/**
 * Week 3-4 Feature Test - Lag Compensation & Anti-Cheat
 * Tests rewind buffer, hit validation, and input validation systems
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <unistd.h>
#include "rewind_buffer.h"
#include "input_validation.h"
#include "sim/simulation.h"
#include "sim/types.h"
#include "util/time.h"
#include "util/log.h"

// Test helper functions
static void create_test_simulation_state(simulation_state_t* state, uint32_t tick);
static void create_test_input_frame(input_frame_t* input, uint32_t tick, float movement_x, float movement_y);
static bool test_rewind_buffer_basic();
static bool test_rewind_buffer_hit_validation();
static bool test_input_validation_rate_limiting();
static bool test_input_validation_movement_bounds();
static bool test_input_validation_anomaly_detection();
static void print_test_results(const char* test_name, bool passed);

int main() {
    printf("🧪 Week 3-4 Feature Test Suite\n");
    printf("================================\n\n");
    
    // Initialize logging
    log_init(LOG_LEVEL_INFO);
    
    bool all_passed = true;
    
    // Test rewind buffer system
    printf("📼 Testing Rewind Buffer System\n");
    printf("--------------------------------\n");
    all_passed &= test_rewind_buffer_basic();
    all_passed &= test_rewind_buffer_hit_validation();
    printf("\n");
    
    // Test input validation system  
    printf("🛡️ Testing Input Validation System\n");
    printf("------------------------------------\n");
    all_passed &= test_input_validation_rate_limiting();
    all_passed &= test_input_validation_movement_bounds();
    all_passed &= test_input_validation_anomaly_detection();
    printf("\n");
    
    // Final results
    printf("================================\n");
    if (all_passed) {
        printf("✅ All Week 3-4 tests PASSED!\n");
        printf("🚀 Ready for client integration and production deployment\n");
        return 0;
    } else {
        printf("❌ Some tests FAILED!\n");
        printf("🔧 Review implementation before proceeding\n");
        return 1;
    }
}

/**
 * Test basic rewind buffer functionality
 */
static bool test_rewind_buffer_basic() {
    printf("  Testing basic rewind buffer operations...\n");
    
    rewind_buffer_t buffer;
    rewind_buffer_init(&buffer);
    
    // Store several states
    for (uint32_t tick = 100; tick < 120; tick++) {
        simulation_state_t state;
        create_test_simulation_state(&state, tick);
        
        float delays[MAX_CLIENTS] = {50.0f, 75.0f, 100.0f}; // Test delays
        rewind_buffer_store(&buffer, tick, &state, delays);
        
        // Small delay to ensure different timestamps
        usleep(1000); // 1ms
    }
    
    // Test buffer metadata
    bool metadata_correct = (buffer.newest_tick == 119 && 
                            buffer.valid_entries == REWIND_BUFFER_SIZE);
    
    // Test state retrieval
    const rewind_entry_t* entry = rewind_buffer_get_state(&buffer, 110);
    bool retrieval_works = (entry != NULL && entry->tick <= 110);
    
    // Test rewind capability
    bool can_rewind_recent = rewind_buffer_can_rewind(&buffer, 115);
    bool cannot_rewind_old = !rewind_buffer_can_rewind(&buffer, 50);
    
    bool passed = metadata_correct && retrieval_works && can_rewind_recent && cannot_rewind_old;
    print_test_results("Basic rewind buffer", passed);
    
    if (passed) {
        printf("    ✓ Buffer size: %d entries\n", buffer.valid_entries);
        printf("    ✓ Tick range: %u - %u\n", buffer.oldest_tick, buffer.newest_tick);
        printf("    ✓ State retrieval working\n");
        printf("    ✓ Rewind capability checks working\n");
    }
    
    return passed;
}

/**
 * Test rewind buffer hit validation
 */
static bool test_rewind_buffer_hit_validation() {
    printf("  Testing hit validation system...\n");
    
    rewind_buffer_t buffer;
    rewind_buffer_init(&buffer);
    
    // Create test scenario with ships
    for (uint32_t tick = 200; tick < 220; tick++) {
        simulation_state_t state;
        create_test_simulation_state(&state, tick);
        
        // Add a test ship at a known position
        state.num_ships = 1;
        state.ships[0].id = 1;
        state.ships[0].position = vec2_create(10.0f, 0.0f);
        state.ships[0].health = 100;
        
        float delays[MAX_CLIENTS] = {25.0f};
        rewind_buffer_store(&buffer, tick, &state, delays);
        usleep(1000);
    }
    
    // Test hit validation - shot that should hit the ship
    vec2_t shot_origin = vec2_create(0.0f, 0.0f);
    vec2_t shot_direction = vec2_create(1.0f, 0.0f); // Shooting east toward ship
    float shot_range = 15.0f;
    
    hit_validation_result_t hit_result = rewind_buffer_validate_hit(&buffer, 0, 210,
                                                                   shot_origin, shot_direction, shot_range);
    
    bool hit_validation_works = hit_result.hit_valid && hit_result.target_ship_id == 1;
    
    // Test miss case - shot that should miss
    vec2_t miss_direction = vec2_create(0.0f, 1.0f); // Shooting north, should miss
    hit_validation_result_t miss_result = rewind_buffer_validate_hit(&buffer, 0, 210,
                                                                    shot_origin, miss_direction, shot_range);
    
    bool miss_detection_works = !miss_result.hit_valid;
    
    // Test statistics
    uint64_t total_rewinds, successful_rewinds;
    float avg_rewind_distance;
    int buffer_utilization;
    rewind_buffer_get_stats(&buffer, &total_rewinds, &successful_rewinds, 
                           &avg_rewind_distance, &buffer_utilization);
    
    bool stats_work = (total_rewinds == 2); // We performed 2 hit validations
    
    bool passed = hit_validation_works && miss_detection_works && stats_work;
    print_test_results("Hit validation", passed);
    
    if (passed) {
        printf("    ✓ Hit detection: %s (damage: %.1f)\n", 
               hit_result.hit_valid ? "HIT" : "MISS", hit_result.damage_dealt);
        printf("    ✓ Miss detection: %s\n", 
               miss_result.hit_valid ? "HIT" : "MISS");
        printf("    ✓ Rewind stats: %lu/%lu successful\n", 
               successful_rewinds, total_rewinds);
        printf("    ✓ Average rewind time: %.1fms\n", avg_rewind_distance);
    }
    
    return passed;
}

/**
 * Test input validation rate limiting
 */
static bool test_input_validation_rate_limiting() {
    printf("  Testing input rate limiting...\n");
    
    input_validator_t validator;
    input_validation_init(&validator);
    
    uint32_t client_id = 0;
    uint64_t timestamp = get_time_ms();
    bool rate_limiting_works = true;
    
    // Send inputs at valid rate (120Hz = 8.33ms intervals)
    for (int i = 0; i < 5; i++) {
        input_frame_t input;
        create_test_input_frame(&input, i, 0.5f, 0.0f);
        
        input_validation_result_t result = input_validation_validate(&validator, client_id, 
                                                                    &input, timestamp);
        
        if (!result.valid) {
            printf("    ❌ Valid input rejected at valid rate\n");
            rate_limiting_works = false;
        }
        
        timestamp += 10; // 10ms intervals (100Hz, should be fine)
    }
    
    // Now send inputs too fast (should be rejected)
    for (int i = 0; i < 3; i++) {
        input_frame_t input;
        create_test_input_frame(&input, i + 10, 0.5f, 0.0f);
        
        input_validation_result_t result = input_validation_validate(&validator, client_id, 
                                                                    &input, timestamp);
        
        if (i > 0 && result.valid) { // First one might pass, but subsequent should fail
            printf("    ❌ Fast input not properly rate limited\n");
            rate_limiting_works = false;
        }
        
        timestamp += 2; // 2ms intervals (500Hz, should be rejected)
    }
    
    // Check statistics
    const input_validation_t* stats = input_validation_get_client_stats(&validator, client_id);
    bool stats_correct = (stats->rate_violations > 0 && stats->total_inputs > 0);
    
    bool passed = rate_limiting_works && stats_correct;
    print_test_results("Rate limiting", passed);
    
    if (passed) {
        printf("    ✓ Total inputs: %u\n", stats->total_inputs);
        printf("    ✓ Invalid inputs: %u\n", stats->invalid_inputs);
        printf("    ✓ Rate violations: %u\n", stats->rate_violations);
        printf("    ✓ Rejection rate: %.1f%%\n", 
               100.0f * stats->invalid_inputs / stats->total_inputs);
    }
    
    return passed;
}

/**
 * Test input validation movement bounds
 */
static bool test_input_validation_movement_bounds() {
    printf("  Testing movement bounds validation...\n");
    
    input_validator_t validator;
    input_validation_init(&validator);
    
    uint32_t client_id = 1;
    uint64_t timestamp = get_time_ms();
    
    // Test valid movement
    input_frame_t valid_input;
    create_test_input_frame(&valid_input, 0, 0.8f, 0.6f); // Magnitude = 1.0
    
    input_validation_result_t result = input_validation_validate(&validator, client_id, 
                                                                &valid_input, timestamp);
    bool valid_movement_accepted = result.valid;
    
    timestamp += 20;
    
    // Test invalid movement (too large)
    input_frame_t invalid_input;
    create_test_input_frame(&invalid_input, 1, 2.0f, 2.0f); // Magnitude > 1.0
    
    result = input_validation_validate(&validator, client_id, &invalid_input, timestamp);
    bool invalid_movement_rejected = !result.valid && 
                                    (result.violation_flags & VIOLATION_MOVEMENT_BOUNDS);
    
    // Check statistics
    const input_validation_t* stats = input_validation_get_client_stats(&validator, client_id);
    bool stats_correct = (stats->movement_violations > 0);
    
    bool passed = valid_movement_accepted && invalid_movement_rejected && stats_correct;
    print_test_results("Movement bounds", passed);
    
    if (passed) {
        printf("    ✓ Valid movement accepted\n");
        printf("    ✓ Invalid movement rejected\n");
        printf("    ✓ Movement violations: %u\n", stats->movement_violations);
    }
    
    return passed;
}

/**
 * Test input validation anomaly detection
 */
static bool test_input_validation_anomaly_detection() {
    printf("  Testing anomaly detection...\n");
    
    input_validator_t validator;
    input_validation_init(&validator);
    
    uint32_t client_id = 2;
    uint64_t timestamp = get_time_ms();
    
    // Send normal inputs
    for (int i = 0; i < 10; i++) {
        input_frame_t input;
        create_test_input_frame(&input, i, (float)(i % 3) * 0.3f, (float)(i % 2) * 0.4f);
        
        input_validation_validate(&validator, client_id, &input, timestamp);
        timestamp += 15; // Normal timing
    }
    
    // Send duplicate inputs (anomaly)
    input_frame_t duplicate_input;
    create_test_input_frame(&duplicate_input, 100, 0.5f, 0.5f);
    
    input_validation_result_t result1 = input_validation_validate(&validator, client_id, 
                                                                 &duplicate_input, timestamp);
    timestamp += 10;
    
    input_validation_result_t result2 = input_validation_validate(&validator, client_id, 
                                                                 &duplicate_input, timestamp);
    
    bool duplicate_detected = (result2.violation_flags & VIOLATION_DUPLICATE_INPUT);
    
    // Send timestamp anomaly
    timestamp -= 50; // Go backwards in time
    input_frame_t time_anomaly_input;
    create_test_input_frame(&time_anomaly_input, 101, 0.3f, 0.3f);
    
    input_validation_result_t result3 = input_validation_validate(&validator, client_id, 
                                                                 &time_anomaly_input, timestamp);
    
    bool timestamp_anomaly_detected = (result3.violation_flags & VIOLATION_TIMESTAMP_ANOMALY);
    
    // Check ban threshold
    bool should_ban = input_validation_should_ban_client(&validator, client_id);
    
    // Get global stats
    uint64_t total_processed, total_rejected;
    uint32_t clients_flagged;
    float rejection_rate;
    input_validation_get_global_stats(&validator, &total_processed, &total_rejected,
                                     &clients_flagged, &rejection_rate);
    
    bool stats_work = (total_processed > 0 && rejection_rate >= 0.0f);
    
    bool passed = duplicate_detected && timestamp_anomaly_detected && stats_work;
    print_test_results("Anomaly detection", passed);
    
    if (passed) {
        printf("    ✓ Duplicate input detected\n");
        printf("    ✓ Timestamp anomaly detected\n");
        printf("    ✓ Should ban client: %s\n", should_ban ? "YES" : "NO");
        printf("    ✓ Global rejection rate: %.1f%%\n", rejection_rate * 100.0f);
        printf("    ✓ Clients flagged: %u\n", clients_flagged);
    }
    
    return passed;
}

/**
 * Helper function to create a test simulation state
 */
static void create_test_simulation_state(simulation_state_t* state, uint32_t tick) {
    memset(state, 0, sizeof(simulation_state_t));
    state->tick = tick;
    state->time = (float)tick / 45.0f; // 45Hz simulation
    state->num_ships = 0;
    state->num_players = 0;
    state->num_cannonballs = 0;
}

/**
 * Helper function to create a test input frame
 */
static void create_test_input_frame(input_frame_t* input, uint32_t tick, 
                                   float movement_x, float movement_y) {
    memset(input, 0, sizeof(input_frame_t));
    input->tick = tick;
    input->movement.x = movement_x;
    input->movement.y = movement_y;
    input->actions = 0; // No actions for basic tests
}

/**
 * Helper function to print test results
 */
static void print_test_results(const char* test_name, bool passed) {
    if (passed) {
        printf("  ✅ %s: PASSED\n", test_name);
    } else {
        printf("  ❌ %s: FAILED\n", test_name);
    }
}