# TODO

Current Progress: 5/7 items completed (71%)

- [x] Analyze requirements
- [x] Set up necessary files for inspection
- [x] Edit server spawn density
- [x] Restart server and run tests
- [x] Apply hard cap + logging in server
- [ ] Restart server and re-run tests to confirm
- [ ] Verify client popup and Miss behavior in browser

Notes:
- Server changes made: reduced MAX_ITEMS to 30 and added logging in generateGameItems; server now stores room.gameItems and emits authoritative payloads in game_start/game_begin.
- [ ] Implement optimistic client interaction flow:
  - client shows immediate feedback, calls `NET.sendInteractionImmediate(...)`
  - server validates interaction, updates `room.objectStates`, broadcasts `object_state` and `peer_score`
  - client reconciles on authoritative `object_state`
- [ ] Separate per-user cursors / hand tracking and per-user scores; sync scores via `peer_score` events
- [ ] Add late-join support: server should send current authoritative state (remaining objects, removed items, scores) to joiner
- [ ] Update `js/ui.js` to show admin controls (Start, forcePlayAll), room status, and per-user score list
- [ ] Add more logging and verification points to server and client for spawn timing checks (help debug sync drift)
- [ ] Add / update tests:
  - run `server/test-multi.js` to simulate multi-client flows
  - scripts/sim-peer-hand.js for input simulation
- [ ] Smoke test locally:
  - start server (resolve any port conflicts)
  - open admin + client, start game, validate schedule and interactions
- [ ] Cross-browser audio verification (AudioContext unlock, `musicController.startGame`)
- [ ] Tune gameplay parameters (spawn rates, thresholds) based on playtests
- [ ] Finalize documentation and merge PR

Notes:
- Start with aligning RNG implementations between server and client to guarantee deterministic item generation.
- Keep server authoritative for all object lifecycle decisions and scoring.
- Use existing NET API (events: `game_start`, `game_begin`, `object_state`, `peer_score`, `peer_hand`, `peer_paint`) for synchronization.


we want after the game is finshed to zero the his score in the room 