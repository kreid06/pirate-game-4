# Module Network Protocol - Hybrid Approach

## Overview

The hybrid module serialization system optimizes network bandwidth while maintaining code readability.

## Design Principles

1. **Dual Identification**: Each module has both a string `kind` (for code) and numeric `ModuleTypeId` (for network)
2. **Full State + Deltas**: Send complete state initially, then only changes
3. **Bandwidth Optimization**: ~40% reduction in module data transmission

## Module Type IDs

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

## Network Protocol

### 1. Initial Ship Sync (Full State)

**Server → Client**

```typescript
{
  type: 'SHIP_SYNC',
  shipId: 1234,
  modules: [
    {
      id: 1001,
      typeId: 2,        // CANNON (1 byte vs ~6 bytes for "cannon")
      deckId: 0,
      pos: [50, -60],   // Compact Vec2
      rot: -1.57,
      stateBits: 16,
      data: {           // Only essential properties
        aimDirection: 0,
        ammunition: 10,
        timeSinceLastFire: 0
      }
    },
    // ... more modules
  ]
}
```

**Bandwidth Savings:**
- String-based: `"cannon"` = 6 bytes + JSON overhead
- Type ID: `2` = 1 byte
- **83% reduction** on type field alone

### 2. Delta Updates (Changed Properties Only)

**Server → Client**

```typescript
{
  type: 'MODULE_UPDATE',
  shipId: 1234,
  updates: [
    {
      id: 1001,                    // Which module
      property: 'moduleData.aimDirection',  // What changed
      value: 1.57                  // New value
    },
    {
      id: 1002,
      property: 'moduleData.ammunition',
      value: 9
    }
  ]
}
```

**Bandwidth Savings:**
- Full module resend: ~50 bytes
- Delta update: ~15 bytes
- **70% reduction** for updates

### 3. Batch Updates (Multiple Changes)

For frequently updated properties (cannons aiming, sails adjusting):

```typescript
{
  type: 'MODULE_BATCH',
  shipId: 1234,
  timestamp: 1234567890,
  updates: [
    { id: 1001, property: 'moduleData.aimDirection', value: 1.57 },
    { id: 1002, property: 'moduleData.aimDirection', value: -1.57 },
    { id: 1003, property: 'moduleData.openness', value: 85 }
  ]
}
```

## Usage Examples

### Server-Side: Initial Sync

```typescript
import { ModuleSerialization } from './ModuleSerialization';

function sendShipSync(socket, ship) {
  const modules = ship.modules.map(m => 
    ModuleSerialization.serializeModule(m)
  );
  
  socket.send({
    type: 'SHIP_SYNC',
    shipId: ship.id,
    modules
  });
}
```

### Client-Side: Receive Sync

```typescript
function handleShipSync(data) {
  const modules = data.modules.map(m => 
    ModuleSerialization.deserializeModule(m)
  );
  
  updateShip(data.shipId, { modules });
}
```

### Server-Side: Send Delta Update

```typescript
function onCannonAim(shipId, moduleId, newAngle) {
  const update = ModuleSerialization.createDeltaUpdate(
    moduleId,
    'moduleData.aimDirection',
    newAngle
  );
  
  broadcastToNearbyPlayers(shipId, {
    type: 'MODULE_UPDATE',
    shipId,
    updates: [update]
  });
}
```

### Client-Side: Apply Delta Update

```typescript
function handleModuleUpdate(data) {
  const ship = getShip(data.shipId);
  
  for (const update of data.updates) {
    const module = ship.modules.find(m => m.id === update.id);
    if (module) {
      ModuleSerialization.applyDeltaUpdate(module, update);
    }
  }
}
```

## Bandwidth Analysis

### Example: 20-module ship

**Initial Sync:**
- String-based: 20 × 50 bytes = **1,000 bytes**
- Hybrid approach: 20 × 30 bytes = **600 bytes**
- **Savings: 40%**

**Per-Frame Updates (5 modules):**
- Full resend: 5 × 50 bytes = **250 bytes**
- Delta updates: 5 × 15 bytes = **75 bytes**
- **Savings: 70%**

**60 FPS over 10 seconds:**
- Full resend: 600 × 250 bytes = **150 KB**
- Delta updates: 600 × 75 bytes = **45 KB**
- **Savings: 105 KB (70%)**

## Property Update Frequency Guide

### High Frequency (every frame)
- Cannon `aimDirection`
- Mast `angle` (sail rotation)
- Helm `wheelRotation`

**Recommendation:** Batch updates, send every 2-3 frames

### Medium Frequency (occasional)
- Mast `openness` (sail deployment)
- Cannon `ammunition`
- Plank `health`

**Recommendation:** Send immediately as deltas

### Low Frequency (rare)
- Module `stateBits`
- Structural changes

**Recommendation:** Send immediately, important for gameplay

## Best Practices

1. **Initial Sync**: Use full serialization for new players joining
2. **Delta Updates**: Use for all runtime changes
3. **Batching**: Group multiple updates per ship per frame
4. **Throttling**: Limit high-frequency updates (e.g., 20Hz for cannon aim)
5. **Priority**: Critical updates (damage, ammunition) take precedence

## Migration Path

1. ✅ **Phase 1**: Implement `ModuleTypeId` and mapping (DONE)
2. ✅ **Phase 2**: Create serialization utilities (DONE)
3. **Phase 3**: Update network managers to use new format
4. **Phase 4**: Server-side implementation in C
5. **Phase 5**: Performance testing and optimization

## C Server Integration

For the C server, create equivalent enum:

```c
typedef enum {
    MODULE_TYPE_HELM = 0,
    MODULE_TYPE_SEAT = 1,
    MODULE_TYPE_CANNON = 2,
    MODULE_TYPE_MAST = 3,
    MODULE_TYPE_STEERING_WHEEL = 4,
    MODULE_TYPE_LADDER = 5,
    MODULE_TYPE_PLANK = 6,
    MODULE_TYPE_DECK = 7,
    MODULE_TYPE_CUSTOM = 255
} ModuleTypeId;
```

## Testing

```typescript
// Verify bandwidth savings
const savings = ModuleSerialization.estimateBandwidthSavings(20);
console.log(`String-based: ${savings.stringBased} bytes`);
console.log(`Hybrid: ${savings.hybridApproach} bytes`);
console.log(`Savings: ${savings.savingsPercent.toFixed(1)}%`);
```

Expected output:
```
String-based: 1000 bytes
Hybrid: 600 bytes
Savings: 40.0%
```
