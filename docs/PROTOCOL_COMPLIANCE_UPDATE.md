# Protocol Compliance Update

## Overview
Updated the client to fully comply with the server's WebSocket protocol specification as documented in `WEBSOCKET_CLIENT_PROTOCOL.md`.

## Changes Made

### 1. Input Frame Protocol (InputManager.ts)
**Added rotation calculation:**
- Implemented `calculatePlayerRotation()` method that calculates the angle from player to mouse using `Math.atan2(dy, dx)`
- Returns rotation in radians (server requirement)
- Defaults to 0 (facing right) when player position is unavailable
- Updated `generateInputFrame()` to include rotation field

**Result:** Client now sends player facing direction based on mouse position

### 2. Network Message Format (NetworkManager.ts)
**Updated sendInput() method:**
- Changed `movement` from Vec2 object to `{x, y}` plain object format
- Added `rotation` field to InputMessage
- Updated InputMessage interface to match server expectations:
  ```typescript
  {
    type: 'input',
    timestamp: number,
    sequenceId: number,
    tick: number,
    rotation: number,      // in radians
    movement: {x, y},      // normalized vector
    actions: number        // bitmask
  }
  ```

**Updated handshake:**
- Changed `protocolVersion` from string `"1.0"` to number `1`
- Updated HandshakeMessage interface type definition

### 3. GAME_STATE Parsing (NetworkManager.ts)
**Fixed player data parsing:**
- Changed from `position.x/position.y` to `world_x/world_y` (server field names)
- Changed from `carrierId` to `parent_ship` (server field name)
- Changed from `onDeck` boolean to `state === 'onship'` check
- Server sends `state` field with values like 'onship', 'inwater', etc.

**Server player data format:**
```json
{
  "id": 1,
  "world_x": 100.5,
  "world_y": 200.3,
  "rotation": 1.57,
  "parent_ship": 0,
  "local_x": 0,
  "local_y": 0,
  "state": "onship"
}
```

### 4. Type Definitions (Types.ts)
**Updated InputFrame interface:**
```typescript
export interface InputFrame {
  tick: number;
  movement: Vec2;
  actions: number;
  rotation: number;  // NEW: player facing direction in radians
}
```

### 5. Compilation Error Fixes
**Fixed missing rotation fields in:**
- `PredictionEngine.ts` - Added rotation to stored prediction state
- `InputManager.ts` - Added rotation: 0 to initial input frame
- `test_udp.ts` - Added rotation: 0 to test input

## Protocol Compliance Checklist

✅ **Handshake Message:**
- Type: 'handshake'
- protocolVersion: 1 (number)
- playerName: string
- timestamp: number

✅ **Input Message:**
- Type: 'input'
- timestamp: number
- sequenceId: number
- tick: number
- rotation: number (radians)
- movement: {x: number, y: number}
- actions: number (bitmask)

✅ **GAME_STATE Response Parsing:**
- Player fields: world_x, world_y, rotation, parent_ship, state
- Ship fields: position, velocity, rotation, hull, modules
- Projectile fields: position, velocity

## Testing Notes

### Expected Behavior:
1. Player rotation should follow mouse cursor
2. Input messages sent to server include rotation in radians
3. Movement vector sent as plain {x, y} object
4. GAME_STATE properly parses player positions from world_x/world_y

### Debug Logging:
- Input frame generation logs include rotation value
- sendInput() logs rotation being sent to server
- GAME_STATE parsing logs player positions correctly

## Server Compatibility

This update ensures full compatibility with the C server implementation that expects:
- JSON text frames (not binary)
- Exact field names (case-sensitive string parsing)
- Rotation in radians
- Movement as nested object with x/y fields
- Protocol version as integer

## Related Documentation
- `WEBSOCKET_CLIENT_PROTOCOL.md` - Complete protocol specification
- `SCALABLE_INPUT_SYSTEM.md` - Input tiering and bandwidth optimization
- `client-side-prediction.md` - Prediction engine documentation
