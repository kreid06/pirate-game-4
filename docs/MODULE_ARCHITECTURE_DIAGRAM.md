# Module System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SERVER (C)                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Ship with Modules:                                                │
│  ┌──────────────────────────────────────┐                          │
│  │ Ship ID: 1                           │                          │
│  │ Position: (100, 100)                 │                          │
│  │ Rotation: 0.0                        │                          │
│  │                                      │                          │
│  │ Modules:                             │                          │
│  │   [0] typeId:0 x:-90  y:0   rot:0   │ ← HELM                   │
│  │   [1] typeId:2 x:-35  y:75  rot:π   │ ← CANNON (port)          │
│  │   [2] typeId:2 x:65   y:75  rot:π   │ ← CANNON (port)          │
│  │   [3] typeId:2 x:-35  y:-75 rot:0   │ ← CANNON (starboard)     │
│  │   [4] typeId:3 x:165  y:0   rot:0   │ ← MAST (foremast)        │
│  │   ...                                │                          │
│  └──────────────────────────────────────┘                          │
│                           │                                         │
│                           │ WebSocket                               │
│                           ▼                                         │
│  ┌────────────────────────────────────┐                            │
│  │ GAME_STATE Message (JSON)          │                            │
│  │ {                                  │                            │
│  │   "type": "GAME_STATE",            │                            │
│  │   "ships": [{                      │                            │
│  │     "id": 1,                       │                            │
│  │     "x": 100, "y": 100,            │                            │
│  │     "modules": [                   │                            │
│  │       {"id":1000, "typeId":0, ...} │                            │
│  │     ]                              │                            │
│  │   }]                               │                            │
│  │ }                                  │                            │
│  └────────────────────────────────────┘                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           │ Network (WebSocket)
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                       CLIENT (TypeScript)                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │ NetworkManager.ts (lines 698-733)                         │    │
│  │                                                            │    │
│  │  Parse GAME_STATE:                                        │    │
│  │  serverModules = ship.modules.map(mod => {               │    │
│  │    const kind = MODULE_TYPE_MAP.toKind(mod.typeId);      │    │
│  │    return {                                               │    │
│  │      id: mod.id,                                          │    │
│  │      kind: kind,              // 'cannon', 'mast', etc.   │    │
│  │      localPos: Vec2(mod.x, mod.y),                       │    │
│  │      localRot: mod.rotation                              │    │
│  │    };                                                     │    │
│  │  });                                                      │    │
│  └───────────────────────┬───────────────────────────────────┘    │
│                          │                                         │
│                          ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ modules.ts - Type System                                 │    │
│  │                                                           │    │
│  │  enum ModuleTypeId {                                     │    │
│  │    HELM = 0, SEAT = 1, CANNON = 2, MAST = 3, ...        │    │
│  │  }                                                       │    │
│  │                                                           │    │
│  │  MODULE_TYPE_MAP = {                                     │    │
│  │    toKind: (typeId) => 'cannon',  // 2 → 'cannon'       │    │
│  │    toTypeId: (kind) => 2           // 'cannon' → 2       │    │
│  │  }                                                       │    │
│  │                                                           │    │
│  │  interface ShipModule {                                  │    │
│  │    id: number;                                           │    │
│  │    kind: ModuleKind;                                     │    │
│  │    localPos: Vec2;                                       │    │
│  │    localRot: number;                                     │    │
│  │    moduleData?: ModuleData;                             │    │
│  │  }                                                       │    │
│  └───────────────────────┬───────────────────────────────────┘    │
│                          │                                         │
│                          ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ RenderSystem.ts - Rendering                              │    │
│  │                                                           │    │
│  │  Layered Rendering Queue:                                │    │
│  │  ┌─────────────────────────────────┐                     │    │
│  │  │ Layer 0: Water & Grid           │                     │    │
│  │  │ Layer 1: Ship Hull              │                     │    │
│  │  │ Layer 2: Players                │                     │    │
│  │  │ Layer 3: Planks                 │                     │    │
│  │  │ Layer 4: ████ Cannons           │ ← ship.modules     │    │
│  │  │ Layer 5: ●    Helms             │ ← .filter('helm')   │    │
│  │  │ Layer 6: ⛵   Sail Fibers        │ ← .filter('mast')   │    │
│  │  │ Layer 7: │    Mast Poles         │ ← .filter('mast')   │    │
│  │  │ Layer 8: ●    Cannonballs        │                     │    │
│  │  └─────────────────────────────────┘                     │    │
│  │                                                           │    │
│  │  drawShipCannons(ship, camera) {                         │    │
│  │    const cannons = ship.modules.filter(m =>             │    │
│  │      m.kind === 'cannon'                                │    │
│  │    );                                                    │    │
│  │    for (cannon of cannons) {                            │    │
│  │      ctx.translate(cannon.localPos.x, cannon.localPos.y);│   │
│  │      ctx.rotate(cannon.localRot);                       │    │
│  │      // Draw base + wheels                              │    │
│  │      ctx.rotate(cannonData.aimDirection);               │    │
│  │      // Draw barrel                                     │    │
│  │    }                                                     │    │
│  │  }                                                       │    │
│  │                                                           │    │
│  │  drawShipSteeringWheels(ship, camera) {                 │    │
│  │    const helms = ship.modules.filter(m =>               │    │
│  │      m.kind === 'helm' || m.kind === 'steering-wheel'   │    │
│  │    );                                                    │    │
│  │    for (helm of helms) {                                │    │
│  │      ctx.arc(helm.localPos.x, helm.localPos.y, 8, ...); │    │
│  │    }                                                     │    │
│  │  }                                                       │    │
│  │                                                           │    │
│  │  drawShipSailFibers(ship, camera) {                     │    │
│  │    const masts = ship.modules.filter(m =>               │    │
│  │      m.kind === 'mast'                                  │    │
│  │    );                                                    │    │
│  │    for (mast of masts) {                                │    │
│  │      if (mastData.openness > 0) {                       │    │
│  │        drawSailFiber(..., mastData.angle);              │    │
│  │      }                                                   │    │
│  │    }                                                     │    │
│  │  }                                                       │    │
│  └──────────────────────────────────────────────────────────┘    │
│                          │                                         │
│                          ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Canvas Output                                            │    │
│  │                                                           │    │
│  │      🌊🌊🌊🌊🌊🌊 Water                                      │    │
│  │                                                           │    │
│  │         ⛵                                                 │    │
│  │        │││  Sails (layer 6) + Masts (layer 7)            │    │
│  │       ╔═══╗                                              │    │
│  │  ████►║   ║◄████  Cannons (layer 4)                     │    │
│  │       ║   ║  Ship Hull (layer 1)                         │    │
│  │  ████►║ ● ║◄████  Helm at center aft (layer 5)          │    │
│  │       ╚═══╝  Planks (layer 3)                            │    │
│  │                                                           │    │
│  │  [Hover tooltip shows module info]                       │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
Server Ship Data
      ↓
JSON Message (GAME_STATE)
      ↓
NetworkManager Parse
      ↓
typeId → kind conversion (MODULE_TYPE_MAP)
      ↓
ShipModule[] with kind, localPos, localRot
      ↓
Ship Object in WorldState
      ↓
RenderSystem.queueWorldObjects()
      ↓
Module filtering: .filter(m => m.kind === 'cannon')
      ↓
Layer-specific draw functions
      ↓
Canvas rendering with transforms
      ↓
Visual output on screen
```

## Module Transform Hierarchy

```
World Space (0,0 at top-left)
    ↓ translate(ship.x, ship.y)
    ↓ rotate(ship.rotation)
Ship-Local Space (0,0 at ship center)
    ↓ translate(module.localPos.x, module.localPos.y)
    ↓ rotate(module.localRot)
Module-Local Space (0,0 at module center)
    ↓ [For cannons] rotate(cannonData.aimDirection)
Turret Space (barrel rotation)
```

## Example: Cannon Rendering

```
1. Server sends:
   {id: 1001, typeId: 2, x: -35, y: 75, rotation: 3.14}

2. Client parses:
   {
     id: 1001,
     kind: 'cannon',      ← MODULE_TYPE_MAP.toKind(2)
     localPos: Vec2(-35, 75),
     localRot: 3.14       ← π radians (180°, points left)
   }

3. Rendering:
   ctx.save()
   ctx.translate(ship.x, ship.y)        // World → Ship
   ctx.rotate(ship.rotation)
   
   ctx.translate(-35, 75)               // Ship → Module
   ctx.rotate(3.14)                     // Module rotation
   
   // Draw base + wheels (doesn't rotate)
   
   ctx.rotate(aimDirection)             // Turret rotation
   // Draw barrel (rotates with aim)
   
   ctx.restore()
```

## File Organization

```
client/src/
├── sim/
│   ├── modules.ts                     ← Type definitions
│   ├── ModuleSerialization.ts         ← Network utilities
│   └── ModuleNetworkExample.ts        ← Integration examples
│
├── net/
│   └── NetworkManager.ts              ← Parse server data
│       └── handleWorldState()         ← Lines 698-733
│
├── client/gfx/
│   └── RenderSystem.ts                ← Visual rendering
│       ├── drawShipCannons()          ← Layer 4
│       ├── drawShipSteeringWheels()   ← Layer 5
│       ├── drawShipSailFibers()       ← Layer 6
│       └── drawShipSailMasts()        ← Layer 7
│
└── test/
    └── BrigantineTestBuilder.ts       ← Test loadouts
        └── BROADSIDE                   ← 6 cannons + helm
```

## Summary

**The complete module pipeline:**

1. **Server** → Sends numeric `typeId` for efficiency
2. **NetworkManager** → Converts to string `kind` for usability
3. **RenderSystem** → Filters by `kind` and renders appropriately
4. **Canvas** → Shows visual representation to player

All components are implemented and working according to documentation! ✅
