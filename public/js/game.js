/**
 * DUEL NEXUS — Client-Side Game Logic
 * All game state is server-authoritative; this file handles UI only.
 */

const socket = io({ reconnectionDelay: 1000, reconnectionAttempts: 10 });

let myRole = null;
let myName = null;
let roomCode = null;
let isOwner = false;   // true when this player is the Defender (room owner)
let lastState = null;
let cooldownTimer = null;
let matchTimerInterval = null;
let isReady = false;

// ─── Particles ────────────────────────────────────────────────────────────────

function initParticles() {
  const container = document.getElementById('particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.cssText = `
      left:${Math.random()*100}%;
      animation-duration:${8+Math.random()*15}s;
      animation-delay:${Math.random()*10}s;
      width:${1+Math.random()*2}px;height:${1+Math.random()*2}px;
      background:${Math.random()>.5?'#c9a227':'#7c3aed'};
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
  el.style.left = rect ? `${rect.left + rect.width/2 - 20}px` : `${30+Math.random()*40}%`;
  el.style.top  = rect ? `${rect.top}px` : '40%';
  container.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// ─── Screens & Toast ──────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`)?.classList.add('active');
}

let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 3000);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function copyCode() {
  if (!roomCode) return;
  navigator.clipboard.writeText(roomCode).then(() => showToast('Room code copied!', 'success'));
}

// ─── Create / Join ────────────────────────────────────────────────────────────

function createRoom() {
  const name = document.getElementById('create-name').value.trim();
  if (!name) return showToast('Enter your name', 'error');

  const settings = {
    startingHp:               parseInt(document.getElementById('set-hp').value)       || 100,
    damage:                   parseInt(document.getElementById('set-damage').value)    || 25,
    diceFaces:                parseInt(document.getElementById('set-dice').value)      || 20,
    cooldownSeconds:           parseFloat(document.getElementById('set-cooldown').value)|| 120,
    protectionEnabled:        document.getElementById('set-protection').checked,
    prize:                    document.getElementById('create-prize').value.trim(),
    totalRounds:              getRoundsValue()
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

// ─── Lobby ────────────────────────────────────────────────────────────────────

function toggleReady() {
  isReady = !isReady;
  socket.emit('set_ready', { ready: isReady });
  const btn = document.getElementById('btn-ready');
  btn.classList.toggle('active', isReady);
  btn.textContent = isReady ? '✅ Ready!' : '⚡ Ready Up';
}

function startMatch() { socket.emit('start_match'); }

// ─── Battle Actions ───────────────────────────────────────────────────────────

function rollInitiative() { socket.emit('roll_initiative'); animateDice('my-dice'); }
function attack(abilityUsed) { socket.emit('attack', { abilityUsed: abilityUsed || null }); animateDice('my-dice'); }
function defend() { socket.emit('defend'); animateDice('my-dice'); }

function useWeakness() { socket.emit('found_weakness'); }

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
  socket.emit('manual_status', {
    targetName: document.getElementById('hc-target').value,
    status: document.getElementById('hc-status').value
  });
}
function hostRestoreProtection() {
  socket.emit('manual_restore_protection', { targetName: document.getElementById('hc-target').value });
}
function hostTrigger(trigger) { socket.emit('manual_trigger', { trigger }); }

// ─── Export ───────────────────────────────────────────────────────────────────

function exportLog(format) {
  socket.emit('export_log');
  socket.once('export_data', (data) => {
    if (format === 'txt') {
      let txt = `DUEL NEXUS — BATTLE REPORT\nRoom: ${roomCode}\nStarted: ${data.startedAt ? new Date(data.startedAt).toLocaleString() : 'N/A'}\nWinner: ${data.winner?.name || 'TBD'}\n\nBATTLE LOG:\n${'─'.repeat(50)}\n`;
      data.log.forEach(e => { txt += `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}\n`; });
      downloadFile(`duel-log-${roomCode}.txt`, txt, 'text/plain');
    } else {
      downloadFile(`duel-log-${roomCode}.json`, JSON.stringify(data, null, 2), 'application/json');
    }
  });
}

function downloadFile(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

// ─── Lobby Renderer ───────────────────────────────────────────────────────────

function renderLobby(state) {
  document.getElementById('lobby-code').textContent = roomCode;
  if (state.settings?.prize) {
    document.getElementById('prize-banner').textContent = `🏆 PRIZE: ${state.settings.prize}`;
  }

  const p1 = myRole === 'attacker' ? state.me : state.opponent;
  const p2 = myRole === 'attacker' ? state.opponent : state.me;

  if (p1) {
    document.getElementById('lobby-p1-name').textContent = p1.name;
    document.getElementById('lobby-p1-status').innerHTML = `<span class="ping-dot ${p1.connected?'online':'offline'}"></span> ${p1.connected?'Online':'Offline'}`;
    const r1 = document.getElementById('lobby-p1-ready');
    r1.textContent = p1.ready ? 'READY' : 'NOT READY';
    r1.className = `ready-badge${p1.ready?' ready':''}`;
  }
  if (p2) {
    document.getElementById('lobby-p2-name').textContent = p2.name;
    document.getElementById('lobby-p2-status').innerHTML = `<span class="ping-dot ${p2.connected?'online':'offline'}"></span> ${p2.connected?'Online':'Offline'}`;
    const r2 = document.getElementById('lobby-p2-ready');
    r2.textContent = p2.ready ? 'READY' : 'NOT READY';
    r2.className = `ready-badge${p2.ready?' ready':''}`;
  }

  const s = state.settings || {};
  document.getElementById('lobby-settings').innerHTML = `
    <div class="setting-item"><span class="setting-val">${s.startingHp}</span><span class="setting-key">HP</span></div>
    <div class="setting-item"><span class="setting-val">${s.damage}</span><span class="setting-key">Damage</span></div>
    <div class="setting-item"><span class="setting-val">d${s.diceFaces}</span><span class="setting-key">Dice</span></div>
    <div class="setting-item"><span class="setting-val">${Math.round(s.cooldownMs/1000)}s</span><span class="setting-key">Cooldown</span></div>
    <div class="setting-item"><span class="setting-val">${s.startingStatus}</span><span class="setting-key">Status</span></div>
    <div class="setting-item"><span class="setting-val">${s.protectionEnabled?'🛡️':'❌'}</span><span class="setting-key">Shield</span></div>
    <div class="setting-item"><span class="setting-val">${s.totalRounds || 1}</span><span class="setting-key">Rounds</span></div>
  `;

  if (isOwner) {
    document.getElementById('btn-start').style.display =
      (state.me?.ready && state.opponent?.ready) ? 'inline-flex' : 'none';
  }
}

// ─── Battle Renderer ──────────────────────────────────────────────────────────

function renderBattle(state) {
  const me = state.me, opp = state.opponent;
  if (!me || !opp) return;

  document.getElementById('battle-code').textContent = roomCode;
  const totalRounds = state.totalRounds || 1;
  document.getElementById('round-display').textContent =
    totalRounds > 1 ? `ROUND ${state.currentRound || 1} / ${totalRounds}` : '';
  document.getElementById('me-name').textContent = me.name;
  document.getElementById('me-role').textContent = me.role?.toUpperCase();
  document.getElementById('opp-name').textContent = opp.name;
  document.getElementById('opp-role').textContent = opp.role?.toUpperCase();

  updateHP('me', me.hp, me.maxHp);
  updateHP('opp', opp.hp, opp.maxHp);
  setStatus('me-status', me.status);
  setStatus('opp-status', opp.status);
  updateShield('me', me.protection);
  updateShield('opp', opp.protection);
  renderStats('me-stats', me.stats);
  renderStats('opp-stats', opp.stats);

  // Defeated visual when status is MB
  document.getElementById('me-panel').classList.toggle('defeated', me.status === 'MB');
  document.getElementById('opp-panel').classList.toggle('defeated', opp.status === 'MB');
  renderTurnIndicator(state);
  renderActions(state);

  if (state.startedAt && !matchTimerInterval) startMatchTimer(state.startedAt);

  // Sync owner status from server (handles reconnect)
  if (state.isOwner !== undefined) isOwner = state.isOwner;

  if (isOwner) {
    document.getElementById('host-controls').style.display = 'block';
    document.getElementById('hc-target').innerHTML = `
      <option value="${me.name}">${me.name}</option>
      <option value="${opp.name}">${opp.name}</option>
    `;
  } else {
    document.getElementById('host-controls').style.display = 'none';
  }

  updateCooldown(state.cooldownRemaining, state.settings?.cooldownMs);
}

function updateHP(side, hp, max) {
  const prev = parseInt(document.getElementById(`${side}-hp`).textContent) || hp;
  document.getElementById(`${side}-hp`).textContent = hp;
  document.getElementById(`${side}-max`).textContent = max;
  const pct = max > 0 ? (hp/max)*100 : 0;
  const bar = document.getElementById(`${side}-hp-bar`);
  bar.style.width = `${pct}%`;
  bar.style.background = pct > 50
    ? 'linear-gradient(90deg,#16a34a,#22c55e)'
    : pct > 25
    ? 'linear-gradient(90deg,#ca8a04,#eab308)'
    : 'linear-gradient(90deg,#b91c1c,#ef4444)';
  document.getElementById(`${side}-hp`).className = 'hp-current' + (pct<=25?' hp-red':pct<=50?' hp-yellow':'');
  if (prev > hp) spawnDamageNumber(prev-hp, 'damage', document.getElementById(`${side}-panel`));
}

function setStatus(elId, status) {
  const el = document.getElementById(elId);
  el.textContent = status;
  el.className = `status-badge status-${status}`;
}

function updateShield(side, has) {
  const icon = document.getElementById(`${side}-shield-icon`);
  if (icon) {
    icon.textContent = has ? '🛡️' : '💔';
    icon.classList.toggle('broken', !has);
  }
  // Update the always-visible protection indicator
  const indicator = document.getElementById(`${side}-protection-indicator`);
  if (indicator) {
    indicator.textContent = has ? '🛡 ON' : '🛡 OFF';
    indicator.className = `protection-indicator ${has ? 'prot-on' : 'prot-off'}`;
  }
}

function renderStats(elId, stats) {
  if (!stats) return;
  const avg = stats.rollCount > 0 ? (stats.totalRoll/stats.rollCount).toFixed(1) : '—';
  document.getElementById(elId).innerHTML = `
    <div class="stat-line"><span class="stat-label">Attacks</span><span class="stat-val">${stats.attacks}</span></div>
    <div class="stat-line"><span class="stat-label">Hits</span><span class="stat-val">${stats.hits}</span></div>
    <div class="stat-line"><span class="stat-label">Misses</span><span class="stat-val">${stats.misses}</span></div>
    <div class="stat-line"><span class="stat-label">Dmg Dealt</span><span class="stat-val">${stats.damageDealt}</span></div>
    <div class="stat-line"><span class="stat-label">Dmg Taken</span><span class="stat-val">${stats.damageReceived}</span></div>
    <div class="stat-line"><span class="stat-label">High Roll</span><span class="stat-val">${stats.highRoll||'—'}</span></div>
    <div class="stat-line"><span class="stat-label">Avg Roll</span><span class="stat-val">${avg}</span></div>
  `;
}

function renderTurnIndicator(state) {
  const el = document.getElementById('topbar-turn');
  const msg = document.getElementById('phase-message');
  if (state.phase === 'initiative') {
    el.textContent = 'ROLL INITIATIVE'; el.className = 'topbar-turn';
    msg.textContent = 'Both players must roll for initiative';
  } else if (state.phase === 'mb') {
    el.textContent = '💀 ROUND OVER'; el.className = 'topbar-turn';
    msg.textContent = state.isOwner ? 'Click Finish Round to end the match' : 'Waiting for Room Owner to finish the round...';
  } else if (state.phase === 'battle') {
    if (state.myTurn && !state.pendingDefense) {
      el.textContent = '⚔️ YOUR ATTACK TURN'; el.className = 'topbar-turn your-turn';
      msg.textContent = 'Attack your opponent!';
    } else if (state.pendingDefense && !state.myTurn) {
      el.textContent = 'DEFEND!'; el.className = 'topbar-turn your-turn';
      msg.textContent = 'Roll your defense!';
    } else {
      el.textContent = "OPPONENT'S TURN"; el.className = 'topbar-turn';
      msg.textContent = 'Wait for your opponent';
    }
  }
}

function renderActions(state) {
  const container = document.getElementById('action-buttons');
  container.innerHTML = '';

  const me = state.me;
  const isDefeated = me?.status === 'MB' || me?.hp <= 0;

  // MB phase: only owner sees Finish Round; defeated player sees nothing
  if (state.phase === 'mb') {
    if (state.isOwner) {
      container.appendChild(makeBtn('🏁 Finish Round', 'btn-primary', () => socket.emit('finish_round')));
    }
    return;
  }

  if (state.phase === 'initiative') {
    // Don't show initiative roll if player is somehow defeated
    if (!isDefeated) container.appendChild(makeBtn('🎲 Roll Initiative', 'btn-initiative', rollInitiative));
    return;
  }

  if (state.phase !== 'battle') return;

  // Defeated player (MB) cannot act
  if (isDefeated) return;

  const cooldown = state.cooldownRemaining > 0;

  if (state.myTurn && !state.pendingDefense) {
    const atk = makeBtn('⚔️ Attack', 'btn-attack', () => attack());
    atk.disabled = cooldown;
    container.appendChild(atk);

    if (me?.role === 'attacker') {
      if (!me.hypnoUsed) {
        const h = makeBtn('🌀 HYPNO (roll 6)', 'btn-ability', () => attack('HYPNO'));
        h.disabled = cooldown; container.appendChild(h);
      }
      if (!me.bcUsed) {
        const bc = makeBtn('⛓️ BC Curse (roll 1)', 'btn-ability', () => attack('BC'));
        bc.disabled = cooldown; container.appendChild(bc);
      }
    }
  }

  if (!state.myTurn && state.pendingDefense) {
    container.appendChild(makeBtn('🛡️ Roll Defense', 'btn-defend', defend));
    if (state.hypnoSkipsRemaining > 0) {
      const info = document.createElement('div');
      info.className = 'hypno-indicator';
      info.textContent = `🌀 HYPNOSIS ACTIVE — ${state.hypnoSkipsRemaining} SKIPS REMAINING`;
      container.appendChild(info);
    }
  }

  // Weakness button — Defender (Room Owner) only, one-time use
  if (state.isOwner && me?.role === 'defender') {
    const wBtn = makeBtn('🎯 Weakness Found', 'btn-weakness', useWeakness);
    wBtn.disabled = !!me.weaknessUsed;
    if (me.weaknessUsed) wBtn.textContent = '🎯 Weakness Used';
    container.appendChild(wBtn);
  }
}

function makeBtn(text, cls, fn) {
  const btn = document.createElement('button');
  btn.textContent = text; btn.className = cls; btn.onclick = fn;
  return btn;
}

function updateCooldown(remaining, total) {
  const el = document.getElementById('cooldown-display');
  const txt = document.getElementById('cooldown-text');
  clearInterval(cooldownTimer);
  if (remaining > 0) {
    el.style.display = 'flex';
    txt.textContent = `COOLDOWN: ${formatTime(remaining)}`;
    setActionButtonsDisabled(true);
    let ms = remaining;
    cooldownTimer = setInterval(() => {
      ms -= 1000;
      if (ms <= 0) {
        el.style.display = 'none';
        clearInterval(cooldownTimer);
        setActionButtonsDisabled(false);
      } else {
        txt.textContent = `COOLDOWN: ${formatTime(ms)}`;
      }
    }, 1000);
  } else {
    el.style.display = 'none';
    setActionButtonsDisabled(false);
  }
}

// Re-enable attack/ability buttons once cooldown expires locally,
// without waiting for the next server state_update broadcast.
function setActionButtonsDisabled(disabled) {
  document.querySelectorAll('.btn-attack, .btn-ability').forEach(btn => {
    btn.disabled = disabled;
  });
}

function startMatchTimer(startedAt) {
  clearInterval(matchTimerInterval);
  matchTimerInterval = setInterval(() => {
    document.getElementById('match-timer').textContent = formatTime(Date.now() - startedAt);
  }, 1000);
}

function renderBattleLog(log) {
  const body = document.getElementById('log-body');
  body.innerHTML = '';
  log.slice().reverse().forEach(entry => {
    const div = document.createElement('div');
    const typeClass = entry.type==='hit'?'hit':entry.type==='miss'?'miss'
      :entry.type?.includes('status')||entry.type?.includes('trigger')?'status'
      :entry.type==='game_over'?'game_over'
      :entry.type?.includes('weakness')?'weakness'
      :entry.type?.includes('bc')||entry.type?.includes('hypno')?'ability':'';
    div.className = `log-entry ${typeClass}`;
    div.innerHTML = `<span class="log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span><span class="log-msg">${entry.message}</span>`;
    body.appendChild(div);
  });
}

function renderVictory(state) {
  clearInterval(matchTimerInterval);
  const winner = state.winner;
  document.getElementById('victory-name').textContent = winner?.name || 'Unknown';
  const isMe = state.me?.name === winner?.name;
  const winStats = isMe ? state.me?.stats : state.opponent?.stats;
  if (winStats) {
    const avg = winStats.rollCount>0?(winStats.totalRoll/winStats.rollCount).toFixed(1):'—';
    document.getElementById('victory-stats').innerHTML = `
      <div class="victory-stat"><span class="victory-stat-val">${winStats.hits}</span><span class="victory-stat-key">Hits</span></div>
      <div class="victory-stat"><span class="victory-stat-val">${winStats.damageDealt}</span><span class="victory-stat-key">Damage Dealt</span></div>
      <div class="victory-stat"><span class="victory-stat-val">${winStats.highRoll||'—'}</span><span class="victory-stat-key">High Roll</span></div>
      <div class="victory-stat"><span class="victory-stat-val">${avg}</span><span class="victory-stat-key">Avg Roll</span></div>
    `;
  }

  // Show round scores if multi-round match
  const scores = state.roundScores;
  const totalRounds = state.totalRounds || 1;
  const prizeEl = document.getElementById('victory-prize');
  if (scores && totalRounds > 1) {
    const me = state.me?.name, opp = state.opponent?.name;
    const myScore = scores[me] || 0, oppScore = scores[opp] || 0;
    prizeEl.innerHTML = `<div style="font-size:1.4rem;letter-spacing:3px;margin-bottom:8px">${me} ${myScore} — ${oppScore} ${opp}</div>${state.settings?.prize ? `🏆 ${state.settings.prize}` : ''}`;
  } else if (state.settings?.prize) {
    prizeEl.textContent = `🏆 ${state.settings.prize}`;
  }

  showScreen('victory');
}

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('room_created', ({ code, role }) => {
  roomCode = code; myRole = role; isOwner = true;
  showScreen('lobby');
  document.getElementById('lobby-code').textContent = code;
  showToast(`Room created: ${code}`, 'success');
});

socket.on('room_joined', ({ code, role }) => {
  roomCode = code; myRole = role; isOwner = false;
  showScreen('lobby');
  showToast(`Joined room: ${code}`, 'success');
});

socket.on('player_joined', ({ name }) => showToast(`${name} joined the arena!`, 'success'));
socket.on('player_disconnected', ({ name }) => showToast(`${name} disconnected. Room stays open 30 min.`, 'error'));
socket.on('all_ready', () => { if (isOwner) showToast('Both ready! Start the battle!', 'success'); });

socket.on('state_update', (state) => {
  lastState = state;
  const phase = state.phase;
  if (phase === 'lobby') {
    renderLobby(state);
  } else if (phase === 'initiative' || phase === 'battle' || phase === 'mb') {
    if (document.getElementById('screen-lobby').classList.contains('active')) showScreen('battle');
    renderBattle(state);
    renderBattleLog(state.battleLog || []);
  } else if (phase === 'ended') {
    if (!document.getElementById('screen-victory').classList.contains('active')) {
      renderBattle(state);
      renderBattleLog(state.battleLog || []);
      renderVictory(state);
    }
  }
});

socket.on('error', (msg) => showToast(msg, 'error'));
socket.on('connect', () => { if (roomCode && myName) socket.emit('join_room', { code: roomCode, name: myName }); });
socket.on('disconnect', () => showToast('Connection lost. Reconnecting...', 'error'));

// ─── Init ─────────────────────────────────────────────────────────────────────

function getRoundsValue() {
  const sel = document.getElementById('set-rounds');
  if (!sel) return 1;
  if (sel.value === 'custom') return Math.max(1, parseInt(document.getElementById('set-rounds-custom').value) || 1);
  return parseInt(sel.value) || 1;
}

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  showScreen('landing');
  ['join-name','join-code'].forEach(id => document.getElementById(id)?.addEventListener('keydown', e => { if(e.key==='Enter') joinRoom(); }));
  document.getElementById('create-name')?.addEventListener('keydown', e => { if(e.key==='Enter') createRoom(); });
  document.getElementById('join-code')?.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
  document.getElementById('set-protection')?.addEventListener('change', e => {
    document.getElementById('protection-text').textContent = e.target.checked ? 'ON → Status: N' : 'OFF → Status: R';
  });
  document.getElementById('set-rounds')?.addEventListener('change', e => {
    document.getElementById('set-rounds-custom').style.display = e.target.value === 'custom' ? 'block' : 'none';
  });
});
