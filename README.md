Camera Hand-Tracking Games

Hand Ninja is a small collection of hand-tracking mini-games that run in the browser using MediaPipe Hands and an HTML5 canvas. Play several modes (Ninja Fruit, Maze, Paint Air, Runner) using just your webcam and your index finger as the controller.

## Features
- Webcam hand-tracking via MediaPipe Hands (no special hardware)
- Multiple game modes: Ninja Fruit, Maze (mini), Paint Air, Runner (flappy-like), Shape Trace
- Per-game persistent leaderboards stored in localStorage
- Lightweight, dependency-free front-end (vanilla JS)
- Particle and popup feedback, tunable spawn/physics parameters
- Per-game audio and asset loading (optional assets/ folder)

## Quick start (local)
1. Clone or copy the project to your machine.
2. From the project folder run a static server:
   - Python 3: `python3 -m http.server 8000`
3. Open your browser at `http://localhost:8000`
4. Allow camera access when prompted, enter a player name and choose a game, then Play.

Notes:
- The project uses MediaPipe served from CDN; internet is required for that dependency.
- Audio and images are loaded from `assets/` when present; missing files are tolerated.

## How to play (controls)
- Ninja Fruit: slice fruits with your index finger; avoid bombs.
- Maze: move your fingertip to navigate the avatar to highlighted exits.
- Paint Air: draw in the air with your index fingertip. Use toolbar for color/size/erase.
- Runner Control: keep your avatar alive by guiding it with your finger.
- Shape Trace: trace the shown shape; coverage fills the shape and scores points.

UI:
- Enter name in the menu to save scores to the per-game leaderboard.
- Leaderboard is per-game; if a specific game has no entries it shows "No leaders yet" for that game.

## Developer notes
- Main files:
  - `index.html` — UI, menus, leaderboard modal
  - `js/game.js` — core game logic, MediaPipe integration, leaderboard storage
- Canvas is scaled using devicePixelRatio; resize observer adjusts canvas dimensions.
- Leaderboards are stored under keys `hand-ninja-leaders-v1:<gameId>` in localStorage, deduped by player name (keeps highest score).

## Assets
- Optional: add audio/images in `assets/` or `assets/<gameId>/` to enhance a mode.
- Example: `assets/ninga-game-sounds/slice-frute.mp3` or `assets/ninja-fruit/bgm.mp3`

## Contributing & customization
- Adjust spawn/physics constants in `js/game.js` (top section) to tune difficulty.
- Add fruit sprites by pushing URLs into `ASSETS.fruitSprites` or placing images in `assets/` and updating references.

## License
- MIT-style: feel free to reuse and adapt for demos and teaching. Keep attribution if you redistribute.
