# Module Data Quick Reference

## Server → Client Module Format

```typescript
{
  id: number,        // Unique module ID (e.g., 1000, 1001, ...)
  typeId: number,    // 0=HELM, 1=SEAT, 2=CANNON, 3=MAST, 5=LADDER, 6=PLANK, 7=DECK
  x: number,         // Position X (ship-relative, client coordinates)
  y: number,         // Position Y (ship-relative, client coordinates)  
  rotation: number   // Rotation in radians (ship-relative)
}
```

## Module Type Mapping

| typeId | ModuleKind | Description |
|--------|------------|-------------|
| 0 | `'helm'` | Steering wheel |
| 1 | `'seat'` | Crew seating |
| 2 | `'cannon'` | Offensive weapon |
| 3 | `'mast'` | Sail system |
| 4 | `'steering-wheel'` | Alternative helm |
| 5 | `'ladder'` | Boarding ladder |
| 6 | `'plank'` | Hull segment |
| 7 | `'deck'` | Floor surface |
| 255 | `'custom'` | User-defined |

## Conversion Utilities

```typescript
import { MODULE_TYPE_MAP } from './sim/modules.js';

// Numeric → String
const kind = MODULE_TYPE_MAP.toKind(2);  // 'cannon'

// String → Numeric  
const typeId = MODULE_TYPE_MAP.toTypeId('mast');  // 3
```

## Parsing Example

```typescript
// In GAME_STATE handler
const modules = ship.modules.map((mod: any) => ({
  id: mod.id,
  kind: MODULE_TYPE_MAP.toKind(mod.typeId),
  localPos: Vec2.from(mod.x, mod.y),
  localRot: mod.rotation
}));
```

## Rendering Pattern

```typescript
ctx.save();
ctx.translate(ship.x, ship.y);
ctx.rotate(ship.rotation);

ship.modules.forEach(module => {
  ctx.save();
  ctx.translate(module.localPos.x, module.localPos.y);
  ctx.rotate(module.localRot);
  
  renderModuleByKind(module.kind);
  
  ctx.restore();
});

ctx.restore();
```

## BROADSIDE Loadout Example

```
Position conventions:
- X: negative = aft, positive = fore
- Y: positive = port, negative = starboard
- Rotation: 0 = forward, π = backward

Modules:
  HELM:    (-90, 0)     rot: 0
  CANNONS: Port y=75, Starboard y=-75
           x positions: -135, -35, 65
  MASTS:   (165, 0), (-35, 0), (-235, 0)
```

## Integration Checklist

- ✅ Import `MODULE_TYPE_MAP` from `modules.js`
- ✅ Parse `ship.modules` array in GAME_STATE handler  
- ✅ Convert `typeId` to `kind` string
- ✅ Use `localPos` and `localRot` for rendering
- ✅ Render modules in ship-local coordinate space
- ✅ Apply module-specific visuals based on `kind`

## File Locations

- **Client Types**: `client/src/sim/modules.ts`
- **Network Handler**: `client/src/net/NetworkManager.ts`
- **Documentation**: `docs/CLIENT_MODULE_INTEGRATION.md`
- **Protocol Spec**: `docs/MODULE_NETWORK_PROTOCOL.md`
