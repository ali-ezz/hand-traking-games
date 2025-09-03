// js/ui.js
// Simple UI wiring for multiplayer: init Socket.IO client and wire Create Room / Join Random buttons.
// Depends on js/net.js being present and Socket.IO client script loaded on the page.

import * as Net from './net.js';

const createBtn = document.getElementById('createRoomBtn');
const joinByIdBtn = document.getElementById('joinByIdBtn');
const showRoomsBtn = document.getElementById('showRoomsBtn');
const roomIdInput = document.getElementById('roomIdInput');
const roomDisplay = document.getElementById('roomIdDisplay');
const playerNameEl = document.getElementById('playerName');

// Lightweight players HUD inserted into #ui
let playersHud = null;
function ensurePlayersHud() {
  if (playersHud) return playersHud;
  const ui = document.getElementById('ui');
  playersHud = document.createElement('div');
  playersHud.id = 'playersHud';
  playersHud.style.marginLeft = '8px';
  playersHud.style.padding = '6px 10px';
  playersHud.style.background = 'rgba(255,255,255,0.03)';
  playersHud.style.borderRadius = '8px';
  playersHud.style.fontSize = '13px';
  playersHud.textContent = 'Players: -';
  ui.appendChild(playersHud);
  return playersHud;
}

function setRoomDisplay(id) {
  if (!roomDisplay) return;
  roomDisplay.textContent = `Room: ${id || '-'}`;
}

function setPlayersList(players) {
  try {
    ensurePlayersHud();
    if (!players || !players.length) {
      playersHud.textContent = 'Players: -';
      return;
    }
    // show up to 6 names
    const names = players.map(p => p.name || p.id.slice(0,6)).slice(0,6);
    playersHud.textContent = `Players (${players.length}): ${names.join(', ')}`;
  } catch (e) { console.warn('setPlayersList failed', e); }
}

async function ensureNet() {
  try {
    if (!window.io) {
      console.warn('Socket.IO client not found on page. Ensure <script src="https://cdn.socket.io/..."></script> is included.');
    }
    await Net.init(); // uses default URL
    // subscribe to presence updates
    Net.onPresence((players) => {
      setPlayersList(players);
    });
    Net.onPlayerUpdate((msg) => {
      // We don't need to do anything here; game.js consumes Net.getPeers()
      // But we can mark room active when the first player update arrives.
    });
    return true;
  } catch (e) {
    console.warn('Net.init failed', e);
    return false;
  }
}

if (createBtn) {
  createBtn.addEventListener('click', async () => {
    const name = (playerNameEl && playerNameEl.value) ? playerNameEl.value.trim().slice(0,24) : undefined;
    await ensureNet();
    Net.createAndJoin(name, (resp) => {
      if (!resp) return alert('Create failed (no response)');
      if (resp.ok) {
        setRoomDisplay(resp.roomId || resp.room || '-');
        setPlayersList(resp.players || []);
        // feedback
        try { /* small flash */ } catch(e){}
      } else {
        alert('Create room error: ' + (resp.error || 'unknown'));
      }
    });
  });
}

if (joinByIdBtn) {
  joinByIdBtn.addEventListener('click', async () => {
    const id = (roomIdInput && roomIdInput.value) ? roomIdInput.value.trim().toUpperCase() : '';
    if (!id) return alert('Enter a Room ID to join.');
    const name = (playerNameEl && playerNameEl.value) ? playerNameEl.value.trim().slice(0,24) : undefined;
    await ensureNet();
    Net.joinRoom(id, name, (resp) => {
      if (!resp) return alert('Join failed (no response)');
      if (resp.ok) {
        setRoomDisplay(resp.room || id);
        // players list will be updated via presence_update
      } else {
        alert('Join room error: ' + (resp.error || 'not_found'));
      }
    });
  });
}

if (showRoomsBtn) {
  showRoomsBtn.addEventListener('click', async () => {
    await ensureNet();
    const base = window.MULTI_SERVER_URL || (location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : ''));
    try {
      const res = await fetch(base + '/rooms');
      if (!res.ok) throw new Error('fetch_failed');
      const json = await res.json();
      const rooms = (json && json.rooms) ? json.rooms : [];
      if (!rooms.length) return alert('No public rooms available.');
      // build simple modal
      const modal = document.createElement('div');
      modal.style.position = 'fixed';
      modal.style.inset = '0';
      modal.style.display = 'flex';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
      modal.style.zIndex = '60';
      modal.style.background = 'rgba(0,0,0,0.6)';
      const box = document.createElement('div');
      box.style.background = 'rgba(0,0,0,0.9)';
      box.style.padding = '12px';
      box.style.borderRadius = '10px';
      box.style.color = '#fff';
      box.style.maxHeight = '70vh';
      box.style.overflow = 'auto';
      box.style.minWidth = '320px';
      const title = document.createElement('div');
      title.textContent = 'Available Rooms';
      title.style.fontWeight = '700';
      title.style.marginBottom = '8px';
      box.appendChild(title);
      for (const r of rooms) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '6px 0';
        const label = document.createElement('div');
        label.textContent = `${r.roomId} (${r.count})`;
        label.style.marginRight = '8px';
        const btn = document.createElement('button');
        btn.textContent = 'Join';
        btn.className = 'btn';
        btn.style.marginLeft = '8px';
        btn.onclick = async () => {
          const name = (playerNameEl && playerNameEl.value) ? playerNameEl.value.trim().slice(0,24) : undefined;
          Net.joinRoom(r.roomId, name, (resp) => {
            if (resp && resp.ok) {
              setRoomDisplay(resp.room || r.roomId);
            } else {
              alert('Join failed: ' + (resp?.error || 'unknown'));
            }
            document.body.removeChild(modal);
          });
        };
        row.appendChild(label);
        row.appendChild(btn);
        box.appendChild(row);
      }
      const close = document.createElement('div');
      close.style.display = 'flex';
      close.style.justifyContent = 'flex-end';
      close.style.marginTop = '8px';
      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close';
      closeBtn.className = 'btn';
      closeBtn.onclick = () => document.body.removeChild(modal);
      close.appendChild(closeBtn);
      box.appendChild(close);
      modal.appendChild(box);
      document.body.appendChild(modal);
    } catch (e) {
      console.warn('showRooms failed', e);
      alert('Failed to fetch rooms.');
    }
  });
}


// Also expose a small API for other modules
export function showRoom(id) { setRoomDisplay(id); }
export function updatePlayers(players) { setPlayersList(players); }

// initialize lazily so page load isn't blocked
// call ensureNet to preconnect if desired; we will not auto-init to avoid extra network calls until user interacts.
