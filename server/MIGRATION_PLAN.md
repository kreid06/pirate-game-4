# Migration Plan: Player-Ship Separation

## Current State (What We Have)
- ✅ WebSocket server with player connections
- ✅ Player movement with rotation and velocity
- ✅ Basic game state broadcasts
- ❌ Players ARE the ships (no separation)

## Target State (What We Need)
- Ships as independent physics entities
- Players as character controllers ON ships
- Coordinate conversion (world ↔ ship-local)
- Multiple players on same ship
- Boarding mechanics (jump between ships)

---

## Phase 1: Ship Entity System ⏳

### 1.1 Create Ship Structure
**File**: `server/include/sim/ship.h`
```c
typedef struct Ship {
    uint32_t ship_id;
    
    // Physics
    float x, y;                    // World position
    float rotation;                // Radians
    float velocity_x, velocity_y;
    float angular_velocity;
    
    // Properties
    float mass;
    float length, width;
    
    // Control
    float rudder_input;   // -1 to 1
    float sail_position;  // 0 to 1
    
    // Deck boundaries (for player collision)
    float deck_min_x, deck_max_x;
    float deck_min_y, deck_max_y;
    
    bool active;
} Ship;
```

**File**: `server/src/sim/ship.c`
- `ship_create()`
- `ship_update_physics(ship, dt)`
- `ship_apply_control(ship, rudder, sails)`
- `ship_is_point_on_deck(ship, local_x, local_y)`

### 1.2 Add Ship to Game World
**File**: `server/include/server.h`
```c
typedef struct GameWorld {
    Ship ships[MAX_SHIPS];
    int ship_count;
    
    // ... existing player data
} GameWorld;
```

### 1.3 Ship Physics Update
**File**: `server/src/server.c`
```c
void game_tick(GameWorld* world, float dt) {
    // 1. Update ships
    for (int i = 0; i < world->ship_count; i++) {
        ship_update_physics(&world->ships[i], dt);
    }
    
    // 2. Update players (will modify later)
    // ...
}
```

**Deliverable**: Ships exist and move independently ✓

---

## Phase 2: Player-Ship Relationship ⏳

### 2.1 Update Player Structure
**File**: `server/src/net/websocket_server.c`
```c
typedef struct WebSocketPlayer {
    // ... existing fields
    
    // Ship relationship
    uint32_t parent_ship_id;  // 0 if not on ship
    float local_x, local_y;   // Position relative to ship
    
    // Movement state
    enum {
        PLAYER_STATE_WALKING,
        PLAYER_STATE_SWIMMING,
        PLAYER_STATE_FALLING
    } movement_state;
    
} WebSocketPlayer;
```

### 2.2 Coordinate Conversion Functions
**File**: `server/src/sim/ship.c`
```c
// Convert player local position to world position
Vec2 ship_local_to_world(Ship* ship, float local_x, float local_y) {
    float cos_r = cosf(ship->rotation);
    float sin_r = sinf(ship->rotation);
    
    return (Vec2){
        ship->x + local_x * cos_r - local_y * sin_r,
        ship->y + local_x * sin_r + local_y * cos_r
    };
}

// Convert world position to ship local
Vec2 ship_world_to_local(Ship* ship, float world_x, float world_y) {
    float dx = world_x - ship->x;
    float dy = world_y - ship->y;
    
    float cos_r = cosf(ship->rotation);
    float sin_r = sinf(ship->rotation);
    
    return (Vec2){
        dx * cos_r + dy * sin_r,
        -dx * sin_r + dy * cos_r
    };
}
```

### 2.3 Update Player Movement Logic
**File**: `server/src/net/websocket_server.c`
```c
static void update_player_movement(WebSocketPlayer* player, 
                                   float rotation, 
                                   float movement_x, 
                                   float movement_y, 
                                   float dt) {
    player->rotation = rotation; // Player aim direction
    
    if (player->parent_ship_id != 0) {
        // Player is on a ship - move in local coordinates
        Ship* ship = find_ship(player->parent_ship_id);
        if (ship) {
            const float WALK_SPEED = 3.0f; // m/s on deck
            
            // Update local position
            player->local_x += movement_x * WALK_SPEED * dt;
            player->local_y += movement_y * WALK_SPEED * dt;
            
            // Clamp to deck boundaries
            if (player->local_x < ship->deck_min_x) player->local_x = ship->deck_min_x;
            if (player->local_x > ship->deck_max_x) player->local_x = ship->deck_max_x;
            if (player->local_y < ship->deck_min_y) player->local_y = ship->deck_min_y;
            if (player->local_y > ship->deck_max_y) player->local_y = ship->deck_max_y;
            
            // Convert to world position
            Vec2 world_pos = ship_local_to_world(ship, player->local_x, player->local_y);
            player->x = world_pos.x;
            player->y = world_pos.y;
            
            // Inherit ship velocity
            player->velocity_x = ship->velocity_x;
            player->velocity_y = ship->velocity_y;
        }
    } else {
        // Player is swimming - move in world coordinates
        const float SWIM_SPEED = 1.5f; // Slower in water
        
        player->velocity_x = movement_x * SWIM_SPEED;
        player->velocity_y = movement_y * SWIM_SPEED;
        
        player->x += player->velocity_x * dt;
        player->y += player->velocity_y * dt;
    }
}
```

**Deliverable**: Players move on ships, position updates correctly ✓

---

## Phase 3: Game State Broadcast Update ⏳

### 3.1 Update Broadcast Format
**File**: `server/src/net/websocket_server.c`
```c
void broadcast_game_state(void) {
    char response[4096]; // Larger buffer
    int offset = 0;
    
    // Start JSON
    offset += snprintf(response + offset, sizeof(response) - offset,
                      "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":[",
                      get_time_ms() / 33, get_time_ms());
    
    // Add ships
    for (int i = 0; i < ship_count; i++) {
        Ship* ship = &ships[i];
        if (ship->active) {
            offset += snprintf(response + offset, sizeof(response) - offset,
                             "%s{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,\"velocity_x\":%.2f,\"velocity_y\":%.2f}",
                             (i > 0 ? "," : ""), ship->ship_id, ship->x, ship->y, 
                             ship->rotation, ship->velocity_x, ship->velocity_y);
        }
    }
    
    offset += snprintf(response + offset, sizeof(response) - offset, "],\"players\":[");
    
    // Add players
    bool first = true;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        WebSocketPlayer* player = &players[i];
        if (player->active) {
            offset += snprintf(response + offset, sizeof(response) - offset,
                             "%s{\"id\":%u,\"name\":\"%s\",\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\"}",
                             (first ? "" : ","), player->player_id, player->name,
                             player->x, player->y, player->rotation,
                             player->parent_ship_id, player->local_x, player->local_y,
                             get_state_string(player->movement_state));
            first = false;
        }
    }
    
    offset += snprintf(response + offset, sizeof(response) - offset, "],\"projectiles\":[]}");
    
    // Broadcast to all clients
    websocket_broadcast(response);
}
```

**Deliverable**: Clients receive ship + player data ✓

---

## Phase 4: Boarding Mechanics ⏳

### 4.1 Jump Action
**File**: `server/src/net/websocket_server.c`
```c
// Parse actions from input frame
if (actions & ACTION_JUMP) {
    if (player->parent_ship_id != 0) {
        // Leave ship
        player->parent_ship_id = 0;
        player->movement_state = PLAYER_STATE_FALLING;
        log_info("Player %u jumped off ship", player->player_id);
    }
}
```

### 4.2 Landing Detection
**File**: `server/src/net/websocket_server.c`
```c
void check_player_boarding(WebSocketPlayer* player) {
    if (player->movement_state != PLAYER_STATE_WALKING) {
        // Check if player is on any ship deck
        for (int i = 0; i < ship_count; i++) {
            Ship* ship = &ships[i];
            if (!ship->active) continue;
            
            // Convert player world position to ship local
            Vec2 local = ship_world_to_local(ship, player->x, player->y);
            
            // Check if in deck bounds
            if (local.x >= ship->deck_min_x && local.x <= ship->deck_max_x &&
                local.y >= ship->deck_min_y && local.y <= ship->deck_max_y) {
                
                // Player landed on deck
                player->parent_ship_id = ship->ship_id;
                player->local_x = local.x;
                player->local_y = local.y;
                player->movement_state = PLAYER_STATE_WALKING;
                
                log_info("Player %u boarded ship %u", player->player_id, ship->ship_id);
                break;
            }
        }
        
        // If still not on ship, check if in water
        if (player->movement_state == PLAYER_STATE_FALLING) {
            player->movement_state = PLAYER_STATE_SWIMMING;
        }
    }
}
```

**Deliverable**: Players can jump and board ships ✓

---

## Phase 5: Ship Control Interface ⏳

### 5.1 Ship Control Message
**File**: `server/src/net/websocket_server.c`
```c
// In websocket message handler
if (strstr(payload, "\"type\":\"ship_control\"")) {
    uint32_t ship_id = 0;
    float rudder = 0.0f, sails = 0.0f;
    
    // Parse JSON
    char* ship_id_str = strstr(payload, "\"ship_id\":");
    char* rudder_str = strstr(payload, "\"rudder\":");
    char* sails_str = strstr(payload, "\"sails\":");
    
    if (ship_id_str) sscanf(ship_id_str + 10, "%u", &ship_id);
    if (rudder_str) sscanf(rudder_str + 9, "%f", &rudder);
    if (sails_str) sscanf(sails_str + 8, "%f", &sails);
    
    // Apply to ship
    Ship* ship = find_ship(ship_id);
    if (ship && can_control_ship(player, ship)) {
        ship_apply_control(ship, rudder, sails);
    }
    
    handled = true;
}
```

**Deliverable**: Players can control ship movement ✓

---

## Testing Checklist

### Ship Physics
- [ ] Ship spawns at starting position
- [ ] Ship moves forward when sails deployed
- [ ] Ship turns when rudder applied
- [ ] Ship has momentum (doesn't stop instantly)

### Player-Ship Interaction
- [ ] Player spawns on ship deck
- [ ] Player can walk on deck (stays on ship)
- [ ] Player position updates when ship moves
- [ ] Player position updates when ship rotates

### Coordinate Systems
- [ ] Local → World conversion is correct
- [ ] World → Local conversion is correct
- [ ] Player world position matches visual position

### Boarding
- [ ] Player can jump off ship
- [ ] Player enters falling state
- [ ] Player lands on other ship deck
- [ ] Player enters swimming if misses ship

### Multi-Player
- [ ] Multiple players on same ship
- [ ] Each player moves independently
- [ ] All players inherit ship motion

---

## File Changes Summary

### New Files
- `server/include/sim/ship.h`
- `server/src/sim/ship.c`
- `docs/PLAYER_SHIP_ARCHITECTURE.md` ✅
- `server/MIGRATION_PLAN.md` ✅

### Modified Files
- `server/include/server.h` - Add ship array
- `server/src/server.c` - Add ship update loop
- `server/src/net/websocket_server.c` - Update player movement, broadcast
- `server/include/net/websocket_server.h` - Update player struct

### Deprecated Files
- `server/MOUSE_CONTROLS_SPEC.md` - Needs major rewrite
- `server/CONTROLS_QUICK_REFERENCE.md` - No longer accurate

---

**Estimated Implementation Time**: 8-12 hours  
**Risk Level**: Medium (major architecture change)  
**Breaking Changes**: Yes (protocol format changes)
