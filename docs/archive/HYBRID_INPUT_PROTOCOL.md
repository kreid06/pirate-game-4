# Hybrid Input Protocol Specification

## Overview
The hybrid input protocol combines state-based movement, delta-based rotation, and event-based actions to achieve optimal bandwidth efficiency while maintaining responsiveness.

## Message Types

### 1. Movement State Message
**Purpose**: Set player movement direction (sent on state change only)

```json
{
  "type": "movement_state",
  "timestamp": 1234567890,
  "movement": {
    "x": 0.0,  // -1.0 to 1.0 (normalized direction)
    "y": 0.0   // -1.0 to 1.0 (normalized direction)
  },
  "is_moving": false  // true if any movement, false if stopped
}
```

**Sending Rules**:
- Send when W/A/S/D pressed or released
- Send when movement direction changes (diagonal transitions)
- Do NOT send on every frame
- Client maintains local movement state

**Server Behavior**:
- Store movement direction in player state
- Apply movement every server tick (30Hz)
- Continue applying until new state received
- Clear state on disconnect

**Bandwidth**: ~2-5 messages/second (vs 30 messages/second)

---

### 2. Rotation Update Message
**Purpose**: Update player aim direction (sent on significant change only)

```json
{
  "type": "rotation_update",
  "timestamp": 1234567890,
  "rotation": 1.5708  // Radians (-π to π)
}
```

**Sending Rules**:
- Send when rotation changes by >0.0524 radians (3 degrees)
- Track `last_sent_rotation` on client
- Calculate delta: `abs(current - last_sent)`
- Smoothly interpolate on server between updates

**Server Behavior**:
- Store rotation in player state
- Interpolate rotation if needed for smooth aiming
- Use for projectile direction, player orientation

**Bandwidth**: ~5-20 messages/second during aiming (vs 30 continuous)

---

### 3. Action Event Message
**Purpose**: Trigger instant actions (fire, jump, interact)

```json
{
  "type": "action_event",
  "timestamp": 1234567890,
  "action": "fire_cannon",  // or "jump", "interact", "reload", etc.
  "target": {  // Optional targeting data
    "x": 100.0,
    "y": 200.0
  }
}
```

**Sending Rules**:
- Send immediately on action trigger
- One message per action
- Include precise timing for reconciliation

**Server Behavior**:
- Process immediately (same tick if possible)
- Validate action (cooldown, resources, state)
- Broadcast action result to nearby players
- Do NOT store as persistent state

**Bandwidth**: Variable (depends on player actions)

---

## Movement State Machine

### States
```
IDLE → MOVING_FORWARD → IDLE
     → MOVING_BACKWARD → IDLE
     → MOVING_LEFT → IDLE
     → MOVING_RIGHT → IDLE
     → MOVING_DIAGONAL → IDLE
```

### Transitions

**Idle → Moving**:
```
Client: W key pressed
Client sends: {"type": "movement_state", "movement": {"x": 0, "y": -1}, "is_moving": true}
Server: Sets player.movement_direction = (0, -1), starts applying movement
Client: Predicts movement locally
```

**Moving → Different Direction**:
```
Client: D key pressed (while W held)
Client sends: {"type": "movement_state", "movement": {"x": 0.707, "y": -0.707}, "is_moving": true}
Server: Updates player.movement_direction = normalized(0.707, -0.707)
Client: Updates local prediction
```

**Moving → Idle**:
```
Client: All movement keys released
Client sends: {"type": "movement_state", "movement": {"x": 0, "y": 0}, "is_moving": false}
Server: Clears player.movement_direction, applies friction/stop
Client: Stops local movement, applies friction
```

---

## Server Implementation

### WebSocketPlayer Structure Update
```c
typedef struct WebSocketPlayer {
    uint32_t player_id;
    char name[64];
    float x, y;
    float velocity_x, velocity_y;
    float rotation;
    
    // NEW: Movement state (hybrid approach)
    float movement_direction_x;  // Persistent movement direction
    float movement_direction_y;
    bool is_moving;              // Is player actively moving
    
    // NEW: Rotation tracking
    float last_rotation;         // For interpolation
    uint32_t last_rotation_update_time;
    
    uint32_t parent_ship_id;
    float local_x, local_y;
    PlayerMovementState movement_state;
    uint32_t last_input_time;
    bool active;
} WebSocketPlayer;
```

### Movement Application (Every Tick)
```c
// Called every server tick (30Hz) - NOT per message
static void apply_player_movement_state(WebSocketPlayer* player, float dt) {
    if (!player->is_moving) {
        // Apply friction when not moving
        player->velocity_x *= FRICTION;
        player->velocity_y *= FRICTION;
        return;
    }
    
    // Apply movement using stored direction
    float movement_x = player->movement_direction_x;
    float movement_y = player->movement_direction_y;
    
    // Rest of movement logic...
    // (walking on ship vs swimming logic remains the same)
}
```

### Message Handlers
```c
// Handle movement state changes
static void handle_movement_state(WebSocketPlayer* player, const char* payload) {
    // Parse movement direction
    float x = 0.0f, y = 0.0f;
    bool is_moving = false;
    
    // ... JSON parsing ...
    
    // Update player state (NOT apply movement yet)
    player->movement_direction_x = x;
    player->movement_direction_y = y;
    player->is_moving = is_moving;
    player->last_input_time = get_time_ms();
    
    log_info("🎮 Player %u movement state: (%.2f, %.2f) moving=%d", 
             player->player_id, x, y, is_moving);
}

// Handle rotation updates
static void handle_rotation_update(WebSocketPlayer* player, const char* payload) {
    float rotation = 0.0f;
    
    // ... JSON parsing ...
    
    player->last_rotation = player->rotation;
    player->rotation = rotation;
    player->last_rotation_update_time = get_time_ms();
    
    log_info("🎯 Player %u rotation: %.3f rad", player->player_id, rotation);
}

// Handle action events
static void handle_action_event(WebSocketPlayer* player, const char* payload) {
    // Parse action type
    char action[32] = {0};
    
    // ... JSON parsing ...
    
    // Process action immediately
    if (strcmp(action, "fire_cannon") == 0) {
        // Fire cannon logic
    } else if (strcmp(action, "jump") == 0) {
        // Jump logic
    }
    
    log_info("⚡ Player %u action: %s", player->player_id, action);
}
```

---

## Client Implementation

### InputManager Changes

```typescript
export class InputManager {
  // Track current and previous state for change detection
  private currentMovementState: Vec2 = Vec2.zero();
  private previousMovementState: Vec2 = Vec2.zero();
  private lastSentRotation: number = 0;
  
  // Rotation threshold: 3 degrees = 0.0524 radians
  private readonly ROTATION_THRESHOLD = 0.0524;
  
  /**
   * Generate input and send state changes only
   */
  update(deltaTime: number): void {
    // Generate current movement state from key presses
    const movementState = this.calculateMovementState();
    
    // Check if movement state changed
    if (!movementState.equals(this.previousMovementState)) {
      // Send movement state change
      this.sendMovementStateChange(movementState);
      this.previousMovementState = movementState.clone();
    }
    
    // Check if rotation changed significantly
    const currentRotation = this.calculateRotation();
    const rotationDelta = Math.abs(currentRotation - this.lastSentRotation);
    
    if (rotationDelta > this.ROTATION_THRESHOLD) {
      this.sendRotationUpdate(currentRotation);
      this.lastSentRotation = currentRotation;
    }
  }
  
  /**
   * Send movement state change (state-based)
   */
  private sendMovementStateChange(movement: Vec2): void {
    if (this.onMovementStateChange) {
      this.onMovementStateChange({
        movement: movement,
        is_moving: movement.lengthSq() > 0.01
      });
    }
  }
  
  /**
   * Send rotation update (delta-based)
   */
  private sendRotationUpdate(rotation: number): void {
    if (this.onRotationUpdate) {
      this.onRotationUpdate(rotation);
    }
  }
  
  /**
   * Send action event (event-based)
   */
  private handleAction(action: string, target?: Vec2): void {
    if (this.onActionEvent) {
      this.onActionEvent({
        action: action,
        target: target
      });
    }
  }
}
```

### NetworkManager Changes

```typescript
/**
 * Send movement state change
 */
sendMovementState(movement: Vec2, isMoving: boolean): void {
  const message = {
    type: 'movement_state',
    timestamp: Date.now(),
    movement: { x: movement.x, y: movement.y },
    is_moving: isMoving
  };
  
  console.log(`🚶 Sending movement state: (${movement.x.toFixed(2)}, ${movement.y.toFixed(2)}), moving: ${isMoving}`);
  this.sendMessage(message);
}

/**
 * Send rotation update
 */
sendRotationUpdate(rotation: number): void {
  const message = {
    type: 'rotation_update',
    timestamp: Date.now(),
    rotation: rotation
  };
  
  console.log(`🎯 Sending rotation: ${rotation.toFixed(3)} rad`);
  this.sendMessage(message);
}

/**
 * Send action event
 */
sendAction(action: string, target?: Vec2): void {
  const message = {
    type: 'action_event',
    timestamp: Date.now(),
    action: action,
    target: target ? { x: target.x, y: target.y } : undefined
  };
  
  console.log(`⚡ Sending action: ${action}`);
  this.sendMessage(message);
}
```

---

## Bandwidth Analysis

### Current (Per-Frame) System
- Input messages: ~30/sec × 80 bytes = **2400 bytes/sec/player**
- 100 players = **240 KB/sec** input bandwidth

### Hybrid System
- Movement state: ~3/sec × 60 bytes = 180 bytes/sec
- Rotation updates: ~10/sec × 50 bytes = 500 bytes/sec
- Actions: ~2/sec × 50 bytes = 100 bytes/sec
- **Total: ~780 bytes/sec/player**
- 100 players = **78 KB/sec** input bandwidth

**Savings: ~67% reduction in input bandwidth**

---

## Migration Strategy

### Phase 1: Server Support (Backward Compatible)
1. Add new message handlers alongside old `input_frame` handler
2. Support both protocols simultaneously
3. Add movement state fields to player struct
4. Implement tick-based movement application

### Phase 2: Client Migration
1. Update InputManager to detect state changes
2. Add new NetworkManager methods
3. Switch message sending logic
4. Test with both protocols active

### Phase 3: Deprecation
1. Monitor usage of old `input_frame` messages
2. Add deprecation warnings
3. Remove old protocol after grace period

---

## Edge Cases & Solutions

### 1. Movement State Desync
**Problem**: "Stop" message drops, player keeps moving on server
**Solution**: Client sends periodic heartbeat with current state (~1/sec)

### 2. Rotation Jitter
**Problem**: Threshold causes visible stepping in aim
**Solution**: Server-side interpolation between rotation updates

### 3. Simultaneous Key Presses
**Problem**: W+D pressed together, which message to send first?
**Solution**: Calculate final normalized vector, send once

### 4. Network Partition
**Problem**: Client disconnects while moving
**Solution**: Server clears all movement state on disconnect

### 5. Action Timing
**Problem**: Action arrives late due to network delay
**Solution**: Use timestamp for reconciliation, allow small time window

---

## Testing Checklist

- [ ] Movement starts/stops correctly
- [ ] Diagonal movement transitions smoothly
- [ ] Rotation updates without jitter
- [ ] Actions fire at correct timing
- [ ] Packet loss doesn't break movement
- [ ] Bandwidth reduced as expected
- [ ] Client prediction stays in sync
- [ ] Multiple players move correctly
- [ ] Swimming and walking both work
- [ ] Ship-relative movement correct

---

## Next Steps

1. ✅ Create this specification document
2. ⏭️ Update server WebSocketPlayer structure
3. ⏭️ Implement server message handlers
4. ⏭️ Update client InputManager
5. ⏭️ Update client NetworkManager
6. ⏭️ Test and iterate
7. ⏭️ Document findings and optimize
