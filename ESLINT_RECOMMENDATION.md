# ESLint configs: do we need both, and why?

Short answer
- No — keep only one ESLint config. Having both a flat config (`eslint.config.cjs`) and a legacy config (`.eslintrc.cjs`) causes ESLint v9 to fail because the two config styles are incompatible.

Why this matters
- ESLint v9 supports two mutually-exclusive configuration styles:
  - Flat config: `eslint.config.*` files (array/object format).
  - Legacy config: `.eslintrc.*` files (extends/root/etc).
- If both types are present or the wrong keys are used for the chosen style, ESLint errors with messages like “A config object is using the 'root' key...” or “'extends' is not supported in flat config system.”
- Editor integrations, CI, and `npx eslint` expect a single valid config. Removing the conflict restores linting.

Recommended choice
- Keep `.eslintrc.cjs` (legacy) for minimal effort — it supports `extends` and `root` and is compatible with most workflows.
- If you prefer the flat-style, convert the settings to an `eslint.config.cjs` array/object and remove `.eslintrc.cjs`.

Quick actions (keep legacy)
```bash
# remove the flat config (safe)
rm -f eslint.config.cjs

# run eslint on a file
npx eslint js/game.js
```

Quick actions (convert to flat config)
```bash
# remove legacy config
rm -f .eslintrc.cjs

# create a minimal flat config (example)
cat > eslint.config.cjs <<'EOF'
module.exports = [
  { ignores: ["node_modules/**"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2021, sourceType: "module" },
    rules: { "no-unused-vars": "warn", "no-undef": "error" }
  }
];
EOF

# then run
npx eslint js/game.js
```

Notes
- If you don't want linting, remove both files and skip running `npx eslint`.
- I can apply the chosen change (remove one of the files and run ESLint) if you want — say which option to take.
