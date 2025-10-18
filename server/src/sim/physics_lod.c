/**
 * Physics LOD (Level of Detail) System Implementation
 * Distance-based physics quality optimization
 */

#include "sim/physics_lod.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <math.h>
#include <stdio.h>

// Helper: Calculate distance squared between two points
static inline float distance_squared(float x1, float y1, float x2, float y2) {
    float dx = x2 - x1;
    float dy = y2 - y1;
    return dx * dx + dy * dy;
}

// Helper: Find entity LOD state by ID
static physics_lod_state_t* find_entity_state(physics_lod_manager_t* manager, uint32_t entity_id) {
    for (uint32_t i = 0; i < manager->entity_count; i++) {
        if (manager->entities[i].entity_id == entity_id) {
            return &manager->entities[i];
        }
    }
    return NULL;
}

/**
 * Initialize physics LOD system with default configurations
 */
void physics_lod_init(physics_lod_manager_t* manager) {
    memset(manager, 0, sizeof(physics_lod_manager_t));
    manager->enable_lod = true;
    
    // Configure FULL LOD tier (< 50m)
    manager->configs[PHYSICS_LOD_FULL] = (physics_lod_config_t){
        .tier = PHYSICS_LOD_FULL,
        .distance_threshold_m = 50.0f,
        .velocity_iterations = 8,
        .position_iterations = 2,
        .enable_ccd = true,
        .enable_constraints = true,
        .enable_buoyancy = true,
        .buoyancy_samples = 4,
        .update_hz = 30.0f,
        .auto_sleep_enabled = false,
        .sleep_threshold_velocity = 0.0f
    };
    
    // Configure MEDIUM LOD tier (50-150m)
    manager->configs[PHYSICS_LOD_MEDIUM] = (physics_lod_config_t){
        .tier = PHYSICS_LOD_MEDIUM,
        .distance_threshold_m = 150.0f,
        .velocity_iterations = 4,
        .position_iterations = 1,
        .enable_ccd = false,
        .enable_constraints = true,
        .enable_buoyancy = true,
        .buoyancy_samples = 2,
        .update_hz = 30.0f,
        .auto_sleep_enabled = true,
        .sleep_threshold_velocity = 0.1f
    };
    
    // Configure LOW LOD tier (150-300m)
    manager->configs[PHYSICS_LOD_LOW] = (physics_lod_config_t){
        .tier = PHYSICS_LOD_LOW,
        .distance_threshold_m = 300.0f,
        .velocity_iterations = 2,
        .position_iterations = 0,
        .enable_ccd = false,
        .enable_constraints = false,
        .enable_buoyancy = true,
        .buoyancy_samples = 1,
        .update_hz = 10.0f,  // Only update every 3rd frame
        .auto_sleep_enabled = true,
        .sleep_threshold_velocity = 0.05f
    };
    
    // Configure MINIMAL LOD tier (> 300m)
    manager->configs[PHYSICS_LOD_MINIMAL] = (physics_lod_config_t){
        .tier = PHYSICS_LOD_MINIMAL,
        .distance_threshold_m = INFINITY,
        .velocity_iterations = 0,
        .position_iterations = 0,
        .enable_ccd = false,
        .enable_constraints = false,
        .enable_buoyancy = false,
        .buoyancy_samples = 0,
        .update_hz = 1.0f,  // Only update once per second
        .auto_sleep_enabled = true,
        .sleep_threshold_velocity = 0.01f
    };
    
    log_info("🎯 Physics LOD system initialized");
    log_info("  FULL:    < 50m   (8 vel iters, 2 pos iters, CCD, 4-sample buoyancy)");
    log_info("  MEDIUM:  < 150m  (4 vel iters, 1 pos iter, 2-sample buoyancy)");
    log_info("  LOW:     < 300m  (2 vel iters, 10Hz update, 1-sample buoyancy)");
    log_info("  MINIMAL: > 300m  (1Hz update, no physics)");
}

/**
 * Register an entity for LOD management
 */
void physics_lod_register_entity(physics_lod_manager_t* manager, uint32_t entity_id) {
    if (manager->entity_count >= MAX_LOD_ENTITIES) {
        log_warn("⚠️  Cannot register entity %u: LOD entity limit reached", entity_id);
        return;
    }
    
    // Check if already registered
    if (find_entity_state(manager, entity_id) != NULL) {
        return;
    }
    
    physics_lod_state_t* state = &manager->entities[manager->entity_count++];
    memset(state, 0, sizeof(physics_lod_state_t));
    
    state->entity_id = entity_id;
    state->current_tier = PHYSICS_LOD_FULL;  // Start at full quality
    state->target_tier = PHYSICS_LOD_FULL;
    state->nearest_observer_distance_m = 0.0f;
    state->last_update_time = get_time_ms();
    
    manager->tier_counts[PHYSICS_LOD_FULL]++;
    
    log_debug("📋 Entity %u registered for physics LOD (FULL tier)", entity_id);
}

/**
 * Unregister an entity from LOD management
 */
void physics_lod_unregister_entity(physics_lod_manager_t* manager, uint32_t entity_id) {
    for (uint32_t i = 0; i < manager->entity_count; i++) {
        if (manager->entities[i].entity_id == entity_id) {
            // Update tier counts
            manager->tier_counts[manager->entities[i].current_tier]--;
            if (manager->entities[i].is_sleeping) {
                manager->sleeping_entities--;
            }
            
            // Remove by swapping with last element
            manager->entities[i] = manager->entities[manager->entity_count - 1];
            manager->entity_count--;
            
            log_debug("📋 Entity %u unregistered from physics LOD", entity_id);
            return;
        }
    }
}

/**
 * Determine LOD tier based on distance
 */
static physics_lod_tier_t determine_tier_from_distance(const physics_lod_manager_t* manager, 
                                                       float distance_m) {
    if (distance_m < manager->configs[PHYSICS_LOD_FULL].distance_threshold_m) {
        return PHYSICS_LOD_FULL;
    } else if (distance_m < manager->configs[PHYSICS_LOD_MEDIUM].distance_threshold_m) {
        return PHYSICS_LOD_MEDIUM;
    } else if (distance_m < manager->configs[PHYSICS_LOD_LOW].distance_threshold_m) {
        return PHYSICS_LOD_LOW;
    } else {
        return PHYSICS_LOD_MINIMAL;
    }
}

/**
 * Update LOD tiers based on observer distances
 */
void physics_lod_update_tiers(physics_lod_manager_t* manager,
                              const float* entity_positions_x,
                              const float* entity_positions_y,
                              const float* observer_positions_x,
                              const float* observer_positions_y,
                              uint32_t observer_count) {
    if (!manager->enable_lod) return;
    
    // Reset tier counts
    memset(manager->tier_counts, 0, sizeof(manager->tier_counts));
    manager->sleeping_entities = 0;
    
    // Update each entity's LOD tier
    for (uint32_t i = 0; i < manager->entity_count; i++) {
        physics_lod_state_t* state = &manager->entities[i];
        uint32_t entity_id = state->entity_id;
        
        // Skip if entity ID is out of bounds (safety check)
        if (entity_id >= MAX_LOD_ENTITIES) continue;
        
        float entity_x = entity_positions_x[entity_id];
        float entity_y = entity_positions_y[entity_id];
        
        // Find nearest observer
        float min_distance_sq = INFINITY;
        state->observer_count = 0;
        
        for (uint32_t j = 0; j < observer_count; j++) {
            float dist_sq = distance_squared(entity_x, entity_y,
                                            observer_positions_x[j],
                                            observer_positions_y[j]);
            
            if (dist_sq < min_distance_sq) {
                min_distance_sq = dist_sq;
            }
            
            // Count observers within 500m
            if (dist_sq < (500.0f * 500.0f)) {
                state->observer_count++;
            }
        }
        
        state->nearest_observer_distance_m = sqrtf(min_distance_sq);
        
        // Determine target tier (override if force_full_lod is set)
        if (state->force_full_lod) {
            state->target_tier = PHYSICS_LOD_FULL;
        } else {
            state->target_tier = determine_tier_from_distance(manager, 
                                                             state->nearest_observer_distance_m);
        }
        
        // Transition to target tier (immediate for now, could add hysteresis)
        if (state->current_tier != state->target_tier) {
            log_debug("🎯 Entity %u LOD transition: %d → %d (distance: %.1fm)",
                     entity_id, state->current_tier, state->target_tier,
                     state->nearest_observer_distance_m);
            
            state->current_tier = state->target_tier;
            manager->tier_transitions++;
        }
        
        // Update tier counts
        manager->tier_counts[state->current_tier]++;
        
        if (state->is_sleeping) {
            manager->sleeping_entities++;
        }
    }
    
    // Calculate computational savings
    // Baseline: all entities at FULL (8 iterations)
    float baseline_iterations = manager->entity_count * 8.0f;
    float actual_iterations = 0.0f;
    
    actual_iterations += manager->tier_counts[PHYSICS_LOD_FULL] * 8.0f;
    actual_iterations += manager->tier_counts[PHYSICS_LOD_MEDIUM] * 4.0f;
    actual_iterations += manager->tier_counts[PHYSICS_LOD_LOW] * 2.0f;
    actual_iterations += manager->tier_counts[PHYSICS_LOD_MINIMAL] * 0.0f;
    
    manager->saved_iterations = baseline_iterations - actual_iterations;
    
    if (baseline_iterations > 0.0f) {
        manager->computational_savings_percent = 
            (manager->saved_iterations / baseline_iterations) * 100.0f;
    }
}

/**
 * Get LOD configuration for an entity
 */
const physics_lod_config_t* physics_lod_get_config(const physics_lod_manager_t* manager,
                                                   uint32_t entity_id) {
    const physics_lod_state_t* state = find_entity_state((physics_lod_manager_t*)manager, entity_id);
    if (state == NULL) {
        return &manager->configs[PHYSICS_LOD_FULL]; // Default to full quality
    }
    
    return &manager->configs[state->current_tier];
}

/**
 * Check if entity should be simulated this frame
 */
bool physics_lod_should_simulate(physics_lod_manager_t* manager,
                                 uint32_t entity_id,
                                 uint64_t current_time) {
    physics_lod_state_t* state = find_entity_state(manager, entity_id);
    if (state == NULL) return true;  // Simulate if not registered
    
    // Always simulate FULL and MEDIUM tier
    if (state->current_tier <= PHYSICS_LOD_MEDIUM) {
        state->last_update_time = current_time;
        return true;
    }
    
    // For LOW and MINIMAL, check update rate
    const physics_lod_config_t* config = &manager->configs[state->current_tier];
    uint64_t update_interval_ms = (uint64_t)(1000.0f / config->update_hz);
    uint64_t time_since_update = current_time - state->last_update_time;
    
    if (time_since_update >= update_interval_ms) {
        state->last_update_time = current_time;
        return true;
    }
    
    state->updates_skipped++;
    return false;
}

/**
 * Force an entity to full LOD
 */
void physics_lod_force_full(physics_lod_manager_t* manager, uint32_t entity_id, bool force) {
    physics_lod_state_t* state = find_entity_state(manager, entity_id);
    if (state == NULL) return;
    
    state->force_full_lod = force;
    
    if (force) {
        log_debug("🎯 Entity %u forced to FULL LOD", entity_id);
    }
}

/**
 * Mark entity as sleeping
 */
void physics_lod_set_sleeping(physics_lod_manager_t* manager, uint32_t entity_id, bool sleeping) {
    physics_lod_state_t* state = find_entity_state(manager, entity_id);
    if (state == NULL) return;
    
    if (state->is_sleeping != sleeping) {
        state->is_sleeping = sleeping;
        
        if (sleeping) {
            log_debug("💤 Entity %u is now sleeping", entity_id);
        } else {
            log_debug("⏰ Entity %u woke up", entity_id);
            state->ticks_since_active = 0;
        }
    }
    
    if (!sleeping) {
        state->ticks_since_active = 0;
    }
}

/**
 * Get LOD statistics
 */
void physics_lod_get_stats(const physics_lod_manager_t* manager,
                          uint32_t tier_counts[PHYSICS_LOD_COUNT],
                          uint32_t* sleeping_count,
                          float* savings_percent) {
    memcpy(tier_counts, manager->tier_counts, sizeof(manager->tier_counts));
    *sleeping_count = manager->sleeping_entities;
    *savings_percent = manager->computational_savings_percent;
}

/**
 * Export LOD stats as JSON
 */
int physics_lod_export_json(const physics_lod_manager_t* manager, char* buffer, size_t buffer_size) {
    int len = snprintf(buffer, buffer_size,
        "{\n"
        "  \"enabled\": %s,\n"
        "  \"total_entities\": %u,\n"
        "  \"tier_distribution\": {\n"
        "    \"FULL\": %u,\n"
        "    \"MEDIUM\": %u,\n"
        "    \"LOW\": %u,\n"
        "    \"MINIMAL\": %u\n"
        "  },\n"
        "  \"sleeping_entities\": %u,\n"
        "  \"performance\": {\n"
        "    \"computational_savings_percent\": %.1f,\n"
        "    \"saved_iterations\": %.0f,\n"
        "    \"tier_transitions\": %u\n"
        "  },\n"
        "  \"tier_configs\": {\n"
        "    \"FULL\": {\"distance_m\": %.0f, \"vel_iters\": %u, \"pos_iters\": %u, \"ccd\": %s},\n"
        "    \"MEDIUM\": {\"distance_m\": %.0f, \"vel_iters\": %u, \"pos_iters\": %u, \"ccd\": %s},\n"
        "    \"LOW\": {\"distance_m\": %.0f, \"vel_iters\": %u, \"update_hz\": %.0f},\n"
        "    \"MINIMAL\": {\"vel_iters\": %u, \"update_hz\": %.0f}\n"
        "  }\n"
        "}",
        manager->enable_lod ? "true" : "false",
        manager->entity_count,
        manager->tier_counts[PHYSICS_LOD_FULL],
        manager->tier_counts[PHYSICS_LOD_MEDIUM],
        manager->tier_counts[PHYSICS_LOD_LOW],
        manager->tier_counts[PHYSICS_LOD_MINIMAL],
        manager->sleeping_entities,
        manager->computational_savings_percent,
        manager->saved_iterations,
        manager->tier_transitions,
        manager->configs[PHYSICS_LOD_FULL].distance_threshold_m,
        manager->configs[PHYSICS_LOD_FULL].velocity_iterations,
        manager->configs[PHYSICS_LOD_FULL].position_iterations,
        manager->configs[PHYSICS_LOD_FULL].enable_ccd ? "true" : "false",
        manager->configs[PHYSICS_LOD_MEDIUM].distance_threshold_m,
        manager->configs[PHYSICS_LOD_MEDIUM].velocity_iterations,
        manager->configs[PHYSICS_LOD_MEDIUM].position_iterations,
        manager->configs[PHYSICS_LOD_MEDIUM].enable_ccd ? "true" : "false",
        manager->configs[PHYSICS_LOD_LOW].distance_threshold_m,
        manager->configs[PHYSICS_LOD_LOW].velocity_iterations,
        manager->configs[PHYSICS_LOD_LOW].update_hz,
        manager->configs[PHYSICS_LOD_MINIMAL].velocity_iterations,
        manager->configs[PHYSICS_LOD_MINIMAL].update_hz
    );
    
    return (len >= (int)buffer_size) ? -1 : 0;
}
