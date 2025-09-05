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
.rooms-body { background: rgba(255,255,255,0.98); color:#111; margin-top:8px; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.15); padding:10px; max-height:320px; overflow:auto; }
.rooms-list { margin:8px 0; max-height:120px; overflow:auto; }
.rooms-item { display:flex; justify-content:space-between; padding:6px 8px; border-bottom:1px solid #eee; align-items:center; }
.rooms-controls { display:flex; gap:6px; margin-top:8px; }
.rooms-controls input[type="text"]{ flex:1; padding:6px; }
.rooms-controls button{ padding:6px 8px; }
.rooms-smallbar { display:flex; gap:8px; align-items:center; padding:6px 8px; border-radius:6px; background:rgba(0,0,0,0.7); color:#fff; font-size:13px; width:100%; box-sizing:border-box; }
.rooms-smallbar button{ background:transparent; color:#fff; border:1px solid rgba(255,255,255,0.12); padding:4px 6px; border-radius:4px; cursor:pointer; }
.rooms-muted { opacity:0.8; font-size:12px; }
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

  function attachSmallBar() {
    // Try to find elements with id or text 'play' or 'leaderboard'
    const playBtn = document.getElementById('play-btn') || document.querySelector('[data-role="play"]') || Array.from(document.querySelectorAll('button')).find(b => /play/i.test(b.textContent || ''));
    const lbBtn = document.getElementById('leaderboard-btn') || document.querySelector('[data-role="leaderboard"]') || Array.from(document.querySelectorAll('button')).find(b => /leaderboard|leaders?/i.test(b.textContent || ''));

    // Create a dedicated row container that will appear on its own line beneath the main menu buttons
    const container = document.createElement('div');
    container.className = 'rooms-smallbar-row';
    container.style.marginTop = '8px';
    container.style.width = '100%';
    container.style.display = 'block';
    smallBar.style.width = '100%';
    smallBar.style.boxSizing = 'border-box';

    container.appendChild(smallBar);

    if (playBtn && playBtn.parentNode) {
      // insert the container immediately after the Play button so it appears on its own line
      playBtn.parentNode.insertBefore(container, playBtn.nextSibling);
    } else if (lbBtn && lbBtn.parentNode) {
      lbBtn.parentNode.insertBefore(container, lbBtn.nextSibling);
    } else {
      document.body.appendChild(container);
    }
  }
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
    });

    NET.on('peer_join', (p) => {
      STATE.peers = STATE.peers || [];
      // avoid duplicates
      if (!STATE.peers.find(x => x.id === p.id)) STATE.peers.push(p);
      updateRoomUI();
    });

    NET.on('peer_leave', (p) => {
      STATE.peers = (STATE.peers || []).filter(x => x.id !== p.id);
      updateRoomUI();
    });

    // authoritative room metadata updates (includes admin id, game, timeLimit, status, players[])
    NET.on('room_update', (data) => {
      if (!data || !data.id) return;
      // update local room info
      STATE.room = { id: data.id, public: data.public };
      STATE.room.game = data.game;
      STATE.room.timeLimit = data.timeLimit;
      STATE.room.status = data.status;
      // normalize players list (exclude self from peers array, but keep for UI)
      STATE.allPlayers = (data.players || []).slice();
      // peers for quick reference (others only)
      STATE.peers = (STATE.allPlayers || []).filter(p => !(NET && NET.socket && p.id === (NET.socket.id)));
      // is current socket the admin?
      STATE.isAdmin = !!(NET && NET.socket && NET.socket.id && data.admin === NET.socket.id);
      updateRoomUI();
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
        // Do NOT start gameplay here. Wait for the authoritative 'game_begin' event from server
        // to actually begin the game (this ensures all clients use the same seed and start time).
        // Use this event only to warm/preload camera or assets if needed.
      } catch (e) { console.warn('game_start handler failed', e); }
    });

    NET.on('game_end', (data) => {
      // server ended the game early; ensure local endGame is invoked
      try {
        if (typeof endGame === 'function') endGame();
      } catch (e) { console.warn('game_end handler failed', e); }
    });

    // UI helpers for room-specific rendering
    function ensureRoomInfoEl() {
      let info = body.querySelector('.rooms-room-info');
      if (!info) {
        info = document.createElement('div');
        info.className = 'rooms-room-info';
        info.style.marginTop = '10px';
        info.innerHTML = `<div style="font-size:13px;margin-bottom:6px;"><strong>Room</strong> <span class="rooms-room-id"></span> <span class="rooms-room-status rooms-muted" style="margin-left:8px;"></span></div>
          <div class="rooms-players-list" style="margin:6px 0;padding:6px;border:1px solid #eee;border-radius:6px;background:#fafafa;max-height:120px;overflow:auto;"></div>
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
      for (const p of players) {
        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';
        el.style.padding = '4px 6px';
        el.innerHTML = `<div style="font-weight:${(adminId && p.id === adminId) ? '600' : '400'};">${p.name || 'Player'}</div>
          <div style="font-size:12px;color:#666;">${p.id === adminId ? 'admin' : ''}</div>`;
        list.appendChild(el);
      }
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

      // Also ensure the main Play button is hidden for non-admin room members
      try {
        const menuStartBtn = document.getElementById('menuStartBtn');
        if (menuStartBtn) {
          if (!STATE.room) {
            menuStartBtn.style.display = '';
          } else if (!STATE.isAdmin) {
            // remove Play for non-admins (keep Leaderboard visible)
            menuStartBtn.style.display = 'none';
          } else {
            menuStartBtn.style.display = '';
          }
        }
      } catch (e) {}

      // Hide/show game selection controls based on room membership and admin status
      const gameSelect = document.getElementById('gameSelect');
      const gameLength = document.getElementById('gameLength');
      
      if (!STATE.room) {
        // Not in a room - show all controls
        if (gameSelect) gameSelect.style.display = '';
        if (gameLength) gameLength.style.display = '';
        
        // restore create/join controls (enable buttons)
        joinIdInput.style.display = '';
        joinIdBtn.style.display = '';
        createIdInput.style.display = '';
        createPublicCheckbox.style.display = '';
        createRoomBtn.style.display = '';
        hideRoomInfo();
        return;
      }

      // In a room - hide game/time controls for non-admin users
      if (!STATE.isAdmin) {
        if (gameSelect) gameSelect.style.display = 'none';
        if (gameLength) gameLength.style.display = 'none';
      } else {
        // Admin users can see and control game settings
        if (gameSelect) gameSelect.style.display = '';
        if (gameLength) gameLength.style.display = '';
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
        const info = ensureRoomInfoEl();        info.querySelector('.rooms-waiting-panel').style.display = 'none';
      } else {
        // non-admin: only show waiting panel (Play is hidden above)
        renderWaitingPanel();
      }
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

        // Admin toggles start/stop via the main Play button
        const isRunning = STATE.room && STATE.room.status === 'running';

        if (isRunning) {
          // stop the running room game
          NET.stopRoomGame({}, (res) => {
            if (!res || !res.ok) alert('Failed to stop room: ' + (res && res.reason ? res.reason : 'unknown'));
          });
          return;
        }

        // starting: read options from the main menu selectors (admin UI moved there)
        const game = (document.getElementById('gameSelect') ? document.getElementById('gameSelect').value : 'default');
        const timeLimit = (document.getElementById('gameLength') ? Number(document.getElementById('gameLength').value) : (STATE.room && STATE.room.timeLimit) || 60);

        // apply options then request server to start the game for the room
        NET.setRoomOptions({ game, timeLimit }, (setRes) => {
          if (!setRes || !setRes.ok) {
            alert('Failed to set room options: ' + (setRes && setRes.reason ? setRes.reason : 'unknown'));
            return;
          }
          NET.startRoomGame({}, (res) => {
            if (!res || !res.ok) alert('Failed to start room: ' + (res && res.reason ? res.reason : 'unknown'));
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

      // no admin controls in small bar; the main Play button is the single start/stop control for admins.
      // Remove any leftover admin buttons if present.
      const existingAdminStart = smallBar.querySelector('.rooms-admin-start');
      if (existingAdminStart) existingAdminStart.remove();
      const existingAdminStop = smallBar.querySelector('.rooms-admin-stop');
      if (existingAdminStop) existingAdminStop.remove();
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

  function updateSmallBar() {
    if (!STATE.room) {
      smallBar.style.display = 'none';
      return;
    }
    smallBar.style.display = 'inline-flex';
    smallBar.querySelector('.room-id').textContent = STATE.room.id;
  }

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
