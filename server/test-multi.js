const io = require('socket.io-client');

const SERVER = process.env.SERVER || 'http://localhost:3000';
function makeClient(name) {
  const sock = io(SERVER, { transports: ['websocket', 'polling'] });
  sock._name = name;
  sock.on('connect', () => console.log(`[${name}] connected ${sock.id}`));
  sock.on('disconnect', () => console.log(`[${name}] disconnected`));
  sock.on('rooms_list', (list) => console.log(`[${name}] rooms_list`, list));
  sock.on('room_update', (r) => console.log(`[${name}] room_update`, r));
  sock.on('game_start', (data) => {
    console.log(`[${name}] game_start`, { items: (data.items || []).length, seed: data.seed, startTs: data.startTs || data.startTs });
    sock._lastGameStart = data;
  });
  sock.on('game_begin', (data) => {
    console.log(`[${name}] game_begin`, data);
    sock._gameBegin = data;
  });
  sock.on('object_state', (s) => console.log(`[${name}] object_state`, s));
  sock.on('peer_score', (s) => console.log(`[${name}] peer_score`, s));
  sock.on('peer_join', p => console.log(`[${name}] peer_join`, p));
  sock.on('peer_leave', p => console.log(`[${name}] peer_leave`, p));
  return sock;
}

(async function run() {
  console.log('TEST: starting two simulated clients (admin + player)');
  const admin = makeClient('admin');
  const player = makeClient('player');

  // wait for both to connect
  await new Promise(resolve => setTimeout(resolve, 500));

  // admin creates a room
  admin.emit('create_room', { isPublic: false }, (res) => {
    console.log('[admin] create_room ->', res);
    const roomId = res && res.room && res.room.id;
    if (!roomId) {
      console.error('[admin] failed to create room');
      process.exit(1);
    }

    // admin joins
    admin.emit('join_room', { roomId, name: 'Admin' }, (jr) => {
      console.log('[admin] join_room ->', jr);

      // player joins
      player.emit('join_room', { roomId, name: 'Player' }, (jr2) => {
        console.log('[player] join_room ->', jr2);

        // Give sockets a moment to settle
        setTimeout(() => {
          // admin starts room game
          console.log('[admin] starting game (forcePlayAll=false)');
          admin.emit('start_room_game', { game: 'fruit', timeLimit: 20, forcePlayAll: false }, (startRes) => {
            console.log('[admin] start_room_game ->', startRes);
          });
        }, 300);
      });
    });
  });

  // After we receive game_start, trigger an interaction from admin on first item
  admin.on('game_start', (data) => {
    // pick first item from game_start.items if present
    const items = data && data.items;
    if (!items || !items.length) {
      console.warn('[admin] no items in game_start to interact with');
      return;
    }
    const item = items[0];
    console.log('[admin] scheduling interaction on item', item.id);
    // wait briefly then send authoritative interaction with normalized coords
    setTimeout(() => {
      const payload = { objectId: item.id, x: item.x, y: item.y };
      console.log('[admin] sending interaction ->', payload);
      admin.emit('interaction', payload, (ack) => {
        console.log('[admin] interaction ack ->', ack);
      });
    }, 1000);
  });

  // Player will also attempt to slice the same item slightly later to test already_removed path
  player.on('game_start', (data) => {
    const items = data && data.items;
    if (!items || !items.length) return;
    const item = items[0];
    setTimeout(() => {
      const payload = { objectId: item.id, x: item.x, y: item.y };
      console.log('[player] sending interaction ->', payload);
      player.emit('interaction', payload, (ack) => {
        console.log('[player] interaction ack ->', ack);
      });
    }, 1500);
  });

  // Exit after 6 seconds
  setTimeout(() => {
    console.log('TEST: finished, disconnecting clients');
    try { admin.disconnect(); } catch(e) {}
    try { player.disconnect(); } catch(e) {}
    process.exit(0);
  }, 6000);
})();
