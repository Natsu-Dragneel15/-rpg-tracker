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
    status: settings.startingStatus || 'N',
    protection: settings.protectionEnabled !== false,
    ready: false,
    connected: true,
    stats: {
      attacks: 0, hits: 0, misses: 0,
      highRoll: 0, lowRoll: 99, totalRoll: 0, rollCount: 0,
      damageDealt: 0, damageReceived: 0, statusChanges: 0
    },
    hypnoUsed: false,
    bcUsed: false
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

  // Weakness countdown: how many ms until next damage tick
  let weaknessCountdown = null;
  if (room.weaknessState?.active) {
    const elapsed = now - room.weaknessState.lastTickAt;
    weaknessCountdown = Math.max(0, room.weaknessState.intervalMs - elapsed);
  }

  return {
    phase: room.phase,
    settings: room.settings,
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
    hypnoSkipsRemaining: room.hypnoState[playerId] || 0,
    playerCount: room.playerOrder.length,
    initiativeRolls: room.initiativeRolls,
    weaknessState: room.weaknessState ? {
      active: room.weaknessState.active,
      targetId: room.weaknessState.targetId,
      targetName: room.weaknessState.targetName,
      damage: room.weaknessState.damage,
      intervalMs: room.weaknessState.intervalMs,
      countdownMs: weaknessCountdown
    } : null
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
    cooldownEnd: room.cooldownEnd[playerId] || 0
  };
}

// ─── Damage & Status Logic ────────────────────────────────────────────────────

function applyDamage(room, targetId, amount, source) {
  const player = room.players[targetId];
  if (!player) return 0;
  const prev = player.hp;
  player.hp = Math.max(0, player.hp - amount);
  const actual = prev - player.hp;
  if (actual > 0) {
    player.stats.damageReceived += actual;
    const attacker = getOpponent(room, targetId);
    if (attacker && room.players[attacker]) room.players[attacker].stats.damageDealt += actual;
  }
  return actual;
}

function progressStatus(room, targetId) {
  const player = room.players[targetId];
  if (!player) return;
  const idx = STATUS_ORDER.indexOf(player.status);
  if (idx < STATUS_ORDER.length - 1) {
    player.status = STATUS_ORDER[idx + 1];
    player.stats.statusChanges++;
    return player.status;
  }
  return null;
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

function startRTimer(room, targetId, roomCode) {
  if (room.rTimers[targetId]) return;
  room.rTimers[targetId] = setInterval(() => {
    const r = rooms[roomCode];
    if (!r || !r.players[targetId]) return clearInterval(r.rTimers[targetId]);
    if (r.players[targetId].status !== 'R') return clearInterval(r.rTimers[targetId]);
    if (r.players[targetId].protection) return;
    const dmg = applyDamage(r, targetId, 5, 'R_damage');
    addLog(r, { type: 'r_damage', target: r.players[targetId].name, damage: dmg, message: `🔴 R Status: ${r.players[targetId].name} took ${dmg} passive damage` });
    checkWin(r, roomCode);
    broadcastState(roomCode);
  }, 5 * 60 * 1000);
}

function startBCTimer(room, targetId, roomCode) {
  const existing = room.bcTimers[targetId];
  if (existing) clearInterval(existing.intervalId);
  room.bcTimers[targetId] = {
    intervalId: setInterval(() => {
      const r = rooms[roomCode];
      if (!r || !r.players[targetId]) return;
      const dmg = applyDamage(r, targetId, 10, 'bc_dot');
      addLog(r, { type: 'bc_damage', target: r.players[targetId].name, damage: dmg, message: `⛓️ BC Curse: ${r.players[targetId].name} took ${dmg} curse damage` });
      checkWin(r, roomCode);
      broadcastState(roomCode);
    }, 5 * 60 * 1000)
  };
}

// ─── Weakness Timer ───────────────────────────────────────────────────────────

/**
 * Start the server-authoritative Weakness DoT timer.
 * weaknessState = { active, targetId, targetName, damage, intervalMs, lastTickAt, intervalHandle }
 */
function startWeaknessTimer(room, roomCode) {
  // Clear any existing timer
  stopWeaknessTimer(room);

  const ws = room.weaknessState;
  if (!ws || !ws.active) return;

  ws.lastTickAt = Date.now(); // reset so countdown starts fresh

  ws.intervalHandle = setInterval(() => {
    const r = rooms[roomCode];
    if (!r || !r.weaknessState?.active) return;

    const targetId = r.weaknessState.targetId;
    const target = r.players[targetId];
    if (!target) return;

    r.weaknessState.lastTickAt = Date.now();

    const dmg = applyDamage(r, targetId, r.weaknessState.damage, 'weakness_dot');
    addLog(r, {
      type: 'weakness_damage',
      target: target.name,
      damage: dmg,
      message: `🎯 Weakness dealt ${dmg} damage to ${target.name}`
    });

    if (checkWin(r, roomCode)) {
      stopWeaknessTimer(r);
      return;
    }
    broadcastState(roomCode);
  }, ws.intervalMs);
}

function stopWeaknessTimer(room) {
  if (room.weaknessState?.intervalHandle) {
    clearInterval(room.weaknessState.intervalHandle);
    room.weaknessState.intervalHandle = null;
  }
}

// ─── Win Check ───────────────────────────────────────────────────────────────

function checkWin(room, roomCode) {
  if (room.phase === 'ended') return false;
  for (const [pid, player] of Object.entries(room.players)) {
    if (player.hp <= 0) {
      const winnerId = getOpponent(room, pid);
      const winner = room.players[winnerId];
      room.winner = { id: winnerId, name: winner?.name || 'Unknown', role: winner?.role || 'Unknown' };
      room.phase = 'ended';
      room.endedAt = Date.now();
      addLog(room, { type: 'game_over', winner: room.winner.name, message: `🏆 ${room.winner.name} wins the match!` });
      // Clear all timers
      Object.values(room.rTimers).forEach(t => clearInterval(t));
      Object.values(room.bcTimers).forEach(t => clearInterval(t.intervalId));
      if (room.weaknessState?.active) {
        stopWeaknessTimer(room);
        addLog(room, { type: 'weakness_ended', message: '🎯 Weakness ended — match over.' });
        room.weaknessState.active = false;
      }
      broadcastState(roomCode);
      return true;
    }
  }
  return false;
}

// ─── Server Roll ──────────────────────────────────────────────────────────────

function rollDie(faces) { return Math.floor(Math.random() * faces) + 1; }

function updateRollStats(player, roll) {
  player.stats.rollCount++;
  player.stats.totalRoll += roll;
  if (roll > player.stats.highRoll) player.stats.highRoll = roll;
  if (roll < player.stats.lowRoll) player.stats.lowRoll = roll;
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
      hostId: socket.id,
      phase: 'lobby',
      settings: {
        startingHp: Math.min(Math.max(parseInt(settings?.startingHp) || 100, 10), 1000),
        damage: Math.min(Math.max(parseInt(settings?.damage) || 25, 1), 500),
        diceFaces: [4,6,8,10,12,20].includes(parseInt(settings?.diceFaces)) ? parseInt(settings.diceFaces) : 20,
        cooldownMs: Math.min(Math.max((parseFloat(settings?.cooldownMinutes) || 2) * 60 * 1000, 5000), 30 * 60 * 1000),
        protectionEnabled: settings?.protectionEnabled !== false,
        startingStatus: STATUS_ORDER.includes(settings?.startingStatus) ? settings.startingStatus : 'N',
        prize: (settings?.prize || '').slice(0, 100),
        // Weakness settings
        weaknessDamage: Math.min(Math.max(parseInt(settings?.weaknessDamage) || 10, 1), 200),
        weaknessIntervalMinutes: Math.min(Math.max(parseFloat(settings?.weaknessIntervalMinutes) || 10, 0.1), 60)
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
      hypnoState: {},
      bcTimers: {},
      rTimers: {},
      cooldownEnd: {},
      disconnectTimers: {},
      // Weakness state — single instance, no stacking
      weaknessState: null
    };

    room.players[socket.id] = createPlayerState(name, 'attacker', room.settings);
    room.playerOrder.push(socket.id);
    rooms[code] = room;

    socket.join(code);
    socket.emit('room_created', { code, role: 'attacker', playerId: socket.id });
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
        if (room.weaknessState?.targetId === existing) room.weaknessState.targetId = socket.id;
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

    room.players[socket.id] = createPlayerState(name, 'defender', room.settings);
    room.playerOrder.push(socket.id);

    socket.join(code);
    socket.emit('room_joined', { code, role: 'defender', playerId: socket.id });
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
    if (socket.id !== room.hostId) return socket.emit('error', 'Only host can start');
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

    const roll = rollDie(room.settings.diceFaces);
    room.initiativeRolls[socket.id] = roll;
    updateRollStats(room.players[socket.id], roll);
    addLog(room, { type: 'initiative', player: room.players[socket.id].name, roll, message: `🎲 ${room.players[socket.id].name} rolled ${roll} for initiative` });
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
      room.playerOrder.forEach(pid => {
        if (room.players[pid].status === 'R' && !room.players[pid].protection) startRTimer(room, pid, code);
      });
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

    let roll, abilitySuccess = false;
    if (abilityUsed === 'HYPNO') { roll = rollDie(room.settings.diceFaces); abilitySuccess = roll === 6; attacker.hypnoUsed = true; }
    else if (abilityUsed === 'BC') { roll = rollDie(room.settings.diceFaces); abilitySuccess = roll === 1; attacker.bcUsed = true; }
    else { roll = rollDie(room.settings.diceFaces); }

    updateRollStats(attacker, roll);
    attacker.stats.attacks++;

    addLog(room, {
      type: 'attack_roll', player: attacker.name, roll, ability: abilityUsed || null, abilitySuccess,
      message: abilityUsed
        ? `⚡ ${attacker.name} uses ${abilityUsed}! Rolled ${roll}${abilitySuccess ? ' — SUCCESS!' : ' — failed'}`
        : `⚔️ ${attacker.name} attacks! Rolled ${roll}`
    });

    if (abilityUsed === 'HYPNO') {
      if (abilitySuccess) {
        room.hypnoState[socket.id] = 2;
        addLog(room, { type: 'hypno_success', player: attacker.name, message: `🌀 HYPNO successful! ${defender.name} will skip the next 2 defense rolls!` });
        room.pendingAttack = { attackerId: socket.id, roll, abilityUsed: 'HYPNO' };
        room.pendingDefense = true;
      } else {
        room.cooldownEnd[socket.id] = now + room.settings.cooldownMs;
        passTurn(room, code);
      }
      broadcastState(code);
      return;
    }

    if (abilityUsed === 'BC') {
      if (abilitySuccess) {
        defender.protection = false;
        const dmg = applyDamage(room, getOpponent(room, socket.id), 10, 'bc_initial');
        startBCTimer(room, getOpponent(room, socket.id), code);
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
    const hypnoSkips = room.hypnoState[attackerId] || 0;
    let defRoll;

    if (hypnoSkips > 0) {
      defRoll = 0;
      room.hypnoState[attackerId] = hypnoSkips - 1;
      addLog(room, { type: 'hypno_skip', target: defender.name, skipsLeft: room.hypnoState[attackerId], message: `🌀 ${defender.name} is hypnotized — defense skipped! (${room.hypnoState[attackerId]} skips left)` });
    } else {
      defRoll = rollDie(room.settings.diceFaces);
      updateRollStats(defender, defRoll);
      addLog(room, { type: 'defense_roll', player: defender.name, roll: defRoll, message: `🛡️ ${defender.name} defends! Rolled ${defRoll}` });
    }

    const atkRoll = room.pendingAttack.roll;
    const attackHits = atkRoll >= defRoll;
    room.pendingDefense = false;
    room.pendingAttack = null;

    if (attackHits) {
      const oldStatus = defender.status;
      let newStatus = null;

      if (oldStatus === 'A') newStatus = progressStatus(room, socket.id);
      else if (oldStatus === 'H') newStatus = progressStatus(room, socket.id);
      else if (oldStatus === 'AD') {
        newStatus = progressStatus(room, socket.id);
        if (defender.status === 'MB') checkMB(room, socket.id, code);
      }

      const actualDmg = applyDamage(room, socket.id, room.settings.damage, 'attack');
      attacker.stats.hits++;

      if (defender.status === 'N' && oldStatus === 'N') {
        defender.status = 'A';
        defender.stats.statusChanges++;
        newStatus = 'A';
        if (!defender.protection) startRTimer(room, socket.id, code);
      }

      addLog(room, { type: 'hit', attacker: attacker.name, defender: defender.name, attackRoll: atkRoll, defenseRoll: defRoll, damage: actualDmg, newStatus, message: `💥 HIT! ${attacker.name} (${atkRoll}) beat ${defender.name} (${defRoll}) for ${actualDmg} damage!${newStatus ? ` Status → ${newStatus}` : ''}` });
      if (checkWin(room, code)) return;
    } else {
      attacker.stats.misses++;
      addLog(room, { type: 'miss', attacker: attacker.name, defender: defender.name, attackRoll: atkRoll, defenseRoll: defRoll, message: `🛡️ BLOCKED! ${defender.name} (${defRoll}) defeated ${attacker.name} (${atkRoll})` });
    }

    room.cooldownEnd[attackerId] = now + room.settings.cooldownMs;
    passTurn(room, code);
    broadcastState(code);
  });

  // ── Found Weakness (Attacker only, once per match) ───────
  socket.on('found_weakness', ({ note }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;

    if (room.phase !== 'battle') return socket.emit('error', 'Not in battle');

    const me = room.players[socket.id];
    if (!me) return;

    // Only attacker can trigger weakness
    if (me.role !== 'attacker') return socket.emit('error', 'Attacker only');

    // No stacking
    if (room.weaknessState?.active) return socket.emit('error', 'Weakness already active');

    const targetId = getOpponent(room, socket.id);
    const target = room.players[targetId];
    if (!target) return;

    const dmgPerTick = room.settings.weaknessDamage;
    const intervalMs = room.settings.weaknessIntervalMinutes * 60 * 1000;

    // Set up weakness state
    room.weaknessState = {
      active: true,
      targetId,
      targetName: target.name,
      damage: dmgPerTick,
      intervalMs,
      lastTickAt: Date.now(),
      intervalHandle: null
    };

    startWeaknessTimer(room, code);

    addLog(room, {
      type: 'weakness_applied',
      player: me.name,
      target: target.name,
      damage: dmgPerTick,
      intervalMinutes: room.settings.weaknessIntervalMinutes,
      note: note || '',
      message: `🎯 ${me.name} found a weakness! ${target.name} will take ${dmgPerTick} damage every ${room.settings.weaknessIntervalMinutes} minute(s)!${note ? ` — ${note}` : ''}`
    });

    broadcastState(code);
  });

  // ── Host: Remove Weakness ────────────────────────────────
  socket.on('remove_weakness', () => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.hostId) return socket.emit('error', 'Host only');
    if (!room.weaknessState?.active) return;

    stopWeaknessTimer(room);
    const targetName = room.weaknessState.targetName;
    room.weaknessState.active = false;

    addLog(room, { type: 'weakness_removed', message: `🎯 Host removed Weakness from ${targetName}` });
    broadcastState(code);
  });

  // ── Host Manual Controls ─────────────────────────────────
  socket.on('manual_status', ({ targetName, status }) => {
    const found = getRoomBySocket(socket.id);
    if (!found) return;
    const { code, room } = found;
    if (socket.id !== room.hostId) return socket.emit('error', 'Host only');
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
    if (socket.id !== room.hostId) return;
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
    if (socket.id !== room.hostId) return;
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
          stopWeaknessTimer(room);
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
