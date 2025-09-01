// task_progress
// - [x] Analyze requirements
// - [x] Set up necessary files (index.html exists)
// - [x] Implement MediaPipe Hands + camera integration
// - [x] Implement fruit spawn, physics, and slicing detection
// - [x] Implement menu, score, timer and leaderboard persistence
// - [x] Add bombs that deduct points and make fruits/bombs slower & fewer
// - [ ] Wire audio assets (in code; assets files to be placed in assets/)
// - [ ] Add particle polish, sprite support and floating score popups
// - [ ] Extensive playtesting and tuning
 // task_progress: leaders: dedupe same names (keep highest) + show placeholder implemented
 // task_progress_update:
 // - [x] Wire Paint toolbar controls and no-timer paint flow
//
// js/game.js — core game logic (modified to wire assets, popups, and robustness)
// Loads via <script type="module" src="js/game.js"></script>

const DPR = Math.max(1, window.devicePixelRatio || 1);

// UI elements
const videoEl = document.getElementById('input_video');
const canvas = document.getElementById('output_canvas');
const ctx = canvas.getContext('2d');
const menuEl = document.getElementById('menu');
const playerNameEl = document.getElementById('playerName');
const gameLengthEl = document.getElementById('gameLength');
const menuStartBtn = document.getElementById('menuStartBtn');
const showLeadersBtn = document.getElementById('showLeadersBtn');
const scoreEl = document.getElementById('score');
const timerEl = document.getElementById('timer');
const noticeEl = document.getElementById('notice');

const leaderboardEl = document.getElementById('leaderboard');
const leadersList = document.getElementById('leadersList');
const closeLeadersBtn = document.getElementById('closeLeadersBtn');
const clearLeadersBtn = document.getElementById('clearLeadersBtn');

// Game state
let hands = null;
let cameraController = null;
let running = false;
let startTime = 0;
let duration = 45;
let score = 0;

// Physics & spawn tuning (slower & fewer)
const GRAVITY = 1200; // px/s^2
const FRUIT_SPAWN_INTERVAL = 1400; // ms (longer -> fewer)
const BOMB_SPAWN_INTERVAL = 5000; // ms (rare)
const MAX_FRUITS = 6;
const MAX_BOMBS = 2;
const HIT_PADDING = 24;

let lastFruitSpawn = 0;
let lastBombSpawn = 0;

const objects = []; // fruits and bombs
const particles = [];

 // Paint Air mode scaffold
const paintPaths = []; // stores {x,y,t}
let paintEnabled = false;
let drawingEnabled = true;
let paintColor = '#00b4ff';
let paintSize = 12;
let eraserMode = false;
const paintTrack = []; // target path to trace (array of {x,y})
let paintOnTrackLen = 0;
let paintModeNoTimer = false;

 // Shape Trace scaffold
let shapes = [];
let shapeIndex = 0;
let shapeCovered = [];
let shapeTolerance = 30;
let shapeProgress = 0;

// Simple gesture detector using mapped hand landmarks (canvas coords).
// Returns 'open' | 'closed' | 'pinch' | null
function detectSimpleGesture(hand) {
  try {
    if (!hand || !hand.length) return null;
    const wrist = hand[0];
    const idxTip = hand[8];
    const thumbTip = hand[4];
    if (!idxTip || !thumbTip || !wrist) return null;
    const dThumbIndex = Math.hypot(thumbTip.x - idxTip.x, thumbTip.y - idxTip.y);
    // pinch threshold (in canvas pixels)
    if (dThumbIndex < 28) return 'pinch';
    // openness: average distance from finger tips to wrist
    const tips = [8,12,16,20].map(i => hand[i]).filter(Boolean);
    if (!tips.length) return null;
    const avg = tips.reduce((s,p) => s + Math.hypot(p.x - wrist.x, p.y - wrist.y), 0) / tips.length;
    // thresholds tuned roughly for typical webcam canvas sizes
    if (avg > 80) return 'open';
    return 'closed';
  } catch (e) { return null; }
}

// Assets & sounds configuration (set URLs or leave null)
// Populate ASSETS.fruitSprites with image URLs to give fruits a graphical look.
// Example:
//   ASSETS.bgm = 'assets/bgm.mp3'
//   ASSETS.slice = 'assets/slice.wav'
//   ASSETS.bomb = 'assets/bomb.wav'
//   ASSETS.fruitSprites = ['assets/apple.png','assets/orange.png']
const ASSETS = {
  // Point these to your files in the assets/ folder.
  // Place audio files like: assets/bgm.mp3, assets/slice.wav, assets/bomb.wav
  bgm: 'assets/bgm.mp3',
  slice: 'assets/slice.wav',
  bomb: 'assets/bomb.wav',
  // Add sprite paths (optional). Example: 'assets/apple.png'
  fruitSprites: [
    // 'assets/apple.png',
    // 'assets/orange.png'
  ],
  // internal runtime cache
  _fruitImages: []
};

const soundPool = {};
let bgmAudio = null;
let musicEnabled = false;

/* preload assets (call once on load or when you have URLs)
   Behavior:
   - Attempts to load per-game assets (ASSETS.* which may point to assets/<gameId>/...)
   - Tries multiple filename patterns and extensions; includes specific candidate paths such as
     assets/ninga-game-sounds/slice-frute.mp3 which some game folders may use.
   - Loads fruit sprite URLs listed in ASSETS.fruitSprites (no server-side directory listing).
*/
async function preloadAssets() {
  // UI element for status reporting (optional)
  const assetStatusEl = document.getElementById('assetStatusList');

  function reportStatus(key, msg) {
    try {
      if (assetStatusEl) {
        const line = document.createElement('div');
        line.textContent = `${key}: ${msg}`;
        assetStatusEl.appendChild(line);
      } else {
        console.info(`[asset:${key}]`, msg);
      }
    } catch (e) { /* ignore */ }
  }

  // helper that attempts to load a single audio URL and resolves with the Audio element or null
  function tryLoadAudioUrl(url, timeoutMs = 3000) {
    return new Promise(res => {
      if (!url) return res(null);
      try {
        // create audio element and set crossOrigin BEFORE assigning src
        const a = document.createElement('audio');
        a.preload = 'auto';
        try { a.crossOrigin = 'anonymous'; } catch (e) {}
        try { a.muted = false; } catch (e) {}
        try { a.volume = 1.0; } catch (e) {}
        let settled = false;
        const onSuccess = () => {
          if (!settled) {
            settled = true;
            reportStatus('audio', `canplay ${url}`);
            a.addEventListener('play', () => { reportStatus('audio', `play event ${url}`); }, { once: true });
            a.addEventListener('error', () => { reportStatus('audio', `play error ${url}`); }, { once: true });
            res(a);
          }
        };
        const onFail = () => {
          if (!settled) {
            settled = true;
            reportStatus('audio', `load error ${url}`);
            res(null);
          }
        };
        a.addEventListener('canplaythrough', onSuccess, { once: true });
        a.addEventListener('error', onFail, { once: true });
        // assign src after listeners and crossOrigin set
        a.src = url;
        // safety timeout
        setTimeout(() => { if (!settled) { settled = true; reportStatus('audio', `timeout ${url}`); res(null); } }, timeoutMs);
      } catch (e) {
        reportStatus('audio', `exception ${url}`);
        return res(null);
      }
    });
  }

  // clear any previous status entries
  if (assetStatusEl) assetStatusEl.innerHTML = '';

  try {
    // Build candidate paths (kept in the same preferred order)
    const sliceCandidates = [
      ASSETS.slice,
      // common per-game locations
      `assets/${currentGameId}/slice.wav`,
      `assets/${currentGameId}/slice.mp3`,
      `assets/${currentGameId}/slice-frute.mp3`,
      `assets/${currentGameId}/slice-fruit.mp3`,
      // known alternate folder used by the ninja assets
      `assets/ninga-game-sounds/slice-frute.mp3`,
      // generic fallbacks
      `assets/slice.wav`,
      `assets/slice.mp3`
    ].filter(Boolean);

    const bombCandidates = [
      ASSETS.bomb,
      `assets/${currentGameId}/bomb.wav`,
      `assets/${currentGameId}/bomb.mp3`,
      `assets/${currentGameId}/bomb-frute.mp3`,
      // check the shared ninja sounds folder (some filenames differ)
      `assets/ninga-game-sounds/boomb.mp3`,
      `assets/ninga-game-sounds/bomb.mp3`,
      `assets/bomb.wav`,
      `assets/bomb.mp3`
    ].filter(Boolean);

    const bgmCandidates = (() => {
      const c = [ASSETS.bgm, `assets/${currentGameId}/bgm.mp3`].filter(Boolean);
      // only consider the shared ninja bgm for the ninja-fruit mode to avoid loading it for other games
      if (currentGameId === 'ninja-fruit') c.push('assets/ninga-game-sounds/bgm.mp3');
      c.push('assets/bgm.mp3');
      return c.filter(Boolean);
    })();

    // Try slice candidates sequentially and report results to UI
    let found = false;
    for (const url of sliceCandidates) {
      reportStatus('slice', `trying ${url}`);
      // small await so network isn't hammered; tryLoadAudioUrl handles timeouts
      const a = await tryLoadAudioUrl(url);
      if (a) {
        soundPool.slice = a;
        reportStatus('slice', `loaded ${a.src}`);
        found = true;
        break;
      } else {
        reportStatus('slice', `failed ${url}`);
      }
    }
    if (!found) reportStatus('slice', 'not found');

    // Try bomb candidates
    found = false;
    for (const url of bombCandidates) {
      reportStatus('bomb', `trying ${url}`);
      const a = await tryLoadAudioUrl(url);
      if (a) {
        soundPool.bomb = a;
        reportStatus('bomb', `loaded ${a.src}`);
        found = true;
        break;
      } else {
        reportStatus('bomb', `failed ${url}`);
      }
    }
    if (!found) reportStatus('bomb', 'not found');

    // Try bgm candidates
    found = false;
    for (const url of bgmCandidates) {
      reportStatus('bgm', `trying ${url}`);
      const a = await tryLoadAudioUrl(url);
      if (a) {
        a.loop = true;
        // stop any previously playing bgmAudio instance (different element) to avoid overlapping BGMs
        try {
          if (bgmAudio && bgmAudio !== a) {
            try { bgmAudio.pause(); bgmAudio.currentTime = 0; } catch(e){}
          }
        } catch(e){}
        bgmAudio = a;
        reportStatus('bgm', `loaded ${a.src}`);
        // auto-play if music is enabled for the current session
        if (musicEnabled) {
          try { bgmAudio.muted = false; bgmAudio.volume = 1.0; bgmAudio.play().catch(()=>{}); } catch(e){}
        }
        found = true;
        break;
      } else {
        reportStatus('bgm', `failed ${url}`);
      }
    }
    if (!found) reportStatus('bgm', 'not found');
  } catch (e) {
    console.warn('audio setup issue', e);
    reportStatus('audio', 'setup exception');
  }

  // Load any per-game short SFX entries provided via ASSETS.sfx
  if (ASSETS.sfx && typeof ASSETS.sfx === 'object') {
    for (const [key, url] of Object.entries(ASSETS.sfx)) {
      if (!url) {
        reportStatus(`sfx:${key}`, 'no url');
        continue;
      }
      reportStatus(`sfx:${key}`, `trying ${url}`);
      try {
        const a = await tryLoadAudioUrl(url);
        if (a) {
          soundPool[key] = a;
          reportStatus(`sfx:${key}`, `loaded ${a.src}`);
        } else {
          reportStatus(`sfx:${key}`, `failed ${url}`);
        }
      } catch (e) {
        reportStatus(`sfx:${key}`, `exception ${url}`);
      }
    }
  }

  // load images listed explicitly in ASSETS.fruitSprites (no directory enumeration)
  ASSETS._fruitImages = [];
  for (const url of ASSETS.fruitSprites || []) {
    const img = new Image();
    const p = new Promise(res => {
      img.addEventListener('load', () => res({ ok: true, img }), { once: true });
      img.addEventListener('error', () => res({ ok: false, img }), { once: true });
    });
    img.src = url;
    const r = await p;
    if (r.ok) {
      ASSETS._fruitImages.push(img);
      reportStatus('image', `loaded ${url}`);
    } else {
      reportStatus('image', `failed ${url}`);
    }
  }

  // done
  reportStatus('done', `assets preload complete (game: ${currentGameId})`);
}

function playSound(name) {
  try {
    if (name === 'bgm') {
      if (!bgmAudio) return;
      if (musicEnabled) { 
        try { bgmAudio.muted = false; bgmAudio.volume = 1.0; } catch(e){}
        bgmAudio.play().catch(()=>{});
      } else { 
        try { bgmAudio.pause(); } catch(e){} 
      }
      return;
    }
    const a = soundPool[name];
    if (!a) return;
    // clone to allow overlapping playback in some browsers
    const inst = a.cloneNode ? a.cloneNode() : new Audio(a.src);
    try { inst.muted = false; inst.volume = 1.0; } catch(e){}
    inst.play().catch((err) => {
      // report in asset status if playback is blocked
      try { reportStatus('audio', `play blocked ${name}`); } catch(e){}
    });
  } catch(e){}
}

function setMusicEnabled(v) { musicEnabled = !!v; playSound('bgm'); }

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b+1)); }

// Resize canvas to match window
function resizeCanvas() {
  canvas.width = Math.floor(canvas.clientWidth * DPR);
  canvas.height = Math.floor(canvas.clientHeight * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();

// Helpers: cover-scale mapping so overlays match video drawn using "cover"
function computeCoverTransform(iw, ih, cw, ch) {
  const scale = Math.max(cw / iw, ch / ih);
  const sw = iw * scale, sh = ih * scale;
  const dx = (cw - sw) / 2, dy = (ch - sh) / 2;
  return { scale, dx, dy, sw, sh };
}

function mapLandmarksToCanvas(landmarks, results) {
  if (!results.image) return [];
  const iw = results.image.width || results.image.videoWidth || canvas.videoWidth || canvas.width;
  const ih = results.image.height || results.image.videoHeight || canvas.height;
  const cw = canvas.width / DPR, ch = canvas.height / DPR;
  const t = computeCoverTransform(iw, ih, cw, ch);
  return landmarks.map(lm => ({
    x: t.dx + lm.x * iw * t.scale,
    y: t.dy + lm.y * ih * t.scale,
    z: lm.z
  }));
}

// Generate random shape outlines (returns { points: [{x,y}], type })
function generateRandomShape() {
  const w = canvas.width / DPR;
  const h = canvas.height / DPR;
  const types = ['circle','rect','poly'];
  const type = types[randInt(0, types.length - 1)];
  const points = [];

  if (type === 'circle') {
    const cx = rand(w * 0.25, w * 0.75);
    const cy = rand(h * 0.25, h * 0.75);
    const r = rand(Math.min(w,h) * 0.12, Math.min(w,h) * 0.26);
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  } else if (type === 'rect') {
    const margin = 40;
    const rw = rand(w * 0.25, w * 0.6);
    const rh = rand(h * 0.18, h * 0.45);
    const x0 = rand(margin, w - margin - rw);
    const y0 = rand(margin, h - margin - rh);
    const corners = [
      { x: x0, y: y0 },
      { x: x0 + rw, y: y0 },
      { x: x0 + rw, y: y0 + rh },
      { x: x0, y: y0 + rh },
      { x: x0, y: y0 } // close
    ];
    // interpolate edges
    const segPerEdge = 20;
    for (let e = 0; e < corners.length - 1; e++) {
      const a = corners[e], b = corners[e+1];
      for (let i = 0; i <= segPerEdge; i++) {
        const t = i / segPerEdge;
        points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  } else {
    // polygon (random n-gon)
    const cx = rand(w * 0.3, w * 0.7);
    const cy = rand(h * 0.3, h * 0.7);
    const r = rand(Math.min(w,h) * 0.12, Math.min(w,h) * 0.28);
    const sides = randInt(5, 8);
    for (let i = 0; i <= sides * 10; i++) {
      const a = (i / (sides * 10)) * Math.PI * 2;
      // slight radial perturbation to make shape interesting
      const rr = r * (1 + Math.sin(a * 3 + rand(-0.2,0.2)) * 0.12);
      points.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  }

  return { type, points };
}

// spawn fruit and bomb
function spawnFruit() {
  if (objects.filter(o => o.type === 'fruit').length >= MAX_FRUITS) return;
  const radius = randInt(28, 44);
  const x = rand(radius, canvas.width / DPR - radius);
  const y = canvas.height / DPR + radius + 10;
  const vx = rand(-220, 220);
  // much stronger upward throw so fruits go very high
  const vy = rand(-1600, -1100);
  const color = `hsl(${randInt(10,140)},70%,55%)`;

  // pick a sprite if available
  let sprite = null;
  if (ASSETS._fruitImages && ASSETS._fruitImages.length) {
    sprite = ASSETS._fruitImages[randInt(0, ASSETS._fruitImages.length - 1)];
  }

  objects.push({
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    type: 'fruit',
    x, y, vx, vy,
    r: radius,
    ang: rand(0, Math.PI*2),
    spin: rand(-3,3),
    color,
    sprite,
    sliced: false
  });
}

function spawnBomb() {
  if (objects.filter(o => o.type === 'bomb').length >= MAX_BOMBS) return;
  const radius = randInt(26, 36);
  const x = rand(radius, canvas.width / DPR - radius);
  const y = canvas.height / DPR + radius + 10;
  const vx = rand(-150, 150);
  // bombs match fruit height (strong upward throw)
  const vy = rand(-1600, -1100);
  objects.push({
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    type: 'bomb',
    x, y, vx, vy,
    r: radius,
    ang: rand(0, Math.PI*2),
    spin: rand(-2,2),
    color: '#111',
    // animated fuse phase for simple spark animation
    fusePhase: Math.random() * Math.PI * 2,
    sliced: false
  });
}

// collision helpers
function segmentCircleDist(px,py,qx,qy,cx,cy) {
  // distance from segment pq to center c
  const vx = qx - px, vy = qy - py;
  const wx = cx - px, wy = cy - py;
  const c1 = vx*wx + vy*wy;
  if (c1 <= 0) return Math.hypot(cx - px, cy - py);
  const c2 = vx*vx + vy*vy;
  if (c2 <= c1) return Math.hypot(cx - qx, cy - qy);
  const b = c1 / c2;
  const bx = px + b * vx, by = py + b * vy;
  return Math.hypot(cx - bx, cy - by);
}

function sliceSegmentIntersectsFruit(px,py,qx,qy, fruit) {
  const d = segmentCircleDist(px,py,qx,qy, fruit.x, fruit.y);
  return d <= fruit.r + HIT_PADDING;
}

// draw functions
function drawVideoFrame(image) {
  const iw = image.width || image.videoWidth;
  const ih = image.height || image.videoHeight;
  const cw = canvas.width / DPR, ch = canvas.height / DPR;
  const t = computeCoverTransform(iw, ih, cw, ch);

  // draw black background for letterboxing
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,cw,ch);

  // draw video scaled to cover
  ctx.save();
  ctx.translate(t.dx, t.dy);
  ctx.scale(t.scale, t.scale);
  ctx.drawImage(image, 0, 0, iw, ih);
  ctx.restore();
}

function drawObjects(dt) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    // physics
    o.vy += GRAVITY * dt;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    o.ang += o.spin * dt;

    // offscreen remove
    if (o.y - o.r > canvas.height / DPR + 60 || o.x < -200 || o.x > canvas.width / DPR + 200) {
      objects.splice(i,1);
      continue;
    }

    // render
    if (o.type === 'fruit') {
      // if a sprite image is provided and loaded, draw it scaled to the fruit radius
      if (o.sprite && o.sprite.complete && o.sprite.naturalWidth) {
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate(o.ang);
        const size = o.r * 2;
        ctx.drawImage(o.sprite, -o.r, -o.r, size, size);
        // subtle outline
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.strokeRect(-o.r, -o.r, size, size);
        ctx.restore();
      } else {
        // fallback: simple glossy circle
        const grad = ctx.createLinearGradient(o.x - o.r, o.y - o.r, o.x + o.r, o.y + o.r);
        grad.addColorStop(0, lighten(o.color, 20));
        grad.addColorStop(1, darken(o.color, 5));
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate(o.ang);
        ctx.beginPath();
        ctx.fillStyle = grad;
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 8;
        ctx.arc(0,0,o.r,0,Math.PI*2);
        ctx.fill();
        // outline
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.stroke();
        ctx.restore();
      }
    } else if (o.type === 'bomb') {
      // simple cartoon bomb with animated fuse/spark
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(o.ang);

      // body
      ctx.beginPath();
      ctx.fillStyle = '#111';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 10;
      ctx.arc(0,0,o.r,0,Math.PI*2);
      ctx.fill();

      // subtle highlight
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.ellipse(-o.r*0.35, -o.r*0.35, o.r*0.6, o.r*0.45, 0, 0, Math.PI*2);
      ctx.fill();

      // red glow outline
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(200,30,30,0.9)';
      ctx.stroke();

      // cartoon fuse base (small metal cap)
      const fuseX = 0;
      const fuseY = -o.r - 6;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(120,120,120,0.95)';
      ctx.rect(fuseX - 6, fuseY - 4, 12, 6);
      ctx.fill();

      // fuse line
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(200,160,60,0.95)';
      ctx.moveTo(fuseX, fuseY - 1);
      ctx.lineTo(fuseX, fuseY - 14);
      ctx.stroke();

      // animated spark using fusePhase
      o.fusePhase = (o.fusePhase || 0) + (0.04 + Math.abs(o.spin) * 0.002);
      const sparkY = fuseY - 14 + Math.sin(o.fusePhase) * 2;
      const sparkX = Math.cos(o.fusePhase * 1.5) * 2;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,180,40,0.95)';
      ctx.arc(sparkX, sparkY, 3, 0, Math.PI*2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,80,20,0.9)';
      ctx.arc(sparkX, sparkY, 1.6, 0, Math.PI*2);
      ctx.fill();

      // X mark
      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,80,80,0.95)';
      ctx.moveTo(-o.r*0.6, -o.r*0.6);
      ctx.lineTo(o.r*0.6, o.r*0.6);
      ctx.moveTo(o.r*0.6, -o.r*0.6);
      ctx.lineTo(-o.r*0.6, o.r*0.6);
      ctx.stroke();

      ctx.restore();
    }
  }
}

// simple color helpers
function lighten(hslStr, amt) {
  // expecting hsl(...) keep it simple: increase lightness percentage
  return hslStr.replace(/(\d+)%\)$/, (m, g1) => Math.min(95, Number(g1) + amt) + '%)');
}
function darken(hslStr, amt) {
  return hslStr.replace(/(\d+)%\)$/, (m, g1) => Math.max(10, Number(g1) - amt) + '%)');
}

/* particles (simple splash) and floating score popups */
function spawnParticles(x,y,color,count=8) {
  for (let i=0;i<count;i++){
    particles.push({
      x, y,
      vx: rand(-320,320),
      vy: rand(-320, -80),
      life: rand(0.35, 0.9),
      col: color,
      r: rand(2,5)
    });
  }
}
function drawParticles(dt) {
  for (let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.vy += GRAVITY * dt * 0.2;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i,1); continue; }
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.col;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/* floating score popups */
const popups = [];
function spawnPopup(x,y,text,opts={}) {
  popups.push({
    x, y,
    text: String(text),
    vx: rand(-40,40),
    vy: rand(-120, -40),
    life: opts.life || 0.9,
    age: 0,
    col: opts.col || 'white',
    size: opts.size || 18
  });
}
function drawPopups(dt) {
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += GRAVITY * dt * 0.02;
    const t = Math.max(0, 1 - p.age / p.life);
    if (p.age >= p.life) { popups.splice(i,1); continue; }
    ctx.save();
    ctx.globalAlpha = t;
    ctx.font = `${p.size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.fillStyle = p.col;
    ctx.strokeText(p.text, p.x, p.y);
    ctx.fillText(p.text, p.x, p.y);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// scoring and hit handling
function handleHit(obj, hitPoint) {
  if (obj.sliced) return;
  obj.sliced = true;
  // position for feedback: prefer hitPoint if provided
  const fx = (hitPoint && hitPoint.x) ? hitPoint.x : obj.x;
  const fy = (hitPoint && hitPoint.y) ? hitPoint.y : obj.y;

  // bomb penalty
  if (obj.type === 'bomb') {
    score = Math.max(0, score - 20);
    // bomb-specific particles and popup
    spawnParticles(fx, fy, 'rgba(255,80,80,0.95)', 18);
    spawnPopup(fx, fy, '-20', { col: 'rgba(255,80,80,0.95)', size: 20 });
    flashNotice('-20 (bomb)');
    playSound('bomb');
  } else {
    score += 10;
    // fruit splash
    spawnParticles(fx, fy, 'rgba(255,255,255,0.95)', 12);
    spawnPopup(fx, fy, '+10', { col: 'rgba(255,240,200,1)', size: 18 });
    playSound('slice');
  }
  // remove object after short delay to allow particles
  setTimeout(()=> {
    const idx = objects.findIndex(o => o.id === obj.id);
    if (idx !== -1) objects.splice(idx,1);
  }, 80);
  updateUI();
}

function flashNotice(text) {
  const prev = noticeEl.textContent;
  noticeEl.textContent = text;
  noticeEl.style.opacity = '1';
  setTimeout(()=> {
    noticeEl.textContent = prev;
  }, 900);
}

function updateUI() {
  scoreEl.textContent = `Score: ${score}`;
}

// leaderboard persistence
/* leaderboard storage support per-game (non-destructive migration) */
const STORAGE_KEY_BASE = 'hand-ninja-leaders-v1';
let currentGameId = 'default';
function storageKey(id) { const gid = id || currentGameId; return `${STORAGE_KEY_BASE}:${gid}`; }

function loadLeaders(gameId) {
  try {
    // load strictly for the specified game id (or currentGameId if omitted)
    const raw = localStorage.getItem(storageKey(gameId));
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function saveLeader(name, score, gameId) {
  try {
    const gid = gameId || currentGameId;
    const list = loadLeaders(gid) || [];
    // include explicit game id on each entry to make stored data unambiguous
    list.push({ name, score, date: Date.now(), game: gid });
    // dedupe by normalized name keeping the highest score per player
    const bestByKey = {};
    for (const e of list) {
      if (!e || !e.name) continue;
      const rawName = String(e.name).trim() || 'Player';
      const key = rawName.toLowerCase();
      const sc = Number(e.score) || 0;
      if (!bestByKey[key] || sc > bestByKey[key].score) {
        bestByKey[key] = { name: rawName, score: sc, date: e.date || Date.now(), game: gid };
      }
    }
    const compact = Object.values(bestByKey).sort((a,b) => b.score - a.score).slice(0,30);
    localStorage.setItem(storageKey(gid), JSON.stringify(compact));
    console.info(`saveLeader -> key=${storageKey(gid)}, name=${name}, score=${score}, total=${compact.length}`);
  } catch(e){
    console.warn('saveLeader failed', e);
  }
}
function showLeaders() {
  try {
    // prefer the selector value so leaderboard always reflects the chosen game
    const sel = document.getElementById('gameSelect');
    const shownGame = (sel && sel.value) ? sel.value : currentGameId;
    const h = leaderboardEl.querySelector('h3');
    if (h) h.textContent = `Leaderboard — ${shownGame}`;
  } catch(e){}
  leaderboardEl.style.display = 'flex';
  const selForList = (document.getElementById('gameSelect') && document.getElementById('gameSelect').value) ? document.getElementById('gameSelect').value : currentGameId;
  // load raw list for the selected game key
  const rawList = loadLeaders(selForList) || [];

  // ensure isolation: only consider entries that match this game id explicitly
  const filtered = rawList.filter(e => e && e.game === selForList);

  // dedupe by normalized name keeping the best score
  const bestByKey = {};
  for (const e of filtered) {
    if (!e || !e.name) continue;
    const rawName = String(e.name).trim() || 'Player';
    const key = rawName.toLowerCase();
    const sc = Number(e.score) || 0;
    if (!bestByKey[key] || sc > bestByKey[key].score) {
      bestByKey[key] = { name: rawName, score: sc };
    }
  }
  const top = Object.values(bestByKey).sort((a,b) => b.score - a.score).slice(0,10);

  const topEl = document.getElementById('leadersTop');
  const recentEl = document.getElementById('leadersRecent');
  if (topEl) topEl.innerHTML = '';
  if (recentEl) recentEl.innerHTML = '';

  if (top.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'no ledars yet';
    if (topEl) topEl.appendChild(li);
    console.info(`showLeaders -> key=${storageKey(selForList)} empty`);
    return;
  }

  for (const entry of top) {
    const li = document.createElement('li');
    li.textContent = `${entry.name} — ${entry.score}`;
    if (topEl) topEl.appendChild(li);
  }
  console.info(`showLeaders -> key=${storageKey(selForList)}, count=${top.length}`);
}
function clearLeaders() {
  try {
    const sel = document.getElementById('gameSelect');
    const gid = (sel && sel.value) ? sel.value : currentGameId;
    localStorage.removeItem(storageKey(gid));
  } catch(e){}
  const topEl = document.getElementById('leadersTop');
  const recentEl = document.getElementById('leadersRecent');
  if (topEl) topEl.innerHTML = '';
  if (recentEl) recentEl.innerHTML = '';
}

// MediaPipe setup & lifecycle
function makeHands() {
  const h = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  h.setOptions({
    selfieMode: true,
    maxNumHands: 2,
    modelComplexity: 0,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });
  h.onResults(onResults);
  return h;
}

async function startCamera() {
  // If already running a frame loop, do nothing
  if (cameraController && cameraController.looping) return;

  // configure video element for autoplay & inline playback
  try { videoEl.autoplay = true; videoEl.muted = true; videoEl.playsInline = true; } catch(e) {}

  if (!window.__handNinja) window.__handNinja = {};

  // Acquire or reuse shared media stream (will prompt only if not previously granted)
  if (!window.__handNinja._sharedStream) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      window.__handNinja._sharedStream = stream;
      videoEl.srcObject = stream;
      try { await videoEl.play(); } catch(e){}
    } catch (e) {
      console.warn('getUserMedia failed in startCamera', e);
      throw e;
    }
  } else {
    videoEl.srcObject = window.__handNinja._sharedStream;
    try { await videoEl.play(); } catch(e){}
  }

  // Start a simple RAF-driven frame loop that feeds MediaPipe hands.
  // This avoids using the Camera helper which may internally re-request media.
  cameraController = { looping: true, rafId: null, errCount: 0 };
  const loop = async () => {
    if (!cameraController || !cameraController.looping) return;
    if (hands) {
      try {
        await hands.send({ image: videoEl });
        cameraController.errCount = 0;
      } catch(e){
        cameraController.errCount = (cameraController.errCount || 0) + 1;
        console.warn('hands.send error', e);
        // try to recreate hands instance after several consecutive errors
        if (cameraController.errCount >= 5) {
          try { if (hands && hands.close) { try { hands.close(); } catch(e){} } } catch(e){}
          hands = makeHands();
          cameraController.errCount = 0;
        }
      }
    } else {
      // try to recreate a Hands instance if missing
      try { hands = makeHands(); } catch(e){ console.warn('makeHands failed', e); }
    }
    cameraController.rafId = requestAnimationFrame(loop);
  };
  loop();

  // expose stream for debugging
  window.__handNinja._mediaStream = window.__handNinja._sharedStream;
}

async function stopCamera() {
  // Stop the RAF loop but keep the media stream active to avoid re-prompting permissions.
  try {
    if (cameraController && cameraController.rafId) {
      cancelAnimationFrame(cameraController.rafId);
    }
  } catch(e){ /* ignore */ }
  cameraController = null;

  // Close hands instance to free internal resources (but do not stop shared stream)
  try {
    if (hands && hands.close) {
      if (hands.close.constructor.name === 'AsyncFunction') {
        await hands.close();
      } else {
        try { hands.close(); } catch(e){ console.warn('hands.close failed', e); }
      }
    }
  } catch(e){ console.warn('hands.close failed', e); }
  hands = null;

  // reset frame timer to avoid a huge dt on next run
  lastFrameTime = performance.now();
}

// game loop via MediaPipe onResults
let lastFrameTime = performance.now();
function onResults(results) {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // draw video
  drawVideoFrame(results.image);

  // update spawn timers + objects only for ninja-fruit mode
  if (currentGameId === 'ninja-fruit') {
    if (running) {
      if (now - lastFruitSpawn > FRUIT_SPAWN_INTERVAL) {
        lastFruitSpawn = now;
        spawnFruit();
      }
      if (now - lastBombSpawn > BOMB_SPAWN_INTERVAL) {
        lastBombSpawn = now;
        // low probability additional check to keep bombs rare
        if (Math.random() < 0.6) spawnBomb();
      }
    }
    // update objects physics & draw
    drawObjects(dt);
  } else {
    // Non-fruit modes should not show ninja objects; clear any leftover objects.
    if (objects.length) objects.length = 0;
  }

  // map landmarks and draw hand trails and collision detection
  const allLandmarks = results.multiHandLandmarks || [];
  const mappedHands = allLandmarks.map(landmarks => mapLandmarksToCanvas(landmarks, results));

  // draw light hand trails (for user feedback)
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineCap = 'round';
  for (const hand of mappedHands) {
    ctx.beginPath();
    for (let i=0;i<hand.length;i++){
      const p = hand[i];
      if (i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y);
    }
    ctx.stroke();
  }

  // collision detection and mode-specific interactions
  if (currentGameId === 'paint-air') {
    // Draw and record index-finger path for Paint Air mode and award points only when on-track.
    // This variant implements free drawing (no timer) plus toolbar controls:
    // - paintColor, paintSize, eraserMode, drawingEnabled
    try {
      const nowT = performance.now();
      let addedLen = 0;

      if (mappedHands[0] && mappedHands[0][8] && running) {
        const pt = mappedHands[0][8];
        const prev = paintPaths.length ? paintPaths[paintPaths.length - 1] : null;

        // Record or erase points based on toolbar state
        if (drawingEnabled) {
          if (eraserMode) {
            // Erase nearby points from paintPaths (simple point-based erase)
            const eraseRadius = Math.max(8, (paintSize || 12) * 0.8);
            for (let i = paintPaths.length - 1; i >= 0; i--) {
              const p = paintPaths[i];
              if (Math.hypot(p.x - pt.x, p.y - pt.y) <= eraseRadius) {
                paintPaths.splice(i, 1);
              }
            }
          } else {
            // Normal drawing: append point
            paintPaths.push({ x: pt.x, y: pt.y, t: nowT });
            if (paintPaths.length > 20000) paintPaths.splice(0, paintPaths.length - 20000);
          }
        }

        if (prev) addedLen = Math.hypot(pt.x - prev.x, pt.y - prev.y);

        // determine if the new point is close to the target track (only count when drawing)
        let onTrack = false;
        const threshold = 30; // pixels tolerance
        if (!eraserMode && paintTrack.length) {
          for (let i = 0; i < paintTrack.length - 1; i++) {
            const a = paintTrack[i], b = paintTrack[i+1];
            const d = segmentCircleDist(a.x,a.y,b.x,b.y, pt.x, pt.y);
            if (d <= threshold) { onTrack = true; break; }
          }
          if (onTrack && addedLen > 0.6) {
            paintOnTrackLen += addedLen;
          }
        }
      }

      // draw target track (dashed)
      if (paintTrack.length) {
        ctx.save();
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(220,220,220,0.75)';
        ctx.setLineDash([10,8]);
        ctx.beginPath();
        for (let i = 0; i < paintTrack.length; i++) {
          const p = paintTrack[i];
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // draw user paint path using toolbar color/size
      if (paintPaths.length) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = paintColor || 'rgba(0,180,255,0.95)';
        ctx.lineWidth = paintSize || 12;
        ctx.beginPath();
        for (let i = 0; i < paintPaths.length; i++) {
          const p = paintPaths[i];
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // update score based on on-track painted length (scaled)
      const newScore = Math.min(9999, Math.floor(paintOnTrackLen / 12));
      if (newScore !== score) {
        score = newScore;
        updateUI();
      }

      // optional debug dot at last point
      if (paintPaths.length) {
        const lp = paintPaths[paintPaths.length - 1];
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.arc(lp.x, lp.y, 6, 0, Math.PI*2);
        ctx.fill();
      }
    } catch(e){ console.warn('paint-air onResults error', e); }
  } else if (currentGameId === 'shape-trace') {
    // Shape Trace: player must trace the current shape outline; when coverage >= threshold move to next shape
    try {
      if (!shapes.length) {
        const s = generateRandomShape();
        shapes.push(s);
        shapeCovered = new Array(Math.max(0, s.points.length - 1)).fill(false);
        shapeIndex = 0;
        shapeProgress = 0;
      }
      if (running && mappedHands[0] && mappedHands[0][8]) {
        const pt = mappedHands[0][8];
        // check proximity to each segment and mark covered
        const s = shapes[shapeIndex];
        for (let i = 0; i < s.points.length - 1; i++) {
          if (shapeCovered[i]) continue;
          const a = s.points[i], b = s.points[i+1];
          const d = segmentCircleDist(a.x,a.y,b.x,b.y, pt.x, pt.y);
          if (d <= shapeTolerance) {
            shapeCovered[i] = true;
            // award small incremental points per covered segment
            score += 2;
            spawnPopup(pt.x, pt.y, '+2', { col: 'cyan', size: 14 });
            // Play segment_complete when this connects to adjacent covered segments, otherwise play point
            try {
              const L = shapeCovered.length;
              const prev = shapeCovered[(i - 1 + L) % L];
              const next = shapeCovered[(i + 1) % L];
              if (prev || next) {
                playSound('segment_complete');
              } else {
                playSound('point');
              }
            } catch(e){}
            updateUI();
          }
        }
        // compute progress
        const covered = shapeCovered.reduce((s1,x)=> s1 + (x?1:0), 0);
        shapeProgress = covered / shapeCovered.length;
        // if shape sufficiently covered, move to next
        if (shapeProgress >= 0.95) {
          try { playSound('shape_complete'); } catch(e){}
          spawnPopup(canvas.width/ (2*DPR), canvas.height/(2*DPR), 'Shape Complete!', { col: 'lime', size: 20 });
          score += 50;
          updateUI();
          // prepare next shape
          const next = generateRandomShape();
          shapes.push(next);
          shapeIndex++;
          shapeCovered = new Array(Math.max(0, next.points.length - 1)).fill(false);
          shapeProgress = 0;
          // reset paint path for clarity
          paintPaths.length = 0;
          noticeEl.textContent = `Shape ${shapeIndex + 1} — trace the outline`;
        }
      }

      // draw current shape outline with covered segments highlighted
      const cur = shapes[shapeIndex];
      if (cur && cur.points && cur.points.length) {
        ctx.save();
        // draw uncovered in gray dashed
        ctx.lineWidth = 8;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (let i = 0; i < cur.points.length - 1; i++) {
          const a = cur.points[i], b = cur.points[i+1];
          ctx.beginPath();
          if (shapeCovered[i]) {
            ctx.strokeStyle = 'rgba(100,255,140,0.95)';
            ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = 'rgba(200,200,200,0.65)';
            ctx.setLineDash([12,8]);
          }
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();

        // finger pointer for shape-trace (follows index tip)
        try {
          if (mappedHands[0] && mappedHands[0][8]) {
            const tip = mappedHands[0][8];
            // small solid dot
            ctx.beginPath();
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.arc(tip.x, tip.y, 6, 0, Math.PI * 2);
            ctx.fill();
            // subtle ring to highlight
            ctx.beginPath();
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(0,200,255,0.9)';
            ctx.arc(tip.x, tip.y, 12, 0, Math.PI * 2);
            ctx.stroke();
          }
        } catch(e){}
      }
    } catch(e){ console.warn('shape-trace error', e); }
  }

  // collision detection: only active for ninja-fruit mode
  if (currentGameId === 'ninja-fruit') {
    for (const hand of mappedHands) {
      for (let s=0; s<hand.length-1; s++) {
        const p = hand[s], q = hand[s+1];
        for (let i = objects.length - 1; i >= 0; i--) {
          const obj = objects[i];
          if (obj.sliced) continue;
          if (sliceSegmentIntersectsFruit(p.x,p.y,q.x,q.y,obj)) {
            handleHit(obj, { x: (p.x+q.x)/2, y: (p.y+q.y)/2 });
          }
        }
      }
    }
  }

  // draw particles on top
  drawParticles(dt);
  // draw floating popups
  drawPopups(dt);

  // draw HUD elements such as timer
  if (running) {
    if (paintModeNoTimer) {
      // Paint-mode uses a manual finish button; hide timer in that mode.
      timerEl.textContent = '';
    } else {
      const elapsed = (now - startTime) / 1000;
      const remaining = Math.max(0, duration - Math.floor(elapsed));
      timerEl.textContent = `Time: ${remaining}s`;
      if (remaining <= 0) endGame();
    }
  }
}

async function startGame() {
  if (running) return;
  // reset state
  score = 0;
  objects.length = 0;
  particles.length = 0;
  updateUI();
  duration = Number(gameLengthEl.value || 45);
  startTime = performance.now();
  lastFrameTime = performance.now();
  lastFruitSpawn = startTime;
  lastBombSpawn = startTime;

  // Prepare UI but don't mark running until camera is confirmed
  menuEl.style.display = 'none';
  noticeEl.textContent = 'Starting camera... please allow permission if requested';

    // Set per-game asset paths based on selected game; put files under assets/<gameId>/
    try {
    const sel = document.getElementById('gameSelect');
    if (sel) currentGameId = sel.value || currentGameId;
    // prefer per-game folder; fallback to top-level assets if not present
    if (currentGameId === 'ninja-fruit') {
      // explicit mapping for the ninja-fruit package provided in the workspace
      ASSETS.bgm = 'assets/ninga-game-sounds/bgm.mp3';
      ASSETS.slice = 'assets/ninga-game-sounds/slice-frute.mp3';
      // note: the bomb audio in that folder is named "boomb.mp3"
      ASSETS.bomb = 'assets/ninga-game-sounds/boomb.mp3';
      ASSETS.sfx = {};
    } else if (currentGameId === 'paint-air') {
      // paint-air: project supplies only a few SFX (no bgm provided by default)
      ASSETS.bgm = `assets/painf-air-game/bgm_paint_loop.mp3`;
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = {
        clear: 'assets/painf-air-game/sfx_clear.mp3',
        done: 'assets/painf-air-game/sfx_done.mp3',
        pop_small: 'assets/painf-air-game/sfx_pop_small.mp3'
      };
    } else if (currentGameId === 'shape-trace') {
      // shape-trace: use the available bgm + several SFX
      ASSETS.bgm = 'assets/shape-track-game/bgm_shape_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = {
        point: 'assets/shape-track-game/sfx_point.mp3',
        segment_complete: 'assets/shape-track-game/sfx_segment_complete.mp3',
        shape_complete: 'assets/shape-track-game/sfx_shape_complete.mp3',
        popup: 'assets/shape-track-game/sfx_popup.mp3',
        wrong: 'assets/shape-track-game/sfx_wrong.mp3'
      };
    } else {
      ASSETS.bgm = `assets/${currentGameId}/bgm.mp3`;
      ASSETS.slice = `assets/${currentGameId}/slice.wav`;
      ASSETS.bomb = `assets/${currentGameId}/bomb.wav`;
      ASSETS.sfx = {};
    }
    // clear any previously loaded fruit images so preload can reload for new game
    ASSETS._fruitImages = [];
    // attempt to preload assets for the selected game (do not block startup on failure)
    await preloadAssets().catch(()=>{});
  } catch (e) {
    console.warn('per-game asset setup failed', e);
  }

  // mode-specific initialization
  try {
    if (currentGameId === 'paint-air') {
      // reset user paint path and tracking progress
      paintPaths.length = 0;
      paintTrack.length = 0;
      paintOnTrackLen = 0;
      // ensure paint toolbar state is fresh
      paintColor = paintColor || '#00b4ff';
      paintSize = paintSize || 12;
      eraserMode = false;
      drawingEnabled = true;
      score = 0;
      updateUI();
      // generate a simple smooth target track to trace (sine wave across screen)
      (function genTrack(){
        const w = canvas.width / DPR, h = canvas.height / DPR;
        const steps = 120;
        for (let i = 0; i < steps; i++) {
          const t = i / (steps - 1);
          const x = 40 + (w - 80) * t;
          const y = h * 0.35 + Math.sin(t * Math.PI * 2 * 1.1) * h * 0.12;
          paintTrack.push({ x, y });
        }
      })();
      // Enter no-timer paint mode and show toolbar (user finishes with Done)
      paintModeNoTimer = true;
      showPaintToolbar(true);
      noticeEl.textContent = 'Paint Air — draw freely. Use the tools to edit and press Done when finished';
    } else if (currentGameId === 'shape-trace') {
      // prepare shape-trace mode
      shapes.length = 0;
      shapeIndex = 0;
      shapeCovered = [];
      shapeProgress = 0;
      score = 0;
      updateUI();
      // generate first shape and init coverage
      const s = generateRandomShape();
      shapes.push(s);
      shapeCovered = new Array(Math.max(0, s.points.length - 1)).fill(false);
      noticeEl.textContent = 'Shape Trace — trace the shape outline to fill it';
    } else {
      // default to ninja fruit behavior
      objects.length = 0;
      // ensure paint toolbar is hidden when not in paint mode
      paintModeNoTimer = false;
      showPaintToolbar(false);
      noticeEl.textContent = 'Starting game...';
    }
  } catch(e){ /* ignore mode init errors */ }

  // ensure a single Hands instance
  if (!hands) hands = makeHands();

  // Try to start camera and handle permission failures gracefully
  try {
    await startCamera();
  } catch (e) {
    console.warn('startCamera failed in startGame', e);
    // If permission denied or camera failed, return to menu and show helpful message
    menuEl.style.display = 'flex';
    noticeEl.textContent = 'Camera permission required — click Play and allow camera access.';
    running = false;
    return;
  }

  // Only mark running after camera & hands are active
  running = true;
  menuEl.style.display = 'none';
  // set a mode-appropriate start message (do not always claim ninja fruit)
  try {
    if (currentGameId === 'ninja-fruit') {
      noticeEl.textContent = 'Game started — slice fruits, avoid bombs!';
    } else if (currentGameId === 'paint-air') {
      noticeEl.textContent = 'Paint Air started — move your index finger to draw';
    } else if (currentGameId === 'simon-gesture') {
      noticeEl.textContent = 'Simon Gesture started — watch the sequence';
    } else {
      noticeEl.textContent = 'Game started';
    }
  } catch(e){
    noticeEl.textContent = 'Game started';
  }
  // ensure initial frame will be processed shortly
}

async function endGame() {
  if (!running) return;
  running = false;
  // keep camera running (do not stop media tracks) to avoid re-prompting for permission on restart
  // save leaderboard
  const name = (playerNameEl.value || 'Player').slice(0,24);
  // save under the currently selected game id to ensure per-game isolation
  const sel = document.getElementById('gameSelect');
  const gid = (sel && sel.value) ? sel.value : currentGameId;
  saveLeader(name, score, gid);
  // show menu again after slight delay
  setTimeout(()=> {
    menuEl.style.display = 'flex';
    noticeEl.textContent = 'Game over. Enter name and press Play to try again.';
    showLeaders();
  }, 250);
}

/* wire UI */
menuStartBtn.addEventListener('click', async ()=> { 
  // sync current game id from selector before starting
  const sel = document.getElementById('gameSelect');
  if (sel) currentGameId = sel.value || currentGameId;
  await startGame(); 
});
showLeadersBtn.addEventListener('click', ()=> showLeaders());
closeLeadersBtn.addEventListener('click', ()=> leaderboardEl.style.display = 'none');
clearLeadersBtn.addEventListener('click', ()=> clearLeaders());

/* Export removed — leaderboard now strictly per-game to keep UI minimal. */


/* music controls: keep only the in-game/top UI music checkbox.
   Removed the menu music toggle (it caused overlapping BGM tied to
   the ninja shared bgm file). Per-game music is controlled via the
   single `musicCheckbox` element. */
const uiMusicCheckbox = document.getElementById('musicCheckbox');
function syncMusicCheckboxes(v) {
  try {
    if (uiMusicCheckbox) uiMusicCheckbox.checked = !!v;
  } catch(e){}
}
if (uiMusicCheckbox) {
  uiMusicCheckbox.addEventListener('change', (e) => {
    setMusicEnabled(!!e.target.checked);
    syncMusicCheckboxes(e.target.checked);
  });
}

 // game selector wiring
const gameSel = document.getElementById('gameSelect');
if (gameSel) {
  currentGameId = gameSel.value || currentGameId;
  gameSel.addEventListener('change', (e) => {
    currentGameId = e.target.value || 'default';
    // update leaderboard title if open
    if (leaderboardEl && leaderboardEl.style.display === 'flex') showLeaders();
  });
}

// Paint toolbar wiring (visible only for paint-air mode)
const paintToolbarEl = document.getElementById('paintToolbar');
const paintColorEl = document.getElementById('paintColor');
const paintSizeEl = document.getElementById('paintSize');
const eraserToggleBtn = document.getElementById('eraserToggle');
const toggleDrawBtn = document.getElementById('toggleDrawBtn');
const clearPaintBtn = document.getElementById('clearPaintBtn');
const clearTrackBtn = document.getElementById('clearTrackBtn');
const finishPaintBtn = document.getElementById('finishPaintBtn');

function showPaintToolbar(show) {
  if (!paintToolbarEl) return;
  paintToolbarEl.style.display = show ? 'flex' : 'none';
}

// wire toolbar controls
if (paintColorEl) paintColorEl.addEventListener('input', (e) => { paintColor = e.target.value || paintColor; });
if (paintSizeEl) paintSizeEl.addEventListener('input', (e) => { paintSize = Number(e.target.value) || paintSize; });
if (eraserToggleBtn) {
  eraserToggleBtn.addEventListener('click', () => {
    eraserMode = !eraserMode;
    eraserToggleBtn.textContent = eraserMode ? 'Eraser: ON' : 'Eraser: OFF';
  });
}
if (toggleDrawBtn) {
  toggleDrawBtn.addEventListener('click', () => {
    drawingEnabled = !drawingEnabled;
    toggleDrawBtn.textContent = drawingEnabled ? 'Stop Drawing' : 'Resume Drawing';
  });
}
if (clearPaintBtn) {
  clearPaintBtn.addEventListener('click', () => {
    paintPaths.length = 0;
    // play clear sfx if available
    try { playSound('clear'); } catch(e){}
  });
}
if (clearTrackBtn) {
  clearTrackBtn.addEventListener('click', () => {
    // Clear the paint target track (for paint-air) or clear current shapes (for shape-trace).
    if (currentGameId === 'paint-air') {
      paintTrack.length = 0;
      paintOnTrackLen = 0;
      noticeEl.textContent = 'Track cleared';
      try { playSound('clear'); } catch(e){}
    }
    if (currentGameId === 'shape-trace') {
      shapes.length = 0;
      shapeCovered = [];
      shapeProgress = 0;
      noticeEl.textContent = 'Shape cleared';
      try { playSound('popup'); } catch(e){}
    }
    // If not in a mode, clear both as a safe fallback
    if (!currentGameId) {
      paintTrack.length = 0;
      shapes.length = 0;
      shapeCovered = [];
      paintOnTrackLen = 0;
      shapeProgress = 0;
      noticeEl.textContent = 'Cleared track and shapes';
      try { playSound('clear'); } catch(e){}
    }
  });
}
if (finishPaintBtn) {
  finishPaintBtn.addEventListener('click', () => {
    // finishing paint: stop the current run and return to menu without saving leaderboard
    try { playSound('done'); } catch(e){}
    running = false;
    paintModeNoTimer = false;
    showPaintToolbar(false);
    menuEl.style.display = 'flex';
    noticeEl.textContent = 'Painting finished.';
    paintPaths.length = 0;
  });
}

// ensure toolbar hidden initially
showPaintToolbar(false);

// assets info toggle
const assetsBtn = document.getElementById('assetsInfoBtn');
const assetsPanel = document.getElementById('assetsInfo');
if (assetsBtn && assetsPanel) {
  assetsBtn.addEventListener('click', () => {
    assetsPanel.style.display = assetsPanel.style.display === 'none' ? 'block' : 'none';
  });
}

// sync music initial state
syncMusicCheckboxes(musicEnabled);

playerNameEl.placeholder = 'Player';

/* automatic resume if user navigates back (defensive)
   Avoid calling stopCamera() here because stopping media tracks can
   trigger permission prompts on next start. Instead, stop the local
   RAF loop and try to close Hands without stopping the shared stream. */
window.addEventListener('beforeunload', ()=> {
  try {
    if (cameraController && cameraController.rafId) {
      cancelAnimationFrame(cameraController.rafId);
    } else if (cameraController && cameraController.looping) {
      cameraController.looping = false;
    }
  } catch(e){ /* ignore */ }
  try {
    if (hands && hands.close) {
      try { hands.close(); } catch(e){ /* ignore */ }
    }
  } catch(e){ /* ignore */ }
});

 // initial UI update
preloadAssets().catch(()=>{});
updateUI();

// Expose some debug hooks (optional)
window.__handNinja = {
  spawnFruit,
  spawnBomb,
  objects,
  particles,
  startGame,
  endGame,
  // expose current game id and allow switching from console for testing
  currentGameId: () => currentGameId,
  setCurrentGameId: (id) => { currentGameId = id || 'default'; }
};
