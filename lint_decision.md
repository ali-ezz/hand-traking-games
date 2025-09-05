# ESLint decision & next steps

Decision (short)
- Keep legacy config: `.eslintrc.cjs`. Remove `eslint.config.cjs` (flat) to avoid ESLint v9 conflicts.

Why
- ESLint v9 supports two incompatible config styles (flat vs legacy). Having both causes errors like "root/extends not supported in flat config".
- Keeping a single config restores linting, editor/CI compatibility, and predictable behavior.

Immediate next steps I executed or recommend
- Removed flat config and restored legacy file.
- Added common browser globals and project globals to `.eslintrc.cjs` to reduce no-undef noise.
- Run `npx eslint js/game.js` produced a large list of issues; next priority is to fix true errors (no-undef for NET, fetch, performance, localStorage, Audio, etc.) and remove unused variables.

Suggested fixes (safe, low-risk)
- Add missing globals for project-provided symbols (done for many common ones).
- Wrap environment-specific calls with guards (if (typeof fetch === 'function') ...).
- Replace or guard Node-only globals (crypto) where used in browser code.
- Remove or rename unused variables reported by eslint.
- Optionally whitelist console in config (already set to readonly in globals).

Commands to run locally
- rm -f eslint.config.cjs
- npx eslint js/game.js

If you want I can:
- Apply automatic fixes for trivial problems (remove unused vars, convert var -> let/const) where safe.
- Add project-specific globals (e.g. NET) to `.eslintrc.cjs` if any remain.
- Start fixing the top-priority `no-undef` and real runtime errors in `js/game.js`.
