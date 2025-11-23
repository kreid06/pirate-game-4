/**
 * Module Interaction System
 * 
 * Handles player interactions with ship modules (cannons, helms, masts, etc.)
 * Separated from the main game engine for cleaner architecture.
 */

import { WorldState, Ship, Player } from '../../sim/Types.js';
import { ShipModule } from '../../sim/modules.js';
import { Vec2 } from '../../common/Vec2.js';

/**
 * Interaction result types
 */
export enum InteractionResult {
  SUCCESS = 'success',
  FAILED_OUT_OF_RANGE = 'failed_out_of_range',
  FAILED_OCCUPIED = 'failed_occupied',
  FAILED_NOT_ON_DECK = 'failed_not_on_deck',
  FAILED_INVALID_MODULE = 'failed_invalid_module'
}

/**
 * Module interaction details
 */
export interface ModuleInteraction {
  playerId: number;
  moduleId: number;
  result: InteractionResult;
  message?: string;
}

/**
 * Mount offset configuration for different module types
 */
const MOUNT_OFFSETS: Record<string, Vec2> = {
  helm: Vec2.from(0, -15),         // Stand behind steering wheel
  'steering-wheel': Vec2.from(0, -15),
  cannon: Vec2.from(0, -20),       // Stand behind cannon
  mast: Vec2.from(0, 15),          // Stand next to mast
  seat: Vec2.from(0, 0),           // Sit in center
  ladder: Vec2.from(0, -10),       // Stand at base of ladder
  custom: Vec2.zero()
};

/**
 * Interaction range for different module types
 */
const INTERACTION_RANGES: Record<string, number> = {
  helm: 30,
  'steering-wheel': 30,
  cannon: 25,
  mast: 35,
  seat: 20,
  ladder: 25,
  custom: 20
};

/**
 * Module interaction system
 */
export class ModuleInteractionSystem {
  private mountedPlayers = new Map<number, number>(); // playerId -> moduleId
  private lastInteractionResults: ModuleInteraction[] = [];
  
  // Callback for when player wants to interact with a module
  public onModuleInteract: ((moduleId: number) => void) | null = null;
  
  /**
   * Update the interaction system
   */
  update(worldState: WorldState, deltaTime: number): void {
    // Update mounted player positions to keep them locked to modules
    this.updateMountedPlayerPositions(worldState);
    
    // Clear old interaction results
    this.lastInteractionResults = [];
    
    // Process any module-specific updates
    this.updateModuleSystems(worldState, deltaTime);
  }
  
  /**
   * Attempt to interact with a module
   */
  interactWithModule(worldState: WorldState, playerId: number, moduleId: number): ModuleInteraction {
    const player = worldState.players.find(p => p.id === playerId);
    const { ship, module } = this.findModule(worldState, moduleId);
    
    // Validate interaction requirements
    const validation = this.validateInteraction(player, ship, module);
    if (validation.result !== InteractionResult.SUCCESS) {
      return validation;
    }
    
    // Check if player is already mounted
    const currentlyMountedModule = this.mountedPlayers.get(playerId);
    if (currentlyMountedModule !== undefined) {
      // Dismount from current module
      return this.dismountPlayer(worldState, playerId);
    }
    
    // Check if module is already occupied
    if (this.isModuleOccupied(moduleId)) {
      return {
        playerId,
        moduleId,
        result: InteractionResult.FAILED_OCCUPIED,
        message: `Module is already occupied`
      };
    }
    
    // Mount player to module
    return this.mountPlayer(worldState, playerId, moduleId, player!, ship!, module!);
  }
  
  /**
   * Dismount a player from their current module
   */
  dismountPlayer(worldState: WorldState, playerId: number): ModuleInteraction {
    const moduleId = this.mountedPlayers.get(playerId);
    if (moduleId === undefined) {
      return {
        playerId,
        moduleId: -1,
        result: InteractionResult.FAILED_INVALID_MODULE,
        message: 'Player is not mounted to any module'
      };
    }
    
    // Remove mount
    this.mountedPlayers.delete(playerId);
    
    // Restore player movement (they can move freely again)
    const player = worldState.players.find(p => p.id === playerId);
    if (player) {
      // Player position is maintained at the module location
      // but they regain the ability to move
    }
    
    const result: ModuleInteraction = {
      playerId,
      moduleId,
      result: InteractionResult.SUCCESS,
      message: 'Dismounted successfully'
    };
    
    this.lastInteractionResults.push(result);
    return result;
  }
  
  /**
   * Get all nearby interactable modules for a player
   */
  getNearbyInteractableModules(worldState: WorldState, playerId: number): ShipModule[] {
    const player = worldState.players.find(p => p.id === playerId);
    if (!player || !player.onDeck) {
      return [];
    }
    
    const ship = worldState.ships.find(s => s.id === player.carrierId);
    if (!ship) {
      return [];
    }
    
    const nearbyModules: ShipModule[] = [];
    
    for (const module of ship.modules) {
      // Skip deck modules (not interactable)
      if (module.kind === 'deck') continue;
      
      // Check if player is within interaction range
      const moduleWorldPos = this.getModuleWorldPosition(ship, module);
      const distance = player.position.sub(moduleWorldPos).length();
      const interactionRange = INTERACTION_RANGES[module.kind] || 20;
      
      if (distance <= interactionRange) {
        nearbyModules.push(module);
      }
    }
    
    return nearbyModules;
  }
  
  /**
   * Check if a player is mounted to any module
   */
  isPlayerMounted(playerId: number): boolean {
    return this.mountedPlayers.has(playerId);
  }
  
  /**
   * Get the module a player is mounted to
   */
  getPlayerMountedModule(worldState: WorldState, playerId: number): ShipModule | null {
    const moduleId = this.mountedPlayers.get(playerId);
    if (moduleId === undefined) return null;
    
    const { module } = this.findModule(worldState, moduleId);
    return module;
  }
  
  /**
   * Get last interaction results for debugging
   */
  getLastInteractionResults(): ModuleInteraction[] {
    return [...this.lastInteractionResults];
  }
  
  /**
   * Attempt to interact with the nearest module
   * Called when player presses E
   */
  tryInteractWithNearestModule(worldState: WorldState, playerId: number): void {
    const nearbyModules = this.getNearbyInteractableModules(worldState, playerId);
    
    if (nearbyModules.length === 0) {
      console.log('[ModuleInteraction] No nearby modules to interact with');
      return;
    }
    
    // Find closest module
    const player = worldState.players.find(p => p.id === playerId);
    if (!player) return;
    
    let closestModule: ShipModule | null = null;
    let closestDistance = Infinity;
    
    for (const module of nearbyModules) {
      const ship = worldState.ships.find(s => s.modules.includes(module));
      if (!ship) continue;
      
      const moduleWorldPos = this.getModuleWorldPosition(ship, module);
      const distance = player.position.sub(moduleWorldPos).length();
      
      if (distance < closestDistance) {
        closestDistance = distance;
        closestModule = module;
      }
    }
    
    if (closestModule) {
      console.log(`[ModuleInteraction] Interacting with ${closestModule.kind} module (id: ${closestModule.id}) at distance ${closestDistance.toFixed(1)}`);
      
      // Trigger callback to send to server
      if (this.onModuleInteract) {
        this.onModuleInteract(closestModule.id);
      }
    }
  }
  
  // Private methods
  
  private validateInteraction(
    player: Player | undefined, 
    ship: Ship | null, 
    module: ShipModule | null
  ): ModuleInteraction {
    if (!player) {
      return {
        playerId: 0,
        moduleId: -1,
        result: InteractionResult.FAILED_INVALID_MODULE,
        message: 'Player not found'
      };
    }
    
    if (!player.onDeck) {
      return {
        playerId: player.id,
        moduleId: -1,
        result: InteractionResult.FAILED_NOT_ON_DECK,
        message: 'Must be on deck to interact with modules'
      };
    }
    
    if (!ship || !module) {
      return {
        playerId: player.id,
        moduleId: -1,
        result: InteractionResult.FAILED_INVALID_MODULE,
        message: 'Module not found'
      };
    }
    
    // Check distance
    const moduleWorldPos = this.getModuleWorldPosition(ship, module);
    const distance = player.position.sub(moduleWorldPos).length();
    const interactionRange = INTERACTION_RANGES[module.kind] || 20;
    
    if (distance > interactionRange) {
      return {
        playerId: player.id,
        moduleId: module.id,
        result: InteractionResult.FAILED_OUT_OF_RANGE,
        message: `Too far from module (${distance.toFixed(1)} > ${interactionRange})`
      };
    }
    
    return {
      playerId: player.id,
      moduleId: module.id,
      result: InteractionResult.SUCCESS
    };
  }
  
  private mountPlayer(
    worldState: WorldState, 
    playerId: number, 
    moduleId: number, 
    player: Player, 
    ship: Ship, 
    module: ShipModule
  ): ModuleInteraction {
    // Record the mount
    this.mountedPlayers.set(playerId, moduleId);
    
    // Position player at module mount point
    const moduleWorldPos = this.getModuleWorldPosition(ship, module);
    const mountOffset = MOUNT_OFFSETS[module.kind] || Vec2.zero();
    const mountWorldPos = moduleWorldPos.add(mountOffset.rotate(ship.rotation));
    
    player.position = mountWorldPos;
    player.velocity = Vec2.zero(); // Stop player movement
    
    const result: ModuleInteraction = {
      playerId,
      moduleId,
      result: InteractionResult.SUCCESS,
      message: `Mounted to ${module.kind} module`
    };
    
    this.lastInteractionResults.push(result);
    return result;
  }
  
  private findModule(worldState: WorldState, moduleId: number): { ship: Ship | null; module: ShipModule | null } {
    for (const ship of worldState.ships) {
      const module = ship.modules.find(m => m.id === moduleId);
      if (module) {
        return { ship, module };
      }
    }
    return { ship: null, module: null };
  }
  
  private getModuleWorldPosition(ship: Ship, module: ShipModule): Vec2 {
    return module.localPos.rotate(ship.rotation).add(ship.position);
  }
  
  private isModuleOccupied(moduleId: number): boolean {
    for (const [, occupiedModuleId] of this.mountedPlayers) {
      if (occupiedModuleId === moduleId) {
        return true;
      }
    }
    return false;
  }
  
  private updateMountedPlayerPositions(worldState: WorldState): void {
    for (const [playerId, moduleId] of this.mountedPlayers) {
      const player = worldState.players.find(p => p.id === playerId);
      const { ship, module } = this.findModule(worldState, moduleId);
      
      if (player && ship && module) {
        // Keep player locked to module position
        const moduleWorldPos = this.getModuleWorldPosition(ship, module);
        const mountOffset = MOUNT_OFFSETS[module.kind] || Vec2.zero();
        const mountWorldPos = moduleWorldPos.add(mountOffset.rotate(ship.rotation));
        
        player.position = mountWorldPos;
        player.velocity = Vec2.zero(); // Mounted players don't have independent velocity
      }
    }
  }
  
  private updateModuleSystems(worldState: WorldState, deltaTime: number): void {
    // Update module-specific systems (cannons, sails, etc.)
    for (const ship of worldState.ships) {
      for (const module of ship.modules) {
        switch (module.kind) {
          case 'cannon':
            this.updateCannonModule(module, deltaTime);
            break;
          case 'mast':
            this.updateMastModule(module, deltaTime);
            break;
          // Add other module types as needed
        }
      }
    }
  }
  
  private updateCannonModule(module: ShipModule, deltaTime: number): void {
    if (!module.moduleData || module.moduleData.kind !== 'cannon') return;
    
    const cannonData = module.moduleData as any;
    
    // Update reload timer
    if (cannonData.timeSinceLastFire !== undefined && 
        cannonData.reloadTime !== undefined && 
        cannonData.timeSinceLastFire < cannonData.reloadTime) {
      cannonData.timeSinceLastFire += deltaTime;
    }
  }
  
  private updateMastModule(module: ShipModule, deltaTime: number): void {
    if (!module.moduleData || module.moduleData.kind !== 'mast') return;
    
    const mastData = module.moduleData as any;
    
    // Update sail state transitions
    // (For now, sail state is controlled directly by input)
    // Future: Add animated transitions between sail states
  }
}