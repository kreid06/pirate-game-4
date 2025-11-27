#include "sim/module_types.h"
#include "util/log.h"
#include <string.h>

/**
 * Create a default module of specified type
 */
ShipModule module_create(uint16_t id, ModuleTypeId type, Vec2Q16 position, q16_t rotation) {
    ShipModule module;
    memset(&module, 0, sizeof(ShipModule));
    
    module.id = id;
    module.type_id = type;
    module.deck_id = 0;
    module.local_pos = position;
    module.local_rot = rotation;
    module.state_bits = MODULE_STATE_ACTIVE;
    
    // Initialize type-specific defaults
    switch (type) {
        case MODULE_TYPE_CANNON:
            module.data.cannon.aim_direction = 0;
            module.data.cannon.ammunition = 10;
            module.data.cannon.time_since_fire = 0;
            module.data.cannon.reload_time = 5000; // 5 seconds in milliseconds
            break;
            
        case MODULE_TYPE_MAST:
            module.data.mast.angle = 0;
            module.data.mast.openness = 0; // Sails start closed
            module.data.mast.wind_efficiency = Q16_ONE;
            break;
            
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL:
            module.data.helm.wheel_rotation = 0;
            module.data.helm.occupied_by = 0;
            break;
            
        case MODULE_TYPE_SEAT:
            module.data.seat.occupied_by = 0;
            break;
            
        case MODULE_TYPE_PLANK:
            module.data.plank.health = Q16_FROM_INT(100);
            module.data.plank.max_health = Q16_FROM_INT(100);
            break;
            
        case MODULE_TYPE_DECK:
        case MODULE_TYPE_LADDER:
        case MODULE_TYPE_CUSTOM:
        default:
            // No special initialization needed
            break;
    }
    
    return module;
}

/**
 * Update module state based on gameplay
 */
void module_update(ShipModule* module, q16_t dt) {
    if (!module || !module_is_functional(module)) return;
    
    switch (module->type_id) {
        case MODULE_TYPE_CANNON:
            // Update reload timer
            if (module->state_bits & MODULE_STATE_RELOADING) {
                module->data.cannon.time_since_fire += Q16_TO_INT(q16_mul(dt, Q16_FROM_INT(1000)));
                
                // Check if reload complete (both values are in milliseconds)
                if (module->data.cannon.time_since_fire >= module->data.cannon.reload_time) {
                    module->state_bits &= ~MODULE_STATE_RELOADING;
                    module->state_bits &= ~MODULE_STATE_FIRING;
                }
            }
            break;
            
        case MODULE_TYPE_MAST:
            // Mast updates could include wind calculations, sail animations, etc.
            break;
            
        default:
            break;
    }
}

/**
 * Check if a module is functional (not destroyed)
 */
bool module_is_functional(const ShipModule* module) {
    if (!module) return false;
    
    // Check if destroyed
    if (module->state_bits & MODULE_STATE_DESTROYED) {
        return false;
    }
    
    // Check plank health
    if (module->type_id == MODULE_TYPE_PLANK) {
        return module->data.plank.health > 0;
    }
    
    return true;
}

/**
 * Apply damage to a module
 */
void module_apply_damage(ShipModule* module, q16_t damage) {
    if (!module) return;
    
    // Mark as damaged
    module->state_bits |= MODULE_STATE_DAMAGED;
    
    // Apply damage to plank health
    if (module->type_id == MODULE_TYPE_PLANK) {
        module->data.plank.health = q16_sub_sat(module->data.plank.health, damage);
        
        if (module->data.plank.health <= 0) {
            module->state_bits |= MODULE_STATE_DESTROYED;
            module->state_bits &= ~MODULE_STATE_ACTIVE;
            log_info("💥 Module %u (plank) destroyed!", module->id);
        }
    }
}

/**
 * Get module type name (for debugging)
 */
const char* module_type_name(ModuleTypeId type) {
    switch (type) {
        case MODULE_TYPE_HELM: return "helm";
        case MODULE_TYPE_SEAT: return "seat";
        case MODULE_TYPE_CANNON: return "cannon";
        case MODULE_TYPE_MAST: return "mast";
        case MODULE_TYPE_STEERING_WHEEL: return "steering_wheel";
        case MODULE_TYPE_LADDER: return "ladder";
        case MODULE_TYPE_PLANK: return "plank";
        case MODULE_TYPE_DECK: return "deck";
        case MODULE_TYPE_CUSTOM: return "custom";
        default: return "unknown";
    }
}
