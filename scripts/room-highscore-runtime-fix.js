/*
Runtime fix for room high-score timestamp clobbering issues.

Usage:
 - Paste the file contents into the browser console on the game page, OR
 - Include this script in the page during development (e.g. <script src="scripts/room-highscore-runtime-fix.js"></script>)
 - It registers extra NET handlers (registered after original handlers) which preserve any existing
   _serverTs when the server payload lacks explicit timestamps. This prevents server events that
   omit timing metadata from overwriting a recent local reset.

Note: This is a conservative runtime shim. If you'd like a permanent fix, I can update js/game.js
to apply the same logic where peer_score and other handlers write roomHighScoresByGame.
*/
(function () {
  try {
    if (typeof window === 'undefined') return;
    if (!window.NET || typeof window.NET.on !== 'function') {
      console.warn('room-highscore-runtime-fix: NET not found on page; aborting shim install.');
      return;
    }

    function extractServerTs(obj) {
      if (!obj) return 0;
      const candidates = [obj._serverTs, obj.ts, obj.t, obj.updatedAt, obj.updated];
      for (const c of candidates) {
        const n = Number(c);
        if (n && isFinite(n) && n > 0) return n;
      }
      return 0;
    }

    // Handle peer_score events (server may forward per-peer score updates without timestamps).
    // Register this AFTER the original handler (when run from console or included late) so our logic
    // can patch any roomHighScoresByGame entry that was just created without timestamps.
    NET.on('peer_score', (payload) => {
      try {
        if (!payload) return;
        const sc = Number(payload.score || 0);
        const gid = (payload && payload.game) ? String(payload.game) : (window.currentGameId || 'default');

        // Determine previous server ts for this game (if any)
        const prevServerTs = (window.roomHighScoresByGame && window.roomHighScoresByGame[gid] && Number(window.roomHighScoresByGame[gid]._serverTs)) 
          ? Number(window.roomHighScoresByGame[gid]._serverTs) : 0;

        const serverProvidedTs = extractServerTs(payload);

        // Only update cached room high when this score is better than existing cached value
        const existing = (window.roomHighScoresByGame && window.roomHighScoresByGame[gid]) ? window.roomHighScoresByGame[gid] : null;
        if (!existing || sc > (existing.score || 0)) {
          const name = payload.name || (window.peerGhosts && window.peerGhosts[payload.id] && window.peerGhosts[payload.id].name) || 'Player';
          try {
            window.roomHighScoresByGame = window.roomHighScoresByGame || {};
            window.roomHighScoresByGame[gid] = Object.assign({}, window.roomHighScoresByGame[gid] || {}, { name: String(name).slice(0,24), score: sc, game: gid });
            if (serverProvidedTs) {
              window.roomHighScoresByGame[gid]._serverTs = serverProvidedTs;
            } else {
              // preserve previously-known server timestamp when server omitted timing metadata
              window.roomHighScoresByGame[gid]._serverTs = prevServerTs || 0;
            }
          } catch (e) {
            // best-effort fallback
            window.roomHighScoresByGame[gid] = { name: String(name).slice(0,24), score: sc, game: gid };
            if (serverProvidedTs) window.roomHighScoresByGame[gid]._serverTs = serverProvidedTs;
          }

          try {
            if (typeof window.updateRoomHighScoreDisplay === 'function' && gid === (window.currentGameId || 'default')) {
              window.updateRoomHighScoreDisplay();
            }
          } catch (e) { /* ignore UI update failures */ }
        }
      } catch (e) {
        console.warn('room-highscore-runtime-fix peer_score handler error', e);
      }
    });

    // Defensive additional listener for room_highscore to ensure the same timestamp-preservation
    // semantics apply even if server later sends a room_highscore without timestamps.
    NET.on('room_highscore', (data) => {
      try {
        if (!data) return;
        const gid = (data && data.game) ? String(data.game) : (window.currentGameId || 'default');
        const prevServerTs = (window.roomHighScoresByGame && window.roomHighScoresByGame[gid] && Number(window.roomHighScoresByGame[gid]._serverTs)) 
          ? Number(window.roomHighScoresByGame[gid]._serverTs) : 0;
        const serverProvidedTs = extractServerTs(data);

        window.roomHighScoresByGame = window.roomHighScoresByGame || {};
        try {
          window.roomHighScoresByGame[gid] = Object.assign({}, data || {});
          if (serverProvidedTs) window.roomHighScoresByGame[gid]._serverTs = serverProvidedTs;
          else window.roomHighScoresByGame[gid]._serverTs = prevServerTs || 0;
        } catch (e) {
          window.roomHighScoresByGame[gid] = data;
          if (!window.roomHighScoresByGame[gid]._serverTs) window.roomHighScoresByGame[gid]._serverTs = prevServerTs || 0;
        }

        try { if (typeof window.updateRoomHighScoreDisplay === 'function') window.updateRoomHighScoreDisplay(); } catch (e) {}
      } catch (e) {
        console.warn('room-highscore-runtime-fix room_highscore handler error', e);
      }
    });

    console.info('room-highscore-runtime-fix installed: peer_score and room_highscore handlers now preserve previous _serverTs when server omits timestamps.');
  } catch (e) {
    console.warn('room-highscore-runtime-fix install failed', e);
  }
})();
