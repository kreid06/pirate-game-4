# Module Coordinate Inconsistency - Critical Bug

## Problem Summary
**The server is double-converting module coordinates, causing module positions to be incorrect.**

## Root Cause

### Server Module Initialization (websocket_server.c:1359-1360)
```c
// Helm position - WRONG: Applies CLIENT_TO_SERVER conversion
ships[0].modules[0].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
ships[0].modules[0].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-50.0f));
```

With `WORLD_SCALE_FACTOR = 10.0`:
- Client wants helm at `(0, -50)` pixels
- `CLIENT_TO_SERVER(-50.0)` = `-50.0 / 10.0` = `-5.0` (server units)
- Stored as Q16: `-5.0` in fixed-point

### Server Sending to Client (websocket_server.c:2209-2211)
```c
// When using simulation ships - WRONG: Applies SERVER_TO_CLIENT conversion
float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
```

- Reads Q16: `-5.0` (server units)
- `SERVER_TO_CLIENT(-5.0)` = `-5.0 * 10.0` = `-50.0` ✓ **CORRECT**

### BUT... Fallback Path (websocket_server.c:2247-2249)
```c
// When using simple ships - WRONG: Does NOT convert
float module_x = Q16_TO_FLOAT(module->local_pos.x);
float module_y = Q16_TO_FLOAT(module->local_pos.y);
```

- Reads Q16: `-5.0` (server units)
- No conversion: sends `-5.0` to client ✗ **WRONG**
- Client expects `-50.0` but receives `-5.0`

## The Inconsistency

There are TWO code paths for sending ship data:
1. **Simulation ships** (lines 2170-2220): Correctly applies `SERVER_TO_CLIENT` ✓
2. **Simple ships fallback** (lines 2222-2258): Does NOT apply conversion ✗

This causes module positions to differ by a factor of 10 depending on which path is active!

## Correct Architecture

Module local positions should be stored in **SERVER UNITS** internally, then converted to **CLIENT UNITS** when sending:

### Storage (Internal - Server Units)
```c
// Store in server units (no conversion needed)
ships[0].modules[0].local_pos.x = Q16_FROM_FLOAT(0.0f);      // 0.0 server units
ships[0].modules[0].local_pos.y = Q16_FROM_FLOAT(-5.0f);     // -5.0 server units (= -50px client)
```

### Transmission (Network - Client Units)
```c
// Convert to client units when sending
float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));  // 0.0 * 10 = 0px
float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));  // -5.0 * 10 = -50px
```

## Required Fixes

### CRITICAL: The Actual Issue

After deeper analysis, the problem is **inconsistent transmission, not storage**:

- **Simulation path** (websocket_server.c:2209): Applies `SERVER_TO_CLIENT` ✓
- **Simple ships fallback** (websocket_server.c:2247): Does NOT apply `SERVER_TO_CLIENT` ✗

Both storage paths use `CLIENT_TO_SERVER` during initialization:
- `simulation.c:301`: `CLIENT_TO_SERVER(-90.0f)` → stores `-9.0` server units
- `websocket_server.c:1359`: `CLIENT_TO_SERVER(-50.0f)` → stores `-5.0` server units

This is actually **correct** - they're storing in server units as intended. The bug is that the fallback transmission path doesn't convert back to client units.

### Fix: Fallback Transmission Path (websocket_server.c:2247-2249)
**ADD** the `SERVER_TO_CLIENT` conversion to match the simulation path:

```c
// BEFORE (WRONG):
float module_x = Q16_TO_FLOAT(module->local_pos.x);
float module_y = Q16_TO_FLOAT(module->local_pos.y);
float module_rot = Q16_TO_FLOAT(module->local_rot);

// AFTER (CORRECT):
float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
float module_rot = Q16_TO_FLOAT(module->local_rot);  // Rotation doesn't need scaling
```

**This is the ONLY change needed.** The storage is correct, only the fallback transmission is broken.

## Impact

### Current Behavior
- Helm appears at `(0, -5)` instead of `(0, -50)` - **10x too close to ship center**
- Cannons at wrong positions
- All gameplay modules misaligned
- Client had to compensate by using wrong positions

### After Fix
- Server is authoritative for all module positions
- Client receives correct positions directly from server
- No client-side corrections needed
- Consistent across all code paths

## Verification Steps

1. ✅ Fixed server module initialization (already correct - uses CLIENT_TO_SERVER)
2. ✅ Fixed fallback transmission path (added SERVER_TO_CLIENT at line 2251-2252)
3. ✅ Fixed initial handshake path (added SERVER_TO_CLIENT at line 1688-1689)
4. ✅ Verified all other paths already correct (interaction handlers, admin API, simulation path)
5. Test client receives correct positions
6. Test interaction range checks work correctly
7. Confirm modules appear at expected visual positions

## Changes Made

### File: server/src/net/websocket_server.c

**Line 1688-1689** (Initial handshake game state):
```c
// BEFORE:
float module_x = Q16_TO_FLOAT(module->local_pos.x);
float module_y = Q16_TO_FLOAT(module->local_pos.y);

// AFTER:
float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
```

**Line 2251-2252** (Fallback simple ships broadcast):
```c
// BEFORE:
float module_x = Q16_TO_FLOAT(module->local_pos.x);
float module_y = Q16_TO_FLOAT(module->local_pos.y);

// AFTER:
float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
```

## Status: FIXED ✅

The server now consistently sends module positions in client units across all code paths. Server is authoritative - client must use the positions provided by the server without any corrections.

## Related Files
- `server/src/net/websocket_server.c` - Lines 1352-1420, 2170-2260
- `server/src/sim/simulation.c` - Lines 240-330 (module initialization)
- `server/include/core/math.h` - Conversion macros
- `client/src/net/NetworkManager.ts` - Client parsing (lines 798-802)
