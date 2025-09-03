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

import * as Net from './net.js';
const DPR = Math.max(1, window.devicePixelRatio || 1);

// Networking: throttle and lightweight peer state for ghost rendering
const NET_THROTTLE_MS = 83; // ~12 Hz
if (!window.__handNinja) window.__handNinja = {};
window.__handNinja._lastNetSendT = window.__handNinja._lastNetSendT || 0;
// local smoothing state for remote peers: id -> { x, y, lastT, alpha }
const netPeersState = new Map();

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

// Global caps and cooldowns to limit transient objects and audio thrash
const MAX_PARTICLES = 200;
const MAX_POPUPS = 24;
const POPUP_COOLDOWN_MS = 50;
const SOUND_COOLDOWN_MS = 80;
// last play timestamps (stored on the shared debug object)
if (!window.__handNinja) window.__handNinja = {};
window.__handNinja._lastPopupTime = window.__handNinja._lastPopupTime || 0;
window.__handNinja._lastSoundTimes = window.__handNinja._lastSoundTimes || {};

 // Paint Air mode scaffold
const paintPaths = []; // stores points and null separators: {x,y,t,color,size} or null
// spatial buckets for fast erase lookups (keys -> arrays of point object refs)
const paintBuckets = new Map();
const BUCKET_SIZE = 80; // tuned bucket size; adjust if needed
let lastPaintPushT = 0;
let lastEraserProcessT = 0;
let deletedCount = 0;

let paintEnabled = false;
let drawingEnabled = true;
let paintColor = '#00b4ff';
let paintSize = 12;
let eraserMode = false;
const paintTrack = []; // target path to trace (array of {x,y})
let paintOnTrackLen = 0;
let paintModeNoTimer = false;
// auto-stop flag when two hands temporarily disable drawing
let autoStoppedByTwoHands = false;

// bucket helpers
function bucketKey(x, y) { return `${Math.floor(x / BUCKET_SIZE)}:${Math.floor(y / BUCKET_SIZE)}`; }
function addPointToBucket(pt) {
  const k = bucketKey(pt.x, pt.y);
  let arr = paintBuckets.get(k);
  if (!arr) { arr = []; paintBuckets.set(k, arr); }
  arr.push(pt);
}
function getBucketKeysForCircle(x, y, r) {
  const minX = Math.floor((x - r) / BUCKET_SIZE);
  const maxX = Math.floor((x + r) / BUCKET_SIZE);
  const minY = Math.floor((y - r) / BUCKET_SIZE);
  const maxY = Math.floor((y + r) / BUCKET_SIZE);
  const keys = [];
  for (let gx = minX; gx <= maxX; gx++) {
    for (let gy = minY; gy <= maxY; gy++) {
      keys.push(`${gx}:${gy}`);
    }
  }
  return keys;
}
function compactPaintStorage() {
  // remove deleted points and rebuild buckets to avoid unbounded growth
  const kept = paintPaths.filter(p => p === null || (p && !p._deleted));
  paintPaths.length = 0;
  paintPaths.push(...kept);
  paintBuckets.clear();
  for (const p of paintPaths) {
    if (p && p !== null && !p._deleted) addPointToBucket(p);
  }
  deletedCount = 0;
}

 // Shape Trace scaffold
let shapes = [];
let shapeIndex = 0;
let shapeCovered = [];
let shapeTolerance = 80; // increased tolerance so corners register more easily
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

// Inline modules: Runner-Control and Simon-Pro (consolidated into main file)
// These reuse existing globals: ctx, canvas, DPR, spawnParticles, spawnPopup, playSound, detectSimpleGesture

const runnerControlModule = (function(){
  // Runner-Control: compact inline port
  let avatar = null;
  let obstacles = [];
  let lastSpawn = 0;
  let runningModule = false;
  const OB_SPAWN_MS = 1300;
  const MAX_OBSTACLES = 4;
  const GRAVITY_MODULE = 1200;

  function rand(a,b){ return a + Math.random()*(b-a); }
  function randInt(a,b){ return Math.floor(rand(a,b+1)); }

  function resetRunner(){
    const width = canvas.width / DPR;
    const height = canvas.height / DPR;
    // No lives: runner-play is time-limited only. Score stored globally.
    avatar = { x: Math.max(80, width*0.18), y: height*0.5, vy:0, r:16, speed: 180, stamina: 1.0 };
    obstacles = [];
    lastSpawn = performance.now();
    runningModule = true;
  }

  function spawnObstacleRunner(){
    // limit concurrent obstacles to make the game easier
    if (obstacles.length >= MAX_OBSTACLES) return;
    const width = canvas.width / DPR;
    const height = canvas.height / DPR;
    const h = randInt(28, 64);
    const gap = randInt(150, 240);
    const y = randInt(60, Math.max(100, height - 60 - gap));

    // narrower speed variance so "slow" pliers are closer to fast ones
    const baseSpeed = 230;
    const speed = baseSpeed + randInt(-12, 12);

    // stagger spawn X to avoid overlapping pairs and give player room
    const STAGGER = 96; // px between nominal spawn offsets
    const JITTER = randInt(0, 40);
    const baseX = width + 80;
    const spawnX = baseX + obstacles.length * STAGGER + JITTER;

    // prevent spawning too close to existing obstacles; skip this spawn if too close
    const MIN_HORIZONTAL_GAP = 140;
    for (const o of obstacles) {
      if (Math.abs(o.x - spawnX) < MIN_HORIZONTAL_GAP) {
        // defer spawn (will be retried on next spawn window)
        return;
      }
    }

    obstacles.push({ id: Math.random().toString(36).slice(2,9), x: spawnX, y, h, gap, w: 32, speed, passed:false });
  }

  function updateRunner(dt, hands){
    if (!runningModule) return;
    // stop updating when global run state ended
    if (!running) { runningModule = false; return; }
    const width = canvas.width / DPR;
    const height = canvas.height / DPR;

    // integrate motion with smoother damping to avoid jitter/etching.
    // Use fingertip-driven desired velocity and lerp avatar.vy toward it, then integrate.
    // This produces responsive but smoothed movement and reduces abrupt positional jumps.
    const tip = (hands && hands.length === 1 && hands[0] && hands[0][8]) ? hands[0][8] : null;
    if (tip) {
      const targetY = tip.y;
      // compute desired velocity to move toward fingertip (tunable responsiveness)
      const desiredVy = (targetY - avatar.y) * 8; // higher = more responsive
      // lerp factor for velocity smoothing (frame-rate independent)
      const blend = Math.min(1, 8 * dt);
      avatar.vy += (desiredVy - avatar.vy) * blend;
      // small gravity to preserve subtle downward feel when fingertip still
      avatar.vy += GRAVITY_MODULE * dt * 0.001;
      // integrate position
      avatar.y += avatar.vy * dt;

      // compute fingertip velocity for poke detection (unchanged measurement)
      if (!updateRunner._lastTipY) updateRunner._lastTipY = targetY;
      const vyTip = (targetY - updateRunner._lastTipY) / Math.max(0.001, dt);
      updateRunner._lastTipY = targetY;

      // quick downward poke (hand moving quickly downward) => give a smooth upward impulse
      // Remove particle and jump sound to satisfy "no jump particles or sound" requirement.
      if (vyTip > 300) {
        // apply an upward velocity impulse (clamped) for a responsive pop without visual/sound noise
        const impulse = Math.min(220, vyTip * 0.02);
        // set a negative vy to move avatar upward smoothly
        avatar.vy = Math.min(avatar.vy, -impulse);
      }
    }

    // clamp
    if (avatar.y < 20) { avatar.y = 20; avatar.vy = 0; }
    if (avatar.y > height - 20) { avatar.y = height - 20; avatar.vy = 0; }

    // spawn obstacles
    const now = performance.now();
    if (now - lastSpawn > OB_SPAWN_MS) {
      lastSpawn = now;
      spawnObstacleRunner();
      if (Math.random() < 0.06) lastSpawn -= 260;
    }

    // update obstacles
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      o.x -= o.speed * dt;

      // collision check
      if (avatar.x + avatar.r > o.x && avatar.x - avatar.r < o.x + o.w) {
        if (avatar.y - avatar.r < o.y + o.h || avatar.y + avatar.r > o.y + o.gap) {
          // collision: do not remove lives. Apply a small global score penalty and visual feedback.
          score = Math.max(0, score - 5);
          spawnParticles && spawnParticles(avatar.x, avatar.y, 'rgba(255,80,80,0.95)', 16);
          spawnPopup && spawnPopup(avatar.x, avatar.y, '-5', { col: 'rgba(255,80,80,0.9)', size: 18 });
          try { playSound && playSound('bomb'); } catch(e){}
          avatar.x -= 8;
          obstacles.splice(i,1);
          updateUI();
          continue;
        }
      }

      // scoring when obstacle passes avatar
      if (!o.passed && o.x + o.w < avatar.x) {
        o.passed = true;
        score += 10;
        spawnPopup && spawnPopup(avatar.x + 40, avatar.y, '+10', { col: 'yellow', size: 14 });
        try { playSound && playSound('point'); } catch(e){}
        updateUI();
      }

      if (o.x + o.w < -120) obstacles.splice(i,1);
    }

    // no lives-based end condition: runner-control runs until the global timer ends
    // (keep module alive; global endGame() will be called when time runs out)
  }

  function drawRunner(){
    if (!ctx) return;
    const width = canvas.width / DPR;
    const height = canvas.height / DPR;
    ctx.save();
    // keep video visible as background so the user can see themself (do not paint over)
    // avatar
    ctx.beginPath();
    ctx.fillStyle = 'orange';
    ctx.arc(avatar.x, avatar.y, avatar.r, 0, Math.PI*2);
    ctx.fill();
    // HUD is handled by the global UI (scoreEl) — no per-avatar score box here.
    // obstacles
    for (const o of obstacles) {
      ctx.fillStyle = '#444';
      ctx.fillRect(o.x, 0, o.w, o.y + o.h);
      ctx.fillRect(o.x, o.y + o.gap, o.w, height - (o.y + o.gap));
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    }
    ctx.restore();
  }

  return {
    init(){ resetRunner(); },
    update(dt, hands){ updateRunner(dt, hands); drawRunner(); },
    onStart(){ resetRunner(); },
    onEnd(){
      runningModule = false;
      try { updateUI(); } catch(e){}
    }
  };
})();

const mazeModule = (function(){
  // Maze Game (previously Simon-Pro): start in center and reach one of the exit cells at the maze edge.
  // Supports a "mini" variant (smaller grids + multiple exits) for easier play.
  let cols = 0, rows = 0, cellSize = 0;
  let mazeOx = 0, mazeOy = 0;
  let finished = false;
  let cells = null; // array of { walls: [top,right,bottom,left], visited }
  let player = null; // { cx, cy, x, y, targetX, targetY }
  let exitCells = []; // array of possible exit cells {cx,cy}
  let runningModule = false;

  function randInt(a,b){ return Math.floor(a + Math.random()*(b-a+1)); }
  function idx(cx,cy){ return cx + cy * cols; }

  function generateMaze(w, h) {
    // Mini maze: use a smaller grid and shrink cells so the maze doesn't fill the whole frame
    cols = Math.max(3, Math.floor(w / 120));
    rows = Math.max(3, Math.floor(h / 120));
    // compute base cell size then reduce so maze appears smaller and easier
    const baseCell = Math.floor(Math.min(w / cols, h / rows));
    cellSize = Math.max(18, Math.floor(baseCell * 0.66));
    // compute maze origin so drawing and input coordinate spaces align
    const mazeW = cols * cellSize, mazeH = rows * cellSize;
    mazeOx = Math.floor((w - mazeW) / 2);
    mazeOy = Math.floor((h - mazeH) / 2);
    cells = new Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        cells[idx(x,y)] = { walls: [true, true, true, true], visited: false };
      }
    }
    // randomized DFS
    const stack = [];
    const startX = Math.floor(cols/2), startY = Math.floor(rows/2);
    cells[idx(startX,startY)].visited = true;
    stack.push({x:startX,y:startY});
    while (stack.length) {
      const cur = stack[stack.length-1];
      const neighbors = [];
      const dirs = [
        { dx:0, dy:-1, wallA:0, wallB:2 }, // top
        { dx:1, dy:0, wallA:1, wallB:3 },  // right
        { dx:0, dy:1, wallA:2, wallB:0 },  // bottom
        { dx:-1, dy:0, wallA:3, wallB:1 }  // left
      ];
      for (const d of dirs) {
        const nx = cur.x + d.dx, ny = cur.y + d.dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !cells[idx(nx,ny)].visited) neighbors.push({nx,ny,d});
      }
      if (neighbors.length === 0) {
        stack.pop();
      } else {
        const pick = neighbors[randInt(0, neighbors.length - 1)];
        // knock down wall between cur and pick
        const a = cells[idx(cur.x,cur.y)], b = cells[idx(pick.nx,pick.ny)];
        a.walls[pick.d.wallA] = false;
        b.walls[pick.d.wallB] = false;
        b.visited = true;
        stack.push({x: pick.nx, y: pick.ny});
      }
    }
    // pick exit(s) on border cells (not the center). For mini mode choose multiple exits.
    const borderCandidates = [];
    for (let x = 0; x < cols; x++) { borderCandidates.push({x, y:0}); borderCandidates.push({x, y:rows-1}); }
    for (let y = 1; y < rows-1; y++) { borderCandidates.push({x:0, y}); borderCandidates.push({x:cols-1, y}); }
    // choose cell(s) that are not the start
    const startIdx = idx(startX, startY);
    exitCells = [];
    if (currentGameId === 'maze-mini') {
      // easier: pick several distinct border exits (2-4)
      const count = randInt(2, Math.min(4, Math.max(2, Math.floor((cols + rows) / 6))));
      const used = new Set();
      while (exitCells.length < count) {
        const c = borderCandidates[randInt(0, borderCandidates.length - 1)];
        const k = idx(c.x, c.y);
        if (k === startIdx || used.has(k)) continue;
        used.add(k);
        exitCells.push({ cx: c.x, cy: c.y });
        if (exitCells.length >= borderCandidates.length) break;
      }
      if (exitCells.length === 0) {
        const c = borderCandidates[0];
        exitCells.push({ cx: c.x, cy: c.y });
      }
    } else {
      // single exit chosen randomly
      let chosen = null;
      for (let i = 0; i < 12; i++) {
        const c = borderCandidates[randInt(0, borderCandidates.length - 1)];
        if (idx(c.x, c.y) !== startIdx) { chosen = c; break; }
      }
      if (!chosen) chosen = borderCandidates[0];
      exitCells = [{ cx: chosen.x, cy: chosen.y }];
    }

    // player starts in center cell
    player = {
      cx: startX, cy: startY,
      x: startX * cellSize + cellSize/2,
      y: startY * cellSize + cellSize/2,
      targetX: startX * cellSize + cellSize/2,
      targetY: startY * cellSize + cellSize/2,
      speed: Math.max(160, cellSize * 3) // pixels per second-ish
    };
  }

  function cellCenter(cx,cy) { return { x: cx * cellSize + cellSize/2, y: cy * cellSize + cellSize/2 }; }

  function tryMoveTowardTip(tip) {
    if (!tip || !player) return;
    // map fingertip into maze-local coordinates
    const localTipX = tip.x - (mazeOx || 0);
    const localTipY = tip.y - (mazeOy || 0);
    const vx = localTipX - player.x;
    const vy = localTipY - player.y;
    const dist = Math.hypot(vx, vy);
    if (dist < 4) return;

    // compute a modest fractional step toward the fingertip (actual smoothing happens in updateModule)
    const maxStep = Math.max(12, player.speed * 0.02); // small step to allow responsive guidance
    const stepFactor = Math.min(1, maxStep / dist);
    const desiredX = player.x + vx * stepFactor;
    const desiredY = player.y + vy * stepFactor;

    const curCx = player.cx, curCy = player.cy;
    const tCx = Math.floor(desiredX / cellSize);
    const tCy = Math.floor(desiredY / cellSize);

    // quick allow if staying inside current cell
    if (tCx === curCx && tCy === curCy) {
      player.targetX = desiredX;
      player.targetY = desiredY;
      return;
    }

    // helper to check if wall between two neighboring cells is open
    function isOpenBetween(cx, cy, nx, ny) {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return false;
      const cur = cells[idx(cx, cy)];
      const dx = nx - cx, dy = ny - cy;
      if (dx === 1) return !cur.walls[1];
      if (dx === -1) return !cur.walls[3];
      if (dy === 1) return !cur.walls[2];
      if (dy === -1) return !cur.walls[0];
      return false;
    }

    // allow movement to adjacent cell only if opening exists between current and target
    if (Math.abs(tCx - curCx) + Math.abs(tCy - curCy) === 1) {
      if (isOpenBetween(curCx, curCy, tCx, tCy)) {
        player.cx = tCx; player.cy = tCy;
        player.targetX = desiredX;
        player.targetY = desiredY;
        return;
      }
    }

    // handle diagonal desires by preferring the larger axis if possible
    if (Math.abs(tCx - curCx) + Math.abs(tCy - curCy) === 2) {
      // try horizontal first if vx dominates
      if (Math.abs(vx) > Math.abs(vy)) {
        const nx = curCx + (vx > 0 ? 1 : -1), ny = curCy;
        if (isOpenBetween(curCx, curCy, nx, ny)) {
          player.cx = nx; player.cy = ny;
          player.targetX = desiredX;
          player.targetY = desiredY;
          return;
        }
      } else {
        const nx = curCx, ny = curCy + (vy > 0 ? 1 : -1);
        if (isOpenBetween(curCx, curCy, nx, ny)) {
          player.cx = nx; player.cy = ny;
          player.targetX = desiredX;
          player.targetY = desiredY;
          return;
        }
      }
    }

    // otherwise clamp the target to remain within current cell bounds to prevent crossing walls
    const minX = curCx * cellSize + 4;
    const maxX = (curCx + 1) * cellSize - 4;
    const minY = curCy * cellSize + 4;
    const maxY = (curCy + 1) * cellSize - 4;
    player.targetX = Math.min(Math.max(desiredX, minX), maxX);
    player.targetY = Math.min(Math.max(desiredY, minY), maxY);
  }

  function updateModule(dt, hands){
    if (!runningModule) return;
    const now = performance.now();
    // draw maze and HUD each frame
    drawMaze();

    // fingertip drives movement: use input only when exactly one hand is present (ignore multi-hand interference)
    const tip = (hands && hands.length === 1 && hands[0] && hands[0][8]) ? hands[0][8] : null;
    if (tip) tryMoveTowardTip(tip);

    // smoothly move player toward target center
    const distX = player.targetX - player.x;
    const distY = player.targetY - player.y;
    const dist = Math.hypot(distX, distY);
    if (dist > 0.5) {
      const maxStep = player.speed * dt;
      const t = Math.min(1, maxStep / dist);
      player.x += distX * t;
      player.y += distY * t;
    }

    // check exit reached (cell equality against any exit)
    if (exitCells && exitCells.some(e => e.cx === player.cx && e.cy === player.cy)) {
      // reached exit: reward and advance to the next maze level instead of ending the game
      spawnPopup && spawnPopup((canvas.width / DPR)/2, 80, 'Level Complete!', { col: 'lime', size: 24 });
      try { playSound && playSound('segment_complete'); } catch(e){}
      score += 100;
      updateUI();
      // briefly pause module while preparing next level
      runningModule = false;
      finished = false;
      setTimeout(()=> {
        try {
          // regenerate a new maze for the current canvas size
          generateMaze((canvas.width / DPR), (canvas.height / DPR));
          // reset player to center of new maze
          const startCX = Math.floor(cols/2), startCY = Math.floor(rows/2);
          if (player) {
            player.cx = startCX; player.cy = startCY;
            const c = cellCenter(startCX, startCY);
            player.x = player.targetX = c.x;
            player.y = player.targetY = c.y;
          }
          // resume module
          runningModule = true;
        } catch(e) { console.warn('advance maze failed', e); }
      }, 650);
    }
  }

  function drawMaze(){
    if (!ctx || !cells) return;
    const width = canvas.width / DPR, height = canvas.height / DPR;
    ctx.save();
    // semi-opaque panel behind maze for clarity (use computed maze origin so panel and maze align)
    const mazeW = cols * cellSize, mazeH = rows * cellSize;
    const ox = mazeOx || Math.floor((width - mazeW) / 2);
    const oy = mazeOy || Math.floor((height - mazeH) / 2);
    const pad = 12;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(ox - Math.floor(pad/2), oy - Math.floor(pad/2), Math.min(width - pad, mazeW + pad), Math.min(height - pad, mazeH + pad));
 
    // translate to maze origin (center it roughly) - ox/oy already set above

    // draw grid walls
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const cell = cells[idx(cx,cy)];
        const x0 = ox + cx * cellSize, y0 = oy + cy * cellSize;
        // top
        if (cell.walls[0]) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + cellSize, y0); ctx.stroke(); }
        // right
        if (cell.walls[1]) { ctx.beginPath(); ctx.moveTo(x0 + cellSize, y0); ctx.lineTo(x0 + cellSize, y0 + cellSize); ctx.stroke(); }
        // bottom
        if (cell.walls[2]) { ctx.beginPath(); ctx.moveTo(x0, y0 + cellSize); ctx.lineTo(x0 + cellSize, y0 + cellSize); ctx.stroke(); }
        // left
        if (cell.walls[3]) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + cellSize); ctx.stroke(); }
      }
    }

    // highlight exit cells
    if (exitCells && exitCells.length) {
      ctx.fillStyle = 'rgba(255,200,60,0.95)';
      for (const exCell of exitCells) {
        const ex = ox + exCell.cx * cellSize, ey = oy + exCell.cy * cellSize;
        ctx.fillRect(ex + 4, ey + 4, cellSize - 8, cellSize - 8);
      }
    }

    // draw player
    if (player) {
      const px = ox + (player.x), py = oy + (player.y);
      ctx.beginPath();
      ctx.fillStyle = 'cyan';
      ctx.arc(ox + player.x, oy + player.y, Math.max(8, cellSize * 0.18), 0, Math.PI*2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // small target ring
      ctx.beginPath();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,200,255,0.9)';
      ctx.arc(ox + player.targetX, oy + player.targetY, Math.max(6, cellSize * 0.12), 0, Math.PI*2);
      ctx.stroke();
    }

    // HUD label
    ctx.fillStyle = 'white';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Maze — move your index finger to navigate to the highlighted exit', width/2, oy - 8);
    ctx.restore();
  }

  function initModule(){
    // reset finished flag when starting a new maze run
    finished = false;
    const width = canvas.width / DPR, height = canvas.height / DPR;
    generateMaze(width, height);
    runningModule = true;
  }

  return {
    init(){ initModule(); },
    update(dt, hands){ updateModule(dt, hands); },
    onStart(){ initModule(); },
    onEnd(){ runningModule = false; }
  };
})();

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
  // reduced default timeout to avoid long blocking waits on missing files
  function tryLoadAudioUrl(url, timeoutMs = 1200) {
    return new Promise(res => {
      if (!url) return res(null);
      try {
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
        a.src = url;
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
      `assets/${currentGameId}/slice.wav`,
      `assets/${currentGameId}/slice.mp3`,
      `assets/${currentGameId}/slice-frute.mp3`,
      `assets/${currentGameId}/slice-fruit.mp3`,
      `assets/ninga-game-sounds/slice-frute.mp3`,
      `assets/slice.wav`,
      `assets/slice.mp3`
    ].filter(Boolean);

    const bombCandidates = [
      ASSETS.bomb,
      `assets/${currentGameId}/bomb.wav`,
      `assets/${currentGameId}/bomb.mp3`,
      `assets/${currentGameId}/bomb-frute.mp3`,
      `assets/ninga-game-sounds/boomb.mp3`,
      `assets/ninga-game-sounds/bomb.mp3`,
      `assets/bomb.wav`,
      `assets/bomb.mp3`
    ].filter(Boolean);

    const bgmCandidates = (() => {
      const c = [ASSETS.bgm, `assets/${currentGameId}/bgm.mp3`].filter(Boolean);
      if (currentGameId === 'ninja-fruit') c.push('assets/ninga-game-sounds/bgm.mp3');
      c.push('assets/bgm.mp3');
      return c.filter(Boolean);
    })();

    // helper to race candidate loaders in parallel and pick the first successful
    async function firstSuccessful(candidates, label) {
      if (!candidates || !candidates.length) {
        reportStatus(label, 'not found');
        return null;
      }
      const loaders = candidates.map(url => tryLoadAudioUrl(url, 1200).then(a => a ? { url, a } : Promise.reject(url)));
      try {
        // Promise.any returns first fulfilled; if none fulfilled it throws AggregateError
        if (typeof Promise.any === 'function') {
          const res = await Promise.any(loaders);
          reportStatus(label, `loaded ${res.a.src}`);
          return res.a;
        } else {
          // fall back to sequential scan if Promise.any isn't available
          for (const url of candidates) {
            reportStatus(label, `trying ${url}`);
            const a = await tryLoadAudioUrl(url, 1200);
            if (a) { reportStatus(label, `loaded ${a.src}`); return a; }
            reportStatus(label, `failed ${url}`);
          }
          reportStatus(label, 'not found');
          return null;
        }
      } catch (e) {
        reportStatus(label, 'not found');
        return null;
      }
    }

    // load slice/bomb/bgm in parallel but non-blocking for overall startup
    // prefer fast selection; do not serially block on many 3s timeouts
    firstSuccessful(sliceCandidates, 'slice').then(a => { if (a) soundPool.slice = a; else reportStatus('slice','not found'); });
    firstSuccessful(bombCandidates, 'bomb').then(a => { if (a) soundPool.bomb = a; else reportStatus('bomb','not found'); });

    // bgm needs special handling to stop previous bgmAudio if a new one is found
    firstSuccessful(bgmCandidates, 'bgm').then(a => {
      if (a) {
        try {
          a.loop = true;
          if (bgmAudio && bgmAudio !== a) { try { bgmAudio.pause(); bgmAudio.currentTime = 0; } catch(e){} }
        } catch(e){}
        bgmAudio = a;
        reportStatus('bgm', `loaded ${a.src}`);
        if (musicEnabled) {
          try { bgmAudio.muted = false; bgmAudio.volume = 1.0; } catch(e){}
          bgmAudio.play().catch(()=>{});
        }
      } else {
        reportStatus('bgm','not found');
      }
    });

  } catch (e) {
    console.warn('audio setup issue', e);
    reportStatus('audio', 'setup exception');
  }

  // Load any per-game short SFX entries provided via ASSETS.sfx (do these in parallel)
  if (ASSETS.sfx && typeof ASSETS.sfx === 'object') {
    const entries = Object.entries(ASSETS.sfx);
    await Promise.all(entries.map(async ([key, url]) => {
      if (!url) { reportStatus(`sfx:${key}`, 'no url'); return; }
      reportStatus(`sfx:${key}`, `trying ${url}`);
      try {
        const a = await tryLoadAudioUrl(url, 1200);
        if (a) {
          soundPool[key] = a;
          reportStatus(`sfx:${key}`, `loaded ${a.src}`);
        } else {
          reportStatus(`sfx:${key}`, `failed ${url}`);
        }
      } catch (e) {
        reportStatus(`sfx:${key}`, `exception ${url}`);
      }
    }));
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

    // sound cooldowns to avoid thrashing when many segments/points trigger at once
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const lastTimes = window.__handNinja._lastSoundTimes || (window.__handNinja._lastSoundTimes = {});
    const cooldownMap = {
      point: 80,
      segment_complete: 80,
      popup: 80,
      shape_complete: 300,
      // fallback default
      default: SOUND_COOLDOWN_MS || 80
    };
    const cd = cooldownMap[name] || cooldownMap.default;
    if (lastTimes[name] && now - lastTimes[name] < cd) return;
    lastTimes[name] = now;

    const a = soundPool[name];
    if (!a) return;
    // clone to allow overlapping playback in some browsers
    const inst = a.cloneNode ? a.cloneNode() : new Audio(a.src);
    try { inst.muted = false; inst.volume = 1.0; } catch(e){}
    inst.play().catch((err) => {
      // report in asset status if playback is blocked (preload helper defines reportStatus; guard)
      try { if (typeof reportStatus === 'function') reportStatus('audio', `play blocked ${name}`); } catch(e){}
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

// Render remote peers (ghosts) with light interpolation.
// Expects Net.getPeers() to provide Map(id -> { id, t, p, ... })
// p is expected to be an array of quantized points: [[qx,qy],[qx2,qy2]] where q in 0..1000
function drawPeers(dt) {
  try {
    const peersMap = Net.getPeers();
    const playersMeta = (typeof Net.getPlayers === 'function') ? Net.getPlayers() : [];
    const now = performance.now();
    const W = canvas.width / DPR, H = canvas.height / DPR;
    const deq = (v, dim) => (v / 1000) * dim;

    for (const [id, msg] of peersMap.entries()) {
      if (!msg || !id) continue;

      // handle explicit clear messages (server broadcasts clear_layer as clear flag)
      if (msg.clear) {
        const st = netPeersState.get(id);
        if (st) {
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = 'rgba(255,90,90,0.95)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(st.x - 12, st.y - 12);
          ctx.lineTo(st.x + 12, st.y + 12);
          ctx.moveTo(st.x + 12, st.y - 12);
          ctx.lineTo(st.x - 12, st.y + 12);
          ctx.stroke();
          ctx.restore();
        }
        continue;
      }

      let targetX = null, targetY = null;
      if (Array.isArray(msg.p) && Array.isArray(msg.p[0])) {
        // use first point (wrist) as anchor; fallback to tip if only one point
        const q0 = msg.p[0];
        targetX = deq(Number(q0[0] || 0), W);
        targetY = deq(Number(q0[1] || 0), H);
      } else {
        // unknown payload shape; skip
        continue;
      }

      const prev = netPeersState.get(id);
      if (!prev) {
        netPeersState.set(id, { x: targetX, y: targetY, lastT: now, alpha: 1.0 });
      } else {
        // smooth toward target
        const blend = Math.min(1, dt * 12);
        prev.x += (targetX - prev.x) * blend;
        prev.y += (targetY - prev.y) * blend;
        prev.lastT = now;
        prev.alpha = 1.0;
      }

      const state = netPeersState.get(id);
      if (!state) continue;

      // draw ghost circle + name label
      ctx.save();
      ctx.globalAlpha = 0.36;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(state.x, state.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.75;
      ctx.stroke();

      // draw small finger line if tip was provided
      if (Array.isArray(msg.p) && Array.isArray(msg.p[1])) {
        const qTip = msg.p[1];
        const tx = deq(Number(qTip[0] || 0), W);
        const ty = deq(Number(qTip[1] || 0), H);
        ctx.beginPath();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2;
        ctx.moveTo(state.x, state.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }

      // draw player name above ghost if known
      let name = null;
      if (Array.isArray(playersMeta) && playersMeta.length) {
        const meta = playersMeta.find(p => p && (p.id === id || p.socketId === id));
        if (meta && meta.name) name = meta.name;
      }
      if (!name) {
        // fallback short id
        try { name = `P-${String(id).slice(0,4)}`; } catch(e){ name = 'P'; }
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(name, state.x, state.y - 14);
      ctx.restore();
    }

    // garbage collect stale peer states
    for (const [id, st] of netPeersState.entries()) {
      if (now - (st.lastT || 0) > 2200) netPeersState.delete(id);
    }
  } catch (e) {
    // non-fatal, don't break rendering
    // console.warn('drawPeers error', e);
  }
}

 // Generate random shape outlines (returns { points: [{x,y}], type })
function generateRandomShape() {
  const w = canvas.width / DPR;
  const h = canvas.height / DPR;
  // expanded set of shape types; keep sampling density low for performance
  const types = ['circle', 'rect', 'triangle', 'ellipse', 'star', 'rounded-rect', 'heart', 'poly'];
  const type = types[randInt(0, types.length - 1)];
  const points = [];
  const margin = 40; // keep shapes away from edge

  if (type === 'circle') {
    const cx = rand(w * 0.25, w * 0.75);
    const cy = rand(h * 0.25, h * 0.75);
    const r = rand(Math.min(w, h) * 0.12, Math.min(w, h) * 0.26);
    const segments = 18;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  } else if (type === 'ellipse') {
    const cx = rand(w * 0.25, w * 0.75);
    const cy = rand(h * 0.25, h * 0.75);
    const rx = rand(Math.min(w, h) * 0.12, Math.min(w, h) * 0.28);
    const ry = rx * rand(0.6, 1.0);
    const segments = 20;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      points.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    }
  } else if (type === 'rect' || type === 'rounded-rect') {
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
 // for rounded-rect, create small arc-like joins; otherwise straight interpolation
 // increase samples per edge to better preserve sharp corners (reduce missing top-right corners)
 const segPerEdge = 6;
 for (let e = 0; e < corners.length - 1; e++) {
      const a = corners[e], b = corners[e + 1];
      for (let i = 0; i <= segPerEdge; i++) {
        const t = i / segPerEdge;
        let x = a.x + (b.x - a.x) * t;
        let y = a.y + (b.y - a.y) * t;
        // nudge points slightly for rounded appearance if requested
        if (type === 'rounded-rect' && (i === 0 || i === segPerEdge)) {
          // move corner points inward a bit to simulate a rounded corner
          const nx = a.x + (b.x - a.x) * (i === 0 ? 0.12 : 0.88);
          const ny = a.y + (b.y - a.y) * (i === 0 ? 0.12 : 0.88);
          x = nx; y = ny;
        }
        points.push({ x, y });
      }
    }
  } else if (type === 'triangle') {
    const cx = rand(w * 0.3, w * 0.7);
    const cy = rand(h * 0.3, h * 0.7);
    const r = rand(Math.min(w, h) * 0.14, Math.min(w, h) * 0.32);
    const segments = 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    // interpolate edges a bit to increase segment count modestly
    const interp = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      interp.push(a);
      interp.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    interp.push(points[points.length - 1]);
    points.length = 0;
    points.push(...interp);
  } else if (type === 'star') {
    const cx = rand(w * 0.3, w * 0.7);
    const cy = rand(h * 0.3, h * 0.7);
    const R = rand(Math.min(w, h) * 0.12, Math.min(w, h) * 0.26);
    const r = R * rand(0.44, 0.6);
    const spikes = randInt(5, 7);
    const segs = spikes * 2;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const rr = (i % 2 === 0) ? R : r;
      points.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  } else if (type === 'heart') {
    // parametric heart shape scaled and translated to fit canvas
    const cx = rand(w * 0.35, w * 0.65);
    const cy = rand(h * 0.35, h * 0.65);
    const scale = rand(Math.min(w, h) * 0.08, Math.min(w, h) * 0.18);
    const segs = 28;
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      points.push({ x: cx + x * scale * 0.6, y: cy - y * scale * 0.6 });
    }
  } else {
    // fallback polygon (random n-gon) with modest sampling
    const cx = rand(w * 0.3, w * 0.7);
    const cy = rand(h * 0.3, h * 0.7);
    const r = rand(Math.min(w, h) * 0.12, Math.min(w, h) * 0.28);
    const sides = randInt(4, 8);
    const steps = Math.max(6, sides * 2);
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr = r * (1 + Math.sin(a * 3 + rand(-0.2, 0.2)) * 0.12);
      points.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  }

  // safety: clamp/fit shape to canvas bounds to avoid off-screen or oversized shapes
  if (points.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    // scale down if shape too large for canvas area
    const availW = Math.max(32, w - margin * 2);
    const availH = Math.max(32, h - margin * 2);
    const scale = Math.min(1, availW / bboxW, availH / bboxH);
    if (scale < 0.999) {
      // scale about center
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      for (const p of points) {
        p.x = cx + (p.x - cx) * scale;
        p.y = cy + (p.y - cy) * scale;
      }
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    // translate if any point falls outside margin area
    let dx = 0, dy = 0;
    if (minX < margin) dx = margin - minX;
    if (maxX > w - margin) dx = (w - margin) - maxX;
    if (minY < margin) dy = margin - minY;
    if (maxY > h - margin) dy = (h - margin) - maxY;
    if (dx !== 0 || dy !== 0) {
      for (const p of points) {
        p.x += dx;
        p.y += dy;
      }
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
function spawnParticles(x,y,color,count=8, opts) {
  // particle freeze window: suppress new bursts for a short window after heavy trace events
  const _nowParticle = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (window.__handNinja && window.__handNinja._lastParticleFreeze && _nowParticle - window.__handNinja._lastParticleFreeze < 220) return;
  // suppress heavy particles entirely during shape-trace to avoid hitches
  if (currentGameId === 'shape-trace') return;

  // allow callers to request a reduced burst (e.g. { source: 'shape-trace' })
  const isShapeTrace = !!(opts && opts.source === 'shape-trace');
  if (isShapeTrace) {
    // be very conservative during shape-trace to avoid frame hiccups
    count = Math.min(count, 1);
  }

  // soft global cap for responsiveness; if too many particles exist, skip new bursts
  const SOFT_PARTICLE_CAP = 120;
  if (particles.length >= SOFT_PARTICLE_CAP) return;

  // enforce global cap to avoid unbounded growth and heavy per-frame cost
  if (particles.length >= MAX_PARTICLES) {
    // try to trim oldest particles to make room, otherwise skip spawning
    const toTrim = Math.min( Math.max(0, particles.length - (MAX_PARTICLES - count)), particles.length );
    if (toTrim > 0) particles.splice(0, toTrim);
    if (particles.length >= MAX_PARTICLES) return;
  }

  for (let i=0;i<count;i++){
    // smaller, shorter-lived, and lower-velocity particles for shape-trace (if any)
    const p = {
      x, y,
      vx: isShapeTrace ? rand(-80,80) : rand(-320,320),
      vy: isShapeTrace ? rand(-160, -40) : rand(-320, -80),
      life: isShapeTrace ? rand(0.12, 0.28) : rand(0.35, 0.9),
      col: color,
      r: isShapeTrace ? rand(1,3) : rand(2,5)
    };
    particles.push(p);
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
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // enforce a short global cooldown to avoid thousands of popups in a single frame
  if (now - (window.__handNinja._lastPopupTime || 0) < POPUP_COOLDOWN_MS) return;
  window.__handNinja._lastPopupTime = now;

  // cap total concurrent popups
  if (popups.length >= MAX_POPUPS) {
    // optionally discard oldest to make room for higher-priority popup (here we discard oldest)
    popups.shift();
  }

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
  if (topEl) topEl.innerHTML = '';

  if (!top || top.length === 0) {
    if (topEl) {
      const li = document.createElement('li');
      li.className = 'leader-row';
      const r = document.createElement('span'); r.className = 'rank'; r.textContent = '-';
      const n = document.createElement('span'); n.className = 'name'; n.textContent = 'No leaders yet';
      const s = document.createElement('span'); s.className = 'leader-score'; s.textContent = '-';
      li.appendChild(r); li.appendChild(n); li.appendChild(s);
      topEl.appendChild(li);
    }
    console.info(`showLeaders -> key=${storageKey(selForList)} empty`);
    return;
  }

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    if (!entry) continue;
    const li = document.createElement('li');
    li.className = 'leader-row';
    const r = document.createElement('span'); r.className = 'rank'; r.textContent = `${i+1}.`;
    const n = document.createElement('span'); n.className = 'name'; n.textContent = entry.name || 'Player';
    const s = document.createElement('span'); s.className = 'leader-score'; s.textContent = String(entry.score || 0);
    li.appendChild(r); li.appendChild(n); li.appendChild(s);
    topEl.appendChild(li);
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

  // send compact network update (throttled)
  try {
    const nowNet = performance.now();
    if (Net && typeof Net.sendPlayerUpdate === 'function' && nowNet - (window.__handNinja._lastNetSendT || 0) >= NET_THROTTLE_MS) {
      window.__handNinja._lastNetSendT = nowNet;
      const W = canvas.width / DPR, H = canvas.height / DPR;
      const q = (v, dim) => Math.max(0, Math.min(1000, Math.round((v / dim) * 1000)));
      if (mappedHands && mappedHands[0] && mappedHands[0][8]) {
        const h0 = mappedHands[0];
        const wrist = h0[0];
        const tip = h0[8];
        const payload = { t: Date.now(), p: [ [q(wrist.x, W), q(wrist.y, H)], [q(tip.x, W), q(tip.y, H)] ] };
        Net.sendPlayerUpdate(payload);
      } else {
        // no hand visible — still send a light presence heartbeat
        Net.sendPlayerUpdate({ t: Date.now() });
      }
    }
  } catch(e) { /* non-fatal */ }

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
  // inline plugin modes: runnerControlModule and simonProModule (consolidated)
  if (currentGameId === 'runner-control') {
    try {
      runnerControlModule.update(dt, mappedHands);
    } catch (e) { console.warn('runner-control update failed', e); }
  } else if (currentGameId === 'maze-mini') {
    try {
      mazeModule.update(dt, mappedHands);
    } catch (e) { console.warn('maze update failed', e); }
  } else if (currentGameId === 'paint-air') {
    try {
      const nowT = performance.now();
      const handCount = mappedHands.length;

      // two-hand auto-stop logic
      if (handCount >= 2 && running && drawingEnabled) {
        // stop drawing temporarily and mark separation
        autoStoppedByTwoHands = true;
        drawingEnabled = false;
        // add separator so next stroke doesn't connect
        paintPaths.push(null);
        noticeEl.textContent = 'Two hands detected — drawing paused';
      } else if (handCount < 2 && autoStoppedByTwoHands) {
        // resume drawing, but start a fresh stroke (separator already pushed)
        autoStoppedByTwoHands = false;
        drawingEnabled = true;
        noticeEl.textContent = 'Drawing resumed';
        // ensure separation (in case separator wasn't pushed earlier)
        if (paintPaths.length === 0 || paintPaths[paintPaths.length - 1] !== null) paintPaths.push(null);
      }

      // current fingertip if available
      const tip = (mappedHands[0] && mappedHands[0][8]) ? mappedHands[0][8] : null;

      // handle eraser mode using spatial buckets and lazy deletion (faster, less GC churn)
      if (eraserMode && tip && running) {
        const eraseRadius = Math.max(8, (paintSize || 12) * 1.4);
        // throttle eraser processing to ~25 Hz to avoid heavy per-frame work
        if (!window.__handNinja._lastEraserProcess || nowT - window.__handNinja._lastEraserProcess > 40) {
          const keys = getBucketKeysForCircle(tip.x, tip.y, eraseRadius);
          let removed = 0;
          for (const k of keys) {
            const bucket = paintBuckets.get(k);
            if (!bucket || !bucket.length) continue;
            for (const pt of bucket) {
              if (!pt || pt._deleted) continue;
              const d = Math.hypot(pt.x - tip.x, pt.y - tip.y);
              if (d <= eraseRadius) {
                pt._deleted = true;
                removed++;
                deletedCount++;
              }
            }
          }
          if (removed && (!window.__handNinja._lastEraserSound || nowT - window.__handNinja._lastEraserSound > 120)) {
            try { playSound('pop_small'); } catch(e){}
            window.__handNinja._lastEraserSound = nowT;
          }
          window.__handNinja._lastEraserProcess = nowT;

          // occasionally compact storage to reclaim memory and shrink render cost
          if (deletedCount > 800 && paintPaths.length > 2000) {
            compactPaintStorage();
          }
        }
      }

      // Record new point when drawingEnabled and not erasing
      if (tip && running && drawingEnabled && !eraserMode) {
        // Throttle sampling: only record if moved sufficiently or enough time passed
        // Find last non-null, non-deleted point
        let lastNonNull = null;
        for (let i = paintPaths.length - 1; i >= 0; i--) {
          const q = paintPaths[i];
          if (q === null) { lastNonNull = null; break; }
          if (q && !q._deleted) { lastNonNull = q; break; }
        }
        const dx = lastNonNull ? Math.hypot(tip.x - lastNonNull.x, tip.y - lastNonNull.y) : Infinity;
        const dtPush = nowT - (lastPaintPushT || 0);
        const minDist = Math.max(1, (paintSize || 12) * 0.25);
        if (dx > minDist || dtPush > 35) {
          const pt = { x: tip.x, y: tip.y, t: nowT, color: paintColor || '#00b4ff', size: paintSize || 12, _deleted: false };
          paintPaths.push(pt);
          addPointToBucket(pt);
          lastPaintPushT = nowT;
          // bounded growth: compact a bit if extremely large
          if (paintPaths.length > 12000 && deletedCount > 2000) compactPaintStorage();

          // if painting on-track compute length using last non-deleted point
          if (lastNonNull) {
            const addedLen = Math.hypot(pt.x - lastNonNull.x, pt.y - lastNonNull.y);
            let onTrack = false;
            const threshold = 30;
            if (paintTrack.length) {
              for (let i = 0; i < paintTrack.length - 1; i++) {
                const a = paintTrack[i], b = paintTrack[i+1];
                const d = segmentCircleDist(a.x,a.y,b.x,b.y, pt.x, pt.y);
                if (d <= threshold) { onTrack = true; break; }
              }
            }
            if (onTrack && addedLen > 0.6) paintOnTrackLen += addedLen;
          }
        }
      }

      // Rendering: iterate paintPaths, respect separators (null) and per-point color/size.
      // Skip points that fall inside any erase mask.
      // Draw strokes by honoring separators and point-level styles (skip deleted points)
      if (paintPaths.length) {
        let started = false;
        let lastColor = null, lastSize = null;
        for (let i = 0; i < paintPaths.length; i++) {
          const p = paintPaths[i];
          if (p === null) {
            // separator: end any current stroke
            started = false;
            continue;
          }
          if (p && p._deleted) continue; // skip erased points
          // if we need to begin a new sub-path or style changed
          const color = p.color || paintColor;
          const size = p.size || paintSize;
          if (!started || color !== lastColor || size !== lastSize) {
            ctx.beginPath();
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.strokeStyle = color;
            ctx.lineWidth = size;
            // find previous non-deleted point in this subpath to moveTo
            let moved = false;
            for (let j = i - 1; j >= 0; j--) {
              const q = paintPaths[j];
              if (q === null) break;
              if (q && !q._deleted) { ctx.moveTo(q.x, q.y); moved = true; break; }
            }
            if (!moved) ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            started = true;
            lastColor = color;
            lastSize = size;
          } else {
            // continue same stroke style; draw segment
            ctx.beginPath();
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.strokeStyle = lastColor;
            ctx.lineWidth = lastSize;
            // find previous drawable non-deleted point
            let prevPoint = null;
            for (let j = i - 1; j >= 0; j--) {
              const q = paintPaths[j];
              if (q === null) break;
              if (q && !q._deleted) { prevPoint = q; break; }
            }
            if (prevPoint) {
              ctx.moveTo(prevPoint.x, prevPoint.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
            } else {
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
            }
          }
        }
      }

    } catch (e) {
      console.warn('paint-air onResults error', e);
    }
  } else if (currentGameId === 'shape-trace') {
    // Shape Trace: player must trace the current shape outline; when coverage >= threshold move to next shape
    try {
      if (!shapes.length) {
        const s = generateRandomShape();
        shapes.push(s);
        shapeCovered = new Array(Math.max(0, s.points.length - 1)).fill(false);
        // reset incremental covered counter
        window.__handNinja._shapeCoveredCount = 0;
        shapeIndex = 0;
        shapeProgress = 0;
      }
      if (running && mappedHands[0] && mappedHands[0][8]) {
        const pt = mappedHands[0][8];
        // check proximity to each segment and mark covered
        const s = shapes[shapeIndex];
        // Localized, throttled scan to avoid full per-frame work when user moves very fast.
        const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (!window.__handNinja._lastShapeScanIndex) window.__handNinja._lastShapeScanIndex = 0;
        if (!window.__handNinja._lastFullShapeScan) window.__handNinja._lastFullShapeScan = 0;
        const lastIdx = window.__handNinja._lastShapeScanIndex || 0;
        const SEG_COUNT = Math.max(0, s.points.length - 1);
        const newlyCovered = [];
        const MAX_SEGMENTS_PER_FRAME = 3;
        const SCAN_RADIUS = 6; // tuneable: how many segments either side to probe first

        // per-frame soft cap to avoid huge bursts of marking work when users move very fast
        let marksThisFrame = 0;
        const MARK_LIMIT_PER_FRAME = Math.max(4, MAX_SEGMENTS_PER_FRAME * 3);
        // neighbor fill threshold tuned lower to avoid cascading fills
        const extraNeighborThreshold = 44; // px

        // small helper to test & mark a single segment index
        function tryMark(i) {
          if (SEG_COUNT <= 0) return;
          if (marksThisFrame >= MARK_LIMIT_PER_FRAME) return;
          const idx = ((i % SEG_COUNT) + SEG_COUNT) % SEG_COUNT;
          if (shapeCovered[idx]) return;
          const a = s.points[idx], b = s.points[idx + 1];
          // distance to segment plus distances to segment endpoints (helps corners)
          const d = segmentCircleDist(a.x,a.y,b.x,b.y, pt.x, pt.y);
          const da = Math.hypot(pt.x - a.x, pt.y - a.y);
          const db = Math.hypot(pt.x - b.x, pt.y - b.y);
          // additional info to help mark small neighbors
          const segLen = Math.hypot(a.x - b.x, a.y - b.y);

          if (d <= shapeTolerance || da <= shapeTolerance || db <= shapeTolerance) {
            const prevAdj = shapeCovered[(idx - 1 + SEG_COUNT) % SEG_COUNT];
            const nextAdj = shapeCovered[(idx + 1) % SEG_COUNT];

            // mark this segment
            shapeCovered[idx] = true;
            marksThisFrame++;
            // maintain incremental covered count to avoid O(n) reductions each frame
            window.__handNinja._shapeCoveredCount = (window.__handNinja._shapeCoveredCount || 0) + 1;
            newlyCovered.push({ idx, adj: !!(prevAdj || nextAdj) });
            window.__handNinja._lastShapeScanIndex = idx;

            // mark immediate neighbors conservatively (only if within tolerance and under mark cap)
            if (marksThisFrame < MARK_LIMIT_PER_FRAME && da <= shapeTolerance) {
              const prevIdx = (idx - 1 + SEG_COUNT) % SEG_COUNT;
              if (!shapeCovered[prevIdx]) {
                shapeCovered[prevIdx] = true;
                marksThisFrame++;
                window.__handNinja._shapeCoveredCount = (window.__handNinja._shapeCoveredCount || 0) + 1;
                newlyCovered.push({ idx: prevIdx, adj: true });
              }
            }
            if (marksThisFrame < MARK_LIMIT_PER_FRAME && db <= shapeTolerance) {
              const nextIdx = (idx + 1) % SEG_COUNT;
              if (!shapeCovered[nextIdx]) {
                shapeCovered[nextIdx] = true;
                marksThisFrame++;
                window.__handNinja._shapeCoveredCount = (window.__handNinja._shapeCoveredCount || 0) + 1;
                newlyCovered.push({ idx: nextIdx, adj: true });
              }
            }

            // optionally fill one extra neighbor for very short segments (but respect mark cap)
            if (segLen <= extraNeighborThreshold && marksThisFrame < MARK_LIMIT_PER_FRAME) {
              const extraIdx = (da <= db) ? ((idx - 2 + SEG_COUNT) % SEG_COUNT) : ((idx + 2) % SEG_COUNT);
              if (!shapeCovered[extraIdx]) {
                shapeCovered[extraIdx] = true;
                marksThisFrame++;
                window.__handNinja._shapeCoveredCount = (window.__handNinja._shapeCoveredCount || 0) + 1;
                newlyCovered.push({ idx: extraIdx, adj: true });
              }
            }
          }
        }

        // 1) Scan neighborhood around last hit (cheap, O(radius))
        for (let off = 0; off <= SCAN_RADIUS && newlyCovered.length < MAX_SEGMENTS_PER_FRAME; off++) {
          tryMark(lastIdx + off);
          if (off > 0) tryMark(lastIdx - off);
        }

        // 2) If nothing found and full-scan cooldown elapsed, do a throttled full scan
        const FULL_SCAN_COOLDOWN = 200; // ms
        if (newlyCovered.length === 0 && nowT - (window.__handNinja._lastFullShapeScan || 0) > FULL_SCAN_COOLDOWN) {
          for (let i = 0; i < SEG_COUNT && newlyCovered.length < MAX_SEGMENTS_PER_FRAME; i++) {
            tryMark(i);
          }
          window.__handNinja._lastFullShapeScan = nowT;
        }

        // 3) If we found any, aggregate feedback (single popup, single sound) to reduce per-frame work.
        // Throttle visual/audio feedback to avoid spikes when many segments are marked in a short time.
        if (newlyCovered.length > 0) {
          const totalPoints = newlyCovered.length * 2;
          score += totalPoints;
          updateUI();
          const firstIdx = newlyCovered[0].idx;
          const a0 = s.points[firstIdx], b0 = s.points[firstIdx + 1];
          const px = (a0.x + b0.x) / 2;
          const py = (a0.y + b0.y) / 2;

          const FEEDBACK_THROTTLE_MS = 120;
          const lastFeedback = window.__handNinja._lastShapeFeedbackTime || 0;
          if (SEG_COUNT <= 80 && (Date.now() - lastFeedback) > FEEDBACK_THROTTLE_MS) {
            spawnPopup(px, py, `+${totalPoints}`, { col: 'cyan', size: 14 });
          }

          try {
            // audio: only play occasional aggregated sounds to avoid audio thrash and main-thread stalls
            if ((Date.now() - lastFeedback) > FEEDBACK_THROTTLE_MS) {
              const anyAdj = newlyCovered.some(n => n.adj);
              if (anyAdj || newlyCovered.length > 1) {
                playSound('segment_complete');
              } else {
                playSound('point');
              }
              window.__handNinja._lastShapeFeedbackTime = Date.now();
            }
          } catch (e) {}
        }

        // Gap-fill pass: only consider small nearby gaps adjacent to newlyMarked segments
        (function gapFillPass(){
          if (!shapeCovered || shapeCovered.length <= 2 || !newlyCovered || newlyCovered.length === 0) return;
          // compute approximate perimeter to derive adaptive threshold
          let perimeter = 0;
          for (let i = 0; i < s.points.length - 1; i++) {
            const a = s.points[i], b = s.points[i+1];
            perimeter += Math.hypot(a.x - b.x, a.y - b.y);
          }
          const gapLengthThreshold = Math.max(40, perimeter * 0.022); // 2.2% of perimeter or 40px minimum

          // collect candidate indices near newlyCovered hits (±1 and ±2)
          const candidates = new Set();
          const N = shapeCovered.length;
          for (const nc of newlyCovered) {
            const base = ((nc && typeof nc.idx === 'number') ? nc.idx : null);
            if (base === null) continue;
            candidates.add(((base - 2) % N + N) % N);
            candidates.add(((base - 1) % N + N) % N);
            candidates.add(base % N);
            candidates.add(((base + 1) % N + N) % N);
            candidates.add(((base + 2) % N + N) % N);
          }

          for (const i of candidates) {
            if (shapeCovered[i]) continue;
            const prev = shapeCovered[(i - 1 + N) % N];
            const next = shapeCovered[(i + 1) % N];
            // only fill isolated 1-gap holes (both neighbors covered)
            if (prev && next) {
              const a = s.points[i], b = s.points[i+1];
              const segLen = Math.hypot(a.x - b.x, a.y - b.y);
              if (segLen <= gapLengthThreshold) {
                shapeCovered[i] = true;
                window.__handNinja._shapeCoveredCount = (window.__handNinja._shapeCoveredCount || 0) + 1;
                if (SEG_COUNT <= 80) spawnPopup((a.x + b.x) / 2, (a.y + b.y) / 2, '+auto', { col: 'cyan', size: 12 });
              }
            }
          }
        })();

        // compute progress using incremental counter (faster than reduce)
        const covered = (window.__handNinja._shapeCoveredCount || 0);
        shapeProgress = shapeCovered.length ? covered / shapeCovered.length : 0;
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
          // reset incremental covered counter for the new shape
          window.__handNinja._shapeCoveredCount = 0;
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

  } else if (currentGameId === 'simon-gesture') {
    // Simon Gesture: memory/sequencing game using simple gestures (open, closed, pinch)
    try {
      if (!window.__handNinja._simon) {
        const gestureOptions = ['open','closed','pinch'];
        window.__handNinja._simon = {
          seq: [gestureOptions[randInt(0,gestureOptions.length-1)], gestureOptions[randInt(0,gestureOptions.length-1)], gestureOptions[randInt(0,gestureOptions.length-1)]],
          showing: true,
          cueIdx: -1,
          lastCueT: now,
          awaitingInput: false,
          userStep: 0,
          _lastInputT: 0
        };
        noticeEl.textContent = 'Simon — watch the sequence';
      }
      const sim = window.__handNinja._simon;
      const gestureOptions = ['open','closed','pinch'];
      // show cues every 700ms when showing
      if (sim.showing) {
        if (now - sim.lastCueT > 700) {
          sim.lastCueT = now;
          sim.cueIdx++;
          if (sim.cueIdx >= sim.seq.length) {
            sim.showing = false;
            sim.awaitingInput = true;
            sim.userStep = 0;
            sim.cueIdx = -1;
            noticeEl.textContent = 'Your turn';
            try { playSound('popup'); } catch(e){}
          } else {
            spawnPopup(canvas.width/(2*DPR), 60, sim.seq[sim.cueIdx], { col: 'yellow', size: 22 });
            try { playSound('point'); } catch(e){}
          }
        }
      } else if (sim.awaitingInput) {
        if (mappedHands[0]) {
          const gest = detectSimpleGesture(mappedHands[0]);
          if (gest && now - (sim._lastInputT || 0) > 350) {
            sim._lastInputT = now;
            if (gest === sim.seq[sim.userStep]) {
              sim.userStep++;
              spawnPopup(canvas.width/(2*DPR), 60, 'OK', { col: 'lime', size: 20 });
              try { playSound('segment_complete'); } catch(e){}
              if (sim.userStep >= sim.seq.length) {
                // success: extend sequence and show next round
                sim.seq.push(gestureOptions[randInt(0, gestureOptions.length - 1)]);
                sim.showing = true;
                sim.awaitingInput = false;
                sim.cueIdx = -1;
                sim.lastCueT = now + 300;
                score += 30;
                updateUI();
                noticeEl.textContent = 'Good! Watch next';
              }
            } else {
              // wrong input: shorten sequence slightly and retry
              spawnPopup(canvas.width/(2*DPR), 60, 'Wrong', { col: 'red', size: 20 });
              try { playSound('wrong'); } catch(e){}
              sim.seq = sim.seq.slice(0, Math.max(3, sim.seq.length - 1));
              sim.showing = true;
              sim.awaitingInput = false;
              sim.cueIdx = -1;
              sim.lastCueT = now + 600;
              noticeEl.textContent = 'Try again';
            }
          }
        }
      }
    } catch(e){ console.warn('simon-gesture error', e); }

  } else if (currentGameId === 'follow-dot') {
    // Follow-the-dot: moving target; keep fingertip close to score points
    try {
      if (!window.__handNinja._follow) {
        const w = canvas.width / DPR, h = canvas.height / DPR;
        window.__handNinja._follow = { x: rand(80,w-80), y: rand(80,h-80), vx: rand(-160,160), vy: rand(-120,120), lastMove: now, scoreAccum: 0 };
      }
      const f = window.__handNinja._follow;
      const dtF = Math.max(0, (now - (f.lastMove || now)) / 1000);
      f.lastMove = now;
      f.x += f.vx * dtF; f.y += f.vy * dtF;
      if (f.x < 40 || f.x > canvas.width / DPR - 40) f.vx *= -1;
      if (f.y < 40 || f.y > canvas.height / DPR - 40) f.vy *= -1;
      // draw moving target
      ctx.beginPath();
      ctx.fillStyle = 'orange';
      ctx.arc(f.x, f.y, 12, 0, Math.PI * 2);
      ctx.fill();
      // fingertip proximity check
      const tip = (mappedHands[0] && mappedHands[0][8]) ? mappedHands[0][8] : null;
      if (tip && running) {
        const d = Math.hypot(tip.x - f.x, tip.y - f.y);
        if (d < 36) {
          f.scoreAccum += dtF;
          if (f.scoreAccum >= 0.7) {
            score += 5;
            spawnPopup(f.x, f.y, '+5', { col: 'orange', size: 16 });
            updateUI();
            f.scoreAccum = 0;
          }
        } else {
          f.scoreAccum = Math.max(0, f.scoreAccum - dtF * 2);
        }
      }
    } catch(e){ console.warn('follow-dot error', e); }
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

  // draw peers (ghosts) from network
  try { drawPeers(dt); } catch(e) {}
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
    } else if (currentGameId === 'runner-control') {
      // runner-control: simple SFX set for jumps, hits and points
      ASSETS.bgm = 'assets/Runner-Control/bgm_runner_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = {
        point: 'assets/Runner-Control/sfx_point.mp3',
        bomb: 'assets/Runner-Control/sfx_hit.mp3',
        popup: 'assets/Runner-Control/sfx_popup.mp3',
        jump: 'assets/Runner-Control/sfx_jump.mp3'
      };
    } else if (currentGameId === 'maze-mini') {
      // maze-mini: audio cues for tokens and feedback
      ASSETS.bgm = 'assets/Maze/bgm_maze_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = {
        point: 'assets/Maze/sfx_point.mp3',
        segment_complete: 'assets/Maze/sfx_segment_complete.mp3',
        wrong: 'assets/Maze/sfx_wrong.mp3',
        popup: 'assets/Maze/sfx_popup.mp3'
      };
    } else {
      ASSETS.bgm = `assets/${currentGameId}/bgm.mp3`;
      ASSETS.slice = `assets/${currentGameId}/slice.wav`;
      ASSETS.bomb = `assets/${currentGameId}/bomb.wav`;
      ASSETS.sfx = {};
    }
    // clear any previously loaded fruit images so preload can reload for new game
    ASSETS._fruitImages = [];
    // start preloading assets but do not block camera startup
    preloadAssets().catch(()=>{});
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
      // reset incremental covered counter
      window.__handNinja._shapeCoveredCount = 0;
      noticeEl.textContent = 'Shape Trace — trace the shape outline to fill it';
    } else if (currentGameId === 'runner-control') {
      // initialize runner control inline module
      try { runnerControlModule.onStart && runnerControlModule.onStart(); } catch(e){ console.warn('runner start failed', e); }
      noticeEl.textContent = 'Runner Control — stay alive!';
    } else if (currentGameId === 'maze-mini') {
      // initialize mini maze only
      try { mazeModule.onStart && mazeModule.onStart(); } catch(e){ console.warn('maze start failed', e); }
      noticeEl.textContent = 'Maze (Mini) — reach any highlighted exit';
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
      // reset incremental covered counter
      window.__handNinja._shapeCoveredCount = 0;
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
