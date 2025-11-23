import { Vec2 } from '../common/Vec2.js';

/**
 * Types of modules that can be placed on ships
 */
export type ModuleKind = 
  | 'helm'           // Steering wheel - controls ship movement
  | 'seat'           // Simple seat - passenger/crew position
  | 'cannon'         // Cannon - offensive capability
  | 'mast'           // Mast - affects ship speed/handling
  | 'steering-wheel' // Alternative steering mechanism
  | 'ladder'         // Boarding ladder - helps players board from water
  | 'plank'          // Ship plank - structural hull component
  | 'deck'           // Ship deck - interior floor surface
  | 'custom';        // User-defined module types

/**
 * Numeric module type IDs for efficient network serialization
 * Maps to ModuleKind for bandwidth optimization
 */
export enum ModuleTypeId {
  HELM = 0,
  SEAT = 1,
  CANNON = 2,
  MAST = 3,
  STEERING_WHEEL = 4,
  LADDER = 5,
  PLANK = 6,
  DECK = 7,
  CUSTOM = 255  // Use high value for custom types
}

/**
 * Bidirectional mapping between ModuleKind and ModuleTypeId
 */
export const MODULE_TYPE_MAP = {
  toTypeId: (kind: ModuleKind): ModuleTypeId => {
    switch (kind) {
      case 'helm': return ModuleTypeId.HELM;
      case 'seat': return ModuleTypeId.SEAT;
      case 'cannon': return ModuleTypeId.CANNON;
      case 'mast': return ModuleTypeId.MAST;
      case 'steering-wheel': return ModuleTypeId.STEERING_WHEEL;
      case 'ladder': return ModuleTypeId.LADDER;
      case 'plank': return ModuleTypeId.PLANK;
      case 'deck': return ModuleTypeId.DECK;
      case 'custom': return ModuleTypeId.CUSTOM;
    }
  },
  toKind: (typeId: ModuleTypeId): ModuleKind => {
    switch (typeId) {
      case ModuleTypeId.HELM: return 'helm';
      case ModuleTypeId.SEAT: return 'seat';
      case ModuleTypeId.CANNON: return 'cannon';
      case ModuleTypeId.MAST: return 'mast';
      case ModuleTypeId.STEERING_WHEEL: return 'steering-wheel';
      case ModuleTypeId.LADDER: return 'ladder';
      case ModuleTypeId.PLANK: return 'plank';
      case ModuleTypeId.DECK: return 'deck';
      case ModuleTypeId.CUSTOM: return 'custom';
      default: return 'custom';
    }
  }
};

/**
 * Module state represented as bit flags for network efficiency
 */
export enum ModuleStateBits {
  OCCUPIED = 1 << 0,      // Someone is using this module
  ACTIVE = 1 << 1,        // Module is actively being operated
  DAMAGED = 1 << 2,       // Module is damaged/broken
  LOCKED = 1 << 3,        // Module is locked/unusable
  INTERACTABLE = 1 << 4,  // Module can be interacted with
  HIGHLIGHTED = 1 << 5,   // Module is highlighted (UI state)
}

/**
 * Module instance on a ship
 * This is pure data - no behavior, just state for deterministic simulation
 */
export interface ShipModule {
  id: number;                    // Unique module ID within the ship
  kind: ModuleKind;             // Type of module
  deckId: number;               // Which deck level this module is on (0 = main deck)
  localPos: Vec2;               // Position relative to ship center
  localRot: number;             // Rotation relative to ship orientation (radians)
  occupiedBy: number | null;    // Player/entity ID currently using this module
  stateBits: number;            // Bit flags for module state (ModuleStateBits)
  
  // Module-specific data (varies by kind)
  moduleData?: ModuleData;
}

/**
 * Type-specific data for different module kinds
 */
export type ModuleData = 
  | HelmModuleData
  | CannonModuleData
  | MastModuleData
  | SeatModuleData
  | LadderModuleData
  | PlankModuleData
  | DeckModuleData
  | CustomModuleData;

/**
 * Helm/Steering-wheel specific data
 */
export interface HelmModuleData {
  kind: 'helm' | 'steering-wheel';
  maxTurnRate: number;          // Maximum turning rate in rad/s
  responsiveness: number;       // How quickly ship responds to input (0-1)
  currentInput: Vec2;           // Current steering input (-1 to 1 for each axis)
  
  // Rendering properties
  wheelRotation: number;        // Current wheel rotation for visual feedback (radians)
}

/**
 * Cannon specific data
 */
export interface CannonModuleData {
  kind: 'cannon';
  aimDirection: number;         // Current aim direction in radians (ship-relative)
  maxAimSpeed: number;          // Maximum aim rotation speed in rad/s
  fireRange: number;            // Maximum firing range
  reloadTime: number;           // Time between shots in seconds
  timeSinceLastFire: number;    // Time since last shot (for reload tracking)
  ammunition: number;           // Remaining ammunition count
  maxAmmunition: number;        // Maximum ammunition capacity
}

/**
 * Mast specific data
 */
export interface MastModuleData {
  kind: 'mast';
  sailState: 'furled' | 'partial' | 'full';  // Current sail configuration
  windEfficiency: number;       // How well this mast catches wind (0-1)
  height: number;              // Mast height (affects wind catching)
  integrity: number;           // Structural integrity (0-1, affects performance)
  radius: number;              // Mast pole radius for rendering
  sailWidth: number;           // Width of the sail
  sailColor: string;           // Color of the sail fabric
  
  // Rendering properties
  openness: number;            // Sail openness (0-100) - how much the sail is deployed
  angle: number;               // Sail angle in degrees (for wind direction)
}

/**
 * Simple seat data
 */
export interface SeatModuleData {
  kind: 'seat';
  comfort: number;             // Comfort level (might affect player stats)
  facing: number;              // Direction the seat faces (radians, ship-relative)
}

/**
 * Boarding ladder data
 */
export interface LadderModuleData {
  kind: 'ladder';
  length: number;              // How far the ladder extends from ship (in world units)
  width: number;               // Width of the ladder (for visual and collision)
  extended: boolean;           // Whether ladder is currently extended
  extendDirection: number;     // Direction ladder extends (radians, ship-relative, 0 = forward)
  boardingZone: Vec2[];        // Additional polygon extending ship detection zone
}

/**
 * Ship plank data - represents hull segments
 */
export interface PlankModuleData {
  kind: 'plank';
  length: number;              // Length of the plank segment
  width: number;               // Width/thickness of the plank
  health: number;              // Structural integrity (0-100)
  material: 'wood' | 'iron' | 'steel'; // Plank material type
  segmentIndex: number;        // Which segment of the ship hull (0-11)
  sectionName?: string;        // Section name (e.g., "port_bow", "starboard_side")
  isCurved?: boolean;          // Whether this plank follows a curve
  curveData?: {                // Curve information for rendering
    start: PlankPoint;
    control: PlankPoint;
    end: PlankPoint;
    t1: number;                // Start position on curve (0-1)
    t2: number;                // End position on curve (0-1)
  };
}

/**
 * Ship deck data - represents interior floor surface
 */
export interface DeckModuleData {
  kind: 'deck';
  area: Vec2[];                // Polygon defining the deck area (ship-local coordinates)
  material: 'wood' | 'stone' | 'metal' | 'canvas'; // Deck surface material
  condition: number;           // Surface condition (0-100, affects traction/speed)
  texture: 'smooth' | 'rough' | 'planked' | 'tiled'; // Surface texture
  walkable: boolean;           // Whether players can walk on this deck section
  deckLevel: number;           // Deck height level (0 = main deck, 1 = upper deck, -1 = lower deck)
}

/**
 * Custom module data for user-defined modules
 */
export interface CustomModuleData {
  kind: 'custom';
  customType: string;          // User-defined type identifier
  properties: Record<string, any>; // Flexible property bag
}

/**
 * Module interaction info for UI and input handling
 */
export interface ModuleInteraction {
  moduleId: number;
  playerId: number;
  interactionType: 'hover' | 'use' | 'release';
  timestamp: number;
  inputData?: any;             // Type-specific interaction data
}

/**
 * Helper functions for module management
 */
export class ModuleUtils {
  /**
   * Get the numeric type ID for a module (for network serialization)
   */
  static getTypeId(module: ShipModule): ModuleTypeId {
    return MODULE_TYPE_MAP.toTypeId(module.kind);
  }

  /**
   * Check if a module can be interacted with
   */
  static canInteract(module: ShipModule): boolean {
    return (module.stateBits & ModuleStateBits.INTERACTABLE) !== 0 &&
           (module.stateBits & ModuleStateBits.LOCKED) === 0 &&
           (module.stateBits & ModuleStateBits.DAMAGED) === 0;
  }

  /**
   * Check if a module is currently occupied
   */
  static isOccupied(module: ShipModule): boolean {
    return module.occupiedBy !== null ||
           (module.stateBits & ModuleStateBits.OCCUPIED) !== 0;
  }

  /**
   * Get the world position of a module given ship transform
   */
  static getWorldPosition(module: ShipModule, shipPos: Vec2, shipRotation: number): Vec2 {
    const rotatedLocal = module.localPos.rotate(shipRotation);
    return shipPos.add(rotatedLocal);
  }

  /**
   * Get the world rotation of a module given ship rotation
   */
  static getWorldRotation(module: ShipModule, shipRotation: number): number {
    return shipRotation + module.localRot;
  }

  /**
   * Create a default module of the specified kind
   */
  static createDefaultModule(id: number, kind: ModuleKind, localPos: Vec2): ShipModule {
    const baseModule: ShipModule = {
      id,
      kind,
      deckId: 0,
      localPos,
      localRot: 0,
      occupiedBy: null,
      stateBits: ModuleStateBits.INTERACTABLE,
    };

    // Add type-specific data
    switch (kind) {
      case 'helm':
      case 'steering-wheel':
        baseModule.moduleData = {
          kind,
          maxTurnRate: Math.PI / 2, // 90 degrees per second
          responsiveness: 0.8,
          currentInput: Vec2.zero(),
          wheelRotation: 0,        // Start with wheel at center position
        } as HelmModuleData;
        break;

      case 'cannon':
        baseModule.moduleData = {
          kind: 'cannon',
          aimDirection: 0,
          maxAimSpeed: Math.PI / 4, // 45 degrees per second
          fireRange: 500,
          reloadTime: 3.0,
          timeSinceLastFire: 0,
          ammunition: 10,
          maxAmmunition: 10,
        } as CannonModuleData;
        break;

      case 'mast':
        baseModule.moduleData = {
          kind: 'mast',
          sailState: 'full',
          windEfficiency: 0.85,
          height: 100,
          integrity: 1.0,
          radius: 15,             // Mast pole radius
          sailWidth: 80,          // Sail width
          sailColor: '#F5F5DC',   // Beige/cream color for sails
          openness: 80,           // Start with sails mostly deployed
          angle: 0,               // Start with sails aligned with ship
        } as MastModuleData;
        break;

      case 'seat':
        baseModule.moduleData = {
          kind: 'seat',
          comfort: 0.7,
          facing: 0,
        } as SeatModuleData;
        break;

      case 'ladder':
        baseModule.moduleData = {
          kind: 'ladder',
          length: 30,              // Extends 30 units from ship
          width: 12,               // 12 units wide
          extended: true,          // Default to extended
          extendDirection: Math.PI, // Points backward (stern)
          boardingZone: [           // Rectangular zone extending from ship
            Vec2.from(-6, 0),       // Ladder width/2
            Vec2.from(6, 0),
            Vec2.from(6, 30),       // Extends 30 units back
            Vec2.from(-6, 30)
          ]
        } as LadderModuleData;
        break;

      case 'plank':
        baseModule.moduleData = {
          kind: 'plank',
          length: 16,              // Default plank length
          width: 4,                // Default plank thickness
          health: 100,             // Full health
          material: 'wood',        // Default wooden planks
          segmentIndex: 0,         // Default to first segment
        } as PlankModuleData;
        break;

      case 'deck':
        baseModule.moduleData = {
          kind: 'deck',
          area: [                  // Default rectangular deck area
            Vec2.from(-20, -20),
            Vec2.from(20, -20),
            Vec2.from(20, 20),
            Vec2.from(-20, 20)
          ],
          material: 'wood',        // Default wooden deck
          condition: 100,          // Perfect condition
          texture: 'planked',      // Traditional planked deck
          walkable: true,          // Players can walk on it
          deckLevel: 0,            // Main deck level
        } as DeckModuleData;
        break;

      case 'custom':
        baseModule.moduleData = {
          kind: 'custom',
          customType: 'unknown',
          properties: {},
        } as CustomModuleData;
        break;
    }

    return baseModule;
  }

  /**
   * Create 12 plank modules distributed around a ship's perimeter
   * Replaces the traditional ship border with modular planks
   */
  static createShipPlanks(shipWidth: number, shipHeight: number, startId: number = 100): ShipModule[] {
    const planks: ShipModule[] = [];
    
    let currentId = startId;
    let segmentIndex = 0;
    
    // Calculate positions around the ship perimeter
    // Start at top-left corner and go clockwise
    
    // Top edge (3 planks)
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3; // Center of each segment
      const x = -shipWidth/2 + t * shipWidth;
      const y = -shipHeight/2;
      
      const plank = this.createDefaultModule(currentId++, 'plank', Vec2.from(x, y));
      if (plank.moduleData && plank.moduleData.kind === 'plank') {
        plank.moduleData.segmentIndex = segmentIndex++;
        plank.moduleData.length = shipWidth / 3;
        plank.localRot = 0; // Horizontal
      }
      planks.push(plank);
    }
    
    // Right edge (3 planks)
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3;
      const x = shipWidth/2;
      const y = -shipHeight/2 + t * shipHeight;
      
      const plank = this.createDefaultModule(currentId++, 'plank', Vec2.from(x, y));
      if (plank.moduleData && plank.moduleData.kind === 'plank') {
        plank.moduleData.segmentIndex = segmentIndex++;
        plank.moduleData.length = shipHeight / 3;
        plank.localRot = Math.PI / 2; // Vertical
      }
      planks.push(plank);
    }
    
    // Bottom edge (3 planks)
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3;
      const x = shipWidth/2 - t * shipWidth;
      const y = shipHeight/2;
      
      const plank = this.createDefaultModule(currentId++, 'plank', Vec2.from(x, y));
      if (plank.moduleData && plank.moduleData.kind === 'plank') {
        plank.moduleData.segmentIndex = segmentIndex++;
        plank.moduleData.length = shipWidth / 3;
        plank.localRot = Math.PI; // Horizontal (reversed)
      }
      planks.push(plank);
    }
    
    // Left edge (3 planks)
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3;
      const x = -shipWidth/2;
      const y = shipHeight/2 - t * shipHeight;
      
      const plank = this.createDefaultModule(currentId++, 'plank', Vec2.from(x, y));
      if (plank.moduleData && plank.moduleData.kind === 'plank') {
        plank.moduleData.segmentIndex = segmentIndex++;
        plank.moduleData.length = shipHeight / 3;
        plank.localRot = -Math.PI / 2; // Vertical (reversed)
      }
      planks.push(plank);
    }
    
    return planks;
  }

  /**
   * Create the main deck module for a ship
   * Creates a single deck module that covers the ship's interior area
   */
  static createShipDeck(shipWidth: number, shipHeight: number, deckId: number = 200): ShipModule {
    // Create deck area slightly smaller than ship hull to account for plank thickness
    const deckMargin = 6; // Leave margin for hull planks
    const deckWidth = shipWidth - (deckMargin * 2);
    const deckHeight = shipHeight - (deckMargin * 2);
    
    const deckModule = this.createDefaultModule(deckId, 'deck', Vec2.from(0, 0));
    
    if (deckModule.moduleData && deckModule.moduleData.kind === 'deck') {
      deckModule.moduleData.area = [
        Vec2.from(-deckWidth/2, -deckHeight/2),
        Vec2.from(deckWidth/2, -deckHeight/2),
        Vec2.from(deckWidth/2, deckHeight/2),
        Vec2.from(-deckWidth/2, deckHeight/2)
      ];
      deckModule.moduleData.material = 'wood';
      deckModule.moduleData.condition = 100;
      deckModule.moduleData.texture = 'planked';
      deckModule.moduleData.walkable = true;
      deckModule.moduleData.deckLevel = 0;
    }
    
    return deckModule;
  }

  /**
   * Create ship deck from a polygon hull
   * Creates a deck module that covers the ship's interior area defined by the hull polygon
   */
  static createShipDeckFromPolygon(hullPolygon: Vec2[], deckId: number = 200): ShipModule {
    // Very small margin to maximize deck coverage and fill plank gaps
    const deckMargin = 1; // Minimal margin for nearly complete coverage
    
    const deckModule = this.createDefaultModule(deckId, 'deck', Vec2.from(0, 0));
    
    if (deckModule.moduleData && deckModule.moduleData.kind === 'deck') {
      // Create a deck polygon that follows the hull shape, shrunk inward
      const deckPolygon = this.createShipDeckPolygon(hullPolygon, deckMargin);
      
      deckModule.moduleData.area = deckPolygon;
      deckModule.moduleData.material = 'wood';
      deckModule.moduleData.condition = 100;
      deckModule.moduleData.texture = 'planked';
      deckModule.moduleData.walkable = true;
      deckModule.moduleData.deckLevel = 0;
      
      console.log(`Created curved deck with ${deckPolygon.length} points following hull shape`);
    }
    
    return deckModule;
  }

  /**
   * Create ship planks from precise hull segments
   * Uses exact hull geometry to ensure perfect coverage and alignment
   */
  static createShipPlanksFromSegments(startId: number = 100): ShipModule[] {
    const planks: ShipModule[] = [];
    let currentId = startId;
    
    // Create hull segments using the precise hull points
    const segments = createCompleteHullSegments(10); // 10 unit thickness
    
    console.log(`Creating ${segments.length} planks from hull segments`);
    
    for (const segment of segments) {
      // Calculate segment center position
      const centerX = (segment.start.x + segment.end.x) / 2;
      const centerY = (segment.start.y + segment.end.y) / 2;
      const position = Vec2.from(centerX, centerY);
      
      // Calculate segment length and angle
      const deltaX = segment.end.x - segment.start.x;
      const deltaY = segment.end.y - segment.start.y;
      const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      const angle = Math.atan2(deltaY, deltaX);
      
      const plank = this.createDefaultModule(currentId++, 'plank', position);
      if (plank.moduleData && plank.moduleData.kind === 'plank') {
        plank.moduleData.length = Math.max(length, 15); // Ensure minimum length
        plank.moduleData.width = segment.thickness;
        plank.moduleData.health = 100;
        plank.moduleData.material = 'wood';
        plank.moduleData.segmentIndex = segment.index;
        plank.moduleData.sectionName = segment.sectionName;
        plank.moduleData.isCurved = segment.isCurved || false;
        
        // Store curve data if this is a curved segment
        if (segment.isCurved && segment.curveStart && segment.curveControl && segment.curveEnd && segment.t1 !== undefined && segment.t2 !== undefined) {
          // Store the ORIGINAL full curve points, not the segment endpoints
          // This ensures the renderer uses the correct curve shape
          plank.moduleData.curveData = {
            start: segment.curveStart,      // Original curve start (e.g., bow)
            control: segment.curveControl,  // Original curve control (e.g., bowTip)
            end: segment.curveEnd,          // Original curve end (e.g., bowBottom)
            t1: segment.t1,                 // Start parameter (e.g., 0 or 0.5)
            t2: segment.t2                  // End parameter (e.g., 0.5 or 1.0)
          };
        }
        
        plank.localRot = angle;
      }
      
      planks.push(plank);
      
      const curveInfo = segment.isCurved ? ' [CURVED]' : ' [STRAIGHT]';
      console.log(`  ${segment.sectionName} plank ${segment.index}${curveInfo}: pos=(${centerX.toFixed(1)}, ${centerY.toFixed(1)}), length=${length.toFixed(1)}, angle=${(angle * 180 / Math.PI).toFixed(1)}°`);
    }
    
    console.log(`Total planks created: ${planks.length}`);
    return planks;
  }

  /**
   * Create a ship-specific deck polygon that closely follows the hull shape
   * Uses edge normals for more accurate inward shrinking
   */
  private static createShipDeckPolygon(hullPolygon: Vec2[], insetDistance: number): Vec2[] {
    if (hullPolygon.length < 3) return hullPolygon.slice();
    
    // For ship deck, we want to maintain the general shape but shrink it inward
    // Use a combination of centroid-based shrinking and edge normal calculation
    const deckPolygon: Vec2[] = [];
    
    // Calculate hull centroid
    let centroidX = 0, centroidY = 0;
    for (const point of hullPolygon) {
      centroidX += point.x;
      centroidY += point.y;
    }
    centroidX /= hullPolygon.length;
    centroidY /= hullPolygon.length;
    const centroid = Vec2.from(centroidX, centroidY);
    
    // Create deck points by moving each hull point toward the center
    for (let i = 0; i < hullPolygon.length; i++) {
      const current = hullPolygon[i];
      const prev = hullPolygon[(i - 1 + hullPolygon.length) % hullPolygon.length];
      const next = hullPolygon[(i + 1) % hullPolygon.length];
      
      // Calculate inward normal (average of adjacent edge normals)
      const edge1 = current.sub(prev).normalize();
      const edge2 = next.sub(current).normalize();
      const normal1 = Vec2.from(-edge1.y, edge1.x); // Perpendicular to edge1
      const normal2 = Vec2.from(-edge2.y, edge2.x); // Perpendicular to edge2
      
      // Average the normals and ensure it points inward
      let avgNormal = normal1.add(normal2).normalize();
      
      // Check if normal points toward centroid, if not flip it
      const toCentroid = centroid.sub(current).normalize();
      if (avgNormal.dot(toCentroid) < 0) {
        avgNormal = avgNormal.mul(-1);
      }
      
      // Move point inward by the inset distance
      const deckPoint = current.add(avgNormal.mul(insetDistance));
      deckPolygon.push(deckPoint);
    }
    
    return deckPolygon;
  }
}

/**
 * Point in 2D space for plank definitions
 */
export interface PlankPoint {
  x: number;
  y: number;
}

/**
 * Plank segment definition
 */
export interface PlankSegment {
  start: PlankPoint;
  end: PlankPoint;
  thickness: number;
  sectionName: string;
  index: number;
  isCurved?: boolean;          // Whether this segment is curved
  curveStart?: PlankPoint;     // Original curve start point (P0)
  curveControl?: PlankPoint;   // Control point for curved segments (P1)
  curveEnd?: PlankPoint;       // Original curve end point (P2)
  t1?: number;                 // Start t value on curve (0-1)
  t2?: number;                 // End t value on curve (0-1)
}

/**
 * Hull points that match the curved ship hull geometry
 * These must match exactly with the hull created in GameEngine.createCurvedShipHull()
 */
export const HULL_POINTS = {
  bow: { x: 190, y: 90 },
  bowTip: { x: 415, y: 0 },
  bowBottom: { x: 190, y: -90 },
  sternBottom: { x: -260, y: -90 },
  sternTip: { x: -345, y: 0 },
  stern: { x: -260, y: 90 }
};

/**
 * Get a point on a quadratic bezier curve
 */
export function getQuadraticPoint(
  p0: PlankPoint, 
  p1: PlankPoint, 
  p2: PlankPoint, 
  t: number
): PlankPoint {
  const x = Math.pow(1-t, 2) * p0.x + 2 * (1-t) * t * p1.x + Math.pow(t, 2) * p2.x;
  const y = Math.pow(1-t, 2) * p0.y + 2 * (1-t) * t * p1.y + Math.pow(t, 2) * p2.y;
  return { x, y };
}

/**
 * Create segments for a curved section of the hull
 */
export function createCurvedSegments(
  start: PlankPoint, 
  control: PlankPoint, 
  end: PlankPoint, 
  segmentCount: number, 
  sectionName: string,
  plankThickness: number
): PlankSegment[] {
  const segments: PlankSegment[] = [];
  
  for (let i = 0; i < segmentCount; i++) {
    const t1 = i / segmentCount;
    const t2 = (i + 1) / segmentCount;
    const segStart = getQuadraticPoint(start, control, end, t1);
    const segEnd = getQuadraticPoint(start, control, end, t2);
    
    segments.push({
      start: segStart,
      end: segEnd,
      thickness: plankThickness,
      sectionName: sectionName,
      index: i,
      isCurved: true,
      curveControl: control,
      t1: t1,
      t2: t2
    });
  }
  
  return segments;
}

/**
 * Create segments for a straight section of the hull
 */
export function createStraightSegments(
  start: PlankPoint, 
  end: PlankPoint, 
  segmentCount: number, 
  sectionName: string,
  plankThickness: number
): PlankSegment[] {
  const segments: PlankSegment[] = [];
  
  for (let i = 0; i < segmentCount; i++) {
    const t1 = i / segmentCount;
    const t2 = (i + 1) / segmentCount;
    
    // Linear interpolation for straight segments
    const segStart = {
      x: start.x + t1 * (end.x - start.x),
      y: start.y + t1 * (end.y - start.y)
    };
    const segEnd = {
      x: start.x + t2 * (end.x - start.x),
      y: start.y + t2 * (end.y - start.y)
    };
    
    segments.push({
      start: segStart,
      end: segEnd,
      thickness: plankThickness,
      sectionName: sectionName,
      index: i
    });
  }
  
  return segments;
}

/**
 * Create all plank segments for a complete ship hull
 * Total: 10 planks (2 bow + 3 starboard + 2 stern + 3 port)
 * Each bow/stern has one plank on port side and one on starboard side
 */
export function createCompleteHullSegments(plankThickness: number = 10): PlankSegment[] {
  const p = HULL_POINTS;
  const segments: PlankSegment[] = [];
  
  // Bow Port Side: Half curve from bow to bowTip (t: 0 to 0.5)
  segments.push(...createCurvedSegmentRange(p.bow, p.bowTip, p.bowBottom, 0, 0.5, "bow_port", plankThickness, 0));
  
  // Bow Starboard Side: Half curve from bowTip to bowBottom (t: 0.5 to 1)
  segments.push(...createCurvedSegmentRange(p.bow, p.bowTip, p.bowBottom, 0.5, 1.0, "bow_starboard", plankThickness, 1));
  
  // Starboard Side: 3 straight planks
  segments.push(...createStraightSegments(p.bowBottom, p.sternBottom, 3, "starboard_side", plankThickness));
  
  // Stern Starboard Side: Half curve from sternBottom to sternTip (t: 0 to 0.5)
  segments.push(...createCurvedSegmentRange(p.sternBottom, p.sternTip, p.stern, 0, 0.5, "stern_starboard", plankThickness, 4));
  
  // Stern Port Side: Half curve from sternTip to stern (t: 0.5 to 1)
  segments.push(...createCurvedSegmentRange(p.sternBottom, p.sternTip, p.stern, 0.5, 1.0, "stern_port", plankThickness, 5));
  
  // Port Side: 3 straight planks
  segments.push(...createStraightSegments(p.stern, p.bow, 3, "port_side", plankThickness));
  
  return segments;
}

/**
 * Create a single curved segment for a specific range of t values
 */
function createCurvedSegmentRange(
  start: PlankPoint,
  control: PlankPoint,
  end: PlankPoint,
  t1: number,
  t2: number,
  sectionName: string,
  plankThickness: number,
  index: number
): PlankSegment[] {
  const segStart = getQuadraticPoint(start, control, end, t1);
  const segEnd = getQuadraticPoint(start, control, end, t2);
  
  return [{
    start: segStart,
    end: segEnd,
    thickness: plankThickness,
    sectionName: sectionName,
    index: index,
    isCurved: true,
    curveStart: start,      // Store original curve start
    curveControl: control,   // Store original curve control point
    curveEnd: end,          // Store original curve end
    t1: t1,
    t2: t2
  }];
}
