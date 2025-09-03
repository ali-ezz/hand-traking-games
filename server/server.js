import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { createRoomId, pickRoom, joinRoomRecord, leaveRoomRecord, getRoomInfo, findRandomRoom, listRooms } from "./rooms.js";

const app = express();
/*
  Configure CORS origin via environment variable for production.
  When hosting the client on Vercel, set ALLOWED_ORIGIN to your Vercel URL
  (for example: https://your-app.vercel.app) to restrict connections.
  If ALLOWED_ORIGIN is not set, it falls back to allowing all origins.
*/
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*' },
});

// Simple HTTP helper endpoints for UI actions
app.post("/create-room", (req, res) => {
  const roomId = createRoomId();
  // create room record (empty)
  joinRoomRecord(roomId, null);
  return res.json({ roomId });
});

app.get("/random-room", (req, res) => {
  const room = findRandomRoom();
  if (!room) return res.status(404).json({ error: "no-room-available" });
  return res.json({ roomId: room });
});

// Return list of current public rooms and their player counts.
app.get("/rooms", (req, res) => {
  try {
    const list = listRooms();
    return res.json({ rooms: list });
  } catch (e) {
    return res.status(500).json({ error: "list_failed" });
  }
});

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // Client requests to join a specific room
  socket.on("join_room", ({ roomId, name }, ack) => {
    try {
      const room = pickRoom(roomId);
      socket.join(room);
      joinRoomRecord(room, socket.id, name);
      const players = getRoomInfo(room);
      io.to(room).emit("presence_update", { type: "joined", id: socket.id, players });
      if (typeof ack === "function") ack({ ok: true, room });
      console.log(`${socket.id} joined ${room} as ${name || "anon"}`);
    } catch (e) {
      console.warn("join_room failed", e);
      if (typeof ack === "function") ack({ ok: false, error: e?.message || "join_failed" });
    }
  });

  // Create and join: helper that returns new room id and joins socket
  socket.on("create_and_join", ({ name }, ack) => {
    try {
      const roomId = createRoomId();
      socket.join(roomId);
      joinRoomRecord(roomId, socket.id, name);
      const players = getRoomInfo(roomId);
      io.to(roomId).emit("presence_update", { type: "joined", id: socket.id, players });
      if (typeof ack === "function") ack({ ok: true, roomId, players });
      console.log(`${socket.id} created and joined ${roomId} as ${name || "anon"}`);
    } catch (e) {
      console.warn("create_and_join failed", e);
      if (typeof ack === "function") ack({ ok: false, error: e?.message || "create_failed" });
    }
  });

  // request a random room from server (client-side will call /random-room often but socket alternative provided)
  socket.on("request_random_room", (payload, ack) => {
    try {
      const room = findRandomRoom();
      if (!room) return ack && ack({ ok: false, error: "no_room" });
      // auto-join
      socket.join(room);
      joinRoomRecord(room, socket.id, payload?.name);
      const players = getRoomInfo(room);
      io.to(room).emit("presence_update", { type: "joined", id: socket.id, players });
      if (typeof ack === "function") ack({ ok: true, room, players });
    } catch (e) {
      console.warn("request_random_room failed", e);
      if (typeof ack === "function") ack({ ok: false, error: e?.message || "random_join_failed" });
    }
  });

  // periodic player state (ghosts, positions, small events)
  socket.on("player_update", (msg) => {
    // msg should contain: { t, p, state } and we broadcast to the room except sender
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    for (const room of rooms) {
      socket.to(room).emit("player_update", { id: socket.id, ...msg });
    }
  });

  // clear own layer request: server authoritatively rebroadcasts clear event to room
  socket.on("clear_layer", (payload) => {
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    for (const room of rooms) {
      // server may validate ownership if needed (we simply broadcast owner's id)
      io.to(room).emit("clear_layer", { ownerId: socket.id });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("disconnect", socket.id, reason);
    // remove from any room records
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    for (const room of rooms) {
      leaveRoomRecord(room, socket.id);
      const players = getRoomInfo(room);
      io.to(room).emit("presence_update", { type: "left", id: socket.id, players });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Multiplayer server listening on :${PORT}`));
