# Mount Helm Feature Implementation

## Overview
When a player successfully interacts with a helm module, they become mounted at a fixed position relative to the helm. This prevents player movement and will eventually enable ship controls.

## Client Implementation ✅

### Player State Changes
Added to `Player` interface:
```typescript
isMounted: boolean;           // Is player mounted to a module
mountedModuleId?: number;     // ID of mounted module
mountOffset?: Vec2;           // Offset from module position
```

### Mount Position
- **Helm mount offset**: `{x: -10, y: 0}` (10 units to the left of helm)
- Player position is locked to: `modulePosition + mountOffset`
- Position updates with ship rotation and movement

### Visual Indicators
- **Mounted players**: Blue circle (#0099ff) with ⚓ anchor icon
- **On-deck players**: Green circle (#00ff00)
- **Swimming players**: Red circle (#ff0000)

### Movement Prevention
When `player.isMounted === true`:
- Player physics locks position to module + offset
- Input movement is ignored
- Player velocity matches ship velocity
- Position recalculated each frame in ship-local coordinates

## Server Implementation Required

### 1. Module Interaction Handler

When receiving `MODULE_INTERACT` message for a helm:

```c
static void handle_helm_interact(WebSocketPlayer* player, Ship* ship, ShipModule* module) {
    // Check if helm is occupied
    if (module->occupied_by_player_id != 0 && module->occupied_by_player_id != player->player_id) {
        send_interaction_failure(player, "module_occupied");
        return;
    }
    
    // Mount player to helm
    module->occupied_by_player_id = player->player_id;
    player->mounted_module_id = module->id;
    player->is_mounted = true;
    
    // Calculate mount position (helm position + offset)
    const float HELM_MOUNT_OFFSET_X = -10.0f;
    const float HELM_MOUNT_OFFSET_Y = 0.0f;
    
    player->local_x = module->x + HELM_MOUNT_OFFSET_X;
    player->local_y = module->y + HELM_MOUNT_OFFSET_Y;
    
    log_info("⚓ Player %u mounted to helm %u at local (%.1f, %.1f)", 
             player->player_id, module->id, player->local_x, player->local_y);
    
    // Send success response with mount offset
    send_mount_success(player, module, HELM_MOUNT_OFFSET_X, HELM_MOUNT_OFFSET_Y);
    
    // Broadcast to nearby players
    broadcast_player_mounted(player, module, ship);
}
```

### 2. Success Response Message

```json
{
  "type": "module_interact_success",
  "module_id": 1001,
  "module_kind": "helm",
  "mounted": true,
  "mount_offset": {
    "x": -10,
    "y": 0
  }
}
```

```c
static void send_mount_success(WebSocketPlayer* player, ShipModule* module, 
                               float offset_x, float offset_y) {
    char response[512];
    snprintf(response, sizeof(response),
             "{"
             "\"type\":\"module_interact_success\","
             "\"module_id\":%u,"
             "\"module_kind\":\"%s\","
             "\"mounted\":true,"
             "\"mount_offset\":{\"x\":%.1f,\"y\":%.1f}"
             "}",
             module->id, 
             get_module_kind_name(module->kind),
             offset_x,
             offset_y);
    
    send_websocket_message(player->ws_conn, response);
}
```

### 3. Player Movement Update

```c
static void update_player_movement(WebSocketPlayer* player, float dt) {
    // If player is mounted, lock position to module
    if (player->is_mounted && player->mounted_module_id != 0) {
        Ship* ship = find_ship(player->parent_ship_id);
        if (!ship) {
            // Ship missing - dismount player
            dismount_player_from_module(player);
            return;
        }
        
        ShipModule* module = find_module_by_id(ship, player->mounted_module_id);
        if (!module) {
            // Module missing - dismount player
            dismount_player_from_module(player);
            return;
        }
        
        // Lock player position (already set during mount)
        // Position doesn't change relative to module
        // World position updated during ship physics
        
        // Convert local to world for network updates
        ship_local_to_world(ship, player->local_x, player->local_y,
                           &player->x, &player->y);
        
        // Match ship velocity
        player->velocity_x = ship->velocity_x;
        player->velocity_y = ship->velocity_y;
        
        return; // Skip normal movement logic
    }
    
    // Normal movement logic for unmounted players...
}
```

### 4. Data Structure Updates

```c
typedef struct ShipModule {
    uint32_t id;
    ModuleKind kind;
    float x, y;              // Local position on ship
    float rotation;
    float health;
    uint32_t occupied_by_player_id;  // Player mounted to this module (0 = none)
    // ... other fields
} ShipModule;

typedef struct WebSocketPlayer {
    uint32_t player_id;
    uint32_t parent_ship_id;
    float local_x, local_y;  // Position on ship
    float x, y;              // World position
    
    // Mount state
    bool is_mounted;              // Is player mounted to a module
    uint32_t mounted_module_id;   // ID of mounted module (0 = not mounted)
    
    // ... other fields
} WebSocketPlayer;
```

### 5. Dismount Logic

```c
static void dismount_player_from_module(WebSocketPlayer* player) {
    if (!player->is_mounted) return;
    
    log_info("🔓 Player %u dismounted from module %u", 
             player->player_id, player->mounted_module_id);
    
    // Clear mount state
    uint32_t module_id = player->mounted_module_id;
    player->is_mounted = false;
    player->mounted_module_id = 0;
    
    // Clear module occupation
    Ship* ship = find_ship(player->parent_ship_id);
    if (ship) {
        ShipModule* module = find_module_by_id(ship, module_id);
        if (module) {
            module->occupied_by_player_id = 0;
        }
    }
    
    // Send dismount notification
    char message[256];
    snprintf(message, sizeof(message),
             "{\"type\":\"module_dismount\",\"module_id\":%u}",
             module_id);
    send_websocket_message(player->ws_conn, message);
}
```

### 6. GAME_STATE Updates

Include mount state in player data:

```json
{
  "type": "GAME_STATE",
  "tick": 12345,
  "players": [
    {
      "id": 1,
      "parent_ship": 123,
      "local_x": 45.5,
      "local_y": -10.0,
      "world_x": 1234.5,
      "world_y": 567.8,
      "is_mounted": true,
      "mounted_module_id": 1001
    }
  ]
}
```

## Future Enhancements

### Ship Controls (When Mounted to Helm)
Once mounted, enable ship steering:
- **A/D keys**: Rotate ship left/right
- **W/S keys**: Adjust sail deployment (speed)
- **E key**: Dismount from helm

```c
// When player is mounted to helm, apply rotation input to ship
if (player->is_mounted && module->kind == MODULE_KIND_HELM) {
    Ship* ship = find_ship(player->parent_ship_id);
    if (ship) {
        // Apply steering input
        ship->angular_velocity = movement_x * SHIP_TURN_RATE;
        
        // Adjust sails
        if (movement_y > 0) {
            raise_sails(ship);
        } else if (movement_y < 0) {
            lower_sails(ship);
        }
    }
}
```

## Testing Checklist

- [ ] Player can interact with helm when close enough
- [ ] Player is positioned at correct offset (-10, 0) from helm
- [ ] Player cannot move when mounted
- [ ] Player rotates with ship
- [ ] Player position updates with ship movement
- [ ] Player appears blue with anchor icon
- [ ] Helm shows as occupied (other players can't mount)
- [ ] E key triggers dismount
- [ ] Player returns to normal movement after dismount
- [ ] Module interaction failure when helm occupied
- [ ] Mount persists across network updates
- [ ] Player velocity matches ship velocity

## Integration Steps

1. ✅ **Client**: Add mount state to Player interface
2. ✅ **Client**: Handle MODULE_INTERACT_SUCCESS response
3. ✅ **Client**: Lock player position when mounted
4. ✅ **Client**: Add visual indicators (blue + anchor)
5. ⏳ **Server**: Implement handle_helm_interact()
6. ⏳ **Server**: Send mount success with offset
7. ⏳ **Server**: Lock player position in update loop
8. ⏳ **Server**: Include is_mounted in GAME_STATE
9. ⏳ **Server**: Implement dismount logic
10. ⏳ **Both**: Test end-to-end mounting flow

## Notes

- Mount offset is in ship-local coordinates
- Player world position recalculated each frame based on ship rotation
- Mounted players inherit full ship velocity (linear + angular)
- Helm can only be occupied by one player at a time
- Press E again while mounted to dismount (future feature)
- Ship controls will be enabled in next iteration
