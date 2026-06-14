# Client Guide: Brigantine Physics Integration

## Overview
The server now broadcasts brigantine physics properties in the `GAME_STATE` message. The client needs to update to receive and use these properties for consistent physics simulation and client-side prediction.

## What Changed on the Server

### 1. Ship Structure Now Includes Physics Properties
The server's `SimpleShip` structure now includes:
- `mass` (kg)
- `moment_of_inertia` (kg⋅m²)
- `max_speed` (m/s)
- `turn_rate` (rad/s)
- `water_drag` (0-1 coefficient)
- `angular_drag` (0-1 coefficient)

### 2. Ship Initialization Uses Brigantine Constants
Ships are initialized with values from `protocol/ship_definitions.h`:
```c
mass = 5000.0f
moment_of_inertia = 500000.0f
max_speed = 30.0f
turn_rate = 0.5f
water_drag = 0.98f
angular_drag = 0.95f
```

## Required Client Changes

### Step 1: Update GAME_STATE Message Type Definition

**File**: `client/src/net/NetworkManager.ts` (or wherever you define message types)

Add physics properties to the ship object in the GAME_STATE message:

```typescript
interface GameStateMessage {
    type: 'GAME_STATE';
    tick: number;
    timestamp: number;
    ships: Array<{
        id: number;
        x: number;
        y: number;
        rotation: number;
        velocity_x: number;
        velocity_y: number;
        angular_velocity: number;
        
        // NEW: Physics properties from server
        mass?: number;              // kg
        moment_of_inertia?: number; // kg⋅m²
        max_speed?: number;         // m/s
        turn_rate?: number;         // rad/s
        water_drag?: number;        // 0-1
        angular_drag?: number;      // 0-1
    }>;
    players: Array<{
        // ... existing player fields
    }>;
    projectiles: Array<any>;
}
```

**Note**: Made optional (`?`) for backward compatibility in case you're testing with older server builds.

### Step 2: Update Ship Entity/Object on Client

**File**: `client/src/sim/Types.ts` (or wherever you define Ship type)

Add physics properties to your client-side ship representation:

```typescript
export interface Ship {
    id: number;
    type: ShipType;
    position: Vec2;
    rotation: number;
    velocity: Vec2;
    angularVelocity: number;
    
    // Physics properties (from server or ship definitions)
    mass: number;
    momentOfInertia: number;
    maxSpeed: number;
    turnRate: number;
    waterDrag: number;
    angularDrag: number;
    
    // Collision hull
    hull?: Vec2[];
    
    // Deck boundaries
    deckBounds?: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
    };
}
```

### Step 3: Update GAME_STATE Handler to Extract Physics

**File**: `client/src/net/NetworkManager.ts`

Update your `onGameState` handler to extract and store physics properties:

```typescript
private handleGameState(message: GameStateMessage): void {
    // Update ships
    message.ships.forEach(serverShip => {
        let ship = this.gameEngine.getShipById(serverShip.id);
        
        if (!ship) {
            // Create new ship
            ship = this.gameEngine.createShip({
                id: serverShip.id,
                position: { x: serverShip.x, y: serverShip.y },
                rotation: serverShip.rotation,
                velocity: { x: serverShip.velocity_x, y: serverShip.velocity_y },
                angularVelocity: serverShip.angular_velocity,
                
                // NEW: Use physics from server if available, fallback to defaults
                mass: serverShip.mass ?? BRIGANTINE_MASS,
                momentOfInertia: serverShip.moment_of_inertia ?? BRIGANTINE_MOMENT_OF_INERTIA,
                maxSpeed: serverShip.max_speed ?? BRIGANTINE_MAX_SPEED,
                turnRate: serverShip.turn_rate ?? BRIGANTINE_TURN_RATE,
                waterDrag: serverShip.water_drag ?? BRIGANTINE_WATER_DRAG,
                angularDrag: serverShip.angular_drag ?? BRIGANTINE_ANGULAR_DRAG,
            });
        } else {
            // Update existing ship
            ship.position.x = serverShip.x;
            ship.position.y = serverShip.y;
            ship.rotation = serverShip.rotation;
            ship.velocity.x = serverShip.velocity_x;
            ship.velocity.y = serverShip.velocity_y;
            ship.angularVelocity = serverShip.angular_velocity;
            
            // NEW: Update physics properties if server sends them
            if (serverShip.mass !== undefined) {
                ship.mass = serverShip.mass;
                ship.momentOfInertia = serverShip.moment_of_inertia!;
                ship.maxSpeed = serverShip.max_speed!;
                ship.turnRate = serverShip.turn_rate!;
                ship.waterDrag = serverShip.water_drag!;
                ship.angularDrag = serverShip.angular_drag!;
            }
        }
    });
    
    // ... rest of player/projectile handling
}
```

### Step 4: Use Ship Definitions for Defaults

**File**: `client/src/common/ShipDefinitions.ts` (create if doesn't exist)

Import the ship definitions to use as fallback values:

```typescript
// Brigantine physics constants (must match protocol/ship_definitions.h)
export const BRIGANTINE_MASS = 5000.0;
export const BRIGANTINE_MOMENT_OF_INERTIA = 500000.0;
export const BRIGANTINE_MAX_SPEED = 30.0;
export const BRIGANTINE_TURN_RATE = 0.5;
export const BRIGANTINE_WATER_DRAG = 0.98;
export const BRIGANTINE_ANGULAR_DRAG = 0.95;
export const BRIGANTINE_LENGTH = 760;
export const BRIGANTINE_BEAM = 180;

// Hull control points (from protocol/ship_definitions.h)
export const BRIGANTINE_HULL_CONTROL_POINTS = {
    bow: [
        { x: 0, y: -380 },    // P0: Front tip
        { x: 0, y: -320 },    // P1: Control point
        { x: 90, y: -260 }    // P2: Bow end
    ],
    starboard: [
        { x: 90, y: -260 },   // Start
        { x: 90, y: 260 }     // End
    ],
    stern: [
        { x: 90, y: 260 },    // P0: Stern start
        { x: 45, y: 320 },    // P1: Control point
        { x: 0, y: 380 }      // P2: Back tip
    ],
    port: [
        { x: 0, y: 380 },     // Start
        { x: -90, y: 260 },   // Mid
        { x: -90, y: -260 },  // Mid
        { x: 0, y: -380 }     // End (back to bow)
    ]
};

/**
 * Generate brigantine hull polygon (49 points)
 * Must match C implementation in protocol/ship_definitions.h
 */
export function generateBrigantineHull(): Vec2[] {
    const hull: Vec2[] = [];
    
    // Bow curve (quadratic Bezier): 15 points
    const bowP0 = BRIGANTINE_HULL_CONTROL_POINTS.bow[0];
    const bowP1 = BRIGANTINE_HULL_CONTROL_POINTS.bow[1];
    const bowP2 = BRIGANTINE_HULL_CONTROL_POINTS.bow[2];
    for (let i = 0; i < 15; i++) {
        const t = i / 14.0;
        hull.push(quadraticBezier(bowP0, bowP1, bowP2, t));
    }
    
    // Starboard side (linear): 10 points
    const starboardStart = BRIGANTINE_HULL_CONTROL_POINTS.starboard[0];
    const starboardEnd = BRIGANTINE_HULL_CONTROL_POINTS.starboard[1];
    for (let i = 1; i < 10; i++) {
        const t = i / 10.0;
        hull.push(lerp(starboardStart, starboardEnd, t));
    }
    
    // Stern curve (quadratic Bezier): 15 points
    const sternP0 = BRIGANTINE_HULL_CONTROL_POINTS.stern[0];
    const sternP1 = BRIGANTINE_HULL_CONTROL_POINTS.stern[1];
    const sternP2 = BRIGANTINE_HULL_CONTROL_POINTS.stern[2];
    for (let i = 0; i < 15; i++) {
        const t = i / 14.0;
        hull.push(quadraticBezier(sternP0, sternP1, sternP2, t));
    }
    
    // Port side (linear): 9 points
    const portPoints = BRIGANTINE_HULL_CONTROL_POINTS.port;
    for (let i = 1; i < 10; i++) {
        const t = i / 10.0;
        const segment = Math.floor(t * 3); // 3 segments
        const segmentT = (t * 3) - segment;
        
        if (segment >= 2) {
            hull.push(lerp(portPoints[2], portPoints[3], segmentT));
        } else if (segment >= 1) {
            hull.push(lerp(portPoints[1], portPoints[2], segmentT));
        } else {
            hull.push(lerp(portPoints[0], portPoints[1], segmentT));
        }
    }
    
    return hull;
}

function quadraticBezier(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
    const u = 1 - t;
    return {
        x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
        y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
    };
}

function lerp(p0: Vec2, p1: Vec2, t: number): Vec2 {
    return {
        x: p0.x + t * (p1.x - p0.x),
        y: p0.y + t * (p1.y - p0.y)
    };
}
```

### Step 5: Apply Physics in Client-Side Prediction

**File**: `client/src/net/PredictionEngine.ts`

Use the ship's physics properties when predicting movement:

```typescript
public predictShipMovement(ship: Ship, dt: number): void {
    // Apply velocity to position
    ship.position.x += ship.velocity.x * dt;
    ship.position.y += ship.velocity.y * dt;
    ship.rotation += ship.angularVelocity * dt;
    
    // NEW: Apply drag using ship's properties
    ship.velocity.x *= ship.waterDrag;
    ship.velocity.y *= ship.waterDrag;
    ship.angularVelocity *= ship.angularDrag;
    
    // NEW: Clamp to max speed
    const speed = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.y ** 2);
    if (speed > ship.maxSpeed) {
        const scale = ship.maxSpeed / speed;
        ship.velocity.x *= scale;
        ship.velocity.y *= scale;
    }
    
    // NEW: Clamp angular velocity to turn rate
    ship.angularVelocity = Math.max(
        -ship.turnRate,
        Math.min(ship.turnRate, ship.angularVelocity)
    );
}
```

### Step 6: Use Hull for Collision Detection

**File**: `client/src/sim/CollisionSystem.ts`

Generate and use the hull polygon for ship collision:

```typescript
import { generateBrigantineHull } from '../common/ShipDefinitions';

export class CollisionSystem {
    private shipHulls: Map<number, Vec2[]> = new Map();
    
    public initializeShip(ship: Ship): void {
        // Generate hull polygon (49 points)
        const localHull = generateBrigantineHull();
        this.shipHulls.set(ship.id, localHull);
    }
    
    public checkShipCollision(ship1: Ship, ship2: Ship): boolean {
        const hull1 = this.shipHulls.get(ship1.id);
        const hull2 = this.shipHulls.get(ship2.id);
        
        if (!hull1 || !hull2) return false;
        
        // Transform hulls to world space
        const worldHull1 = this.transformHull(hull1, ship1.position, ship1.rotation);
        const worldHull2 = this.transformHull(hull2, ship2.position, ship2.rotation);
        
        // Use SAT (Separating Axis Theorem) for polygon collision
        return this.satCollision(worldHull1, worldHull2);
    }
    
    private transformHull(localHull: Vec2[], position: Vec2, rotation: number): Vec2[] {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        
        return localHull.map(point => ({
            x: position.x + point.x * cos - point.y * sin,
            y: position.y + point.x * sin + point.y * cos
        }));
    }
    
    private satCollision(hull1: Vec2[], hull2: Vec2[]): boolean {
        // Implement SAT algorithm
        // Check all edges of both polygons as potential separating axes
        // Return true if collision detected, false otherwise
        // (Implementation details omitted for brevity)
        return false; // Placeholder
    }
}
```

## Server Changes Coming Soon

The server will soon broadcast physics properties in the GAME_STATE message. The updated format will be:

```json
{
    "type": "GAME_STATE",
    "tick": 12345,
    "timestamp": 1637000000,
    "ships": [
        {
            "id": 1,
            "x": 100.0,
            "y": 100.0,
            "rotation": 0.0,
            "velocity_x": 0.0,
            "velocity_y": 0.0,
            "angular_velocity": 0.0,
            "mass": 5000.0,
            "moment_of_inertia": 500000.0,
            "max_speed": 30.0,
            "turn_rate": 0.5,
            "water_drag": 0.98,
            "angular_drag": 0.95
        }
    ],
    "players": [...],
    "projectiles": [...]
}
```

## Testing Checklist

- [ ] Client receives GAME_STATE messages with ship data
- [ ] Ship physics properties are extracted and stored
- [ ] Client-side prediction uses correct drag coefficients
- [ ] Ships clamp to max_speed correctly
- [ ] Angular velocity clamped to turn_rate
- [ ] Hull polygon generated correctly (49 points)
- [ ] Ship-to-ship collision detection works
- [ ] Player-ship collision uses hull polygon
- [ ] Reconciliation handles physics property updates
- [ ] Fallback to default brigantine values works when server doesn't send them

## Benefits

✅ **Consistent Physics**: Client and server use identical ship properties  
✅ **Better Prediction**: Client-side prediction matches server physics exactly  
✅ **Accurate Collisions**: Proper hull polygons for collision detection  
✅ **Smooth Gameplay**: Drag and speed limits prevent visual artifacts  
✅ **Easy Testing**: Can compare client vs server physics side-by-side  

## Migration Path

1. **Phase 1** (Current): Client uses hard-coded brigantine constants
2. **Phase 2**: Server broadcasts physics properties in GAME_STATE
3. **Phase 3**: Client receives and uses server physics properties
4. **Phase 4**: Client validates physics match expected values
5. **Phase 5**: Full ship-to-ship collision with hull polygons

## Related Documentation

- `protocol/SHIP_DEFINITIONS.md` - Ship definition format and hull generation
- `protocol/ship_definitions.h` - C header with brigantine constants
- `protocol/ship_definitions.json` - Human-readable ship specs
- `server/BRIGANTINE_PHYSICS_INTEGRATION.md` - Server-side changes
- `docs/HYBRID_INPUT_PROTOCOL.md` - Related: Movement input protocol
- `docs/ENHANCED_GAME_STATE.md` - GAME_STATE broadcast format
