# WebSocket Protocol Quick Reference

## Connection
```
ws://localhost:8082
```

## Message Flow

```
Client                          Server
  |                               |
  |------ handshake ------------->|
  |<--- handshake_response -------|
  |<----- GAME_STATE (initial) ---|
  |                               |
  |------ input_frame ----------->|  (30-60 Hz)
  |<---- message_ack -------------|
  |<----- GAME_STATE -------------|  (20-30 Hz broadcast)
  |                               |
  |------ ping ------------------>|  (optional, every 30s)
  |<----- pong -------------------|
```

## Messages You Send

### 1. Handshake (First Message)
```json
{
  "type": "handshake",
  "playerName": "YourName"
}
```

### 2. Input Frame (Every Frame)
```json
{
  "type": "input_frame",
  "rotation": 1.5708,
  "movement": {
    "x": 0.707,
    "y": -0.707
  }
}
```

**Rotation**: Radians, where:
- `0` = Right →
- `π/2` ≈ `1.57` = Up ↑
- `π` ≈ `3.14` = Left ←
- `-π/2` ≈ `-1.57` = Down ↓

**Movement**: Normalized vector [-1, 1]:
- `x`: -1 (left/A) to +1 (right/D)
- `y`: -1 (up/W) to +1 (down/S)

### 3. Ping (Optional)
```json
{
  "type": "ping"
}
```

## Messages You Receive

### 1. Handshake Response
```json
{
  "type": "handshake_response",
  "player_id": 1000,
  "status": "connected"
}
```
Save `player_id` for reference!

### 2. Game State (20-30 Hz)
```json
{
  "type": "GAME_STATE",
  "ships": [{
    "id": 1,
    "x": 400, "y": 300,
    "rotation": 0
  }],
  "players": [{
    "id": 1000,
    "world_x": 400, "world_y": 300,
    "rotation": 1.57,
    "parent_ship": 1,
    "local_x": 0, "local_y": 0,
    "state": "WALKING"
  }]
}
```

**Player States**:
- `WALKING` - On ship deck
- `SWIMMING` - In water
- `FALLING` - Airborne

## Code Snippets

### Calculate Rotation (Mouse Aim)
```javascript
const rotation = Math.atan2(
  mouseY - playerY,
  mouseX - playerX
);
```

### Calculate Movement (WASD)
```javascript
let moveX = 0, moveY = 0;
if (keys.w) moveY -= 1;
if (keys.s) moveY += 1;
if (keys.a) moveX -= 1;
if (keys.d) moveX += 1;

// Normalize
const mag = Math.sqrt(moveX*moveX + moveY*moveY);
if (mag > 0) {
  moveX /= mag;
  moveY /= mag;
}
```

### Send Input (Throttled)
```javascript
let lastInputTime = 0;
const INPUT_RATE = 33; // ms (30 Hz)

function update() {
  const now = Date.now();
  if (now - lastInputTime >= INPUT_RATE) {
    ws.send(JSON.stringify({
      type: 'input_frame',
      rotation: rotation,
      movement: { x: moveX, y: moveY }
    }));
    lastInputTime = now;
  }
}
```

## Validation Rules

| Field | Min | Max | Notes |
|-------|-----|-----|-------|
| `movement.x` | -1.0 | 1.0 | Server clamps |
| `movement.y` | -1.0 | 1.0 | Server clamps |
| `rotation` | -π | π | Server clamps (~-3.14 to 3.14) |
| `playerName` | - | 31 chars | Truncated if longer |

## Common Mistakes

❌ **Don't**: Send rotation in degrees  
✅ **Do**: Convert to radians: `deg * Math.PI / 180`

❌ **Don't**: Send unnormalized movement  
✅ **Do**: Normalize: `vec / magnitude`

❌ **Don't**: Send input every frame (60+ Hz)  
✅ **Do**: Throttle to 30-60 Hz

❌ **Don't**: Forget handshake  
✅ **Do**: Send handshake immediately on connect

## Testing Checklist

- [ ] Handshake sent on connection
- [ ] Player ID received and stored
- [ ] Initial game state received
- [ ] Input frames sent at 30 Hz
- [ ] Rotation in radians (not degrees)
- [ ] Movement vector normalized
- [ ] Game state updates processed
- [ ] Player position updated on screen
- [ ] Ship position rendered

## Server Logs to Expect

```
[18:52:51] 🤝 WebSocket handshake from 192.168.1.100:52535 (Player: Alice, ID: 1000)
[18:52:51] 🎮 Sent initial game state to 192.168.1.100:52535
[18:52:52] 🎮 Input frame received from 192.168.1.100:52535 (Player: 1000)
[18:52:52] 📥 Input from player 1000: rotation=1.571, movement=(0.707, -0.707)
[18:52:52] 🎮 Player 1000 at (405.0, 295.0) facing 1.571 rad
```

---

**Full Documentation**: See `docs/WEBSOCKET_CLIENT_PROTOCOL.md`
