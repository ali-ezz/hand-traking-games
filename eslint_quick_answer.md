# Do we need both ESLint configs?

Short answer
- No — keep only one ESLint config file.

Why
- ESLint v9 supports two mutually-exclusive configuration systems:
  - "Flat" config files (eslint.config.*)
  - Legacy .eslintrc.* files
- If both types or incompatible keys (e.g., root/extends) are present, ESLint fails with errors (exactly what happened).
- Editor/CI/`npx eslint` expect a single valid config; removing the conflict restores linting.

Which to keep
- Recommended (minimal work): keep `.eslintrc.cjs` (legacy) — works with `extends`/`root` and common tooling.
- Alternative: keep `eslint.config.cjs` (flat) but then remove `.eslintrc.cjs` and convert rules to the flat config shape.

Quick actions
- Keep legacy:
  - `rm -f eslint.config.cjs`
  - `npx eslint js/game.js`
- Keep flat:
  - `rm -f .eslintrc.cjs`
  - create/adjust `eslint.config.cjs` (flat format)
  - `npx eslint js/game.js`

Current state & next step
- I ran ESLint against `js/game.js`; it produced many warnings/errors (reported).
- Pick which config to keep and I will remove the other and run ESLint fixes or report the results.
