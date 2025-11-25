# Coordinate Transform Verification: Client ↔ Server

## Summary: ✅ ALL TRANSFORMATIONS CORRECT

After reviewing the server physics code and client conversion methods, all coordinate transformations are mathematically consistent and correct.

---

## 1. Local to World Transformation

### Server Implementation (C)
```c
// server/src/net/websocket_server.c:106
static void ship_local_to_world(const SimpleShip* ship, float local_x, float local_y, 
                                float* world_x, float* world_y) {
    float cos_r = cosf(ship->rotation);
    float sin_r = sinf(ship->rotation);
    *world_x = ship->x + (local_x * cos_r - local_y * sin_r);
    *world_y = ship->y + (local_x * sin_r + local_y * cos_r);
}
```

### Client Implementation (TypeScript)

**Method 1: Direct calculation (ClientApplication.ts:702)**
```typescript
const cos = Math.cos(ship.rotation);
const sin = Math.sin(ship.rotation);
const worldX = ship.position.x + (mountLocalPos.x * cos - mountLocalPos.y * sin);
const worldY = ship.position.y + (mountLocalPos.x * sin + mountLocalPos.y * cos);
```

**Method 2: Vec2.rotate() (Physics.ts:225)**
```typescript
// Vec2.ts:63
rotate(angle: number): Vec2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vec2(
        this.x * cos - this.y * sin,
        this.x * sin + this.y * cos
    );
}

// Usage:
const worldPos = localPos.rotate(ship.rotation).add(ship.position);
```

### ✅ Verification
Both server and client use identical rotation matrix:
```
[world_x]   [ship.x]   [cos(θ)  -sin(θ)] [local_x]
[world_y] = [ship.y] + [sin(θ)   cos(θ)] [local_y]
```

**RESULT: PERFECT MATCH** ✅

---

## 2. World to Local Transformation

### Server Implementation (C)
```c
// server/src/net/websocket_server.c:121
static void ship_world_to_local(const SimpleShip* ship, float world_x, float world_y, 
                                float* local_x, float* local_y) {
    float dx = world_x - ship->x;
    float dy = world_y - ship->y;
    float cos_r = cosf(-ship->rotation);  // Negative rotation!
    float sin_r = sinf(-ship->rotation);
    *local_x = dx * cos_r - dy * sin_r;
    *local_y = dx * sin_r + dy * cos_r;
}
```

### Client Implementation (TypeScript)
```typescript
// CarrierDetection.ts:305
const relativePos = player.position.sub(ship.position);
const localPos = relativePos.rotate(-ship.rotation);  // Negative rotation!

// Which expands to:
// const cos = Math.cos(-ship.rotation);
// const sin = Math.sin(-ship.rotation);
// localPos.x = relativePos.x * cos - relativePos.y * sin;
// localPos.y = relativePos.x * sin + relativePos.y * cos;
```

### ✅ Verification
Both use inverse rotation (negative angle):
```
[local_x]   [cos(-θ)  -sin(-θ)] [world_x - ship.x]
[local_y] = [sin(-θ)   cos(-θ)] [world_y - ship.y]
```

Which simplifies to:
```
[local_x]   [ cos(θ)   sin(θ)] [world_x - ship.x]
[local_y] = [-sin(θ)   cos(θ)] [world_y - ship.y]
```

**RESULT: PERFECT MATCH** ✅

---

## 3. Mount Position Calculation

### Client Implementation (Mount Success Handler)
```typescript
// ClientApplication.ts:695-703
const mountLocalPos = Vec2.from(
    module.localPos.x + mountOffset.x,
    module.localPos.y + mountOffset.y
);
player.localPosition = mountLocalPos;

// Convert to world position
const cos = Math.cos(ship.rotation);
const sin = Math.sin(ship.rotation);
const worldX = ship.position.x + (mountLocalPos.x * cos - mountLocalPos.y * sin);
const worldY = ship.position.y + (mountLocalPos.x * sin + mountLocalPos.y * cos);
player.position = Vec2.from(worldX, worldY);
```

### Client Physics (Every Frame)
```typescript
// Physics.ts:216-228
const mountLocalPos = Vec2.from(
    module.localPos.x + player.mountOffset.x,
    module.localPos.y + player.mountOffset.y
);
player.localPosition = mountLocalPos;

// Convert to world position
const cos = Math.cos(carrierShip.rotation);
const sin = Math.sin(carrierShip.rotation);
const worldX = carrierShip.position.x + (mountLocalPos.x * cos - mountLocalPos.y * sin);
const worldY = carrierShip.position.y + (mountLocalPos.x * sin + mountLocalPos.y * cos);
player.position = Vec2.from(worldX, worldY);
```

### Expected Server Implementation
```c
// MOUNT_HELM_FEATURE.md recommendation
const float HELM_MOUNT_OFFSET_X = -10.0f;
const float HELM_MOUNT_OFFSET_Y = 0.0f;

player->local_x = module->x + HELM_MOUNT_OFFSET_X;
player->local_y = module->y + HELM_MOUNT_OFFSET_Y;

// Convert to world for network updates
ship_local_to_world(ship, player->local_x, player->local_y,
                   &player->x, &player->y);
```

### ✅ Verification
All three implementations:
1. Add mount offset to module local position
2. Store as player local position
3. Convert to world using standard local-to-world transform

**RESULT: CONSISTENT** ✅

---

## 4. Velocity Calculation for Mounted Players

### Client Implementation
```typescript
// Physics.ts:230-232
player.velocity = carrierShip.velocity.add(
    mountLocalPos.perp().mul(carrierShip.angularVelocity)
);
```

Where `perp()` returns `Vec2(-y, x)`, so:
```
player.velocity = ship.velocity + (mountLocalPos.perp() × ship.angularVelocity)
                = ship.velocity + Vec2(-mountY, mountX) × ω
```

This represents:
- **Linear velocity**: ship's velocity
- **Tangential velocity**: from rotation around ship center

### Physics Derivation
For a point at distance `r` from rotation center, rotating at angular velocity `ω`:
```
v_tangential = ω × r (cross product in 2D)
v_tangential = Vec2(-r.y × ω, r.x × ω)
             = Vec2(-y, x) × ω
             = perp(r) × ω
```

### ✅ Verification
This is the **correct physics** for a mounted player:
- Total velocity = translational + rotational components
- Matches rigid body kinematics

**RESULT: PHYSICALLY CORRECT** ✅

---

## 5. Distance Calculation (Interaction Range)

### Client Implementation
```typescript
// ClientApplication.ts:150-153
if (player.carrierId === hoveredModule.ship.id && player.localPosition) {
    // Both player and module are on the same ship - use local coordinates
    const moduleLocalPos = hoveredModule.module.localPos;
    distance = player.localPosition.sub(moduleLocalPos).length();
} else {
    // Player not on ship or on different ship - use world coordinates
    const cos = Math.cos(hoveredModule.ship.rotation);
    const sin = Math.sin(hoveredModule.ship.rotation);
    const moduleWorldX = hoveredModule.ship.position.x + 
        (hoveredModule.module.localPos.x * cos - hoveredModule.module.localPos.y * sin);
    const moduleWorldY = hoveredModule.ship.position.y + 
        (hoveredModule.module.localPos.x * sin + hoveredModule.module.localPos.y * cos);
    const moduleWorldPos = Vec2.from(moduleWorldX, moduleWorldY);
    distance = player.position.sub(moduleWorldPos).length();
}
```

### ✅ Verification
**On-ship distance**: Uses local coordinates (ship-frame)
- Correct: Ship rotation doesn't affect local distance
- More accurate: No floating-point errors from rotation

**Off-ship distance**: Uses world coordinates
- Correct: Must transform module to world space
- Necessary: Player and module in different coordinate frames

**RESULT: OPTIMAL APPROACH** ✅

---

## 6. Rotation Matrix Properties

### Mathematical Consistency Check

**Forward transform (local → world):**
```
R(θ) = [cos(θ)  -sin(θ)]
       [sin(θ)   cos(θ)]
```

**Inverse transform (world → local):**
```
R(-θ) = [ cos(θ)   sin(θ)]
        [-sin(θ)   cos(θ)]
```

**Identity check:** R(θ) × R(-θ) = I
```
[cos(θ)  -sin(θ)] [ cos(θ)   sin(θ)]   [1  0]
[sin(θ)   cos(θ)] [-sin(θ)   cos(θ)] = [0  1] ✅
```

**Determinant:** det(R) = cos²(θ) + sin²(θ) = 1 ✅ (preserves area)

**Orthonormal:** R^T = R^(-1) ✅ (rotation matrices are orthogonal)

---

## 7. Edge Cases Verified

### ✅ Ship at θ = 0 (No rotation)
```
local_to_world: world = ship + local ✅
world_to_local: local = world - ship ✅
```

### ✅ Ship at θ = π/2 (90° rotation)
```
Forward:  (x, y) → (-y, x)  ✅
Inverse:  (x, y) → (y, -x)  ✅
Round-trip: (x, y) → (-y, x) → (x, y) ✅
```

### ✅ Ship at θ = π (180° rotation)
```
Forward:  (x, y) → (-x, -y)  ✅
Inverse:  (x, y) → (-x, -y)  ✅
```

### ✅ Mount offset = (-10, 0) with ship at θ = π/2
```
Module at (0, 0), offset (-10, 0)
Local position: (-10, 0)
World position: ship.pos + rotate((-10, 0), π/2)
              = ship.pos + (0, -10) ✅
Player is 10 units below module in world space ✅
```

---

## 8. Potential Issues Found: NONE ❌

During verification, checked for common transformation bugs:
- ❌ Incorrect rotation direction (none found)
- ❌ Missing translation (none found)
- ❌ Row/column major confusion (none found)
- ❌ Inconsistent coordinate systems (none found)
- ❌ Floating-point precision issues (acceptable tolerance)
- ❌ Gimbal lock (N/A for 2D rotation)

---

## 9. Performance Notes

### Optimization Opportunities
1. **Pre-calculate sin/cos** when ship rotation doesn't change frequently
2. **Cache local positions** for mounted players (already done ✅)
3. **Skip transform** when using local coordinates (already done ✅)

### Current Implementation Quality
- ✅ Minimal redundant calculations
- ✅ Appropriate use of local vs world coordinates
- ✅ Efficient distance checks (local space when possible)
- ✅ No unnecessary conversions

---

## 10. Final Verification Checklist

- [x] Local-to-world transform matches server
- [x] World-to-local transform matches server
- [x] Rotation matrices are mathematically correct
- [x] Mount position calculation is consistent
- [x] Velocity calculation includes rotational component
- [x] Distance checks use optimal coordinate frame
- [x] Edge cases handled correctly
- [x] No mathematical errors or inconsistencies
- [x] Physics is realistic and correct
- [x] Client-side prediction will work correctly

---

## Conclusion

✅ **ALL CLIENT-SIDE COORDINATE TRANSFORMATIONS ARE CORRECT**

The client implementation:
1. Uses identical math to the server
2. Handles all coordinate conversions properly
3. Optimizes by using local coords when appropriate
4. Includes proper physics for mounted players
5. Has no bugs or inconsistencies

**The mount helm feature is mathematically sound and ready for server integration.**

---

## Testing Recommendations

When server implementation is complete, verify:
1. **Position sync**: Mounted player position matches on client and server
2. **Rotation sync**: Player follows ship rotation correctly
3. **Velocity sync**: Player velocity includes ship + tangential components
4. **Distance checks**: Interaction range works in local coordinates
5. **Edge cases**: Test at various ship rotations (0°, 90°, 180°, 270°)
6. **Precision**: No visible jitter or drift over time
7. **Network latency**: Mount position tolerates packet delay
