#define _DEFAULT_SOURCE
#include "server.h"
#include "sim/simulation.h"
#in    // Initialize network layer (UDP) on port 8081
    if (network_init(&server->network, 8081) != 0) {
        log_error("Failed to initialize network manager");
        simulation_cleanup(&server->simulation);
        free(server);
        return -1;
    }
    
    // Initialize admin server on port 8082
    if (admin_server_init(&server->admin, 8082) != 0) {/types.h"
#include "net/network.h"
#include "net/websocket_server.h"
#include "admin/admin_server.h"
#include "rewind_buffer.h"
#include "util/log.h"
#include "util/time.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <sys/time.h>

// Server context structure with Week 3-4 enhancements
struct ServerContext {
    bool running;
    uint64_t tick_count;
    uint64_t start_time_us;
    
    struct Sim simulation;
    struct NetworkManager network;
    struct AdminServer admin;
    
    // Week 3-4: Lag compensation and anti-cheat
    rewind_buffer_t rewind_buffer;
    float client_network_delays[MAX_CLIENTS];
    uint64_t client_last_input_time[MAX_CLIENTS];
    
    // Performance tracking
    uint64_t total_tick_time_us;
    uint64_t max_tick_time_us;
    uint32_t ticks_per_second;
    uint32_t last_stats_time;
};

int server_init(struct ServerContext** ctx) {
    if (!ctx) return -1;
    
    // Allocate server context
    struct ServerContext* server = calloc(1, sizeof(struct ServerContext));
    if (!server) {
        log_error("Failed to allocate server context");
        return -1;
    }
    
    log_info("Initializing pirate game server...");
    
    server->running = true;
    server->start_time_us = get_time_us();
    server->last_stats_time = get_time_ms();
    
    // Initialize Week 3-4: Rewind buffer and anti-cheat
    rewind_buffer_init(&server->rewind_buffer);
    memset(server->client_network_delays, 0, sizeof(server->client_network_delays));
    memset(server->client_last_input_time, 0, sizeof(server->client_last_input_time));
    
    // Initialize simulation with default config
    struct SimConfig sim_config = {
        .random_seed = (uint32_t)time(NULL),
        .gravity = Q16_FROM_FLOAT(-9.81f),
        .water_friction = Q16_FROM_FLOAT(0.1f),
        .air_friction = Q16_FROM_FLOAT(0.01f),
        .buoyancy_factor = Q16_FROM_FLOAT(1.0f)
    };
    if (simulation_init(&server->simulation, &sim_config) != 0) {
        log_error("Failed to initialize simulation");
        free(server);
        return -1;
    }
    
    // Initialize network layer (UDP) on port 8081
    if (network_init(&server->network, 8081) != 0) {
        log_error("Failed to initialize network manager");
        simulation_cleanup(&server->simulation);
        free(server);
        return -1;
    }
    
    // Initialize admin server on port 8082
    if (admin_server_init(&server->admin, 8082) != 0) {
        log_error("Failed to initialize admin server");
        network_cleanup(&server->network);
        simulation_cleanup(&server->simulation);
        free(server);
        return -1;
    }
    
    // Initialize WebSocket server on port 8080 (browser clients)
    if (websocket_server_init(8080) != 0) {
        log_error("Failed to initialize WebSocket server");
        admin_server_cleanup(&server->admin);
        network_cleanup(&server->network);
        simulation_cleanup(&server->simulation);
        free(server);
        return -1;
    }
    
    log_info("🚀 Pirate Game Server initialized successfully with Week 3-4 enhancements");
    log_info("⚡ Simulation running at %d Hz (%.3f ms per tick)", 
             TICK_RATE_HZ, (float)TICK_DURATION_MS);
    log_info("⏪ Rewind buffer: %d frames (≥%dms coverage)", 
             REWIND_BUFFER_SIZE, MAX_REWIND_TIME_MS);
    
    printf("\n� ═══════════════════ PIRATE GAME SERVER READY ═══════════════════\n");
    printf("�🌐 WebSocket Server (Browser Clients): ws://localhost:8080\n");
    printf("   → Ready for JavaScript/TypeScript clients\n");
    printf("   → JSON message protocol with UDP compatibility\n");
    printf("📡 UDP Server (Native Clients): udp://localhost:8081\n");
    printf("   → Binary protocol for high-performance clients\n");
    printf("⚙️  Admin Panel: http://localhost:8082\n");
    printf("   → Server statistics and management interface\n");
    printf("═══════════════════════════════════════════════════════════════════\n\n");
    
    *ctx = server;
    return 0;
}

void server_shutdown(struct ServerContext* ctx) {
    if (!ctx) return;
    
    log_info("Shutting down server...");
    
    // Log final statistics
    if (ctx->tick_count > 0) {
        double uptime_sec = (get_time_us() - ctx->start_time_us) / 1000000.0;
        double avg_tick_time_us = (double)ctx->total_tick_time_us / ctx->tick_count;
        
        log_info("Server statistics:");
        log_info("  Uptime: %.1f seconds", uptime_sec);
        log_info("  Total ticks: %lu", ctx->tick_count);
        log_info("  Average tick time: %.1f μs (%.3f ms)", 
                 avg_tick_time_us, avg_tick_time_us / 1000.0);
        log_info("  Max tick time: %lu μs (%.3f ms)", 
                 ctx->max_tick_time_us, ctx->max_tick_time_us / 1000.0);
    }
    
    // Cleanup subsystems
    websocket_server_cleanup();
    admin_server_cleanup(&ctx->admin);
    network_cleanup(&ctx->network);
    simulation_cleanup(&ctx->simulation);
    
    free(ctx);
    log_info("Server shutdown complete");
}

int server_run(struct ServerContext* ctx) {
    if (!ctx) return -1;
    
    log_info("Starting main server loop...");
    
    uint64_t next_tick_time = get_time_us();
    uint32_t ticks_this_second = 0;
    uint32_t last_second = get_time_ms() / 1000;
    
    while (ctx->running) {
        uint64_t tick_start = get_time_us();
        
        // Run one simulation tick
        server_tick(ctx);
        
        // Performance tracking
        uint64_t tick_duration = get_time_us() - tick_start;
        ctx->total_tick_time_us += tick_duration;
        if (tick_duration > ctx->max_tick_time_us) {
            ctx->max_tick_time_us = tick_duration;
        }
        
        // Track ticks per second
        ticks_this_second++;
        uint32_t current_second = get_time_ms() / 1000;
        if (current_second != last_second) {
            ctx->ticks_per_second = ticks_this_second;
            ticks_this_second = 0;
            last_second = current_second;
        }
        
        ctx->tick_count++;
        
        // Sleep until next tick
        next_tick_time += TICK_DURATION_US;
        uint64_t current_time = get_time_us();
        
        if (next_tick_time > current_time) {
            usleep(next_tick_time - current_time);
        } else {
            // We're running behind - log warning
            if (current_time - next_tick_time > TICK_DURATION_US / 2) {
                log_warn("Server running behind schedule by %lu μs", 
                         current_time - next_tick_time);
            }
            next_tick_time = current_time;
        }
        
        // Log statistics periodically
        uint32_t current_time_ms = get_time_ms();
        if (current_time_ms - ctx->last_stats_time > 30000) { // Every 30 seconds
            double avg_tick_time = ctx->tick_count > 0 ? 
                (double)ctx->total_tick_time_us / ctx->tick_count : 0.0;
            
            log_info("Server performance - TPS: %u, Avg tick: %.1f μs, Max tick: %lu μs, "
                     "Total ticks: %lu",
                     ctx->ticks_per_second, avg_tick_time, ctx->max_tick_time_us,
                     ctx->tick_count);
            
            ctx->last_stats_time = current_time_ms;
        }
    }
    
    log_info("Main server loop ended");
    return 0;
}

void server_tick(struct ServerContext* ctx) {
    if (!ctx) return;
    
    uint32_t current_time = get_time_ms();
    
    // Process incoming network messages
    network_process_incoming(&ctx->network, &ctx->simulation);
    
    // Update network systems (reliability, heartbeats, etc.)
    network_update(&ctx->network, current_time);
    
    // Update admin server (handle HTTP requests)
    admin_server_update(&ctx->admin, &ctx->simulation, &ctx->network);
    
    // Update WebSocket server (handle browser clients)
    websocket_server_update(&ctx->simulation);
    
    // Run physics simulation step
    simulation_step(&ctx->simulation);
    
    // Week 3-4: Store simulation state in rewind buffer for lag compensation
    // TODO: Convert actual simulation state to rewind buffer format
    // For now, store NULL to avoid compilation errors
    rewind_buffer_store(&ctx->rewind_buffer, ctx->tick_count, 
                       NULL, ctx->client_network_delays);
    
    // Send snapshots to connected players
    network_send_snapshots(&ctx->network, &ctx->simulation);
    
    // Cleanup rewind buffer periodically (every 60 ticks ≈ 1.3 seconds)
    if (ctx->tick_count % 60 == 0) {
        rewind_buffer_cleanup(&ctx->rewind_buffer, (uint32_t)ctx->tick_count);
        
        // Log rewind buffer statistics periodically
        if (ctx->tick_count % 900 == 0) { // Every 20 seconds
            uint64_t total_rewinds, successful_rewinds;
            float avg_rewind_distance;
            int buffer_utilization;
            
            rewind_buffer_get_stats(&ctx->rewind_buffer, &total_rewinds, 
                                   &successful_rewinds, &avg_rewind_distance, 
                                   &buffer_utilization);
            
            log_info("Rewind buffer stats: %lu/%lu successful rewinds (%.1f%%), "
                     "avg distance: %.1fms, utilization: %d%%",
                     successful_rewinds, total_rewinds,
                     total_rewinds > 0 ? (100.0f * successful_rewinds / total_rewinds) : 0.0f,
                     avg_rewind_distance, buffer_utilization);
        }
    }
    
    // Update admin server (every 5th tick to reduce overhead)
    if (ctx->tick_count % 5 == 0) {
        admin_server_update(&ctx->admin, &ctx->simulation, &ctx->network);
    }
}

bool server_should_run(const struct ServerContext* ctx) {
    return ctx && ctx->running;
}