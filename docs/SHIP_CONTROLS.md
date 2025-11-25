# Ship Control System

## Overview
When a player mounts the helm of a ship, their input controls switch from player movement to ship controls. This document describes the control scheme and network protocol.

## Mount/Dismount
- **Mount**: Press `E` while hovering over the helm module
- **Dismount**: Press `E` again while mounted

## Ship Controls (When Mounted to Helm)

### Sail Controls
| Key | Action | Increment | Range |
|-----|--------|-----------|-------|
| **W** | Open sails | +10% | 0-100% |
| **S** | Close sails | -10% | 0-100% |

**Behavior:**
- Each keypress changes sail openness by 10%
- Client sends desired openness to server
- Server gradually adjusts actual sail openness to match desired value
- More open sails = faster ship speed (when wind is favorable)

### Rudder Controls
| Key | Action |
|-----|--------|
| **A** | Turn left |
| **D** | Turn right |

**Behavior:**
- Holding `A` sends `turning_left: true` to server
- Holding `D` sends `turning_right: true` to server
- Releasing key sends `turning_left: false` / `turning_right: false`
- Server manages rudder angle (gradually moves to left/right when turning)
- Server automatically returns rudder to center when keys released
- Rudder angle affects ship rotation rate

### Sail Angle Controls
| Key | Action | Increment | Range |
|-----|--------|-----------|-------|
| **Shift+A** | Rotate sails left | -6° | -60° to +60° |
| **Shift+D** | Rotate sails right | +6° | -60° to +60° |

**Behavior:**
- Each keypress changes sail angle by 6 degrees
- Client sends desired angle to server
- Server adjusts all mast sail angles to match
- Sail angle affects wind efficiency based on wind direction
- 0° = sails perpendicular to ship (catching crosswinds)
- ±60° = maximum rotation for tacking

### Cannon Controls (Future)
| Action | Control |
|--------|---------|
| **Left Click** | Fire cannon (single) |
| **Right Click** | Aim cannon at mouse position |
| **Double Left Click** | Fire all cannons in range |

**Behavior (planned):**
- Cannons must be within aim range of target
- Right-click aims individual cannon
- Left-click fires aimed cannon
- Double left-click fires broadside (all cannons on one side)

## Network Protocol

### Client → Server Messages

#### 1. Sail Openness Control
```typescript
{
  type: "ship_sail_control",
  timestamp: number,
  desired_openness: number  // 0-100 in increments of 10
}
```

#### 2. Rudder Control
```typescript
{
  type: "ship_rudder_control",
  timestamp: number,
  turning_left: boolean,
  turning_right: boolean
}
```

#### 3. Sail Angle Control
```typescript
{
  type: "ship_sail_angle_control",
  timestamp: number,
  desired_angle: number  // -60 to +60 in increments of 6
}
```

### Server → Client State

The server includes mount state and controlling ship in player data:

```json
{
  "id": 1000,
  "is_mounted": true,
  "mounted_module_id": 1000,
  "controlling_ship": 1,
  "parent_ship": 1,
  "local_x": -100,
  "local_y": 0,
  ...
}
```

## Implementation Details

### Client-Side

**InputManager.ts:**
- `setMountState(mounted: boolean, shipId?: number)` - Enable/disable ship controls
- `handleShipControls()` - Process ship control inputs when mounted
- Ship control state tracking:
  - `currentSailOpenness: number` (0-100)
  - `currentSailAngle: number` (-60 to +60)
  - `lastRudderState: { left: boolean, right: boolean }`

**NetworkManager.ts:**
- `sendShipSailControl(desiredOpenness: number)` - Send sail adjustment
- `sendShipRudderControl(turningLeft: boolean, turningRight: boolean)` - Send rudder state
- `sendShipSailAngleControl(desiredAngle: number)` - Send sail rotation

**ClientApplication.ts:**
- Wires up ship control callbacks from InputManager to NetworkManager
- Updates InputManager mount state when player mounts/dismounts helm
- Monitors server world state for mount changes (server can force dismount)

### Server-Side (To Be Implemented)

**Required handlers:**
- `handle_ship_sail_control()` - Adjust mast openness to desired value
- `handle_ship_rudder_control()` - Set rudder turning state
- `handle_ship_sail_angle_control()` - Rotate mast sail angles

**Physics integration:**
- Rudder creates angular force proportional to ship velocity
- Sail openness affects forward thrust from wind
- Sail angle affects wind efficiency (dot product with wind direction)
- Server gradually interpolates sail/rudder to desired values (smooth animation)

## Control Flow

### Mounting Helm
1. Player presses `E` near helm → `MODULE_INTERACT` sent to server
2. Server validates interaction → `MODULE_INTERACT_SUCCESS` sent to client
3. Client calls `inputManager.setMountState(true, shipId)`
4. InputManager switches to ship control mode
5. Player movement keys now control ship instead

### Operating Ship
1. Player presses `W` → `currentSailOpenness += 10`
2. Client sends `SHIP_SAIL_CONTROL` with new openness
3. Server gradually opens sails to match
4. Player holds `A` → Client sends `turning_left: true`
5. Server sets rudder angle to left
6. Player releases `A` → Client sends `turning_left: false`
7. Server returns rudder to center

### Dismounting
1. Player presses `E` while mounted → `dismount` action sent
2. Server clears mount state
3. Server sends `GAME_STATE` with `is_mounted: false`
4. Client detects mount state change in world state
5. Client calls `inputManager.setMountState(false)`
6. InputManager switches back to player movement mode

## Future Enhancements

### Visual Feedback
- Rudder visualization (rotates left/right)
- Sail animation (opening/closing, rotating)
- Wind direction indicator
- Speed/heading indicators

### Advanced Controls
- Cannon aiming reticle
- Cannon range indicators
- Crew member AI (auto-manage sails)
- Formation sailing (multiple ships)

### Multiplayer
- Multiple players can control different modules
- Helmsman steers, gunners aim cannons
- Dedicated roles (captain, gunner, sailor)

## Testing

### Manual Testing Steps
1. Board ship and press `E` on helm
2. Verify console shows: `⚓ [INPUT] Player mounted to helm on ship X - ship controls active`
3. Press `W` repeatedly - check console for sail openness increases
4. Press `S` repeatedly - check console for sail openness decreases
5. Hold `A` - check console for `🚢 Rudder: LEFT`
6. Release `A` - check console for `🚢 Rudder: STRAIGHT`
7. Hold `Shift+A` - check console for sail angle decreases
8. Press `E` again - verify dismount and return to player controls

### Debug Logging
All ship control messages log to console:
- `⛵ Sail control: 80% openness`
- `🚢 Rudder: LEFT / RIGHT / STRAIGHT`
- `🌀 Sail angle: 12°`

## Related Files
- `client/src/client/gameplay/InputManager.ts` - Input handling and ship controls
- `client/src/net/NetworkManager.ts` - Network message sending
- `client/src/client/ClientApplication.ts` - Control callback wiring
- `server/src/net/websocket_server.c` - Server message handlers (to be implemented)
