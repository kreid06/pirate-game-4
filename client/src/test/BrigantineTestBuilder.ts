/**
 * Brigantine Test Builder
 * 
 * Standalone tool for building and testing different brigantine loadouts
 * without needing a server connection. Useful for:
 * - Testing module placements
 * - Balancing ship configurations
 * - Visual design iteration
 * - Module interaction testing
 */

import { Vec2 } from '../common/Vec2.js';
import { Ship } from '../sim/Types.js';
import { ShipModule, ModuleUtils, ModuleKind } from '../sim/modules.js';
import { createCurvedShipHull } from '../sim/ShipUtils.js';
import {
  BRIGANTINE_PHYSICS,
  BRIGANTINE_DECK_ID,
  BRIGANTINE_HELM_ID,
  BRIGANTINE_PLANK_START_ID
} from '../common/ShipDefinitions.js';

/**
 * Loadout configuration for a brigantine
 */
export interface BrigantineLoadout {
  name: string;
  description: string;
  modules: ModuleConfig[];
}

/**
 * Module configuration for loadout builder
 */
export interface ModuleConfig {
  kind: ModuleKind;
  position: { x: number, y: number };
  rotation?: number;
  customData?: any;
}

/**
 * Predefined brigantine loadouts
 */
export class BrigantineLoadouts {
  /**
   * Minimal loadout - just deck, hull, and helm
   */
  static MINIMAL: BrigantineLoadout = {
    name: 'Minimal',
    description: 'Basic brigantine with only essential components',
    modules: [
      // Helm for steering
      {
        kind: 'helm',
        position: { x: -90, y: 0 },
        rotation: 0
      }
    ]
  };

  /**
   * Balanced combat loadout
   */
  static COMBAT: BrigantineLoadout = {
    name: 'Combat',
    description: 'Balanced configuration with 4 cannons and crew positions',
    modules: [
      // Helm
      { kind: 'helm', position: { x: -90, y: 0 } },
      
      // Starboard cannons
      { kind: 'cannon', position: { x: 50, y: -60 }, rotation: -Math.PI / 2 },
      { kind: 'cannon', position: { x: -50, y: -60 }, rotation: -Math.PI / 2 },
      
      // Port cannons
      { kind: 'cannon', position: { x: 50, y: 60 }, rotation: Math.PI / 2 },
      { kind: 'cannon', position: { x: -50, y: 60 }, rotation: Math.PI / 2 },
      
      // Crew seats
      { kind: 'seat', position: { x: 100, y: 0 } },
      { kind: 'seat', position: { x: -150, y: 30 } },
      { kind: 'seat', position: { x: -150, y: -30 } }
    ]
  };

  /**
   * Heavy artillery loadout
   */
  static ARTILLERY: BrigantineLoadout = {
    name: 'Artillery',
    description: 'Maximum firepower with 8 cannons',
    modules: [
      // Helm
      { kind: 'helm', position: { x: -90, y: 0 } },
      
      // Starboard battery (4 cannons)
      { kind: 'cannon', position: { x: 120, y: -60 }, rotation: -Math.PI / 2 },
      { kind: 'cannon', position: { x: 40, y: -60 }, rotation: -Math.PI / 2 },
      { kind: 'cannon', position: { x: -40, y: -60 }, rotation: -Math.PI / 2 },
      { kind: 'cannon', position: { x: -120, y: -60 }, rotation: -Math.PI / 2 },
      
      // Port battery (4 cannons)
      { kind: 'cannon', position: { x: 120, y: 60 }, rotation: Math.PI / 2 },
      { kind: 'cannon', position: { x: 40, y: 60 }, rotation: Math.PI / 2 },
      { kind: 'cannon', position: { x: -40, y: 60 }, rotation: Math.PI / 2 },
      { kind: 'cannon', position: { x: -120, y: 60 }, rotation: Math.PI / 2 }
    ]
  };

  /**
   * Trading/Transport loadout
   */
  static TRANSPORT: BrigantineLoadout = {
    name: 'Transport',
    description: 'Crew-focused with multiple seats and ladders',
    modules: [
      // Helm
      { kind: 'helm', position: { x: -90, y: 0 } },
      
      // Crew seating area
      { kind: 'seat', position: { x: 80, y: 0 } },
      { kind: 'seat', position: { x: 80, y: -40 } },
      { kind: 'seat', position: { x: 80, y: 40 } },
      { kind: 'seat', position: { x: 0, y: -40 } },
      { kind: 'seat', position: { x: 0, y: 40 } },
      { kind: 'seat', position: { x: -80, y: -40 } },
      { kind: 'seat', position: { x: -80, y: 40 } },
      
      // Boarding ladders
      { kind: 'ladder', position: { x: 150, y: -60 }, rotation: -Math.PI / 2 },
      { kind: 'ladder', position: { x: 150, y: 60 }, rotation: Math.PI / 2 },
      
      // Light defensive armament
      { kind: 'cannon', position: { x: 180, y: 0 }, rotation: 0 }
    ]
  };

  /**
   * Speed/Racing loadout
   */
  static SPEED: BrigantineLoadout = {
    name: 'Speed',
    description: 'Lightweight configuration focused on speed',
    modules: [
      // Helm
      { kind: 'helm', position: { x: -90, y: 0 } },
      
      // Minimal crew
      { kind: 'seat', position: { x: 100, y: 0 } },
      
      // Masts for speed (if implemented)
      { kind: 'mast', position: { x: 50, y: 0 } },
      { kind: 'mast', position: { x: -50, y: 0 } }
    ]
  };

  /**
   * Get all available loadouts
   */
  static getAll(): BrigantineLoadout[] {
    return [
      this.MINIMAL,
      this.COMBAT,
      this.ARTILLERY,
      this.TRANSPORT,
      this.SPEED
    ];
  }
}

/**
 * Builder for creating test brigantine ships
 */
export class BrigantineTestBuilder {
  private modules: ShipModule[] = [];
  private nextModuleId = 1000;

  /**
   * Create a new builder instance
   */
  constructor() {
    this.reset();
  }

  /**
   * Reset builder to empty state (keeps deck and planks)
   */
  reset(): this {
    this.modules = [];
    this.nextModuleId = 1000;
    
    // Always add deck
    const hull = createCurvedShipHull();
    this.modules.push(ModuleUtils.createShipDeckFromPolygon(hull, BRIGANTINE_DECK_ID));
    
    // Always add planks
    this.modules.push(...ModuleUtils.createShipPlanksFromSegments(BRIGANTINE_PLANK_START_ID));
    
    return this;
  }

  /**
   * Load a predefined loadout
   */
  loadLoadout(loadout: BrigantineLoadout): this {
    this.reset();
    
    for (const config of loadout.modules) {
      this.addModule(config.kind, Vec2.from(config.position.x, config.position.y), config.rotation);
    }
    
    return this;
  }

  /**
   * Add a module at specified position
   */
  addModule(kind: ModuleKind, position: Vec2, rotation: number = 0): this {
    const module = ModuleUtils.createDefaultModule(this.nextModuleId++, kind, position);
    module.localRot = rotation;
    this.modules.push(module);
    return this;
  }

  /**
   * Add helm at standard position
   */
  addHelm(position?: Vec2): this {
    const helmPos = position || Vec2.from(-90, 0);
    const helm = ModuleUtils.createDefaultModule(BRIGANTINE_HELM_ID, 'helm', helmPos);
    this.modules.push(helm);
    return this;
  }

  /**
   * Add cannon at position with rotation
   */
  addCannon(position: Vec2, rotation: number): this {
    return this.addModule('cannon', position, rotation);
  }

  /**
   * Add seat at position
   */
  addSeat(position: Vec2): this {
    return this.addModule('seat', position, 0);
  }

  /**
   * Add ladder at position with direction
   */
  addLadder(position: Vec2, direction: number): this {
    return this.addModule('ladder', position, direction);
  }

  /**
   * Add mast at position
   */
  addMast(position: Vec2): this {
    return this.addModule('mast', position, 0);
  }

  /**
   * Remove module by ID
   */
  removeModule(id: number): this {
    this.modules = this.modules.filter(m => m.id !== id);
    return this;
  }

  /**
   * Get all modules
   */
  getModules(): ShipModule[] {
    return [...this.modules];
  }

  /**
   * Build the complete ship
   */
  build(position: Vec2 = Vec2.zero(), rotation: number = 0): Ship {
    const hull = createCurvedShipHull();
    
    return {
      id: Math.floor(Math.random() * 1000000),
      position,
      rotation,
      velocity: Vec2.zero(),
      angularVelocity: 0,
      hull,
      modules: this.getModules(),
      ...BRIGANTINE_PHYSICS
    };
  }

  /**
   * Export loadout configuration
   */
  exportLoadout(name: string, description: string): BrigantineLoadout {
    // Filter out deck and planks for cleaner export
    const customModules = this.modules.filter(m => 
      m.id !== BRIGANTINE_DECK_ID && 
      m.id < BRIGANTINE_PLANK_START_ID ||
      m.id >= BRIGANTINE_PLANK_START_ID + 48
    );
    
    return {
      name,
      description,
      modules: customModules.map(m => ({
        kind: m.moduleData?.kind || 'custom',
        position: { x: m.localPos.x, y: m.localPos.y },
        rotation: m.localRot
      }))
    };
  }

  /**
   * Get module count statistics
   */
  getStats(): {
    total: number;
    byType: Map<ModuleKind, number>;
  } {
    const byType = new Map<ModuleKind, number>();
    
    for (const module of this.modules) {
      const kind = module.moduleData?.kind || 'custom';
      byType.set(kind, (byType.get(kind) || 0) + 1);
    }
    
    return {
      total: this.modules.length,
      byType
    };
  }
}

/**
 * Helper function to create a test ship with specific loadout
 */
export function createTestBrigantine(loadout?: BrigantineLoadout, position?: Vec2, rotation?: number): Ship {
  const builder = new BrigantineTestBuilder();
  
  if (loadout) {
    builder.loadLoadout(loadout);
  } else {
    builder.loadLoadout(BrigantineLoadouts.COMBAT); // Default to combat
  }
  
  return builder.build(position, rotation);
}
