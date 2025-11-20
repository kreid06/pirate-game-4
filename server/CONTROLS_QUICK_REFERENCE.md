# Ship Controls - Quick Reference

## Control Scheme
**Independent Rotation + WASD Movement with Directional Speed**

## How It Works

### Client Responsibilities
1. **Calculate Rotation** from mouse position:
   ```javascript
   rotation = Math.atan2(mouseY - playerY, mouseX - playerX)
   ```

2. **Calculate Movement** from WASD input:
   ```javascript
   let x = 0, y = 0;
   if (W_pressed) y -= 1;
   if (S_pressed) y += 1;
   if (A_pressed) x -= 1;
   if (D_pressed) x += 1;
   
   // Normalize
   const mag = Math.sqrt(x*x + y*y);
   if (mag > 0) { x /= mag; y /= mag; }
   ```

3. **Send Both** in input frame:
   ```json
   {
     "rotation": 1.57,
     "movement": {"x": 0, "y": -1}
   }
   ```

### Server Processing
1. **Sets ship rotation** = client rotation (instant)
2. **Calculates angle difference** between facing direction and movement direction
3. **Applies speed modifier**:
   - **Forward** (0-45°): 100% speed → 200 px/s
   - **Sideways** (45-135°): 75% speed → 150 px/s  
   - **Backward** (135-180°): 50% speed → 100 px/s

## Speed Modifier Formula

```c
float angle_diff = movement_angle - rotation;
float abs_angle = fabsf(angle_diff);

if (abs_angle < π/4)        speed = 100%  // Forward
else if (abs_angle < 3π/4)  speed = 75%   // Sideways
else                        speed = 50%   // Backward
```

## Example Scenarios

| Ship Facing | WASD Input | Angle Diff | Speed | Result |
|-------------|------------|------------|-------|--------|
| → (0°) | D (right) | 0° | 100% | Move right 200 px/s |
| → (0°) | W (up) | 90° | 75% | Strafe up 150 px/s |
| → (0°) | A (left) | 180° | 50% | Reverse left 100 px/s |
| ↑ (90°) | W (up) | 0° | 100% | Move forward 200 px/s |
| ↑ (90°) | D (right) | 90° | 75% | Strafe right 150 px/s |
| ↑ (90°) | S (down) | 180° | 50% | Reverse backward 100 px/s |

## Implementation Details

### Speed Constants
```c
#define PLAYER_SPEED 200.0f      // Base speed
#define FORWARD_MULT 1.0f        // 100%
#define SIDEWAYS_MULT 0.75f      // 75%
#define BACKWARD_MULT 0.5f       // 50%
#define FRICTION 0.85f           // Velocity retention when not moving
```

### Angle Ranges
```c
#define FORWARD_THRESHOLD  (M_PI / 4.0f)      // 45°
#define SIDEWAYS_THRESHOLD (3.0f * M_PI / 4.0f)  // 135°
```

## Why This Design?

1. **Intuitive**: Ship always faces mouse, like a twin-stick shooter
2. **Strategic**: Can't strafe at full speed - must choose optimal angle
3. **Balanced**: Retreating is slower, encourages aggressive play
4. **Realistic-ish**: Ships move slower when not facing direction of travel

## Client Implementation Checklist

- [ ] Track mouse position in world coordinates
- [ ] Calculate rotation from player to mouse every frame
- [ ] Collect WASD input into movement vector
- [ ] Normalize movement vector
- [ ] Send both rotation and movement in input_frame
- [ ] Render ship sprite rotated by server-provided rotation
- [ ] Apply client-side prediction using same speed formula

## Testing

### Test 1: Forward Movement
1. Face ship right (mouse to the right)
2. Press D (move right)
3. Expected: 200 px/s movement

### Test 2: Strafing
1. Face ship right (mouse to the right)
2. Press W (move up)
3. Expected: 150 px/s movement (75% speed)

### Test 3: Reverse
1. Face ship right (mouse to the right)
2. Press A (move left)
3. Expected: 100 px/s movement (50% speed)

### Test 4: Diagonal Forward
1. Face ship up-right (45°)
2. Press W+D (move up-right)
3. Expected: ~200 px/s (100% - aligned with facing)

### Test 5: Rotation Independence
1. Press W to move up
2. Move mouse around
3. Expected: Ship rotates to mouse, maintains upward movement speed based on new angle

---

**Status**: ✅ Implemented (Nov 20, 2024)  
**Server**: `bin/pirate-server`  
**File**: `src/net/websocket_server.c:update_player_movement()`
