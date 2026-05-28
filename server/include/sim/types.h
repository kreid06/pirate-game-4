#ifndef SIM_TYPES_H
#define SIM_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"
#include "core/rng.h"
#include "sim/module_types.h"
#include "sim/ship_level.h"

/* ── Shipyard construction module bitmasks ──────────────────────────────── */
#define MODULE_HULL_LEFT   (1u << 0)
#define MODULE_HULL_RIGHT  (1u << 1)
#define MODULE_DECK        (1u << 2)
#define MODULE_MAST        (1u << 3)
#define MODULE_CANNON_PORT (1u << 4)
#define MODULE_CANNON_STBD (1u << 5)
/** All three required modules to allow launch */
#define MODULES_REQUIRED   (MODULE_HULL_LEFT | MODULE_HULL_RIGHT | MODULE_DECK)

// Maximum entity counts
#define MAX_SHIPS 50
#define MAX_PLAYERS 100
#define MAX_PROJECTILES 500

// Spatial hash configuration
#define SPATIAL_HASH_SIZE 64                    // 64x64 grid
#define MAX_ENTITIES_PER_CELL 16               // Max entities per cell

// Simulation constants
#define TICK_RATE_HZ 30
#define TICK_DURATION_MS (1000 / TICK_RATE_HZ)
#define FIXED_DT_Q16 Q16_FROM_FLOAT(1.0f / TICK_RATE_HZ)  // Fixed timestep in Q16.16

// Entity ID type
typedef uint16_t entity_id;
#define INVALID_ENTITY_ID 0

// Physics configuration
#define GRAVITY_Q16 Q16_FROM_FLOAT(-9.81f)  // m/s²
#define WATER_DENSITY_Q16 Q16_FROM_FLOAT(1000.0f)  // kg/m³
#define AIR_DENSITY_Q16 Q16_FROM_FLOAT(1.225f)     // kg/m³

// ── Multi-deck support ──
#define MAX_DECKS_PER_SHIP       2
#define MAX_SNAP_POINTS_PER_DECK 3
#define MAX_DECK_COLLISION_VERTS 8   // max polygon vertices per deck (brigantine uses 6)

/* Deck geometry uses client-pixel floats (same coordinate space as SimpleShip/WebSocketPlayer).
 * collision_px[v][0]=x, collision_px[v][1]=y, in client pixels relative to ship centre.
 * snap_points x/y are also client pixels. */
typedef struct {
    uint8_t id;       // 0 = lower, 1 = upper
    uint8_t z_index;  // render order (lower z drawn first)
    float   collision_px[MAX_DECK_COLLISION_VERTS][2]; // polygon vertices (client px)
    uint8_t collision_count;
    struct {
        float   x, y;  // client pixels relative to ship centre
        uint8_t type;  // 0 = ladder, 1 = ramp (future)
        uint8_t _pad;
    } snap_points[MAX_SNAP_POINTS_PER_DECK];
    uint8_t snap_point_count;
} ShipDeck;

struct Ship {
    entity_id id;
    Vec2Q16 position;        // World position (m)
    Vec2Q16 velocity;        // Linear velocity (m/s)
    q16_t rotation;          // Rotation angle (radians)
    q16_t angular_velocity;  // Angular velocity (rad/s)
    q16_t mass;             // Ship mass (kg)
    q16_t moment_inertia;   // Rotational inertia (kg⋅m²)

    Vec2Q16 net_force;   // Accumulated force this tick (N)
    q16_t   net_torque;  // Accumulated torque this tick (N⋅m)

    q16_t hull_health;      // Hull integrity

    // Multi-deck support
    ShipDeck decks[MAX_DECKS_PER_SHIP];
    uint8_t deck_count;

    // Hull collision shape (legacy, for compatibility)
    Vec2Q16 hull_vertices[64];
    uint8_t hull_vertex_count;
    q16_t bounding_radius;

    // Ship modules (cannons, masts, seats, etc.)
    ShipModule modules[MAX_MODULES_PER_SHIP];
    uint8_t module_count;

    // Ship control state
    uint8_t desired_sail_openness;
    float rudder_angle;
    float target_rudder_angle;

    // Ship state flags
    uint16_t flags;
    uint8_t reserved[1];

    // Sinking mechanics
    uint8_t initial_plank_count;
    uint8_t company_id;
    uint8_t has_crew;

    /* Ship progression — levelled attributes and XP pool. */
    ShipLevelStats level_stats;
};

// Player state  
struct Player {
    entity_id id;
    entity_id ship_id;       // Current ship (0 = in water)
    Vec2Q16 position;        // World position
    Vec2Q16 velocity;        // Velocity
    Vec2Q16 relative_pos;    // Position relative to ship (when aboard)
    uint8_t deck_index;      // Which deck the player is on (0 = lower, 1 = upper)
    q16_t radius;           // Collision radius
    q16_t health;           // Player health
    
    // Player state
    uint32_t action_flags;   // Current action bitfield (see PLAYER_ACTION_*)
    uint16_t flags;          // Status flags (see PLAYER_FLAG_*)
    uint8_t reserved[1];
};

/* Projectile ammo types
 * Cannon ammo: 0-9   — used when player fires from helm/cannon
 * Swivel ammo: 10-19 — used when player/NPC fires from swivel
 * IDs are intentionally non-overlapping so the server can distinguish
 * weapon category from ammo_type alone without needing extra context. */
#define PROJ_TYPE_CANNONBALL    0
#define PROJ_TYPE_BAR_SHOT      1
#define PROJ_TYPE_GRAPESHOT     10  // Swivel: spread pellets, anti-personnel
#define PROJ_TYPE_LIQUID_FLAME  11  // Swivel: incendiary, area denial
#define PROJ_TYPE_CANISTER_SHOT 12  // Swivel: wide spread canister pellets

// Projectile state (cannonballs, etc)  
struct Projectile {
    entity_id id;
    entity_id owner_id;      // Who fired this
    Vec2Q16 position;
    Vec2Q16 prev_position;   // Position last tick — used for swept hull-edge intersection
    Vec2Q16 velocity;
    q16_t damage;           // Damage amount
    q16_t lifetime;         // Remaining lifetime in seconds
    uint32_t spawn_time;    // Server tick when created
    uint32_t effective_age_ms; // Accumulated age: 1ms/ms at sea, 2ms/ms over land
    uint16_t flags;         // Projectile flags
    uint8_t type;           // Cannonball, grapeshot, etc
    uint8_t firing_company; // Company owning this projectile (0=unset; skip if == target ship company)
    uint16_t last_hit_module_id; // Bar shot: ID of the last mast hit — skip it until the proj moves away
    uint8_t  ticks_inside;       // How many consecutive ticks ball has been inside a hull with no module hit
    entity_id inside_ship_id;   // 0 = not inside any hull; set when ball passes through a breach
    entity_id firing_ship_id;   // Ship that fired this projectile (for XP award on hit)
};

// Input command from client
struct InputCmd {
    entity_id player_id;
    uint16_t sequence;
    uint32_t client_time;
    int16_t thrust;         // Q0.15 format
    int16_t turn;           // Q0.15 format  
    uint16_t actions;       // Bitfield
    uint16_t dt_ms;         // Client frame time echo
};

// Forward declarations
struct SpatialCell;

// Spatial hash cell for collision detection
struct SpatialCell {
    struct Ship* ships[MAX_ENTITIES_PER_CELL];
    struct Player* players[MAX_ENTITIES_PER_CELL];
    struct Projectile* projectiles[MAX_ENTITIES_PER_CELL];
    uint8_t ship_count;
    uint8_t player_count;
    uint8_t projectile_count;
    uint8_t reserved;
};

// Hit event emitted when a cannonball damages a plank or breaches to hit a module
#define MAX_HIT_EVENTS 64
struct HitEvent {
    entity_id ship_id;
    uint16_t  module_id;   // ID of the module hit (0 for SHIP_SINK)
    bool      is_breach;   // false = plank hit / sink; true = interior module hit through breach
    bool      is_sink;     // true = ship hull_health reached 0
    bool      destroyed;        // true = module was destroyed by this hit
    float     damage_dealt;     // how much damage this hit dealt (in HP units)
    float     hit_x;
    float     hit_y;
    entity_id shooter_ship_id;  // Ship that fired the projectile (for XP award)
};

/* ── Contact cache for warm-starting collision solvers ─────────────────────
 *
 * Stores the accumulated normal impulse (P_n) from the previous tick for each
 * actively-colliding entity pair.  At the start of the next tick's solve the
 * cached impulse is applied as a warm-start guess so the solver converges
 * faster and produces less jitter at rest.
 *
 * Keyed by an order-independent pair of entity IDs:
 *   key = (min(a,b) << 16) | max(a,b)
 *
 * Entries are aged out after MAX_CONTACT_AGE ticks with no collision.       */

#define CONTACT_CACHE_SIZE 256   /* power-of-two; open-addressing hash map */
#define MAX_CONTACT_AGE    3     /* ticks without collision before eviction */
#define MAX_CONTACT_POINTS 4     /* max cached contact points per pair     */

struct ContactEntry {
    uint32_t key;                               /* 0 = empty slot              */
    uint32_t last_tick;                         /* sim->tick of last update    */
    float    P_n[MAX_CONTACT_POINTS];           /* accumulated normal impulse  */
    float    P_f[MAX_CONTACT_POINTS];           /* accumulated friction impulse*/
    float    cx[MAX_CONTACT_POINTS];            /* contact point x (world)     */
    float    cy[MAX_CONTACT_POINTS];            /* contact point y (world)     */
    uint8_t  n_contacts;                        /* how many contacts last tick */
};

struct ContactCache {
    struct ContactEntry entries[CONTACT_CACHE_SIZE];
};

// Complete simulation state
struct Sim {
    uint32_t tick;               // Current simulation tick
    uint32_t time_ms;           // Simulation time in milliseconds
    struct RNGState rng;         // Deterministic RNG state
    
    // Entities (SoA layout for cache efficiency)
    struct Ship ships[MAX_SHIPS];
    struct Player players[MAX_PLAYERS];  
    struct Projectile projectiles[MAX_PROJECTILES];
    
    // Entity counts
    uint16_t ship_count;
    uint16_t player_count;
    uint16_t projectile_count;
    
    // Spatial acceleration structures
    struct SpatialCell spatial_hash[SPATIAL_HASH_SIZE * SPATIAL_HASH_SIZE];
    
    // Physics constants (tunable per simulation instance)
    q16_t water_friction;
    q16_t air_friction;
    q16_t buoyancy_factor;
    
    // Global wind state (affects all ships)
    float wind_power;           // Wind strength (0.0 to 1.0, where 1.0 = full wind)
    float wind_direction;       // Wind direction in radians (for future use)

    // Hit events produced this tick; drained by websocket layer for broadcast
    struct HitEvent hit_events[MAX_HIT_EVENTS];
    uint8_t         hit_event_count;

    // Contact cache for warm-starting collision solvers
    struct ContactCache contact_cache;
};

// Simulation configuration
struct SimConfig {
    uint32_t random_seed;
    q16_t gravity;
    q16_t water_friction;
    q16_t air_friction;
    q16_t buoyancy_factor;
};

// Action bit flags for players
#define PLAYER_ACTION_JUMP         (1 << 0)
#define PLAYER_ACTION_INTERACT     (1 << 1)  
#define PLAYER_ACTION_FIRE_CANNON  (1 << 2)
#define PLAYER_ACTION_GRAPPLE      (1 << 3)
#define PLAYER_ACTION_MELEE        (1 << 4)
#define PLAYER_ACTION_RELOAD       (1 << 5)
#define PLAYER_ACTION_BOARD        (1 << 6)  // Attempt to board a ship
#define PLAYER_ACTION_LEAVE        (1 << 7)  // Leave current ship

// Ship flags
#define SHIP_FLAG_SINKING    (1 << 0)
#define SHIP_FLAG_BURNING    (1 << 1)
#define SHIP_FLAG_SCAFFOLDED (1 << 2)  // Attached to shipyard — immune to plank-drain sinking

// Player flags  
#define PLAYER_FLAG_IN_WATER    (1 << 0)
#define PLAYER_FLAG_CLIMBING    (1 << 1)
#define PLAYER_FLAG_DEAD        (1 << 2)

#endif /* SIM_TYPES_H */