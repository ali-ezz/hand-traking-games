# Lint next steps (summary)

- [x] Analyze requirements
- [x] Update js/ui.js (name propagation, kick behavior)
- [x] Read js/game.js to find audio state
- [x] Update js/game.js (unify music controller, prevent BGM bleed)
- [x] Prepare to run syntax checks
- [x] Run syntax check on js/game.js
- [x] Add minimal ESLint config
- [x] Fix flat-config "root" error in eslint.config.cjs
- [x] Remove conflicting flat-config file
- [x] Run ESLint on `js/game.js` (initial run) — reported 589 problems (many no-undef / no-unused-vars)
- [ ] Run project-wide ESLint (optional)
- [ ] Categorize and fix top-priority lint errors:
  - [ ] Fix true errors (no-undef for browser globals like fetch, window, localStorage, Audio, performance, NET)
  - [ ] Replace or guard Node-only globals where needed (crypto, ResizeObserver, etc)
  - [ ] Remove/rename unused variables and unused handlers
  - [ ] Replace console.* calls if you want stricter rules, or whitelist console in config
- [ ] Re-run ESLint and reduce errors to zero, warnings as desired
- [ ] Manual/in-browser audio tests (solo, admin, non-admin)
- [ ] Add CSS fixes for scrollable lists
- [ ] Present final summary and mark task complete

Notes:
- Keep only one ESLint config. We selected and restored the legacy config (`.eslintrc.cjs`) to avoid flat/legacy conflicts.
- ESLint run has produced many `no-undef` results for browser globals — these are expected when linting a large browser-targeted single-file script without precise env/globals. Fix approach:
  1. Ensure `.eslintrc.cjs` includes `env: { browser: true, node: true }` (already present).
  2. If errors persist, add specific `globals` entries for project-provided globals (e.g. `NET`, `updateAudioIntensity`) or wrap references with feature-detection guards.
  3. Apply targeted code fixes for obvious mistakes (unused vars, mistyped names).
- I can start applying automated, low-risk fixes (remove unused vars, add missing global declarations, wrap setTimeout/clearTimeout in guards) if you want me to proceed.
