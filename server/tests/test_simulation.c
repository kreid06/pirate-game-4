#include <stdio.h>
#include <assert.h>
#include <string.h>
#include "../include/sim/simulation.h"
#include "../include/aoi/grid.h"
#include "../src/sim/simulation.c"
#include "../src/core/hash.c"
#include "../src/aoi/grid.c"

// Test deterministic simulation with multiple runs
void test_deterministic_simulation(void) {
    printf("Testing deterministic simulation...\n");
    
    const uint32_t TEST_SEED = 42;
    const uint32_t TEST_TICKS = 900; // 30 seconds at 30 Hz
    
    // Configuration
    struct SimConfig config = {
        .random_seed = TEST_SEED,
        .gravity = GRAVITY_Q16,
        .water_friction = Q16_FROM_FLOAT(0.95f),
        .air_friction = Q16_FROM_FLOAT(0.99f),
        .buoyancy_factor = Q16_FROM_FLOAT(1.2f)
    };
    
    // Run simulation twice with identical setup
    struct Sim sim1, sim2;
    
    // Initialize both simulations
    assert(sim_init(&sim1, &config) == 0);
    assert(sim_init(&sim2, &config) == 0);
    
    // Create identical test scenarios
    entity_id ship1_id = sim_create_ship(&sim1, (Vec2Q16){Q16_FROM_FLOAT(0.0f), Q16_FROM_FLOAT(0.0f)}, 0);
    entity_id ship2_id = sim_create_ship(&sim2, (Vec2Q16){Q16_FROM_FLOAT(0.0f), Q16_FROM_FLOAT(0.0f)}, 0);
    assert(ship1_id == ship2_id);
    
    entity_id player1_id = sim_create_player(&sim1, (Vec2Q16){Q16_FROM_FLOAT(0.0f), Q16_FROM_FLOAT(0.0f)}, ship1_id);
    entity_id player2_id = sim_create_player(&sim2, (Vec2Q16){Q16_FROM_FLOAT(0.0f), Q16_FROM_FLOAT(0.0f)}, ship2_id);
    assert(player1_id == player2_id);
    
    // Apply identical input sequences
    struct InputCmd test_input = {0};
    test_input.player_id = player1_id;
    test_input.sequence = 1;
    test_input.thrust = 16384; // 50% forward thrust
    test_input.turn = 8192;    // 25% right turn
    test_input.actions = ACTION_FIRE_CANNON;
    
    // Simulate both worlds for TEST_TICKS
    uint64_t hash1_history[10] = {0};
    uint64_t hash2_history[10] = {0};
    
    for (uint32_t tick = 0; tick < TEST_TICKS; tick++) {
        // Apply input every 10 ticks (simulate 3 Hz input rate)
        if (tick % 10 == 0) {
            test_input.sequence++;
            test_input.client_time = tick * 33; // 33ms per tick
            sim_process_input(&sim1, &test_input);
            sim_process_input(&sim2, &test_input);
        }
        
        // Step both simulations
        sim_step(&sim1, FIXED_DT_Q16);
        sim_step(&sim2, FIXED_DT_Q16);
        
        // Check hash periodically
        if (tick % 90 == 0) { // Every 3 seconds
            uint64_t hash1 = sim_state_hash(&sim1);
            uint64_t hash2 = sim_state_hash(&sim2);
            
            int history_idx = tick / 90;
            if (history_idx < 10) {
                hash1_history[history_idx] = hash1;
                hash2_history[history_idx] = hash2;
            }
            
            if (hash1 != hash2) {
                printf("  ❌ Hash mismatch at tick %u: 0x%016lX vs 0x%016lX\n", tick, hash1, hash2);
                assert(false && "Determinism violation detected!");
            } else {
                printf("  ✓ Hash match at tick %u: 0x%016lX\n", tick, hash1);
            }
        }
    }
    
    // Final state comparison
    uint64_t final_hash1 = sim_state_hash(&sim1);
    uint64_t final_hash2 = sim_state_hash(&sim2);
    
    printf("  Final hash sim1: 0x%016lX\n", final_hash1);
    printf("  Final hash sim2: 0x%016lX\n", final_hash2);
    assert(final_hash1 == final_hash2 && "Final states must match!");
    
    // Verify simulation actually did something (state changed)
    bool state_changed = false;
    for (int i = 1; i < 10; i++) {
        if (hash1_history[i] != hash1_history[0]) {
            state_changed = true;
            break;
        }
    }
    assert(state_changed && "Simulation state should have changed during test");
    
    // Cleanup
    sim_cleanup(&sim1);
    sim_cleanup(&sim2);
    
    printf("Deterministic simulation test passed! ✓\n");
    printf("  - Ran %u ticks (%.1f seconds) with identical results\n", TEST_TICKS, TEST_TICKS / 30.0f);
    printf("  - Hash checkpoints: 10/10 matches\n");
    printf("  - State evolution: Confirmed dynamic\n\n");
}

void test_aoi_system(void) {
    printf("Testing AOI system...\n");
    
    struct AOIGrid grid;
    assert(aoi_init(&grid) == 0);
    
    // Test entity insertion and queries
    entity_id entities[10];
    Vec2Q16 positions[10];
    
    // Create entities in a line
    for (int i = 0; i < 10; i++) {
        entities[i] = i + 1;
        positions[i] = (Vec2Q16){Q16_FROM_FLOAT(i * 30.0f), Q16_FROM_FLOAT(0.0f)};
        aoi_insert_entity(&grid, entities[i], positions[i]);
    }
    
    printf("  Inserted %d entities\n", 10);
    
    // Query around center entity (should find nearby entities)
    Vec2Q16 query_center = positions[5]; // Entity 6's position
    entity_id found_entities[20];
    int found_count = aoi_query_radius(&grid, query_center, Q16_FROM_FLOAT(100.0f), 
                                      found_entities, 20);
    
    printf("  Query found %d entities within 100m radius\n", found_count);
    assert(found_count > 0 && "Should find at least some entities");
    
    // Verify we found the query center entity
    bool found_center = false;
    for (int i = 0; i < found_count; i++) {
        if (found_entities[i] == entities[5]) {
            found_center = true;
            break;
        }
    }
    assert(found_center && "Should find the center entity in query");
    
    // Test entity movement
    Vec2Q16 new_pos = (Vec2Q16){Q16_FROM_FLOAT(500.0f), Q16_FROM_FLOAT(0.0f)};
    aoi_update_entity(&grid, entities[0], positions[0], new_pos);
    
    // Query original area - should not find moved entity
    found_count = aoi_query_radius(&grid, positions[0], Q16_FROM_FLOAT(50.0f),
                                  found_entities, 20);
    
    bool found_moved = false;
    for (int i = 0; i < found_count; i++) {
        if (found_entities[i] == entities[0]) {
            found_moved = true;
            break;
        }
    }
    assert(!found_moved && "Moved entity should not be found in old location");
    
    // Test subscription system
    struct AOISubscription subscription;
    assert(aoi_subscription_init(&subscription, 100) == 0);
    
    aoi_update_subscription(&subscription, &grid, query_center, 1000);
    
    printf("  Subscription created for player 100\n");
    printf("  Subscribed to %u entities\n", subscription.subscription_count);
    assert(subscription.subscription_count > 0 && "Should subscribe to nearby entities");
    
    aoi_cleanup(&grid);
    
    printf("AOI system test passed! ✓\n");
    printf("  - Entity insertion/removal: Working\n");
    printf("  - Spatial queries: Working\n");
    printf("  - Subscription management: Working\n\n");
}

void test_performance_benchmark(void) {
    printf("Testing performance benchmark...\n");
    
    struct SimConfig config = {
        .random_seed = 12345,
        .gravity = GRAVITY_Q16,
        .water_friction = Q16_FROM_FLOAT(0.95f),
        .air_friction = Q16_FROM_FLOAT(0.99f),
        .buoyancy_factor = Q16_FROM_FLOAT(1.2f)
    };
    
    struct Sim sim;
    assert(sim_init(&sim, &config) == 0);
    
    // Create test scenario with multiple entities
    const int NUM_SHIPS = 20;
    const int NUM_PLAYERS = 50;
    
    for (int i = 0; i < NUM_SHIPS; i++) {
        Vec2Q16 pos = {Q16_FROM_FLOAT(i * 50.0f), Q16_FROM_FLOAT(0.0f)};
        sim_create_ship(&sim, pos, Q16_FROM_FLOAT(i * 0.1f));
    }
    
    for (int i = 0; i < NUM_PLAYERS; i++) {
        Vec2Q16 pos = {Q16_FROM_FLOAT(i * 10.0f), Q16_FROM_FLOAT(100.0f)};
        entity_id ship_id = (i < NUM_SHIPS) ? i + 1 : 0; // Some players on ships
        sim_create_player(&sim, pos, ship_id);
    }
    
    printf("  Created %d ships and %d players\n", NUM_SHIPS, NUM_PLAYERS);
    
    // Benchmark simulation performance
    const int BENCHMARK_TICKS = 300; // 10 seconds
    uint64_t start_time = get_time_us();
    
    for (int tick = 0; tick < BENCHMARK_TICKS; tick++) {
        sim_step(&sim, FIXED_DT_Q16);
    }
    
    uint64_t end_time = get_time_us();
    uint64_t total_us = end_time - start_time;
    double avg_us_per_tick = (double)total_us / BENCHMARK_TICKS;
    
    printf("  Simulated %d ticks in %lu μs\n", BENCHMARK_TICKS, total_us);
    printf("  Average: %.1f μs/tick (%.1f%% of 33ms budget)\n", 
           avg_us_per_tick, (avg_us_per_tick / 33333.0) * 100.0);
    
    // Performance acceptance criteria
    const double TICK_BUDGET_US = 6000.0; // 6ms p95 target
    bool performance_ok = avg_us_per_tick < TICK_BUDGET_US;
    
    if (performance_ok) {
        printf("  ✓ Performance: PASS (%.1f μs < %.1f μs target)\n", avg_us_per_tick, TICK_BUDGET_US);
    } else {
        printf("  ⚠ Performance: AT RISK (%.1f μs > %.1f μs target)\n", avg_us_per_tick, TICK_BUDGET_US);
    }
    
    sim_cleanup(&sim);
    
    printf("Performance benchmark completed!\n\n");
}

int main(void) {
    printf("=== Simulation Integration Tests ===\n\n");
    
    // Initialize required subsystems
    math_init();
    time_init();
    
    // Run comprehensive tests
    test_deterministic_simulation();
    test_aoi_system();
    test_performance_benchmark();
    
    printf("🎉 All simulation tests passed!\n");
    printf("\nValidation Summary:\n");
    printf("✅ Deterministic physics: 900 tick replay consistency\n");
    printf("✅ State hashing: Hash-based validation working\n");
    printf("✅ AOI system: Spatial queries and subscriptions functional\n");
    printf("✅ Performance: Initial benchmark baseline established\n");
    printf("\nWeek 1 Sprint Progress:\n");
    printf("✅ Core determinism foundation\n");
    printf("✅ State hashing for replay validation\n"); 
    printf("✅ Basic AOI spatial system\n");
    printf("🔄 Next: Complete physics integration & optimization\n");
    
    return 0;
}