<!-- task_progress: 40% -->

# Hand Tracking Games

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Demo: Browser](https://img.shields.io/badge/demo-browser-lightgrey.svg)](#) [![Status: Prototype](https://img.shields.io/badge/status-prototype-yellow.svg)](#)

A polished set of browser-based, real-time hand-tracking mini-games built on MediaPipe Hands and HTML5 Canvas. Designed for demos, playtesting, and research into natural hand interaction UX.

Table of contents
- Features
- Live demo (local)
- Quick start
- Screenshots
- Controls & UX
- Audio & persistence
- Developer notes
- Project layout
- Contributing
- Checklist / TODO

Features
- Three playable modes:
  - Ninja Fruit — fingertip slicing arcade game (avoid bombs).
  - Paint Air — freeform air-painting with toolbar (color, size, eraser, clear, done).
  - Shape Trace — trace on-screen outlines with fingertip; per-segment scoring.
- Robust MediaPipe Hands integration with a single RAF-driven loop to avoid repeated camera prompts.
- Per-mode SFX and BGM, preloaded from the local `assets/` folder; BGMs are isolated so they never overlap.
- Persistent per-game leaderboards in localStorage with deduplication and best-score retention.
- Defensive camera reuse to preserve user permission and improve UX.
- Simple, dependency-free codebase — plain HTML, JS, and static assets.

Live demo (local)
- Serving the folder with a static server is recommended to avoid camera permission issues.
- Example:
  ```bash
  python3 -m http.server 8000
  # open http://localhost:8000 in your browser
  ```

Screenshots
- Add screenshots to `assets/screens/` and they will render here.
- Placeholder examples (drop images into `assets/screens/`):
  - assets/screens/ninja-fruit.png
  - assets/screens/paint-air.png
  - assets/screens/shape-trace.png

Controls & UX
- Camera: grant permission once; the app attempts to reuse the same stream across mode switches.
- Ninja Fruit: swipe the index fingertip to slice fruits; bombs end the run.
- Paint Air:
  - Toolbar: color picker, brush size slider, eraser toggle, clear strokes, clear track, Done (exit).
  - Paint mode has no gameplay timer; press Done when finished.
- Shape Trace: use the fingertip pointer dot + ring to follow outlines; auditory feedback for segment/shape completion.

Audio & persistence
- All audio assets are loaded from `assets/` and preloaded where possible.
- BGM isolation: starting a game's BGM stops any previously playing BGM.
- Browser autoplay policies may require a user gesture before audio plays.
- Leaderboards: stored under per-game keys in localStorage. Names are normalized and deduped; only the best score for a name is kept.

Developer notes
- MediaPipe Hands is loaded via CDN and fed a RAF loop to capture frames once and reuse the camera stream.
- Collision detection: uses segment-to-circle distance testing and slice intersection math.
- Paint implementation: recorded as ordered `paintPaths[]` of point arrays; eraser removes points within proximity.
- Shape-trace: shapes are generated as segment lists with coverage tracking per segment.
- Audio: soundPool for SFX clones; single bgmAudio instance per active game — preloads and stops previous bgm on game switch.

Project layout
- index.html — UI, game selector, and canvas
- js/game.js — core logic: MediaPipe integration, rendering, audio, leaderboard
- assets/ — audio/images per game
  - assets/ninga-game-sounds/
  - assets/painf-air-game/
  - assets/shape-track-game/
  - assets/screens/ (user-added screenshots)
- README.md — this file
- LICENSE — MIT license
- .gitignore — repo ignores

Contributing
- Fork, implement fixes or polish, and open a PR.
- Add screenshots to `assets/screens/` and update README references.
- Run the demo locally and verify camera + audio behavior on Chromium-based browsers for best compatibility.
- Preferred PRs:
  - Improve UX / visuals
  - Add more assets (SFX / BGMs)
  - Tuning gameplay parameters (spawn rates, scoring)

Checklist / TODO
- [x] Create a polished README (this file)
- [x] Create LICENSE (MIT)
- [x] Create .gitignore
- [ ] Commit and push README + LICENSE + .gitignore to remote
- [ ] Verify all referenced assets exist in `assets/` (SFX/BGM)
- [ ] Playtest all modes and tune spawn/score parameters
- [ ] Add screenshots to `assets/screens/` and reference them here
- [ ] Add CI / GH Pages demo (optional)

Suggested git commands (run locally)
```bash
git add README.md LICENSE .gitignore
git commit -m "docs: polish README; add license & ignore"
git push origin main
```

Acknowledgements
- MediaPipe (Google) for the Hands model and examples that inspired integration patterns.

Contact
- Repo owner / maintainer: ali-ezz — https://github.com/ali-ezz
