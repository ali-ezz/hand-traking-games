const MAX_PER_ROOM = 50;
const ROOM_PREFIX = "room";
const rooms = new Map(); // roomId => Map(socketId => { name })

export function createRoomId(len = 6) {
  // base36 short id
  const id = Math.random().toString(36).slice(2, 2 + len).toUpperCase();
  if (rooms.has(id)) return createRoomId(len);
  rooms.set(id, new Map());
  return id;
}

export function pickRoom(requested) {
  if (requested) {
    if (!rooms.has(requested)) rooms.set(requested, new Map());
    return requested;
  }
  // find first room with capacity
  let idx = 1;
  while (true) {
    const name = `${ROOM_PREFIX}${idx}`;
    const size = rooms.get(name)?.size || 0;
    if (!rooms.has(name) || size < MAX_PER_ROOM) {
      if (!rooms.has(name)) rooms.set(name, new Map());
      return name;
    }
    idx++;
    // safety: prevent infinite loop (shouldn't happen)
    if (idx > 10000) {
      const fallback = createRoomId();
      rooms.set(fallback, new Map());
      return fallback;
    }
  }
}

export function joinRoomRecord(roomId, socketId, name) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  const map = rooms.get(roomId);
  if (socketId) map.set(socketId, { name: name || `Player-${socketId.slice(0,6)}` });
}

export function leaveRoomRecord(roomId, socketId) {
  if (!rooms.has(roomId)) return;
  const map = rooms.get(roomId);
  if (socketId) map.delete(socketId);
  // cleanup empty rooms
  if (map.size === 0) rooms.delete(roomId);
}

export function getRoomInfo(roomId) {
  const map = rooms.get(roomId);
  if (!map) return [];
  const out = [];
  for (const [id, meta] of map.entries()) {
    out.push({ id, name: meta?.name || `Player-${id.slice(0,6)}` });
  }
  return out;
}

export function findRandomRoom() {
  for (const [roomId, map] of rooms.entries()) {
    if (map.size < MAX_PER_ROOM) return roomId;
  }
  // if none, create a new room
  const id = createRoomId();
  rooms.set(id, new Map());
  return id;
}

// Return list of public rooms with counts.
// This endpoint feeds the client "available rooms" list.
export function listRooms() {
  const out = [];
  for (const [roomId, map] of rooms.entries()) {
    out.push({ roomId, count: map.size });
  }
  return out;
}
