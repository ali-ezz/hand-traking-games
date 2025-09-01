# Hand Ninja — Camera Hand-Tracking Game (Fruit‑Ninja style)

A small interactive web game where players "slice" fruits using their hand in front of the webcam. Uses MediaPipe Hands to show the user's full camera feed (not just points) plus a rendered overlay for slicing and game objects.

Task progress
- [ ] Decide final feature set (controls, scoring, powerups)
- [ ] Inspect/create project files (index.html, js/game.js, SUMMARY.md, assets/)
- [ ] Integrate MediaPipe Hands camera feed + hand overlay
- [ ] Implement fruit spawn, physics, and slicing detection
- [ ] UI: score, lives, start/pause screens, responsiveness
- [ ] Add sounds, particles, and polish
- [ ] Test on desktop/mobile, optimize performance
- [ ] Deploy and prepare demo README/screenshots

Tech stack
- Plain HTML/CSS/JS
- MediaPipe Hands (web) for hand tracking + full camera feed
- Optional: simple local server for testing (python / node)

Files to be created
- `index.html` — main game page (camera + canvas + UI)
- `js/game.js` — game logic, hand-tracking integration
- `SUMMARY.md` — short project summary and dev notes
- `assets/` — sounds and images

Run locally
1. Start a simple server from the project folder:
   - Python 3: `python -m http.server 8000`
2. Open http://localhost:8000 in your browser and allow camera access.

Notes
- Localhost is a secure origin for getUserMedia; using a local server avoids cross-origin issues.
- MediaPipe Hands will be configured to render the camera feed and an overlay so the user sees themselves with game overlays (not just tracking points).

Next step: I will create `index.html` scaffold with MediaPipe Hands integration and a basic canvas overlay.
