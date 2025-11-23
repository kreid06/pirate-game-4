/**
 * Example: Integrating Module Serialization with Network Manager
 * 
 * This file shows how to use the hybrid module serialization system
 * with the existing WebSocket network manager.
 */

import { ModuleSerialization, NetworkModuleData, ModuleDeltaUpdate } from '../sim/ModuleSerialization.js';
import { Ship } from '../sim/Types.js';
import { ShipModule } from '../sim/modules.js';

/**
 * Example message types for the module protocol
 */
interface ShipSyncMessage {
  type: 'SHIP_SYNC';
  shipId: number;
  modules: NetworkModuleData[];
}

interface ModuleUpdateMessage {
  type: 'MODULE_UPDATE';
  shipId: number;
  updates: ModuleDeltaUpdate[];
}

/**
 * Server-side helper for sending ship data
 */
export class ServerModuleSync {
  /**
   * Send complete ship state to a newly connected client
   */
  static sendInitialSync(socket: WebSocket, ship: Ship): void {
    const message: ShipSyncMessage = {
      type: 'SHIP_SYNC',
      shipId: ship.id,
      modules: ship.modules.map(m => ModuleSerialization.serializeModule(m))
    };
    
    socket.send(JSON.stringify(message));
    
    console.log(`Sent ${ship.modules.length} modules for ship ${ship.id}`);
    console.log(`Bandwidth: ${JSON.stringify(message).length} bytes`);
  }

  /**
   * Broadcast module changes to nearby players
   */
  static broadcastModuleUpdates(
    sockets: WebSocket[], 
    shipId: number, 
    updates: ModuleDeltaUpdate[]
  ): void {
    const message: ModuleUpdateMessage = {
      type: 'MODULE_UPDATE',
      shipId,
      updates
    };
    
    const payload = JSON.stringify(message);
    sockets.forEach(socket => socket.send(payload));
    
    console.log(`Broadcast ${updates.length} updates: ${payload.length} bytes`);
  }
}

/**
 * Client-side helper for receiving ship data
 */
export class ClientModuleSync {
  /**
   * Handle initial ship sync from server
   */
  static handleShipSync(message: ShipSyncMessage, onShipUpdate: (shipId: number, modules: ShipModule[]) => void): void {
    const modules = message.modules.map(m => 
      ModuleSerialization.deserializeModule(m)
    );
    
    onShipUpdate(message.shipId, modules);
    
    console.log(`Received ${modules.length} modules for ship ${message.shipId}`);
  }

  /**
   * Handle module delta updates from server
   */
  static handleModuleUpdates(
    message: ModuleUpdateMessage, 
    getShip: (shipId: number) => Ship | undefined
  ): void {
    const ship = getShip(message.shipId);
    if (!ship) {
      console.warn(`Ship ${message.shipId} not found for module update`);
      return;
    }

    for (const update of message.updates) {
      const module = ship.modules.find(m => m.id === update.id);
      if (module) {
        ModuleSerialization.applyDeltaUpdate(module, update);
      } else {
        console.warn(`Module ${update.id} not found on ship ${message.shipId}`);
      }
    }

    console.log(`Applied ${message.updates.length} module updates to ship ${message.shipId}`);
  }
}

/**
 * Example: Network Manager Integration
 */
export class NetworkModuleManager {
  private socket: WebSocket | null = null;
  private ships: Map<number, Ship> = new Map();

  constructor(private serverUrl: string) {}

  connect(): void {
    this.socket = new WebSocket(this.serverUrl);
    
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
  }

  private handleMessage(message: any): void {
    switch (message.type) {
      case 'SHIP_SYNC':
        this.handleShipSync(message as ShipSyncMessage);
        break;
      
      case 'MODULE_UPDATE':
        this.handleModuleUpdate(message as ModuleUpdateMessage);
        break;
    }
  }

  private handleShipSync(message: ShipSyncMessage): void {
    ClientModuleSync.handleShipSync(message, (shipId, modules) => {
      const ship = this.ships.get(shipId);
      if (ship) {
        ship.modules = modules;
      }
    });
  }

  private handleModuleUpdate(message: ModuleUpdateMessage): void {
    ClientModuleSync.handleModuleUpdates(
      message, 
      (shipId) => this.ships.get(shipId)
    );
  }

  /**
   * Example: Send cannon aim update to server
   */
  sendCannonAim(shipId: number, moduleId: number, aimDirection: number): void {
    if (!this.socket) return;

    const update = ModuleSerialization.createDeltaUpdate(
      moduleId,
      'moduleData.aimDirection',
      aimDirection
    );

    const message: ModuleUpdateMessage = {
      type: 'MODULE_UPDATE',
      shipId,
      updates: [update]
    };

    this.socket.send(JSON.stringify(message));
  }
}

/**
 * Example Usage:
 * 
 * const manager = new NetworkModuleManager('ws://localhost:8080');
 * manager.connect();
 * 
 * // When player aims cannon:
 * manager.sendCannonAim(1234, 1001, 1.57);
 */
