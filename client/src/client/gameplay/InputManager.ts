/**
 * Input Manager - Unified Input Handling
 * 
 * Collects and processes all player input (keyboard, mouse, gamepad).
 * Generates InputFrame objects for the simulation.
 */

import { InputConfig } from '../ClientConfig.js';
import { InputFrame } from '../../sim/Types.js';
import { PlayerActions } from '../../sim/Physics.js';
import { Vec2 } from '../../common/Vec2.js';

/**
 * Input tier system for scalable 100+ player support
 */
enum InputTier {
  CRITICAL = 'critical',    // Combat/near enemies - 60Hz
  NORMAL = 'normal',        // Normal gameplay - 30Hz  
  BACKGROUND = 'background', // Distant from others - 10Hz
  IDLE = 'idle'             // Stationary - 1Hz
}

/**
 * Input state tracking
 */
interface InputState {
  // Keyboard
  pressedKeys: Set<string>;
  
  // Mouse
  mousePosition: Vec2;          // Screen coordinates
  mouseWorldPosition: Vec2;     // World coordinates (updated by camera)
  leftMouseDown: boolean;
  rightMouseDown: boolean;
  leftMouseReleased: boolean;
  
  // Gamepad (future)
  gamepadConnected: boolean;
  gamepadState: GamepadState | null;
}

/**
 * Gamepad state (for future implementation)
 */
interface GamepadState {
  axes: number[];
  buttons: boolean[];
}

/**
 * Input action mappings
 */
interface ActionMapping {
  action: string;
  keyCode: string;
  pressed: boolean;
}

/**
 * Main input manager
 */
export class InputManager {
  private canvas: HTMLCanvasElement;
  private config: InputConfig;
  
  private inputState: InputState;
  private actionMappings: ActionMapping[] = [];
  private currentInputFrame: InputFrame;
  private inputFrameCounter = 0;
  private playerPosition: Vec2 = Vec2.zero();
  
  // Event callbacks
  public onInputFrame: ((inputFrame: InputFrame) => void) | null = null;
  
  // HYBRID PROTOCOL: Callbacks for state changes
  public onMovementStateChange: ((movement: Vec2, isMoving: boolean) => void) | null = null;
  public onRotationUpdate: ((rotation: number) => void) | null = null;
  public onActionEvent: ((action: string, target?: Vec2) => void) | null = null;
  
  // Ship control callbacks (when mounted to helm)
  public onShipSailControl: ((desiredOpenness: number) => void) | null = null;
  public onShipRudderControl: ((turningLeft: boolean, turningRight: boolean) => void) | null = null;
  public onShipSailAngleControl: ((desiredAngle: number) => void) | null = null;
  
  // HYBRID PROTOCOL: State tracking for change detection
  private previousMovementState: Vec2 = Vec2.zero();
  private lastSentRotation: number = 0;
  private readonly ROTATION_THRESHOLD = 0.0524; // 3 degrees in radians
  
  // Ship control state tracking
  private isMountedToHelm: boolean = false;
  private currentSailOpenness: number = 100; // Start at 100% (full sails)
  private currentSailAngle: number = 0; // Start at 0 degrees
  private lastRudderState: { left: boolean; right: boolean } = { left: false, right: false };
  private lastSailOpenness: number = 100;
  private lastSailAngle: number = 0;
  private lastSailOpennessChangeTime: number = 0; // Track last sail openness change
  private lastSailAngleChangeTime: number = 0; // Track last sail angle change
  private readonly SAIL_OPENNESS_COOLDOWN = 100; // 0.1s per 10% change
  private readonly SAIL_ANGLE_COOLDOWN = 100; // 0.1s per 6° change
  
  // HYBRID PROTOCOL: Movement stop detection
  private playerVelocity: Vec2 = Vec2.zero();
  private lastStopSentTime: number = 0;
  private readonly STOP_RESEND_INTERVAL = 100; // Resend stop every 100ms if still moving
  private readonly VELOCITY_STOP_THRESHOLD = 0.1; // Consider stopped if velocity < 0.1
  
  // Cooldowns and timing
  private lastInteractionTime = 0;
  private readonly interactionCooldown = 500; // 500ms
  
  // Scalable input tracking for 100+ players
  private lastInputFrame: InputFrame | null = null;
  private lastHeartbeatTime = 0;
  private hasActiveInput = false;
  
  // Tiered sending system based on player activity and proximity
  private inputBuffer: InputFrame[] = [];
  private lastSendTime = 0;
  private currentTier: InputTier = InputTier.NORMAL;
  private nearbyPlayerCount = 0; // Updated by AOI system
  
  // Adaptive rates based on context
  private readonly tierSettings = {
    [InputTier.CRITICAL]: { interval: 16, threshold: 0.05 },   // 60Hz for combat
    [InputTier.NORMAL]: { interval: 33, threshold: 0.1 },      // 30Hz for normal play  
    [InputTier.BACKGROUND]: { interval: 100, threshold: 0.2 }, // 10Hz for distant players
    [InputTier.IDLE]: { interval: 1000, threshold: 1.0 }       // 1Hz for stationary
  };
  
  constructor(canvas: HTMLCanvasElement, config: InputConfig) {
    this.canvas = canvas;
    this.config = config;
    
    // Initialize input state
    this.inputState = {
      pressedKeys: new Set(),
      mousePosition: Vec2.from(canvas.width / 2, canvas.height / 2),
      mouseWorldPosition: Vec2.zero(),
      leftMouseDown: false,
      rightMouseDown: false,
      leftMouseReleased: false,
      gamepadConnected: false,
      gamepadState: null
    };
    
    // Initialize current input frame
    this.currentInputFrame = {
      tick: 0,
      movement: Vec2.zero(),
      actions: 0,
      rotation: 0
    };
    
    this.setupEventListeners();
    this.setupActionMappings();
  }
  
  /**
   * Update input manager (called at client tick rate)
   */
  update(deltaTime: number): void {
    // Update gamepad input
    this.updateGamepad();
    
    // If mounted to helm, handle ship controls instead of player movement
    if (this.isMountedToHelm) {
      this.handleShipControls();
      this.resetFrameFlags();
      return; // Skip normal player input processing
    }
    
    // Generate current input frame
    this.generateInputFrame();
    
    // HYBRID PROTOCOL: Detect movement state changes
    const currentMovement = this.currentInputFrame.movement;
    if (!currentMovement.equals(this.previousMovementState)) {
      const isMoving = currentMovement.lengthSq() > 0.01;
      if (this.onMovementStateChange) {
        this.onMovementStateChange(currentMovement, isMoving);
        this.lastStopSentTime = Date.now();
      }
      this.previousMovementState = currentMovement.clone();
    }
    
    // HYBRID PROTOCOL: Detect if player released keys but is still moving (server-side friction)
    // Resend stop message periodically until player actually stops
    const noInput = currentMovement.lengthSq() < 0.01;
    const stillMoving = this.playerVelocity.lengthSq() > this.VELOCITY_STOP_THRESHOLD * this.VELOCITY_STOP_THRESHOLD;
    const timeSinceLastStop = Date.now() - this.lastStopSentTime;
    
    if (noInput && stillMoving && timeSinceLastStop > this.STOP_RESEND_INTERVAL) {
      // Player released keys but server hasn't stopped them yet - resend stop
      if (this.onMovementStateChange) {
        this.onMovementStateChange(Vec2.zero(), false);
        this.lastStopSentTime = Date.now();
      }
    }
    
    // HYBRID PROTOCOL: Detect rotation changes >3 degrees
    const currentRotation = this.currentInputFrame.rotation;
    const rotationDelta = Math.abs(currentRotation - this.lastSentRotation);
    
    if (rotationDelta > this.ROTATION_THRESHOLD) {
      if (this.onRotationUpdate) {
        this.onRotationUpdate(currentRotation);
      }
      this.lastSentRotation = currentRotation;
    }
    
    // OLD: Optimized sending for backward compatibility (can be removed after migration)
    const shouldSend = this.shouldSendInputFrame();
    
    if (shouldSend && this.onInputFrame) {
      this.onInputFrame(this.currentInputFrame);
      this.lastInputFrame = { ...this.currentInputFrame };
      
      if (this.hasActiveInput) {
        console.log(`📤 Input changed - sending frame: Movement(${this.currentInputFrame.movement.x.toFixed(2)}, ${this.currentInputFrame.movement.y.toFixed(2)}), Actions: ${this.currentInputFrame.actions}`);
      } else {
        console.log(`💓 Heartbeat sent - keeping connection alive`);
      }
    }
    
    // Reset per-frame flags
    this.resetFrameFlags();
  }
  
  /**
   * Update mouse world position (called by camera system)
   */
  updateMouseWorldPosition(worldPos: Vec2): void {
    this.inputState.mouseWorldPosition = worldPos.clone();
  }
  
  /**
   * Update player position for mouse-relative movement calculation
   */
  setPlayerPosition(playerPos: Vec2): void {
    this.playerPosition = playerPos.clone();
  }
  
  /**
   * Update player velocity for stop detection (HYBRID PROTOCOL)
   */
  setPlayerVelocity(velocity: Vec2): void {
    this.playerVelocity = velocity.clone();
  }
  
  /**
   * Get current input frame
   */
  getCurrentInputFrame(): InputFrame {
    return { ...this.currentInputFrame };
  }
  
  /**
   * Get current mouse world position
   */
  getMouseWorldPosition(): Vec2 {
    return this.inputState.mouseWorldPosition.clone();
  }
  
  /**
   * Check if a specific action is currently active
   */
  isActionActive(actionName: string): boolean {
    const mapping = this.actionMappings.find(m => m.action === actionName);
    return mapping ? mapping.pressed : false;
  }
  
  /**
   * Update nearby player count for tier calculation (called by AOI system)
   */
  updateNearbyPlayerCount(count: number): void {
    this.nearbyPlayerCount = count;
    this.updateInputTier();
  }
  
  /**
   * Set combat mode for critical input tier
   */
  setCombatMode(inCombat: boolean): void {
    if (inCombat && this.currentTier !== InputTier.CRITICAL) {
      this.currentTier = InputTier.CRITICAL;
      console.log('🔥 Switching to CRITICAL input tier (60Hz) - combat detected');
    } else if (!inCombat && this.currentTier === InputTier.CRITICAL) {
      this.updateInputTier();
    }
  }

  /**
   * Set mount state (called when player mounts/dismounts helm)
   */
  setMountState(mounted: boolean, shipId?: number): void {
    this.isMountedToHelm = mounted;
    if (mounted) {
      console.log(`⚓ [INPUT] Player mounted to helm on ship ${shipId} - ship controls active`);
      // Reset ship control state
      this.currentSailOpenness = 100;
      this.currentSailAngle = 0;
      this.lastSailOpenness = 100;
      this.lastSailAngle = 0;
      this.lastRudderState = { left: false, right: false };
      this.lastSailOpennessChangeTime = 0;
      this.lastSailAngleChangeTime = 0;
    } else {
      console.log(`⚓ [INPUT] Player dismounted - player controls active`);
    }
  }

  /**
   * Handle ship controls when mounted to helm
   */
  private handleShipControls(): void {
    const shiftPressed = this.inputState.pressedKeys.has('ShiftLeft') || this.inputState.pressedKeys.has('ShiftRight');
    
    // Rudder control (A/D without shift)
    if (!shiftPressed) {
      const turningLeft = this.isActionActive('move_left');   // A key
      const turningRight = this.isActionActive('move_right'); // D key
      
      // Send rudder control if state changed
      if (turningLeft !== this.lastRudderState.left || turningRight !== this.lastRudderState.right) {
        if (this.onShipRudderControl) {
          this.onShipRudderControl(turningLeft, turningRight);
        }
        this.lastRudderState = { left: turningLeft, right: turningRight };
      }
      
      // Sail openness control (W/S without shift)
      const openSails = this.isActionActive('move_forward');   // W key
      const closeSails = this.isActionActive('move_backward'); // S key
      const currentTime = Date.now();
      
      // Check cooldown before allowing sail openness change
      if (currentTime - this.lastSailOpennessChangeTime >= this.SAIL_OPENNESS_COOLDOWN) {
        if (openSails && this.currentSailOpenness < 100) {
          this.currentSailOpenness = Math.min(100, this.currentSailOpenness + 10);
          if (this.currentSailOpenness !== this.lastSailOpenness) {
            if (this.onShipSailControl) {
              this.onShipSailControl(this.currentSailOpenness);
            }
            this.lastSailOpenness = this.currentSailOpenness;
            this.lastSailOpennessChangeTime = currentTime;
          }
        } else if (closeSails && this.currentSailOpenness > 0) {
          this.currentSailOpenness = Math.max(0, this.currentSailOpenness - 10);
          if (this.currentSailOpenness !== this.lastSailOpenness) {
            if (this.onShipSailControl) {
              this.onShipSailControl(this.currentSailOpenness);
            }
            this.lastSailOpenness = this.currentSailOpenness;
            this.lastSailOpennessChangeTime = currentTime;
          }
        }
      }
    } else {
      // Sail angle control (Shift+A/D)
      const rotateLeft = this.isActionActive('move_left');   // Shift+A
      const rotateRight = this.isActionActive('move_right'); // Shift+D
      const currentTime = Date.now();
      
      // Check cooldown before allowing sail angle change
      if (currentTime - this.lastSailAngleChangeTime >= this.SAIL_ANGLE_COOLDOWN) {
        if (rotateLeft && this.currentSailAngle > -60) {
          this.currentSailAngle = Math.max(-60, this.currentSailAngle - 6);
          if (this.currentSailAngle !== this.lastSailAngle) {
            if (this.onShipSailAngleControl) {
              this.onShipSailAngleControl(this.currentSailAngle);
            }
            this.lastSailAngle = this.currentSailAngle;
            this.lastSailAngleChangeTime = currentTime;
          }
        } else if (rotateRight && this.currentSailAngle < 60) {
          this.currentSailAngle = Math.min(60, this.currentSailAngle + 6);
          if (this.currentSailAngle !== this.lastSailAngle) {
            if (this.onShipSailAngleControl) {
              this.onShipSailAngleControl(this.currentSailAngle);
            }
            this.lastSailAngle = this.currentSailAngle;
            this.lastSailAngleChangeTime = currentTime;
          }
        }
      }
    }
    
    // Handle interact key (E) to dismount
    if (this.isActionActive('interact') && this.canInteract()) {
      this.lastInteractionTime = Date.now();
      if (this.onActionEvent) {
        this.onActionEvent('dismount');
      }
    }
  }
  
  /**
   * Update input tier based on activity and proximity
   */
  private updateInputTier(): void {
    const wasIdle = this.currentTier === InputTier.IDLE;
    
    // Determine tier based on activity and proximity
    if (!this.hasActiveInput) {
      this.currentTier = InputTier.IDLE;
    } else if (this.nearbyPlayerCount >= 3) {
      this.currentTier = InputTier.CRITICAL; // Crowded area
    } else if (this.nearbyPlayerCount >= 1) {
      this.currentTier = InputTier.NORMAL; // Normal interaction
    } else {
      this.currentTier = InputTier.BACKGROUND; // Exploring alone
    }
    
    if (this.config.enableDebugLogging && wasIdle !== (this.currentTier === InputTier.IDLE)) {
      console.log(`� Input tier: ${this.currentTier} (${this.tierSettings[this.currentTier].interval}ms interval, nearby: ${this.nearbyPlayerCount})`);
    }
  }
  
  /**
   * Determine if we should send an input frame (Tiered system for 100+ players)
   */
  private shouldSendInputFrame(): boolean {
    const currentTime = Date.now();
    
    // Check if this is the first frame
    if (!this.lastInputFrame) {
      this.lastHeartbeatTime = currentTime;
      this.lastSendTime = currentTime;
      return true;
    }
    
    // Update input tier based on current activity
    this.updateInputTier();
    
    // Get current tier settings
    const settings = this.tierSettings[this.currentTier];
    
    // Check if input has changed
    const movementChanged = !this.currentInputFrame.movement.equals(this.lastInputFrame.movement);
    const actionsChanged = this.currentInputFrame.actions !== this.lastInputFrame.actions;
    
    // Calculate movement change magnitude
    let movementDelta = 0;
    if (movementChanged) {
      const lastMag = this.lastInputFrame.movement.length();
      const currentMag = this.currentInputFrame.movement.length();
      movementDelta = Math.abs(currentMag - lastMag) + 
                     this.currentInputFrame.movement.sub(this.lastInputFrame.movement).length();
    }
    
    const significantChange = movementDelta > settings.threshold || actionsChanged;
    const timeSinceLastSend = currentTime - this.lastSendTime;
    const hasAnyChange = movementChanged || actionsChanged;
    
    // Determine if we should send based on tier
    let shouldSend = false;
    let reason = '';
    
    if (significantChange) {
      // Always send significant changes immediately
      shouldSend = true;
      reason = `significant change (delta: ${movementDelta.toFixed(3)})`;
    } else if (hasAnyChange && timeSinceLastSend >= settings.interval) {
      // Send minor changes at tier-appropriate rate
      shouldSend = true;
      reason = `tier-limited change (${this.currentTier})`;
    } else if (!hasAnyChange && timeSinceLastSend >= Math.max(settings.interval * 10, 1000)) {
      // Heartbeat: send idle state at slower rate
      shouldSend = true;
      reason = 'heartbeat';
    }
    
    if (shouldSend) {
      this.hasActiveInput = hasAnyChange;
      this.lastHeartbeatTime = currentTime;
      this.lastSendTime = currentTime;
      
      if (this.config.enableDebugLogging) {
        console.log(`📊 ${this.currentTier.toUpperCase()} send: ${reason} (interval: ${settings.interval}ms)`);
      }
      return true;
    }
    
    // No need to send
    this.hasActiveInput = hasAnyChange;
    return false;
  }
  
  /**
   * Update input configuration
   */
  updateConfig(newConfig: InputConfig): void {
    this.config = { ...newConfig };
    this.setupActionMappings();
    console.log('🎮 Input configuration updated');
  }
  
  /**
   * Shutdown input manager
   */
  shutdown(): void {
    this.removeEventListeners();
    console.log('🎮 Input manager shutdown');
  }
  
  // Private methods
  
  private setupEventListeners(): void {
    // Keyboard events
    window.addEventListener('keydown', this.onKeyDown.bind(this));
    window.addEventListener('keyup', this.onKeyUp.bind(this));
    
    // Mouse events
    this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.canvas.addEventListener('wheel', this.onMouseWheel.bind(this));
    this.canvas.addEventListener('contextmenu', this.onContextMenu.bind(this));
    
    // Gamepad events (future)
    window.addEventListener('gamepadconnected', this.onGamepadConnected.bind(this));
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected.bind(this));
    
    console.log('🎮 Input event listeners setup');
  }
  
  private removeEventListeners(): void {
    window.removeEventListener('keydown', this.onKeyDown.bind(this));
    window.removeEventListener('keyup', this.onKeyUp.bind(this));
    this.canvas.removeEventListener('mousemove', this.onMouseMove.bind(this));
    this.canvas.removeEventListener('mousedown', this.onMouseDown.bind(this));
    this.canvas.removeEventListener('mouseup', this.onMouseUp.bind(this));
    this.canvas.removeEventListener('wheel', this.onMouseWheel.bind(this));
    this.canvas.removeEventListener('contextmenu', this.onContextMenu.bind(this));
    window.removeEventListener('gamepadconnected', this.onGamepadConnected.bind(this));
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected.bind(this));
  }
  
  private setupActionMappings(): void {
    this.actionMappings = [];
    
    for (const [action, keyCode] of this.config.keyBindings.entries()) {
      this.actionMappings.push({
        action,
        keyCode,
        pressed: false
      });
    }
  }
  
  private generateInputFrame(): void {
    // Calculate movement vector using player position for mouse-relative movement
    const movement = this.calculateMovementVector(this.playerPosition);
    
    // Calculate action bitmask
    const actions = this.calculateActionBitmask();
    
    // Calculate rotation (player facing mouse direction)
    const rotation = this.calculatePlayerRotation();
    
    // Create input frame
    this.currentInputFrame = {
      tick: this.inputFrameCounter++,
      movement,
      actions,
      rotation
    };
    
    // Debug log only when debug logging is enabled
    if (this.config.enableDebugLogging) {
      console.log(`🕹️ Input frame generated - Movement: (${movement.x.toFixed(2)}, ${movement.y.toFixed(2)}), Rotation: ${rotation.toFixed(2)} rad, Actions: ${actions}, Keys: W=${this.isActionActive('move_forward')} S=${this.isActionActive('move_backward')} A=${this.isActionActive('move_left')} D=${this.isActionActive('move_right')}`);
    }
  }
  
  private calculatePlayerRotation(): number {
    // Calculate angle from player to mouse (in radians)
    if (this.playerPosition) {
      const mousePos = this.inputState.mouseWorldPosition;
      const dx = mousePos.x - this.playerPosition.x;
      const dy = mousePos.y - this.playerPosition.y;
      return Math.atan2(dy, dx);
    }
    // Default to facing right (0 radians) if no player position
    return 0;
  }
  
  private calculateMovementVector(playerPosition?: Vec2): Vec2 {
    let movement = Vec2.zero();
    
    // Check for movement keys
    const forward = this.isActionActive('move_forward');
    const backward = this.isActionActive('move_backward');
    const left = this.isActionActive('move_left');
    const right = this.isActionActive('move_right');
    
    // If we have player position, use mouse-relative movement
    if (playerPosition && (forward || backward || left || right)) {
      const mousePos = this.inputState.mouseWorldPosition;
      const playerToMouse = mousePos.sub(playerPosition);
      
      // Calculate forward direction (towards mouse)
      const forwardDir = playerToMouse.lengthSq() > 0 ? playerToMouse.normalize() : Vec2.from(0, -1);
      
      // Calculate right direction (perpendicular to forward)
      const rightDir = Vec2.from(-forwardDir.y, forwardDir.x); // Rotate 90 degrees clockwise
      
      // Apply movement based on keys
      if (forward) movement = movement.add(forwardDir);
      if (backward) movement = movement.add(forwardDir.mul(-1));
      if (right) movement = movement.add(rightDir);
      if (left) movement = movement.add(rightDir.mul(-1));
      
      // Debug logging for mouse-relative movement (only when needed)
      if (this.config.enableDebugLogging) {
        const distance = Math.sqrt(playerToMouse.lengthSq());
        console.log(`🖱️ Mouse-relative movement: Player(${playerPosition.x.toFixed(1)}, ${playerPosition.y.toFixed(1)}) -> Mouse(${mousePos.x.toFixed(1)}, ${mousePos.y.toFixed(1)}) Distance: ${distance.toFixed(1)}`);
        console.log(`🧭 Forward: (${forwardDir.x.toFixed(2)}, ${forwardDir.y.toFixed(2)}), Right: (${rightDir.x.toFixed(2)}, ${rightDir.y.toFixed(2)})`);
        console.log(`⌨️ Keys: W=${forward} S=${backward} A=${left} D=${right} -> Movement: (${movement.x.toFixed(2)}, ${movement.y.toFixed(2)})`);
      }
    } else {
      // Fallback to traditional WASD if no player position provided
      if (forward) movement = movement.add(Vec2.from(0, -1));
      if (backward) movement = movement.add(Vec2.from(0, 1));
      if (left) movement = movement.add(Vec2.from(-1, 0));
      if (right) movement = movement.add(Vec2.from(1, 0));
    }
    
    // Normalize diagonal movement
    if (movement.lengthSq() > 1) {
      movement = movement.normalize();
    }
    
    return movement;
  }
  
  private calculateActionBitmask(): number {
    let actions = 0;
    
    // Jump action
    if (this.isActionActive('jump')) {
      actions |= PlayerActions.JUMP;
    }
    
    // Interact action (with cooldown)
    if (this.isActionActive('interact') && this.canInteract()) {
      actions |= PlayerActions.INTERACT;
      this.lastInteractionTime = Date.now();
      
      // Trigger action event for module interaction
      if (this.onActionEvent) {
        this.onActionEvent('interact');
      }
    }
    
    // Dismount action (with cooldown)
    if (this.isActionActive('dismount') && this.canInteract()) {
      actions |= PlayerActions.DISMOUNT;
      this.lastInteractionTime = Date.now();
    }
    
    // Destroy plank action
    if (this.isActionActive('destroy_plank')) {
      actions |= PlayerActions.DESTROY_PLANK;
    }
    
    return actions;
  }
  
  private canInteract(): boolean {
    const currentTime = Date.now();
    return (currentTime - this.lastInteractionTime) > this.interactionCooldown;
  }
  
  private resetFrameFlags(): void {
    this.inputState.leftMouseReleased = false;
  }
  
  private updateGamepad(): void {
    if (!this.config.gamepadEnabled || !this.inputState.gamepadConnected) {
      return;
    }
    
    // Get gamepad state
    const gamepads = navigator.getGamepads();
    const gamepad = gamepads[0]; // Use first gamepad
    
    if (!gamepad) {
      this.inputState.gamepadConnected = false;
      return;
    }
    
    // Update gamepad state
    this.inputState.gamepadState = {
      axes: Array.from(gamepad.axes),
      buttons: gamepad.buttons.map(button => button.pressed)
    };
    
    // TODO: Map gamepad input to actions
  }
  
  // Event handlers
  
  private onKeyDown(event: KeyboardEvent): void {
    this.inputState.pressedKeys.add(event.code);
    
    // Update action mappings
    for (const mapping of this.actionMappings) {
      if (mapping.keyCode === event.code) {
        mapping.pressed = true;
      }
    }
    
    // Handle debug toggles immediately (not part of simulation input)
    switch (event.code) {
      case 'KeyL':
        // Debug toggle handled by client application
        break;
      case 'KeyP':
        // Plank bounds toggle handled by client application
        break;
      case 'KeyT':
        // Collision tracker toggle handled by client application
        break;
      case 'KeyN':
        // Water mode toggle handled by client application
        break;
      case 'KeyC':
        // Camera mode toggle handled by client application
        break;
    }
  }
  
  private onKeyUp(event: KeyboardEvent): void {
    this.inputState.pressedKeys.delete(event.code);
    
    // Update action mappings
    for (const mapping of this.actionMappings) {
      if (mapping.keyCode === event.code) {
        mapping.pressed = false;
      }
    }
  }
  
  private onMouseMove(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.inputState.mousePosition = Vec2.from(
      event.clientX - rect.left,
      event.clientY - rect.top
    );
  }
  
  private onMouseDown(event: MouseEvent): void {
    event.preventDefault();
    
    if (event.button === 0) { // Left mouse button
      this.inputState.leftMouseDown = true;
      
      // HYBRID PROTOCOL: Send fire action event
      if (this.onActionEvent) {
        this.onActionEvent('fire_cannon', this.inputState.mouseWorldPosition);
      }
    } else if (event.button === 2) { // Right mouse button
      this.inputState.rightMouseDown = true;
    }
  }
  
  private onMouseUp(event: MouseEvent): void {
    event.preventDefault();
    
    if (event.button === 0) { // Left mouse button
      this.inputState.leftMouseDown = false;
      this.inputState.leftMouseReleased = true;
    } else if (event.button === 2) { // Right mouse button
      this.inputState.rightMouseDown = false;
    }
  }
  
  private onMouseWheel(event: WheelEvent): void {
    event.preventDefault();
    // Mouse wheel zoom is handled by camera system
  }
  
  private onContextMenu(event: Event): void {
    event.preventDefault(); // Prevent right-click context menu
  }
  
  private onGamepadConnected(event: GamepadEvent): void {
    console.log('🎮 Gamepad connected:', event.gamepad.id);
    this.inputState.gamepadConnected = true;
  }
  
  private onGamepadDisconnected(event: GamepadEvent): void {
    console.log('🎮 Gamepad disconnected:', event.gamepad.id);
    this.inputState.gamepadConnected = false;
    this.inputState.gamepadState = null;
  }
}