const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');

const APP_PORT = process.env.PORT || 3000;
const ROOM_ID_SIZE = 6;
const ROOM_CAP = 200;
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..'))); // serve client from project root

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Simple leaderboard persistence helpers
function loadAllLeaderboards() {
  try {
    if (!fs.existsSync(LEADERBOARD_FILE)) {
      fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify({}), 'utf8');
      return {};
    }
    const raw = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Failed to load leaderboard file:', err);
    return {};
  }
}

function saveAllLeaderboards(data) {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save leaderboard file:', err);
  }
}

function postLeader(gameId, entry) {
  const all = loadAllLeaderboards();
  const list = all[gameId] || [];
  const nameKey = (entry.name || 'Anonymous').trim();
  const normalized = nameKey.toLowerCase();
  const existingIndex = list.findIndex(e => (e.name || '').toLowerCase() === normalized);
  if (existingIndex >= 0) {
    if (entry.score > list[existingIndex].score) {
      list[existingIndex] = { name: nameKey, score: entry.score, ts: Date.now() };
    }
  } else {
    list.push({ name: nameKey, score: entry.score, ts: Date.now() });
  }
  list.sort((a, b) => b.score - a.score || a.ts - b.ts);
  all[gameId] = list.slice(0, 200);
  saveAllLeaderboards(all);
  try { io && io.emit && io.emit('leaderboard_update', { game: gameId, leaders: all[gameId] }); } catch(e){}
  return all[gameId];
}

// REST: leaderboard endpoints
app.get('/leaderboard', (req, res) => {
  const game = req.query.game || 'default';
  const leaders = (loadAllLeaderboards())[game] || [];
  res.json({ game, leaders });
});

app.post('/leaderboard', (req, res) => {
  const { game = 'default', name = 'Anonymous', score } = req.body || {};
  if (typeof score !== 'number') {
    return res.status(400).json({ error: 'score (number) is required' });
  }
  const updated = postLeader(game, { name, score });
  res.json({ game, leaders: updated });
});

// In-memory room manager and state caches
const rooms = Object.create(null);
// rooms[roomId] = { id, public, players: Map(socketId->meta), createdAt, cleanupTimer, admin, game, status, timeLimit, startTs, endTs }

 // Peer streaming and per-socket state caching removed for simplified admin-only model.

function createRoom({ id, isPublic }) {
  let roomId = id && String(id).trim() ? String(id).trim() : nanoid(ROOM_ID_SIZE);
  if (rooms[roomId]) {
    if (id) return null;
    do { roomId = nanoid(ROOM_ID_SIZE); } while (rooms[roomId]);
  }
  rooms[roomId] = {
    id: roomId,
    public: !!isPublic,
    players: new Map(),
    createdAt: Date.now(),
    cleanupTimer: null,
    admin: null,
    game: 'default',
    timeLimit: 60,
    status: 'waiting',
    startTs: null,
    endTs: null,
    // Track the room's all-time high score (name and score)
    highScore: { name: null, score: 0 }
  };
  broadcastRoomList();
  return rooms[roomId];
}

function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => r.public)
    .map(r => ({ id: r.id, count: r.players.size }));
}

function joinRoom(roomId, socket, name) {
  const room = rooms[roomId];
  if (!room) return { ok: false, reason: 'not_found' };
  if (room.players.size >= ROOM_CAP) return { ok: false, reason: 'full' };
  room.players.set(socket.id, { name: name || 'Anonymous' });
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.data.displayName = name || 'Anonymous';
  broadcastRoomList();
  return { ok: true, room };
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms[roomId];
  if (!room) {
    delete socket.data.roomId;
    return;
  }
  const wasAdmin = room.admin === socket.id;
  room.players.delete(socket.id);
  socket.leave(roomId);
  delete socket.data.roomId;
  delete socket.data.displayName;

  if (wasAdmin) {
    if (room.players.size > 0) {
      const nextAdmin = room.players.keys().next().value;
      room.admin = nextAdmin;
    } else {
      room.admin = null;
    }
  }

  // schedule cleanup if empty
  if (room.players.size === 0) {
    room.cleanupTimer = setTimeout(() => {
      delete rooms[roomId];
      broadcastRoomList();
    }, 30_000);
  }

  // emit room_update to remaining members
  if (rooms[roomId]) {
    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });
  }

  broadcastRoomList();
}

function broadcastRoomList() {
  const list = getPublicRooms();
  io.emit('rooms_list', list);
}

// Validation helpers for hand/paint payloads
function isValidHandPayload(p) {
  if (!p || typeof p !== 'object') return false;
  if (!Array.isArray(p.lm)) return false;
  // accept either array-of-points (single hand) or array-of-hands (array of arrays)
  if (p.lm.length === 0) return true;
  if (Array.isArray(p.lm[0])) {
    // multi-hand: first must be array
    return p.lm.every(h => Array.isArray(h));
  }
  // single hand: each element should be an array [x,y,z] or object
  return p.lm.every(pt => Array.isArray(pt) || (pt && typeof pt === 'object' && typeof pt.x === 'number' && typeof pt.y === 'number'));
}

function isValidPaintPayload(p) {
  if (!p || typeof p !== 'object') return false;
  if (!Array.isArray(p.pts)) return false;
  return p.pts.every(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number');
}

// Generate a deterministic set of game items based on a seed
function generateGameItems(gameType, seed) {
  const items = [];

  // Mulberry32 deterministic PRNG to match client-side generator for parity
  function mulberry32(a) {
    return function() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rng = mulberry32(seed >>> 0);

  if (gameType === 'fruit' || gameType === 'ninja-fruit') {
    const baseNumItems = 25 + Math.floor(rng() * 25); // 25-50 items (reduced for multiplayer)
    const MAX_ITEMS = 30; // hard cap to reduce density in multiplayer rooms
    const numItems = Math.min(baseNumItems, MAX_ITEMS);
    try { console.log(`generateGameItems seed=${seed} baseNumItems=${baseNumItems} numItems=${numItems}`); } catch(e){}
    for (let i = 0; i < numItems; i++) {
      items.push({
        id: `item_${i}_${Date.now()}`,
        type: rng() > 0.2 ? 'fruit' : 'bomb',
        x: 0.1 + rng() * 0.8, // avoid edges
        y: 1.1, // start offscreen top
        velX: (rng() - 0.5) * 0.005,
        velY: -0.015 - (rng() * 0.01), // move upwards initially
        gravity: 0.00005,
        spawnTime: Math.round(i * (100 + rng() * 400)) // Stagger spawn times (ms)
      });
    }
  } else if (gameType === 'shape-trace' || gameType === 'paint-air' || gameType === 'runner-control' || gameType === 'maze-mini') {
    // For non-physics games (shape-trace, paint-air, runner), generate minimal items
    // These games don't need spawn items, but we create a dummy item for synchronization
    items.push({
      id: `sync_${seed}_${Date.now()}`,
      type: 'sync',
      x: 0.0,
      y: 0.0,
      velX: 0,
      velY: 0,
      gravity: 0,
      spawnTime: 0
    });
  }
  return items;
}

function mapGameToBgm(gameType) {
  const mapping = { fruit: '/assets/bgm_maze_loop.mp3', default: '/assets/bgm.mp3' };
  return mapping[gameType] || mapping.default;
}


// Socket.IO handlers
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // Send initial public rooms
  socket.emit('rooms_list', getPublicRooms());

  socket.on('create_room', (opts = {}, cb) => {
    const { id, isPublic = true } = opts;
    const room = createRoom({ id, isPublic });
    if (!room) {
      if (cb) cb({ ok: false, reason: 'exists' });
      return;
    }
    if (cb) cb({ ok: true, room: { id: room.id, public: room.public } });
  });

  socket.on('join_room', (opts = {}, cb) => {
    const { roomId, name } = opts;
    if (!roomId) {
      if (cb) cb({ ok: false, reason: 'missing_roomId' });
      return;
    }
    const res = joinRoom(roomId, socket, name);
    if (!res.ok) {
      if (cb) cb(res);
      return;
    }
    const room = res.room;
    if (!room.admin) {
      room.admin = socket.id;
    }
    // Notify others
    socket.to(roomId).emit('peer_join', { id: socket.id, name: socket.data.displayName });
    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });


    // If a run is active, send authoritative game state to the newcomer so they
    // can join mid-run with the exact schedule and timings.
    if (room.status === 'running') {
      try {
        const now = Date.now();
        socket.emit('game_start', {
          game: room.game,
          timeLimit: room.timeLimit,
          startTs: room.startTs,
          endTs: room.endTs,
          seed: typeof room.seed === 'number' ? room.seed : null,
          items: Array.isArray(room.gameItems) ? room.gameItems : [],
          forcePlayAll: !!room.forcePlayAll,
          bgmUrl: room.bgmUrl
        });
          // If the authoritative start time already passed, also emit game_begin so client switches to authoritative mode.
          if (now >= (room.startTs || 0)) {
            socket.emit('game_begin', {
              startTime: room.startTs,
              seed: typeof room.seed === 'number' ? room.seed : null,
              items: Array.isArray(room.gameItems) ? room.gameItems : [],
              bgmUrl: room.bgmUrl
            });
          }
      } catch (e) {
        console.warn('Failed to send running game state to joiner', socket.id, e);
      }
    }

    // Respond to joiner's callback with list of peers
    const peers = [];
    for (const [sid, meta] of res.room.players.entries()) {
      if (sid === socket.id) continue;
      peers.push({ id: sid, name: meta.name });
    }
    if (cb) cb({ ok: true, room: { id: res.room.id, public: res.room.public }, peers });
  });

  socket.on('leave_room', () => {
    const roomId = socket.data.roomId;
    leaveRoom(socket);
    if (roomId) socket.to(roomId).emit('peer_leave', { id: socket.id });
  });

  socket.on('set_room_options', (opts = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
    const room = rooms[roomId];
    if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
    if (room.admin !== socket.id) { if (cb) cb({ ok: false, reason: 'not_admin' }); return; }
    const { game, timeLimit } = opts;
    if (typeof game === 'string') room.game = game;
    if (typeof timeLimit === 'number') room.timeLimit = Math.max(5, Math.min(3600, Math.floor(timeLimit)));
    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });
    if (cb) cb({ ok: true });
  });

  socket.on('start_room_game', (opts = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
    const room = rooms[roomId];
    if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
    if (room.admin !== socket.id) { if (cb) cb({ ok: false, reason: 'not_admin' }); return; }

    // basic request log for debugging / audit
    try { console.log('start_room_game request', { socket: socket.id, room: roomId, opts }); } catch(e){}

    // Allow caller to override game/timeLimit atomically and support forced replace
    try {
      const { game, timeLimit, replace } = opts || {};
      if (typeof game === 'string') room.game = game;
      if (typeof timeLimit === 'number') room.timeLimit = Math.max(5, Math.min(3600, Math.floor(timeLimit)));
      try { console.log(`room:${roomId} options updated by ${socket.id}`, { game: room.game, timeLimit: room.timeLimit, replace: !!replace }); } catch(e){}
    } catch (e) {}

    // Prevent concurrent start requests
    if (room.starting) {
      if (cb) cb({ ok: false, reason: 'busy' });
      return;
    }

    // If a run is already active and caller didn't request replace -> reject immediately
    if (room.status === 'running' && !(opts && opts.replace)) {
      if (cb) cb({ ok: false, reason: 'already_running' });
      return;
    }

    // If a run is already active and caller requested replace -> stop it cleanly and notify clients before starting the new one.
    if (room.status === 'running' && (opts && opts.replace)) {
      room.starting = true;
      try { if (room.beginTimer) { clearTimeout(room.beginTimer); room.beginTimer = null; } } catch(e){}
      try { if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; } } catch(e){}
      const prevEnd = room.endTs;
      room.status = 'waiting';
      room.startTs = null;
      room.endTs = null;
      try {
        try { console.log(`room:${roomId} replacing active run (requested by ${socket.id}) prevEnd=${prevEnd}`); } catch(e){}
        io.to(roomId).emit('game_end', { reason: 'replaced', endTs: prevEnd });
        io.to(roomId).emit('room_update', {
          id: room.id,
          public: room.public,
          admin: room.admin,
          game: room.game,
          timeLimit: room.timeLimit,
          status: room.status,
          players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
        });
        try { console.log(`room:${roomId} broadcasted replacement game_end`); } catch(e){}
      } catch (e) {
        console.warn('Failed to broadcast replacement game_end for room', roomId, e);
      } finally {
        room.starting = false;
      }
    }

    // Start the new room run
    room.status = 'running';
    const kickoffDelayMs = 3000;
    const startTs = Date.now() + kickoffDelayMs;
    const seed = Math.floor(Math.random() * 0x7fffffff);
    room.startTs = startTs;
    room.endTs = room.startTs + (room.timeLimit || 60) * 1000;
    // Persist the seed so late joiners can deterministically reproduce the schedule
    room.seed = seed;

    // Generate game items based on game type and seed
    const gameItems = generateGameItems(room.game, seed);
    room.gameItems = gameItems; // Store items in the room object

    try { console.log(`room:${roomId} starting game`, { game: room.game, timeLimit: room.timeLimit, startTs: room.startTs, endTs: room.endTs, seed, items: gameItems.length, requestedBy: socket.id }); } catch(e){}

    // emit updated room metadata and a game_start notification
    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });
    const bgmUrl = mapGameToBgm(room.game);
    room.bgmUrl = bgmUrl;
    io.to(roomId).emit('game_start', { game: room.game, timeLimit: room.timeLimit, startTs: room.startTs, endTs: room.endTs, seed, items: gameItems, bgmUrl, forcePlayAll: true });

    // schedule authoritative game_begin at the startTs
    const __delay = Math.max(0, room.startTs - Date.now());
    room.beginTimer = setTimeout(() => {
      try {
        // Include authoritative scheduled items with the game_begin so non-admin clients
        // receive the exact spawn schedule they must follow.
        io.to(roomId).emit('game_begin', {
          startTime: room.startTs,
          seed,
          items: room.gameItems || gameItems,
          bgmUrl: room.bgmUrl || mapGameToBgm(room.game),
          forcePlayAll: true
        });
        // Instruct all clients to start the shared room BGM when the game begins.
        try {
            io.to(roomId).emit('music_play', { bgmUrl: room.bgmUrl || mapGameToBgm(room.game), forcePlayAll: true });
          } catch (e) {
            console.warn('Failed to emit music_play for room', roomId, e);
          }
      } catch (e) { console.warn('Failed to emit game_begin for room', roomId, e); }
      room.beginTimer = null;
    }, __delay);

    // schedule authoritative game_end at the endTs
    const endDelay = Math.max(0, room.endTs - Date.now());
    room.endTimer = setTimeout(() => {
      try {
        // mark not running and notify clients
        room.status = 'waiting';
        const prevEndTs = room.endTs;
        room.startTs = null;
        room.endTs = null;

        try { console.log(`room:${roomId} game ended (timeup) prevEndTs=${prevEndTs}`); } catch(e){}
        // Notify clients to stop shared room BGM when the game ends.
          try {
          io.to(roomId).emit('music_stop', { reason: 'timeup', endTs: prevEndTs, forceStopAll: true });
        } catch (e) {
          console.warn('Failed to emit music_stop for room', roomId, e);
        }
        io.to(roomId).emit('game_end', { reason: 'timeup', endTs: prevEndTs });
        io.to(roomId).emit('room_update', {
          id: room.id,
          public: room.public,
          admin: room.admin,
          game: room.game,
          timeLimit: room.timeLimit,
          status: room.status,
          players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
        });
      } catch (e) {
        console.warn('Failed to emit game_end for room', roomId, e);
      } finally {
        room.endTimer = null;
      }
    }, endDelay);

    if (cb) cb({ ok: true });
  });

  // Admin can stop a running room game early
  socket.on('stop_room_game', (opts = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
    const room = rooms[roomId];
    if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
    if (room.admin !== socket.id) { if (cb) cb({ ok: false, reason: 'not_admin' }); return; }
    if (room.status !== 'running') { if (cb) cb({ ok: false, reason: 'not_running' }); return; }

    try { console.log(`room:${roomId} stop requested by admin ${socket.id} prevEnd=${room.endTs}`); } catch(e){}

    try { if (room.beginTimer) { clearTimeout(room.beginTimer); room.beginTimer = null; } } catch(e){}
    try { if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; } } catch(e){}

    room.status = 'waiting';
    const prevEnd = room.endTs;
    room.startTs = null;
    room.endTs = null;

    // Instruct clients to stop shared room BGM when admin stops the game early.
    try {
      io.to(roomId).emit('music_stop', { reason: 'stopped', endTs: prevEnd, forceStopAll: true });
    } catch (e) {
      console.warn('Failed to emit music_stop for room stop', roomId, e);
    }
    io.to(roomId).emit('game_end', { reason: 'stopped', endTs: prevEnd });
    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });

    if (cb) cb({ ok: true });
  });

  // Update display name and broadcast to room
  socket.on('set_display_name', (opts = {}, cb) => {
    try {
      const name = (opts && typeof opts.name === 'string') ? opts.name.trim().slice(0, 64) : '';
      if (!name) { if (cb) cb({ ok: false, reason: 'invalid_name' }); return; }
      const roomId = socket.data.roomId;
      if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
      const room = rooms[roomId];
      if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
      socket.data.displayName = name;
      if (room.players.has(socket.id)) {
        room.players.set(socket.id, { name });
      }
      io.to(roomId).emit('room_update', {
        id: room.id,
        public: room.public,
        admin: room.admin,
        game: room.game,
        timeLimit: room.timeLimit,
        status: room.status,
        players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
      });
      if (cb) cb({ ok: true });
    } catch (e) {
      if (cb) cb({ ok: false, reason: 'error' });
    }
  });

  // Admin can kick a player from the room
  socket.on('kick_player', (opts = {}, cb) => {
    try {
      const targetId = opts && opts.id;
      const roomId = socket.data.roomId;
      if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
      const room = rooms[roomId];
      if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
      if (room.admin !== socket.id) { if (cb) cb({ ok: false, reason: 'not_admin' }); return; }
      if (!targetId || !room.players.has(targetId)) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
      if (targetId === room.admin) { if (cb) cb({ ok: false, reason: 'cannot_kick_admin' }); return; }

      // Remove from room state
      room.players.delete(targetId);
      const targetSock = io.sockets.sockets.get ? io.sockets.sockets.get(targetId) : io.sockets.connected && io.sockets.connected[targetId];
      if (targetSock) {
        try {
          targetSock.leave(roomId);
          delete targetSock.data.roomId;
          delete targetSock.data.displayName;
          try { targetSock.emit('kicked', { by: socket.id, room: roomId }); } catch (e) {}
        } catch (e) {}
      }

      // Reassign admin if needed
      if (!room.admin && room.players.size > 0) {
        room.admin = room.players.keys().next().value;
      }

      io.to(roomId).emit('peer_leave', { id: targetId });
      io.to(roomId).emit('room_update', {
        id: room.id,
        public: room.public,
        admin: room.admin,
        game: room.game,
        timeLimit: room.timeLimit,
        status: room.status,
        players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
      });

      // schedule cleanup if empty
      if (room.players.size === 0) {
        room.cleanupTimer = setTimeout(() => {
          delete rooms[roomId];
          broadcastRoomList();
        }, 30_000);
      }

      if (cb) cb({ ok: true });
    } catch (e) {
      if (cb) cb({ ok: false, reason: 'error' });
    }
  });




  socket.on('player_score', (payload, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
      const room = rooms[roomId];
      if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
      if (room.status !== 'running') { if (cb) cb({ ok: false, reason: 'not_running' }); return; }

      const { score, name } = payload || {};
      if (typeof score !== 'number') {
        if (cb) cb({ ok: false, reason: 'invalid_score' });
        return;
      }

      // Update room.highScore if this score is greater
      room.highScore = room.highScore || { name: null, score: 0 };
      if (score > (room.highScore.score || 0)) {
        room.highScore = { name: (name || socket.data.displayName || 'Anonymous'), score, ts: Date.now() };
        io.to(roomId).emit('room_highscore', { name: room.highScore.name, score: room.highScore.score });
      }

      // Still broadcast player's current score to the room
      io.to(roomId).emit('peer_score', { id: socket.id, score });
      if (cb) cb({ ok: true, highScore: room.highScore });

    } catch (err) {
      console.error('player_score handler err', err);
      if (cb) cb({ ok: false, reason: 'error' });
    }
  });

  // Authoritative interaction handler
  // Clients send interaction intents (e.g. slice/hit) to the server for validation.
  // Server validates proximity to the authoritative item and, if accepted,
  // marks the item removed and broadcasts object_state + peer_score updates.
  socket.on('interaction', (payload, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
      const room = rooms[roomId];
      if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
      if (room.status !== 'running') { if (cb) cb({ ok: false, reason: 'not_running' }); return; }

      const { objectId, x, y } = payload || {};
      if (!objectId) { if (cb) cb({ ok: false, reason: 'invalid_payload' }); return; }

      room.objectStates = room.objectStates || {};
      // find authoritative item if still present
      const item = (room.gameItems || []).find(it => it && it.id === objectId);

      // not found and not previously known as removed -> reject
      if (!item && !(room.objectStates && room.objectStates[objectId])) {
        if (cb) cb({ ok: false, reason: 'not_found' });
        return;
      }

      // already removed
      if (room.objectStates[objectId] && room.objectStates[objectId].removed) {
        if (cb) cb({ ok: false, reason: 'already_removed' });
        return;
      }

      // Simple proximity validation if coordinates provided.
      // Coordinates are expected normalized (0..1). Uses a conservative threshold.
      let valid = true;
      if (typeof x === 'number' && typeof y === 'number' && item && typeof item.x === 'number' && typeof item.y === 'number') {
        const dx = x - item.x;
        const dy = y - item.y;
        const dist2 = dx * dx + dy * dy;
        const thresh = 0.08; // tuned threshold for hit validation
        if (dist2 > (thresh * thresh)) valid = false;
      }

      if (!valid) {
        if (cb) cb({ ok: false, reason: 'miss' });
        return;
      }

      // Mark removed in authoritative state
      room.objectStates[objectId] = { removed: true, by: socket.id, ts: Date.now(), type: item ? item.type : 'unknown' };

      // Maintain a simple per-room score table
      room.scores = room.scores || {};
      const delta = (item && item.type === 'bomb') ? -1 : 1;
      room.scores[socket.id] = (room.scores[socket.id] || 0) + delta;

      // Broadcast authoritative object state to all peers
      try {
        io.to(roomId).emit('object_state', { id: objectId, removed: true, by: socket.id, ts: room.objectStates[objectId].ts, type: room.objectStates[objectId].type });
      } catch (e) {}

      // Broadcast updated score for the player
      try {
        io.to(roomId).emit('peer_score', { id: socket.id, score: room.scores[socket.id] });
      } catch (e) {}

      if (cb) cb({ ok: true, removed: true, score: room.scores[socket.id] });
    } catch (err) {
      console.error('interaction handler err', err);
      if (cb) cb({ ok: false, reason: 'error' });
    }
  });

  socket.on('score', (payload, cb) => {
    try {
      const { game = 'default', name = socket.data.displayName || 'Anonymous', score } = payload || {};
      if (typeof score !== 'number') {
        if (cb) cb({ ok: false, reason: 'invalid_score' });
        return;
      }
      const updated = postLeader(game, { name, score });
      if (cb) cb({ ok: true, leaders: updated });
      io.emit('leaderboard_update', { game, leaders: updated });
    } catch (err) {
      console.error('score handler err', err);
      if (cb) cb({ ok: false, reason: 'error' });
    }
  });

  socket.on('peer_request_state', (data) => {
    // backwards compatibility: ask peers to emit their latest state immediately
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      // simply forward request to room
      socket.to(roomId).emit('peer_request_state', data || {});
    } catch (e) {}
  });

  // Allow clients to request an authoritative room update from the server.
  // This is used by clients that want the latest players/metadata immediately.
  socket.on('request_room_update', (opts = {}, cb) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
      const room = rooms[roomId];
      if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
      io.to(roomId).emit('room_update', {
        id: room.id,
        public: room.public,
        admin: room.admin,
        game: room.game,
        timeLimit: room.timeLimit,
        status: room.status,
        players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
      });
      if (cb) cb({ ok: true });
    } catch (e) {
      if (cb) cb({ ok: false, reason: 'error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    const roomId = socket.data.roomId;
    leaveRoom(socket);
    if (roomId) socket.to(roomId).emit('peer_leave', { id: socket.id });
  });
});

// Health
app.get('/_health', (req, res) => res.json({ ok: true, ts: Date.now() }));

server.listen(APP_PORT, () => {
  console.log(`Server listening on http://localhost:${APP_PORT}`);
  console.log(`REST leaderboards: GET/POST /leaderboard`);
});
