# ⚔️ DUEL NEXUS — Real-Time RPG Challenge Tracker

A server-authoritative, real-time multiplayer RPG duel tracker for 2 players. 
Dark fantasy MMORPG aesthetic with full anti-cheat, status system, special abilities, and a synchronized battle log.

## ✨ Features

- **Real-time sync** via Socket.IO — every action instant on both screens
- **Server-authoritative** game logic — no client-side cheating possible
- **6-character room codes** — create and share with one player
- **Full status system** — N → R → A → H → AD → MB with automatic progression
- **Special abilities** — HYPNO (skip defenses) and BC (break protection + DoT)
- **Weakness system** — defender can trigger bonus damage once per match
- **Protection shield** — animated, breakable, restorable
- **Battle log** — exportable as TXT or JSON
- **Live stats** — damage dealt, rolls, hit rate, and more
- **Persistent rooms** — 30-minute reconnect window on disconnect
- **Dark fantasy UI** — animated HP bars, floating damage numbers, rune shimmer

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm

### Install & Run

```bash
# Install dependencies
npm install

# Start the server (production)
npm start

# Start with auto-reload (development)
npm run dev
```

Visit: http://localhost:3000

## 🌐 Deploy

### Render.com (free tier)
1. Push to GitHub
2. Create new Web Service on Render
3. Set Build Command: `npm install`
4. Set Start Command: `npm start`
5. Done — Render handles the rest

### Railway
```bash
# Install Railway CLI
npm i -g @railway/cli

railway login
railway init
railway up
```

### Environment Variables (optional)
```env
PORT=3000   # Default: 3000
```

No database required — all state is in-memory with Socket.IO sync.

## 🎮 How to Play

1. **Player 1** clicks "Create Match", sets battle parameters, gets a 6-char room code
2. **Player 2** clicks "Join Match", enters name + room code
3. Both players click **Ready**, host clicks **Start Battle**
4. Roll initiative — higher roll goes first
5. Attacker rolls to attack, defender rolls to defend — higher wins (ties favor attacker)
6. Status progresses: N → A (first hit) → H → AD → MB (instant KO)
7. First player to 0 HP loses

## ⚔️ Status Reference

| Status | Trigger | Effect |
|--------|---------|--------|
| N | Default | Normal |
| R | Protection disabled | 5 damage every 5 min |
| A | First successful attack | — |
| H | Attack while target in A | — |
| AD | Attack while target in H | -1 to future dice |
| MB | Attack while target in AD | HP → 0 instantly |

## 🧙 Special Abilities (Attacker only, once per match)

| Ability | Roll to Succeed | Effect on Success |
|---------|-----------------|-------------------|
| HYPNO | Roll a 6 | Defender skips next 2 defense rolls |
| BC Curse | Roll a 1 | Break shield + 10 dmg + 10 dmg/5min |

## 🛡️ Defender Ability

**Found Weakness** — Once per match, deal 10 bonus damage + optional note + optional negative status trigger.

## 📁 Project Structure

```
rpg-tracker/
├── server/
│   └── index.js          # Server + game logic (Socket.IO)
├── public/
│   ├── index.html        # Single-page app
│   ├── css/
│   │   └── style.css     # Dark fantasy theme
│   └── js/
│       └── game.js       # Client-side Socket.IO + UI
├── package.json
└── README.md
```

## 🔒 Anti-Cheat

All game logic runs on the server:
- Dice rolls are server-generated
- HP changes validated server-side
- Turn order enforced — clients cannot act out of turn
- Cooldowns tracked and validated server-side
- Special ability use-once enforced server-side
- Clients receive read-only state; they can never write their own HP or rolls

## 📜 License

MIT
