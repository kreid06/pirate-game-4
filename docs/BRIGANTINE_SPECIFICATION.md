# Brigantine Ship - Complete Specification

This document defines the complete brigantine ship specification including physics, dimensions, hull geometry, and module data expected from the server.

## Physics Properties

These values MUST match between client (`ShipDefinitions.ts`) and server (`ship_definitions.h`):

| Property | Value | Unit | Description |
|----------|-------|------|-------------|
| **mass** | 5000.0 | kg | Ship mass for physics calculations |
| **momentOfInertia** | 500000.0 | kg⋅m² | Rotational inertia |
| **maxSpeed** | 30.0 | m/s | Maximum linear velocity magnitude |
| **turnRate** | 0.5 | rad/s | Maximum angular velocity |
| **waterDrag** | 0.98 | coefficient | Linear velocity damping (98% retained per tick = 2% drag) |
| **angularDrag** | 0.95 | coefficient | Angular velocity damping (95% retained per tick = 5% drag) |

### Physics Constants (TypeScript)

```typescript
export const BRIGANTINE_PHYSICS = {
  mass: 5000.0,
  momentOfInertia: 500000.0,
  maxSpeed: 30.0,
  turnRate: 0.5,
  waterDrag: 0.98,
  angularDrag: 0.95,
} as const;
```

### Physics Constants (C)

```c
#define BRIGANTINE_MASS 5000.0f
#define BRIGANTINE_MOMENT_OF_INERTIA 500000.0f
#define BRIGANTINE_MAX_SPEED 30.0f
#define BRIGANTINE_TURN_RATE 0.5f
#define BRIGANTINE_WATER_DRAG 0.98f
#define BRIGANTINE_ANGULAR_DRAG 0.95f
```

---

## Dimensions

| Dimension | Value | Unit | Description |
|-----------|-------|------|-------------|
| **length** | 760 | units | Overall length (stern_tip to bow_tip) |
| **beam** | 180 | units | Maximum width (port to starboard) |

**Visual Reference:**
```
        bow_tip (415, 0)
           /\
          /  \
   bow (190, 90)    bow (190, -90)
         |              |
         |              |
stern (−260, 90)  stern (−260, −90)
         \              /
          \            /
       stern_tip (−345, 0)
       
Length: 760 units (from −345 to 415)
Beam: 180 units (from −90 to 90)
```

---

## Hull Geometry

### Hull Control Points (Ship-Local Coordinates)

| Point | X | Y | Description |
|-------|---|---|-------------|
| **bow** | 190 | 90 | Forward starboard corner |
| **bow_tip** | 415 | 0 | Forward-most point |
| **bow_bottom** | 190 | -90 | Forward port corner |
| **stern_bottom** | -260 | -90 | Aft port corner |
| **stern_tip** | -345 | 0 | Aft-most point |
| **stern** | -260 | 90 | Aft starboard corner |

### Hull Generation Algorithm

The hull is a **49-point polygon** generated using:

1. **Bow Curve** (13 points): Quadratic Bézier from `bow → bow_tip → bow_bottom`
2. **Starboard Side** (12 points): Linear interpolation from `bow_bottom → stern_bottom`
3. **Stern Curve** (12 points): Quadratic Bézier from `stern_bottom → stern_tip → stern`
4. **Port Side** (11 points): Linear interpolation from `stern → bow`
5. **Total**: 48 explicit points + 1 closure = 49 points

**Quadratic Bézier Formula:**
```
B(t) = (1-t)² * P0 + 2(1-t)t * P1 + t² * P2
where t ∈ [0, 1]
```

**Linear Interpolation Formula:**
```
L(t) = P0 + t * (P1 - P0)
where t ∈ [0, 1]
```

### Hull Points Array (TypeScript)

```typescript
export const BRIGANTINE_HULL_CONTROL_POINTS = {
  bow: { x: 190, y: 90 },
  bowTip: { x: 415, y: 0 },
  bowBottom: { x: 190, y: -90 },
  sternBottom: { x: -260, y: -90 },
  sternTip: { x: -345, y: 0 },
  stern: { x: -260, y: 90 }
};
```

### Hull Points Struct (C)

```c
typedef struct {
    Vec2 bow;
    Vec2 bow_tip;
    Vec2 bow_bottom;
    Vec2 stern_bottom;
    Vec2 stern_tip;
    Vec2 stern;
} BrigantineHullControlPoints;
```

---

## Module Data

### Deck Module

| Property | Value | Description |
|----------|-------|-------------|
| **Module ID** | 200 | Fixed ID for brigantine deck |
| **Kind** | 'deck' | Module type identifier |
| **Hull Polygon** | 49 points | Same as ship hull |
| **Local Position** | (0, 0) | Center of ship |
| **Local Rotation** | 0 | No rotation |

**Deck Boundaries (for collision):**
```typescript
deckMinX: -260
deckMaxX: 415
deckMinY: -90
deckMaxY: 90
```

### Helm Module

| Property | Value | Description |
|----------|-------|-------------|
| **Module ID** | 1000 | Fixed ID for brigantine helm |
| **Kind** | 'helm' | Module type identifier |
| **Local Position** | (-90, 0) | Aft-center of ship |
| **Local Rotation** | 0 | Facing forward |
| **Helm Data** | | |
| - Steering Speed | 1.0 rad/s | How fast player can steer |
| - Control Radius | 20 units | Interaction distance |

### Plank Modules

**Total Planks:** 48 (matching hull segments)

| Property | Value | Description |
|----------|-------|-------------|
| **Module IDs** | 100-147 | Sequential IDs starting at 100 |
| **Kind** | 'plank' | Module type identifier |
| **Thickness** | 10 units | Plank width |
| **Material** | 'wood' | Default material |
| **Health** | 100 | Full structural integrity |

**Plank Distribution:**
- Bow curve: 13 planks (segments 0-12)
- Starboard side: 12 planks (segments 13-24)
- Stern curve: 12 planks (segments 25-36)
- Port side: 11 planks (segments 37-47)

Each plank segment is defined by:
```typescript
interface PlankSegment {
  index: number;           // 0-47
  sectionName: string;     // "bow", "starboard", "stern", "port"
  start: { x: number, y: number };
  end: { x: number, y: number };
  thickness: number;       // 10 units
}
```

---

## Expected Server Data Format

### World State Ship Object

```typescript
interface Ship {
  id: number;                    // Unique ship identifier
  position: Vec2;                // World position
  rotation: number;              // World rotation (radians)
  velocity: Vec2;                // Linear velocity (m/s)
  angularVelocity: number;       // Angular velocity (rad/s)
  hull: Vec2[];                  // 49-point polygon (ship-local coords)
  modules: ShipModule[];         // Array of all modules
  
  // Physics properties
  mass: number;                  // 5000.0 kg
  momentOfInertia: number;       // 500000.0 kg⋅m²
  maxSpeed: number;              // 30.0 m/s
  turnRate: number;              // 0.5 rad/s
  waterDrag: number;             // 0.98
  angularDrag: number;           // 0.95
}
```

### Module Data Structure

```typescript
interface ShipModule {
  id: number;                    // Unique module identifier
  localPos: Vec2;                // Position relative to ship center
  localRot: number;              // Rotation relative to ship (radians)
  state: number;                 // Bit flags (OCCUPIED, ACTIVE, etc.)
  moduleData: ModuleData;        // Type-specific data
}

type ModuleData = 
  | DeckModuleData 
  | HelmModuleData 
  | PlankModuleData 
  | CannonModuleData
  | MastModuleData
  | LadderModuleData;
```

---

## Validation Functions

### TypeScript Validation

```typescript
/**
 * Validate ship physics match brigantine specification
 */
export function validateBrigantinePhysics(ship: Ship): boolean {
  const epsilon = 0.01;
  
  return (
    Math.abs(ship.mass - BRIGANTINE_MASS) < epsilon &&
    Math.abs(ship.momentOfInertia - BRIGANTINE_MOMENT_OF_INERTIA) < epsilon &&
    Math.abs(ship.maxSpeed - BRIGANTINE_MAX_SPEED) < epsilon &&
    Math.abs(ship.turnRate - BRIGANTINE_TURN_RATE) < epsilon &&
    Math.abs(ship.waterDrag - BRIGANTINE_WATER_DRAG) < epsilon &&
    Math.abs(ship.angularDrag - BRIGANTINE_ANGULAR_DRAG) < epsilon
  );
}

/**
 * Validate hull has correct number of points
 */
export function validateBrigantineHull(hull: Vec2[]): boolean {
  return hull.length === 49;
}

/**
 * Validate modules are present and correct
 */
export function validateBrigantineModules(modules: ShipModule[]): {
  hasDeck: boolean;
  hasHelm: boolean;
  plankCount: number;
  valid: boolean;
} {
  const hasDeck = modules.some(m => m.id === BRIGANTINE_DECK_ID);
  const hasHelm = modules.some(m => m.id === BRIGANTINE_HELM_ID);
  const plankCount = modules.filter(m => 
    m.moduleData?.kind === 'plank'
  ).length;
  
  return {
    hasDeck,
    hasHelm,
    plankCount,
    valid: hasDeck && hasHelm && plankCount === 48
  };
}
```

---

## Usage Examples

### Client: Receiving Ship from Server

```typescript
// When receiving ship data from server
function onWorldState(state: WorldState): void {
  for (const ship of state.ships) {
    // Validate physics properties
    if (!validateBrigantinePhysics(ship)) {
      console.warn('Ship physics mismatch:', ship.id);
    }
    
    // Validate hull
    if (!validateBrigantineHull(ship.hull)) {
      console.warn('Ship hull point count incorrect:', ship.hull.length);
    }
    
    // Validate modules
    const moduleValidation = validateBrigantineModules(ship.modules);
    if (!moduleValidation.valid) {
      console.warn('Ship modules incomplete:', moduleValidation);
    }
  }
}
```

### Server: Creating Brigantine Ship

```c
// Initialize brigantine ship
void init_brigantine_ship(Ship* ship, uint32_t id) {
    ship->id = id;
    ship->position = (Vec2){ .x = 0.0f, .y = 0.0f };
    ship->rotation = 0.0f;
    ship->velocity = (Vec2){ .x = 0.0f, .y = 0.0f };
    ship->angular_velocity = 0.0f;
    
    // Physics properties
    ship->mass = BRIGANTINE_MASS;
    ship->moment_of_inertia = BRIGANTINE_MOMENT_OF_INERTIA;
    ship->max_speed = BRIGANTINE_MAX_SPEED;
    ship->turn_rate = BRIGANTINE_TURN_RATE;
    ship->water_drag = BRIGANTINE_WATER_DRAG;
    ship->angular_drag = BRIGANTINE_ANGULAR_DRAG;
    
    // Generate hull
    BrigantineHullControlPoints control_points = get_brigantine_hull_control_points();
    ship->hull_count = generate_brigantine_hull(control_points, ship->hull);
    
    // Deck boundaries
    ship->deck_min_x = -260.0f;
    ship->deck_max_x = 415.0f;
    ship->deck_min_y = -90.0f;
    ship->deck_max_y = 90.0f;
    
    ship->active = true;
}
```

---

## References

- **Protocol Definition**: `protocol/ship_definitions.h`
- **Client Constants**: `client/src/common/ShipDefinitions.ts`
- **Hull Generation**: `client/src/sim/PlankSegments.ts`
- **Module System**: `client/src/sim/modules.ts`
- **Server Integration**: `server/BRIGANTINE_PHYSICS_INTEGRATION.md`
