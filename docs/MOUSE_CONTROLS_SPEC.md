# Player Movement Controls Specification

## Architecture
**Players and Ships are INDEPENDENT entities:**
- **Ships**: Physics-simulated vessels (AI or player-controlled via rudder/sails)
- **Players**: Characters that walk on ship decks (controlled by WASD + mouse)

## Player Movement
- **Rotation**: Player character always faces mouse cursor (for aiming cannons/weapons)
- **Movement**: WASD input moves player relative to ship deck
  - Movement is in ship-local coordinates when standing on ship
  - Movement is in world coordinates when swimming
  - Speed is constant (no directional modifiers for player walking)

## Protocol

### Client → Server: Player Input Frame
```json
{
  "type": "player_input",
  "timestamp": 1763680733614,
  "sequenceId": 123,
  "tick": 3721,
  "rotation": 2.356,  // Radians (where player AIMS - from mouse position)
  "movement": {
    "x": 0.707,       // Normalized WASD (direction player WALKS)
    "y": -0.707       // Magnitude ≤ 1.0
  },
  "actions": 1        // Bitmask: 1=fire_cannon, 2=jump, 4=interact, etc.
}
```

### Client → Server: Ship Control (Optional - if player is captain)
```json
{
  "type": "ship_control",
  "ship_id": 1234,
  "rudder": 0.5,      // -1 to 1 (turn left/right)
  "sails": 0.8        // 0 to 1 (speed control)
}
```

### Server → Client: Game State
```json
{
  "type": "GAME_STATE",
  "tick": 3721,
  "timestamp": 1763680733614,
  "ships": [
    {
      "id": 1,
      "x": 500.0,           // World position
      "y": 300.0,
      "rotation": 1.57,     // Ship facing direction
      "velocity_x": 2.5,
      "velocity_y": 0.0,
      "angular_velocity": 0.1
    }
  ],
  "players": [
    {
      "id": 1000,
      "name": "Player",
      "world_x": 505.0,     // Absolute world position
      "world_y": 302.0,
      "rotation": 2.356,    // Player aim direction (mouse)
      "parent_ship": 1,     // On ship ID 1 (or 0 if swimming)
      "local_x": 5.0,       // Position relative to ship
      "local_y": 2.0,
      "state": "WALKING"    // WALKING, SWIMMING, FALLING
    }
  ],
  "projectiles": []
}
```

## Client-Side Implementation

### Calculating Rotation (from mouse)
```javascript
// Get mouse position in world coordinates
const mouseWorldX = camera.screenToWorld(mouseX);
const mouseWorldY = camera.screenToWorld(mouseY);

// Calculate rotation (where ship faces)
const dx = mouseWorldX - player.x;
const dy = mouseWorldY - player.y;
const rotation = Math.atan2(dy, dx);
```

### Calculating Movement (from WASD)
```javascript
// WASD input (before normalization)
let moveX = 0, moveY = 0;
if (keys['w'] || keys['ArrowUp']) moveY -= 1;
if (keys['s'] || keys['ArrowDown']) moveY += 1;
if (keys['a'] || keys['ArrowLeft']) moveX -= 1;
if (keys['d'] || keys['ArrowRight']) moveX += 1;

// Normalize WASD vector
const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
const movement = {
    x: magnitude > 0.01 ? moveX / magnitude : 0,
    y: magnitude > 0.01 ? moveY / magnitude : 0
};
```

### Sending Input
```javascript
// Send at ~30-60 Hz (throttled)
const inputFrame = {
    type: "input_frame",
    timestamp: Date.now(),
    sequenceId: this.sequenceId++,
    tick: this.estimatedServerTick,
    rotation: rotation,    // Where ship faces (from mouse)
    movement: movement,    // WASD input direction
    actions: this.getActionBitmask()
};

websocket.send(JSON.stringify(inputFrame));
```

## Server-Side Processing

### Movement Update (30 Hz)
```c
void update_player_movement(WebSocketPlayer* player, float rotation, 
                           float movement_x, float movement_y, float dt) {
    const float PLAYER_SPEED = 200.0f;  // Base speed (pixels/sec)
    const float FRICTION = 0.85f;
    
    // Update rotation (from mouse)
    player->rotation = rotation;
    
    // Calculate magnitude of WASD input
    float magnitude = sqrtf(movement_x * movement_x + movement_y * movement_y);
    
    if (magnitude > 0.01f) {
        // Normalize vector (safety check)
        movement_x /= magnitude;
        movement_y /= magnitude;
        
        // Calculate movement direction angle
        float movement_angle = atan2f(movement_y, movement_x);
        
        // Calculate angle difference between facing and movement
        float angle_diff = movement_angle - rotation;
        
        // Normalize angle to [-π, π]
        while (angle_diff > M_PI) angle_diff -= 2 * M_PI;
        while (angle_diff < -M_PI) angle_diff += 2 * M_PI;
        
        // Calculate speed multiplier based on direction
        float speed_multiplier;
        float abs_angle = fabsf(angle_diff);
        
        if (abs_angle < M_PI / 4) {
            // Forward (0° to 45°): 100% speed
            speed_multiplier = 1.0f;
        } else if (abs_angle < 3 * M_PI / 4) {
            // Sideways (45° to 135°): 75% speed
            speed_multiplier = 0.75f;
        } else {
            // Backward (135° to 180°): 50% speed
            speed_multiplier = 0.5f;
        }
        
        // Apply velocity with direction-based speed
        float effective_speed = PLAYER_SPEED * speed_multiplier;
        player->velocity_x = movement_x * effective_speed;
        player->velocity_y = movement_y * effective_speed;
    } else {
        // Apply friction when not moving
        player->velocity_x *= FRICTION;
        player->velocity_y *= FRICTION;
    }
    
    // Update position
    player->x += player->velocity_x * dt;
    player->y += player->velocity_y * dt;
    
    // Bounds checking
    clamp_to_world_bounds(player);
}
```

## Key Behaviors

### 1. **Instant Rotation**
- Ship **immediately** faces the mouse direction
- Rotation is client-calculated and sent to server
- This is arcade-style, not realistic ship physics

### 2. **Directional Speed Modifiers**
| Angle from Facing | Direction | Speed Multiplier |
|-------------------|-----------|------------------|
| 0° - 45° | Forward | 100% (200 px/s) |
| 45° - 135° | Sideways | 75% (150 px/s) |
| 135° - 180° | Backward | 50% (100 px/s) |

### 3. **Movement Physics**
- Base speed: 200 pixels/second
- Friction: 85% velocity retained when input stops
- Normalized WASD input ensures consistent speed

### 4. **Input Validation**
```c
// Server validates:
if (magnitude > 1.5f) {
    reject_input(); // Impossible movement vector
}
if (rotation < -M_PI || rotation > M_PI) {
    reject_input(); // Invalid rotation
}
```

### 4. **World Coordinates**
- Client calculates mouse position in **world space**, not screen space
- Direction vector is world-relative
- Server uses world coordinates for all physics

## Expected Behavior

| Rotation | Movement (WASD) | Speed | Result |
|----------|-----------------|-------|--------|
| 0 rad (→) | (1, 0) right | 100% | Move right at 200 px/s |
| 0 rad (→) | (0, -1) up | 75% | Strafe up at 150 px/s |
| 0 rad (→) | (-1, 0) left | 50% | Reverse left at 100 px/s |
| π/2 rad (↑) | (0, -1) up | 100% | Move forward at 200 px/s |
| π/2 rad (↑) | (1, 0) right | 75% | Strafe right at 150 px/s |
| Any | (0, 0) | 0% | Apply friction, maintain rotation |

## Performance Characteristics

- **Client Input Rate**: 30-60 Hz (throttled)
- **Server Update Rate**: 30 Hz (fixed tick)
- **State Broadcast Rate**: 20-30 Hz (adaptive)
  - 5 Hz: No players
  - 20 Hz: Idle players
  - 30 Hz: Active movement/combat

## Anti-Cheat Considerations

1. **Vector Magnitude**: Must be ≤ 1.0 (with small tolerance)
2. **Rate Limiting**: Max inputs per second enforced
3. **Position Validation**: Server is authoritative
4. **Sequence IDs**: Detect packet replay/injection

## Future Enhancements

- [ ] Smooth rotation (lerp toward mouse over time)
- [ ] Ship momentum and inertia
- [ ] Acceleration curves
- [ ] Water resistance simulation
- [ ] Wind effects
- [ ] Cannon recoil

## Testing

### Unit Test: Normalize Vector
```javascript
const dx = 100, dy = 100;
const dist = Math.sqrt(dx*dx + dy*dy); // 141.42
const normalized = { x: dx/dist, y: dy/dist }; // {x: 0.707, y: 0.707}
console.assert(Math.abs(normalized.x*normalized.x + normalized.y*normalized.y - 1.0) < 0.001);
```

### Integration Test: Movement
1. Client sends movement=(1, 0) at t=0
2. Server updates player at t=33ms
3. Expected: player.x += 200 * 0.033 = 6.6 pixels
4. Expected: player.rotation = 0 radians

---

**Last Updated**: November 20, 2025  
**Server Version**: 1.0  
**Protocol Version**: 1.0
