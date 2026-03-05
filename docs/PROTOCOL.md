# Pirate Game — Protocol Reference

Single reference for all client-server communication.

---

## Connection

| Port | Protocol | Purpose |
|------|----------|---------|
| 8082 | WebSocket (TCP) | Browser game clients |
| 8080 | UDP | Native clients |
| 8081 | HTTP | Admin panel dashboard |

**WebSocket endpoint**: `ws://localhost:8082` (or `wss://` behind nginx SSL proxy)

### Connection Flow

```
Client                          Server
  |                               |
  |------ handshake ------------->|  (first message after connect)
  |<--- handshake_response -------|
  |<----- GAME_STATE (initial) ---|
  |                               |
  |------ input_frame ----------->|  (30–60 Hz)
  |<---- message_ack -------------|
  |<----- GAME_STATE -------------|  (20–30 Hz broadcast to all)
  |                               |
  |------ cannon_aim ------------>|  (right-click held)
  |------ cannon_fire ----------->|  (left-click)
  |<--- CANNON_FIRE_EVENT --------|
  |                               |
  |------ ping ------------------>|  (every ~30s)
  |<----- pong -------------------|
```

---

## Client → Server Messages

### `handshake` — First message after connection

```json
{
  "type": "handshake",
  "playerName": "YourName",
  "protocolVersion": 1,
  "timestamp": 1763680733614
}
```

**Response (success)**:
```json
{
  "type": "handshake_response",
  "player_id": 1000,
  "playerName": "YourName",
  "server_time": 1763680733614,
  "status": "connected"
}
```
Server immediately follows with an initial `GAME_STATE`.

---

### `input_frame` — Player movement (30–60 Hz)

```json
{
  "type": "input_frame",
  "timestamp": 1763680733614,
  "sequenceId": 123,
  "rotation": 1.5708,
  "movement": { "x": 0.707, "y": -0.707 },
  "actions": 0
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `rotation` | Yes | Player aim direction in radians. 0 = right, π/2 = up, ±π = left |
| `movement.x` | Yes | -1 (A) to +1 (D), should be normalized |
| `movement.y` | Yes | -1 (W) to +1 (S), should be normalized |
| `timestamp`, `sequenceId` | No | Not validated server-side |

**Response**: `{ "type": "message_ack", "status": "input_received" }`

---

### `ship_control` — Ship steering (while mounted at helm)

```json
{ "type": "ship_control", "control": "rudder", "value": 0.5 }
{ "type": "ship_control", "control": "sail", "value": 0.8 }
{ "type": "ship_control", "control": "sail_angle", "value": 45.0 }
```

| Control | Range | Effect |
|---------|-------|--------|
| `rudder` | -1.0 to +1.0 | Turn rate (-1 = hard port, +1 = hard starboard) |
| `sail` | 0.0 to 1.0 | Sail openness (0 = furled, 1 = full open) |
| `sail_angle` | -90° to +90° | Mast rotation in degrees |

---

### `cannon_aim` — Aim cannons (right-click held)

```json
{
  "type": "cannon_aim",
  "timestamp": 1732637892341,
  "aim_angle": 0.524
}
```

`aim_angle` is **ship-relative** (already `worldAngle - shipRotation`). Normalized to [-π, π].  
Throttled client-side to changes > 1°.  
Server stores this as `player->cannon_aim_angle_relative` — does **not** subtract ship rotation again.

---

### `cannon_fire` — Fire cannons (left-click / double-click)

```json
{ "type": "cannon_fire", "fire_all": false }
{ "type": "cannon_fire", "fire_all": true }
```

| `fire_all` | Trigger | Behaviour |
|-----------|---------|-----------|
| `false` | Single click | Fire cannons within ±20° of current aim angle |
| `true` | Double-click (< 300ms) | Fire all cannons regardless of aim |

---

### `module_interact` — Interact with a ship module (E key or click)

```json
{
  "type": "module_interact",
  "module_id": 1001,
  "ship_id": 1
}
```

Used to mount helm, sit in seats, use ladders, etc.

---

### `ping` — Keep-alive

```json
{ "type": "ping" }
```

**Response**: `{ "type": "pong", "server_time": 1763680733614 }`

---

## Server → Client Messages

### `GAME_STATE` — World snapshot (20–30 Hz broadcast)

```json
{
  "type": "GAME_STATE",
  "tick": 3721,
  "timestamp": 1763680733614,
  "ships": [
    {
      "id": 1,
      "x": 400.0,
      "y": 300.0,
      "rotation": 0.0,
      "velocity_x": 2.5,
      "velocity_y": 0.0,
      "angular_velocity": 0.0,
      "modules": [
        {
          "id": 1001,
          "typeId": 2,
          "x": 60.0,
          "y": -30.0,
          "rotation": -1.5708,
          "moduleData": {
            "kind": "cannon",
            "aimDirection": 0.0,
            "ammunition": 10,
            "timeSinceLastFire": 5000
          }
        }
      ]
    }
  ],
  "players": [
    {
      "id": 1000,
      "name": "Player_1000",
      "world_x": 400.0,
      "world_y": 300.0,
      "rotation": 1.571,
      "parent_ship": 1,
      "local_x": 0.0,
      "local_y": 0.0,
      "state": "WALKING",
      "carrierId": 1
    }
  ],
  "projectiles": [
    {
      "id": 5001,
      "x": 450.0,
      "y": 300.0,
      "velocity_x": 500.0,
      "velocity_y": 0.0
    }
  ]
}
```

**Player `state` values**: `WALKING` | `SWIMMING` | `FALLING`

**Module `typeId` values**:

| typeId | Kind | Description |
|--------|------|-------------|
| 0 | `helm` | Steering wheel |
| 1 | `seat` | Crew seating |
| 2 | `cannon` | Offensive weapon |
| 3 | `mast` | Sail system |
| 4 | `steering-wheel` | Alternative helm |
| 5 | `ladder` | Boarding ladder |
| 6 | `plank` | Hull segment |
| 7 | `deck` | Floor surface |
| 255 | `custom` | User-defined |

---

### `CANNON_FIRE_EVENT` — A cannon fired

```json
{
  "type": "CANNON_FIRE_EVENT",
  "cannonId": 1001,
  "shipId": 1,
  "x": 430.0,
  "y": 295.0,
  "angle": 0.0,
  "projectileId": 5001
}
```

---

## Data Types

### Coordinate system

- All positions in **client pixels** on the wire
- Server stores internally in server units (1 server unit = 10 client pixels via `WORLD_SCALE_FACTOR`)
- `SERVER_TO_CLIENT(v) = v * 10`, `CLIENT_TO_SERVER(v) = v / 10`
- Q16.16 fixed-point used internally; converted to float before JSON serialisation

### Local ↔ World transform

```
world_x = ship.x + local_x * cos(θ) - local_y * sin(θ)
world_y = ship.y + local_x * sin(θ) + local_y * cos(θ)

local_x = (world_x - ship.x) *  cos(θ) + (world_y - ship.y) * sin(θ)
local_y = (world_x - ship.x) * -sin(θ) + (world_y - ship.y) * cos(θ)
```

### Module rendering pattern (client)

```typescript
ctx.save();
ctx.translate(ship.x, ship.y);
ctx.rotate(ship.rotation);

for (const module of ship.modules) {
  ctx.save();
  ctx.translate(module.x, module.y);
  ctx.rotate(module.rotation);
  renderModule(module);
  ctx.restore();
}

ctx.restore();
```

---

## Module Sync Strategy

### Initial sync (full state)
On connect the server sends all modules inside the first `GAME_STATE`. Includes static position/rotation and dynamic `moduleData`.

### Delta updates (ongoing)
Only changed `moduleData` fields are updated in subsequent `GAME_STATE` broadcasts.

**High-frequency properties** (send every frame or batched every 2–3 frames):
- `cannon.aimDirection`
- `mast.angle`

**Low-frequency properties** (send on change):
- `cannon.ammunition`
- `cannon.timeSinceLastFire`

---

## Legacy UDP Packet Structure

Used by native clients on port 8080 (not required for browser clients):

```c
struct GamePacket {
    uint32_t magic;        // 0x50495241 ('PIRA')
    uint16_t version;      // Protocol version (1)
    uint16_t type;         // Message type
    uint32_t sequence;     // Sequence number
    uint32_t timestamp;    // Client timestamp (ms)
    uint16_t payload_size;
    uint8_t  checksum;
    uint8_t  flags;
    // Payload follows...
};
```

Quantization: position 1/512m, velocity 1/256 m/s, rotation 1/1024 rad.

---

## See Also

- [docs/SSL_SETUP.md](SSL_SETUP.md) — WSS setup via nginx
- [docs/TESTING_GUIDE.md](TESTING_GUIDE.md) — Testing commands
- [server/PORTS.md](../server/PORTS.md) — Port overview
- [protocol/ship_definitions.h](../protocol/ship_definitions.h) — Shared C ship constants
