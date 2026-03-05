# Bug History Archive

A consolidated record of identified bugs, root causes, and their fixes.

---

## Bug 1: Module Coordinate Double-Conversion

**Status**: ✅ Fixed  
**Severity**: Critical — all ship modules appeared at wrong positions (10× off)

### Problem

Server was using two inconsistent code paths when sending module positions to clients. Modules stored internally in server units (1 unit = 10 client pixels via `WORLD_SCALE_FACTOR = 10.0`), but one broadcast path forgot to convert back to client units.

### Root Cause

| Code Path | Conversion Applied | Result |
|-----------|-------------------|--------|
| Simulation ships (`websocket_server.c:2209`) | `SERVER_TO_CLIENT()` ✓ | Correct |
| Simple ships fallback (`websocket_server.c:2247`) | None ✗ | 10× too small |
| Initial handshake (`websocket_server.c:1688`) | None ✗ | 10× too small |

Storage was always correct — modules initialized with `CLIENT_TO_SERVER()` → stored in server units. The bug was only in the fallback transmission paths.

### Fix

Added `SERVER_TO_CLIENT()` to the two broken paths:

```c
// websocket_server.c:1688-1689 (handshake) and :2251-2252 (simple ships fallback)
// BEFORE:
float module_x = Q16_TO_FLOAT(module->local_pos.x);
float module_y = Q16_TO_FLOAT(module->local_pos.y);

// AFTER:
float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
```

Rotation does not need scaling — only position.

---

## Bug 2: Cannon Direction Off by 90 Degrees

**Status**: ✅ Fixed  
**Severity**: High — cannons always fired 90° wrong direction

### Problem

Cannon projectiles fired in the wrong direction whenever the ship was rotated (most visibly 90° off with the default ship orientation).

### Root Cause

Double subtraction of ship rotation in `handle_cannon_aim()`:

1. **Client** sends `aim_angle = atan2(dy, dx) - shipRotation` — already ship-relative
2. **Server** `handle_cannon_aim()` treated it as a world angle and subtracted `ship->rotation` again:
   ```c
   player->cannon_aim_angle_relative = aim_angle - ship->rotation;  // WRONG
   ```
   
Result: `projectile_angle = worldAngle - shipRotation` instead of correct `worldAngle`.

### Fix

`server/src/net/websocket_server.c`, `handle_cannon_aim()`:

```c
// BEFORE (double subtraction):
player->cannon_aim_angle_relative = aim_angle - ship->rotation;

// AFTER (client already sends ship-relative angle):
player->cannon_aim_angle_relative = aim_angle;
```

---

## Coordinate Transform Verification

**Date**: Verified correct — no bugs found.

A full audit of all client ↔ server coordinate transformations confirmed:

| Transform | Client | Server | Match |
|-----------|--------|--------|-------|
| Local → World | `rotate(θ)` + translate | `cos/sin` rotation matrix | ✅ Identical |
| World → Local | `rotate(-θ)` + translate | negative rotation angle | ✅ Identical |
| Mount position | offset + local→world | same pattern | ✅ Consistent |
| Velocity (mounted) | `ship.vel + perp(localPos) × ω` | same rigid-body formula | ✅ Correct |
| Distance check | local coords on-ship, world off-ship | same logic | ✅ Optimal |

Rotation matrices verified:
- `R(θ) × R(-θ) = I` ✅
- `det(R) = 1` ✅ (area-preserving)
- `R^T = R^(-1)` ✅ (orthogonal)

Edge cases tested at θ = 0, π/2, π with round-trip verification — all correct.
