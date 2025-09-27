#ifndef SIM_TYPES_H
#define SIM_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"
#include "core/rng.h"

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
    
    // Hull collision shape (local coordinates)
    Vec2Q16 hull_vertices[16];
    uint8_t hull_vertex_count;
    q16_t bounding_radius;   // For broad-phase collision
    
    // Ship state flags
    uint16_t flags;
    uint8_t health;
    uint8_t reserved;
};

// Player state  
struct Player {
    entity_id id;
    entity_id ship_id;       // Current ship (0 = in water)
    Vec2Q16 position;        // World position
    Vec2Q16 velocity;        // Velocity
    q16_t radius;           // Collision radius
    
    // Player state
    uint16_t actions;        // Current action bitfield
    uint8_t health;
    uint8_t flags;
};

// Projectile state (cannonballs, etc)  
struct Projectile {
    entity_id id;
    entity_id shooter_id;    // Who fired this
    Vec2Q16 position;
    Vec2Q16 velocity;
    q16_t radius;
    uint32_t spawn_time;     // Server tick when created
    uint16_t damage;
    uint8_t type;           // Cannonball, grapeshot, etc
    uint8_t flags;
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
    uint32_t spatial_hash[256]; // Simple spatial hash for broad-phase collision
    
    // Physics constants (tunable per simulation instance)
    q16_t water_friction;
    q16_t air_friction;
    q16_t buoyancy_factor;
};

// Simulation configuration
struct SimConfig {
    uint32_t random_seed;
    q16_t gravity;
    q16_t water_friction;
    q16_t air_friction;
    q16_t buoyancy_factor;
};

// Action bit flags
#define ACTION_JUMP         (1 << 0)
#define ACTION_INTERACT     (1 << 1)  
#define ACTION_FIRE_CANNON  (1 << 2)
#define ACTION_GRAPPLE      (1 << 3)
#define ACTION_MELEE        (1 << 4)
#define ACTION_RELOAD       (1 << 5)

// Ship flags
#define SHIP_FLAG_SINKING   (1 << 0)
#define SHIP_FLAG_BURNING   (1 << 1)

// Player flags  
#define PLAYER_FLAG_IN_WATER    (1 << 0)
#define PLAYER_FLAG_CLIMBING    (1 << 1)
#define PLAYER_FLAG_DEAD        (1 << 2)

#endif /* SIM_TYPES_H */