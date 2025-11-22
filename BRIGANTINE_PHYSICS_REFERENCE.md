# Brigantine Physics Values Reference

## What the Server Broadcasts

Every `GAME_STATE` message now includes these brigantine physics properties for each ship:

```json
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
```

## Physics Property Definitions

| Property | Value | Unit | Usage |
|----------|-------|------|-------|
| `mass` | 5000.0 | kg | Ship mass for force calculations (future feature) |
| `moment_of_inertia` | 500000.0 | kg⋅m² | Rotational inertia for torque (future feature) |
| `max_speed` | 30.0 | m/s | Maximum linear velocity - **CLAMP TO THIS** |
| `turn_rate` | 0.5 | rad/s | Maximum angular velocity - **CLAMP TO THIS** |
| `water_drag` | 0.98 | 0-1 | Linear velocity damping - **MULTIPLY VELOCITY EVERY FRAME** |
| `angular_drag` | 0.95 | 0-1 | Angular velocity damping - **MULTIPLY ANGULAR_VELOCITY EVERY FRAME** |

## How to Use in Client

### Every Physics Tick

```typescript
// 1. Apply drag (before integration)
ship.velocity.x *= ship.waterDrag;  // 0.98 = 2% drag per frame
ship.velocity.y *= ship.waterDrag;
ship.angularVelocity *= ship.angularDrag;  // 0.95 = 5% drag per frame

// 2. Integrate position (standard physics)
ship.position.x += ship.velocity.x * dt;
ship.position.y += ship.velocity.y * dt;
ship.rotation += ship.angularVelocity * dt;

// 3. Clamp to limits (after integration)
const speed = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.y ** 2);
if (speed > ship.maxSpeed) {
    const scale = ship.maxSpeed / speed;
    ship.velocity.x *= scale;
    ship.velocity.y *= scale;
}

ship.angularVelocity = Math.max(-ship.turnRate, Math.min(ship.turnRate, ship.angularVelocity));
```

### Drag Explanation

- **Water Drag (0.98)**: Multiply velocity by 0.98 every frame → 2% reduction per frame
  - After 1 second (30 frames): velocity ≈ 0.98³⁰ = 0.545 × original (45.5% reduction)
  - Ships slow down naturally without input

- **Angular Drag (0.95)**: Multiply angular velocity by 0.95 every frame → 5% reduction per frame
  - After 1 second (30 frames): angular_velocity ≈ 0.95³⁰ = 0.215 × original (78.5% reduction)
  - Ships stop spinning faster than they stop moving

### Speed Limits

- **Max Speed (30 m/s)**:
  - At 30 FPS: 30 m/s = 1 meter per frame
  - Ship can never exceed this velocity magnitude
  - Clamp *after* applying forces/input

- **Turn Rate (0.5 rad/s)**:
  - At 30 FPS: 0.5 rad/s = 0.0167 rad per frame ≈ 0.95°/frame
  - At 30 FPS: Full 360° rotation takes ~377 frames ≈ 12.6 seconds
  - Ship can never spin faster than this

## Testing Expected Values

When you connect to the server and receive a `GAME_STATE` message, you should see:

```
Ship 1:
  mass: 5000.0
  moment_of_inertia: 500000.0
  max_speed: 30.0
  turn_rate: 0.5
  water_drag: 0.98
  angular_drag: 0.95
```

## Physics Consistency Check

The client should verify these values match the expected brigantine constants:

```typescript
const EXPECTED_BRIGANTINE_PHYSICS = {
    mass: 5000.0,
    moment_of_inertia: 500000.0,
    max_speed: 30.0,
    turn_rate: 0.5,
    water_drag: 0.98,
    angular_drag: 0.95
};

function validateShipPhysics(ship: Ship): boolean {
    const epsilon = 0.01; // Tolerance for floating-point comparison
    
    return (
        Math.abs(ship.mass - EXPECTED_BRIGANTINE_PHYSICS.mass) < epsilon &&
        Math.abs(ship.moment_of_inertia - EXPECTED_BRIGANTINE_PHYSICS.moment_of_inertia) < epsilon &&
        Math.abs(ship.max_speed - EXPECTED_BRIGANTINE_PHYSICS.max_speed) < epsilon &&
        Math.abs(ship.turn_rate - EXPECTED_BRIGANTINE_PHYSICS.turn_rate) < epsilon &&
        Math.abs(ship.water_drag - EXPECTED_BRIGANTINE_PHYSICS.water_drag) < epsilon &&
        Math.abs(ship.angular_drag - EXPECTED_BRIGANTINE_PHYSICS.angular_drag) < epsilon
    );
}
```

## Common Mistakes

❌ **Applying drag after clamping speed** - Results in ship never reaching max speed  
✅ Apply drag → integrate → clamp

❌ **Not applying drag every frame** - Ship accelerates indefinitely  
✅ Multiply velocity by drag coefficient every physics tick

❌ **Using drag as subtraction** - `velocity -= 0.02` is wrong  
✅ Use multiplication: `velocity *= 0.98`

❌ **Forgetting to clamp angular velocity** - Ship spins too fast  
✅ Clamp angular_velocity to ±turn_rate

## See Also

- `protocol/ship_definitions.h` - C header with these constants
- `protocol/SHIP_DEFINITIONS.md` - Hull geometry and physics documentation
- `docs/CLIENT_BRIGANTINE_PHYSICS_GUIDE.md` - Complete implementation guide
- `server/BRIGANTINE_PHYSICS_INTEGRATION.md` - Server-side implementation
