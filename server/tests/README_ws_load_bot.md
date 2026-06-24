# WebSocket load bot

Headless multi-client stress test for the game server WebSocket path (port 8082).

## Requirements

- Node.js 18+ (native `WebSocket`)
- Running `pirate-server` with `JWT_SECRET` loaded (bots use name-only handshake, no JWT)

## Usage

```bash
# Terminal 1 — server
set -a && source server/config/auth.env && set +a
./server/bin/pirate-server

# Terminal 2 — load bots
node server/tests/ws_load_bot.mjs --clients 8 --duration 120
node server/tests/ws_load_bot.mjs --clients 16 --duration 60 --move-ms 40
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | `ws://127.0.0.1:8082` | WebSocket endpoint |
| `--clients` | `4` | Number of simultaneous bots |
| `--duration` | `60` | Test duration in seconds |
| `--move-ms` | `40` | Movement heartbeat interval (~25 Hz) |

## Output

Prints JSON summary: connected count, total `GAME_STATE` frames received, average payload bytes, errors/disconnects.

Watch server logs for `blob-worker stats`, `send stats`, and `gs payload stats` during the run.
