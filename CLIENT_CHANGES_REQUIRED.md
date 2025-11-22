# Client Changes Required for Brigantine Physics

## Quick Summary

The server now broadcasts brigantine physics properties in every `GAME_STATE` message. The client needs to:

1. **Update TypeScript interfaces** to include physics properties
2. **Extract physics data** from GAME_STATE messages
3. **Apply physics** in client-side prediction
4. **Generate hull polygon** for collision detection
5. **Use ship definitions** as fallback defaults

## Key Changes

### 1. Server Now Broadcasts Physics Properties ✅

Every `GAME_STATE` message now includes ship physics:

```json
{
  "type": "GAME_STATE",
  "ships": [{
    "id": 1,
    "x": 100.0,
    "y": 100.0,
    "rotation": 0.0,
    "velocity_x": 0.0,
    "velocity_y": 0.0,
    "angular_velocity": 0.0,
    "mass": 5000.0,                    // NEW
    "moment_of_inertia": 500000.0,     // NEW
    "max_speed": 30.0,                 // NEW
    "turn_rate": 0.5,                  // NEW
    "water_drag": 0.98,                // NEW
    "angular_drag": 0.95               // NEW
  }]
}
```

### 2. Client Must Extract and Use These Properties

**TypeScript Interface Update** (`NetworkManager.ts`):
```typescript
interface Ship {
    id: number;
    x: number;
    y: number;
    rotation: number;
    velocity_x: number;
    velocity_y: number;
    angular_velocity: number;
    mass: number;              // Add these
    moment_of_inertia: number; // Add these
    max_speed: number;         // Add these
    turn_rate: number;         // Add these
    water_drag: number;        // Add these
    angular_drag: number;      // Add these
}
```

**Physics Application** (`PredictionEngine.ts`):
```typescript
// Apply drag every frame
ship.velocity.x *= ship.waterDrag;
ship.velocity.y *= ship.waterDrag;
ship.angularVelocity *= ship.angularDrag;

// Clamp to max speed
const speed = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.y ** 2);
if (speed > ship.maxSpeed) {
    const scale = ship.maxSpeed / speed;
    ship.velocity.x *= scale;
    ship.velocity.y *= scale;
}

// Clamp angular velocity
ship.angularVelocity = Math.max(
    -ship.turnRate,
    Math.min(ship.turnRate, ship.angularVelocity)
);
```

### 3. Hull Polygon Generation

The client should generate the brigantine hull (49-point polygon) for collision detection:

```typescript
import { generateBrigantineHull } from './ShipDefinitions';

const hull = generateBrigantineHull(); // Returns Vec2[49]
```

This hull matches the server's physics body exactly.

## Complete Implementation Guide

See `docs/CLIENT_BRIGANTINE_PHYSICS_GUIDE.md` for:
- Complete code examples
- Step-by-step implementation
- Hull generation algorithm
- Collision detection setup
- Testing checklist

## Files to Modify

| File | Changes Required |
|------|------------------|
| `client/src/net/NetworkManager.ts` | Add physics fields to Ship interface, extract from GAME_STATE |
| `client/src/sim/Types.ts` | Add physics properties to Ship type |
| `client/src/net/PredictionEngine.ts` | Apply drag, clamp speed/turn rate |
| `client/src/common/ShipDefinitions.ts` | Create with brigantine constants and hull generator |
| `client/src/sim/CollisionSystem.ts` | Use hull polygon for collision detection |

## Benefits

✅ **Client-server physics consistency** - Same drag, speed, and turn limits  
✅ **Accurate prediction** - Client predicts exactly what server simulates  
✅ **Proper collisions** - Hull polygon matches server physics body  
✅ **Smooth gameplay** - No sudden corrections from server  
✅ **Easy debugging** - Can compare client vs server physics values  

## Testing

1. Connect to server and inspect GAME_STATE messages
2. Verify physics properties are received: `mass: 5000`, `max_speed: 30`, etc.
3. Test that ship doesn't exceed max_speed (30 m/s)
4. Verify drag is applied (velocity slowly decreases)
5. Check angular velocity clamped to turn_rate (0.5 rad/s)
6. Test ship-to-ship collision with hull polygons

## Next Steps for Client

1. ✅ Server broadcasts physics properties
2. → Update client TypeScript interfaces
3. → Extract physics from GAME_STATE
4. → Apply physics in prediction engine
5. → Generate hull polygon
6. → Test collision detection
7. → Verify physics match server

---

**Full Documentation**: `docs/CLIENT_BRIGANTINE_PHYSICS_GUIDE.md`
