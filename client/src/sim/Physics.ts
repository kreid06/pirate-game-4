import { Vec2 } from '../common/Vec2.js';
import { AngleUtils } from '../common/AngleUtils.js';
import { PolygonUtils } from '../common/PolygonUtils.js';
import { WorldState, InputFrame, Ship, Player, PhysicsConfig, SHIP_TYPE_GHOST } from './Types.js';
import { CollisionContext, resolveIslandCollisions, isInsideIsland, resolveDockCollisions, isDockPointOnSurface } from './IslandCollisions.js';
import { CollisionSystem, CollisionResult } from './CollisionSystem.js';
import { predictShipCollisions, predictIslandCollisions } from './PhysicsCollisionPredict.js';
import { ModuleKind } from './modules.js';
import { 
  CarrierDetectionState, 
  CarrierChangeEvent,
  createCarrierDetectionState 
} from './CarrierDetection.js';
/**
 * Action bit flags for player input
 */
export const PlayerActions = {
  JUMP: 1 << 0,          // Jump/Leave ship action
  INTERACT: 1 << 1,      // Interact with modules
  DISMOUNT: 1 << 2,      // Dismount from modules
  DESTROY_PLANK: 1 << 3, // Destroy nearby planks
  SPRINT: 1 << 4,        // Sprint (Shift+W, land/deck only)
  // Add more actions as needed
} as const;

/**
 * Pure deterministic simulation function
 * This is the core of Phase 0 - completely deterministic physics
 */
export function simulate(prevWorld: WorldState, inputFrame: InputFrame, dt: number, collisionCtx?: CollisionContext | null): WorldState {
  // Clone the world state for immutability
  const newWorld: WorldState = {
    tick: prevWorld.tick + 1,
    ships: prevWorld.ships.map(ship => ({ ...ship })),
    players: prevWorld.players.map(player => ({ ...player })),
    cannonballs: prevWorld.cannonballs.map(cb => ({ ...cb })),
    npcs: prevWorld.npcs ?? [],
    tombstones: prevWorld.tombstones ?? [],
    droppedItems: prevWorld.droppedItems ?? [],
    companies: prevWorld.companies ?? [],
    timestamp: prevWorld.timestamp + dt * 1000,
    carrierDetection: new Map(prevWorld.carrierDetection),
    islands: prevWorld.islands,
  };

  // Update ship physics (forces, but not positions yet)
  for (const ship of newWorld.ships) {
    updateShipPhysics(ship, dt);
  }

  // Handle ship-to-ship collisions with multiple substeps to prevent tunneling
  const collisionSubsteps = 3; // Multiple collision checks per frame
  const subDt = dt / collisionSubsteps;
  
  for (let step = 0; step < collisionSubsteps; step++) {
    // Apply partial position integration
    for (const ship of newWorld.ships) {
      ship.position = ship.position.add(ship.velocity.mul(subDt));
      ship.rotation += ship.angularVelocity * subDt;
    }
    
    // Check and resolve collisions using server-mirrored CCD + SAT + impulse
    predictShipCollisions(newWorld.ships, subDt);
  }

  // Ship-island collision prediction (polygon islands only)
  predictIslandCollisions(newWorld.ships, newWorld.islands ?? []);

  // Phase 2: Enhanced player update with carrier detection
  const allEvents: CarrierChangeEvent[] = [];
  
  for (const player of newWorld.players) {
    const events = updatePlayerWithDetection(player, newWorld.ships, newWorld.carrierDetection, inputFrame, dt, newWorld.timestamp, collisionCtx);
    for (const ev of events) allEvents.push(ev);
  }

  // Store events for potential camera system usage (could be used by GameEngine)
  (newWorld as any).carrierEvents = allEvents;

  return newWorld;
}

/**
 * Enhanced ship physics with realistic speed-dependent turning
 */
/**
 * Update ship physics (forces and velocities, but not position integration)
 */
function updateShipPhysics(ship: Ship, dt: number): void {
  // Single pass over modules: collect helm steering input and mast sail power simultaneously.
  // Avoids a second O(N) scan (previously a separate .find() for helm + a for-loop for masts).
  let steeringInput = 0;
  let totalSailPower = 0;
  let sailCount = 0;

  for (const module of ship.modules) {
    if (module.kind === 'helm' && module.moduleData) {
      const helmData = module.moduleData as any;
      steeringInput = helmData.currentInput?.x || 0;
    } else if (module.kind === 'mast' && module.moduleData) {
      const mastData = module.moduleData as any;
      const openness = mastData.openness || 0; // 0-100 sail openness
      const efficiency = mastData.windEfficiency || 0.8; // How well this mast works

      // Convert openness (0-100) to power contribution with exponential scaling
      const opennessFactor = openness / 100; // 0-1
      const sailPower = Math.pow(opennessFactor, 0.7) * efficiency; // Exponential curve for more power
      totalSailPower += sailPower;
      sailCount++;
    }
  }

  // Calculate current speed for turning effectiveness
  const currentSpeed = ship.velocity.length();
  const minTurningSpeed = 5; // Below this speed, turning is very slow
  const maxTurningSpeed = 40; // Above this speed, turning is at full effectiveness
  
  // Speed-based turning effectiveness (reduced by 50%)
  let turningEffectiveness;
  if (currentSpeed < minTurningSpeed) {
    // Very slow turning when stationary or moving very slowly (50% reduction)
    turningEffectiveness = 0.05 + (currentSpeed / minTurningSpeed) * 0.1; // 0.05 to 0.15 (was 0.1 to 0.3)
  } else {
    // Normal turning when moving (50% reduction)
    const speedFactor = Math.min(currentSpeed / maxTurningSpeed, 1.0);
    turningEffectiveness = 0.15 + speedFactor * 0.35; // 0.15 to 0.5 (was 0.3 to 1.0)
  }
  
  // Apply steering force with speed-dependent effectiveness
  const baseAngularAcceleration = 1.5; // Base turning force
  const effectiveSteeringForce = steeringInput * turningEffectiveness;
  
  // Apply steering force (drag is handled below in the hydrodynamic section)
  ship.angularVelocity += effectiveSteeringForce * baseAngularAcceleration * dt;
  
  // Update rotation
  ship.rotation = AngleUtils.wrap(ship.rotation + ship.angularVelocity * dt);
  
  // Calculate thrust force based on sail power - Reduced wind power
  const maxThrust = 8000; // Reduced from 15000
  const minThrust = 300;  // Reduced from 500
  
  let thrustForce = minThrust;
  if (sailCount > 0) {
    const averageSailPower = totalSailPower / sailCount;
    
    // Multi-mast bonus: More masts = higher efficiency (reduced)
    const mastBonus = 1 + (sailCount - 1) * 0.1; // 10% bonus per additional mast (was 20%)
    
    // Wind power amplification based on total sail area (reduced)
    const sailAreaMultiplier = 1 + (totalSailPower * 0.25); // Up to 25% bonus (was 50%)
    
    const finalSailPower = averageSailPower * mastBonus * sailAreaMultiplier;
    thrustForce = minThrust + (maxThrust - minThrust) * Math.min(finalSailPower, 1.25); // Cap at 125% (was 150%)
  }
  
  // Apply thrust in forward direction
  const forwardDir = Vec2.from(Math.cos(ship.rotation), Math.sin(ship.rotation));
  const thrustVector = forwardDir.mul(thrustForce);
  
  // Ship mass affects acceleration (lighter ships accelerate faster)
  // Use brigantine physics properties from server (mass, waterDrag, maxSpeed, etc.)
  const acceleration = thrustVector.div(ship.mass);
  
  // Apply acceleration to velocity
  ship.velocity = ship.velocity.add(acceleration.mul(dt));
  
  // ── Hydrodynamic drag (linear + quadratic) ──────────────────────────
  // Linear term: low-speed hull friction.
  // Quadratic term: wave-making resistance — dominates at speed and
  // naturally caps velocity without a hard clamp.
  //
  //   drag_factor = 1 − (c_lin + c_quad · |v|)
  //
  // At equilibrium, thrust_accel·dt = |v|·(c_lin + c_quad·|v|), giving
  // a natural top speed the ship can never exceed.
  {
    const C_LIN_V  = 0.012;   // base linear drag (~1.2 % per frame)
    const C_QUAD_V = 0.0006;  // quadratic coefficient (stronger at high speed)
    const C_LIN_W  = 0.03;    // angular linear drag
    const C_QUAD_W = 0.10;    // angular quadratic drag
    const MIN_DRAG = 0.60;    // safety floor

    const spd = ship.velocity.length();
    const dragV = Math.max(1 - (C_LIN_V + C_QUAD_V * spd), MIN_DRAG);
    ship.velocity = ship.velocity.mul(dragV);

    const absW = Math.abs(ship.angularVelocity);
    const dragW = Math.max(1 - (C_LIN_W + C_QUAD_W * absW), MIN_DRAG);
    ship.angularVelocity *= dragW;
  }
  
  // Note: Position integration is now handled separately in the collision loop
}

/**
 * Update ship physics including position (legacy compatibility)
 */
function updateShipWithPosition(ship: Ship, dt: number): void {
  updateShipPhysics(ship, dt);
  
  // Update position
  ship.position = ship.position.add(ship.velocity.mul(dt));
  ship.rotation += ship.angularVelocity * dt;
}

/**
 * Enhanced player update with Phase 2 carrier detection
 */
function updatePlayerWithDetection(
  player: Player,
  ships: Ship[],
  carrierDetectionMap: Map<number, CarrierDetectionState>,
  inputFrame: InputFrame,
  dt: number,
  currentTime: number,
  collisionCtx?: CollisionContext | null
): CarrierChangeEvent[] {
  // If player is mounted to a module, lock their position and prevent movement
  if (player.isMounted) {
    const carrierShip = ships.find(ship => ship.id === player.carrierId);
    if (carrierShip) {
      // Determine ship-local mount position in priority order:
      //   1. localPosition — set from server snapshot (local_x/local_y fields). This is
      //      the canonical position used by server's update_mounted_players_on_ship(). Use
      //      it whenever available so prediction exactly matches server after a rollback.
      //   2. module.localPos + mountOffset — one-time mount message data (may be absent
      //      if the mount happened before this session or the message was lost).
      //   3. Reverse-transform the current world position — guarantees we always have a
      //      valid local position even on the first prediction tick after rollback.
      let lx: number;
      let ly: number;

      if (player.localPosition) {
        lx = player.localPosition.x;
        ly = player.localPosition.y;
      } else if (player.mountedModuleId && player.mountOffset) {
        const module = carrierShip.modules.find(m => m.id === player.mountedModuleId);
        if (module) {
          lx = module.localPos.x + player.mountOffset.x;
          ly = module.localPos.y + player.mountOffset.y;
        } else {
          // Module not found — fall through to reverse-transform below
          lx = NaN; ly = NaN;
        }
      } else {
        lx = NaN; ly = NaN;
      }

      if (isNaN(lx)) {
        // Reverse-transform world → local so we never lose the position
        const cosN = Math.cos(-carrierShip.rotation);
        const sinN = Math.sin(-carrierShip.rotation);
        const dx = player.position.x - carrierShip.position.x;
        const dy = player.position.y - carrierShip.position.y;
        lx = dx * cosN - dy * sinN;
        ly = dx * sinN + dy * cosN;
      }

      // Persist to localPosition so subsequent prediction ticks keep using the same
      // anchor without re-deriving it. Mirrors server's stored local_x/local_y.
      player.localPosition = Vec2.from(lx, ly);

      // Convert local → world using the CURRENT ship transform (same as server's
      // ship_local_to_world inside update_mounted_players_on_ship each tick).
      const cosF = Math.cos(carrierShip.rotation);
      const sinF = Math.sin(carrierShip.rotation);
      player.position = Vec2.from(
        carrierShip.position.x + lx * cosF - ly * sinF,
        carrierShip.position.y + lx * sinF + ly * cosF,
      );

      // Velocity = ship translational + rotational component at the player's arm
      player.velocity = carrierShip.velocity.add(
        Vec2.from(lx, ly).perp().mul(carrierShip.angularVelocity),
      );

      return []; // No carrier events when mounted
    }
  }
  
  // ── Carrier state is SERVER-AUTHORITATIVE ─────────────────────────────────
  // The server only ever boards a player via:
  //   1. Ladder interact (E at an extended ladder)   — module_interactions.c
  //   2. Stepping onto a scaffolded ship from a dock — mirrored by
  //      tryBoardScaffoldedShip() below
  //   3. Respawn / teleport / admin actions
  // There is NO "swim into the hull → walk on deck" transition server-side.
  // The old geometric auto-boarding (updateCarrierDetection + plank-aware hull
  // containment) let the client board any ship just by swimming into it, while
  // the server kept the player SWIMMING — a hard desync that also corrupted the
  // reported positions the server adopts. We now branch purely on the
  // carrierId/onDeck flags merged from server snapshots; boarding transitions
  // (ladder, grapple, etc.) arrive within one RTT of the interaction.
  const events: CarrierChangeEvent[] = [];
  const newCarrierId = player.carrierId ?? 0;
  player.onDeck = newCarrierId > 0;

  // Keep the detection-state map coherent for the scaffold-boarding mirror.
  let detectionState = carrierDetectionMap.get(player.id);
  if (!detectionState) {
    detectionState = createCarrierDetectionState();
    carrierDetectionMap.set(player.id, detectionState);
  }
  detectionState.currentCarrierId = newCarrierId > 0 ? newCarrierId : null;
  
  // Apply physics based on carrier status
  const carrierShip = ships.find(ship => ship.id === newCarrierId);
  
  if (carrierShip && player.onDeck) {
    updatePlayerOnDeck(player, carrierShip, inputFrame, dt);
  } else if ((player.onIslandId ?? 0) > 0) {
    // On land the server uses DIRECT-position walking (no acceleration/drag), not swim
    // physics. Mirror that here or the prediction constantly diverges from the server.
    updatePlayerOnLand(player, inputFrame, dt, collisionCtx);
  } else if ((player.onDockId ?? 0) > 0) {
    // Dock/shipyard walking: server uses ws_player_walk_target (semi-authority) + direct
    // position — same model as island walking. Without this the client used swimming
    // physics (acceleration + drag), creating a major physics mismatch and constant rollbacks.

    // Replicate server's instant scaffolded-ship boarding (websocket_server.c:13235-13250).
    // The server boards the player immediately when they step into the ship hull polygon, but
    // CarrierDetection has a 2-tick confirmation window — if we don't short-circuit here the
    // client lags behind the server by 2+ ticks, triggering a carrierId mismatch rollback
    // (jump/teleport) every time the player steps from dock onto the scaffolded ship deck.
    if (collisionCtx && tryBoardScaffoldedShip(player, ships, carrierDetectionMap, collisionCtx, inputFrame, dt)) {
      return events; // Player boarded the ship this tick — no dock physics needed
    }

    // Remember the dock ID before the move (updatePlayerOnLand never clears it).
    const currentDockId = player.onDockId ?? 0;

    updatePlayerOnLand(player, inputFrame, dt, collisionCtx);

    // After moving, mirror server's dock_point_on_surface() exit check
    // (websocket_server.c:13218). If the new position is off the dock surface the server
    // clears on_dock_id and transitions to island/swim in the same tick. Without this
    // mirror the client keeps predicting dock physics for the full RTT, producing
    // temporary rubberbanding when walking back onto the island.
    if (collisionCtx && currentDockId > 0) {
      const dock = collisionCtx.structures.find(s => s.id === currentDockId && s.type === 'shipyard');
      if (dock && !isDockPointOnSurface(player.position, dock)) {
        player.onDockId = 0;
        // Server immediately transitions to SWIMMING, then island detection fires next
        // tick. If the dock sits on an island (which is always the case), pre-set
        // onIslandId so the client switches to island walking in the same tick and
        // avoids one extra tick of swim physics.
        if ((dock.islandId ?? 0) > 0) {
          player.onIslandId = dock.islandId;
        }
      }
    }
  } else {
    updatePlayerOffDeck(player, ships, inputFrame, dt);
  }

  // ── Grapple constraint — mirrors server update_grapple_hooks logic ─────────
  // ONLY applies for SHIP targets (targetType=2): the server pulls the *player*
  // toward the ship hull while reeling.  For every other target type — dropped
  // item (1), player (3), npc (4), wreck (5) — the server moves the TARGET toward
  // the player and the player stays put, so applying a player constraint here would
  // fight the server and cause rubber-banding.
  const GRAPPLE_TARGET_SHIP_TYPE = 2;
  if (player.grappleState === 2 &&
      player.grappleTargetType === GRAPPLE_TARGET_SHIP_TYPE &&
      player.grappleX !== undefined && player.grappleY !== undefined) {
    const GRAPPLE_REEL_PULL = 90.0;  // px/s — must match server GRAPPLE_REEL_PULL
    const GRAPPLE_ROPE_MIN  = 30.0;  // px   — must match server GRAPPLE_ROPE_MIN

    const gx = player.grappleX;
    const gy = player.grappleY;

    // Vector from hook to player (same convention as server: tdx/tdy)
    const tdx  = player.position.x - gx;
    const tdy  = player.position.y - gy;
    const tdist = Math.sqrt(tdx * tdx + tdy * tdy);

    if (tdist > 0.5) {
      const nx = tdx / tdist;
      const ny = tdy / tdist;

      if (inputFrame.grappleReelIn) {
        // Mode A: LMB held — actively pull player toward hook (mirrors server)
        const step    = GRAPPLE_REEL_PULL * dt;
        const newDist = Math.max(tdist - step, GRAPPLE_ROPE_MIN);
        const moved   = tdist - newDist;
        if (moved > 0) {
          player.position = new Vec2(
            player.position.x - nx * moved,
            player.position.y - ny * moved,
          );
          // Kill outward velocity so drag doesn't push us back out
          const outward = player.velocity.dot(new Vec2(nx, ny));
          if (outward > 0) {
            player.velocity = player.velocity.sub(new Vec2(nx * outward, ny * outward));
          }
        }
      } else if (!inputFrame.grappleReelOut) {
        // Mode B: idle — hard rope constraint (player cannot drift past rope_length)
        const rope = player.grappleRopeLength;
        if (rope !== undefined && tdist > rope) {
          const over = tdist - rope;
          player.position = new Vec2(
            player.position.x - nx * over,
            player.position.y - ny * over,
          );
          // Cancel outward velocity so the player doesn't immediately re-violate
          const outward = player.velocity.dot(new Vec2(nx, ny));
          if (outward > 0) {
            player.velocity = player.velocity.sub(new Vec2(nx * outward, ny * outward));
          }
        }
      }
      // Mode C: RMB held (grappleReelOut) — rope is extending, no constraint applied

      // If player is on a ship deck, recompute localPosition from the constrained world pos
      if (carrierShip) {
        const cosR = Math.cos(carrierShip.rotation);
        const sinR = Math.sin(carrierShip.rotation);
        const dxW  = player.position.x - carrierShip.position.x;
        const dyW  = player.position.y - carrierShip.position.y;
        player.localPosition = new Vec2(
          dxW * cosR + dyW * sinR,
          -dxW * sinR + dyW * cosR,
        );
      }
    }
  }

  return events;
}

/**
 * Instant dock-to-ship boarding detection — mirrors websocket_server.c:13235-13250.
 *
 * While the player is on the dock and a ship is being scaffolded inside, the server
 * immediately boards the player as soon as they step inside the ship hull polygon.
 * The generic CarrierDetection has a 2-tick confirmation delay which would cause a
 * carrierId mismatch (→ rollback jump) on every dock→ship step.
 *
 * Returns true and updates player state if boarding occurred; returns false otherwise.
 */
function tryBoardScaffoldedShip(
  player: Player,
  ships: Ship[],
  carrierDetectionMap: Map<number, CarrierDetectionState>,
  collisionCtx: CollisionContext,
  inputFrame: InputFrame,
  dt: number,
): boolean {
  const dock = collisionCtx.structures.find(
    s => s.id === player.onDockId && s.type === 'shipyard',
  );
  if (!dock?.construction || dock.construction.phase !== 'building') return false;

  const scaffoldedShipId = dock.construction.scaffoldedShipId;
  if (!scaffoldedShipId) return false;

  const scaffoldedShip = ships.find(s => s.id === scaffoldedShipId);
  if (!scaffoldedShip || scaffoldedShip.hull.length < 3) return false;

  // Transform player world position to ship-local coordinates (same as server's ship_world_to_local).
  const cosN = Math.cos(-scaffoldedShip.rotation);
  const sinN = Math.sin(-scaffoldedShip.rotation);
  const dx = player.position.x - scaffoldedShip.position.x;
  const dy = player.position.y - scaffoldedShip.position.y;
  const slx = dx * cosN - dy * sinN;
  const sly = dx * sinN + dy * cosN;

  // Point-in-polygon test on the ship hull (mirrors server is_outside_deck).
  const hull = scaffoldedShip.hull;
  let inside = false;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const ax = hull[j].x, ay = hull[j].y;
    const bx = hull[i].x, by = hull[i].y;
    if ((ay > sly) !== (by > sly)) {
      const xi = ax + (sly - ay) * (bx - ax) / (by - ay);
      if (slx < xi) inside = !inside;
    }
  }
  if (!inside) return false;

  // Player is inside the scaffolded ship hull — board instantly (zero-delay).
  player.onDockId = 0;
  player.carrierId = scaffoldedShip.id;
  player.onDeck   = true;

  // Sync CarrierDetection state so it doesn't fight the boarding next tick.
  const detState = carrierDetectionMap.get(player.id);
  if (detState) {
    detState.currentCarrierId = scaffoldedShip.id;
  }

  updatePlayerOnDeck(player, scaffoldedShip, inputFrame, dt);
  return true;
}

/**
 * Land walking — mirrors the server's island movement (websocket_server.c):
 * position moves directly by movement·walkSpeed·dt each tick (no velocity integration,
 * no drag). When a CollisionContext is available, wall/tree/boulder collisions are
 * resolved client-side so the predicted position is already collision-correct and the
 * server simply adopts it, eliminating reconciliation spikes on wall contact.
 */
function updatePlayerOnLand(
  player: Player,
  inputFrame: InputFrame,
  dt: number,
  collisionCtx?: CollisionContext | null
): void {
  // Apply server-computed carry-weight speed modifier.
  // speedMult = max(0.3, 1 - carry_ratio * 0.5); canSprint = carry_ratio < 0.85.
  // Absent when server hasn't sent them yet → default to unencumbered (1.0 / true).
  const speedMult  = player.speedMult  ?? 1.0;
  const canSprint  = player.canSprint  ?? true;
  const isSprinting = canSprint && (inputFrame.actions & PlayerActions.SPRINT) !== 0;
  const walkSpeed = (isSprinting
    ? PhysicsConfig.PLAYER_WALK_SPEED * PhysicsConfig.PLAYER_SPRINT_MULT
    : PhysicsConfig.PLAYER_WALK_SPEED) * speedMult;

  const hasInput = inputFrame.movement.lengthSq() > 0.0001;

  // Direct position integration (input is already in world space from the camera transform).
  if (hasInput) {
    player.position = player.position.add(inputFrame.movement.mul(walkSpeed * dt));
  }

  // Client-side collision resolution — mirrors server's island collision block.
  // Only fires when the player moved this tick. When stationary the server's position
  // is already collision-valid; re-resolving it would create a systematic offset whenever
  // the player is standing within PLAYER_R + OBJ_R of an obstacle (tree, wall, boulder).
  if (hasInput && collisionCtx && (player.onIslandId ?? 0) > 0) {
    const island = collisionCtx.islands.find(i => i.id === player.onIslandId);
    if (island) {
      // Island boundary — mirrors the server's island→swim transition (websocket_server.c):
      // when the new position leaves the island polygon, the server clears on_island_id,
      // switches to SWIMMING, keeps the position, and carries the walk velocity into the
      // swim. The client MUST do the same. With client semi-authority the server adopts
      // our reported position — if we clamped at the shoreline (old behaviour) the server
      // would only ever see inside-the-island positions and NEITHER side would ever
      // transition: the player would be permanently stuck on land.
      if (!isInsideIsland(player.position, island)) {
        player.onIslandId = 0;
        // Server: sim velocity = movement × walk_speed — swim drag takes over next tick.
        player.velocity = inputFrame.movement.mul(walkSpeed);
        return;
      }

      // Still on the island — resolve wall/tree/boulder collisions.
      player.position = resolveIslandCollisions(player.position, island, collisionCtx);
    }
  }

  // Dock U-wall OBB pushout — mirrors server dock_apply_player_collision() (dock_physics.c).
  // Same guard: only resolves when the player has input so a stationary player at a
  // server-validated position doesn't get pushed by 10-12 px every tick.
  if (hasInput && collisionCtx && (player.onDockId ?? 0) > 0) {
    const dock = collisionCtx.structures.find(s => s.id === player.onDockId && s.type === 'shipyard');
    if (dock) {
      player.position = resolveDockCollisions(player.position, dock);
    }
  }

  // Server uses direct-position model and stores velocity = 0 for land walking.
  // Mirror this exactly so statesDiffer never sees a velocity divergence.
  // Camera follows position directly; stop-detection in InputManager uses its own
  // playerVelocity field (fed from server snapshots), not this physics velocity.
  player.velocity = Vec2.zero();
}

/**
 * Initialize carrier detection for all players in a world state
 */
export function initializeCarrierDetection(world: WorldState): void {
  if (!world.carrierDetection) {
    world.carrierDetection = new Map();
  }
  
  for (const player of world.players) {
    if (!world.carrierDetection.has(player.id)) {
      world.carrierDetection.set(player.id, createCarrierDetectionState());
    }
  }
}

/**
 * Enhanced carrier physics implementation with better rotation handling
 */
// ── Ship-deck collision radii — must match server module_collision_radius() ──
const SHIP_MODULE_RADII: Partial<Record<ModuleKind, number>> = {
  'helm':           10,
  'steering-wheel': 10,
  'mast':           14,
  'cannon':         13,
  'swivel':         10,
  'chest':          12,
};

// Matches server: PLAYER_RADIUS + PLANK_THICKNESS = 8 + 10
const DECK_INSET = 18;
const DECK_PLAYER_R = 8;

/**
 * Resolve on-deck collisions in ship-local coordinates.
 * Mirrors server resolve_player_module_collisions + ramp + resolve_player_hull_containment.
 * All coordinates are in ship-local client pixels (identical to server client-px local space).
 */
function resolveShipDeckCollisions(
  lx: number, ly: number,
  playerDeckLevel: number,
  mountedModuleId: number | undefined,
  ship: Ship
): { lx: number; ly: number } {
  // ── 1. Module circle push-out ─────────────────────────────────────────────
  for (const mod of ship.modules) {
    if (mod.id === mountedModuleId) continue;

    // Ramps handled separately below.
    if (mod.kind === 'ramp') continue;

    // Planks are boundary walls — skip here; hull containment handles the boundary.
    if (mod.kind === 'plank') continue;

    const modRadius = SHIP_MODULE_RADII[mod.kind] ?? 0;
    if (modRadius <= 0) continue;

    // Per-deck filtering — mirrors server logic exactly:
    //   lower deck (0): masts (deck-independent=255) + cannons + deckId=0 modules
    //   upper deck (1): skip deckId=0 modules; everything else collides
    if (playerDeckLevel === 0) {
      if (mod.kind !== 'mast' && mod.kind !== 'cannon' && mod.deckId !== 0) continue;
    } else if (playerDeckLevel === 1) {
      if (mod.deckId === 0) continue;
    }

    const mx = mod.localPos.x;
    const my = mod.localPos.y;
    const dx = lx - mx;
    const dy = ly - my;
    const distSq = dx * dx + dy * dy;
    const minDist = DECK_PLAYER_R + modRadius;

    if (distSq < minDist * minDist) {
      const dist = Math.sqrt(distSq);
      if (dist < 0.001) {
        lx += minDist;
      } else {
        const overlap = minDist - dist;
        lx += (dx / dist) * overlap;
        ly += (dy / dist) * overlap;
      }
    }
  }

  // ── 2. Ramp U-shape (lower deck only) ────────────────────────────────────
  if (playerDeckLevel === 0) {
    for (const mod of ship.modules) {
      if (mod.kind !== 'ramp') continue;
      if (mod.id === mountedModuleId) continue;
      // Skip fully destroyed ramps — mirrors server check: `if (mod->health == 0) continue`.
      // Use the parsed health value when available; fall back to the stateBits ACTIVE flag.
      if (mod.health !== undefined ? mod.health === 0 : !(mod.stateBits & 1 /* MODULE_STATE_ACTIVE */)) continue;

      const rampX = mod.localPos.x;
      const rampY = mod.localPos.y;
      const rampRot = mod.localRot;
      const dx = lx - rampX;
      const dy = ly - rampY;
      const cr = Math.cos(-rampRot);
      const sr = Math.sin(-rampRot);
      let rlx = dx * cr - dy * sr;
      let rly = dx * sr + dy * cr;

      const HX = 22;
      const HY = 22;
      // Three walls: −X, +Y, −Y (open on +X side).
      const walls: [number, number, number, number][] = [
        [-HX, -HY, -HX,  HY],
        [-HX,  HY,  HX,  HY],
        [-HX, -HY,  HX, -HY],
      ];

      for (const [ax, ay, bx, by] of walls) {
        let cx: number, cy: number;
        if (ax === bx) {
          cx = ax;
          const lo = Math.min(ay, by), hi = Math.max(ay, by);
          cy = Math.max(lo, Math.min(hi, rly));
        } else {
          cy = ay;
          const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
          cx = Math.max(lo, Math.min(hi, rlx));
        }
        const ddx = rlx - cx;
        const ddy = rly - cy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < DECK_PLAYER_R * DECK_PLAYER_R) {
          const d = Math.sqrt(d2);
          if (d > 0.001) {
            const push = DECK_PLAYER_R - d;
            rlx += (ddx / d) * push;
            rly += (ddy / d) * push;
          } else {
            if (ax === bx) rlx += ax > 0 ? DECK_PLAYER_R : -DECK_PLAYER_R;
            else           rly += ay > 0 ? DECK_PLAYER_R : -DECK_PLAYER_R;
          }
        }
      }

      // Rotate corrected ramp-local position back to ship-local.
      const bc = Math.cos(rampRot);
      const bs = Math.sin(rampRot);
      lx = rampX + rlx * bc - rly * bs;
      ly = rampY + rlx * bs + rly * bc;
    }
  }

  // ── 3. Hull polygon containment (lower deck only) ───────────────────────
  // Mirrors server: resolve_player_hull_containment is gated on deck_level == 0.
  // On the upper deck the server applies NO hull containment — the player can
  // freely walk off the edge; the server detects the exit via is_outside_deck and
  // then calls dismount_player_from_ship.  Applying containment here for the upper
  // deck causes the client to report an "inside hull" position every tick, so the
  // server (which adopts the client's semi-authoritative position) never sees the
  // player go outside and therefore never fires the dismount — the player becomes
  // permanently stuck at the hull edge.  Removing containment for deck_level != 0
  // lets the client correctly predict the player stepping off, which then triggers
  // the server dismount and matching forced-correction on the client side.
  if (playerDeckLevel === 0 && ship.hull.length >= 3) {
    const hull = ship.hull;
    const nv = hull.length;
    const slotHealth = buildPlankSlotHealth(ship);

    // Determine polygon winding (CCW = positive signed area → CCW sign = +1).
    let signedArea2 = 0;
    for (let i = 0, j = nv - 1; i < nv; j = i++) {
      signedArea2 += hull[j].x * hull[i].y - hull[i].x * hull[j].y;
    }
    const ccwSign = signedArea2 >= 0 ? 1 : -1;

    for (let iter = 0; iter < 2; iter++) {
      const px = lx, py = ly;

      // Point-in-polygon ray cast (+x ray).
      let inside = false;
      for (let i = 0, j = nv - 1; i < nv; j = i++) {
        const ax = hull[j].x, ay = hull[j].y;
        const bx = hull[i].x, by = hull[i].y;
        if ((ay > py) !== (by > py)) {
          const xi = ax + (py - ay) * (bx - ax) / (by - ay);
          if (px < xi) inside = !inside;
        }
      }

      // Find closest edge (track dest vertex index for plank-slot lookup).
      let bestDist2 = 1e30;
      let bestCx = px, bestCy = py;
      let bestNx = 0, bestNy = 0;
      let bestEdgeI = 0; // destination vertex index (= i in j→i edge loop)
      for (let i = 0, j = nv - 1; i < nv; j = i++) {
        const ax = hull[j].x, ay = hull[j].y;
        const bx = hull[i].x, by = hull[i].y;
        const ex = bx - ax, ey = by - ay;
        const elen2 = ex * ex + ey * ey;
        if (elen2 < 0.0001) continue;
        let t = ((px - ax) * ex + (py - ay) * ey) / elen2;
        t = Math.max(0, Math.min(1, t));
        const cx2 = ax + t * ex;
        const cy2 = ay + t * ey;
        const ddx = px - cx2, ddy = py - cy2;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestCx = cx2; bestCy = cy2;
          bestEdgeI = i;
          const elen = Math.sqrt(elen2);
          bestNx = -ey * ccwSign / elen;
          bestNy =  ex * ccwSign / elen;
        }
      }

      // Skip containment if the nearest plank is breached — player falls through.
      // Mirrors server: hull_section_plank_alive check (websocket_server.c ~1082).
      if (!hullEdgeAlive(bestEdgeI, nv, slotHealth)) continue;

      const dist = Math.sqrt(bestDist2);
      if (!inside) {
        lx = bestCx + bestNx * DECK_INSET;
        ly = bestCy + bestNy * DECK_INSET;
      } else if (dist < DECK_INSET) {
        const push = DECK_INSET - dist;
        lx = px + bestNx * push;
        ly = py + bestNy * push;
      }
    }
  }

  return { lx, ly };
}

/**
 * On-deck movement — LOCAL-ANCHOR model, exact mirror of the server's on-ship branch
 * (websocket_server.c "ON-SHIP MOVEMENT (LOCAL COORDINATES)"):
 *
 *   1. The player's state on deck is their ship-local position (local_x/local_y).
 *   2. World-space input is rotated into ship-local space and integrated directly
 *      (no velocity, no acceleration, no drift damping).
 *   3. Collisions are resolved in local space.
 *   4. World position is DERIVED from the ship transform — the player is rigidly
 *      carried by the ship. We never integrate the player's world position while
 *      the ship moves; only the ship is predicted, the player rides it.
 *   5. Velocity stays zero — the server never sets velocity in this branch, so the
 *      snapshot always reports (0,0). The old world-space "ice drift" model invented
 *      a phantom decaying velocity that diverged from the server every tick.
 */
function updatePlayerOnDeck(player: Player, ship: Ship, inputFrame: InputFrame, dt: number): void {
  const cosR = Math.cos(ship.rotation);
  const sinR = Math.sin(ship.rotation);

  // Ship-local anchor: prefer localPosition (seeded from the server's local_x/local_y
  // snapshot fields), else derive it from the current world position once.
  let lx: number;
  let ly: number;
  if (player.localPosition) {
    lx = player.localPosition.x;
    ly = player.localPosition.y;
  } else {
    const dx = player.position.x - ship.position.x;
    const dy = player.position.y - ship.position.y;
    lx =  dx * cosR + dy * sinR;
    ly = -dx * sinR + dy * cosR;
  }

  // Mirror the server's carry-weight penalty (speed_mult) and sprint block (can_sprint).
  const speedMult  = player.speedMult  ?? 1.0;
  const canSprint  = player.canSprint  ?? true;
  const isSprinting = canSprint && (inputFrame.actions & PlayerActions.SPRINT) !== 0;
  const walkSpeed = (isSprinting
    ? PhysicsConfig.PLAYER_WALK_SPEED * PhysicsConfig.PLAYER_SPRINT_MULT
    : PhysicsConfig.PLAYER_WALK_SPEED) * speedMult;

  const hasInput = inputFrame.movement.lengthSq() > 0.0001;
  if (hasInput) {
    // Rotate world-space input into ship-local space (server: local_move_x = mx·cos + my·sin).
    const localMoveX =  inputFrame.movement.x * cosR + inputFrame.movement.y * sinR;
    const localMoveY = -inputFrame.movement.x * sinR + inputFrame.movement.y * cosR;

    lx += localMoveX * walkSpeed * dt;
    ly += localMoveY * walkSpeed * dt;

    // Server-matching collision resolution in ship-local space.
    // Mirrors: resolve_player_module_collisions + ramp U-shape + resolve_player_hull_containment.
    const resolved = resolveShipDeckCollisions(lx, ly, player.deckId, player.mountedModuleId, ship);
    lx = resolved.lx;
    ly = resolved.ly;
  }

  player.localPosition = Vec2.from(lx, ly);

  // World position derived from the ship transform (server: ship_local_to_world).
  player.position = Vec2.from(
    ship.position.x + lx * cosR - ly * sinR,
    ship.position.y + lx * sinR + ly * cosR,
  );

  // Server never writes velocity in the on-deck branch → snapshots report (0,0).
  player.velocity = Vec2.zero();
}


/**
 * Enhanced free movement when player is not on deck
 */
function updatePlayerOffDeck(player: Player, ships: Ship[], inputFrame: InputFrame, dt: number): void {
  // Match server physics (simulation.c + websocket_server.c)
  const SWIM_ACCELERATION = 160.0; // px/s² - matches server CLIENT_TO_SERVER(160.0)
  const SWIM_MAX_SPEED = 30.0;     // px/s  - matches server CLIENT_TO_SERVER(30.0)
  // Server applies 0.95 drag each tick at 20 Hz; express as dt-independent multiplier:
  // per_second = 0.95^20, so per dt = per_second^dt = 0.95^(20*dt)
  const SWIM_DRAG_PER_SECOND = Math.pow(0.95, 20); // ≈ 0.358
  
  // Server also applies linear deceleration (120 px/s²) when stopped to bring
  // velocity to zero faster than drag alone. Mirrors websocket_server.c ~13493-13518.
  const SWIM_DECELERATION = 120.0; // px/s² - matches server CLIENT_TO_SERVER(120.0)

  const isMoving = inputFrame.movement.lengthSq() > 0.01;
  
  if (isMoving) {
    // Apply acceleration then hard-clamp (server order: accel → clamp → drag)
    const acceleration = inputFrame.movement.mul(SWIM_ACCELERATION * dt);
    player.velocity = player.velocity.add(acceleration);
    const currentSpeed = player.velocity.length();
    if (currentSpeed > SWIM_MAX_SPEED) {
      player.velocity = player.velocity.normalize().mul(SWIM_MAX_SPEED);
    }
  } else {
    // Stopped: apply linear deceleration opposite to velocity direction.
    const currentSpeed = player.velocity.length();
    if (currentSpeed > 0.1) {
      const decelAmount = SWIM_DECELERATION * dt;
      if (decelAmount >= currentSpeed) {
        player.velocity = new Vec2(0, 0);
      } else {
        player.velocity = player.velocity.mul((currentSpeed - decelAmount) / currentSpeed);
      }
    }
  }
  
  // Passive drag applied every tick on the server regardless of input
  player.velocity = player.velocity.mul(Math.pow(SWIM_DRAG_PER_SECOND, dt));
  
  // DON'T add water current - server doesn't have this, causes velocity mismatch
  // const currentStrength = 10;
  // const currentDir = Vec2.from(0.3, 0.1).normalize();
  // const current = currentDir.mul(currentStrength * dt);
  // player.velocity = player.velocity.add(current);
  
  // Calculate intended new position
  const intendedPosition = player.position.add(player.velocity.mul(dt));
  
  // Hull collision for non-boarded players — crossing rejection + contact pushout.
  // The previous swept-only test (sweptCircleVsHealthyHull) failed under SUSTAINED
  // contact: once the player was already touching the hull, the sweep detected no
  // new crossing and let the position sink a little deeper every tick until it
  // tunnelled through. This static resolver runs every tick, uses the PREVIOUS
  // position to decide which side of the hull the player belongs on, and mirrors
  // the server's resolve_swimmer_ship_hull_collision exactly.
  let finalPosition = intendedPosition;
  let finalVelocity = player.velocity;

  for (const ship of ships) {
    const distanceToShip = player.position.distanceTo(ship.position);
    const maxRelevantDistance = 400; // Generous bounding check
    if (distanceToShip > maxRelevantDistance) continue;

    const resolved = resolveSwimmerHullCollision(
      player.position,   // previous (collision-valid) position
      finalPosition,
      player.radius,
      ship
    );
    if (resolved) {
      finalPosition = resolved;
      // Cancel the velocity component pointing into the hull so drag doesn't
      // re-penetrate next tick (same projection as the server applies).
      const pushDir = resolved.sub(intendedPosition);
      const pushLen = pushDir.length();
      if (pushLen > 0.0001) {
        const n = pushDir.mul(1 / pushLen);
        const into = finalVelocity.dot(n);
        if (into < 0) {
          finalVelocity = finalVelocity.sub(n.mul(into));
        }
      }
    }
  }
  
  player.position = finalPosition;
  player.velocity = finalVelocity;
  
  // Final safety clamp (drag should keep us below max, but guard against FP drift)
  const finalSpeed = player.velocity.length();
  if (finalSpeed > SWIM_MAX_SPEED) {
    player.velocity = player.velocity.normalize().mul(SWIM_MAX_SPEED);
  }
}

/**
 * Calculate the bounding radius of a ship based on its deck or hull
 */
function calculateShipBoundingRadius(ship: Ship): number {
  const deck = getShipDeck(ship);
  let points: Vec2[];
  
  if (deck && deck.moduleData) {
    const deckData = deck.moduleData as any;
    points = (deckData.area && Array.isArray(deckData.area)) ? deckData.area : ship.hull;
  } else {
    points = ship.hull;
  }
  
  // Find the maximum distance from center to any point
  let maxDistance = 0;
  for (const point of points) {
    const distance = point.length();
    maxDistance = Math.max(maxDistance, distance);
  }
  
  return maxDistance + 10; // Add small buffer
}

/**
 * Handle collisions between ships
 */
function handleShipCollisions(ships: Ship[]): void {
  // Check all pairs of ships for collisions
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const ship1 = ships[i];
      const ship2 = ships[j];
      
      // Check if ships are close enough to potentially collide (improved broad phase)
      const distance = ship1.position.sub(ship2.position).length();
      const ship1Radius = calculateShipBoundingRadius(ship1);
      const ship2Radius = calculateShipBoundingRadius(ship2);
      const combinedRadius = ship1Radius + ship2Radius;
      
      if (distance < combinedRadius) {
        // Perform more precise deck-to-deck collision detection
        const collision = checkShipHullCollision(ship1, ship2);
        
        if (collision.isColliding) {
          // Resolve the collision with realistic ship physics
          resolveShipCollision(ship1, ship2, collision);
          
          // Calculate plank damage from the collision
          calculateCollisionPlankDamage(ship1, ship2, collision);
        }
      }
    }
  }
}

/**
 * Check for collision between two ship hulls using deck shapes
 */
function checkShipHullCollision(ship1: Ship, ship2: Ship): {
  isColliding: boolean;
  normal: Vec2;
  penetration: number;
  contactPoint: Vec2;
} {
  // Get deck modules from both ships for consistent collision detection
  const ship1Deck = getShipDeck(ship1);
  const ship2Deck = getShipDeck(ship2);
  
  if (!ship1Deck || !ship2Deck) {
    // Fallback to hull-based collision if no deck found
    return checkHullPolygonCollision(ship1, ship2);
  }
  
  // Get deck areas (polygons) in world coordinates
  const deck1Data = ship1Deck.moduleData as any;
  const deck2Data = ship2Deck.moduleData as any;
  
  // Ensure we have proper deck areas
  const deck1Area = (deck1Data && deck1Data.area && Array.isArray(deck1Data.area)) 
    ? deck1Data.area : ship1.hull;
  const deck2Area = (deck2Data && deck2Data.area && Array.isArray(deck2Data.area)) 
    ? deck2Data.area : ship2.hull;
  
  const deck1World = deck1Area.map((p: Vec2) => 
    p.rotate(ship1.rotation).add(ship1.position)
  );
  const deck2World = deck2Area.map((p: Vec2) => 
    p.rotate(ship2.rotation).add(ship2.position)
  );
  
  // Use SAT for polygon-to-polygon collision
  return checkPolygonCollision(deck1World, deck2World, ship1.position, ship2.position);
}

/**
 * Get the deck module from a ship
 */
function getShipDeck(ship: Ship) {
  return ship.modules.find(module => module.kind === 'deck');
}

/**
 * Fallback hull-based collision detection
 */
function checkHullPolygonCollision(ship1: Ship, ship2: Ship): {
  isColliding: boolean;
  normal: Vec2;
  penetration: number;
  contactPoint: Vec2;
} {
  const hull1World = ship1.hull.map(p => p.rotate(ship1.rotation).add(ship1.position));
  const hull2World = ship2.hull.map(p => p.rotate(ship2.rotation).add(ship2.position));
  
  return checkPolygonCollision(hull1World, hull2World, ship1.position, ship2.position);
}

/**
 * Generic polygon collision detection using SAT
 */
function checkPolygonCollision(
  poly1: Vec2[], 
  poly2: Vec2[], 
  center1: Vec2, 
  center2: Vec2
): {
  isColliding: boolean;
  normal: Vec2;
  penetration: number;
  contactPoint: Vec2;
} {
  const axes: Vec2[] = [];
  
  // Get normal vectors from both polygons
  for (let i = 0; i < poly1.length; i++) {
    const current = poly1[i];
    const next = poly1[(i + 1) % poly1.length];
    const edge = next.sub(current);
    axes.push(Vec2.from(-edge.y, edge.x).normalize());
  }
  
  for (let i = 0; i < poly2.length; i++) {
    const current = poly2[i];
    const next = poly2[(i + 1) % poly2.length];
    const edge = next.sub(current);
    axes.push(Vec2.from(-edge.y, edge.x).normalize());
  }
  
  let minOverlap = Infinity;
  let separationAxis = Vec2.zero();
  
  // Test each axis for separation
  for (const axis of axes) {
    const proj1 = projectPolygonOntoAxis(poly1, axis);
    const proj2 = projectPolygonOntoAxis(poly2, axis);
    
    const overlap = Math.min(proj1.max, proj2.max) - Math.max(proj1.min, proj2.min);
    
    if (overlap <= 0) {
      return {
        isColliding: false,
        normal: Vec2.zero(),
        penetration: 0,
        contactPoint: Vec2.zero()
      };
    }
    
    if (overlap < minOverlap) {
      minOverlap = overlap;
      separationAxis = axis;
    }
  }
  
  // Ensure normal points from ship1 to ship2
  const centerDiff = center2.sub(center1);
  if (centerDiff.dot(separationAxis) < 0) {
    separationAxis = separationAxis.mul(-1);
  }
  
  return {
    isColliding: true,
    normal: separationAxis,
    penetration: minOverlap,
    contactPoint: center1.add(center2).mul(0.5)
  };
}

/**
 * Project a polygon onto an axis
 */
function projectPolygonOntoAxis(vertices: Vec2[], axis: Vec2): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  
  for (const vertex of vertices) {
    const projection = vertex.dot(axis);
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  
  return { min, max };
}

/**
 * Resolve collision between two ships with realistic physics
 */
function resolveShipCollision(ship1: Ship, ship2: Ship, collision: any): void {
  const normal = collision.normal;
  const penetration = collision.penetration;
  
  // Ship masses (assume larger ships are heavier)
  const mass1 = 1000; // Base ship mass
  const mass2 = 1000; // Base ship mass
  const totalMass = mass1 + mass2;
  
  // Separate ships to avoid overlap
  const separationRatio1 = mass2 / totalMass; // Lighter object moves more
  const separationRatio2 = mass1 / totalMass;
  
  ship1.position = ship1.position.sub(normal.mul(penetration * separationRatio1));
  ship2.position = ship2.position.add(normal.mul(penetration * separationRatio2));
  
  // Calculate relative velocity at collision point
  const relativeVelocity = ship2.velocity.sub(ship1.velocity);
  const velocityAlongNormal = relativeVelocity.dot(normal);
  
  // Don't resolve if objects are separating
  if (velocityAlongNormal > 0) return;
  
  // Very low restitution for realistic ship collision (no bounce)
  const restitution = 0.05; // Ships are heavy and absorb impact
  const impulseScalar = -(1 + restitution) * velocityAlongNormal / totalMass;
  const impulse = normal.mul(impulseScalar);
  
  // Apply impulse to velocities with momentum transfer
  const momentum1 = impulse.mul(mass2);
  const momentum2 = impulse.mul(mass1);
  
  ship1.velocity = ship1.velocity.sub(momentum1);
  ship2.velocity = ship2.velocity.add(momentum2);
  
  // Calculate impact speed for damage scaling
  const impactSpeed = Math.abs(velocityAlongNormal);
  
  // Add angular velocity based on impact location and speed
  const arm1 = collision.contactPoint.sub(ship1.position);
  const arm2 = collision.contactPoint.sub(ship2.position);
  const angularFactor = Math.min(impactSpeed * 0.0005, 0.002); // Scale with impact speed
  
  const torque1 = arm1.cross(momentum1.mul(-1)) * angularFactor;
  const torque2 = arm2.cross(momentum2) * angularFactor;
  
  ship1.angularVelocity += torque1;
  ship2.angularVelocity += torque2;
  
  // Heavy damping for realistic water resistance and structural damage absorption
  const speedDamping = Math.max(0.7, 1.0 - impactSpeed * 0.01); // More damping at high speeds
  const angularDamping = Math.max(0.6, 1.0 - impactSpeed * 0.015);
  
  ship1.velocity = ship1.velocity.mul(speedDamping);
  ship2.velocity = ship2.velocity.mul(speedDamping);
  ship1.angularVelocity *= angularDamping;
  ship2.angularVelocity *= angularDamping;
}

/**
 * Map a collision point to the corresponding plank index using radial angle
 * This assumes planks are distributed around the ship hull in a circular pattern
 * 
 * @param ship - The ship being hit
 * @param collisionPoint - World coordinates of the collision
 * @param totalPlanks - Total number of planks (typically 10 for brigantine)
 * @returns Plank index (0-based)
 */
function mapCollisionToPlankIndex(ship: Ship, collisionPoint: Vec2, totalPlanks: number = 10): number {
  // Convert collision point to ship-local coordinates
  const localCollision = collisionPoint.sub(ship.position).rotate(-ship.rotation);
  
  // Calculate angle from ship center to collision point
  // atan2 returns angle in radians from -π to π
  const angle = Math.atan2(localCollision.y, localCollision.x);
  
  // Normalize angle to 0-2π range
  const normalizedAngle = angle < 0 ? angle + Math.PI * 2 : angle;
  
  // Map angle to plank index
  // Divide the circle into equal segments (one per plank)
  const anglePerPlank = (Math.PI * 2) / totalPlanks;
  const plankIndex = Math.floor(normalizedAngle / anglePerPlank) % totalPlanks;
  
  return plankIndex;
}

/**
 * Map a hull edge — identified by its DESTINATION vertex index in the polygon
 * loop — to one of the 10 brigantine plank slots (0-9).
 *
 * Direct port of server hull_edge_to_plank_slot() (websocket_server.c).
 * Vertex layout for the brigantine hull (client builds 48 verts, server uses 47;
 * the extra trailing port vertex falls into the same slot-9 range):
 *   0..12  — bow curve      → slot 0 (bow_port; twin = slot 1)
 *   13..24 — stbd straight  → slots 2/3/4 (4 edges each)
 *   25..36 — stern curve    → slot 5 (stern_stbd; twin = slot 6)
 *   37..   — port straight  → slots 7/8/9 (+ closing edge dest=0 → slot 9)
 */
function hullEdgeToPlankSlot(edgeDestIndex: number, nv: number): number {
  if (edgeDestIndex >= 1  && edgeDestIndex <= 12) return 0; // bow curve
  if (edgeDestIndex >= 13 && edgeDestIndex <= 16) return 2; // stbd seg 0
  if (edgeDestIndex >= 17 && edgeDestIndex <= 20) return 3; // stbd seg 1
  if (edgeDestIndex >= 21 && edgeDestIndex <= 24) return 4; // stbd seg 2
  if (edgeDestIndex >= 25 && edgeDestIndex <= 36) return 5; // stern curve
  if (edgeDestIndex >= 37 && edgeDestIndex <= 40) return 7; // port seg 0
  if (edgeDestIndex >= 41 && edgeDestIndex <= 44) return 8; // port seg 1
  if (edgeDestIndex === 0 || (edgeDestIndex >= 45 && edgeDestIndex < nv)) return 9; // port seg 2 + close
  return -1;
}

/**
 * Twin plank slot for the bow/stern dual-plank sections, or -1.
 * Port of server hull_plank_twin_slot(): those curves carry TWO planks
 * (port+stbd faces) and are only breached when both are destroyed.
 */
function hullPlankTwinSlot(slot: number): number {
  if (slot === 0) return 1; // bow_port ↔ bow_stbd
  if (slot === 5) return 6; // stern_stbd ↔ stern_port
  return -1;
}

/**
 * Resolve a plank module to its server slot number (0-9) from the template's
 * sectionName/segmentIndex (set in PlankSegments.createCompleteHullSegments,
 * which mirrors the server's PLANK_KEYS table). Returns null when unknown.
 */
function plankModuleToSlot(data: { sectionName?: string; segmentIndex?: number }): number | null {
  switch (data.sectionName) {
    case 'bow_port':        return 0;
    case 'bow_starboard':   return 1;
    case 'starboard_side':  return 2 + (data.segmentIndex ?? 0); // segs 0-2 → slots 2-4
    case 'stern_starboard': return 5;
    case 'stern_port':      return 6;
    case 'port_side':       return 7 + (data.segmentIndex ?? 0); // segs 0-2 → slots 7-9
    default:                return null;
  }
}

/**
 * Build plank health keyed by SERVER SLOT (0-9).
 * Falls back to template array order when sectionName is missing — the
 * template emits planks in exact slot order 0-9.
 * Returns null when the ship has no plank modules (solid hull).
 */
function buildPlankSlotHealth(ship: Ship): Map<number, number> | null {
  const planks = ship.modules.filter(m =>
    m.kind === 'plank' && m.moduleData && m.moduleData.kind === 'plank'
  );
  if (planks.length === 0) return null;

  const slotHealth = new Map<number, number>();
  planks.forEach((plank, order) => {
    const data = plank.moduleData as { sectionName?: string; segmentIndex?: number; health?: number };
    const slot = plankModuleToSlot(data) ?? order;
    slotHealth.set(slot, data.health ?? 0);
  });
  return slotHealth;
}

/**
 * True when the hull edge ending at vertex `edgeDestIndex` is guarded by at
 * least one living plank. Mirrors server hull_section_plank_alive(): bow and
 * stern sections check BOTH covering planks; a missing slot counts as dead
 * (the server treats an absent plank module as a breach).
 */
function hullEdgeAlive(
  edgeDestIndex: number,
  nv: number,
  slotHealth: Map<number, number> | null
): boolean {
  if (!slotHealth) return true; // no plank modules: solid hull
  const slot = hullEdgeToPlankSlot(edgeDestIndex, nv);
  if (slot < 0) return true;    // unknown edge → treat as solid (server parity)
  if ((slotHealth.get(slot) ?? 0) > 0) return true;
  const twin = hullPlankTwinSlot(slot);
  if (twin >= 0 && (slotHealth.get(twin) ?? 0) > 0) return true;
  return false;                 // all covering planks gone — hull breach
}

/**
 * Create hull collision segments only for healthy planks
 * Destroyed planks create gaps that players can walk/fall through
 * 
 * @param ship - The ship to generate collision segments for
 * @returns Array of line segments (world coordinates) representing solid hull sections
 */
function createHealthyHullSegments(ship: Ship): Array<{start: Vec2, end: Vec2, plankIndex: number}> {
  const segments: Array<{start: Vec2, end: Vec2, plankIndex: number}> = [];

  // Ghost hulls are always fully solid — treat every edge as alive.
  const isGhost = ship.shipType === SHIP_TYPE_GHOST;

  // Plank health keyed by server slot (0-9), section-aware like the server.
  const slotHealth = buildPlankSlotHealth(ship);

  // Transform hull to world coordinates
  const hullWorld = ship.hull.map(p => p.rotate(ship.rotation).add(ship.position));
  const n = hullWorld.length;

  // Create segments only for hull edges guarded by a living plank.
  // Edges are keyed by their DESTINATION vertex index, matching the server.
  for (let i = 0; i < n; i++) {
    const destIndex = (i + 1) % n;
    if (!isGhost && !hullEdgeAlive(destIndex, n, slotHealth)) continue; // breach — gap (player ships only)

    segments.push({
      start: hullWorld[i],
      end: hullWorld[destIndex],
      plankIndex: hullEdgeToPlankSlot(destIndex, n),
    });
  }

  return segments;
}

/**
 * Static hull collision resolver for NON-boarded players (swimmers).
 * Mirrors the server's resolve_swimmer_ship_hull_collision().
 *
 * Robust against sustained contact: which side of the hull the player belongs
 * on is decided from the PREVIOUS (collision-valid) position, so pressing into
 * the hull can never flip the wall — alive edges reject crossings outright and
 * push the contact circle back to the legal side every tick. Edges whose plank
 * is destroyed are passable in both directions (hull breach).
 *
 * Returns the corrected world position, or null when no contact occurred.
 */
function resolveSwimmerHullCollision(
  prevPos: Vec2,
  newPos: Vec2,
  radius: number,
  ship: Ship
): Vec2 | null {
  const hull = ship.hull;
  const n = hull.length;
  if (n < 3) return null;

  // Ghost ship hulls are always fully solid — players cannot pass through
  // breached sections or board a ghost ship. Skip plank-alive checks.
  const isGhost = ship.shipType === SHIP_TYPE_GHOST;

  // Plank health keyed by server slot (0-9). Edges are keyed by their
  // DESTINATION vertex index — the same convention as the server's
  // `for (i, j=i-1)` loop passing `i` to hull_edge_to_plank_slot(). Our loops
  // below walk edges as (i → i+1), so the edge key is (i + 1) % n.
  const slotHealth = buildPlankSlotHealth(ship);
  const edgeAlive = (i: number): boolean =>
    isGhost || hullEdgeAlive((i + 1) % n, n, slotHealth);

  // Work in ship-local space so the hull stays static.
  const cosL = Math.cos(-ship.rotation), sinL = Math.sin(-ship.rotation);
  const toLocalX = (v: Vec2) => (v.x - ship.position.x) * cosL - (v.y - ship.position.y) * sinL;
  const toLocalY = (v: Vec2) => (v.x - ship.position.x) * sinL + (v.y - ship.position.y) * cosL;
  const ox = toLocalX(prevPos), oy = toLocalY(prevPos);
  let px = toLocalX(newPos),  py = toLocalY(newPos);

  // Polygon winding → outward normal orientation.
  let area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area2 += hull[j].x * hull[i].y - hull[i].x * hull[j].y;
  }
  const ccw = area2 >= 0 ? 1 : -1;

  // Swimmers always belong on the OUTSIDE of any hull.
  //
  // The old model used the previous-position side to pick the normal direction:
  // if prevPos was inside (e.g. just dismounted from deck), sideSign = -1 and
  // pass 2 actively pushed the player TOWARD the ship centre every tick. The
  // client then reported that centre position to the server, which adopted it,
  // creating a self-reinforcing loop ("pushed back to centre on dismount").
  //
  // Fix: always use sideSign = +1 (outward normals). If the player starts
  // inside (post-dismount), both passes push them outward through the nearest
  // alive edge. Breach gaps are handled separately by edgeAlive() returning
  // false for dead planks — those edges are simply skipped in both passes, so
  // players can still exit through a breached hull section.
  const sideSign = 1;

  let moved = false;

  // Pass 1: crossing rejection — if the old→new motion segment crosses an alive
  // edge, clamp to the earliest crossing point pushed back to the legal side.
  let bestT = Infinity;
  let bestEdge = -1;
  const mx = px - ox, my = py - oy;
  if (mx * mx + my * my > 1e-9) {
    for (let i = 0; i < n; i++) {
      if (!edgeAlive(i)) continue;
      const a = hull[i], b = hull[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const denom = mx * ey - my * ex;
      if (Math.abs(denom) < 1e-9) continue; // parallel
      const t = ((a.x - ox) * ey - (a.y - oy) * ex) / denom;
      const u = ((a.x - ox) * my - (a.y - oy) * mx) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bestT) {
        bestT = t;
        bestEdge = i;
      }
    }
  }
  if (bestEdge >= 0) {
    const a = hull[bestEdge], b = hull[(bestEdge + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const elen = Math.hypot(ex, ey);
    // Outward normal of this edge, oriented to the player's legal side.
    const nx = (ey / elen) * ccw * sideSign;
    const ny = (-ex / elen) * ccw * sideSign;
    px = ox + mx * bestT + nx * radius;
    py = oy + my * bestT + ny * radius;
    moved = true;
  }

  // Pass 2: contact pushout (two iterations so corners settle).
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < n; i++) {
      if (!edgeAlive(i)) continue;
      const a = hull[i], b = hull[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const elen2 = ex * ex + ey * ey;
      if (elen2 < 0.0001) continue;
      let t = ((px - a.x) * ex + (py - a.y) * ey) / elen2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const cx = a.x + t * ex, cy = a.y + t * ey;
      const vx = px - cx, vy = py - cy;
      const d2 = vx * vx + vy * vy;
      if (d2 >= radius * radius) continue;

      const elen = Math.sqrt(elen2);
      const nx = (ey / elen) * ccw * sideSign; // legal-side normal
      const ny = (-ex / elen) * ccw * sideSign;
      const s = vx * nx + vy * ny;
      const d = Math.sqrt(d2);
      if (s >= 0 && d > 0.001) {
        // Shallow contact on the legal side: push directly away from the edge.
        const push = radius - d;
        px += (vx / d) * push;
        py += (vy / d) * push;
      } else {
        // Center slipped to (or past) the wrong side: snap back to the legal side.
        px = cx + nx * radius;
        py = cy + ny * radius;
      }
      moved = true;
    }
  }

  if (!moved) return null;

  const cosW = Math.cos(ship.rotation), sinW = Math.sin(ship.rotation);
  return Vec2.from(
    px * cosW - py * sinW + ship.position.x,
    px * sinW + py * cosW + ship.position.y,
  );
}

/**
 * Check collision against healthy hull segments
 * Only segments with healthy planks provide collision
 * Destroyed planks create gaps that players can pass through
 */
function sweptCircleVsHealthyHull(
  startPos: Vec2,
  endPos: Vec2,
  radius: number,
  velocity: Vec2,
  ship: Ship,
  epsilon: number,
  dt: number
): CollisionResult {
  const segments = createHealthyHullSegments(ship);
  
  // If no healthy segments, no collision possible - player can pass through
  if (segments.length === 0) {
    return {
      newPosition: endPos,
      newVelocity: velocity,
      collided: false,
      normal: Vec2.zero(),
      penetrationDepth: 0,
      contactPoint: endPos,
      slideDistance: 0
    };
  }
  
  // Build a polygon from the healthy segments
  // Note: This might create gaps where destroyed planks are
  const healthyPolygon: Vec2[] = [];
  const segmentSet = new Set(segments.map(s => `${s.start.x},${s.start.y}`));
  
  // Try to build a contiguous polygon from segments
  // If there are gaps (destroyed planks), we'll handle collision segment-by-segment
  let hasGaps = segments.length < ship.hull.length;
  
  if (!hasGaps) {
    // All planks healthy — run the swept-circle test in ship-local space so that
    // the hull polygon never changes shape due to floating-point trig at different
    // rotation values.  We un-rotate inputs, test against the static local hull,
    // then rotate the result back to world space.
    const cos = Math.cos(-ship.rotation);
    const sin = Math.sin(-ship.rotation);
    const toLocal = (v: Vec2) =>
      Vec2.from(
        (v.x - ship.position.x) * cos - (v.y - ship.position.y) * sin,
        (v.x - ship.position.x) * sin + (v.y - ship.position.y) * cos
      );
    const toWorld = (v: Vec2) =>
      Vec2.from(
        v.x * Math.cos(ship.rotation) - v.y * Math.sin(ship.rotation) + ship.position.x,
        v.x * Math.sin(ship.rotation) + v.y * Math.cos(ship.rotation) + ship.position.y
      );

    const localResult = CollisionSystem.sweptCircleVsPolygon({
      startPos:  toLocal(startPos),
      endPos:    toLocal(endPos),
      radius:    radius,
      velocity:  velocity.rotate(-ship.rotation),
      polygon:   ship.hull,          // static local-space vertices
      epsilon:   epsilon,
      dt:        dt
    });

    return {
      newPosition:      toWorld(localResult.newPosition),
      newVelocity:      localResult.newVelocity.rotate(ship.rotation),
      collided:         localResult.collided,
      normal:           localResult.normal.rotate(ship.rotation),
      penetrationDepth: localResult.penetrationDepth,
      contactPoint:     toWorld(localResult.contactPoint),
      slideDistance:    localResult.slideDistance
    };
  }
  
  // Has gaps - check if player path crosses any healthy segment
  // If not, they can pass through the gap
  let collided = false;
  let closestPoint = endPos;
  let collisionNormal = Vec2.zero();
  let minDistance = Infinity;
  
  const movement = endPos.sub(startPos);
  const movementLength = movement.length();
  
  if (movementLength < 0.001) {
    // No significant movement
    return {
      newPosition: endPos,
      newVelocity: velocity,
      collided: false,
      normal: Vec2.zero(),
      penetrationDepth: 0,
      contactPoint: endPos,
      slideDistance: 0
    };
  }
  
  // Check each healthy segment for collision
  for (const segment of segments) {
    const edgeVec = segment.end.sub(segment.start);
    const edgeDir = edgeVec.normalize();
    const edgeNormal = Vec2.from(-edgeDir.y, edgeDir.x);
    
    // Check if movement path intersects this segment (with radius)
    const distToSegment = pointToSegmentDistance(startPos, segment.start, segment.end);
    const endDistToSegment = pointToSegmentDistance(endPos, segment.start, segment.end);
    
    // If either start or end is within collision distance, handle it
    if (distToSegment < radius + epsilon || endDistToSegment < radius + epsilon) {
      // Collision with this segment - project onto it
      const closestOnSegment = closestPointOnSegment(endPos, segment.start, segment.end);
      const distanceToEdge = endPos.sub(closestOnSegment).length();
      
      if (distanceToEdge < minDistance) {
        minDistance = distanceToEdge;
        collided = true;
        
        // Push player away from segment
        const pushDir = endPos.sub(closestOnSegment).normalize();
        closestPoint = closestOnSegment.add(pushDir.mul(radius + epsilon));
        collisionNormal = pushDir;
      }
    }
  }
  
  if (collided) {
    // Apply sliding along the collision normal
    const slideVel = velocity.sub(collisionNormal.mul(velocity.dot(collisionNormal)));
    
    return {
      newPosition: closestPoint,
      newVelocity: slideVel,
      collided: true,
      normal: collisionNormal,
      penetrationDepth: Math.max(0, radius + epsilon - minDistance),
      contactPoint: closestPoint,
      slideDistance: 0
    };
  }
  
  // No collision - player can move freely (possibly through a gap)
  return {
    newPosition: endPos,
    newVelocity: velocity,
    collided: false,
    normal: Vec2.zero(),
    penetrationDepth: 0,
    contactPoint: endPos,
    slideDistance: 0
  };
}

/**
 * Calculate distance from point to line segment
 */
function pointToSegmentDistance(point: Vec2, segStart: Vec2, segEnd: Vec2): number {
  const closest = closestPointOnSegment(point, segStart, segEnd);
  return point.sub(closest).length();
}

/**
 * Find closest point on line segment to given point
 */
function closestPointOnSegment(point: Vec2, segStart: Vec2, segEnd: Vec2): Vec2 {
  const segVec = segEnd.sub(segStart);
  const segLengthSq = segVec.lengthSq();
  
  if (segLengthSq < 0.0001) {
    return segStart; // Degenerate segment
  }
  
  const pointVec = point.sub(segStart);
  const t = Math.max(0, Math.min(1, pointVec.dot(segVec) / segLengthSq));
  
  return segStart.add(segVec.mul(t));
}

/**
 * Apply radial angle-based damage to a plank
 * Finds the plank based on collision angle and applies damage
 * 
 * @param ship - The ship being damaged
 * @param collisionPoint - World coordinates of the collision
 * @param damage - Amount of damage to apply
 * @param spreadRadius - Optional angular spread to damage adjacent planks (in radians)
 */
function applyRadialPlankDamage(
  ship: Ship, 
  collisionPoint: Vec2, 
  damage: number,
  spreadRadius: number = 0
): void {
  // Find all plank modules
  const planks = ship.modules.filter(m => 
    m.kind === 'plank' && 
    m.moduleData && 
    m.moduleData.kind === 'plank' &&
    m.moduleData.health > 0
  );
  
  if (planks.length === 0) return;
  
  // Get the primary plank hit
  const primaryPlankIndex = mapCollisionToPlankIndex(ship, collisionPoint, planks.length);
  
  // Apply damage to primary plank
  const primaryPlank = planks[primaryPlankIndex];
  if (primaryPlank && primaryPlank.moduleData && primaryPlank.moduleData.kind === 'plank') {
    const plankData = primaryPlank.moduleData;
    plankData.health       = Math.max(0, plankData.health       - damage);
    plankData.targetHealth = Math.max(0, (plankData.targetHealth ?? plankData.maxHealth) - damage);
    
    if (plankData.health <= 0) {
      console.log(`💥 Radial collision destroyed plank ${primaryPlankIndex}! (${damage.toFixed(1)} damage)`);
    } else {
      console.log(`⚔️ Radial collision damaged plank ${primaryPlankIndex}: ${plankData.health.toFixed(1)} health remaining`);
    }
  }
  
  // If spread radius is specified, damage adjacent planks
  if (spreadRadius > 0) {
    const anglePerPlank = (Math.PI * 2) / planks.length;
    const spreadPlanks = Math.ceil(spreadRadius / anglePerPlank);
    
    for (let offset = 1; offset <= spreadPlanks; offset++) {
      const falloffFactor = 1 - (offset / (spreadPlanks + 1)); // Damage decreases with distance
      const spreadDamage = damage * falloffFactor * 0.5; // 50% max for adjacent planks
      
      // Damage plank to the left
      const leftIndex = (primaryPlankIndex - offset + planks.length) % planks.length;
      const leftPlank = planks[leftIndex];
      if (leftPlank && leftPlank.moduleData && leftPlank.moduleData.kind === 'plank') {
        leftPlank.moduleData.health       = Math.max(0, leftPlank.moduleData.health       - spreadDamage);
        leftPlank.moduleData.targetHealth = Math.max(0, (leftPlank.moduleData.targetHealth ?? leftPlank.moduleData.maxHealth) - spreadDamage);
      }
      
      // Damage plank to the right
      const rightIndex = (primaryPlankIndex + offset) % planks.length;
      const rightPlank = planks[rightIndex];
      if (rightPlank && rightPlank.moduleData && rightPlank.moduleData.kind === 'plank') {
        rightPlank.moduleData.health       = Math.max(0, rightPlank.moduleData.health       - spreadDamage);
        rightPlank.moduleData.targetHealth = Math.max(0, (rightPlank.moduleData.targetHealth ?? rightPlank.moduleData.maxHealth) - spreadDamage);
      }
    }
  }
}

/**
 * Calculate plank damage from ship collision using radial angle-based detection
 */
function calculateCollisionPlankDamage(ship1: Ship, ship2: Ship, collision: any): void {
  const impactForce = collision.penetration * 10; // Convert penetration to damage force
  const baseDamage = Math.min(impactForce * 200, 1500); // Cap collision damage at 1500 per hit (scaled to 10000 HP)
  
  // Use radial angle-based damage instead of distance-based
  // Apply to both ships at their respective collision points
  const spreadAngle = Math.PI / 6; // 30 degrees spread (affects 1-2 adjacent planks)
  
  applyRadialPlankDamage(ship1, collision.contactPoint, baseDamage, spreadAngle);
  applyRadialPlankDamage(ship2, collision.contactPoint, baseDamage, spreadAngle);
}

/**
 * Apply collision damage to planks within radius of contact point
 * DEPRECATED: Use applyRadialPlankDamage instead for angle-based damage
 */
function applyCollisionDamageToShip(ship: Ship, contactPoint: Vec2, baseDamage: number, damageRadius: number): void {
  // This function is deprecated - keeping for reference only
  // New code should use applyRadialPlankDamage() instead
  console.warn('applyCollisionDamageToShip is deprecated. Use applyRadialPlankDamage instead.');
  
  for (const module of ship.modules) {
    if (module.kind !== 'plank') continue;
    if (!module.moduleData || module.moduleData.kind !== 'plank') continue;
    
    const plankData = module.moduleData as any;
    if (plankData.health <= 0) continue; // Skip already destroyed planks
    
    // Calculate plank position in world coordinates
    const plankWorldPos = module.localPos.rotate(ship.rotation).add(ship.position);
    const distanceToContact = plankWorldPos.sub(contactPoint).length();
    
    // Apply damage based on distance to contact point
    if (distanceToContact <= damageRadius) {
      const damageMultiplier = 1 - (distanceToContact / damageRadius); // Closer = more damage
      const damage = baseDamage * damageMultiplier;
      
      plankData.health = Math.max(0, plankData.health - damage);
      
      if (plankData.health <= 0 && damage > 0) {
        console.log(`💥 Collision destroyed plank! (${damage.toFixed(1)} damage)`);
        plankData.destroyed = true;
      } else if (damage > 0) {
        console.log(`⚔️ Collision damaged plank: ${plankData.health.toFixed(1)} health remaining`);
      }
    }
  }
}