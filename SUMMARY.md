task_progress: 15%

# Hand-tracking Web Game — Summary & Quick Run

Short description
- Small polished browser demo that uses webcam hand-tracking (MediaPipe) for one of several mini-games (Ninja Fruit, Paint Air, Maze, Runner).
- Includes a lightweight local leaderboard (localStorage + optional server) and basic UI for demoing in ~2 minutes.

Deliverables
- index.html + js/*.js (game, ui, net)
- server/server.js (optional scoreboard)
- TODO.md (planning & progress)
- SUMMARY.md (this file)

Quick run (development)
- Option A — quick static server (recommended for camera + getUserMedia):
  - Python: from project root run `python3 -m http.server 8000` then open http://localhost:8000
  - Node: from project root run `npx serve .` or `npx http-server` then open the shown URL

- Option B — run the optional Node leaderboard server (if you want server persistence):
  - cd server
  - npm install
  - node server.js
  - Open the frontend via a static server (see Option A). The frontend will POST to `/leaderboard` and optionally use socket.io if the server is running.

Where to look / edit
- js/game.js — core gameplay, modes, hand-tracking integration
- js/ui.js — UI bindings and modal/leaderboard helpers
- js/net.js — network/score posting and socket glue
- server/server.js — simple Express scoreboard (start/stop, persistence)

3-day milestone plan (high level)
- Day 1: verify webcam + MediaPipe, stabilize input mapping, core Ninja Fruit gameplay
- Day 2: polish visuals/audio, implement server scoreboard + client integration
- Day 3: testing, docs, demo script, 2-min recording or live demo prep

Checklist (current)
- [x] Analyze requirements and lock game concept
- [x] Verify & choose hand-tracking library (MediaPipe / TensorFlow)
- [ ] Wire up webcam + calibration UI
- [ ] Implement game loop, input mapping, scoring, lives
- [ ] Implement pause/restart and no-camera fallback
- [ ] Add UI polish: HUD, animations, sound effects
- [ ] Implement server scoreboard API and client integration
- [ ] Add basic tests / playthrough checklist
- [ ] Write README + run instructions
- [ ] Prepare demo script and 2-min recording or live demo
- [ ] Final QA and bug fixes

Notes
- For camera permission and smooth demoing use a localhost/https origin; `file://` may block getUserMedia.
- Use TODO.md to track progress and mark completed items as you go.
