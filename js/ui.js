/*
task_progress: 3/7

Checklist:
- [x] Analyze requirements
- [x] Set up necessary files (server/package.json)
- [x] [x] Implement main server (server/server.js)
- [x] Implement client networking (js/net.js)
- [x] Implement client UI hooks (js/ui.js)  <- current
- [ ] Integrate leaderboard persistence and client fetch
- [ ] Test locally and provide tunnel instructions

Purpose:
- Inject a compact "Rooms" panel into the page:
  - Minimized header, toggles open
  - Shows public rooms list, Create room form (id + public/private), Join by ID
  - Keeps persistent small room controls near Play and Leaderboard buttons while in a room
- Hooks into NET (js/net.js) events: rooms_list, joined_room, left_room, peer_join, peer_leave
- Automatically connects NET on load (uses same origin)
*/

(function () {
  const STATE = {
    room: null, // { id, public }
    peers: [],
    name: localStorage.getItem('player_name') || 'Player'
  };

  // Minimal styles inserted once
  const STYLE_ID = 'rooms-ui-styles';
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
.rooms-widget { position: fixed; right: 16px; bottom: 16px; width: 320px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; z-index: 9999; }
.rooms-header { background: rgba(20,20,20,0.9); color: #fff; padding: 8px 10px; border-radius: 8px; cursor: pointer; display:flex; justify-content:space-between; align-items:center; }
.rooms-body { background: rgba(255,255,255,0.98); color:#111; margin-top:8px; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.15); padding:10px; max-height:360px; overflow:auto; }
.rooms-list { margin:8px 0; max-height:140px; overflow:auto; }
.rooms-players-list { margin:6px 0; padding:6px; border:1px solid #eee; border-radius:6px; background:#fafafa; max-height:200px; overflow:auto; }
.rooms-item { display:flex; justify-content:space-between; padding:6px 8px; border-bottom:1px solid #eee; align-items:center; }
.rooms-controls { display:flex; gap:6px; margin-top:8px; }
.rooms-controls input[type="text"]{ flex:1; padding:6px; }
.rooms-controls button{ padding:6px 8px; }
.rooms-smallbar { display:flex; gap:8px; align-items:center; padding:6px 8px; border-radius:6px; background:rgba(0,0,0,0.7); color:#fff; font-size:13px; width:100%; box-sizing:border-box; }
.rooms-smallbar button{ background:transparent; color:#fff; border:1px solid rgba(255,255,255,0.12); padding:4px 6px; border-radius:4px; cursor:pointer; }
.rooms-muted { opacity:0.8; font-size:12px; }

/* make scrollbars visible / friendly across platforms */
.rooms-players-list::-webkit-scrollbar, .rooms-list::-webkit-scrollbar, .rooms-body::-webkit-scrollbar { height:10px; width:10px; }
.rooms-players-list::-webkit-scrollbar-thumb, .rooms-list::-webkit-scrollbar-thumb, .rooms-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius:6px; }
.rooms-players-list { -webkit-overflow-scrolling: touch; }

/* leaderboard / generic lists: ensure fixed size + scrollbar if content overflows */
.leaderboard, .leaders, #leaderboard, .leaders-list, .leaderboard-list { max-height:220px; overflow:auto; }
.leaderboard::-webkit-scrollbar, .leaders-list::-webkit-scrollbar, .leaderboard-list::-webkit-scrollbar { width:10px; height:10px; }
.leaderboard::-webkit-scrollbar-thumb, .leaders-list::-webkit-scrollbar-thumb, .leaderboard-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius:6px; }

`;
    document.head.appendChild(s);
  }

  // Root widget
  const root = document.createElement('div');
  root.className = 'rooms-widget';
  root.innerHTML = `
    <div class="rooms-header" title="Rooms (click to toggle)">
      <div style="display:flex;gap:8px;align-items:center;">
        <strong>Rooms</strong>
        <span class="rooms-status rooms-muted" style="font-weight:normal;font-size:12px;margin-left:6px;">(disconnected)</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="rooms-toggle-btn" style="background:transparent;border:1px solid rgba(255,255,255,0.12);color:#fff;padding:4px 6px;border-radius:6px;">Open</button>
      </div>
    </div>
    <div class="rooms-body" style="display:none;">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>Public Rooms</strong>
          <button class="refresh-rooms" style="padding:4px 6px;border-radius:6px;">Refresh</button>
        </div>
        <div class="rooms-list"></div>
      </div>
      <div style="margin-top:8px;">
        <div style="display:flex;gap:6px;">
          <input class="join-id-input" type="text" placeholder="Join by ID" />
          <button class="join-id-btn">Join</button>
        </div>
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
          <input class="create-id-input" type="text" placeholder="Optional room id" />
          <label style="display:flex;align-items:center;gap:6px;"><input class="create-public-checkbox" type="checkbox" checked /> Public</label>
          <button class="create-room-btn">Create</button>
        </div>
      </div>
      <div style="margin-top:10px;font-size:12px;color:#555;">
        While in a room, a small persistent control appears near Play / Leaderboard.
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // Elements
  const header = root.querySelector('.rooms-header');
  const toggleBtn = root.querySelector('.rooms-toggle-btn');
  const body = root.querySelector('.rooms-body');
  const statusSpan = root.querySelector('.rooms-status');
  const listEl = root.querySelector('.rooms-list');
  const refreshBtn = root.querySelector('.refresh-rooms');
  const joinIdInput = root.querySelector('.join-id-input');
  const joinIdBtn = root.querySelector('.join-id-btn');
  const createIdInput = root.querySelector('.create-id-input');
  const createPublicCheckbox = root.querySelector('.create-public-checkbox');
  const createRoomBtn = root.querySelector('.create-room-btn');
  // Use the main menu player name input as the single source of truth.
  // If the main input exists, hook into it; otherwise fall back to the local rooms input.
  const mainNameInput = (typeof document !== 'undefined') ? document.getElementById('playerName') : null;
  const nameInput = mainNameInput || root.querySelector('.player-name-input');

    if (nameInput) {
      const initName = (mainNameInput && mainNameInput.value) ? mainNameInput.value : (localStorage.getItem('player_name') || 'Player');
    STATE.name = initName;

    if (mainNameInput) {
      mainNameInput.addEventListener('change', () => {
        STATE.name = mainNameInput.value.trim() || 'Player';
        localStorage.setItem('player_name', STATE.name);

        // update local cached player entry immediately so admin/local UI reflects change instantly
        try {
          // If we have authoritative players cached, update matching entry immediately.
          if (STATE.allPlayers && NET && NET.socket && NET.socket.id) {
            for (const p of STATE.allPlayers) {
              if (p.id === NET.socket.id) {
                // update multiple possible name fields defensively
                p.name = STATE.name;
                p.displayName = STATE.name;
                p.nickname = STATE.name;
              }
            }
            try { updateRoomUI(); } catch(e){}
          } else {
            // If socket id isn't available yet, retry once after a short delay to ensure UI reflects name change.
            setTimeout(() => {
              try {
                if (STATE.allPlayers && NET && NET.socket && NET.socket.id) {
                  for (const p of STATE.allPlayers) {
                    if (p.id === NET.socket.id) {
                      p.name = STATE.name;
                      p.displayName = STATE.name;
                      p.nickname = STATE.name;
                    }
                  }
                  try { updateRoomUI(); } catch(e){}
                }
              } catch (innerErr) {}
            }, 300);
          }
        } catch(e){}

        // propagate name change to server so room members see updated name; request authoritative room update on success
        try {
          if (NET && NET.socket) {
            try {
              NET.socket.emit('set_display_name', { name: STATE.name }, (res) => {
                if (!res || !res.ok) {
                  console.warn('set_display_name failed', res);
                } else {
                  try { if (NET && NET.socket) NET.socket.emit('request_room_update'); } catch(e){}
                }
              });
            } catch (e) { console.warn('set_display_name emit failed', e); }
          }
        } catch (e) {}
      }, { passive: true });
    } else {
      nameInput.value = STATE.name;
      nameInput.addEventListener('change', () => {
        STATE.name = nameInput.value.trim() || 'Player';
        localStorage.setItem('player_name', STATE.name);
      }, { passive: true });
    }
  }

  function setStatus(text, color) {
    statusSpan.textContent = `(${text})`;
    statusSpan.style.color = color || '';
  }

  // Small persistent bar: find Play and Leaderboard buttons to attach under; otherwise attach top-right
  const smallBar = document.createElement('div');
  smallBar.className = 'rooms-smallbar';
  smallBar.style.display = 'none';
  smallBar.innerHTML = `<span class="rooms-label">Room: <strong class="room-id">-</strong></span>
  <button class="rooms-copy-btn">Copy</button>
  <button class="rooms-leave-btn">Leave</button>`;

  // Delegate clicks for admin Stop button to ensure the action fires even if the button
  // is re-rendered or its handler was lost. Uses capture to run before other handlers.
  document.addEventListener('click', (e) => {
    try {
      const stopEl = e.target && e.target.closest && e.target.closest('.rooms-admin-stop');
      const kickEl = e.target && e.target.closest && e.target.closest('.rooms-kick-btn');
      if (!stopEl && !kickEl) return;

      if (kickEl) {
        console.log('rooms: delegated kick clicked');
        e.stopPropagation();
        e.preventDefault();
        const targetId = kickEl.getAttribute('data-target-id') || kickEl.dataset.targetId;
        if (!targetId) return;

        // optimistic UI update: remove from local lists
        try {
          if (STATE.allPlayers) STATE.allPlayers = STATE.allPlayers.filter(p => p.id !== targetId);
          STATE.peers = (STATE.peers || []).filter(p => p.id !== targetId);
          updateRoomUI();
        } catch (err) { console.warn('rooms: optimistic kick UI update failed', err); }

        // call server to kick
        try {
          if (NET && NET.socket) {
            NET.socket.emit('kick_player', { id: targetId }, (res) => {
              console.log('rooms: kick callback', res);
              if (!res || !res.ok) {
                alert('Kick failed: ' + (res && res.reason ? res.reason : 'unknown'));
                // request authoritative room state as a fallback
                try { if (NET && NET.socket) NET.socket.emit('request_room_update'); } catch(e){}
                return;
              }
            });
          }
        } catch (err) {
          console.error('rooms: delegated kick threw', err);
        }
        return;
      }

      // stop handling (existing flow)
      console.log('rooms: delegated admin stop clicked');
      e.stopPropagation();
      e.preventDefault();

      // optimistic UI update
      try {
        if (STATE.room) {
          STATE.room.status = 'waiting';
          STATE.room.startTs = null;
          STATE.room.endTs = null;
        }
        updateRoomUI();
      } catch (err) { console.warn('rooms: optimistic UI update failed', err); }

      // call server to stop
      try {
        NET.stopRoomGame({}, (res) => {
          console.log('rooms: delegated stop callback', res);
          if (!res || !res.ok) {
            try { if (STATE.room) STATE.room.status = 'running'; updateRoomUI(); } catch(e){}
            alert('Stop failed: ' + (res && res.reason ? res.reason : 'unknown'));
            return;
          }
          try { if (typeof endGame === 'function') endGame(); } catch(e){}
          try {
            if (STATE.room) {
              STATE.room.status = 'waiting';
              STATE.room.startTs = null;
              STATE.room.endTs = null;
            }
            updateRoomUI();
          } catch(e){}
        });
      } catch (err) {
        console.error('rooms: delegated stop threw', err);
      }
    } catch (err) {
      console.error('rooms: delegated stop handler failed', err);
    }
  }, true);

  function attachSmallBar() {
    // Remove any existing smallbar-row to avoid duplicates
    const existing = document.querySelector('.rooms-smallbar-row');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    // find play/leader buttons and preferred containers
    const playBtn = document.getElementById('menuStartBtn') || document.getElementById('play-btn') || document.querySelector('[data-role="play"]') || Array.from(document.querySelectorAll('button')).find(b => /play/i.test(b.textContent || ''));
    const lbBtn = document.getElementById('showLeadersBtn') || document.getElementById('leaderboard-btn') || document.querySelector('[data-role="leaderboard"]') || Array.from(document.querySelectorAll('button')).find(b => /leaderboard|leaders?/i.test(b.textContent || ''));

    // Create a dedicated row container that will appear on its own line near the main menu buttons
    const container = document.createElement('div');
    container.className = 'rooms-smallbar-row';
    // place above controls visually by using marginBottom when inserted before controls
    container.style.marginBottom = '8px';
    container.style.width = '100%';
    container.style.display = 'block';
    smallBar.style.width = '100%';
    smallBar.style.boxSizing = 'border-box';

    container.appendChild(smallBar);

    // Helper: safe insert helpers
    function insertBefore(node, newNode) {
      if (!node || !node.parentNode) {
        document.body.appendChild(newNode);
        return;
      }
      node.parentNode.insertBefore(newNode, node);
    }
    function insertAfter(node, newNode) {
      if (!node || !node.parentNode) {
        document.body.appendChild(newNode);
        return;
      }
      node.parentNode.insertBefore(newNode, node.nextSibling);
    }

    // Preferred: inside a menu overlay near controls and insert BEFORE the control row
    const menuOverlay = document.getElementById('menu') || document.querySelector('.menu') || document.querySelector('.menu-overlay') || null;
    if (menuOverlay && (playBtn || lbBtn)) {
      let controlRow = null;
      try {
        if (playBtn && menuOverlay.contains(playBtn)) controlRow = playBtn.closest('div, section, nav');
        if (!controlRow && lbBtn && menuOverlay.contains(lbBtn)) controlRow = lbBtn.closest('div, section, nav');
      } catch (e) { /* ignore DOM traversal errors */ }

      // fallback: find a child row that looks like controls
      if (!controlRow) {
        controlRow = menuOverlay.querySelector('.controls, .control-row, .menu-controls, .btn-row') || menuOverlay.firstElementChild;
      }
      if (controlRow && controlRow.parentNode) {
        // insert BEFORE the control row so smallBar appears above Play/Leaderboard
        insertBefore(controlRow, container);
        return;
      }
    }

    // Fallback: try insert BEFORE the play button element or its container so it appears above
    if (playBtn && playBtn.parentNode) {
      insertBefore(playBtn.parentNode, container);
      return;
    }
    if (playBtn) {
      insertBefore(playBtn, container);
      return;
    }

    // Next fallback: place before leaderboard container
    if (lbBtn && lbBtn.parentNode) {
      insertBefore(lbBtn.parentNode, container);
      return;
    }
    if (lbBtn) {
      insertBefore(lbBtn, container);
      return;
    }

    // Last resort: append to body
    document.body.appendChild(container);
  }
  // Place small bar at init; will be repositioned on room/admin changes via updateRoomUI
  attachSmallBar();

  // Toggle visibility
  header.addEventListener('click', (e) => {
    const visible = body.style.display !== 'none';
    body.style.display = visible ? 'none' : 'block';
    toggleBtn.textContent = visible ? 'Open' : 'Close';
  });

  // NET integration (auto-connect)
  if (window.NET) {
    try { NET.connect(); } catch (e) { console.warn('NET.connect failed', e); }
    setStatus(NET.connected ? 'connected' : 'connecting', NET.connected ? 'green' : '');
    NET.on('connect', () => setStatus('connected', 'green'));
    NET.on('disconnect', () => setStatus('disconnected', 'red'));
    NET.on('rooms_list', (list) => renderRooms(list));
    NET.on('joined_room', (res) => {
      if (res && res.ok && res.room) {
        STATE.room = res.room;
        STATE.peers = res.peers || [];
        // room_update will follow from server with authoritative metadata (admin, game, status)
        updateRoomUI();
        try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
        try { if (typeof ensureLocalNameUnique === 'function') ensureLocalNameUnique(); } catch(e){}
        try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
        renderRooms([]); // refresh counts will be received from server event too
        body.style.display = 'none';
        toggleBtn.textContent = 'Open';
      }
    });

    NET.on('left_room', () => {
      STATE.room = null;
      STATE.peers = [];
      STATE.isAdmin = false;
      updateRoomUI();
      try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
      try { if (typeof ensureLocalNameUnique === 'function') ensureLocalNameUnique(); } catch(e){}
      try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
    });

    NET.on('peer_join', (p) => {
      STATE.peers = STATE.peers || [];
      // avoid duplicates
      if (!STATE.peers.find(x => x.id === p.id)) STATE.peers.push(p);
      updateRoomUI();
      try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
      try { if (typeof ensureLocalNameUnique === 'function') ensureLocalNameUnique(); } catch(e){}
      try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
      // Ask server for an authoritative room update so display names and metadata sync promptly
      try { if (NET && NET.socket) NET.socket.emit('request_room_update'); } catch(e){}
    });

    NET.on('peer_leave', (p) => {
      STATE.peers = (STATE.peers || []).filter(x => x.id !== p.id);
      updateRoomUI();
      try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
      try { if (typeof ensureLocalNameUnique === 'function') ensureLocalNameUnique(); } catch(e){}
      try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
    });

    // authoritative room metadata updates (includes admin id, game, timeLimit, status, players[])
    NET.on('room_update', (data) => {
      if (!data || !data.id) return;
      // update local room info
      STATE.room = { id: data.id, public: data.public };
      STATE.room.game = data.game;
      STATE.room.timeLimit = data.timeLimit;
      STATE.room.status = data.status;
      // store admin id explicitly for UI decisions
      STATE.room.admin = data.admin;
      // normalize players list (exclude self from peers array, but keep for UI)
      STATE.allPlayers = (data.players || []).slice();
      // peers for quick reference (others only)
      STATE.peers = (STATE.allPlayers || []).filter(p => !(NET && NET.socket && p.id === (NET.socket.id)));
      // is current socket the admin?
      STATE.isAdmin = !!(NET && NET.socket && NET.socket.id && data.admin === NET.socket.id);

      // reflect authoritative selections immediately in the main menu so all clients stay in sync
      try {
        const sel = document.getElementById('gameSelect');
        if (sel && data.game) sel.value = data.game;
        const len = document.getElementById('gameLength');
        if (len && typeof data.timeLimit === 'number') len.value = String(data.timeLimit);
      } catch (e) {}

      // ensure the small bar is positioned appropriately (admin menu area)
      try { attachSmallBar(); } catch (e) {}

      updateRoomUI();
      try { if (typeof dedupePeerDisplayNames === 'function') dedupePeerDisplayNames(); } catch(e){}
      try { if (typeof ensureLocalNameUnique === 'function') ensureLocalNameUnique(); } catch(e){}
      try { if (typeof updateRoomHighScoreDisplay === 'function') updateRoomHighScoreDisplay(); } catch(e){}
    });

    // when server says game_start, prepare client using authoritative params
    NET.on('game_start', (data) => {
      try {
        // data: { game, timeLimit, startTs, endTs }
        // set UI selectors to match server
        if (data && data.game) {
          const sel = document.getElementById('gameSelect');
          if (sel) sel.value = data.game;
          if (document.getElementById('gameLength')) document.getElementById('gameLength').value = data.timeLimit || 45;
        }

        // Update authoritative timing in room state so UI can show consistent time-left.
        // Prefer server-provided startTs/endTs; fall back to timeLimit derivation when appropriate.
        try {
          if (STATE.room) {
            if (data && typeof data.startTs !== 'undefined') {
              STATE.room.startTs = Number(data.startTs);
            }
            if (data && typeof data.endTs !== 'undefined') {
              STATE.room.endTs = Number(data.endTs);
            } else if (data && typeof data.startTs !== 'undefined' && typeof data.timeLimit !== 'undefined') {
              // server provided start + duration in seconds
              STATE.room.endTs = Number(data.startTs) + (Number(data.timeLimit) * 1000);
            }
            if (data && typeof data.timeLimit !== 'undefined') {
              STATE.room.timeLimit = Number(data.timeLimit);
            }
            // reflect changes in UI immediately
            try { updateRoomUI(); } catch(e){}
          }
        } catch (inner) { console.warn('game_start timing sync failed', inner); }

        // Do NOT start gameplay here. Wait for the authoritative 'game_begin' event from server
        // to actually begin the game (this ensures all clients use the same seed and start time).
        // Use this event only to warm/preload camera or assets if needed.
      } catch (e) { console.warn('game_start handler failed', e); }
    });

    NET.on('game_end', (data) => {
      // server ended the game early; ensure local endGame is invoked and sync room state
      try {
        if (typeof endGame === 'function') endGame();
      } catch (e) { console.warn('game_end handler failed', e); }

      // Ensure client reflects authoritative "not running" state immediately in UI,
      // in case a room_update is delayed or lost.
      try {
        if (STATE.room) {
          STATE.room.status = 'waiting';
          // clear timing info so Play button logic sees non-running state
          STATE.room.startTs = null;
          STATE.room.endTs = null;
        }
        updateRoomUI();
      } catch (e) { console.warn('Failed to sync room state on game_end', e); }
    });

    // Handle being kicked from a room
    NET.on('kicked', (data) => {
      try {
        alert(`You have been kicked from room ${data.room || ''} by the admin.`);
        STATE.room = null;
        STATE.peers = [];
        STATE.isAdmin = false;
        updateRoomUI();
      } catch (e) { console.warn('kicked handler failed', e); }
    });

    // UI helpers for room-specific rendering
    function ensureRoomInfoEl() {
      let info = body.querySelector('.rooms-room-info');
      if (!info) {
        info = document.createElement('div');
        info.className = 'rooms-room-info';
        info.style.marginTop = '10px';
        info.innerHTML = `<div style="font-size:13px;margin-bottom:6px;"><strong>Room</strong> <span class="rooms-room-id"></span> <span class="rooms-room-status rooms-muted" style="margin-left:8px;"></span></div>
          <div class="rooms-players-list" style="margin:6px 0;padding:6px;border:1px solid #eee;border-radius:6px;background:#fafafa;max-height:160px;overflow:auto;"></div>
          <div class="rooms-admin-panel" style="margin-top:8px;display:none;"></div>
          <div class="rooms-waiting-panel rooms-muted" style="margin-top:8px;display:none;">Waiting for room admin to start the game...</div>`;
        // insert before the final note element
        const note = body.querySelector('div[style*="While in a room"]');
        if (note) body.insertBefore(info, note);
        else body.appendChild(info);
      }
      return info;
    }

    function renderPlayersList(players, adminId) {
      const info = ensureRoomInfoEl();
      const list = info.querySelector('.rooms-players-list');
      list.innerHTML = '';
      if (!players || players.length === 0) {
        list.innerHTML = `<div style="padding:6px;color:#666;font-size:13px;">No players</div>`;
        return;
      }

      // helper to pick a sensible display name across different server field names
      function getDisplayName(p) {
        if (!p) return 'Player';
        return (p.displayName && String(p.displayName).trim()) ||
               (p.name && String(p.name).trim()) ||
               (p.nickname && String(p.nickname).trim()) ||
               (p.nick && String(p.nick).trim()) ||
               (p.id && String(p.id).slice(0,6)) ||
               'Player';
      }

      for (const p of players) {
        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';
        el.style.padding = '4px 6px';

        const isAdminPlayer = !!(adminId && p.id === adminId);
        const nameHtml = `<div style="font-weight:${isAdminPlayer ? '600' : '400'};">${escapeHtml(getDisplayName(p))}</div>`;
        let rightHtml = `<div style="font-size:12px;color:#666;">${isAdminPlayer ? 'admin' : ''}</div>`;

        // Render Kick button for room admin users (can't kick self)
        try {
          const localId = (NET && NET.socket && NET.socket.id) ? NET.socket.id : null;
          if (STATE.isAdmin && p.id !== localId) {
            rightHtml = `<div style="display:flex;gap:6px;align-items:center;"><div style="font-size:12px;color:#666;">${isAdminPlayer ? 'admin' : ''}</div><button class="rooms-kick-btn" data-target-id="${p.id}" style="padding:4px 6px;border-radius:4px;">Kick</button></div>`;
          }
        } catch (e) {
          // fallback: no kick button if socket state isn't available
        }

        el.innerHTML = `${nameHtml}${rightHtml}`;
        list.appendChild(el);
      }
    }

    // minimal HTML escape to avoid accidental markup injection if server sends HTML
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#39;');
    }

    function renderAdminPanel(room) {
      const info = ensureRoomInfoEl();
      const panel = info.querySelector('.rooms-admin-panel');
      // Admin controls removed from the Rooms panel — they live in the main menu now.
      panel.innerHTML = `<div style="font-size:13px;color:#666;">Room admin controls moved to main menu.</div>`;
      panel.style.display = 'block';
    }

    function renderWaitingPanel() {
      const info = ensureRoomInfoEl();
      const wait = info.querySelector('.rooms-waiting-panel');
      wait.style.display = 'block';
      // hide admin panel just in case
      const panel = info.querySelector('.rooms-admin-panel');
      if (panel) panel.style.display = 'none';
    }

    function hideRoomInfo() {
      const info = body.querySelector('.rooms-room-info');
      if (info) {
        const panel = info.querySelector('.rooms-admin-panel');
        if (panel) panel.style.display = 'none';
        const wait = info.querySelector('.rooms-waiting-panel');
        if (wait) wait.style.display = 'none';
        const players = info.querySelector('.rooms-players-list');
        if (players) players.innerHTML = '';
      }
    }

    function updateRoomUI() {
      // sync the basic smallBar and the main body panels depending on room/admin state
      updateSmallBar();

      // Hide/show game selection controls based on room membership and admin status
      const gameSelect = document.getElementById('gameSelect');
      const gameLength = document.getElementById('gameLength');
      const menuStartBtn = document.getElementById('menuStartBtn');

      if (!STATE.room) {
        // Not in a room - show all controls
        if (gameSelect) gameSelect.style.display = '';
        if (gameLength) gameLength.style.display = '';
        if (menuStartBtn) menuStartBtn.style.display = '';

        // restore create/join controls (enable buttons)
        joinIdInput.style.display = '';
        joinIdBtn.style.display = '';
        createIdInput.style.display = '';
        createPublicCheckbox.style.display = '';
        createRoomBtn.style.display = '';
        hideRoomInfo();

        // ensure small bar repositioning for main menu state
        try { attachSmallBar(); } catch (e){}
        return;
      }

      // In a room - hide game/time controls for non-admin users
      if (!STATE.isAdmin) {
        if (gameSelect) gameSelect.style.display = 'none';
        if (gameLength) gameLength.style.display = 'none';
        if (menuStartBtn) menuStartBtn.style.display = 'none'; // remove Play button for non-admins
      } else {
        // Admin users can see and control game settings
        if (gameSelect) gameSelect.style.display = '';
        if (gameLength) gameLength.style.display = '';
        if (menuStartBtn) menuStartBtn.style.display = ''; // ensure Play visible for admin
      }

      // in-room: hide create/join controls
      joinIdInput.style.display = 'none';
      joinIdBtn.style.display = 'none';
      createIdInput.style.display = 'none';
      createPublicCheckbox.style.display = 'none';
      createRoomBtn.style.display = 'none';

      // name is controlled via the main menu input; nothing to toggle here

      // render player list (allPlayers if available, otherwise STATE.peers + local)
      const all = STATE.allPlayers || [];
      let adminId = null;
      try { adminId = (NET && NET.socket && NET.socket.id && (STATE.isAdmin ? NET.socket.id : null)) || (all.find(p => p && p.isAdmin) || (all.length ? all[0].id : null)); } catch(e){}
      renderPlayersList(all.length ? all : (STATE.peers || []).concat([{ id: NET && NET.socket ? NET.socket.id : 'me', name: STATE.name }]), (STATE.room && STATE.isAdmin) ? (NET && NET.socket && NET.socket.id) : (all.length ? (all.find(p=>p && p.id) && all[0].id) : null));

      // admin vs non-admin UI
      if (STATE.isAdmin) {
        renderAdminPanel(STATE.room);
        const info = ensureRoomInfoEl();
        info.querySelector('.rooms-waiting-panel').style.display = 'none';
      } else {
        // non-admin: only show waiting panel
        renderWaitingPanel();
      }

      // Update Play button label for admin to reflect current room status (Play / Stop)
      try {
        if (menuStartBtn && STATE.room && STATE.isAdmin) {
          try { menuStartBtn.textContent = (STATE.room.status === 'running') ? 'Stop' : 'Play'; } catch(e){}
        } else if (menuStartBtn) {
          // restore default label for non-admin or no-room state
          try { menuStartBtn.textContent = 'Play'; } catch(e){}
        }
      } catch (e) {}

      // Reposition the smallBar so it appears under Play/Leaderboard in admin/main pages
      try { attachSmallBar(); } catch (e){}
    }

    // Intercept local Play/start when user is in-room.
    // For non-admins: block and show waiting message.
    // For admins: convert local Start into a server-driven start (set options + start_room_game)
    // Use capture + stopImmediatePropagation so the existing gameStart handler (in game.js) doesn't run.
    const menuStartBtn = document.getElementById('menuStartBtn');
    if (menuStartBtn) {
      menuStartBtn.addEventListener('click', (e) => {
        // If not in a room, let normal flow proceed
        if (!STATE.room) return;

        // prevent local start handlers from running; we will forward to server for room sessions
        e.stopImmediatePropagation();
        e.preventDefault();

        if (!STATE.isAdmin) {
          alert('Waiting for the room admin to start the game');
          return;
        }

        // Read selected options from the main menu selectors (admin UI moved there)
        const game = (document.getElementById('gameSelect') ? document.getElementById('gameSelect').value : 'default');
        const timeLimit = (document.getElementById('gameLength') ? Number(document.getElementById('gameLength').value) : (STATE.room && STATE.room.timeLimit) || 60);

        // Admin toggles start/stop via the main Play button
        const isRunning = STATE.room && STATE.room.status === 'running';

        if (isRunning) {
          // If a game is already running, decide: if the selected options differ, replace the running game with the new selection.
          // Otherwise, stop the running game.
          const currentGame = STATE.room && STATE.room.game;
          const currentTime = STATE.room && STATE.room.timeLimit;

          if (game !== currentGame || timeLimit !== currentTime) {
            // Replace running game with newly selected game/timeLimit (server will cleanly stop the old run)
            NET.setRoomOptions({ game, timeLimit }, (setRes) => {
              if (!setRes || !setRes.ok) {
                alert('Failed to set room options: ' + (setRes && setRes.reason ? setRes.reason : 'unknown'));
                return;
              }
              NET.startRoomGame({ game, timeLimit }, (res) => {
                // Handle the common race where the server still considers a run active.
                if (res && res.ok) {
                  try { attachSmallBar(); } catch (e) {}
                  return;
                }
                if (res && res.reason === 'already_running') {
                  // Try stopping first, then start again after a short delay to avoid race
                  NET.stopRoomGame({}, (stopRes) => {
                    // If stop succeeded, proactively update UI so admin sees stopped state immediately
                    try {
                      if (stopRes && stopRes.ok) {
                        try { if (typeof endGame === 'function') endGame(); } catch(e){}
                        if (STATE.room) {
                          STATE.room.status = 'waiting';
                          STATE.room.startTs = null;
                          STATE.room.endTs = null;
                        }
                        try { updateRoomUI(); } catch(e){}
                      }
                    } catch (e){}
                    // best-effort: ignore stop failures and retry start once after 200ms
                    setTimeout(() => {
                      NET.startRoomGame({ game, timeLimit }, (r2) => {
                        if (!r2 || !r2.ok) alert('Failed to replace running room: ' + (r2 && r2.reason ? r2.reason : 'unknown'));
                        try { attachSmallBar(); } catch (e) {}
                      });
                    }, 200);
                  });
                  return;
                }
                alert('Failed to replace running room: ' + (res && res.reason ? res.reason : 'unknown'));
              });
            });
          } else {
            // Selected options match current run -> stop it
                NET.stopRoomGame({}, (res) => {
                  if (!res || !res.ok) {
                    alert('Failed to stop room: ' + (res && res.reason ? res.reason : 'unknown'));
                    return;
                  }
                  // proactively reflect stopped state immediately in UI and end local game
                  try { if (typeof endGame === 'function') endGame(); } catch(e){}
                  try {
                    if (STATE.room) {
                      STATE.room.status = 'waiting';
                      STATE.room.startTs = null;
                      STATE.room.endTs = null;
                    }
                    updateRoomUI();
                  } catch(e){}
                });
          }
          return;
        }

        // Not running: start a new room run with selected options
        NET.setRoomOptions({ game, timeLimit }, (setRes) => {
          if (!setRes || !setRes.ok) {
            alert('Failed to set room options: ' + (setRes && setRes.reason ? setRes.reason : 'unknown'));
            return;
          }
          NET.startRoomGame({ game, timeLimit }, (res) => {
            if (res && res.ok) {
              try { attachSmallBar(); } catch(e){}
              return;
            }
              if (res && res.reason === 'already_running') {
                // If server reports already_running, stop then retry starting with the selected options after a short delay
                NET.stopRoomGame({}, (stopRes) => {
                  // If stop succeeded, proactively update UI to not appear running while we retry
                  try {
                    if (stopRes && stopRes.ok) {
                      try { if (typeof endGame === 'function') endGame(); } catch(e){}
                      if (STATE.room) {
                        STATE.room.status = 'waiting';
                        STATE.room.startTs = null;
                        STATE.room.endTs = null;
                      }
                      try { updateRoomUI(); } catch(e){}
                    }
                  } catch(e){}
                  setTimeout(() => {
                    NET.startRoomGame({ game, timeLimit }, (r2) => {
                      if (!r2 || !r2.ok) alert('Failed to start room after stopping previous run: ' + (r2 && r2.reason ? r2.reason : 'unknown'));
                      try { attachSmallBar(); } catch(e){}
                    });
                  }, 200);
                });
                return;
              }
            alert('Failed to start room: ' + (res && res.reason ? res.reason : 'unknown'));
          });
        });
      }, true);
    }

    // Enhance small bar update to reflect status and admin controls
    const _origUpdateSmallBar = updateSmallBar;
    function updateSmallBar() {
      if (!STATE.room) {
        smallBar.style.display = 'none';
        return;
      }
      smallBar.style.display = 'inline-flex';
      const idEl = smallBar.querySelector('.room-id');
      if (idEl) idEl.textContent = STATE.room.id;

      // status element
      let statusEl = smallBar.querySelector('.room-status');
      if (!statusEl) {
        statusEl = document.createElement('span');
        statusEl.className = 'room-status rooms-muted';
        statusEl.style.marginLeft = '8px';
        smallBar.insertBefore(statusEl, smallBar.querySelector('.rooms-copy-btn'));
      }
      statusEl.textContent = STATE.room.status ? ` ${STATE.room.status}` : '';

      // players count
      let countEl = smallBar.querySelector('.room-count');
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'room-count rooms-muted';
        countEl.style.marginLeft = '8px';
        smallBar.insertBefore(countEl, statusEl.nextSibling);
      }
      const count = (STATE.allPlayers && STATE.allPlayers.length) ? STATE.allPlayers.length : ((STATE.peers ? STATE.peers.length : 0) + 1);
      countEl.textContent = ` ${count} players`;

      // Remove any leftover admin buttons if present.
      const existingAdminStart = smallBar.querySelector('.rooms-admin-start');
      if (existingAdminStart) existingAdminStart.remove();

      // Reuse existing Stop button when possible to avoid losing its event handler.
      let existingAdminStop = smallBar.querySelector('.rooms-admin-stop');
      if (existingAdminStop) {
        // remove it if no longer needed
        if (!(STATE.isAdmin && STATE.room && STATE.room.status === 'running')) {
          existingAdminStop.remove();
          existingAdminStop = null;
        }
      }

      // If current socket is the room admin, ensure a small Stop button is present so stop action is sent reliably.
      if (STATE.isAdmin && STATE.room && STATE.room.status === 'running') {
        if (!existingAdminStop) {
          const stopBtn = document.createElement('button');
          stopBtn.className = 'rooms-admin-stop';
          stopBtn.textContent = 'Stop';
          stopBtn.title = 'Stop running game (admin)';
          stopBtn.style.marginLeft = '8px';

          stopBtn.addEventListener('click', (ev) => {
            console.log('rooms: admin stop clicked');
            ev.stopPropagation();

            // provide immediate visual feedback
            try {
              if (STATE.room) {
                STATE.room.status = 'waiting';
                STATE.room.startTs = null;
                STATE.room.endTs = null;
              }
              updateRoomUI();
            } catch (e) { console.warn('rooms: ui update failed', e); }

            // Call server to stop; handle callback (may be synchronous if not connected)
            try {
              NET.stopRoomGame({}, (res) => {
                console.log('rooms: stop callback', res);
                if (!res || !res.ok) {
                  // revert status if stop failed
                  try {
                    if (STATE.room) STATE.room.status = 'running';
                    updateRoomUI();
                  } catch (e) {}
                  alert('Stop failed: ' + (res && res.reason ? res.reason : 'unknown'));
                  return;
                }
                // success: end local game immediately
                try { if (typeof endGame === 'function') endGame(); } catch(e){}
                try {
                  if (STATE.room) {
                    STATE.room.status = 'waiting';
                    STATE.room.startTs = null;
                    STATE.room.endTs = null;
                  }
                  updateRoomUI();
                } catch(e){}
              });
            } catch (err) {
              console.error('rooms: stopRoomGame threw', err);
            }
          }, false);

          const copyBtn = smallBar.querySelector('.rooms-copy-btn');
          if (copyBtn && copyBtn.parentNode) copyBtn.parentNode.insertBefore(stopBtn, copyBtn);
          else smallBar.appendChild(stopBtn);
        }
      }
    }
  } else {
    setStatus('offline', 'gray');
  }

  // Render rooms list
  function renderRooms(list) {
    listEl.innerHTML = '';
    if (!list || list.length === 0) {
      listEl.innerHTML = `<div style="padding:8px;color:#666;font-size:13px;">No public rooms</div>`;
      return;
    }
    list.forEach(r => {
      const item = document.createElement('div');
      item.className = 'rooms-item';
      item.innerHTML = `<div><strong>${r.id}</strong><div class="rooms-muted" style="font-size:12px;">${r.count} players</div></div>
        <div><button data-room="${r.id}" style="padding:6px 8px;border-radius:6px;">Join</button></div>`;
      const btn = item.querySelector('button');
      btn.addEventListener('click', () => {
        joinRoomById(r.id);
      });
      listEl.appendChild(item);
    });
  }

  refreshBtn.addEventListener('click', () => {
    // Ask server for rooms list (NET will emit 'rooms_list' when available)
    // If no socket, try fetch fallback to /rooms_list (server doesn't provide REST - rely on socket)
    if (NET && NET.socket) {
      // request via no-op: server already emits rooms_list; but we can ping
      NET.socket.emit('ping_rooms');
    }
  });

  function joinRoomById(id) {
    const name = STATE.name;
    NET.joinRoom({ roomId: id, name }, (res) => {
      if (!res || !res.ok) {
        alert('Failed to join: ' + (res && res.reason ? res.reason : 'unknown'));
        return;
      }
      console.log('joined', res);
    });
  }

  joinIdBtn.addEventListener('click', () => {
    const id = joinIdInput.value.trim();
    if (!id) return alert('Enter room ID');
    joinRoomById(id);
  });

  createRoomBtn.addEventListener('click', () => {
    const id = createIdInput.value.trim();
    const isPublic = !!createPublicCheckbox.checked;
    NET.createRoom({ id: id || undefined, isPublic }, (res) => {
      if (!res || !res.ok) {
        alert('Create failed: ' + (res && res.reason ? res.reason : 'unknown'));
        return;
      }
      // auto-join after create
      NET.joinRoom({ roomId: res.room.id, name: STATE.name }, (jr) => {
        if (!jr || !jr.ok) {
          alert('Created but failed to join: ' + (jr && jr.reason ? jr.reason : 'unknown'));
        }
      });
    });
  });


  // Small bar actions
  smallBar.querySelector('.rooms-copy-btn').addEventListener('click', () => {
    if (!STATE.room) return;
    navigator.clipboard?.writeText(STATE.room.id).then(() => {
      const old = smallBar.querySelector('.rooms-copy-btn').textContent;
      smallBar.querySelector('.rooms-copy-btn').textContent = 'Copied';
      setTimeout(() => smallBar.querySelector('.rooms-copy-btn').textContent = old, 1500);
    });
  });
  smallBar.querySelector('.rooms-leave-btn').addEventListener('click', () => {
    NET.leaveRoom();
    STATE.room = null;
    updateSmallBar();
  });

  // Expose for debugging
  window.ROOMS_UI = {
    state: STATE,
    updateSmallBar,
    renderRooms
  };

  // Update status periodically
  setInterval(() => {
    if (NET && NET.connected) setStatus('connected', 'green');
    else setStatus('disconnected', 'red');
  }, 2000);
})();
