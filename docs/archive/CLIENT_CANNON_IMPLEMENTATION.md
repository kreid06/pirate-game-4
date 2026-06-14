# Client-Side Cannon Control Implementation

## Overview
The client implements a mouse-based cannon aiming and firing system that sends commands to the server for authoritative processing.

## User Controls

### Aiming (Right-Click)
- **Action**: Hold right mouse button
- **Behavior**: 
  - Calculates aim angle from player position to mouse cursor (world coordinates)
  - Sends continuous `CANNON_AIM` messages to server
  - Updates throttled to >1° angle changes to reduce network traffic
- **Requirements**: Player must be on a ship (`carrierId > 0`)

### Single Fire (Left-Click)
- **Action**: Single left-click
- **Behavior**: Fires cannons that are currently aimed at the target
- **Message**: `CANNON_FIRE` with no `cannon_ids` specified
- **Server Responsibility**: Determine which cannons are within aim tolerance and can fire

### Broadside (Double-Click)
- **Action**: Double left-click (within 300ms)
- **Behavior**: Fires ALL cannons on the ship simultaneously
- **Message**: `CANNON_FIRE` with `fire_all: true`
- **Server Responsibility**: Fire all cannons regardless of aim direction

## Network Protocol

### Message: `CANNON_AIM`
Sent continuously while right-mouse is held and player is on a ship.

```typescript
{
  type: "cannon_aim",
  timestamp: 1732637892341,
  aim_angle: 0.524  // Radians, SHIP-RELATIVE angle (not world coordinates)
}
```

**Client Calculation**:
```typescript
// World angle from player to mouse cursor
const aimAngleWorld = Math.atan2(dy, dx);

// Convert to ship-relative angle
let aimAngleRelative = aimAngleWorld - shipRotation;

// Normalize to [-π, π] range
while (aimAngleRelative > Math.PI) aimAngleRelative -= 2 * Math.PI;
while (aimAngleRelative < -Math.PI) aimAngleRelative += 2 * Math.PI;
```

**Client Throttling**:
- Only sends when angle changes by >1° (~0.017 radians)
- Prevents network spam from minor mouse movements

**Server Expected Behavior**:
1. Receive ship-relative aim angle (already normalized)
2. Update `aim_direction` for all cannons or player's aim state
3. Track which cannons are "aimed" (within firing arc)
4. No need for coordinate conversion - angle is already ship-relative

---

### Message: `CANNON_FIRE` (Single Click)
Sent on left-click to fire aimed cannons.

```typescript
{
  type: "cannon_fire",
  timestamp: 1732637892450,
  // No cannon_ids specified = fire aimed cannons only
  fire_all: false
}
```

**Server Expected Behavior**:
1. Get player's current aim angle
2. Find all cannons within firing tolerance (e.g., ±15° of aim direction)
3. Fire eligible cannons that:
   - Are within aim tolerance
   - Have ammunition
   - Are not reloading
4. Spawn cannonball projectiles
5. Start reload timers
6. Broadcast fire events to clients

---

### Message: `CANNON_FIRE` (Double Click)
Sent on double left-click to fire ALL cannons.

```typescript
{
  type: "cannon_fire",
  timestamp: 1732637892580,
  fire_all: true
}
```

**Server Expected Behavior**:
1. Fire ALL cannons on player's ship regardless of aim
2. Ignore aim direction checks
3. Fire all cannons that have ammo and are not reloading
4. Typical use case: Broadside attack
5. Spawn projectiles in cannon's facing direction
6. Start reload timers
7. Broadcast fire events

---

## Implementation Details

### Client-Side State Tracking

**InputManager** (`client/src/client/gameplay/InputManager.ts`):
```typescript
private currentShipId: number | null = null;  // Track player's ship
private lastCannonAimAngle: number = 0;       // Last sent aim angle
private lastLeftClickTime: number = 0;        // For double-click detection
private readonly DOUBLE_CLICK_THRESHOLD = 300; // 300ms window
```

**Aim Calculation**:
```typescript
// In handleCannonAiming()
// 1. Calculate world angle from player to mouse
const dx = mouseWorldPosition.x - playerPosition.x;
const dy = mouseWorldPosition.y - playerPosition.y;
const aimAngleWorld = Math.atan2(dy, dx);

// 2. Convert to ship-relative angle
let aimAngleRelative = aimAngleWorld - currentShipRotation;

// 3. Normalize to [-π, π] range
while (aimAngleRelative > Math.PI) aimAngleRelative -= 2 * Math.PI;
while (aimAngleRelative < -Math.PI) aimAngleRelative += 2 * Math.PI;
```

**Ship Rotation Tracking**:
```typescript
// In ClientApplication.updateWorldState()
if (player.carrierId) {
  const ship = worldState.ships.find(s => s.id === player.carrierId);
  if (ship) {
    this.inputManager.setCurrentShipRotation(ship.rotation);
  }
}
```

**Double-Click Detection**:
```typescript
const now = Date.now();
const timeSinceLastClick = now - this.lastLeftClickTime;
const isDoubleClick = timeSinceLastClick < 300; // 300ms threshold
```

### NetworkManager Methods

**Send Aim Updates**:
```typescript
sendCannonAim(aimAngle: number): void {
  const message: CannonAimMessage = {
    type: MessageType.CANNON_AIM,
    timestamp: Date.now(),
    aim_angle: aimAngle
  };
  this.sendMessage(message);
}
```

**Send Fire Commands**:
```typescript
sendCannonFire(cannonIds?: number[], fireAll: boolean = false): void {
  const message: CannonFireMessage = {
    type: MessageType.CANNON_FIRE,
    timestamp: Date.now(),
    cannon_ids: cannonIds,
    fire_all: fireAll
  };
  this.sendMessage(message);
}
```

### ClientApplication Integration

**Callback Wiring** (in `initializeSystems()`):
```typescript
// Wire up cannon callbacks
this.inputManager.onCannonAim = (aimAngle) => {
  this.networkManager.sendCannonAim(aimAngle);
};

this.inputManager.onCannonFire = (cannonIds, fireAll) => {
  this.networkManager.sendCannonFire(cannonIds, fireAll);
};
```

**Ship ID Tracking** (in `updateWorldState()`):
```typescript
// Update ship ID for cannon aiming
const player = worldState.players.find(p => p.id === playerId);
if (player) {
  this.inputManager.setCurrentShipId(player.carrierId || null);
}
```

---

## Server Implementation Guide

### 1. Message Handlers

Add to WebSocket message processing:

```c
else if (strstr(payload, "\"type\":\"cannon_aim\"")) {
    // Parse aim_angle
    float aim_angle = 0.0f;
    char* angle_start = strstr(payload, "\"aim_angle\":");
    if (angle_start) {
        sscanf(angle_start + 12, "%f", &aim_angle);
    }
    
    handle_cannon_aim(player, aim_angle);
}
else if (strstr(payload, "\"type\":\"cannon_fire\"")) {
    // Parse fire_all flag
    bool fire_all = strstr(payload, "\"fire_all\":true") != NULL;
    
    handle_cannon_fire(player, fire_all);
}
```

### 2. Cannon Aiming Logic

**Option A: Store per-player aim state**
```c
void handle_cannon_aim(WebSocketPlayer* player, float aim_angle) {
    // Angle is already ship-relative from client
    player->cannon_aim_angle_relative = aim_angle;
    
    log_info("🎯 Player %u aiming cannons at %.2f° (ship-relative)", 
             player->player_id, aim_angle * 180.0f / M_PI);
}
```

**Option B: Update cannon modules directly**
```c
void handle_cannon_aim(WebSocketPlayer* player, float aim_angle) {
    if (player->parent_ship_id == 0) return;
    
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;
    
    // Angle is already ship-relative from client, just store it
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].type_id == MODULE_TYPE_CANNON) {
            ship->modules[i].data.cannon.aim_direction = Q16_FROM_FLOAT(aim_angle);
        }
    }
}
```

### 3. Cannon Firing Logic

```c
void handle_cannon_fire(WebSocketPlayer* player, bool fire_all) {
    if (player->parent_ship_id == 0) {
        log_warn("Player %u tried to fire cannons while not on a ship", player->player_id);
        return;
    }
    
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;
    
    int cannons_fired = 0;
    
    for (int i = 0; i < ship->module_count; i++) {
        ShipModule* module = &ship->modules[i];
        
        if (module->type_id != MODULE_TYPE_CANNON) continue;
        
        // Check ammo and reload status
        if (module->data.cannon.ammunition == 0) continue;
        if (module->data.cannon.time_since_fire < module->data.cannon.reload_time) continue;
        
        bool should_fire = fire_all;
        
        if (!fire_all) {
            // Check if cannon is aimed at target (within tolerance)
            float cannon_aim = Q16_TO_FLOAT(module->data.cannon.aim_direction);
            float player_aim = player->cannon_aim_angle_relative;
            float aim_difference = fabsf(cannon_aim - player_aim);
            
            const float AIM_TOLERANCE = 0.262f; // ~15 degrees in radians
            should_fire = aim_difference < AIM_TOLERANCE;
        }
        
        if (should_fire) {
            fire_cannon(ship, module, player);
            cannons_fired++;
        }
    }
    
    log_info("💥 Player %u fired %d cannons (%s)", 
             player->player_id, cannons_fired, fire_all ? "broadside" : "aimed");
}
```

### 4. Projectile Spawning

```c
void fire_cannon(SimpleShip* ship, ShipModule* cannon, WebSocketPlayer* player) {
    // Consume ammo
    cannon->data.cannon.ammunition--;
    cannon->data.cannon.time_since_fire = 0;
    
    // Calculate world position of cannon
    float cannon_world_x = ship->x + 
        (Q16_TO_FLOAT(cannon->local_pos.x) * cosf(ship->rotation) - 
         Q16_TO_FLOAT(cannon->local_pos.y) * sinf(ship->rotation));
    float cannon_world_y = ship->y + 
        (Q16_TO_FLOAT(cannon->local_pos.x) * sinf(ship->rotation) + 
         Q16_TO_FLOAT(cannon->local_pos.y) * cosf(ship->rotation));
    
    // Calculate projectile direction (cannon facing + aim direction)
    float projectile_angle = ship->rotation + Q16_TO_FLOAT(cannon->data.cannon.aim_direction);
    
    const float CANNONBALL_SPEED = 500.0f; // Client units/s
    float vel_x = cosf(projectile_angle) * CANNONBALL_SPEED;
    float vel_y = sinf(projectile_angle) * CANNONBALL_SPEED;
    
    // Spawn projectile (add to simulation)
    spawn_projectile(cannon_world_x, cannon_world_y, vel_x, vel_y, player->player_id);
    
    // Broadcast fire event to all clients
    broadcast_cannon_fire_event(ship->ship_id, cannon->id, cannon_world_x, cannon_world_y);
}
```

---

## Example Flow

### Scenario: Player aims and fires starboard cannons

1. **Player boards ship**
   - Server sends `GAME_STATE` with `player.parent_ship = 1`
   - Client sets `currentShipId = 1`

2. **Player holds right-click and moves mouse**
   - Client calculates world angle: `aim_angle_world = atan2(dy, dx) = 0.524 rad` (~30°)
   - Ship is facing: `ship.rotation = 1.57 rad` (~90°, pointing north)
   - Client calculates ship-relative: `0.524 - 1.57 = -1.046 rad` (~-60°, starboard side)
   - Client sends: `{"type":"cannon_aim","aim_angle":-1.046}`
   - Server stores player's `cannon_aim_angle_relative = -1.046`

3. **Player left-clicks**
   - Client detects single click (>300ms since last)
   - Client sends: `{"type":"cannon_fire","fire_all":false}`
   - Server checks all cannons against player's aim (-1.046 rad = ~-60°):
     - Port cannons: facing = -1.57 rad (~-90°), diff = 0.52 rad (~30°) → **fire** (within 15° tolerance with some leeway)
     - Starboard cannons: facing = 1.57 rad (~90°), diff = 2.62 rad (~150°) → **skip** (wrong side)
   - Server spawns cannonball projectiles from port side
   - Server broadcasts fire events

4. **Player double-clicks**
   - Client detects double-click (<300ms)
   - Client sends: `{"type":"cannon_fire","fire_all":true}`
   - Server fires ALL 6 cannons (port + starboard)
   - Server spawns 6 cannonball projectiles

---

## Testing Checklist

### Client-Side
- [✅] Right-click sends `CANNON_AIM` messages
- [✅] Aim angle calculated correctly (player → mouse)
- [✅] Throttling works (only sends on >1° change)
- [✅] Single click sends `CANNON_FIRE` with `fire_all:false`
- [✅] Double click sends `CANNON_FIRE` with `fire_all:true`
- [✅] Ship ID tracked when boarding/dismounting
- [✅] No messages sent when not on ship

### Server-Side (To Implement)
- [ ] Parse `cannon_aim` messages
- [ ] Parse `cannon_fire` messages
- [ ] Store player aim angle (world or ship-relative)
- [ ] Fire aimed cannons on single-click
- [ ] Fire all cannons on double-click
- [ ] Check ammo and reload status
- [ ] Spawn projectile entities
- [ ] Broadcast fire events to clients
- [ ] Update cannon `time_since_fire` counters
- [ ] Handle reload mechanics

---

## Future Enhancements

### Client-Side
- [ ] Visual aim indicator (crosshair or arc)
- [ ] Cannon ready/reloading UI
- [ ] Ammo counter display
- [ ] Firing animation triggers
- [ ] Sound effects (cannon fire, reload)

### Server-Side
- [ ] Cannon spread/accuracy simulation
- [ ] Different ammo types
- [ ] Reload time variations
- [ ] Cannon damage states
- [ ] Fire rate limiting (prevent spam)
- [ ] Chain shot, grape shot mechanics

---

## Notes

**Coordinate Systems**:
- Client sends aim in **world coordinates** (absolute angle)
- Server should convert to **ship-relative** for cannon matching
- Example: Ship at 90°, player aims at 120° → ship-relative = 30°

**Timing**:
- Double-click threshold: 300ms
- Aim angle threshold: 1° (~0.017 radians)
- Expected cannon reload: 3-5 seconds

**Network Efficiency**:
- Aim updates throttled (not every frame)
- Fire commands are instant (no prediction)
- Server is authoritative for all cannon state

---

**Last Updated**: November 26, 2025  
**Client Version**: 1.0  
**Protocol Version**: 1.0 (Hybrid)
