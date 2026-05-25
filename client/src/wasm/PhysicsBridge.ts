/**
 * PhysicsBridge.ts — Ship, player, and projectile physics helpers.
 *
 * Wraps the WasmBridge physics step functions with idiomatic TypeScript
 * types so game code works with plain objects instead of raw Float32Arrays.
 *
 * Usage:
 *   import { physicsBridge } from './PhysicsBridge';
 *   await physicsBridge.initialize();
 *
 *   const ship = PhysicsBridge.makeShipState({ posX: 100, posY: 200 });
 *   physicsBridge.shipStep(ship, 1, 0, 1/60);  // advance one frame
 *   console.log(ship.posX, ship.posY);
 */

import { wasmBridge } from './WasmBridge';

/* ── Ship state ─────────────────────────────────────────────────────────── */

/** Mutable ship state — matches the 8-float WASM layout exactly. */
export interface ShipState {
  posX:         number;  // [0]
  posY:         number;  // [1]
  velX:         number;  // [2]
  velY:         number;  // [3]
  rotation:     number;  // [4] radians
  angularVel:   number;  // [5] rad/s
  sailOpenness: number;  // [6] 0‥1
  rudderAngle:  number;  // [7] -1‥1
}

/** Mutable player physics state — matches 5-float WASM layout. */
export interface PlayerPhysState {
  posX:     number;  // [0]
  posY:     number;  // [1]
  velX:     number;  // [2]
  velY:     number;  // [3]
  rotation: number;  // [4] radians
}

/** Mutable projectile state — matches 5-float WASM layout. */
export interface ProjectileState {
  posX:     number;  // [0]
  posY:     number;  // [1]
  velX:     number;  // [2]
  velY:     number;  // [3]
  lifetime: number;  // [4] seconds remaining
}

/* ── Scratch buffers ────────────────────────────────────────────────────── */

/** Reusable scratch Float32Arrays — avoids per-frame allocation. */
const _shipBuf = new Float32Array(8);
const _playerBuf = new Float32Array(5);
const _projectileBuf = new Float32Array(5);

/* ── PhysicsBridge class ───────────────────────────────────────────────── */

export class PhysicsBridge {

  /** Delegate initialisation to the shared WasmBridge singleton. */
  async initialize(scriptUrl?: string): Promise<void> {
    return wasmBridge.initialize(scriptUrl);
  }

  get isReady(): boolean {
    return wasmBridge.isReady;
  }

  /* ── Ship ────────────────────────────────────────────────────────────── */

  /**
   * Advance ship physics by dt seconds.
   * @param state      Mutable ship state object, updated in place.
   * @param sailDelta  -1 = close, 0 = hold, +1 = open
   * @param rudderDelta -1 = port, 0 = centre, +1 = starboard
   */
  shipStep(state: ShipState, sailDelta: -1 | 0 | 1, rudderDelta: -1 | 0 | 1, dt: number): void {
    _shipBuf[0] = state.posX;
    _shipBuf[1] = state.posY;
    _shipBuf[2] = state.velX;
    _shipBuf[3] = state.velY;
    _shipBuf[4] = state.rotation;
    _shipBuf[5] = state.angularVel;
    _shipBuf[6] = state.sailOpenness;
    _shipBuf[7] = state.rudderAngle;

    wasmBridge.shipStep(_shipBuf, sailDelta, rudderDelta, dt);

    state.posX        = _shipBuf[0];
    state.posY        = _shipBuf[1];
    state.velX        = _shipBuf[2];
    state.velY        = _shipBuf[3];
    state.rotation    = _shipBuf[4];
    state.angularVel  = _shipBuf[5];
    state.sailOpenness = _shipBuf[6];
    state.rudderAngle = _shipBuf[7];
  }

  /* ── Player ──────────────────────────────────────────────────────────── */

  /**
   * Advance player physics by dt seconds.
   * @param state    Mutable player state, updated in place.
   * @param moveX    Input axis X (-1‥1)
   * @param moveY    Input axis Y (-1‥1)
   * @param sprinting Whether sprint is active
   */
  playerStep(state: PlayerPhysState, moveX: number, moveY: number,
             sprinting: boolean, dt: number): void {
    _playerBuf[0] = state.posX;
    _playerBuf[1] = state.posY;
    _playerBuf[2] = state.velX;
    _playerBuf[3] = state.velY;
    _playerBuf[4] = state.rotation;

    wasmBridge.playerStep(_playerBuf, moveX, moveY, sprinting, dt);

    state.posX     = _playerBuf[0];
    state.posY     = _playerBuf[1];
    state.velX     = _playerBuf[2];
    state.velY     = _playerBuf[3];
    state.rotation = _playerBuf[4];
  }

  /* ── Projectile ──────────────────────────────────────────────────────── */

  /**
   * Advance projectile physics by dt seconds.
   * @param state  Mutable projectile state, updated in place.
   * @returns      `false` when the projectile lifetime has expired.
   */
  projectileStep(state: ProjectileState, dt: number): boolean {
    _projectileBuf[0] = state.posX;
    _projectileBuf[1] = state.posY;
    _projectileBuf[2] = state.velX;
    _projectileBuf[3] = state.velY;
    _projectileBuf[4] = state.lifetime;

    const alive = wasmBridge.projectileStep(_projectileBuf, dt);

    state.posX     = _projectileBuf[0];
    state.posY     = _projectileBuf[1];
    state.velX     = _projectileBuf[2];
    state.velY     = _projectileBuf[3];
    state.lifetime = _projectileBuf[4];

    return alive;
  }

  /* ── Factory helpers ─────────────────────────────────────────────────── */

  static makeShipState(partial: Partial<ShipState> = {}): ShipState {
    return {
      posX: 0, posY: 0, velX: 0, velY: 0,
      rotation: 0, angularVel: 0,
      sailOpenness: 0, rudderAngle: 0,
      ...partial,
    };
  }

  static makePlayerState(partial: Partial<PlayerPhysState> = {}): PlayerPhysState {
    return { posX: 0, posY: 0, velX: 0, velY: 0, rotation: 0, ...partial };
  }

  static makeProjectile(partial: Partial<ProjectileState> = {}): ProjectileState {
    return { posX: 0, posY: 0, velX: 0, velY: 0, lifetime: 5, ...partial };
  }
}

export const physicsBridge = new PhysicsBridge();
