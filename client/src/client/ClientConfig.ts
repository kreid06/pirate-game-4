/**
 * Client Configuration System
 * 
 * Centralized configuration for all client-side systems.
 * This ensures consistent settings across the entire client.
 */

/**
 * Network configuration for client-server communication
 */
export interface NetworkConfig {
  serverUrl: string;
  maxReconnectAttempts: number;
  reconnectDelay: number; // milliseconds
  heartbeatInterval: number; // milliseconds
  timeoutDuration: number; // milliseconds
  protocol: 'websocket' | 'webtransport';
  fallbackToWebSocket: boolean;
}

/**
 * Graphics and rendering configuration
 */
export interface GraphicsConfig {
  targetFPS: number;
  vsync: boolean;
  antialiasing: boolean;
  particleQuality: 'low' | 'medium' | 'high';
  shadowQuality: 'none' | 'low' | 'medium' | 'high';
  textureQuality: 'low' | 'medium' | 'high';
  renderDistance: number; // world units
}

/**
 * Audio configuration
 */
export interface AudioConfig {
  masterVolume: number; // 0.0 to 1.0
  musicVolume: number; // 0.0 to 1.0
  sfxVolume: number; // 0.0 to 1.0
  voiceVolume: number; // 0.0 to 1.0
  enabled: boolean;
  spatialAudio: boolean;
}

/**
 * Input and controls configuration
 */
export interface InputConfig {
  mouseSensitivity: number;
  invertMouseY: boolean;
  keyBindings: Map<string, string>; // action -> key code
  gamepadEnabled: boolean;
  gamepadDeadzone: number; // 0.0 to 1.0
  enableDebugLogging: boolean; // Enable verbose movement debug logging
}

/**
 * Prediction and interpolation settings
 */
export interface PredictionConfig {
  clientTickRate: number; // Hz (typically 120 for responsive input)
  serverTickRate: number; // Hz (typically 30 for bandwidth efficiency)
  interpolationBuffer: number; // milliseconds
  interpolationDelay: number; // milliseconds (render delay for smooth interpolation)
  extrapolationLimit: number; // milliseconds
  rollbackLimit: number; // ticks
  predictionErrorThreshold: number; // units (distance threshold for rollback)
  enablePrediction: boolean;
  enableInterpolation: boolean;
}

/**
 * Debug and development configuration
 */
export interface DebugConfig {
  enabled: boolean;
  showNetworkStats: boolean;
  showPerformanceStats: boolean;
  showCollisionBounds: boolean;
  showPlankBounds: boolean;
  showCarrierDetection: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  recordReplays: boolean;
  maxReplayLength: number; // seconds
}

/**
 * Canvas configuration
 */
export interface CanvasConfig {
  width: number;
  height: number;
}

/**
 * Complete client configuration
 */
export interface ClientConfig {
  network: NetworkConfig;
  graphics: GraphicsConfig;
  audio: AudioConfig;
  input: InputConfig;
  prediction: PredictionConfig;
  debug: DebugConfig;
  canvas: CanvasConfig;
}

/**
 * Default client configuration values
 */
export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  network: {
    serverUrl: import.meta.env.VITE_WS_PROTOCOL && import.meta.env.VITE_WS_HOST && import.meta.env.VITE_WS_PORT
      ? `${import.meta.env.VITE_WS_PROTOCOL}://${import.meta.env.VITE_WS_HOST}:${import.meta.env.VITE_WS_PORT}`
      : 'ws://192.168.56.10:8082', // Fallback to default if env vars not set
    maxReconnectAttempts: 5,
    reconnectDelay: 2000,
    heartbeatInterval: 30000,
    timeoutDuration: 10000,
    protocol: 'websocket',
    fallbackToWebSocket: true
  },
  
  graphics: {
    targetFPS: 60,
    vsync: true,
    antialiasing: true,
    particleQuality: 'medium',
    shadowQuality: 'medium',
    textureQuality: 'high',
    renderDistance: 2000
  },
  
  audio: {
    masterVolume: 1.0,
    musicVolume: 0.7,
    sfxVolume: 0.8,
    voiceVolume: 1.0,
    enabled: true,
    spatialAudio: true
  },
  
  input: {
    mouseSensitivity: 1.0,
    invertMouseY: false,
    keyBindings: new Map([
      ['move_forward', 'KeyW'],
      ['move_backward', 'KeyS'],
      ['move_left', 'KeyA'],
      ['move_right', 'KeyD'],
      ['jump', 'Space'],
      ['interact', 'KeyE'],
      ['dismount', 'KeyR'],
      ['destroy_plank', 'KeyQ'],
      ['toggle_debug', 'KeyL'],
      ['toggle_plank_bounds', 'KeyP'],
      ['toggle_collision_tracker', 'KeyT'],
      ['toggle_water_mode', 'KeyN'],
      ['toggle_camera_mode', 'KeyC'],
    ]),
    gamepadEnabled: true,
    gamepadDeadzone: 0.1,
    enableDebugLogging: false // Disable verbose movement logging by default
  },
  
  prediction: {
    clientTickRate: 120, // 120 Hz for responsive input
    serverTickRate: 20, // 20 Hz server update rate
    interpolationBuffer: 150, // 150ms buffer for smoother interpolation (3 server frames)
    interpolationDelay: 100, // 100ms render delay (2 frames at 20Hz = 100ms)
    extrapolationLimit: 75, // 75ms max extrapolation for prediction
    rollbackLimit: 10, // 10 ticks rollback for lag compensation
    predictionErrorThreshold: 5.0, // 5 units position error threshold
    enablePrediction: true,
    enableInterpolation: true
  },
  
  debug: {
    enabled: false,
    showNetworkStats: false,
    showPerformanceStats: false,
    showCollisionBounds: false,
    showPlankBounds: false,
    showCarrierDetection: false,
    logLevel: 'info',
    recordReplays: false,
    maxReplayLength: 300 // 5 minutes
  },
  
  canvas: {
    width: 1920,
    height: 1080
  }
};

/**
 * Configuration manager for loading/saving client settings
 */
export class ClientConfigManager {
  private static readonly STORAGE_KEY = 'pirate_mmo_client_config';
  
  /**
   * Load configuration from local storage with defaults
   */
  static load(): ClientConfig {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) {
        return { ...DEFAULT_CLIENT_CONFIG };
      }
      
      const parsed = JSON.parse(stored);
      
      // Merge with defaults to handle new config options
      return this.mergeWithDefaults(parsed);
    } catch (error) {
      console.warn('Failed to load client config from localStorage:', error);
      return { ...DEFAULT_CLIENT_CONFIG };
    }
  }
  
  /**
   * Save configuration to local storage
   */
  static save(config: ClientConfig): void {
    try {
      // Convert Map to Object for JSON serialization
      const serializable = {
        ...config,
        input: {
          ...config.input,
          keyBindings: Object.fromEntries(config.input.keyBindings)
        }
      };
      
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(serializable));
    } catch (error) {
      console.warn('Failed to save client config to localStorage:', error);
    }
  }
  
  /**
   * Merge stored config with defaults to handle new options
   */
  private static mergeWithDefaults(stored: any): ClientConfig {
    const config = { ...DEFAULT_CLIENT_CONFIG };
    
    // Deep merge each section
    if (stored.network) Object.assign(config.network, stored.network);
    if (stored.graphics) Object.assign(config.graphics, stored.graphics);
    if (stored.audio) Object.assign(config.audio, stored.audio);
    if (stored.prediction) Object.assign(config.prediction, stored.prediction);
    if (stored.debug) Object.assign(config.debug, stored.debug);
    if (stored.canvas) Object.assign(config.canvas, stored.canvas);
    
    // Handle input section with Map conversion
    if (stored.input) {
      Object.assign(config.input, stored.input);
      
      // Convert keyBindings back to Map if it was stored as Object
      if (stored.input.keyBindings && !(stored.input.keyBindings instanceof Map)) {
        config.input.keyBindings = new Map(Object.entries(stored.input.keyBindings));
      }
    }
    
    return config;
  }
  
  /**
   * Reset configuration to defaults
   */
  static reset(): ClientConfig {
    localStorage.removeItem(this.STORAGE_KEY);
    return { ...DEFAULT_CLIENT_CONFIG };
  }
}