module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  env: {
    browser: true,
    node: true,
    es2021: true,
  },
  globals: {
    performance: "readonly",
    fetch: "readonly",
    localStorage: "readonly",
    URL: "readonly",
    Blob: "readonly",
    AbortController: "readonly",
    Audio: "readonly",
    Image: "readonly",
    ResizeObserver: "readonly",
    NET: "readonly",
    updateAudioIntensity: "readonly",
    location: "readonly",
    crypto: "readonly",
    cancelAnimationFrame: "readonly",
    requestAnimationFrame: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    console: "readonly",
    alert: "readonly"
  },
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: "module",
  },
  rules: {
    // keep defaults; adjust if project has specific style rules
  },
};
