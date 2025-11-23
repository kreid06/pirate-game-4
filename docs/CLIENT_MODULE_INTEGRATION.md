# Client Module Integration Guide

## Overview

This guide explains how to handle module data in `GAME_STATE` updates from the server. The server now sends complete module information for all ships, enabling clients to render cannons, masts, helms, and other ship modules accurately.

## GAME_STATE Message Format

### Complete Message Structure

```json
{
  "type": "GAME_STATE",
  "tick": 1461,
  "timestamp": 48690,
  "ships": [
    {
      "id": 1,
      "x": 100.0,
      "y": 100.0,
      "rotation": 0.000,
      "velocity_x": 0.00,
      "velocity_y": 0.00,
      "angular_velocity": 0.000,
      "mass": 5000.0,
      "moment_of_inertia": 500000.0,
      "max_speed": 15.0,
      "turn_rate": 1.0,
      "water_drag": 0.950,
      "angular_drag": 0.900,
      "modules": [
        {
          "id": 1000,
          "typeId": 0,
          "x": -90.0,
          "y": 0.0,
          "rotation": 0.00
        },
        {
          "id": 1001,
          "typeId": 2,
          "x": -35.0,
          "y": 75.0,
          "rotation": 3.14
        }
        // ... more modules
      ]
    }
  ],
  "players": [...],
  "projectiles": [...]
}
```

## Module Data Format

### Module Fields

Each module in the `modules` array contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique module identifier (globally unique) |
| `typeId` | number | Numeric module type (see Module Types below) |
| `x` | number | X position relative to ship center (client coordinates) |
| `y` | number | Y position relative to ship center (client coordinates) |
| `rotation` | number | Module rotation in radians (ship-relative) |

### Module Types (typeId)

The `typeId` field uses numeric identifiers for network efficiency:

```typescript
enum ModuleTypeId {
  HELM = 0,           // Steering wheel
  SEAT = 1,           // Crew seating
  CANNON = 2,         // Offensive weapon
  MAST = 3,           // Sail system
  STEERING_WHEEL = 4, // Alternative helm
  LADDER = 5,         // Boarding ladder
  PLANK = 6,          // Hull segment
  DECK = 7,           // Floor surface
  CUSTOM = 255        // User-defined
}
```

### Coordinate System

- **Position (`x`, `y`)**: Relative to ship center in **client coordinates**
  - Server automatically converts from internal units (10x scale factor)
  - Ready to use directly for rendering
  - Example: Helm at (-90, 0) means 90 pixels left of ship center

- **Rotation**: In radians, relative to ship orientation
  - 0 = pointing forward (along ship's direction)
  - π (3.14) = pointing backward
  - π/2 = pointing to port (left)
  - -π/2 = pointing to starboard (right)

## Client Integration

### 1. Parsing Module Data

The `NetworkManager.ts` automatically parses module data:

```typescript
// Server module format -> Client ShipModule format
const serverModules = ship.modules.map((mod: any) => {
  const kind = MODULE_TYPE_MAP.toKind(mod.typeId);
  
  return {
    id: mod.id,
    kind: kind,                            // 'helm', 'cannon', 'mast', etc.
    deckId: 0,
    localPos: Vec2.from(mod.x, mod.y),     // Already in client coordinates
    localRot: mod.rotation,
    occupiedBy: null,
    stateBits: 0,
    moduleData: undefined                   // Can be enhanced later
  } as ShipModule;
});
```

### 2. Converting TypeId to ModuleKind

Use the `MODULE_TYPE_MAP` utility:

```typescript
import { MODULE_TYPE_MAP, ModuleTypeId } from './sim/modules.js';

// Convert numeric typeId to string kind
const kind = MODULE_TYPE_MAP.toKind(2);  // Returns 'cannon'

// Convert string kind to numeric typeId
const typeId = MODULE_TYPE_MAP.toTypeId('mast');  // Returns 3
```

### 3. Rendering Modules

Modules should be rendered in ship-local coordinate space:

```typescript
// Pseudo-code for rendering
ships.forEach(ship => {
  ctx.save();
  ctx.translate(ship.position.x, ship.position.y);
  ctx.rotate(ship.rotation);
  
  // Render hull first
  renderHull(ship.hull);
  
  // Render modules on top of hull
  ship.modules.forEach(module => {
    ctx.save();
    ctx.translate(module.localPos.x, module.localPos.y);
    ctx.rotate(module.localRot);
    
    // Render based on module kind
    switch (module.kind) {
      case 'helm':
        renderHelm(module);
        break;
      case 'cannon':
        renderCannon(module);
        break;
      case 'mast':
        renderMast(module);
        break;
      // ... other types
    }
    
    ctx.restore();
  });
  
  ctx.restore();
});
```

### 4. Module-Specific Rendering

Different module types should be rendered differently:

**Helm (typeId: 0)**
- Small circular indicator
- Typically rendered at ship's aft
- Visual: Steering wheel icon or circle

**Cannon (typeId: 2)**
- Directional barrel pointing at `rotation`
- Position indicates port/starboard placement
- Visual: Gray barrel extending forward from base

**Mast (typeId: 3)**
- Vertical pole with sail attachment
- Position indicates fore/middle/aft placement
- Visual: Tall pole with sail rectangle

**Seat (typeId: 1)**
- Small square or circular marker
- Position indicates crew station
- Visual: Simple icon or colored square

## Example: BROADSIDE Loadout

A typical brigantine with BROADSIDE loadout has:

```
10 total modules:
├─ 1 HELM (id:1000, typeId:0)
│  └─ Position: (-90, 0) - Center aft
│
├─ 6 CANNONS (typeId:2)
│  ├─ Port side (y = 75):
│  │  ├─ id:1001 at (-35, 75) rotation: π
│  │  ├─ id:1002 at (65, 75) rotation: π
│  │  └─ id:1003 at (-135, 75) rotation: π
│  │
│  └─ Starboard side (y = -75):
│     ├─ id:1004 at (-35, -75) rotation: 0
│     ├─ id:1005 at (65, -75) rotation: 0
│     └─ id:1006 at (-135, -75) rotation: 0
│
└─ 3 MASTS (typeId:3)
   ├─ Foremast: id:1007 at (165, 0)
   ├─ Mainmast: id:1008 at (-35, 0)
   └─ Mizzenmast: id:1009 at (-235, 0)
```

## Update Frequency

- Modules are sent in **every GAME_STATE** message (20-30 Hz)
- Module positions/rotations are **ship-relative** (don't change unless ship reconfigured)
- Future: Delta updates will only send changed module data for bandwidth efficiency

## Future Enhancements

The server will eventually support:

1. **Module State Updates**: Track which modules are damaged, occupied, or active
2. **Delta Protocol**: Send only changed module properties instead of full state
3. **Cannon Aim Direction**: Real-time cannon aiming updates
4. **Sail State**: Mast openness percentage and wind efficiency
5. **Module Health**: Plank integrity and damage state

## TypeScript Types

Client types defined in `client/src/sim/modules.ts`:

```typescript
interface ShipModule {
  id: number;
  kind: ModuleKind;
  deckId: number;
  localPos: Vec2;
  localRot: number;
  occupiedBy: number | null;
  stateBits: number;
  moduleData?: ModuleData;
}

type ModuleKind = 
  | 'helm' 
  | 'seat' 
  | 'cannon' 
  | 'mast' 
  | 'steering-wheel' 
  | 'ladder' 
  | 'plank' 
  | 'deck' 
  | 'custom';
```

## Bandwidth Considerations

Current module data size per ship:
- 10 modules × ~25 bytes/module = ~250 bytes
- Total GAME_STATE with modules: ~500-800 bytes
- At 30 Hz: ~15-24 KB/s per client

**Optimization**: Future delta updates will reduce this by 40-70% by only sending:
- Changed module properties
- Active modules (cannons firing, sails adjusting)
- Damaged/destroyed modules

## Testing

Test files provided:
- `server/test_websocket_modules.html` - Browser-based WebSocket client
- `server/test_modules_client.js` - Node.js verification script

Both display received module data for debugging and verification.

## Debugging

To verify module data reception:

```typescript
// Add to your GAME_STATE handler
console.log('Received ship with modules:', {
  shipId: ship.id,
  moduleCount: ship.modules?.length || 0,
  modules: ship.modules?.map(m => ({
    id: m.id,
    type: MODULE_TYPE_MAP.toKind(m.typeId),
    pos: [m.x, m.y],
    rot: m.rotation
  }))
});
```

## Summary

1. **Server sends** module data in every GAME_STATE message
2. **Modules array** contains: `{id, typeId, x, y, rotation}`
3. **Coordinates** are ship-relative and in client units (ready to render)
4. **Use MODULE_TYPE_MAP** to convert numeric typeId to string kind
5. **Render modules** in ship-local space after applying ship transform
6. **Module types** determine visual representation (helm, cannon, mast, etc.)

The module system provides the foundation for interactive ship gameplay, including cannon firing, sail management, and player-module interactions!
