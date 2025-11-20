# WebSocket Client Protocol Reference

## Server Connection
- **Host**: `ws://localhost:8082` (or your server IP)
- **Protocol**: WebSocket (RFC 6455)
- **Message Format**: JSON text frames

---

## Message Types (Client → Server)

### 1. Handshake (Connection Initialization)

**Purpose**: Initialize connection and create player  
**When**: Immediately after WebSocket connection opens  
**Required**: Yes - must be first message

**Format**:
```json
{
  "type": "handshake",
  "playerName": "YourName",
  "protocolVersion": 1,
  "timestamp": 1763680733614
}
```

**Fields**:
- `type`: **Required** - Must be `"handshake"`
- `playerName`: **Optional** - Player display name (default: "Player")
  - Max length: 31 characters
  - Server extracts using: `"playerName":"value"`
- `protocolVersion`: **Optional** - Not currently validated
- `timestamp`: **Optional** - Not currently used

**Server Response** (Success):
```json
{
  "type": "handshake_response",
  "player_id": 1000,
  "playerName": "YourName",
  "server_time": 1763680733614,
  "status": "connected"
}
```

**Server Response** (Reconnect):
```json
{
  "type": "handshake_response",
  "player_id": 1000,
  "playerName": "YourName",
  "server_time": 1763680733614,
  "status": "reconnected"
}
```

**Server Response** (Error - Server Full):
```json
{
  "type": "handshake_response",
  "status": "error",
  "message": "Server full"
}
```

**After Handshake**:
Server automatically sends initial game state:
```json
{
  "type": "GAME_STATE",
  "tick": 123,
  "timestamp": 1763680733614,
  "ships": [
    {
      "id": 1,
      "x": 400.0,
      "y": 300.0,
      "rotation": 0.0,
      "velocity_x": 0.0,
      "velocity_y": 0.0
    }
  ],
  "players": [
    {
      "id": 1000,
      "name": "Player",
      "world_x": 400.0,
      "world_y": 300.0,
      "rotation": 0.0,
      "parent_ship": 1,
      "local_x": 0.0,
      "local_y": 0.0,
      "state": "WALKING"
    }
  ],
  "projectiles": []
}
```

---

### 2. Input Frame (Player Movement & Actions)

**Purpose**: Send player input (WASD movement + mouse rotation + actions)  
**When**: Every frame or throttled to 30-60 Hz  
**Required**: No, but needed for movement

**Format**:
```json
{
  "type": "input_frame",
  "timestamp": 1763680733614,
  "sequenceId": 123,
  "tick": 3721,
  "rotation": 1.5708,
  "movement": {
    "x": 0.707,
    "y": -0.707
  },
  "actions": 0
}
```

**Fields**:
- `type`: **Required** - Must be `"input_frame"`
- `rotation`: **Required** - Player aim direction in radians
  - Range: [-π, π] (approximately -3.14159 to 3.14159)
  - 0 = facing right/east
  - π/2 = facing up/north
  - π or -π = facing left/west
  - -π/2 = facing down/south
  - Server clamps to [-π, π]
  
- `movement`: **Required** - WASD movement vector
  - `x`: Horizontal movement (-1 to 1)
    - -1 = left (A key)
    - +1 = right (D key)
  - `y`: Vertical movement (-1 to 1)
    - -1 = up (W key)
    - +1 = down (S key)
  - **Should be normalized** (magnitude ≤ 1.0)
  - Server clamps each component to [-1, 1]
  
- `timestamp`: **Optional** - Client timestamp (milliseconds)
- `sequenceId`: **Optional** - Packet sequence number (not validated)
- `tick`: **Optional** - Client's estimated server tick (not validated)
- `actions`: **Optional** - Bitmask for actions (not yet implemented)

**Server Response**:
```json
{
  "type": "message_ack",
  "status": "input_received"
}
```

**Error Responses**:
```json
{
  "type": "message_ack",
  "status": "no_player"
}
```
```json
{
  "type": "message_ack",
  "status": "player_not_found"
}
```

**Server Log Output** (when received):
```
[18:52:51] 🎮 Input frame received from 192.168.56.1:52535 (Player: 1000)
[18:52:51] 🔍 Raw input_frame payload: {"type":"input_frame",...}
[18:52:51] 📥 Input from player 1000: rotation=1.571, movement=(0.707, -0.707)
[18:52:51] 🎮 Player 1000 at (405.0, 295.0) facing 1.571 rad
```

---

### 3. Ping (Keep-Alive)

**Purpose**: Keep connection alive and measure latency  
**When**: Periodically (recommended: every 30 seconds)  
**Required**: No

**Format**:
```json
{
  "type": "ping"
}
```

**Fields**:
- `type`: **Required** - Must be `"ping"`

**Server Response**:
```json
{
  "type": "pong",
  "timestamp": 1763680733614,
  "server_time": 1763680733614
}
```

---

## Message Types (Server → Client)

### 1. GAME_STATE (Periodic Updates)

**Purpose**: Broadcast current world state to all clients  
**Frequency**: 20-30 Hz (adaptive based on activity)  
**Automatic**: Yes - sent periodically without request

**Format**:
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
      "velocity_x": 0.0,
      "velocity_y": 0.0,
      "angular_velocity": 0.0
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
      "state": "WALKING"
    }
  ],
  "projectiles": []
}
```

**Fields**:

**Top Level**:
- `type`: Always `"GAME_STATE"`
- `tick`: Server tick number (approximate)
- `timestamp`: Server time (milliseconds since epoch)

**Ships Array**:
- `id`: Unique ship identifier
- `x`, `y`: World position (pixels or meters)
- `rotation`: Ship facing direction (radians)
- `velocity_x`, `velocity_y`: Ship velocity (m/s)
- `angular_velocity`: Ship rotation speed (rad/s)

**Players Array**:
- `id`: Unique player identifier
- `name`: Player name (from handshake)
- `world_x`, `world_y`: Player's absolute world position
- `rotation`: Player's aim direction (radians)
- `parent_ship`: ID of ship player is on (0 = in water)
- `local_x`, `local_y`: Position relative to ship center
- `state`: Movement state
  - `"WALKING"` - On ship deck
  - `"SWIMMING"` - In water
  - `"FALLING"` - Airborne (not yet implemented)

**Projectiles Array**:
- Currently always empty `[]`

**Update Rate**:
- **5 Hz** - No players connected
- **20 Hz** - Players idle (no movement for 2+ seconds)
- **25 Hz** - Single player moving
- **30 Hz** - Multiple players active

---

## Parsing Requirements

### Client Must Parse

1. **JSON Strings**: All messages are JSON text
2. **Number Formats**: Floats may have 1-3 decimal places
3. **Array Iteration**: Ships and players arrays are variable length
4. **State Strings**: Movement state is a string enum

### Server Uses Simple Parsing

**⚠️ Important**: Server uses `strstr()` and `sscanf()` for parsing, not a JSON library.

**What this means**:
- Field order doesn't matter
- Extra fields are ignored
- Whitespace doesn't matter
- Missing optional fields default to 0

**Example - All Valid**:
```json
{"type":"handshake","playerName":"Alice"}
```
```json
{
  "type": "handshake",
  "playerName": "Alice",
  "extra_field": "ignored"
}
```
```json
{"playerName":"Alice","type":"handshake"}
```

---

## Example Client Implementation

### JavaScript/TypeScript

```javascript
class PirateGameClient {
  constructor(serverUrl = 'ws://localhost:8082') {
    this.ws = new WebSocket(serverUrl);
    this.playerId = null;
    this.sequenceId = 0;
    
    this.ws.onopen = () => this.sendHandshake();
    this.ws.onmessage = (event) => this.handleMessage(event.data);
    this.ws.onerror = (error) => console.error('WebSocket error:', error);
    this.ws.onclose = () => console.log('WebSocket closed');
  }
  
  sendHandshake(playerName = 'Player') {
    const message = {
      type: 'handshake',
      playerName: playerName,
      protocolVersion: 1,
      timestamp: Date.now()
    };
    this.ws.send(JSON.stringify(message));
  }
  
  sendInput(rotation, movementX, movementY) {
    // Normalize movement vector
    const magnitude = Math.sqrt(movementX * movementX + movementY * movementY);
    if (magnitude > 1.0) {
      movementX /= magnitude;
      movementY /= magnitude;
    }
    
    const message = {
      type: 'input_frame',
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
      tick: Math.floor(Date.now() / 33), // Approximate
      rotation: rotation, // In radians
      movement: {
        x: movementX,
        y: movementY
      },
      actions: 0
    };
    this.ws.send(JSON.stringify(message));
  }
  
  handleMessage(data) {
    const message = JSON.parse(data);
    
    switch (message.type) {
      case 'handshake_response':
        console.log('Connected! Player ID:', message.player_id);
        this.playerId = message.player_id;
        break;
        
      case 'GAME_STATE':
        this.updateGameState(message);
        break;
        
      case 'pong':
        const latency = Date.now() - message.timestamp;
        console.log('Latency:', latency, 'ms');
        break;
        
      case 'message_ack':
        // Input acknowledged
        break;
    }
  }
  
  updateGameState(state) {
    // Update ships
    state.ships.forEach(ship => {
      console.log(`Ship ${ship.id} at (${ship.x}, ${ship.y})`);
    });
    
    // Update players
    state.players.forEach(player => {
      if (player.id === this.playerId) {
        console.log(`You are at (${player.world_x}, ${player.world_y}) on ship ${player.parent_ship}`);
      }
    });
  }
}

// Usage
const client = new PirateGameClient();

// Send input every frame (throttled to 30 Hz recommended)
setInterval(() => {
  const rotation = Math.atan2(mouseY - playerY, mouseX - playerX);
  const moveX = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  const moveY = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
  
  client.sendInput(rotation, moveX, moveY);
}, 33); // ~30 Hz
```

---

## Validation & Constraints

### Server-Side Validation

**Movement Vector**:
- Each component clamped to [-1.0, 1.0]
- Magnitude should be ≤ 1.0 (client responsibility to normalize)

**Rotation**:
- Clamped to [-π, π]
- Must be in radians

**Player Name**:
- Max 31 characters
- Defaults to "Player" if not provided

**Delta Time**:
- Capped at 0.1 seconds (100ms) to prevent large jumps
- Falls back to 0.033s if excessive

### Client-Side Best Practices

1. **Normalize Movement Vectors**: Ensure magnitude ≤ 1.0
2. **Use Radians**: All angles in radians, not degrees
3. **Throttle Input**: Send at most 60 Hz (33-50 Hz recommended)
4. **Handle Disconnects**: Implement reconnection logic
5. **Parse Defensively**: Check for null/undefined fields

---

## Common Issues & Solutions

### Issue: Player Not Moving
**Cause**: Sending movement in degrees instead of radians  
**Solution**: Convert rotation to radians: `rotation = degrees * Math.PI / 180`

### Issue: Player Moving Too Fast
**Cause**: Movement vector not normalized  
**Solution**: Normalize before sending: `magnitude = sqrt(x² + y²); x /= magnitude; y /= magnitude;`

### Issue: Connection Drops
**Cause**: No activity for extended period  
**Solution**: Send ping messages every 30 seconds

### Issue: Player Spawns at Wrong Position
**Cause**: Expecting initial position before game state  
**Solution**: Wait for first `GAME_STATE` message after handshake

---

## Protocol Version: 1.0
**Last Updated**: November 20, 2024  
**Server**: pirate-server v1.0  
**Port**: 8082 (WebSocket)
