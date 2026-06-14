# Client Implementation Guide - Hybrid Input Protocol

## 🎯 Overview

The server now supports a **hybrid input protocol** that dramatically reduces bandwidth while maintaining responsiveness. This guide explains exactly what the client needs to implement.

**See also**: `HYBRID_INPUT_PROTOCOL.md` for full protocol specification.

---

## 📦 What Changed on Server

The server now accepts **3 new message types** alongside the old `input_frame`:

1. **`movement_state`** - Send when movement keys change (not every frame)
2. **`rotation_update`** - Send when aim changes >3 degrees (not every frame)  
3. **`action_event`** - Send when actions occur (fire, jump, etc.)

**Backward Compatible**: Old `input_frame` messages still work! You can migrate incrementally.

---

## 🔧 Required Client Changes

### 1. Update NetworkManager Message Types

**File**: `client/src/net/NetworkManager.ts`

```typescript
export enum MessageType {
  HANDSHAKE = 'handshake',
  INPUT_FRAME = 'input_frame',  // OLD - still supported
  
  // NEW: Hybrid protocol
  MOVEMENT_STATE = 'movement_state',
  ROTATION_UPDATE = 'rotation_update',
  ACTION_EVENT = 'action_event',
  
  PING = 'ping',
  PONG = 'pong',
  // ... rest
}
```

### 2. Add New NetworkManager Methods

**File**: `client/src/net/NetworkManager.ts`

```typescript
/**
 * Send movement state change (HYBRID)
 */
sendMovementState(movement: Vec2, isMoving: boolean): void {
  if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
    return;
  }

  const message = {
    type: MessageType.MOVEMENT_STATE,
    timestamp: Date.now(),
    movement: {
      x: movement.x,
      y: movement.y
    },
    is_moving: isMoving
  };

  console.log(`🚶 Movement state: (${movement.x.toFixed(2)}, ${movement.y.toFixed(2)}), moving: ${isMoving}`);
  this.sendMessage(message);
}

/**
 * Send rotation update (HYBRID)
 */
sendRotationUpdate(rotation: number): void {
  if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
    return;
  }

  const message = {
    type: MessageType.ROTATION_UPDATE,
    timestamp: Date.now(),
    rotation: rotation
  };

  console.log(`🎯 Rotation update: ${rotation.toFixed(3)} rad`);
  this.sendMessage(message);
}

/**
 * Send action event (HYBRID)
 */
sendAction(action: string, target?: Vec2): void {
  if (this.connectionState !== ConnectionState.CONNECTED || !this.socket) {
    return;
  }

  const message: any = {
    type: MessageType.ACTION_EVENT,
    timestamp: Date.now(),
    action: action
  };

  if (target) {
    message.target = {
      x: target.x,
      y: target.y
    };
  }

  console.log(`⚡ Action: ${action}`);
  this.sendMessage(message);
}
```

### 3. Update InputManager - Movement State Detection

**File**: `client/src/client/gameplay/InputManager.ts`

```typescript
export class InputManager {
  // NEW: Track state for change detection
  private currentMovementState: Vec2 = Vec2.zero();
  private previousMovementState: Vec2 = Vec2.zero();
  private lastSentRotation: number = 0;
  
  // Rotation threshold: 3 degrees = 0.0524 radians
  private readonly ROTATION_THRESHOLD = 0.0524;
  
  // Callbacks for hybrid protocol
  public onMovementStateChange: ((movement: Vec2, isMoving: boolean) => void) | null = null;
  public onRotationUpdate: ((rotation: number) => void) | null = null;
  public onActionEvent: ((action: string, target?: Vec2) => void) | null = null;

  /**
   * Update - called every client frame
   */
  update(deltaTime: number): void {
    // Calculate current movement state from keys
    const movementState = this.calculateMovementFromKeys();
    
    // Check if movement state changed
    if (!movementState.equals(this.previousMovementState)) {
      this.sendMovementStateChange(movementState);
      this.previousMovementState = movementState.clone();
    }
    
    // Check if rotation changed significantly
    const currentRotation = this.calculateRotationFromMouse();
    const rotationDelta = Math.abs(currentRotation - this.lastSentRotation);
    
    if (rotationDelta > this.ROTATION_THRESHOLD) {
      this.sendRotationUpdate(currentRotation);
      this.lastSentRotation = currentRotation;
    }
    
    // Reset per-frame flags
    this.resetFrameFlags();
  }
  
  /**
   * Calculate movement vector from current key presses
   */
  private calculateMovementFromKeys(): Vec2 {
    let movement = Vec2.zero();
    
    if (this.inputState.pressedKeys.has('w') || this.inputState.pressedKeys.has('arrowup')) {
      movement = movement.add(Vec2.from(0, -1));
    }
    if (this.inputState.pressedKeys.has('s') || this.inputState.pressedKeys.has('arrowdown')) {
      movement = movement.add(Vec2.from(0, 1));
    }
    if (this.inputState.pressedKeys.has('a') || this.inputState.pressedKeys.has('arrowleft')) {
      movement = movement.add(Vec2.from(-1, 0));
    }
    if (this.inputState.pressedKeys.has('d') || this.inputState.pressedKeys.has('arrowright')) {
      movement = movement.add(Vec2.from(1, 0));
    }
    
    // Normalize diagonal movement
    if (movement.lengthSq() > 0.01) {
      movement = movement.normalize();
    }
    
    return movement;
  }
  
  /**
   * Calculate rotation from mouse position
   */
  private calculateRotationFromMouse(): number {
    // Calculate angle from player to mouse (world coordinates)
    const mouseWorld = this.inputState.mouseWorldPosition;
    const playerPos = this.playerPosition; // Updated externally
    
    const dx = mouseWorld.x - playerPos.x;
    const dy = mouseWorld.y - playerPos.y;
    
    return Math.atan2(dy, dx);
  }
  
  /**
   * Send movement state change
   */
  private sendMovementStateChange(movement: Vec2): void {
    const isMoving = movement.lengthSq() > 0.01;
    
    if (this.onMovementStateChange) {
      this.onMovementStateChange(movement, isMoving);
      console.log(`📤 Movement state changed: (${movement.x.toFixed(2)}, ${movement.y.toFixed(2)}), moving: ${isMoving}`);
    }
  }
  
  /**
   * Send rotation update
   */
  private sendRotationUpdate(rotation: number): void {
    if (this.onRotationUpdate) {
      this.onRotationUpdate(rotation);
      console.log(`📤 Rotation changed: ${rotation.toFixed(3)} rad (${(rotation * 180 / Math.PI).toFixed(1)}°)`);
    }
  }
  
  /**
   * Handle mouse click - send action event
   */
  private handleMouseClick(event: MouseEvent): void {
    if (event.button === 0) { // Left click
      // Fire action
      if (this.onActionEvent) {
        this.onActionEvent('fire_cannon', this.inputState.mouseWorldPosition);
        console.log(`📤 Action: fire_cannon`);
      }
    }
  }
  
  /**
   * Handle key press - send action event for non-movement keys
   */
  private handleKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    
    // Movement keys handled by state change
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      this.inputState.pressedKeys.add(key);
      // Movement state change will be detected in update()
      return;
    }
    
    // Action keys
    if (key === ' ' || key === 'space') {
      if (this.onActionEvent) {
        this.onActionEvent('jump');
      }
    } else if (key === 'e') {
      if (this.onActionEvent) {
        this.onActionEvent('interact');
      }
    } else if (key === 'r') {
      if (this.onActionEvent) {
        this.onActionEvent('reload');
      }
    }
  }
}
```

### 4. Wire Up InputManager to NetworkManager

**File**: `client/src/client/ClientApplication.ts`

```typescript
private setupInputManager(): void {
  this.inputManager = new InputManager(this.canvas, this.config.input);
  
  // HYBRID: Connect movement state changes
  this.inputManager.onMovementStateChange = (movement: Vec2, isMoving: boolean) => {
    this.networkManager.sendMovementState(movement, isMoving);
  };
  
  // HYBRID: Connect rotation updates
  this.inputManager.onRotationUpdate = (rotation: number) => {
    this.networkManager.sendRotationUpdate(rotation);
  };
  
  // HYBRID: Connect action events
  this.inputManager.onActionEvent = (action: string, target?: Vec2) => {
    this.networkManager.sendAction(action, target);
  };
  
  // OLD: Keep input frame for now (can remove later)
  this.inputManager.onInputFrame = (inputFrame: InputFrame) => {
    // Optional: can keep for backward compatibility or remove
    // this.networkManager.sendInput(inputFrame);
  };
}
```

---

## 🧪 Testing the Implementation

### Step 1: Test Movement State
1. Connect to server
2. Press **W** - should see log: `🚶 Movement state: (0.00, -1.00), moving: true`
3. Server log should show: `🚶 Player 1000 movement state: (0.00, -1.00) moving=1`
4. Release **W** - should see: `🚶 Movement state: (0.00, 0.00), moving: false`
5. Player should keep moving until you release the key!

### Step 2: Test Rotation
1. Move mouse around
2. Should only see rotation updates when you move >3 degrees
3. Server log: `🎯 Player 1000 rotation: 1.571 rad`
4. Much fewer messages than before!

### Step 3: Test Actions
1. Click mouse - should see: `⚡ Action: fire_cannon`
2. Press **Space** - should see: `⚡ Action: jump`
3. Press **E** - should see: `⚡ Action: interact`
4. Server logs each action immediately

### Step 4: Verify Bandwidth Reduction
1. Open browser DevTools → Network tab
2. Watch WebSocket messages
3. **Before**: ~30 messages/second when moving
4. **After**: ~3-5 messages/second when moving
5. **Savings**: ~85% reduction! 🎉

---

## ⚠️ Important Notes

### Client-Side Prediction Still Required!
The hybrid protocol sends messages less frequently, so **client-side prediction is mandatory** or movement will feel laggy.

**What to predict locally:**
```typescript
// In your game loop, apply movement immediately
const localInput = this.inputManager.getCurrentMovement();
this.localPlayer.velocity = localInput.normalize().mul(MOVE_SPEED);
this.localPlayer.position = this.localPlayer.position.add(this.localPlayer.velocity.mul(dt));

// Server will send corrections if needed
```

### State Synchronization
- Server is authoritative - it applies movement every tick
- Client predicts movement locally
- Server corrections handled by prediction engine (you already have this!)
- No changes needed to reconciliation logic

### Backward Compatibility
- Old `input_frame` messages still work
- You can migrate one message type at a time
- Test each change incrementally

---

## 📊 Expected Results

### Bandwidth Comparison (per player)

| Metric | Old (Per-Frame) | New (Hybrid) | Savings |
|--------|----------------|--------------|---------|
| Movement msgs/sec | ~30 | ~3-5 | 83-90% |
| Rotation msgs/sec | ~30 | ~10-15 | 50-67% |
| Action msgs/sec | 0 | ~2-5 | New feature |
| **Total bytes/sec** | **2400** | **780** | **67%** |
| **100 players** | **240 KB/s** | **78 KB/s** | **162 KB/s saved!** |

### Benefits
✅ **Massive bandwidth reduction** - Support 5-10x more players  
✅ **Network resilience** - Keep moving even if packets drop  
✅ **Simpler client** - No more tiered sending complexity  
✅ **Better mobile** - Lower battery drain, fewer messages  

### Trade-offs
⚠️ **Prediction required** - Must predict locally (but you already have this!)  
⚠️ **Threshold tuning** - May need to adjust 3° rotation threshold  

---

## 🐛 Troubleshooting

### Player doesn't move
- Check: Are you sending `is_moving: true`?
- Check: Is movement vector normalized?
- Check: Server logs - is state being received?

### Player keeps moving after releasing key
- Check: Did you send `is_moving: false`?
- Check: Is movement vector set to `(0, 0)`?
- This is actually correct behavior! Server applies friction.

### Rotation looks choppy
- Reduce threshold from 3° to 1-2°
- Add client-side interpolation
- Check: Are you sending rotation in radians (not degrees)?

### Too much bandwidth still
- Check: Are you still sending old `input_frame` messages?
- Check: Is rotation threshold too small?
- Increase rotation threshold to 5°

---

## 📝 Quick Reference

### Message Format Summary

```typescript
// Movement state (send on key press/release)
{
  type: "movement_state",
  timestamp: Date.now(),
  movement: { x: 0.707, y: -0.707 },  // Normalized
  is_moving: true
}

// Rotation update (send when change >3°)
{
  type: "rotation_update",
  timestamp: Date.now(),
  rotation: 1.5708  // Radians
}

// Action event (send on action)
{
  type: "action_event",
  timestamp: Date.now(),
  action: "fire_cannon",
  target: { x: 100, y: 200 }  // Optional
}
```

### Server Expectations

1. **Movement**: Server applies stored state every tick (30Hz)
2. **Rotation**: Server stores latest value, uses for aiming
3. **Actions**: Server processes immediately, validates cooldowns

---

## ✅ Implementation Checklist

- [ ] Add new message types to `MessageType` enum
- [ ] Add `sendMovementState()` to NetworkManager
- [ ] Add `sendRotationUpdate()` to NetworkManager  
- [ ] Add `sendAction()` to NetworkManager
- [ ] Update InputManager to track previous state
- [ ] Detect movement state changes in InputManager
- [ ] Detect rotation changes >3° in InputManager
- [ ] Wire up callbacks in ClientApplication
- [ ] Remove old `sendInput()` calls (or keep for compatibility)
- [ ] Test movement start/stop
- [ ] Test rotation updates
- [ ] Test action events
- [ ] Verify bandwidth reduction in DevTools
- [ ] Celebrate! 🎉

---

## 🚀 Next Steps

1. Implement the client changes above
2. Test with the running server (already supports hybrid protocol!)
3. Monitor bandwidth in browser DevTools
4. Fine-tune rotation threshold if needed
5. Remove old `input_frame` code once confident
6. Enjoy supporting 500+ players! 🏴‍☠️

**Questions?** Check `/docs/HYBRID_INPUT_PROTOCOL.md` for full protocol details.
