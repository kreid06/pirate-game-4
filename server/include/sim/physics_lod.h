/**
 * Physics LOD (Level of Detail) System
 * Distance-based physics quality optimization
 * 
 * Based on optimized_computations.md Section 6
 */

#ifndef PHYSICS_LOD_H
#define PHYSICS_LOD_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Physics LOD tiers based on distance and importance
typedef enum {
    PHYSICS_LOD_FULL,       // < 50m: Full simulation, CCD enabled, multi-sample buoyancy
    PHYSICS_LOD_MEDIUM,     // 50-150m: Simplified constraints, no CCD, basic buoyancy
    PHYSICS_LOD_LOW,        // 150-300m: Kinematic interpolation, no constraints
    PHYSICS_LOD_MINIMAL,    // > 300m: Position updates only, auto-sleep
    PHYSICS_LOD_COUNT
} physics_lod_tier_t;

// LOD configuration for each tier
typedef struct {
    physics_lod_tier_t tier;
    float distance_threshold_m;     // Distance from nearest observer
    
    // Solver settings
    uint32_t velocity_iterations;   // PGS velocity constraint iterations
    uint32_t position_iterations;   // Position correction iterations
    bool enable_ccd;                // Continuous collision detection
    
    // Physics features
    bool enable_constraints;        // Joints, ropes, etc.
    bool enable_buoyancy;          // Water physics
    uint32_t buoyancy_samples;     // Sample points for buoyancy (1-4)
    
    // Update rate
    float update_hz;                // Physics update frequency (can be < 30Hz)
    
    // Auto-sleep
    bool auto_sleep_enabled;       // Automatically sleep when idle
    float sleep_threshold_velocity; // Linear velocity threshold for sleep
} physics_lod_config_t;

// Per-entity LOD state
typedef struct {
    uint32_t entity_id;
    physics_lod_tier_t current_tier;
    physics_lod_tier_t target_tier;
    
    // Distance tracking
    float nearest_observer_distance_m;
    uint32_t observer_count;       // Number of players observing this entity
    
    // Update timing
    uint64_t last_update_time;
    uint32_t updates_skipped;      // For LOD_LOW/MINIMAL update rate control
    
    // State flags
    bool is_sleeping;
    bool force_full_lod;           // Override (e.g., in combat)
    uint32_t ticks_since_active;
} physics_lod_state_t;

// Main physics LOD manager
#define MAX_LOD_ENTITIES 1000

typedef struct {
    // Configuration
    physics_lod_config_t configs[PHYSICS_LOD_COUNT];
    bool enable_lod;
    
    // Entity states
    physics_lod_state_t entities[MAX_LOD_ENTITIES];
    uint32_t entity_count;
    
    // Statistics
    uint32_t tier_counts[PHYSICS_LOD_COUNT];
    uint32_t tier_transitions;
    uint32_t sleeping_entities;
    
    // Performance tracking
    float saved_iterations;        // Iterations saved by LOD
    float computational_savings_percent;
} physics_lod_manager_t;

/**
 * Initialize physics LOD system with default configurations
 */
void physics_lod_init(physics_lod_manager_t* manager);

/**
 * Register an entity for LOD management
 */
void physics_lod_register_entity(physics_lod_manager_t* manager, uint32_t entity_id);

/**
 * Unregister an entity from LOD management
 */
void physics_lod_unregister_entity(physics_lod_manager_t* manager, uint32_t entity_id);

/**
 * Update LOD tiers based on observer distances
 * Call this once per frame before physics update
 */
void physics_lod_update_tiers(physics_lod_manager_t* manager,
                              const float* entity_positions_x,
                              const float* entity_positions_y,
                              const float* observer_positions_x,
                              const float* observer_positions_y,
                              uint32_t observer_count);

/**
 * Get LOD configuration for an entity
 */
const physics_lod_config_t* physics_lod_get_config(const physics_lod_manager_t* manager,
                                                   uint32_t entity_id);

/**
 * Check if entity should be simulated this frame
 * Returns false if update can be skipped due to LOD
 */
bool physics_lod_should_simulate(physics_lod_manager_t* manager,
                                 uint32_t entity_id,
                                 uint64_t current_time);

/**
 * Force an entity to full LOD (e.g., combat, player control)
 */
void physics_lod_force_full(physics_lod_manager_t* manager, uint32_t entity_id, bool force);

/**
 * Mark entity as sleeping (no movement)
 */
void physics_lod_set_sleeping(physics_lod_manager_t* manager, uint32_t entity_id, bool sleeping);

/**
 * Get LOD statistics
 */
void physics_lod_get_stats(const physics_lod_manager_t* manager,
                          uint32_t tier_counts[PHYSICS_LOD_COUNT],
                          uint32_t* sleeping_count,
                          float* savings_percent);

/**
 * Export LOD stats as JSON
 */
int physics_lod_export_json(const physics_lod_manager_t* manager, char* buffer, size_t buffer_size);

#endif // PHYSICS_LOD_H
