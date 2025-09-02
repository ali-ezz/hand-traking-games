# Camera Hand‑Tracking Games 📷

A tiny, polished suite of hand‑tracking mini‑games that run in the browser using MediaPipe Hands and an HTML5 canvas. Use your webcam and your index finger to play fast, fun demos — slice fruits, trace shapes, paint in the air, navigate mazes, and more.

---

## 🎯 Highlights
- ✅ Browser-based hand tracking (MediaPipe Hands via CDN)  
- 🎮 Multiple modes: Ninja Fruit, Maze (mini), Paint Air, Runner (flappy-like), Shape Trace  
- 🏆 Per-game persistent leaderboards (localStorage), deduped by name (best score kept)  
- ⚙️ Tiny, dependency‑free front end (vanilla JS) — easy to customize  
- 🔊 Optional per‑game audio & sprites via `assets/` folder  
- ⚡ Performance tuned: particle/pop limits, spawn throttles, canvas DPR scaling

---

## 🚀 Quick start (local)
1. Clone or copy project to your machine.
2. From the project folder run a static server:
   - Python 3: `python3 -m http.server 8000`
3. Open your browser at: `http://localhost:8000`
4. Allow camera access, enter your player name, pick a game, and Play.

Tip: MediaPipe is loaded from CDN, so an internet connection is required.

---

## 🎮 How to play (controls)
- Ninja Fruit — slice fruits with your index finger; avoid bombs.  
- Maze (mini) — guide the avatar with your fingertip to highlighted exits.  
- Paint Air — draw in mid-air; use color, size, and eraser toolbar controls.  
- Runner Control — guide the avatar vertically with your index finger.  
- Shape Trace — trace the outline; fill coverage to score.

UI:
- Enter name in the menu to save scores to the per‑game leaderboard.  
- Each game's leaderboard is independent; if a game has no entries it shows "No leaders yet" for that game.

---

## 🧭 Developer notes
Main files:
- `index.html` — UI, menu, leaderboard modal, and styles  
- `js/game.js` — core game logic: MediaPipe integration, game modes, scoring, localStorage leaders

Leaderboards:
- Stored under `hand-ninja-leaders-v1:<gameId>` in `localStorage`.  
- Entries are deduped by normalized name (keeps the highest score).

Canvas:
- Uses devicePixelRatio scaling and ResizeObserver for crisp rendering.

Assets:
- Optional assets can be placed in `assets/` or `assets/<gameId>/`.  
- Example: `assets/ninga-game-sounds/slice-frute.mp3` or `assets/ninja-fruit/bgm.mp3`.

Tuneable constants:
- Open `js/game.js` top section to adjust GRAVITY, spawn intervals, max objects, hit padding, etc.

---

## ✨ Visual polish for README (now)
- Emojis used for section anchors and quick scanning.  
- Short, scannable sections and tips for local testing.  
- Clear developer pointers for customizing gameplay and assets.

---

## 🛠️ Contributing & customization
- Add fruit sprites by adding image URLs to `ASSETS.fruitSprites` in `js/game.js` or drop images into `assets/`.  
- Fine‑tune spawn/physics constants in `js/game.js` (top).  
- To add a new game mode, see existing mode handlers in `onResults()` and reuse popup/particle helpers.

---

## 📸 Preview & test
- Run `python3 -m http.server 8000` → open `http://localhost:8000` → Play and verify leaderboard under Menu → Leaderboard.

---

## 📝 License
MIT-style — free to reuse and adapt for demos and teaching. Keep attribution when redistributing.
