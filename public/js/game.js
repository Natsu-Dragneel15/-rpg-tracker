/**
 * DUEL NEXUS — Client-Side Game Logic
 * All game state is server-authoritative; this file handles UI only.
 */

// ─── Socket Setup ─────────────────────────────────────────────────────────────

const socket = io({ reconnectionDelay: 1000, reconnectionAttempts: 10 });

// ─── State ────────────────────────────────────────────────────────────────────

let myRole = null;
let myName = null;
let roomCode = null;
let isHost = false;
let lastState = null;
let cooldownTimer = null;
let matchTimerInterval = null;
let isReady = false;
let exportData = null;

// ─── Particle System ──────────────────────────────────────────────────────────

function initParticles() {
  const container = document.getElementById('particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = `
      left: ${Math.random() * 100}%;
      animation-duration: ${8 + Math.random() * 15}s;
      animation-delay: ${Math.random() * 10}s;
      opacity: ${0.2 + Math.random() * 0.4};
      width: ${1 + Math.random() * 2}px;
      height: ${1 + Math.random() * 2}px;
      background: ${Math.random() > 0.5 ? '#c9a227' : '#7c3aed'};
    `;
    container.appendChild(p);
  }
}

// ─── Floating Damage Numbers ──────────────────────────────────────────────────

function spawnDamageNumber(amount, type = 'damage', anchorEl = null) {
  const el = document.createElement('div');
  el.className = `float-num ${type}`;
  el.textContent = type === 'damage' ? `-${amount}` : type === 'heal' ? `+${amount}` : 'MISS!';

  const container = document.getElementById('floating-numbers');
  const rect = anchorEl?.getBoundingClientRect();
  el.style.left = rect ? `${rect.left + rect.width / 2 - 20}px` : `${30 + Math.random() * 40}%`;
  el.style.top = rect ? `${rect.top}px` : '40%';

  container.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// ─── Screen Management ────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`)?.classList.add('active');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 3000);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function copyCode() {
  if (!roomCode) return;
  navigator.clipboard.writeText(roomCode).then(() => showToast('Room code copied!', 'success'));
}

// ─── Create/Join ──────────────────────────────────────────────────────────────

function createRoom() {
  const name = document.getElementById('create-name').value.trim();
  if (!name) return showToast('Enter your name', 'error');

  const protEl = document.getElementById('set-protection');
  const settings = {
    startingHp: parseInt(document.getElementById('set-hp').value) || 100,
    damage: parseInt(document.getElementById('set-damage').value) || 25,
    diceFaces: parseInt(document.getElementById('set-dice').value) || 20,
    cooldownMinutes: parseFloat(document.getElementById('set-cooldown').value) || 2,
    protectionEnabled: protEl.checked,
    startingStatus: document.getElementById('set-status').value || 'N',
    prize: document.getElementById('create-prize').value.trim()
  };

  myName = name;
  socket.emit('create_room', { name, settings });
}

function joinRoom() {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) return showToast('Enter your name', 'error');
  if (!code) return showToast('Enter room code', 'error');
  myName = name;
  socket.emit('join_room', { code, name });
}

// ─── Lobby Actions ────────────────────────────────────────────────────────────

function toggleReady() {
  isReady = !isReady;
  socket.emit('set_ready', { ready: isReady });
  const btn = document.getElementById('btn-ready');
  btn.classList.toggle('active', isReady);
  btn.textContent = isReady ? '✅ Ready!' : '⚡ Ready Up';
}

function startMatch() {
  socket.emit('start_match');
}

// ─── Battle Actions ───────────────────────────────────────────────────────────

function rollInitiative() {
  socket.emit('roll_initiative');
  animateDice('my-dice');
}

function attack(abilityUsed) {
  socket.emit('attack', { abilityUsed: abilityUsed || null });
  animateDice('my-dice');
}

function defend() {
  socket.emit('defend');
  animateDice('my-dice');
}

function openWeaknessModal() {
  document.getElementById('weakness-modal').style.display = 'flex';
}

function closeWeaknessModal() {
  document.getElementById('weakness-modal').style.display = 'none';
}

function submitWeakness() {
  const note = document.getElementById('weakness-note').value.trim();
  const applyNeg = document.getElementById('weakness-neg-status').checked;
  socket.emit('found_weakness', { note, applyNegativeStatus: applyNeg });
  closeWeaknessModal();
}

function animateDice(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('rolling');
  void el.offsetWidth;
  el.classList.add('rolling');
  setTimeout(() => el.classList.remove('rolling'), 700);
}

// ─── Host Controls ────────────────────────────────────────────────────────────

function hostSetStatus() {
  const target = document.getElementById('hc-target').value;
  const status = document.getElementById('hc-status').value;
  socket.emit('manual_status', { targetName: target, status });
}

function hostRestoreProtection() {
  const target = document.getElementById('hc-target').value;
  socket.emit('manual_restore_protection', { targetName: target });
}

function hostTrigger(trigger) {
  socket.emit('manual_trigger', { trigger });
}

// ─── Export ───────────────────────────────────────────────────────────────────

function exportLog(format) {
  socket.emit('export_log');
  socket.once('export_data', (data) => {
    exportData = data;
    if (format === 'txt') exportTXT(data);
    else exportJSON(data);
  });
}

function exportTXT(data) {
  let txt = `DUEL NEXUS — BATTLE REPORT\n`;
  txt += `Room: ${roomCode}\n`;
  txt += `Started: ${data.startedAt ? new Date(data.startedAt).toLocaleString() : 'N/A'}\n`;
  txt += `Winner: ${data.winner?.name || 'TBD'}\n\n`;
  txt += `BATTLE LOG:\n${'─'.repeat(50)}\n`;
  data.log.forEach(e => {
    txt += `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}\n`;
  });
  downloadFile(`duel-log-${roomCode}.txt`, txt, 'text/plain');
}

function exportJSON(data) {
  downloadFile(`duel-log-${roomCode}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function downloadFile(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

// ─── UI Renderers ─────────────────────────────────────────────────────────────

function renderLobby(state) {
  const p1Id = Object.keys(state.me || {})[0];
  const me = state.me;
  const opp = state.opponent;

  document.getElementById('lobby-code').textContent = roomCode;

  if (state.settings?.prize) {
    document.getElementById('prize-banner').textContent = `🏆 PRIZE: ${state.settings.prize}`;
  }

  // Player 1 (attacker)
  const p1 = myRole === 'attacker' ? me : opp;
  const p2 = myRole === 'attacker' ? opp : me;

  if (p1) {
    document.getElementById('lobby-p1-name').textContent = p1.name;
    document.getElementById('lobby-p1-status').innerHTML =
      `<span class="ping-dot ${p1.connected ? 'online' : 'offline'}"></span> ${p1.connected ? 'Online' : 'Offline'}`;
    const r1 = document.getElementById('lobby-p1-ready');
    r1.textContent = p1.ready ? 'READY' : 'NOT READY';
    r1.className = `ready-badge${p1.ready ? ' ready' : ''}`;
  }

  if (p2) {
    document.getElementById('lobby-p2-name').textContent = p2.name;
    document.getElementById('lobby-p2-status').innerHTML =
      `<span class="ping-dot ${p2.connected ? 'online' : 'offline'}"></span> ${p2.connected ? 'Online' : 'Offline'}`;
    const r2 = document.getElementById('lobby-p2-ready');
    r2.textContent = p2.ready ? 'READY' : 'NOT READY';
    r2.className = `ready-badge${p2.ready ? ' ready' : ''}`;
  }

  // Settings
  const s = state.settings || {};
  document.getElementById('lobby-settings').innerHTML = `
    <div class="setting-item"><span class="setting-val">${s.startingHp}</span><span class="setting-key">HP</span></div>
    <div class="setting-item"><span class="setting-val">${s.damage}</span><span class="setting-key">Damage</span></div>
    <div class="setting-item"><span class="setting-val">d${s.diceFaces}</span><span class="setting-key">Dice</span></div>
    <div class="setting-item"><span class="setting-val">${(s.cooldownMs/60000).toFixed(1)}m</span><span class="setting-key">Cooldown</span></div>
    <div class="setting-item"><span class="setting-val">${s.startingStatus}</span><span class="setting-key">Status</span></div>
    <div class="setting-item"><span class="setting-val">${s.protectionEnabled ? '🛡️' : '❌'}</span><span class="setting-key">Shield</span></div>
  `;

  // Start button (host only, both ready)
  const both = me?.ready && opp?.ready;
  const startBtn = document.getElementById('btn-start');
  if (isHost) {
    startBtn.style.display = both ? 'inline-flex' : 'none';
  }
}

function renderBattle(state) {
  const me = state.me;
  const opp = state.opponent;
  if (!me || !opp) return;

  document.getElementById('battle-code').textContent = roomCode;

  // Names & roles
  document.getElementById('me-name').textContent = me.name;
  document.getElementById('me-role').textContent = me.role?.toUpperCase();
  document.getElementById('opp-name').textContent = opp.name;
  document.getElementById('opp-role').textContent = opp.role?.toUpperCase();

  // HP
  updateHP('me', me.hp, me.maxHp);
  updateHP('opp', opp.hp, opp.maxHp);

  // Status
  setStatus('me-status', me.status);
  setStatus('opp-status', opp.status);

  // Shield
  updateShield('me', me.protection);
  updateShield('opp', opp.protection);

  // Stats
  renderStats('me-stats', me.stats);
  renderStats('opp-stats', opp.stats);

  // Turn indicator
  renderTurnIndicator(state);

  // Action buttons
  renderActions(state);

  // Match timer
  if (state.startedAt && !matchTimerInterval) {
    startMatchTimer(state.startedAt);
  }

  // Host controls
  if (isHost) {
    document.getElementById('host-controls').style.display = 'block';
    const targetSel = document.getElementById('hc-target');
    targetSel.innerHTML = `
      <option value="${me.name}">${me.name}</option>
      <option value="${opp.name}">${opp.name}</option>
    `;
  }

  // Cooldown display
  updateCooldown(state.cooldownRemaining, state.settings?.cooldownMs);
}

function updateHP(side, hp, max) {
  const prev = parseInt(document.getElementById(`${side}-hp`).textContent) || hp;
  document.getElementById(`${side}-hp`).textContent = hp;
  document.getElementById(`${side}-max`).textContent = max;

  const pct = max > 0 ? (hp / max) * 100 : 0;
  const bar = document.getElementById(`${side}-hp-bar`);
  bar.style.width = `${pct}%`;

  const colors = pct > 50
    ? 'linear-gradient(90deg, #16a34a, #22c55e)'
    : pct > 25
    ? 'linear-gradient(90deg, #ca8a04, #eab308)'
    : 'linear-gradient(90deg, #b91c1c, #ef4444)';
  bar.style.background = colors;

  const hpEl = document.getElementById(`${side}-hp`);
  hpEl.className = 'hp-current' + (pct <= 25 ? ' hp-red' : pct <= 50 ? ' hp-yellow' : '');

  // Spawn damage number if HP decreased
  if (prev > hp) {
    const diff = prev - hp;
    const anchorEl = document.getElementById(`${side}-panel`);
    spawnDamageNumber(diff, 'damage', anchorEl);
  }
}

function setStatus(elId, status) {
  const el = document.getElementById(elId);
  el.textContent = status;
  el.className = `status-badge status-${status}`;
}

function updateShield(side, hasProtection) {
  const icon = document.getElementById(`${side}-shield-icon`);
  if (hasProtection) {
    icon.textContent = '🛡️';
    icon.classList.remove('broken');
  } else {
    icon.textContent = '💔';
    icon.classList.add('broken');
  }
}

function renderStats(elId, stats) {
  if (!stats) return;
  const avg = stats.rollCount > 0 ? (stats.totalRoll / stats.rollCount).toFixed(1) : '—';
  document.getElementById(elId).innerHTML = `
    <div class="stat-line"><span class="stat-label">Attacks</span><span class="stat-val">${stats.attacks}</span></div>
    <div class="stat-line"><span class="stat-label">Hits</span><span class="stat-val">${stats.hits}</span></div>
    <div class="stat-line"><span class="stat-label">Misses</span><span class="stat-val">${stats.misses}</span></div>
    <div class="stat-line"><span class="stat-label">Dmg Dealt</span><span class="stat-val">${stats.damageDealt}</span></div>
    <div class="stat-line"><span class="stat-label">Dmg Taken</span><span class="stat-val">${stats.damageReceived}</span></div>
    <div class="stat-line"><span class="stat-label">High Roll</span><span class="stat-val">${stats.highRoll || '—'}</span></div>
    <div class="stat-line"><span class="stat-label">Avg Roll</span><span class="stat-val">${avg}</span></div>
  `;
}

function renderTurnIndicator(state) {
  const turnEl = document.getElementById('topbar-turn');
  const phase = state.phase;

  if (phase === 'initiative') {
    const rolled = state.initiativeRolls && Object.keys(state.initiativeRolls).length;
    turnEl.textContent = rolled > 0 ? 'WAITING FOR OPPONENT...' : 'ROLL INITIATIVE';
    turnEl.className = 'topbar-turn';
    document.getElementById('phase-message').textContent = 'Both players must roll for initiative';
  } else if (phase === 'battle') {
    if (state.myTurn && !state.pendingDefense) {
      turnEl.textContent = '⚔️ YOUR ATTACK TURN';
      turnEl.className = 'topbar-turn your-turn';
      document.getElementById('phase-message').textContent = 'Attack your opponent!';
    } else if (state.pendingDefense && !state.myTurn) {
      // I am being attacked; wait for server to tell me if I need to defend
      turnEl.textContent = 'OPPONENT ATTACKING...';
      turnEl.className = 'topbar-turn';
      document.getElementById('phase-message').textContent = 'Opponent is attacking...';
    } else if (state.pendingDefense && state.myTurn) {
      // The opponent is defending against my attack
      turnEl.textContent = 'OPPONENT DEFENDING...';
      turnEl.className = 'topbar-turn';
      document.getElementById('phase-message').textContent = 'Waiting for opponent to defend...';
    } else {
      turnEl.textContent = 'OPPONENT\'S TURN';
      turnEl.className = 'topbar-turn';
      document.getElementById('phase-message').textContent = 'Wait for your opponent to attack';
    }
  }
}

function renderActions(state) {
  const container = document.getElementById('action-buttons');
  const phase = state.phase;
  const me = state.me;
  const opp = state.opponent;
  container.innerHTML = '';

  if (phase === 'initiative') {
    const hasRolled = state.initiativeRolls &&
      Object.values(state.initiativeRolls).some(Boolean);
    const btn = makeBtn('🎲 Roll Initiative', 'btn-initiative', rollInitiative);
    container.appendChild(btn);
    return;
  }

  if (phase !== 'battle') return;

  const myTurn = state.myTurn;
  const pendingDefense = state.pendingDefense;
  const cooldown = state.cooldownRemaining > 0;

  // ATTACK (my turn, no pending, no cooldown)
  if (myTurn && !pendingDefense) {
    const atk = makeBtn('⚔️ Attack', 'btn-attack', () => attack());
    atk.disabled = cooldown;
    container.appendChild(atk);

    // Abilities (attacker role only)
    if (me?.role === 'attacker') {
      if (!me.hypnoUsed) {
        const h = makeBtn('🌀 HYPNO (roll 6)', 'btn-ability', () => attack('HYPNO'));
        h.disabled = cooldown;
        container.appendChild(h);
      }
      if (!me.bcUsed) {
        const bc = makeBtn('⛓️ BC Curse (roll 1)', 'btn-ability', () => attack('BC'));
        bc.disabled = cooldown;
        container.appendChild(bc);
      }
    }
  }

  // DEFEND (not my attack turn, but defense is pending and I'm the defender)
  if (!myTurn && pendingDefense) {
    // I need to defend
    const def = makeBtn('🛡️ Roll Defense', 'btn-defend', defend);
    container.appendChild(def);

    // Show HYPNO skip indicator if active
    if (state.hypnoSkipsRemaining > 0) {
      const info = document.createElement('div');
      info.className = 'hypno-indicator';
      info.textContent = `🌀 HYPNOSIS ACTIVE — ${state.hypnoSkipsRemaining} SKIPS REMAINING`;
      container.appendChild(info);
    }
  }

  // FOUND WEAKNESS (defender, not their turn)
  if (me?.role === 'defender' && !me.weaknessUsed) {
    const w = makeBtn('🎯 Found Weakness', 'btn-weakness', openWeaknessModal);
    container.appendChild(w);
  }
}

function makeBtn(text, cls, fn) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.className = cls;
  btn.onclick = fn;
  return btn;
}

function updateCooldown(remaining, total) {
  const el = document.getElementById('cooldown-display');
  const txt = document.getElementById('cooldown-text');

  if (remaining > 0) {
    el.style.display = 'flex';
    txt.textContent = `COOLDOWN: ${formatTime(remaining)}`;

    // Update every second locally
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      remaining -= 1000;
      if (remaining <= 0) {
        el.style.display = 'none';
        clearInterval(cooldownTimer);
      } else {
        txt.textContent = `COOLDOWN: ${formatTime(remaining)}`;
      }
    }, 1000);
  } else {
    el.style.display = 'none';
    clearInterval(cooldownTimer);
  }
}

function startMatchTimer(startedAt) {
  clearInterval(matchTimerInterval);
  matchTimerInterval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    document.getElementById('match-timer').textContent = formatTime(elapsed);
  }, 1000);
}

function renderBattleLog(log) {
  const body = document.getElementById('log-body');
  body.innerHTML = '';
  log.slice().reverse().forEach(entry => {
    const div = document.createElement('div');
    const typeClass = entry.type === 'hit' ? 'hit'
      : entry.type === 'miss' ? 'miss'
      : entry.type?.includes('status') || entry.type?.includes('trigger') ? 'status'
      : entry.type === 'game_over' ? 'game_over'
      : entry.type?.includes('bc') || entry.type?.includes('hypno') ? 'ability'
      : '';
    div.className = `log-entry ${typeClass}`;
    div.innerHTML = `<span class="log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span><span class="log-msg">${entry.message}</span>`;
    body.appendChild(div);
  });
}

function renderVictory(state) {
  clearInterval(matchTimerInterval);
  const winner = state.winner;
  document.getElementById('victory-name').textContent = winner?.name || 'Unknown';

  // Find winner's stats
  const isMe = state.me?.name === winner?.name;
  const winStats = isMe ? state.me?.stats : state.opponent?.stats;

  if (winStats) {
    const avg = winStats.rollCount > 0 ? (winStats.totalRoll / winStats.rollCount).toFixed(1) : '—';
    document.getElementById('victory-stats').innerHTML = `
      <div class="victory-stat"><span class="victory-stat-val">${winStats.hits}</span><span class="victory-stat-key">Hits</span></div>
      <div class="victory-stat"><span class="victory-stat-val">${winStats.damageDealt}</span><span class="victory-stat-key">Damage Dealt</span></div>
      <div class="victory-stat"><span class="victory-stat-val">${winStats.highRoll || '—'}</span><span class="victory-stat-key">High Roll</span></div>
      <div class="victory-stat"><span class="victory-stat-val">${avg}</span><span class="victory-stat-key">Avg Roll</span></div>
    `;
  }

  if (state.settings?.prize) {
    document.getElementById('victory-prize').textContent = `🏆 ${state.settings.prize}`;
  }

  showScreen('victory');
}

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('room_created', ({ code, role }) => {
  roomCode = code;
  myRole = role;
  isHost = true;
  showScreen('lobby');
  document.getElementById('lobby-code').textContent = code;
  showToast(`Room created: ${code}`, 'success');

  // Set up protection toggle display
  const protToggle = document.getElementById('set-protection');
  if (protToggle) {
    protToggle.addEventListener('change', () => {
      document.getElementById('protection-text').textContent =
        protToggle.checked ? 'Enabled' : 'Disabled';
    });
  }
});

socket.on('room_joined', ({ code, role }) => {
  roomCode = code;
  myRole = role;
  isHost = false;
  showScreen('lobby');
  document.getElementById('lobby-code').textContent = code;
  showToast(`Joined room: ${code}`, 'success');
});

socket.on('player_joined', ({ name }) => {
  showToast(`${name} joined the arena!`, 'success');
});

socket.on('player_disconnected', ({ name }) => {
  showToast(`${name} disconnected. Room stays open 30 min.`, 'error');
});

socket.on('all_ready', () => {
  if (isHost) showToast('Both ready! Start the battle!', 'success');
});

socket.on('state_update', (state) => {
  lastState = state;

  const phase = state.phase;

  if (phase === 'lobby') {
    renderLobby(state);
  } else if (phase === 'initiative' || phase === 'battle') {
    if (document.getElementById('screen-lobby').classList.contains('active')) {
      showScreen('battle');
    }
    renderBattle(state);
    renderBattleLog(state.battleLog || []);
    if (state.initiativeRolls) {
      renderInitiativeRolls(state.initiativeRolls);
    }
  } else if (phase === 'ended') {
    if (document.getElementById('screen-battle').classList.contains('active')) {
      renderBattle(state);
      renderBattleLog(state.battleLog || []);
    }
    renderVictory(state);
  }
});

function renderInitiativeRolls(rolls) {
  // Show opponent's roll if available
  // This is simplified — in full flow, server tracks who rolled what
}

socket.on('error', (msg) => {
  showToast(msg, 'error');
});

socket.on('connect', () => {
  if (roomCode && myName) {
    // Attempt reconnect
    socket.emit('join_room', { code: roomCode, name: myName });
  }
});

socket.on('disconnect', () => {
  showToast('Connection lost. Reconnecting...', 'error');
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  showScreen('landing');

  // Enter key on join inputs
  ['join-name', 'join-code'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') joinRoom();
    });
  });

  document.getElementById('create-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') createRoom();
  });

  // Auto-uppercase room code
  document.getElementById('join-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
});
