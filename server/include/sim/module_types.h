#ifndef SIM_MODULE_TYPES_H
#define SIM_MODULE_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"

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
    MODULE_STATE_LOCKED = (1 << 7)       // Module is locked/unusable
} ModuleStateBits;

/**
 * Cannon-specific module data
 */
typedef struct {
    q16_t aim_direction;        // Angle the cannon is aimed at
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
    q16_t wind_efficiency;      // Current wind capture efficiency
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
    q16_t health;               // Plank structural health
    q16_t max_health;           // Maximum health
} PlankModuleData;

/**
 * Generic ship module structure
 */
typedef struct {
    uint16_t id;                // Unique module ID
    ModuleTypeId type_id;       // Module type (for network)
    uint16_t deck_id;           // Which deck this module belongs to
    Vec2Q16 local_pos;          // Position relative to ship center
    q16_t local_rot;            // Rotation relative to ship
    uint8_t state_bits;         // Compact state flags
    
    // Type-specific data (union to save memory)
    union {
        CannonModuleData cannon;
        MastModuleData mast;
        HelmModuleData helm;
        SeatModuleData seat;
        PlankModuleData plank;
    } data;
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
