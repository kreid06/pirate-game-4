/**
 * Module Serialization Utilities
 * 
 * Efficient network serialization for ship modules using the hybrid approach:
 * - Full state on initial sync (includes type, position, all properties)
 * - Delta updates for changes (just module ID + changed properties)
 */

import { ShipModule, ModuleTypeId, MODULE_TYPE_MAP, ModuleUtils } from './modules.js';
import { Vec2 } from '../common/Vec2.js';

/**
 * Compact module data for initial network sync
 * Uses numeric type IDs to save bandwidth
 */
export interface NetworkModuleData {
  id: number;                    // Unique module ID
  typeId: ModuleTypeId;          // Numeric type (1 byte vs ~6-12 bytes for string)
  deckId: number;
  pos: [number, number];         // Compact Vec2 as array
  rot: number;
  stateBits: number;
  
  // Type-specific data (only send what's needed)
  data?: any;
}

/**
 * Delta update for a single module property change
 * Only sends what changed to minimize bandwidth
 */
export interface ModuleDeltaUpdate {
  id: number;                    // Which module changed
  property: string;              // What property changed
  value: any;                    // New value
}

/**
 * Batch of module delta updates
 */
export interface ModuleDeltaBatch {
  shipId: number;
  updates: ModuleDeltaUpdate[];
}

/**
 * Serialization utilities
 */
export class ModuleSerialization {
  /**
   * Serialize a module for initial network transmission
   * Uses numeric type IDs and compact format
   */
  static serializeModule(module: ShipModule): NetworkModuleData {
    const typeId = ModuleUtils.getTypeId(module);
    
    return {
      id: module.id,
      typeId,
      deckId: module.deckId,
      pos: [module.localPos.x, module.localPos.y],
      rot: module.localRot,
      stateBits: module.stateBits,
      data: module.moduleData ? this.serializeModuleData(module.moduleData) : undefined
    };
  }

  /**
   * Deserialize network module data back to ShipModule
   */
  static deserializeModule(networkData: NetworkModuleData): ShipModule {
    const kind = MODULE_TYPE_MAP.toKind(networkData.typeId);
    
    return {
      id: networkData.id,
      kind,
      deckId: networkData.deckId,
      localPos: Vec2.from(networkData.pos[0], networkData.pos[1]),
      localRot: networkData.rot,
      occupiedBy: null,
      stateBits: networkData.stateBits,
      moduleData: networkData.data ? this.deserializeModuleData(kind, networkData.data) : undefined
    };
  }

  /**
   * Serialize module-specific data (just the essential properties)
   */
  private static serializeModuleData(data: any): any {
    // Only send the properties that matter for each type
    const kind = data.kind;
    
    switch (kind) {
      case 'cannon':
        return {
          aimDirection: data.aimDirection,
          ammunition: data.ammunition,
          timeSinceLastFire: data.timeSinceLastFire
        };
      
      case 'mast':
        return {
          sailState: data.sailState,
          openness: data.openness,
          angle: data.angle,
          integrity: data.integrity
        };
      
      case 'plank':
        return {
          health: data.health,
          segmentIndex: data.segmentIndex
        };
      
      case 'helm':
      case 'steering-wheel':
        return {
          wheelRotation: data.wheelRotation
        };
      
      // Other types don't need much data sent
      default:
        return {};
    }
  }

  /**
   * Deserialize module-specific data
   */
  private static deserializeModuleData(kind: string, data: any): any {
    // Reconstruct full moduleData with defaults + received data
    // This would call ModuleUtils.createDefaultModule and merge data
    return { kind, ...data };
  }

  /**
   * Create a delta update for a module property change
   */
  static createDeltaUpdate(moduleId: number, property: string, value: any): ModuleDeltaUpdate {
    return {
      id: moduleId,
      property,
      value
    };
  }

  /**
   * Apply delta updates to a module
   */
  static applyDeltaUpdate(module: ShipModule, update: ModuleDeltaUpdate): void {
    const parts = update.property.split('.');
    
    if (parts.length === 1) {
      // Direct property (e.g., "localRot")
      (module as any)[parts[0]] = update.value;
    } else if (parts.length === 2 && parts[0] === 'moduleData' && module.moduleData) {
      // Nested property (e.g., "moduleData.aimDirection")
      (module.moduleData as any)[parts[1]] = update.value;
    }
  }

  /**
   * Calculate bandwidth savings for a typical ship
   * 
   * Example: Ship with 20 modules
   * - String-based: ~20 * 50 bytes = 1000 bytes
   * - Hybrid approach: ~20 * 30 bytes = 600 bytes (40% savings)
   * - Delta updates: ~5 bytes per update vs ~30 bytes full module
   */
  static estimateBandwidthSavings(moduleCount: number): {
    stringBased: number;
    hybridApproach: number;
    savingsPercent: number;
  } {
    const avgStringSize = 50; // Bytes per module with string types
    const avgHybridSize = 30; // Bytes per module with numeric types
    
    const stringBased = moduleCount * avgStringSize;
    const hybridApproach = moduleCount * avgHybridSize;
    const savingsPercent = ((stringBased - hybridApproach) / stringBased) * 100;
    
    return {
      stringBased,
      hybridApproach,
      savingsPercent
    };
  }
}

/**
 * Example usage for network protocol:
 * 
 * // Server: Initial ship sync
 * const modules = ship.modules.map(m => ModuleSerialization.serializeModule(m));
 * socket.send({ type: 'SHIP_SYNC', shipId: 123, modules });
 * 
 * // Client: Receive and deserialize
 * const shipModules = data.modules.map(m => ModuleSerialization.deserializeModule(m));
 * 
 * // Server: Send delta update when cannon aims
 * const update = ModuleSerialization.createDeltaUpdate(1001, 'moduleData.aimDirection', 1.57);
 * socket.send({ type: 'MODULE_UPDATE', shipId: 123, updates: [update] });
 * 
 * // Client: Apply delta update
 * const module = ship.modules.find(m => m.id === update.id);
 * if (module) ModuleSerialization.applyDeltaUpdate(module, update);
 */
