task_progress: 75%

Project roadmap & TODO (3-day demo goal)
- [x] Analyze requirements and acceptance criteria
- [x] Choose tech stack (HTML/CSS/Vanilla JS, MediaPipe Hands, Node/Express, Socket.IO)
- [x] Create project skeleton (index.html, js/, server/)
- [x] Integrate MediaPipe Hands and camera pipeline
- [x] Implement core gameplay mechanics (ninja-fruit, paint-air, shape-trace, runner)
- [x] Implement particle system and popup system
- [x] Add HUD animation (score pulse) and small UI transitions
- [x] Wire audio playback logic in code (playSound, preloadAssets)
- [x] Implement server (Express + Socket.IO) and leaderboard REST endpoints
- [x] Emit realtime leaderboard updates from server
- [x] Start & verify cloudflared quick tunnel for external demo
- [ ] Add placeholder audio assets under assets/ (bgm, slice, bomb, popup, point)
- [ ] Tune particle/popups visual parameters and performance
- [ ] Implement robust camera/no-camera fallback UI and pause/restart hooks
- [ ] Add user-name input and leaderboard UX improvements (modal, validation)
- [ ] Cross-browser testing (Chrome, Firefox) and autoplay handling fixes
- [ ] Add persistence & server hardening (file locks, atomic writes)
- [ ] Finalize README and SUMMARY with run & demo steps
- [ ] Create playthrough checklist and automated smoke tests
- [ ] Record 2-minute demo video or prepare live demo script
- [ ] Polish visuals (sprites, particle art) and audio mixing
- [ ] Prepare presentation assets (slides, one-page handout)

Immediate next step (automated, chosen to continue work now)
- Implement code-side safety and tuning so missing audio files won't break the app and particle/popups are tuned conservatively.
  - Add guard rails in preloadAssets to ignore missing audio files and fall back to silent/no-op.
  - Ensure playSound checks user gesture / document.visibility and gracefully fails if playback blocked.
  - Tune spawnParticles defaults: lower particle count for mobile; clamp lifetimes.
This will let the UI polish be completed now without creating binary audio assets (you can add real audio files later).

Notes
- If you prefer that I create placeholder audio files now (small beep/silent files), say "create placeholders" and I'll add them under assets/ and update ASSETS references.
- After you confirm the above immediate next step, I will modify the code (js/game.js and preload logic) to add the safety checks and tuning.
