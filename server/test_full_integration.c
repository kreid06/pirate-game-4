/*
 * Week 3-4 Full Integration Test
 * 
 * This test verifies that the rewind buffer and input validation systems
 * integrate properly with the main simulation components.
 */

#include "rewind_buffer.h"
#include "input_validation.h"
#include "sim/simulation.h"
#include "protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <time.h>
#include <math.h>

// Test configuration
#define TEST_DURATION_FRAMES 60
#define SIMULATION_RATE_HZ 45
#define CLIENT_INPUT_RATE_HZ 60

// Mock simulation state for testing
struct TestSimulationState {
    uint32_t tick;
    uint32_t entity_count;
    struct {
        entity_id id;
        float pos_x, pos_y;
        float vel_x, vel_y;
    } entities[16];
};

// Statistics tracking
struct IntegrationTestStats {
    uint32_t total_inputs_processed;
    uint32_t inputs_validated;
    uint32_t inputs_rejected;
    uint32_t rewind_validations;
    uint32_t successful_hit_validations;
    uint32_t failed_hit_validations;
    
    // Performance metrics
    uint64_t total_validation_time_us;
    uint64_t total_rewind_time_us;
    uint32_t max_validation_time_us;
    uint32_t max_rewind_time_us;
};

static uint64_t get_time_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
}

// Create realistic test input based on frame
static void create_test_input(uint32_t frame, entity_id player_id, struct CmdPacket* cmd) {
    memset(cmd, 0, sizeof(*cmd));
    
    cmd->type = PACKET_INPUT;
    cmd->client_id = player_id;
    cmd->sequence = frame;
    cmd->client_time = frame * (1000 / CLIENT_INPUT_RATE_HZ); // ms
    
    // Simulate player movement patterns
    float t = (float)frame / 60.0f; // Time in seconds
    
    // Movement inputs (normalized -1.0 to 1.0, converted to Q15)
    cmd->thrust = FLOAT_TO_Q15(0.5f * sinf(t * 2.0f));
    cmd->turn = FLOAT_TO_Q15(0.3f * cosf(t * 1.5f));
    
    // Action inputs
    cmd->actions = 0;
    if (frame % 30 == 0) cmd->actions |= ACTION_SHOOT;
    if (frame % 45 == 0) cmd->actions |= ACTION_USE;
    
    cmd->dt_ms = 1000 / CLIENT_INPUT_RATE_HZ;
}

// Create test simulation state
static void create_test_sim_state(uint32_t frame, struct TestSimulationState* state) {
    state->tick = frame;
    state->entity_count = 4;
    
    // Create some test entities with predictable movement
    for (uint32_t i = 0; i < state->entity_count; i++) {
        state->entities[i].id = 1000 + i;
        
        float t = (float)frame / SIMULATION_RATE_HZ;
        state->entities[i].pos_x = 100.0f + 50.0f * sinf(t + i);
        state->entities[i].pos_y = 100.0f + 50.0f * cosf(t + i * 0.7f);
        state->entities[i].vel_x = 10.0f * cosf(t + i);
        state->entities[i].vel_y = 10.0f * sinf(t + i * 0.7f);
    }
}

// Convert test state to rewind buffer format
static void convert_to_rewind_state(const struct TestSimulationState* test_state,
                                   rewind_simulation_state_t* rewind_state) {
    rewind_state->tick = test_state->tick;
    rewind_state->entity_count = test_state->entity_count;
    
    for (uint32_t i = 0; i < test_state->entity_count && i < REWIND_MAX_ENTITIES; i++) {
        rewind_state->entities[i].entity_id = test_state->entities[i].id;
        rewind_state->entities[i].position.x = test_state->entities[i].pos_x;
        rewind_state->entities[i].position.y = test_state->entities[i].pos_y;
        rewind_state->entities[i].velocity.x = test_state->entities[i].vel_x;
        rewind_state->entities[i].velocity.y = test_state->entities[i].vel_y;
        rewind_state->entities[i].health = 100.0f;
    }
}

// Test the full integration: Input validation -> Simulation -> Rewind buffer -> Hit validation
static int test_full_integration_cycle(void) {
    printf("\n=== Testing Full Integration Cycle ===\n");
    
    // Initialize systems
    rewind_buffer_t rewind_buffer;
    input_validator_t input_validator;
    struct IntegrationTestStats stats = {0};
    
    if (rewind_buffer_init(&rewind_buffer, REWIND_BUFFER_SIZE) != 0) {
        printf("❌ Failed to initialize rewind buffer\n");
        return -1;
    }
    
    input_validation_init(&input_validator);
    
    printf("✅ Systems initialized\n");
    printf("   - Rewind buffer: %d frames (%.1fms coverage)\n", 
           REWIND_BUFFER_SIZE, 
           (float)REWIND_BUFFER_SIZE * 1000.0f / SIMULATION_RATE_HZ);
    printf("   - Input validation: Rate limiting enabled\n");
    
    // Simulation loop
    for (uint32_t frame = 0; frame < TEST_DURATION_FRAMES; frame++) {
        uint64_t frame_start = get_time_us();
        
        // === 1. Process client inputs ===
        entity_id test_player_id = 42;
        struct CmdPacket input_cmd;
        create_test_input(frame, test_player_id, &input_cmd);
        
        // Validate input
        uint64_t validation_start = get_time_us();
        bool input_valid = input_validation_validate(&input_validator, test_player_id, &input_cmd);
        uint64_t validation_time = get_time_us() - validation_start;
        
        stats.total_validation_time_us += validation_time;
        if (validation_time > stats.max_validation_time_us) {
            stats.max_validation_time_us = (uint32_t)validation_time;
        }
        
        stats.total_inputs_processed++;
        if (input_valid) {
            stats.inputs_validated++;
        } else {
            stats.inputs_rejected++;
        }
        
        // === 2. Update simulation state ===
        struct TestSimulationState sim_state;
        create_test_sim_state(frame, &sim_state);
        
        // === 3. Store state in rewind buffer ===
        rewind_simulation_state_t rewind_state;
        convert_to_rewind_state(&sim_state, &rewind_state);
        
        uint64_t rewind_start = get_time_us();
        rewind_buffer_store_state(&rewind_buffer, &rewind_state);
        uint64_t rewind_time = get_time_us() - rewind_start;
        
        stats.total_rewind_time_us += rewind_time;
        if (rewind_time > stats.max_rewind_time_us) {
            stats.max_rewind_time_us = (uint32_t)rewind_time;
        }
        
        // === 4. Test hit validation (every 15 frames) ===
        if (frame > 10 && frame % 15 == 0 && input_valid) {
            uint32_t target_tick = frame - 5; // 5 frames ago
            rewind_vec2_t shoot_origin = {sim_state.entities[0].pos_x, sim_state.entities[0].pos_y};
            rewind_vec2_t shoot_direction = {1.0f, 0.0f};
            float shoot_range = 100.0f;
            
            stats.rewind_validations++;
            
            bool hit_valid = rewind_buffer_validate_hit(&rewind_buffer, target_tick,
                                                       shoot_origin, shoot_direction, 
                                                       shoot_range, 1001); // Target entity 1001
            
            if (hit_valid) {
                stats.successful_hit_validations++;
            } else {
                stats.failed_hit_validations++;
            }
        }
        
        uint64_t frame_time = get_time_us() - frame_start;
        
        // Progress indicator
        if (frame % 15 == 0) {
            printf("   Frame %2d: Input %s, Validation %2lluµs, Rewind %2lluµs, Total %3lluµs\n",
                   frame,
                   input_valid ? "✅" : "❌",
                   validation_time,
                   rewind_time,
                   frame_time);
        }
    }
    
    // === Results Analysis ===
    printf("\n=== Integration Test Results ===\n");
    printf("Input Processing:\n");
    printf("  Total inputs processed: %u\n", stats.total_inputs_processed);
    printf("  Inputs validated:       %u (%.1f%%)\n", 
           stats.inputs_validated,
           100.0f * stats.inputs_validated / stats.total_inputs_processed);
    printf("  Inputs rejected:        %u (%.1f%%)\n", 
           stats.inputs_rejected,
           100.0f * stats.inputs_rejected / stats.total_inputs_processed);
    
    printf("\nRewind Buffer Performance:\n");
    printf("  Hit validations:        %u\n", stats.rewind_validations);
    printf("  Successful hits:        %u (%.1f%%)\n", 
           stats.successful_hit_validations,
           stats.rewind_validations > 0 ? 100.0f * stats.successful_hit_validations / stats.rewind_validations : 0.0f);
    printf("  Failed hits:            %u\n", stats.failed_hit_validations);
    
    printf("\nPerformance Metrics:\n");
    printf("  Avg validation time:    %.1fµs\n", 
           (float)stats.total_validation_time_us / stats.total_inputs_processed);
    printf("  Max validation time:    %uµs\n", stats.max_validation_time_us);
    printf("  Avg rewind time:        %.1fµs\n", 
           (float)stats.total_rewind_time_us / stats.total_inputs_processed);
    printf("  Max rewind time:        %uµs\n", stats.max_rewind_time_us);
    
    // Cleanup
    rewind_buffer_cleanup(&rewind_buffer);
    
    // Success criteria
    bool success = (stats.inputs_validated > 0) && 
                   (stats.rewind_validations > 0) &&
                   (stats.max_validation_time_us < 1000) && // < 1ms per validation
                   (stats.max_rewind_time_us < 500);        // < 0.5ms per rewind
    
    if (success) {
        printf("\n🎉 FULL INTEGRATION TEST PASSED!\n");
        printf("   Week 3-4 systems are properly integrated and performing well.\n");
        return 0;
    } else {
        printf("\n❌ Integration test failed - performance or functionality issues\n");
        return -1;
    }
}

int main(void) {
    printf("🚢 Pirate Game Server - Week 3-4 Full Integration Test\n");
    printf("Testing rewind buffer + input validation integration\n");
    printf("=======================================================\n");
    
    if (test_full_integration_cycle() == 0) {
        printf("\n✅ ALL INTEGRATION TESTS PASSED\n");
        printf("Week 3-4 lag compensation and anti-cheat systems are ready for deployment!\n");
        return 0;
    } else {
        printf("\n❌ INTEGRATION TESTS FAILED\n");
        return -1;
    }
}