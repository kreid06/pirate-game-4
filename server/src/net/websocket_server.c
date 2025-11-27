#include "net/websocket_server.h"
#include "net/websocket_protocol.h"
#include "net/network.h"
#include "sim/simulation.h"
#include "core/math.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#define _USE_MATH_DEFINES
#include <math.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <openssl/sha.h>
#include <openssl/evp.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>

// Include shared ship definitions from protocol folder
#include "../../protocol/ship_definitions.h"

// Define M_PI if not available
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// WebSocket magic key for handshake
#define WS_MAGIC_KEY "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define WS_MAX_CLIENTS 100

// WebSocket opcodes
#define WS_OPCODE_CONTINUATION 0x0
#define WS_OPCODE_TEXT 0x1
#define WS_OPCODE_BINARY 0x2
#define WS_OPCODE_CLOSE 0x8
#define WS_OPCODE_PING 0x9
#define WS_OPCODE_PONG 0xA

// Simple player data structure for movement
// (Definition in websocket_server.h)

struct WebSocketClient {
    int fd;
    bool connected;
    bool handshake_complete;
    uint32_t last_ping_time;
    char ip_address[INET_ADDRSTRLEN];
    uint16_t port;
    uint32_t player_id; // Associated player ID
};

struct WebSocketServer {
    int socket_fd;
    uint16_t port;
    bool running;
    struct WebSocketClient clients[WS_MAX_CLIENTS];
    int client_count;
    uint64_t packets_sent;
    uint64_t packets_received;
    uint64_t input_messages_received;
    uint64_t unknown_messages_received;
    uint32_t last_input_time;
    uint32_t last_unknown_time;
};

static struct WebSocketServer ws_server = {0};

// Global simulation pointer for player collision detection
static struct Sim* global_sim = NULL;

// Helper function to get movement state string
static const char* get_state_string(PlayerMovementState state) {
    switch (state) {
        case PLAYER_STATE_WALKING: return "WALKING";
        case PLAYER_STATE_SWIMMING: return "SWIMMING";
        case PLAYER_STATE_FALLING: return "FALLING";
        default: return "UNKNOWN";
    }
}

// Global player data for simple movement tracking
static WebSocketPlayer players[WS_MAX_CLIENTS] = {0};
static int next_player_id = 1000;

// Global ship data (simple ships for testing)
#define MAX_SIMPLE_SHIPS 16
static SimpleShip ships[MAX_SIMPLE_SHIPS] = {0};
static int ship_count = 0;
static int next_ship_id = 1;

// Helper function to find a ship by ID
static SimpleShip* find_ship(uint32_t ship_id) {
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active && ships[i].ship_id == ship_id) {
            return &ships[i];
        }
    }
    return NULL;
}

// Coordinate conversion helpers
static void ship_local_to_world(const SimpleShip* ship, float local_x, float local_y, float* world_x, float* world_y) {
    float cos_r = cosf(ship->rotation);
    float sin_r = sinf(ship->rotation);
    *world_x = ship->x + (local_x * cos_r - local_y * sin_r);
    *world_y = ship->y + (local_x * sin_r + local_y * cos_r);
}

// Update world positions of all players mounted to this ship
static void update_mounted_players_on_ship(uint32_t ship_id) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return;
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].is_mounted && players[i].parent_ship_id == ship_id) {
            // Update player's world position based on their local position and ship transform
            ship_local_to_world(ship, players[i].local_x, players[i].local_y, 
                              &players[i].x, &players[i].y);
        }
    }
}

// Sync SimpleShip state from simulation ships (position, rotation, velocity)
static void sync_simple_ships_from_simulation(void) {
    if (!global_sim || global_sim->ship_count == 0) return;
    
    for (int s = 0; s < ship_count; s++) {
        if (!ships[s].active) continue;
        
        // Find matching simulation ship by ID
        for (uint32_t sim_idx = 0; sim_idx < global_sim->ship_count; sim_idx++) {
            if (global_sim->ships[sim_idx].id == ships[s].ship_id) {
                struct Ship* sim_ship = &global_sim->ships[sim_idx];
                
                // Sync position, rotation, velocity from simulation to SimpleShip
                ships[s].x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->position.x));
                ships[s].y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->position.y));
                ships[s].rotation = Q16_TO_FLOAT(sim_ship->rotation);
                ships[s].velocity_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->velocity.x));
                ships[s].velocity_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->velocity.y));
                ships[s].angular_velocity = Q16_TO_FLOAT(sim_ship->angular_velocity);
                
                // Update mounted players' world positions with new ship transform
                update_mounted_players_on_ship(ships[s].ship_id);
                break;
            }
        }
    }
}

static void ship_clamp_to_deck(const SimpleShip* ship, float* local_x, float* local_y) {
    if (*local_x < ship->deck_min_x) *local_x = ship->deck_min_x;
    if (*local_x > ship->deck_max_x) *local_x = ship->deck_max_x;
    if (*local_y < ship->deck_min_y) *local_y = ship->deck_min_y;
    if (*local_y > ship->deck_max_y) *local_y = ship->deck_max_y;
}

// Helper to convert world coordinates to ship-local coordinates
static void ship_world_to_local(const SimpleShip* ship, float world_x, float world_y, float* local_x, float* local_y) {
    float dx = world_x - ship->x;
    float dy = world_y - ship->y;
    float cos_r = cosf(-ship->rotation);
    float sin_r = sinf(-ship->rotation);
    *local_x = dx * cos_r - dy * sin_r;
    *local_y = dx * sin_r + dy * cos_r;
}

// Helper to check if player is outside hull polygon (using simulation ship hull)
static bool is_outside_deck(uint32_t ship_id, float local_x, float local_y) {
    if (!global_sim) {
        return false; // No simulation, can't check
    }
    
    // Find the ship in the simulation
    struct Ship* sim_ship = NULL;
    for (uint16_t i = 0; i < global_sim->ship_count; i++) {
        if (global_sim->ships[i].id == ship_id) {
            sim_ship = &global_sim->ships[i];
            break;
        }
    }
    
    if (!sim_ship || sim_ship->hull_vertex_count < 3) {
        return false; // No hull to check against
    }
    
    // Convert client local coordinates to server coordinates for comparison
    Vec2Q16 point = {
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x)),
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y))
    };
    
    // Point-in-polygon test using ray casting algorithm
    bool inside = false;
    uint8_t vertex_count = sim_ship->hull_vertex_count;
    
    for (uint8_t i = 0, j = vertex_count - 1; i < vertex_count; j = i++) {
        Vec2Q16 vi = sim_ship->hull_vertices[i];
        Vec2Q16 vj = sim_ship->hull_vertices[j];
        
        // Check if point is between the y-coordinates of the edge
        if (((vi.y > point.y) != (vj.y > point.y))) {
            // Calculate the x-coordinate where the ray intersects the edge
            q16_t slope = q16_div(vj.x - vi.x, vj.y - vi.y);
            q16_t x_intersect = vi.x + q16_mul(slope, point.y - vi.y);
            
            if (point.x < x_intersect) {
                inside = !inside;
            }
        }
    }
    
    return !inside; // Return true if OUTSIDE
}

// Helper to board a player onto a ship
static void board_player_on_ship(WebSocketPlayer* player, SimpleShip* ship, float local_x, float local_y) {
    player->parent_ship_id = ship->ship_id;
    player->local_x = local_x;
    player->local_y = local_y;
    player->movement_state = PLAYER_STATE_WALKING;
    
    // Update world position to match ship
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);
    
    // Inherit ship velocity
    player->velocity_x = ship->velocity_x;
    player->velocity_y = ship->velocity_y;
    
    log_info("⚓ Player %u boarded ship %u at local (%.1f, %.1f)", 
             player->player_id, ship->ship_id, player->local_x, player->local_y);
}

// Helper to dismount a player from a ship (into water)
static void dismount_player_from_ship(WebSocketPlayer* player, const char* reason) {
    if (player->parent_ship_id == 0) {
        return; // Already in water
    }
    
    log_info("🌊 Player %u dismounting from ship %u (reason: %s)", 
             player->player_id, player->parent_ship_id, reason);
    
    // Keep current world position but clear ship reference
    player->parent_ship_id = 0;
    player->local_x = 0.0f;
    player->local_y = 0.0f;
    player->movement_state = PLAYER_STATE_SWIMMING;
    
    // Keep some of the ship's velocity (player carries momentum)
    player->velocity_x *= 0.5f;
    player->velocity_y *= 0.5f;
    
    // Clear mounted state if player was on a module
    if (player->is_mounted) {
        player->is_mounted = false;
        player->mounted_module_id = 0;
        player->controlling_ship_id = 0;
    }
}

// Base64 encoding for WebSocket handshake
static char* base64_encode(const unsigned char* input, int length) {
    BIO *bio, *b64;
    BUF_MEM *buffer_ptr;
    
    b64 = BIO_new(BIO_f_base64());
    bio = BIO_new(BIO_s_mem());
    bio = BIO_push(b64, bio);
    
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(bio, input, length);
    BIO_flush(bio);
    BIO_get_mem_ptr(bio, &buffer_ptr);
    
    char* result = malloc(buffer_ptr->length + 1);
    memcpy(result, buffer_ptr->data, buffer_ptr->length);
    result[buffer_ptr->length] = '\0';
    
    BIO_free_all(bio);
    return result;
}

// WebSocket handshake
static bool websocket_handshake(int client_fd, const char* request) {
    size_t request_len = strlen(request);
    log_info("🤝 Starting WebSocket handshake, request length: %zu bytes", request_len);
    
    // Log raw bytes for debugging if request is suspiciously short
    if (request_len < 20) {
        log_error("⚠️ Request too short (%zu bytes) for HTTP handshake. Raw bytes (hex):", request_len);
        for (size_t i = 0; i < request_len && i < 50; i++) {
            fprintf(stderr, "%02X ", (unsigned char)request[i]);
        }
        fprintf(stderr, "\n");
        log_debug("ASCII representation: '%s'", request);
        return false;
    }
    
    // Log first line of request for debugging
    const char* first_line_end = strstr(request, "\r\n");
    if (first_line_end) {
        size_t first_line_len = first_line_end - request;
        char first_line[256];
        size_t copy_len = (first_line_len < sizeof(first_line) - 1) ? first_line_len : sizeof(first_line) - 1;
        memcpy(first_line, request, copy_len);
        first_line[copy_len] = '\0';
        log_debug("📋 Request first line: '%s'", first_line);
    }
    
    // Check for WebSocket upgrade request - must be GET
    if (!strstr(request, "GET ")) {
        log_error("❌ Handshake failed: Not a GET request (might be POST/OPTIONS or non-HTTP data)");
        log_debug("First 100 chars of request: '%.100s'", request);
        return false;
    }
    
    if (!strstr(request, "Upgrade: websocket") && !strstr(request, "Upgrade: WebSocket")) {
        log_error("❌ Handshake failed: Missing 'Upgrade: websocket' header");
        return false;
    }
    
    char* key_start = strstr(request, "Sec-WebSocket-Key: ");
    if (!key_start) {
        log_error("❌ Handshake failed: Missing 'Sec-WebSocket-Key' header");
        log_debug("Request headers:\n%s", request);
        return false;
    }
    
    key_start += 19; // Length of "Sec-WebSocket-Key: "
    char* key_end = strstr(key_start, "\r\n");
    if (!key_end) {
        log_error("❌ Handshake failed: Malformed Sec-WebSocket-Key (no CRLF)");
        return false;
    }
    
    size_t key_len = key_end - key_start;
    if (key_len == 0 || key_len > 255) {
        log_error("❌ Handshake failed: Invalid key length: %zu", key_len);
        return false;
    }
    
    char key[256];
    memcpy(key, key_start, key_len);
    key[key_len] = '\0';
    
    log_debug("📋 Extracted WebSocket key: '%s' (length: %zu)", key, key_len);
    
    // Create accept key
    char accept_input[512];
    snprintf(accept_input, sizeof(accept_input), "%s%s", key, WS_MAGIC_KEY);
    
    unsigned char hash[SHA_DIGEST_LENGTH];
    SHA1((unsigned char*)accept_input, strlen(accept_input), hash);
    
    char* accept_key = base64_encode(hash, SHA_DIGEST_LENGTH);
    if (!accept_key) {
        log_error("❌ Handshake failed: base64_encode returned NULL");
        return false;
    }
    
    log_debug("🔑 Computed Sec-WebSocket-Accept: '%s'", accept_key);
    
    // Send handshake response
    char response[1024];
    int response_len = snprintf(response, sizeof(response),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n",
        accept_key);
    
    if (response_len < 0 || response_len >= (int)sizeof(response)) {
        log_error("❌ Handshake failed: Response buffer overflow");
        free(accept_key);
        return false;
    }
    
    log_debug("📤 Sending handshake response (%d bytes)", response_len);
    
    ssize_t sent = send(client_fd, response, strlen(response), 0);
    free(accept_key);
    
    if (sent <= 0) {
        log_error("❌ Handshake failed: send() returned %zd, errno: %d (%s)", 
                  sent, errno, strerror(errno));
        return false;
    }
    
    if (sent != response_len) {
        log_warn("⚠️ Handshake partial send: %zd/%d bytes", sent, response_len);
    }
    
    log_info("✅ WebSocket handshake completed successfully (%zd bytes sent)", sent);
    return true;
}

// Parse WebSocket frame
// Forward declarations
static WebSocketPlayer* find_player(uint32_t player_id);
static WebSocketPlayer* create_player(uint32_t player_id);
static void remove_player(uint32_t player_id);

// Player management functions
static WebSocketPlayer* find_player(uint32_t player_id) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].player_id == player_id) {
            return &players[i];
        }
    }
    return NULL;
}

static WebSocketPlayer* find_player_by_sim_id(uint32_t sim_entity_id) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].sim_entity_id == sim_entity_id) {
            return &players[i];
        }
    }
    return NULL;
}

static WebSocketPlayer* create_player(uint32_t player_id) {
    // Check if player already exists
    WebSocketPlayer* existing = find_player(player_id);
    if (existing) {
        log_warn("Player %u already exists, reusing existing player", player_id);
        return existing;
    }
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (!players[i].active) {
            // Clear the player structure first
            memset(&players[i], 0, sizeof(WebSocketPlayer));
            
            players[i].player_id = player_id;
            players[i].sim_entity_id = 0; // Will be set when added to simulation
            
            // Spawn player in water well above the ship for testing collision
            players[i].parent_ship_id = 0;
            players[i].x = 100.0f;  // Directly above the ship at (100, 100) in client coords
            players[i].y = 600.0f;  // 500 units above in client coords
            players[i].local_x = 0.0f;
            players[i].local_y = 0.0f;
            players[i].movement_state = PLAYER_STATE_SWIMMING;
            
            // ===== ADD PLAYER TO C SIMULATION FOR COLLISION DETECTION =====
            if (global_sim) {
                Vec2Q16 spawn_pos = {
                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(players[i].x)),
                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(players[i].y))
                };
                entity_id sim_player_id = sim_create_player(global_sim, spawn_pos, 0);
                if (sim_player_id != INVALID_ENTITY_ID) {
                    players[i].sim_entity_id = sim_player_id;
                    log_info("✅ Player %u added to simulation (sim_entity_id: %u)", player_id, sim_player_id);
                } else {
                    log_warn("❌ Failed to add player %u to simulation", player_id);
                }
            }
            
            // Player spawned in water
            
            /* Original ship spawn code - commented out for swimming tests
            // Spawn player on the first ship if it exists
            if (ship_count > 0 && ships[0].active) {
                players[i].parent_ship_id = ships[0].ship_id;
                players[i].local_x = 0.0f;  // Center of ship deck
                players[i].local_y = 0.0f;
                players[i].movement_state = PLAYER_STATE_WALKING;
                
                // Calculate world position from ship position
                ship_local_to_world(&ships[0], players[i].local_x, players[i].local_y, 
                                   &players[i].x, &players[i].y);
                
                log_info("🎮 Spawned player %u on ship %u at local (%.1f, %.1f), world (%.1f, %.1f)", 
                         player_id, ships[0].ship_id, players[i].local_x, players[i].local_y,
                         players[i].x, players[i].y);
            } else {
                // No ship available - spawn in water at origin
                players[i].parent_ship_id = 0;
                players[i].x = 0.0f;
                players[i].y = 0.0f;
                players[i].local_x = 0.0f;
                players[i].local_y = 0.0f;
                players[i].movement_state = PLAYER_STATE_SWIMMING;
                
                log_info("🎮 Spawned player %u in water at (%.1f, %.1f)", 
                         player_id, players[i].x, players[i].y);
            }
            */
            
            players[i].velocity_x = 0.0f;
            players[i].velocity_y = 0.0f;
            players[i].rotation = 0.0f;
            
            // Initialize hybrid input system fields
            players[i].movement_direction_x = 0.0f;
            players[i].movement_direction_y = 0.0f;
            players[i].is_moving = false;
            players[i].last_rotation = 0.0f;
            players[i].last_rotation_update_time = get_time_ms();
            
            players[i].last_input_time = get_time_ms();
            players[i].active = true;
            
            // Initialize module interaction state
            players[i].is_mounted = false;
            players[i].mounted_module_id = 0;
            players[i].controlling_ship_id = 0;
            
            return &players[i];
        }
    }
    return NULL;
}

static void remove_player(uint32_t player_id) {
    if (player_id == 0) {
        log_warn("Attempted to remove player with invalid ID 0");
        return;
    }
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].player_id == player_id) {
            // Clear the entire player structure
            memset(&players[i], 0, sizeof(WebSocketPlayer));
            log_info("🎮 Removed player %u", player_id);
            return;
        }
    }
    log_warn("Attempted to remove non-existent player %u", player_id);
}

// ============================================================================
// MODULE INTERACTION SYSTEM
// ============================================================================

/**
 * Get human-readable module type name
 */
static const char* get_module_type_name(ModuleTypeId type_id) {
    switch (type_id) {
        case MODULE_TYPE_CANNON: return "CANNON";
        case MODULE_TYPE_HELM: return "HELM";
        case MODULE_TYPE_MAST: return "MAST";
        case MODULE_TYPE_LADDER: return "LADDER";
        case MODULE_TYPE_SEAT: return "SEAT";
        case MODULE_TYPE_PLANK: return "PLANK";
        case MODULE_TYPE_DECK: return "DECK";
        case MODULE_TYPE_STEERING_WHEEL: return "STEERING_WHEEL";
        default: return "UNKNOWN";
    }
}

/**
 * Find ship by ID
 */
static SimpleShip* find_ship_by_id(uint32_t ship_id) {
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active && ships[i].ship_id == ship_id) {
            return &ships[i];
        }
    }
    return NULL;
}

/**
 * Find module by ID on a ship
 */
static ShipModule* find_module_by_id(SimpleShip* ship, uint32_t module_id) {
    if (!ship) return NULL;
    
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].id == module_id) {
            return &ship->modules[i];
        }
    }
    return NULL;
}

/**
 * Send interaction failure to client
 */
static void send_interaction_failure(struct WebSocketClient* client, const char* reason) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_failure\",\"reason\":\"%s\"}",
             reason);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Send mount success to client
 */
static void send_mount_success(struct WebSocketClient* client, ShipModule* module) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"module_id\":%u,\"module_kind\":\"%s\",\"mounted\":true}",
             module->id, get_module_type_name(module->type_id));
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Send interaction success (non-mounting actions)
 */
static void send_interaction_success(struct WebSocketClient* client, const char* action) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"action\":\"%s\"}",
             action);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Broadcast player mounted state to nearby players
 */
static void broadcast_player_mounted(WebSocketPlayer* player, ShipModule* module, SimpleShip* ship) {
    char message[512];
    snprintf(message, sizeof(message),
             "{\"type\":\"player_mounted\",\"player_id\":%u,\"module_id\":%u,\"ship_id\":%u}",
             player->player_id, module->id, ship->ship_id);
    
    // Broadcast to all connected clients
    // TODO: Optimize to only send to nearby players
    websocket_server_broadcast(message);
}

// Module-specific interaction handlers
static void handle_cannon_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Check if cannon is already occupied
    if (module->data.cannon.ammunition > 0 && module->state_bits & MODULE_STATE_OCCUPIED) {
        uint16_t occupier_id = 0; // TODO: Track which player occupies
        if (occupier_id != 0 && occupier_id != player->player_id) {
            log_info("Cannon %u already occupied by player %u", module->id, occupier_id);
            send_interaction_failure(client, "module_occupied");
            return;
        }
    }
    
    // Mount player to cannon
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;
    
    log_info("🎯 Player %u mounted to cannon %u", player->player_id, module->id);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
}

static void handle_helm_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    log_info("🎮 handle_helm_interact called for player %u, module %u", player->player_id, module->id);
    
    // Check if helm is occupied
    if (module->data.helm.occupied_by != 0 && module->data.helm.occupied_by != player->player_id) {
        log_info("Helm %u already occupied by player %u", module->id, module->data.helm.occupied_by);
        send_interaction_failure(client, "module_occupied");
        return;
    }
    
    // Mount player and grant ship control
    module->data.helm.occupied_by = player->player_id;
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;
    player->controlling_ship_id = ship->ship_id;
    
    // Position player at mounted location relative to helm
    // Helm mounted position: x:-10, y:0 in client coordinates
    const float HELM_MOUNT_OFFSET_X = -10.0f;
    const float HELM_MOUNT_OFFSET_Y = 0.0f;
    
    // Calculate player's local position as helm position + offset
    // Convert module position from server Q16 to client coordinates
    float helm_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float helm_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    player->local_x = helm_local_x + HELM_MOUNT_OFFSET_X;
    player->local_y = helm_local_y + HELM_MOUNT_OFFSET_Y;
    
    // Update world position based on ship transform
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);
    
    log_info("⚓ Player %u mounted to helm %u at local (%.1f, %.1f), controlling ship %u", 
             player->player_id, module->id, player->local_x, player->local_y, ship->ship_id);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
}

static void handle_mast_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Toggle sail state (raised/lowered)
    if (module->state_bits & MODULE_STATE_DEPLOYED) {
        module->state_bits &= ~MODULE_STATE_DEPLOYED;
        module->data.mast.openness = 0;
        log_info("⛵ Player %u furled mast %u sail", player->player_id, module->id);
    } else {
        module->state_bits |= MODULE_STATE_DEPLOYED;
        module->data.mast.openness = 100;
        log_info("⛵ Player %u deployed mast %u sail", player->player_id, module->id);
    }
    
    send_interaction_success(client, "sail_toggled");
    
    // Broadcast sail state change
    char message[256];
    snprintf(message, sizeof(message),
             "{\"type\":\"sail_state\",\"ship_id\":%u,\"module_id\":%u,\"deployed\":%s}",
             ship->ship_id, module->id, (module->state_bits & MODULE_STATE_DEPLOYED) ? "true" : "false");
    websocket_server_broadcast(message);
}

static void handle_ladder_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Check if player is already on this ship
    if (player->parent_ship_id == ship->ship_id) {
        log_info("🪜 Player %u already on ship %u, no need to board", player->player_id, ship->ship_id);
        send_interaction_success(client, "already_aboard");
        return;
    }
    
    // Player is swimming - board them onto the ship at the ladder position
    if (player->parent_ship_id == 0) {
        // Get ladder position in ship-local coordinates (convert from server to client)
        float ladder_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float ladder_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        
        // Board player at ladder position (or nearby safe spot)
        board_player_on_ship(player, ship, ladder_local_x, ladder_local_y);
        
        log_info("🪜 Player %u boarded ship %u via ladder %u", 
                 player->player_id, ship->ship_id, module->id);
        
        // Send success response
        char response[256];
        snprintf(response, sizeof(response),
                 "{\"type\":\"player_boarded\",\"ship_id\":%u,\"state\":\"walking\"}",
                 ship->ship_id);
        
        char frame[512];
        size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
        if (frame_len > 0) {
            send(client->fd, frame, frame_len, 0);
        }
        
        // Broadcast boarding event to all players
        char broadcast[256];
        snprintf(broadcast, sizeof(broadcast),
                 "{\"type\":\"player_state_changed\",\"player_id\":%u,\"state\":\"walking\",\"ship_id\":%u}",
                 player->player_id, ship->ship_id);
        websocket_server_broadcast(broadcast);
    } else {
        // Player is on a different ship - transfer them
        log_info("🪜 Player %u transferring from ship %u to ship %u via ladder",
                 player->player_id, player->parent_ship_id, ship->ship_id);
        
        float ladder_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float ladder_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        
        board_player_on_ship(player, ship, ladder_local_x, ladder_local_y);
        send_interaction_success(client, "ship_transfer");
    }
}

static void handle_seat_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Check if seat is occupied
    if (module->data.seat.occupied_by != 0 && module->data.seat.occupied_by != player->player_id) {
        send_interaction_failure(client, "module_occupied");
        return;
    }
    
    module->data.seat.occupied_by = player->player_id;
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;
    
    log_info("💺 Player %u seated at %u", player->player_id, module->id);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
}

/**
 * Handle module unmount request from client
 */
static void handle_module_unmount(WebSocketPlayer* player, struct WebSocketClient* client) {
    if (!player->is_mounted) {
        log_warn("Player %u tried to unmount but is not mounted", player->player_id);
        send_interaction_failure(client, "not_mounted");
        return;
    }
    
    // Find the module and ship
    SimpleShip* target_ship = NULL;
    ShipModule* module = NULL;
    
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active) {
            ShipModule* found_module = find_module_by_id(&ships[i], player->mounted_module_id);
            if (found_module) {
                target_ship = &ships[i];
                module = found_module;
                break;
            }
        }
    }
    
    if (module && target_ship) {
        // Clear module occupation
        switch (module->type_id) {
            case MODULE_TYPE_CANNON:
                // Cannons just use the OCCUPIED state bit
                module->state_bits &= ~MODULE_STATE_OCCUPIED;
                break;
            case MODULE_TYPE_HELM:
            case MODULE_TYPE_STEERING_WHEEL:
                module->data.helm.occupied_by = 0;
                player->controlling_ship_id = 0;
                break;
            case MODULE_TYPE_SEAT:
                module->data.seat.occupied_by = 0;
                break;
            default:
                module->state_bits &= ~MODULE_STATE_OCCUPIED;
                break;
        }
        
        log_info("🔓 Player %u unmounted from %s (ID: %u)", 
                 player->player_id, get_module_type_name(module->type_id), module->id);
    }
    
    // Clear player mount state
    player->is_mounted = false;
    player->mounted_module_id = 0;
    
    // Send success response
    send_interaction_success(client, "unmounted");
    
    // Broadcast unmount event
    char broadcast[512];
    snprintf(broadcast, sizeof(broadcast),
             "{\"type\":\"player_unmounted\",\"player_id\":%u}",
             player->player_id);
    websocket_server_broadcast(broadcast);
}

// ============================================================================
// SHIP CONTROL HANDLERS
// ============================================================================

/**
 * Handle sail openness control from helm-mounted player
 * Sets the desired openness - actual openness will gradually adjust in tick
 */
static void handle_ship_sail_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, int desired_openness) {
    if (desired_openness < 0) desired_openness = 0;
    if (desired_openness > 100) desired_openness = 100;
    
    log_info("⛵ Player %u setting desired sail openness on ship %u: %d%%", player->player_id, ship->ship_id, desired_openness);
    
    // Store desired openness in simulation ship (the source of truth for broadcasts)
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                global_sim->ships[s].desired_sail_openness = (uint8_t)desired_openness;
                break;
            }
        }
    }
    
    // Also store in simple ship for compatibility
    ship->desired_sail_openness = (uint8_t)desired_openness;
    
    // Send acknowledgment
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"ship_control_ack\",\"control\":\"sail\",\"value\":%d}",
             desired_openness);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Handle rudder control from helm-mounted player
 * Sets target rudder angle - actual angle will gradually adjust in tick
 */
static void handle_ship_rudder_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, bool turning_left, bool turning_right) {
    const char* direction = "STRAIGHT";
    float target_angle = 0.0f;
    
    if (turning_left && !turning_right) {
        direction = "LEFT";
        target_angle = -50.0f;  // Max left rudder angle
    } else if (turning_right && !turning_left) {
        direction = "RIGHT";
        target_angle = 50.0f;   // Max right rudder angle
    } else {
        direction = "STRAIGHT";
        target_angle = 0.0f;    // Center rudder
    }
    
    log_info("🚢 Player %u rudder control on ship %u: %s (target: %.1f°)", 
             player->player_id, ship->ship_id, direction, target_angle);
    
    // Update simulation ship target rudder angle
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                global_sim->ships[s].target_rudder_angle = target_angle;
                break;
            }
        }
    }
    
    // Send acknowledgment
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"ship_control_ack\",\"control\":\"rudder\",\"direction\":\"%s\"}",
             direction);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Handle sail angle control from helm-mounted player
 */
static void handle_ship_sail_angle_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, float desired_angle) {
    // Clamp to range -60 to +60 degrees
    if (desired_angle < -60.0f) desired_angle = -60.0f;
    if (desired_angle > 60.0f) desired_angle = 60.0f;
    
    log_info("🌀 Player %u adjusting sail angle on ship %u: %.1f°", player->player_id, ship->ship_id, desired_angle);
    
    // Convert to radians for Q16 storage
    float angle_radians = desired_angle * (3.14159f / 180.0f);
    q16_t angle_q16 = Q16_FROM_FLOAT(angle_radians);
    
    // Update simulation ship masts (the ones we broadcast to clients)
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                struct Ship* sim_ship = &global_sim->ships[s];
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    if (sim_ship->modules[m].type_id == MODULE_TYPE_MAST) {
                        sim_ship->modules[m].data.mast.angle = angle_q16;
                        log_info("  🌀 Mast %u angle set to %.1f° (%.3f rad)", 
                                 sim_ship->modules[m].id, desired_angle, angle_radians);
                    }
                }
                break;
            }
        }
    }
    
    // Also update SimpleShip for compatibility
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].type_id == MODULE_TYPE_MAST) {
            ship->modules[i].data.mast.angle = angle_q16;
        }
    }
    
    // Send acknowledgment
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"ship_control_ack\",\"control\":\"sail_angle\",\"value\":%.1f}",
             desired_angle);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

// ============================================================================
// CANNON CONTROL HANDLERS
// ============================================================================

// Forward declarations
static void broadcast_cannon_fire(uint32_t cannon_id, uint32_t ship_id, float world_x, float world_y, 
                                  float angle, entity_id projectile_id);

/**
 * Handle cannon aim from player
 * Updates player's aim angle and cannon aim_direction for all cannons within range
 */
static void handle_cannon_aim(WebSocketPlayer* player, float aim_angle) {
    if (player->parent_ship_id == 0) {
        return; // Player not on a ship
    }
    
    // Store world aim angle
    player->cannon_aim_angle = aim_angle;
    
    // Convert to ship-relative angle
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;
    
    player->cannon_aim_angle_relative = aim_angle - ship->rotation;
    
    // Normalize to -PI to +PI range
    while (player->cannon_aim_angle_relative > M_PI) player->cannon_aim_angle_relative -= 2.0f * M_PI;
    while (player->cannon_aim_angle_relative < -M_PI) player->cannon_aim_angle_relative += 2.0f * M_PI;
    
    // Update cannon aim_direction for all cannons within ±30° range
    const float CANNON_AIM_RANGE = 30.0f * (M_PI / 180.0f); // ±30 degrees
    
    // Get simulation ship to update cannon modules
    struct Ship* sim_ship = NULL;
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                sim_ship = &global_sim->ships[s];
                break;
            }
        }
    }
    
    if (!sim_ship) return;
    
    // Update each cannon's aim_direction if it can reach the player's target
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        if (sim_ship->modules[m].type_id != MODULE_TYPE_CANNON) continue;
        
        ShipModule* cannon = &sim_ship->modules[m];
        float cannon_base_angle = Q16_TO_FLOAT(cannon->local_rot); // Base rotation relative to ship
        
        // Calculate desired aim offset (player's aim - cannon's base)
        float desired_offset = player->cannon_aim_angle_relative - cannon_base_angle;
        
        // Normalize
        while (desired_offset > M_PI) desired_offset -= 2.0f * M_PI;
        while (desired_offset < -M_PI) desired_offset += 2.0f * M_PI;
        
        // Clamp to cannon's ±30° range
        if (desired_offset > CANNON_AIM_RANGE) desired_offset = CANNON_AIM_RANGE;
        if (desired_offset < -CANNON_AIM_RANGE) desired_offset = -CANNON_AIM_RANGE;
        
        // Update cannon's aim_direction
        cannon->data.cannon.aim_direction = Q16_FROM_FLOAT(desired_offset);
        
        // Also update simple ship for sync
        for (int i = 0; i < ship->module_count; i++) {
            if (ship->modules[i].id == cannon->id) {
                ship->modules[i].data.cannon.aim_direction = Q16_FROM_FLOAT(desired_offset);
                break;
            }
        }
    }
}

/**
 * Fire a single cannon, spawning projectile
 */
static void fire_cannon(SimpleShip* ship, ShipModule* cannon, WebSocketPlayer* player, bool manually_fired) {
    // Consume ammo
    if (cannon->data.cannon.ammunition > 0) {
        cannon->data.cannon.ammunition--;
    }
    cannon->data.cannon.time_since_fire = 0;
    
    // Calculate cannon world position (ship transform + cannon local position)
    // NOTE: ship->x/y are in CLIENT PIXELS, cannon->local_pos is in SERVER UNITS (Q16)
    float cos_rot = cosf(ship->rotation);
    float sin_rot = sinf(ship->rotation);
    
    // Convert cannon local position from server units to client pixels
    float cannon_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.x));
    float cannon_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.y));
    
    // Transform to world space (in client pixels)
    float cannon_world_x = ship->x + (cannon_local_x * cos_rot - cannon_local_y * sin_rot);
    float cannon_world_y = ship->y + (cannon_local_x * sin_rot + cannon_local_y * cos_rot);
    
    // Calculate projectile direction (ship rotation + cannon's base rotation + aim offset)
    float cannon_local_rot = Q16_TO_FLOAT(cannon->local_rot);
    float aim_offset = Q16_TO_FLOAT(cannon->data.cannon.aim_direction);
    float projectile_angle = ship->rotation + cannon_local_rot + aim_offset;
    
    // Spawn projectile at the end of the cannon barrel (outside the ship)
    // All positions in CLIENT PIXELS at this point
    const float BARREL_LENGTH = 30.0f; // 30 pixels barrel extension
    float barrel_offset_x = cosf(projectile_angle) * BARREL_LENGTH;
    float barrel_offset_y = sinf(projectile_angle) * BARREL_LENGTH;
    
    float spawn_x = cannon_world_x + barrel_offset_x;
    float spawn_y = cannon_world_y + barrel_offset_y;
    
    // Cannonball base speed
    const float CANNONBALL_SPEED = CLIENT_TO_SERVER(500.0f); // Convert from client pixels/s to server units/s
    
    // Calculate projectile velocity (inherit ship velocity + cannon velocity)
    float projectile_vx = cosf(projectile_angle) * CANNONBALL_SPEED + ship->velocity_x;
    float projectile_vy = sinf(projectile_angle) * CANNONBALL_SPEED + ship->velocity_y;
    
    // Determine owner for projectile tracking
    uint32_t owner_id = manually_fired ? player->player_id : ship->ship_id;
    
    // Spawn projectile in simulation (convert from client pixels to server units)
    if (global_sim) {
        Vec2Q16 proj_pos = {
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(spawn_x)),
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(spawn_y))
        };
        Vec2Q16 proj_vel = {
            Q16_FROM_FLOAT(projectile_vx),
            Q16_FROM_FLOAT(projectile_vy)
        };
        
        log_info("🎯 Before spawn: projectile_count=%u, max=%d", global_sim->projectile_count, MAX_PROJECTILES);
        
        entity_id projectile_id = sim_create_projectile(global_sim, proj_pos, proj_vel, owner_id);
        
        log_info("🎯 After spawn: projectile_count=%u, projectile_id=%u", global_sim->projectile_count, projectile_id);
        
        if (projectile_id != INVALID_ENTITY_ID) {
            log_info("💥 Cannon %u fired! ship_pos=(%.1f,%.1f) cannon_pos=(%.1f,%.1f) projectile_id=%u spawn_pos=(%.1f,%.1f) angle=%.2f° vel=(%.1f,%.1f) owner=%u manual=%s",
                     cannon->id,
                     ship->x, ship->y,
                     cannon_world_x, cannon_world_y,
                     projectile_id,
                     spawn_x, spawn_y,
                     projectile_angle * (180.0f / M_PI),
                     SERVER_TO_CLIENT(projectile_vx), SERVER_TO_CLIENT(projectile_vy),
                     owner_id, manually_fired ? "yes" : "no");
            
            // Broadcast cannon fire event to all clients (use cannon position for visual effect)
            broadcast_cannon_fire(cannon->id, ship->ship_id, cannon_world_x, cannon_world_y, 
                                projectile_angle, projectile_id);
        } else {
            log_warn("Failed to spawn projectile for cannon %u (max projectiles reached)", cannon->id);
        }
    } else {
        log_error("❌ Cannot spawn projectile - global_sim is NULL!");
    }
}

/**
 * Broadcast cannon fire event to all connected clients
 */
static void broadcast_cannon_fire(uint32_t cannon_id, uint32_t ship_id, float world_x, float world_y, 
                                  float angle, entity_id projectile_id) {
    char message[512];
    snprintf(message, sizeof(message),
            "{\"type\":\"CANNON_FIRE_EVENT\",\"cannonId\":%u,\"shipId\":%u,"
            "\"x\":%.1f,\"y\":%.1f,\"angle\":%.3f,\"projectileId\":%u}",
            cannon_id, ship_id, world_x, world_y, angle, projectile_id);
    
    char frame[1024];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    
    if (frame_len > 0) {
        // Send to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                send(client->fd, frame, frame_len, 0);
            }
        }
    }
}

/**
 * Handle cannon fire from player
 * Single click: Fire cannons currently being aimed (within player's aim angle ±30°)
 * Double click: Fire ALL cannons on the ship (broadside)
 */
static void handle_cannon_fire(WebSocketPlayer* player, bool fire_all) {
    if (player->parent_ship_id == 0) {
        log_warn("Player %u tried to fire cannons while not on a ship", player->player_id);
        return;
    }
    
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) {
        log_warn("Player %u parent ship %u not found", player->player_id, player->parent_ship_id);
        return;
    }
    
    int cannons_fired = 0;
    bool manually_fired = !player->is_mounted; // If not mounted to helm, it's manual fire
    
    // Get simulation ship for up-to-date cannon data
    struct Ship* sim_ship = NULL;
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                sim_ship = &global_sim->ships[s];
                break;
            }
        }
    }
    
    if (!sim_ship) {
        log_warn("Simulation ship %u not found", ship->ship_id);
        return;
    }
    
    // Iterate through all modules to find cannons
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* module = &sim_ship->modules[m];
        
        if (module->type_id != MODULE_TYPE_CANNON) continue;
        
        // Check ammo and reload status
        if (module->data.cannon.ammunition == 0) {
            log_info("  ⚠️  Cannon %u: No ammo", module->id);
            continue;
        }
        
        if (module->data.cannon.time_since_fire < module->data.cannon.reload_time) {
            log_info("  ⚠️  Cannon %u: Reloading (%.1fs remaining)", 
                     module->id,
                     (module->data.cannon.reload_time - module->data.cannon.time_since_fire) / 1000.0f);
            continue;
        }
        
        bool should_fire = fire_all;
        
        if (!fire_all) {
            // Single click: Only fire cannons within aim range
            // Cannon can aim ±30° from base rotation
            float cannon_base_angle = Q16_TO_FLOAT(module->local_rot); // Cannon's base rotation relative to ship
            float cannon_current_aim = Q16_TO_FLOAT(module->data.cannon.aim_direction); // Current aim offset
            float cannon_absolute_aim = cannon_base_angle + cannon_current_aim; // Total cannon direction (ship-relative)
            
            // Player's aim direction (ship-relative)
            float player_aim = player->cannon_aim_angle_relative;
            
            // Calculate difference
            float aim_difference = fabsf(cannon_absolute_aim - player_aim);
            
            // Normalize to -PI to +PI
            while (aim_difference > M_PI) aim_difference -= 2.0f * M_PI;
            while (aim_difference < -M_PI) aim_difference += 2.0f * M_PI;
            aim_difference = fabsf(aim_difference);
            
            // Check if cannon is currently aimed at player's target
            // Cannons have ±30° range, so check if player's aim is within that cone
            const float CANNON_AIM_RANGE = 30.0f * (M_PI / 180.0f); // ±30 degrees
            const float AIM_TOLERANCE = 0.35f; // ~20 degrees tolerance for "being aimed"
            
            should_fire = (aim_difference < AIM_TOLERANCE);
            
            if (!should_fire) {
                log_info("  ⏭️  Cannon %u: Not aimed (diff=%.1f°, tolerance=±%.1f°)", 
                         module->id, aim_difference * (180.0f / M_PI), AIM_TOLERANCE * (180.0f / M_PI));
            }
        }
        
        if (should_fire) {
            fire_cannon(ship, module, player, manually_fired);
            cannons_fired++;
            
            // Also update simple ship module for sync
            for (int i = 0; i < ship->module_count; i++) {
                if (ship->modules[i].id == module->id) {
                    ship->modules[i].data.cannon.ammunition = module->data.cannon.ammunition;
                    ship->modules[i].data.cannon.time_since_fire = 0;
                    break;
                }
            }
        }
    }
    
    log_info("💥 Player %u fired %d cannon(s) on ship %u (%s)", 
             player->player_id, cannons_fired, ship->ship_id,
             fire_all ? "BROADSIDE" : "AIMED");
}

// ============================================================================
// END CANNON CONTROL HANDLERS
// ============================================================================

/**
 * Handle module interaction request from client
 */
static void handle_module_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    // Parse module_id from JSON
    uint32_t module_id = 0;
    char* module_id_start = strstr(payload, "\"module_id\":");
    if (module_id_start) {
        module_id_start += 12; // Skip past "module_id":
        module_id = (uint32_t)atoi(module_id_start);
    } else {
        log_error("module_interact missing module_id field");
        send_interaction_failure(client, "invalid_request");
        return;
    }
    
    log_info("🎮 [MODULE_INTERACT] Player %u -> Module %u", player->player_id, module_id);
    
    // For ladder interactions, we need to find which ship has this ladder
    // For other modules, player must be on the ship
    
    SimpleShip* target_ship = NULL;
    ShipModule* module = NULL;
    
    // Search all ships for the module
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active) {
            ShipModule* found_module = find_module_by_id(&ships[i], module_id);
            if (found_module) {
                target_ship = &ships[i];
                module = found_module;
                break;
            }
        }
    }
    
    if (!module || !target_ship) {
        log_warn("Module %u not found on any ship", module_id);
        send_interaction_failure(client, "module_not_found");
        return;
    }
    
    // Special handling for ladders - can be used from water or different ships
    bool is_ladder = (module->type_id == MODULE_TYPE_LADDER);
    
    // For non-ladder modules, player must be on the same ship
    if (!is_ladder && player->parent_ship_id != target_ship->ship_id) {
        if (player->parent_ship_id == 0) {
            log_warn("Player %u not on a ship, cannot interact with module %u", player->player_id, module_id);
            send_interaction_failure(client, "not_on_ship");
        } else {
            log_warn("Player %u on different ship, cannot interact with module %u on ship %u", 
                     player->player_id, module_id, target_ship->ship_id);
            send_interaction_failure(client, "wrong_ship");
        }
        return;
    }
    
    // Validate range
    float dx, dy, distance;
    float player_world_x, player_world_y, module_world_x, module_world_y;
    
    // Convert module position from Q16 to client coordinates
    float module_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float module_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    
    log_info("🔍 Module %u Q16 pos: (%d, %d)", module_id, module->local_pos.x, module->local_pos.y);
    log_info("🔍 Module %u converted local pos: (%.1f, %.1f)", module_id, module_local_x, module_local_y);
    log_info("🔍 Ship %u pos: (%.1f, %.1f), rot: %.3f", target_ship->ship_id, target_ship->x, target_ship->y, target_ship->rotation);
    log_info("🔍 Player %u parent_ship_id: %u, local pos: (%.1f, %.1f), world pos: (%.1f, %.1f)", 
             player->player_id, player->parent_ship_id, player->local_x, player->local_y, player->x, player->y);
    
    if (player->parent_ship_id == target_ship->ship_id) {
        // Player on same ship - use ship-local coordinates
        log_info("🔍 Using LOCAL coordinates (player on ship %u)", target_ship->ship_id);
        dx = player->local_x - module_local_x;
        dy = player->local_y - module_local_y;
        log_info("🔍 Local distance: player (%.1f, %.1f) - module (%.1f, %.1f) = delta (%.1f, %.1f)", 
                 player->local_x, player->local_y, module_local_x, module_local_y, dx, dy);
        
        // Calculate world coords for logging
        ship_local_to_world(target_ship, player->local_x, player->local_y, &player_world_x, &player_world_y);
        ship_local_to_world(target_ship, module_local_x, module_local_y, &module_world_x, &module_world_y);
    } else {
        // Player in water or on different ship - use world coordinates
        log_info("🔍 Using WORLD coordinates (player in water or different ship)");
        ship_local_to_world(target_ship, module_local_x, module_local_y, &module_world_x, &module_world_y);
        dx = player->x - module_world_x;
        dy = player->y - module_world_y;
        log_info("🔍 World distance: player (%.1f, %.1f) - module (%.1f, %.1f) = delta (%.1f, %.1f)", 
                 player->x, player->y, module_world_x, module_world_y, dx, dy);
        
        player_world_x = player->x;
        player_world_y = player->y;
    }
    
    distance = sqrtf(dx * dx + dy * dy);
    const float MAX_INTERACT_RANGE = 60.0f; // Slightly more lenient on server
    
    if (distance > MAX_INTERACT_RANGE) {
        log_warn("Player %u too far from module %u (%.1fpx > %.1fpx)", 
                 player->player_id, module_id, distance, MAX_INTERACT_RANGE);
        log_warn("  Player world pos: (%.1f, %.1f), Module world pos: (%.1f, %.1f)", 
                 player_world_x, player_world_y, module_world_x, module_world_y);
        send_interaction_failure(client, "out_of_range");
        return;
    }
    
    // Check module is active (not destroyed)
    if (module->state_bits & MODULE_STATE_DESTROYED) {
        log_warn("Module %u is destroyed, cannot interact", module_id);
        send_interaction_failure(client, "module_destroyed");
        return;
    }
    
    // Process interaction based on module type
    log_info("✅ Player %u interacting with %s (ID: %u) at %.1fpx", 
             player->player_id, get_module_type_name(module->type_id), module_id, distance);
    
    switch (module->type_id) {
        case MODULE_TYPE_CANNON:
            handle_cannon_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL:
            handle_helm_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_MAST:
            handle_mast_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_LADDER:
            handle_ladder_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_SEAT:
            handle_seat_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_PLANK:
        case MODULE_TYPE_DECK:
            // Structural modules, no interaction
            log_warn("Cannot interact with structural module type %d", module->type_id);
            send_interaction_failure(client, "not_interactive");
            break;
            
        default:
            log_warn("Unhandled module type: %d", module->type_id);
            send_interaction_failure(client, "unknown_module_type");
            break;
    }
}

// ============================================================================
// END MODULE INTERACTION SYSTEM
// ============================================================================

// Global movement tracking for adaptive tick rate
static uint32_t g_last_movement_time = 0;

static void update_movement_activity(void) {
    g_last_movement_time = get_time_ms();
}

static void debug_player_state(void) {
    // Debug function - logging disabled
}

// HYBRID APPROACH: Apply player movement state every tick (called from server loop)
static void apply_player_movement_state(WebSocketPlayer* player, float dt) {
    const float WALK_SPEED = 30.0f;   // m/s when walking on deck (10x faster)
    const float SWIM_SPEED = 15.0f;   // m/s when swimming (10x faster)
    const float FRICTION = 0.85f;
    
    // Use stored movement direction from state
    float movement_x = player->movement_direction_x;
    float movement_y = player->movement_direction_y;
    bool is_moving = player->is_moving;
    
    // Calculate magnitude of movement vector
    float magnitude = sqrtf(movement_x * movement_x + movement_y * movement_y);
    
    if (player->parent_ship_id != 0) {
        // Player is on a ship - move in ship-local coordinates
        SimpleShip* ship = find_ship(player->parent_ship_id);
        if (ship) {
            if (is_moving && magnitude > 0.01f) {
                // Normalize movement vector
                movement_x /= magnitude;
                movement_y /= magnitude;
                
                // Calculate new local position
                float new_local_x = player->local_x + movement_x * WALK_SPEED * dt;
                float new_local_y = player->local_y + movement_y * WALK_SPEED * dt;
                
                // Check if player would walk off the deck (hull boundary)
                if (is_outside_deck(ship->ship_id, new_local_x, new_local_y)) {
                    // Player walked off the edge - dismount into water
                    log_info("🌊 Player %u walked off the deck of ship %u", 
                             player->player_id, ship->ship_id);
                    
                    // Keep current position (at edge), then dismount
                    // Convert to world position before dismounting
                    ship_local_to_world(ship, player->local_x, player->local_y, 
                                      &player->x, &player->y);
                    
                    // Dismount player
                    dismount_player_from_ship(player, "walked_off_deck");
                    
                    // Continue movement in water
                    player->velocity_x = movement_x * SWIM_SPEED;
                    player->velocity_y = movement_y * SWIM_SPEED;
                } else {
                    // Normal movement on deck
                    player->local_x = new_local_x;
                    player->local_y = new_local_y;
                }
            }
            
            // Only update position if still on ship
            if (player->parent_ship_id != 0) {
                // Convert local position to world position
                ship_local_to_world(ship, player->local_x, player->local_y, 
                                  &player->x, &player->y);
                
                // Player inherits ship velocity
                player->velocity_x = ship->velocity_x;
                player->velocity_y = ship->velocity_y;
            }
            
        } else {
            // Ship not found - fall into water
            log_warn("Player %u lost ship %u - falling into water", 
                     player->player_id, player->parent_ship_id);
            player->parent_ship_id = 0;
            player->movement_state = PLAYER_STATE_SWIMMING;
        }
    } else {
        // Player is swimming in water - move in world coordinates
        if (is_moving && magnitude > 0.01f) {
            // Normalize movement vector
            movement_x /= magnitude;
            movement_y /= magnitude;
            
            // Direct world-space movement (slower in water)
            player->velocity_x = movement_x * SWIM_SPEED;
            player->velocity_y = movement_y * SWIM_SPEED;
        } else {
            // Apply friction when not moving
            player->velocity_x *= FRICTION;
            player->velocity_y *= FRICTION;
        }
        
        // Update world position
        player->x += player->velocity_x * dt;
        player->y += player->velocity_y * dt;
    }
    
    // No world bounds - players can swim freely in the open world
    // (Deck boundaries still apply when on a ship)
}

// LEGACY: Old per-message movement update (for backward compatibility with input_frame)
static void update_player_movement(WebSocketPlayer* player, float rotation, float movement_x, float movement_y, float dt) {
    const float WALK_SPEED = 30.0f;   // m/s when walking on deck (10x faster)
    const float SWIM_SPEED = 15.0f;   // m/s when swimming (10x faster)
    const float FRICTION = 0.85f;
    
    // Update player aim rotation (from mouse)
    player->rotation = rotation;
    
    // Calculate magnitude of WASD movement vector
    float magnitude = sqrtf(movement_x * movement_x + movement_y * movement_y);
    
    if (player->parent_ship_id != 0) {
        // Player is on a ship - move in ship-local coordinates
        SimpleShip* ship = find_ship(player->parent_ship_id);
        if (ship) {
            if (magnitude > 0.01f) {
                // Normalize movement vector
                movement_x /= magnitude;
                movement_y /= magnitude;
                
                // Calculate new local position
                float new_local_x = player->local_x + movement_x * WALK_SPEED * dt;
                float new_local_y = player->local_y + movement_y * WALK_SPEED * dt;
                
                // Check if player would walk off the deck (hull boundary)
                if (is_outside_deck(ship->ship_id, new_local_x, new_local_y)) {
                    // Player walked off the edge - dismount into water
                    log_info("🌊 Player %u walked off the deck of ship %u", 
                             player->player_id, ship->ship_id);
                    
                    // Keep current position (at edge), then dismount
                    // Convert to world position before dismounting
                    ship_local_to_world(ship, player->local_x, player->local_y, 
                                      &player->x, &player->y);
                    
                    // Dismount player
                    dismount_player_from_ship(player, "walked_off_deck");
                    
                    // Continue movement in water
                    player->velocity_x = movement_x * SWIM_SPEED;
                    player->velocity_y = movement_y * SWIM_SPEED;
                } else {
                    // Normal movement on deck
                    player->local_x = new_local_x;
                    player->local_y = new_local_y;
                }
            }
            
            // Only update position if still on ship
            if (player->parent_ship_id != 0) {
                // Convert local position to world position
                ship_local_to_world(ship, player->local_x, player->local_y, 
                                  &player->x, &player->y);
                
                // Player inherits ship velocity
                player->velocity_x = ship->velocity_x;
                player->velocity_y = ship->velocity_y;
            }
            
        } else {
            // Ship not found - fall into water
            log_warn("Player %u lost ship %u - falling into water", 
                     player->player_id, player->parent_ship_id);
            player->parent_ship_id = 0;
            player->movement_state = PLAYER_STATE_SWIMMING;
        }
    } else {
        // Player is swimming in water - move in world coordinates
        if (magnitude > 0.01f) {
            // Normalize movement vector
            movement_x /= magnitude;
            movement_y /= magnitude;
            
            // Direct world-space movement (slower in water)
            player->velocity_x = movement_x * SWIM_SPEED;
            player->velocity_y = movement_y * SWIM_SPEED;
        } else {
            // Apply friction when not moving
            player->velocity_x *= FRICTION;
            player->velocity_y *= FRICTION;
        }
        
        // Update world position
        player->x += player->velocity_x * dt;
        player->y += player->velocity_y * dt;
    }
    
    // No world bounds - players can swim freely in the open world
    // (Deck boundaries still apply when on a ship)
    
    // Debug logging for movement
    static uint32_t last_movement_log_time = 0;
    uint32_t current_time_ms = get_time_ms();
    if (current_time_ms - last_movement_log_time > 1000) {  // Track time
        // Movement updates happening (logging disabled)
        last_movement_log_time = current_time_ms;
    }
}

static int websocket_parse_frame(const char* buffer, size_t buffer_len, char* payload, size_t* payload_len) {
    if (buffer_len < 2) return -1;
    
    uint8_t first_byte = buffer[0];
    uint8_t second_byte = buffer[1];
    
    bool fin = (first_byte & 0x80) != 0;
    uint8_t opcode = first_byte & 0x0F;
    bool masked = (second_byte & 0x80) != 0;
    uint8_t payload_length = second_byte & 0x7F;
    
    if (!fin || !masked) return -1; // We expect final, masked frames from clients
    
    size_t header_len = 2;
    uint64_t actual_payload_len = payload_length;
    
    // Extended payload length
    if (payload_length == 126) {
        if (buffer_len < 4) return -1;
        actual_payload_len = ((unsigned char)buffer[2] << 8) | (unsigned char)buffer[3];
        header_len += 2;
    } else if (payload_length == 127) {
        if (buffer_len < 10) return -1;
        // For simplicity, we don't handle 64-bit lengths
        return -1;
    }
    
    // CRITICAL: Check payload won't overflow destination buffer (assumed to be 4096 bytes)
    if (actual_payload_len > 4095) {
        log_warn("⚠️ Dropping oversized WebSocket frame: %lu bytes (max 4095) - connection remains active", 
                  (unsigned long)actual_payload_len);
        *payload_len = 0;
        return opcode;  // Return opcode but with zero payload length
    }
    
    if (buffer_len < header_len + 4 + actual_payload_len) return -1;
    
    // Extract masking key
    uint8_t mask[4];
    memcpy(mask, buffer + header_len, 4);
    header_len += 4;
    
    // Unmask payload
    for (size_t i = 0; i < actual_payload_len; i++) {
        payload[i] = buffer[header_len + i] ^ mask[i % 4];
    }
    payload[actual_payload_len] = '\0';
    *payload_len = actual_payload_len;
    
    return opcode;
}

// Create WebSocket frame
// NOTE: Caller must ensure frame buffer is large enough (payload_len + 10 bytes for header)
size_t websocket_create_frame(uint8_t opcode, const char* payload, size_t payload_len, char* frame, size_t frame_size) {
    size_t frame_len = 0;
    
    // Calculate required frame size (header + payload)
    size_t required_size = payload_len + 10; // Max header is 10 bytes
    
    // Validate buffer size
    if (required_size > frame_size) {
        log_error("❌ Frame buffer overflow prevented: need %zu bytes, have %zu bytes (payload: %zu)", 
                  required_size, frame_size, payload_len);
        return 0;
    }
    
    // First byte: FIN = 1, opcode
    frame[frame_len++] = 0x80 | opcode;
    
    // Payload length
    if (payload_len < 126) {
        frame[frame_len++] = payload_len;
    } else if (payload_len < 65536) {
        frame[frame_len++] = 126;
        frame[frame_len++] = (payload_len >> 8) & 0xFF;
        frame[frame_len++] = payload_len & 0xFF;
    } else {
        // We don't handle large payloads for simplicity
        log_error("Payload too large for WebSocket frame: %zu bytes", payload_len);
        return 0;
    }
    
    // Payload
    memcpy(frame + frame_len, payload, payload_len);
    frame_len += payload_len;
    
    return frame_len;
}

void websocket_server_set_simulation(struct Sim* sim) {
    global_sim = sim;
    log_info("✅ WebSocket server linked to simulation for collision detection");
}

int websocket_server_init(uint16_t port) {
    memset(&ws_server, 0, sizeof(ws_server));
    ws_server.port = port;
    
    // Create TCP socket
    ws_server.socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (ws_server.socket_fd < 0) {
        log_error("Failed to create WebSocket TCP socket: %s", strerror(errno));
        return -1;
    }
    
    // Set socket options
    int reuse = 1;
    if (setsockopt(ws_server.socket_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
        log_warn("Failed to set SO_REUSEADDR on WebSocket socket: %s", strerror(errno));
    }
    
    // Set non-blocking
    int flags = fcntl(ws_server.socket_fd, F_GETFL, 0);
    if (flags == -1 || fcntl(ws_server.socket_fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        log_error("Failed to set WebSocket socket non-blocking: %s", strerror(errno));
        close(ws_server.socket_fd);
        return -1;
    }
    
    // Bind socket
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(ws_server.socket_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        log_error("Failed to bind WebSocket socket to port %u: %s", port, strerror(errno));
        close(ws_server.socket_fd);
        return -1;
    }
    
    // Start listening
    if (listen(ws_server.socket_fd, 10) < 0) {
        log_error("Failed to listen on WebSocket socket: %s", strerror(errno));
        close(ws_server.socket_fd);
        return -1;
    }
    
    ws_server.running = true;
    log_info("WebSocket server initialized on port %u", port);
    
    // Initialize a test ship away from origin (using brigantine physics from protocol/ship_definitions.h)
    ships[0].ship_id = next_ship_id++;
    ships[0].ship_type = 3;  // Brigantine
    ships[0].x = 100.0f;  // Spawn ship away from center
    ships[0].y = 100.0f;
    ships[0].rotation = 0.0f;
    ships[0].velocity_x = 0.0f;
    ships[0].velocity_y = 0.0f;
    ships[0].angular_velocity = 0.0f;
    
    // Physics properties from brigantine ship definition
    ships[0].mass = BRIGANTINE_MASS;
    ships[0].moment_of_inertia = BRIGANTINE_MOMENT_OF_INERTIA;
    ships[0].max_speed = BRIGANTINE_MAX_SPEED;
    ships[0].turn_rate = BRIGANTINE_TURN_RATE;
    ships[0].water_drag = BRIGANTINE_WATER_DRAG;
    ships[0].angular_drag = BRIGANTINE_ANGULAR_DRAG;
    
    ships[0].deck_min_x = -8.0f;  // Deck boundaries (in ship-local coords)
    ships[0].deck_max_x = 8.0f;
    ships[0].deck_min_y = -6.0f;
    ships[0].deck_max_y = 6.0f;
    ships[0].active = true;
    
    // Ship control state
    ships[0].desired_sail_openness = 0;  // Sails start closed
    
    // Initialize ship modules for brigantine
    ships[0].module_count = 0;
    uint16_t module_id_counter = 1000; // Start module IDs at 1000
    
    // Add helm at standard position matching client (-90, 0 pixels)
    ships[0].modules[ships[0].module_count].id = module_id_counter++;
    ships[0].modules[ships[0].module_count].type_id = MODULE_TYPE_HELM;
    ships[0].modules[ships[0].module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f));
    ships[0].modules[ships[0].module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
    ships[0].modules[ships[0].module_count].local_rot = Q16_FROM_FLOAT(0.0f);
    ships[0].modules[ships[0].module_count].state_bits = MODULE_STATE_ACTIVE;
    ships[0].modules[ships[0].module_count].data.helm.occupied_by = 0;
    ships[0].modules[ships[0].module_count].data.helm.wheel_rotation = Q16_FROM_FLOAT(0.0f);
    ships[0].module_count++;
    
    // Add 6 cannons (3 port, 3 starboard)
    for (int i = 0; i < 6; i++) {
        float side = (i < 3) ? -70.0f : 70.0f;  // Port vs starboard (client pixels)
        float y_pos = -30.0f + (i % 3) * 30.0f; // Spacing along ship (client pixels)
        
        ships[0].modules[ships[0].module_count].id = module_id_counter++;
        ships[0].modules[ships[0].module_count].type_id = MODULE_TYPE_CANNON;
        ships[0].modules[ships[0].module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(side));
        ships[0].modules[ships[0].module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(y_pos));
        ships[0].modules[ships[0].module_count].local_rot = Q16_FROM_FLOAT((i < 3) ? -M_PI/2 : M_PI/2);
        ships[0].modules[ships[0].module_count].state_bits = MODULE_STATE_ACTIVE;
        ships[0].modules[ships[0].module_count].data.cannon.aim_direction = Q16_FROM_FLOAT(0.0f);
        ships[0].modules[ships[0].module_count].data.cannon.ammunition = 10;
        ships[0].modules[ships[0].module_count].data.cannon.time_since_fire = 0;
        ships[0].modules[ships[0].module_count].data.cannon.reload_time = Q16_FROM_FLOAT(3000.0f);
        ships[0].module_count++;
    }
    
    // Add 3 masts
    for (int i = 0; i < 3; i++) {
        float y_pos = -40.0f + i * 40.0f;  // Client pixels
        
        ships[0].modules[ships[0].module_count].id = module_id_counter++;
        ships[0].modules[ships[0].module_count].type_id = MODULE_TYPE_MAST;
        ships[0].modules[ships[0].module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
        ships[0].modules[ships[0].module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(y_pos));
        ships[0].modules[ships[0].module_count].local_rot = Q16_FROM_FLOAT(0.0f);
        ships[0].modules[ships[0].module_count].state_bits = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
        ships[0].modules[ships[0].module_count].data.mast.angle = Q16_FROM_FLOAT(0.0f);
        ships[0].modules[ships[0].module_count].data.mast.openness = 0;
        ships[0].modules[ships[0].module_count].data.mast.wind_efficiency = Q16_FROM_FLOAT(1.0f);
        ships[0].module_count++;
    }
    
    // Add 4 ladders (port/starboard sides, front/back) plus one at the specified position
    float ladder_positions[1][2] = {
 
        {-305.0f, 0.0f}   // Special ladder at requested position
    };
    
    for (int i = 0; i < 1; i++) {
        ships[0].modules[ships[0].module_count].id = module_id_counter++;
        ships[0].modules[ships[0].module_count].type_id = MODULE_TYPE_LADDER;
        ships[0].modules[ships[0].module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ladder_positions[i][0]));
        ships[0].modules[ships[0].module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ladder_positions[i][1]));
        ships[0].modules[ships[0].module_count].local_rot = Q16_FROM_FLOAT(0.0f);
        ships[0].modules[ships[0].module_count].state_bits = MODULE_STATE_ACTIVE;
        ships[0].module_count++;
    }
    
    log_info("🔧 Initialized %d modules for ship %u (1 helm, 6 cannons, 3 masts, 1 ladder)", 
             ships[0].module_count, ships[0].ship_id);
    
    ship_count = 1;
    log_info("🚢 Initialized test ship (ID: %u, Type: Brigantine, Mass: %.0f kg, Inertia: %.0f kg⋅m²) at (%.1f, %.1f)", 
             ships[0].ship_id, ships[0].mass, ships[0].moment_of_inertia, ships[0].x, ships[0].y);
    
    // Enhanced startup message
    printf("\n🌐 ═══════════════════════════════════════════════════════════════\n");
    printf("🔌 WebSocket Server Ready for Browser Clients!\n");
    printf("🌍 WebSocket listening on 0.0.0.0:%u\n", port);
    printf("🔄 Protocol bridge: WebSocket ↔ UDP translation active\n");
    printf("🎯 Browser clients can now connect via WebSocket\n");
    printf("🚢 Test ship spawned at (%.1f, %.1f)\n", ships[0].x, ships[0].y);
    printf("═══════════════════════════════════════════════════════════════\n\n");
    
    return 0;
}

void websocket_server_cleanup(void) {
    if (!ws_server.running) {
        log_info("WebSocket server already stopped");
        return;
    }
    
    log_info("📋 Starting WebSocket server cleanup...");
    
    // Signal shutdown
    ws_server.running = false;
    
    // Close all client connections gracefully
    int closed_clients = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (ws_server.clients[i].connected) {
            // Send close frame if possible
            uint8_t close_frame[] = {0x88, 0x00}; // Close frame with no payload
            send(ws_server.clients[i].fd, close_frame, sizeof(close_frame), MSG_NOSIGNAL);
            
            // Close the socket
            close(ws_server.clients[i].fd);
            ws_server.clients[i].connected = false;
            ws_server.clients[i].fd = -1;
            closed_clients++;
        }
    }
    
    if (closed_clients > 0) {
        log_info("🔌 Closed %d WebSocket client connections", closed_clients);
    }
    
    // Close server socket
    if (ws_server.socket_fd >= 0) {
        shutdown(ws_server.socket_fd, SHUT_RDWR);
        close(ws_server.socket_fd);
        ws_server.socket_fd = -1;
        log_info("🔌 WebSocket server socket closed");
    }
    
    log_info("✅ WebSocket server cleanup complete");
}

int websocket_server_update(struct Sim* sim) {
    if (!ws_server.running) return 0;
    
    // Accept new connections
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    int client_fd = accept(ws_server.socket_fd, (struct sockaddr*)&client_addr, &addr_len);
    
    if (client_fd >= 0) {
        // Find empty client slot
        int slot = -1;
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            if (!ws_server.clients[i].connected) {
                slot = i;
                break;
            }
        }
        
        if (slot >= 0) {
            // Set client non-blocking
            int flags = fcntl(client_fd, F_GETFL, 0);
            if (flags != -1) {
                fcntl(client_fd, F_SETFL, flags | O_NONBLOCK);
            }
            
            // Initialize client
            ws_server.clients[slot].fd = client_fd;
            ws_server.clients[slot].connected = true;
            ws_server.clients[slot].handshake_complete = false;
            ws_server.clients[slot].last_ping_time = get_time_ms();
            ws_server.clients[slot].player_id = 0; // Will be assigned during handshake
            inet_ntop(AF_INET, &client_addr.sin_addr, ws_server.clients[slot].ip_address, INET_ADDRSTRLEN);
            ws_server.clients[slot].port = ntohs(client_addr.sin_port);
            
            log_info("🔌 New WebSocket connection from %s:%u (slot %d, fd %d)", 
                     ws_server.clients[slot].ip_address, 
                     ws_server.clients[slot].port, 
                     slot, client_fd);
        } else {
            log_warn("❌ WebSocket server full (%d/%d), rejecting connection from %s:%u",
                     ws_server.client_count, WS_MAX_CLIENTS,
                     inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
            close(client_fd);
        }
    }
    
    // Process existing clients
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (!ws_server.clients[i].connected) continue;
        
        struct WebSocketClient* client = &ws_server.clients[i];
        char buffer[4096];
        ssize_t received = recv(client->fd, buffer, sizeof(buffer) - 1, 0);
        
        if (received > 0) {
            buffer[received] = '\0';
            
            if (!client->handshake_complete) {
                log_debug("📨 Received handshake request from %s:%u (%zd bytes)", 
                         client->ip_address, client->port, received);
                
                // Handle WebSocket handshake
                if (websocket_handshake(client->fd, buffer)) {
                    client->handshake_complete = true;
                    log_info("✅ WebSocket handshake successful for %s:%u", 
                            client->ip_address, client->port);
                } else {
                    log_error("❌ WebSocket handshake FAILED for %s:%u - closing connection", 
                             client->ip_address, client->port);
                    close(client->fd);
                    client->connected = false;
                }
            } else {
                // Handle WebSocket frames
                char payload[4096];  // Increased to handle larger messages
                size_t payload_len = 0;
                int opcode = websocket_parse_frame(buffer, received, payload, &payload_len);
                
                // Check for parsing errors
                if (opcode < 0) {
                    log_warn("WebSocket frame parsing failed from %s:%u (Player: %u) | Received: %zd bytes",
                            client->ip_address, client->port, client->player_id, received);
                    
                    if (received >= 2) {
                        log_warn("Frame header: 0x%02X 0x%02X (FIN=%d, Opcode=0x%X, Masked=%d, PayloadLen=%d)",
                                (unsigned char)buffer[0], (unsigned char)buffer[1],
                                (buffer[0] & 0x80) >> 7, buffer[0] & 0x0F,
                                (buffer[1] & 0x80) >> 7, buffer[1] & 0x7F);
                    }
                    
                    // Log raw data for debugging
                    char hex_dump[256] = {0};
                    int offset = 0;
                    for (size_t i = 0; i < received && i < 32; i++) {
                        offset += snprintf(hex_dump + offset, sizeof(hex_dump) - offset, "%02X ", (unsigned char)buffer[i]);
                    }
                    log_warn("Raw bytes (first 32): %s", hex_dump);
                    continue;
                }
                
                // Debug: Log all WebSocket frame information
                const char* opcode_name = "UNKNOWN";
                switch(opcode) {
                    case WS_OPCODE_TEXT: opcode_name = "TEXT"; break;
                    case WS_OPCODE_BINARY: opcode_name = "BINARY"; break;
                    case WS_OPCODE_CLOSE: opcode_name = "CLOSE"; break;
                    case WS_OPCODE_PING: opcode_name = "PING"; break;
                    case WS_OPCODE_PONG: opcode_name = "PONG"; break;
                    default: opcode_name = "UNKNOWN"; break;
                }
                
                // Frame received - processing
                
                if (opcode == WS_OPCODE_TEXT || opcode == WS_OPCODE_BINARY) {
                    
                    char response[1024];
                    bool handled = false;
                    
                    // Check if message is JSON or text command
                    if (payload[0] == '{') {
                        // JSON message - parse type
                        // JSON message - parsing type
                        
                        if (strstr(payload, "\"type\":\"handshake\"")) {
                            // Processing HANDSHAKE message
                            // Extract player name from handshake if provided
                            char player_name[32] = "Player";
                            char* name_start = strstr(payload, "\"playerName\":\"");
                            if (name_start) {
                                name_start += 14; // Skip past "playerName":"
                                char* name_end = strchr(name_start, '"');
                                if (name_end) {
                                    size_t name_len = name_end - name_start;
                                    if (name_len > 0 && name_len < sizeof(player_name) - 1) {
                                        strncpy(player_name, name_start, name_len);
                                        player_name[name_len] = '\0';
                                    }
                                }
                            }
                            
                            // Check if client already has a player
                            if (client->player_id != 0) {
                                WebSocketPlayer* existing_player = find_player(client->player_id);
                                if (existing_player) {
                                    log_info("🤝 Client %s:%u reconnecting with existing player ID %u", 
                                             client->ip_address, client->port, client->player_id);
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"player_id\":%u,\"playerName\":\"%s\",\"server_time\":%u,\"status\":\"reconnected\"}",
                                            client->player_id, player_name, get_time_ms());
                                    handled = true;
                                } else {
                                    // Player ID exists but player not found - reset it
                                    log_warn("Client %s:%u had invalid player ID %u, resetting", 
                                             client->ip_address, client->port, client->player_id);
                                    client->player_id = 0;
                                }
                            }
                            
                            if (client->player_id == 0 && !handled) {
                                // Handshake message - create new player
                                uint32_t player_id = next_player_id++;
                                client->player_id = player_id;
                                
                                // Create player for this client
                                WebSocketPlayer* player = create_player(player_id);
                                if (!player) {
                                    log_error("Failed to create player for client %s:%u", client->ip_address, client->port);
                                    client->player_id = 0; // Reset on failure
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"status\":\"error\",\"message\":\"Server full\"}");
                                    handled = true;
                                } else {
                                    // Store player name
                                    strncpy(player->name, player_name, sizeof(player->name) - 1);
                                    player->name[sizeof(player->name) - 1] = '\0';
                                    
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"player_id\":%u,\"playerName\":\"%s\",\"server_time\":%u,\"status\":\"connected\"}",
                                            player_id, player_name, get_time_ms());
                                    handled = true;
                                    log_info("🤝 WebSocket handshake from %s:%u (Player: %s, ID: %u)", 
                                             client->ip_address, client->port, player_name, player_id);
                                }
                            }
                            
                            // Send initial game state after successful handshake
                            if (handled && client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    char game_state_frame[16384];  // Increased for module data
                                    char game_state_response[12288];  // Increased for module data
                                    
                                    // Build ships array for initial state (increased buffer for modules)
                                    char ships_str[8192];
                                    int ships_offset = 0;
                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "[");
                                    
                                    bool first_ship = true;
                                    for (int s = 0; s < ship_count && ships_offset < (int)sizeof(ships_str) - 512; s++) {
                                        if (ships[s].active) {
                                            ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                    "%s{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"modules\":[",
                                                    first_ship ? "" : ",",
                                                    ships[s].ship_id, ships[s].x, ships[s].y, ships[s].rotation,
                                                    ships[s].velocity_x, ships[s].velocity_y);
                                            
                                            // Add modules
                                            for (int m = 0; m < ships[s].module_count && ships_offset < (int)sizeof(ships_str) - 200; m++) {
                                                const ShipModule* module = &ships[s].modules[m];
                                                float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                                                float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                                                float module_rot = Q16_TO_FLOAT(module->local_rot);
                                                
                                                // Add module-specific data based on type
                                                if (module->type_id == MODULE_TYPE_MAST) {
                                                    // Mast: include openness and sail angle
                                                    float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f}",
                                                        m > 0 ? "," : "", module->id, module->type_id, 
                                                        module_x, module_y, module_rot, module->data.mast.openness, sail_angle);
                                                } else if (module->type_id == MODULE_TYPE_CANNON) {
                                                    // Cannon: include ammunition and aim direction
                                                    float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"ammo\":%u,\"aimDir\":%.3f}",
                                                        m > 0 ? "," : "", module->id, module->type_id, 
                                                        module_x, module_y, module_rot, module->data.cannon.ammunition, aim_direction);
                                                } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                                                    // Helm: include wheel rotation and occupied status
                                                    float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s}",
                                                        m > 0 ? "," : "", module->id, module->type_id, 
                                                        module_x, module_y, module_rot, wheel_rot, 
                                                        (module->data.helm.occupied_by != 0) ? "true" : "false");
                                                } else {
                                                    // Generic module: just transform data
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f}",
                                                        m > 0 ? "," : "", module->id, module->type_id, 
                                                        module_x, module_y, module_rot);
                                                }
                                            }
                                            
                                            ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "]}");
                                            first_ship = false;
                                        }
                                    }
                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "]");
                                    
                                    log_info("📊 Initial game state: ships_str size=%d, buffer=%zu", 
                                             ships_offset, sizeof(ships_str));
                                    
                                    snprintf(game_state_response, sizeof(game_state_response),
                                            "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":%s,\"players\":[{\"id\":%u,\"name\":\"Player\","
                                            "\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,"
                                            "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"is_moving\":%s,"
                                            "\"movement_direction_x\":%.2f,\"movement_direction_y\":%.2f,"
                                            "\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\"}],\"projectiles\":[]}",
                                            get_time_ms() / 33, get_time_ms(), ships_str, 
                                            client->player_id, player->x, player->y, player->rotation,
                                            player->velocity_x, player->velocity_y,
                                            player->is_moving ? "true" : "false",
                                            player->movement_direction_x, player->movement_direction_y,
                                            player->parent_ship_id, player->local_x, player->local_y,
                                            get_state_string(player->movement_state));
                                    
                                    size_t response_len = strlen(game_state_response);
                                    log_info("📊 Game state response: %zu bytes (buffer: %zu bytes)", 
                                             response_len, sizeof(game_state_response));
                                    
                                    // Send handshake response first
                                    char frame[2048];  // Increased to match earlier fix
                                    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
                                    if (frame_len > 0 && frame_len < sizeof(frame)) {
                                        send(client->fd, frame, frame_len, 0);
                                    }
                                    
                                    // Then send game state
                                    size_t game_state_frame_len = websocket_create_frame(WS_OPCODE_TEXT, game_state_response, strlen(game_state_response), game_state_frame, sizeof(game_state_frame));
                                    if (game_state_frame_len > 0 && game_state_frame_len < sizeof(game_state_frame)) {
                                        send(client->fd, game_state_frame, game_state_frame_len, 0);
                                        // Sent initial game state
                                    }
                                    
                                    // Skip normal response sending since we already sent
                                    ws_server.packets_sent += 2;
                                    ws_server.packets_received++;
                                    continue;
                                }
                            }
                            
                        } else if (strstr(payload, "\"type\":\"input_frame\"")) {
                            // Input frame message - parse movement data
                            ws_server.input_messages_received++;
                            ws_server.last_input_time = get_time_ms();
                            
                            if (client->player_id == 0) {
                                log_warn("Input frame from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse rotation from input frame
                                    float rotation = 0.0f;
                                    char* rotation_start = strstr(payload, "\"rotation\":");
                                    if (rotation_start) {
                                        sscanf(rotation_start + 11, "%f", &rotation);
                                    }
                                    
                                    // Simple JSON parsing for movement (basic implementation)
                                    char* movement_start = strstr(payload, "\"movement\":{");
                                    if (movement_start) {
                                        float x = 0.0f, y = 0.0f;
                                        char* x_start = strstr(movement_start, "\"x\":");
                                        char* y_start = strstr(movement_start, "\"y\":");
                                        
                                        if (x_start) sscanf(x_start + 4, "%f", &x);
                                        if (y_start) sscanf(y_start + 4, "%f", &y);
                                        
                                        // Validate movement values
                                        if (x < -1.0f) x = -1.0f;
                                        if (x > 1.0f) x = 1.0f;
                                        if (y < -1.0f) y = -1.0f;
                                        if (y > 1.0f) y = 1.0f;
                                        
                                        // Validate rotation (should be in [-π, π])
                                        if (rotation < -M_PI) rotation = -M_PI;
                                        if (rotation > M_PI) rotation = M_PI;
                                        
                                        // Store movement state for tick-based processing
                                        // (Don't apply movement immediately - let websocket_server_tick handle it)
                                        player->movement_direction_x = x;
                                        player->movement_direction_y = y;
                                        player->is_moving = (x != 0.0f || y != 0.0f);
                                        player->rotation = rotation;
                                        player->last_input_time = get_time_ms();
                                        
                                        // Track movement for adaptive tick rate
                                        if (player->is_moving) {
                                            update_movement_activity();
                                        }
                                        
                                        // Player input processed
                                    } else {
                                        log_warn("Invalid input frame format from player %u", client->player_id);
                                    }
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"input_received\"}");
                                } else {
                                    log_warn("Input frame for non-existent player %u from %s:%u", 
                                             client->player_id, client->ip_address, client->port);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"movement_state\"")) {
                            // HYBRID: Movement state change message
                            ws_server.input_messages_received++;
                            ws_server.last_input_time = get_time_ms();
                            
                            if (client->player_id == 0) {
                                log_warn("Movement state from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse movement direction
                                    float x = 0.0f, y = 0.0f;
                                    char* movement_start = strstr(payload, "\"movement\":{");
                                    if (movement_start) {
                                        char* x_start = strstr(movement_start, "\"x\":");
                                        char* y_start = strstr(movement_start, "\"y\":");
                                        if (x_start) sscanf(x_start + 4, "%f", &x);
                                        if (y_start) sscanf(y_start + 4, "%f", &y);
                                    }
                                    
                                    // Parse is_moving flag
                                    bool is_moving = false;
                                    if (strstr(payload, "\"is_moving\":true")) {
                                        is_moving = true;
                                    }
                                    
                                    // Validate movement values
                                    if (x < -1.0f) x = -1.0f;
                                    if (x > 1.0f) x = 1.0f;
                                    if (y < -1.0f) y = -1.0f;
                                    if (y > 1.0f) y = 1.0f;
                                    
                                    // Update player's movement state (NOT apply movement yet - that happens every tick)
                                    player->movement_direction_x = x;
                                    player->movement_direction_y = y;
                                    player->is_moving = is_moving;
                                    player->last_input_time = get_time_ms();
                                    
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"state_updated\"}");
                                } else {
                                    log_warn("Movement state for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"rotation_update\"")) {
                            // HYBRID: Rotation update message
                            
                            if (client->player_id == 0) {
                                log_warn("Rotation update from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse rotation
                                    float rotation = 0.0f;
                                    char* rotation_start = strstr(payload, "\"rotation\":");
                                    if (rotation_start) {
                                        sscanf(rotation_start + 11, "%f", &rotation);
                                    }
                                    
                                    // Validate rotation (should be in [-π, π])
                                    if (rotation < -M_PI) rotation = -M_PI;
                                    if (rotation > M_PI) rotation = M_PI;
                                    
                                    // Update player rotation
                                    player->last_rotation = player->rotation;
                                    player->rotation = rotation;
                                    player->last_rotation_update_time = get_time_ms();
                                    
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"rotation_updated\"}");
                                } else {
                                    log_warn("Rotation update for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"module_interact\"")) {
                            // MODULE_INTERACT message
                            log_info("🎮 Processing MODULE_INTERACT message");
                            
                            if (client->player_id == 0) {
                                log_warn("Module interact from client %s:%u with no player ID", client->ip_address, client->port);
                                send_interaction_failure(client, "no_player");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_module_interact(player, client, payload);
                                } else {
                                    log_warn("Module interact for non-existent player %u", client->player_id);
                                    send_interaction_failure(client, "player_not_found");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"module_unmount\"")) {
                            // MODULE_UNMOUNT message
                            log_info("🔓 Processing MODULE_UNMOUNT message");
                            
                            if (client->player_id == 0) {
                                log_warn("Module unmount from client %s:%u with no player ID", client->ip_address, client->port);
                                send_interaction_failure(client, "no_player");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_module_unmount(player, client);
                                } else {
                                    log_warn("Module unmount for non-existent player %u", client->player_id);
                                    send_interaction_failure(client, "player_not_found");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"action_event\"")) {
                            // HYBRID: Action event message
                            log_info("⚡ Processing ACTION_EVENT message");
                            
                            if (client->player_id == 0) {
                                log_warn("Action event from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse action type
                                    char action[32] = {0};
                                    char* action_start = strstr(payload, "\"action\":\"");
                                    if (action_start) {
                                        action_start += 10; // Skip past "action":"
                                        int i = 0;
                                        while (i < 31 && action_start[i] != '"' && action_start[i] != '\0') {
                                            action[i] = action_start[i];
                                            i++;
                                        }
                                        action[i] = '\0';
                                    }
                                    
                                    log_info("⚡ Player %u action: %s", player->player_id, action);
                                    
                                    // Process action immediately (no state persistence)
                                    if (strcmp(action, "fire_cannon") == 0) {
                                        // TODO: Implement cannon firing
                                        log_info("💥 Player %u fired cannon!", player->player_id);
                                    } else if (strcmp(action, "jump") == 0) {
                                        // Jump action - dismount from ship if on one
                                        if (player->parent_ship_id != 0) {
                                            log_info("🦘 Player %u jumped off ship %u!", player->player_id, player->parent_ship_id);
                                            dismount_player_from_ship(player, "jumped");
                                            
                                            // Send state update to player
                                            char jump_response[256];
                                            snprintf(jump_response, sizeof(jump_response),
                                                    "{\"type\":\"player_state_changed\",\"player_id\":%u,\"state\":\"swimming\",\"ship_id\":0}",
                                                    player->player_id);
                                            
                                            char jump_frame[512];
                                            size_t jump_frame_len = websocket_create_frame(WS_OPCODE_TEXT, jump_response, 
                                                                                          strlen(jump_response), jump_frame, sizeof(jump_frame));
                                            if (jump_frame_len > 0) {
                                                send(client->fd, jump_frame, jump_frame_len, 0);
                                            }
                                            
                                            // Broadcast to other players
                                            websocket_server_broadcast(jump_response);
                                        } else {
                                            log_info("🦘 Player %u jumped (already in water)", player->player_id);
                                        }
                                    } else if (strcmp(action, "interact") == 0) {
                                        // TODO: Implement interaction
                                        log_info("🤝 Player %u interacted!", player->player_id);
                                    }
                                    
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"action_processed\"}");
                                } else {
                                    log_warn("Action event for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"ship_sail_control\"")) {
                            // SHIP SAIL CONTROL message
                            log_info("⛵ Processing SHIP_SAIL_CONTROL message");
                            
                            if (client->player_id == 0) {
                                log_warn("Ship sail control from client with no player ID");
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->is_mounted && player->controlling_ship_id != 0) {
                                    // Find the ship being controlled
                                    SimpleShip* ship = NULL;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].ship_id == player->controlling_ship_id) {
                                            ship = &ships[s];
                                            break;
                                        }
                                    }
                                    
                                    if (ship) {
                                        // Parse desired_openness
                                        int desired_openness = 50; // Default
                                        char* openness_start = strstr(payload, "\"desired_openness\":");
                                        if (openness_start) {
                                            sscanf(openness_start + 19, "%d", &desired_openness);
                                        }
                                        
                                        handle_ship_sail_control(player, client, ship, desired_openness);
                                    } else {
                                        log_warn("Player %u controlling non-existent ship %u", player->player_id, player->controlling_ship_id);
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    }
                                } else {
                                    log_warn("Ship sail control from player %u not controlling a ship", client->player_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_controlling_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"ship_rudder_control\"")) {
                            // SHIP RUDDER CONTROL message
                            log_info("🚢 Processing SHIP_RUDDER_CONTROL message");
                            
                            if (client->player_id == 0) {
                                log_warn("Ship rudder control from client with no player ID");
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->is_mounted && player->controlling_ship_id != 0) {
                                    // Find the ship being controlled
                                    SimpleShip* ship = NULL;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].ship_id == player->controlling_ship_id) {
                                            ship = &ships[s];
                                            break;
                                        }
                                    }
                                    
                                    if (ship) {
                                        // Parse turning_left and turning_right
                                        bool turning_left = strstr(payload, "\"turning_left\":true") != NULL;
                                        bool turning_right = strstr(payload, "\"turning_right\":true") != NULL;
                                        
                                        handle_ship_rudder_control(player, client, ship, turning_left, turning_right);
                                    } else {
                                        log_warn("Player %u controlling non-existent ship %u", player->player_id, player->controlling_ship_id);
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    }
                                } else {
                                    log_warn("Ship rudder control from player %u not controlling a ship", client->player_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_controlling_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"ship_sail_angle_control\"")) {
                            // SHIP SAIL ANGLE CONTROL message
                            log_info("🌀 Processing SHIP_SAIL_ANGLE_CONTROL message");
                            
                            if (client->player_id == 0) {
                                log_warn("Ship sail angle control from client with no player ID");
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->is_mounted && player->controlling_ship_id != 0) {
                                    // Find the ship being controlled
                                    SimpleShip* ship = NULL;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].ship_id == player->controlling_ship_id) {
                                            ship = &ships[s];
                                            break;
                                        }
                                    }
                                    
                                    if (ship) {
                                        // Parse desired_angle
                                        float desired_angle = 0.0f; // Default
                                        char* angle_start = strstr(payload, "\"desired_angle\":");
                                        if (angle_start) {
                                            sscanf(angle_start + 16, "%f", &desired_angle);
                                        }
                                        
                                        handle_ship_sail_angle_control(player, client, ship, desired_angle);
                                    } else {
                                        log_warn("Player %u controlling non-existent ship %u", player->player_id, player->controlling_ship_id);
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    }
                                } else {
                                    log_warn("Ship sail angle control from player %u not controlling a ship", client->player_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_controlling_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"cannon_aim\"")) {
                            // CANNON AIM message
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    // Parse aim_angle
                                    float aim_angle = 0.0f;
                                    char* angle_start = strstr(payload, "\"aim_angle\":");
                                    if (angle_start) {
                                        sscanf(angle_start + 12, "%f", &aim_angle);
                                    }
                                    
                                    handle_cannon_aim(player, aim_angle);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"aim_updated\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"cannon_fire\"")) {
                            // CANNON FIRE message
                            log_info("💥 Processing CANNON_FIRE message");
                            
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    // Parse fire_all flag
                                    bool fire_all = strstr(payload, "\"fire_all\":true") != NULL;
                                    
                                    handle_cannon_fire(player, fire_all);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"cannons_fired\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"ping\"")) {
                            // JSON ping message
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"pong\",\"timestamp\":%u,\"server_time\":%u}",
                                    get_time_ms(), get_time_ms());
                            handled = true;
                            
                        } else {
                            // Unknown JSON message
                            ws_server.unknown_messages_received++;
                            ws_server.last_unknown_time = get_time_ms();
                            
                            log_warn("❓ Unknown JSON message type from %s:%u (Player: %u)", 
                                     client->ip_address, client->port, client->player_id);
                            log_warn("❓ Full unknown message: %.*s", (int)payload_len, payload);
                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"processed\"}");
                            handled = true;
                        }
                        
                    } else {
                        // Text command (simple protocol)
                        if (strncmp(payload, "PING", 4) == 0) {
                            strcpy(response, "PONG");
                            handled = true;
                            
                        } else if (strncmp(payload, "JOIN:", 5) == 0) {
                            // Extract player name (with safety limits)
                            char player_name[64] = "Player";  // Default name
                            const char* name_src = payload + 5;
                            size_t max_name_len = payload_len - 5;
                            if (max_name_len > sizeof(player_name) - 1) {
                                max_name_len = sizeof(player_name) - 1;
                            }
                            if (max_name_len > 0) {
                                strncpy(player_name, name_src, max_name_len);
                                player_name[max_name_len] = '\0';
                                // Remove any newlines or control characters
                                for (size_t i = 0; i < sizeof(player_name); i++) {
                                    if (player_name[i] == '\0') break;
                                    if (player_name[i] < 32 || player_name[i] > 126) {
                                        player_name[i] = '\0';
                                        break;
                                    }
                                }
                            }
                            
                            uint32_t player_id = next_player_id++;
                            client->player_id = player_id;
                            
                            // Create player for this client
                            WebSocketPlayer* player = create_player(player_id);
                            if (!player) {
                                log_error("Failed to create player for JOIN command from %s:%u", client->ip_address, client->port);
                                client->player_id = 0; // Reset on failure
                                strcpy(response, "{\"type\":\"handshake_response\",\"status\":\"failed\",\"error\":\"server_full\"}");
                            } else {
                                snprintf(response, sizeof(response),
                                        "{\"type\":\"handshake_response\",\"player_id\":%u,\"player_name\":\"%s\",\"server_time\":%u,\"status\":\"connected\"}",
                                        player_id, player_name, get_time_ms());
                                // Player joined
                            }
                            handled = true;
                            
                        } else if (strncmp(payload, "STATE", 5) == 0) {
                            // Request game state
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":[],\"players\":[{\"id\":1001,\"name\":\"Player\",\"x\":400,\"y\":300}],\"projectiles\":[]}",
                                    get_time_ms() / 33, get_time_ms()); // Approximate tick from time
                            handled = true;
                            
                        } else {
                            // Unknown command
                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"unknown_command\"}");
                            handled = true;
                        }
                    }
                    
                    // Send response
                    if (handled) {
                        char frame[2048];  // Increased to safely hold 1024-byte response + frame headers
                        size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
                        if (frame_len > 0 && frame_len < sizeof(frame)) {
                            ssize_t sent = send(client->fd, frame, frame_len, 0);
                            if (sent > 0) {
                                ws_server.packets_sent++;
                                // Response sent
                            }
                        } else if (frame_len >= sizeof(frame)) {
                            log_error("Frame buffer overflow prevented! frame_len=%zu, buffer=%zu", 
                                     frame_len, sizeof(frame));
                        }
                    }
                    
                    ws_server.packets_received++;
                    
                } else if (opcode == WS_OPCODE_CLOSE) {
                    // CLOSE frame received
                    if (client->player_id > 0) {
                        // Removing player due to disconnect
                        remove_player(client->player_id);
                        client->player_id = 0;
                    }
                    close(client->fd);
                    client->connected = false;
                } else if (opcode == WS_OPCODE_PING) {
                    // PING received - sending PONG
                    // Respond with pong
                    char frame[64];
                    size_t frame_len = websocket_create_frame(WS_OPCODE_PONG, payload, payload_len, frame, sizeof(frame));
                    if (frame_len > 0) {
                        ssize_t sent = send(client->fd, frame, frame_len, 0);
                        // PONG sent
                    }
                } else if (opcode == WS_OPCODE_PONG) {
                    // PONG received
                } else {
                    log_warn("⚠️ Unknown WebSocket opcode 0x%X from %s:%u (Player: %u)", 
                            opcode, client->ip_address, client->port, client->player_id);
                }
            }
        } else if (received == 0) {
            // Client disconnected
            // WebSocket client disconnected
            if (client->player_id > 0) {
                remove_player(client->player_id);
                client->player_id = 0;
            }
            close(client->fd);
            client->connected = false;
        } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
            // Error
            log_warn("WebSocket client %s:%u error: %s", client->ip_address, client->port, strerror(errno));
            if (client->player_id > 0) {
                remove_player(client->player_id);
                client->player_id = 0;
            }
            close(client->fd);
            client->connected = false;
        }
    }
    
    // Adaptive game state updates - 20Hz base, 30Hz max
    static uint32_t last_game_state_time = 0;
    static uint32_t last_debug_time = 0;
    static uint32_t current_update_rate = 20; // Start at 20 Hz
    uint32_t current_time = get_time_ms();
    
    // Debug player state every 10 seconds
    if (current_time - last_debug_time > 10000) {
        debug_player_state();
        last_debug_time = current_time;
    }
    
    // Calculate adaptive update interval (milliseconds)
    uint32_t update_interval = 1000 / current_update_rate; // 20Hz = 50ms, 30Hz = 33ms
    
    if (current_time - last_game_state_time > update_interval) {
        // Build ships JSON array with physics properties and modules
        char ships_json[8192];
        int ships_offset = 0;
        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "[");
        bool first_ship = true;
        
        // Log which ship source we're using
        static uint32_t last_ship_source_log = 0;
        if (current_time - last_ship_source_log > 5000) {
            log_info("📦 Ship source: sim=%p, sim->ship_count=%d, simple_ship_count=%d",
                     (void*)sim, sim ? sim->ship_count : 0, ship_count);
            if (ship_count > 0) {
                log_info("📦 Simple ship[0]: module_count=%d", ships[0].module_count);
            }
            last_ship_source_log = current_time;
        }
        
        // Use actual simulation ships if available
        if (sim && sim->ship_count > 0) {
            for (uint32_t s = 0; s < sim->ship_count; s++) {
                const struct Ship* ship = &sim->ships[s];
                if (!first_ship) {
                    ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, ",");
                }
                
                // Convert ship physics to client units
                float pos_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.x));
                float pos_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.y));
                float rotation = Q16_TO_FLOAT(ship->rotation);
                float vel_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->velocity.x));
                float vel_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->velocity.y));
                float ang_vel = Q16_TO_FLOAT(ship->angular_velocity);
                float rudder_radians = ship->rudder_angle * (3.14159f / 180.0f); // Convert degrees to radians
                
                char ship_entry[4096];
                int offset = snprintf(ship_entry, sizeof(ship_entry),
                        "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                        "\"mass\":%.1f,\"moment_of_inertia\":%.1f,"
                        "\"max_speed\":%.1f,\"turn_rate\":%.2f,"
                        "\"water_drag\":%.3f,\"angular_drag\":%.3f,\"rudder_angle\":%.3f,\"modules\":[",
                        ship->id, pos_x, pos_y, rotation, vel_x, vel_y, ang_vel,
                        5000.0f, 500000.0f, 15.0f, 1.0f, 0.95f, 0.90f, rudder_radians);
                
                // Add modules array
                // Planks (100-109) and deck (200): only send health/ID, client generates positions
                // Gameplay modules (1000+): send full transform
                for (uint8_t m = 0; m < ship->module_count && offset < (int)sizeof(ship_entry) - 200; m++) {
                    const ShipModule* module = &ship->modules[m];
                    
                    if (module->type_id == MODULE_TYPE_PLANK) {
                        // Plank: only health data (client has hard-coded positions from hull)
                        offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                            "%s{\"id\":%u,\"typeId\":%u,\"health\":%u}",
                            m > 0 ? "," : "", module->id, module->type_id, module->data.plank.health);
                    } else if (module->type_id == MODULE_TYPE_DECK) {
                        // Deck: only ID/type (client generates polygon from hull)
                        offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                            "%s{\"id\":%u,\"typeId\":%u}",
                            m > 0 ? "," : "", module->id, module->type_id);
                    } else {
                        // Gameplay modules: full transform data
                        float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                        float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                        float module_rot = Q16_TO_FLOAT(module->local_rot);
                        
                        // Add module-specific data based on type
                        if (module->type_id == MODULE_TYPE_MAST) {
                            // Mast: include openness and sail angle
                            float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.mast.openness, sail_angle);
                        } else if (module->type_id == MODULE_TYPE_CANNON) {
                            // Cannon: include ammunition and aim direction
                            float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"ammo\":%u,\"aimDir\":%.3f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.cannon.ammunition, aim_direction);
                        } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                            // Helm: include wheel rotation and occupied status
                            float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, wheel_rot, 
                                (module->data.helm.occupied_by != 0) ? "true" : "false");
                        } else {
                            // Generic module: just transform data
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot);
                        }
                    }
                }
                
                offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset, "]}");
                ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "%s", ship_entry);
                first_ship = false;
            }
        } else {
            // Fallback to simple ships array (backward compatibility)
            for (int s = 0; s < ship_count; s++) {
                if (ships[s].active) {
                    if (!first_ship) {
                        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, ",");
                    }
                    
                    // Build ship entry with modules
                    char ship_entry[4096];
                    int offset = snprintf(ship_entry, sizeof(ship_entry),
                            "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                            "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                            "\"mass\":%.1f,\"moment_of_inertia\":%.1f,"
                            "\"max_speed\":%.1f,\"turn_rate\":%.2f,"
                            "\"water_drag\":%.3f,\"angular_drag\":%.3f,\"rudder_angle\":%.3f,\"modules\":[",
                            ships[s].ship_id, ships[s].x, ships[s].y, ships[s].rotation,
                            ships[s].velocity_x, ships[s].velocity_y, ships[s].angular_velocity,
                            ships[s].mass, ships[s].moment_of_inertia,
                            ships[s].max_speed, ships[s].turn_rate,
                            ships[s].water_drag, ships[s].angular_drag, 0.0f);
                    
                    // Add modules from simple ships
                    for (int m = 0; m < ships[s].module_count && offset < (int)sizeof(ship_entry) - 200; m++) {
                        const ShipModule* module = &ships[s].modules[m];
                        float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                        float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                        float module_rot = Q16_TO_FLOAT(module->local_rot);
                        
                        // Add module-specific data based on type
                        if (module->type_id == MODULE_TYPE_MAST) {
                            // Mast: include openness and sail angle
                            float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.mast.openness, sail_angle);
                        } else if (module->type_id == MODULE_TYPE_CANNON) {
                            // Cannon: include ammunition and aim direction
                            float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"ammo\":%u,\"aimDir\":%.3f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.cannon.ammunition, aim_direction);
                        } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                            // Helm: include wheel rotation and occupied status
                            float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, wheel_rot, 
                                (module->data.helm.occupied_by != 0) ? "true" : "false");
                        } else {
                            // Generic module: just transform data
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot);
                        }
                    }
                    
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset, "]}");
                    ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "%s", ship_entry);
                    first_ship = false;
                }
            }
        }
        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "]");
        
        // Build players JSON array with ship relationship data
        char players_json[2048];
        int players_offset = 0;
        players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, "[");
        bool first_player = true;
        int active_count = 0;
        
        for (int p = 0; p < WS_MAX_CLIENTS; p++) {
            if (players[p].active) {
                if (!first_player) {
                    players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, ",");
                }
                char player_entry[384];  // Increased size for additional fields
                snprintf(player_entry, sizeof(player_entry),
                        "{\"id\":%u,\"name\":\"Player_%u\",\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"is_moving\":%s,"
                        "\"movement_direction_x\":%.2f,\"movement_direction_y\":%.2f,"
                        "\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\","
                        "\"is_mounted\":%s,\"mounted_module_id\":%u,\"controlling_ship\":%u}",
                        players[p].player_id, players[p].player_id, 
                        players[p].x, players[p].y, players[p].rotation,
                        players[p].velocity_x, players[p].velocity_y, 
                        players[p].is_moving ? "true" : "false",
                        players[p].movement_direction_x, players[p].movement_direction_y,
                        players[p].parent_ship_id, players[p].local_x, players[p].local_y,
                        get_state_string(players[p].movement_state),
                        players[p].is_mounted ? "true" : "false",
                        players[p].mounted_module_id,
                        players[p].controlling_ship_id);
                players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, "%s", player_entry);
                first_player = false;
                active_count++;
            }
        }
        players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, "]");
        
        // Build projectiles JSON array
        char projectiles_json[2048];
        int projectiles_offset = 0;
        projectiles_offset += snprintf(projectiles_json + projectiles_offset, sizeof(projectiles_json) - projectiles_offset, "[");
        bool first_projectile = true;
        
        // Debug: Log projectile count
        static uint32_t last_projectile_log = 0;
        if (current_time - last_projectile_log > 2000 && global_sim) {
            log_info("🎯 Projectile count: %u", global_sim->projectile_count);
            last_projectile_log = current_time;
        }
        
        if (global_sim && global_sim->projectile_count > 0) {
            for (uint16_t p = 0; p < global_sim->projectile_count; p++) {
                struct Projectile* proj = &global_sim->projectiles[p];
                
                if (!first_projectile) {
                    projectiles_offset += snprintf(projectiles_json + projectiles_offset, 
                                                  sizeof(projectiles_json) - projectiles_offset, ",");
                }
                
                float proj_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.x));
                float proj_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.y));
                float proj_vx = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->velocity.x));
                float proj_vy = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->velocity.y));
                
                projectiles_offset += snprintf(projectiles_json + projectiles_offset, 
                                              sizeof(projectiles_json) - projectiles_offset,
                                              "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"vx\":%.1f,\"vy\":%.1f,\"type\":%u,\"owner\":%u}",
                                              proj->id, proj_x, proj_y, proj_vx, proj_vy, proj->type, proj->owner_id);
                first_projectile = false;
            }
        }
        projectiles_offset += snprintf(projectiles_json + projectiles_offset, sizeof(projectiles_json) - projectiles_offset, "]");
        
        // Adaptive tick rate based on activity
        bool has_recent_movement = (current_time - g_last_movement_time) < 2000; // Movement in last 2 seconds
        
        // Determine optimal update rate
        if (active_count == 0) {
            current_update_rate = 5; // 5Hz when no players
        } else if (has_recent_movement && active_count > 1) {
            current_update_rate = 30; // 30Hz during multiplayer action
        } else if (has_recent_movement) {
            current_update_rate = 25; // 25Hz during single player movement
        } else {
            current_update_rate = 20; // 20Hz baseline
        }
        
        // Cap at maximum rate
        if (current_update_rate > 30) current_update_rate = 30;
        
        // Broadcasting game state
        
        char game_state[6144];  // Increased buffer size for ships + players + projectiles
        snprintf(game_state, sizeof(game_state),
                "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":%s,\"players\":%s,\"projectiles\":%s}",
                current_time / 33, current_time, ships_json, players_json, projectiles_json);
        
        // Broadcast to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                char frame[8192];  // Large enough for game state with ships + players + projectiles + modules
                size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, game_state, strlen(game_state), frame, sizeof(frame));
                if (frame_len > 0) {
                    ssize_t sent = send(client->fd, frame, frame_len, 0);
                    if (sent > 0) {
                        ws_server.packets_sent++;
                    }
                }
            }
        }
        last_game_state_time = current_time;
    }
    
    // ===== BROADCAST WORLD STATE (WIND, ETC.) =====
    static uint32_t last_world_state_time = 0;
    if (current_time - last_world_state_time >= 5000) { // Every 5 seconds
        char world_state[256];
        float wind_power = global_sim ? global_sim->wind_power : 0.0f;
        float wind_direction = global_sim ? global_sim->wind_direction : 0.0f;
        
        snprintf(world_state, sizeof(world_state),
                "{\"type\":\"WORLD_STATE\",\"windPower\":%.2f,\"windDirection\":%.2f}",
                wind_power, wind_direction);
        
        // Broadcast to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                char frame[512];
                size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, world_state, strlen(world_state), frame, sizeof(frame));
                if (frame_len > 0) {
                    send(client->fd, frame, frame_len, 0);
                }
            }
        }
        last_world_state_time = current_time;
    }
    
    return 0;
}

void websocket_server_broadcast(const char* message) {
    if (!ws_server.running || !message) return;
    
    char frame[2048];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    if (frame_len == 0) return;
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (ws_server.clients[i].connected && ws_server.clients[i].handshake_complete) {
            ssize_t sent = send(ws_server.clients[i].fd, frame, frame_len, 0);
            if (sent <= 0) {
                log_warn("Failed to send WebSocket broadcast to client %d", i);
            }
        }
    }
}

int websocket_server_get_stats(struct WebSocketStats* stats) {
    if (!stats) return -1;
    
    stats->connected_clients = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (ws_server.clients[i].connected && ws_server.clients[i].handshake_complete) {
            stats->connected_clients++;
        }
    }
    
    stats->packets_sent = ws_server.packets_sent;
    stats->packets_received = ws_server.packets_received;
    stats->input_messages_received = ws_server.input_messages_received;
    stats->unknown_messages_received = ws_server.unknown_messages_received;
    stats->last_input_time = ws_server.last_input_time;
    stats->last_unknown_time = ws_server.last_unknown_time;
    stats->port = ws_server.port;
    
    return 0;
}

// Get WebSocket ships data for admin panel
int websocket_server_get_ships(SimpleShip** out_ships, int* out_count) {
    if (!out_ships || !out_count) return -1;
    *out_ships = ships;
    *out_count = ship_count;
    return 0;
}

// Get WebSocket players data for admin panel
int websocket_server_get_players(WebSocketPlayer** out_players, int* out_count) {
    if (!out_players || !out_count) return -1;
    
    // Count active players
    int active_count = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active) {
            active_count++;
        }
    }
    
    *out_players = players;
    *out_count = active_count;
    return 0;
}

// HYBRID: Apply movement state to all active players (called every server tick)
void websocket_server_tick(float dt) {
    static uint32_t last_tick_log_time = 0;
    uint32_t current_time = get_time_ms();
    
    // ===== SYNC SHIP STATE FROM SIMULATION =====
    // This ensures SimpleShip has current position/rotation for mounted player updates
    sync_simple_ships_from_simulation();
    
    int moving_players = 0;
    
    // Count moving players (for adaptive tick rate)
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].is_moving) {
            moving_players++;
        }
    }
    
    // ===== SYNC WEBSOCKET PLAYERS TO SIMULATION FOR COLLISION DETECTION =====
    if (global_sim) {
        // Physics constants (scaled to server units via WORLD_SCALE_FACTOR)
        const float SWIM_ACCELERATION = CLIENT_TO_SERVER(160.0f); // Acceleration when swimming (server units/s²)
        const float SWIM_MAX_SPEED = CLIENT_TO_SERVER(30.0f);     // Maximum swimming speed (server units/s)
        const float SWIM_DECELERATION = CLIENT_TO_SERVER(120.0f); // Deceleration when stopping (server units/s²)
        
        const float WALK_ACCELERATION = CLIENT_TO_SERVER(240.0f); // Acceleration when walking on deck (server units/s²)
        const float WALK_MAX_SPEED = CLIENT_TO_SERVER(40.0f);     // Maximum walking speed on deck (server units/s)
        const float WALK_DECELERATION = CLIENT_TO_SERVER(180.0f); // Deceleration when stopping on deck (server units/s²)
        
        for (uint16_t i = 0; i < global_sim->player_count; i++) {
            struct Player* sim_player = &global_sim->players[i];
            
            // Find corresponding WebSocket player by simulation entity ID
            WebSocketPlayer* ws_player = find_player_by_sim_id(sim_player->id);
            if (ws_player && ws_player->active) {
                // Sync ship boarding state to simulation for collision filtering
                if (ws_player->parent_ship_id != 0) {
                    // Player is on a ship - disable ship collision
                    sim_player->ship_id = ws_player->parent_ship_id;
                } else {
                    // Player is swimming - enable ship collision
                    sim_player->ship_id = INVALID_ENTITY_ID;
                }
                
                // Check if player is on a ship
                bool on_ship = (ws_player->parent_ship_id != 0);
                SimpleShip* player_ship = NULL;
                if (on_ship) {
                    // Find the ship
                    for (int s = 0; s < ship_count; s++) {
                        if (ships[s].active && ships[s].ship_id == ws_player->parent_ship_id) {
                            player_ship = &ships[s];
                            break;
                        }
                    }
                }
                
                // Players who are mounted cannot move - they're locked to the module position
                if (ws_player->is_mounted) {
                    // Mounted players stay at their mount position
                    // Their world position still updates as the ship moves/rotates
                    if (on_ship && player_ship) {
                        ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y,
                                          &ws_player->x, &ws_player->y);
                    }
                    // Skip movement processing
                } else if (ws_player->is_moving) {
                    // Player is actively moving
                    float movement_x = ws_player->movement_direction_x;
                    float movement_y = ws_player->movement_direction_y;
                    float magnitude = sqrtf(movement_x * movement_x + movement_y * movement_y);
                    
                    if (magnitude > 0.01f) {
                        // Normalize movement direction
                        movement_x /= magnitude;
                        movement_y /= magnitude;
                        
                        if (on_ship && player_ship) {
                            // ===== ON-SHIP MOVEMENT (LOCAL COORDINATES) =====
                            // Movement is in world space, need to convert to ship-local space
                            float ship_cos = cosf(player_ship->rotation);
                            float ship_sin = sinf(player_ship->rotation);
                            
                            // Rotate movement vector to ship-local coordinates
                            float local_move_x = movement_x * ship_cos + movement_y * ship_sin;
                            float local_move_y = -movement_x * ship_sin + movement_y * ship_cos;
                            
                            // Apply movement in local coordinates (direct velocity, not acceleration)
                            // Note: local_x/y are stored in CLIENT coordinates, so convert speed back to client
                            float walk_speed_client = SERVER_TO_CLIENT(WALK_MAX_SPEED);
                            float new_local_x = ws_player->local_x + local_move_x * walk_speed_client * dt;
                            float new_local_y = ws_player->local_y + local_move_y * walk_speed_client * dt;
                            
                            log_info("🚶 P%u: Move calc | speed=%.2f client/s | dt=%.4f | delta=(%.4f, %.4f) | old_local=(%.2f, %.2f) | new_local=(%.2f, %.2f)",
                                     ws_player->player_id, walk_speed_client, dt,
                                     local_move_x * walk_speed_client * dt, local_move_y * walk_speed_client * dt,
                                     ws_player->local_x, ws_player->local_y,
                                     new_local_x, new_local_y);
                            
                            // Check if player would walk off the deck (hull boundary)
                            if (is_outside_deck(player_ship->ship_id, new_local_x, new_local_y)) {
                                // Player walked off the edge - dismount into water
                                log_info("🌊 Player %u walked off the deck of ship %u (tick movement)", 
                                         ws_player->player_id, player_ship->ship_id);
                                
                                // Keep current position (at edge), then dismount
                                // Convert to world position before dismounting
                                ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y, 
                                                  &ws_player->x, &ws_player->y);
                                
                                // Dismount player
                                dismount_player_from_ship(ws_player, "walked_off_deck");
                                
                                // Continue movement in water (set velocity to swim at max speed in movement direction)
                                ws_player->velocity_x = movement_x * SWIM_MAX_SPEED;
                                ws_player->velocity_y = movement_y * SWIM_MAX_SPEED;
                                
                                // Clear simulation ship_id (now swimming)
                                sim_player->ship_id = INVALID_ENTITY_ID;
                            } else {
                                // Normal movement on deck
                                ws_player->local_x = new_local_x;
                                ws_player->local_y = new_local_y;
                                
                                // Update world position from local position
                                ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y,
                                                  &ws_player->x, &ws_player->y);
                                
                                // Sync to simulation relative_pos
                                sim_player->relative_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->local_x));
                                sim_player->relative_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->local_y));
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->y));
                                
                                log_info("🚶 P%u: Walking on ship %u | local=(%.2f, %.2f) | world=(%.2f, %.2f)",
                                         sim_player->id, ws_player->parent_ship_id,
                                         ws_player->local_x, ws_player->local_y,
                                         ws_player->x, ws_player->y);
                            }
                        } else {
                            // ===== SWIMMING MOVEMENT (WORLD COORDINATES) =====
                            // Apply acceleration in movement direction
                            q16_t accel_x = Q16_FROM_FLOAT(movement_x * SWIM_ACCELERATION * dt);
                            q16_t accel_y = Q16_FROM_FLOAT(movement_y * SWIM_ACCELERATION * dt);
                            
                            log_info("⚡ P%u: Swimming | accel=(%.2f, %.2f) | dir=(%.2f, %.2f) | dt=%.3f",
                                     sim_player->id,
                                     Q16_TO_FLOAT(accel_x), Q16_TO_FLOAT(accel_y),
                                     movement_x, movement_y, dt);
                            
                            sim_player->velocity.x += accel_x;
                            sim_player->velocity.y += accel_y;
                            
                            // Clamp to maximum speed
                            float current_vx = Q16_TO_FLOAT(sim_player->velocity.x);
                            float current_vy = Q16_TO_FLOAT(sim_player->velocity.y);
                            float current_speed = sqrtf(current_vx * current_vx + current_vy * current_vy);
                            
                            if (current_speed > SWIM_MAX_SPEED) {
                                // Scale velocity back to max speed
                                float scale = SWIM_MAX_SPEED / current_speed;
                                log_info("🚀 P%u: Speed clamped %.2f → %.2f m/s | vel=(%.2f, %.2f) → (%.2f, %.2f)",
                                         sim_player->id,
                                         current_speed, SWIM_MAX_SPEED,
                                         current_vx, current_vy,
                                         current_vx * scale, current_vy * scale);
                                sim_player->velocity.x = Q16_FROM_FLOAT(current_vx * scale);
                                sim_player->velocity.y = Q16_FROM_FLOAT(current_vy * scale);
                            }
                        }
                    }
                } else {
                    // Player stopped moving - no deceleration needed for on-ship movement
                    // (player position is fixed relative to ship, ship velocity handles world movement)
                    if (!on_ship) {
                        // Only apply deceleration for swimming players
                        float current_vx = Q16_TO_FLOAT(sim_player->velocity.x);
                        float current_vy = Q16_TO_FLOAT(sim_player->velocity.y);
                        float current_speed = sqrtf(current_vx * current_vx + current_vy * current_vy);
                        
                        if (current_speed > 0.1f) {
                            // Apply deceleration opposite to velocity direction
                            float decel_amount = SWIM_DECELERATION * dt;
                            
                            if (decel_amount >= current_speed) {
                                // Stop completely
                                log_info("🛑 P%u: Stopping | speed=%.2f → 0.00 m/s | vel=(%.2f, %.2f) → (0.00, 0.00)",
                                         sim_player->id, current_speed, current_vx, current_vy);
                                sim_player->velocity.x = 0;
                                sim_player->velocity.y = 0;
                            } else {
                                // Reduce speed
                                float scale = (current_speed - decel_amount) / current_speed;
                                float new_vx = current_vx * scale;
                                float new_vy = current_vy * scale;
                                log_info("⬇️ P%u: Decelerating | speed=%.2f → %.2f m/s | vel=(%.2f, %.2f) → (%.2f, %.2f)",
                                         sim_player->id,
                                         current_speed, current_speed - decel_amount,
                                         current_vx, current_vy, new_vx, new_vy);
                                sim_player->velocity.x = Q16_FROM_FLOAT(new_vx);
                                sim_player->velocity.y = Q16_FROM_FLOAT(new_vy);
                            }
                        } else if (current_speed > 0.01f) {
                            // Snap to zero for very low speeds
                            log_info("🛑 P%u: Snap to zero | speed=%.2f m/s (below threshold)",
                                     sim_player->id, current_speed);
                            sim_player->velocity.x = 0;
                            sim_player->velocity.y = 0;
                        }
                    }
                }
                
                // Copy simulation position BACK to WebSocket player for rendering (scale to client coords)
                // BUT: For players on ships, their world position is calculated from local coords + ship transform
                // So we only copy back position for swimming players
                if (!on_ship) {
                    ws_player->x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->position.x));
                    ws_player->y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->position.y));
                    ws_player->velocity_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->velocity.x));
                    ws_player->velocity_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->velocity.y));
                } else {
                    // For on-ship players, recalculate world position from local coords
                    // (ship might have moved/rotated since last tick)
                    if (player_ship) {
                        ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y,
                                          &ws_player->x, &ws_player->y);
                    }
                    // On-ship players have zero velocity (movement is relative to ship)
                    ws_player->velocity_x = 0.0f;
                    ws_player->velocity_y = 0.0f;
                }
            }
        }
    }
    
    // ===== GRADUALLY ADJUST SHIP SAILS TO DESIRED OPENNESS =====
    // Rate: 10% per 0.2 seconds = 50% per second
    const float SAIL_ADJUST_RATE = 50.0f; // percent per second
    static uint32_t last_sail_update = 0;
    
    // Update sails at fixed intervals (200ms = 0.2s for 10% change)
    if (current_time - last_sail_update >= 200) {
        float time_delta = (current_time - last_sail_update) / 1000.0f; // Convert to seconds
        float max_change = SAIL_ADJUST_RATE * time_delta; // How much we can change this update
        
        // Update simulation ships (the ones we broadcast to clients)
        if (global_sim && global_sim->ship_count > 0) {
            for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                struct Ship* ship = &global_sim->ships[s];
                uint8_t desired = ship->desired_sail_openness;
                
                // For each mast on the ship, gradually adjust to desired openness
                for (uint8_t m = 0; m < ship->module_count; m++) {
                    if (ship->modules[m].type_id == MODULE_TYPE_MAST) {
                        uint8_t current = ship->modules[m].data.mast.openness;
                        
                        if (current != desired) {
                            float diff = (float)desired - (float)current;
                            float change = diff;
                            
                            // Clamp change to max rate (10% per 0.2s)
                            if (change > max_change) change = max_change;
                            if (change < -max_change) change = -max_change;
                            
                            uint8_t new_openness = (uint8_t)((float)current + change);
                            
                            // Clamp to valid range
                            if (new_openness > 100) new_openness = 100;
                            
                            ship->modules[m].data.mast.openness = new_openness;
                            
                            // Log only when there's a visible change
                            if (new_openness != current) {
                                log_info("⛵ Ship %u Mast %u: %u%% → %u%% (target: %u%%)",
                                       ship->id, ship->modules[m].id,
                                       current, new_openness, desired);
                            }
                        }
                    }
                }
            }
        }
        
        last_sail_update = current_time;
    }
    
    // ===== GRADUALLY ADJUST RUDDER ANGLE TO TARGET =====
    // Rate: 5 degrees per 0.2 seconds = 25 degrees per second
    const float RUDDER_ADJUST_RATE = 25.0f; // degrees per second
    static uint32_t last_rudder_update = 0;
    
    if (current_time - last_rudder_update >= 200) {
        float time_delta = (current_time - last_rudder_update) / 1000.0f;
        float max_rudder_change = RUDDER_ADJUST_RATE * time_delta; // 5 degrees per 0.2s
        
        if (global_sim && global_sim->ship_count > 0) {
            for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                struct Ship* ship = &global_sim->ships[s];
                
                // Gradually move rudder to target angle
                if (ship->rudder_angle != ship->target_rudder_angle) {
                    float diff = ship->target_rudder_angle - ship->rudder_angle;
                    float change = diff;
                    
                    // Clamp change to max rate
                    if (change > max_rudder_change) change = max_rudder_change;
                    if (change < -max_rudder_change) change = -max_rudder_change;
                    
                    ship->rudder_angle += change;
                    
                    // Clamp to valid range
                    if (ship->rudder_angle > 50.0f) ship->rudder_angle = 50.0f;
                    if (ship->rudder_angle < -50.0f) ship->rudder_angle = -50.0f;
                }
            }
        }
        
        last_rudder_update = current_time;
    }
    
    // ===== UPDATE CANNON RELOAD TIMERS =====
    // Track time since last fire for each cannon
    static uint32_t last_cannon_update = 0;
    
    if (current_time - last_cannon_update >= 100) { // Update every 100ms
        uint32_t time_elapsed = current_time - last_cannon_update;
        
        if (global_sim && global_sim->ship_count > 0) {
            for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                struct Ship* ship = &global_sim->ships[s];
                
                for (uint8_t m = 0; m < ship->module_count; m++) {
                    if (ship->modules[m].type_id == MODULE_TYPE_CANNON) {
                        ShipModule* cannon = &ship->modules[m];
                        
                        // Increment time since fire (capped at reload time)
                        if (cannon->data.cannon.time_since_fire < cannon->data.cannon.reload_time) {
                            cannon->data.cannon.time_since_fire += time_elapsed;
                            
                            // Clamp to reload time
                            if (cannon->data.cannon.time_since_fire > cannon->data.cannon.reload_time) {
                                cannon->data.cannon.time_since_fire = cannon->data.cannon.reload_time;
                            }
                        }
                    }
                }
            }
        }
        
        last_cannon_update = current_time;
    }
    
    // ===== APPLY WIND-BASED SHIP MOVEMENT =====
    static uint32_t last_movement_log = 0;
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            struct Ship* ship = &global_sim->ships[s];
            
            // Calculate average sail openness across all masts
            float total_openness = 0.0f;
            int mast_count = 0;
            for (uint8_t m = 0; m < ship->module_count; m++) {
                if (ship->modules[m].type_id == MODULE_TYPE_MAST) {
                    total_openness += ship->modules[m].data.mast.openness;
                    mast_count++;
                }
            }
            float avg_sail_openness = (mast_count > 0) ? (total_openness / mast_count) : 0.0f;
            
            // Calculate forward force from wind and sails
            // Wind power (0-1) * sail openness (0-100) * base speed
            const float BASE_WIND_SPEED = 25.0f; // meters per second at full wind, full sails (5x increased)
            float wind_force_factor = (global_sim->wind_power * avg_sail_openness / 100.0f);
            float target_speed = BASE_WIND_SPEED * wind_force_factor;
            
            // Get current ship speed (magnitude of velocity)
            float vx = Q16_TO_FLOAT(ship->velocity.x);
            float vy = Q16_TO_FLOAT(ship->velocity.y);
            float current_speed = sqrtf(vx * vx + vy * vy);
            
            // Apply forward force in ship's facing direction
            float ship_rot = Q16_TO_FLOAT(ship->rotation);
            float target_vx = cosf(ship_rot) * target_speed;
            float target_vy = sinf(ship_rot) * target_speed;
            
            // Debug logging every 2 seconds
            if (current_time - last_movement_log > 2000 && avg_sail_openness > 0) {
                log_info("⛵ Ship %u: masts=%d, avg_openness=%.1f%%, wind=%.2f, target_speed=%.2f m/s, current_speed=%.2f m/s, pos=(%.1f,%.1f)",
                         ship->id, mast_count, avg_sail_openness, global_sim->wind_power, target_speed, current_speed,
                         SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.x)), SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.y)));
                last_movement_log = current_time;
            }
            
            // Smoothly accelerate toward target velocity
            // Using exponential smoothing: vel += (target - vel) * blend_factor
            // Higher blend factor = faster acceleration (1.0 = instant, 0.0 = no change)
            const float WIND_ACCEL_RATE = 2.0f; // How many seconds to reach 63% of target speed
            float blend_factor = 1.0f - expf(-dt / WIND_ACCEL_RATE);
            
            vx += (target_vx - vx) * blend_factor;
            vy += (target_vy - vy) * blend_factor;
            
            ship->velocity.x = Q16_FROM_FLOAT(vx);
            ship->velocity.y = Q16_FROM_FLOAT(vy);
            
            // Recalculate current speed after velocity update (for turning calculation)
            current_speed = sqrtf(vx * vx + vy * vy);
            
            // ===== APPLY RUDDER-BASED TURNING =====
            // Turning effectiveness depends on ship speed
            float speed_factor = current_speed / BASE_WIND_SPEED; // 0 = stopped, 1 = full speed
            if (speed_factor < 0.01f) {
                // Ship is stopped - can still turn slowly in place
                speed_factor = 0.05f; // Minimum turning ability when stopped
            }
            
            // Convert rudder angle to turning rate
            // Max rudder (50°) at full speed = max turn rate
            const float MAX_TURN_RATE = 0.5f; // radians per second at full speed
            float rudder_factor = ship->rudder_angle / 50.0f; // -1 to +1
            float turn_rate = rudder_factor * MAX_TURN_RATE * speed_factor;
            
            // Apply angular velocity
            ship->angular_velocity = Q16_FROM_FLOAT(turn_rate);
            
            // Apply rotation from angular velocity
            float new_rotation = ship_rot + (turn_rate * dt);
            ship->rotation = Q16_FROM_FLOAT(new_rotation);
            
            // Apply velocity to position
            ship->position.x += Q16_FROM_FLOAT(vx * dt);
            ship->position.y += Q16_FROM_FLOAT(vy * dt);
        }
    }
    
    // Tick processing complete
    last_tick_log_time = current_time;
}