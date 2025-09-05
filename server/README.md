task_progress: 5/7

# Server README — hand-tracking-games/server

Quick facts
- Node + Express + Socket.IO server for Rooms, presence, hand forwarding and global leaderboards.
- Leaderboards persisted to disk at `server/leaderboard.json`.
- Rooms manager is in-memory (auto-clean after empty for 30s). Room IDs use short nanoid tokens by default.

Run locally
1. Install dependencies
   - From project root run:
     npm install --prefix server

2. Start server (dev)
   - npm run dev --prefix server
   - Or production: npm start --prefix server
   - Server listens on port 3000 by default (set `PORT` env to change).

What the server exposes
- Socket.IO (default path) — use the socket.io client at `/socket.io/socket.io.js`.
  Events:
  - emit: create_room { id?, isPublic? } -> callback { ok, room }
  - emit: join_room { roomId, name } -> callback { ok, room, peers }
  - emit: leave_room
  - emit: hand payload -> forwarded to peers in room via `peer_hand`
  - emit: score { game, name, score } -> server persists and emits `leaderboard_update`
  - receives connections and emits `rooms_list` to keep clients updated
- REST:
  - GET  /leaderboard?game=GAMEID  -> { game, leaders: [...] }
  - POST /leaderboard  (JSON: { game, name, score }) -> returns updated leaders

Testing cross-device (no credit card)
- Use Cloudflare Tunnel (cloudflared) to expose your localhost to the web for phone testing:
  1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation
  2. Run the server locally: npm start --prefix server
  3. Start a tunnel for port 3000:
     cloudflared tunnel --url http://localhost:3000
  4. cloudflared prints a public URL you can open on your phone.

Alternate: ngrok (requires signup) — cloudflared preferred for no-credit-card testing.

Notes & next steps
- The server currently keeps rooms in-memory. For scale, swap to a Redis-backed adapter (socket.io-redis) and persist leaderboards to a proper DB.
- Recommended follow-ups:
  - [ ] Run `npm install` in `server/` then `npm run dev` to verify runtime.
  - [ ] Test phone+desktop join via cloudflared.
  - [ ] Tune quantization/throttle in `js/net.js` (currently ~12Hz, QUANT_MAX=1000).
  - [ ] (Optional) Add authentication or optional room passwords.
