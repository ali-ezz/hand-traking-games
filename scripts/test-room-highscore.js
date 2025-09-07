/*
Utility to test room high-score timestamp heuristics in the running game page.

Usage (in browser console on the game page):
1) Paste the entire file contents into the console (or include this file in the page).
2) Run: runRoomHighscoreTest()  — runs two scenarios and logs expected vs actual UI state.
3) Or call individual helpers:
     doLocalReset(gid)
     simulateServerHigh(gid, score, name, serverAgeMs)
     inspectRoomHigh(gid)

Notes:
- serverAgeMs is how old the server publish appears (ms). Positive -> older than now, negative -> future/newer.
- gid defaults to currentGameId || 'default'.
*/

(function () {
  // Ensure globals exist
  if (typeof window === 'undefined') return;
  window.__testRoomHighscore = window.__testRoomHighscore || {};

  function now() { return Date.now(); }

  function inspectRoomHigh(gid) {
    gid = gid || (window.currentGameId || 'default');
    const rh = (window.roomHighScoresByGame && window.roomHighScoresByGame[gid]) ? window.roomHighScoresByGame[gid] : null;
    const localReset = (window.roomHighScoreResetTimestamps && window.roomHighScoreResetTimestamps[gid]) ? window.roomHighScoreResetTimestamps[gid] : null;
    console.log('inspectRoomHigh:', { gid, roomHighEntry: rh, roomHighScoreResetTimestamps: localReset, roomHighScoreElem: (document.getElementById('roomHighScore') || null) });
    try {
      if (typeof window.updateRoomHighScoreDisplay === 'function') window.updateRoomHighScoreDisplay();
      console.log('DOM roomHighScore.textContent ->', (document.getElementById('roomHighScore') || { textContent: null }).textContent);
    } catch(e) { console.warn('updateRoomHighScoreDisplay error', e); }
  }

  // Simulate a server-provided room high; serverAgeMs: positive -> published in past by that ms
  function simulateServerHigh(gid, score, name, serverAgeMs) {
    gid = gid || (window.currentGameId || 'default');
    serverAgeMs = (typeof serverAgeMs === 'number') ? serverAgeMs : 0;
    const serverTs = Date.now() - serverAgeMs;
    const entry = { name: String(name || 'Server'), score: Number(score || 0), game: gid };
    // attach _serverTs like real handler does
    entry._serverTs = serverTs;
    // store shallow copy
    try {
      window.roomHighScoresByGame = window.roomHighScoresByGame || {};
      window.roomHighScoresByGame[gid] = Object.assign({}, entry);
      console.log(`simulateServerHigh -> gid=${gid}, score=${entry.score}, name=${entry.name}, _serverTs=${entry._serverTs} (age=${serverAgeMs}ms)`);
      if (typeof window.updateRoomHighScoreDisplay === 'function') window.updateRoomHighScoreDisplay();
      console.log('After server update DOM ->', (document.getElementById('roomHighScore') || { textContent: null }).textContent);
    } catch (e) {
      console.error('simulateServerHigh failed', e);
    }
  }

  // Perform a local reset (mimics cleanupAfterLeave / endGame behavior)
  function doLocalReset(gid) {
    gid = gid || (window.currentGameId || 'default');
    try {
      const clientId = (function() { try { return localStorage.getItem('hand_ninja_client_id'); } catch(e) { return null; } })();
      const localName = (window.playerNameEl && (window.playerNameEl.value || window.playerNameEl.placeholder)) ? (window.playerNameEl.value || window.playerNameEl.placeholder) : 'Player';
      window.roomHighScoresByGame = window.roomHighScoresByGame || {};
      window.roomHighScoresByGame[gid] = { name: String(localName).slice(0,24), score: 0, game: gid, clientId: clientId || null };
      window.roomHighScoreResetTimestamps = window.roomHighScoreResetTimestamps || {};
      window.roomHighScoreResetTimestamps[gid] = Date.now();
      console.log(`doLocalReset -> gid=${gid}, name=${localName}, ts=${window.roomHighScoreResetTimestamps[gid]}`);
      if (typeof window.updateRoomHighScoreDisplay === 'function') window.updateRoomHighScoreDisplay();
      console.log('After local reset DOM ->', (document.getElementById('roomHighScore') || { textContent: null }).textContent);
    } catch (e) {
      console.error('doLocalReset failed', e);
    }
  }

  // Test runner: two quick scenarios
  async function runRoomHighscoreTest() {
    const gid = window.currentGameId || 'default';
    console.log('Running room-highscore timestamp heuristics test for gid=', gid);
    // Scenario 1: local reset newer than server (server old) -> expect local zero preserved
    console.log('Scenario 1: local reset newer than server (expect local zeroed entry to WIN)');
    doLocalReset(gid);
    // simulate server value published 7s in the past (older than local reset)
    await new Promise(r => setTimeout(r, 300)); // slight gap so timestamps differ
    simulateServerHigh(gid, 123, 'Alice', 7000);
    inspectRoomHigh(gid);

    // Scenario 2: server sends a newer publish (server more recent) -> expect server high to override
    console.log('Scenario 2: server publishes NEWER than local reset (expect server value to WIN)');
    doLocalReset(gid);
    // simulate server with negative age (i.e. server_ts in the future by 4s => newer)
    await new Promise(r => setTimeout(r, 300));
    simulateServerHigh(gid, 456, 'Bob', -4000);
    inspectRoomHigh(gid);

    console.log('Test complete. Use inspectRoomHigh(gid) to re-check state, or re-run scenarios manually.');
  }

  // Export helpers
  window.__testRoomHighscore.inspectRoomHigh = inspectRoomHigh;
  window.__testRoomHighscore.doLocalReset = doLocalReset;
  window.__testRoomHighscore.simulateServerHigh = simulateServerHigh;
  window.__testRoomHighscore.runRoomHighscoreTest = runRoomHighscoreTest;

  // Friendly console hint
  console.info('Room high-score test helpers installed: run window.__testRoomHighscore.runRoomHighscoreTest()');
})();
