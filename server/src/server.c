#include "server.h"
#include "sim/types.h"
#include "net/protocol.h"
#include "net/websocket_server.h"
#include "admin/admin_server.h"
#include "input_validation.h"
#include "util/time.h"
#include "util/log.h"
#include "core/rng.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>

// Server context - holds all subsystems
struct ServerContext {
    // Core state
    bool initialized;
    bool should_run;
    
    // Timing
    uint64_t tick_start_time;
    uint32_t current_tick;
    
    // Networking
    int udp_socket;
    struct sockaddr_in server_addr;
    
    // Simulation
    struct Sim simulation;
    
    // Admin server
    struct AdminServer admin_server;
    
    // Input validation system
    input_validator_t input_validator;
    
    // Buffers for packet processing
    uint8_t recv_buffer[MAX_PACKET_SIZE];
    uint8_t send_buffer[MAX_PACKET_SIZE];
    
    // Basic metrics
    uint64_t total_packets_received;
    uint64_t total_packets_sent;
    uint64_t total_bytes_received;
    uint64_t total_bytes_sent;
    
    // Simple player connection tracking
    struct {
        bool connected;
        struct sockaddr_in addr;
        uint32_t last_seen_time;
        uint16_t last_sequence;
    } players[MAX_PLAYERS];
};

// Forward declarations
static int init_networking(struct ServerContext* ctx);
static void process_network_input(struct ServerContext* ctx);
static void send_snapshots(struct ServerContext* ctx);
static void cleanup_networking(struct ServerContext* ctx);
static void init_simulation(struct ServerContext* ctx);
static void step_simulation(struct ServerContext* ctx);

int server_init(struct ServerContext** out_ctx) {
    if (!out_ctx) {
        log_error("Invalid output context pointer");
        return -1;
    }
    
    // Allocate server context
    struct ServerContext* ctx = calloc(1, sizeof(struct ServerContext));
    if (!ctx) {
        log_error("Failed to allocate server context: %s", strerror(errno));
        return -1;
    }
    
    log_info("Initializing server subsystems...");
    
    // Initialize timing utilities
    time_init();
    
    // Initialize networking
    if (init_networking(ctx) != 0) {
        log_error("Failed to initialize networking");
        free(ctx);
        return -1;
    }
    
    // Initialize simulation
    init_simulation(ctx);
    
    // Initialize input validation system
    input_validation_init(&ctx->input_validator);
    log_info("Input validation system initialized");
    
    // Initialize admin server on port 8081
    if (admin_server_init(&ctx->admin_server, 8081) != 0) {
        log_error("Failed to initialize admin server");
        // Don't fail server startup if admin server fails
        log_warn("Admin panel will not be available");
    } else {
        log_info("Admin server initialized on port 8081");
    }
    
    // Initialize WebSocket server on port 8082 (browser clients)
    if (websocket_server_init(8082) != 0) {
        log_error("Failed to initialize WebSocket server");
        cleanup_networking(ctx);
        free(ctx);
        return -1;
    }
    
    // Link WebSocket server to simulation for collision detection
    websocket_server_set_simulation(&ctx->simulation);
    log_info("WebSocket server linked to simulation");
    
    // Mark as initialized
    ctx->initialized = true;
    ctx->should_run = true;
    ctx->tick_start_time = get_time_us();
    
    *out_ctx = ctx;
    
    log_info("Server initialization complete");
    return 0;
}

void server_shutdown(struct ServerContext* ctx) {
    if (!ctx) return;
    
    log_info("Starting server shutdown sequence...");
    
    // Stop main loop
    ctx->should_run = false;
    
    // Save current state for debugging
    log_info("Final tick count: %u", ctx->current_tick);
    log_info("Total packets: RX=%u TX=%u", ctx->total_packets_received, ctx->total_packets_sent);
    log_info("Total bytes: RX=%u TX=%u", ctx->total_bytes_received, ctx->total_bytes_sent);
    
    // Cleanup networking resources first (close sockets)
    cleanup_networking(ctx);
    
    // Cleanup admin server
    admin_server_cleanup(&ctx->admin_server);
    
    // Cleanup WebSocket server
    websocket_server_cleanup();
    
    // Free the context
    free(ctx);
    
    log_info("Server shutdown complete");
}

void server_request_shutdown(struct ServerContext* ctx) {
    if (!ctx) return;
    
    log_info("🛑 Shutdown requested - stopping main loop");
    ctx->should_run = false;
}

int server_run(struct ServerContext* ctx) {
    if (!ctx || !ctx->initialized) {
        log_error("Server not properly initialized");
        return -1;
    }
    
    log_info("Starting main server loop at %d Hz", TICK_RATE_HZ);
    
    uint64_t next_tick_time = ctx->tick_start_time;
    uint32_t shutdown_countdown = 0;
    
    while (ctx->should_run) {
        uint64_t tick_start = get_time_us();
        
        // Process incoming network packets
        process_network_input(ctx);
        
        // Update WebSocket server (process browser client connections)
        websocket_server_update(NULL);  // TODO: pass simulation context if needed
        
        // HYBRID: Apply player movement states (30Hz tick)
        websocket_server_tick(TICK_DURATION_MS / 1000.0f);
        
        // Update admin server (process admin panel requests)
        admin_server_update(&ctx->admin_server, &ctx->simulation, NULL);
        
        // Run physics simulation step
        step_simulation(ctx);
        
        // Send state updates to clients
        send_snapshots(ctx);
        
        // Update tick counter
        ctx->current_tick++;
        
        // Calculate next tick time
        next_tick_time += TICK_DURATION_US;
        
        // Sleep until next tick
        uint64_t tick_end = get_time_us();
        uint64_t tick_duration = tick_end - tick_start;
        
        // Log performance warning if tick took too long
        if (tick_duration > TICK_DURATION_US) {
            log_warn("Tick %u took %lu us (budget: %u us)", 
                     ctx->current_tick, tick_duration, TICK_DURATION_US);
        }
        
        // Check if shutdown was requested
        if (!ctx->should_run) {
            shutdown_countdown++;
            if (shutdown_countdown == 1) {
                log_info("📋 Shutdown initiated - completing current operations...");
            }
            // Allow a few ticks to complete ongoing operations
            if (shutdown_countdown > 3) {
                log_info("⏱️ Shutdown grace period complete");
                break;
            }
        }
        
        // Sleep until next tick boundary
        sleep_until_time(next_tick_time);
    }
    
    log_info("📋 Main server loop exited cleanly after %u ticks", ctx->current_tick);
    return 0;
}

void server_tick(struct ServerContext* ctx) {
    // This function is for external tick-by-tick control
    // The main loop handles ticking internally
    if (!ctx || !ctx->initialized) return;
    
    process_network_input(ctx);
    step_simulation(ctx);
    send_snapshots(ctx);
    ctx->current_tick++;
}

bool server_should_run(const struct ServerContext* ctx) {
    return ctx && ctx->should_run;
}

// Networking implementation
static int init_networking(struct ServerContext* ctx) {
    // Create UDP socket
    ctx->udp_socket = socket(AF_INET, SOCK_DGRAM, 0);
    if (ctx->udp_socket < 0) {
        log_error("Failed to create UDP socket: %s", strerror(errno));
        return -1;
    }
    
    // Set socket to non-blocking
    int flags = fcntl(ctx->udp_socket, F_GETFL, 0);
    if (fcntl(ctx->udp_socket, F_SETFL, flags | O_NONBLOCK) < 0) {
        log_error("Failed to set socket non-blocking: %s", strerror(errno));
        close(ctx->udp_socket);
        return -1;
    }
    
    // Bind to port
    memset(&ctx->server_addr, 0, sizeof(ctx->server_addr));
    ctx->server_addr.sin_family = AF_INET;
    ctx->server_addr.sin_addr.s_addr = INADDR_ANY;
    ctx->server_addr.sin_port = htons(8080);  // UDP on port 8080 (WebSocket uses 8082)
    
    if (bind(ctx->udp_socket, (struct sockaddr*)&ctx->server_addr, 
             sizeof(ctx->server_addr)) < 0) {
        log_error("Failed to bind socket: %s", strerror(errno));
        close(ctx->udp_socket);
        return -1;
    }
    
    log_info("UDP socket bound to port 8080");
    return 0;
}

static void cleanup_networking(struct ServerContext* ctx) {
    if (ctx->udp_socket >= 0) {
        close(ctx->udp_socket);
        ctx->udp_socket = -1;
    }
}

static void process_network_input(struct ServerContext* ctx) {
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    
    // Process all available packets
    while (true) {
        ssize_t bytes_received = recvfrom(ctx->udp_socket, ctx->recv_buffer, 
                                         MAX_PACKET_SIZE, 0,
                                         (struct sockaddr*)&client_addr, &addr_len);
        
        if (bytes_received < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // No more packets available
                break;
            }
            log_error("Error receiving packet: %s", strerror(errno));
            break;
        }
        
        if (bytes_received == 0) {
            continue; // Empty packet
        }
        
        // Update statistics
        ctx->total_packets_received++;
        ctx->total_bytes_received += bytes_received;
        
        // Basic packet validation
        if (bytes_received < 2) {
            log_warn("Received undersized packet (%zd bytes)", bytes_received);
            continue;
        }
        
        uint8_t packet_type = ctx->recv_buffer[0];
        uint8_t version = ctx->recv_buffer[1];
        
        if (version != PROTOCOL_VERSION) {
            log_warn("Received packet with wrong version: %u", version);
            continue;
        }
        
        // Process based on packet type
        switch (packet_type) {
            case PACKET_CLIENT_HANDSHAKE:
                log_info("Received handshake from %s:%d", 
                         inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
                // TODO: Handle client connection
                break;
                
            case PACKET_CLIENT_INPUT:
                if (bytes_received >= (ssize_t)sizeof(struct CmdPacket)) {
                    // TODO: Process input command
                    // struct CmdPacket* cmd = (struct CmdPacket*)ctx->recv_buffer;
                }
                break;
                
            default:
                log_warn("Unknown packet type: %u", packet_type);
                break;
        }
    }
}

static void send_snapshots(struct ServerContext* ctx) {
    // TODO: Generate and send snapshot packets to connected clients
    // For now, just increment sent packet counter to track activity
    
    // This is a placeholder - would normally:
    // 1. Generate snapshot data from simulation state
    // 2. Apply delta compression
    // 3. Send to each connected client based on AOI
    
    static uint32_t last_snapshot_tick = 0;
    uint32_t snapshot_interval = TICK_RATE_HZ / 20; // 20 Hz snapshots
    
    if (ctx->current_tick - last_snapshot_tick >= snapshot_interval) {
        // Placeholder: just update statistics
        ctx->total_packets_sent++;
        ctx->total_bytes_sent += 64; // Estimated snapshot size
        last_snapshot_tick = ctx->current_tick;
    }
}

static void init_simulation(struct ServerContext* ctx) {
    // Initialize simulation state
    memset(&ctx->simulation, 0, sizeof(ctx->simulation));
    
    // Seed RNG with current time (deterministic seed would come from config)
    struct RNGState* rng = &ctx->simulation.rng;
    rng_seed(rng, (uint32_t)time(NULL));
    
    // Initialize physics constants
    ctx->simulation.water_friction = Q16_FROM_FLOAT(0.95f);
    ctx->simulation.air_friction = Q16_FROM_FLOAT(0.99f);  
    ctx->simulation.buoyancy_factor = Q16_FROM_FLOAT(1.2f);
    
    log_info("Simulation initialized with RNG seed: %u", rng->seed);
}

static void step_simulation(struct ServerContext* ctx) {
    struct Sim* sim = &ctx->simulation;
    
    // Update simulation tick
    sim->tick = ctx->current_tick;
    sim->time_ms = ctx->current_tick * TICK_DURATION_MS;
    
    // TODO: Implement full physics simulation
    // This is a placeholder that would include:
    // 1. Process player input commands
    // 2. Update ship physics (forces, collisions)
    // 3. Update projectile physics  
    // 4. Handle game events (combat, interactions)
    // 5. Update spatial acceleration structures
    
    // For now, just demonstrate deterministic behavior
    uint32_t random_val = rng_next(&sim->rng);
    (void)random_val; // Suppress unused warning
}