const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');

const APP_PORT = process.env.PORT || 3000;
const ROOM_ID_SIZE = 6;
const ROOM_CAP = 50;
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

// Keep last-known state per socket to let newcomers see peers immediately
const lastHandBySocket = new Map(); // socketId -> { payload, name, ts }
const lastPaintBySocket = new Map(); // socketId -> { payload, name, ts }

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
    endTs: null
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
      musicEnabled: !!room.musicEnabled,
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
      musicEnabled: !!room.musicEnabled,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });

    // Immediately send existing peers' last known states to the newcomer
    for (const [sid, meta] of room.players.entries()) {
      if (sid === socket.id) continue;
      const handState = lastHandBySocket.get(sid);
      if (handState && handState.payload) {
        try {
          socket.emit('peer_hand', { id: sid, payload: handState.payload, name: handState.name || 'Player', ts: handState.ts || Date.now() });
        } catch (e) {}
      }
      const paintState = lastPaintBySocket.get(sid);
      if (paintState && paintState.payload) {
        try {
          socket.emit('peer_paint', { id: sid, payload: paintState.payload, name: paintState.name || 'Player', ts: paintState.ts || Date.now() });
        } catch (e) {}
      }
    }

    // Still request state as a fallback for older clients
    socket.to(roomId).emit('peer_request_state', { requester: socket.id });

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
    const { game, timeLimit, musicEnabled } = opts;
    if (typeof game === 'string') room.game = game;
    if (typeof timeLimit === 'number') room.timeLimit = Math.max(5, Math.min(3600, Math.floor(timeLimit)));
    if (typeof musicEnabled === 'boolean') room.musicEnabled = !!musicEnabled;
    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      musicEnabled: !!room.musicEnabled,
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
    if (room.status === 'running') { if (cb) cb({ ok: false, reason: 'already_running' }); return; }
    room.status = 'running';
    const kickoffDelayMs = 3000;
    const startTs = Date.now() + kickoffDelayMs;
    const seed = Math.floor(Math.random() * 0x7fffffff);
    room.startTs = startTs;
    room.endTs = room.startTs + (room.timeLimit || 60) * 1000;

    // clear any existing end timer so we don't double-schedule
    if (room._endTimer) {
      try { clearTimeout(room._endTimer); } catch (e) {}
      room._endTimer = null;
    }

    io.to(roomId).emit('room_update', {
      id: room.id,
      public: room.public,
      admin: room.admin,
      game: room.game,
      timeLimit: room.timeLimit,
      musicEnabled: !!room.musicEnabled,
      status: room.status,
      players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
    });
    // Include authoritative musicEnabled and admin info with game lifecycle events so clients
    // can apply the room-admin choices (BGM on/off and selected game) immediately and consistently.
    io.to(roomId).emit('game_start', {
      game: room.game,
      timeLimit: room.timeLimit,
      startTs: room.startTs,
      endTs: room.endTs,
      seed,
      musicEnabled: !!room.musicEnabled,
      admin: room.admin
    });
    const __delay = Math.max(0, room.startTs - Date.now());
    setTimeout(() => {
      try {
        io.to(roomId).emit('game_begin', {
          startTime: room.startTs,
          seed,
          musicEnabled: !!room.musicEnabled,
          admin: room.admin
        });
      } catch (e) { console.warn('Failed to emit game_begin for room', roomId, e); }
    }, __delay);

    // schedule automatic end
    const __timeUntilEnd = Math.max(0, room.endTs - Date.now());
    room._endTimer = setTimeout(() => {
      try {
        room.status = 'finished';
      } catch(e){}
      try { io.to(roomId).emit('game_end', { reason: 'timeout', endTs: room.endTs }); } catch(e){}
      try {
        io.to(roomId).emit('room_update', {
          id: room.id,
          public: room.public,
          admin: room.admin,
          game: room.game,
          timeLimit: room.timeLimit,
          musicEnabled: !!room.musicEnabled,
          status: room.status,
          players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
        });
      } catch(e){}
      room._endTimer = null;
    }, __timeUntilEnd);

    if (cb) cb({ ok: true });
  });

  // allow admin to stop an in-progress room game immediately
  socket.on('stop_room_game', (opts = {}, cb) => {
    const roomId = socket.data.roomId;
    if (!roomId) { if (cb) cb({ ok: false, reason: 'not_in_room' }); return; }
    const room = rooms[roomId];
    if (!room) { if (cb) cb({ ok: false, reason: 'not_found' }); return; }
    if (room.admin !== socket.id) { if (cb) cb({ ok: false, reason: 'not_admin' }); return; }
    if (room.status !== 'running') { if (cb) cb({ ok: false, reason: 'not_running' }); return; }
    // clear any scheduled end timer
    if (room._endTimer) {
      try { clearTimeout(room._endTimer); } catch (e) {}
      room._endTimer = null;
    }
    room.status = 'finished';
    room.endTs = Date.now();
    try { io.to(roomId).emit('game_end', { reason: 'stopped', endTs: room.endTs }); } catch(e){}
    try {
      io.to(roomId).emit('room_update', {
        id: room.id,
        public: room.public,
        admin: room.admin,
        game: room.game,
        timeLimit: room.timeLimit,
        musicEnabled: !!room.musicEnabled,
        status: room.status,
        players: Array.from(room.players.entries()).map(([sid, meta]) => ({ id: sid, name: meta.name }))
      });
    } catch(e){}
    if (cb) cb({ ok: true });
  });

  // Hand frames: validate, cache last state, forward to peers
  socket.on('hand', (payload) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      // debug log: received hand frame
      try { console.debug && console.debug('server: recv hand', { socket: socket.id, room: roomId, hasPayload: !!payload }); } catch(e){}
      const norm = payload || {};
      if (!isValidHandPayload(norm)) {
        // store minimal info so new joiners still see something
        lastHandBySocket.set(socket.id, { payload: norm, name: socket.data.displayName || 'Player', ts: Date.now() });
        try { console.debug && console.debug('server: saved invalid hand state for newcomer', { socket: socket.id, room: roomId }); } catch(e){}
        return;
      }
      lastHandBySocket.set(socket.id, { payload: norm, name: socket.data.displayName || 'Player', ts: Date.now() });
      // forward to everyone else in the same room
      try { console.debug && console.debug('server: forward peer_hand', { from: socket.id, room: roomId }); } catch(e){}
      socket.to(roomId).emit('peer_hand', { id: socket.id, payload: norm, name: socket.data.displayName || 'Player', ts: Date.now() });
    } catch (e) {
      console.warn('hand handler failed', e);
    }
  });

  // Paint frames: validate, cache last paint, forward to peers
  socket.on('paint', (payload) => {
    try {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      // debug log: received paint
      try { console.debug && console.debug('server: recv paint', { socket: socket.id, room: roomId, ptsCount: Array.isArray(payload && payload.pts) ? payload.pts.length : 0 }); } catch(e){}
      const norm = payload || {};
      if (!isValidPaintPayload(norm)) {
        lastPaintBySocket.set(socket.id, { payload: norm, name: socket.data.displayName || 'Player', ts: Date.now() });
        try { console.debug && console.debug('server: saved invalid paint state for newcomer', { socket: socket.id, room: roomId }); } catch(e){}
        return;
      }
      lastPaintBySocket.set(socket.id, { payload: norm, name: socket.data.displayName || 'Player', ts: Date.now() });
      try { console.debug && console.debug('server: forward peer_paint', { from: socket.id, room: roomId, ptsCount: norm.pts ? norm.pts.length : 0 }); } catch(e){}
      socket.to(roomId).emit('peer_paint', { id: socket.id, payload: norm, name: socket.data.displayName || 'Player', ts: Date.now() });
    } catch (e) {
      try { socket.to(roomId).emit('peer_paint', { id: socket.id, payload, name: socket.data.displayName || 'Player' }); } catch(e){}
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

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    const roomId = socket.data.roomId;
    leaveRoom(socket);
    lastHandBySocket.delete(socket.id);
    lastPaintBySocket.delete(socket.id);
    if (roomId) socket.to(roomId).emit('peer_leave', { id: socket.id });
  });
});

// Health
app.get('/_health', (req, res) => res.json({ ok: true, ts: Date.now() }));

server.listen(APP_PORT, () => {
  console.log(`Server listening on http://localhost:${APP_PORT}`);
  console.log(`REST leaderboards: GET/POST /leaderboard`);
});
