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
    
    // Set default configuration
    validator->enable_rate_limiting = true;
    validator->enable_movement_validation = true;
    validator->enable_anomaly_detection = true;
    validator->ban_threshold_score = 0.85f; // Ban at 85% suspicious score
    
    log_info("🛡️ Input validation system initialized");
    log_info("  Rate limiting: %s", validator->enable_rate_limiting ? "enabled" : "disabled");
    log_info("  Movement validation: %s", validator->enable_movement_validation ? "enabled" : "disabled");
    log_info("  Anomaly detection: %s", validator->enable_anomaly_detection ? "enabled" : "disabled");
    log_info("  Auto-ban threshold: %.1f%%", validator->ban_threshold_score * 100.0f);
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