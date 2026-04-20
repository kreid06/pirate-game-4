# Pirate Game — Data Structure Reference

## ID System Overview

The game uses a two-tier ID system. Tier determines width, which is chosen by frequency and scope.

### Tier 1 — Module ID (`module_id_t`, `uint16_t`)

Used for per-tick module health, state updates, and interaction events.

```
Bit: 15──8         │  7──0
     ───────────────┼───────────────
     ship_seq       │  offset
     (1–255)        │  (0–255)
```

- `ship_seq`: top byte, which ship. Monotonically incrementing, never reused, never 0.
- `offset`: bottom byte, which slot within that ship. Fixed per module type.
- `0x0000` = `MODULE_ID_INVALID` — never assigned.
- Defined in: `server/include/sim/module_ids.h`
- Key macros: `MID(seq, off)`, `MID_SHIP_SEQ(id)`, `MID_OFFSET(id)`, `MID_BELONGS_TO(id, seq)`

**Fixed offset table (bottom byte):**

| Offset | Name | Notes |
|--------|------|-------|
| `0x00` | INVALID | reserved |
| `0x01` | LADDER | emergency stern ladder |
| `0x02` | HELM | steering wheel |
| `0x03` | CANNON_PORT_0 | mid-ship port |
| `0x04` | CANNON_PORT_1 | bow-ward port |
| `0x05` | CANNON_PORT_2 | stern-ward port |
| `0x06` | CANNON_STBD_0 | mid-ship starboard |
| `0x07` | CANNON_STBD_1 | bow-ward starboard |
| `0x08` | CANNON_STBD_2 | stern-ward starboard |
| `0x09` | MAST_BOW | forward mast |
| `0x0A` | MAST_MID | centre mast |
| `0x0B` | MAST_STERN | aft mast |
| `0x0C–0x15` | PLANK(0–9) | hull segments |
| `0x16` | DECK | centre deck |
| `0x17–0xFF` | DYNAMIC_BASE+ | dynamically placed |

Wire cost: 2 bytes binary, 5 chars JSON (max 65535).

---

### Tier 0 — Entity IDs (current state)

| Field | Type | Value | Scope |
|-------|------|-------|-------|
| `SimpleShip.ship_id` | `uint16_t` | `= ship_seq` (alias) | WebSocket layer |
| `SimpleShip.ship_seq` | `uint8_t` | 1–255, never reused | module ID namespace |
| `sim Ship.id` (`entity_id`) | `uint16_t` | physics-internal flat counter | physics sim only |
| `WebSocketPlayer.player_id` | `uint32_t` | 1000+ | WebSocket layer |
| `WebSocketPlayer.sim_entity_id` | `uint16_t` | sim-assigned | physics sim |
| `WorldNpc.id` | `uint32_t` | 5000+ | WebSocket layer |
| `island.id` | `uint32_t` | flat counter | WebSocket layer |
| `PlacedStructure.id` | `uint32_t` | flat counter | WebSocket layer |

> **Single-server:** `ship_id = ship_seq`. One counter (`next_ship_seq`) drives both. `next_ship_id` has been removed.
>
> **Multi-server (future):** `ship_id` widens to `(server_id << 8) | ship_seq` — still `uint16_t` (8-bit server_id + 8-bit ship_seq). `ship_seq` stays frozen as the module-namespace byte — always extractable as `ship_id & 0xFF`. Module IDs never change.
>
> `sim Ship.id` remains physics-internal and is intentionally separate from `ship_id`.

---

### Future Tier — Global ID (`game_id_t`, `uint32_t`, not yet implemented)

Planned for cross-server / cluster entity references sent once per session (alias table, not per-tick).

```
Bit: 31──24      │  23──16       │  15──8        │  7──0
     ─────────────┼───────────────┼───────────────┼──────────
     reserved     │  server_id    │  ship_seq     │  offset
     (future use) │  (1–255)      │  (1–255)      │  (0–255)
```

- Bottom 2 bytes = local `module_id_t` directly.
- Byte 2 = which server in a cluster (not yet used, single-server for now).
- Client holds an alias table `Map<local_id, global_id>` populated once on zone entry; hot path still uses `module_id_t`.

---

## Entity Structs

### `ShipModule` (shared by both layers)

Defined in: `server/include/sim/module_types.h`

```
ShipModule
├── id              module_id_t (uint16_t)  MID(ship_seq, offset)
├── type_id         ModuleTypeId enum
│     HELM=0, SEAT=1, CANNON=2, MAST=3, LADDER=5,
│     PLANK=6, DECK=7, SWIVEL=8
├── deck_id         uint16_t
├── local_pos       Vec2Q16     ship-local position (server units)
├── local_rot       q16_t       ship-local rotation (radians, Q16.16)
├── state_bits      uint16_t    ModuleStateBits flags
│     ACTIVE, DAMAGED, DESTROYED, FIRING, RELOADING,
│     OCCUPIED, DEPLOYED, LOCKED, REPAIRING, NEEDED,
│     RETRACTED, DECK_ZONE0/1/2
├── health          q16_t       current HP
├── target_health   q16_t       repair ceiling (planks only)
├── max_health      q16_t       plank=10000, cannon=8000, mast=15000, helm=10000
├── fire_timer_ms   uint32_t    >0 = burning
└── data (union):
    ├── CannonModuleData     aim_direction, ammunition, time_since_fire, reload_time
    ├── MastModuleData       angle, openness, wind_efficiency, fiber_health, sail_fire_intensity
    ├── HelmModuleData       wheel_rotation, occupied_by (entity_id)
    ├── SeatModuleData       occupied_by (entity_id)
    ├── SwivelModuleData     aim_direction, time_since_fire, reload_time, loaded_ammo
    └── PlankModuleData      (health tracked at ShipModule level)
```

---

### `sim Ship` — physics layer

Defined in: `server/include/sim/types.h`

```
sim Ship
├── id                  entity_id (uint16_t)    physics sim counter
├── position            Vec2Q16                 world position (server metres, Q16.16)
├── velocity            Vec2Q16                 linear velocity (m/s)
├── rotation            q16_t                   radians (Q16.16)
├── angular_velocity    q16_t
├── mass                q16_t                   kg
├── moment_inertia      q16_t                   kg⋅m²
├── net_force           Vec2Q16                 accumulator, cleared each tick
├── net_torque          q16_t                   accumulator, cleared each tick
├── hull_health         q16_t
├── hull_vertices[]     Vec2Q16[64]             collision polygon (47 used)
├── bounding_radius     q16_t                   broad-phase radius
├── modules[]           ShipModule[64]          IDs = MID(ship_seq, offset)
├── module_count        uint8_t
├── desired_sail_openness uint8_t               0–100%
├── rudder_angle        float                   degrees (–50 to +50)
├── initial_plank_count uint8_t                 set once at creation (10)
├── company_id          uint8_t                 COMPANY_* faction
├── has_crew            uint8_t                 ≥1 player aboard (set by WS layer)
└── level_stats         ShipLevelStats
```

Tick rate: 30 Hz. Fixed timestep `FIXED_DT_Q16`.

---

### `SimpleShip` — WebSocket/network layer

Defined in: `server/include/net/websocket_server.h`

```
SimpleShip
├── ship_id             uint16_t        = ship_seq on single server; widens to (server_id<<8)|ship_seq on cluster
├── ship_seq            uint8_t         module ID namespace — top byte of every module_id_t on this ship
│                                         module_id = MID(ship_seq, offset); always = ship_id & 0xFF
├── ship_type           uint32_t        SHIP_TYPE_BRIGANTINE=3 etc.
├── x, y                float           world position (client pixels)
├── rotation            float           radians
├── velocity_x/y        float
├── angular_velocity    float
├── mass/moment_of_inertia/max_speed/turn_rate float  physics properties
├── deck_min/max_x/y    float           walkable area bounds
├── company_id          uint8_t         COMPANY_PIRATES=1, NAVY=2, GHOST=99
├── desired_sail_openness uint8_t
├── desired_sail_angle  float           radians (±60°)
├── cannon_ammo         uint16_t        shared pool (when infinite_ammo=false)
├── infinite_ammo       bool
├── active_aim_angle    float           NPC sector-of-fire hint
├── modules[]           ShipModule[64]  IDs = MID(ship_seq, offset) — mirrors sim Ship
├── module_count        uint8_t
├── cannon_last_fire_ms[]  uint32_t[64]   wall-clock ms of last fire per slot
├── cannon_last_needed_ms[] uint32_t[64]  wall-clock ms of last needed per slot
├── weapon_groups[company][10] WeaponGroup  per-company weapon targeting groups
      └── weapon_ids[16]  module_id_t  /* MID(ship_seq, offset) for each cannon/swivel in group */
├── is_sinking          bool
├── sink_start_ms       uint32_t
└── reverse_thrust      bool
```

---

### `WebSocketPlayer`

Defined in: `server/include/net/websocket_server.h`

```
WebSocketPlayer
├── player_id           uint32_t        network counter (starts 1000)
├── sim_entity_id       uint16_t        entity_id in physics sim
├── name                char[64]
├── x, y                float           world position (client pixels)
├── velocity_x/y        float
├── rotation            float           radians
├── movement_direction_x/y float        –1.0 to 1.0 normalised
├── is_moving / is_sprinting bool
├── parent_ship_id      uint16_t        → SimpleShip.ship_id
├── local_x, local_y    float           ship-local position
├── movement_state      PlayerMovementState  IDLE/WALKING/SWIMMING/FALLING
├── company_id          uint8_t         inherited from ship on board
├── is_mounted          bool
├── mounted_module_id   module_id_t    /* MID(ship_seq, offset); 0 if not mounted */
├── controlling_ship_id uint16_t        → SimpleShip.ship_id (helm only)
├── cannon_aim_angle    float           world radians
├── cannon_aim_angle_relative float     ship-relative radians
├── health              uint16_t
├── max_health          uint16_t        default 100
├── sword_last_attack_ms uint32_t
├── inventory           PlayerInventory slots[10] + armor + shield + active_slot
├── fire_timer_ms       uint32_t
├── on_island_id        uint32_t        0 = in water
└── on_dock_id          uint32_t        0 = not on shipyard dock
```

---

### `WorldNpc`

Defined in: `server/include/net/websocket_server.h`

```
WorldNpc
├── id                  uint32_t        flat counter (starts 5000)
├── name                char[32]
├── active              bool
├── role                NpcRole         GUNNER=1, HELMSMAN=2, RIGGER=3, REPAIRER=4
├── x, y, rotation      float           world position (client pixels)
├── ship_id             uint16_t        → SimpleShip.ship_id
├── local_x, local_y    float           ship-local position
├── port_cannon_id      module_id_t     /* Rigger: mast ID.  Gunner: locked preference (0=free) */
├── starboard_cannon_id module_id_t     /* Rigger: mast ID (mirrors port).  Gunner: unused (0) */
├── assigned_weapon_id  module_id_t     /* Module the NPC is currently heading to / stationed at */
├── wants_cannon        bool
├── state               WorldNpcState   IDLE/MOVING/AT_GUN/REPAIRING
├── target_local_x/y    float           movement destination
├── idle_local_x/y      float           spawn resting position
├── move_speed          float           client units/s (default 80)
├── company_id          uint8_t
├── velocity_x/y        float           knockback (decays each tick)
├── npc_level           uint8_t         1–10
├── health / max_health uint16_t
├── xp                  uint32_t
├── stat_health/damage/stamina/weight  uint8_t  upgrade levels 0–5
├── fire_timer_ms       uint32_t
├── in_water            bool
├── task_locked         bool
└── boarding_ship_id    uint16_t        0 = not boarding
```

---

### `PlacedStructure` (island buildings / shipyard)

```
PlacedStructure
├── id                  uint32_t        flat counter
├── type                PlacedStructureType  WOODEN_FLOOR, WORKBENCH, WALL, DOOR_FRAME, DOOR, SHIPYARD
├── island_id           uint32_t        which island this sits on
├── x, y                float           world position
├── rotation            float           degrees
├── company_id          uint8_t
├── hp / max_hp         uint16_t
├── placer_id           uint32_t        → WebSocketPlayer.player_id
├── open                bool            doors only
├── construction_phase  ShipConstructionPhase  EMPTY / BUILDING
├── modules_placed      uint8_t         bitmask (MODULE_HULL_LEFT etc.)
├── construction_company uint8_t
└── scaffolded_ship_id  uint16_t        → SimpleShip.ship_id (0 = none)
```

---

## Known Type Mismatches (to fix)

All previously identified mismatches have been resolved:

| Field | Previous type | Fixed type | File |
|-------|--------------|-----------|------|
| `WebSocketPlayer.mounted_module_id` | `uint32_t` | `module_id_t` | websocket_server.h |
| `WorldNpc.assigned_weapon_id` | `uint32_t` | `module_id_t` | websocket_server.h |
| `WorldNpc.port_cannon_id` | `uint32_t` | `module_id_t` | websocket_server.h |
| `WorldNpc.starboard_cannon_id` | `uint32_t` | `module_id_t` | websocket_server.h |
| `WeaponGroup.weapon_ids[]` | `uint32_t[16]` | `module_id_t[16]` | websocket_server.h |
| `handle_cannon_fire` `explicit_ids` param | `uint32_t*` | `module_id_t*` | websocket_server.c |
| `handle_cannon_group_config` `weapon_ids` param | `uint32_t*` | `module_id_t*` | websocket_server.c |
| `handle_cannon_group_config` `valid_ids` local | `uint32_t[]` | `module_id_t[]` | websocket_server.c |
| `resolve_player_module_collisions` param | `uint32_t` | `module_id_t` | websocket_server.c |

JSON parse sites (`parse_json_uint32_array` → `module_id_t[]`) use a temporary `uint32_t` parse buffer with an explicit cast-copy loop, preserving the existing parse helper.

---

## Coordinate Systems

| System | Unit | Scale factor | Used in |
|--------|------|-------------|---------|
| Client units | pixels | — | WebSocket layer, client rendering |
| Server units | metres | `CLIENT_TO_SERVER(x) = x / 10.0f` | Physics sim (Q16.16) |
| Q16.16 | fixed-point | 1 unit = 65536 | All `q16_t` / `Vec2Q16` fields |

Conversion: `Q16_FROM_FLOAT(CLIENT_TO_SERVER(client_px))`

---

## Cluster / Multi-Server (planned)

Each server will have a `server_id` (uint8_t, 1–255).

Per-tick protocol stays unchanged — local `module_id_t` (2 bytes).

On zone entry the client receives a one-time alias manifest:
```
{ "entities": [ { "gid": <uint32>, "lid": <uint16>, "type": "ship|player|npc" } ] }
```

Global ID layout (when implemented):
```
[31..24] reserved | [23..16] server_id | [15..8] ship_seq | [7..0] offset
```
`global_id & 0xFFFF` = local `module_id_t` directly (no translation when server_id is known).

