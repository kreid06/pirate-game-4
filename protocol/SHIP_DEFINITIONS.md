# Ship Definitions - Shared Protocol

This directory contains **shared ship definitions** that both the client and server use to create consistent ship geometry and physics.

---

## 📁 Files

### `ship_definitions.json`
- **Human-readable** ship specifications
- Contains hull control points, physics properties, dimensions
- Good for documentation and reference
- Can be parsed by tools for validation

### `ship_definitions.h`
- **C header file** for server-side use
- Drop-in definitions for C/C++ physics engines
- Includes helper functions to generate hull polygons
- No dependencies, pure C99

### `example_ship_usage.c`
- Example showing how to use `ship_definitions.h`
- Shows hull generation and physics body creation
- Compile and run to verify definitions

---

## 🚢 Brigantine Ship

### Hull Control Points
```
Bow (Front)              Stern (Back)
     ____________________
    /                    \
bow → ●                  ● ← stern
       \                /
bow_tip  ●            ● stern_tip
          \          /
           ●________●
      bow_bottom    stern_bottom
```

**Coordinates** (ship-local, origin at center):
- `bow`: (190, 90) - Port side bow start
- `bow_tip`: (415, 0) - Pointy front tip (furthest forward)
- `bow_bottom`: (190, -90) - Starboard side bow
- `stern_bottom`: (-260, -90) - Starboard side stern
- `stern_tip`: (-345, 0) - Stern tip (furthest back)
- `stern`: (-260, 90) - Port side stern

### Hull Generation Algorithm

The hull is a **49-point polygon** generated from control points:

1. **Bow Curve** (13 points): Quadratic Bezier from `bow → bow_tip → bow_bottom`
2. **Starboard Side** (12 points): Straight line from `bow_bottom → stern_bottom`
3. **Stern Curve** (12 points): Quadratic Bezier from `stern_bottom → stern_tip → stern`
4. **Port Side** (11 points): Straight line from `stern → bow`
5. **Total**: 49 points (closes automatically)

**Quadratic Bezier Formula:**
```
B(t) = (1-t)² * P0 + 2(1-t)t * P1 + t² * P2
where t ∈ [0, 1]
```

### Physics Properties

| Property | Value | Description |
|----------|-------|-------------|
| Mass | 5000 kg | Ship weight |
| Moment of Inertia | 500000 kg⋅m² | Rotational inertia |
| Max Speed | 30 m/s | Maximum velocity |
| Turn Rate | 0.5 rad/s | Maximum angular velocity |
| Water Drag | 0.98 | Velocity damping per tick (98% retained) |
| Angular Drag | 0.95 | Angular velocity damping per tick |

### Dimensions
- **Length**: 760 units (stern_tip to bow_tip)
- **Beam**: 180 units (width at widest point)

---

## 🔧 Server Usage

### Include the header:
```c
#include "ship_definitions.h"
```

### Generate hull polygon:
```c
Vec2 hull[49];
int point_count = generate_brigantine_hull(hull);
// Returns 49 points in ship-local coordinates
```

### Create physics body (Chipmunk2D example):
```c
cpBody *body = cpBodyNew(BRIGANTINE_MASS, BRIGANTINE_MOMENT_OF_INERTIA);
cpBodySetPosition(body, cpv(x, y));
cpBodySetAngle(body, rotation);

cpShape *shape = cpPolyShapeNew(body, point_count, (cpVect*)hull, 
                                cpTransformIdentity, 0.0);
cpShapeSetFriction(shape, 0.5);

cpSpaceAddBody(space, body);
cpSpaceAddShape(space, shape);
```

### Apply drag each tick:
```c
// Water drag
cpVect vel = cpBodyGetVelocity(body);
vel.x *= BRIGANTINE_WATER_DRAG;
vel.y *= BRIGANTINE_WATER_DRAG;
cpBodySetVelocity(body, vel);

// Angular drag
float ang_vel = cpBodyGetAngularVelocity(body);
ang_vel *= BRIGANTINE_ANGULAR_DRAG;
cpBodySetAngularVelocity(body, ang_vel);
```

---

## 📊 Verification

### Compile and run the example:
```bash
cd protocol
gcc -o test_ship example_ship_usage.c -lm
./test_ship
```

**Expected output:**
```
=== Brigantine Ship Definition Example ===

Created brigantine hull with 49 points
Position: (600.0, 400.0), Rotation: 0.00 rad
Mass: 5000.0 kg, Max Speed: 30.0 m/s

First 5 hull points (ship-local coordinates):
  Point 0: (190.00, 90.00)
  Point 1: (227.60, 74.48)
  Point 2: (263.13, 59.90)
  ...
```

### Client Verification
The client uses the **exact same algorithm** in `ShipUtils.ts`:
- Same control points (`HULL_POINTS`)
- Same Bezier curve function (`getQuadraticPoint`)
- Same subdivision counts (12 per section)
- **Result**: Client and server have identical hull geometry

---

## 🔮 Future Ship Types

When adding new ship types (sloop, galleon, etc.):

1. Add control points to `ship_definitions.json`
2. Add constants to `ship_definitions.h`
3. Create `generate_[shiptype]_hull()` function
4. Update client `ShipUtils.ts` with matching definition
5. Server can select ship type based on `ship.type` field

---

## 🎯 Why This Matters

**Problem**: Server and client need identical ship hulls for:
- ✅ Accurate collision detection
- ✅ Consistent physics simulation
- ✅ Visual alignment with hitboxes
- ✅ Plank placement calculations

**Solution**: Single source of truth in `/protocol/`
- Server generates physics bodies from definitions
- Client generates visuals from same definitions
- Both use **identical algorithms** = perfect alignment

---

## 📝 Notes

- All coordinates are in **ship-local space** (origin at center of mass)
- **World coordinates** = `rotation_matrix * local_coords + ship_position`
- Hull points are **counter-clockwise** for standard polygon winding
- Client may add **visual embellishments** (sails, masts) but uses same physics hull

---

## 🔗 Related Files

- Client ship creation: `/client/src/sim/ShipUtils.ts`
- Client hull definition: `/client/src/sim/modules.ts` (HULL_POINTS)
- Client plank segments: `/client/src/sim/PlankSegments.ts`
- Server physics: `/server/src/sim/physics.c` (TODO: implement)
