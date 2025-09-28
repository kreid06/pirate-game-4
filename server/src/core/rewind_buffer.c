/**
 * Rewind Buffer Implementation - Server-Side Lag Compensation
 * Week 3-4: Hit validation and movement validation with 16-frame ring buffer
 */

#include "rewind_buffer.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <stdio.h>
#include <math.h>

// Static helper functions
static void copy_simulation_state_to_rewind(rewind_simulation_state_t* dest, const void* src);
static bool raycast_ship_hit(rewind_vec2_t ray_origin, rewind_vec2_t ray_direction, float ray_length,
                            const rewind_ship_t* ship, rewind_vec2_t* hit_point);
static float calculate_max_movement_distance(float delta_time, float max_speed);

/**
 * Initialize rewind buffer system
 */
void rewind_buffer_init(rewind_buffer_t* buffer) {
    memset(buffer, 0, sizeof(rewind_buffer_t));
    buffer->current_index = 0;
    buffer->valid_entries = 0;
    buffer->oldest_tick = 0;
    buffer->newest_tick = 0;
    
    // Mark all entries as invalid initially
    for (int i = 0; i < REWIND_BUFFER_SIZE; i++) {
        buffer->entries[i].valid = false;
    }
    
    printf("📼 Rewind buffer initialized (size: %d frames, max coverage: %dms)\n", 
           REWIND_BUFFER_SIZE, MAX_REWIND_TIME_MS);
}

/**
 * Store current simulation state in rewind buffer
 */
void rewind_buffer_store(rewind_buffer_t* buffer, uint32_t tick, 
                        const void* state,  // Generic state pointer
                        const float* network_delays) {
    rewind_entry_t* entry = &buffer->entries[buffer->current_index];
    
    // Store the state
    entry->tick = tick;
    entry->timestamp = get_time_ms();
    copy_simulation_state_to_rewind(&entry->state, state);
    entry->valid = true;
    
    // Store per-client network delays
    if (network_delays) {
        memcpy(entry->network_delays, network_delays, sizeof(float) * MAX_CLIENTS);
    } else {
        memset(entry->network_delays, 0, sizeof(float) * MAX_CLIENTS);
    }
    
    // Update buffer metadata
    if (buffer->valid_entries < REWIND_BUFFER_SIZE) {
        buffer->valid_entries++;
    }
    
    buffer->newest_tick = tick;
    
    // Calculate oldest valid tick
    if (buffer->valid_entries == REWIND_BUFFER_SIZE) {
        int oldest_index = (buffer->current_index + 1) % REWIND_BUFFER_SIZE;
        buffer->oldest_tick = buffer->entries[oldest_index].tick;
    } else if (buffer->valid_entries == 1) {
        buffer->oldest_tick = tick;
    }
    
    // Move to next position in ring buffer
    buffer->current_index = (buffer->current_index + 1) % REWIND_BUFFER_SIZE;
}

/**
 * Get state from specific tick for hit validation
 */
const rewind_entry_t* rewind_buffer_get_state(const rewind_buffer_t* buffer, uint32_t tick) {
    // Search for the exact tick in the buffer
    for (int i = 0; i < REWIND_BUFFER_SIZE; i++) {
        const rewind_entry_t* entry = &buffer->entries[i];
        if (entry->valid && entry->tick == tick) {
            return entry;
        }
    }
    
    // If exact tick not found, find closest older tick
    const rewind_entry_t* closest = NULL;
    uint32_t closest_distance = UINT32_MAX;
    
    for (int i = 0; i < REWIND_BUFFER_SIZE; i++) {
        const rewind_entry_t* entry = &buffer->entries[i];
        if (entry->valid && entry->tick <= tick) {
            uint32_t distance = tick - entry->tick;
            if (distance < closest_distance) {
                closest_distance = distance;
                closest = entry;
            }
        }
    }
    
    return closest;
}

/**
 * Validate hit against historical state
 */
hit_validation_result_t rewind_buffer_validate_hit(const rewind_buffer_t* buffer,
                                                  uint32_t client_id,
                                                  uint32_t reported_tick,
                                                  rewind_vec2_t shot_origin,
                                                  rewind_vec2_t shot_direction,
                                                  float shot_range) {
    hit_validation_result_t result = {0};
    
    // Get historical state for the reported tick
    const rewind_entry_t* historical_state = rewind_buffer_get_state(buffer, reported_tick);
    if (!historical_state) {
        printf("⚠️ No historical state found for tick %u\n", reported_tick);
        return result;
    }
    
    // Calculate rewind time
    uint64_t current_time = get_time_ms();
    result.rewind_time_ms = (float)(current_time - historical_state->timestamp);
    result.rewind_tick = historical_state->tick;
    
    // Adjust for client's network delay
    float client_delay = 0.0f;
    if (client_id < MAX_CLIENTS) {
        client_delay = historical_state->network_delays[client_id];
    }
    
    // Validate the hit against all ships in historical state
    rewind_vec2_t hit_point;
    float closest_hit_distance = shot_range + 1.0f; // Start beyond range
    
    for (int i = 0; i < historical_state->state.num_ships; i++) {
        const rewind_ship_t* ship = &historical_state->state.ships[i];
        
        if (raycast_ship_hit(shot_origin, shot_direction, shot_range, ship, &hit_point)) {
            float hit_distance = rewind_vec2_distance(shot_origin, hit_point);
            
            if (hit_distance < closest_hit_distance) {
                closest_hit_distance = hit_distance;
                result.hit_valid = true;
                result.hit_position = hit_point;
                result.target_ship_id = ship->id;
                result.damage_dealt = 25.0f; // TODO: Calculate based on weapon type
            }
        }
    }
    
    // Update statistics
    ((rewind_buffer_t*)buffer)->total_rewinds++;
    if (result.hit_valid) {
        ((rewind_buffer_t*)buffer)->successful_rewinds++;
    } else {
        ((rewind_buffer_t*)buffer)->failed_rewinds++;
    }
    
    // Update average rewind distance
    float total_distance = ((rewind_buffer_t*)buffer)->average_rewind_distance * 
                          (((rewind_buffer_t*)buffer)->total_rewinds - 1);
    total_distance += result.rewind_time_ms;
    ((rewind_buffer_t*)buffer)->average_rewind_distance = 
        total_distance / ((rewind_buffer_t*)buffer)->total_rewinds;
    
    return result;
}

/**
 * Validate player movement against physics envelope
 */
movement_envelope_t rewind_buffer_validate_movement(const rewind_buffer_t* buffer,
                                                   uint32_t player_id,
                                                   uint32_t from_tick,
                                                   uint32_t to_tick,
                                                   rewind_vec2_t reported_position) {
    movement_envelope_t envelope = {0};
    
    // Get states for both ticks
    const rewind_entry_t* from_state = rewind_buffer_get_state(buffer, from_tick);
    const rewind_entry_t* to_state = rewind_buffer_get_state(buffer, to_tick);
    
    if (!from_state || !to_state) {
        printf("⚠️ Missing states for movement validation (from: %u, to: %u)\n", 
               from_tick, to_tick);
        envelope.position_valid = false;
        return envelope;
    }
    
    // Find player in from_state
    const rewind_player_t* from_player = NULL;
    for (int i = 0; i < from_state->state.num_players; i++) {
        if (from_state->state.players[i].id == player_id) {
            from_player = &from_state->state.players[i];
            break;
        }
    }
    
    if (!from_player) {
        printf("⚠️ Player %u not found in from_state\n", player_id);
        envelope.position_valid = false;
        return envelope;
    }
    
    // Calculate time delta
    float delta_time = (float)(to_state->timestamp - from_state->timestamp) / 1000.0f;
    float max_movement = calculate_max_movement_distance(delta_time, PLAYER_MAX_SPEED);
    
    // Create movement envelope
    envelope.expected_position = rewind_vec2_add(from_player->position, 
                                        rewind_vec2_scale(from_player->velocity, delta_time));
    envelope.min_position = rewind_vec2_sub(from_player->position, rewind_vec2_create(max_movement, max_movement));
    envelope.max_position = rewind_vec2_add(from_player->position, rewind_vec2_create(max_movement, max_movement));
    envelope.tolerance = max_movement * 0.1f; // 10% tolerance
    
    // Check if reported position is within envelope
    float distance_from_expected = rewind_vec2_distance(reported_position, envelope.expected_position);
    envelope.position_valid = distance_from_expected <= (max_movement + envelope.tolerance);
    
    return envelope;
}

/**
 * Get rewind buffer statistics
 */
void rewind_buffer_get_stats(const rewind_buffer_t* buffer,
                            uint64_t* total_rewinds,
                            uint64_t* successful_rewinds,
                            float* average_rewind_distance,
                            int* buffer_utilization) {
    if (total_rewinds) *total_rewinds = buffer->total_rewinds;
    if (successful_rewinds) *successful_rewinds = buffer->successful_rewinds;
    if (average_rewind_distance) *average_rewind_distance = buffer->average_rewind_distance;
    if (buffer_utilization) *buffer_utilization = (buffer->valid_entries * 100) / REWIND_BUFFER_SIZE;
}

/**
 * Clean up old entries (called periodically)
 */
void rewind_buffer_cleanup(rewind_buffer_t* buffer, uint32_t current_tick) {
    // Mark entries older than MAX_REWIND_TIME_MS as invalid
    uint64_t current_time = get_time_ms();
    uint64_t cutoff_time = current_time - MAX_REWIND_TIME_MS;
    
    for (int i = 0; i < REWIND_BUFFER_SIZE; i++) {
        rewind_entry_t* entry = &buffer->entries[i];
        if (entry->valid && entry->timestamp < cutoff_time) {
            entry->valid = false;
            buffer->valid_entries--;
        }
    }
}

/**
 * Check if rewind buffer can handle the requested rewind
 */
bool rewind_buffer_can_rewind(const rewind_buffer_t* buffer, uint32_t target_tick) {
    return (target_tick >= buffer->oldest_tick && 
            target_tick <= buffer->newest_tick &&
            buffer->valid_entries > 0);
}

// Static helper functions

/**
 * Copy simulation state to rewind buffer format
 */
static void copy_simulation_state_to_rewind(rewind_simulation_state_t* dest, const void* src) {
    // For now, create a minimal test state
    // In a real implementation, this would convert from the actual simulation state
    memset(dest, 0, sizeof(rewind_simulation_state_t));
    dest->tick = 0;
    dest->time = 0.0f;
    dest->num_ships = 0;
    dest->num_players = 0;
    dest->num_cannonballs = 0;
    
    // TODO: Implement proper state conversion from actual simulation
    (void)src; // Unused parameter for now
}

/**
 * Raycast against ship hull for hit detection
 */
static bool raycast_ship_hit(rewind_vec2_t ray_origin, rewind_vec2_t ray_direction, float ray_length,
                            const rewind_ship_t* ship, rewind_vec2_t* hit_point) {
    // Simple bounding circle check first
    float ship_radius = 2.0f; // Approximate ship radius
    rewind_vec2_t to_ship = rewind_vec2_sub(ship->position, ray_origin);
    float distance_to_ship = rewind_vec2_length(to_ship);
    
    if (distance_to_ship > ray_length + ship_radius) {
        return false; // Too far away
    }
    
    // More detailed hull intersection check
    rewind_vec2_t ray_end = rewind_vec2_add(ray_origin, rewind_vec2_scale(ray_direction, ray_length));
    
    // Check intersection with ship's bounding box (simplified)
    rewind_vec2_t ship_min = rewind_vec2_sub(ship->position, rewind_vec2_create(ship_radius, ship_radius));
    rewind_vec2_t ship_max = rewind_vec2_add(ship->position, rewind_vec2_create(ship_radius, ship_radius));
    
    // Line-box intersection test
    float t_min = 0.0f;
    float t_max = ray_length;
    
    // X-axis intersection
    if (ray_direction.x != 0.0f) {
        float tx1 = (ship_min.x - ray_origin.x) / ray_direction.x;
        float tx2 = (ship_max.x - ray_origin.x) / ray_direction.x;
        t_min = fmaxf(t_min, fminf(tx1, tx2));
        t_max = fminf(t_max, fmaxf(tx1, tx2));
    }
    
    // Y-axis intersection
    if (ray_direction.y != 0.0f) {
        float ty1 = (ship_min.y - ray_origin.y) / ray_direction.y;
        float ty2 = (ship_max.y - ray_origin.y) / ray_direction.y;
        t_min = fmaxf(t_min, fminf(ty1, ty2));
        t_max = fminf(t_max, fmaxf(ty1, ty2));
    }
    
    if (t_min <= t_max && t_max >= 0.0f) {
        // Hit detected
        if (hit_point) {
            *hit_point = rewind_vec2_add(ray_origin, rewind_vec2_scale(ray_direction, t_min));
        }
        return true;
    }
    
    return false;
}

/**
 * Calculate maximum movement distance in given time
 */
static float calculate_max_movement_distance(float delta_time, float max_speed) {
    // Add some tolerance for acceleration/deceleration
    float base_distance = max_speed * delta_time;
    float tolerance_factor = 1.2f; // 20% tolerance
    return base_distance * tolerance_factor;
}