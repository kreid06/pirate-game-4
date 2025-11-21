# Enhanced GAME_STATE Broadcast - Movement Data

## 🎯 What Changed

The server now broadcasts **complete movement state** for all players in every `GAME_STATE` message.

---

## 📦 New Player Data Structure

**Before (Missing velocity & movement state):**
```json
{
  "id": 1000,
  "name": "Player_1000",
  "world_x": 50.0,
  "world_y": 50.0,
  "rotation": 1.57,
  "parent_ship": 0,
  "local_x": 0.0,
  "local_y": 0.0,
  "state": "SWIMMING"
}
```

**After (Complete movement data):**
```json
{
  "id": 1000,
  "name": "Player_1000",
  "world_x": 50.0,
  "world_y": 50.0,
  "rotation": 1.57,
  
  // NEW: Velocity data
  "velocity_x": 15.0,
  "velocity_y": 0.0,
  
  // NEW: Movement state (hybrid protocol)
  "is_moving": true,
  "movement_direction_x": 1.0,
  "movement_direction_y": 0.0,
  
  "parent_ship": 0,
  "local_x": 0.0,
  "local_y": 0.0,
  "state": "SWIMMING"
}
```

---

## 🔧 New Fields Explained

### `velocity_x` / `velocity_y` (float)
- **Current velocity** in world coordinates (m/s)
- Swimming: 0-15 m/s (with 10x speed)
- Walking: Inherits ship velocity
- **Use for**: Smooth interpolation, prediction, rendering other players

### `is_moving` (boolean)
- **Is player actively moving?**
- `true` = Keys pressed, moving
- `false` = No input, applying friction
- **Use for**: Client reconciliation, animation state

### `movement_direction_x` / `movement_direction_y` (float)
- **Normalized movement direction** (-1.0 to 1.0)
- Server's stored state from hybrid protocol
- What direction server thinks player wants to move
- **Use for**: Debug, reconciliation, understanding server state

---

## 💡 How Client Should Use This

### 1. Reconcile Local Player State

```typescript
function reconcileServerState(serverPlayer: ServerPlayerData): void {
  const localPlayer = getLocalPlayer();
  
  // Check if server state matches our prediction
  const positionError = localPlayer.position.sub(
    Vec2.from(serverPlayer.world_x, serverPlayer.world_y)
  ).length();
  
  if (positionError > 5.0) {
    // Large error - snap to server position
    console.warn(`⚠️ Large position error: ${positionError.toFixed(2)}m, snapping to server`);
    localPlayer.position.x = serverPlayer.world_x;
    localPlayer.position.y = serverPlayer.world_y;
  }
  
  // Check if server thinks we're moving but we're not
  if (serverPlayer.is_moving && !localInputManager.isMoving()) {
    console.warn(`⚠️ Server thinks we're moving but we stopped - server will apply friction`);
    // Server will naturally stop us with friction
  }
  
  // Check velocity mismatch (for debugging)
  const velocityError = Math.abs(
    localPlayer.velocity.length() - 
    Math.sqrt(serverPlayer.velocity_x ** 2 + serverPlayer.velocity_y ** 2)
  );
  
  if (velocityError > 2.0) {
    console.warn(`⚠️ Velocity mismatch: ${velocityError.toFixed(2)} m/s`);
  }
}
```

### 2. Render Other Players Smoothly

```typescript
function updateOtherPlayer(player: Player, serverData: ServerPlayerData, dt: number): void {
  // Use server velocity for smooth interpolation
  const targetPosition = Vec2.from(serverData.world_x, serverData.world_y);
  const serverVelocity = Vec2.from(serverData.velocity_x, serverData.velocity_y);
  
  // Predict where player will be next frame
  const predictedPosition = targetPosition.add(serverVelocity.mul(dt));
  
  // Interpolate smoothly to predicted position
  player.position = player.position.lerp(predictedPosition, 0.3);
  
  // Set animation state based on is_moving
  if (serverData.is_moving) {
    player.playAnimation('swim'); // or 'walk'
  } else {
    player.playAnimation('idle');
  }
}
```

### 3. Debug Movement Issues

```typescript
function debugMovementState(serverPlayer: ServerPlayerData): void {
  console.log(`
🐛 Server Movement State for Player ${serverPlayer.id}:
  Position: (${serverPlayer.world_x.toFixed(1)}, ${serverPlayer.world_y.toFixed(1)})
  Velocity: (${serverPlayer.velocity_x.toFixed(2)}, ${serverPlayer.velocity_y.toFixed(2)})
  Is Moving: ${serverPlayer.is_moving}
  Direction: (${serverPlayer.movement_direction_x.toFixed(2)}, ${serverPlayer.movement_direction_y.toFixed(2)})
  State: ${serverPlayer.state}
  `);
}
```

---

## 🧪 Testing

### 1. Check Velocity Updates
1. Connect to server
2. Press **W** to move forward
3. Check GAME_STATE message in DevTools
4. Should see: `"velocity_y": -15.0, "is_moving": true`
5. Release **W**
6. Should see velocity decrease: `"velocity_y": -12.75, "is_moving": false` (friction applied)

### 2. Check Movement Direction
1. Press **W+D** (diagonal)
2. Check: `"movement_direction_x": 0.71, "movement_direction_y": -0.71`
3. Should be normalized (magnitude ≈ 1.0)

### 3. Verify is_moving Flag
1. Stand still → `"is_moving": false`
2. Press any WASD → `"is_moving": true`
3. Release all keys → `"is_moving": false`

---

## ⚠️ Common Issues & Solutions

### Issue: `is_moving` is always `false`
**Cause**: Client not sending hybrid `movement_state` messages
**Solution**: Implement client hybrid protocol (see CLIENT_HYBRID_IMPLEMENTATION.md)
**Workaround**: Server still supports old `input_frame` messages

### Issue: Velocity is `0.0` when moving
**Cause**: Server not applying movement (tick function not called?)
**Check**: Server logs should show `🎮 TICK: Applied movement to X players`

### Issue: Movement direction doesn't match input
**Cause**: Client sending wrong normalized vector
**Debug**: Check client sends normalized movement (-1 to 1)

### Issue: Position jumps/teleports
**Cause**: Large position error between client prediction and server
**Solution**: 
  - Check client prediction is using same speed constants (15 m/s swim, 30 m/s walk)
  - Verify client applies friction correctly
  - Add reconciliation logic (see example above)

---

## 📊 Bandwidth Impact

**Additional data per player:**
- `velocity_x`: ~6 bytes (`15.00`)
- `velocity_y`: ~6 bytes (`-15.00`)
- `is_moving`: ~4 bytes (`true`)
- `movement_direction_x`: ~6 bytes (`0.71`)
- `movement_direction_y`: ~6 bytes (`-0.71`)

**Total: ~28 bytes per player**

For 10 players at 20Hz: **28 bytes × 10 players × 20 updates/sec = 5.6 KB/sec**

Still much better than the old per-frame input (which was eliminated with hybrid protocol).

---

## 🎯 Summary

✅ **Server now broadcasts:**
- Player velocity (for smooth rendering)
- Movement state (for reconciliation)
- Movement direction (for debugging)

✅ **Clients can now:**
- Reconcile local predictions with server state
- Render other players smoothly with velocity prediction
- Debug movement issues with complete state info
- Understand if server thinks player is moving

✅ **Fixes the movement bug by:**
- Showing if server and client agree on movement state
- Providing velocity for proper prediction
- Enabling reconciliation when states diverge

**The server is running with these changes! Test it now in the browser.** 🚀

---

## 🔗 Related Documentation

- `/docs/HYBRID_INPUT_PROTOCOL.md` - Full hybrid protocol spec
- `/docs/CLIENT_HYBRID_IMPLEMENTATION.md` - How to implement client-side
- `/docs/client-side-prediction.md` - Prediction & reconciliation details
