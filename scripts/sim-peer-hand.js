/**
 * scripts/sim-peer-hand.js
 * Simple simulation: start two socket.io clients (sender & receiver),
 * create/join a room, sender emits 'hand' payloads with selfie true/false,
 * receiver logs any 'peer_hand' events it receives.
 *
 * Run: node scripts/sim-peer-hand.js
 */
const io = require('socket.io-client');

const SERVER = process.env.SERVER || 'http://localhost:3001';
const ROOM_OPTS = { isPublic: false };

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function run() {
  console.log('SIM: connecting sender and receiver to', SERVER);

  const sender = io(SERVER, { transports: ['websocket'] });
  const receiver = io(SERVER, { transports: ['websocket'] });

  let roomId;

  receiver.on('connect', () => {
    console.log('[receiver] connected', receiver.id);
  });

  sender.on('connect', () => {
    console.log('[sender] connected', sender.id);
  });

  receiver.on('rooms_list', (list) => {
    // ignore
  });
  sender.on('rooms_list', (list) => {
    // ignore
  });

  // Receiver logs any peer_hand events
  receiver.on('peer_hand', (data) => {
    console.log('[receiver] peer_hand received:', JSON.stringify(data, null, 2));
  });

  // cleanup on disconnect
  function finishAndExit(code = 0) {
    try { sender.disconnect(); } catch(e){}
    try { receiver.disconnect(); } catch(e){}
    process.exit(code);
  }

  // 1) Sender creates a room
  await new Promise((resolve) => {
    sender.emit('create_room', ROOM_OPTS, (res) => {
      if (!res || !res.ok) {
        console.error('[sender] failed to create room', res);
        return finishAndExit(2);
      }
      roomId = res.room.id;
      console.log('[sender] created room', roomId);

      // join as sender
      sender.emit('join_room', { roomId, name: 'Sender' }, (jr) => {
        console.log('[sender] join_room ->', jr);
        resolve();
      });
    });
  });

  // 2) Receiver joins the room
  await new Promise((resolve) => {
    receiver.emit('join_room', { roomId, name: 'Receiver' }, (jr) => {
      console.log('[receiver] join_room ->', jr);
      resolve();
    });
  });

  // allow server to propagate join events
  await delay(250);

  // 3) Send a few hand payloads with various selfie flags / shapes
  const testPayloads = [
    { note: 'single-hand quantized, selfie=false', payload: { lm: [[0,0,0],[0.5,0.5,0],[1,1,0]], cw: 640, ch: 480, selfie: false, name: 'Sender' } },
    { note: 'single-hand quantized, selfie=true',  payload: { lm: [[0,0,0],[0.5,0.5,0],[1,1,0]], cw: 640, ch: 480, selfie: true, name: 'Sender' } },
    { note: 'multi-hand, selfie=false',             payload: { lm: [[[0,0,0],[0.1,0.1,0]] , [[0.9,0.9,0],[0.8,0.8,0]]], cw: 320, ch: 240, selfie: false, name: 'Sender' } },
    { note: 'invalid shape (should still be forwarded/stored)', payload: { foo: 'bar', selfie: true, name: 'Sender' } }
  ];

  for (const t of testPayloads) {
    console.log('[sender] sending:', t.note);
    sender.emit('hand', t.payload);
    await delay(300);
  }

  // Wait for receiver to get forwarded events
  await delay(1000);

  console.log('SIM: done, disconnecting');
  finishAndExit(0);
}

run().catch(err => {
  console.error('SIM: error', err);
  process.exit(1);
});
