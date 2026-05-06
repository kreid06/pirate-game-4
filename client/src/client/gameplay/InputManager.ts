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

  // Stored bound handlers so removeEventListeners can actually remove them
  private boundOnKeyDown!: (e: KeyboardEvent) => void;
  private boundOnKeyUp!: (e: KeyboardEvent) => void;
  private boundOnMouseMove!: (e: MouseEvent) => void;
  private boundOnMouseDown!: (e: MouseEvent) => void;
  private boundOnMouseUp!: (e: MouseEvent) => void;
  private boundOnMouseWheel!: (e: WheelEvent) => void;
  private boundOnContextMenu!: (e: MouseEvent) => void;
  private boundOnBlur!: () => void;
  private boundOnVisibilityChange!: () => void;
  private boundOnGamepadConnected!: (e: GamepadEvent) => void;
  private boundOnGamepadDisconnected!: (e: GamepadEvent) => void;

  // Movement heartbeat — resend current movement every 150ms while keys are held
  // so the server's inactivity timeout doesn't fire during sustained keypresses.
  private movementHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly MOVEMENT_HEARTBEAT_INTERVAL = 150;
  
  // Event callbacks
  public onInputFrame: ((inputFrame: InputFrame) => void) | null = null;
  
  // HYBRID PROTOCOL: Callbacks for state changes
  public onMovementStateChange: ((movement: Vec2, isMoving: boolean, isSprinting: boolean) => void) | null = null;
  public onRotationUpdate: ((rotation: number) => void) | null = null;
  public onActionEvent: ((action: string, target?: Vec2) => void) | null = null;
  
  // Ship control callbacks (when mounted to helm)
  public onShipSailControl: ((desiredOpenness: number) => void) | null = null;
  public onShipRudderControl: ((turningLeft: boolean, turningRight: boolean, movingBackward: boolean) => void) | null = null;
  public onShipSailAngleControl: ((desiredAngle: number) => void) | null = null;
  
  // Cannon control callbacks
  public onCannonAim: ((aimAngle: number, activeGroups: number[]) => void) | null = null;
  public onSwivelAim: ((aimAngle: number) => void) | null = null;
  public onCannonFire: ((cannonIds?: number[], fireAll?: boolean, ammoType?: number, weaponGroup?: number, weaponGroups?: Set<number>) => void) | null = null;

  // Inventory callbacks
  public onSlotSelect: ((slot: number) => void) | null = null;
  /** Q key — deselect the active hotbar slot (unequip). */
  public onUnequip: (() => void) | null = null;
  /** Digit 1–9 on helm — selects weapon group 0–9. */
  public onWeaponGroupSelect: ((group: number) => void) | null = null;
  /** Shift+left-click on a cannon toggles it in/out of the active weapon group. */
  public onGroupAssign: (() => void) | null = null;
  /** Ctrl+Digit while hovering a cannon — assign it directly to the given group index. */
  public onGroupAssignTo: ((group: number) => void) | null = null;
  /** Right-click intercepted by UI (e.g. cycling weapon group mode on hotbar). Returns true if consumed. */
  public onUIRightClick: ((x: number, y: number) => boolean) | null = null;
  /** Right-click on world while on helm in targetfire mode — world position to lock onto. */
  public onGroupTarget: ((worldPos: Vec2) => void) | null = null;
  /** Called when right-click aiming begins (right mouse pressed, not consumed by UI or targetfire). */
  public onAimStart: (() => void) | null = null;
  /** Called when right-click aiming ends (right mouse released). */
  public onAimEnd: (() => void) | null = null;
  /** Called at the very start of any right-click (button 2 down). Return true to consume the event and skip all other right-click handling. */
  public onBeforeRightClick: (() => boolean) | null = null;
  /** Called at the very start of any left-click (button 0 down, after UI/shift/ctrl checks).
   *  Return true to consume the event — fires onActionEvent('attack') then skips all other handling. */
  public onBeforeLeftClick: (() => boolean) | null = null;

  // UI click intercept — return true to consume the click before game logic runs
  public onUIClick: ((x: number, y: number) => boolean) | null = null;

  // Build mode — set when a buildable item (e.g. plank) is in the active hotbar slot
  public buildMode: boolean = false;
  public onBuildPlace: ((worldPos: Vec2) => void) | null = null;

  // Explicit build mode (toggled with B key — independent of hotbar items)
  public explicitBuildMode: boolean = false;
  public islandBuildMode: boolean = false;
  public onBuildModeToggle: (() => void) | null = null;
  public onToggleAllLadders: (() => void) | null = null;
  public onBuildRotate: ((deltaDeg: number) => void) | null = null;
  /** Called when R is pressed while hovering a damaged mast (not in explicit build mode). */
  public onRepairSail: (() => void) | null = null;

  // Build menu (B key — open panel + ghost placement system)
  /** True while the build menu panel is open. Affects right-click and other input. */
  public buildMenuOpen: boolean = false;
  /** Right-click while build menu is open — fires with world position. */
  public onBuildRightClick: ((worldPos: Vec2) => void) | null = null;

  // Camera zoom callback
  public onZoom: ((factor: number, screenPoint: Vec2) => void) | null = null;

  // UI overlay input hooks — called before game input is processed
  /** Called on every mousemove so overlays (e.g. world map) can update drag state. */
  public onUIMouseMove: ((x: number, y: number) => void) | null = null;
  /** Called on left mouse-up so overlays can end drag. */
  public onUIMouseUp: ((x: number, y: number) => void) | null = null;
  /** Called before onZoom — if returns true, zoom is consumed by UI (e.g. world map). */
  public onUIWheel: ((deltaY: number, x: number, y: number) => boolean) | null = null;
  
  // HYBRID PROTOCOL: State tracking for change detection
  private previousMovementState: Vec2 = Vec2.zero();
  private previousSprintState: boolean = false;
  private lastSentRotation: number = 0;
  private readonly ROTATION_THRESHOLD = 0.0524; // 3 degrees in radians
  
  // Ship control state tracking
  private mountKind: 'none' | 'helm' | 'cannon' | 'mast' | 'swivel' = 'none';
  private get isMountedToHelm(): boolean { return this.mountKind === 'helm'; }
  /** Mode of the currently active (primary) weapon group — kept in sync by ClientApplication. */
  public activeGroupMode: string = 'haltfire';

  /** Primary active weapon group (last one solo-selected). Used for assign/mode-cycle/targetfire. */
  public activeWeaponGroup: number = -1;
  /** All currently selected weapon groups. Digit alone = solo; Ctrl+Digit = toggle add/remove. */
  public activeWeaponGroups: Set<number> = new Set();
  /** Returns the current mount kind. */
  public getMountKind(): string { return this.mountKind; }
  /** Returns true while Shift is currently held — used to show weapon group overlay. */
  public isShiftHeld(): boolean {
    return this.inputState.pressedKeys.has('ShiftLeft') || this.inputState.pressedKeys.has('ShiftRight');
  }
  /**
   * Returns true when either Ctrl key is held.
   * Detects ControlLeft and ControlRight so it works consistently across
   * macOS (Control ≠ Command), Windows, and Linux keyboards.
   */
  public isCtrlHeld(): boolean {
    return this.inputState.pressedKeys.has('ControlLeft') || this.inputState.pressedKeys.has('ControlRight');
  }
  private currentSailOpenness: number = 100; // Start at 100% (full sails)
  private currentSailAngle: number = 0; // Start at 0 degrees
  private lastRudderState: { left: boolean; right: boolean; backward: boolean } = { left: false, right: false, backward: false };
  private lastSailOpenness: number = 100;
  private lastSailAngle: number = 0;
  private lastSailOpennessChangeTime: number = 0; // Track last sail openness change
  private lastSailAngleChangeTime: number = 0; // Track last sail angle change
  private readonly SAIL_OPENNESS_COOLDOWN = 100; // 0.1s per 10% change
  private readonly SAIL_ANGLE_COOLDOWN = 100; // 0.1s per 6° change
  
  /** True while right mouse button is held down. */
  public get isRightMouseDown(): boolean {
    return this.inputState.rightMouseDown;
  }

  // Cannon aiming state
  /** True while the player is mounted to a cannon and holding right-mouse to aim. */
  public get isCannonAiming(): boolean {
    return (this.mountKind === 'cannon' || this.mountKind === 'swivel') && this.inputState.rightMouseDown;
  }
  /** ID of the cannon module the player is currently mounted to, or null. */
  public mountedCannonModuleId: number | null = null;
  private lastCannonAimAngle: number = 0;
  /** Selected ammo type: 0 = cannonball, 1 = bar shot. Toggle with X key. */
  public selectedAmmoType: number = 0;    // Pending ammo (to load after next fire)
  public loadedAmmoType: number = 0;      // What's physically in the barrel right now
  private xHoldTimer: ReturnType<typeof setTimeout> | null = null;  // setTimeout handle for 1s hold
  private xHoldFired: boolean = false;    // True if hold timer already fired this press
  private flameStreamTimer: ReturnType<typeof setInterval> | null = null; // Liquid flame continuous stream
  private flameAmmoSwitchTimer: ReturnType<typeof setTimeout> | null = null; // Post-flame ammo reload delay
  /** Active ammo group while at helm: 'cannon' (IDs 0-1) or 'swivel' (IDs 10-12). Toggle with U key. */
  public activeAmmoGroup: 'cannon' | 'swivel' = 'cannon';

  /** Called when player holds X (1s) to force-reload with the pending ammo type. */
  public onForceReload: (() => void) | null = null;

  /** Returns what ammo type is currently loaded (for aim guides and fire messages). */
  public getLoadedAmmoType(): number { return this.loadedAmmoType; }
  /** Resets loaded and pending ammo type to cannonball (0). Call when boarding a new ship. */
  public resetAmmoType(): void { this.selectedAmmoType = 0; this.loadedAmmoType = 0; }
  /** Current aim angle relative to ship — updated every frame while right-mouse is held. */
  public get cannonAimAngleRelative(): number { return this.lastCannonAimAngle; }
  private lastLeftClickTime: number = 0;
  private readonly DOUBLE_CLICK_THRESHOLD = 300; // 300ms for double-click detection
  private currentShipId: number | null = null; // Track which ship player is on for aim calculation
  private currentShipRotation: number = 0; // Track ship's current rotation for relative aiming
  
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
    
    // Handle cannon aiming (works whether on ship or not)
    this.handleCannonAiming();
    
    // If mounted to helm, handle ship controls instead of player movement
    if (this.mountKind === 'helm') {
      this.handleShipControls();
      this.resetFrameFlags();
      return; // Skip normal player input processing
    }

    // If mounted to cannon/mast/swivel, handle interact-to-dismount only
    if (this.mountKind === 'cannon' || this.mountKind === 'mast' || this.mountKind === 'swivel') {
      if (this.isActionActive('interact') && this.canInteract()) {
        this.lastInteractionTime = Date.now();
        if (this.onActionEvent) this.onActionEvent('dismount');
      }
      this.resetFrameFlags();
      return; // Locked to mount position
    }
    
    // Generate current input frame
    this.generateInputFrame();
    
    // HYBRID PROTOCOL: Detect movement state changes
    const currentMovement = this.currentInputFrame.movement;
    const isSprinting = this.isShiftHeld() && this.isActionActive('move_forward');
    const movementChanged = !currentMovement.equals(this.previousMovementState);
    const sprintChanged = isSprinting !== this.previousSprintState;
    if (movementChanged || sprintChanged) {
      const isMoving = currentMovement.lengthSq() > 0.01;
      if (this.onMovementStateChange) {
        this.onMovementStateChange(currentMovement, isMoving, isSprinting);
        this.lastStopSentTime = Date.now();
      }
      this.previousMovementState = currentMovement.clone();
      this.previousSprintState = isSprinting;

      // Start or stop heartbeat based on whether we're now moving
      if (isMoving) {
        this.startMovementHeartbeat();
      } else {
        this.stopMovementHeartbeat();
      }
    }
    
    // HYBRID PROTOCOL: Detect if player released keys but is still moving (server-side friction)
    // Resend stop message periodically until player actually stops
    const noInput = currentMovement.lengthSq() < 0.01;
    const stillMoving = this.playerVelocity.lengthSq() > this.VELOCITY_STOP_THRESHOLD * this.VELOCITY_STOP_THRESHOLD;
    const timeSinceLastStop = Date.now() - this.lastStopSentTime;
    
    if (noInput && stillMoving && timeSinceLastStop > this.STOP_RESEND_INTERVAL) {
      // Player released keys but server hasn't stopped them yet - resend stop
      if (this.onMovementStateChange) {
        this.onMovementStateChange(Vec2.zero(), false, false);
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
      

    }
    
    // Walking right-click = block
    if (this.inputState.rightMouseDown && this.mountKind === 'none') {
      if (this.onActionEvent) this.onActionEvent('block');
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
   * Set current ship ID (for cannon aiming calculations)
   */
  setCurrentShipId(shipId: number | null): void {
    this.currentShipId = shipId;
  }
  
  /**
   * Set current ship rotation (for ship-relative cannon aiming)
   */
  setCurrentShipRotation(rotation: number): void {
    // Guard against Infinity / -Infinity (|| 0 only catches NaN, not Infinity)
    this.currentShipRotation = Number.isFinite(rotation) ? rotation : 0;
  }
  
  /**
   * Get current input frame
   */
  getCurrentInputFrame(): InputFrame {
    return { ...this.currentInputFrame };
  }
  
  /**
   * Get current mouse position in screen coordinates
   */
  getMouseScreenPosition(): Vec2 {
    return this.inputState.mousePosition.clone();
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
   * Set mount state (called when player mounts/dismounts a module)
   */
  setMountState(mounted: boolean, shipId?: number, moduleKind: string = 'none', moduleId?: number, initialSailOpenness?: number): void {
    this.mountKind = mounted ? (moduleKind.toLowerCase() as 'helm' | 'cannon' | 'mast' | 'swivel') : 'none';
    this.currentShipId = shipId !== undefined ? shipId : null;
    this.mountedCannonModuleId = (mounted && (moduleKind.toLowerCase() === 'cannon' || moduleKind.toLowerCase() === 'swivel') && moduleId != null) ? moduleId : null;

    if (mounted) {
      console.log(`⚓ [INPUT] Player mounted to ${moduleKind} on ship ${shipId}`);
      if (this.mountKind === 'helm') {
        // Seed from the server's current sail openness so W/S work immediately
        const seeded = initialSailOpenness ?? 100;
        this.currentSailOpenness = seeded;
        this.lastSailOpenness    = seeded;
        this.currentSailAngle = 0;
        this.lastSailAngle = 0;
        this.lastRudderState = { left: false, right: false, backward: false };
        this.lastSailOpennessChangeTime = 0;
        this.lastSailAngleChangeTime = 0;
        this.activeAmmoGroup = 'cannon';
        console.log(`⛵ [INPUT] Seeded sail openness to ${seeded}% on mount`);
      } else if (this.mountKind === 'swivel') {
        // Swivel uses its own ammo types (10=grapeshot, 11=liquid flame, 12=canister shot)
        this.selectedAmmoType = 10;
        this.loadedAmmoType   = 10;
      }
    } else {
      console.log(`⚓ [INPUT] Player dismounted - player controls active`);
      this.activeWeaponGroup = -1;
      this.activeWeaponGroups.clear();
      // Stop any active flame stream on dismount
      if (this.flameStreamTimer !== null) {
        clearInterval(this.flameStreamTimer);
        this.flameStreamTimer = null;
      }
      if (this.flameAmmoSwitchTimer !== null) {
        clearTimeout(this.flameAmmoSwitchTimer);
        this.flameAmmoSwitchTimer = null;
      }
    }
  }

  /**
   * Handle ship controls when mounted to helm
   */
  private handleShipControls(): void {
    const shiftPressed = this.inputState.pressedKeys.has('ShiftLeft') || this.inputState.pressedKeys.has('ShiftRight');
    
    // Rudder control (A/D without shift)
    if (!shiftPressed) {
      const turningLeft = this.isActionActive('ship_move_left');
      const turningRight = this.isActionActive('ship_move_right');
      const movingBackward = this.isActionActive('ship_move_backward');
      
      // Send rudder control if any state changed
      if (turningLeft !== this.lastRudderState.left ||
          turningRight !== this.lastRudderState.right ||
          movingBackward !== this.lastRudderState.backward) {
        if (this.onShipRudderControl) {
          this.onShipRudderControl(turningLeft, turningRight, movingBackward);
        }
        this.lastRudderState = { left: turningLeft, right: turningRight, backward: movingBackward };
      }
      
      // Sail openness control (W/S without shift)
      const openSails = this.isActionActive('ship_move_forward');
      const closeSails = this.isActionActive('ship_move_backward');
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
      const rotateLeft = this.isActionActive('ship_move_left');
      const rotateRight = this.isActionActive('ship_move_right');
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
    
    // Handle interact key to dismount helm
    if (this.isActionActive('ship_interact') && this.canInteract()) {
      this.lastInteractionTime = Date.now();
      if (this.onActionEvent) {
        this.onActionEvent('dismount');
      }
    }
  }
  
  /**
   * Handle cannon aiming (right-click + mouse movement)
   * Calculates aim angle relative to ship rotation (or world angle for island cannons)
   */
  private handleCannonAiming(): void {
    // Only send aiming updates when right mouse is held
    if (!this.inputState.rightMouseDown) {
      return;
    }

    // Only aim when mounted to helm, cannon, or swivel
    if (this.mountKind !== 'helm' && this.mountKind !== 'cannon' && this.mountKind !== 'swivel') {
      return;
    }

    // Island cannon: currentShipId is null — still allow aiming, send world angle
    const isIslandCannon = this.currentShipId === null && this.mountKind === 'cannon';

    // Ship-mounted cannons/helm/swivel still require a ship
    if (!isIslandCannon && this.currentShipId === null) {
      return;
    }

    // Calculate aim angle from player position to mouse position (world coordinates)
    const dx = this.inputState.mouseWorldPosition.x - this.playerPosition.x;
    const dy = this.inputState.mouseWorldPosition.y - this.playerPosition.y;

    // Always aim toward mouse — no range limit (server enforces fire range separately)
    const aimAngleWorld = Math.atan2(dy, dx);

    // Island cannon: send raw world angle (server stores in cannon_aim_angle directly)
    // Ship cannon: convert to ship-relative angle
    let aimAngle: number;
    if (isIslandCannon) {
      aimAngle = aimAngleWorld;
    } else {
      aimAngle = aimAngleWorld - this.currentShipRotation;
    }

    // Normalize to [-π, π] — O(1), immune to ±Infinity / NaN
    if (!Number.isFinite(aimAngle)) return;
    const TWO_PI = 2 * Math.PI;
    aimAngle -= TWO_PI * Math.floor((aimAngle + Math.PI) / TWO_PI);

    // Only send if aim changed significantly (>1 degree)
    const ANGLE_THRESHOLD = 0.017; // ~1 degree in radians
    const angleDelta = Math.abs(aimAngle - this.lastCannonAimAngle);

    if (angleDelta > ANGLE_THRESHOLD) {
      if (this.mountKind === 'swivel') {
        // Swivel: use dedicated swivel_aim message (server applies ±45° limit)
        if (this.onSwivelAim) {
          this.onSwivelAim(aimAngle);
        }
      } else if (this.onCannonAim) {
        this.onCannonAim(aimAngle, [...this.activeWeaponGroups]);
      }
      this.lastCannonAimAngle = aimAngle;
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
    this.stopMovementHeartbeat();
    this.removeEventListeners();
    console.log('🎮 Input manager shutdown');
  }
  
  // Private methods
  
  private setupEventListeners(): void {
    // Bind and store handlers so they can be properly removed later
    this.boundOnKeyDown = this.onKeyDown.bind(this);
    this.boundOnKeyUp = this.onKeyUp.bind(this);
    this.boundOnMouseMove = this.onMouseMove.bind(this);
    this.boundOnMouseDown = this.onMouseDown.bind(this);
    this.boundOnMouseUp = this.onMouseUp.bind(this);
    this.boundOnMouseWheel = this.onMouseWheel.bind(this);
    this.boundOnContextMenu = this.onContextMenu.bind(this);
    this.boundOnGamepadConnected = this.onGamepadConnected.bind(this);
    this.boundOnGamepadDisconnected = this.onGamepadDisconnected.bind(this);

    // Keyboard events
    window.addEventListener('keydown', this.boundOnKeyDown);
    window.addEventListener('keyup', this.boundOnKeyUp);
    
    // Mouse events
    this.canvas.addEventListener('mousemove', this.boundOnMouseMove);
    this.canvas.addEventListener('mousedown', this.boundOnMouseDown);
    this.canvas.addEventListener('mouseup', this.boundOnMouseUp);
    this.canvas.addEventListener('wheel', this.boundOnMouseWheel);
    this.canvas.addEventListener('contextmenu', this.boundOnContextMenu);
    
    // Clear all input when the window loses focus (prevents stuck keys on tab-out)
    this.boundOnBlur = () => this.clearAllInput();
    this.boundOnVisibilityChange = () => { if (document.hidden) this.clearAllInput(); };
    window.addEventListener('blur', this.boundOnBlur);
    document.addEventListener('visibilitychange', this.boundOnVisibilityChange);

    // Gamepad events (future)
    window.addEventListener('gamepadconnected', this.boundOnGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.boundOnGamepadDisconnected);
    
    console.log('🎮 Input event listeners setup');
  }
  
  private removeEventListeners(): void {
    window.removeEventListener('keydown', this.boundOnKeyDown);
    window.removeEventListener('keyup', this.boundOnKeyUp);
    this.canvas.removeEventListener('mousemove', this.boundOnMouseMove);
    this.canvas.removeEventListener('mousedown', this.boundOnMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundOnMouseUp);
    this.canvas.removeEventListener('wheel', this.boundOnMouseWheel);
    this.canvas.removeEventListener('contextmenu', this.boundOnContextMenu);
    window.removeEventListener('blur', this.boundOnBlur);
    document.removeEventListener('visibilitychange', this.boundOnVisibilityChange);
    window.removeEventListener('gamepadconnected', this.boundOnGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.boundOnGamepadDisconnected);
  }

  /** Clear all pressed keys and send a stop — called on blur/visibility-hidden. */
  private clearAllInput(): void {
    this.inputState.pressedKeys.clear();
    this.inputState.leftMouseDown = false;
    this.inputState.rightMouseDown = false;
    for (const mapping of this.actionMappings) {
      mapping.pressed = false;
    }
    this.stopMovementHeartbeat();
    if (this.onMovementStateChange) {
      this.onMovementStateChange(Vec2.zero(), false, false);
    }
    this.previousMovementState = Vec2.zero();
    this.previousSprintState = false;
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
    
    // Sprint action (Shift + forward key)
    if (this.isShiftHeld() && this.isActionActive('move_forward')) {
      actions |= PlayerActions.SPRINT;
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

  /** Start a repeating heartbeat that refreshes the server's movement state while keys are held. */
  private startMovementHeartbeat(): void {
    if (this.movementHeartbeatTimer !== null) return; // already running
    this.movementHeartbeatTimer = setInterval(() => {
      const m = this.previousMovementState;
      const isMoving = m.lengthSq() > 0.01;
      if (!isMoving) {
        this.stopMovementHeartbeat();
        return;
      }
      const sprint = this.previousSprintState;
      if (this.onMovementStateChange) {
        this.onMovementStateChange(m, true, sprint);
      }
    }, this.MOVEMENT_HEARTBEAT_INTERVAL);
  }

  private stopMovementHeartbeat(): void {
    if (this.movementHeartbeatTimer !== null) {
      clearInterval(this.movementHeartbeatTimer);
      this.movementHeartbeatTimer = null;
    }
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
        if (this.onToggleAllLadders) this.onToggleAllLadders();
        event.preventDefault();
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
        break;      case 'KeyB':
        // Toggle explicit build mode
        if (this.onBuildModeToggle) this.onBuildModeToggle();
        event.preventDefault();
        break;
      case 'KeyR':
        // In explicit build mode, plan mode, or island build mode: rotate the placement ghost.
        // Otherwise: repair sail fibers on the hovered damaged mast.
        if ((this.explicitBuildMode || this.buildMenuOpen || this.islandBuildMode) && this.onBuildRotate) {
          this.onBuildRotate(15);
          event.preventDefault();
        } else if (!this.explicitBuildMode && !this.buildMenuOpen && !this.islandBuildMode && this.onRepairSail) {
          this.onRepairSail();
          event.preventDefault();
        }
        break;
      case 'KeyX':
        // Toggle ammo type when mounted to a cannon or helm
        // On initial press: start a 1s timer — if it fires, force swap immediately
        // On release before 1s: cancel timer, queue the swap instead
        if (this.mountKind === 'cannon' || this.mountKind === 'helm') {
          if (!event.repeat) {
            this.xHoldFired = false;
            this.xHoldTimer = setTimeout(() => {
              this.xHoldFired = true;
              const useSwivelGroup = this.mountKind === 'helm' && this.activeAmmoGroup === 'swivel';
              if (useSwivelGroup) {
                const swivelAmmos = [10, 11, 12];
                if (this.selectedAmmoType === this.loadedAmmoType) {
                  const idx = swivelAmmos.indexOf(this.selectedAmmoType);
                  this.selectedAmmoType = swivelAmmos[(idx < 0 ? 0 : (idx + 1)) % 3];
                }
                this.loadedAmmoType = this.selectedAmmoType;
                const swivelNames: Record<number, string> = { 10: 'GRAPESHOT', 11: 'LIQUID FLAME', 12: 'CANISTER SHOT' };
                console.log(`⚡ Helm swivel ammo force-loaded → ${swivelNames[this.loadedAmmoType]}`);
              } else {
                if (this.selectedAmmoType === this.loadedAmmoType) {
                  this.selectedAmmoType = this.selectedAmmoType === 0 ? 1 : 0;
                }
                this.loadedAmmoType = this.selectedAmmoType;
                const ammoNames = ['CANNONBALL', 'BAR SHOT'];
                console.log(`⚡ Ammo force-loaded → ${ammoNames[this.loadedAmmoType]}`);
              }
              if (this.onForceReload) this.onForceReload();
            }, 500);
          }
          event.preventDefault();
        } else if (this.mountKind === 'swivel') {
          if (!event.repeat) {
            const swivelAmmos = [10, 11, 12]; // GRAPESHOT, LIQUID_FLAME, CANISTER_SHOT
            const ammoNames: Record<number, string> = { 10: 'GRAPESHOT', 11: 'LIQUID FLAME', 12: 'CANISTER SHOT' };
            this.xHoldFired = false;
            this.xHoldTimer = setTimeout(() => {
              this.xHoldFired = true;
              // Cycle to next swivel ammo type and force-load immediately
              if (this.selectedAmmoType === this.loadedAmmoType) {
                const idx = swivelAmmos.indexOf(this.selectedAmmoType);
                this.selectedAmmoType = swivelAmmos[(idx < 0 ? 0 : (idx + 1)) % 3];
              }
              this.loadedAmmoType = this.selectedAmmoType;
              console.log(`⚡ Swivel ammo force-loaded → ${ammoNames[this.loadedAmmoType]}`);
              if (this.onForceReload) this.onForceReload();
            }, 500);
          }
          event.preventDefault();
        }
        break;      // Hotbar slots: Digit1-Digit9 → slots 0-8, Digit0 → slot 9
      case 'KeyU':
        // Toggle active ammo group between cannon and swivel while at helm
        if (this.mountKind === 'helm') {
          this.activeAmmoGroup = this.activeAmmoGroup === 'cannon' ? 'swivel' : 'cannon';
          // Snap to a valid ammo for the newly active group
          if (this.activeAmmoGroup === 'swivel') {
            if (![10, 11, 12].includes(this.selectedAmmoType)) {
              this.selectedAmmoType = 10;
              this.loadedAmmoType   = 10;
            }
          } else {
            if (![0, 1].includes(this.selectedAmmoType)) {
              this.selectedAmmoType = 0;
              this.loadedAmmoType   = 0;
            }
          }
          console.log(`🔄 Helm ammo group → ${this.activeAmmoGroup.toUpperCase()}`);
          event.preventDefault();
        }
        break;
      case 'KeyF':
        if (this.onUnequip) this.onUnequip();
        event.preventDefault();
        break;
      case 'KeyQ':
        // In build mode or island build mode: rotate ghost left; otherwise no-op
        if ((this.explicitBuildMode || this.buildMenuOpen || this.islandBuildMode) && this.onBuildRotate) {
          this.onBuildRotate(-15);
          event.preventDefault();
        }
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
      case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9':
        if (this.mountKind === 'helm') {
          const digit = parseInt(event.code.replace('Digit', ''));
          const groupIdx = digit; // Key 1→G1, Key 2→G2, …, Key 9→G9
          if (this.isCtrlHeld()) {
            // Ctrl+Digit: assign hovered cannon to this group without changing selection
            if (this.onGroupAssignTo) this.onGroupAssignTo(groupIdx);
          } else {
            if (this.activeWeaponGroups.has(groupIdx)) {
              this.activeWeaponGroups.delete(groupIdx);
              if (this.activeWeaponGroup === groupIdx) {
                this.activeWeaponGroup = this.activeWeaponGroups.size > 0
                  ? [...this.activeWeaponGroups][this.activeWeaponGroups.size - 1] : -1;
              }
            } else {
              this.activeWeaponGroups.add(groupIdx);
              this.activeWeaponGroup = groupIdx;
            }
            // Force next handleCannonAiming() to re-send aim with updated group list
            // even if the mouse hasn't moved, so the server learns about the new selection.
            this.lastCannonAimAngle = Infinity;
            if (this.onWeaponGroupSelect) this.onWeaponGroupSelect(this.activeWeaponGroup);
          }
          event.preventDefault();
        } else {
          if (this.onSlotSelect) this.onSlotSelect(parseInt(event.code.replace('Digit', '')) - 1);
        }
        break;
      case 'Digit0':
        if (this.mountKind === 'helm') {
          const groupIdx = 0; // Key 0→G0
          if (this.isCtrlHeld()) {
            // Ctrl+0: assign hovered cannon to group 9 without changing selection
            if (this.onGroupAssignTo) this.onGroupAssignTo(groupIdx);
          } else {
            if (this.activeWeaponGroups.has(groupIdx)) {
              this.activeWeaponGroups.delete(groupIdx);
              if (this.activeWeaponGroup === groupIdx) {
                this.activeWeaponGroup = this.activeWeaponGroups.size > 0
                  ? [...this.activeWeaponGroups][this.activeWeaponGroups.size - 1] : -1;
              }
            } else {
              this.activeWeaponGroups.add(groupIdx);
              this.activeWeaponGroup = groupIdx;
            }
            this.lastCannonAimAngle = Infinity;
            if (this.onWeaponGroupSelect) this.onWeaponGroupSelect(this.activeWeaponGroup);
          }
          event.preventDefault();
        } else {
          if (this.onSlotSelect) this.onSlotSelect(9);
        }
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

    // X key ammo logic:
    //   hold 1s (timer fires while key is down) → force-load immediately
    //   release before 1s                       → queue the swap for after next fire
    if (event.code === 'KeyX' && (this.mountKind === 'cannon' || this.mountKind === 'helm' || this.mountKind === 'swivel')) {
      if (this.xHoldTimer !== null) {
        clearTimeout(this.xHoldTimer);
        this.xHoldTimer = null;
      }
      if (!this.xHoldFired) {
        // Released before 1s — queue the swap
        if (this.mountKind === 'swivel' || (this.mountKind === 'helm' && this.activeAmmoGroup === 'swivel')) {
          const swivelAmmos = [10, 11, 12];
          const ammoNames: Record<number, string> = { 10: 'GRAPESHOT', 11: 'LIQUID FLAME', 12: 'CANISTER SHOT' };
          const idx = swivelAmmos.indexOf(this.selectedAmmoType);
          this.selectedAmmoType = swivelAmmos[(idx < 0 ? 0 : (idx + 1)) % 3];
          console.log(`💣 Swivel ammo queued → ${ammoNames[this.selectedAmmoType]} (hold X 0.5s to load now)`);
        } else {
          this.selectedAmmoType = this.selectedAmmoType === 0 ? 1 : 0;
          const ammoNames = ['CANNONBALL', 'BAR SHOT'];
          console.log(`💣 Ammo queued → ${ammoNames[this.selectedAmmoType]} (hold X 0.5s to load now)`);
        }
      }
      // If xHoldFired is true the force-load already happened — nothing more to do
    }
  }
  
  private onMouseMove(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.inputState.mousePosition = Vec2.from(
      event.clientX - rect.left,
      event.clientY - rect.top
    );
    if (this.onUIMouseMove) {
      this.onUIMouseMove(this.inputState.mousePosition.x, this.inputState.mousePosition.y);
    }
  }
  
  private onMouseDown(event: MouseEvent): void {
    event.preventDefault();
    
    if (event.button === 0) { // Left mouse button
      // Shift+click toggles cannon group membership — check before any UI consumption
      if (event.shiftKey) {
        if (this.onGroupAssign) this.onGroupAssign();
        return;
      }

      // Let UI panels consume the click first (e.g. manning priority panel)
      if (this.onUIClick && this.onUIClick(event.offsetX, event.offsetY)) {
        this.inputState.leftMouseDown = false;
        return;
      }

      this.inputState.leftMouseDown = true;
      
      if (this.buildMode) {
        // Build mode: left click places a building item (e.g. plank) at cursor
        if (this.onBuildPlace) {
          this.onBuildPlace(this.inputState.mouseWorldPosition);
        }
        return;
      }

      const now = Date.now();
      const timeSinceLastClick = now - this.lastLeftClickTime;
      const isDoubleClick = timeSinceLastClick < this.DOUBLE_CLICK_THRESHOLD;

      // Shift+left-click is handled at the top of onMouseDown — unreachable here
      if (this.isCtrlHeld()) {
        // Ctrl+click while mounted: toggle cannon group membership
        if (this.onGroupAssign) this.onGroupAssign();
      } else if (this.mountKind === 'none') {
        // Walking: left-click = attack toward mouse
        if (this.onActionEvent) {
          this.onActionEvent('attack', this.inputState.mouseWorldPosition);
        }
      } else if (this.onBeforeLeftClick && this.onBeforeLeftClick()) {
        // Intercept hook consumed the click (e.g. Move To mode) — emit attack and skip cannon fire
        if (this.onActionEvent) this.onActionEvent('attack', this.inputState.mouseWorldPosition);
      } else {
        // Mounted to helm, cannon, or swivel: fire weapon(s)
        // Flame mode: ammo_type 11 (liquid flame) always streams regardless of activeAmmoGroup toggle
        const isFlameMode = this.loadedAmmoType === 11 &&
          (this.mountKind === 'swivel' || this.mountKind === 'helm');
        if (isFlameMode) {
          // Liquid flame: fire immediately then stream while mouse is held
          const wg  = this.mountKind === 'helm' ? this.activeWeaponGroup  : undefined;
          const wgs = this.mountKind === 'helm' ? this.activeWeaponGroups : undefined;
          if (this.onCannonFire) this.onCannonFire(undefined, false, this.loadedAmmoType, wg, wgs);
          if (this.flameStreamTimer === null) {
            this.flameStreamTimer = setInterval(() => {
              if (this.onCannonFire) this.onCannonFire(undefined, false, this.loadedAmmoType, wg, wgs);
            }, 100);
          }
        } else if (isDoubleClick) {
          console.log('💥💥 Double-click: Fire ALL cannons!');
          if (this.onCannonFire) this.onCannonFire(undefined, true, this.loadedAmmoType, this.mountKind === 'helm' ? this.activeWeaponGroup : undefined, this.mountKind === 'helm' ? this.activeWeaponGroups : undefined);
          // Cannon will reload into the pending ammo type
          this.loadedAmmoType = this.selectedAmmoType;
        } else {
          console.log('💥 Single-click: Fire aimed cannons');
          if (this.onCannonFire) this.onCannonFire(undefined, false, this.loadedAmmoType, this.mountKind === 'helm' ? this.activeWeaponGroup : undefined, this.mountKind === 'helm' ? this.activeWeaponGroups : undefined);
          // Cannon will reload into the pending ammo type
          this.loadedAmmoType = this.selectedAmmoType;
        }
      }

      this.lastLeftClickTime = now;
      
    } else if (event.button === 2) { // Right mouse button
      // Early-out hook: allows callers to intercept all right-clicks (e.g. cancel Move To mode)
      if (this.onBeforeRightClick && this.onBeforeRightClick()) return;
      // Ctrl+right-click: toggle cannon group membership (same as Ctrl+left-click)
      if (this.isCtrlHeld()) {
        if (this.onGroupAssign) this.onGroupAssign();
        return;
      }
      // Build menu: right-click fires ghost-cancel / ghost-remove callback
      if (this.buildMenuOpen && this.onBuildRightClick) {
        this.onBuildRightClick(this.inputState.mouseWorldPosition);
      } else {
        if (this.onUIRightClick && this.onUIRightClick(event.offsetX, event.offsetY)) return;
        // Helm mode: target-lock only when the active group is in targetfire mode.
        // In aiming mode (or no group), right-click-drag aims cannons normally.
        if (this.mountKind === 'helm' && this.activeGroupMode === 'targetfire' && this.onGroupTarget) {
          this.onGroupTarget(this.inputState.mouseWorldPosition);
          return;
        }
        this.inputState.rightMouseDown = true;
        if (this.onAimStart) this.onAimStart();
        // Aiming will be handled in update() while right mouse is held
      }
    }
  }
  
  private onMouseUp(event: MouseEvent): void {
    event.preventDefault();
    
    if (event.button === 0) { // Left mouse button
      this.inputState.leftMouseDown = false;
      this.inputState.leftMouseReleased = true;
      if (this.onUIMouseUp) this.onUIMouseUp(event.offsetX, event.offsetY);
      // Stop liquid flame stream if running
      if (this.flameStreamTimer !== null) {
        clearInterval(this.flameStreamTimer);
        this.flameStreamTimer = null;
        // If a different ammo is queued, schedule reload after 1s (swivel re-chambers)
        if (this.selectedAmmoType !== this.loadedAmmoType) {
          if (this.flameAmmoSwitchTimer !== null) clearTimeout(this.flameAmmoSwitchTimer);
          this.flameAmmoSwitchTimer = setTimeout(() => {
            this.loadedAmmoType = this.selectedAmmoType;
            this.flameAmmoSwitchTimer = null;
          }, 1000);
        }
      }
    } else if (event.button === 2) { // Right mouse button
      if (this.inputState.rightMouseDown) {
        this.inputState.rightMouseDown = false;
        if (this.onAimEnd) this.onAimEnd();
      }
    }
  }
  
  private onMouseWheel(event: WheelEvent): void {
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;

    // Let UI overlays consume the wheel event first (e.g. world map zoom)
    if (this.onUIWheel && this.onUIWheel(event.deltaY, cx, cy)) return;

    if (!this.onZoom) return;

    const screenPoint = Vec2.from(cx, cy);
    // deltaY > 0 = scroll down = zoom out, < 0 = scroll up = zoom in
    const zoomFactor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.onZoom(zoomFactor, screenPoint);
  }
  
  private onContextMenu(event: Event): void {
    event.preventDefault(); // Prevent browser context menu
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