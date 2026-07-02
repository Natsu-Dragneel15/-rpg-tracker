/**
 * RPG Challenge Tracker - Server
 * Server-authoritative game logic with Socket.IO real-time sync
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// ─── In-Memory Game State ────────────────────────────────────────────────────

const rooms = {}; // roomCode → GameRoom

const STATUS_ORDER = ['N', 'R', 'A', 'H', 'AD', 'MB'];

function createPlayerState(name, role, settings) {
  return {
    name,
    role,
    hp: settings.startingHp || 100,
    maxHp: settings.startingHp || 100,
    status: settings.startingStatus || 'N',   // single status: N/R → A → H → AD → MB
    protection: settings.protectionEnabled !== false,
    ready: false,
    connected: true,
    stats: {
      attacks: 0, hits: 0, misses: 0,
      highRoll: 0, lowRoll: 99, totalRoll: 0, rollCount: 0,
      damageDealt: 0, damageReceived: 0, statusChanges: 0
    },
    hypnoUsed: false,
    bcUsed: false,
    weaknessUsed: false
  };
}

// ─── Room Helpers ─────────────────────────────────────────────────────────────

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoomBySocket(socketId) {
  for (const [code, room] of Object.entries(rooms)) {
    if (room.players && room.players[socketId]) return { code, room };
  }
  return null;
}

function getOpponent(room, socketId) {
  return room.playerOrder.find(id => id !== socketId);
}

function addLog(room, entry) {
  const log = { id: uuidv4(), timestamp: Date.now(), ...entry };
  room.battleLog.push(log);
  return log;
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.playerOrder.forEach(pid => {
    const socket = io.sockets.sockets.get(pid);
    if (!socket) return;
    socket.emit('state_update', buildClientState(room, pid, getOpponent(room, pid)));
  });
}

function buildClientState(room, playerId, opponentId) {
  const me = room.players[playerId];
  const opp = opponentId ? room.players[opponentId] : null;
  const now = Date.now();

  return {
    phase: room.phase,
    settings: room.settings,
    isOwner: room.ownerId === playerId,   // true only for the Defender (room owner)
    me: me ? sanitizePlayer(me, playerId, room) : null,
    opponent: opp ? sanitizePlayer(opp, opponentId, room) : null,
    currentAttacker: room.currentAttacker,
    myTurn: room.currentAttacker === playerId,
    pendingDefense: room.pendingDefense && opponentId === room.currentAttacker,
    battleLog: room.battleLog.slice(-50),
    winner: room.winner,
    startedAt: room.startedAt,
    matchDuration: room.startedAt ? now - room.startedAt : 0,
    cooldownRemaining: room.cooldownEnd[playerId] ? Math.max(0, room.cooldownEnd[playerId] - now) : 0,
    hypnoSkipsRemaining: room.hypnoState[playerId] || 0,       // MY skips (I am the hypnotized defender)
    oppHypnoSkipsRemaining: room.hypnoState[opponentId] || 0,  // OPPONENT's skips (they are the hypnotized defender)
    playerCount: room.playerOrder.length,
    initiativeRolls: room.initiativeRolls,
    currentRound: room.currentRound,
    totalRounds: room.settings.totalRounds,
    roundScores: room.roundScores,
    // P roll: available to attacker in mb phase, final round, defender protection OFF
    pRollAvailable: (room.phase === 'mb') &&
      (room.currentRound >= room.settings.totalRounds) &&
      (() => {
        const defId = room.playerOrder.find(pid => room.players[pid]?.role === 'defender');
        return defId && !room.players[defId]?.protection;
      })()
  };
}

function sanitizePlayer(player, playerId, room) {
  return {
    name: player.name,
    role: player.role,
    hp: player.hp,
    maxHp: player.maxHp,
    status: player.status,
    protection: player.protection,
    ready: player.ready,
    connected: player.connected,
    stats: player.stats,
    hypnoUsed: player.hypnoUsed,
    bcUsed: player.bcUsed,
    pStatus: player.pStatus || false,
    cooldownEnd: room.cooldownEnd[playerId] || 0
  };
}

// ─── Damage & Status Logic ────────────────────────────────────────────────────

function applyDamage(room, targetId, amount, source, roomCode) {
  const player = room.players[targetId];
  if (!player) return 0;
  const prev = player.hp;
  player.hp = Math.max(0, player.hp - amount);
  const actual = prev - player.hp;
  if (actual > 0) {
    player.stats.damageReceived += actual;
    const attacker = getOpponent(room, targetId);
    if (attacker && room.players[attacker]) room.players[attacker].stats.damageDealt += actual;
    // Automatically update status based on new HP percentage
    if (roomCode) updateStatusFromHp(room, targetId, roomCode);
  }
  return actual;
}

function progressStatus(room, targetId) {
  // Kept for manual_trigger (Word Teasing / Roomplay Corruption) only
  const player = room.players[targetId];
  if (!player) return;
  const COMBAT_ORDER = ['N', 'R', 'A', 'H', 'AD', 'MB'];
  const idx = COMBAT_ORDER.indexOf(player.status);
  if (player.status === 'N' || player.status === 'R') {
    player.status = 'A';
  } else if (idx < COMBAT_ORDER.length - 1) {
    player.status = COMBAT_ORDER[idx + 1];
  }
  player.stats.statusChanges++;
  return player.status;
}

/**
 * Automatically update a player's status based on their current HP %.
 * Called after every damage event.
 * Thresholds (based on maxHp):
 *   > 75%  → starting status (N or R)  [no change from initial]
 *   ≤ 75%  → A
 *   ≤ 50%  → H
 *   ≤ 25%  → AD
 *   = 0    → MB
 * Status never goes backwards.
 */
const HP_STATUS_TIERS = [
  { threshold: 0,    status: 'MB' },
  { threshold: 0.25, status: 'AD' },
  { threshold: 0.50, status: 'H'  },
  { threshold: 0.75, status: 'A'  },
];

function updateStatusFromHp(room, targetId, roomCode) {
  const player = room.players[targetId];
  if (!player || player.status === 'MB') return null;

  const pct = player.maxHp > 0 ? player.hp / player.maxHp : 0;
  let targetStatus = player.status; // default: no change

  for (const tier of HP_STATUS_TIERS) {
    if (pct <= tier.threshold) { targetStatus = tier.status; break; }
  }

  // Never go backwards (e.g. healing can't lower status)
  const ORDER = ['N', 'R', 'A', 'H', 'AD', 'MB'];
  const currentIdx = ORDER.indexOf(player.status);
  const targetIdx  = ORDER.indexOf(targetStatus);
  if (targetIdx <= currentIdx) return null; // no change

  const oldStatus = player.status;
  player.status = targetStatus;
  player.stats.statusChanges++;

  addLog(room, {
    type: 'status_change',
    player: player.name,
    from: oldStatus,
    to: targetStatus,
    message: `📊 ${player.name}'s HP dropped — Status: ${oldStatus} → ${targetStatus}`
  });

  if (targetStatus === 'MB') {
    player.hp = 0;
    checkWin(room, roomCode);
  }

  return targetStatus;
}

function checkMB(room, targetId, roomCode) {
  const player = room.players[targetId];
  if (!player || player.status !== 'MB') return;
  player.hp = 0;
  const attacker = getOpponent(room, targetId);
  addLog(room, {
    type: 'mb_triggered',
    player: room.players[attacker]?.name || 'Unknown',
    target: player.name,
    message: `💀 MB Status triggered! ${player.name}'s HP dropped to 0!`
  });
}

/**
 * Start the protection-based HP drain.
 * Fires only when protection was OFF at match start.
 * Damages BOTH players 5 HP every 5 minutes simultaneously.
 * This timer is stored as room.protectionDrainTimer (one timer for the room).
 * BC does NOT start this timer — BC has its own separate bcTimer.
 */
function startProtectionDrainTimer(room, roomCode) {
  if (room.protectionDrainTimer) return; // already running
  room.protectionDrainTimer = setInterval(() => {
    const r = rooms[roomCode];
    if (!r || r.phase === 'ended') { clearInterval(r?.protectionDrainTimer); return; }
    let anyDamage = false;
    r.playerOrder.forEach(pid => {
      const p = r.players[pid];
      if (!p) return;
      const dmg = applyDamage(r, pid, 5, 'protection_drain', roomCode);
      if (dmg > 0) {
        anyDamage = true;
        addLog(r, { type: 'protection_drain', target: p.name, damage: dmg, message: `🔴 Protection OFF: ${p.name} lost ${dmg} HP` });
      }
    });
    if (anyDamage) {
      checkWin(r, roomCode);
      broadcastState(roomCode);
    }
  }, 5 * 60 * 1000);
}

function startBCTimer(room, targetId, roomCode) {
  const existing = room.bcTimers[targetId];
  if (existing) clearInterval(existing.intervalId);
  room.bcTimers[targetId] = {
    intervalId: setInterval(() => {
      const r = rooms[roomCode];
      if (!r || !r.players[targetId]) return;
      const dmg = applyDamage(r, targetId, 10, 'bc_dot', roomCode);
      addLog(r, { type: 'bc_damage', target: r.players[targetId].name, damage: dmg, message: `⛓️ BC Curse: ${r.players[targetId].name} took ${dmg} curse damage` });
      checkWin(r, roomCode);
      broadcastState(roomCode);
    }, 5 * 60 * 1000)
  };
}

// ─── Win Check ───────────────────────────────────────────────────────────────

function checkWin(room, roomCode) {
  if (room.phase === 'ended' || room.phase === 'mb') return false;
  for (const [pid, player] of Object.entries(room.players)) {
    if (player.hp <= 0 || player.status === 'MB') {
      player.hp = 0;
      player.status = 'MB';
      player.stats.statusChanges++;

      const winnerId = getOpponent(room, pid);
      const winner = room.players[winnerId];
      room.winner = { id: winnerId, name: winner?.name || 'Unknown', role: winner?.role || 'Unknown' };
      room.defeatedId = pid;

      // Move to 'mb' phase — match paused, waiting for owner to finish
      room.phase = 'mb';

      addLog(room, {
        type: 'mb_triggered',
        defeated: player.name,
        winner: winner?.name,
        message: `💀 ${player.name} has been defeated (MB)! ${winner?.name} wins — waiting for Room Owner to finish the round.`
      });

      broadcastState(roomCode);
      return true;
    }
  }
  return false;
}

// ─── Server Roll ──────────────────────────────────────────────────────────────

function rollDie(faces) { return Math.floor(Math.random() * faces) + 1; }

// Only Status AD applies a -1 dice penalty
function rollDieForPlayer(faces, player) {
  const raw = rollDie(faces);
  const hasPenalty = player.status === 'AD';
  const penalty = hasPenalty ? 1 : 0;
  const final = Math.max(1, raw - penalty);
  return { raw, penalty, final };
}

function updateRollStats(player, roll) {
  player.stats.rollCount++;
  player.stats.totalRoll += roll;
  if (roll > player.stats.highRoll) player.stats.highRoll = roll;
  if (roll < player.stats.lowRoll) player.stats.lowRoll = roll;
}

/**
 * Automatically apply a HYPNO attack (no defender roll).
 * skipNumber: 1 or 2 (which skip this is out of 2)
 */
function applyHypnoAttack(room, attackerId, defenderId, roomCode, skipNumber) {
  const attacker = room.players[attackerId];
  const defender = room.players[defenderId];
  if (!attacker || !defender) return;

  // Consume one skip
  room.hypnoState[defenderId] = Math.max(0, (room.hypnoState[defenderId] || 1) - 1);
  const skipsLeft = room.hypnoState[defenderId];

  const dmg = applyDamage(room, defenderId, room.settings.damage, 'hypno_attack', roomCode);
  attacker.stats.hits++;
  attacker.stats.attacks++;

  addLog(room, {
    type: 'hypno_hit',
    attacker: attacker.name,
    defender: defender.name,
    skipNumber,
    skipsLeft,
    damage: dmg,
    message: `🌀 HYPNO — Defense skipped (${skipNumber}/2)! ${attacker.name} automatically hits ${defender.name} for ${dmg} damage.${skipsLeft === 0 ? ' HYPNO effect ended.' : ''}`
  });

  checkWin(room, roomCode);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──────────────────────────────────────────
  socket.on('create_room', ({ name, settings }) => {
    if (!name || typeof name !== 'string') return socket.emit('error', 'Invalid name');
    name = name.trim().slice(0, 20);

    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    const room = {
      code,
      hostId: socket.id,   // kept for reconnect reference
      ownerId: socket.id,   // Defender is always the owner
      phase: 'lobby',
      settings: {
        startingHp: Math.min(Math.max(parseInt(settings?.startingHp) || 100, 10), 1000),
        damage: Math.min(Math.max(parseInt(settings?.damage) || 25, 1), 500),
        diceFaces: [4,6,8,10,12,20].includes(parseInt(settings?.diceFaces)) ? parseInt(settings.diceFaces) : 6,
        cooldownMs: Math.min(Math.max((parseFloat(settings?.cooldownSeconds) || 120) * 1000, 5000), 30 * 60 * 1000),
        protectionEnabled: settings?.protectionEnabled !== false,
        // Starting status: N if protection ON, R if protection OFF
        startingStatus: (settings?.protectionEnabled !== false) ? 'N' : 'R',
        prize: (settings?.prize || '').slice(0, 100),
        totalRounds: Math.min(Math.max(parseInt(settings?.totalRounds) || 1, 1), 99)
      },
      players: {},
      playerOrder: [],
      currentAttacker: null,
      initiativeRolls: {},
      pendingDefense: false,
      pendingAttack: null,
      battleLog: [],
      startedAt: null,
      endedAt: null,
      winner: null,
      currentRound: 1,
      roundScores: {},   // playerName → rounds won
      hypnoState: {},
      bcTimers: {},
      rTimers: {},
      protectionDrainTimer: null,   // room-wide 5HP/5min drain when protection OFF at start
      bcBrokenProtection: false,    // true if BC broke protection mid-match (suppresses normal drain)
      cooldownEnd: {},
      disconnectTimers: {}
    };

    // Creator is the Defender (Room Owner)
    room.players[socket.id] = createPlayerState(name, 'defender', room.settings);
    room.playerOrder.push(socket.id);
    rooms[code] = room;

    socket.join(code);
    socket.emit('room_created', { code, role: 'defender', playerId: socket.id });
    console.log(`[Room] Created: ${code} by ${name}`);
  });

  // ── Join Room ────────────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    if (!name || !code) return socket.emit('error', 'Name and code required');
    code = code.trim().toUpperCase();
    name = name.trim().slice(0, 20);

    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');

    if (room.playerOrder.length >= 2) {
      // Reconnect attempt
      const existing = room.playerOrder.find(pid =>
        room.players[pid]?.name === name && !room.players[pid]?.connected
      );
      if (existing) {
        room.players[existing].connected = true;
        room.players[socket.id] = room.players[existing];
        delete room.players[existing];
        room.playerOrder = room.playerOrder.map(pid => pid === existing ? socket.id : pid);
        if (room.currentAttacker === existing) room.currentAttacker = socket.id;
        if (room.ownerId === existing) room.ownerId = socket.id;
        if (room.disconnectTimers[existing]) {
          clearTimeout(room.disconnectTimers[existing]);
          delete room.disconnectTimers[existing];
        }
        socket.join(code);
        socket.emit('room_joined', { code, role: room.players[socket.id].role, playerId: socket.id });
        broadcastState(code);
        return;
      }
      return socket.emit('error', 'Room is full');
    }
    if (room.phase !== 'lobby') return socket.emit('error', 'Match already started');

    room.players[socket.id] = createPlayerState(name, 'attacker', room.settings);
    room.playerOrder.push(socket.id);

    socket.join(code);
    socket.emit('room_joined', { code, role: 'attacker', playerId: socket.id });
    broadcastState(code);
    io.to(code).emit('player_joined', { name });
  });

  // ── Ready Toggle ─────────────────────────────────────────
  socket.on('set_ready', ({ ready }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.phase !== 'lobby' || !room.players[socket.id]) return;
    room.players[socket.id].ready = !!ready;
    broadcastState(code);
    const allReady = room.playerOrder.length === 2 && room.playerOrder.every(pid => room.players[pid]?.ready);
    if (allReady) io.to(code).emit('all_ready');
  });

  // ── Start Match ──────────────────────────────────────────
  socket.on('start_match', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.ownerId) return socket.emit('error', 'Only the room owner can start');
    if (room.playerOrder.length < 2) return socket.emit('error', 'Need 2 players');
    if (room.phase !== 'lobby') return;
    if (!room.playerOrder.every(pid => room.players[pid]?.ready)) return socket.emit('error', 'Both players must be ready');

    room.phase = 'initiative';
    room.startedAt = Date.now();
    addLog(room, { type: 'match_start', message: '⚔️ The battle begins! Roll initiative!' });
    broadcastState(code);
  });

  // ── Roll Initiative ──────────────────────────────────────
  socket.on('roll_initiative', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.phase !== 'initiative') return;
    if (room.initiativeRolls[socket.id] !== undefined) return;

    const { raw, penalty, final: roll } = rollDieForPlayer(room.settings.diceFaces, room.players[socket.id]);
    room.initiativeRolls[socket.id] = roll;
    updateRollStats(room.players[socket.id], roll);
    addLog(room, {
      type: 'initiative',
      player: room.players[socket.id].name,
      roll, rawRoll: raw, penalty,
      message: penalty > 0
        ? `🎲 ${room.players[socket.id].name} rolled ${raw} for initiative. Status AD penalty: -${penalty}. Final roll: ${roll}.`
        : `🎲 ${room.players[socket.id].name} rolled ${roll} for initiative`
    });
    broadcastState(code);

    if (room.playerOrder.every(pid => room.initiativeRolls[pid] !== undefined)) {
      const [p1, p2] = room.playerOrder;
      const r1 = room.initiativeRolls[p1], r2 = room.initiativeRolls[p2];
      if (r1 === r2) {
        room.initiativeRolls = {};
        addLog(room, { type: 'initiative_tie', message: '🔁 Tie! Both players reroll initiative.' });
        broadcastState(code);
        return;
      }
      room.currentAttacker = r1 > r2 ? p1 : p2;
      room.phase = 'battle';
      // If protection was OFF at match start, begin 5HP/5min drain for both players
      if (!room.settings.protectionEnabled) {
        startProtectionDrainTimer(room, code);
      }
      addLog(room, { type: 'initiative_result', winner: room.players[room.currentAttacker].name, message: `⚔️ ${room.players[room.currentAttacker].name} goes first!` });
      broadcastState(code);
    }
  });

  // ── Attack ───────────────────────────────────────────────
  socket.on('attack', ({ abilityUsed }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.phase !== 'battle') return socket.emit('error', 'Not in battle');
    if (room.currentAttacker !== socket.id) return socket.emit('error', 'Not your turn');
    if (room.pendingDefense) return socket.emit('error', 'Defense pending');
    if (room.winner) return;

    const now = Date.now();
    if (now < (room.cooldownEnd[socket.id] || 0)) return socket.emit('error', `Cooldown active`);

    const attacker = room.players[socket.id];
    const defender = room.players[getOpponent(room, socket.id)];
    if (!attacker || !defender) return;

    if (abilityUsed === 'HYPNO' && attacker.hypnoUsed) return socket.emit('error', 'HYPNO already used');
    if (abilityUsed === 'BC' && attacker.bcUsed) return socket.emit('error', 'BC already used');
    if ((abilityUsed === 'HYPNO' || abilityUsed === 'BC') && attacker.role !== 'attacker') return socket.emit('error', 'Only attacker can use abilities');

    let roll, rawRoll, penalty = 0, abilitySuccess = false;
    if (abilityUsed === 'HYPNO') { roll = rollDie(room.settings.diceFaces); rawRoll = roll; abilitySuccess = roll === 6; attacker.hypnoUsed = true; }
    else if (abilityUsed === 'BC') { roll = rollDie(room.settings.diceFaces); rawRoll = roll; abilitySuccess = roll === 1; attacker.bcUsed = true; }
    else { ({ raw: rawRoll, penalty, final: roll } = rollDieForPlayer(room.settings.diceFaces, attacker)); }

    updateRollStats(attacker, roll);
    attacker.stats.attacks++;

    addLog(room, {
      type: 'attack_roll', player: attacker.name, roll, rawRoll, penalty, ability: abilityUsed || null, abilitySuccess,
      message: abilityUsed
        ? `⚡ ${attacker.name} uses ${abilityUsed}! Rolled ${roll}${abilitySuccess ? ' — SUCCESS!' : ' — failed'}`
        : penalty > 0
          ? `⚔️ ${attacker.name} attacks! Rolled ${rawRoll}. Status AD penalty: -${penalty}. Final roll: ${roll}.`
          : `⚔️ ${attacker.name} attacks! Rolled ${roll}`
    });

    if (abilityUsed === 'HYPNO') {
      if (abilitySuccess) {
        const defenderId = getOpponent(room, socket.id);
        // Store remaining skips on the DEFENDER (keyed by defender's id)
        room.hypnoState[defenderId] = 2;
        addLog(room, {
          type: 'hypno_success', player: attacker.name, target: defender.name,
          message: `🌀 HYPNO successful! ${attacker.name} rolled 6. ${defender.name} is hypnotized — next 2 defenses will be skipped.`
        });
        // Auto-apply first hypno attack immediately (no defender click needed)
        applyHypnoAttack(room, socket.id, defenderId, code, 1);
      } else {
        addLog(room, { type: 'hypno_fail', player: attacker.name, roll, message: `🌀 HYPNO failed — ${attacker.name} rolled ${roll}. No effect.` });
        room.cooldownEnd[socket.id] = now + room.settings.cooldownMs;
        passTurn(room, code);
      }
      broadcastState(code);
      return;
    }

    if (abilityUsed === 'BC') {
      // BC can only be used when Defender's protection is currently ON
      if (!defender.protection) return socket.emit('error', 'BC can only be used when Defender has Protection ON');
      if (abilitySuccess) {
        defender.protection = false;
        room.bcBrokenProtection = true; // flag: do NOT start normal drain
        const dmg = applyDamage(room, getOpponent(room, socket.id), 10, 'bc_initial', code);
        startBCTimer(room, getOpponent(room, socket.id), code); // 10 HP/5min to defender only
        addLog(room, { type: 'bc_success', player: attacker.name, target: defender.name, damage: dmg, message: `⛓️ BC successful! ${defender.name}'s protection broken! ${dmg} damage + ongoing curse!` });
        if (checkWin(room, code)) return;
      } else {
        addLog(room, { type: 'bc_fail', message: `⛓️ BC failed — ${attacker.name} could not break the curse.` });
      }
      room.cooldownEnd[socket.id] = now + room.settings.cooldownMs;
      passTurn(room, code);
      broadcastState(code);
      return;
    }

    // If defender has HYPNO skips remaining, auto-hit without pending defense
    const defenderId = getOpponent(room, socket.id);
    const skipsOnDefender = room.hypnoState[defenderId] || 0;
    if (skipsOnDefender > 0) {
      const skipNumber = 3 - skipsOnDefender; // skip 1 = used 1 of 2, skip 2 = used 2 of 2
      applyHypnoAttack(room, socket.id, defenderId, code, skipNumber);
      room.cooldownEnd[socket.id] = now + room.settings.cooldownMs;
      passTurn(room, code);
      broadcastState(code);
      return;
    }

    room.pendingAttack = { attackerId: socket.id, roll };
    room.pendingDefense = true;
    broadcastState(code);
  });

  // ── Defend ───────────────────────────────────────────────
  socket.on('defend', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (!room.pendingDefense) return;
    const attackerId = room.pendingAttack?.attackerId;
    if (socket.id !== getOpponent(room, attackerId)) return;

    const defender = room.players[socket.id];
    const attacker = room.players[attackerId];
    if (!defender || !attacker) return;

    const now = Date.now();
    let defRoll;

    {
      const { raw, penalty, final } = rollDieForPlayer(room.settings.diceFaces, defender);
      defRoll = final;
      updateRollStats(defender, defRoll);
      addLog(room, {
        type: 'defense_roll', player: defender.name, roll: defRoll, rawRoll: raw, penalty,
        message: penalty > 0
          ? `🛡️ ${defender.name} defends! Rolled ${raw}. Status AD penalty: -${penalty}. Final roll: ${defRoll}.`
          : `🛡️ ${defender.name} defends! Rolled ${defRoll}`
      });
    }

    const atkRoll = room.pendingAttack.roll;
    const attackHits = atkRoll >= defRoll;
    room.pendingDefense = false;
    room.pendingAttack = null;

    if (attackHits) {
      const actualDmg = applyDamage(room, socket.id, room.settings.damage, 'attack', code);
      attacker.stats.hits++;

      addLog(room, { type: 'hit', attacker: attacker.name, defender: defender.name, attackRoll: atkRoll, defenseRoll: defRoll, damage: actualDmg, message: `💥 HIT! ${attacker.name} (${atkRoll}) beat ${defender.name} (${defRoll}) for ${actualDmg} damage!` });
      if (checkWin(room, code)) return;
    } else {
      attacker.stats.misses++;
      addLog(room, { type: 'miss', attacker: attacker.name, defender: defender.name, attackRoll: atkRoll, defenseRoll: defRoll, message: `🛡️ BLOCKED! ${defender.name} (${defRoll}) defeated ${attacker.name} (${atkRoll})` });
    }

    room.cooldownEnd[attackerId] = now + room.settings.cooldownMs;
    passTurn(room, code);
    broadcastState(code);
  });

  // ── Roll P (Attacker only, mb phase, final round, defender protection OFF) ──
  socket.on('roll_p', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;

    // Must be in mb phase
    if (room.phase !== 'mb') return socket.emit('error', 'P is only available after MB');

    // Only attacker can roll P
    const me = room.players[socket.id];
    if (!me || me.role !== 'attacker') return socket.emit('error', 'Attacker only');

    // Must be the final round
    if (room.currentRound < room.settings.totalRounds) return socket.emit('error', 'P is only available in the final round');

    // Defender's protection must be OFF
    const defenderId = room.playerOrder.find(pid => room.players[pid]?.role === 'defender');
    const defender = room.players[defenderId];
    if (!defender) return;
    if (defender.protection) return socket.emit('error', 'P requires Defender protection to be OFF');

    // Roll — succeeds only on exactly 3
    const roll = rollDie(room.settings.diceFaces);
    const success = roll === 3;

    addLog(room, {
      type: 'p_roll',
      player: me.name,
      roll,
      success,
      message: success
        ? `✨ ${me.name} rolled ${roll} — P Status activated! Special outcome achieved!`
        : `✨ ${me.name} attempted P — rolled ${roll}. P requires exactly 3. Failed.`
    });

    if (success) {
      defender.pStatus = true;
      addLog(room, { type: 'p_activated', target: defender.name, message: `✨ ${defender.name} has been given Status P!` });
    }

    broadcastState(code);
  });

  // ── Found Weakness (Defender/Owner only, once per match) ─
  socket.on('found_weakness', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;

    if (room.phase !== 'battle') return socket.emit('error', 'Not in battle');
    if (socket.id !== room.ownerId) return socket.emit('error', 'Room owner only');

    const me = room.players[socket.id]; // defender
    if (!me) return;
    if (me.weaknessUsed) return socket.emit('error', 'Weakness already used');

    me.weaknessUsed = true;

    // Defender loses 10 HP immediately
    const dmg = applyDamage(room, socket.id, 10, 'weakness', code);

    addLog(room, {
      type: 'weakness',
      player: me.name,
      damage: dmg,
      message: `🎯 ${me.name} acknowledged a discovered Weakness. ${me.name} lost ${dmg} HP.`
    });

    checkWin(room, code);
    broadcastState(code);
  });

  // ── Finish Round (Owner/Defender only) ──────────────────
  socket.on('finish_round', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.ownerId) return socket.emit('error', 'Only the room owner can finish the round');
    if (room.phase !== 'mb') return socket.emit('error', 'No defeated player yet');

    // Stop per-round timers
    Object.values(room.rTimers).forEach(t => clearInterval(t));
    Object.values(room.bcTimers).forEach(t => clearInterval(t.intervalId));
    if (room.protectionDrainTimer) { clearInterval(room.protectionDrainTimer); room.protectionDrainTimer = null; }
    room.rTimers = {};
    room.bcTimers = {};

    // Award round to winner
    const winnerName = room.winner?.name;
    if (winnerName) room.roundScores[winnerName] = (room.roundScores[winnerName] || 0) + 1;

    const roundMsg = `🏆 Round ${room.currentRound} finished! ${winnerName} wins the round!`;
    addLog(room, { type: 'round_over', round: room.currentRound, winner: winnerName, message: roundMsg });

    const moreRounds = room.currentRound < room.settings.totalRounds;

    if (moreRounds) {
      // Start next round — reset players
      room.currentRound++;
      room.phase = 'initiative';
      room.initiativeRolls = {};
      room.pendingDefense = false;
      room.pendingAttack = null;
      room.currentAttacker = null;
      room.winner = null;
      room.cooldownEnd = {};
      room.hypnoState = {};
      room.bcBrokenProtection = false;

      // Reset each player's HP, status, and per-match abilities
      room.playerOrder.forEach(pid => {
        const p = room.players[pid];
        p.hp = room.settings.startingHp;
        p.maxHp = room.settings.startingHp;
        p.status = room.settings.startingStatus;
        p.protection = room.settings.protectionEnabled;
        p.hypnoUsed = false;
        p.bcUsed = false;
        p.weaknessUsed = false;
        p.pStatus = false;
        p.stats = { attacks: 0, hits: 0, misses: 0, highRoll: 0, lowRoll: 99, totalRoll: 0, rollCount: 0, damageDealt: 0, damageReceived: 0, statusChanges: 0 };
      });

      addLog(room, { type: 'round_start', round: room.currentRound, message: `⚔️ Round ${room.currentRound} begins! Roll initiative!` });
    } else {
      // All rounds done — find match winner by most rounds won
      room.phase = 'ended';
      room.endedAt = Date.now();

      const scores = room.roundScores;
      const names = Object.keys(scores);
      const matchWinner = names.reduce((a, b) => (scores[a] || 0) >= (scores[b] || 0) ? a : b, names[0]);
      const scoreStr = names.map(n => `${n}: ${scores[n] || 0}`).join(', ');

      addLog(room, { type: 'game_over', winner: matchWinner, message: `🏆 Match over! ${matchWinner} wins! (${scoreStr})` });
    }

    broadcastState(code);
  });

  // ── Host Manual Controls ─────────────────────────────────
  socket.on('manual_status', ({ targetName, status }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.ownerId) return socket.emit('error', 'Room owner only');
    if (!STATUS_ORDER.includes(status)) return socket.emit('error', 'Invalid status');

    const targetId = room.playerOrder.find(pid => room.players[pid]?.name === targetName);
    if (!targetId) return;

    const old = room.players[targetId].status;
    room.players[targetId].status = status;
    room.players[targetId].stats.statusChanges++;
    if (status === 'MB') checkMB(room, targetId, code);

    addLog(room, { type: 'manual_status', player: targetName, from: old, to: status, message: `🔧 Host changed ${targetName}'s status: ${old} → ${status}` });
    broadcastState(code);
  });

  socket.on('manual_restore_protection', ({ targetName }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.ownerId) return;
    const targetId = room.playerOrder.find(pid => room.players[pid]?.name === targetName);
    if (!targetId) return;
    room.players[targetId].protection = true;
    addLog(room, { type: 'protection_restored', player: targetName, message: `🛡️ Host restored protection for ${targetName}` });
    broadcastState(code);
  });

  socket.on('manual_trigger', ({ trigger }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.ownerId) return;
    const [p1, p2] = room.playerOrder;
    const defender = room.players[p2] ? p2 : p1;
    if (trigger === 'word_teasing') {
      const old = room.players[defender].status;
      room.players[defender].status = 'A';
      addLog(room, { type: 'manual_trigger', trigger, message: `💬 Successful Word Teasing! ${room.players[defender].name}: ${old} → A` });
    } else if (trigger === 'roomplay_corruption') {
      const old = room.players[defender].status;
      room.players[defender].status = 'H';
      addLog(room, { type: 'manual_trigger', trigger, message: `🌀 Roomplay Corruption! ${room.players[defender].name}: ${old} → H` });
    }
    broadcastState(code);
  });

  // ── Export ───────────────────────────────────────────────
  socket.on('export_log', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    socket.emit('export_data', {
      log: found.room.battleLog,
      players: found.room.playerOrder.map(pid => ({ ...found.room.players[pid], id: pid })),
      settings: found.room.settings,
      startedAt: found.room.startedAt,
      endedAt: found.room.endedAt,
      winner: found.room.winner
    });
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (room.players[socket.id]) {
      room.players[socket.id].connected = false;
      io.to(code).emit('player_disconnected', { name: room.players[socket.id].name });
    }
    room.disconnectTimers = room.disconnectTimers || {};
    room.disconnectTimers[socket.id] = setTimeout(() => {
      if (!io.sockets.sockets.get(socket.id)) {
        const allGone = room.playerOrder.every(pid => !room.players[pid]?.connected);
        if (allGone) {
          Object.values(room.rTimers || {}).forEach(t => clearInterval(t));
          Object.values(room.bcTimers || {}).forEach(t => clearInterval(t.intervalId));
          if (room.protectionDrainTimer) clearInterval(room.protectionDrainTimer);
          delete rooms[code];
          console.log(`[Room] Cleaned up: ${code}`);
        }
      }
    }, 30 * 60 * 1000);
    broadcastState(code);
  });
});

function passTurn(room, code) {
  if (!room || room.phase !== 'battle') return;
  const opp = getOpponent(room, room.currentAttacker);
  if (opp) room.currentAttacker = opp;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`⚔️  RPG Challenge Tracker running on http://localhost:${PORT}`));
