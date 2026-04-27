#ifndef SIM_MODULE_TYPES_H
#define SIM_MODULE_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"

/** Cannon reload time: shared by all sources so every cannon reloads identically. */
#define CANNON_RELOAD_TIME_MS 3000

/** Swivel gun reload time: faster than cannon, anti-personnel weapon. */
#define SWIVEL_RELOAD_TIME_MS   1200
#define SWIVEL_FLAME_INTERVAL_MS  200  /* Liquid flame stream: ms between shots */

/**
 * Module Type IDs - matches client ModuleTypeId enum
 * These are used for efficient network serialization
 */
typedef enum {
    MODULE_TYPE_HELM = 0,           // Steering wheel
    MODULE_TYPE_SEAT = 1,           // Crew seating
    MODULE_TYPE_CANNON = 2,         // Offensive weapon
    MODULE_TYPE_MAST = 3,           // Sail system
    MODULE_TYPE_STEERING_WHEEL = 4, // Alternative helm
    MODULE_TYPE_LADDER = 5,         // Boarding ladder
    MODULE_TYPE_PLANK = 6,          // Hull segment
    MODULE_TYPE_DECK = 7,           // Floor surface
    MODULE_TYPE_SWIVEL = 8,         // Swivel gun — fast, low-damage, anti-personnel
    MODULE_TYPE_CUSTOM = 255        // User-defined
} ModuleTypeId;

/**
 * Module state bits for compact state transmission
 */
typedef enum {
    MODULE_STATE_ACTIVE = (1 << 0),      // Module is active/functional
    MODULE_STATE_DAMAGED = (1 << 1),     // Module has taken damage
    MODULE_STATE_DESTROYED = (1 << 2),   // Module is destroyed
    MODULE_STATE_FIRING = (1 << 3),      // Cannon is firing
    MODULE_STATE_RELOADING = (1 << 4),   // Cannon is reloading
    MODULE_STATE_OCCUPIED = (1 << 5),    // Seat/helm is occupied
    MODULE_STATE_DEPLOYED = (1 << 6),    // Sail/ladder is deployed
    MODULE_STATE_LOCKED = (1 << 7),      // Module is locked/unusable
    MODULE_STATE_REPAIRING = (1 << 8),   // Repair has been initiated (enables passive regen)
    /** Cannon needs a gunner: player is aiming at it but no crew is stationed.
     *  Set by handle_cannon_aim() on the SimpleShip module; cleared when an NPC
     *  arrives at AT_GUN.  NPCs treat NEEDED cannons as their top-priority
     *  destination regardless of weapon-group membership. */
    MODULE_STATE_NEEDED = (1 << 9),
    /** Set by toggle_ladder: ladder is pulled up and cannot be climbed. */
    MODULE_STATE_RETRACTED = (1 << 10),
    /** Deck fire zones (bits 11-13): each bit marks one third of the deck as burning.
     *  Zone 0 = bow (+160 client), Zone 1 = mid (0), Zone 2 = stern (-160 client).
     *  Set by the flame-wave loop; cleared when the deck fire extinguishes. */
    MODULE_STATE_DECK_ZONE0 = (1 << 11),
    MODULE_STATE_DECK_ZONE1 = (1 << 12),
    MODULE_STATE_DECK_ZONE2 = (1 << 13)
} ModuleStateBits;

/**
 * Cannon-specific module data
 */
typedef struct {
    q16_t aim_direction;         // Current angle the cannon is rotated to
    q16_t desired_aim_direction; // Target angle — actual rotates toward this each tick
    uint8_t ammunition;         // Remaining ammunition
    uint32_t time_since_fire;   // Time since last fire (ms)
    uint32_t reload_time;       // Time required to reload (ms)
} CannonModuleData;

/**
 * Mast/Sail-specific module data
 */
typedef struct {
    q16_t angle;                // Sail rotation angle
    uint8_t openness;           // Sail deployment percentage (0-100)
    q16_t wind_efficiency;      // Current wind capture efficiency (derived from fiber_health)
    q16_t fiber_health;         // Sail cloth HP — same base as mast pole (15000)
    q16_t fiber_max_health;     // Sail cloth max HP
    uint8_t sail_fire_intensity; // 0-100: fiber fire intensity (0=not burning, 100=fully engulfed)
} MastModuleData;

/**
 * Helm-specific module data
 */
typedef struct {
    q16_t wheel_rotation;       // Visual wheel rotation
    uint16_t occupied_by;       // Player entity ID (0 if empty)
} HelmModuleData;

/**
 * Seat-specific module data
 */
typedef struct {
    uint16_t occupied_by;       // Player entity ID (0 if empty)
} SeatModuleData;

/**
 * Plank-specific module data
 */
typedef struct {
    // Health is tracked at the ShipModule level (module.health / module.max_health)
} PlankModuleData;

/**
 * Swivel gun — fast, low-damage, anti-personnel weapon mounted at ship edges.
 */
typedef struct {
    q16_t aim_direction;         // Current aim direction (ship-relative, radians)
    q16_t desired_aim_direction; // Target aim direction
    uint32_t time_since_fire;    // Time since last fire (ms)
    uint32_t reload_time;        // Reload time (ms) — defaults to SWIVEL_RELOAD_TIME_MS
    uint8_t  loaded_ammo;        // Currently loaded ammo type (0=cannonball, 1=grapeshot)
    uint8_t  _pad[3];            // Alignment padding
} SwivelModuleData;

/**
 * Generic ship module structure
 */
typedef struct {
    uint16_t id;                // Unique module ID
    ModuleTypeId type_id;       // Module type (for network)
    uint16_t deck_id;           // Which deck this module belongs to
    Vec2Q16 local_pos;          // Position relative to ship center
    q16_t local_rot;            // Rotation relative to ship
    uint16_t state_bits;        // Compact state flags
    q16_t health;               // Current HP (all module types)
    q16_t target_health;        // Repair ceiling (planks only) — decreases with damage;
                                //   player must spend wood to raise it back toward max_health
    q16_t max_health;           // Maximum HP:
                                //   plank: 10000, cannon: 8000
                                //   mast: 15000, helm: 10000
    
    // Type-specific data (union to save memory)
    union {
        CannonModuleData cannon;
        MastModuleData mast;
        HelmModuleData helm;
        SeatModuleData seat;
        PlankModuleData plank;
        SwivelModuleData swivel;
    } data;

    // Status effects (separate from type-specific data)
    uint32_t fire_timer_ms;  // >0 = burning; auto-extinguishes at 0
} ShipModule;

/**
 * Maximum number of modules per ship
 */
#define MAX_MODULES_PER_SHIP 64

/**
 * Module utility functions
 */

/**
 * Create a default module of specified type
 */
ShipModule module_create(uint16_t id, ModuleTypeId type, Vec2Q16 position, q16_t rotation);

/**
 * Update module state based on gameplay
 */
void module_update(ShipModule* module, q16_t dt);

/**
 * Check if a module is functional (not destroyed)
 */
bool module_is_functional(const ShipModule* module);

/**
 * Apply damage to a module
 */
void module_apply_damage(ShipModule* module, q16_t damage);

/**
 * Get module type name (for debugging)
 */
const char* module_type_name(ModuleTypeId type);

#endif // SIM_MODULE_TYPES_H
