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
  
  // Event callbacks
  public onInputFrame: ((inputFrame: InputFrame) => void) | null = null;
  
  // Cooldowns and timing
  private lastInteractionTime = 0;
  private readonly interactionCooldown = 500; // 500ms
  
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
      actions: 0
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
    
    // Generate current input frame
    this.generateInputFrame();
    
    // Send input frame to network layer
    if (this.onInputFrame) {
      this.onInputFrame(this.currentInputFrame);
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
    // Calculate movement vector
    const movement = this.calculateMovementVector();
    
    // Calculate action bitmask
    const actions = this.calculateActionBitmask();
    
    // Create input frame
    this.currentInputFrame = {
      tick: this.inputFrameCounter++,
      movement,
      actions
    };
  }
  
  private calculateMovementVector(): Vec2 {
    let movement = Vec2.zero();
    
    // Check for movement keys
    const forward = this.isActionActive('move_forward');
    const backward = this.isActionActive('move_backward');
    const left = this.isActionActive('move_left');
    const right = this.isActionActive('move_right');
    
    // Calculate direction from player to mouse (for directional movement)
    // This will be handled by the game logic, for now just use WASD
    if (forward) movement = movement.add(Vec2.from(0, -1));
    if (backward) movement = movement.add(Vec2.from(0, 1));
    if (left) movement = movement.add(Vec2.from(-1, 0));
    if (right) movement = movement.add(Vec2.from(1, 0));
    
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