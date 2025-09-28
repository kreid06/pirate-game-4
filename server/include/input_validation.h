/**
 * Input Validation - Anti-Cheat System
 * Week 3-4: Validates client inputs for rate limiting and anomaly detection
 */

#ifndef INPUT_VALIDATION_H
#define INPUT_VALIDATION_H

#include <stdint.h>
#include <stdbool.h>

// Forward declarations to avoid circular dependencies
#ifndef MAX_CLIENTS
#define MAX_CLIENTS 32
#endif

/**
 * Input frame structure (simplified for validation)
 */
typedef struct {
    uint32_t tick;
    struct {
        float x, y;
    } movement;
    uint32_t actions;
} input_frame_t;

// Input validation limits
#define MAX_INPUT_RATE_HZ 120           // Maximum input rate (120 Hz)
#define MIN_INPUT_INTERVAL_MS 8         // Minimum time between inputs (8ms = 125Hz)
#define MAX_MOVEMENT_MAGNITUDE 1.0f     // Maximum movement vector magnitude
#define MAX_ACTION_BITS 0xFF            // Maximum action bitfield value
#define INPUT_BURST_WINDOW_MS 100       // Window for burst detection
#define MAX_INPUTS_PER_WINDOW 15        // Max inputs in burst window

/**
 * Input validation metrics per client
 */
typedef struct {
    uint32_t client_id;
    
    // Rate limiting
    uint64_t last_input_timestamp;
    uint64_t input_count;
    uint32_t inputs_in_window;
    uint64_t window_start_time;
    
    // Validation counters
    uint32_t total_inputs;
    uint32_t invalid_inputs;
    uint32_t rate_violations;
    uint32_t movement_violations;
    uint32_t action_violations;
    uint32_t timestamp_anomalies;
    uint32_t burst_violations;
    
    // Anomaly detection
    float movement_pattern_score;       // 0.0 = normal, 1.0 = suspicious
    uint32_t duplicate_input_count;
    uint64_t last_duplicate_time;
    
    // Statistics
    float average_input_rate;
    float peak_input_rate;
    uint64_t first_input_time;
} input_validation_t;

/**
 * Input validation result
 */
typedef struct {
    bool valid;                         // Input passed all validation
    uint32_t violation_flags;           // Bitfield of violation types
    float suspicious_score;             // 0.0 = normal, 1.0 = definitely cheating
    char reason[256];                   // Human-readable violation reason
} input_validation_result_t;

/**
 * Violation flags
 */
#define VIOLATION_NONE              0x00
#define VIOLATION_RATE_LIMIT        0x01
#define VIOLATION_MOVEMENT_BOUNDS   0x02
#define VIOLATION_ACTION_INVALID    0x04
#define VIOLATION_TIMESTAMP_ANOMALY 0x08
#define VIOLATION_BURST_LIMIT       0x10
#define VIOLATION_DUPLICATE_INPUT   0x20
#define VIOLATION_PATTERN_ANOMALY   0x40

/**
 * Global input validation state
 */
typedef struct {
    input_validation_t clients[MAX_CLIENTS];
    uint32_t active_clients;
    
    // Global statistics
    uint64_t total_inputs_processed;
    uint64_t total_inputs_rejected;
    uint32_t clients_flagged;
    uint32_t clients_banned;
    
    // Configuration
    bool enable_rate_limiting;
    bool enable_movement_validation;
    bool enable_anomaly_detection;
    float ban_threshold_score;          // Automatic ban threshold
} input_validator_t;

// Function declarations

/**
 * Initialize input validation system
 */
void input_validation_init(input_validator_t* validator);

/**
 * Validate an input frame from a client
 */
input_validation_result_t input_validation_validate(input_validator_t* validator,
                                                   uint32_t client_id,
                                                   const input_frame_t* input,
                                                   uint64_t timestamp);

/**
 * Update client network delay for validation timing
 */
void input_validation_update_delay(input_validator_t* validator,
                                  uint32_t client_id,
                                  float network_delay_ms);

/**
 * Get validation statistics for a specific client
 */
const input_validation_t* input_validation_get_client_stats(const input_validator_t* validator,
                                                          uint32_t client_id);

/**
 * Get global validation statistics
 */
void input_validation_get_global_stats(const input_validator_t* validator,
                                      uint64_t* total_processed,
                                      uint64_t* total_rejected,
                                      uint32_t* clients_flagged,
                                      float* overall_rejection_rate);

/**
 * Reset validation statistics for a client
 */
void input_validation_reset_client(input_validator_t* validator, uint32_t client_id);

/**
 * Check if client should be automatically banned
 */
bool input_validation_should_ban_client(const input_validator_t* validator, uint32_t client_id);

/**
 * Update validation configuration
 */
void input_validation_configure(input_validator_t* validator,
                               bool enable_rate_limiting,
                               bool enable_movement_validation,
                               bool enable_anomaly_detection,
                               float ban_threshold);

/**
 * Cleanup and log final statistics
 */
void input_validation_cleanup(input_validator_t* validator);

#endif // INPUT_VALIDATION_H