 // task_progress: COMPLETED - multiplayer complex synchronization system implemented
 // - [x] Analyze requirements
 // - [x] Set up necessary files (index.html exists)
 // - [x] Implement MediaPipe Hands + camera integration
 // - [x] Implement fruit spawn, physics, and slicing detection
 // - [x] Implement menu, score, timer and leaderboard persistence
 // - [x] Add bombs that deduct points and make fruits/bombs slower & fewer
 // - [x] Add stronger hands.send guards, logging and recreate/backoff
 // - [x] Wire audio assets (in code; assets files to be placed in assets/)
 // - [x] Fix maze level progression synchronization for all users
 // - [x] Verify music gating behavior for admin and non-admin
 // - [x] Add multiplayer server-authoritative game state management
 // - [x] Implement peer object state synchronization
 // - [x] Add particle polish, sprite support and floating score popups
 // - [ ] Extensive playtesting and tuning (awaiting user feedback)
 // task_progress: leaders: dedupe same names (keep highest) + show placeholder implemented
 // task_progress_update:
 // - [x] Wire Paint toolbar controls and no-timer paint flow
 //
// js/game.js — core game logic (modified to wire assets, popups, and robustness)
// Loads via <script type="module" src="js/game.js"></script>

const DPR = Math.max(1, window.devicePixelRatio || 1);

// user interaction guard for audio autoplay / playback
if (!window.__handNinja) window.__handNinja = {};
// defensive stub: ensure updateAudioIntensity exists early to avoid ReferenceError
if (!window.updateAudioIntensity) window.updateAudioIntensity = function() { /* no-op until full audio system initializes */ };
if (typeof document !== 'undefined') {
  window.__handNinja._userInteracted = window.__handNinja._userInteracted || false;
  // Basic gesture-guard (keeps original behaviour)
  document.addEventListener('pointerdown', () => { window.__handNinja._userInteracted = true; }, { once: true, passive: true });
  document.addEventListener('keydown', () => { window.__handNinja._userInteracted = true; }, { once: true, passive: true });

  // Stronger unlock: resume AudioContext and init SimpleAudio on first user interaction.
  // This helps hosted environments (Cloudflare Pages, CDNs) where autoplay is blocked.
  const __unlockAudio = function() {
    try {
      window.__handNinja._userInteracted = true;
    } catch(e){}
    try {
      // prefer resuming existing ctx, or create/resume via ensureAudioCtx()
      try {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(()=>{});
        } else {
          const c = ensureAudioCtx();
          if (c && c.state === 'suspended') c.resume().catch(()=>{});
        }
      } catch(e) {}
      try {
        if (window.__handNinja._simpleAudio && typeof window.__handNinja._simpleAudio.initOnFirstInteraction === 'function') {
          window.__handNinja._simpleAudio.initOnFirstInteraction();
        }
      } catch(e){}
    } catch(e){}
    window.removeEventListener('pointerdown', __unlockAudio);
    window.removeEventListener('touchstart', __unlockAudio);
  };
  window.addEventListener('pointerdown', __unlockAudio, { once: true, passive: true });
  window.addEventListener('touchstart', __unlockAudio, { once: true, passive: true });
}

// UI elements
const videoEl = document.getElementById('input_video');
const canvas = document.getElementById('output_canvas');
const ctx = canvas.getContext('2d');
const menuEl = document.getElementById('menu');
const playerNameEl = document.getElementById('playerName');
let prevLocalName = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? String(playerNameEl.value || playerNameEl.placeholder) : 'Player';
const gameLengthEl = document.getElementById('gameLength');
const menuStartBtn = document.getElementById('menuStartBtn');
const showLeadersBtn = document.getElementById('showLeadersBtn');
const scoreEl = document.getElementById('score');
const timerEl = document.getElementById('timer');
const noticeEl = document.getElementById('notice');

// Small "Waiting for players" overlay used during authoritative room start handshake
function showWaitingForPlayersOverlay(show, text) {
  try {
    if (typeof document === 'undefined') return;
    let el = document.getElementById('waitingOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'waitingOverlay';
      Object.assign(el.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        top: '0',
        bottom: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent', // keep video visible behind overlay
        color: '#fff',
        zIndex: 99990,
        fontSize: '18px',
        pointerEvents: 'none' // allow interacting with underlying UI while status is shown
      });
      const inner = document.createElement('div');
      inner.id = 'waitingOverlayInner';
      Object.assign(inner.style, {
        padding: '18px 22px',
        borderRadius: '10px',
        background: 'rgba(0,0,0,0.62)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.6)',
        textAlign: 'center',
        maxWidth: '80%',
        pointerEvents: 'none' // non-blocking UI: allow clicks to pass through while still showing status
      });
      inner.textContent = text || 'Waiting for other players to be ready…';
      el.appendChild(inner);
      document.body.appendChild(el);
    }
    const inner = el.querySelector('#waitingOverlayInner');
    if (inner && text) inner.textContent = text;
    el.style.display = show ? 'flex' : 'none';
    
    // Ensure canvas is visible even when overlay is shown
    try {
      const canvas = document.getElementById('output_canvas');
      if (canvas) {
        canvas.style.visibility = 'visible';
      }
    } catch(e) {}
  } catch (e) { /* ignore overlay failures */ }
}

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
let roomHighScore = null; // server-provided room high-score (name, score)

// Networking / peer ghost state
const NET_QUANT_MAX = 1000;
const peerGhosts = Object.create(null); // id -> { target: [{x,y,z}], display: [{x,y,z}], lastTs }
const peerPaints = Object.create(null); // id -> [ {x,y,t,color,size} ]

// Keep latest room high-scores per game so we can show the correct "room best"
// for the currently selected game. This enables dynamic per-game room best display.
const roomHighScoresByGame = Object.create(null);
const roomHighScoreResetTimestamps = Object.create(null);
const roomHighScoreEditedTimestamps = Object.create(null);

 // Return array of peer names (normalized) currently known from peerGhosts
function getPeerNames() {
  const names = [];
  try {
    for (const k of Object.keys(peerGhosts || {})) {
      try {
        // Prefer the locally-disambiguated display name when available.
        const st = peerGhosts[k];
        const n = st && (st._displayName || st.name) ? String(st._displayName || st.name).trim() : null;
        if (n) names.push(n);
      } catch(e){}
    }
  } catch(e){}
  return names;
}

 // Return peer names but exclude the local client (when NET.socket.id is available).
// This helps ensure uniqueness checks don't accidentally treat our own echoed name as a duplicate.
function getPeerNamesExcludingSelf() {
  const names = [];
  try {
    const selfId = (typeof NET !== 'undefined' && NET && NET.socket && NET.socket.id) ? NET.socket.id : null;
    for (const id of Object.keys(peerGhosts || {})) {
      try {
        if (selfId && id === selfId) continue;
        const st = peerGhosts[id];
        const n = st && (st._displayName || st.name) ? String(st._displayName || st.name).trim() : null;
        if (n) names.push(n);
      } catch(e){}
    }
  } catch(e){}
  return names;
}

// Normalize peer display names to avoid exact duplicates in the local UI.
// This only affects local display (peerGhosts[*]._displayName) and does not change remote clients.
// Strategy:
//  - Build a case-insensitive map of names -> [ids]
//  - For any name with count > 1, append " (2)", " (3)"... to all but the first entry.
//  - Prefer the most-recently-updated peer as the canonical first entry (based on lastTs).
function dedupePeerDisplayNames() {
  try {
    const map = Object.create(null);
    for (const [id, st] of Object.entries(peerGhosts || {})) {
      try {
        const raw = st && st.name ? String(st.name).trim() : 'Player';
        const key = (raw || 'Player').toLowerCase();
        (map[key] = map[key] || []).push({ id, raw, ts: (st && st.lastTs) ? Number(st.lastTs) : 0 });
      } catch (e) { /* ignore per-peer errors */ }
    }

    for (const key of Object.keys(map)) {
      const arr = map[key];
      if (!arr || arr.length <= 1) {
        // ensure displayName is canonical when unique
        if (arr && arr[0]) {
          try { const st = peerGhosts[arr[0].id]; if (st) st._displayName = st.name; } catch(e){}
        }
        continue;
      }
      // sort by lastTs descending so the freshest remains unmodified
      arr.sort((a,b) => (b.ts || 0) - (a.ts || 0));
      for (let i = 0; i < arr.length; i++) {
        const ent = arr[i];
        try {
          const st = peerGhosts[ent.id];
          if (!st) continue;
          if (i === 0) {
            // canonical first entry keeps original name
            st._displayName = st.name;
          } else {
            // append a numeric suffix for local-disambiguation
            const suffix = ` (${i+1})`;
            st._displayName = `${st.name || 'Player'}${suffix}`;
          }
        } catch (e) { /* ignore per-peer set errors */ }
      }
    }
  } catch (e) {
    console.warn('dedupePeerDisplayNames failed', e);
  }
}

try { window.dedupePeerDisplayNames = dedupePeerDisplayNames; } catch(e){}

// Ensure the local player's name is unique within the current peer set.
// If duplicate found, append a numeric suffix "(2)", "(3)" etc until unique.
// Also update the placeholder suggestion so users see the unique variant.
function ensureLocalNameUnique() {
  try {
    if (!playerNameEl) return;
    const raw = (playerNameEl.value || '').trim() || '';
    // Use the visible placeholder as the base if the input is empty, otherwise use the typed name.
    const base = raw || (playerNameEl.placeholder ? String(playerNameEl.placeholder).trim() : 'Player') || 'Player';
    const peers = getPeerNamesExcludingSelf().map(n => (n || '').toLowerCase());

    // generate candidate names (base, base (2), base (3), ...)
    let candidate = base;
    let i = 1;
    while (peers.indexOf((candidate || '').toLowerCase()) !== -1) {
      i++;
      candidate = `${base} (${i})`;
      // safety cap to avoid infinite loops
      if (i > 99) break;
    }

    // If user hasn't typed an explicit value (empty), set placeholder to the unique suggestion.
    if (!raw) {
      try { playerNameEl.placeholder = candidate; } catch (e) {}
      return;
    }

    // If user typed a name that collides with an existing peer name, adjust both the visible value
    // and the placeholder so the user sees the resolved unique variant immediately.
    if (peers.indexOf(raw.toLowerCase()) !== -1) {
      try { playerNameEl.value = candidate; } catch(e){}
      try { playerNameEl.placeholder = candidate; } catch(e){}
      return;
    }

    // If user-provided name is already unique, still update placeholder to a safe suggestion
    // (this helps when peers join later and the placeholder should reflect a unique fallback).
    try { playerNameEl.placeholder = (playerNameEl.placeholder && playerNameEl.placeholder.trim()) || candidate; } catch(e){}

  } catch (e) { /* ignore uniqueness errors */ }
}

try { window.ensureLocalNameUnique = ensureLocalNameUnique; } catch(e){}

// Update the visible room high score element to reflect the best for currentGameId.
// If none available for the selected game, hide/clear the element.
// This augmented implementation will:
//  - prefer authoritative roomHighScoresByGame[gid] when present
//  - otherwise compute the best score dynamically from peerGhosts (and local score)
//  - present a disambiguated display name by consulting peerGhosts[*]._displayName when possible
function updateRoomHighScoreDisplay() {
  try {
    const roomHighScoreEl = document.getElementById('roomHighScore');
    const gid = currentGameId || 'default';
    // Only show room high-score UI when the client is inside a multiplayer room.
    // Hide it for single-player/local runs to avoid confusing the user.
    try {
      const roomsStateLocal = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
      if (!roomsStateLocal || !roomsStateLocal.room) {
        // ensure the DOM element is hidden for single-player flows
        if (roomHighScoreEl) {
          roomHighScoreEl.textContent = '';
          roomHighScoreEl.removeAttribute('data-visible');
          roomHighScoreEl.style.display = 'none';
        }
        // also clear runtime cached roomHighScore so other UI paths don't think a room best exists
        roomHighScore = null;
        return;
      }
    } catch (e) {}

    // Prefer server-provided cached high for this game
    let rh = roomHighScoresByGame[gid] || null;

    // If this client recently performed a local "reset" of the room high-score, prefer the local
    // zeroed entry when the local reset timestamp is newer than any server-provided timestamp.
    // This prevents server-delivered highs from immediately overriding a user's intentional reset.
    try {
      const localResetTs = (roomHighScoreResetTimestamps && roomHighScoreResetTimestamps[gid]) ? Number(roomHighScoreResetTimestamps[gid]) : 0;
      const serverTs = rh ? (Number(rh._serverTs) || Number(rh.ts) || Number(rh.t) || Number(rh.updatedAt) || Number(rh.updated) || 0) : 0;
      const localEditTs = (roomHighScoreEditedTimestamps && roomHighScoreEditedTimestamps[gid]) ? Number(roomHighScoreEditedTimestamps[gid]) : 0;

      // Prefer a recent local name edit over an older server-supplied record.
      // This ensures local name changes immediately reflect in the UI even if the server still
      // holds an older name for the same score.
      if (localEditTs && localEditTs > serverTs) {
        try {
          const localName = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder) : '';
          if (rh) {
            rh = Object.assign({}, rh, { name: localName });
            roomHighScoresByGame[gid] = rh;
          } else if (localName) {
            // Create a benign local entry to surface the updated name in the UI
            const clientId = (function() { try { return localStorage.getItem('hand_ninja_client_id'); } catch(e) { return null; } })();
            roomHighScoresByGame[gid] = { name: String(localName), score: 0, game: gid, clientId: clientId || null };
            rh = roomHighScoresByGame[gid];
          }
        } catch(e){}
      } else if (localResetTs && localResetTs > serverTs) {
        // prefer the locally-zeroed entry if present; otherwise clear rh to allow computed/live peers to win
        const localEntry = roomHighScoresByGame[gid];
        if (localEntry && typeof localEntry.score === 'number') {
          rh = localEntry;
        } else {
          rh = null;
        }
      }
    } catch (e) { /* ignore timestamp heuristics failures */ }

    // Compute dynamic best among peerGhosts and local score; prefer live peer/local data when available.
    try {
      const PRESENCE_THRESHOLD_MS = 120000; // only consider peers updated within this window as "present" (increased to 120s to avoid premature "Player" fallbacks)
      const nowTs = Date.now();

      let bestFromPeers = null;
      for (const [id, st] of Object.entries(peerGhosts || {})) {
        try {
          // Only consider peers with recent updates (presence) to avoid showing stale/offline scores.
          if (!st || typeof st.score !== 'number') continue;
          if (!st.lastTs || (nowTs - Number(st.lastTs)) > PRESENCE_THRESHOLD_MS) continue;
          const s = Number(st.score);
          const name = (st._displayName || st.name) ? String(st._displayName || st.name).trim() : 'Player';
          if (!bestFromPeers || s > bestFromPeers.score) {
            bestFromPeers = { id, name, score: s, ts: st.lastTs || 0 };
          } else if (s === bestFromPeers.score) {
            // Prefer the more recently-updated peer when scores tie.
            if ((st.lastTs || 0) > (bestFromPeers.ts || 0)) bestFromPeers = { id, name, score: s, ts: st.lastTs || 0 };
          }
        } catch(e){}
      }

      // consider local score as well (treat local as candidate). Local player is always "present".
      try {
        if (typeof score === 'number') {
          const localName = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder) : 'You';
          if (!bestFromPeers || score > bestFromPeers.score || (score === bestFromPeers.score && bestFromPeers.id === 'local')) {
            bestFromPeers = { id: (NET && NET.socket && NET.socket.id) || 'local', name: String(localName).trim(), score: Number(score), ts: Date.now() };
          }
        }
      } catch(e){}

      // Prefer peer/local computed best when it's missing on the server or equal/greater than server value.
      if ((!rh || typeof rh.score !== 'number') && bestFromPeers) {
        rh = { name: bestFromPeers.name, score: bestFromPeers.score };
        roomHighScoresByGame[gid] = rh;
      } else if (rh && typeof rh.score === 'number') {
        // If server value exists, only override it with a live peer/local value when that peer is present
        // and has equal/greater score to avoid showing stale server highs for absent players.
        if (bestFromPeers && bestFromPeers.score >= rh.score) {
          rh = { name: bestFromPeers.name, score: bestFromPeers.score };
          roomHighScoresByGame[gid] = rh;
        } else {
          // Keep server value but attempt to keep the name in sync with any peer that currently holds that score.
          // Prefer recent/present peers, but if the cached name is missing or generic ('Player'),
          // relax presence checks to find any matching peer and adopt its display name.
          let matched = false;
          for (const [id, st] of Object.entries(peerGhosts || {})) {
            try {
              if (!st || typeof st.score !== 'number') continue;
              const isRecent = st.lastTs && (nowTs - Number(st.lastTs)) <= PRESENCE_THRESHOLD_MS;
              // Accept if score matches and (peer is recent OR cached name is not meaningful)
              if (st.score === rh.score && (isRecent || !rh.name || String(rh.name).trim().toLowerCase() === 'player')) {
                rh.name = (st._displayName || st.name) || rh.name;
                roomHighScoresByGame[gid] = rh;
                matched = true;
                break;
              }
            } catch(e){}
          }

          // Also ensure local player's current name is used if the cached score equals local score.
          // Prefer this when no better peer name was found.
          try {
            if ((!rh.name || String(rh.name).trim() === '' || String(rh.name).toLowerCase() === 'player') &&
                typeof score === 'number' && rh && Number(rh.score) === Number(score)) {
              rh.name = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder) : rh.name;
              roomHighScoresByGame[gid] = rh;
            }
          } catch(e){}
        }
      }
    } catch (e) {
      // tolerate peer scanning failures and fall back to server value
    }

    // Fallback: if the cached server value has a generic name, try to resolve a friendlier display name.
    // Prefer a matching peerGhosts entry (ignore strict presence) or the local player's current name when appropriate.
    try {
      if (rh && (typeof rh.name !== 'string' || String(rh.name).trim() === '' || String(rh.name).trim().toLowerCase() === 'player')) {
        for (const [pid, pst] of Object.entries(peerGhosts || {})) {
          try {
            if (!pst || typeof pst.score !== 'number') continue;
            if (Number(pst.score) === Number(rh.score)) {
              rh.name = (pst._displayName || pst.name) || rh.name;
              roomHighScoresByGame[gid] = rh;
              break;
            }
          } catch(e){}
        }
        // If still generic and the local player's score matches, use local name (value or placeholder).
        if ((!rh.name || String(rh.name).trim().toLowerCase() === 'player') && typeof score === 'number' && Number(rh.score) === Number(score)) {
          rh.name = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder) : rh.name;
          roomHighScoresByGame[gid] = rh;
        }
      }
    } catch(e){}

    // If server supplied a clientId for the high scorer and it matches our local client id, prefer our current name.
    try {
      if (rh && rh.clientId) {
        const localCid = localStorage.getItem('hand_ninja_client_id');
        if (localCid && rh.clientId === localCid) {
          rh.name = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder) : rh.name;
          roomHighScoresByGame[gid] = rh;
        }
      }
    } catch(e){}

    if (roomHighScoreEl) {
      if (rh && typeof rh.score === 'number') {
        const name = (rh.name || 'Player').slice(0,12);
        roomHighScoreEl.textContent = `Room Best: ${name}: ${rh.score}`;
        roomHighScoreEl.setAttribute('data-visible', 'true');
        roomHighScoreEl.style.display = 'inline-block';
      } else {
        roomHighScoreEl.textContent = '';
        roomHighScoreEl.removeAttribute('data-visible');
        roomHighScoreEl.style.display = 'none';
      }
    }

    // also keep the runtime roomHighScore variable consistent (used elsewhere)
    roomHighScore = rh;
  } catch (e) { /* ignore UI errors */ }
}

try { window.updateRoomHighScoreDisplay = updateRoomHighScoreDisplay; } catch(e){}

 // Server-authoritative scheduling state
let scheduledGameItems = []; // items supplied by server or generated from seed

// Centralized cleanup helper used by Leave and Kick flows.
// Ensures consistent teardown: post score, end game, clear room high-score cache and UI, and leave room UI.
function cleanupAfterLeave() {
  try {
    const sel = document.getElementById('gameSelect');
    const gid = (sel && sel.value) ? sel.value : currentGameId;
    const name = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder) : 'Player';

    // Post score to server if available and we were running
    try {
      if (running) {
        if (window.NET && typeof window.NET.postScore === 'function') {
          try { window.NET.postScore({ game: gid, name: String(name).slice(0,24), score }); } catch(e){}
        } else {
          try {
            fetch(`/leaderboard`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ game: gid, name: String(name).slice(0,24), score })
            }).catch(()=>{});
          } catch(e){}
        }
      }
    } catch (e) {}

    // Ensure game ends and UI state reset
    try { if (running) endGame(); } catch(e){}

    // Reset room high score for current game to a zeroed entry using the local player's name.
    // This keeps the UI consistent (shows "Room Best: <your-name>: 0") instead of hiding the element
    // or deleting the cached entry which can produce inconsistent behaviour across flows.
    try {
      const clientId = (function() { try { return localStorage.getItem('hand_ninja_client_id'); } catch(e) { return null; } })();
      const localName = String(name || 'Player').slice(0,24);
      roomHighScoresByGame[gid] = { name: localName, score: 0, game: gid, clientId: clientId || null };
      try { roomHighScoreResetTimestamps[gid] = Date.now(); } catch(e) {}
      roomHighScore = roomHighScoresByGame[gid];
      if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay();

      const roomHighScoreEl = document.getElementById('roomHighScore');
      if (roomHighScoreEl) {
        roomHighScoreEl.textContent = `Room Best: ${String(roomHighScore.name || 'Player').slice(0,12)}: ${Number(roomHighScore.score || 0)}`;
        roomHighScoreEl.setAttribute('data-visible', 'true');
        roomHighScoreEl.style.display = 'inline-block';
      }
    } catch (e) { console.warn('Failed to reset room high score in cleanupAfterLeave', e); }

    // Ask ROOMS_UI to leave room if available
    try { if (window.ROOMS_UI && typeof window.ROOMS_UI.leaveRoom === 'function') { window.ROOMS_UI.leaveRoom(); console.log('Left room via cleanupAfterLeave()'); } } catch(e){ console.warn('Failed to call ROOMS_UI.leaveRoom in cleanupAfterLeave', e); }

    // hide leaderboard panel
    try { leaderboardEl.style.display = 'none'; } catch(e){}
  } catch (e) { console.warn('cleanupAfterLeave failed', e); }
}
let serverStartEpoch = null;  // epoch ms when the server-authoritative game started
let serverAuthoritative = false; // true when server-driven spawns are active

 // Physics & spawn tuning (slower & fewer)
 // Tuned to reduce object density on-screen and make bombs rarer on lower-end devices.
 const GRAVITY = 1200; // px/s^2
 // Increase spawn interval to reduce per-second object rate (less clutter)
 const FRUIT_SPAWN_INTERVAL = 2200; // ms (longer -> fewer)
 // Make bombs significantly rarer to avoid frequent penalties
 const BOMB_SPAWN_INTERVAL = 9000; // ms (very rare)
  // Lower concurrent caps so fewer objects are visible at once
  const MAX_FRUITS = 3;
  // Increased bomb concurrency to make bombs more visible in both single-player and multiplayer.
  // Tweak MAX_BOMBS to control solo counts; the multiplayer cap is computed by applying SERVER_SPAWN_MULTIPLIER.
  const MAX_BOMBS = 4;
  // When running in server-authoritative (multiplayer) mode, scale down spawn caps by this multiplier.
  // Reduce multiplier so multiplayer shows noticeably fewer objects (helps crowded rooms).
  // Set to 0.5 to roughly half client-side density for authoritative runs.
  const SERVER_SPAWN_MULTIPLIER = 0.5;
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
    // Device-agnostic maze generation:
    // - By default use a fixed logical maze size so the same grid is generated on phones and desktops.
    // - Compute cols/rows/cellSize from a LOGICAL size, then scale to the actual canvas so drawing
    //   and input mapping remain correct across devices.
    const actualW = w;
    const actualH = h;

    // Prefer a landscape-first logical grid on touch/mobile devices when the viewport is portrait.
    // This makes the maze appear horizontally-oriented on phones held in portrait by generating
    // the grid as if the device were in landscape, then scaling/centering it in the canvas.
    const isTouchDevice = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator && navigator.maxTouchPoints > 0));

    // Allow opt-in override via window.__handNinja flags (useful for testing).
const useLogical = (window.__handNinja && typeof window.__handNinja.forceLogicalMaze !== 'undefined')
  ? !!window.__handNinja.forceLogicalMaze
  : false; // default: false so each device generates its own maze (do not force identical maze across devices)

    const LOGICAL_MAZE_W = (window.__handNinja && window.__handNinja.logicalMazeWidth) || 800;
    const LOGICAL_MAZE_H = (window.__handNinja && window.__handNinja.logicalMazeHeight) || 480;

    // Start with sensible defaults (either forced logical or actual canvas dims).
    let logicalW = useLogical ? LOGICAL_MAZE_W : actualW;
    let logicalH = useLogical ? LOGICAL_MAZE_H : actualH;

    // When on a touch device in portrait orientation and not forcing a logical size,
    // swap to a landscape-first logical sizing so cols/rows compute as a wider layout.
    if (isTouchDevice && actualH > actualW && !useLogical) {
      logicalW = Math.max(actualW, actualH);
      logicalH = Math.min(actualW, actualH);
      // gentle UX hint encouraging landscape rotation (non-blocking)
      try {
        if (typeof noticeEl !== 'undefined' && noticeEl) {
          noticeEl.textContent = 'Rotate device for best maze experience — landscape preferred';
          setTimeout(()=> { try { noticeEl.textContent = ''; } catch(e){} }, 1600);
        }
      } catch(e){}
    }

    // compute grid based on logical size to keep maze deterministic across devices
    cols = Math.max(3, Math.floor(logicalW / 120));
    rows = Math.max(3, Math.floor(logicalH / 120));

    // logical base cell then reduced for easier gameplay
    const baseCellLogical = Math.floor(Math.min(logicalW / cols, logicalH / rows));
    const cellSizeLogical = Math.max(18, Math.floor(baseCellLogical * 0.66));

    // scale logical cell size to actual canvas while preserving aspect
    const scale = Math.min(actualW / logicalW, actualH / logicalH);
    cellSize = Math.max(12, Math.floor(cellSizeLogical * scale));

    // compute maze origin in actual canvas coordinates
    const mazeW = cols * cellSize, mazeH = rows * cellSize;
    mazeOx = Math.floor((actualW - mazeW) / 2);
    mazeOy = Math.floor((actualH - mazeH) / 2);

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
      // reached exit: reward and advance to the next maze level for ALL users
      spawnPopup && spawnPopup((canvas.width / DPR)/2, 80, 'Level Complete!', { col: 'lime', size: 24 });
      try { playSound && playSound('segment_complete'); } catch(e){}
      score += 100;
      updateUI();

      // For multiplayer synchronization: Send maze completion to server to regenerate for all users
      if (serverAuthoritative && window.NET && typeof window.NET.sendInteractionImmediate === 'function') {
        window.NET.sendInteractionImmediate({
          objectId: 'maze_complete_' + Date.now(),
          x: 0.5, y: 0.5,
          type: 'maze_advance'
        });
      }

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

 /* Assets & sounds configuration (automatically populated best-effort)
   - Builds a best-effort mapping of known assets shipped in /assets
   - Populates ASSETS.sfx with semantic keys (point, popup, slice, bomb, etc.)
   - Keeps _fruitImages / fruitSprites for optional sprite loading
   This avoids needing a directory listing at runtime while ensuring preloadAssets()
   will attempt to load every useful SFX/BGM file shipped in the repo.
*/
const ASSETS = (() => {
  const files = [
    'https://ali-ezz.github.io/hand-traking-games/assets/bgm_maze_loop.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bgm_paint_loop.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bgm_runner_loop.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bgm_shape_loop.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bomb-frute.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bomb.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/bomb.wav',
    'https://ali-ezz.github.io/hand-traking-games/assets/boomb.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_clear.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_done.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_eraser.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_hit.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_jump.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_paint_stroke.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_pop_small.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_popup.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_segment_complete.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_shape_complete.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/sfx_wrong.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/slice-fruit.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/slice-frute.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/slice.mp3',
    'https://ali-ezz.github.io/hand-traking-games/assets/slice.wav'
  ];
  const has = (p) => files.indexOf(p) !== -1;
  const pick = (candidates) => {
    for (const c of candidates) if (has(c)) return c;
    return null;
  };

    const sfx = {
    point: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3']),
    popup: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_popup.mp3']),
    segment_complete: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_segment_complete.mp3']),
    shape_complete: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_shape_complete.mp3']),
    wrong: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_wrong.mp3']),
    pop_small: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_pop_small.mp3']),
    clear: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_clear.mp3']),
    done: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_done.mp3']),
    eraser: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_eraser.mp3']),
    hit: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_hit.mp3']),
    jump: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_jump.mp3']),
    paint_stroke: pick(['https://ali-ezz.github.io/hand-traking-games/assets/sfx_paint_stroke.mp3']),
    // slicing variants (map several possible filenames to the canonical 'slice' key)
    slice: pick([
      'https://ali-ezz.github.io/hand-traking-games/assets/slice-frute.mp3',
      'https://ali-ezz.github.io/hand-traking-games/assets/slice-fruit.mp3',
      'https://ali-ezz.github.io/hand-traking-games/assets/slice.mp3',
      'https://ali-ezz.github.io/hand-traking-games/assets/slice.wav'
    ]),
    // bomb variants
    bomb: pick([
      'https://ali-ezz.github.io/hand-traking-games/assets/boomb.mp3',
      'https://ali-ezz.github.io/hand-traking-games/assets/bomb-frute.mp3',
      'https://ali-ezz.github.io/hand-traking-games/assets/bomb.mp3',
      'https://ali-ezz.github.io/hand-traking-games/assets/bomb.wav'
    ])
  };

  const bgmVariants = {
    paint: pick(['https://ali-ezz.github.io/hand-traking-games/assets/bgm_paint_loop.mp3']),
    shape: pick(['https://ali-ezz.github.io/hand-traking-games/assets/bgm_shape_loop.mp3']),
    runner: pick(['https://ali-ezz.github.io/hand-traking-games/assets/bgm_runner_loop.mp3']),
    maze: pick(['https://ali-ezz.github.io/hand-traking-games/assets/bgm_maze_loop.mp3']),
    default: pick(['https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3'])
  };

  return {
    // Default bgm (startGame may override per-game ASSETS.bgm)
    bgm: bgmVariants.default,
    // Expose named bgm variants for diagnostics / manual use
    bgmVariants,
    // canonical single-file pointers for gameplay (slice/bomb)
    slice: sfx.slice,
    bomb: sfx.bomb,
    // full sfx map used by preloadAssets() to eagerly load each semantic key
    sfx,
    // optional fruit sprite urls (left empty by default)
    fruitSprites: [],
    // runtime cache
    _fruitImages: []
  };
})();

const soundPool = {};
let bgmAudio = null;
let musicEnabled = false;
// Restore persisted user music preference early so UI and controller can read it.
try {
  const _m = localStorage.getItem('hand_ninja_music_enabled');
  if (_m !== null) musicEnabled = (_m === '1' || _m === 'true' || _m === 'yes');
} catch (e) { /* ignore localStorage errors */ }

/* MusicController (refactor)
   Centralized, small-surface music manager with clear policy:
   - preload(url): attempts to decode/preload but does not auto-play
   - start(url, {force, vol}): starts playback respecting room/admin policy unless force=true
   - startGame(): convenience -> start(current asset)
   - stop({force}): stops playback (force may be used by server)
   - setRoomState({inRoom,isAdmin}): informs controller about room context
   - getState(): returns minimal state for diagnostics
*/
if (!window.__handNinja) window.__handNinja = {};
window.__handNinja.musicController = (function() {
  const state = { playing: false, url: null, inRoom: false, isAdmin: false, vol: 0.7 };

  async function preload(url) {
    if (!url) return false;
    state.url = url;
    try {
      // Best-effort decode into WebAudio for fast start
      await decodeBgmBuffer(url).catch(()=>null);
      return true;
    } catch (e) {
      console.warn('musicController.preload failed', e);
      return false;
    }
  }

  function setRoomState({ inRoom = false, isAdmin = false } = {}) {
    state.inRoom = !!inRoom;
    state.isAdmin = !!isAdmin;
  }

  function getState() {
    return Object.assign({}, state);
  }

  // Internal helper: start decoded BGM if available else fallback to SimpleAudio/HTMLAudio
  async function _playUrl(url, vol = 0.7, { loop = true } = {}) {
    try {
      if (!url) return false;
      // Avoid duplicate playback attempts for the same URL when we already believe it's playing.
      // This helps prevent double-start when multiple server events (music_play / game_begin)
      // arrive in quick succession. Also use a transient `starting` flag to reduce the race
      // window where two concurrent callers might both pass the playing check.
      try {
        if (state.playing && state.url && url && (String(state.url) === String(url))) {
          return true;
        }
        if (state.starting && state.url && url && (String(state.url) === String(url))) {
          // Another start is in-flight for the same URL; treat as success.
          return true;
        }
        // mark that we're attempting to start this URL so concurrent callers will observe `state.starting`
        state.starting = true;
      } catch (e) { /* ignore guard failures */ }
      // Try decoded WebAudio buffer
      if (sfxBuffers && sfxBuffers['bgm']) {
        try {
          stopDecodedBgm();
          playDecodedBgm(url, { vol, loop });
          state.playing = true;
          return true;
        } catch(e) { /* fallthrough */ }
      }
      // If decode already cached globally
      if (decodedBgm && decodedBgmUrl === url) {
        try { playDecodedBgm(url, { vol, loop }); state.playing = true; return true; } catch(e){}
      }

      // Try SimpleAudio
      const sa = window.__handNinja && window.__handNinja._simpleAudio;
      if (sa && sa.unlocked) {
        try {
          sa.stopBgm && sa.stopBgm();
          sa.map && (sa.map.bgm = url);
          sa.playBgm && sa.playBgm('bgm', vol);
          state.playing = true;
          return true;
        } catch (e) { /* fallthrough */ }
      }

      // Last resort: HTMLAudio
      try {
        stopAllAudio();
        const a = new Audio(url);
        a.loop = !!loop;
        a.volume = Math.max(0, Math.min(1, vol));
        a.play().then(() => { bgmAudio = a; soundPool.bgm = a; }).catch(()=>{});
        state.playing = true;
        return true;
      } catch(e) { console.warn('musicController HTMLAudio start failed', e); return false; }
    } catch (e) {
      console.warn('musicController _playUrl failed', e);
      return false;
    } finally {
      // clear transient starting flag to allow subsequent starts
      try { if (state && state.starting) delete state.starting; } catch (e) {}
    }
  }

  // Public start: honor room/admin policy unless force=true
  async function start(url, { force = false, vol = 0.7 } = {}) {
    const u = url || state.url || (ASSETS && ASSETS.bgm);
    if (!u) return false;
    state.url = u;
    state.vol = vol;
    // Policy: non-admin in-room clients should not auto-start unless forced by server/admin
    if (state.inRoom && !state.isAdmin && !force) {
      // preload but do not autoplay
      await preload(u).catch(()=>{});
      state.playing = false;
      // Debugging: surface why playback was blocked (console + optional debug panel + brief notice)
      try {
        console.warn('musicController.start blocked autoplay: inRoom && !isAdmin && !force', { url: u, inRoom: state.inRoom, isAdmin: state.isAdmin, force });
        const panel = (typeof document !== 'undefined') ? document.getElementById('audioDebugPanel') : null;
        if (panel) {
          const entry = document.createElement('div');
          entry.textContent = `[${new Date().toLocaleTimeString()}] BGM blocked (room/non-admin)`;
          entry.style.fontSize = '12px';
          entry.style.marginTop = '6px';
          panel.insertBefore(entry, panel.firstChild);
        }
        // Non-intrusive user hint
        if (typeof noticeEl !== 'undefined' && noticeEl) {
          const prev = noticeEl.textContent;
          try { noticeEl.textContent = 'Music withheld by room settings (admin can force) — tap to enable'; } catch(e){}
          setTimeout(()=> { try { noticeEl.textContent = prev; } catch(e){} }, 2200);
        }
      } catch(e){}
      return false;
    }
    // Ensure audio context exists for decoded playback
    try { ensureAudioCtx(); } catch(e){}
    const ok = await _playUrl(u, vol, { loop: true });
    state.playing = !!ok;
    return ok;
  }

  function startGame() { return start(state.url, { force: false, vol: state.vol }); }

  // Stop music; if force=true, always stop. Otherwise respect that non-admin room users may have not started.
  function stop({ force = false } = {}) {
    if (!state.playing && !force) {
      // still attempt minimal teardown of decoded buffer
      try { stopDecodedBgm(); } catch(e){}
      state.playing = false;
      return;
    }
    try {
      stopAllAudio();
    } catch (e) { console.warn('musicController.stop failed', e); }
    state.playing = false;
  }
  function stopGame() { stop({ force: false }); }

  function isPlaying() { return !!state.playing; }

  return {
    preload: (u) => preload(u),
    setRoomState,
    start,
    startGame,
    stop,
    stopGame,
    isPlaying,
    getState
  };
})();

// WebAudio low-latency SFX system (lazy-created on first user gesture)
let audioCtx = null;
const sfxBuffers = {};
let sfxMasterGain = null;

// WebAudio decoded BGM support
let decodedBgm = null;
let decodedBgmNode = null;
let decodedBgmGain = null;
let decodedBgmUrl = null;
let decodedBgmPlaying = false;

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sfxMasterGain = audioCtx.createGain();
    sfxMasterGain.gain.value = 1.0;
    sfxMasterGain.connect(audioCtx.destination);

    const unlock = () => {
      try { audioCtx.resume().catch(()=>{}); } catch(e){}
      try { window.__handNinja._userInteracted = true; } catch(e){}
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('touchstart', unlock, { once: true, passive: true });
  } catch (e) {
    console.warn('ensureAudioCtx failed', e);
    audioCtx = null;
    sfxMasterGain = null;
  }
  return audioCtx;
}

// Decode and play BGM via WebAudio to avoid HTMLAudio streaming delays (useful over tunnels)
async function decodeBgmBuffer(url) {
  try {
    if (!url) return null;
    const ctx = ensureAudioCtx();
    if (!ctx) return null;
    // Return cached buffer when available
    if (decodedBgm && decodedBgmUrl === url) return decodedBgm;
    // Fetch audio data (supports blob: and http(s:) object URLs)
    const resp = await fetch(url, { cache: 'force-cache' });
    if (!resp.ok) throw new Error('fetch-failed');
    const arr = await resp.arrayBuffer();
    let buf = null;
    try {
      buf = await ctx.decodeAudioData(arr);
    } catch (e) {
      // fallback signature
      buf = await new Promise((resolve, reject) => ctx.decodeAudioData(arr, resolve, reject));
    }
    if (buf) {
      decodedBgm = buf;
      decodedBgmUrl = url;
    }
    return buf;
  } catch (e) {
    console.warn('decodeBgmBuffer failed', e);
    return null;
  }
}

function playDecodedBgm(url, { vol = 0.8, loop = true } = {}) {
  try {
    const ctx = ensureAudioCtx();
    if (!ctx) return false;
    // If already playing the same decoded BGM, no-op
    if (decodedBgmNode && decodedBgmNode.url === url && decodedBgmPlaying) return true;
    // stop any existing decoded node
    stopDecodedBgm();
    // prefer cached decoded buffer for requested url
    const buf = (decodedBgm && decodedBgmUrl === url) ? decodedBgm : (sfxBuffers && sfxBuffers['bgm']) ? sfxBuffers['bgm'] : null;
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = !!loop;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(ctx.destination);
    try { src.start(0); } catch(e){ /* ignore start errors */ }
    decodedBgmNode = { source: src, gain: g, url };
    decodedBgmPlaying = true;
    // if the source ever ends (non-looping), clear playing flag
    try { src.onended = () => { decodedBgmPlaying = false; }; } catch(e){}
    return true;
  } catch (e) {
    console.warn('playDecodedBgm failed', e);
    return false;
  }
}

function stopDecodedBgm() {
  try {
    if (decodedBgmNode && decodedBgmNode.source) {
      try { decodedBgmNode.source.stop(0); } catch(e){}
      try { decodedBgmNode.source.disconnect(); } catch(e){}
    }
    if (decodedBgmNode && decodedBgmNode.gain) {
      try { decodedBgmNode.gain.disconnect(); } catch(e){}
    }
    decodedBgmNode = null;
    decodedBgmPlaying = false;
  } catch (e) {}
}

/*
  Safety wrappers: prevent scattered code from directly starting/stopping BGM
  outside the centralized musicController policy. These wrappers prefer the
  musicController API when available, but fall back to the original behavior
  to preserve compatibility.
*/
try {
  // Wrap playDecodedBgm so callers that directly start decoded buffers are
  // routed through the musicController (ensures consistent policy and stop).
  const _origPlayDecodedBgm = typeof playDecodedBgm === 'function' ? playDecodedBgm : null;
  playDecodedBgm = function(url, opts) {
    try {
      const mc = window.__handNinja && window.__handNinja.musicController;
      const volume = opts && typeof opts.vol === 'number' ? opts.vol : 0.8;
      // Only divert BGM-style urls (the project's ASSETS.bgm) to the controller.
      // For other arbitrary decoded plays preserve original behavior when possible.
      const isLikelyBgm = (ASSETS && ASSETS.bgm && url && url === ASSETS.bgm) || (typeof url === 'string' && /bgm/i.test(url));
      if (mc && typeof mc.start === 'function' && isLikelyBgm) {
        // Use controller and force play when callers requested direct start
        mc.start(url, { force: true, vol: volume }).catch(() => {});
        return true;
      }
    } catch (e) {
      console.warn('playDecodedBgm wrapper failed', e);
    }
    // fallback to original implementation if available
    try { if (_origPlayDecodedBgm) return _origPlayDecodedBgm(url, opts); } catch(e){}
    return false;
  };

  // Wrap stopDecodedBgm to prefer controller stop path which performs more
  // complete teardown across playback backends.
  const _origStopDecodedBgm = typeof stopDecodedBgm === 'function' ? stopDecodedBgm : null;
  stopDecodedBgm = function() {
    try {
      const mc = window.__handNinja && window.__handNinja.musicController;
      if (mc && typeof mc.stop === 'function') {
        // force stop via controller so it tears down all sources consistently
        try { mc.stop({ force: true }); } catch(e){}
        return;
      }
    } catch (e) {
      console.warn('stopDecodedBgm wrapper failed', e);
    }
    try { if (_origStopDecodedBgm) return _origStopDecodedBgm(); } catch(e){}
  };
} catch (e) {
  // Defensive: if wrappers fail, continue without breaking the rest of the script.
  console.warn('BGM wrapper installation failed', e);
}

 // Preload and decode a short SFX into an AudioBuffer
async function preloadSfx(key, url) {
  if (!url) return null;
  try {
    const ctx = ensureAudioCtx();
    if (!ctx) return null;
    const resp = await fetch(url, { cache: 'force-cache' });
    if (!resp.ok) throw new Error('fetch-failed');
    const arr = await resp.arrayBuffer();
    // Some browsers return a Promise from decodeAudioData; handle accordingly
    let buf = null;
    if (typeof ctx.decodeAudioData === 'function') {
      try {
        buf = await ctx.decodeAudioData(arr);
      } catch (e) {
        // fallback: older signature (callback)
        buf = await new Promise((resolve, reject) => {
          ctx.decodeAudioData(arr, resolve, reject);
        });
      }
    }
    if (buf) sfxBuffers[key] = buf;
    return buf;
  } catch (e) {
    console.warn('preloadSfx failed', key, e);
    return null;
  }
}
 
// ensure all SFX are decoded into WebAudio buffers for lowest latency
async function ensureDecodedSfxAll(prioritize = ['slice','point','popup','pop_small','segment_complete','shape_complete','bomb','hit','jump']) {
  try {
    const sfxKeys = (ASSETS && ASSETS.sfx && typeof ASSETS.sfx === 'object') ? Object.keys(ASSETS.sfx) : [];
    const toLoad = Array.from(new Set([...(Array.isArray(prioritize) ? prioritize : []), ...sfxKeys]));
    for (const k of toLoad) {
      if (!k) continue;
      if (sfxBuffers[k]) continue;
      const url = (ASSETS && ASSETS.sfx && ASSETS.sfx[k]) || ASSETS[k] || null;
      if (!url) continue;
      try { await preloadSfx(k, url); } catch(e){ /* ignore per-key failures */ }
    }
  } catch(e) { console.warn('ensureDecodedSfxAll failed', e); }
}
 
// Play a preloaded SFX buffer (low-latency). Returns true if played.
function playSfx(key, { vol = 1.0, rate = 1.0 } = {}) {
  try {
    const buf = sfxBuffers[key];
    if (!buf) return false;
    const ctx = ensureAudioCtx();
    if (!ctx || !sfxMasterGain) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    try { src.playbackRate.value = rate; } catch(e){}
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(sfxMasterGain);
    src.start(0);
    // cleanup
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    return true;
  } catch (e) {
    console.warn('playSfx error', e);
    return false;
  }
}

// Play a preloaded SFX buffer with duration limiting (low-latency). Returns true if played.
function playSfxWithDuration(key, durationLimit, { vol = 1.0, rate = 1.0 } = {}) {
  try {
    const buf = sfxBuffers[key];
    if (!buf) return false;
    const ctx = ensureAudioCtx();
    if (!ctx || !sfxMasterGain) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    try { src.playbackRate.value = rate; } catch(e){}
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(sfxMasterGain);
    
    if (durationLimit && durationLimit > 0) {
      // Stop after duration limit
      src.start(0);
      setTimeout(() => {
        try { 
          src.stop();
        } catch(e){}
      }, durationLimit * 1000);
    } else {
      src.start(0);
    }
    
    // cleanup
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
    return true;
  } catch (e) {
    console.warn('playSfxWithDuration error', e);
    return false;
  }
}

// Play SimpleAudio with duration control
function playSimpleAudioWithDuration(simpleAudioInstance, key, durationLimit) {
  try {
    if (!simpleAudioInstance || !simpleAudioInstance.unlocked) return;
    const src = (simpleAudioInstance.buff[key] && simpleAudioInstance.buff[key].src) ? simpleAudioInstance.buff[key].src : (simpleAudioInstance.map[key] || null);
    if (!src) return;
    const s = new Audio(src);
    try { s.volume = 1.0; } catch(e){}
    
    if (durationLimit && durationLimit > 0) {
      // Stop after duration limit
      setTimeout(() => {
        try { 
          s.pause();
          s.currentTime = 0;
        } catch(e){}
      }, durationLimit * 1000);
    }
    
    s.play().catch(()=>{});
  } catch(e) {
    console.warn('playSimpleAudioWithDuration error', e);
  }
}

// SimpleAudio quick-fix fallback.
// If js/audio-simple.js / more-advanced preload isn't available, create a minimal in-page fallback
// that preloads a set of root-level assets and uses cloned HTMLAudio nodes for immediate playback.
if (!window._SimpleAudio) {
  window._SimpleAudio = (function(){
    class SA {
      constructor(map){
        this.map = map || {};
        this.buff = {};
        this.unlocked = false;
        this.bgm = null;
        this.bgmKey = null;
      }
      initOnFirstInteraction(){
        const unlock = () => {
          try {
            Object.entries(this.map).forEach(([k,url])=>{
              try {
                if (!url) return;
                const a = new Audio(url);
                a.preload = 'auto';
                // defensive: set a short timeout to avoid blocking long loads
                a.addEventListener('error', ()=>{}, { once: true });
                this.buff[k] = a;
              } catch(e){}
            });
          } catch(e){}
          this.unlocked = true;
          window.removeEventListener('pointerdown', unlock);
          window.removeEventListener('touchstart', unlock);
        };
        window.addEventListener('pointerdown', unlock, {once:true, passive:true});
        window.addEventListener('touchstart', unlock, {once:true, passive:true});
      }
      playBgm(key, vol=0.6){
        if (!this.unlocked) return;
        if (this.bgm && this.bgmKey===key) return;
        if (this.bgm){ try { this.bgm.pause(); } catch(e){} this.bgm = null; }
        const src = (this.buff[key] && this.buff[key].src) ? this.buff[key].src : (this.map[key] || null);
        if (!src) return;
        const a = new Audio(src);
        a.loop = true;
        try { a.volume = vol; } catch(e){}
        a.play().catch(()=>{});
        this.bgm = a; this.bgmKey = key;
      }
      stopBgm(){ if (this.bgm) try{ this.bgm.pause(); }catch(e){} this.bgm=null; this.bgmKey=null; }
      playSfx(key, vol=1){
        if (!this.unlocked) return;
        const src = (this.buff[key] && this.buff[key].src) ? this.buff[key].src : (this.map[key] || null);
        if (!src) return;
        const s = new Audio(src);
        try { s.volume = vol; } catch(e){}
        s.play().catch(()=>{});
      }
    }
    return SA;
  })();
}

// create a sensible fallback map (points to files present in /assets)
if (!window.__handNinja) window.__handNinja = {};
if (!window.__handNinja._simpleAudio) {
  const fallbackMap = {
    bgm: (ASSETS && ASSETS.bgm) ? ASSETS.bgm : 'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3',
    // prefer canonical semantic SFX detected above, fall back to common filenames
    slice: (ASSETS && ASSETS.sfx && ASSETS.sfx.slice) ? ASSETS.sfx.slice : (ASSETS && ASSETS.slice) ? ASSETS.slice : 'https://ali-ezz.github.io/hand-traking-games/assets/slice-frute.mp3',
    bomb: (ASSETS && ASSETS.sfx && ASSETS.sfx.bomb) ? ASSETS.sfx.bomb : (ASSETS && ASSETS.bomb) ? ASSETS.bomb : 'https://ali-ezz.github.io/hand-traking-games/assets/boomb.mp3',
    point: (ASSETS && ASSETS.sfx && ASSETS.sfx.point) ? ASSETS.sfx.point : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
    popup: (ASSETS && ASSETS.sfx && ASSETS.sfx.popup) ? ASSETS.sfx.popup : null,
    segment_complete: (ASSETS && ASSETS.sfx && ASSETS.sfx.segment_complete) ? ASSETS.sfx.segment_complete : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_segment_complete.mp3',
    shape_complete: (ASSETS && ASSETS.sfx && ASSETS.sfx.shape_complete) ? ASSETS.sfx.shape_complete : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_shape_complete.mp3',
    wrong: (ASSETS && ASSETS.sfx && ASSETS.sfx.wrong) ? ASSETS.sfx.wrong : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_wrong.mp3',
    pop_small: (ASSETS && ASSETS.sfx && ASSETS.sfx.pop_small) ? ASSETS.sfx.pop_small : null,
    clear: (ASSETS && ASSETS.sfx && ASSETS.sfx.clear) ? ASSETS.sfx.clear : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_clear.mp3',
    done: (ASSETS && ASSETS.sfx && ASSETS.sfx.done) ? ASSETS.sfx.done : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_done.mp3',
    eraser: (ASSETS && ASSETS.sfx && ASSETS.sfx.eraser) ? ASSETS.sfx.eraser : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_eraser.mp3',
    paint_stroke: (ASSETS && ASSETS.sfx && ASSETS.sfx.paint_stroke) ? ASSETS.sfx.paint_stroke : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_paint_stroke.mp3',
    jump: (ASSETS && ASSETS.sfx && ASSETS.sfx.jump) ? ASSETS.sfx.jump : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_jump.mp3',
    hit: (ASSETS && ASSETS.sfx && ASSETS.sfx.hit) ? ASSETS.sfx.hit : 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_hit.mp3'
  };
  window.__handNinja._simpleAudio = new window._SimpleAudio(fallbackMap);
  window.__handNinja._simpleAudio.initOnFirstInteraction();
}

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
  function tryLoadAudioUrl(url, timeoutMs = 6000) {
    // Prefer a fetch+blob-based loader (more tolerant to proxy/tunnel resets).
    // Falls back to classic HTMLAudio canplaythrough if fetch fails.
    return new Promise(async (res) => {
      if (!url) return res(null);

      // Attempt fetch -> ArrayBuffer -> Blob -> objectURL -> audio.src
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (resp && resp.ok) {
          try {
            const contentType = resp.headers.get('content-type') || 'audio/mpeg';
            const buf = await resp.arrayBuffer();
            const blob = new Blob([buf], { type: contentType });
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement('audio');
            a.preload = 'auto';
            try { a.crossOrigin = 'anonymous'; } catch (e) {}
            a.src = objUrl;
            let settled = false;
            const onCan = () => {
              if (settled) return;
              settled = true;
              reportStatus('audio', `fetched ${url}`);
              // small safety: revoke object URL after some time to avoid memory leak
              setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch (e) {} }, 60000);
              res(a);
            };
            const onErr = () => {
              if (settled) return;
              settled = true;
              reportStatus('audio', `fetched-play-error ${url}`);
              try { URL.revokeObjectURL(objUrl); } catch (e) {}
              res(null);
            };
            a.addEventListener('canplaythrough', onCan, { once: true });
            a.addEventListener('error', onErr, { once: true });
            // fallback: if canplaythrough doesn't fire, resolve with the element after a short grace period
            setTimeout(() => { if (!settled) { settled = true; reportStatus('audio', `fetched-timeout ${url}`); res(a); } }, 300);
            return;
          } catch (e) {
            reportStatus('audio', `fetch-blob-exception ${url}`);
            // fall through to element loader fallback
          }
        } else {
          reportStatus('audio', `fetch-not-ok ${url}`);
        }
      } catch (e) {
        clearTimeout(timeoutId);
        reportStatus('audio', `fetch-failed ${url}`);
        // fall through to element loader fallback
      }

      // Fallback: classic HTMLAudio loader (short timeout)
      try {
        const a = document.createElement('audio');
        a.preload = 'auto';
        try { a.crossOrigin = 'anonymous'; } catch (e) {}
        try { a.muted = false; } catch (e) {}
        try { a.volume = 1.0; } catch (e) {}
        let settled2 = false;
        const onSuccess = () => {
          if (!settled2) {
            settled2 = true;
            reportStatus('audio', `canplay ${url}`);
            a.addEventListener('play', () => { reportStatus('audio', `play event ${url}`); }, { once: true });
            a.addEventListener('error', () => { reportStatus('audio', `play error ${url}`); }, { once: true });
            res(a);
          }
        };
        const onFail = () => {
          if (!settled2) {
            settled2 = true;
            reportStatus('audio', `load error ${url}`);
            res(null);
          }
        };
        a.addEventListener('canplaythrough', onSuccess, { once: true });
        a.addEventListener('error', onFail, { once: true });
        a.src = url;
        setTimeout(() => { if (!settled2) { settled2 = true; reportStatus('audio', `timeout ${url}`); res(null); } }, 1200);
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
      (ASSETS.sfx && ASSETS.sfx.slice)
    ].filter(Boolean);

    const bombCandidates = [
      ASSETS.bomb,
      (ASSETS.sfx && ASSETS.sfx.bomb)
    ].filter(Boolean);

    const bgmCandidates = [
      ASSETS.bgm,
      (ASSETS.bgmVariants && ASSETS.bgmVariants.default)
    ].filter(Boolean);

    // helper to race candidate loaders in parallel and pick the first successful
    async function firstSuccessful(candidates, label, timeoutMs = 1200) {
      if (!candidates || !candidates.length) {
        reportStatus(label, 'not found');
        return null;
      }
      const loaders = candidates.map(url => tryLoadAudioUrl(url, timeoutMs).then(a => a ? { url, a } : Promise.reject(url)));
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
            const a = await tryLoadAudioUrl(url, timeoutMs);
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
    firstSuccessful(sliceCandidates, 'slice', 6000).then(a => {
      if (a) {
        soundPool.slice = a;
        reportStatus('slice', `loaded ${a.src}`);
        // attempt to also preload a low-latency WebAudio buffer for short SFX
        try { preloadSfx('slice', a.src).catch(()=>{}); } catch(e){}
      } else {
        reportStatus('slice','not found');
      }
    });
    firstSuccessful(bombCandidates, 'bomb', 6000).then(a => {
      if (a) {
        soundPool.bomb = a;
        reportStatus('bomb', `loaded ${a.src}`);
        try { preloadSfx('bomb', a.src).catch(()=>{}); } catch(e){}
      } else {
        reportStatus('bomb','not found');
      }
    });

    // bgm needs special handling to stop previous bgmAudio if a new one is found
    firstSuccessful(bgmCandidates, 'bgm', 6000).then(a => {
      if (a) {
        try {
          // Ensure loop on discovered element
          a.loop = true;

          // If a centralized musicController exists, prefer it for BGM lifecycle management.
          // We still keep a diagnostic reference to the discovered element but avoid assigning
          // it as the active playback source so we don't bypass controller policy (preload vs start).
          const mc = window.__handNinja && window.__handNinja.musicController;
          if (mc && typeof mc.preload === 'function') {
            try {
              mc.preload(a.src).catch(()=>{});
              try { soundPool.bgm = a; } catch(e){}
              reportStatus('bgm', `preloaded via musicController ${a.src}`);
            } catch (e) {
              // fall back to legacy assignment below on unexpected controller errors
              console.warn('musicController.preload failed, falling back to legacy bgm assignment', e);
            }
          } else {
            // Teardown any existing bgm BEFORE assigning the new instance to avoid races/duplicate playback.
            if (bgmAudio && bgmAudio !== a) {
              try { reportStatus('bgm', `teardown prev ${bgmAudio && bgmAudio.src ? bgmAudio.src : '<none>'} at ${Date.now()}`); } catch(e){}
              try { bgmAudio.pause(); } catch(e){}
              try { bgmAudio.currentTime = 0; } catch(e){}
              try {
                // preserve previous src so we can revoke blob URLs after clearing
                const _prevSrc = bgmAudio.src;
                try { bgmAudio.src = ''; } catch(e){}
                try { bgmAudio.removeAttribute && bgmAudio.removeAttribute('src'); } catch(e){}
                try { bgmAudio.load && bgmAudio.load(); } catch(e){}
                if (_prevSrc && typeof _prevSrc === 'string' && _prevSrc.indexOf('blob:') === 0) {
                  try { URL.revokeObjectURL(_prevSrc); } catch(e){}
                }
              } catch(e){}
              try { delete soundPool.bgm; } catch(e){}
            }

            // Register the new bgm element (single assignment)
            bgmAudio = a;
            try { soundPool.bgm = a; } catch(e){}
            try { reportStatus('bgm', `loaded ${a.src} at ${Date.now()}`); } catch(e){}
          }

          // Decode bgm into WebAudio buffer in background (no autoplay).
          // Use preloadSfx to leverage existing decode logic / AudioContext handling.
          (async () => {
            try {
              const buf = await preloadSfx('bgm', a.src).catch(()=>null);
              if (buf) {
                sfxBuffers['bgm'] = buf;
                try { reportStatus('bgm', `decoded bgm buffer ${a.src}`); } catch(e){}
              } else {
                try { reportStatus('bgm', `bgm decode failed ${a.src}`); } catch(e){}
              }
            } catch(e){}
          })();
        } catch(e){}
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
        const a = await tryLoadAudioUrl(url, 6000);
        if (a) {
          soundPool[key] = a;
          reportStatus(`sfx:${key}`, `loaded ${a.src}`);
          // Attempt to decode into WebAudio buffer for lower-latency playback (fire-and-forget).
          try { preloadSfx(key, a.src).catch(()=>{}); } catch(e){}
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
  try { if (typeof ensureDecodedSfxAll === 'function') { ensureDecodedSfxAll().catch(()=>{}); } } catch(e){}
}

function playSound(name) {
  try {
    // Prefer WebAudio manager when available for lowest-latency playback
    if (window.AUDIO) {
      try {
        if (name === 'bgm') {
          // map currentGameId to reasonable bgm key names used by AudioManager
          const bgmKeyMap = {
            'ninja-fruit': 'bgm',
            'paint-air': 'bgm_paint_loop',
            'shape-trace': 'bgm_shape_loop',
            'runner-control': 'bgm_runner_loop',
            'maze-mini': 'bgm_maze_loop'
          };
          const key = bgmKeyMap[currentGameId] || 'bgm';
          // ensure AudioContext unlocked before playing
          try { window.AUDIO.initOnFirstInteraction(); } catch(e){}
          window.AUDIO.playBgm(key, { volume: 0.6 });
          return;
        } else {
          try { window.AUDIO.initOnFirstInteraction(); } catch(e){}
          // SFX: delegate to AudioManager; it will fallback gracefully
          window.AUDIO.playSfx(name, { volume: 1.0, playbackRate: 1.0, duck: true });
          return;
        }
      } catch (e) {
        // fallthrough to legacy path on error
      }
    }

    // Avoid playing when page hidden
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // Require a user gesture for short SFX to avoid autoplay blocks on some browsers
    if (!window.__handNinja._userInteracted && name !== 'bgm') {
      return;
    }

      if (name === 'bgm') {
        // Delegate BGM handling to centralized musicController to ensure consistent behavior
        try {
          const bgmUrl = (ASSETS && ASSETS.bgm) ? ASSETS.bgm : 'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3';
          const mc = window.__handNinja && window.__handNinja.musicController ? window.__handNinja.musicController : null;
          if (mc && typeof mc.start === 'function') {
            // start will respect room/admin policy and the user's music preference
            mc.start(bgmUrl, { force: false, vol: 0.6 });
            return;
          }
        } catch (e) {
          console.warn('playSound delegated to musicController failed', e);
        }

        // Fallback older behavior if controller missing: only play when musicEnabled and not in-room non-admin
        if (!musicEnabled) return;
        const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
        if (roomsState && roomsState.room && !roomsState.isAdmin) {
          // Non-admin clients must not auto-start BGM; preload only
          try { if (ASSETS && ASSETS.bgm) { preloadSfx('bgm', ASSETS.bgm).catch(()=>{}); } } catch(e){}
          return;
        }

        // fallback: attempt existing start strategies
        try {
          // stop previous audio
          try { stopAllAudio(); } catch(e){}
          const url = (ASSETS && ASSETS.bgm) ? ASSETS.bgm : null;
          if (!url) return;
          // prefer decoded buffer
          if (sfxBuffers && sfxBuffers['bgm']) {
            try {
              const ctx = ensureAudioCtx();
              if (ctx) {
                stopDecodedBgm();
                const src = ctx.createBufferSource();
                src.buffer = sfxBuffers['bgm'];
                src.loop = true;
                const g = ctx.createGain();
                g.gain.value = 0.5;
                src.connect(g);
                g.connect(ctx.destination);
                src.start(0);
                decodedBgmNode = { source: src, gain: g, url };
                decodedBgmPlaying = true;
                return;
              }
            } catch(e){}
          }
          // SimpleAudio fallback
          const sa = (window.__handNinja && window.__handNinja._simpleAudio) ? window.__handNinja._simpleAudio : null;
          if (sa && sa.unlocked) {
            try { sa.stopBgm(); sa.map.bgm = url; sa.playBgm('bgm', 0.6); return; } catch(e){}
          }
          // HTMLAudio fallback
          try {
            const inst = new Audio(url);
            inst.loop = true;
            inst.volume = 0.5;
            inst.play().then(()=>{ bgmAudio = inst; soundPool.bgm = inst; }).catch(()=>{});
          } catch(e){}
        } catch(e){ console.warn('Legacy BGM fallback failed', e); }
        return;
      }

    // SFX handling with proper cooldowns AND DURATION LIMITING
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const lastTimes = window.__handNinja._lastSoundTimes || (window.__handNinja._lastSoundTimes = {});
    const cooldownMap = {
      point: 80,
      segment_complete: 80,
      popup: 80,
      shape_complete: 300,
      paint_stroke: 100, // Prevent paint stroke spam
      eraser: 120,       // Prevent eraser spam
      pop_small: 60,     // Allow more frequent for bounces
      // fallback default
      default: SOUND_COOLDOWN_MS || 80
    };
    const cd = cooldownMap[name] || cooldownMap.default;
    if (lastTimes[name] && now - lastTimes[name] < cd) return;
    lastTimes[name] = now;

// SFX Duration limits - all sounds less than 1 second as requested
const sfxDurationLimits = {
  slice: 0.8,        // Only first 0.8 seconds
  bomb: 0.9,         // Only first 0.9 seconds  
  point: 0.4,        // Short point sound
  popup: 0.5,        // Brief popup
  segment_complete: 0.9,
  shape_complete: 0.9,
  paint_stroke: 0.3,
  eraser: 0.4,
  jump: 0.6,
  hit: 0.5,
  pop_small: 0.3,
  clear: 0.9,
  done: 0.9,
  wrong: 0.8
};

// DYNAMIC AUDIO INTENSITY SYSTEM - Makes audio "fat" and responsive
const AUDIO_INTENSITY_LEVELS = {
  CALM: 0,      // 0-0.2: Very quiet, minimal layering
  LOW: 1,       // 0.2-0.4: Light activity, single sounds
  MEDIUM: 2,    // 0.4-0.6: Moderate activity, some layering
  HIGH: 3,      // 0.6-0.8: High activity, full layering
  EXTREME: 4    // 0.8-1.0: Maximum intensity, all effects
};

// Audio layering system for "fat" sound
const AUDIO_LAYERS = {
  'slice': ['slice-frute.mp3', 'slice-fruit.mp3', 'slice.mp3', 'slice.wav'],
  'bomb': ['boomb.mp3', 'bomb-frute.mp3', 'bomb.mp3', 'bomb.wav'],
  'hit': ['sfx_hit.mp3', 'sfx_pop_small.mp3'],
  'jump': ['sfx_jump.mp3', 'sfx_pop_small.mp3'],
  'paint_stroke': ['sfx_paint_stroke.mp3', 'sfx_pop_small.mp3'],
  'eraser': ['sfx_eraser.mp3', 'sfx_pop_small.mp3'],
  'point': ['sfx_point.mp3', 'sfx_pop_small.mp3'],
  'segment_complete': ['sfx_segment_complete.mp3', 'sfx_point.mp3'],
  'shape_complete': ['sfx_shape_complete.mp3', 'sfx_segment_complete.mp3', 'sfx_point.mp3']
};

// Current audio intensity (0-1, updated by hand movement)
let currentAudioIntensity = 0;
let lastHandVelocity = 0;
let audioIntensitySmoothing = 0;

// Update audio intensity based on hand movement - FIXED FUNCTION
function updateAudioIntensity(hands) {
  if (!hands || hands.length === 0) {
    // Decay intensity when no hands detected
    currentAudioIntensity = Math.max(0, currentAudioIntensity - 0.02);
    audioIntensitySmoothing = currentAudioIntensity;
    return;
  }

  // Calculate hand velocity for intensity
  let totalVelocity = 0;
  let handCount = 0;
  
  for (const hand of hands) {
    if (hand && hand[8]) { // Index fingertip
      const tip = hand[8];
      if (updateAudioIntensity.lastPositions) {
        const lastPos = updateAudioIntensity.lastPositions[handCount];
        if (lastPos) {
          const velocity = Math.hypot(tip.x - lastPos.x, tip.y - lastPos.y);
          totalVelocity += velocity;
        }
      }
      handCount++;
    }
  }
  
  // Store positions for next frame
  if (!updateAudioIntensity.lastPositions) updateAudioIntensity.lastPositions = [];
  updateAudioIntensity.lastPositions = hands.map(hand => 
    hand && hand[8] ? { x: hand[8].x, y: hand[8].y } : null
  ).filter(Boolean);
  
  if (handCount > 0) {
    const avgVelocity = totalVelocity / handCount;
    // Normalize velocity to 0-1 range (max expected velocity ~100px/frame)
    const normalizedVelocity = Math.min(1, avgVelocity / 100);
    
    // Smooth intensity changes
    const targetIntensity = normalizedVelocity;
    audioIntensitySmoothing = audioIntensitySmoothing * 0.8 + targetIntensity * 0.2;
    currentAudioIntensity = Math.max(0, Math.min(1, audioIntensitySmoothing));
    
    // Game-specific intensity modifiers
    if (currentGameId === 'ninja-fruit') {
      currentAudioIntensity *= 1.2; // More aggressive for slicing
    } else if (currentGameId === 'paint-air') {
      currentAudioIntensity *= 0.8; // Smoother for painting
    } else if (currentGameId === 'runner-control') {
      currentAudioIntensity *= 1.1; // Slightly more intense for running
    }
    
    currentAudioIntensity = Math.min(1, currentAudioIntensity);
  }
}

// Make updateAudioIntensity globally accessible to fix reference errors
window.updateAudioIntensity = updateAudioIntensity;

// Get intensity level from current intensity value
function getIntensityLevel() {
  if (currentAudioIntensity < 0.2) return AUDIO_INTENSITY_LEVELS.CALM;
  if (currentAudioIntensity < 0.4) return AUDIO_INTENSITY_LEVELS.LOW;
  if (currentAudioIntensity < 0.6) return AUDIO_INTENSITY_LEVELS.MEDIUM;
  if (currentAudioIntensity < 0.8) return AUDIO_INTENSITY_LEVELS.HIGH;
  return AUDIO_INTENSITY_LEVELS.EXTREME;
}

// Play layered audio based on intensity - makes sounds "fat"
function playLayeredAudio(soundName, baseVolume = 1.0) {
  const intensityLevel = getIntensityLevel();
  const layers = AUDIO_LAYERS[soundName] || [soundName];
  
  // Determine how many layers to play based on intensity
  let layerCount = 1;
  switch (intensityLevel) {
    case AUDIO_INTENSITY_LEVELS.CALM:
      layerCount = 1;
      break;
    case AUDIO_INTENSITY_LEVELS.LOW:
      layerCount = Math.min(2, layers.length);
      break;
    case AUDIO_INTENSITY_LEVELS.MEDIUM:
      layerCount = Math.min(2, layers.length);
      break;
    case AUDIO_INTENSITY_LEVELS.HIGH:
      layerCount = Math.min(3, layers.length);
      break;
    case AUDIO_INTENSITY_LEVELS.EXTREME:
      layerCount = layers.length;
      break;
  }
  
  // Play layers with slight timing and volume offsets for "fat" sound
  for (let i = 0; i < layerCount; i++) {
    const layerSound = layers[i];
    const layerVolume = baseVolume * (1 - i * 0.15); // Diminishing volume per layer
    const delay = i * 25; // 25ms stagger between layers
    
    setTimeout(() => {
      // Try to find the asset with 'https://ali-ezz.github.io/hand-traking-games/assets/' prefix
      const assetPath = layerSound.startsWith('https://ali-ezz.github.io/hand-traking-games/assets/') ? layerSound : `https://ali-ezz.github.io/hand-traking-games/assets/${layerSound}`;
      
      // Check if this specific asset exists in our ASSETS.sfx mapping
      let soundKey = soundName;
      if (ASSETS && ASSETS.sfx) {
        // Find the key that matches this asset
        for (const [key, url] of Object.entries(ASSETS.sfx)) {
          if (url === assetPath || url === layerSound) {
            soundKey = key;
            break;
          }
        }
      }
      
      // Play the sound with modified volume
      try {
        const durationLimit = sfxDurationLimits[soundKey] || sfxDurationLimits[soundName];
        
        if (typeof sfxBuffers !== 'undefined' && sfxBuffers && sfxBuffers[soundKey]) {
          playSfxWithDuration(soundKey, durationLimit, { vol: layerVolume });
        } else {
          // Fallback: create temporary audio element
          const audio = new Audio(assetPath);
          audio.volume = layerVolume;
          audio.play().catch(() => {});
          
          if (durationLimit) {
            setTimeout(() => {
              try {
                audio.pause();
                audio.currentTime = 0;
              } catch(e) {}
            }, durationLimit * 1000);
          }
        }
      } catch(e) {
        console.warn(`Failed to play layer ${layerSound}:`, e);
      }
    }, delay);
  }
}

// COMPREHENSIVE FAT & RESPONSIVE AUDIO SYSTEM
// This system makes all sounds rich and responsive to hand movements across all 5 games

class FatResponsiveAudioEngine {
  constructor() {
    // Enhanced tracking variables
    this.handTrackingIntensity = 0; // 0-1 based on hand movement speed
    this.lastHandPositions = [];
    this.handVelocity = 0;
    this.audioIntensitySmoothing = 0;
    
    // Audio layering system for "fat" sounds
    this.audioLayers = new Map();
    this.activeAudioNodes = new Set();
    
    // Game-specific audio profiles
    this.gameAudioProfiles = this.setupGameAudioProfiles();
    
    // Combo system for enhanced feedback
    this.comboCounter = 0;
    this.lastComboTime = 0;
    this.comboMultiplier = 1;
    
    // Spatial audio system
    this.spatialNodes = new Map();
    
    // Dynamic filtering system
    this.dynamicFilters = new Map();
    
    console.log('Fat Responsive Audio Engine initialized with comprehensive layering system');
  }

  // Set up comprehensive game-specific audio profiles using ALL available assets
  setupGameAudioProfiles() {
    return {
      'ninja-fruit': {
        // Layer multiple slice sounds for fat slicing audio
        layeredSounds: {
          slice: {
            primary: ['slice-frute.mp3', 'slice-fruit.mp3', 'slice.mp3', 'slice.wav'],
            secondary: ['sfx_pop_small.mp3', 'sfx_hit.mp3'],
            intensity: { low: 1, medium: 2, high: 3, extreme: 4 }
          },
          bomb: {
            primary: ['boomb.mp3', 'bomb-frute.mp3', 'bomb.mp3', 'bomb.wav'],
            secondary: ['sfx_hit.mp3'],
            intensity: { low: 1, medium: 2, high: 2, extreme: 3 }
          },
          point: {
            primary: ['sfx_point.mp3'],
            secondary: ['sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 2, high: 2, extreme: 2 }
          }
        },
        intensityMultipliers: { low: 0.7, medium: 1.2, high: 1.8, extreme: 2.5 },
        comboSounds: true,
        spatialEffects: true,
        bgm: 'bgm.mp3'
      },
      
      'paint-air': {
        layeredSounds: {
          paint_stroke: {
            primary: ['sfx_paint_stroke.mp3'],
            secondary: ['sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 3 }
          },
          eraser: {
            primary: ['sfx_eraser.mp3'],
            secondary: ['sfx_pop_small.mp3', 'sfx_clear.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 2 }
          },
          clear: {
            primary: ['sfx_clear.mp3'],
            secondary: ['sfx_done.mp3'],
            intensity: { low: 1, medium: 1, high: 1, extreme: 2 }
          }
        },
        intensityMultipliers: { low: 0.5, medium: 0.8, high: 1.3, extreme: 1.8 },
        brushPressure: true,
        bgm: 'bgm_paint_loop.mp3'
      },
      
      'shape-trace': {
        layeredSounds: {
          point: {
            primary: ['sfx_point.mp3'],
            secondary: ['sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 2 }
          },
          segment_complete: {
            primary: ['sfx_segment_complete.mp3'],
            secondary: ['sfx_point.mp3', 'sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 2, high: 3, extreme: 3 }
          },
          shape_complete: {
            primary: ['sfx_shape_complete.mp3'],
            secondary: ['sfx_segment_complete.mp3', 'sfx_point.mp3'],
            intensity: { low: 1, medium: 2, high: 3, extreme: 4 }
          },
          wrong: {
            primary: ['sfx_wrong.mp3'],
            secondary: ['sfx_hit.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 2 }
          }
        },
        intensityMultipliers: { low: 0.6, medium: 1.0, high: 1.5, extreme: 2.2 },
        progressiveAudio: true,
        bgm: 'bgm_shape_loop.mp3'
      },
      
      'runner-control': {
        layeredSounds: {
          jump: {
            primary: ['sfx_jump.mp3'],
            secondary: ['sfx_pop_small.mp3', 'sfx_hit.mp3'],
            intensity: { low: 1, medium: 2, high: 2, extreme: 3 }
          },
          hit: {
            primary: ['sfx_hit.mp3'],
            secondary: ['boomb.mp3', 'sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 2, high: 2, extreme: 3 }
          },
          point: {
            primary: ['sfx_point.mp3'],
            secondary: ['sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 2 }
          }
        },
        intensityMultipliers: { low: 0.8, medium: 1.4, high: 2.0, extreme: 2.8 },
        heartbeatEffect: true,
        bgm: 'bgm_runner_loop.mp3'
      },
      
      'maze-mini': {
        layeredSounds: {
          point: {
            primary: ['sfx_point.mp3'],
            secondary: ['sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 2 }
          },
          segment_complete: {
            primary: ['sfx_segment_complete.mp3'],
            secondary: ['sfx_point.mp3'],
            intensity: { low: 1, medium: 2, high: 2, extreme: 3 }
          },
          popup: {
            primary: ['sfx_popup.mp3'],
            secondary: ['sfx_pop_small.mp3'],
            intensity: { low: 1, medium: 1, high: 2, extreme: 2 }
          }
        },
        intensityMultipliers: { low: 0.7, medium: 1.1, high: 1.6, extreme: 2.3 },
        echoEffects: true,
        bgm: 'bgm_maze_loop.mp3'
      }
    };
  }

  // Update hand tracking with enhanced responsiveness
  updateHandTracking(hands) {
    if (!hands || hands.length === 0) {
      // Decay intensity when no hands detected
      this.handTrackingIntensity = Math.max(0, this.handTrackingIntensity - 0.03);
      this.audioIntensitySmoothing = this.handTrackingIntensity;
      this.handVelocity = 0;
      return;
    }

    // Calculate enhanced hand velocity for all hands
    let totalVelocity = 0;
    let maxIndividualVelocity = 0;
    let handCount = 0;
    
    const currentPositions = hands.map(hand => {
      if (hand && hand[8]) { // Index fingertip
        return { x: hand[8].x, y: hand[8].y };
      }
      return null;
    }).filter(Boolean);
    
    if (this.lastHandPositions.length > 0 && currentPositions.length > 0) {
      for (let i = 0; i < Math.min(this.lastHandPositions.length, currentPositions.length); i++) {
        const lastPos = this.lastHandPositions[i];
        const currentPos = currentPositions[i];
        if (lastPos && currentPos) {
          const velocity = Math.hypot(currentPos.x - lastPos.x, currentPos.y - lastPos.y);
          totalVelocity += velocity;
          maxIndividualVelocity = Math.max(maxIndividualVelocity, velocity);
          handCount++;
        }
      }
      
      if (handCount > 0) {
        this.handVelocity = totalVelocity / handCount;
        
        // Enhanced intensity calculation
        const maxVelocity = 60; // Base velocity threshold
        const avgIntensity = Math.min(1, this.handVelocity / maxVelocity);
        const peakIntensity = Math.min(1, maxIndividualVelocity / (maxVelocity * 1.2));
        
        // Combine average and peak with game-specific modifiers
        let combinedIntensity = Math.max(avgIntensity, peakIntensity * 0.8);
        
        // Apply game-specific intensity scaling
        switch(currentGameId) {
          case 'ninja-fruit':
            combinedIntensity *= 1.4; // Very aggressive for slicing
            break;
          case 'paint-air':
            combinedIntensity *= 0.7; // Smoother for painting
            break;
          case 'runner-control':
            combinedIntensity *= 1.2; // Moderate for running
            break;
          case 'shape-trace':
            combinedIntensity *= 1.0; // Balanced for tracing
            break;
          case 'maze-mini':
            combinedIntensity *= 0.9; // Slightly calmer for maze
            break;
        }
        
        // Smooth intensity changes with adaptive smoothing
        const smoothingFactor = Math.min(0.3, combinedIntensity * 0.4);
        this.audioIntensitySmoothing = this.audioIntensitySmoothing * (1 - smoothingFactor) + combinedIntensity * smoothingFactor;
        this.handTrackingIntensity = Math.max(0, Math.min(1, this.audioIntensitySmoothing));
      }
    }
    
    this.lastHandPositions = currentPositions;
  }

  // Get current intensity level for layering decisions
  getIntensityLevel() {
    if (this.handTrackingIntensity < 0.2) return 'low';
    if (this.handTrackingIntensity < 0.5) return 'medium';
    if (this.handTrackingIntensity < 0.8) return 'high';
    return 'extreme';
  }

  // Play FAT layered audio - the core of the system
  playFatSound(soundName, options = {}) {
    try {
      const profile = this.gameAudioProfiles[currentGameId];
      if (!profile || !profile.layeredSounds[soundName]) {
        // Fallback to regular playSound for unmapped sounds
        playSound(soundName);
        return;
      }

      const soundConfig = profile.layeredSounds[soundName];
      const intensityLevel = this.getIntensityLevel();
      const layerCount = soundConfig.intensity[intensityLevel] || 1;
      const intensityMultiplier = profile.intensityMultipliers[intensityLevel] || 1.0;
      
      const {
        position = null,
        baseVolume = 1.0,
        pitchVariation = true,
        staggerLayers = true
      } = options;

      // Play primary sound layers
      const primarySounds = soundConfig.primary || [];
      for (let i = 0; i < Math.min(layerCount, primarySounds.length); i++) {
        const soundFile = primarySounds[i];
        const layerDelay = staggerLayers ? i * 30 : 0; // 30ms stagger
        const layerVolume = baseVolume * intensityMultiplier * (1 - i * 0.15); // Diminishing volume
        const layerPitch = pitchVariation ? 1.0 + (Math.random() - 0.5) * 0.2 : 1.0; // ±10% pitch variation
        
        setTimeout(() => {
          this.playSingleLayerSound(soundFile, {
            volume: layerVolume,
            pitch: layerPitch,
            position: position
          });
        }, layerDelay);
      }

      // Play secondary enhancement sounds for higher intensities
      if (intensityLevel === 'high' || intensityLevel === 'extreme') {
        const secondarySounds = soundConfig.secondary || [];
        const secondaryCount = intensityLevel === 'extreme' ? 2 : 1;
        
        for (let i = 0; i < Math.min(secondaryCount, secondarySounds.length); i++) {
          const soundFile = secondarySounds[i];
          const layerDelay = staggerLayers ? (primarySounds.length * 30) + (i * 40) : 0;
          const layerVolume = baseVolume * intensityMultiplier * 0.6 * (1 - i * 0.2);
          const layerPitch = pitchVariation ? 1.0 + (Math.random() - 0.5) * 0.15 : 1.0;
          
          setTimeout(() => {
            this.playSingleLayerSound(soundFile, {
              volume: layerVolume,
              pitch: layerPitch,
              position: position
            });
          }, layerDelay);
        }
      }

      // Handle special effects
      if (currentGameId === 'ninja-fruit' && profile.comboSounds) {
        this.handleComboEffects(soundName);
      }
      
      if (profile.heartbeatEffect && this.handTrackingIntensity > 0.7) {
        this.triggerHeartbeatEffect();
      }

    } catch (e) {
      console.warn('Fat sound playback failed', e, 'falling back to regular audio');
      playSound(soundName);
    }
  }

  // Play individual sound layer with enhancements
  playSingleLayerSound(soundFile, options = {}) {
    const { volume = 1.0, pitch = 1.0, position = null } = options;
    
    // Get the full asset path
    const assetPath = soundFile.startsWith('https://ali-ezz.github.io/hand-traking-games/assets/') ? soundFile : `https://ali-ezz.github.io/hand-traking-games/assets/${soundFile}`;
    
    // Find the sound key in our system
    let soundKey = null;
    if (ASSETS && ASSETS.sfx) {
      for (const [key, url] of Object.entries(ASSETS.sfx)) {
        if (url === assetPath || url.includes(soundFile)) {
          soundKey = key;
          break;
        }
      }
    }

    // Try WebAudio first for best control
    if (soundKey && sfxBuffers && sfxBuffers[soundKey]) {
      try {
        const ctx = ensureAudioCtx();
        if (ctx && sfxMasterGain) {
          const source = ctx.createBufferSource();
          const gainNode = ctx.createGain();
          
          source.buffer = sfxBuffers[soundKey];
          source.playbackRate.value = pitch;
          gainNode.gain.value = volume;
          
          // Add spatial audio if position provided
          if (position && ctx.createPanner) {
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            
            if (panner.positionX) {
              panner.positionX.value = (position.x - canvas.width/2) / 1000;
              panner.positionY.value = -(position.y - canvas.height/2) / 1000;
              panner.positionZ.value = 0;
            }
            
            source.connect(gainNode);
            gainNode.connect(panner);
            panner.connect(sfxMasterGain);
          } else {
            source.connect(gainNode);
            gainNode.connect(sfxMasterGain);
          }
          
          source.start(0);
          
          // Cleanup
          source.onended = () => {
            try {
              source.disconnect();
              gainNode.disconnect();
            } catch (e) {}
          };
          
          return;
        }
      } catch (e) {
        console.warn('WebAudio layer failed', e);
      }
    }

    // Fallback to HTMLAudio
    try {
      const audio = new Audio(assetPath);
      audio.volume = Math.min(1.0, volume);
      if (audio.playbackRate) audio.playbackRate = pitch;
      audio.play().catch(() => {}); // Ignore play failures
    } catch (e) {
      console.warn('HTMLAudio layer failed', e);
    }
  }

  // Handle combo effects for ninja-fruit
  handleComboEffects(soundName) {
    const now = performance.now();
    
    if (soundName === 'slice') {
      if (now - this.lastComboTime < 1200) {
        this.comboCounter++;
        this.comboMultiplier = Math.min(3.0, 1.0 + (this.comboCounter * 0.2));
        
        // Play escalating combo sounds
        if (this.comboCounter >= 3) {
          setTimeout(() => {
            this.playSingleLayerSound('sfx_popup.mp3', {
              volume: 0.8,
              pitch: 1.0 + (this.comboCounter * 0.1)
            });
          }, 100);
        }
        
        if (this.comboCounter >= 6) {
          setTimeout(() => {
            this.playSingleLayerSound('sfx_segment_complete.mp3', {
              volume: 1.0,
              pitch: 1.2
            });
          }, 150);
        }
      } else {
        this.comboCounter = 0;
        this.comboMultiplier = 1.0;
      }
      
      this.lastComboTime = now;
    }
  }

  // Trigger heartbeat effect for intense runner moments
  triggerHeartbeatEffect() {
    if (Math.random() < 0.15) { // 15% chance during intense moments
      setTimeout(() => {
        this.playSingleLayerSound('sfx_hit.mp3', {
          volume: 0.4,
          pitch: 0.7
        });
      }, Math.random() * 200);
    }
  }

  // Update ambient effects
  updateAmbientEffects() {
    try {
      const profile = this.gameAudioProfiles[currentGameId];
      if (!profile) return;
      
      // Modulate any ambient loops based on intensity
      if (profile.heartbeatEffect && currentGameId === 'runner-control') {
        if (this.handTrackingIntensity > 0.8) {
          this.triggerHeartbeatEffect();
        }
      }
    } catch (e) {
      console.warn('Ambient effects update failed', e);
    }
  }

  // Clean up resources
  cleanup() {
    try {
      this.audioLayers.clear();
      this.spatialNodes.clear();
      this.dynamicFilters.clear();
      this.activeAudioNodes.forEach(node => {
        try { node.disconnect(); } catch (e) {}
      });
      this.activeAudioNodes.clear();
    } catch (e) {
      console.warn('Audio cleanup failed', e);
    }
  }
}

// Initialize the Fat Responsive Audio Engine
      const fatAudio = new FatResponsiveAudioEngine();
      try { window.fatAudio = fatAudio; } catch(e) {}

// Enhanced playSound function that uses the fat audio system
function playFatSound(soundName, options = {}) {
  try {
    // Update hand tracking intensity for all calls
    if (typeof hands !== 'undefined' && hands) {
      // Get current hand data from last onResults call
      if (window.__handNinja && window.__handNinja._lastMappedHands) {
        fatAudio.updateHandTracking(window.__handNinja._lastMappedHands);
      }
    }
    
    // Use the fat audio system
    fatAudio.playFatSound(soundName, options);
    
  } catch (e) {
    console.warn('Fat audio failed, using fallback', e);
    playSound(soundName);
  }
}

    // Try WebAudio decoded buffers first (lowest latency) with duration control
    if (typeof sfxBuffers !== 'undefined' && sfxBuffers && sfxBuffers[name]) {
      try { 
        const durationLimit = sfxDurationLimits[name];
        if (playSfxWithDuration(name, durationLimit)) return; 
      } catch(e){}
    }

    // Try SimpleAudio fallback with duration control
    const sa = (window.__handNinja && window.__handNinja._simpleAudio) ? window.__handNinja._simpleAudio : null;
    if (sa) {
      try { 
        const durationLimit = sfxDurationLimits[name];
        if (durationLimit) {
          // Create limited duration audio for SimpleAudio
          playSimpleAudioWithDuration(sa, name, durationLimit);
        } else {
          sa.playSfx(name, 1.0);
        }
        return; 
      } catch(e){}
    }

    // HTMLAudio fallback with duration control - ensure we have the sound in soundPool
    const a = soundPool[name];
    if (!a) {
      // Try to find the sound in ASSETS.sfx
      const url = ASSETS && ASSETS.sfx && ASSETS.sfx[name] ? ASSETS.sfx[name] : null;
      if (url) {
        try {
          const inst = new Audio(url);
          inst.volume = 1.0;
          const durationLimit = sfxDurationLimits[name];
          if (durationLimit) {
            // Stop after duration limit
            setTimeout(() => {
              try { inst.pause(); } catch(e){}
            }, durationLimit * 1000);
          }
          inst.play().catch(()=>{});
        } catch(e){}
      }
      return;
    }

    // Clone and play HTMLAudio with duration control
    try {
      const inst = a.cloneNode ? a.cloneNode() : new Audio(a.src);
      inst.muted = false;
      inst.volume = 1.0;
      
      const durationLimit = sfxDurationLimits[name];
      if (durationLimit) {
        // Stop after duration limit
        setTimeout(() => {
          try { 
            inst.pause();
            inst.currentTime = 0;
          } catch(e){}
        }, durationLimit * 1000);
      }
      
      inst.play().catch((err) => {
        console.warn(`Audio play blocked: ${name}`, err);
      });
    } catch(e){}
  } catch(e){
    console.warn('playSound error:', e);
  }
}

function setMusicEnabled(v) {
  // Simplified centralized music toggle:
  // - always persist preference
  // - disabling stops all audio immediately
  // - enabling preloads when idle, starts immediately if a game is running
  try {
    const prev = !!musicEnabled;
    musicEnabled = !!v;
    console.log(`Music toggled: wasEnabled=${prev}, nowEnabled=${musicEnabled}`);
  } catch (e) {
    musicEnabled = !!v;
  }

  // sync UI and persist preference
  try { syncMusicCheckboxes(musicEnabled); } catch (e) {}
  try { localStorage.setItem('hand_ninja_music_enabled', musicEnabled ? '1' : '0'); } catch (e) {}

  // Immediate disable path: stop everything
  if (!musicEnabled) {
    try {
      // Prefer controller stop when available
      const mc = window.__handNinja && window.__handNinja.musicController;
      if (mc && typeof mc.stop === 'function') {
        try { mc.stop({ force: true }); } catch (e) {}
      }
    } catch (e) {}
    try { stopAllAudio(); } catch (e) {}
    try { if (noticeEl) { noticeEl.textContent = 'Music disabled'; setTimeout(() => { noticeEl.textContent = ''; }, 1200); } } catch (e) {}
    return;
  }

  // Enabling: decide between immediate start (if running) or preload-only (if idle)
  const mc = window.__handNinja && window.__handNinja.musicController ? window.__handNinja.musicController : null;
  const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
  const inRoom = !!(roomsState && roomsState.room);
  const isAdmin = !!(roomsState && roomsState.isAdmin);

  if (running) {
    // If a game is actively running, start music now (respecting server/admin policy inside controller).
    try {
      if (mc && typeof mc.setRoomState === 'function') {
        try { mc.setRoomState({ inRoom, isAdmin }); } catch (e) {}
      }
      if (mc && typeof mc.startGame === 'function') {
        mc.startGame().catch(() => {});
      } else {
        // fallback: try decoded play or legacy playSound
        try { ensureAudioCtx(); } catch (e) {}
        if (ASSETS && ASSETS.bgm) {
          decodeBgmBuffer(ASSETS.bgm).then(buf => {
            try {
              if (buf) {
                playDecodedBgm(ASSETS.bgm, { vol: 0.8, loop: true });
              } else {
                playSound('bgm');
              }
            } catch (e) {}
          }).catch(() => { try { playSound('bgm'); } catch (e) {} });
        } else {
          try { playSound('bgm'); } catch (e) {}
        }
      }
      try { if (noticeEl) { noticeEl.textContent = 'Music enabled'; setTimeout(() => { noticeEl.textContent = ''; }, 1400); } } catch (e) {}
    } catch (e) {
      console.warn('Failed to start music on enable', e);
    }
    return;
  }

  // Not running: preload/decode BGM but do not auto-play
  try {
    if (mc && typeof mc.setRoomState === 'function') {
      try { mc.setRoomState({ inRoom, isAdmin }); } catch (e) {}
    }
    if (mc && typeof mc.preload === 'function') {
      mc.preload(ASSETS && ASSETS.bgm).catch(() => {});
    } else if (ASSETS && ASSETS.bgm) {
      // best-effort decode into WebAudio without starting playback
      decodeBgmBuffer(ASSETS.bgm).catch(() => {});
    }
    try { if (noticeEl) { noticeEl.textContent = 'Music enabled — will play when a game starts'; setTimeout(() => { noticeEl.textContent = ''; }, 1800); } } catch (e) {}
  } catch (e) {
    console.warn('Failed to preload BGM on enable', e);
  }
}

/* Deterministic RNG support: allows server-provided seeds for synchronized games.
   Uses a small PRNG (mulberry32) when seeded; falls back to Math.random otherwise. */
let deterministicRng = null;
function mulberry32(a) {
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedRng(seed) {
  try {
    deterministicRng = mulberry32(Number(seed) >>> 0);
  } catch (e) {
    deterministicRng = null;
  }
}
function rand(a, b) {
  if (deterministicRng) return a + deterministicRng() * (b - a);
  return a + Math.random() * (b - a);
}
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }

// Client-side deterministic item generator (matches server generator)
// Returns an array of items: { id, type, x, y, vx, vy, r, spawnTime }
function generateGameItems(gameType, seed) {
  const items = [];
  let s = Number(seed) >>> 0;
  function localRand() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  if (!gameType) gameType = 'ninja-fruit';
    if (gameType === 'ninja-fruit' || gameType === 'fruit' || gameType === 'ninja') {
    // Solo baseline reduced to 25-50 items to avoid overly dense generation.
    // Multiplayer (serverAuthoritative) fallback will apply SERVER_SPAWN_MULTIPLIER
    // so clients generate roughly half (or configured multiplier) of the solo set.
    // Ensure we generate enough items to reasonably cover the whole game duration.
    // Base solo count remains 25-50, but also ensure a minimum based on duration / spawn interval.
    let numItems = 25 + Math.floor(localRand() * 25); // 25-50 items (solo baseline)

    // Compute a duration-based desired minimum so spawns continue throughout the run.
    const gameDurationMs = (typeof gameLengthEl !== 'undefined' && gameLengthEl && Number(gameLengthEl.value))
      ? Math.max(3000, Number(gameLengthEl.value) * 1000)
      : (typeof duration === 'number' ? Math.max(3000, duration * 1000) : 45000);

    try {
      // desired count roughly equals duration divided by fruit spawn interval (allow some slack)
      const desiredByInterval = Math.max(6, Math.ceil(gameDurationMs / Math.max(1200, FRUIT_SPAWN_INTERVAL) * 1.05));
      numItems = Math.max(numItems, desiredByInterval);

      if (typeof serverAuthoritative !== 'undefined' && serverAuthoritative) {
        const adjustedMultiplier = Math.max(0.01, SERVER_SPAWN_MULTIPLIER);
        // Ensure we always generate a small minimum so late-joiners still see some content.
        numItems = Math.max(4, Math.round(numItems * adjustedMultiplier));
      }
    } catch (e) { /* ignore */ }

    for (let i = 0; i < numItems; i++) {
      // In multiplayer fallbacks make bombs rarer
      let isBomb = (localRand() > 0.82);
      try {
        if (typeof serverAuthoritative !== 'undefined' && serverAuthoritative) {
          // reduce bomb frequency for multiplayer fallback (rarer than solo)
          // make bombs even rarer in multiplayer fallbacks to reduce negative UX (approx ~6-8%)
          isBomb = (localRand() > 0.94);
        }
      } catch (e) { /* ignore */ }

      const x = 0.08 + localRand() * 0.84; // normalized X (0..1)
      const y = 1.05; // spawn slightly below bottom (normalized)
      const vx = (localRand() - 0.5) * 0.4; // normalized lateral velocity
      const vy = -0.012 - (localRand() * 0.006); // normalized upward velocity
      const r = 26 + Math.floor(localRand() * 18);

      // Keep most spawns inside the full game duration so items continue appearing until game end
      const spawnWindow = Math.max(3000, Math.floor(gameDurationMs));
      // Distribute items evenly across the spawnWindow with a small per-item jitter.
      const spawnTime = Math.floor((i / Math.max(1, numItems - 1)) * spawnWindow + localRand() * Math.min(500, Math.floor(spawnWindow / Math.max(10, numItems))));
      items.push({
        id: `item_${i}_${String(seed || 0)}`,
        type: isBomb ? 'bomb' : 'fruit',
        x, y, vx, vy, r,
        spawnTime
      });
    }
  }

  return items;
}

// Convert a scheduled item into an in-game object and push to `objects`
function createObjectFromItem(item) {
  try {
    const w = canvas.width / DPR;
    const h = canvas.height / DPR;
    let x = (typeof item.x === 'number') ? item.x : (Math.random() * (w - 60) + 30);
    let y = (typeof item.y === 'number') ? item.y : (h + 20);
    // if normalized coords (0..1-ish), convert to pixels
    if (x <= 1.05 && x >= -0.05) x = x * w;
    if (y <= 2.5) y = y * h;

    // velocities: if provided as small normalized numbers, scale to px/s
    // Accept both server-side names (velX/velY) and client-side (vx/vy).
    // Fall back to random toss if neither provided.
    let vx = (typeof item.vx === 'number') ? item.vx : ((typeof item.velX === 'number') ? item.velX : rand(-220, 220));
    let vy = (typeof item.vy === 'number') ? item.vy : ((typeof item.velY === 'number') ? item.velY : rand(-1600, -1100));

    // If server provided normalized small velocities (0..1), scale them to px/s.
    if (Math.abs(vx) <= 1.0) vx = vx * Math.max(120, w * 0.6);
    // For vy also map small normalized values to a playable upward velocity.
    if (Math.abs(vy) <= 1.0) {
      vy = (typeof serverAuthoritative !== 'undefined' && serverAuthoritative) ? rand(-1200, -900) : rand(-1600, -1100);
    }

    // Honor an optional per-item gravity multiplier provided by the server.
    // Store a gravityFactor on the object which the physics loop will consult.
    const gravityFactor = (typeof item.gravity === 'number' && isFinite(item.gravity)) ? Number(item.gravity) : null;

    const r = Number(item.r) || randInt(28, 44);

    const obj = {
      id: item.id || (crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
      type: item.type === 'bomb' ? 'bomb' : 'fruit',
      x, y, vx, vy,
      r,
      ang: rand(0, Math.PI * 2),
      spin: rand(-3, 3),
      color: item.color || `hsl(${randInt(10,140)},70%,55%)`,
      sprite: item.sprite || null,
      sliced: false
    };

    if (obj.type === 'bomb') {
      obj.color = item.color || '#111';
      obj.fusePhase = Math.random() * Math.PI * 2;
    }

    objects.push(obj);
    return obj;
  } catch (e) {
    console.warn('createObjectFromItem failed', e);
    return null;
  }
}

/*
  Process scheduledGameItems against a wall-clock timestamp (Date.now()).
  Throttle actual creation to avoid huge bursts when many scheduled items become due
  (common when joining late or when authoritative server emits many items at once).
  Also respect conservative per-type concurrency caps when running in server-authoritative mode.
*/
function processScheduledSpawns(nowMs) {
  try {
    if (!serverStartEpoch || !Array.isArray(scheduledGameItems) || scheduledGameItems.length === 0) return;

    // per-frame spawn cap to avoid huge simultaneous bursts
    let spawnedThisFrame = 0;
    // In multiplayer (server-authoritative) reduce the burst allowance so late-join floods
    // don't create large simultaneous bursts. In solo play allow a slightly larger per-frame burst.
    const MAX_SPAWN_PER_FRAME = (serverAuthoritative) ? 1 : 3; // tuneable: how many scheduled items we allow to create per frame

    // track how many of each type we spawned this frame to compute "current" count with pending spawns
    const spawnedThisFrameForType = { fruit: 0, bomb: 0 };

    // current on-screen counts (base)
    const currFruitCount = objects.filter(o => o.type === 'fruit').length;
    const currBombCount = objects.filter(o => o.type === 'bomb').length;

    for (const it of scheduledGameItems) {
      if (spawnedThisFrame >= MAX_SPAWN_PER_FRAME) break;
      if (!it || it._spawned) continue;
      const spawnAt = (typeof it.spawnTime === 'number') ? (serverStartEpoch + Number(it.spawnTime)) : null;
      if (!spawnAt) continue;
      if (nowMs < spawnAt) continue;

      // determine type and effective cap
      const type = (it.type === 'bomb') ? 'bomb' : 'fruit';
      const baseMax = (type === 'fruit') ? MAX_FRUITS : MAX_BOMBS;
      // Apply server-authoritative multiplier to reduce on-screen concurrency for multiplayer rooms.
      const effectiveMax = (serverAuthoritative)
        // Ensure multiplayer caps are reduced but never drop to 0 when the base cap is > 0.
        // Use a slightly higher minimum so gameplay doesn't starve (keep at least 2 when baseMax > 0).
        ? Math.max((baseMax > 0 ? 2 : 0), Math.floor(baseMax * SERVER_SPAWN_MULTIPLIER))
        : baseMax;

      // compute current count including the spawns we will make this frame
      // (use the safe per-type counters; guard against legacy typos)
      const currentCountSafe = (type === 'fruit')
        ? (currFruitCount + (spawnedThisFrameForType.fruit || 0))
        : (currBombCount + (spawnedThisFrameForType.bomb || 0));

      // If we already reached the cap for this type, defer spawning (leave _spawned false so it will be retried later)
      if (currentCountSafe >= effectiveMax) {
        continue;
      }

      // create object and mark spawned
      createObjectFromItem(it);
      it._spawned = true;
      spawnedThisFrame++;
      spawnedThisFrameForType[type] = (spawnedThisFrameForType[type] || 0) + 1;
    }
  } catch (e) {
    console.warn('processScheduledSpawns error', e);
  }
}

// Resize canvas to match window
function resizeCanvas() {
  canvas.width = Math.floor(canvas.clientWidth * DPR);
  canvas.height = Math.floor(canvas.clientHeight * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();

// Pointer/tap support: allow direct tapping on fruits/bombs to slice (improves touch UX)
try {
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    // map CSS pixels -> canvas logical pixels (account for DPR and potential CSS scaling)
    const x = (cssX * (canvas.width / rect.width)) / DPR;
    const y = (cssY * (canvas.height / rect.height)) / DPR;

    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i];
      if (!obj) continue;
      const dx = obj.x - x;
      const dy = obj.y - y;
      if (Math.hypot(dx, dy) <= (obj.r || 0) + HIT_PADDING) {
        try { handleHit(obj, { x, y }); } catch (e) {}
        try { e.preventDefault(); } catch (e) {}
        break;
      }
    }
  }, { passive: false });
} catch (e) {}

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
  // TRUE MIRROR MODE: Force mirror transformation for all hand landmarks to match camera
  return landmarks.map(lm => {
    const lx = (typeof lm.x === 'number') ? lm.x : 0;
    const ly = (typeof lm.y === 'number') ? lm.y : 0;
    // Always apply mirror flip (1 - lx) to match the forced camera mirror mode
    const px = 1 - lx;
    return {
      x: t.dx + px * iw * t.scale,
      y: t.dy + ly * ih * t.scale,
      z: lm.z
    };
  });
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
 function spawnFruit(opts) {
   opts = opts || {};
   // Reduce local spawn caps when running in server-authoritative (multiplayer) mode.
   // If forceLocal is set, treat this spawn as a local fallback and use normal local caps.
   const effectiveMax = (serverAuthoritative && !opts.forceLocal)
     // In multiplayer reduce visible fruits but keep at least two when base cap > 0 to avoid starvation.
     ? Math.max((MAX_FRUITS > 0 ? 2 : 0), Math.floor(MAX_FRUITS * SERVER_SPAWN_MULTIPLIER))
     : MAX_FRUITS;
   if ((objects.filter(o => o.type === 'fruit').length) >= effectiveMax) return;

  const radius = randInt(28, 44);
  const x = rand(radius, canvas.width / DPR - radius);
  const y = canvas.height / DPR + radius + 10;
  const vx = rand(-220, 220);
  // slightly gentler upward throw on multiplayer fallbacks to reduce clutter
  const vy = serverAuthoritative ? rand(-1200, -900) : rand(-1600, -1100);
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

 function spawnBomb(opts) {
   opts = opts || {};
   // Reduce bomb concurrency in multiplayer/fallback cases.
   // If forceLocal is set, use normal local caps so fallback spawns can show a playable number of bombs.
   const effectiveMax = (serverAuthoritative && !opts.forceLocal)
     // In multiplayer reduce visible bombs but keep at least two when base cap > 0 to avoid starvation.
     ? Math.max((MAX_BOMBS > 0 ? 2 : 0), Math.floor(MAX_BOMBS * SERVER_SPAWN_MULTIPLIER))
     : MAX_BOMBS;
   if ((objects.filter(o => o.type === 'bomb').length) >= effectiveMax) return;

  const radius = randInt(26, 36);
  const x = rand(radius, canvas.width / DPR - radius);
  const y = canvas.height / DPR + radius + 10;
  const vx = rand(-150, 150);
  // slightly gentler upward throw for bombs in multiplayer fallback
  const vy = serverAuthoritative ? rand(-1200, -900) : rand(-1600, -1100);
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

  // Stabilize brightness by applying a subtle filter (prevent flickering)
  ctx.save();
  ctx.filter = 'brightness(1.02) contrast(1.05)'; // Slight stabilization

  // TRUE MIRROR MODE: Force horizontal flip for consistent mirror behavior like a real mirror
  ctx.translate(t.dx, t.dy);
  ctx.scale(t.scale, t.scale);
  // Always force mirror - left/right swapped like a real mirror regardless of camera or MediaPipe settings
  ctx.translate(iw, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(image, 0, 0, iw, ih);
  ctx.restore();

  // Reset filter for other rendering
  ctx.filter = 'none';
}

function drawObjects(dt) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    // physics
    // Per-object gravity: if an object carries a gravityFactor (from server), apply it as a multiplier.
    const gMult = (typeof o.gravityFactor === 'number' && isFinite(o.gravityFactor)) ? Number(o.gravityFactor) : 1;
    o.vy += GRAVITY * gMult * dt;
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
  const _nowParticle = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  // particle freeze window: suppress new bursts for a short window after heavy trace events
  if (window.__handNinja && window.__handNinja._lastParticleFreeze && _nowParticle - window.__handNinja._lastParticleFreeze < 220) return;
  // suppress heavy particles entirely during shape-trace to avoid hitches
  if (currentGameId === 'shape-trace') return;

  // allow callers to request a reduced burst (e.g. { source: 'shape-trace' })
  const isShapeTrace = !!(opts && opts.source === 'shape-trace');

  // reduce default counts on touch/mobile to preserve CPU/battery
  const isTouch = (typeof window !== 'undefined') && (('ontouchstart' in window) || (navigator && navigator.maxTouchPoints > 0));
  if (isTouch && !isShapeTrace) {
    count = Math.min(count, 6);
  }
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

  // scale velocities/lifetimes for mobile to be cheaper
  const mobileScale = isTouch ? 0.6 : 1;

  for (let i=0;i<count;i++){
    // smaller, shorter-lived, and lower-velocity particles for shape-trace (if any)
    const p = {
      x, y,
      vx: isShapeTrace ? rand(-80,80) * mobileScale : rand(-320,320) * mobileScale,
      vy: isShapeTrace ? rand(-160, -40) * mobileScale : rand(-320, -80) * mobileScale,
      life: isShapeTrace ? rand(0.12, 0.28) * mobileScale : rand(0.35, 0.9) * Math.max(0.45, mobileScale),
      col: color || 'white',
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

  // Ensure popup text is always a sensible string (avoid `undefined`, `null` or "?" artifacts)
  let popupText = '';
  try {
    if (typeof text === 'number') popupText = String(text);
    else if (typeof text === 'string') popupText = text.trim();
    else if (text === null || typeof text === 'undefined') popupText = '';
    else popupText = String(text);

    // Normalize ambiguous single-character or punctuation-only placeholders into 'Miss'.
    // Preserve score-like strings (e.g. "+10", "-5") and numeric strings.
    try {
      const tnorm = popupText.trim();
      if (tnorm === '?') popupText = 'Miss';
      else if (/^[^0-9A-Za-z+\-]{1,3}$/.test(tnorm)) popupText = 'Miss';
    } catch (innerE) { /* ignore normalization errors */ }

  } catch (e) { popupText = ''; }
  // Do not spawn empty popups
  if (!popupText || popupText.trim().length === 0) return;

  popups.push({
    x, y,
    text: popupText,
    vx: rand(-40,40),
    vy: rand(-120, -40),
    life: opts.life || 0.9,
    age: 0,
    col: opts.col || 'white',
    size: opts.size || 18
  });

  // play a brief popup SFX when available (only if asset present)
  try { if (ASSETS && ASSETS.sfx && ASSETS.sfx.popup) playSound('popup'); } catch(e){}

  // quick HUD pulse for score element to give tactile feedback
  try {
    if (typeof scoreEl !== 'undefined' && scoreEl && scoreEl.classList) {
      scoreEl.classList.add('pulse');
      setTimeout(() => { try { scoreEl.classList.remove('pulse'); } catch(e){} }, 360);
    }
  } catch(e){}
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
  // Deduplicate rapid hits / in-flight interactions
  if (obj.sliced || obj._tentativeRemove || obj._pendingInteraction) return;

  // Helper to format optimistic popup text consistently
  const formatDelta = (delta) => (delta > 0) ? `+${delta}` : `${delta}`;

  // Server-authoritative optimistic flow
  if (serverAuthoritative) {
    const canSend = !!(window.NET && typeof window.NET.sendInteractionImmediate === 'function');

    // coords
    const cw = canvas.width / DPR;
    const ch = canvas.height / DPR;
    const hx = (hitPoint && typeof hitPoint.x === 'number') ? hitPoint.x : obj.x;
    const hy = (hitPoint && typeof hitPoint.y === 'number') ? hitPoint.y : obj.y;
    const nx = Math.max(0, Math.min(1, hx / cw));
    const ny = Math.max(0, Math.min(1, hy / ch));
    const fx = hx, fy = hy;

    const optimisticDelta = (obj.type === 'bomb') ? -20 : 10;
    const optimisticPopupText = formatDelta(optimisticDelta);

    // Apply optimistic visual + score immediately
    obj._pendingInteraction = !!canSend;
    obj._optimisticScore = optimisticDelta;
    score = Math.max(0, score + optimisticDelta);
    updateUI();

    // Mark sliced locally to prevent duplicate hits and give immediate visual feedback.
    // We remove the object locally shortly after to keep UX responsive; the server will
    // still reconcile authoritative state and scores.
    try {
      obj.sliced = true;
      setTimeout(() => {
        try {
          const idx = objects.findIndex(o => o.id === obj.id);
          if (idx !== -1) objects.splice(idx, 1);
        } catch (e) {}
      }, 80);
    } catch (e) {}

    // visual/audio feedback
    if (obj.type === 'bomb') {
      spawnParticles(fx, fy, 'rgba(255,80,80,0.95)', 12);
      spawnPopup(fx, fy, optimisticPopupText, { col: 'rgba(255,80,80,0.95)', size: 18 });
      try { playSound('bomb'); } catch(e){}
    } else {
      spawnParticles(fx, fy, 'rgba(255,255,255,0.95)', 8);
      spawnPopup(fx, fy, optimisticPopupText, { col: 'rgba(255,240,200,1)', size: 16 });
      try { playSound('slice'); } catch(e){}
    }

    obj._tentativeRemove = true;

    // If we cannot reach server, resolve locally (keep optimistic score)
    if (!canSend) {
      try {
        obj.sliced = true;
        setTimeout(() => {
          const idx = objects.findIndex(o => o.id === obj.id);
          if (idx !== -1) objects.splice(idx, 1);
        }, 80);
      } catch (e) {}
      return;
    }

    // Send interaction intent with tolerant reconciliation
    try {
      // safety timer to avoid permanent pending state
      try {
        obj._optimisticTimer = setTimeout(() => {
          if (obj && obj._pendingInteraction) {
            obj._pendingInteraction = false;
            obj._optimisticTimer = null;
          }
        }, 5000);
      } catch (e) {}

      NET.sendInteractionImmediate({ objectId: obj.id, x: nx, y: ny }, (res) => {
        obj._pendingInteraction = false;
        try { clearTimeout(obj._optimisticTimer); } catch(e){}

        // No server response -> keep optimistic result (avoid false "Miss" on flaky networks)
        if (!res) {
          updateUI();
          return;
        }

        // Explicit success from server -> adopt authoritative score if provided
        if (res && res.ok === true) {
          if (typeof res.score === 'number') {
            score = Number(res.score);
            updateUI();
          } else {
            updateUI();
          }
          obj._optimisticScore = 0;
          return;
        }

        // If server returned a non-success but we're in server-authoritative multiplayer,
        // be tolerant: keep optimistic visuals/score to avoid confusing "Miss" for players.
        // Preserve the optimistic popup/score and simply clear the pending flag so the UI
        // does not revert to a confusing "Miss" or a fallback '?' label on flaky networks.
        if (serverAuthoritative) {
          try { clearTimeout(obj._optimisticTimer); } catch (e) {}
          // Clear the pending flag but keep tentative remove/sliced state so optimistic visuals remain.
          obj._pendingInteraction = false;
          // Do NOT flip _tentativeRemove or obj.sliced here; they represent the optimistic visual state.
          // Leave obj._optimisticScore intact so the score display/popup persists until authoritative confirmation.
          updateUI();
          return;
        }

        // Non-authoritative flows: preserve previous "not found" tolerant logic, otherwise revert and show Miss
        const reason = (res.reason || res.message || '').toString().toLowerCase();
        const code = (res.code || '').toString().toLowerCase();
        const status = Number(res.status || res.statusCode || 0);
        const treatAsNotFound = (typeof reason === 'string' && /not\s*found|unknown|missing/i.test(reason)) ||
                                (typeof code === 'string' && /not[_-]?found|unknown|missing|unknown_object/i.test(code)) ||
                                status === 404 || status === 410;

        if (treatAsNotFound) {
          try {
            obj.sliced = true;
            setTimeout(() => {
              const idx2 = objects.findIndex(o => o.id === obj.id);
              if (idx2 !== -1) objects.splice(idx2, 1);
            }, 80);
          } catch (e) {}
          try { clearTimeout(obj._optimisticTimer); } catch(e){}
          obj._pendingInteraction = false;
          obj._tentativeRemove = false;
          updateUI();
          return;
        }

        // Genuine rejection in non-authoritative mode: undo optimistic score and show Miss only when server explicitly rejected.
        try {
          const optimistic = Number(obj._optimisticScore || 0);
          if (optimistic && typeof score === 'number') {
            score = Math.max(0, Math.round(score - optimistic));
          }
        } catch (e) {}
        obj._tentativeRemove = false;
        obj._optimisticScore = 0;
        obj.sliced = false;
        // Only display a visible "Miss" when the server provided an explicit rejection payload.
        // Avoid showing "Miss" on flaky/absent responses to prevent confusing UX.
        const serverRejected = (res && (res.ok === false || (res.status && Number(res.status) >= 400) || res.reason || res.code));
        if (serverRejected) {
          spawnPopup(fx, fy, 'Miss', { col: 'red', size: 14 });
          try { playSound('wrong'); } catch (e) {}
        } else {
          // Silent revert: keep UX calm on ambiguous/falsy responses
          try { playSound && playSound('wrong'); } catch(e) { /* but avoid popup */ }
        }
        updateUI();
      });
    } catch (e) {
      // synchronous send error -> fallback to local removal but keep optimistic visuals/score
      obj._pendingInteraction = false;
      try { clearTimeout(obj._optimisticTimer); } catch (e) {}
      try {
        obj.sliced = true;
        setTimeout(() => {
          const idx = objects.findIndex(o => o.id === obj.id);
          if (idx !== -1) objects.splice(idx, 1);
        }, 80);
      } catch (e) {}
      updateUI();
    }

    return;
  }

  // Local non-authoritative flow
  obj.sliced = true;
  const fx = (hitPoint && hitPoint.x) ? hitPoint.x : obj.x;
  const fy = (hitPoint && hitPoint.y) ? hitPoint.y : obj.y;

  if (obj.type === 'bomb') {
    score = Math.max(0, score - 20);
    spawnParticles(fx, fy, 'rgba(255,80,80,0.95)', 18);
    spawnPopup(fx, fy, '-20', { col: 'rgba(255,80,80,0.95)', size: 20 });
    flashNotice('-20 (bomb)');
    playSound('bomb');
  } else {
    score += 10;
    spawnParticles(fx, fy, 'rgba(255,255,255,0.95)', 12);
    spawnPopup(fx, fy, '+10', { col: 'rgba(255,240,200,1)', size: 18 });
    playSound('slice');
  }

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
  // Keep score display focused on local score only.
  try {
    scoreEl.textContent = `Score: ${score}`;
  } catch (e) {
    try { scoreEl.textContent = `Score: ${score}`; } catch(e){}
  }

  try {
    // When in a room/server-authoritative flow, send periodic score updates to server (throttled).
    if (serverAuthoritative && window.NET && typeof window.NET.sendScore === 'function') {
      const now = Date.now();
      if (!updateUI._lastSent || (now - updateUI._lastSent) > 800) {
        try { window.NET.sendScore(score); } catch(e){ /* best-effort */ }
        updateUI._lastSent = now;
      }
    }
  } catch(e) { /* ignore UI send errors */ }

  // Show Leave Game button when game is running (both single player and multiplayer)
  try {
    const leaveGameBtn = document.getElementById('leaveGameBtn');
    if (leaveGameBtn) {
      if (running) {
        leaveGameBtn.style.display = 'inline-block';
      } else {
        leaveGameBtn.style.display = 'none';
      }
    }
  } catch(e) { /* ignore */ }
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

    // ensure a persistent local client id so we can reliably attribute scores across name changes
    let clientId = null;
    try {
      clientId = localStorage.getItem('hand_ninja_client_id');
      if (!clientId) {
        clientId = 'c_' + Math.random().toString(36).slice(2,9);
        localStorage.setItem('hand_ninja_client_id', clientId);
      }
    } catch (e) {
      clientId = 'c_' + Math.random().toString(36).slice(2,9);
    }

    // persist locally (compact + dedupe) so offline clients still have a view
    const list = loadLeaders(gid) || [];
    list.push({ name, score, date: Date.now(), game: gid, clientId });

    // Dedupe primarily by clientId (if available), otherwise by normalized name.
    const bestByKey = {};
    for (const e of list) {
      if (!e) continue;
      const rawName = String(e.name || 'Player').trim() || 'Player';
      const key = (e.clientId) ? `id:${e.clientId}` : `name:${rawName.toLowerCase()}`;
      const sc = Number(e.score) || 0;
      if (!bestByKey[key] || sc > bestByKey[key].score) {
        bestByKey[key] = { name: rawName, score: sc, date: e.date || Date.now(), game: gid, clientId: e.clientId || null };
      }
    }

    const compact = Object.values(bestByKey).sort((a,b) => b.score - a.score).slice(0,30);
    localStorage.setItem(storageKey(gid), JSON.stringify(compact));
    console.info(`saveLeader -> key=${storageKey(gid)}, name=${name}, score=${score}, total=${compact.length}, clientId=${clientId}`);

    // Attempt to publish to server-side global leaderboard (non-blocking).
    // Include clientId so server can map identities reliably (when supported).
    try {
      const payload = { game: gid, name, score, clientId };
      if (window.NET && typeof window.NET.postScore === 'function') {
        window.NET.postScore(payload, (res) => {
          if (res && res.ok === false) console.warn('server leaderboard post failed', res);
        });
      } else {
        // fallback REST POST if NET not present
        fetch(`/leaderboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json()).then(j => {
          // ignore response; server may emit leaderboard_update via socket if connected
        }).catch(()=>{ /* ignore */ });
      }
    } catch (e) {
      console.warn('publish leader to server failed', e);
    }
  } catch(e){
    console.warn('saveLeader failed', e);
  }
}
async function showLeaders() {
  try {
    // prefer the selector value so leaderboard always reflects the chosen game
    const sel = document.getElementById('gameSelect');
    const shownGame = (sel && sel.value) ? sel.value : currentGameId;
    const h = leaderboardEl.querySelector('h3');
    if (h) h.textContent = `Leaderboard — ${shownGame}`;
  } catch(e){}

  leaderboardEl.style.display = 'flex';
  const selForList = (document.getElementById('gameSelect') && document.getElementById('gameSelect').value) ? document.getElementById('gameSelect').value : currentGameId;

  const topEl = document.getElementById('leadersTop');
  if (topEl) topEl.innerHTML = '';

  // Try server-first: prefer global leaderboard if available
  try {
    let serverData = null;
    if (window.NET && typeof window.NET.fetchLeaderboard === 'function') {
      serverData = await window.NET.fetchLeaderboard(selForList).catch(()=>null);
    } else {
      serverData = await fetch(`/leaderboard?game=${encodeURIComponent(selForList)}`).then(r => r.ok ? r.json() : null).catch(()=>null);
    }
    if (serverData && (serverData.leaders || Array.isArray(serverData))) {
      const leaders = serverData.leaders || serverData;
      if (!leaders || leaders.length === 0) {
        const li = document.createElement('li');
        li.className = 'leader-row';
        const r = document.createElement('span'); r.className = 'rank'; r.textContent = '-';
        const n = document.createElement('span'); n.className = 'name'; n.textContent = 'No leaders yet';
        const s = document.createElement('span'); s.className = 'leader-score'; s.textContent = '-';
        li.appendChild(r); li.appendChild(n); li.appendChild(s);
        topEl.appendChild(li);
        return;
      }
      // server returns list already sorted; display top 10
      const top = (leaders.slice ? leaders.slice(0, 10) : leaders).map((e) => ({ name: e.name || 'Player', score: Number(e.score) || 0 }));
      for (let i = 0; i < top.length; i++) {
        const entry = top[i];
        const li = document.createElement('li');
        li.className = 'leader-row';
        const r = document.createElement('span'); r.className = 'rank'; r.textContent = `${i+1}.`;
        const n = document.createElement('span'); n.className = 'name'; n.textContent = entry.name || 'Player';
        const s = document.createElement('span'); s.className = 'leader-score'; s.textContent = String(entry.score || 0);
        li.appendChild(r); li.appendChild(n); li.appendChild(s);
        topEl.appendChild(li);
      }
      return;
    }
  } catch (e) {
    console.warn('server leaderboard fetch failed, falling back to local', e);
  }

  // Fallback to localStorage if server unavailable
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

  if (!top || top.length === 0) {
    const li = document.createElement('li');
    li.className = 'leader-row';
    const r = document.createElement('span'); r.className = 'rank'; r.textContent = '-';
    const n = document.createElement('span'); n.className = 'name'; n.textContent = 'No leaders yet';
    const s = document.createElement('span'); s.className = 'leader-score'; s.textContent = '-';
    li.appendChild(r); li.appendChild(n); li.appendChild(s);
    topEl.appendChild(li);
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
  // Suppress noisy MediaPipe / WebGL initialization logs for a short grace period.
  // This installs a narrow console filter to absorb known benign messages emitted
  // asynchronously during WASM/WebGL backend startup. A developer toggle is exposed
  // so suppression can be disabled when debugging.
  if (!window.__handNinja) window.__handNinja = {};
  // developer flag: when true, do not hide MediaPipe logs (useful during debugging)
  window.__handNinja.__DEV_SHOW_MEDIAPIPE_LOGS = window.__handNinja.__DEV_SHOW_MEDIAPIPE_LOGS || false;
  // optional persistent suppression flag (if set externally, keep suppression active)
  window.__handNinja.__KEEP_MEDIAPIPE_SUPP = window.__handNinja.__KEEP_MEDIAPIPE_SUPP || false;

  const _orig = { warn: console.warn, info: console.info, log: console.log };
  const _filterRE = /gl_context|WEBGL_polygon_mode|I0000|gl_context_webgl|gl_context.cc|OpenGL error checking is disabled/;

  function installFilter() {
    console.warn = function(...args){ try { if (!window.__handNinja.__DEV_SHOW_MEDIAPIPE_LOGS && typeof args[0] === 'string' && _filterRE.test(args[0])) return; } catch(e){} return _orig.warn.apply(console, args); };
    console.info = function(...args){ try { if (!window.__handNinja.__DEV_SHOW_MEDIAPIPE_LOGS && typeof args[0] === 'string' && _filterRE.test(args[0])) return; } catch(e){} return _orig.info.apply(console, args); };
    console.log = function(...args){ try { if (!window.__handNinja.__DEV_SHOW_MEDIAPIPE_LOGS && typeof args[0] === 'string' && _filterRE.test(args[0])) return; } catch(e){} return _orig.log.apply(console, args); };
  }
  function restoreConsole() {
    try { console.warn = _orig.warn; console.info = _orig.info; console.log = _orig.log; } catch (e) {}
  }

  // install filter to cover constructor + a short async grace window
  installFilter();

  // Grace period to cover asynchronous messages from WASM/WebGL initialization.
  // After this timeout the console is restored unless a persistent suppression flag is set.
  const GRACE_MS = 2500;
  let restoreTimeout = null;

  // Helpers exposed for developers to toggle/control suppression at runtime.
  window.__handNinja.toggleMediapipeLogSuppression = function(showLogs, keepSuppressed = false) {
    try {
      // showLogs === true -> allow logs to pass through (disable filtering)
      window.__handNinja.__DEV_SHOW_MEDIAPIPE_LOGS = !!showLogs;
      window.__handNinja.__KEEP_MEDIAPIPE_SUPP = !!keepSuppressed;
      if (showLogs) {
        // re-install filter wrappers so their internal check will pass through messages
        installFilter();
      } else {
        // install filter (it will block matching messages)
        installFilter();
      }
      // if keepSuppressed is false and showLogs is true, restore immediately
      if (showLogs && !keepSuppressed) {
        restoreConsole();
      }
    } catch (e) { /* ignore */ }
  };
  window.__handNinja.restoreMediapipeLogsNow = function() {
    try {
      if (restoreTimeout) { clearTimeout(restoreTimeout); restoreTimeout = null; }
      restoreConsole();
    } catch (e) {}
  };

    try {
    const h = new Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });

    // Force TRUE MIRROR MODE - Flip video at canvas level + coordinate fix
    let selfieMode = false; // Don't use MediaPipe selfieMode
    try {
      console.log('👁️ USING TRUE MIRROR MODE: Video flipped at canvas level');
      console.log('✋ Hand coordinates will be adjusted for natural mirror movement');
    } catch (e) {
      console.warn('Mirror mode setup error:', e);
    }

    h.setOptions({
      selfieMode: !!selfieMode,
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5
    });

    // record the MediaPipe "selfieMode" choice so receivers can know whether the sender used a mirrored camera.
    try { 
      if (!window.__handNinja) window.__handNinja = {};
      window.__handNinja.handsSelfieMode = !!selfieMode;
    } catch(e){}
    h.onResults(onResults);

    // schedule restore after grace period unless persistent suppression requested
    try {
      restoreTimeout = setTimeout(() => {
        try {
          if (!window.__handNinja.__KEEP_MEDIAPIPE_SUPP) restoreConsole();
        } catch (e) {}
      }, GRACE_MS);
    } catch (e) {}

    return h;
  } catch (err) {
    // Ensure console restored if constructor throws
    try { if (restoreTimeout) { clearTimeout(restoreTimeout); restoreTimeout = null; } } catch(e){}
    restoreConsole();
    throw err;
  }
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

    // Only attempt to send a video frame if we have a valid video image available.
    // This prevents MediaPipe/WASM/WebGL errors caused by zero-size ROIs when the
    // video element isn't ready (readyState < HAVE_CURRENT_DATA) or has zero
    // intrinsic dimensions.
    if (hands && typeof hands.send === 'function') {
      const hasVideoFrame = (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0);
      if (hasVideoFrame) {
        try {
          try { console.debug && console.debug('hands before send', hands && (typeof hands === 'object' ? Object.keys(hands) : typeof hands)); } catch(e){}
          await hands.send({ image: videoEl });
          cameraController.errCount = 0;
        } catch (e) {
          cameraController.errCount = (cameraController.errCount || 0) + 1;
          try { console.warn('hands.send error', e && (e.stack || e)); } catch(ex){}
          // aggressive recovery: attempt to recreate Hands sooner with a small backoff to avoid thrash.
          const nowTs = Date.now();
          cameraController._lastErrTs = cameraController._lastErrTs || 0;
          cameraController._lastRecreateTs = cameraController._lastRecreateTs || 0;
          const sinceLastRecreate = nowTs - (cameraController._lastRecreateTs || 0);
          const shouldRecreate = (cameraController.errCount >= 1 && sinceLastRecreate > 3000) || (cameraController.errCount >= 3);
          if (shouldRecreate) {
            try {
              if (hands && typeof hands.close === 'function') {
                // try async close if available
                if (hands.close.constructor && hands.close.constructor.name === 'AsyncFunction') {
                  try { await hands.close(); } catch(errClose){ console.warn('hands.close async failed', errClose); }
                } else {
                  try { hands.close(); } catch(errClose){ console.warn('hands.close failed', errClose); }
                }
              }
            } catch(errClose) { console.warn('hands.close threw', errClose); }
            try {
              hands = makeHands();
              cameraController._lastRecreateTs = Date.now();
              console.info('Recreated Hands instance after send error');
            } catch(errMake) {
              console.warn('makeHands failed during recreate', errMake && (errMake.stack || errMake));
            }
            cameraController.errCount = 0;
          }
        }
      } else {
        // Skip sending this frame when there's no valid video frame available.
        // Do not increment errCount so transient readiness delays don't trigger recreation.
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

// Control helpers: disable/enable menu controls until camera preview ready
function setMenuControlsEnabled(enabled) {
  try {
    // keep primary navigation controls toggled, but always allow the music checkbox
    const elems = [menuStartBtn, showLeadersBtn, gameSel, gameLengthEl, playerNameEl];
    elems.forEach(el => {
      if (!el) return;
      try {
        el.disabled = !enabled;
        el.style.opacity = enabled ? '1' : '0.5';
        el.style.pointerEvents = enabled ? 'auto' : 'none';
      } catch(e){}
    });
    // Ensure music checkbox remains interactive in the menu so users can toggle music
    try {
      if (uiMusicCheckbox) {
        uiMusicCheckbox.disabled = false;
        uiMusicCheckbox.style.opacity = '1';
        uiMusicCheckbox.style.pointerEvents = 'auto';
      }
    } catch(e){}
  } catch(e){}
}

// Initialize camera and MediaPipe immediately after permission granted
// Keep buttons disabled until both camera and MediaPipe are fully working and hands detected
async function warmCameraWithMediaPipe(timeoutMs = 8000) {
  try {
    setMenuControlsEnabled(false);
    try { noticeEl.textContent = 'Initializing camera and hand tracking — please allow access'; } catch(e){}

    if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      try { noticeEl.textContent = 'Camera not supported on this device'; } catch(e){}
      return;
    }

    // Get camera permission and stream
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false, signal: controller.signal });
      clearTimeout(to);
    } catch (e) {
      clearTimeout(to);
      console.warn('camera getUserMedia failed', e);
      try { noticeEl.textContent = 'Camera permission required — click Play and allow access'; } catch(e){}
      setMenuControlsEnabled(true); // Allow music toggle even without camera
      const retry = () => {
        try { warmCameraWithMediaPipe().catch(()=>{}); } catch(e){}
        try { document.removeEventListener('pointerdown', retry); } catch(e){}
        try { document.removeEventListener('touchstart', retry); } catch(e){}
      };
      document.addEventListener('pointerdown', retry, { once: true, passive: true });
      document.addEventListener('touchstart', retry, { once: true, passive: true });
      return;
    }

    window.__handNinja = window.__handNinja || {};
    window.__handNinja._sharedStream = stream;
    try { videoEl.srcObject = stream; } catch(e){}

    // Wait for video to be ready
    await new Promise((res, rej) => {
      let settled = false;
      const onPlay = () => { if (settled) return; settled = true; res(); };
      const onLoaded = () => { if (settled) return; settled = true; res(); };
      const onErr = (ev) => { if (settled) return; settled = true; rej(ev || new Error('video play failed')); };
      videoEl.addEventListener('playing', onPlay, { once: true });
      videoEl.addEventListener('loadeddata', onLoaded, { once: true });
      videoEl.addEventListener('error', onErr, { once: true });
      try { videoEl.play().catch(()=>{}); } catch(e){}
      setTimeout(() => { if (!settled) { settled = true; res(); } }, 1200);
    });

    try { noticeEl.textContent = 'Camera ready — initializing hand tracking...'; } catch(e){}

    // Initialize MediaPipe Hands immediately
    if (!hands) hands = makeHands();
    
    // Start camera processing immediately
    await startCamera();

    try { noticeEl.textContent = 'Hand tracking initialized — move your hands to test...'; } catch(e){}

    // Wait for MediaPipe to actually detect hands before enabling controls
    let handsDetected = false;
    let handDetectionTimeout = null;
    let handDetectionAttempts = 0;
    const MAX_HAND_DETECTION_ATTEMPTS = 30; // 30 frames = ~1 second at 30fps
    
    // Create a temporary onResults handler to detect hands
    // NOTE: Hands exposes onResults(fn) to register a callback; it does not provide a getter.
    // Use the module-level `onResults` handler as the original callback to avoid calling the setter as if it were the handler.
    const originalOnResults = (typeof onResults === 'function') ? onResults : null;
    const testHandDetection = (results) => {
      // Call original handler to keep video flowing (best-effort)
      try { if (typeof originalOnResults === 'function') originalOnResults(results); } catch(e){ /* ignore */ }
      
      handDetectionAttempts++;
      
      // Check if hands are detected
      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        if (!handsDetected) {
          handsDetected = true;
          clearTimeout(handDetectionTimeout);
          
          // Restore normal onResults and enable controls
          try { if (hands && typeof originalOnResults === 'function') hands.onResults(originalOnResults); } catch(e){ /* ignore */ }
          
          setMenuControlsEnabled(true);
          try { noticeEl.textContent = 'Ready! Hand tracking is working. Select a game and press Play.'; } catch(e){}
        }
      } else if (handDetectionAttempts >= MAX_HAND_DETECTION_ATTEMPTS && !handsDetected) {
        // After enough frames without hands, enable controls anyway
        handsDetected = true; // Prevent multiple triggers
        clearTimeout(handDetectionTimeout);
        
        // Restore normal onResults and enable controls
        try { if (hands && typeof originalOnResults === 'function') hands.onResults(originalOnResults); } catch(e){ /* ignore */ }
        
        setMenuControlsEnabled(true);
        try { noticeEl.textContent = 'Ready! (Move your hands in front of camera to test hand tracking)'; } catch(e){}
      }
    };

    // Set the test handler (register temporary detector)
    try { if (hands) hands.onResults(testHandDetection); } catch(e){}

    // Set timeout to enable controls even if no hands detected (longer fallback)
    handDetectionTimeout = setTimeout(() => {
      if (!handsDetected) {
        handsDetected = true;
        
        // Restore normal onResults and enable controls as fallback
        if (hands && originalOnResults) {
          hands.onResults(originalOnResults);
        }
        
        setMenuControlsEnabled(true);
        try { noticeEl.textContent = 'Ready! (Move your hands in front of camera to test hand tracking)'; } catch(e){}
      }
    }, 5000);

  } catch(e) {
    console.warn('warmCameraWithMediaPipe failed', e);
    try { noticeEl.textContent = 'Setup failed - click Play to retry'; } catch(e){}
    setMenuControlsEnabled(true); // Allow retries
  }
}

 // menu preview loop: draw raw video frames into canvas while MediaPipe/hands isn't running
let _menuPreviewRaf = null;
let _menuPreviewing = false;
function startMenuPreviewLoop() {
  try {
    if (_menuPreviewing) return;
    _menuPreviewing = true;
    const loop = () => {
      try {
        // stop preview if a game is running or MediaPipe is active (hands exists)
        if (running || hands) {
          _menuPreviewing = false;
          _menuPreviewRaf = null;
          return;
        }
        // only draw when there is a warmed video stream and the element has data
        try {
          if (videoEl && videoEl.readyState >= 2) {
            drawVideoFrame(videoEl);
            try { drawPeerGhosts(); } catch(e){}
          }
        } catch(e){}
      } catch(e){}
      _menuPreviewRaf = requestAnimationFrame(loop);
    };
    _menuPreviewRaf = requestAnimationFrame(loop);
  } catch(e){ _menuPreviewing = false; _menuPreviewRaf = null; }
}
function stopMenuPreviewLoop() {
  try {
    if (_menuPreviewRaf) cancelAnimationFrame(_menuPreviewRaf);
  } catch(e){}
  _menuPreviewing = false;
  _menuPreviewRaf = null;
}

 // game loop via MediaPipe onResults
function drawPeerGhosts() {
  try {
    // Skip peer rendering when inside a room using the simplified admin-driven model.
    // This disables peer ghosts/paints to ensure all users see only the admin-controlled game.
    const roomsStateLocal = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
    if (roomsStateLocal && roomsStateLocal.room) return;

    // ensure canvas transform and state are consistent for peer overlays
    // (some callers may change ctx transform/state; restore a known baseline)
    try { ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.globalCompositeOperation = 'source-over'; } catch(e) {}
    const nowTs = Date.now();
    const fadeMs = 8000; // remove ghosts after 8s of inactivity
    const cw = canvas.width / DPR;
    const ch = canvas.height / DPR;

    // Render peer paints globally so peer paint strokes/points are visible regardless of local game mode.
    // Make paints bolder and add a subtle glow so remote content is unmistakable even on busy backgrounds.
    try {
      for (const [pid, pArr] of Object.entries(peerPaints || {})) {
        if (!Array.isArray(pArr) || pArr.length === 0) continue;
        // skip very old paint trails
        const last = pArr[pArr.length - 1];
        const ageMs = Date.now() - (last && last.t ? last.t : Date.now());
        if (ageMs > 12000) continue; // keep a slightly longer window for visibility

        try {
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1.0;

          // pick style from first valid point, fall back to a high-contrast cyan
          const firstValid = pArr.find(p => p && typeof p.x === 'number');
          const strokeColor = (firstValid && firstValid.color) ? firstValid.color : 'rgba(0,220,255,0.98)';
          const strokeSize = (firstValid && firstValid.size) ? Math.max(3, firstValid.size) : 8;

          // draw a subtle glow behind the stroke for contrast
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = strokeSize + 4;
          ctx.strokeStyle = strokeColor.replace(/rgba?\(([^,]+),([^,]+),([^,]+)(?:,.*)?\)/, (m, r, g, b) => `rgba(${r.trim()},${g.trim()},${b.trim()},0.22)`);
          ctx.beginPath();
          let moved = false;
          for (let i = 0; i < pArr.length; i++) {
            const pt = pArr[i];
            if (!pt || typeof pt.x !== 'number') continue;
            if (!moved) { ctx.moveTo(pt.x, pt.y); moved = true; } else { ctx.lineTo(pt.x, pt.y); }
          }
          if (moved) ctx.stroke();

          // stroke the main path on top
          ctx.lineWidth = strokeSize;
          ctx.strokeStyle = strokeColor;
          ctx.beginPath();
          moved = false;
          for (let i = 0; i < pArr.length; i++) {
            const pt = pArr[i];
            if (!pt || typeof pt.x !== 'number') continue;
            if (!moved) { ctx.moveTo(pt.x, pt.y); moved = true; } else { ctx.lineTo(pt.x, pt.y); }
          }
          if (moved) ctx.stroke();

          // stronger end-cap so the content ball is obvious
          if (firstValid) {
            const endX = (last && typeof last.x === 'number') ? last.x : firstValid.x;
            const endY = (last && typeof last.y === 'number') ? last.y : firstValid.y;
            ctx.beginPath();
            ctx.fillStyle = strokeColor;
            ctx.arc(endX, endY, Math.max(3, strokeSize * 0.6), 0, Math.PI * 2);
            ctx.fill();
            // small white center for contrast
            ctx.beginPath();
            ctx.fillStyle = 'white';
            ctx.arc(endX, endY, Math.max(1.5, strokeSize * 0.22), 0, Math.PI * 2);
            ctx.fill();
          }
        } catch (innerE) {
          // avoid bubbling paint draw errors for a single peer
          console.warn('peer paint draw inner failed for', pid, innerE);
        } finally {
          try { ctx.restore(); } catch (e2) {}
        }
      }
    } catch (e) { /* ignore peer paint global render failures */ }

    for (const [id, st] of Object.entries(peerGhosts)) {
      if (!st) continue;

      // Fallback avatar rendering: ensure peers remain visible even if skeleton mapping fails.
      // Choose the most reliable representative point and draw an unmistakable anchor with name.
      try {
        let avatarPt = null;
        // Prefer interpolated displayHands (index fingertip)
        if (Array.isArray(st.displayHands) && st.displayHands.length && st.displayHands[0] && st.displayHands[0][8]) {
          avatarPt = st.displayHands[0][8];
        } else if (Array.isArray(st.target) && st.target[8]) {
          avatarPt = st.target[8];
        } else if (Array.isArray(st.hands) && st.hands.length && st.hands[0] && st.hands[0][8]) {
          avatarPt = st.hands[0][8];
        } else {
          // fallback to peer paints if available (use last paint point)
          const paints = peerPaints && peerPaints[id];
          if (Array.isArray(paints) && paints.length) {
            for (let i = paints.length - 1; i >= 0; i--) {
              const p = paints[i];
              if (p && typeof p.x === 'number') { avatarPt = p; break; }
            }
          }
        }

        if (avatarPt && typeof avatarPt.x === 'number' && typeof avatarPt.y === 'number') {
          ctx.save();
          ctx.globalAlpha = Math.max(0.9, 0.8);

          // Outer glow ring for high contrast
          try {
            ctx.beginPath();
            ctx.fillStyle = 'rgba(0,200,255,0.9)';
            ctx.shadowColor = 'rgba(0,200,255,0.55)';
            ctx.shadowBlur = 14;
            ctx.arc(avatarPt.x, avatarPt.y, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          } catch(e){ /* ignore shadow failures */ }

          // inner white content ball for readability
          ctx.beginPath();
          ctx.fillStyle = 'white';
          ctx.arc(avatarPt.x, avatarPt.y, 5, 0, Math.PI * 2);
          ctx.fill();

          // subtle dark stroke to ground the anchor
          ctx.beginPath();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.arc(avatarPt.x, avatarPt.y, 14, 0, Math.PI * 2);
          ctx.stroke();

          // name tag (small, unobtrusive) below the anchor for clarity
          const name = st.name ? String(st.name).slice(0, 12) : 'Player';
          try {
            ctx.font = '600 11px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const textY = avatarPt.y + 18;
            const metrics = ctx.measureText(name);
            const pad = 6;
            const w = Math.max(28, metrics.width + pad * 2);
            const x = avatarPt.x - w / 2;
            const y = textY - 2;
            // background
            ctx.beginPath();
            ctx.fillStyle = `rgba(255,255,255,0.95)`;
            try {
              const r = 8;
              ctx.moveTo(x + r, y);
              ctx.arcTo(x + w, y, x + w, y + 16, r);
              ctx.arcTo(x + w, y + 16, x, y + 16, r);
              ctx.arcTo(x, y + 16, x, y, r);
              ctx.arcTo(x, y, x + w, y, r);
              ctx.closePath();
              ctx.fill();
            } catch (e) {
              ctx.fillRect(x, y, w, 16);
            }
            // text
            ctx.fillStyle = 'rgba(20,20,20,0.96)';
            ctx.fillText(name, avatarPt.x, textY + 2);
          } catch (e) { /* ignore name draw errors */ }

          ctx.restore();
        }
      } catch (e) { /* ignore fallback draw errors */ }

      // Support multi-hand payloads: st.hands === Array<Array<point>>
      // Do not early-skip here — allow later fallbacks (displayHands / peerPaints) so presence persists
      let handsArr = Array.isArray(st.hands) && st.hands.length ? st.hands : (Array.isArray(st.target) && st.target.length ? [st.target] : []);
      // Intentionally do not continue here if empty; we'll try fallback strategies after interpolation/aging.

      // Cleanup stale peers (based on lastTs)
      if (st.lastTs && (nowTs - st.lastTs) > fadeMs) {
        delete peerGhosts[id];
        continue;
      }

      // Ensure displayHands mirrors handsArr shape
      if (!st.displayHands || !Array.isArray(st.displayHands) || st.displayHands.length !== handsArr.length) {
        st.displayHands = handsArr.map(hand => hand.map(p => ({ x: p.x || 0, y: p.y || 0, z: p.z || 0 })));
      } else {
        // Interpolate each hand separately
        const age = nowTs - (st.lastTs || nowTs);
        const blend = Math.min(0.5, 0.15 + (age / fadeMs) * 0.2);
        for (let hIdx = 0; hIdx < Math.min(handsArr.length, st.displayHands.length); hIdx++) {
          const tgt = handsArr[hIdx] || [];
          const disp = st.displayHands[hIdx] || [];
          // Resize display array to match target if needed
          if (disp.length !== tgt.length) {
            st.displayHands[hIdx] = tgt.map(p => ({ x: p.x || 0, y: p.y || 0, z: p.z || 0 }));
            continue;
          }
          for (let i = 0; i < Math.min(tgt.length, disp.length); i++) {
            const t = tgt[i] || { x: 0, y: 0, z: 0 };
            const d = disp[i];
            if (d && typeof t.x === 'number' && typeof t.y === 'number') {
              d.x += (t.x - d.x) * blend;
              d.y += (t.y - d.y) * blend;
              d.z = (typeof t.z === 'number') ? (d.z + ((t.z - d.z) * blend)) : (d.z || 0);
            }
          }
        }
      }

      // Calculate fade factor based on age
      const age = nowTs - (st.lastTs || nowTs);
      const fadeFactor = Math.max(0.1, Math.min(1, 1 - (age / fadeMs)));

      // Fallbacks if no fresh hands were received:
      // 1) Use previously-interpolated displayHands if available so peers remain visible when packets are delayed.
      // 2) If neither fresh hands nor displayHands exist, but peer paints exist, allow paint-only label rendering below.
      // 3) Otherwise skip drawing this peer.
      if ((!handsArr || handsArr.length === 0)) {
        if (Array.isArray(st.displayHands) && st.displayHands.length) {
          // use existing interpolated displayHands (render code below primarily reads st.displayHands)
          handsArr = st.displayHands;
        } else {
          // no hand geometry available; check if peer has paints which may still be rendered by paint-only logic
          const paints = peerPaints[id];
          if (!(Array.isArray(paints) && paints.length)) {
            // nothing meaningful to render for this peer
            continue;
          }
          // allow paint-only branch below to render a label near paint points; fall through.
        }
      }

      // Draw each hand / peer indicator for this peer according to per-game visibility rules
      try {
        // visibility modes per-game:
        // - hands_name: draw hands + name (default for hand-centric games)
        // - hands: draw hands only (no name)
        // - paint_only: do not draw hands (paints drawn elsewhere), draw name near last paint if available
        // - ball_only: draw a small avatar/ball at primary tip (no name)
        // - ball_name: draw the ball and the name
        // - avatar_ball: show the game-controlled avatar/ball instead of fingertip
        const visibilityMap = {
          'ninja-fruit': 'hands_name',
          'shape-trace': 'hands_name',
          'paint-air': 'avatar_ball', // Show game-controlled avatar ball for paint-air
          'maze-mini': 'avatar_ball', // Show maze avatar ball instead of finger hand
          'runner-control': 'avatar_ball', // Show runner avatar ball instead of finger pointer
          'follow-dot': 'ball_name'
        };
        const mode = visibilityMap[currentGameId] || 'hands_name';

        // helper to find primary display point (prefer index tip, fallback to wrist)
        const getPrimaryPoint = (dispArr) => {
          if (!dispArr || dispArr.length === 0) return null;
          const h = dispArr[0];
          if (!h) return null;
          const tip = h[8] || h[0];
          if (tip && typeof tip.x === 'number' && typeof tip.y === 'number') return tip;
          return null;
        };

        // If mode is paint_only, prefer drawing a label near the peer's paint.
        // If no paint exists (or no valid label point), fall through and draw the regular skeleton
        // so peers remain visible even when paints haven't been forwarded yet.
        if (mode === 'paint_only') {
          let labelPos = null;
          const paints = peerPaints[id];
          if (Array.isArray(paints) && paints.length) {
            // pick last non-deleted paint point
            for (let i = paints.length - 1; i >= 0; i--) {
              const p = paints[i];
              if (p && !p._deleted && typeof p.x === 'number') { labelPos = p; break; }
            }
          }
          // fallback to primary fingertip if no paint point found
          if (!labelPos) labelPos = getPrimaryPoint(st.displayHands);

          if (labelPos && typeof labelPos.x === 'number') {
            const name = st.name || 'Player';
            ctx.save();
            ctx.globalAlpha = Math.max(0.2, fadeFactor);
            ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const text = String(name).slice(0, 12);
            const px = labelPos.x;
            const py = (labelPos.y || 0) - 18;
            const metrics = ctx.measureText(text);
            const padding = 8;
            const w = Math.max(28, metrics.width + padding * 2);
            const h = 16;
            const rx = 8;
            const x = px - w / 2;
            const y = py - h;
            (function() {
              const radius = Math.min(rx, w / 2, h / 2);
              try {
                ctx.beginPath();
                ctx.moveTo(x + radius, y);
                ctx.arcTo(x + w, y, x + w, y + h, radius);
                ctx.arcTo(x + w, y + h, x, y + h, radius);
                ctx.arcTo(x, y + h, x, y, radius);
                ctx.arcTo(x, y, x + w, y, radius);
                ctx.closePath();
              } catch (err) {
                ctx.beginPath();
                ctx.rect(x, y, w, h);
              }
            })();
            ctx.fillStyle = `rgba(28,28,28,${0.82 * Math.max(0.4, fadeFactor)})`;
            ctx.fill();
            ctx.strokeStyle = `rgba(120,140,180,${0.5 * Math.max(0.4, fadeFactor)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = 'white';
            ctx.fillText(text, px, py - 3);
            ctx.restore();

            // We drew a paint label - skip skeleton to preserve paint-only visual semantics
            continue;
          }
          // No paint label available — fall through to default skeleton rendering so peer remains visible.
        }

        // For ball modes, draw a small circular avatar at the primary tip.
        // If no primary tip is available, fall through to draw the full skeleton so peers remain visible.
        if (mode === 'ball_only' || mode === 'ball_name') {
          const pt = getPrimaryPoint(st.displayHands);
          if (pt && typeof pt.x === 'number') {
            ctx.save();
            ctx.globalAlpha = fadeFactor;
            // small circle with subtle outline
            ctx.beginPath();
            ctx.fillStyle = 'rgba(255,160,40,0.95)';
            ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(0,0,0,0.35)';
            ctx.stroke();
            ctx.restore();

            // draw name when requested
            if (mode === 'ball_name') {
              const name = st.name || 'Player';
              ctx.save();
              ctx.globalAlpha = Math.max(0.25, fadeFactor);
              ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              const text = String(name).slice(0, 12);
              const px = pt.x;
              const py = pt.y + 14;
              ctx.fillStyle = `rgba(30,30,30,${0.86 * fadeFactor})`;
              const metrics = ctx.measureText(text);
              const padding = 6;
              const w = Math.max(28, metrics.width + padding * 2);
              const h = 16;
              const rx = 8;
              const x = px - w / 2;
              const y = py;
              (function() {
                const radius = Math.min(rx, w / 2, h / 2);
                try {
                  ctx.beginPath();
                  ctx.moveTo(x + radius, y);
                  ctx.arcTo(x + w, y, x + w, y + h, radius);
                  ctx.arcTo(x + w, y + h, x, y + h, radius);
                  ctx.arcTo(x, y + h, x, y, radius);
                  ctx.arcTo(x, y, x + w, y, radius);
                  ctx.closePath();
                } catch (err) {
                  ctx.beginPath();
                  ctx.rect(x, y, w, h);
                }
              })();
              ctx.fillStyle = `rgba(24,24,24,${0.85 * fadeFactor})`;
              ctx.fill();
              ctx.strokeStyle = `rgba(120,140,180,${0.5 * fadeFactor})`;
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.fillStyle = 'white';
              ctx.fillText(text, px, py + 12 - 3);
              ctx.restore();
            }

            // Successfully rendered ball (and optional name) — skip skeleton drawing.
            continue;
          }
          // No primary point available — fall through and draw the skeleton below.
        }

        // Default: draw full hand skeletons (hands or hands_name)
        // shared connections
        const connections = [
          [0,1], [1,2], [2,3], [3,4], // thumb
          [0,5], [5,6], [6,7], [7,8], // index finger
          [5,9], [9,10], [10,11], [11,12], // middle finger
          [9,13], [13,14], [14,15], [15,16], // ring finger
          [13,17], [17,18], [18,19], [19,20], // pinky
          [0,17] // palm connection
        ];

        for (let hIdx = 0; hIdx < st.displayHands.length; hIdx++) {
          const disp = st.displayHands[hIdx];
          if (!disp || disp.length === 0) continue;

          // color per hand index for multi-hand clarity
          const baseColors = [
            `rgba(100, 255, 200, ${0.6 * fadeFactor})`,
            `rgba(180, 150, 255, ${0.6 * fadeFactor})`
          ];
          const fillColors = [
            `rgba(255, 200, 100, ${0.8 * fadeFactor})`,
            `rgba(200, 160, 255, ${0.8 * fadeFactor})`
          ];
          const strokeColor = baseColors[hIdx] || baseColors[0];
          const pointFill = fillColors[hIdx] || fillColors[0];

          ctx.save();
          ctx.globalAlpha = fadeFactor;
          ctx.lineWidth = 8;
          ctx.strokeStyle = strokeColor;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          ctx.beginPath();
          for (const [a, b] of connections) {
            const pa = disp[a];
            const pb = disp[b];
            if (pa && pb && typeof pa.x === 'number' && typeof pb.x === 'number') {
              ctx.moveTo(pa.x, pa.y);
              ctx.lineTo(pb.x, pb.y);
            }
          }
          ctx.stroke();

          // fingertips
          ctx.fillStyle = pointFill;
          const keyPoints = [4, 8, 12, 16, 20];
          for (const idx of keyPoints) {
            const p = disp[idx];
            if (p && typeof p.x === 'number') {
              ctx.beginPath();
              ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          ctx.restore();
        }

        // Draw name label when mode allows it (hands_name or ball_name)
        const nameAllowed = (mode === 'hands_name' || mode === 'ball_name');
        if (nameAllowed) {
          const primaryDisp = (st.displayHands && st.displayHands[0]) ? st.displayHands[0] : null;
          const tip = (primaryDisp && primaryDisp[8]) ? primaryDisp[8] : (primaryDisp && primaryDisp[0]) ? primaryDisp[0] : null;
          if (tip && typeof tip.x === 'number') {
            const name = st.name || 'Player';
            ctx.save();
            ctx.globalAlpha = fadeFactor;
            ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const text = String(name).slice(0, 12);

            const px = tip.x;
            const py = tip.y - 18;

            const metrics = ctx.measureText(text);
            const padding = 8;
            const w = Math.max(30, metrics.width + padding * 2);
            const h = 18;
            const rx = 9;
            const x = px - w / 2;
            const y = py - h;

            (function() {
              const radius = Math.min(rx, w / 2, h / 2);
              try {
                ctx.beginPath();
                ctx.moveTo(x + radius, y);
                ctx.arcTo(x + w, y, x + w, y + h, radius);
                ctx.arcTo(x + w, y + h, x, y + h, radius);
                ctx.arcTo(x, y + h, x, y, radius);
                ctx.arcTo(x, y, x + w, y, radius);
                ctx.closePath();
              } catch (err) {
                ctx.beginPath();
                ctx.rect(x, y, w, h);
              }
            })();
            ctx.fillStyle = `rgba(30, 30, 30, ${0.85 * fadeFactor})`;
            ctx.fill();
            ctx.strokeStyle = `rgba(120, 160, 200, ${0.6 * fadeFactor})`;
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = 'white';
            ctx.fillText(text, px, py - 3);
            ctx.restore();
          }
        }

      } catch (e) {
        console.warn('Peer ghost draw error for', id, e);
      }
    }
  } catch (e) { 
    console.warn('Peer ghost rendering error:', e);
  } finally {
    // restore canvas state established at function entry
    try { ctx.restore(); } catch(e) {}
  }
}
// close drawPeerGhosts()

let lastFrameTime = performance.now();
function onResults(results) {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // draw video
  drawVideoFrame(results.image);

  // update spawn timers + objects only for ninja-fruit mode
  if (currentGameId === 'ninja-fruit') {
  // Spawn handling for ninja-fruit:
  // - In server-authoritative mode, process scheduled items provided by server to avoid duplicate local spawns.
  // - Otherwise fall back to local deterministic spawning.
  if (serverAuthoritative && running) {
    // Process server-supplied scheduled items (throttled inside function).
    try {
      // Only treat scheduledGameItems as "present" when there are still unspawned entries.
      // Previously a non-empty array with all items marked _spawned prevented the client fallback
      // from running; that caused spawns to stop once the server-provided list was exhausted.
      if (Array.isArray(scheduledGameItems) && scheduledGameItems.some(it => !it._spawned)) {
        processScheduledSpawns(Date.now());
      } else {
        // No pending scheduled items provided by server — fallback to local spawning so the game remains playable.
        // Use local spawn caps when falling back so players still see multiple fruits/bombs.
        const fruitInterval = FRUIT_SPAWN_INTERVAL;
        const bombInterval = BOMB_SPAWN_INTERVAL;

        if (now - lastFruitSpawn > fruitInterval) {
          lastFruitSpawn = now;
          // forceLocal tells spawnFruit to ignore the server-authoritative caps so the client
          // can continue showing a playable amount of objects when the server didn't provide items.
          spawnFruit({ forceLocal: true });
        }
        if (now - lastBombSpawn > bombInterval) {
          lastBombSpawn = now;
          if (Math.random() < 0.6) spawnBomb({ forceLocal: true });
        }
      }
    } catch(e) { console.warn('processScheduledSpawns failed', e); }
  } else if (running) {
    // Local deterministic spawning for solo play.
    // Keep intervals configurable; use base constants here.
    const fruitInterval = FRUIT_SPAWN_INTERVAL;
    const bombInterval = BOMB_SPAWN_INTERVAL;

    if (now - lastFruitSpawn > fruitInterval) {
      lastFruitSpawn = now;
      spawnFruit();
      console.log('Spawned fruit locally:', objects.length);
    }
    if (now - lastBombSpawn > bombInterval) {
      lastBombSpawn = now;
      if (Math.random() < 0.6) spawnBomb();
      console.log('Spawned bomb locally:', objects.length);
    }
  }
  // update objects physics & draw for all ninja-fruit modes
  drawObjects(dt);
  if (objects.length > 0) {
    console.log(`Rendering ${objects.length} objects in ninja-fruit mode`);
  }
  } else {
    // Non-fruit modes should not show ninja objects; clear any leftover objects.
    if (objects.length) objects.length = 0;
  }

  // map landmarks and draw hand trails and collision detection
  const allLandmarks = results.multiHandLandmarks || [];
  const mappedHands = allLandmarks.map(landmarks => mapLandmarksToCanvas(landmarks, results));

  // Send quantized landmarks to server for peer ghost rendering (throttled by NET)
  try {
    if (window.NET && allLandmarks && allLandmarks.length) {
      // Quantize landmarks using normalized coordinates (0-1 range) for consistent rendering
      // Quantize using MediaPipe normalized landmark coordinates (image-space 0..1).
      // This avoids embedding cover/offset-dependent canvas coordinates and ensures
      // receivers can map points correctly regardless of local canvas/video transforms.
      const quantizePoint = (lm) => {
        // lm.x / lm.y are normalized relative to the image (0..1)
        const nx = Math.max(0, Math.min(1, (typeof lm.x === 'number' ? lm.x : 0)));
        const ny = Math.max(0, Math.min(1, (typeof lm.y === 'number' ? lm.y : 0)));
        const qx = Math.round(nx * NET_QUANT_MAX);
        const qy = Math.round(ny * NET_QUANT_MAX);
        // z: map approx range [-1,1] into [0, NET_QUANT_MAX] (preserve relative depth)
        const qz = Math.round(((typeof lm.z === 'number' ? lm.z : 0) * (NET_QUANT_MAX / 2)) + (NET_QUANT_MAX / 2));
        return [qx, qy, qz];
      };
      
      // Use raw MediaPipe landmarks (allLandmarks) which are normalized image coords
      const quantizedHands = allLandmarks.map(lmArr => lmArr.map(quantizePoint));
      
      // Include sender canvas size so receivers can scale paint events; hand quantization
      // is image-space based and therefore robust across different cover transforms.
      const payload = {
        lm: (quantizedHands.length === 1 ? quantizedHands[0] : quantizedHands),
        cw: canvas.width / DPR,
        ch: canvas.height / DPR,
        // propagate local MediaPipe selfie/mirror hint so peers can choose correct flip heuristics
        selfie: !!(window.__handNinja && window.__handNinja.handsSelfieMode),
        name: (playerNameEl && playerNameEl.value) ? String(playerNameEl.value).slice(0,24) : 'Player'
      };
      
      try {
        // In simplified room model, avoid sending per-frame hand telemetry.
        // If not in a room or the client is the admin, allow sending as before.
        const roomsStateLocal = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
        const inRoom = roomsStateLocal && roomsStateLocal.room;
        const isAdmin = roomsStateLocal && roomsStateLocal.isAdmin;
        if (!inRoom || isAdmin) {
          if (typeof window.NET.sendHand === 'function') {
            window.NET.sendHand(payload);
          } else if (window.NET.socket && typeof window.NET.socket.emit === 'function') {
            window.NET.socket.emit('hand', payload);
          }
        }
      } catch (e) {
        // best-effort; ignore send failures
      }
    }
  } catch (e) { /* ignore send errors */ }

drawPeerGhosts();

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

  // Store mapped hands for fat audio system and update hand tracking intensity
  try {
    // Store hands for fat audio system
    window.__handNinja._lastMappedHands = mappedHands;
    
    // Update both the new intensity system and fat audio engine
    updateAudioIntensity(mappedHands);
    
    if (typeof window.fatAudio !== 'undefined' && window.fatAudio && typeof window.fatAudio.updateHandTracking === 'function') {
      window.fatAudio.updateHandTracking(mappedHands);
    }
    if (typeof window.fatAudio !== 'undefined' && window.fatAudio && typeof window.fatAudio.updateAmbientEffects === 'function') {
      window.fatAudio.updateAmbientEffects();
    }
  } catch (e) {
    console.warn('Fat audio update failed', e);
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
            try { 
              // Use eraser sound if available, fallback to pop_small
              if (ASSETS && ASSETS.sfx && ASSETS.sfx.eraser) {
                playSound('eraser'); 
              } else if (ASSETS && ASSETS.sfx && ASSETS.sfx.pop_small) {
                playSound('pop_small');
              }
            } catch(e){}
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

          // Send paint point to server for peer forwarding (best-effort)
              try {
                // Do not forward per-point paint to server when participating inside a room
                // in the simplified admin-driven model. Admins may still send paints.
                const roomsStateLocal = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
                const inRoom = roomsStateLocal && roomsStateLocal.room;
                const isAdmin = roomsStateLocal && roomsStateLocal.isAdmin;
                if (!inRoom || isAdmin) {
                  if (window.NET && typeof window.NET.sendPaint === 'function') {
                    const cw = canvas.width / DPR;
                    const ch = canvas.height / DPR;
                    const payload = {
                      pts: [{ x: pt.x, y: pt.y, t: pt.t, color: pt.color, size: pt.size }],
                      cw, ch,
                      name: (playerNameEl && playerNameEl.value) ? String(playerNameEl.value).slice(0,24) : 'Player'
                    };
                    try { window.NET.sendPaint(payload); } catch(e){}
                  }
                }
              } catch(e) {}
          
          // Play paint stroke sound for responsive feedback
        try {
          if (videoEl && videoEl.readyState >= 2) {
            drawVideoFrame(videoEl);
            // draw peer overlays even when MediaPipe isn't running locally
            try { drawPeerGhosts(); } catch(e){}
          }
        } catch(e){}
          
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

          // Rendering: draw incoming peer paints first (more robust)
          try {
            const peerIds = Object.keys(peerPaints || {});
            for (const pid of peerIds) {
              const pArr = peerPaints[pid];
              if (!pArr || !pArr.length) continue;
              // simple age-based cleanup
              const last = pArr[pArr.length - 1];
              const ageMs = Date.now() - (last && last.t ? last.t : Date.now());
              if (ageMs > 12000) { delete peerPaints[pid]; continue; }

              // Draw strokes robustly: handle single-point dots, multi-point continuous stroke,
              // skip null/holes, and add end-caps to avoid single-pixel gaps.
              try {
                ctx.save();
                ctx.globalAlpha = 0.95;

                // find first valid point index
                let firstIdx = -1;
                for (let i = 0; i < pArr.length; i++) {
                  if (pArr[i]) { firstIdx = i; break; }
                }
                if (firstIdx === -1) { ctx.restore(); continue; }

                // If there's only a single valid point, draw a filled dot
                if (pArr.length - firstIdx === 1) {
                  const p = pArr[firstIdx];
                  const color = p.color || paintColor;
                  const size = p.size || paintSize;
                  ctx.beginPath();
                  ctx.fillStyle = color;
                  ctx.arc(p.x, p.y, Math.max(1, (size || 6) * 0.5), 0, Math.PI * 2);
                  ctx.fill();
                  ctx.restore();
                  continue;
                }

                // Multi-point stroke: build one path and stroke once
                const firstP = pArr[firstIdx];
                const strokeColor = firstP.color || paintColor;
                const strokeSize = firstP.size || paintSize;

                ctx.beginPath();
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = strokeSize;
                ctx.moveTo(firstP.x, firstP.y);

                let lastP = firstP;
                for (let i = firstIdx + 1; i < pArr.length; i++) {
                  const pt = pArr[i];
                  if (!pt) continue;
                  ctx.lineTo(pt.x, pt.y);
                  lastP = pt;
                }
                ctx.stroke();

                // draw small end-caps at ends to avoid thin tails/gaps
                try {
                  ctx.beginPath();
                  ctx.fillStyle = strokeColor;
                  ctx.arc(firstP.x, firstP.y, Math.max(1, strokeSize * 0.42), 0, Math.PI * 2);
                  ctx.fill();
                  ctx.beginPath();
                  ctx.arc(lastP.x, lastP.y, Math.max(1, strokeSize * 0.42), 0, Math.PI * 2);
                  ctx.fill();
                } catch (e) { /* ignore cap failures */ }

                ctx.restore();
              } catch (e) {
                console.warn('peer paint draw failed for', pid, e);
                try { ctx.restore(); } catch (e2) {}
              }
            }
          } catch(e) { console.warn('peer paint render failed', e); }

          // Overlay a subtle coordinate indicator to show mirror mode status
          try {
            ctx.save();
            ctx.globalAlpha = 0.6;
            ctx.font = '12px sans-serif';
            ctx.fillStyle = 'yellow';
            ctx.textAlign = 'left';
            const selfieMode = !!(window.__handNinja && window.__handNinja.handsSelfieMode);
            const statusText = selfieMode ? 'MIRROR: ON' : 'MIRROR: OFF';
            ctx.fillText(statusText, 10, canvas.height / DPR - 10);
            ctx.restore();
          } catch(e) { /* ignore mirror status indicator */ }

          // Rendering: iterate paintPaths, respect separators (null) and per-point color/size.
          // Skip points that fall inside any erase mask.
          // Draw strokes by honoring separators and point-level styles (skip deleted points)
          if (paintPaths.length) {
        let strokeStart = -1;
        let lastColor = null, lastSize = null;

        for (let i = 0; i <= paintPaths.length; i++) {
          const p = paintPaths[i];

          // Handle stroke completion or end of array
          if (p === null || i === paintPaths.length || (p && p._deleted)) {
            if (strokeStart !== -1) {
              // We have a complete stroke to render
              try {
                ctx.beginPath();
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.strokeStyle = lastColor || paintColor;
                ctx.lineWidth = lastSize || paintSize;

                let moved = false;
                for (let j = strokeStart; j < i; j++) {
                  const pt = paintPaths[j];
                  if (pt && !pt._deleted) {
                    if (!moved) {
                      ctx.moveTo(pt.x, pt.y);
                      moved = true;
                    } else {
                      ctx.lineTo(pt.x, pt.y);
                    }
                  }
                }

                if (moved) {
                  ctx.stroke();
                }
              } catch (e) {
                console.warn('Stroke render error:', e);
              }
            }
            strokeStart = -1; // Reset stroke
            lastColor = null;
            lastSize = null;
          }

          // Handle point addition to current stroke
          if (p && !p._deleted) {
            if (strokeStart === -1) {
              // Starting new stroke
              strokeStart = i;
              lastColor = p.color || paintColor;
              lastSize = p.size || paintSize;
            } else {
              // Continuing stroke - ensure color/size consistency
              const color = p.color || paintColor;
              const size = p.size || paintSize;
              if (color !== lastColor || size !== lastSize) {
                // Style change - finish current stroke and start new one
                if (strokeStart !== -1) {
                  try {
                    ctx.beginPath();
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.strokeStyle = lastColor;
                    ctx.lineWidth = lastSize;

                    let moved = false;
                    for (let j = strokeStart; j < i; j++) {
                      const pt = paintPaths[j];
                      if (pt && !pt._deleted) {
                        if (!moved) {
                          ctx.moveTo(pt.x, pt.y);
                          moved = true;
                        } else {
                          ctx.lineTo(pt.x, pt.y);
                        }
                      }
                    }

                    if (moved) {
                      ctx.stroke();
                    }
                  } catch (e) {
                    console.warn('Style change stroke render error:', e);
                  }
                }
                strokeStart = i; // Start new stroke from current point
                lastColor = color;
                lastSize = size;
              }
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
        // Play a startup sound
        try { playSound('popup'); } catch(e){}
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
            // Different sounds for different cue positions to add variety
            if (sim.cueIdx === 0) {
              try { playSound('point'); } catch(e){}
            } else {
              try { playSound('pop_small'); } catch(e){}
            }
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
                // Play completion sound
                try { playSound('shape_complete'); } catch(e){}
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
        window.__handNinja._follow = { x: rand(80,w-80), y: rand(80,h-80), vx: rand(-160,160), vy: rand(-120,120), lastMove: now, scoreAccum: 0, lastBounceSound: 0 };
        // Play startup sound
        try { playSound('popup'); } catch(e){}
      }
      const f = window.__handNinja._follow;
      const dtF = Math.max(0, (now - (f.lastMove || now)) / 1000);
      f.lastMove = now;
      const prevX = f.x, prevY = f.y;
      f.x += f.vx * dtF; f.y += f.vy * dtF;
      
      // Play bounce sound when hitting walls
      if ((f.x < 40 || f.x > canvas.width / DPR - 40) && now - f.lastBounceSound > 200) {
        f.vx *= -1;
        try { playSound('pop_small'); } catch(e){}
        f.lastBounceSound = now;
      }
      if ((f.y < 40 || f.y > canvas.height / DPR - 40) && now - f.lastBounceSound > 200) {
        f.vy *= -1;
        try { playSound('pop_small'); } catch(e){}
        f.lastBounceSound = now;
      }
      
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
            try { playSound('point'); } catch(e){}
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

      // Append room high-score (name + score) next to the timer when available.
      let highText = '';
      try {
        if (roomHighScore && typeof roomHighScore.score === 'number') {
          const hn = roomHighScore.name ? String(roomHighScore.name).slice(0,12) : 'Room';
          highText = ` · Room High: ${hn} ${roomHighScore.score}`;
        }
      } catch (e) { highText = ''; }

      timerEl.textContent = `Time: ${remaining}s`;
      if (remaining <= 0) endGame();
    }
  }
}

async function startGame() {
  if (running) return;
  
  console.log(`Starting game: ${currentGameId}`);
  
  // Reset all game state completely
  score = 0;
  objects.length = 0;
  particles.length = 0;
  popups.length = 0;
  
  // Clear mode-specific state
  if (paintPaths) paintPaths.length = 0;
  if (shapes) shapes.length = 0;
  if (shapeCovered) shapeCovered.length = 0;
  shapeProgress = 0;
  paintOnTrackLen = 0;
  
  // Clear module state
  try {
    if (window.__handNinja) {
      delete window.__handNinja._follow;
      delete window.__handNinja._simon;
      delete window.__handNinja._shapeCoveredCount;
    }
  } catch(e) {}
  
  updateUI();
  duration = Number(gameLengthEl.value || 45);
  startTime = performance.now();
  lastFrameTime = performance.now();
  lastFruitSpawn = startTime;
  lastBombSpawn = startTime;

  // Prepare UI but don't mark running until camera is confirmed
  menuEl.style.display = 'none';
  noticeEl.textContent = 'Starting camera... please allow permission if requested';
  try { stopMenuPreviewLoop(); } catch(e){}

    // Set per-game asset paths based on selected game; put files under assets/<gameId>/
    try {
    // Stop any previously-playing BGM immediately when switching games to avoid
    // cross-game bleed and to force a fresh load via preloadAssets().
    try {
      if (bgmAudio) {
        try { 
          bgmAudio.pause(); 
        } catch(e){}
        try { bgmAudio.currentTime = 0; } catch(e){}
        try {
          // Revoke any blob: object URL associated with the previous bgm to stop lingering fetches
          if (bgmAudio.src && typeof bgmAudio.src === 'string' && bgmAudio.src.indexOf('blob:') === 0) {
            try { URL.revokeObjectURL(bgmAudio.src); } catch(e){}
          }
        } catch(e){}
        bgmAudio = null;
      }
    } catch(e){}
    try { if (window.__handNinja && window.__handNinja._simpleAudio) window.__handNinja._simpleAudio.stopBgm(); } catch(e){}
    try { stopDecodedBgm(); } catch(e){}
    const sel = document.getElementById('gameSelect');
    if (sel) currentGameId = sel.value || currentGameId;
    // prefer per-game mapping to the shipped assets/ filenames
    if (currentGameId === 'ninja-fruit') {
      // use top-level ninja fruit assets present in /assets
      ASSETS.bgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3';
      // multiple slice variants exist; keep existing best-effort mapping while preserving global sfx map
      ASSETS.slice = ASSETS.slice || 'https://ali-ezz.github.io/hand-traking-games/assets/slice-frute.mp3' || 'https://ali-ezz.github.io/hand-traking-games/assets/slice-fruit.mp3';
      ASSETS.bomb = ASSETS.bomb || 'https://ali-ezz.github.io/hand-traking-games/assets/boomb.mp3';
      ASSETS.sfx = Object.assign({}, ASSETS.sfx, {
        slice: ASSETS.sfx.slice || 'https://ali-ezz.github.io/hand-traking-games/assets/slice-frute.mp3',
        bomb: ASSETS.sfx.bomb || 'https://ali-ezz.github.io/hand-traking-games/assets/boomb.mp3',
        point: ASSETS.sfx.point || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
        popup: ASSETS.sfx.popup || null
      });
    } else if (currentGameId === 'paint-air') {
      // paint-air: dedicated paint bgm and SFX from root assets
      ASSETS.bgm = ASSETS.bgmVariants && ASSETS.bgmVariants.paint ? ASSETS.bgmVariants.paint : 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_paint_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = Object.assign({}, ASSETS.sfx, {
        clear: ASSETS.sfx.clear || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_clear.mp3',
        done: ASSETS.sfx.done || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_done.mp3',
        pop_small: ASSETS.sfx.pop_small || null,
        paint_stroke: ASSETS.sfx.paint_stroke || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_paint_stroke.mp3'
      });
    } else if (currentGameId === 'shape-trace') {
      // shape-trace: dedicated bgm + shape SFX
      ASSETS.bgm = ASSETS.bgmVariants && ASSETS.bgmVariants.shape ? ASSETS.bgmVariants.shape : 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_shape_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = Object.assign({}, ASSETS.sfx, {
        point: ASSETS.sfx.point || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
        segment_complete: ASSETS.sfx.segment_complete || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_segment_complete.mp3',
        shape_complete: ASSETS.sfx.shape_complete || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_shape_complete.mp3',
        popup: ASSETS.sfx.popup || null,
        wrong: ASSETS.sfx.wrong || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_wrong.mp3'
      });
    } else if (currentGameId === 'runner-control') {
      // runner-control: runner bgm and gameplay SFX
      ASSETS.bgm = ASSETS.bgmVariants && ASSETS.bgmVariants.runner ? ASSETS.bgmVariants.runner : 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_runner_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = Object.assign({}, ASSETS.sfx, {
        point: ASSETS.sfx.point || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
        bomb: ASSETS.sfx.bomb || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_hit.mp3',
        popup: ASSETS.sfx.popup || null,
        jump: ASSETS.sfx.jump || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_jump.mp3'
      });
    } else if (currentGameId === 'maze-mini') {
      // maze-mini: maze bgm and feedback SFX
      ASSETS.bgm = ASSETS.bgmVariants && ASSETS.bgmVariants.maze ? ASSETS.bgmVariants.maze : 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_maze_loop.mp3';
      ASSETS.slice = null;
      ASSETS.bomb = null;
      ASSETS.sfx = Object.assign({}, ASSETS.sfx, {
        point: ASSETS.sfx.point || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
        segment_complete: ASSETS.sfx.segment_complete || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_segment_complete.mp3',
        wrong: ASSETS.sfx.wrong || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_wrong.mp3',
        popup: ASSETS.sfx.popup || null
      });
    } else {
      // fallback: try top-level files using the conventional names while preserving the global sfx map
      ASSETS.bgm = ASSETS.bgm || `https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3`;
      ASSETS.slice = ASSETS.slice || `https://ali-ezz.github.io/hand-traking-games/assets/slice.mp3`;
      ASSETS.bomb = ASSETS.bomb || `https://ali-ezz.github.io/hand-traking-games/assets/bomb.mp3`;
      ASSETS.sfx = Object.assign({}, ASSETS.sfx, {
        point: ASSETS.sfx.point || 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
        popup: ASSETS.sfx.popup || null
      });
    }
    // clear any previously loaded fruit images so preload can reload for new game
    ASSETS._fruitImages = [];
    // start preloading assets but do not block camera startup
    (function initOnFirstGesture() {
  const handler = async () => {
    try {
      // resume/create audio context
      try { ensureAudioCtx(); } catch(e){}
      // warm camera stream once to avoid long permission/negotiation delay on first game start
      try {
        if (!window.__handNinja) window.__handNinja = {};
        if (!window.__handNinja._sharedStream && navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
            window.__handNinja._sharedStream = s;
            try { videoEl.srcObject = s; } catch(e){}
            // do not start the RAF processing here; startGame will attach and begin processing when appropriate
          } catch(e) {
            // ignore camera warm failures (permission will be requested when user starts game)
          }
        }
      } catch(e){}
      // start asset preload in background (non-blocking)
      try { await preloadAssets().catch(()=>{}); } catch(e){}
    } catch(e){}
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('touchstart', handler);
  };
  window.addEventListener('pointerdown', handler, { once: true, passive: true });
  window.addEventListener('touchstart', handler, { once: true, passive: true });
})();
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
  // Immediately refresh HUD so the Leave button and other runtime UI appear as soon as the run is marked running.
  try { updateUI(); } catch(e){}
  
  // Clear canvas to prevent black screen issues
  try {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);
  } catch(e) {}
  
  // Set a mode-appropriate start message
  try {
    if (currentGameId === 'ninja-fruit') {
      noticeEl.textContent = 'Game started — slice fruits, avoid bombs!';
    } else if (currentGameId === 'paint-air') {
      noticeEl.textContent = 'Paint Air started — move your index finger to draw';
    } else if (currentGameId === 'shape-trace') {
      noticeEl.textContent = 'Shape Trace started — trace the shape outline';
    } else if (currentGameId === 'runner-control') {
      noticeEl.textContent = 'Runner Control started — move your finger to control the avatar';
    } else if (currentGameId === 'maze-mini') {
      noticeEl.textContent = 'Maze started — navigate to the highlighted exit';
    } else if (currentGameId === 'simon-gesture') {
      noticeEl.textContent = 'Simon Gesture started — watch the sequence';
    } else if (currentGameId === 'follow-dot') {
      noticeEl.textContent = 'Follow Dot started — keep your finger on the target';
    } else {
      noticeEl.textContent = 'Game started';
    }
  } catch(e){
    noticeEl.textContent = 'Game started';
  }
  
  console.log(`Game started successfully: ${currentGameId}, running: ${running}`);
}

async function endGame() {
  if (!running) return;
  
  console.log(`Ending game: ${currentGameId}, final score: ${score}`);
  
  running = false;
  // Ensure UI hides the Leave button and updates HUD immediately when the run ends.
  try { updateUI(); } catch(e){}

  // Ensure music is stopped when a run completes. Use centralized controller if available,
  // and as a fallback perform a full audio teardown to avoid lingering BGM.
  try {
    const mc = window.__handNinja && window.__handNinja.musicController;
    if (mc && typeof mc.stop === 'function') {
      try { mc.stop({ force: true }); } catch(e){ console.warn('musicController.stop in endGame failed', e); }
    }
  } catch (e) { console.warn('endGame music stop guard failed', e); }

  try { stopAllAudio(); } catch(e){ console.warn('stopAllAudio in endGame failed', e); }

  // Clean up mode-specific state
  try {
    if (currentGameId === 'runner-control') {
      runnerControlModule.onEnd && runnerControlModule.onEnd();
    } else if (currentGameId === 'maze-mini') {
      mazeModule.onEnd && mazeModule.onEnd();
    } else if (currentGameId === 'paint-air') {
      showPaintToolbar(false);
      paintModeNoTimer = false;
    }
  } catch(e) {
    console.warn('Mode cleanup failed:', e);
  }
  
  // Clear any remaining visual state
  try {
    objects.length = 0;
    particles.length = 0;
    popups.length = 0;
  } catch(e) {}
  
  // keep camera running (do not stop media tracks) to avoid re-prompting for permission on restart
  // save leaderboard
  const name = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder).slice(0,24) : 'Player';
  // save under the currently selected game id to ensure per-game isolation
  const sel = document.getElementById('gameSelect');
  const gid = (sel && sel.value) ? sel.value : currentGameId;
  saveLeader(name, score, gid);

  // Reset any cached room high score for this game to a zeroed entry using the local player's name.
  // Preserve a defined entry so other UI flows keep a consistent "Room Best: <name>: 0" view.
    try {
      const clientId = (function() { try { return localStorage.getItem('hand_ninja_client_id'); } catch(e) { return null; } })();
      const localName = (playerNameEl && (playerNameEl.value || playerNameEl.placeholder)) ? (playerNameEl.value || playerNameEl.placeholder).slice(0,24) : 'Player';
      roomHighScoresByGame[gid] = { name: String(localName), score: 0, game: gid, clientId: clientId || null };
      try { roomHighScoreResetTimestamps[gid] = Date.now(); } catch(e) {}
      roomHighScore = roomHighScoresByGame[gid];
      if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay();

    const roomHighScoreEl = document.getElementById('roomHighScore');
    if (roomHighScoreEl) {
      roomHighScoreEl.textContent = `Room Best: ${String(roomHighScore.name || 'Player').slice(0,12)}: ${Number(roomHighScore.score || 0)}`;
      roomHighScoreEl.setAttribute('data-visible', 'true');
      roomHighScoreEl.style.display = 'inline-block';
    }
  } catch (e) { console.warn('Failed to reset room high score on endGame', e); }
  
  console.log(`Saved score ${score} for ${name} in game ${gid}`);
  
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

  // If the Rooms UI exists and we're in a room, delegate start/stop to the server.
  const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
  if (roomsState && roomsState.room) {
    // Non-admins wait for admin
    if (!roomsState.isAdmin) {
      alert('Waiting for the room admin to start the game');
      return;
    }

    // Admin toggles start/stop via the main Play button
    const isRunningRoom = !!(roomsState.room && roomsState.room.status === 'running');

    if (isRunningRoom) {
      // Stop running room game
      NET.stopRoomGame({}, (res) => {
        if (!res || !res.ok) alert('Failed to stop room: ' + (res && res.reason ? res.reason : 'unknown'));
      });
    } else {
      // Start: set options then request server to start the room game
      const timeLimit = Number(gameLengthEl.value) || (roomsState.room && roomsState.room.timeLimit) || 60;
      NET.setRoomOptions({ game: currentGameId, timeLimit }, (setRes) => {
        if (!setRes || !setRes.ok) {
          alert('Failed to set room options: ' + (setRes && setRes.reason ? setRes.reason : 'unknown'));
          return;
        }
        NET.startRoomGame({}, (res) => {
          if (!res || !res.ok) alert('Failed to start room: ' + (res && res.reason ? res.reason : 'unknown'));
        });
      });
    }
    return;
  }

  // not in a room — start locally as before
  await startGame(); 
});
showLeadersBtn.addEventListener('click', ()=> showLeaders());
closeLeadersBtn.addEventListener('click', ()=> leaderboardEl.style.display = 'none');
clearLeadersBtn.addEventListener('click', ()=> clearLeaders());

const leaveGameBtn = document.getElementById('leaveGameBtn');
if (leaveGameBtn) {
  // Position the Leave button so it won't overlap the room best-score box and appears consistently.
  try {
    leaveGameBtn.style.position = 'fixed';
    leaveGameBtn.style.top = '12px';
    leaveGameBtn.style.right = '12px';
    leaveGameBtn.style.zIndex = '99995';
    // Start hidden; updateUI() toggles visibility based on running state.
    leaveGameBtn.style.display = 'none';
    // Use a lightweight transform to create a new stacking context on some browsers to avoid overlap glitches.
    leaveGameBtn.style.transform = 'translateZ(0)';
  } catch(e){}

  // Leave button click handler — posts score and exits the room when clicked.
  leaveGameBtn.addEventListener('click', () => {
    try {
      cleanupAfterLeave();
    } catch(e) { console.warn('cleanupAfterLeave failed from leave button', e); }
  });
}

/* Export removed — leaderboard now strictly per-game to keep UI minimal. */

/* music controls: synchronize both menu and game music checkboxes */
const uiMusicCheckbox = document.getElementById('musicCheckbox');
const menuMusicCheckbox = document.getElementById('menuMusicCheckbox');

function syncMusicCheckboxes(v) {
  try {
    if (uiMusicCheckbox) uiMusicCheckbox.checked = !!v;
    if (menuMusicCheckbox) menuMusicCheckbox.checked = !!v;
  } catch(e){}
}

function handleMusicToggle(enabled) {
  setMusicEnabled(enabled);
  syncMusicCheckboxes(enabled);
}

if (uiMusicCheckbox) {
  uiMusicCheckbox.addEventListener('change', (e) => {
    handleMusicToggle(e.target.checked);
  });
}

if (menuMusicCheckbox) {
  menuMusicCheckbox.addEventListener('change', (e) => {
    handleMusicToggle(e.target.checked);
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
    // Keep room high-score display in sync with the currently selected game.
    try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
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

// sync music initial state and ensure proper game-specific BGM switching
syncMusicCheckboxes(musicEnabled);
(function installAudioDebugWrappers(){
  try {
    // Wrap AudioManager if present to log which backend is used
    if (window.AUDIO && !window.AUDIO._debugWrapped) {
      try {
        const origPlayBgm = window.AUDIO.playBgm && window.AUDIO.playBgm.bind(window.AUDIO);
        const origPlaySfx = window.AUDIO.playSfx && window.AUDIO.playSfx.bind(window.AUDIO);
        if (origPlayBgm) {
          window.AUDIO.playBgm = function(key, opts){ 
            try { console.debug && console.debug('AudioManager.playBgm ->', key, opts); } catch(e){}
            return origPlayBgm(key, opts);
          };
        }
        if (origPlaySfx) {
          window.AUDIO.playSfx = function(name, opts){
            try { console.debug && console.debug('AudioManager.playSfx ->', name, opts); } catch(e){}
            return origPlaySfx(name, opts);
          };
        }
      } catch(e){ console.warn('AudioManager debug wrapper failed', e); }
      try { window.AUDIO._debugWrapped = true; } catch(e){}
    }

    // Wrap SimpleAudio fallback when available
    try {
      if (window.__handNinja && window.__handNinja._simpleAudio && !window.__handNinja._simpleAudio._debugWrapped) {
        const sa = window.__handNinja._simpleAudio;
        try {
          const origSaBgm = sa.playBgm && sa.playBgm.bind(sa);
          const origSaSfx = sa.playSfx && sa.playSfx.bind(sa);
          if (origSaBgm) {
            sa.playBgm = function(key, vol){ 
              try { console.debug && console.debug('SimpleAudio.playBgm ->', key, vol); } catch(e){}
              return origSaBgm(key, vol);
            };
          }
          if (origSaSfx) {
            sa.playSfx = function(key, vol){
              try { console.debug && console.debug('SimpleAudio.playSfx ->', key, vol); } catch(e){}
              return origSaSfx(key, vol);
            };
          }
        } catch(e){ console.warn('SimpleAudio debug wrapper inner failed', e); }
        try { window.__handNinja._simpleAudio._debugWrapped = true; } catch(e){}
      }
    } catch(e){ /* ignore */ }

    // Instrument low-level WebAudio helper for SFX
    try {
      if (typeof playSfx === 'function' && !playSfx._debugWrapped) {
        const _origPlaySfx = playSfx;
        window.playSfx = function(key, opts){
          try { console.debug && console.debug('playSfx (WebAudio) ->', key, opts); } catch(e){}
          return _origPlaySfx(key, opts);
        };
        window.playSfx._debugWrapped = true;
      }
      if (typeof playSfxWithDuration === 'function' && !playSfxWithDuration._debugWrapped) {
        const _orig = playSfxWithDuration;
        window.playSfxWithDuration = function(key, dur, opts){
          try { console.debug && console.debug('playSfxWithDuration ->', key, dur, opts); } catch(e){}
          return _orig(key, dur, opts);
        };
        window.playSfxWithDuration._debugWrapped = true;
      }
    } catch(e){}
  } catch(e){}
})();

// Enhanced BGM switching - completely stop all audio before switching
function stopAllAudio() {
  console.log('Stopping all audio sources...');

  // Stop AudioManager BGM if present (highest-level manager)
  try {
    if (window.AUDIO && typeof window.AUDIO.stopBgm === 'function') {
      try {
        window.AUDIO.stopBgm();
        console.log('Stopped AudioManager BGM');
      } catch (e) {
        console.warn('AudioManager stopBgm failed:', e);
      }
    }
  } catch (e) { /* ignore */ }

  // Stop ALL HTMLAudio instances that might be playing BGM
  try { 
    if (bgmAudio) { 
      console.log('Stopping HTMLAudio BGM:', bgmAudio.src);
      bgmAudio.pause(); 
      bgmAudio.currentTime = 0; 
      
      // Revoke blob URLs to prevent memory leaks
      if (bgmAudio.src && bgmAudio.src.startsWith('blob:')) {
        try { URL.revokeObjectURL(bgmAudio.src); } catch(e){}
      }
      
      bgmAudio.src = ''; 
      bgmAudio.removeAttribute('src');
      try { bgmAudio.load(); } catch(e){}
      bgmAudio = null; 
    } 
  } catch(e){ console.warn('HTMLAudio BGM stop failed:', e); }
  
  // Stop ALL audio elements that might be playing (catch any stragglers)
  try {
    const allAudio = document.querySelectorAll('audio');
    for (const audio of allAudio) {
      try {
        if (!audio.paused) {
          console.log('Stopping stray audio element:', audio.src);
          audio.pause();
          audio.currentTime = 0;
        }
        // clear src to free network handles / blobs
        try { audio.src = ''; audio.removeAttribute('src'); } catch(e){}
        try { audio.load(); } catch(e){}
      } catch (innerE) { /* ignore individual audio stop failures */ }
    }
  } catch(e){}
  
  // Stop decoded WebAudio BGM
  try { 
    stopDecodedBgm(); 
    console.log('Stopped decoded WebAudio BGM');
  } catch(e){ console.warn('Decoded BGM stop failed:', e); }
  
  // Stop SimpleAudio BGM
  try { 
    if (window.__handNinja && window.__handNinja._simpleAudio) {
      try {
        window.__handNinja._simpleAudio.stopBgm();
        // Also clear the BGM instance completely
        window.__handNinja._simpleAudio.bgm = null;
        window.__handNinja._simpleAudio.bgmKey = null;
        console.log('Stopped SimpleAudio BGM');
      } catch (e) { console.warn('SimpleAudio stopBgm inner failed:', e); }
    } 
  } catch(e){ console.warn('SimpleAudio BGM stop failed:', e); }
  
  // Clear all cached audio buffers and references
  try { 
    if (sfxBuffers && sfxBuffers['bgm']) {
      delete sfxBuffers['bgm'];
      console.log('Cleared cached BGM buffer');
    }
  } catch(e){}
  
  // Clear soundPool BGM entry
  try {
    if (soundPool && soundPool.bgm) {
      delete soundPool.bgm;
      console.log('Cleared soundPool BGM');
    }
  } catch(e){}
  
  // Clear any cached decoded BGM
  try {
    decodedBgm = null;
    decodedBgmUrl = null;
    decodedBgmPlaying = false;
  } catch(e){}

  console.log('All audio sources stopped');
}

 // Centralized BGM system - safer behavior around rooms and joins
function updateGameBGM(newGameId, { force = false } = {}) {
  console.log(`updateGameBGM -> ${newGameId} (force=${!!force})`);
  // Map game id to asset URL
  let newBgm = null;
  if (newGameId === 'ninja-fruit') newBgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3';
  else if (newGameId === 'paint-air') newBgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_paint_loop.mp3';
  else if (newGameId === 'shape-trace') newBgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_shape_loop.mp3';
  else if (newGameId === 'runner-control') newBgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_runner_loop.mp3';
  else if (newGameId === 'maze-mini') newBgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_maze_loop.mp3';
  else newBgm = 'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3';

  ASSETS.bgm = newBgm;
  try { if (window.__handNinja && window.__handNinja._simpleAudio) window.__handNinja._simpleAudio.map.bgm = newBgm; } catch(e){}

  // Inform musicController about the new BGM and let it decide whether to preload/start/stop.
  try {
    const mc = window.__handNinja && window.__handNinja.musicController ? window.__handNinja.musicController : null;
    if (mc) {
      // update local room/admin state from ROOMS_UI if available
      const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
      mc.setRoomState({ inRoom: !!(roomsState && roomsState.room), isAdmin: !!(roomsState && roomsState.isAdmin) });
      // preload the new asset
      mc.preload(newBgm).catch(()=>{});
      // decide start: only force start for solo/admin/explicit force
      if (force) {
        if (musicEnabled) mc.start(newBgm, { force: true });
      } else {
        // start only if allowed (solo/admin) and user has music enabled
        const state = mc.getState ? mc.getState() : null;
        const allowed = !(roomsState && roomsState.room) || (roomsState && roomsState.isAdmin);
        if (musicEnabled && allowed) {
          // slight delay to allow teardown to finish
          setTimeout(() => { try { mc.start(newBgm, { force: false }); } catch(e){} }, 180);
        }
      }
    } else {
      // fallback to legacy behavior: stop if forced/solo/admin then try playSound
      const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
      const inRoom = roomsState && roomsState.room;
      const isAdmin = roomsState && roomsState.isAdmin;
      const shouldTeardown = (!inRoom) || isAdmin || !!force;
      if (shouldTeardown) try { stopAllAudio(); } catch(e){}
      if (musicEnabled && shouldTeardown) setTimeout(()=>{ try{ playSound('bgm'); }catch(e){} }, 250);
    }
  } catch(e){ console.warn('updateGameBGM failed', e); }
}

// Enhanced audio unlock for room scenarios
function ensureAudioUnlocked() {
  try {
    // Resume AudioContext if suspended
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(()=>{});
    }
    
    // Unlock SimpleAudio if needed
    if (window.__handNinja && window.__handNinja._simpleAudio && !window.__handNinja._simpleAudio.unlocked) {
      try {
        window.__handNinja._simpleAudio.initOnFirstInteraction();
      } catch(e){}
    }
    
    // Set user interacted flag
    window.__handNinja._userInteracted = true;
  } catch(e){}
}

// Enhanced game selector with centralized BGM control
if (gameSel) {
  gameSel.addEventListener('change', (e) => {
    const newGameId = e.target.value || 'default';
    console.log(`Game selector changed from ${currentGameId} to ${newGameId}`);
    
    // Update current game ID
    currentGameId = newGameId;
    
    // Update BGM only if appropriate (not in room or is admin)
    updateGameBGM(newGameId);
    
    // update leaderboard title if open
    if (leaderboardEl && leaderboardEl.style.display === 'flex') showLeaders();
  });
}

playerNameEl.placeholder = 'Player';
if (playerNameEl) {
  try {
    // Keep local name unique while user types and after blur (defensive).
    // Also keep the room high-score display in sync with the live local name when appropriate.
    playerNameEl.addEventListener('input', () => { 
      try { 
        ensureLocalNameUnique(); 
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
        // Ensure cached room highscore updates when our local name changes.
        try {
          const gid = currentGameId || 'default';
          const rh = roomHighScoresByGame[gid];
          const localCid = (function(){ try { return localStorage.getItem('hand_ninja_client_id'); } catch(e){ return null; } })();
          const localName = (playerNameEl.value || playerNameEl.placeholder) ? String(playerNameEl.value || playerNameEl.placeholder) : '';

          // Update when we can reliably attribute the cached entry to ourselves
          if (rh && rh.clientId && localCid && rh.clientId === localCid) {
            rh.name = localName;
            roomHighScoresByGame[gid] = rh;
            try { roomHighScoreEditedTimestamps[gid] = Date.now(); } catch(e){}
          } else if (rh && typeof rh.score === 'number' && typeof score === 'number' && Number(rh.score) === Number(score)) {
            // If our local score equals the cached room high score, prefer our live name.
            rh.name = localName;
            roomHighScoresByGame[gid] = rh;
            try { roomHighScoreEditedTimestamps[gid] = Date.now(); } catch(e){}
          } else if (rh && rh.name && String(rh.name || '').trim().toLowerCase() === String(prevLocalName || '').trim().toLowerCase()) {
            // If the cached name matches our previous name, treat the edit as a rename of the same identity.
            try {
              rh.name = localName;
              roomHighScoresByGame[gid] = rh;
              roomHighScoreEditedTimestamps[gid] = Date.now();
            } catch(e){}
          }

          // Propagate name-change to server if supported so authoritative records can be updated.
          try {
            if (window.NET) {
              if (typeof window.NET.sendNameChange === 'function') {
                window.NET.sendNameChange({ name: localName });
              } else if (NET && NET.socket && typeof NET.socket.emit === 'function') {
                NET.socket.emit('name_change', { name: localName });
              } else if (typeof NET.send === 'function') {
                NET.send('name_change', { name: localName });
              }
            }
          } catch(e){ /* non-fatal */ }

          prevLocalName = localName;
        } catch(e){}
      } catch(e){} 
    });
    playerNameEl.addEventListener('input', () => { 
      try { 
        ensureLocalNameUnique(); 
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
        // Ensure cached room highscore updates when our local name changes.
        try {
          const gid = currentGameId || 'default';
          const rh = roomHighScoresByGame[gid];
          const localCid = (function(){ try { return localStorage.getItem('hand_ninja_client_id'); } catch(e){ return null; } })();
          const localName = (playerNameEl.value || playerNameEl.placeholder) ? String(playerNameEl.value || playerNameEl.placeholder) : '';

          // Update when we can reliably attribute the cached entry to ourselves
          if (rh && rh.clientId && localCid && rh.clientId === localCid) {
            rh.name = localName;
            roomHighScoresByGame[gid] = rh;
            try { roomHighScoreEditedTimestamps[gid] = Date.now(); } catch(e){}
          } else if (rh && typeof rh.score === 'number' && typeof score === 'number' && Number(rh.score) === Number(score)) {
            // If our local score equals the cached room high score, prefer our live name.
            rh.name = localName;
            roomHighScoresByGame[gid] = rh;
            try { roomHighScoreEditedTimestamps[gid] = Date.now(); } catch(e){}
          } else if (rh && rh.name && String(rh.name || '').trim().toLowerCase() === String(prevLocalName || '').trim().toLowerCase()) {
            // If the cached name matches our previous name, treat the edit as a rename of the same identity.
            try {
              rh.name = localName;
              roomHighScoresByGame[gid] = rh;
              roomHighScoreEditedTimestamps[gid] = Date.now();
            } catch(e){}
          }

          // Propagate name-change to server if supported so authoritative records can be updated.
          try {
            if (window.NET) {
              if (typeof window.NET.sendNameChange === 'function') {
                window.NET.sendNameChange({ name: localName });
              } else if (NET && NET.socket && typeof NET.socket.emit === 'function') {
                NET.socket.emit('name_change', { name: localName });
              } else if (typeof NET.send === 'function') {
                NET.send('name_change', { name: localName });
              }
            }
          } catch(e){ /* non-fatal */ }

          prevLocalName = localName;
        } catch(e){}
      } catch(e){} 
    });
    playerNameEl.addEventListener('blur',  () => { 
      try { 
        ensureLocalNameUnique(); 
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
      } catch(e){} 
    });
    // Ensure initial placeholder / value is unique with current peers and refresh highscore UI.
    try { ensureLocalNameUnique(); if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
  } catch(e) {}
}

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
// ensure the main UI (music checkbox) sits above the centered menu overlay so it remains clickable
try { const uiEl = document.getElementById('ui'); if (uiEl) uiEl.style.zIndex = '60'; } catch(e){}
// initialize camera and MediaPipe immediately - keep controls disabled until fully ready
try { if (typeof warmCameraWithMediaPipe === 'function') warmCameraWithMediaPipe().catch(()=>{}); } catch(e){}

/*
NET integration: respond to authoritative room events.
- When server emits `game_start` clients (admin and non-admin) will set selector/time and call startGame().
- When server emits `game_end` clients will call endGame().
This keeps game lifecycle authoritative on the server while allowing clients to prepare camera/assets.
*/
if (window.NET) {
  try {
    // server-driven game start: request readiness, preload, then wait for authoritative begin
    NET.on('game_start', (data) => {
        try {
          // honor server-selected game and timeLimit in the UI
          if (data && data.game) {
            const sel = document.getElementById('gameSelect');
            if (sel) sel.value = data.game;
            // Make the server's game selection authoritative locally so subsequent logic uses it
            try { currentGameId = data.game; } catch (e) { /* ignore if not writable */ }
          }
          if (data && typeof data.timeLimit === 'number') {
            const gl = document.getElementById('gameLength');
            if (gl) gl.value = data.timeLimit;
          }

          // Accept server-provided scheduled items (if present). Items are expected to have
          // a spawnTime offset (ms) relative to the authoritative game start time.
          try {
            scheduledGameItems = Array.isArray(data && data.items) ? (data.items.slice()) : scheduledGameItems;
          } catch (e) { scheduledGameItems = scheduledGameItems || []; }

        // Show "waiting" overlay while we preload and warm camera/audio
        showWaitingForPlayersOverlay(true, 'Preparing your client — loading assets and hand tracking');

        // Notify server immediately that client is ready for authoritative begin (do not wait for warm tasks)
        const readyPayload = {
          game: (data && data.game) ? data.game : currentGameId,
          timeLimit: (data && typeof data.timeLimit === 'number') ? data.timeLimit : Number(gameLengthEl.value || 45),
          name: (playerNameEl && playerNameEl.value) ? String(playerNameEl.value).slice(0,24) : undefined
        };
        try {
          if (typeof NET.sendClientReady === 'function') {
            NET.sendClientReady(readyPayload);
          } else if (NET.socket && typeof NET.socket.emit === 'function') {
            NET.socket.emit('client_ready', readyPayload);
          } else if (typeof NET.send === 'function') {
            NET.send('client_ready', readyPayload);
          }
        } catch (e) { console.warn('Failed to notify server of readiness (early)', e); }

        // Start background preload + warm tasks (non-blocking)
        (async () => {
          try {
            // warm camera & mediapipe (does not mark running)
            await warmCameraWithMediaPipe().catch(()=>{});
            // ensure AudioContext exists
            ensureAudioCtx();
            // Kick off preload & decode tasks but do NOT await them here to avoid blocking UI / join flow.
            // This reduces the chance of long blocking waits (fetch/decode) causing a black screen delay.
            preloadAssets().catch(()=>{});
            ensureDecodedSfxAll().catch(()=>{});
            if (ASSETS && ASSETS.bgm) {
              // decode in background (best-effort)
              decodeBgmBuffer(ASSETS.bgm).catch(()=>{});
            }
          } catch (e) {
            console.warn('Preload/warm tasks failed', e);
          }
        })();

        // Fallback: if server does not issue game_begin in time, start locally after timeout
        try { if (window.__handNinja) window.__handNinja._gameBegun = false; } catch(e){}
        const fallbackMs = 8000; // wait 8s for game_begin
        if (window.__handNinja && window.__handNinja._gameStartFallbackTimeout) {
          try { clearTimeout(window.__handNinja._gameStartFallbackTimeout); } catch(e){}
        }
        window.__handNinja._gameStartFallbackTimeout = setTimeout(() => {
          try {
            // If we're inside a server room and not the admin, do NOT start a local fallback.
            // Wait for the room admin / server to send the authoritative `game_begin`.
            const roomsStateInner = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
            const inRoom = roomsStateInner && roomsStateInner.room;
            const isAdmin = roomsStateInner && roomsStateInner.isAdmin;
            if (!window.__handNinja._gameBegun) {
              if (inRoom && !isAdmin) {
                console.warn('No game_begin received; waiting for room admin to start authoritative game.');
                // keep the waiting overlay visible and do not start local game
                showWaitingForPlayersOverlay(true, 'Waiting for room admin to start the game…');
                return;
              }
              // Not in a room or we are the admin — safe to fall back to a local start
              console.warn('Fallback: server did not send game_begin in time; starting local game');
              showWaitingForPlayersOverlay(false);
              // seed RNG from current time for local randomness
              seedRng(Date.now());
              startGame();
            }
          } catch (e) { console.warn('fallback start failed', e); }
        }, fallbackMs);
      } catch (e) { console.warn('game_start handler failed', e); }
    });

    NET.on('game_end', (data) => {
      try {
        endGame();
      } catch (e) { console.warn('game_end handler failed', e); }
    });

    // Server authoritative begin: server sends a startTime (epoch ms) and optional seed for deterministic spawns.
    NET.on('game_begin', (data) => {
      try {
        console.log('Received server game_begin:', data);
        
        // mark begun and clear fallback timer
        try { if (window.__handNinja) window.__handNinja._gameBegun = true; } catch(e){}
        try { if (window.__handNinja && window.__handNinja._gameStartFallbackTimeout) { clearTimeout(window.__handNinja._gameStartFallbackTimeout); window.__handNinja._gameStartFallbackTimeout = null; } } catch(e){}

        // Extract startTime and seed
        const startEpoch = (data && data.startTime) ? Number(data.startTime) : Date.now();
        const seed = (typeof data.seed === 'number') ? Number(data.seed) : (data && data.seed ? Number(String(data.seed).split('').reduce((s,c)=>s + c.charCodeAt(0),0)) : Date.now());

        console.log(`Server game_begin - startEpoch: ${startEpoch}, seed: ${seed}, currentGame: ${currentGameId}`);

          // record authoritative epoch and prepare scheduled items (either server-sent or generated from seed)
        try {
          // mark server-authoritative early so local fallback generators and spawn heuristics
          // reduce their density for multiplayer games. This prevents generateGameItems()
          // from producing a full solo-sized set when we are actually running an authoritative run.
          serverAuthoritative = true;

          serverStartEpoch = startEpoch;
          const roomsStateInner = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
          const inRoom = roomsStateInner && roomsStateInner.room;
          const isAdmin = roomsStateInner && roomsStateInner.isAdmin;

            if (Array.isArray(data && data.items) && data.items.length) {
            // Use server-supplied scheduled items when available
            scheduledGameItems = data.items.slice();

            // If this is a multiplayer authoritative run, reduce the client-side visual density
            // by sampling the scheduled list according to SERVER_SPAWN_MULTIPLIER. Use the
            // deterministic RNG when seeded so clients remain visually consistent.
            try {
              if (serverAuthoritative && Array.isArray(scheduledGameItems) && scheduledGameItems.length > 8) {
                try {
                  const sampled = [];
                  for (let i = 0; i < scheduledGameItems.length; i++) {
                    const r = (typeof deterministicRng === 'function') ? deterministicRng() : Math.random();
                    if (r < SERVER_SPAWN_MULTIPLIER) sampled.push(scheduledGameItems[i]);
                  }
                  // If sampling removed everything (rare), fall back to taking every-other item
                  if (sampled.length && sampled.length > 0) {
                    scheduledGameItems = sampled;
                  } else {
                    scheduledGameItems = scheduledGameItems.filter((_, i) => (i % 2) === 0);
                  }
                } catch (innerE) {
                  // conservative fallback: every-other item
                  scheduledGameItems = scheduledGameItems.filter((_, i) => (i % 2) === 0);
                }
              }
            } catch (e) { /* ignore trimming failures */ }

          } else if (inRoom && !isAdmin) {
            // In a room and not admin: do NOT locally generate authoritative items.
            // Clients should await authoritative items from the server to ensure identical state.
            scheduledGameItems = [];
            console.warn('No items provided by server; awaiting authoritative items from server for room participants.');
          } else {
            // Solo play or admin: generate deterministic items locally from seed as a fallback
            // serverAuthoritative already true above, so generateGameItems will reduce density accordingly.
            scheduledGameItems = generateGameItems(currentGameId, seed) || [];
          }
        } catch (e) {
          scheduledGameItems = scheduledGameItems || [];
          // If anything fails, be conservative and ensure serverAuthoritative is unset so we don't accidentally shrink caps elsewhere.
          serverAuthoritative = false;
          console.warn('Failed to prepare scheduled game items', e);
        }

        // Seed deterministic RNG to ensure synchronized spawn/maze generation
        try { seedRng(seed); } catch(e){ console.warn('seedRng failed', e); }

        // Hide waiting UI
        showWaitingForPlayersOverlay(false);

        // Compute delay until the authoritative start
        const delay = Math.max(0, startEpoch - Date.now());
        console.log(`Game_begin delay: ${delay}ms`);

        // Initialize game state function
        const initializeGameState = () => {
          try {
            console.log(`Initializing synchronized game state for ${currentGameId}`);
            
            // Only clear to black when the camera/video is not producing frames yet.
            // Clearing unconditionally can produce a visible black screen while the camera warms up.
            try {
              if (!videoEl || (typeof videoEl.readyState === 'undefined') || videoEl.readyState < 2) {
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);
              }
            } catch (e) { /* ignore canvas clear failures */ }
            
            // Reset all state
            score = 0;
            objects.length = 0;
            particles.length = 0;
            popups.length = 0;
            
            // Clear mode-specific state
            if (paintPaths) paintPaths.length = 0;
            if (shapes) shapes.length = 0;
            if (shapeCovered) shapeCovered.length = 0;
            
            // Mode-specific initialization with seed
            if (currentGameId === 'runner-control') {
              runnerControlModule.onStart && runnerControlModule.onStart();
            } else if (currentGameId === 'maze-mini') {
              mazeModule.onStart && mazeModule.onStart();
            } else if (currentGameId === 'shape-trace') {
              const s = generateRandomShape();
              shapes = [s];
              shapeCovered = new Array(Math.max(0, s.points.length - 1)).fill(false);
              window.__handNinja._shapeCoveredCount = 0;
              shapeIndex = 0;
              shapeProgress = 0;
            } else if (currentGameId === 'paint-air') {
              paintPaths.length = 0;
              paintTrack.length = 0;
              paintOnTrackLen = 0;
              paintModeNoTimer = true;
              showPaintToolbar(true);
            }
            
            // Align local timers and spawn anchors
            startTime = performance.now();
            lastFrameTime = performance.now();
            lastFruitSpawn = startTime;
            lastBombSpawn = startTime;
            
            // Start music at game begin - both solo and multiplayer
            try {
              const mc = window.__handNinja && window.__handNinja.musicController;
              const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
              const isAdmin = !!(roomsState && roomsState.isAdmin);
              const forcePlayAll = !!(data && data.forcePlayAll);

              // Policy:
              // - If server forces playback (forcePlayAll), start BGM on all clients.
              // - Otherwise start only when local preference allows it (musicEnabled) AND client is admin or not in a room.
              // - If not starting, preload/decode the BGM so it can start quickly when allowed.
              if (mc && typeof mc.startGame === 'function') {
                if (forcePlayAll || (musicEnabled && (!roomsState || isAdmin))) {
                  // Use controller API to start music; controller should handle user gesture requirements and fallbacks.
                  try { mc.startGame(); } catch (e) { console.warn('musicController.startGame failed, falling back', e); }
                  console.log('Game music started (policy allowed) on game_begin');
                } else {
                  // Preload but do not autoplay for non-admin room users or when music disabled.
                  try { if (ASSETS && ASSETS.bgm) decodeBgmBuffer(ASSETS.bgm).catch(()=>{}); } catch(e){}
                  console.log('Game music preloaded (not auto-starting) on game_begin');
                }
              } else {
                // No controller available: fallback to direct playback or preload.
                if (forcePlayAll || (musicEnabled && (!roomsState || isAdmin))) {
                  try {
                    if (ASSETS && ASSETS.bgm) {
                      playDecodedBgm(ASSETS.bgm, { vol: 0.8, loop: true });
                    } else {
                      playSound('bgm');
                    }
                  } catch (e) {
                    try { playSound('bgm'); } catch (e2) {}
                  }
                  console.log('Fallback game music started (policy allowed) on game_begin');
                } else {
                  try { if (ASSETS && ASSETS.bgm) decodeBgmBuffer(ASSETS.bgm).catch(()=>{}); } catch(e){}
                  console.log('Fallback: preloaded BGM (not auto-starting) on game_begin');
                }
              }
            } catch (e) { console.warn('BGM start gating failed on game_begin', e); }
            
            running = true;
            menuEl.style.display = 'none';
            // ensure UI reflects run state immediately (show Leave button)
            try { updateUI(); } catch (e) {}
            
            // Set appropriate start message
            if (currentGameId === 'ninja-fruit') {
              noticeEl.textContent = 'Multiplayer game started — slice fruits, avoid bombs!';
            } else if (currentGameId === 'paint-air') {
              noticeEl.textContent = 'Multiplayer Paint Air — draw freely!';
            } else if (currentGameId === 'shape-trace') {
              noticeEl.textContent = 'Multiplayer Shape Trace — trace the shape outline!';
            } else if (currentGameId === 'runner-control') {
              noticeEl.textContent = 'Multiplayer Runner Control — stay alive!';
            } else if (currentGameId === 'maze-mini') {
              noticeEl.textContent = 'Multiplayer Maze — reach the exit!';
            } else {
              noticeEl.textContent = 'Multiplayer game started!';
            }
            
            console.log(`Game state initialized successfully for ${currentGameId}`);
            
          } catch(e) { 
            console.error('Game state initialization failed:', e);
            noticeEl.textContent = 'Game initialization failed - check console';
          }
        };

        // Schedule synchronized start
        if (delay > 0) {
          setTimeout(initializeGameState, delay);
        } else {
          // start immediately
          initializeGameState();
        }
      } catch (e) { console.error('game_begin handler failed:', e); }
    });

    // Optional: update local UI when room metadata changes
    NET.on('room_update', (data) => {
      try {
        // keep local selector in sync when room shifts selection (non-disruptive)
        if (!data) return;
        const sel = document.getElementById('gameSelect');
        if (sel && data.game) sel.value = data.game;
        const gl = document.getElementById('gameLength');
        if (gl && typeof data.timeLimit === 'number') gl.value = data.timeLimit;

        // Apply admin-selected game BGM for all clients — update asset mapping but do not force playback here
        try { if (typeof updateGameBGM === 'function' && data && data.game) updateGameBGM(data.game, { force: false }); } catch (e) { console.warn('updateGameBGM failed on room_update', e); }

        // If the admin changed the selected game for the room, treat this as a room-level reset
        // but only apply the zero-reset when it makes sense:
        // - do not clobber a live higher peer/local score for the same game
        // - prefer to reset when there is no positive live score (so the UI shows a clean "0" for a fresh game)
        // This prevents an unconditional room-wide zero that would hide valid live highs when players are mid-game.
        try {
          if (data && data.game) {
            const gid2 = String(data.game);
            // compute best live score among peers (and local) to avoid overwriting a real high
            let bestLiveScore = 0;
            try {
              // consider recent peers only (reuse presence threshold used elsewhere)
              const PRESENCE_THRESHOLD_MS = 120000;
              const nowTs = Date.now();
              for (const st of Object.values(peerGhosts || {})) {
                try {
                  if (!st || typeof st.score !== 'number') continue;
                  if (!st.lastTs || (nowTs - Number(st.lastTs)) > PRESENCE_THRESHOLD_MS) continue;
                  if (Number(st.score) > bestLiveScore) bestLiveScore = Number(st.score);
                } catch(e){}
              }
              // also include local player's current score when it's for the same selected game
              try {
                const sel = document.getElementById('gameSelect');
                const selected = sel && sel.value ? String(sel.value) : currentGameId;
                if (selected === gid2 && typeof score === 'number' && Number(score) > bestLiveScore) bestLiveScore = Number(score);
              } catch(e){}
            } catch (e) { /* ignore live-scan failures */ }

            const clientId = (function() { try { return localStorage.getItem('hand_ninja_client_id'); } catch(e) { return null; } })();

            // Apply reset only when there is no live positive score to preserve the true room best.
            if (bestLiveScore <= 0) {
              const resetEntry = { name: 'Player', score: 0, game: gid2, clientId: clientId || null };
              // mark as a server-provided reset so clients consider it authoritative now
              resetEntry._serverTs = Date.now();
              roomHighScoresByGame[gid2] = resetEntry;
              roomHighScore = roomHighScoresByGame[gid2];
              try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
            } else {
              // If there's a live best, do not overwrite server cache; instead ensure display refresh
              try {
                if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay();
              } catch(e){}
            }
          }
        } catch (e) {
          console.warn('Failed to apply room_update reset for game', data && data.game, e);
        }

        // show a short notice when admin changes options
        if (typeof noticeEl !== 'undefined' && noticeEl) {
          noticeEl.textContent = `Room updated: ${data.game || ''} · ${data.timeLimit || ''}s`;
          setTimeout(()=> { try { noticeEl.textContent = ''; } catch(e){} }, 1400);
        }
      } catch(e){ console.warn('room_update handler failed', e); }
    });

    // Server may emit explicit music control events to start/stop BGM across clients.
    // These handlers respect room/admin policy and local user preference unless the server forces playback.
    NET.on('music_play', (data) => {
      try {
        data = data || {};
        // allow server to override the BGM asset
        if (data.bgmUrl) {
          ASSETS.bgm = data.bgmUrl;
          try { if (window.__handNinja && window.__handNinja._simpleAudio) window.__handNinja._simpleAudio.map.bgm = data.bgmUrl; } catch(e){}
        }

        const forcePlayAll = !!data.forcePlayAll;
        const mc = window.__handNinja && window.__handNinja.musicController;

        // Prefer the centralized music controller when available
        if (mc && typeof mc.startGame === 'function') {
          if (forcePlayAll) {
            mc.startGame();
          } else {
            // Only auto-start when allowed: either not in a room, or user is admin, and user has music enabled.
            const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
            const allowed = !(roomsState && roomsState.room) || (roomsState && roomsState.isAdmin);
            if (musicEnabled && allowed) {
              mc.startGame();
            } else {
              // Preload/decode for faster start if user later enables/admits playback
              try { if (ASSETS && ASSETS.bgm) decodeBgmBuffer(ASSETS.bgm).catch(()=>{}); } catch(e){}
            }
          }
          return;
        }

        // Fallback legacy behavior when musicController missing
        if (forcePlayAll || (musicEnabled && (!(window.ROOMS_UI && window.ROOMS_UI.state && window.ROOMS_UI.state.room) || (window.ROOMS_UI && window.ROOMS_UI.state && window.ROOMS_UI.state.isAdmin)))) {
          try { playDecodedBgm(ASSETS && ASSETS.bgm, { vol: 0.8, loop: true }); } catch(e){ try { playSound('bgm'); } catch(e){} }
        } else {
          try { if (ASSETS && ASSETS.bgm) decodeBgmBuffer(ASSETS.bgm).catch(()=>{}); } catch(e){}
        }
      } catch(e) { console.warn('music_play handler failed', e); }
    });

    NET.on('music_stop', (data) => {
      try {
        data = data || {};
        const forceStopAll = !!data.forceStopAll;
        const mc = window.__handNinja && window.__handNinja.musicController;
        if (mc && typeof mc.stopGame === 'function') {
          if (forceStopAll) {
            mc.stopGame();
          } else {
            // Only stop for solo/admin clients; do not forcibly stop non-admin room users unless server requested.
            const roomsState = (window.ROOMS_UI && window.ROOMS_UI.state) ? window.ROOMS_UI.state : null;
            const allowed = !(roomsState && roomsState.room) || (roomsState && roomsState.isAdmin);
            if (allowed) mc.stopGame();
            // otherwise leave client preference intact but ensure preload/decoded buffers are cleared
            else try { stopDecodedBgm(); } catch(e){}
          }
          return;
        }

        // legacy fallback
        if (forceStopAll || (!(window.ROOMS_UI && window.ROOMS_UI.state && window.ROOMS_UI.state.room) || (window.ROOMS_UI && window.ROOMS_UI.state && window.ROOMS_UI.state.isAdmin))) {
          try { stopAllAudio(); } catch(e){}
        } else {
          try { stopDecodedBgm(); } catch(e){}
        }
      } catch(e) { console.warn('music_stop handler failed', e); }
    });

    // Peer hand updates: receive quantized payloads from other clients and render ghost hands
    function handlePeerHand(data) {
      try {
        if (!data) return;
        // Accept either server-wrapped { id, payload } or raw payload with .id
        const id = data.id || (data.payload && data.payload.id) || (data.clientId || data.peerId) || null;
        if (!id) return;

        const payload = (data.payload && typeof data.payload === 'object') ? data.payload : data;

        // payload may include cw/ch (sender canvas size) and lm in multiple formats.
        // Normalize into an array-of-hands where each hand is an array of point-like entries.
        let rawHands = [];
        const lm = (payload && payload.lm !== undefined) ? payload.lm : undefined;

        // Helper: detect MediaPipe-style array of point objects [{x,y,z}, ...]
        const isPointsArray = (arr) => Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null && typeof arr[0].x === 'number' && typeof arr[0].y === 'number';

        // Debug: log incoming payload shape for easier diagnosis of edge cases
        try { console.debug && console.debug('handlePeerHand recv', { id, lmType: (Array.isArray(lm) ? (Array.isArray(lm[0]) ? 'array-of-arrays' : 'array') : typeof lm), keys: Object.keys(payload || {}) }); } catch(e){}

        if (Array.isArray(lm)) {
          if (lm.length === 0) {
            rawHands = [];
          } else if (isPointsArray(lm)) {
            // single hand as array of point objects
            rawHands = [lm];
          } else if (Array.isArray(lm[0])) {
            // nested arrays: could be multi-hand quantized, single-hand quantized (21 triplets), or multi-hand point arrays
            const first0 = lm[0];

            // If inner arrays contain number triplets like [qx,qy,qz], detect by checking the first element type
            if (first0.length && typeof first0[0] === 'number') {
              // Heuristic: if top-level array length equals 21, treat as a single quantized hand
              if (lm.length === 21) {
                rawHands = [lm];
              } else {
                // If each child is length 21, treat as array-of-hands (multi-hand quantized)
                if (lm.every(h => Array.isArray(h) && h.length === 21)) {
                  rawHands = lm;
                } else {
                  // Ambiguous: commonly this is either single-hand quantized or multi-hand quantized.
                  // Prefer treating as multi-hand if each child element is itself an array of triplets.
                  const looksLikeMulti = lm.every(h => Array.isArray(h) && Array.isArray(h[0]) && typeof h[0][0] === 'number');
                  rawHands = looksLikeMulti ? lm : [lm];
                }
              }
            } else if (isPointsArray(first0)) {
              // multi-hand raw points
              rawHands = lm;
            } else {
              // unknown nested format; pass-through as best-effort
              rawHands = lm;
            }
          } else {
            // flat array but not points array (ambiguous) — treat as single hand
            rawHands = [lm];
          }
        } else if (Array.isArray(payload)) {
          rawHands = [payload];
        } else if (Array.isArray(payload && payload.landmarks)) {
          rawHands = [payload.landmarks];
        } else {
          rawHands = [];
        }

        if (!rawHands || rawHands.length === 0) return;

        // Helper: map varied point formats to canvas pixel coords
        const targetW = canvas.width / DPR;
        const targetH = canvas.height / DPR;
        const srcW = Number(payload.cw) || null;
        const srcH = Number(payload.ch) || null;

        function mapPoint(pt) {
          if (!pt) return null;
          let x = null, y = null, z = null;

          if (Array.isArray(pt)) {
            x = Number(pt[0]);
            y = Number(pt[1]);
            z = (pt.length > 2) ? Number(pt[2]) : null;
          } else if (typeof pt === 'object') {
            x = Number(pt.x);
            y = Number(pt.y);
            z = (typeof pt.z === 'number') ? Number(pt.z) : null;
          } else {
            return null;
          }

          if (isNaN(x) || isNaN(y)) return null;

          const iwLocal = (videoEl && videoEl.videoWidth) ? videoEl.videoWidth : (canvas.videoWidth || (canvas.width / DPR));
          const ihLocal = (videoEl && videoEl.videoHeight) ? videoEl.videoHeight : (canvas.videoHeight || (canvas.height / DPR));
          const tLocal = computeCoverTransform(iwLocal, ihLocal, targetW, targetH);

          if (srcW && srcH && srcW > 0 && srcH > 0 && x >= 0 && y >= 0 && x <= srcW && y <= srcH) {
            const sx = x * (targetW / srcW);
            const sy = y * (targetH / srcH);
            return { x: sx, y: sy, z: (typeof z === 'number' ? z : 0) };
          }

          if (x >= 0 && x <= NET_QUANT_MAX && y >= 0 && y <= NET_QUANT_MAX && Number.isInteger(x) && Number.isInteger(y)) {
            const nxf = (x / NET_QUANT_MAX);
            const nyf = (y / NET_QUANT_MAX);
            const px = tLocal.dx + nxf * iwLocal * tLocal.scale;
            const py = tLocal.dy + nyf * ihLocal * tLocal.scale;
            const nz = (typeof z === 'number' ? (z === -1 ? 0 : (z / (NET_QUANT_MAX / 2) - 1)) : 0);
            return { x: px, y: py, z: nz };
          }

          if (Math.abs(x) <= 1.01 && Math.abs(y) <= 1.01) {
            const nxf = x;
            const nyf = y;
            const px = tLocal.dx + nxf * iwLocal * tLocal.scale;
            const py = tLocal.dy + nyf * ihLocal * tLocal.scale;
            const nz = (typeof z === 'number' ? z : 0);
            return { x: px, y: py, z: nz };
          }

          if (srcW && srcH && srcW > 0 && srcH > 0) {
            const sx = x * (targetW / srcW);
            const sy = y * (targetH / srcH);
            return { x: sx, y: sy, z: (typeof z === 'number' ? z : 0) };
          }

          return { x: x, y: y, z: (typeof z === 'number' ? z : 0) };
        }

        const convertedHands = rawHands.map(hand => {
          if (!Array.isArray(hand)) return [];
          return hand.map(mapPoint).filter(p => p && typeof p.x === 'number' && typeof p.y === 'number' && !isNaN(p.x) && !isNaN(p.y));
        }).filter(h => h && h.length);
        
        if (!convertedHands.length) return;
        
        // Heuristic: detect horizontal mirroring issues by checking how many mapped points fall inside the local canvas.
        // If flipping X (mirror) yields a higher on-canvas ratio, prefer the flipped coordinates.
        const canvasW = canvas.width / DPR;
        const canvasH = canvas.height / DPR;
        function computeInsideRatio(hands) {
          let total = 0, inside = 0;
          for (const h of hands) {
            for (const p of h) {
              total++;
              if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                if (p.x >= 0 && p.x <= canvasW && p.y >= 0 && p.y <= canvasH) inside++;
              }
            }
          }
          return total ? (inside / total) : 0;
        }
        function flipHandsHoriz(hands) {
          return hands.map(h => h.map(p => ({ x: (typeof p.x === 'number' ? (canvasW - p.x) : p.x), y: p.y, z: p.z })));
        }
        
        let finalHands = convertedHands;
        try {
          const origRatio = computeInsideRatio(convertedHands);
          const flipped = flipHandsHoriz(convertedHands);
          const flipRatio = computeInsideRatio(flipped);
          // If sender explicitly included a selfie/mirror hint, respect it (prefer original if selfie==true)
          const preferOriginal = payload && (payload.selfie === true || payload.mirror === true);
          if (!preferOriginal && flipRatio > origRatio + 0.03) {
            finalHands = flipped;
            console.debug && console.debug('handlePeerHand: applied horizontal flip for peer', id, { origRatio, flipRatio });
          } else {
            // keep original; but if payload hints selfie true and original looks out-of-bounds, consider flipping
            if (preferOriginal && origRatio < 0.2 && flipRatio > origRatio) {
              finalHands = flipped;
              console.debug && console.debug('handlePeerHand: forced flip due to selfie hint for peer', id, { origRatio, flipRatio });
            }
          }
        } catch (errFlip) {
          // if anything goes wrong in heuristic, fall back to original mapped hands
          finalHands = convertedHands;
        }
        
        const nowTs = Date.now();
        const st = peerGhosts[id] || {};
        
        st.hands = finalHands;
        st.target = finalHands[0] || null;
        st.lastTs = nowTs;
        st.name = data.name || data.displayName || data.nick || payload.name || st.name || 'Player';

        if (!st.displayHands || !Array.isArray(st.displayHands) || st.displayHands.length !== convertedHands.length) {
          st.displayHands = convertedHands.map(h => h.map(p => ({ x: p.x || 0, y: p.y || 0, z: p.z || 0 })));
        } else {
          for (let i = 0; i < convertedHands.length; i++) {
            const tgt = convertedHands[i];
            const disp = st.displayHands[i] || [];
            if (disp.length !== tgt.length) {
              st.displayHands[i] = tgt.map(p => ({ x: p.x || 0, y: p.y || 0, z: p.z || 0 }));
            }
          }
        }

        peerGhosts[id] = st;
        // If this peer reports a score and we previously stored a room high with that score,
        // update the stored entry's name when the peer's name arrives later.
        try {
          if (st && typeof st.score === 'number') {
            for (const gid of Object.keys(roomHighScoresByGame || {})) {
              try {
                const existing = roomHighScoresByGame[gid];
                if (existing && typeof existing.score === 'number' && existing.score === st.score && existing.name !== st.name) {
                  roomHighScoresByGame[gid] = Object.assign({}, existing, { name: st.name });
                  if (gid === currentGameId) {
                    try { updateRoomHighScoreDisplay(); } catch(e){}
                  }
                }
              } catch(e){}
            }
          }
        } catch(e){}

        // Recompute local peer display names to avoid duplicate visible names,
        // then ensure the local player's name suggestion remains unique.
        try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
        try { if (typeof ensureLocalNameUnique === 'function') ensureLocalNameUnique(); } catch(e){}

        // Keep room high score UI in sync after peer name/score/name-disambiguation changes.
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}

        console.debug && console.debug(`Updated peer ghost ${id}: ${convertedHands.length} hand(s), name: ${st.name}`);
        try { if (typeof window !== 'undefined' && typeof window.__peerDebugUpdate === 'function') window.__peerDebugUpdate(id, 'hand'); } catch(e){}
      } catch (err) {
        console.warn('Peer hand parsing error:', err);
      }
    }

    NET.on('peer_hand', handlePeerHand);
    // DOM fallback for net:peer_hand (dispatched by NET wrapper)
    try { window.addEventListener && window.addEventListener('net:peer_hand', (e) => { try { handlePeerHand(e && e.detail ? e.detail : e); } catch(ex){} }); } catch(e){}

    // Incoming peer paints (forwarded by server). Convert to local canvas coords and store.
    function handlePeerPaint(data) {
      try {
        if (!data) return;

        const payload = (data.payload && typeof data.payload === 'object') ? data.payload : data;
        const id = data.id || payload.id || payload.peerId || payload.clientId || payload.from || payload.senderId;
        if (!id) return;

        const pts = Array.isArray(payload.pts) ? payload.pts : (Array.isArray(payload.points) ? payload.points : (Array.isArray(payload.path) ? payload.path : []));
        if (!pts || !pts.length) return;

        const cwSrc = (payload.cw != null) ? Number(payload.cw) : (payload.canvasWidth != null ? Number(payload.canvasWidth) : null);
        const chSrc = (payload.ch != null) ? Number(payload.ch) : (payload.canvasHeight != null ? Number(payload.canvasHeight) : null);
        const targetW = canvas.width / DPR;
        const targetH = canvas.height / DPR;

        const converted = [];
        for (const raw of pts) {
          if (!raw) continue;
          let rx = null, ry = null, rt = null, rcolor = null, rsize = null;
          if (Array.isArray(raw)) {
            rx = Number(raw[0]);
            ry = Number(raw[1]);
            rt = raw[2] ? Number(raw[2]) : Date.now();
          } else if (typeof raw === 'object') {
            rx = Number(raw.x);
            ry = Number(raw.y);
            rt = raw.t ? Number(raw.t) : Date.now();
            rcolor = raw.color;
            rsize = raw.size;
          } else {
            continue;
          }
          if (isNaN(rx) || isNaN(ry)) continue;

          let x = rx, y = ry;
          if (cwSrc && chSrc && cwSrc > 0 && chSrc > 0 && rx >= 0 && ry >= 0 && rx <= cwSrc && ry <= chSrc) {
            x = rx * (targetW / cwSrc);
            y = ry * (targetH / chSrc);
          } else if (Number.isInteger(rx) && Number.isInteger(ry) && rx >= 0 && ry >= 0 && rx <= NET_QUANT_MAX && ry <= NET_QUANT_MAX) {
            x = (rx / NET_QUANT_MAX) * targetW;
            y = (ry / NET_QUANT_MAX) * targetH;
          } else if (Math.abs(rx) <= 1.01 && Math.abs(ry) <= 1.01) {
            x = rx * targetW;
            y = ry * targetH;
          } else {
            x = rx;
            y = ry;
          }

          if (!isFinite(x) || !isFinite(y) || isNaN(x) || isNaN(y)) continue;
          const point = {
            x: x,
            y: y,
            t: Number(rt || Date.now()),
            color: rcolor || payload.color || paintColor,
            size: rsize || payload.size || paintSize
          };
          converted.push(point);
        }

        if (!converted.length) return;

        const st = peerPaints[id] || [];
        st.push(...converted);
        const MAX_PEER_PAINT = 4000;
        if (st.length > MAX_PEER_PAINT) st.splice(0, st.length - MAX_PEER_PAINT);
        peerPaints[id] = st;

        console.debug && console.debug('peer_paint recv', id, converted.length);
        try { if (typeof window !== 'undefined' && typeof window.__peerDebugUpdate === 'function') window.__peerDebugUpdate(id, 'paint'); } catch(e){}
      } catch (e) {
        console.warn('peer_paint handler failed', e);
      }
    }

    NET.on('peer_paint', handlePeerPaint);

    // Room-level high-score (simplified admin-driven model). Server emits when a new room high is achieved.
    NET.on('room_highscore', (data) => {
      try {
        if (!data) return;
        console.log('Received room_highscore:', data);
        // Cache per-game so UI helpers can prefer live/local names and apply heuristics consistently.
        const gid = (data && data.game) ? String(data.game) : currentGameId || 'default';
        // store a shallow copy but DO NOT blindly stamp a local recv timestamp.
        // Prefer explicit server-provided timestamps when present. If the server did not
        // include a timestamp, preserve any previous _serverTs so recent local resets
        // aren't clobbered by server payloads that lack timing metadata.
        try {
          // preserve previous server timestamp before we overwrite the entry
          const prevServerTs = (roomHighScoresByGame[gid] && Number(roomHighScoresByGame[gid]._serverTs)) ? Number(roomHighScoresByGame[gid]._serverTs) : 0;
          const serverProvidedTs = (data && (Number(data._serverTs) || Number(data.ts) || Number(data.t) || Number(data.updatedAt) || Number(data.updated))) 
            ? Number(data._serverTs || data.ts || data.t || data.updatedAt || data.updated) 
            : 0;

          roomHighScoresByGame[gid] = Object.assign({}, data || {});
          if (serverProvidedTs) {
            // use server-supplied timestamp when available
            roomHighScoresByGame[gid]._serverTs = serverProvidedTs;
          } else {
            // preserve previous server ts (or leave as 0) to avoid overwriting a recent local reset
            roomHighScoresByGame[gid]._serverTs = prevServerTs || 0;
          }
        } catch (e) {
          // fallback: store original object if shallow copy fails
          roomHighScoresByGame[gid] = data;
        }
        roomHighScore = roomHighScoresByGame[gid];

        // Let the centralized display updater handle name resolution (prefers local/peer names when applicable).
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}

        const roomHighScoreEl = document.getElementById('roomHighScore');
        if (roomHighScoreEl && roomHighScore && typeof roomHighScore.score === 'number') {
          const name = (roomHighScore.name || 'Player').slice(0, 12);
          const score = roomHighScore.score;
          roomHighScoreEl.textContent = `Room Best: ${name}: ${score}`;
          roomHighScoreEl.setAttribute('data-visible', 'true');
          roomHighScoreEl.style.display = 'inline-block';
          console.log('Updated room high score display:', name, score);
        } else {
          console.log('Could not update room high score display - element not found or invalid data');
        }
      } catch(e) {
        console.warn('room_highscore handler failed', e);
      }
    });

    // Peer score updates forwarded from server (id + score). Update peerGhosts and show a small popup.
    NET.on('peer_score', (payload) => {
      try {
        if (!payload) return;
        const id = payload.id || payload.clientId || payload.peerId || payload.from;
        const sc = Number(payload.score) || 0;
        if (!id) return;

        // Update peer ghost state
        const st = peerGhosts[id] || {};
        st.score = sc;
        peerGhosts[id] = st;

        // Dynamically update the room high-score for the current game when peers report scores.
        // Prefer payload.game if provided; otherwise assume currentGameId.
        try {
          const gameOfScore = (payload && payload.game) ? String(payload.game) : currentGameId;
          if (gameOfScore) {
            const gid = gameOfScore;
            const existing = roomHighScoresByGame[gid] || null;
            if (!existing || sc > (existing.score || 0)) {
              // preserve previous server timestamp when payload omits timing fields
              const prevServerTs = (roomHighScoresByGame[gid] && Number(roomHighScoresByGame[gid]._serverTs)) ? Number(roomHighScoresByGame[gid]._serverTs) : 0;
              const serverProvidedTs = (payload && (Number(payload._serverTs) || Number(payload.ts) || Number(payload.t) || Number(payload.updatedAt) || Number(payload.updated))) 
                ? Number(payload._serverTs || payload.ts || payload.t || payload.updatedAt || payload.updated) 
                : 0;

              roomHighScoresByGame[gid] = Object.assign({}, { name: st.name || payload.name || 'Player', score: sc, game: gid });
              if (serverProvidedTs) {
                roomHighScoresByGame[gid]._serverTs = serverProvidedTs;
              } else {
                roomHighScoresByGame[gid]._serverTs = prevServerTs || 0;
              }

              // Refresh display if this is the active game
              if (gid === currentGameId) updateRoomHighScoreDisplay();
            }
          }
        } catch (e) { /* ignore highscore update failures */ }

        // Re-run peer-name deduplication so any duplicate names visible in the room are disambiguated,
        // and refresh the room-high UI to reflect the latest peer-driven values.
        try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}

        // If this score belongs to us (our socket id), adopt authoritative score immediately
        try {
          if (NET && NET.socket && NET.socket.id && id === NET.socket.id) {
            score = sc;
            updateUI();
            // show a subtle confirmation popup near HUD
            try { spawnPopup((canvas.width / DPR) - 80, 40, `Score: ${sc}`, { col: 'yellow', size: 14 }); } catch(e){}
          }
        } catch (e) { /* ignore */ }

        // show small popup near peer anchor if available (for remote peers)
        const anchor = (st && st.displayHands && st.displayHands[0] && st.displayHands[0][8]) ? st.displayHands[0][8] : null;
        if (anchor && id !== (NET && NET.socket && NET.socket.id)) {
          spawnPopup(anchor.x, anchor.y - 30, `${st.name || 'Player'}: ${sc}`, { col: 'yellow', size: 14 });
        }
      } catch(e){ console.warn('peer_score handler failed', e); }
    });

    // Server-initiated kick: perform the same cleanup as leaving the room.
    NET.on('kicked', (data) => {
      try {
        console.log('Received kicked event from server', data);
        try { cleanupAfterLeave(); } catch(e){ console.warn('cleanupAfterLeave failed in kicked handler', e); }
        try { noticeEl.textContent = 'You were removed from the room'; setTimeout(() => { noticeEl.textContent = ''; }, 2000); } catch(e){}
      } catch (e) {
        console.warn('kicked handler failed', e);
      }
    });

    // Authoritative object state updates from server (e.g. removed items). Reconcile optimistic state.
    NET.on('object_state', (data) => {
      try {
        if (!data || !data.id) return;
        const objId = data.id;
        const removed = !!data.removed;
        const by = data.by || data.clientId || data.from;
        // find object locally (may be present as tentative)
        const idx = objects.findIndex(o => o.id === objId);
        if (removed) {
          // If object exists, remove and reconcile with any optimistic local state.
          if (idx !== -1) {
            const obj = objects[idx];
            const fx = obj.x, fy = obj.y;

            // If the client already applied an optimistic score for this object,
            // treat this as authoritative confirmation and avoid duplicating effects.
            if (obj._optimisticScore) {
              // If server provided an authoritative score, adopt it; otherwise keep optimistic value.
              if (typeof data.score === 'number') {
                score = Number(data.score);
              }
              // Clean up optimistic bookkeeping
              try { clearTimeout(obj._optimisticTimer); } catch(e){}
              obj._pendingInteraction = false;
              obj._tentativeRemove = false;
              obj._optimisticScore = 0;
              updateUI();
              // Do not spawn duplicate visual/audio since optimistic UI already displayed.
            } else {
              // No optimistic state: spawn authoritative particles / popup based on type
              if (obj.type === 'bomb') {
                spawnParticles(fx, fy, 'rgba(255,80,80,0.95)', 18);
                spawnPopup(fx, fy, '-20', { col: 'rgba(255,80,80,0.95)', size: 20 });
                try { playSound('bomb'); } catch(e){}
              } else {
                spawnParticles(fx, fy, 'rgba(255,255,255,0.95)', 12);
                spawnPopup(fx, fy, '+10', { col: 'rgba(255,240,200,1)', size: 16 });
                try { playSound('slice'); } catch(e){}
              }
            }

            // remove from objects
            objects.splice(idx, 1);
          } else {
            // object already removed locally or never spawned; ignore
          }
        } else {
          // server says object is not removed (possible rejection) -> revert tentative flags if present
          if (idx !== -1) {
            const obj = objects[idx];
            if (obj._tentativeRemove) {
              obj._tentativeRemove = false;
              obj._pendingInteraction = false;
            }
          }
        }
      } catch (e) {
        console.warn('object_state handler failed', e);
      }
    });

    // DOM fallback for net:peer_paint
    try { window.addEventListener && window.addEventListener('net:peer_paint', (e) => { try { handlePeerPaint(e && e.detail ? e.detail : e); } catch(ex){} }); } catch(e){}
  } catch (e) {
    console.warn('NET hook install failed', e);
  }
}

 // Auto-connect NET if available and not explicitly disabled by window.__handNinja.noAutoConnect
 try {
   if (typeof NET !== 'undefined' && NET && !NET.connected) {
     var skip = false;
     try { skip = !!(window.__handNinja && window.__handNinja.noAutoConnect); } catch(e){}
     if (!skip) {
       try { NET.connect(location.origin); } catch(e){}
     }
   }
 } catch(e){}

window.__handNinja = {
  spawnFruit,
  spawnBomb,
  objects,
  particles,
  startGame,
  endGame,
  // simulate peer events for local testing (hand / paint). Usage:
  // window.__handNinja.simulatePeer('peer-id', 'hand', payload) or ('paint', payload)
  simulatePeer: function(id, type, payload) {
    try {
      if (!id) id = 'debug-' + Math.random().toString(36).slice(2,8);
      if (type === 'hand') {
        const dataPayload = payload || {};
        // Normalize payload.lm which may be:
        // - single hand: Array of [x,y,z] points
        // - multi-hand: Array of hands where each hand is an Array of points
        // - direct array payload
        // - object with .landmarks
        let handsArr = [];
        if (Array.isArray(dataPayload.lm)) {
          const first = dataPayload.lm[0];
          if (Array.isArray(first) && Array.isArray(first[0])) {
            handsArr = dataPayload.lm;
          } else {
            handsArr = [dataPayload.lm];
          }
        } else if (Array.isArray(dataPayload)) {
          handsArr = [dataPayload];
        } else if (Array.isArray(dataPayload.landmarks)) {
          handsArr = [dataPayload.landmarks];
        }
        if (!handsArr || handsArr.length === 0) return;
        const cw = canvas.width / DPR;
        const ch = canvas.height / DPR;
        const convertedHands = handsArr.map(hand => {
          if (!Array.isArray(hand)) return [];
          return hand.map(p => {
            let qx = 0, qy = 0, qz = -1;
            if (Array.isArray(p)) {
              qx = Number(p[0] || 0);
              qy = Number(p[1] || 0);
              qz = Number(p[2] == null ? -1 : p[2]);
            } else if (p && typeof p === 'object') {
              qx = Number(p.x || 0);
              qy = Number(p.y || 0);
              qz = (typeof p.z === 'number') ? Number(p.z) : -1;
            }
            qx = isNaN(qx) ? 0 : Math.max(0, Math.min(NET_QUANT_MAX, qx));
            qy = isNaN(qy) ? 0 : Math.max(0, Math.min(NET_QUANT_MAX, qy));
            return {
              x: (qx / NET_QUANT_MAX) * cw,
              y: (qy / NET_QUANT_MAX) * ch,
              z: (qz === -1 ? 0 : (qz / (NET_QUANT_MAX / 2) - 1))
            };
          }).filter(p => p && typeof p.x === 'number' && typeof p.y === 'number' && !isNaN(p.x) && !isNaN(p.y));
        }).filter(h => h && h.length);
        if (!convertedHands.length) return;
        const now = Date.now();
        const st = peerGhosts[id] || {};
        st.hands = convertedHands;
        st.target = convertedHands[0] || null;
        st.lastTs = now;
        st.name = (payload && payload.name) || 'Debug';
        st.displayHands = convertedHands.map(h => h.map(p => ({ x: p.x || 0, y: p.y || 0, z: p.z || 0 })));
        peerGhosts[id] = st;
        console.log('simulatePeer hand', id, convertedHands.length);
      } else if (type === 'paint') {
        const pts = Array.isArray(payload.pts) ? payload.pts : (payload.points || []);
        if (!pts || !pts.length) return;
        const cwSrc = Number(payload.cw) || null;
        const chSrc = Number(payload.ch) || null;
        const targetW = canvas.width / DPR;
        const targetH = canvas.height / DPR;
        const converted = [];
        for (const p of pts) {
          if (!p) continue;
          let x = Number(p.x || 0), y = Number(p.y || 0);
          if (x <= 1 && y <= 1) {
            x = x * targetW;
            y = y * targetH;
          } else if (cwSrc && chSrc && cwSrc > 0 && chSrc > 0) {
            x = x * (targetW / cwSrc);
            y = y * (targetH / chSrc);
          }
          converted.push({ x, y, t: Number(p.t || Date.now()), color: p.color || payload.color || paintColor, size: p.size || paintSize });
        }
        if (!converted.length) return;
        const st = peerPaints[id] || [];
        st.push(...converted);
        if (st.length > 4000) st.splice(0, st.length - 4000);
        peerPaints[id] = st;
        console.log('simulatePeer paint', id, converted.length);
      }
    } catch (e) { console.warn('simulatePeer failed', e); }
  },
  // expose current game id and allow switching from console for testing
  currentGameId: () => currentGameId,
  setCurrentGameId: (id) => { currentGameId = id || 'default'; },
  // lightweight debug helpers for audio: show/hide panel and init overlay
  _showAudioDebug: false,
  showAudioDebugPanel: function() {
    if (typeof document === 'undefined') return;
    var p = document.getElementById('audioDebugPanel');
    if (!p) { if (typeof window.__handNinja.initAudioDebugUI === 'function') window.__handNinja.initAudioDebugUI(); p = document.getElementById('audioDebugPanel'); if(!p) return; }
    this._showAudioDebug = !this._showAudioDebug;
    p.style.display = this._showAudioDebug ? 'block' : 'none';
  },
  initAudioDebugUI: function() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('audioDebugPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'audioDebugPanel';
    Object.assign(panel.style, {
      position: 'fixed',
      right: '12px',
      top: '72px',
      width: '280px',
      maxHeight: '60vh',
      overflow: 'auto',
      background: 'rgba(0,0,0,0.85)',
      color: '#fff',
      padding: '10px',
      borderRadius: '8px',
      zIndex: 99999,
      fontSize: '13px',
      boxShadow: '0 6px 24px rgba(0,0,0,0.5)'
    });
    const header = document.createElement('div');
    header.textContent = 'Audio Debug';
    header.style.fontWeight = '700';
    header.style.marginBottom = '8px';
    panel.appendChild(header);

    const ctrlRow = document.createElement('div');
    ctrlRow.style.display = 'flex';
    ctrlRow.style.gap = '6px';
    const preloadBtn = document.createElement('button');
    preloadBtn.textContent = 'Preload';
    preloadBtn.title = 'Attempt to preload detected assets';
    preloadBtn.style.flex = '1';
    preloadBtn.onclick = function() { try { preloadAssets().catch(()=>{}); } catch(e){} };
    const unlockBtn = document.createElement('button');
    unlockBtn.textContent = 'Unlock';
    unlockBtn.title = 'Mark a user gesture to unlock audio';
    unlockBtn.style.flex = '1';
    unlockBtn.onclick = function() { try { window.__handNinja._userInteracted = true; if (window.__handNinja._simpleAudio && typeof window.__handNinja._simpleAudio.initOnFirstInteraction === 'function') window.__handNinja._simpleAudio.initOnFirstInteraction(); } catch(e){} };

    // Stop / Dump controls for quick debugging of audio state
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop All';
    stopBtn.title = 'Stop all audio sources (decoded, HTMLAudio, SimpleAudio)';
    stopBtn.style.flex = '1';
    stopBtn.onclick = function() {
      try {
        stopAllAudio();
        const msg = 'stopAllAudio() invoked';
        try { console.info && console.info(msg); } catch(e){}
        // also provide immediate visual feedback by inserting a short log line
        const stamp = document.createElement('div');
        stamp.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        stamp.style.fontSize = '12px';
        stamp.style.opacity = '0.9';
        list && list.insertBefore(stamp, list.firstChild);
      } catch(e){}
    };

    const dumpBtn = document.createElement('button');
    dumpBtn.textContent = 'Dump';
    dumpBtn.title = 'Dump current audio debug status';
    dumpBtn.style.flex = '1';
    dumpBtn.onclick = function() {
      try {
        const state = {
          decodedBgmPlaying: !!decodedBgmPlaying,
          decodedBgmUrl: decodedBgmUrl || null,
          bgmAudioSrc: (bgmAudio && bgmAudio.src) ? bgmAudio.src : null,
          simpleAudioBgmKey: (window.__handNinja && window.__handNinja._simpleAudio) ? window.__handNinja._simpleAudio.bgmKey || null : null,
          soundPoolBgm: (soundPool && soundPool.bgm && soundPool.bgm.src) ? soundPool.bgm.src : null,
          sfxBuffersKeys: Object.keys(sfxBuffers || {}),
          musicControllerState: (window.__handNinja && window.__handNinja.musicController && typeof window.__handNinja.musicController.getState === 'function') ? window.__handNinja.musicController.getState() : null
        };
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(state, null, 2);
        pre.style.background = 'rgba(255,255,255,0.02)';
        pre.style.color = '#dfefff';
        pre.style.padding = '8px';
        pre.style.borderRadius = '6px';
        pre.style.marginTop = '8px';
        pre.style.maxHeight = '200px';
        pre.style.overflow = 'auto';
        list && list.insertBefore(pre, list.firstChild);
        try { console.debug && console.debug('Audio debug dump', state); } catch(e){}
      } catch(e){}
    };

    ctrlRow.appendChild(preloadBtn);
    ctrlRow.appendChild(unlockBtn);
    ctrlRow.appendChild(stopBtn);
    ctrlRow.appendChild(dumpBtn);
    panel.appendChild(ctrlRow);

    const list = document.createElement('div');
    list.style.marginTop = '10px';

    // build keys: prefer ASSETS.sfx entries, then include canonical keys
    const sfxKeys = Array.isArray(Object.keys(ASSETS && ASSETS.sfx || {})) ? Object.keys(ASSETS.sfx || {}) : [];
    const canonical = ['slice','bomb','point','popup','segment_complete','shape_complete','wrong','pop_small','clear','done','eraser','paint_stroke','jump','hit','bgm'];
    const keys = sfxKeys.concat(canonical).filter(Boolean);
    const seen = new Set();
    keys.forEach(function(k){
      if (!k || seen.has(k)) return;
      seen.add(k);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.marginTop = '6px';

      const label = document.createElement('div');
      label.textContent = k;
      label.style.flex = '1';
      label.style.marginRight = '8px';
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace = 'nowrap';

      const testBtn = document.createElement('button');
      testBtn.textContent = '▶';
      testBtn.title = 'Play ' + k;
      testBtn.onclick = function() {
        try {
          if (k === 'bgm') {
            // toggle music on then play
            setMusicEnabled(true);
            playSound('bgm');
          } else {
            // attempt immediate play; respects user gesture guard in playSound
            playSound(k);
          }
        } catch(e){}
      };
      row.appendChild(label);
      row.appendChild(testBtn);
      list.appendChild(row);
    });

    panel.appendChild(list);

    const hints = document.createElement('div');
    hints.style.marginTop = '10px';
    hints.style.opacity = '0.85';
    hints.style.fontSize = '12px';
    hints.textContent = 'Tip: click Unlock or tap the big overlay to enable audio. Press "a" to toggle this panel.';
    panel.appendChild(hints);

    // start hidden by default (developer can toggle)
    panel.style.display = 'none';
    document.body.appendChild(panel);
  },
    initGestureUnlockOverlay: function() {
      // Audio unlock overlay disabled - users can interact directly with the game
      return;
    }
};

// Fallback: global DOM event forwarders for NET-less environments.
// Some NET wrappers dispatch custom DOM events 'net:peer_hand' and 'net:peer_paint'.
// Forward these to the in-page simulatePeer helper so peer hands/paints render even if NET.on wasn't registered yet.
try {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('net:peer_hand', (e) => {
      try {
        const d = (e && e.detail) ? e.detail : e;
        const id = d && (d.id || d.clientId || d.peerId || d.from) ? (d.id || d.clientId || d.peerId || d.from) : ('net-' + Math.random().toString(36).slice(2,8));
        const payload = d.payload || d;
        if (window.__handNinja && typeof window.__handNinja.simulatePeer === 'function') {
          window.__handNinja.simulatePeer(id, 'hand', payload);
        }
      } catch (err) { /* ignore */ }
    }, { passive: true });

    window.addEventListener('net:peer_paint', (e) => {
      try {
        const d = (e && e.detail) ? e.detail : e;
        const id = d && (d.id || d.clientId || d.peerId || d.from) ? (d.id || d.clientId || d.peerId || d.from) : ('net-' + Math.random().toString(36).slice(2,8));
        const payload = d.payload || d;
        if (window.__handNinja && typeof window.__handNinja.simulatePeer === 'function') {
          window.__handNinja.simulatePeer(id, 'paint', payload);
        }
      } catch (err) { /* ignore */ }
    }, { passive: true });
  }
} catch(e) { /* ignore */ }
 
 // Auto-init small debug UI and overlay on DOM ready
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function() {
    try {
      if (window.__handNinja && typeof window.__handNinja.initAudioDebugUI === 'function') window.__handNinja.initAudioDebugUI();
      if (window.__handNinja && typeof window.__handNinja.initGestureUnlockOverlay === 'function') window.__handNinja.initGestureUnlockOverlay();
    } catch(e){}
    // allow quick toggle via "a" key for dev convenience
    window.addEventListener('keydown', function(ev){ if (ev && ev.key === 'a') { try { window.__handNinja.showAudioDebugPanel(); } catch(e){} } }, { passive: true });

    // DEV: optional auto-simulate peers for local testing.
    // Enable by adding "?simulatePeers" to the URL or setting window.__handNinja.autoSimPeers = true in the console.
    try {
      const shouldSim = (typeof window.__handNinja !== 'undefined' && window.__handNinja.autoSimPeers) || (typeof location !== 'undefined' && (location.search || '').indexOf('simulatePeers') !== -1);
      if (shouldSim && window.__handNinja && typeof window.__handNinja.simulatePeer === 'function') {
        // helper to build a quantized single-hand payload (21 points)
        const makeQuantHand = () => {
          const hand = [];
          for (let i = 0; i < 21; i++) {
            const qx = Math.floor(Math.random() * NET_QUANT_MAX);
            const qy = Math.floor(Math.random() * NET_QUANT_MAX);
            const qz = Math.floor(Math.random() * NET_QUANT_MAX);
            hand.push([qx, qy, qz]);
          }
          return hand;
        };

        // spawn a small number of simulated peers with varied payload shapes
        const simIds = ['sim-A', 'sim-B'];
        simIds.forEach((id, idx) => {
          // stagger intervals for slightly different rhythms
          setInterval(() => {
            try {
              // alternate between quantized single-hand and multi-hand normalized payloads
              if (Math.random() < 0.6) {
                // quantized single-hand (the server would normally forward this shape)
                const payload = { lm: makeQuantHand(), cw: canvas.width / DPR, ch: canvas.height / DPR, name: `Sim${idx+1}` };
                window.__handNinja.simulatePeer(id, 'hand', payload);
              } else {
                // normalized float pixel-style hand (0..1) to test normalization branch
                const hand = [];
                for (let i = 0; i < 21; i++) {
                  hand.push({ x: Math.random(), y: Math.random(), z: (Math.random() * 2 - 1) });
                }
                const payload = { lm: hand, cw: canvas.width / DPR, ch: canvas.height / DPR, name: `Sim${idx+1}-N` };
                window.__handNinja.simulatePeer(id, 'hand', payload);
              }
            } catch (e) { /* ignore simulation errors */ }
          }, 420 + idx * 140);
        });
        console.info('Auto peer simulation enabled (simulatePeers)');
      }
    } catch (e) { /* ignore dev sim failures */ }
  });
}
