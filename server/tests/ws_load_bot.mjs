#!/usr/bin/env node
/**
 * WebSocket load bot for pirate-game-4 server stress testing.
 * Uses raw HTTP upgrade + WebSocket frames (compatible with server handshake parser).
 *
 * Usage:
 *   node server/tests/ws_load_bot.mjs --clients 8 --duration 120
 */

import { connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const URL_STR = arg('--url', 'ws://127.0.0.1:8082');
const CLIENTS = Math.max(1, parseInt(arg('--clients', '4'), 10) || 4);
const DURATION_SEC = Math.max(5, parseInt(arg('--duration', '60'), 10) || 60);
const MOVE_INTERVAL_MS = parseInt(arg('--move-ms', '40'), 10) || 40;

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const stats = {
  connected: 0,
  gameStates: 0,
  gameStateBytes: 0,
  errors: 0,
  disconnects: 0,
};

function wsAccept(key) {
  return createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  const hdr = len < 126
    ? Buffer.from([0x81, 0x80 | len])
    : Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([hdr, mask, masked]);
}

function decodeFrames(buffer) {
  const messages = [];
  let off = 0;
  while (off + 2 <= buffer.length) {
    const b0 = buffer[off];
    const b1 = buffer[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (pos + 2 > buffer.length) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buffer.length) break;
    let payload = buffer.subarray(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const mask = buffer.subarray(pos, pos + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    if (opcode === 0x1) messages.push(payload.toString('utf8'));
    off = pos + maskLen + len;
  }
  return { messages, rest: buffer.subarray(off) };
}

function wsConnect(urlStr) {
  const u = new URL(urlStr);
  const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  const key = randomBytes(16).toString('base64');
  const req = [
    `GET ${u.pathname || '/'} HTTP/1.1`,
    `Host: ${u.hostname}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const sock = connect(port, u.hostname);
    let buf = Buffer.alloc(0);
    let settled = false;

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!settled) {
        const hdrEnd = buf.indexOf('\r\n\r\n');
        if (hdrEnd < 0) return;
        const hdr = buf.subarray(0, hdrEnd).toString('utf8');
        if (!hdr.includes('101') || !hdr.includes('Sec-WebSocket-Accept')) {
          settled = true;
          reject(new Error('WebSocket upgrade failed'));
          sock.destroy();
          return;
        }
        const accept = hdr.match(/Sec-WebSocket-Accept:\s*(.+)/i)?.[1]?.trim();
        if (accept !== wsAccept(key)) {
          settled = true;
          reject(new Error('Bad Sec-WebSocket-Accept'));
          sock.destroy();
          return;
        }
        settled = true;
        const rest = buf.subarray(hdrEnd + 4);
        resolve({ sock, send: (s) => sock.write(encodeTextFrame(s)), initial: rest });
      }
    });

    sock.on('error', reject);
    sock.write(req);
  });
}

function randDir() {
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

async function connectBot(index) {
  let conn;
  try {
    conn = await wsConnect(URL_STR);
  } catch (e) {
    stats.errors++;
    return null;
  }

  const { sock, send, initial } = conn;
  let buf = initial && initial.length ? initial : Buffer.alloc(0);
  let playerId = 0;
  let moveTimer = null;
  let inputTimer = null;
  let dir = randDir();

  const cleanup = () => {
    if (moveTimer) clearInterval(moveTimer);
    if (inputTimer) clearInterval(inputTimer);
  };

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = decodeFrames(buf);
    buf = rest;
    for (const raw of messages) {
      if (raw.includes('"type":"GAME_STATE"') || raw.startsWith('GAME_STATE:')) {
        stats.gameStates++;
        stats.gameStateBytes += raw.length;
        continue;
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }

      if ((msg.type === 'handshake_response' || msg.type === 'ack') && msg.player_id && !playerId) {
        playerId = msg.player_id;
        stats.connected++;
        moveTimer = setInterval(() => {
          if (Math.random() < 0.05) dir = randDir();
          send(JSON.stringify({
            type: 'movement_state',
            direction_x: dir.x,
            direction_y: dir.y,
            is_moving: true,
            is_sprinting: false,
            view_radius: 3500 + Math.floor(Math.random() * 1500),
          }));
        }, MOVE_INTERVAL_MS);
        inputTimer = setInterval(() => {
          send(JSON.stringify({
            type: 'input_frame',
            tick: Date.now(),
            rotation: Math.random() * Math.PI * 2,
            movement_x: dir.x,
            movement_y: dir.y,
            view_radius: 4000,
          }));
        }, 100);
      }
    }
  });

  sock.on('close', () => { stats.disconnects++; cleanup(); });
  sock.on('error', () => { stats.errors++; cleanup(); });

  send(JSON.stringify({
    type: 'handshake',
    name: `LoadBot${index}`,
    client_version: 'ws_load_bot/1.0',
  }));

  setTimeout(() => {
    cleanup();
    sock.destroy();
  }, DURATION_SEC * 1000);

  return sock;
}

async function main() {
  console.log(`ws_load_bot: ${CLIENTS} clients → ${URL_STR} for ${DURATION_SEC}s`);
  const t0 = Date.now();
  for (let i = 0; i < CLIENTS; i++) {
    connectBot(i + 1);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000 + 1000));
  const elapsed = (Date.now() - t0) / 1000;
  const avgGs = stats.gameStates > 0 ? Math.round(stats.gameStateBytes / stats.gameStates) : 0;
  console.log(JSON.stringify({
    clients: CLIENTS,
    durationSec: elapsed,
    connected: stats.connected,
    gameStates: stats.gameStates,
    avgGameStateBytes: avgGs,
    errors: stats.errors,
    disconnects: stats.disconnects,
  }, null, 2));
  if (stats.connected === 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
