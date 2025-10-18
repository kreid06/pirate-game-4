/**
 * Input Validation Implementation - Anti-Cheat System
 * Week 3-4: Advanced input validation with anomaly detection
 */

#include "input_validation.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <math.h>
#include <stdio.h>

// Global tier configuration and statistics
input_tier_config_t g_tier_config[INPUT_TIER_COUNT];
int tier_player_counts[INPUT_TIER_COUNT] = {0};

// Static helper functions
static float calculate_movement_magnitude(const input_frame_t* input);
static bool is_valid_action_bitfield(uint32_t actions);
static float calculate_pattern_anomaly_score(const input_validation_t* client, 
                                           const input_frame_t* input);
static void update_input_rate_tracking(input_validation_t* client, uint64_t timestamp);

/**
 * Initialize input validation system
 */
void input_validation_init(input_validator_t* validator) {
    memset(validator, 0, sizeof(input_validator_t));
    
    // Initialize tier system configurations
    validator->enable_tiered_input = true;
    validator->max_total_input_rate = 5000; // Global rate limit
    
    // Configure input tiers based on SCALABLE_INPUT_SYSTEM.md
    validator->tier_configs[INPUT_TIER_IDLE] = (input_tier_config_t){
        .tier = INPUT_TIER_IDLE,
        .max_rate_hz = 1,
        .min_interval_ms = 1000,
        .movement_threshold = 0.0f
    };
    
    validator->tier_configs[INPUT_TIER_BACKGROUND] = (input_tier_config_t){
        .tier = INPUT_TIER_BACKGROUND,
        .max_rate_hz = 10,
        .min_interval_ms = 100,
        .movement_threshold = 0.20f
    };
    
    validator->tier_configs[INPUT_TIER_NORMAL] = (input_tier_config_t){
        .tier = INPUT_TIER_NORMAL,
        .max_rate_hz = 30,
        .min_interval_ms = 33,
        .movement_threshold = 0.10f
    };
    
    validator->tier_configs[INPUT_TIER_CRITICAL] = (input_tier_config_t){
        .tier = INPUT_TIER_CRITICAL,
        .max_rate_hz = 60,
        .min_interval_ms = 16,
        .movement_threshold = 0.05f
    };
    
    // Initialize global tier configurations for API access
    g_tier_config[INPUT_TIER_IDLE] = (input_tier_config_t){
        .tier = INPUT_TIER_IDLE,
        .max_rate_hz = 1,
        .min_interval_ms = 1000,
        .movement_threshold = 0.0f
    };
    
    g_tier_config[INPUT_TIER_BACKGROUND] = (input_tier_config_t){
        .tier = INPUT_TIER_BACKGROUND,
        .max_rate_hz = 10,
        .min_interval_ms = 100,
        .movement_threshold = 0.20f
    };
    
    g_tier_config[INPUT_TIER_NORMAL] = (input_tier_config_t){
        .tier = INPUT_TIER_NORMAL,
        .max_rate_hz = 30,
        .min_interval_ms = 33,
        .movement_threshold = 0.10f
    };
    
    g_tier_config[INPUT_TIER_CRITICAL] = (input_tier_config_t){
        .tier = INPUT_TIER_CRITICAL,
        .max_rate_hz = 60,
        .min_interval_ms = 16,
        .movement_threshold = 0.05f
    };
    
    // Set default configuration
    validator->enable_rate_limiting = true;
    validator->enable_movement_validation = true;
    validator->enable_anomaly_detection = true;
    validator->ban_threshold_score = 0.85f; // Ban at 85% suspicious score
    
    log_info("🛡️ Input validation system initialized");
    log_info("  Tiered input: %s", validator->enable_tiered_input ? "enabled" : "disabled");
    log_info("  Rate limiting: %s", validator->enable_rate_limiting ? "enabled" : "disabled");
    log_info("  Movement validation: %s", validator->enable_movement_validation ? "enabled" : "disabled");
    log_info("  Anomaly detection: %s", validator->enable_anomaly_detection ? "enabled" : "disabled");
    log_info("  Auto-ban threshold: %.1f%%", validator->ban_threshold_score * 100.0f);
    log_info("  Global input rate limit: %u packets/sec", validator->max_total_input_rate);
}

/**
 * Validate an input frame from a client
 */
input_validation_result_t input_validation_validate(input_validator_t* validator,
                                                   uint32_t client_id,
                                                   const input_frame_t* input,
                                                   uint64_t timestamp) {
    input_validation_result_t result = {0};
    result.valid = true;
    strcpy(result.reason, "Valid input");
    
    if (client_id >= MAX_CLIENTS) {
        result.valid = false;
        result.violation_flags |= VIOLATION_ACTION_INVALID;
        strcpy(result.reason, "Invalid client ID");
        return result;
    }
    
    input_validation_t* client = &validator->clients[client_id];
    client->client_id = client_id;
    client->total_inputs++;
    validator->total_inputs_processed++;
    
    // Initialize client if this is their first input
    if (client->first_input_time == 0) {
        client->first_input_time = timestamp;
        client->window_start_time = timestamp;
        // Don't set last_input_timestamp here - let it be set at the end
        validator->active_clients++;
    }
    
    // 1. Rate limiting validation
    if (validator->enable_rate_limiting) {
        // Skip rate limiting for first input from this client
        if (client->last_input_timestamp > 0) {
            uint64_t time_since_last = timestamp - client->last_input_timestamp;
            
            if (time_since_last < MIN_INPUT_INTERVAL_MS) {
                result.violation_flags |= VIOLATION_RATE_LIMIT;
                client->rate_violations++;
                result.suspicious_score += 0.3f;
                snprintf(result.reason, sizeof(result.reason),
                        "Input rate too high (%.1fms interval)", (float)time_since_last);
            }
        }
        
        // Burst detection
        if (timestamp - client->window_start_time >= INPUT_BURST_WINDOW_MS) {
            if (client->inputs_in_window > MAX_INPUTS_PER_WINDOW) {
                result.violation_flags |= VIOLATION_BURST_LIMIT;
                client->burst_violations++;
                result.suspicious_score += 0.4f;
                snprintf(result.reason, sizeof(result.reason),
                        "Input burst detected (%u inputs in %dms)",
                        client->inputs_in_window, INPUT_BURST_WINDOW_MS);
            }
            client->inputs_in_window = 0;
            client->window_start_time = timestamp;
        }
        client->inputs_in_window++;
        
        update_input_rate_tracking(client, timestamp);
    }
    
    // 2. Movement validation
    if (validator->enable_movement_validation) {
        float movement_magnitude = calculate_movement_magnitude(input);
        
        if (movement_magnitude > MAX_MOVEMENT_MAGNITUDE) {
            result.violation_flags |= VIOLATION_MOVEMENT_BOUNDS;
            client->movement_violations++;
            result.suspicious_score += 0.2f;
            snprintf(result.reason, sizeof(result.reason),
                    "Movement magnitude too large (%.3f > %.3f)",
                    movement_magnitude, MAX_MOVEMENT_MAGNITUDE);
        }
        
        // Check for impossible movement patterns
        if (movement_magnitude > 0.0f) {
            // Normalize movement
            float normalized_x = input->movement.x / movement_magnitude;
            float normalized_y = input->movement.y / movement_magnitude;
            
            // Check for suspicious perfect patterns (e.g., perfect circles)
            // This is a simple heuristic - real anti-cheat would be more sophisticated
            if (fabsf(normalized_x) == fabsf(normalized_y) && movement_magnitude > 0.9f) {
                client->movement_pattern_score += 0.1f;
                if (client->movement_pattern_score > 5.0f) { // Accumulated suspicion
                    result.violation_flags |= VIOLATION_PATTERN_ANOMALY;
                    result.suspicious_score += 0.15f;
                }
            } else {
                client->movement_pattern_score *= 0.98f; // Decay suspicion
            }
        }
    }
    
    // 3. Action validation
    if (!is_valid_action_bitfield(input->actions)) {
        result.violation_flags |= VIOLATION_ACTION_INVALID;
        client->action_violations++;
        result.suspicious_score += 0.25f;
        snprintf(result.reason, sizeof(result.reason),
                "Invalid action bitfield: 0x%08X", input->actions);
    }
    
    // 4. Timestamp anomaly detection
    if (client->last_input_timestamp > 0) {
        int64_t time_delta = (int64_t)timestamp - (int64_t)client->last_input_timestamp;
        
        // Check for negative time or excessive gaps
        if (time_delta < 0 || time_delta > 200) { // More than 200ms gap
            result.violation_flags |= VIOLATION_TIMESTAMP_ANOMALY;
            client->timestamp_anomalies++;
            result.suspicious_score += 0.1f;
        }
    }
    
    // 5. Duplicate input detection
    static input_frame_t last_inputs[MAX_CLIENTS];
    if (client_id < MAX_CLIENTS) {
        if (memcmp(&last_inputs[client_id], input, sizeof(input_frame_t)) == 0) {
            if (timestamp - client->last_duplicate_time < 50) { // Duplicate within 50ms
                result.violation_flags |= VIOLATION_DUPLICATE_INPUT;
                client->duplicate_input_count++;
                result.suspicious_score += 0.05f;
            }
            client->last_duplicate_time = timestamp;
        }
        last_inputs[client_id] = *input;
    }
    
    // 6. Pattern anomaly detection (if enabled)
    if (validator->enable_anomaly_detection) {
        float pattern_score = calculate_pattern_anomaly_score(client, input);
        result.suspicious_score += pattern_score;
    }
    
    // Clamp suspicious score
    if (result.suspicious_score > 1.0f) {
        result.suspicious_score = 1.0f;
    }
    
    // Determine if input is valid
    if (result.violation_flags != VIOLATION_NONE) {
        result.valid = false;
        client->invalid_inputs++;
        validator->total_inputs_rejected++;
        
        // Check if client should be flagged
        float rejection_rate = (float)client->invalid_inputs / client->total_inputs;
        if (rejection_rate > 0.1f || result.suspicious_score > 0.7f) {
            validator->clients_flagged++;
        }
    }
    
    client->last_input_timestamp = timestamp;
    return result;
}

/**
 * Update client network delay for validation timing
 */
void input_validation_update_delay(input_validator_t* validator,
                                  uint32_t client_id,
                                  float network_delay_ms) {
    if (client_id >= MAX_CLIENTS) return;
    
    // Use network delay to adjust validation tolerances
    // Higher delays get more tolerance for timing anomalies
    (void)network_delay_ms; // TODO: Implement delay-adjusted validation
}

/**
 * Get validation statistics for a specific client
 */
const input_validation_t* input_validation_get_client_stats(const input_validator_t* validator,
                                                          uint32_t client_id) {
    if (client_id >= MAX_CLIENTS) return NULL;
    return &validator->clients[client_id];
}

/**
 * Get global validation statistics
 */
void input_validation_get_global_stats(const input_validator_t* validator,
                                      uint64_t* total_processed,
                                      uint64_t* total_rejected,
                                      uint32_t* clients_flagged,
                                      float* overall_rejection_rate) {
    if (total_processed) *total_processed = validator->total_inputs_processed;
    if (total_rejected) *total_rejected = validator->total_inputs_rejected;
    if (clients_flagged) *clients_flagged = validator->clients_flagged;
    
    if (overall_rejection_rate) {
        *overall_rejection_rate = validator->total_inputs_processed > 0 ?
            (float)validator->total_inputs_rejected / validator->total_inputs_processed : 0.0f;
    }
}

/**
 * Reset validation statistics for a client
 */
void input_validation_reset_client(input_validator_t* validator, uint32_t client_id) {
    if (client_id >= MAX_CLIENTS) return;
    
    log_info("🔄 Resetting validation stats for client %u", client_id);
    memset(&validator->clients[client_id], 0, sizeof(input_validation_t));
    validator->clients[client_id].client_id = client_id;
}

/**
 * Check if client should be automatically banned
 */
bool input_validation_should_ban_client(const input_validator_t* validator, uint32_t client_id) {
    if (client_id >= MAX_CLIENTS) return false;
    
    const input_validation_t* client = &validator->clients[client_id];
    
    // Calculate overall suspicious score
    float rejection_rate = client->total_inputs > 0 ? 
        (float)client->invalid_inputs / client->total_inputs : 0.0f;
    
    float overall_score = rejection_rate * 0.6f + 
                         (client->movement_pattern_score / 10.0f) * 0.4f;
    
    return overall_score >= validator->ban_threshold_score;
}

/**
 * Update validation configuration
 */
void input_validation_configure(input_validator_t* validator,
                               bool enable_rate_limiting,
                               bool enable_movement_validation,
                               bool enable_anomaly_detection,
                               float ban_threshold) {
    validator->enable_rate_limiting = enable_rate_limiting;
    validator->enable_movement_validation = enable_movement_validation;
    validator->enable_anomaly_detection = enable_anomaly_detection;
    validator->ban_threshold_score = ban_threshold;
    
    log_info("🔧 Input validation configuration updated");
}

/**
 * Cleanup and log final statistics
 */
void input_validation_cleanup(input_validator_t* validator) {
    log_info("🛡️ Input validation final statistics:");
    log_info("  Total inputs processed: %lu", validator->total_inputs_processed);
    log_info("  Total inputs rejected: %lu (%.2f%%)", 
             validator->total_inputs_rejected,
             validator->total_inputs_processed > 0 ?
             100.0f * validator->total_inputs_rejected / validator->total_inputs_processed : 0.0f);
    log_info("  Active clients tracked: %u", validator->active_clients);
    log_info("  Clients flagged: %u", validator->clients_flagged);
    log_info("  Clients banned: %u", validator->clients_banned);
}

// Static helper functions

/**
 * Calculate movement vector magnitude
 */
static float calculate_movement_magnitude(const input_frame_t* input) {
    return sqrtf(input->movement.x * input->movement.x + 
                input->movement.y * input->movement.y);
}

/**
 * Validate action bitfield
 */
static bool is_valid_action_bitfield(uint32_t actions) {
    // Check that only valid action bits are set
    return (actions & ~MAX_ACTION_BITS) == 0;
}

/**
 * Calculate pattern anomaly score based on input history
 */
static float calculate_pattern_anomaly_score(const input_validation_t* client, 
                                           const input_frame_t* input) {
    // Simple pattern analysis - real implementation would be much more sophisticated
    (void)client;
    (void)input;
    
    // TODO: Implement sophisticated pattern analysis
    // - Fourier analysis of input timing
    // - Movement pattern recognition
    // - Statistical analysis of input distributions
    // - Machine learning based anomaly detection
    
    return 0.0f;
}

/**
 * Update input rate tracking
 */
static void update_input_rate_tracking(input_validation_t* client, uint64_t timestamp) {
    if (client->first_input_time == 0) return;
    
    uint64_t total_time = timestamp - client->first_input_time;
    if (total_time > 0) {
        client->average_input_rate = (float)client->input_count * 1000.0f / total_time;
    }
    
    // Track peak input rate in a sliding window
    uint64_t window_size = 1000; // 1 second window
    if (timestamp - client->last_input_timestamp < window_size) {
        float current_rate = 1000.0f / (timestamp - client->last_input_timestamp + 1);
        if (current_rate > client->peak_input_rate) {
            client->peak_input_rate = current_rate;
        }
    }
    
    client->input_count++;
}

/**
 * Update client input tier based on gameplay context
 */
void input_validation_update_tier(input_validator_t* validator,
                                 uint32_t client_id,
                                 uint32_t nearby_players,
                                 bool in_combat,
                                 bool is_moving) {
    if (!validator || client_id >= MAX_CLIENTS) return;
    
    input_validation_t* client = &validator->clients[client_id];
    input_tier_t new_tier;
    
    // Tier selection logic from SCALABLE_INPUT_SYSTEM.md
    if (in_combat || nearby_players >= 3) {
        new_tier = INPUT_TIER_CRITICAL; // 60Hz for combat/high activity
    } else if (nearby_players >= 1) {
        new_tier = INPUT_TIER_NORMAL;    // 30Hz for normal gameplay
    } else if (is_moving) {
        new_tier = INPUT_TIER_BACKGROUND; // 10Hz for solo exploration
    } else {
        new_tier = INPUT_TIER_IDLE;      // 1Hz for idle/AFK
    }
    
    // Update client state
    if (client->current_tier != new_tier) {
        log_info("🎯 Client %u tier changed: %d → %d (nearby:%u combat:%d moving:%d)",
                 client_id, client->current_tier, new_tier, nearby_players, in_combat, is_moving);
        
        // Update global tier statistics
        if (client->current_tier >= 0 && client->current_tier < INPUT_TIER_COUNT) {
            tier_player_counts[client->current_tier]--;
        }
        tier_player_counts[new_tier]++;
        
        client->current_tier = new_tier;
        client->last_tier_update = get_time_ms();
    }
    
    client->nearby_players = nearby_players;
    client->in_combat = in_combat;
    client->is_moving = is_moving;
}

/**
 * Check if input should be processed based on tier rate limiting
 */
bool input_validation_should_process_input(input_validator_t* validator,
                                          uint32_t client_id,
                                          uint64_t timestamp) {
    if (!validator || client_id >= MAX_CLIENTS) return false;
    if (!validator->enable_tiered_input) return true;
    
    input_validation_t* client = &validator->clients[client_id];
    input_tier_config_t* tier_config = &validator->tier_configs[client->current_tier];
    
    // Check if enough time has passed since last input
    uint64_t time_since_last = timestamp - client->last_input_timestamp;
    if (time_since_last < tier_config->min_interval_ms) {
        return false; // Rate limited
    }
    
    return true;
}

/**
 * Get input tier statistics
 */
void input_validation_get_tier_stats(const input_validator_t* validator,
                                    uint64_t tier_counts[INPUT_TIER_COUNT],
                                    uint32_t* total_players) {
    if (!validator || !tier_counts || !total_players) return;
    
    memset(tier_counts, 0, sizeof(uint64_t) * INPUT_TIER_COUNT);
    *total_players = 0;
    
    for (uint32_t i = 0; i < MAX_CLIENTS; i++) {
        const input_validation_t* client = &validator->clients[i];
        if (client->client_id != 0) { // Active client
            tier_counts[client->current_tier]++;
            (*total_players)++;
        }
    }
}

/**
 * Register a new client for tier tracking
 */
void input_validation_register_client(input_validator_t* validator, uint32_t client_id) {
    if (!validator || client_id >= MAX_CLIENTS) return;
    
    input_validation_t* client = &validator->clients[client_id];
    
    // Initialize new client to IDLE tier
    if (client->client_id == 0) {
        client->client_id = client_id;
        client->current_tier = INPUT_TIER_IDLE;
        client->last_tier_update = get_time_ms();
        tier_player_counts[INPUT_TIER_IDLE]++;
        
        log_info("📋 Client %u registered for tier tracking (IDLE)", client_id);
    }
}

/**
 * Unregister a client from tier tracking
 */
void input_validation_unregister_client(input_validator_t* validator, uint32_t client_id) {
    if (!validator || client_id >= MAX_CLIENTS) return;
    
    input_validation_t* client = &validator->clients[client_id];
    
    if (client->client_id != 0) {
        // Remove from tier count
        if (client->current_tier >= 0 && client->current_tier < INPUT_TIER_COUNT) {
            tier_player_counts[client->current_tier]--;
        }
        
        log_info("📋 Client %u unregistered from tier tracking", client_id);
        
        // Clear client data
        memset(client, 0, sizeof(input_validation_t));
    }
}