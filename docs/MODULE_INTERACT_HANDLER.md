# Module Interaction Handler - Server Implementation

## Overview
This document describes how the server should handle `MODULE_INTERACT` messages sent from the client when players interact with ship modules using the mouse and E key.

## Client Behavior

### Interaction Flow
1. Player hovers mouse over a module (cannon, helm, mast, ladder, seat)
2. Green outline appears around the hovered module
3. Tooltip shows module stats and "[E] Interact" hint
4. Player presses **E** key
5. Client validates:
   - Module is currently hovered (mouse over it)
   - Player is within 50px range of the module
6. Client sends `MODULE_INTERACT` message to server

### Visual Feedback
- **Green outline**: 3px thick, #00ff00 color around hovered module
- **Tooltip**: Shows module type, health, and interaction hint
- **Console logs**:
  - 🎯 Success: "Player interacting with CANNON (ID: 1001) at distance 23.4px"
  - ❌ Too far: "CANNON too far: 67.2px > 50px"
  - ⚠️ No hover: "No module hovered - move mouse over a module and press E"
  - 📤 Network: "Sent MODULE_INTERACT for module {id}"

## Message Format

### MODULE_INTERACT Message
```json
{
  "type": "module_interact",
  "timestamp": 1234567890,
  "module_id": 1001
}
```

### Fields
- **type**: Always "module_interact" (string)
- **timestamp**: Client timestamp in milliseconds (uint64_t)
- **module_id**: Unique ID of the module to interact with (uint32_t)

## Server Handler Implementation

### Message Router
Add to your WebSocket message dispatcher:

```c
// In websocket message handler
if (strcmp(type, "module_interact") == 0) {
    handle_module_interact(player, payload);
}
```

### Core Handler Function

```c
/**
 * Handle module interaction request from client
 * 
 * Client sends this when player presses E on a hovered module.
 * Validates range, module existence, and processes based on module type.
 */
static void handle_module_interact(WebSocketPlayer* player, const char* payload) {
    // Parse JSON
    cJSON* json = cJSON_Parse(payload);
    if (!json) {
        log_error("Failed to parse module_interact message");
        return;
    }
    
    // Extract module_id
    cJSON* module_id_item = cJSON_GetObjectItem(json, "module_id");
    if (!module_id_item) {
        log_error("module_interact missing module_id field");
        cJSON_Delete(json);
        return;
    }
    uint32_t module_id = (uint32_t)module_id_item->valueint;
    
    // Extract timestamp (optional, for lag compensation)
    uint64_t timestamp = 0;
    cJSON* timestamp_item = cJSON_GetObjectItem(json, "timestamp");
    if (timestamp_item) {
        timestamp = (uint64_t)timestamp_item->valuedouble;
    }
    
    cJSON_Delete(json);
    
    log_info("🎮 [MODULE_INTERACT] Player %u -> Module %u", player->player_id, module_id);
    
    // Validate player is on a ship
    if (player->parent_ship_id == 0) {
        log_warn("Player %u not on a ship, cannot interact with module", player->player_id);
        send_interaction_failure(player, "not_on_ship");
        return;
    }
    
    // Find the ship
    Ship* ship = find_ship_by_id(player->parent_ship_id);
    if (!ship) {
        log_error("Ship %u not found for player %u", player->parent_ship_id, player->player_id);
        send_interaction_failure(player, "ship_not_found");
        return;
    }
    
    // Find the module on the ship
    ShipModule* module = find_module_by_id(ship, module_id);
    if (!module) {
        log_warn("Module %u not found on ship %u", module_id, ship->id);
        send_interaction_failure(player, "module_not_found");
        return;
    }
    
    // Validate range (client checks 50px, server should verify)
    // Use ship-local coordinates (player->local_x/y and module->x/y)
    float dx = player->local_x - module->x;
    float dy = player->local_y - module->y;
    float distance = sqrtf(dx * dx + dy * dy);
    
    const float MAX_INTERACT_RANGE = 60.0f; // Slightly more lenient on server for latency
    
    if (distance > MAX_INTERACT_RANGE) {
        log_warn("Player %u too far from module %u (%.1fpx > %.1fpx)", 
                 player->player_id, module_id, distance, MAX_INTERACT_RANGE);
        send_interaction_failure(player, "out_of_range");
        return;
    }
    
    // Check module health
    if (module->health <= 0) {
        log_warn("Module %u is destroyed, cannot interact", module_id);
        send_interaction_failure(player, "module_destroyed");
        return;
    }
    
    // Process interaction based on module type
    log_info("✅ Player %u interacting with %s (ID: %u) at %.1fpx", 
             player->player_id, get_module_kind_name(module->kind), module_id, distance);
    
    switch (module->kind) {
        case MODULE_KIND_CANNON:
            handle_cannon_interact(player, ship, module);
            break;
            
        case MODULE_KIND_HELM:
            handle_helm_interact(player, ship, module);
            break;
            
        case MODULE_KIND_MAST:
            handle_mast_interact(player, ship, module);
            break;
            
        case MODULE_KIND_LADDER:
            handle_ladder_interact(player, ship, module);
            break;
            
        case MODULE_KIND_SEAT:
            handle_seat_interact(player, ship, module);
            break;
            
        case MODULE_KIND_PLANK:
        case MODULE_KIND_DECK:
            // Structural modules, no interaction
            log_warn("Cannot interact with structural module type %d", module->kind);
            send_interaction_failure(player, "not_interactive");
            break;
            
        default:
            log_warn("Unhandled module kind: %d", module->kind);
            send_interaction_failure(player, "unknown_module_type");
            break;
    }
}
```

## Module-Specific Handlers

### Cannon Interaction
```c
static void handle_cannon_interact(WebSocketPlayer* player, Ship* ship, ShipModule* module) {
    // Mount player to cannon for aiming/firing
    
    // Check if cannon is already occupied
    if (module->occupied_by_player_id != 0 && module->occupied_by_player_id != player->player_id) {
        log_info("Cannon %u already occupied by player %u", module->id, module->occupied_by_player_id);
        send_interaction_failure(player, "module_occupied");
        return;
    }
    
    // Mount player
    module->occupied_by_player_id = player->player_id;
    player->mounted_module_id = module->id;
    player->is_mounted = true;
    
    log_info("🎯 Player %u mounted to cannon %u", player->player_id, module->id);
    
    // Send success response
    send_mount_success(player, module);
    
    // Broadcast to nearby players
    broadcast_player_mounted(player, module, ship);
}
```

### Helm Interaction
```c
static void handle_helm_interact(WebSocketPlayer* player, Ship* ship, ShipModule* module) {
    // Mount player to helm for ship steering
    
    // Check if helm is occupied
    if (module->occupied_by_player_id != 0 && module->occupied_by_player_id != player->player_id) {
        log_info("Helm %u already occupied by player %u", module->id, module->occupied_by_player_id);
        send_interaction_failure(player, "module_occupied");
        return;
    }
    
    // Mount player and grant ship control
    module->occupied_by_player_id = player->player_id;
    player->mounted_module_id = module->id;
    player->is_mounted = true;
    player->controlling_ship_id = ship->id;
    
    log_info("⚓ Player %u mounted to helm %u, controlling ship %u", 
             player->player_id, module->id, ship->id);
    
    send_mount_success(player, module);
    broadcast_player_mounted(player, module, ship);
}
```

### Mast Interaction
```c
static void handle_mast_interact(WebSocketPlayer* player, Ship* ship, ShipModule* module) {
    // Toggle sail state (raised/lowered)
    
    // Masts don't require mounting, just toggle state
    module->sail_deployed = !module->sail_deployed;
    
    log_info("⛵ Player %u toggled mast %u sail (deployed: %d)", 
             player->player_id, module->id, module->sail_deployed);
    
    // Send feedback
    send_interaction_success(player, "sail_toggled");
    
    // Update ship physics (sail affects speed)
    update_ship_sail_force(ship);
    
    // Broadcast sail state change
    broadcast_sail_state(ship, module);
}
```

### Ladder Interaction
```c
static void handle_ladder_interact(WebSocketPlayer* player, Ship* ship, ShipModule* module) {
    // Start climbing animation/movement
    
    // For now, just acknowledge - climbing system to be implemented
    log_info("🪜 Player %u used ladder %u", player->player_id, module->id);
    
    send_interaction_success(player, "ladder_used");
    
    // TODO: Implement vertical movement/climbing state
}
```

### Seat Interaction
```c
static void handle_seat_interact(WebSocketPlayer* player, Ship* ship, ShipModule* module) {
    // Mount player to seat (passenger mode)
    
    if (module->occupied_by_player_id != 0 && module->occupied_by_player_id != player->player_id) {
        send_interaction_failure(player, "module_occupied");
        return;
    }
    
    module->occupied_by_player_id = player->player_id;
    player->mounted_module_id = module->id;
    player->is_mounted = true;
    
    log_info("💺 Player %u seated at %u", player->player_id, module->id);
    
    send_mount_success(player, module);
    broadcast_player_mounted(player, module, ship);
}
```

## Response Messages

### Success Response
```json
{
  "type": "module_interact_success",
  "module_id": 1001,
  "module_kind": "cannon",
  "mounted": true
}
```

### Failure Response
```json
{
  "type": "module_interact_failure",
  "module_id": 1001,
  "reason": "out_of_range"
}
```

### Failure Reasons
- `"not_on_ship"` - Player not on a ship
- `"ship_not_found"` - Ship doesn't exist
- `"module_not_found"` - Module doesn't exist on ship
- `"out_of_range"` - Player too far from module
- `"module_destroyed"` - Module health <= 0
- `"module_occupied"` - Another player already using module
- `"not_interactive"` - Module type cannot be interacted with
- `"unknown_module_type"` - Unrecognized module kind

## Helper Functions

```c
/**
 * Get human-readable module kind name
 */
static const char* get_module_kind_name(ModuleKind kind) {
    switch (kind) {
        case MODULE_KIND_CANNON: return "CANNON";
        case MODULE_KIND_HELM: return "HELM";
        case MODULE_KIND_MAST: return "MAST";
        case MODULE_KIND_LADDER: return "LADDER";
        case MODULE_KIND_SEAT: return "SEAT";
        case MODULE_KIND_PLANK: return "PLANK";
        case MODULE_KIND_DECK: return "DECK";
        default: return "UNKNOWN";
    }
}

/**
 * Find module by ID on a ship
 */
static ShipModule* find_module_by_id(Ship* ship, uint32_t module_id) {
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].id == module_id) {
            return &ship->modules[i];
        }
    }
    return NULL;
}

/**
 * Send interaction failure to client
 */
static void send_interaction_failure(WebSocketPlayer* player, const char* reason) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_failure\",\"reason\":\"%s\"}",
             reason);
    
    send_websocket_message(player->ws_conn, response);
}

/**
 * Send mount success to client
 */
static void send_mount_success(WebSocketPlayer* player, ShipModule* module) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"module_id\":%u,\"module_kind\":\"%s\",\"mounted\":true}",
             module->id, get_module_kind_name(module->kind));
    
    send_websocket_message(player->ws_conn, response);
}

/**
 * Send interaction success (non-mounting actions)
 */
static void send_interaction_success(WebSocketPlayer* player, const char* action) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"action\":\"%s\"}",
             action);
    
    send_websocket_message(player->ws_conn, response);
}
```

## Data Structure Updates

### ShipModule Structure
```c
typedef struct ShipModule {
    uint32_t id;              // Unique module ID
    ModuleKind kind;          // Module type
    float x, y;               // Position on ship (local coords)
    float rotation;           // Rotation in radians
    float health;             // Module health (0-100)
    
    // Interaction state
    uint32_t occupied_by_player_id;  // 0 if not occupied
    bool sail_deployed;              // For masts
    float aim_rotation;              // For cannons
    
    // Add as needed...
} ShipModule;
```

### WebSocketPlayer Updates
```c
typedef struct WebSocketPlayer {
    // ... existing fields ...
    
    // Module interaction state
    bool is_mounted;               // Is player mounted to a module
    uint32_t mounted_module_id;    // ID of mounted module (0 if not mounted)
    uint32_t controlling_ship_id;  // ID of ship being controlled (helm only)
    
    // ... rest of fields ...
} WebSocketPlayer;
```

## Testing

### Manual Testing Steps
1. Start server with debug logging enabled
2. Connect client and spawn on ship with modules
3. Hover mouse over cannon → verify green outline appears
4. Press E → verify console shows interaction attempt
5. Check server logs for "🎮 [MODULE_INTERACT]" message
6. Verify server processes and responds
7. Test out-of-range (walk far away, press E)
8. Test occupied modules (two players interact with same module)
9. Test each module type (cannon, helm, mast, ladder, seat)

### Expected Server Logs
```
🎮 [MODULE_INTERACT] Player 1 -> Module 1001
✅ Player 1 interacting with CANNON (ID: 1001) at 23.4px
🎯 Player 1 mounted to cannon 1001
```

## Integration Checklist

- [ ] Add `handle_module_interact` to WebSocket message router
- [ ] Implement core validation logic
- [ ] Implement module-specific handlers
- [ ] Add helper functions (`find_module_by_id`, etc.)
- [ ] Update `ShipModule` structure with interaction fields
- [ ] Update `WebSocketPlayer` structure with mount state
- [ ] Implement response messages (success/failure)
- [ ] Add broadcast functions for state changes
- [ ] Test with live client
- [ ] Add metrics/logging for interaction events

## Future Enhancements

1. **Dismounting**: Add handler for when player wants to leave module (press E again)
2. **Cannon Aiming**: Track player rotation while mounted, update cannon aim
3. **Cannon Firing**: Handle SPACE/CLICK to fire cannon while mounted
4. **Climbing System**: Implement vertical movement for ladders
5. **Animation Sync**: Broadcast player animation state to nearby clients
6. **Collision Prevention**: Ensure mounted players don't get pushed off ship
7. **Permission System**: Add ship ownership/crew permissions for modules
8. **Cooldowns**: Add interaction cooldowns to prevent spam
9. **Audio Feedback**: Trigger sound effects for interactions
10. **Analytics**: Track module usage statistics

## Notes

- Client already validates 50px range before sending, but server should verify (60px with latency buffer)
- Module IDs must be unique across all ships in the world
- Mounted players should be locked to module position on ship
- When ship moves/rotates, mounted players move with it
- Destroying a module should dismount any mounted players
- Player disconnect should clear all module occupation states
