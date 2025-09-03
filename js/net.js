/*
js/net.js
Socket.IO client wrapper for multiplayer rooms and ghost updates.
Usage:
  import * as Net from './js/net.js';
  await Net.init(); // optional serverUrl
  Net.onPresence((players)=>{ ... });
  Net.createAndJoin(name, ack);
  Net.joinRoom(roomId, name, ack);
  Net.requestRandomRoom(name, ack);
  Net.sendPlayerUpdate(payload);
  Net.clearLayer();
  Net.getPeers(); // Map of peerId -> last message
*/

const SERVER_URL = window.MULTI_SERVER_URL || null; // optional override

let socket = null;
const peers = new Map(); // id -> last message
let playersList = []; // current players metadata
let presenceCb = null;
let playerUpdateCb = null;

export async function init(serverUrl) {
  const url = serverUrl || SERVER_URL || (location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : ''));
  // if already connected to same URL, keep it
  if (socket && socket.connected && socket._url === url) return;
  // ensure socket.io client script is present
  if (!window.io) throw new Error('Socket.IO client not loaded. Include https://cdn.socket.io/4.7.5/socket.io.min.js');
  socket = window.io(url, { transports: ['websocket'] });
  socket._url = url;

  socket.on('connect', () => {
    console.info('multiplayer: connected', socket.id);
  });

  socket.on('presence_update', (msg) => {
    // msg: { type: 'joined'|'left', id, players }
    if (Array.isArray(msg.players)) playersList = msg.players;
    if (typeof presenceCb === 'function') presenceCb(playersList);
  });

  socket.on('player_update', (msg) => {
    // msg: { id, t, p, state }
    if (!msg || !msg.id) return;
    peers.set(msg.id, msg);
    if (typeof playerUpdateCb === 'function') playerUpdateCb(msg);
  });

  socket.on('clear_layer', (msg) => {
    // msg: { ownerId }
    // forward as a player_update-like event with clear flag
    if (!msg || !msg.ownerId) return;
    peers.set(msg.ownerId, { id: msg.ownerId, clear: true, t: Date.now() });
    if (typeof playerUpdateCb === 'function') playerUpdateCb({ id: msg.ownerId, clear: true });
  });

  socket.on('disconnect', (r) => {
    console.info('multiplayer: disconnected', r);
    peers.clear();
    playersList = [];
    if (typeof presenceCb === 'function') presenceCb(playersList);
  });
}

export function createAndJoin(name, ack) {
  if (!socket) return ack && ack({ ok: false, error: 'not_connected' });
  socket.emit('create_and_join', { name }, ack);
}

export function joinRoom(roomId, name, ack) {
  if (!socket) return ack && ack({ ok: false, error: 'not_connected' });
  socket.emit('join_room', { roomId, name }, ack);
}

export function requestRandomRoom(name, ack) {
  if (!socket) return ack && ack({ ok: false, error: 'not_connected' });
  socket.emit('request_random_room', { name }, ack);
}

export function sendPlayerUpdate(payload) {
  if (!socket) return;
  // payload should be small: { t, p, state }
  socket.emit('player_update', payload);
}

export function clearLayer() {
  if (!socket) return;
  socket.emit('clear_layer', {});
}

export function leaveRoom() {
  if (!socket) return;
  try { socket.disconnect(); } catch(e){}
  peers.clear();
  playersList = [];
}

export function getPeers() {
  return peers;
}

export function getPlayers() {
  return playersList.slice();
}

export function onPresence(cb) {
  presenceCb = cb;
}

export function onPlayerUpdate(cb) {
  playerUpdateCb = cb;
}
