# Brigantine Physics Integration

## Overview
Integrated shared ship definitions from `protocol/ship_definitions.h` into the server's ship initialization and physics system. The server now uses the same brigantine physics properties as the client for consistent simulation.

## Changes Made

### 1. Updated `SimpleShip` Structure
**File**: `server/include/net/websocket_server.h`

Added physics property fields to the `SimpleShip` struct:
```c
typedef struct SimpleShip {
    uint32_t ship_id;
    uint32_t ship_type;
    float x, y;
    float rotation;
    float velocity_x, velocity_y;
    float angular_velocity;
    
    // Physics properties (from ship definitions)
    float mass;              // Ship mass (kg)
    float moment_of_inertia; // Rotational inertia (kg⋅m²)
    float max_speed;         // Maximum speed (m/s)
    float turn_rate;         // Maximum turn rate (rad/s)
    float water_drag;        // Linear drag coefficient (0-1)
    float angular_drag;      // Angular drag coefficient (0-1)
    
    float deck_min_x, deck_max_x;
    float deck_min_y, deck_max_y;
    bool active;
} SimpleShip;
```

### 2. Included Ship Definitions Header
**File**: `server/src/net/websocket_server.c`

Added include at top of file:
```c
#include "../../protocol/ship_definitions.h"
```

### 3. Updated Ship Initialization
**File**: `server/src/net/websocket_server.c` (lines 584-608)

Replaced hard-coded values with brigantine constants:
```c
// Initialize a test ship away from origin (using brigantine physics from protocol/ship_definitions.h)
ships[0].ship_id = next_ship_id++;
ships[0].ship_type = 3;  // Brigantine
ships[0].x = 100.0f;
ships[0].y = 100.0f;
ships[0].rotation = 0.0f;
ships[0].velocity_x = 0.0f;
ships[0].velocity_y = 0.0f;
ships[0].angular_velocity = 0.0f;

// Physics properties from brigantine ship definition
ships[0].mass = BRIGANTINE_MASS;
ships[0].moment_of_inertia = BRIGANTINE_MOMENT_OF_INERTIA;
ships[0].max_speed = BRIGANTINE_MAX_SPEED;
ships[0].turn_rate = BRIGANTINE_TURN_RATE;
ships[0].water_drag = BRIGANTINE_WATER_DRAG;
ships[0].angular_drag = BRIGANTINE_ANGULAR_DRAG;

ships[0].deck_min_x = -8.0f;
ships[0].deck_max_x = 8.0f;
ships[0].deck_min_y = -6.0f;
ships[0].deck_max_y = 6.0f;
ships[0].active = true;
ship_count = 1;
log_info("🚢 Initialized test ship (ID: %u, Type: Brigantine, Mass: %.0f kg, Inertia: %.0f kg⋅m²) at (%.1f, %.1f)", 
         ships[0].ship_id, ships[0].mass, ships[0].moment_of_inertia, ships[0].x, ships[0].y);
```

## Brigantine Physics Properties

From `protocol/ship_definitions.h`:

| Property | Value | Unit | Description |
|----------|-------|------|-------------|
| **BRIGANTINE_MASS** | 5000.0 | kg | Ship mass for physics calculations |
| **BRIGANTINE_MOMENT_OF_INERTIA** | 500000.0 | kg⋅m² | Rotational inertia |
| **BRIGANTINE_MAX_SPEED** | 30.0 | m/s | Maximum velocity |
| **BRIGANTINE_TURN_RATE** | 0.5 | rad/s | Maximum angular velocity |
| **BRIGANTINE_WATER_DRAG** | 0.98 | 0-1 | Linear velocity damping (2% drag per tick) |
| **BRIGANTINE_ANGULAR_DRAG** | 0.95 | 0-1 | Angular velocity damping (5% drag per tick) |
| **BRIGANTINE_LENGTH** | 760 | units | Overall ship length |
| **BRIGANTINE_BEAM** | 180 | units | Ship width |

## Testing

Server successfully compiles and runs with brigantine physics:

```
[21:06:40 websocket_server.c:608] 🚢 Initialized test ship (ID: 1, Type: Brigantine, Mass: 5000 kg, Inertia: 500000 kg⋅m²) at (100.0, 100.0)
```

## Next Steps

### 1. Apply Drag in Physics Tick
Currently the drag coefficients are stored but not applied. Need to update the physics tick function:

```c
void apply_ship_physics(SimpleShip* ship, float dt) {
    // Apply water drag to linear velocity
    ship->velocity_x *= ship->water_drag;
    ship->velocity_y *= ship->water_drag;
    
    // Apply angular drag
    ship->angular_velocity *= ship->angular_drag;
    
    // Clamp to max speed
    float speed = sqrtf(ship->velocity_x * ship->velocity_x + ship->velocity_y * ship->velocity_y);
    if (speed > ship->max_speed) {
        float scale = ship->max_speed / speed;
        ship->velocity_x *= scale;
        ship->velocity_y *= scale;
    }
    
    // Clamp angular velocity to turn rate
    if (ship->angular_velocity > ship->turn_rate) {
        ship->angular_velocity = ship->turn_rate;
    } else if (ship->angular_velocity < -ship->turn_rate) {
        ship->angular_velocity = -ship->turn_rate;
    }
}
```

### 2. Generate Hull Polygon
For collision detection, generate the 49-point hull using `generate_brigantine_hull()`:

```c
Vec2 hull[49];
generate_brigantine_hull(hull);
```

This requires either:
- Adding `Vec2 hull_points[49]` to `SimpleShip` struct
- Creating a separate hull storage system
- Computing hull on-demand for collision checks

### 3. Calculate Deck Boundaries from Hull
Current deck boundaries are hard-coded. Should calculate from actual hull geometry:

```c
// After generating hull, find min/max for deck area
float deck_min_x = hull[0].x, deck_max_x = hull[0].x;
float deck_min_y = hull[0].y, deck_max_y = hull[0].y;
for (int i = 1; i < 49; i++) {
    if (hull[i].x < deck_min_x) deck_min_x = hull[i].x;
    if (hull[i].x > deck_max_x) deck_max_x = hull[i].x;
    if (hull[i].y < deck_min_y) deck_min_y = hull[i].y;
    if (hull[i].y > deck_max_y) deck_max_y = hull[i].y;
}
```

### 4. Ship-to-Ship Collision
Use hull polygons for accurate ship-to-ship collision detection using SAT (Separating Axis Theorem) or GJK algorithm.

## Benefits

✅ **Consistent Physics**: Client and server use identical ship properties  
✅ **Shared Definitions**: Single source of truth in `protocol/ship_definitions.h`  
✅ **Easy Updates**: Change one file to update both client and server  
✅ **Type Safety**: C header file ensures compile-time type checking  
✅ **Documentation**: Physics properties clearly documented in protocol folder  

## Related Files

- `protocol/ship_definitions.h` - C header with brigantine constants and hull generator
- `protocol/ship_definitions.json` - Human-readable ship specifications  
- `protocol/SHIP_DEFINITIONS.md` - Documentation of hull generation algorithm
- `protocol/examples/example_ship_usage.c` - Usage examples
- `docs/HYBRID_INPUT_PROTOCOL.md` - Related: Ship movement with hybrid input
