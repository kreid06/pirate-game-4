#ifndef SIM_TYPES_H
#define SIM_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"
#include "core/rng.h"
#include "sim/module_types.h"

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

// Ship state
struct Ship {
    entity_id id;
    Vec2Q16 position;        // World position (m)
    Vec2Q16 velocity;        // Linear velocity (m/s)
    q16_t rotation;          // Rotation angle (radians)
    q16_t angular_velocity;  // Angular velocity (rad/s)
    q16_t mass;             // Ship mass (kg)
    q16_t moment_inertia;   // Rotational inertia (kg⋅m²)
    q16_t hull_health;      // Hull integrity
    
    // Hull collision shape (local coordinates)
    Vec2Q16 hull_vertices[64];  // Increased to support detailed brigantine hull (47 vertices)
    uint8_t hull_vertex_count;
    q16_t bounding_radius;   // For broad-phase collision
    
    // Ship modules (cannons, masts, seats, etc.)
    ShipModule modules[MAX_MODULES_PER_SHIP];
    uint8_t module_count;
    
    // Ship control state
    uint8_t desired_sail_openness;  // Target sail openness (0-100%)
    float rudder_angle;             // Current rudder angle in degrees (-50 to +50)
    float target_rudder_angle;      // Target rudder angle from player input (-50 to +50)
    
    // Ship state flags
    uint16_t flags;
    uint8_t reserved[1];
};

// Player state  
struct Player {
    entity_id id;
    entity_id ship_id;       // Current ship (0 = in water)
    Vec2Q16 position;        // World position
    Vec2Q16 velocity;        // Velocity
    Vec2Q16 relative_pos;    // Position relative to ship (when aboard)
    q16_t radius;           // Collision radius
    q16_t health;           // Player health
    
    // Player state
    uint32_t action_flags;   // Current action bitfield (see PLAYER_ACTION_*)
    uint16_t flags;          // Status flags (see PLAYER_FLAG_*)
    uint8_t reserved[2];
};

// Projectile state (cannonballs, etc)  
struct Projectile {
    entity_id id;
    entity_id owner_id;      // Who fired this
    Vec2Q16 position;
    Vec2Q16 velocity;
    q16_t damage;           // Damage amount
    q16_t lifetime;         // Remaining lifetime in seconds
    uint32_t spawn_time;    // Server tick when created
    uint16_t flags;         // Projectile flags
    uint8_t type;           // Cannonball, grapeshot, etc
    uint8_t reserved;
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
#define SHIP_FLAG_SINKING   (1 << 0)
#define SHIP_FLAG_BURNING   (1 << 1)

// Player flags  
#define PLAYER_FLAG_IN_WATER    (1 << 0)
#define PLAYER_FLAG_CLIMBING    (1 << 1)
#define PLAYER_FLAG_DEAD        (1 << 2)

#endif /* SIM_TYPES_H */