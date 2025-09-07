# Test Steps — Room high score reset on room_update

Purpose
- Verify clients treat a server/admin `room_update` (selected game change) as a room-level reset for the newly-selected game: cached room high must be set to zero, stamped as server-provided, and the UI should show "Room Best: <name>: 0" immediately until a later authoritative value arrives.

Prerequisites
- Start the server (example): `node server/server.js`
- Open two browser clients (same room): one admin, one regular player.
- Confirm you have the latest `js/game.js` with the room_update change applied.

Manual tests

1) Basic reset on game-change (manual admin)
- Steps:
  1. Ensure a non-zero room best exists for game A on clients.
  2. As admin, change the room's selected game to game B (via admin UI or server command that emits `room_update` with `{ game: '<gid>' }`).
  3. Observe all clients.
- Expected:
  - Immediately after `room_update`, each client shows "Room Best: <Player>: 0" for game B.
  - In memory, `roomHighScoresByGame[gid]` exists and has `score: 0` and `_serverTs` set (recent timestamp).
  - `updateRoomHighScoreDisplay()` runs and updates the displayed string.

2) Reset replaced by authoritative highscore
- Steps:
  1. After test (1), cause a server-originated `room_highscore` event or a peer score publish with a later timestamp (e.g., finish a game round with a real score).
  2. Observe clients.
- Expected:
  - The zeroed room-best is replaced by the new authoritative value when that event arrives (server timestamp or later peer_score supersedes the reset).
  - If the incoming timestamp is earlier than `_serverTs`, the client keeps the reset (timestamp logic).

3) Multi-client sync
- Steps:
  1. Run test (1) while multiple clients are connected (3+).
  2. Confirm all clients get the same immediate reset and display zero at the same time.
- Expected:
  - All clients show the zeroed room best immediately following `room_update`.

4) Leave / End game edge-case
- Steps:
  1. Trigger a leave or endGame on a client while a reset is in effect.
  2. Rejoin the room or have other clients remain connected.
- Expected:
  - No stale or duplicated room highs persist incorrectly; UI shows the correct room best according to the newest server or local state.

Scripted / integration tests

- There is a helper script present: `scripts/test-room-highscore.js`
- Example usage (from the project root):
  - Start server: `node server/server.js`
  - Run the script to emit a `room_update` (if the script supports it):
    - `node scripts/test-room-highscore.js` (see script for arguments)
- Observe connected browser clients to verify the zeroed room best appears.

Automated unit test (example using Jest)
- Goal: assert that when `NET` emits `room_update` with `game` set, client code sets `roomHighScoresByGame[gid]` to a zeroed entry with `_serverTs` and calls the UI update.

Example test snippet (concept):
```javascript
// javascript
test('room_update resets room high for new game', () => {
  // Set up globals similar to browser environment
  global.roomHighScoresByGame = {};
  global.updateRoomHighScoreDisplay = jest.fn();
  const gid = 'test-game-123';
  // Simulate NET event handler invocation
  // (Call the same logic that NET.on('room_update') executes in-game)
  const clientId = 'test-client';
  const resetEntry = { name: 'Player', score: 0, game: String(gid), clientId };
  resetEntry._serverTs = Date.now();
  roomHighScoresByGame[String(gid)] = resetEntry;
  // simulate UI update
  updateRoomHighScoreDisplay();
  // Expectations
  expect(roomHighScoresByGame[gid]).toBeDefined();
  expect(roomHighScoresByGame[gid].score).toBe(0);
  expect(roomHighScoresByGame[gid]._serverTs).toBeGreaterThan(0);
  expect(updateRoomHighScoreDisplay).toHaveBeenCalled();
});
```
- Integrate this into whatever test harness you use (Jest/Mocha) and mock any DOM or NET dependencies.

Verification checklist (what to look for)
- UI: "Room Best: <name>: 0" shows instantly on game change.
- Data: `roomHighScoresByGame[gid].score === 0` and `_serverTs` present and recent.
- Replacement: when a later authoritative `room_highscore`/peer_score arrives, it overwrites zero.
- Multi-client: reset is visible to all clients consistently.
- Console: no uncaught exceptions from the room_update handler.

Troubleshooting tips
- If UI does not update: confirm `updateRoomHighScoreDisplay` exists and is reachable; check console for errors.
- If zero is immediately replaced by a stale server value: verify server-sent `room_highscore` includes a timestamp or arrives after the reset; examine timestamp comparison logic.
- If only admin sees the change: confirm all clients received the `room_update` event (network/NET connection).

Expected results summary
- The client now treats `room_update` with a game change as a server-authoritative room-level reset for that game's best: clients should display zero immediately and honor later authoritative updates.

Notes
- The client-side code stamps the reset with `_serverTs = Date.now()` to mark it as server-originated; tests should verify that behavior.
