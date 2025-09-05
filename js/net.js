/*
task_progress: 2/7

Checklist:
- [x] Analyze requirements
- [x] Set up necessary files (server/package.json)
- [x] Implement main server (server/server.js)
- [x] Implement client networking (js/net.js)  <- current
- [ ] Implement room manager (rooms.js)  (basic manager is inlined in server)
- [ ] Implement client UI hooks (js/ui.js)
- [ ] Integrate leaderboard persistence and client fetch
- [ ] Test locally and provide tunnel instructions

Purpose:
- Browser-side Socket.IO wrapper for rooms, presence, hand broadcast and leaderboard events.
- Provides a small API used by client game code:
  NET.connect(serverUrl)
  NET.createRoom({id, isPublic}, cb)
  NET.joinRoom({roomId, name}, cb)
  NET.leaveRoom()
  NET.sendHand(payload)  // throttled + quantized internally
  NET.postScore({game, name, score}, cb)
  NET.on(event, cb) // events: rooms_list, peer_join, peer_leave, peer_hand, leaderboard_update

Notes:
- This file assumes the Socket.IO client script is available at /socket.io/socket.io.js
- Hand payloads should be compact objects (quantized) produced by the game.
*/

(function (global) {
  const DEFAULT_THROTTLE_HZ = 12; // 10-15Hz recommended
  const QUANT_MAX = 1000;

  function throttle(fn, hz) {
    let last = 0;
    const minMs = 1000 / hz;
    return function (...args) {
      const now = Date.now();
      if (now - last >= minMs) {
        last = now;
        fn.apply(this, args);
      }
    };
  }

  function quantizePoint(p) {
    // p: {x,y,z?} normalized [0..1] or pixel coords (detect)
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      // assume normalized 0..1 -> map to 0..QUANT_MAX
      return {
        x: Math.round(Math.max(0, Math.min(1, p.x)) * QUANT_MAX),
        y: Math.round(Math.max(0, Math.min(1, p.y)) * QUANT_MAX),
        z: typeof p.z === 'number' ? Math.round((p.z + 1) * (QUANT_MAX / 2)) : undefined
      };
    }
    return { x: 0, y: 0 };
  }

  function quantizeLandmarks(landmarks, maxPoints = 21) {
    // landmarks: Array of {x,y,z} (MediaPipe)
    // returns array of compact ints; truncated or padded to maxPoints
    const out = [];
    for (let i = 0; i < Math.min(maxPoints, landmarks.length); i++) {
      const q = quantizePoint(landmarks[i]);
      out.push([q.x, q.y, q.z == null ? -1 : q.z]);
    }
    // pad if necessary
    for (let i = out.length; i < maxPoints; i++) out.push([0, 0, -1]);
    return out;
  }

  // Simple event emitter
  function makeEmitter() {
    const handlers = Object.create(null);
    return {
      on(name, cb) {
        (handlers[name] || (handlers[name] = [])).push(cb);
      },
      off(name, cb) {
        if (!handlers[name]) return;
        const idx = handlers[name].indexOf(cb);
        if (idx >= 0) handlers[name].splice(idx, 1);
      },
      emit(name, ...args) {
        (handlers[name] || []).slice().forEach(cb => {
          try { cb(...args); } catch (e) { console.error('NET handler error', e); }
        });
      }
    };
  }

  const E = makeEmitter();

 // Mirror emitter emits to DOM so listeners that rely on DOM CustomEvents
 // (e.g. page code loaded before NET or alternate wrappers) receive the same
 // peer events. This is defensive and non-destructive.
 try {
   const _origEmit = E.emit.bind(E);
   E.emit = function(name, ...args) {
     try { _origEmit(name, ...args); } catch (e) { /* ignore emitter errors */ }
     try {
       if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
         const evName = 'net:' + name;
         // Be defensive about arg shapes:
         // - single-arg: dispatch that arg as detail
         // - two-arg where first is an id (string/number) and second is payload:
         //    dispatch { id, payload }
         // - otherwise dispatch the first arg when present
         let detail;
         if (args && args.length === 1) {
           detail = args[0];
         } else if (args && args.length === 2 && (typeof args[0] === 'string' || typeof args[0] === 'number')) {
           detail = { id: args[0], payload: args[1] };
         } else if (args && args.length > 0) {
           detail = args[0];
         } else {
           detail = undefined;
         }
         try { window.dispatchEvent(new CustomEvent(evName, { detail })); } catch (err) { /* ignore dispatch errors */ }
       }
     } catch (err) { /* ignore */ }
   };
 } catch (e) { /* ignore */ }

  const NET = {
    socket: null,
    connected: false,
    serverUrl: null,
    throttleHz: DEFAULT_THROTTLE_HZ,
    sendHandThrottled: null,
    // in-memory fallback queue for hand payloads when socket is temporarily unavailable
    pendingHandQueue: [],
    pendingHandQueueMax: 200,

    connect(serverUrl) {
      this.serverUrl = serverUrl || (location.origin.replace(/^http/, 'ws'));
      if (typeof io === 'undefined') {
        console.error('Socket.IO client (io) not found. Include /socket.io/socket.io.js');
      }
      this.socket = io(this.serverUrl, { transports: ['websocket', 'polling'] });
      this._installBaseHandlers();
      this.sendHandThrottled = throttle(payload => {
        if (!this.socket) return;
        try {
          try { console.debug && console.debug('NET: send hand (throttled)', payload); } catch(e){}
          this.socket.emit('hand', payload);
        } catch (e) {}
      }, this.throttleHz);

      // Separate paint throttle so paint payloads are always emitted on the 'paint' channel
      // instead of being rerouted through the 'hand' event (which prevented peer_paint delivery).
      this.sendPaintThrottled = throttle(payload => {
        if (!this.socket) return;
        try {
          try { console.debug && console.debug('NET: send paint (throttled)', payload); } catch(e){}
          this.socket.emit('paint', payload);
        } catch (e) {}
      }, this.throttleHz);
      return this.socket;
    },

    _installBaseHandlers() {
      if (!this.socket) return;
      const self = this;
      this.socket.on('connect', () => {
        self.connected = true;
        // flush any queued hand payloads (use throttled sender to avoid bursts)
        try {
          if (Array.isArray(self.pendingHandQueue) && self.pendingHandQueue.length && typeof self.sendHandThrottled === 'function') {
            const toFlush = self.pendingHandQueue.length;
            try { console.debug && console.debug(`NET: flushing ${toFlush} pending hand frames`); } catch(e){}
            // best-effort notify server we're about to flush (server may ignore)
            try { if (self.socket && typeof self.socket.emit === 'function') self.socket.emit('hand_diagnostic', { pending: toFlush }); } catch(e){}
            while (self.pendingHandQueue.length) {
              try { self.sendHandThrottled(self.pendingHandQueue.shift()); } catch(e){}
            }
            try { if (self.socket && typeof self.socket.emit === 'function') self.socket.emit('hand_diagnostic', { flushed: toFlush }); } catch(e){}
          }
        } catch(e){}
        E.emit('connect');
      });
      this.socket.on('disconnect', () => {
        self.connected = false;
        E.emit('disconnect');
      });
      this.socket.on('rooms_list', (list) => { E.emit('rooms_list', list); });
      this.socket.on('peer_join', (p) => { E.emit('peer_join', p); });
      this.socket.on('peer_leave', (p) => { E.emit('peer_leave', p); });
      this.socket.on('peer_hand', (data) => {
        try { console.debug && console.debug('NET: recv peer_hand', data); } catch(e){}
        E.emit('peer_hand', data);
        // Also dispatch a DOM event so other modules loaded before NET can react.
        try { 
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('net:peer_hand', { detail: data }));
          }
        } catch (e) {}
      });
      // receive paint updates forwarded by server
      this.socket.on('peer_paint', (data) => {
        try { console.debug && console.debug('NET: recv peer_paint', data); } catch(e){}
        E.emit('peer_paint', data);
        // Also dispatch a DOM event so other modules loaded before NET can react.
        try { 
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('net:peer_paint', { detail: data }));
          }
        } catch (e) {}
      });
      this.socket.on('leaderboard_update', (data) => { E.emit('leaderboard_update', data); });

      // room lifecycle / admin events
      this.socket.on('room_update', (data) => { E.emit('room_update', data); });
      this.socket.on('game_start', (data) => { E.emit('game_start', data); });
      this.socket.on('game_end', (data) => { E.emit('game_end', data); });

      // server may request clients to immediately share their latest hand state (useful when a new peer joins)
      this.socket.on('peer_request_state', (data) => {
        // Notify local listeners
        E.emit('peer_request_state', data);
        // Best-effort: immediately emit our last known hand state so newcomers see current peers quickly.
        // This avoids waiting for the throttled sendHand interval and helps the joining client display ghosts.
        try {
          if (this._lastSentHand) {
            try { this.sendHandImmediate(this._lastSentHand); } catch (e) { /* ignore send errors */ }
          }
        } catch (e) { /* ignore */ }
      });
    },

    createRoom(opts = {}, cb) {
      if (!this.socket) return cb && cb({ ok: false, reason: 'not_connected' });
      this.socket.emit('create_room', opts, (res) => {
        if (cb) cb(res);
        if (res && res.ok) E.emit('room_created', res.room);
      });
    },

    joinRoom(opts = {}, cb) {
      if (!this.socket) return cb && cb({ ok: false, reason: 'not_connected' });
      this.socket.emit('join_room', opts, (res) => {
        if (cb) cb(res);
        if (res && res.ok) E.emit('joined_room', res);
      });
    },

    leaveRoom() {
      if (!this.socket) return;
      this.socket.emit('leave_room');
      E.emit('left_room');
    },

    // Admin actions: set options and start/stop game for current room
    setRoomOptions(opts = {}, cb) {
      if (!this.socket) return cb && cb({ ok: false, reason: 'not_connected' });
      this.socket.emit('set_room_options', opts, (res) => {
        if (cb) cb(res);
      });
    },

    startRoomGame(opts = {}, cb) {
      if (!this.socket) return cb && cb({ ok: false, reason: 'not_connected' });
      this.socket.emit('start_room_game', opts, (res) => {
        if (cb) cb(res);
      });
    },

    stopRoomGame(opts = {}, cb) {
      if (!this.socket) return cb && cb({ ok: false, reason: 'not_connected' });
      this.socket.emit('stop_room_game', opts, (res) => {
        if (cb) cb(res);
      });
    },

    sendClientReady(payload = {}, cb) {
      // Try multiple transport styles so client code can call NET.sendClientReady reliably.
      // Returns immediately; if the transport supports an ack it will call cb.
      try {
        if (this.socket && typeof this.socket.emit === 'function') {
          // socket.io style emit with optional ack callback
          try { return this.socket.emit('client_ready', payload, cb); } catch (e) {}
        }
      } catch (e) {}
      try {
        if (typeof this.send === 'function') {
          // generic NET.send(event, payload, cb) style
          try { return this.send('client_ready', payload, cb); } catch (e) {}
        }
      } catch (e) {}
      try {
        if (typeof this.startRoomGame === 'function') {
          // some implementations expect startRoomGame({ ready: true })
          try { return this.startRoomGame({ ready: true }, cb); } catch (e) {}
        }
      } catch (e) {}
      // fallback: no transport available
      if (cb) cb({ ok: false, reason: 'not_connected' });
    },

    sendHand(rawLandmarks) {
      // Accepts:
      // - raw MediaPipe landmark array for a single hand (Array of {x,y,z})
      // - raw array-of-hands: [ [points], [points], ... ] where each points is {x,y,z}
      // - an already-quantized payload object: { lm: [...] } (single hand or array-of-hands)
      // - a convenience object produced by the game (e.g. { lm, cw, ch, name })
      // If socket not present or not connected, queue payload for later delivery.
      let payload = rawLandmarks;

      // If socket is not initialized or not connected, queue payload for later delivery (capped)
      if (!this.socket || this.connected === false) {
        try {
          this.pendingHandQueue = this.pendingHandQueue || [];
          this.pendingHandQueue.push(payload);
          if (this.pendingHandQueue.length > (this.pendingHandQueueMax || 200)) this.pendingHandQueue.shift();
        } catch(e) {}
        return;
      }

      // Helper to detect a points-array (MediaPipe style) e.g. [{x:...,y:...}, ...]
      const isPointsArray = (arr) => Array.isArray(arr) && arr.length && typeof arr[0] === 'object' && arr[0] !== null && typeof arr[0].x === 'number' && typeof arr[0].y === 'number';

      // Normalize different input shapes into a consistent payload:
      // - { lm: [ [qtriplet,...] ] }  => multi-hand quantized (leave as-is)
      // - { lm: [ [ {x,y}, ... ], [ {x,y} ... ] ] } => multi-hand raw points -> quantize each
      // - single hand raw points (Array of {x,y}) -> quantize into { lm: [...] } (single hand quantized)
      if (Array.isArray(rawLandmarks)) {
        // rawLandmarks could be: single hand points OR array-of-hands
        if (isPointsArray(rawLandmarks)) {
          // single hand raw points
          payload = { lm: quantizeLandmarks(rawLandmarks) };
        } else if (Array.isArray(rawLandmarks[0]) && isPointsArray(rawLandmarks[0])) {
          // array-of-hands raw points
          payload = { lm: rawLandmarks.map(hand => quantizeLandmarks(hand)) };
        } else {
          // assume it's already quantized or in an unknown format; pass-through
          payload = rawLandmarks;
        }
      } else if (rawLandmarks && rawLandmarks.lm && Array.isArray(rawLandmarks.lm)) {
        // payload-like object with .lm
        if (Array.isArray(rawLandmarks.lm[0]) && isPointsArray(rawLandmarks.lm[0])) {
          // .lm is array-of-hands of raw points -> quantize each hand
          payload = Object.assign({}, rawLandmarks, { lm: rawLandmarks.lm.map(hand => quantizeLandmarks(hand)) });
        } else {
          // leave payload as-is (already quantized single-hand or multi-hand)
          payload = rawLandmarks;
        }
      } else {
        payload = rawLandmarks;
      }

      // Remember last sent payload so we can respond to peer_state requests quickly
      try { this._lastSentHand = payload; } catch(e){}

      // Throttle emission to reduce bandwidth.
      try {
        try { console.debug && console.debug('NET: sendHand()', payload); } catch(e){}
        if (this.sendHandThrottled) {
          this.sendHandThrottled(payload);
        } else {
          this.socket.emit('hand', payload);
        }
      } catch (e) {
        // best-effort; ignore send failures
        try { console.debug && console.debug('NET: sendHand() fallback emit', payload); } catch(e){}
        try { this.socket.emit('hand', payload); } catch (er) {}
      }
    },

    // Immediate hand send bypassing throttling (used to respond to server peer state requests)
    sendHandImmediate(payload) {
      try {
        if (!payload) return;
        // if socket not available or not connected, queue it
        if (!this.socket || this.connected === false) {
          this.pendingHandQueue = this.pendingHandQueue || [];
          this.pendingHandQueue.push(payload);
          if (this.pendingHandQueue.length > (this.pendingHandQueueMax || 200)) this.pendingHandQueue.shift();
          return;
        }
        // remember last sent
        try { this._lastSentHand = payload; } catch(e){}
        // send immediately
        try { console.debug && console.debug('NET: sendHandImmediate()', payload); } catch(e){}
        try { this.socket.emit('hand', payload); } catch (e) {}
      } catch (e) {}
    },

    // Send paint payload to server (throttled similar to hand frames).
    // Payload expected shape: { pts: [ {x,y,color,size,t}, ... ], cw, ch, name }
    sendPaint(payload) {
      try {
        if (!this.socket || this.connected === false) {
          this.pendingHandQueue = this.pendingHandQueue || [];
          this.pendingHandQueue.push(payload);
          if (this.pendingHandQueue.length > (this.pendingHandQueueMax || 200)) this.pendingHandQueue.shift();
          return;
        }
        // throttle using existing sendHandThrottled if available, otherwise emit directly
        try {
          try { console.debug && console.debug('NET: sendPaint()', payload); } catch(e){}
          if (this.sendPaintThrottled) {
            this.sendPaintThrottled(payload);
          } else {
            // direct emit as a safe fallback
            this.socket.emit('paint', payload);
          }
        } catch (e) {
          try { console.debug && console.debug('NET: sendPaint() fallback emit', payload); } catch(e){}
          try { this.socket.emit('paint', payload); } catch (er) {}
        }
      } catch (e) {}
    },

    // Immediate paint send bypassing throttling
    sendPaintImmediate(payload) {
      try {
        if (!payload) return;
        if (!this.socket || this.connected === false) {
          this.pendingHandQueue = this.pendingHandQueue || [];
          this.pendingHandQueue.push(payload);
          if (this.pendingHandQueue.length > (this.pendingHandQueueMax || 200)) this.pendingHandQueue.shift();
          return;
        }
        try { console.debug && console.debug('NET: sendPaintImmediate()', payload); } catch(e){}
        try { this.socket.emit('paint', payload); } catch (e) {}
      } catch (e) {}
    },

    postScore({ game = 'default', name = 'Anonymous', score }, cb) {
      if (!this.socket) {
        // fallback to REST
        fetch(`/leaderboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game, name, score })
        }).then(r => r.json()).then(cb).catch(err => cb && cb({ ok: false, reason: err.message }));
        return;
      }
      this.socket.emit('score', { game, name, score }, (res) => {
        if (cb) cb(res);
      });
    },

    fetchLeaderboard(game = 'default') {
      return fetch(`/leaderboard?game=${encodeURIComponent(game)}`).then(r => r.json());
    },

    on(event, cb) { E.on(event, cb); },
    off(event, cb) { E.off(event, cb); }
  };

  // Expose
  global.NET = NET;
})(window);
