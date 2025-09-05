# Multiplayer Rooms — TODO

task_progress: 4/7

- [x] Add server socket handlers:
  - [x] `set_room_options` (admin only): set room.game, room.timeLimit; emit `room_update`
  - [x] `start_room_game` (admin only): set status='running', startTs/endTs; emit `room_update` and `game_start`
  - [x] `stop_room_game` (admin only): set status='waiting' or ended; emit `room_update` and `game_end`
  - [x] Transfer admin when current admin disconnects

- [x] Add server-side permission checks & validation (verify socket.id === room.admin)

- [x] Extend client NET (js/net.js):
  - [x] NET.setRoomOptions({roomId, game, timeLimit}, cb)
  - [x] NET.startRoomGame({roomId}, cb)
  - [x] NET.on('room_update' | 'game_start' | 'game_end', ...)

- [ ] Update UI (js/ui.js):
  - [x] Remove duplicate name input; use main #playerName as single source of truth (done)
  - [ ] Show admin panel (game selector, time input, Start button) when local user is admin
  - [ ] For non-admins in-room: hide create/join controls, show name-only + "Waiting for admin" indicator
  - [ ] Update smallBar to persist Create/Leave and show room status/players

- [ ] Update game (js/game.js):
  - [ ] Start game only on receiving `game_start` from server (use provided gameId/time)
  - [ ] Render ghosted peers from NET peer_hand events with interpolation

- [ ] Test full flow via cloudflared public URL (multiple devices); validate leaderboard POST/GET

Notes:
- Keep rooms in-memory (MVP). Persist leaderboards to server/leaderboard.json (already implemented).
- Use quantized/throttled peer_hand events (existing NET.sendHand) for low bandwidth.
