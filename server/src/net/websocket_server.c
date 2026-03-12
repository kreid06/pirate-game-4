#include "net/websocket_server.h"
#include "sim/ship_level.h"
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
    /* Set when a cannon_group_config was processed this message-loop iteration.
     * Broadcast is deferred until all messages from this client in the current
     * frame have been handled, so a burst of group-config messages (e.g. the
     * client switching two groups to AIMING simultaneously) produces exactly
     * one broadcast rather than one per message. */
    uint32_t pending_group_broadcast_ship_id;
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

// ── Company / Alliance registry ───────────────────────────────────────────
typedef struct { uint8_t id; const char* name; uint8_t alliance_id; } Company;
static const Company g_companies[] = {
    { COMPANY_NEUTRAL, "Neutral", 0 },
    { COMPANY_PIRATES, "Pirates", 1 },
    { COMPANY_NAVY,    "Navy",    2 },
};
// Returns true if companies a and b are in the same non-zero alliance (i.e. friendly).
static bool is_allied(uint8_t a, uint8_t b) {
    if (a == COMPANY_NEUTRAL || b == COMPANY_NEUTRAL) return false;
    if (a == b) return true;
    uint8_t a_al = 0, b_al = 0;
    for (int i = 0; i < 3; i++) {
        if (g_companies[i].id == a) a_al = g_companies[i].alliance_id;
        if (g_companies[i].id == b) b_al = g_companies[i].alliance_id;
    }
    return a_al != 0 && a_al == b_al;
}
static const char* company_name(uint8_t id) {
    for (int i = 0; i < 3; i++)
        if (g_companies[i].id == id) return g_companies[i].name;
    return "Unknown";
}

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

// NPC agents
static NpcAgent npc_agents[MAX_NPC_AGENTS] = {0};
static int npc_count = 0;
static uint32_t next_npc_id = 5000;

// World NPCs (visible, interactable entities)
static WorldNpc world_npcs[MAX_WORLD_NPCS] = {0};
static int world_npc_count = 0;
static uint32_t next_world_npc_id = 9000;

// Global ship data (simple ships for testing)
#define MAX_SIMPLE_SHIPS 50
static SimpleShip ships[MAX_SIMPLE_SHIPS] = {0};
static int ship_count = 0;
static int next_ship_id = 1;
// Monotonically-increasing module ID base — never reused, avoids collisions on slot recycle
static uint32_t next_mid_base = 3000u;

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
                // Propagate company to sim layer for projectile friendly-fire checks
                sim_ship->company_id = ships[s].company_id;
                
                // Update mounted players' world positions with new ship transform
                update_mounted_players_on_ship(ships[s].ship_id);
                break;
            }
        }
    }
}

__attribute__((unused))
static void ship_clamp_to_deck(const SimpleShip* ship, float* local_x, float* local_y) {
    if (*local_x < ship->deck_min_x) *local_x = ship->deck_min_x;
    if (*local_x > ship->deck_max_x) *local_x = ship->deck_max_x;
    if (*local_y < ship->deck_min_y) *local_y = ship->deck_min_y;
    if (*local_y > ship->deck_max_y) *local_y = ship->deck_max_y;
}

// Helper to convert world coordinates to ship-local coordinates
__attribute__((unused))
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

// Collision radii (client pixels) for module types that block player movement
static float module_collision_radius(ModuleTypeId type) {
    switch (type) {
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL: return 18.0f;
        case MODULE_TYPE_MAST:           return 14.0f;
        case MODULE_TYPE_CANNON:         return 20.0f;
        default:                         return 0.0f; // ladder/plank/deck/seat — passable
    }
}

/**
 * Resolve player-vs-module collisions in ship-local space.
 * Pushes (new_local_x, new_local_y) out of any module it overlaps.
 * Skips the module the player is currently mounted to.
 */
static void resolve_player_module_collisions(const SimpleShip* ship,
                                             uint32_t mounted_module_id,
                                             float* new_local_x, float* new_local_y)
{
    const float PLAYER_RADIUS = 8.0f; // client pixels — matches sim radius

    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];

        // Skip modules the player is mounted to
        if (mod->id == mounted_module_id) continue;

        float mod_radius = module_collision_radius(mod->type_id);
        if (mod_radius <= 0.0f) continue; // passable

        // Module position in ship-local client pixels
        float mod_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float mod_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));

        float dx = *new_local_x - mod_x;
        float dy = *new_local_y - mod_y;
        float dist_sq = dx * dx + dy * dy;
        float min_dist = PLAYER_RADIUS + mod_radius;

        if (dist_sq < min_dist * min_dist) {
            float dist = sqrtf(dist_sq);
            if (dist < 0.001f) {
                // Exact overlap — push sideways
                *new_local_x += min_dist;
            } else {
                // Push player out along the collision normal
                float overlap = min_dist - dist;
                *new_local_x += (dx / dist) * overlap;
                *new_local_y += (dy / dist) * overlap;
            }
        }
    }
}

/*
 * Pushes (new_local_x, new_local_y) out of any active WorldNpc on the same ship.
 * NPCs are treated as solid obstacles; only the player position is adjusted.
 */
static void resolve_player_npc_collisions(const SimpleShip* ship,
                                          float* new_local_x, float* new_local_y)
{
    const float PLAYER_RADIUS = 8.0f;
    const float NPC_RADIUS    = 8.0f;
    const float MIN_DIST      = PLAYER_RADIUS + NPC_RADIUS;

    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* npc = &world_npcs[i];
        if (!npc->active) continue;
        if (npc->ship_id != ship->ship_id) continue;

        float dx = *new_local_x - npc->local_x;
        float dy = *new_local_y - npc->local_y;
        float dist_sq = dx * dx + dy * dy;

        if (dist_sq < MIN_DIST * MIN_DIST) {
            float dist = sqrtf(dist_sq);
            if (dist < 0.001f) {
                *new_local_x += MIN_DIST;
            } else {
                float overlap = MIN_DIST - dist;
                *new_local_x += (dx / dist) * overlap;
                *new_local_y += (dy / dist) * overlap;
            }
        }
    }
}

// Helper to board a player onto a ship
static void board_player_on_ship(WebSocketPlayer* player, SimpleShip* ship, float local_x, float local_y) {
    player->parent_ship_id = ship->ship_id;
    player->company_id     = ship->company_id;  // inherit faction from ship
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
static ShipModule* find_module_by_id(SimpleShip* ship, uint32_t module_id);
static void send_cannon_group_state_to_client(struct WebSocketClient* client, SimpleShip* ship);

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
            players[i].health = 100;
            players[i].max_health = 100;
            
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

            // Initialize inventory — give starter items for testing
            // Slot 0 must NOT be a plank or the client enters build mode and
            // left-click places planks instead of firing cannons.
            memset(&players[i].inventory, 0, sizeof(PlayerInventory));
            players[i].inventory.active_slot = 0;
            players[i].inventory.slots[0].item     = ITEM_CANNON_BALL;
            players[i].inventory.slots[0].quantity = 10;
            players[i].inventory.slots[1].item     = ITEM_PLANK;
            players[i].inventory.slots[1].quantity = 10;
            players[i].inventory.slots[2].item     = ITEM_HAMMER;
            players[i].inventory.slots[2].quantity = 1;
            players[i].inventory.slots[3].item     = ITEM_REPAIR_KIT;
            players[i].inventory.slots[3].quantity = 3;
            players[i].inventory.slots[4].item     = ITEM_CANNON;
            players[i].inventory.slots[4].quantity = 3;
            players[i].inventory.slots[5].item     = ITEM_SAIL;
            players[i].inventory.slots[5].quantity = 3;
            players[i].inventory.slots[6].item     = ITEM_HELM;
            players[i].inventory.slots[6].quantity = 1;
            players[i].inventory.slots[7].item     = ITEM_DECK;
            players[i].inventory.slots[7].quantity = 3;
            players[i].inventory.slots[8].item     = ITEM_SWORD;
            players[i].inventory.slots[8].quantity = 1;

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
            // If mounted, clear the module's occupied state so other players can use it.
            if (players[i].is_mounted && players[i].mounted_module_id != 0) {
                for (int s = 0; s < ship_count; s++) {
                    if (!ships[s].active) continue;
                    ShipModule* mod = find_module_by_id(&ships[s], players[i].mounted_module_id);
                    if (!mod) continue;
                    switch (mod->type_id) {
                        case MODULE_TYPE_HELM:
                        case MODULE_TYPE_STEERING_WHEEL:
                            mod->data.helm.occupied_by = 0;
                            break;
                        case MODULE_TYPE_SEAT:
                            mod->data.seat.occupied_by = 0;
                            break;
                        default:
                            break;
                    }
                    mod->state_bits &= ~MODULE_STATE_OCCUPIED;
                    log_info("🔓 Cleared occupied state on module %u (player %u disconnected)",
                             mod->id, player_id);
                    break;
                }
            }
            // Remove the physics/collision entity from the simulation first so
            // there are no invisible collision bodies left behind.
            if (global_sim && players[i].sim_entity_id != 0) {
                bool removed = sim_destroy_entity(global_sim, players[i].sim_entity_id);
                if (removed) {
                    log_info("🎮 Removed sim entity %u for player %u", players[i].sim_entity_id, player_id);
                } else {
                    log_warn("sim_destroy_entity could not find entity %u for player %u", players[i].sim_entity_id, player_id);
                }
            }
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
__attribute__((unused))
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
    // Check if cannon is already occupied by someone else
    if (module->state_bits & MODULE_STATE_OCCUPIED) {
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

    // Snap player directly behind the cannon barrel.
    // The barrel's natural firing angle in ship-local space is (local_rot - PI/2).
    // "Behind" = opposite direction, offset CANNON_MOUNT_DIST px away from barrel tip.
    {
        float cannon_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float cannon_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        float barrel_angle   = Q16_TO_FLOAT(module->local_rot) - (float)(M_PI / 2.0);
        const float CANNON_MOUNT_DIST = 25.0f; // client pixels behind breech
        player->local_x = cannon_local_x - cosf(barrel_angle) * CANNON_MOUNT_DIST;
        player->local_y = cannon_local_y - sinf(barrel_angle) * CANNON_MOUNT_DIST;
        ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);
    }

    log_info("🎯 Player %u mounted to cannon %u at local (%.1f, %.1f)",
             player->player_id, module->id, player->local_x, player->local_y);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
    /* Push current group config to the player mounting a cannon so they can
     * immediately see which group (if any) this cannon belongs to. */
    send_cannon_group_state_to_client(client, ship);
}

static void handle_helm_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // log_info("🎮 handle_helm_interact called for player %u, module %u", player->player_id, module->id);
    
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
    /* Push current group config to the newly-mounted helm player so they see
     * any groups configured by a previous helmsman without needing a resync. */
    send_cannon_group_state_to_client(client, ship);
}

static void handle_mast_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // If already mounted here, treat a second interact as a sail toggle
    if (player->is_mounted && player->mounted_module_id == module->id) {
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
        char message[256];
        snprintf(message, sizeof(message),
                 "{\"type\":\"sail_state\",\"ship_id\":%u,\"module_id\":%u,\"deployed\":%s}",
                 ship->ship_id, module->id, (module->state_bits & MODULE_STATE_DEPLOYED) ? "true" : "false");
        websocket_server_broadcast(message);
        return;
    }

    // Check if already occupied by someone else
    if ((module->state_bits & MODULE_STATE_OCCUPIED) && !(player->is_mounted && player->mounted_module_id == module->id)) {
        send_interaction_failure(client, "module_occupied");
        return;
    }

    // Mount the player to the mast
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;

    // Snap player to port side of the mast (offset +20px in local Y)
    float mast_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float mast_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    player->local_x = mast_local_x;
    player->local_y = mast_local_y + 20.0f;
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);

    log_info("⛵ Player %u mounted to mast %u at local (%.1f, %.1f)",
             player->player_id, module->id, player->local_x, player->local_y);

    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
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

        /* Unicast current weapon group config to the newly boarded player so
         * they see the ship's authoritative group state right away. */
        send_cannon_group_state_to_client(client, ship);
    } else {
        // Player is on a different ship - transfer them
        log_info("🪜 Player %u transferring from ship %u to ship %u via ladder",
                 player->player_id, player->parent_ship_id, ship->ship_id);
        
        float ladder_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float ladder_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        
        board_player_on_ship(player, ship, ladder_local_x, ladder_local_y);
        send_interaction_success(client, "ship_transfer");
        /* Unicast group state after ship transfer too. */
        send_cannon_group_state_to_client(client, ship);
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
 * Returns true if a WorldNpc rigger is stationed at this specific mast module
 * (assigned_cannon_id == mast_id AND state == AT_CANNON).
 */
static bool is_mast_manned(uint32_t ship_id, uint32_t mast_id) {
    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* w = &world_npcs[i];
        if (!w->active || w->ship_id != ship_id) continue;
        if (w->role == NPC_ROLE_RIGGER &&
            w->assigned_cannon_id == mast_id &&
            w->state == WORLD_NPC_STATE_AT_CANNON)
            return true;
    }
    return false;
}

/**
 * Handle sail openness control from helm-mounted player
 * Sets the desired openness - actual openness will gradually adjust in tick
 */
static void handle_ship_sail_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, int desired_openness) {
    /* Gate: at least one rigger must be stationed at a mast before allowing sail control. */
    {
        bool any_rigger = false;
        for (int m = 0; m < ship->module_count && !any_rigger; m++) {
            if (ship->modules[m].type_id == MODULE_TYPE_MAST)
                any_rigger = is_mast_manned(ship->ship_id, ship->modules[m].id);
        }
        if (!any_rigger) {
            log_info("⛵ Sail control rejected for player %u — no rigger manning any mast on ship %u",
                     player->player_id, ship->ship_id);
            return;
        }
    }

    if (desired_openness < 0) desired_openness = 0;
    if (desired_openness > 100) desired_openness = 100;

    // log_info("⛵ Player %u setting desired sail openness on ship %u: %d%% (applies to manned masts only)",
    //          player->player_id, ship->ship_id, desired_openness);

    // Store desired openness — the tick will only apply it to individually manned masts
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
    
    // log_info("🚢 Player %u rudder control on ship %u: %s (target: %.1f°)", 
    //          player->player_id, ship->ship_id, direction, target_angle);
    
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

    // log_info("🌀 Player %u adjusting sail angle on ship %u: %.1f° (manned masts only)", player->player_id, ship->ship_id, desired_angle);

    // Convert to radians for Q16 storage
    float angle_radians = desired_angle * (3.14159f / 180.0f);
    q16_t angle_q16 = Q16_FROM_FLOAT(angle_radians);

    // Update simulation ship masts — only those with a rigger stationed at them
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                struct Ship* sim_ship = &global_sim->ships[s];
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    if (sim_ship->modules[m].type_id == MODULE_TYPE_MAST &&
                        is_mast_manned(ship->ship_id, sim_ship->modules[m].id)) {
                        sim_ship->modules[m].data.mast.angle = angle_q16;
                        // log_info("  🌀 Mast %u angle set to %.1f° (%.3f rad)",
                        //          sim_ship->modules[m].id, desired_angle, angle_radians);
                    }
                }
                break;
            }
        }
    }

    // Also update SimpleShip for compatibility (manned masts only)
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].type_id == MODULE_TYPE_MAST &&
            is_mast_manned(ship->ship_id, ship->modules[i].id)) {
            ship->modules[i].data.mast.angle = angle_q16;
        }
    }

    // Persist desired angle so rigger NPCs can apply it when they arrive at a mast
    ship->desired_sail_angle = angle_radians;
    
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
                                  float angle, entity_id projectile_id, uint8_t ammo_type);
static void fire_cannon(SimpleShip* ship, ShipModule* cannon, WebSocketPlayer* player, bool manually_fired, uint8_t ammo_type);
static void handle_cannon_force_reload(WebSocketPlayer* player);
static void handle_cannon_fire(WebSocketPlayer* player, bool fire_all, uint8_t ammo_type,
                               uint32_t* explicit_ids, int explicit_count, bool skip_aim_check);
static void handle_cannon_group_config(WebSocketPlayer* player, int group_index,
                                       WeaponGroupMode mode, uint32_t* cannon_ids,
                                       int cannon_count, uint32_t target_ship_id);
static WeaponGroup* find_cannon_weapon_group(uint32_t ship_id, uint32_t cannon_id);
static void assign_weapon_group_crew(SimpleShip* ship);
static void tick_cannon_needed_expiry(void);
static void tick_ship_weapon_groups(void);
static void tick_sinking_ships(void);
static void ship_init_default_weapon_groups(SimpleShip* ship);
static void broadcast_cannon_group_state(SimpleShip* ship);
static void send_cannon_group_state_to_client(struct WebSocketClient* client, SimpleShip* ship);
static void handle_crew_assign(uint32_t ship_id, uint32_t npc_id, const char* task);
static void update_npc_cannon_sector(SimpleShip* ship, float aim_angle);
static void dismount_npc(WorldNpc* npc, SimpleShip* ship);

/**
 * Find a module on a SimpleShip by module ID.
 * Returns a pointer into ship->modules[], or NULL if not found.
 */
static ShipModule* find_module_on_ship(SimpleShip* ship, uint32_t module_id) {
    for (int m = 0; m < ship->module_count; m++) {
        if (ship->modules[m].id == module_id)
            return &ship->modules[m];
    }
    return NULL;
}

/**
 * Aim a specific cannon on a ship toward a world-space target (CLIENT pixel coords).
 * Sets aim_direction on both SimpleShip and sim-ship cannon modules.
 */
__attribute__((unused))
static void npc_aim_cannon_at_world(SimpleShip* ship, ShipModule* cannon, float target_x, float target_y) {
    const float CANNON_AIM_RANGE = 30.0f * (float)(M_PI / 180.0);

    // World angle from cannon toward target (client-pixel space — same coord system as ship->x/y)
    float dx = target_x - ship->x;
    float dy = target_y - ship->y;
    float world_angle = atan2f(dy, dx);

    // Convert to ship-relative angle
    float relative_angle = world_angle - ship->rotation;
    while (relative_angle >  (float)M_PI) relative_angle -= 2.0f * (float)M_PI;
    while (relative_angle < -(float)M_PI) relative_angle += 2.0f * (float)M_PI;

    // desired_offset is the delta from the cannon's natural barrel direction
    float cannon_base_angle = Q16_TO_FLOAT(cannon->local_rot);
    float desired_offset = relative_angle - cannon_base_angle + (float)(M_PI / 2.0);
    while (desired_offset >  (float)M_PI) desired_offset -= 2.0f * (float)M_PI;
    while (desired_offset < -(float)M_PI) desired_offset += 2.0f * (float)M_PI;

    if (desired_offset >  CANNON_AIM_RANGE) desired_offset =  CANNON_AIM_RANGE;
    if (desired_offset < -CANNON_AIM_RANGE) desired_offset = -CANNON_AIM_RANGE;

    cannon->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);

    // Mirror into sim-ship so fire_cannon reads the correct value
    if (global_sim) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                struct Ship* sim_ship = &global_sim->ships[s];
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    if (sim_ship->modules[m].id == cannon->id) {
                        sim_ship->modules[m].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                        break;
                    }
                }
                break;
            }
        }
    }
}

/**
 * Apply a single crew task assignment from the client manning-priority panel.
 *
 * task == "Sails"   → become RIGGER, walk to the next free mast
 * task == "Cannons" → become GUNNER,  sector system places at closest cannon
 * task == "Combat"  → same as Cannons
 * anything else     → become NONE,    walk back to idle spawn position
 */

/* Dismount the NPC from whatever module/role it currently holds, freeing that
 * slot for other crew.  Does NOT set a new target or role — caller does that. */
static void dismount_npc(WorldNpc* npc, SimpleShip* ship) {
    if (npc->role == NPC_ROLE_GUNNER) {
        npc->wants_cannon       = false;
        npc->assigned_cannon_id = 0;
        /* Re-run sector so remaining gunners can claim the vacated cannon */
        if (ship) update_npc_cannon_sector(ship, ship->active_aim_angle);

    } else if (npc->role == NPC_ROLE_RIGGER) {
        /* Free the mast — clear id so is_mast_manned() returns false immediately */
        npc->assigned_cannon_id = 0;
        npc->port_cannon_id     = 0;
        npc->starboard_cannon_id= 0;
    }
    npc->role  = NPC_ROLE_NONE;
    npc->state = WORLD_NPC_STATE_MOVING; /* will be overridden by caller if needed */
}

static void handle_crew_assign(uint32_t ship_id, uint32_t npc_id, const char* task) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return;

    WorldNpc* npc = NULL;
    for (int i = 0; i < world_npc_count; i++) {
        if (world_npcs[i].active && world_npcs[i].id == npc_id && world_npcs[i].ship_id == ship_id) {
            npc = &world_npcs[i];
            break;
        }
    }
    if (!npc) {
        log_warn("crew_assign: NPC %u not found on ship %u", npc_id, ship_id);
        return;
    }

    /* Dismount from current module before applying new role */
    dismount_npc(npc, ship);

    bool want_sails   = (strncmp(task, "Sails",   5) == 0);
    bool want_cannons = (strncmp(task, "Cannons", 7) == 0 || strncmp(task, "Combat", 6) == 0);
    bool want_repairs = (strncmp(task, "Repairs", 7) == 0);

    if (want_sails) {
        /* Become a rigger — find the first mast not already occupied by another rigger */
        uint32_t free_mast = 0;
        for (int m = 0; m < ship->module_count && free_mast == 0; m++) {
            if (ship->modules[m].type_id != MODULE_TYPE_MAST) continue;
            uint32_t mid = ship->modules[m].id;
            bool occupied = false;
            for (int j = 0; j < world_npc_count; j++) {
                WorldNpc* other = &world_npcs[j];
                if (!other->active || other->id == npc->id) continue;
                if (other->ship_id != ship_id) continue;
                if (other->role == NPC_ROLE_RIGGER && other->assigned_cannon_id == mid) {
                    occupied = true;
                    break;
                }
            }
            if (!occupied) free_mast = mid;
        }
        npc->role = NPC_ROLE_RIGGER;
        if (free_mast != 0) {
            ShipModule* mast = find_module_by_id(ship, free_mast);
            if (mast) {
                float mx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mast->local_pos.x));
                float my = SERVER_TO_CLIENT(Q16_TO_FLOAT(mast->local_pos.y));
                npc->target_local_x     = mx;
                npc->target_local_y     = my + 20.0f;
                npc->assigned_cannon_id = free_mast;
            }
            // log_info("⛵ NPC %u (%s) → RIGGER, walking to mast %u", npc->id, npc->name, free_mast);
        } else {
            /* All masts full — wait at centre until one frees up */
            npc->target_local_x = 0.0f;
            npc->target_local_y = 0.0f;
            // log_info("⛵ NPC %u (%s) → RIGGER, all masts occupied — standby", npc->id, npc->name);
        }
        npc->state = WORLD_NPC_STATE_MOVING;

    } else if (want_cannons) {
        /* Become a gunner — sector system places at the closest cannon */
        npc->role         = NPC_ROLE_GUNNER;
        npc->wants_cannon = true;
        update_npc_cannon_sector(ship, ship->active_aim_angle);
        // log_info("🔫 NPC %u (%s) → GUNNER, sector dispatch issued", npc->id, npc->name);

    } else if (want_repairs) {
        /* Become a repairer — walk to idle position, tick_world_npcs will dispatch to a module */
        npc->role           = NPC_ROLE_REPAIRER;
        npc->assigned_cannon_id = 0;
        npc->target_local_x = npc->idle_local_x;
        npc->target_local_y = npc->idle_local_y;
        npc->state          = WORLD_NPC_STATE_MOVING;
        log_info("🔧 NPC %u (%s) → REPAIRER, standing by for damage", npc->id, npc->name);

    } else {
        /* Stand down — return to crew pool at spawn-time idle position */
        npc->role           = NPC_ROLE_NONE;
        npc->target_local_x = npc->idle_local_x;
        npc->target_local_y = npc->idle_local_y;
        npc->state          = WORLD_NPC_STATE_MOVING;
        update_npc_cannon_sector(ship, ship->active_aim_angle);
        log_info("💤 NPC %u (%s) → IDLE, returning to spawn pos (%.0f, %.0f)",
                 npc->id, npc->name, npc->idle_local_x, npc->idle_local_y);
        return;
    }
    /* NOTE: sail openness is NOT changed here; it is player-controlled only. */
}

/**
 * Tick all active NPC agents — gunners aim/fire, helmsmen steer, riggers adjust sails.
 */
static void tick_npc_agents(float dt) {
    for (int i = 0; i < npc_count; i++) {
        NpcAgent* npc = &npc_agents[i];
        if (!npc->active) continue;

        SimpleShip* ship = find_ship(npc->ship_id);
        if (!ship) continue;

        ShipModule* module = find_module_on_ship(ship, npc->module_id);
        if (!module) continue;

        switch (npc->role) {
            case NPC_ROLE_GUNNER: {
                npc->fire_cooldown -= dt;
                if (npc->target_ship_id == 0) break;

                SimpleShip* target = find_ship(npc->target_ship_id);
                if (!target) break;
                // Don't fire on allied ships
                if (is_allied(ship->company_id, target->company_id)) break;

                // Only aim/fire while the WorldNpc gunner is stationary at this cannon.
                // Find the corresponding WorldNpc for this module and check its state.
                bool npc_at_cannon = false;
                for (int wn = 0; wn < world_npc_count; wn++) {
                    WorldNpc* wnpc = &world_npcs[wn];
                    if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                        wnpc->ship_id == ship->ship_id &&
                        wnpc->assigned_cannon_id == module->id &&
                        wnpc->state == WORLD_NPC_STATE_AT_CANNON) {
                        npc_at_cannon = true;
                        break;
                    }
                }
                if (!npc_at_cannon) break;

                /* ── Weapon-group override ──────────────────────────────────
                 * If this cannon belongs to a player's weapon control group,
                 * the group mode dictates what the NPC does:
                 *
                 *   HALTFIRE   → suppress everything; NPC does not aim or fire.
                 *   TARGETFIRE → aim is handled by tick_player_weapon_groups();
                 *                skip the NPC aim update below to avoid fighting it.
                 *   AIMING / FREEFIRE → NPC aims normally (follows ship aim angle).
                 * ─────────────────────────────────────────────────────────── */
                {
                    WeaponGroup* grp = find_cannon_weapon_group(ship->ship_id, module->id);
                    if (grp) {
                        if (grp->mode == WEAPON_GROUP_MODE_HALTFIRE)   break; /* suppressed */
                        if (grp->mode == WEAPON_GROUP_MODE_TARGETFIRE)  break; /* aim owned by tick_player_weapon_groups */
                        /* AIMING / FREEFIRE: NPC follows ship aim angle normally */
                    }
                }

                // Sync cannon's desired aim to the ship's current aim angle every tick.
                // Mirrors the rigger pattern: the NpcAgent continuously applies the
                // authoritative ship value so no aim message is needed on arrival.
                {
                    float cannon_base_angle = Q16_TO_FLOAT(module->local_rot);
                    float desired_offset = ship->active_aim_angle - cannon_base_angle
                                          + (float)(M_PI / 2.0f);
                    while (desired_offset >  (float)M_PI) desired_offset -= 2.0f * (float)M_PI;
                    while (desired_offset < -(float)M_PI) desired_offset += 2.0f * (float)M_PI;
                    const float CANNON_AIM_RANGE        = 30.0f * ((float)M_PI / 180.0f);
                    const float CANNON_AIM_RESET_MARGIN = 15.0f * ((float)M_PI / 180.0f);
                    if (fabsf(desired_offset) > CANNON_AIM_RANGE + CANNON_AIM_RESET_MARGIN)
                        desired_offset = 0.0f; // Past grace zone — return to neutral
                    else if (fabsf(desired_offset) > CANNON_AIM_RANGE)
                        desired_offset = (desired_offset > 0.0f) ? CANNON_AIM_RANGE : -CANNON_AIM_RANGE;
                    module->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                    // Mirror into sim-ship
                    if (global_sim) {
                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                            if (global_sim->ships[si].id == ship->ship_id) {
                                for (uint8_t mi = 0; mi < global_sim->ships[si].module_count; mi++) {
                                    if (global_sim->ships[si].modules[mi].id == module->id) {
                                        global_sim->ships[si].modules[mi].data.cannon.desired_aim_direction
                                            = Q16_FROM_FLOAT(desired_offset);
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                    }
                }

                break;
            }

            case NPC_ROLE_RIGGER: {
                // Set sail openness and angle to the ship's desired values
                if (module->type_id == MODULE_TYPE_MAST) {
                    uint8_t target_openness = ship->desired_sail_openness;
                    module->data.mast.openness = target_openness;
                    if (target_openness > 0)
                        module->state_bits |=  MODULE_STATE_DEPLOYED;
                    else
                        module->state_bits &= ~MODULE_STATE_DEPLOYED;

                    // Apply desired sail angle
                    module->data.mast.angle = Q16_FROM_FLOAT(ship->desired_sail_angle);
                    // Mirror into sim-ship
                    if (global_sim) {
                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                            if (global_sim->ships[si].id == ship->ship_id) {
                                for (uint8_t mi = 0; mi < global_sim->ships[si].module_count; mi++) {
                                    if (global_sim->ships[si].modules[mi].id == module->id) {
                                        global_sim->ships[si].modules[mi].data.mast.angle = module->data.mast.angle;
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                    }

                    // Gradually repair torn sail fibers at 500 HP/s.
                    float fh    = Q16_TO_FLOAT(module->data.mast.fiber_health);
                    float fhmax = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                    if (fhmax <= 0.0f) fhmax = 15000.0f;
                    if (fh < fhmax) {
                        fh += 500.0f * dt;
                        if (fh > fhmax) fh = fhmax;
                        module->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                        module->data.mast.wind_efficiency = Q16_FROM_FLOAT(fh / fhmax);
                    }
                }
                break;
            }

            case NPC_ROLE_HELMSMAN: {
                // Steer the ship toward the desired heading
                if (module->type_id == MODULE_TYPE_HELM ||
                    module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                    float diff = npc->desired_heading - ship->rotation;
                    while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                    while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;

                    const float TURN_RATE = 0.5f; // rad/s max
                    float turn = diff;
                    if (turn >  TURN_RATE * dt) turn =  TURN_RATE * dt;
                    if (turn < -TURN_RATE * dt) turn = -TURN_RATE * dt;
                    ship->rotation += turn;
                }
                break;
            }

            default:
                break;
        }
    }
}

/**
 * Spawn a generic crew member.  Role is set at runtime by the manning panel
 * (Sails → RIGGER, Cannons → GUNNER, Idle → NONE).
 * Returns the new NPC id, or 0 on failure.
 */
static uint32_t spawn_ship_crew(uint32_t ship_id, const char* name) {
    if (world_npc_count >= MAX_WORLD_NPCS) {
        log_warn("spawn_ship_crew: MAX_WORLD_NPCS reached");
        return 0;
    }
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) {
        log_warn("spawn_ship_crew: ship %u not found", ship_id);
        return 0;
    }
    /* Enforce per-ship crew cap derived from the Crew level attribute */
    if (global_sim) {
        struct Ship* sim_ship = sim_get_ship(global_sim, (entity_id)ship_id);
        if (sim_ship) {
            uint8_t max_crew = ship_level_max_crew(&sim_ship->level_stats);
            int crew_count = 0;
            for (int i = 0; i < world_npc_count; i++) {
                if (world_npcs[i].active && world_npcs[i].ship_id == ship_id)
                    crew_count++;
            }
            if (crew_count >= (int)max_crew) {
                log_warn("spawn_ship_crew: ship %u crew cap (%u) reached", ship_id, max_crew);
                return 0;
            }
        }
    }
    WorldNpc* npc = &world_npcs[world_npc_count++];
    memset(npc, 0, sizeof(WorldNpc));
    npc->id             = next_world_npc_id++;
    npc->active         = true;
    npc->role           = NPC_ROLE_NONE;  /* assigned dynamically by manning panel */
    npc->ship_id        = ship_id;
    npc->company_id     = ship->company_id; /* inherit faction from ship */
    npc->wants_cannon   = false;
    npc->move_speed     = 80.0f;
    npc->interact_radius= 40.0f;
    npc->state          = WORLD_NPC_STATE_IDLE;
    npc->assigned_cannon_id = 0;
    strncpy(npc->name,     name,              sizeof(npc->name)     - 1);
    strncpy(npc->dialogue, "Aye aye, Captain!", sizeof(npc->dialogue) - 1);

    /* Crew levelling — fresh recruit */
    npc->npc_level   = 1;
    npc->stat_health = 0;
    npc->stat_damage = 0;
    npc->stat_stamina= 0;
    npc->stat_weight = 0;
    npc->max_health  = (uint16_t)(100 + npc->stat_health * 20);
    npc->health      = npc->max_health;
    npc->xp          = 0;

    /* Stagger idle positions along ship centreline */
    int slot_idx = (int)(npc->id % 9);
    npc->local_x        = -200.0f + slot_idx * 50.0f;
    npc->local_y        = 0.0f;
    npc->idle_local_x   = npc->local_x;   /* remembered for life */
    npc->idle_local_y   = npc->local_y;
    npc->target_local_x = npc->local_x;
    npc->target_local_y = npc->local_y;
    ship_local_to_world(ship, npc->local_x, npc->local_y, &npc->x, &npc->y);
    log_info("🧑 Crew '%s' (id %u) on ship %u — idle", npc->name, npc->id, ship_id);
    return npc->id;
}

/* ============================================================================
 * NPC CANNON PRIORITY SYSTEM
 *
 * All cannons on the ship are ranked by angular distance from the player's
 * aim angle (closest = highest priority).  There is NO arc cutoff — even a
 * cannon pointing straight aft gets ranked, just last.  On-duty gunners
 * (wants_cannon=true) are always assigned to the N closest cannons.
 *
 * Hysteresis: a gunner won't swap cannons unless the candidate is at least
 * SWAP_HYSTERESIS radians closer than their current cannon, preventing
 * constant jitter as the player micro-adjusts aim.
 * ============================================================================*/
#define SWAP_HYSTERESIS (10.0f * ((float)M_PI / 180.0f))  /* 10° dead-band */

/* Walk a gunner to the given cannon module. */
static void dispatch_gunner_to_cannon(WorldNpc* npc, SimpleShip* ship,
                                      uint32_t cannon_id, float abs_diff_deg) {
    ShipModule* cannon = find_module_by_id(ship, cannon_id);
    if (!cannon) return;
    float cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.x));
    float cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.y));
    float barrel_angle = Q16_TO_FLOAT(cannon->local_rot) - (float)(M_PI / 2.0f);
    const float CANNON_MOUNT_DIST = 25.0f;
    npc->assigned_cannon_id = cannon_id;
    npc->target_local_x     = cx - cosf(barrel_angle) * CANNON_MOUNT_DIST;
    npc->target_local_y     = cy - sinf(barrel_angle) * CANNON_MOUNT_DIST;
    npc->state              = WORLD_NPC_STATE_MOVING;

    /* Keep the corresponding NpcAgent's module_id in sync so that
     * tick_npc_agents can find and aim the correct cannon after dispatch. */
    for (int ai = 0; ai < npc_count; ai++) {
        if (npc_agents[ai].active && npc_agents[ai].npc_id == npc->id &&
            npc_agents[ai].ship_id == npc->ship_id) {
            npc_agents[ai].module_id = cannon_id;
            break;
        }
    }
    // log_info("🔫 NPC %u (%s) → cannon %u (%.0f° off aim)",
    //          npc->id, npc->name, cannon_id, abs_diff_deg);
}

/**
 * Timeout (ms) after last activity before MODULE_STATE_NEEDED is cleared.
 * "Activity" = aim was within the cannon's sector of fire, or cannon fired.
 * While NEEDED is set, NPCs stay at the cannon.  Once it expires, NPCs may
 * leave (but only if another cannon has NEEDED and needs crew).
 */
#define CANNON_NEEDED_TIMEOUT_MS  2000
/* Duration of the client-side sinking animation; ship stays alive this long after hull_health=0 */
#define SHIP_SINK_DURATION_MS     8000

/**
 * tick_cannon_needed_expiry — run once per server tick.
 *
 * For every cannon with MODULE_STATE_NEEDED, check whether enough time has
 * elapsed since the last activity (aim-in-sector OR fire) to clear the flag.
 *
 * Aim-based:  cannon_last_needed_ms + CANNON_NEEDED_TIMEOUT_MS
 * Fire-based: cannon_last_fire_ms   + CANNON_RELOAD_TIME_MS + CANNON_NEEDED_TIMEOUT_MS
 *
 * NEEDED stays true as long as EITHER timer is still valid.
 */
static void tick_cannon_needed_expiry(void) {
    uint32_t now = get_time_ms();
    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active) continue;
        for (int m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_CANNON) continue;
            if (!(mod->state_bits & MODULE_STATE_NEEDED)) continue;

            uint32_t last_aim = ship->cannon_last_needed_ms[m];
            if (last_aim == 0) {
                /* Never had NEEDED set properly — clear it */
                mod->state_bits &= ~MODULE_STATE_NEEDED;
                continue;
            }

            uint32_t aim_expiry = last_aim + CANNON_NEEDED_TIMEOUT_MS;

            /* A fired cannon stays NEEDED for the full reload + grace period */
            uint32_t fire_expiry = 0;
            if (ship->cannon_last_fire_ms[m] > 0) {
                fire_expiry = ship->cannon_last_fire_ms[m]
                            + CANNON_RELOAD_TIME_MS
                            + CANNON_NEEDED_TIMEOUT_MS;
            }

            uint32_t effective = (fire_expiry > aim_expiry) ? fire_expiry : aim_expiry;
            if (now > effective) {
                mod->state_bits &= ~MODULE_STATE_NEEDED;
            }
        }
    }
}

/**
 * Assign free on-duty gunner NPCs to any weapon-group cannon that is currently
 * unmanned and has MODULE_STATE_NEEDED set.
 *
 * NEEDED is the single authoritative signal: it is set by handle_cannon_aim
 * (sector check), refreshed by fire_cannon(), and cleared by
 * tick_cannon_needed_expiry() after CANNON_NEEDED_TIMEOUT_MS of inactivity.
 *
 * NPCs will only be pulled from a cannon whose NEEDED has expired to fill
 * a cannon whose NEEDED is active.
 */
static void assign_weapon_group_crew(SimpleShip* ship) {
    if (!ship) return;

    for (int m = 0; m < ship->module_count; m++) {
        ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON) continue;

        /* Only dispatch to cannons that are actively NEEDED. */
        if (!(mod->state_bits & MODULE_STATE_NEEDED)) continue;

        /* Check occupancy: player seated here? */
        bool occupied = false;
        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
            WebSocketPlayer* p = &players[pi];
            if (p->active && p->is_mounted && p->mounted_module_id == mod->id) {
                occupied = true; break;
            }
        }
        /* WorldNpc gunner stationed or en-route here? */
        bool en_route = false;
        if (!occupied) {
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* npc = &world_npcs[ni];
                if (npc->active && npc->role == NPC_ROLE_GUNNER &&
                    npc->ship_id == ship->ship_id &&
                    npc->assigned_cannon_id == mod->id) {
                    if (npc->state == WORLD_NPC_STATE_AT_CANNON) occupied  = true;
                    else                                          en_route  = true;
                    break;
                }
            }
        }

        if (occupied || en_route) continue; /* already handled */

        /* Find the nearest free gunner NPC.  An NPC is "free" if it is either
         * unassigned (idle) or its current cannon no longer has NEEDED set
         * (the timeout expired — the cannon is inactive). */
        WorldNpc* best = NULL;
        float     best_dist = 1e9f;
        float     cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float     cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        for (int ni = 0; ni < world_npc_count; ni++) {
            WorldNpc* npc = &world_npcs[ni];
            if (!npc->active || npc->ship_id != ship->ship_id) continue;
            if (npc->role != NPC_ROLE_GUNNER || !npc->wants_cannon) continue;
            if (npc->assigned_cannon_id != 0) {
                /* Only pull from a cannon whose NEEDED has expired */
                ShipModule* cur = find_module_on_ship(ship, npc->assigned_cannon_id);
                if (cur && (cur->state_bits & MODULE_STATE_NEEDED)) continue;
            }
            float dx = npc->local_x - cx;
            float dy = npc->local_y - cy;
            float dist = dx * dx + dy * dy;
            if (dist < best_dist) { best_dist = dist; best = npc; }
        }

        if (best) {
            // log_info("🎯 Cannon %u NEEDED+unmanned — dispatching NPC %u (%s)",
            //          mod->id, best->id, best->name);
            dispatch_gunner_to_cannon(best, ship, mod->id, 0.0f);
        }
    }

}

/**
 * Returns true if cannon_id is claimed by any player weapon group on the given ship.
 */
static void update_npc_cannon_sector(SimpleShip* ship, float aim_angle) {
    if (!ship) return;

    /* ─ Step 1: rank ALL cannons by angular distance from aim ─────────────────
     * Group cannons are included; HALTFIRE group cannons receive a 2π penalty
     * so they always sort to the back of the list (lower crew priority) but
     * are never completely invisible to the sector system.                     */
    uint32_t sorted_ids [MAX_MODULES_PER_SHIP];
    float    sorted_diff[MAX_MODULES_PER_SHIP];
    int      cannon_count = 0;

    for (int m = 0; m < ship->module_count; m++) {
        ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON) continue;

        float fire_dir = Q16_TO_FLOAT(mod->local_rot) - (float)(M_PI / 2.0f);
        float diff = aim_angle - fire_dir;
        while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
        while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
        float abs_diff = fabsf(diff);

        /* Cannons urgently needing crew sort to the very front regardless of angle.
         * HALTFIRE group cannons sort to the back.  These two bonuses are mutually
         * exclusive in practice (HALTFIRE suppresses aiming so it never gets NEEDED). */
        if (mod->state_bits & MODULE_STATE_NEEDED)
            abs_diff -= 2.0f * (float)M_PI;   /* guaranteed negative → sorts first */
        else {
            WeaponGroup* grp = find_cannon_weapon_group(ship->ship_id, mod->id);
            if (grp && grp->mode == WEAPON_GROUP_MODE_HALTFIRE)
                abs_diff += 2.0f * (float)M_PI; /* sorts last */
        }

        /* Insertion sort: smallest diff first */
        int pos = cannon_count;
        while (pos > 0 && sorted_diff[pos - 1] > abs_diff) {
            sorted_ids [pos] = sorted_ids [pos - 1];
            sorted_diff[pos] = sorted_diff[pos - 1];
            pos--;
        }
        sorted_ids [pos] = mod->id;
        sorted_diff[pos] = abs_diff;
        cannon_count++;
    }
    if (cannon_count == 0) return;

    /* ─ Step 2: dispatch unassigned or released gunners to NEEDED cannons only.
     *
     *  NPCs stay at their cannon as long as it has MODULE_STATE_NEEDED.
     *  Once NEEDED expires (cleared by tick_cannon_needed_expiry), the NPC
     *  may be pulled to a different cannon that still has NEEDED.  If no
     *  cannon needs them, they stay put (no idle-return here). ─ */
    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* npc = &world_npcs[i];
        if (!npc->active || npc->ship_id != ship->ship_id) continue;
        if (npc->role != NPC_ROLE_GUNNER || !npc->wants_cannon) continue;

        /* NPC is already heading to or sitting at a cannon — keep them
         * unless their cannon's NEEDED has expired AND another cannon
         * has NEEDED and is uncovered. */
        if (npc->assigned_cannon_id != 0) {
            ShipModule* cur = find_module_on_ship(ship, npc->assigned_cannon_id);
            bool cur_needed = cur && (cur->state_bits & MODULE_STATE_NEEDED);
            if (cur_needed) continue; /* their cannon is still active — stay */

            /* Their cannon's NEEDED expired.  Only move if there is another
             * NEEDED cannon that is uncovered. */
            bool any_needed_elsewhere = false;
            for (int mn = 0; mn < ship->module_count; mn++) {
                if (ship->modules[mn].id == npc->assigned_cannon_id) continue;
                if (ship->modules[mn].type_id == MODULE_TYPE_CANNON &&
                    (ship->modules[mn].state_bits & MODULE_STATE_NEEDED)) {
                    bool covered = false;
                    for (int j = 0; j < world_npc_count; j++) {
                        if (j == i) continue;
                        WorldNpc* o = &world_npcs[j];
                        if (o->active && o->role == NPC_ROLE_GUNNER &&
                            o->ship_id == ship->ship_id &&
                            o->assigned_cannon_id == ship->modules[mn].id) {
                            covered = true; break;
                        }
                    }
                    if (!covered) { any_needed_elsewhere = true; break; }
                }
            }
            if (!any_needed_elsewhere) continue; /* no NEEDED cannon uncovered — stay put */
        }

        /* Find the highest-priority NEEDED cannon not already covered by another NPC */
        uint32_t best_id = 0;
        float    best_diff = (float)M_PI * 4.0f; /* sorted_diff can be negative for NEEDED */
        for (int c = 0; c < cannon_count; c++) {
            uint32_t cid = sorted_ids[c];
            ShipModule* cmod = find_module_on_ship(ship, cid);
            if (!cmod || !(cmod->state_bits & MODULE_STATE_NEEDED)) continue;
            /* Already assigned to this one? Stay */
            if (cid == npc->assigned_cannon_id) { best_id = cid; best_diff = sorted_diff[c]; break; }
            /* Check nobody else is already covering it */
            bool covered = false;
            for (int j = 0; j < world_npc_count; j++) {
                if (j == i) continue;
                WorldNpc* o = &world_npcs[j];
                if (o->active && o->role == NPC_ROLE_GUNNER &&
                    o->ship_id == ship->ship_id &&
                    o->assigned_cannon_id == cid) { covered = true; break; }
            }
            if (!covered) { best_id = cid; best_diff = sorted_diff[c]; break; }
        }

        if (best_id == 0 || best_id == npc->assigned_cannon_id) continue;

        dispatch_gunner_to_cannon(npc, ship, best_id,
                                  best_diff * 180.0f / (float)M_PI);
    }

    // log_info("⚓ Ship %u priority dispatch: aim=%.0f°, top cannon %u (%.0f° off)",
    //          ship->ship_id, aim_angle * 180.0f / (float)M_PI,
    //          sorted_ids[0], sorted_diff[0] * 180.0f / (float)M_PI);
}

/* ── NPC global levelling constants ───────────────────────────────────────── */
/* Max global level: 1 base + 65 upgrades */
#define NPC_MAX_LEVEL       66u
/* XP needed to advance from level L to L+1: NPC_LEVEL_XP_BASE * L */
#define NPC_LEVEL_XP_BASE  100u

/*
 * Grant XP to a crew NPC and apply any level-ups.
 * Stops accumulating XP once NPC_MAX_LEVEL is reached.
 * Each level-up gives 1 stat point (= npc_level - 1 - total_stats_spent).
 */
static void npc_apply_xp(WorldNpc* npc, uint32_t xp_gain) {
    if (npc->npc_level >= NPC_MAX_LEVEL) return; /* already max level — no more XP */
    npc->xp += xp_gain;
    /* Process level-ups: cost to advance from L to L+1 is NPC_LEVEL_XP_BASE * L */
    while (npc->npc_level < NPC_MAX_LEVEL) {
        uint32_t cost = NPC_LEVEL_XP_BASE * (uint32_t)npc->npc_level;
        if (npc->xp < cost) break;
        npc->xp -= cost;
        npc->npc_level++;
    }
}

/**
 * Tick world NPCs: animate movement across deck, then update world positions.
 */
static void tick_world_npcs(float dt) {
    // Plank centre positions in client-space local coords (match HULL_POINTS in modules.ts)
    // Order: bow_port, bow_starboard, 3× starboard, stern_starboard, stern_port, 3× port
    static const float s_plank_cx[10] = {
         246.25f,  246.25f,  115.0f,  -35.0f, -185.0f,
        -281.25f, -281.25f, -185.0f,  -35.0f,  115.0f
    };
    static const float s_plank_cy[10] = {
         45.0f, -45.0f, -90.0f, -90.0f, -90.0f,
        -45.0f,  45.0f,  90.0f,  90.0f,  90.0f
    };

    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* npc = &world_npcs[i];
        if (!npc->active) continue;

        if (npc->state == WORLD_NPC_STATE_MOVING) {
            // ── Repairer walking home: interrupt if new damage appears ──────────
            if (npc->role == NPC_ROLE_REPAIRER && npc->assigned_cannon_id == 0 && global_sim) {
                struct Ship* intr_ship = NULL;
                for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                    if ((uint32_t)global_sim->ships[s].id == npc->ship_id) {
                        intr_ship = &global_sim->ships[s]; break;
                    }
                }
                if (intr_ship) {
                    // Check for missing deck (highest priority)
                    bool intr_deck_present = false;
                    for (uint8_t m = 0; m < intr_ship->module_count; m++) {
                        if (intr_ship->modules[m].id == 200) { intr_deck_present = true; break; }
                    }
                    bool intr_deck_taken = false;
                    if (!intr_deck_present) {
                        for (int j = 0; j < world_npc_count; j++) {
                            WorldNpc* other = &world_npcs[j];
                            if (!other->active || other->id == npc->id) continue;
                            if (other->ship_id == npc->ship_id && other->role == NPC_ROLE_REPAIRER &&
                                other->assigned_cannon_id == 200) { intr_deck_taken = true; break; }
                        }
                    }
                    if (!intr_deck_present && !intr_deck_taken) {
                        npc->target_local_x     = 0.0f;
                        npc->target_local_y     = 0.0f;
                        npc->assigned_cannon_id = 200;
                        log_info("🔨 NPC %u (%s) interrupted — redirecting to replace missing deck",
                                 npc->id, npc->name);
                    } else {
                    // Check for missing planks first
                    bool present[10] = {false};
                    for (uint8_t m = 0; m < intr_ship->module_count; m++) {
                        uint16_t mid = intr_ship->modules[m].id;
                        if (mid >= 100 && mid <= 109) present[mid - 100] = true;
                    }
                    int intr_missing = -1;
                    for (int k = 0; k < 10; k++) {
                        if (present[k]) continue;
                        bool taken = false;
                        for (int j = 0; j < world_npc_count; j++) {
                            WorldNpc* other = &world_npcs[j];
                            if (!other->active || other->id == npc->id) continue;
                            if (other->ship_id == npc->ship_id && other->role == NPC_ROLE_REPAIRER &&
                                other->assigned_cannon_id == (uint32_t)(100 + k)) { taken = true; break; }
                        }
                        if (!taken) { intr_missing = k; break; }
                    }
                    if (intr_missing >= 0) {
                        float pcx = s_plank_cx[intr_missing], pcy = s_plank_cy[intr_missing];
                        float pmag = sqrtf(pcx * pcx + pcy * pcy);
                        if (pmag > 0.0f) { pcx -= (pcx / pmag) * 28.0f; pcy -= (pcy / pmag) * 28.0f; }
                        npc->target_local_x     = pcx;
                        npc->target_local_y     = pcy;
                        npc->assigned_cannon_id = (uint32_t)(100 + intr_missing);
                        log_info("🔨 NPC %u (%s) interrupted — redirecting to missing plank %u",
                                 npc->id, npc->name, 100 + intr_missing);
                    } else {
                        // Check for damaged modules
                        ShipModule* intr_mod = NULL;
                        ShipModule* intr_stack = NULL;
                        float intr_worst = 1.0f, intr_stack_r = 1.0f;
                        for (uint8_t m = 0; m < intr_ship->module_count; m++) {
                            ShipModule* mod = &intr_ship->modules[m];
                            if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                            if (mod->max_health == 0) continue;
                            float ratio = (float)mod->health / (float)mod->max_health;
                            if (ratio >= 1.0f) continue;
                            bool taken = false;
                            for (int j = 0; j < world_npc_count; j++) {
                                WorldNpc* other = &world_npcs[j];
                                if (!other->active || other->id == npc->id) continue;
                                if (other->ship_id == npc->ship_id && other->role == NPC_ROLE_REPAIRER &&
                                    other->assigned_cannon_id == (uint32_t)mod->id) { taken = true; break; }
                            }
                            if (!taken && ratio < intr_worst)  { intr_mod   = mod; intr_worst  = ratio; }
                            if ( taken && ratio < intr_stack_r){ intr_stack = mod; intr_stack_r = ratio; }
                        }
                        if (!intr_mod) intr_mod = intr_stack;
                        if (intr_mod) {
                            float mx = SERVER_TO_CLIENT(Q16_TO_FLOAT(intr_mod->local_pos.x));
                            float my = SERVER_TO_CLIENT(Q16_TO_FLOAT(intr_mod->local_pos.y));
                            float mmag = sqrtf(mx * mx + my * my);
                            if (mmag > 0.0f) { mx -= (mx / mmag) * 28.0f; my -= (my / mmag) * 28.0f; }
                            npc->target_local_x     = mx;
                            npc->target_local_y     = my;
                            npc->assigned_cannon_id = (uint32_t)intr_mod->id;
                            log_info("🔧 NPC %u (%s) interrupted — redirecting to damaged module %u (%.0f%% HP)",
                                     npc->id, npc->name, intr_mod->id, intr_worst * 100.0f);
                        }
                    }
                    } // end deck-missing else
                }
            }

            float dx   = npc->target_local_x - npc->local_x;
            float dy   = npc->target_local_y - npc->local_y;
            float dist = sqrtf(dx * dx + dy * dy);
            float step = npc->move_speed * dt;
            if (dist <= step || dist < 0.5f) {
                npc->local_x = npc->target_local_x;
                npc->local_y = npc->target_local_y;
                if (npc->assigned_cannon_id != 0) {
                    /* Repair crew arrives at a damaged module; gunners/riggers arrive at a post */
                    npc->state = (npc->role == NPC_ROLE_REPAIRER)
                               ? WORLD_NPC_STATE_REPAIRING
                               : WORLD_NPC_STATE_AT_CANNON;

                    /* Rigger just arrived at mast — immediately apply current sail angle/openness
                     * so the sail snaps to the correct position without waiting for the next
                     * sail-angle update message from the helm player. */
                    if (npc->role == NPC_ROLE_RIGGER) {
                        SimpleShip* rship = find_ship(npc->ship_id);
                        if (rship) {
                            ShipModule* mast = find_module_by_id(rship, npc->assigned_cannon_id);
                            if (mast && mast->type_id == MODULE_TYPE_MAST) {
                                uint8_t tgt_open = rship->desired_sail_openness;
                                mast->data.mast.openness = tgt_open;
                                if (tgt_open > 0) mast->state_bits |=  MODULE_STATE_DEPLOYED;
                                else              mast->state_bits &= ~MODULE_STATE_DEPLOYED;
                                mast->data.mast.angle = Q16_FROM_FLOAT(rship->desired_sail_angle);
                                if (global_sim) {
                                    for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                        if (global_sim->ships[si].id != rship->ship_id) continue;
                                        for (uint8_t mi = 0; mi < global_sim->ships[si].module_count; mi++) {
                                            if (global_sim->ships[si].modules[mi].id == mast->id) {
                                                global_sim->ships[si].modules[mi].data.mast.angle = mast->data.mast.angle;
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } else {
                    npc->state = WORLD_NPC_STATE_IDLE;
                }
            } else {
                npc->local_x += (dx / dist) * step;
                npc->local_y += (dy / dist) * step;
                npc->rotation = atan2f(dy, dx); // Face direction of travel
            }
        }

        // Integrate knockback velocity and apply drag
        if (npc->velocity_x != 0.0f || npc->velocity_y != 0.0f) {
            const float DRAG = 8.0f; // decay rate (higher = stops faster)
            npc->local_x   += npc->velocity_x * dt;
            npc->local_y   += npc->velocity_y * dt;
            float decay     = 1.0f - DRAG * dt;
            if (decay < 0.0f) decay = 0.0f;
            npc->velocity_x *= decay;
            npc->velocity_y *= decay;
            if (fabsf(npc->velocity_x) < 0.5f) npc->velocity_x = 0.0f;
            if (fabsf(npc->velocity_y) < 0.5f) npc->velocity_y = 0.0f;
        }

        // Keep world position in sync with ship transform
        if (npc->ship_id != 0) {
            SimpleShip* ship = find_ship(npc->ship_id);
            if (ship) ship_local_to_world(ship, npc->local_x, npc->local_y, &npc->x, &npc->y);
        }

        // ── Repair crew (NPC_ROLE_REPAIRER) ─────────────────────────────────────
        if (npc->role != NPC_ROLE_REPAIRER) continue;
        if (!global_sim) continue;

        struct Ship* sim_ship = NULL;
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if ((uint32_t)global_sim->ships[s].id == npc->ship_id) {
                sim_ship = &global_sim->ships[s];
                break;
            }
        }

        // ── REPAIRING: actively fix the assigned module ──────────────────────────
        if (npc->state == WORLD_NPC_STATE_REPAIRING) {
            bool still_working = false;

            if (sim_ship) {
                uint32_t target_id = npc->assigned_cannon_id;

                // If the deck is missing, place it first
                if (target_id == 200) {
                    bool deck_exists = false;
                    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                        if (sim_ship->modules[m].id == 200) { deck_exists = true; break; }
                    }
                    if (!deck_exists && sim_ship->module_count < MAX_MODULES_PER_SHIP) {
                        ShipModule new_deck = module_create(200, MODULE_TYPE_DECK, (Vec2Q16){0,0}, 0);
                        new_deck.health      = new_deck.max_health / 10;
                        new_deck.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                        sim_ship->modules[sim_ship->module_count++] = new_deck;
                        SimpleShip* simple = find_ship(npc->ship_id);
                        if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                            simple->modules[simple->module_count++] = new_deck;
                        log_info("🔨 NPC %u (%s) placed missing deck on ship %u",
                                 npc->id, npc->name, sim_ship->id);
                    }
                }

                // If it's a plank slot that's empty, place a new plank first
                if (target_id >= 100 && target_id <= 109) {
                    bool module_exists = false;
                    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                        if ((uint32_t)sim_ship->modules[m].id == target_id) {
                            module_exists = true; break;
                        }
                    }
                    if (!module_exists && sim_ship->module_count < MAX_MODULES_PER_SHIP) {
                        int idx = (int)(target_id - 100);
                        Vec2Q16 pos = {
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(s_plank_cx[idx])),
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(s_plank_cy[idx]))
                        };
                        ShipModule new_plank = module_create((uint16_t)target_id, MODULE_TYPE_PLANK, pos, 0);
                        new_plank.health      = new_plank.max_health / 10; // start at 10% HP
                        new_plank.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                        sim_ship->modules[sim_ship->module_count++] = new_plank;
                        // Also register in SimpleShip so hit-event tracking stays in sync
                        SimpleShip* simple = find_ship(npc->ship_id);
                        if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                            simple->modules[simple->module_count++] = new_plank;
                        log_info("🔨 NPC %u (%s) placed missing plank %u on ship %u",
                                 npc->id, npc->name, target_id, sim_ship->id);
                    }
                }

                // Now repair the module (whether freshly placed or already present)
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    ShipModule* mod = &sim_ship->modules[m];
                    if ((uint32_t)mod->id != target_id) continue;
                    if (mod->state_bits & MODULE_STATE_DESTROYED) break;

                    // Initiate passive regen (2.5%/s via sim_update_ships)
                    mod->state_bits |= MODULE_STATE_REPAIRING;

                    // Repair main HP at 10%/s
                    if (mod->health < (int32_t)mod->max_health) {
                        float heal = (float)mod->max_health * 0.10f * dt;
                        mod->health += (int32_t)heal;
                        if (mod->health >= (int32_t)mod->max_health) {
                            mod->health = (int32_t)mod->max_health;
                            mod->state_bits &= ~(uint16_t)MODULE_STATE_DAMAGED;
                        } else {
                            still_working = true;
                        }
                    }

                    // Repair mast sail fibers at 10%/s
                    if (mod->type_id == MODULE_TYPE_MAST) {
                        float fh    = Q16_TO_FLOAT(mod->data.mast.fiber_health);
                        float fhmax = Q16_TO_FLOAT(mod->data.mast.fiber_max_health);
                        if (fhmax > 0.0f && fh < fhmax) {
                            fh += fhmax * 0.10f * dt;
                            if (fh > fhmax) fh = fhmax;
                            mod->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                            mod->data.mast.wind_efficiency = Q16_FROM_FLOAT(fh / fhmax);
                            if (fh < fhmax) still_working = true;
                        }
                    }
                    break;
                }
            }

            if (!still_working) {
                log_info("✅ NPC %u (%s) finished with module %u",
                         npc->id, npc->name, npc->assigned_cannon_id);
                /* Award XP for completing a repair */
                npc_apply_xp(npc, 25);
                npc->assigned_cannon_id = 0;
                // Fall through to the IDLE scan below so the NPC goes directly to
                // the next damaged/missing module without returning home first.
                npc->state = WORLD_NPC_STATE_IDLE;
            }
        }

        // ── IDLE: scan for next damaged or missing module ────────────────────────
        // This runs both when the NPC was already idle AND immediately after
        // finishing a repair (state was just set to IDLE above).
        if (npc->state == WORLD_NPC_STATE_IDLE) {
            if (!sim_ship) continue;

            // --- 0. Check for missing deck (highest priority) -------------------
            bool deck_present = false;
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                if (sim_ship->modules[m].id == 200) { deck_present = true; break; }
            }
            if (!deck_present) {
                bool deck_taken = false;
                for (int j = 0; j < world_npc_count; j++) {
                    WorldNpc* other = &world_npcs[j];
                    if (!other->active || other->id == npc->id) continue;
                    if (other->ship_id == npc->ship_id && other->role == NPC_ROLE_REPAIRER &&
                        other->assigned_cannon_id == 200) { deck_taken = true; break; }
                }
                if (!deck_taken) {
                    npc->target_local_x     = 0.0f;
                    npc->target_local_y     = 0.0f;
                    npc->assigned_cannon_id = 200;
                    npc->state              = WORLD_NPC_STATE_MOVING;
                    log_info("🔨 NPC %u (%s) → walking to replace missing deck", npc->id, npc->name);
                    continue;
                }
            }

            // --- 1. Check for missing planks (highest priority) ------------------
            bool present[10] = {false};
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                uint16_t mid = sim_ship->modules[m].id;
                if (mid >= 100 && mid <= 109) present[mid - 100] = true;
            }
            int missing_idx = -1;
            for (int k = 0; k < 10; k++) {
                if (present[k]) continue;
                bool taken = false;
                for (int j = 0; j < world_npc_count; j++) {
                    WorldNpc* other = &world_npcs[j];
                    if (!other->active || other->id == npc->id) continue;
                    if (other->ship_id == npc->ship_id &&
                        other->role   == NPC_ROLE_REPAIRER &&
                        other->assigned_cannon_id == (uint32_t)(100 + k)) {
                        taken = true; break;
                    }
                }
                if (!taken) { missing_idx = k; break; }
            }

            if (missing_idx >= 0) {
                // Stop 28 client units inward from the hull edge
                float pcx = s_plank_cx[missing_idx], pcy = s_plank_cy[missing_idx];
                float pmag = sqrtf(pcx * pcx + pcy * pcy);
                if (pmag > 0.0f) { pcx -= (pcx / pmag) * 28.0f; pcy -= (pcy / pmag) * 28.0f; }
                npc->target_local_x     = pcx;
                npc->target_local_y     = pcy;
                npc->assigned_cannon_id = (uint32_t)(100 + missing_idx);
                npc->state              = WORLD_NPC_STATE_MOVING;
                log_info("🔨 NPC %u (%s) → walking to place missing plank %u",
                         npc->id, npc->name, 100 + missing_idx);
                continue;
            }

            // --- 2. Check for damaged modules ------------------------------------
            // First pass: prefer a module NOT already claimed by another NPC.
            // If everything damaged is taken, fall back to stacking on the worst one.
            ShipModule* target_mod  = NULL;
            ShipModule* stack_mod   = NULL; // fallback: most-damaged taken module
            float worst_ratio  = 1.0f;
            float stack_ratio  = 1.0f;
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                ShipModule* mod = &sim_ship->modules[m];
                if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                if (mod->max_health == 0) continue;
                float ratio = (float)mod->health / (float)mod->max_health;
                // For masts, also consider fiber (sail) health damage
                if (mod->type_id == MODULE_TYPE_MAST) {
                    float fhmax = Q16_TO_FLOAT(mod->data.mast.fiber_max_health);
                    if (fhmax > 0.0f) {
                        float fh = Q16_TO_FLOAT(mod->data.mast.fiber_health);
                        float fiber_ratio = fh / fhmax;
                        if (fiber_ratio < ratio) ratio = fiber_ratio;
                    }
                }
                if (ratio >= 1.0f) continue;
                bool taken = false;
                for (int j = 0; j < world_npc_count; j++) {
                    WorldNpc* other = &world_npcs[j];
                    if (!other->active || other->id == npc->id) continue;
                    if (other->ship_id == npc->ship_id &&
                        other->role   == NPC_ROLE_REPAIRER &&
                        other->assigned_cannon_id == (uint32_t)mod->id) {
                        taken = true; break;
                    }
                }
                if (!taken && ratio < worst_ratio) { target_mod = mod; worst_ratio = ratio; }
                if ( taken && ratio < stack_ratio)  { stack_mod  = mod; stack_ratio = ratio; }
            }
            // If no untaken module available, allow stacking on the most-damaged taken one
            if (!target_mod) target_mod = stack_mod;

            if (target_mod) {
                float mx = SERVER_TO_CLIENT(Q16_TO_FLOAT(target_mod->local_pos.x));
                float my = SERVER_TO_CLIENT(Q16_TO_FLOAT(target_mod->local_pos.y));
                // Stop 28 client units inward from the hull edge
                float mmag = sqrtf(mx * mx + my * my);
                if (mmag > 0.0f) { mx -= (mx / mmag) * 28.0f; my -= (my / mmag) * 28.0f; }
                npc->target_local_x     = mx;
                npc->target_local_y     = my;
                npc->assigned_cannon_id = (uint32_t)target_mod->id;
                npc->state              = WORLD_NPC_STATE_MOVING;
                log_info("🔧 NPC %u (%s) → walking to repair module %u (%.0f%% HP)",
                         npc->id, npc->name, target_mod->id, worst_ratio * 100.0f);
                continue;
            }

            // --- 3. Nothing to do: drift back to idle position if not already there
            float hdx = npc->idle_local_x - npc->local_x;
            float hdy = npc->idle_local_y - npc->local_y;
            if (sqrtf(hdx * hdx + hdy * hdy) > 1.0f) {
                npc->target_local_x = npc->idle_local_x;
                npc->target_local_y = npc->idle_local_y;
                npc->state          = WORLD_NPC_STATE_MOVING;
            }
        }
    }
}

/**
 * Parse a JSON array of uint32_t values for a given key.
 * Supports keys like "cannon_ids":[101,103,105].
 * Returns the number of values written into out[] (capped at max_out).
 */
static int parse_json_uint32_array(const char* json, const char* key, uint32_t* out, int max_out) {
    // Build search pattern: "key":[
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":[", key);
    const char* start = strstr(json, pattern);
    if (!start) return 0;
    start += strlen(pattern);
    int count = 0;
    while (count < max_out) {
        while (*start == ' ' || *start == '\t') start++;
        if (*start == ']' || *start == '\0') break;
        char* end;
        unsigned long val = strtoul(start, &end, 10);
        if (end == start) break; // no digits
        out[count++] = (uint32_t)val;
        start = end;
        while (*start == ' ' || *start == '\t') start++;
        if (*start == ',') start++;
    }
    return count;
}

/**
 * Configure a weapon control group on the ship.
 * Called when a client sends "cannon_group_config".  The group is stored per-ship
 * so all players on the same ship share authoritative group state.
 *
 * Enforces:
 *  - cannon IDs must be real cannon modules on this ship (invalid IDs stripped)
 *  - exclusive ownership: each cannon can only belong to one group at a time
 *    (cannon is removed from any other group before being added here)
 */
static void handle_cannon_group_config(WebSocketPlayer* player, int group_index,
                                       WeaponGroupMode mode, uint32_t* cannon_ids,
                                       int cannon_count, uint32_t target_ship_id) {
    if (group_index < 0 || group_index >= MAX_WEAPON_GROUPS) return;
    if (player->parent_ship_id == 0) return;
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    /* ── Validate: strip any cannon ID not belonging to a real cannon module on
     *    this ship.  Prevents clients from referencing foreign-ship cannons. ── */
    uint32_t valid_ids[MAX_CANNONS_PER_GROUP];
    int      valid_count = 0;
    int      limit = (cannon_count > MAX_CANNONS_PER_GROUP) ? MAX_CANNONS_PER_GROUP : cannon_count;
    for (int i = 0; i < limit; i++) {
        ShipModule* mod = find_module_on_ship(ship, cannon_ids[i]);
        if (mod && mod->type_id == MODULE_TYPE_CANNON) {
            valid_ids[valid_count++] = cannon_ids[i];
        }
    }

    /* ── Exclusive ownership: remove each validated cannon from every other group
     *    so a cannon can never appear in two groups simultaneously. ── */
    for (int i = 0; i < valid_count; i++) {
        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            if (g == group_index) continue;
            WeaponGroup* other = &ship->weapon_groups[g];
            for (int c = 0; c < other->cannon_count; c++) {
                if (other->cannon_ids[c] == valid_ids[i]) {
                    /* Compact: overwrite with last entry */
                    other->cannon_ids[c] = other->cannon_ids[other->cannon_count - 1];
                    other->cannon_count--;
                    break;
                }
            }
        }
    }

    WeaponGroup* group = &ship->weapon_groups[group_index];
    group->mode         = mode;
    group->cannon_count = (uint8_t)valid_count;
    for (int i = 0; i < valid_count; i++) {
        group->cannon_ids[i] = valid_ids[i];
    }
    group->target_ship_id = (mode == WEAPON_GROUP_MODE_TARGETFIRE) ? target_ship_id : 0;

    /* For all modes, NPCs remain stationed at their assigned cannon.
     * Mode only controls what the NPC does while there (aim/fire guards
     * in tick_npc_agents enforce HALTFIRE / AIMING / etc. per tick).
     * Immediately ensure any unmanned group cannons get a crew member. */

    /* Clear MODULE_STATE_NEEDED on suppressed-mode cannons.
     * When the player reverts from AIMING to HALTFIRE or TARGETFIRE
     * (e.g. right-click released, or hotbar mode cycle), NEEDED bits that
     * were set by handle_cannon_aim while the group was AIMING would
     * otherwise linger and keep driving NPCs toward those cannons.
     * Also covers multi-group onAimEnd: each group sends its own config
     * message, and all need their NEEDED bits cleaned up. */
    if (mode == WEAPON_GROUP_MODE_HALTFIRE || mode == WEAPON_GROUP_MODE_TARGETFIRE) {
        for (int ci = 0; ci < group->cannon_count; ci++) {
            ShipModule* mod = find_module_on_ship(ship, group->cannon_ids[ci]);
            if (mod) mod->state_bits &= ~MODULE_STATE_NEEDED;
        }
    }

    /* NEEDED is set purely by the sector check in handle_cannon_aim Pass 1.
     * We do NOT set NEEDED unconditionally here — that would cause all cannons
     * in the group to show NEED even when the aim angle only covers one side. */

    assign_weapon_group_crew(ship);

    /* When a group switches to AIMING, immediately re-evaluate NPC routing.
     * This covers the case where the player re-activates aiming at exactly the
     * same angle as before (delta = 0 → below the 3° gate in handle_cannon_aim),
     * so update_npc_cannon_sector would not fire from handle_cannon_aim.
     * Calling it here ensures any free NPCs are dispatched to the right side
     * as soon as the AIMING mode is applied, before the first aim message
     * arrives. */
    if (mode == WEAPON_GROUP_MODE_AIMING) {
        update_npc_cannon_sector(ship, ship->active_aim_angle);
    }

    log_info("🎯 Player %u group %d → mode=%d cannons=%d target=%u",
             player->player_id, group_index, mode, group->cannon_count, group->target_ship_id);

    /* Defer the broadcast: mark the sender's client slot as dirty so that all
     * group-config messages in one frame collapse into a single broadcast at
     * the end of this connection's message processing.  This prevents a burst
     * of rapid config messages (e.g. switching two groups to AIMING at once)
     * from echoing an intermediate state back to the sender before all groups
     * have been updated on the server. */
    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
        struct WebSocketClient* c = &ws_server.clients[ci];
        if (c->connected && c->player_id == player->player_id) {
            c->pending_group_broadcast_ship_id = ship->ship_id;
            break;
        }
    }
}

/**
 * Per-tick update: for each player's TARGETFIRE weapon groups, auto-aim the
 * group's cannons toward the locked target ship using npc_aim_cannon_at_world().
 */

/**
 * Find the WeaponGroup that owns cannon_id on ship_id, from any active player.
 * Returns NULL if no weapon group claims this cannon.
 */
static WeaponGroup* find_cannon_weapon_group(uint32_t ship_id, uint32_t cannon_id) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return NULL;
    for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
        WeaponGroup* grp = &ship->weapon_groups[g];
        for (int c = 0; c < grp->cannon_count; c++) {
            if (grp->cannon_ids[c] == cannon_id) return grp;
        }
    }
    return NULL;
}

static void tick_ship_weapon_groups(void) {
    for (int si = 0; si < ship_count; si++) {
        SimpleShip* ship = &ships[si];
        if (!ship->active) continue;
        if (ship->is_sinking) continue; /* no auto-fire while sinking */

        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            WeaponGroup* group = &ship->weapon_groups[g];
            if (group->mode != WEAPON_GROUP_MODE_TARGETFIRE) continue;
            if (group->target_ship_id == 0 || group->cannon_count == 0) continue;

            SimpleShip* target = find_ship(group->target_ship_id);
            if (!target || !target->active) continue;

            for (int c = 0; c < group->cannon_count; c++) {
                ShipModule* cannon = find_module_on_ship(ship, group->cannon_ids[c]);
                if (!cannon || cannon->type_id != MODULE_TYPE_CANNON) continue;
                npc_aim_cannon_at_world(ship, cannon, target->x, target->y);
            }
        }
    }
}

/**
 * Handle cannon aim from player
 * Updates player's aim angle and cannon aim_direction for all cannons within range
 */
static void handle_cannon_aim(WebSocketPlayer* player, float aim_angle,
                              uint32_t* active_group_indices, int active_group_count) {
    if (player->parent_ship_id == 0) {
        return; // Player not on a ship
    }

    // Only helm-mounted or cannon-mounted players may aim cannons.
    bool at_helm   = player->is_mounted &&
                     (find_ship(player->parent_ship_id) != NULL) &&
                     ({  ShipModule* _m = find_module_by_id(find_ship(player->parent_ship_id), player->mounted_module_id);
                         _m && (_m->type_id == MODULE_TYPE_HELM || _m->type_id == MODULE_TYPE_STEERING_WHEEL); });
    bool at_cannon = player->is_mounted &&
                     (find_ship(player->parent_ship_id) != NULL) &&
                     ({  ShipModule* _m = find_module_by_id(find_ship(player->parent_ship_id), player->mounted_module_id);
                         _m && _m->type_id == MODULE_TYPE_CANNON; });

    if (!at_helm && !at_cannon) {
        return; // Not at a valid control station
    }

    // Client already sends a ship-relative angle (worldAngle - shipRotation)
    player->cannon_aim_angle = aim_angle;

    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    // Use directly — do NOT subtract ship->rotation again (client already did so)
    player->cannon_aim_angle_relative = aim_angle;

    // Normalize to -PI to +PI range
    while (player->cannon_aim_angle_relative > M_PI) player->cannon_aim_angle_relative -= 2.0f * M_PI;
    while (player->cannon_aim_angle_relative < -M_PI) player->cannon_aim_angle_relative += 2.0f * M_PI;

    /* Update cannon priority dispatch on any meaningful aim change (>3°).
     * We record the delta here but defer the actual update_npc_cannon_sector
     * call until AFTER Pass 1 (NEEDED flags) and Pass 3 (NPC dismissal) so
     * that the dispatcher sees the freshly computed flags and freed NPCs. */
    bool do_sector_update = false;
    {
        float prev = ship->active_aim_angle;
        ship->active_aim_angle = player->cannon_aim_angle_relative;
        float delta = ship->active_aim_angle - prev;
        while (delta >  (float)M_PI) delta -= 2.0f * (float)M_PI;
        while (delta < -(float)M_PI) delta += 2.0f * (float)M_PI;
        if (fabsf(delta) > (3.0f * (float)M_PI / 180.0f)) {
            do_sector_update = true;
        }
    }

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

    // Update cannon(s) depending on how the player is mounted:
    //   - helm → update all cannons (broadside targeting)
    //   - cannon mount → update only the mounted cannon
    
    /* ── Determine whether this player has ANY weapon groups configured ──────
     * If at least one group has cannons assigned, we enter "group mode":
     * only cannons that are explicitly listed in an AIMING or FREEFIRE group
     * for this player will receive aim updates.  Cannons in other groups, or
     * ungrouped cannons, are completely ignored while group mode is active.
     *
     * If no groups have any cannons at all, fall back to the legacy path
     * (all occupied cannons in arc receive aim updates).
     * ────────────────────────────────────────────────────────────────────── */
    bool player_has_groups = false;
    for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
        if (ship->weapon_groups[g].cannon_count > 0) {
            player_has_groups = true;
            break;
        }
    }

    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        if (sim_ship->modules[m].type_id != MODULE_TYPE_CANNON) continue;

        ShipModule* cannon = &sim_ship->modules[m];

        /* Resolve weapon group membership once for this cannon */
        WeaponGroup* grp = find_cannon_weapon_group(ship->ship_id, cannon->id);

        /* ── Pass 1: MODULE_STATE_NEEDED update (SET-ONLY / sticky) ───────────
         *
         * NEEDED is a sticky flag: once set it stays on until the timeout
         * expires (tick_cannon_needed_expiry clears it after
         * CANNON_NEEDED_TIMEOUT_MS of inactivity).  This pass only SETS
         * the flag and refreshes the cannon_last_needed_ms timestamp.
         * It never clears NEEDED — that is exclusively the tick's job.
         *
         * This eliminates the old bug where moving the cursor away from a
         * group's sector instantly cleared NEEDED and dismissed all NPCs.
         * ──────────────────────────────────────────────────────────────────── */
        {
            bool do_needed_update;
            if (!grp) {
                if (player_has_groups) {
                    /* Ungrouped cannon in group mode — do not touch NEEDED */
                }
                /* Legacy (no groups at all): sector-based staffing applies */
                do_needed_update = !player_has_groups;
            } else {
                bool in_active = false;
                for (int ag = 0; ag < active_group_count && !in_active; ag++) {
                    uint32_t tg = active_group_indices[ag];
                    if (tg >= MAX_WEAPON_GROUPS) continue;
                    WeaponGroup* chk = &ship->weapon_groups[tg];
                    for (int ci = 0; ci < chk->cannon_count && !in_active; ci++) {
                        if (chk->cannon_ids[ci] == cannon->id) in_active = true;
                    }
                }
                if (active_group_count == 0) {
                    in_active = (grp->mode == WEAPON_GROUP_MODE_AIMING);
                }
                do_needed_update = in_active;
            }

            if (do_needed_update) {
                /* NEEDED is set only when the aim angle is within the cannon's
                 * lateral limits (±CANNON_AIM_RANGE from its fire direction).
                 * This applies to ALL cannons — grouped or ungrouped.
                 * NEEDED is sticky: once set it stays for CANNON_NEEDED_TIMEOUT_MS
                 * after the last in-sector aim or fire event.
                 *
                 * NEEDED controls NPC dispatch only — it does NOT gate aim
                 * propagation (Pass 2 handles that separately).  This keeps
                 * NPC movement efficient: crew only walks to cannons the
                 * player is actually pointing at. */
                float fire_dir = Q16_TO_FLOAT(cannon->local_rot) - (float)(M_PI / 2.0f);
                float diff = aim_angle - fire_dir;
                while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
                bool in_sector = fabsf(diff) <= CANNON_AIM_RANGE;

                if (in_sector) {
                    ShipModule* smod = find_module_on_ship(ship, cannon->id);
                    if (smod) {
                        smod->state_bits |= MODULE_STATE_NEEDED;
                        uint32_t now = get_time_ms();
                        for (int mi = 0; mi < ship->module_count; mi++) {
                            if (ship->modules[mi].id == cannon->id) {
                                ship->cannon_last_needed_ms[mi] = now;
                                break;
                            }
                        }
                    }
                }
                /* NOTE: we intentionally do NOT clear NEEDED when out of sector.
                 * tick_cannon_needed_expiry handles expiry after the timeout. */
            }
        }

        /* ── Pass 2: Aim-direction propagation (with all original gates) ────
         *
         * Now apply the at_cannon and group-mode filters that restrict which
         * cannons physically track the cursor.
         * ──────────────────────────────────────────────────────────────────── */

        // If mounted to a specific cannon, propagate aim only to that cannon
        if (at_cannon && cannon->id != player->mounted_module_id) {
            log_info("🔫 P2 c%u: SKIP at_cannon gate (mounted=%u)", cannon->id, player->mounted_module_id);
            continue;
        }

        /* ── Weapon-group aim priority ──────────────────────────────────────
         * AIMING     → player aim IS the authority for this cannon; propagate.
         * FREEFIRE   → player can steer the aim; propagate.
         * HALTFIRE   → suppressed; never track the player's cursor.
         * TARGETFIRE → auto-aim owns it; skip here to avoid fighting it.
         * Not in any group (no_group):
         *   - If player_has_groups → cannon is outside all groups; skip it.
         *   - If !player_has_groups → legacy path; propagate normally.
         * ──────────────────────────────────────────────────────────────────── */
        bool in_active_pass2 = false;
        if (grp) {
            /* If this cannon's group is in the active list from the aim
             * message, allow aim propagation regardless of stored mode
             * (fixes race between cannon_group_config and cannon_aim). */
            for (int ag = 0; ag < active_group_count && !in_active_pass2; ag++) {
                uint32_t tg = active_group_indices[ag];
                if (tg >= MAX_WEAPON_GROUPS) continue;
                WeaponGroup* chk = &ship->weapon_groups[tg];
                for (int ci = 0; ci < chk->cannon_count && !in_active_pass2; ci++) {
                    if (chk->cannon_ids[ci] == cannon->id) in_active_pass2 = true;
                }
            }
            if (!in_active_pass2) {
                if (grp->mode == WEAPON_GROUP_MODE_HALTFIRE) {
                    log_info("🔫 P2 c%u: SKIP haltfire (not in active list)", cannon->id);
                    continue;
                }
                if (grp->mode == WEAPON_GROUP_MODE_TARGETFIRE) {
                    log_info("🔫 P2 c%u: SKIP targetfire (not in active list)", cannon->id);
                    continue;
                }
            }
        } else if (player_has_groups) {
            log_info("🔫 P2 c%u: SKIP ungrouped cannon in group mode", cannon->id);
            continue; /* ungrouped cannon in group mode — already handled in pass 1 */
        }

        // Only move a cannon if it is occupied (player mounted or WorldNpc AT_CANNON).
        // Cannons cannot aim without crew present.
        bool cannon_has_occupant = (cannon->state_bits & MODULE_STATE_OCCUPIED) != 0;
        if (!cannon_has_occupant) {
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* wnpc = &world_npcs[ni];
                if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                    wnpc->ship_id == ship->ship_id &&
                    wnpc->assigned_cannon_id == cannon->id &&
                    wnpc->state == WORLD_NPC_STATE_AT_CANNON) {
                    cannon_has_occupant = true;
                    break;
                }
            }
        }
        if (!cannon_has_occupant) {
            /* Find NPC state for diagnostics */
            int npc_state = -1; uint32_t npc_assigned = 0;
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* wnpc = &world_npcs[ni];
                if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                    wnpc->ship_id == ship->ship_id &&
                    wnpc->assigned_cannon_id == cannon->id) {
                    npc_state = wnpc->state;
                    npc_assigned = wnpc->id;
                    break;
                }
            }
            int grp_idx = -1;
            if (grp) { for (int gg = 0; gg < MAX_WEAPON_GROUPS; gg++) { if (&ship->weapon_groups[gg] == grp) { grp_idx = gg; break; } } }
            log_info("🔫 P2 c%u g%d: SKIP no_occupant (sim_occ=%d npc_id=%u npc_state=%d in_active=%d)",
                     cannon->id, grp_idx,
                     (cannon->state_bits & MODULE_STATE_OCCUPIED) ? 1 : 0,
                     npc_assigned, npc_state, in_active_pass2 ? 1 : 0);
            continue;
        }

        /* Skip cannons the player has placed in a haltfire group — they should not track the cursor.
         * BUT: if in_active_pass2 is set, the client's aim message explicitly lists this cannon's
         * group as active.  This overrides the stored mode to handle the race where the aim
         * message arrives before the cannon_group_config that switches the group to AIMING. */
        if (!in_active_pass2) {
            bool in_haltfire = false;
            for (int g = 0; g < MAX_WEAPON_GROUPS && !in_haltfire; g++) {
                WeaponGroup* wg = &ship->weapon_groups[g];
                if (wg->mode != WEAPON_GROUP_MODE_HALTFIRE) continue;
                for (int ci = 0; ci < wg->cannon_count; ci++) {
                    if (wg->cannon_ids[ci] == cannon->id) { in_haltfire = true; break; }
                }
            }
            if (in_haltfire) {
                log_info("🔫 P2 c%u: SKIP in_haltfire check", cannon->id);
                continue;
            }
        }

        {
            int grp_idx = -1;
            if (grp) { for (int gg = 0; gg < MAX_WEAPON_GROUPS; gg++) { if (&ship->weapon_groups[gg] == grp) { grp_idx = gg; break; } } }
            log_info("🔫 P2 c%u g%d: AIM PROPAGATED (in_active=%d mode=%d)",
                     cannon->id, grp_idx, in_active_pass2 ? 1 : 0, grp ? grp->mode : -1);
        }

        float cannon_base_angle = Q16_TO_FLOAT(cannon->local_rot);

        // Calculate desired aim offset.
        // cannon_base_angle is in rendering convention; add PI/2 to shift into physics convention
        // so that aim_direction=0 means the cannon fires along its natural barrel direction.
        float desired_offset = player->cannon_aim_angle_relative - cannon_base_angle + (float)(M_PI / 2.0);

        // Normalize
        while (desired_offset > M_PI) desired_offset -= 2.0f * M_PI;
        while (desired_offset < -M_PI) desired_offset += 2.0f * M_PI;

        // Three zones:
        //  ≤ ±30°           — track normally
        //  ±30° to ±45°     — clamp to arc limit so cannon stays at its lateral edge
        //  > ±45°           — reset to neutral (cursor is clearly pointing away)
        const float CANNON_AIM_RESET_MARGIN = 15.0f * ((float)M_PI / 180.0f);
        if (fabsf(desired_offset) > CANNON_AIM_RANGE + CANNON_AIM_RESET_MARGIN) {
            desired_offset = 0.0f; // Past grace zone — return to neutral
        } else if (fabsf(desired_offset) > CANNON_AIM_RANGE) {
            desired_offset = (desired_offset > 0.0f) ? CANNON_AIM_RANGE : -CANNON_AIM_RANGE;
        }

        // Update cannon's aim_direction
        cannon->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);

        // Also update simple ship for sync
        for (int i = 0; i < ship->module_count; i++) {
            if (ship->modules[i].id == cannon->id) {
                ship->modules[i].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                break;
            }
        }
    }

    /* ── After Pass 1 set sticky NEEDED flags and Pass 2 propagated aim,
     * dispatch any free NPCs to NEEDED cannons.  The tick also does this
     * every frame, but running it here gives immediate responsiveness when
     * the player first aims into a new sector. */

    /* Diagnostic: log NEEDED status of all cannons after Pass 1 */
    {
        char nbuf[256]; int npos = 0;
        for (int dm = 0; dm < ship->module_count && npos < 240; dm++) {
            ShipModule* dm_mod = &ship->modules[dm];
            if (dm_mod->type_id != MODULE_TYPE_CANNON) continue;
            int needed = (dm_mod->state_bits & MODULE_STATE_NEEDED) ? 1 : 0;
            WeaponGroup* dg = find_cannon_weapon_group(ship->ship_id, dm_mod->id);
            int gi = -1;
            if (dg) { for (int gg = 0; gg < MAX_WEAPON_GROUPS; gg++) { if (&ship->weapon_groups[gg] == dg) { gi = gg; break; } } }
            npos += snprintf(nbuf + npos, (size_t)(256 - npos), " c%u:g%d:%s",
                             dm_mod->id, gi, needed ? "NEED" : "----");
        }
        log_info("📊 Ship %u NEEDED map:%s", ship->ship_id, nbuf);
    }

    if (do_sector_update) {
        update_npc_cannon_sector(ship, ship->active_aim_angle);
    }
}

/**
 * Fire a single cannon, spawning projectile
 */
static void fire_cannon(SimpleShip* ship, ShipModule* cannon, WebSocketPlayer* player, bool manually_fired, uint8_t ammo_type) {
    // Consume ship-level ammo (unless infinite ammo mode is on)
    if (!ship->infinite_ammo) {
        if (ship->cannon_ammo == 0) return; // No ammo — should have been caught earlier
        ship->cannon_ammo--;
    }
    cannon->data.cannon.time_since_fire = 0;
    cannon->state_bits |= MODULE_STATE_RELOADING;
    cannon->state_bits &= ~MODULE_STATE_FIRING;
    /* Record wall-clock fire time on the SimpleShip copy (lookup by ID — cannon
     * may point into sim_ship->modules which is a different array).
     * Also refresh cannon_last_needed_ms so the NPC stays during the full
     * reload cycle + CANNON_NEEDED_TIMEOUT_MS grace period. */
    {
        uint32_t now = get_time_ms();
        for (int _fi = 0; _fi < ship->module_count; _fi++) {
            if (ship->modules[_fi].id == cannon->id) {
                ship->cannon_last_fire_ms[_fi] = now;
                ship->cannon_last_needed_ms[_fi] = now;
                ship->modules[_fi].state_bits |= MODULE_STATE_NEEDED;
                break;
            }
        }
    }
    
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
    
    // Calculate projectile direction.
    // cannon->local_rot is stored in "rendering convention" (0 = barrel faces -Y/up, rotated from there).
    // cos/sin physics use "math convention" (0 = +X/right).
    // Converting: physics_angle = rendering_angle - PI/2
    float cannon_local_rot = Q16_TO_FLOAT(cannon->local_rot);
    float aim_offset = Q16_TO_FLOAT(cannon->data.cannon.aim_direction);
    float projectile_angle = ship->rotation + (cannon_local_rot - (float)(M_PI / 2.0)) + aim_offset;
    
    // Spawn projectile at the end of the cannon barrel (outside the ship)
    // All positions in CLIENT PIXELS at this point
    const float BARREL_LENGTH = 30.0f; // 30 pixels barrel extension
    float barrel_offset_x = cosf(projectile_angle) * BARREL_LENGTH;
    float barrel_offset_y = sinf(projectile_angle) * BARREL_LENGTH;
    
    float spawn_x = cannon_world_x + barrel_offset_x;
    float spawn_y = cannon_world_y + barrel_offset_y;
    
    // Cannonball base speed (server units/s)
    const float CANNONBALL_SPEED = CLIENT_TO_SERVER(500.0f);
    
    // ship->velocity_x/y is stored in client pixels/s — convert to server units/s before adding
    float ship_vx = CLIENT_TO_SERVER(ship->velocity_x);
    float ship_vy = CLIENT_TO_SERVER(ship->velocity_y);
    
    // Calculate projectile velocity (inherit ship velocity + cannon muzzle velocity)
    float projectile_vx = cosf(projectile_angle) * CANNONBALL_SPEED + ship_vx;
    float projectile_vy = sinf(projectile_angle) * CANNONBALL_SPEED + ship_vy;
    
    // Determine owner for projectile tracking (player can be NULL for NPC-fired cannons)
    uint32_t owner_id = (manually_fired && player != NULL) ? player->player_id : ship->ship_id;
    
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
        
        // log_info("🎯 Before spawn: projectile_count=%u, max=%d", global_sim->projectile_count, MAX_PROJECTILES);
        
        entity_id projectile_id = sim_create_projectile(global_sim, proj_pos, proj_vel, owner_id, ammo_type);
        
        // Stamp the firing ship's company and ship-id so the sim can skip friendly-fire
        // collisions and award XP correctly.
        if (projectile_id != INVALID_ENTITY_ID) {
            struct Projectile* proj = sim_get_projectile(global_sim, projectile_id);
            if (proj) {
                proj->firing_company = ship->company_id;
                proj->firing_ship_id = (entity_id)ship->ship_id;
                proj->type = ammo_type;
                // Apply the firing ship's Damage level multiplier
                struct Ship* sim_ship = sim_get_ship(global_sim, (entity_id)ship->ship_id);
                if (sim_ship) {
                    float dmg_mult = ship_level_damage_mult(&sim_ship->level_stats);
                    proj->damage = Q16_FROM_FLOAT(Q16_TO_FLOAT(proj->damage) * dmg_mult);
                }
            }
        }
        
        // log_info("🎯 After spawn: projectile_count=%u, projectile_id=%u", global_sim->projectile_count, projectile_id);
        
        if (projectile_id != INVALID_ENTITY_ID) {
            // log_info("💥 Cannon %u fired! ship_pos=(%.1f,%.1f) cannon_pos=(%.1f,%.1f) projectile_id=%u spawn_pos=(%.1f,%.1f) angle=%.2f° vel=(%.1f,%.1f) owner=%u manual=%s",
            //          cannon->id,
            //          ship->x, ship->y,
            //          cannon_world_x, cannon_world_y,
            //          projectile_id,
            //          spawn_x, spawn_y,
            //          projectile_angle * (180.0f / M_PI),
            //          SERVER_TO_CLIENT(projectile_vx), SERVER_TO_CLIENT(projectile_vy),
            //          owner_id, manually_fired ? "yes" : "no");
            
            // Broadcast cannon fire event to all clients (use cannon position for visual effect)
            broadcast_cannon_fire(cannon->id, ship->ship_id, cannon_world_x, cannon_world_y, 
                                projectile_angle, projectile_id, ammo_type);
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
                                  float angle, entity_id projectile_id, uint8_t ammo_type) {
    char message[512];
    snprintf(message, sizeof(message),
            "{\"type\":\"CANNON_FIRE_EVENT\",\"cannonId\":%u,\"shipId\":%u,"
            "\"x\":%.1f,\"y\":%.1f,\"angle\":%.3f,\"projectileId\":%u,\"ammoType\":%u}",
            cannon_id, ship_id, world_x, world_y, angle, projectile_id, (unsigned)ammo_type);
    
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
 * Broadcast authoritative weapon group state for ship to ALL connected clients.
 * Clients on other ships will ignore this message by checking shipId.
 */
static void broadcast_cannon_group_state(SimpleShip* ship) {
    if (!ship) return;
    static const char* mode_names[] = { "aiming", "freefire", "haltfire", "targetfire" };
    char message[4096];
    int pos = snprintf(message, sizeof(message),
        "{\"type\":\"cannon_group_state\",\"shipId\":%u,\"groups\":[", ship->ship_id);
    for (int g = 0; g < MAX_WEAPON_GROUPS && pos < (int)sizeof(message) - 64; g++) {
        WeaponGroup* grp = &ship->weapon_groups[g];
        const char* mode_str = (grp->mode < 4) ? mode_names[grp->mode] : "haltfire";
        pos += snprintf(message + pos, sizeof(message) - pos,
            "%s{\"index\":%d,\"mode\":\"%s\",\"cannonIds\":[",
            (g > 0 ? "," : ""), g, mode_str);
        for (int c = 0; c < grp->cannon_count && pos < (int)sizeof(message) - 32; c++) {
            pos += snprintf(message + pos, sizeof(message) - pos,
                "%s%u", (c > 0 ? "," : ""), grp->cannon_ids[c]);
        }
        pos += snprintf(message + pos, sizeof(message) - pos,
            "],\"targetShipId\":%u}", grp->target_ship_id);
    }
    if (pos < (int)sizeof(message) - 2)
        pos += snprintf(message + pos, sizeof(message) - pos, "]}");

    char frame[5120];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    if (frame_len > 0) {
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete)
                send(client->fd, frame, frame_len, 0);
        }
    }
}

/**
 * Send authoritative weapon group state for ship to a single connected client.
 * Called after a player mounts to a helm/cannon or boards a ship so they
 * immediately have the current per-ship group configuration without waiting
 * for another player to trigger a broadcast.
 */
static void send_cannon_group_state_to_client(struct WebSocketClient* client, SimpleShip* ship) {
    if (!client || !ship) return;
    if (!client->connected || !client->handshake_complete) return;
    static const char* mode_names[] = { "aiming", "freefire", "haltfire", "targetfire" };
    char message[4096];
    int pos = snprintf(message, sizeof(message),
        "{\"type\":\"cannon_group_state\",\"shipId\":%u,\"groups\":[", ship->ship_id);
    for (int g = 0; g < MAX_WEAPON_GROUPS && pos < (int)sizeof(message) - 64; g++) {
        WeaponGroup* grp = &ship->weapon_groups[g];
        const char* mode_str = (grp->mode < 4) ? mode_names[grp->mode] : "haltfire";
        pos += snprintf(message + pos, sizeof(message) - pos,
            "%s{\"index\":%d,\"mode\":\"%s\",\"cannonIds\":[",
            (g > 0 ? "," : ""), g, mode_str);
        for (int c = 0; c < grp->cannon_count && pos < (int)sizeof(message) - 32; c++) {
            pos += snprintf(message + pos, sizeof(message) - pos,
                "%s%u", (c > 0 ? "," : ""), grp->cannon_ids[c]);
        }
        pos += snprintf(message + pos, sizeof(message) - pos,
            "],\"targetShipId\":%u}", grp->target_ship_id);
    }
    if (pos < (int)sizeof(message) - 2)
        pos += snprintf(message + pos, sizeof(message) - pos, "]}");

    char frame[5120];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    if (frame_len > 0)
        send(client->fd, frame, frame_len, 0);
}

/**
 * Handle force-reload request from player.
 * Resets the reload timer on the player's manned cannon (or all nearest cannons
 * when at the helm) and marks them as RELOADING so they cannot fire immediately.
 * This lets a player discard the currently loaded round and reload a different ammo type.
 */
static void handle_cannon_force_reload(WebSocketPlayer* player) {
    if (player->parent_ship_id == 0 || !player->is_mounted) return;

    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    struct Ship* sim_ship = NULL;
    if (global_sim) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                sim_ship = &global_sim->ships[s];
                break;
            }
        }
    }
    if (!sim_ship) return;

    ShipModule* mmod = find_module_by_id(ship, player->mounted_module_id);
    if (!mmod) return;

    bool at_cannon = (mmod->type_id == MODULE_TYPE_CANNON);
    bool at_helm   = (mmod->type_id == MODULE_TYPE_HELM ||
                      mmod->type_id == MODULE_TYPE_STEERING_WHEEL);

    if (!at_cannon && !at_helm) return;

    int reloaded = 0;
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* module = &sim_ship->modules[m];
        if (module->type_id != MODULE_TYPE_CANNON) continue;

        /* For a cannon-mounted player only reset their specific cannon */
        if (at_cannon && module->id != mmod->id) continue;

        /* Reset reload timer and set RELOADING flag */
        module->data.cannon.time_since_fire = 0;
        module->state_bits |= MODULE_STATE_RELOADING;
        module->state_bits &= ~MODULE_STATE_FIRING;
        reloaded++;
    }

    log_info("⚡ Force-reload: player %u reset %d cannon(s) on ship %u",
             player->player_id, reloaded, ship->ship_id);
}

/**
 * Handle cannon fire from player.
 *
 * @param fire_all        True → broadside (fire every loaded cannon with crew).
 * @param ammo_type       PROJ_TYPE_CANNONBALL or PROJ_TYPE_BAR_SHOT.
 * @param explicit_ids    Non-NULL → fire only these cannon module IDs (weapon-group fire).
 * @param explicit_count  Length of explicit_ids array (0 when explicit_ids is NULL).
 * @param skip_aim_check  True → skip the aim-angle tolerance check (freefire / targetfire).
 */
static void handle_cannon_fire(WebSocketPlayer* player, bool fire_all, uint8_t ammo_type,
                               uint32_t* explicit_ids, int explicit_count, bool skip_aim_check) {
    if (player->parent_ship_id == 0) {
        log_warn("Player %u tried to fire cannons while not on a ship", player->player_id);
        return;
    }

    // Determine what the player is currently mounted to
    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) {
        log_warn("Player %u parent ship %u not found", player->player_id, player->parent_ship_id);
        return;
    }

    /* Prevent firing while ship is sinking */
    if (ship->is_sinking) return;

    bool at_helm = false;
    bool at_cannon = false;
    uint32_t mounted_cannon_id = 0;

    if (player->is_mounted) {
        ShipModule* mmod = find_module_by_id(ship, player->mounted_module_id);
        if (mmod) {
            if (mmod->type_id == MODULE_TYPE_HELM || mmod->type_id == MODULE_TYPE_STEERING_WHEEL) {
                at_helm = true;
            } else if (mmod->type_id == MODULE_TYPE_CANNON) {
                at_cannon = true;
                mounted_cannon_id = mmod->id;
            }
        }
    }

    if (!at_helm && !at_cannon) {
        log_warn("Player %u tried to fire cannons but is not at helm or cannon", player->player_id);
        return;
    }

    int cannons_fired = 0;
    // Helm-triggered shots are considered automated (broadside volleys);
    // cannon-mounted shots are manually aimed.
    bool manually_fired = at_cannon;
    
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

        // If the client sent an explicit cannon-ID list (weapon-group fire), only
        // fire cannons that appear in that list.
        if (explicit_ids && explicit_count > 0) {
            bool in_list = false;
            for (int ei = 0; ei < explicit_count; ei++) {
                if (explicit_ids[ei] == module->id) { in_list = true; break; }
            }
            if (!in_list) continue;
        } else if (at_cannon && module->id != mounted_cannon_id) {
            // If mounted to a specific cannon, skip every other cannon
            continue;
        }

        // Check ammo and reload status
        if (!ship->infinite_ammo && ship->cannon_ammo == 0) {
            // log_info("  ⚠️  Ship %u: No ammo", ship->ship_id);
            break; // No point checking remaining cannons
        }
        
        if (module->data.cannon.time_since_fire < module->data.cannon.reload_time) {
            // log_info("  ⚠️  Cannon %u: Reloading (%.1fs remaining)", 
            //          module->id,
            //          (module->data.cannon.reload_time - module->data.cannon.time_since_fire) / 1000.0f);
            continue;
        }

        // Require a player or NPC to be mounted at this cannon before it can fire.
        // When the firing player is already mounted to this cannon (at_cannon), it counts.
        // Otherwise check for a WorldNpc gunner stationed here.
        if (!at_cannon || module->id != mounted_cannon_id) {
            bool cannon_occupied = false;
            // Check if another player is mounted here
            for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                WebSocketPlayer* op = &players[pi];
                if (op->active && op->is_mounted && op->mounted_module_id == module->id) {
                    cannon_occupied = true;
                    break;
                }
            }
            // Check if a WorldNpc gunner is stationed here
            if (!cannon_occupied) {
                for (int wn = 0; wn < world_npc_count; wn++) {
                    WorldNpc* wnpc = &world_npcs[wn];
                    if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                        wnpc->ship_id == ship->ship_id &&
                        wnpc->assigned_cannon_id == module->id &&
                        wnpc->state == WORLD_NPC_STATE_AT_CANNON) {
                        cannon_occupied = true;
                        break;
                    }
                }
            }
            if (!cannon_occupied) {
                // log_info("  ⏭️  Cannon %u: No crew mounted — skipping", module->id);
                continue;
            }
        }
        
        bool should_fire = fire_all || skip_aim_check;
        
        if (!fire_all && !skip_aim_check) {
            // Single click with aim check: only fire cannons within player's aim arc
            // Cannon can aim ±30° from its base rotation
            float cannon_base_angle = Q16_TO_FLOAT(module->local_rot); // Cannon's base rotation relative to ship
            float cannon_current_aim = Q16_TO_FLOAT(module->data.cannon.aim_direction); // Current aim offset
            // Convert base angle from rendering convention to physics convention (subtract PI/2)
            float cannon_absolute_aim = (cannon_base_angle - (float)(M_PI / 2.0)) + cannon_current_aim;
            
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
            const float AIM_TOLERANCE = 0.35f; // ~20 degrees tolerance for "being aimed"
            
            should_fire = (aim_difference < AIM_TOLERANCE);
            
            if (!should_fire) {
                // log_info("  ⏭️  Cannon %u: Not aimed (diff=%.1f°, tolerance=±%.1f°)", 
                //          module->id, aim_difference * (180.0f / M_PI), AIM_TOLERANCE * (180.0f / M_PI));
            }
        }
        
        if (should_fire) {
            fire_cannon(ship, module, player, manually_fired, ammo_type);
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
    
    log_info("💥 Player %u fired %d cannon(s) on ship %u (%s%s)", 
             player->player_id, cannons_fired, ship->ship_id,
             fire_all ? "BROADSIDE" : (explicit_ids ? "GROUP" : "AIMED"),
             skip_aim_check ? "/FREEFIRE" : "");
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
    
    // log_info("🎮 [MODULE_INTERACT] Player %u -> Module %u", player->player_id, module_id);
    
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
    
    // log_info("🔍 Module %u Q16 pos: (%d, %d)", module_id, module->local_pos.x, module->local_pos.y);
    // log_info("🔍 Module %u converted local pos: (%.1f, %.1f)", module_id, module_local_x, module_local_y);
    // log_info("🔍 Ship %u pos: (%.1f, %.1f), rot: %.3f", target_ship->ship_id, target_ship->x, target_ship->y, target_ship->rotation);
    // log_info("🔍 Player %u parent_ship_id: %u, local pos: (%.1f, %.1f), world pos: (%.1f, %.1f)", 
    //          player->player_id, player->parent_ship_id, player->local_x, player->local_y, player->x, player->y);
    
    if (player->parent_ship_id == target_ship->ship_id) {
        // Player on same ship - use ship-local coordinates
        // log_info("🔍 Using LOCAL coordinates (player on ship %u)", target_ship->ship_id);
        dx = player->local_x - module_local_x;
        dy = player->local_y - module_local_y;
        // log_info("🔍 Local distance: player (%.1f, %.1f) - module (%.1f, %.1f) = delta (%.1f, %.1f)", 
        //          player->local_x, player->local_y, module_local_x, module_local_y, dx, dy);
        
        // Calculate world coords for logging
        ship_local_to_world(target_ship, player->local_x, player->local_y, &player_world_x, &player_world_y);
        ship_local_to_world(target_ship, module_local_x, module_local_y, &module_world_x, &module_world_y);
    } else {
        // Player in water or on different ship - use world coordinates
        // log_info("🔍 Using WORLD coordinates (player in water or different ship)");
        ship_local_to_world(target_ship, module_local_x, module_local_y, &module_world_x, &module_world_y);
        dx = player->x - module_world_x;
        dy = player->y - module_world_y;
        // log_info("🔍 World distance: player (%.1f, %.1f) - module (%.1f, %.1f) = delta (%.1f, %.1f)", 
        //          player->x, player->y, module_world_x, module_world_y, dx, dy);
        
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
    // log_info("✅ Player %u interacting with %s (ID: %u) at %.1fpx", 
    //          player->player_id, get_module_type_name(module->type_id), module_id, distance);
    
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
__attribute__((unused))
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
                
                // Resolve collisions with ship modules (helm, mast, cannon)
                resolve_player_module_collisions(ship,
                    player->is_mounted ? player->mounted_module_id : 0,
                    &new_local_x, &new_local_y);

                // Check if player would walk off the deck (hull boundary)
                if (is_outside_deck(ship->ship_id, new_local_x, new_local_y)) {
                    // Player walked off the edge - dismount into water
                    log_info("🌊 Player %u walked off the deck of ship %u", 
                             player->player_id, ship->ship_id);
                    
                    // Place player at the exit point (new_local_x/y is just outside the hull)
                    ship_local_to_world(ship, new_local_x, new_local_y, 
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
__attribute__((unused))
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
                
                // Resolve collisions with ship modules (helm, mast, cannon)
                resolve_player_module_collisions(ship,
                    player->is_mounted ? player->mounted_module_id : 0,
                    &new_local_x, &new_local_y);

                // Check if player would walk off the deck (hull boundary)
                if (is_outside_deck(ship->ship_id, new_local_x, new_local_y)) {
                    // Player walked off the edge - dismount into water
                    log_info("🌊 Player %u walked off the deck of ship %u", 
                             player->player_id, ship->ship_id);
                    
                    // Place player at the exit point (new_local_x/y is just outside the hull)
                    ship_local_to_world(ship, new_local_x, new_local_y, 
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

/**
 * Each tick: keep sinking ships frozen and despawn them after SHIP_SINK_DURATION_MS.
 */
static void tick_sinking_ships(void) {
    uint32_t now = get_time_ms();
    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active || !ship->is_sinking) continue;

        /* Keep the vessel stationary — zero velocity in the sim ship every tick */
        if (global_sim) {
            for (uint32_t ss = 0; ss < global_sim->ship_count; ss++) {
                if ((uint32_t)global_sim->ships[ss].id == ship->ship_id) {
                    global_sim->ships[ss].velocity.x = 0;
                    global_sim->ships[ss].velocity.y = 0;
                    global_sim->ships[ss].angular_velocity = 0;
                    break;
                }
            }
        }
        ship->velocity_x = 0.0f;
        ship->velocity_y = 0.0f;
        ship->angular_velocity = 0.0f;

        /* After 8 s, fully despawn and broadcast SHIP_SINK */
        if ((now - ship->sink_start_ms) < SHIP_SINK_DURATION_MS) continue;

        entity_id sunk_id = ship->ship_id;
        float wx = ship->x, wy = ship->y;

        /* Eject any remaining players to the water */
        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
            if (!players[pi].active || players[pi].parent_ship_id != sunk_id) continue;
            players[pi].parent_ship_id      = 0;
            players[pi].movement_state      = PLAYER_STATE_SWIMMING;
            players[pi].is_mounted          = false;
            players[pi].mounted_module_id   = 0;
            players[pi].controlling_ship_id = 0;
            players[pi].x = SERVER_TO_CLIENT(CLIENT_TO_SERVER(wx));
            players[pi].y = SERVER_TO_CLIENT(CLIENT_TO_SERVER(wy));
        }

        /* Destroy in sim */
        if (global_sim) sim_destroy_entity(global_sim, sunk_id);

        /* Swap-and-pop */
        ships[s] = ships[ship_count - 1];
        memset(&ships[ship_count - 1], 0, sizeof(SimpleShip));
        ship_count--;
        s--; /* re-check this slot */

        /* Broadcast final SHIP_SINK */
        char msg[128];
        snprintf(msg, sizeof(msg),
            "{\"type\":\"SHIP_SINK\",\"shipId\":%u,\"x\":%.1f,\"y\":%.1f}",
            sunk_id, SERVER_TO_CLIENT(CLIENT_TO_SERVER(wx)), SERVER_TO_CLIENT(CLIENT_TO_SERVER(wy)));
        websocket_server_broadcast(msg);
        log_info("⚓ Ship %u fully despawned after sinking", sunk_id);
    }
}

/**
 * Partition the ship's cannon modules into sensible default weapon control groups.
 * Group 0 = port-side cannons  (local_y > 0), mode = HALTFIRE
 * Group 1 = starboard cannons  (local_y < 0), mode = HALTFIRE
 * Groups 2-9 = empty,                          mode = HALTFIRE
 *
 * All groups start HALTFIRE so the ship is silent until the player actively
 * configures them.  Called once after all modules have been added to the ship.
 */
static void ship_init_default_weapon_groups(SimpleShip* ship) {
    /* Reset all groups to HALTFIRE with no cannons */
    for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
        ship->weapon_groups[g].mode         = WEAPON_GROUP_MODE_HALTFIRE;
        ship->weapon_groups[g].cannon_count = 0;
        ship->weapon_groups[g].target_ship_id = 0;
    }

    /* Partition cannons: port (local_y > 0) → group 1, starboard → group 2 */
    for (int m = 0; m < ship->module_count; m++) {
        ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON) continue;

        float local_y = Q16_TO_FLOAT(mod->local_pos.y);
        int   target_group = (local_y > 0.0f) ? 1 : 2;
        WeaponGroup* grp = &ship->weapon_groups[target_group];
        if (grp->cannon_count < MAX_CANNONS_PER_GROUP) {
            grp->cannon_ids[grp->cannon_count++] = mod->id;
        }
    }

    log_info("🔫 Ship %u: default groups — port=%d cannons (grp1), starboard=%d cannons (grp2)",
             ship->ship_id,
             ship->weapon_groups[1].cannon_count,
             ship->weapon_groups[2].cannon_count);
}

// Initialize a brigantine ship at the given slot index, world position (client pixels), module ID base, and company
static void init_brigantine_ship(int idx, float world_x, float world_y, uint16_t module_id_base, uint8_t company_id) {
    SimpleShip* s = &ships[idx];
    memset(s, 0, sizeof(SimpleShip));

    s->ship_id  = next_ship_id++;
    s->ship_type = 3;  // Brigantine
    s->company_id = company_id;
    s->x = world_x;
    s->y = world_y;
    s->active = true;

    s->mass             = BRIGANTINE_MASS;
    s->moment_of_inertia = BRIGANTINE_MOMENT_OF_INERTIA;
    s->max_speed        = BRIGANTINE_MAX_SPEED;
    s->turn_rate        = BRIGANTINE_TURN_RATE;
    s->water_drag       = BRIGANTINE_WATER_DRAG;
    s->angular_drag     = BRIGANTINE_ANGULAR_DRAG;

    // Deck bounds (server units = client px / 10)
    s->deck_min_x = -31.0f;
    s->deck_max_x =  30.0f;
    s->deck_min_y =  -8.0f;
    s->deck_max_y =   8.0f;

    s->module_count = 0;
    s->cannon_ammo  = 0;       // unused — infinite_ammo is on
    s->infinite_ammo = true;
    s->module_id_base = module_id_base;

    uint16_t mid = module_id_base;

    // Helm
    s->modules[s->module_count].id           = mid++;
    s->modules[s->module_count].type_id      = MODULE_TYPE_HELM;
    s->modules[s->module_count].local_pos.x  = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f));
    s->modules[s->module_count].local_pos.y  = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
    s->modules[s->module_count].local_rot    = Q16_FROM_FLOAT(0.0f);
    s->modules[s->module_count].state_bits   = MODULE_STATE_ACTIVE;
    s->modules[s->module_count].data.helm.occupied_by    = 0;
    s->modules[s->module_count].data.helm.wheel_rotation = Q16_FROM_FLOAT(0.0f);
    s->module_count++;

    // 6 cannons — BROADSIDE loadout (x=fore/aft, y=port/starboard)
    float cannon_xs[3] = { -35.0f, 65.0f, -135.0f };
    for (int i = 0; i < 6; i++) {
        float cx  = cannon_xs[i % 3];
        float cy  = (i < 3) ? 75.0f : -75.0f;
        float rot = (i < 3) ? (float)M_PI : 0.0f;
        s->modules[s->module_count].id          = mid++;
        s->modules[s->module_count].type_id     = MODULE_TYPE_CANNON;
        s->modules[s->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cx));
        s->modules[s->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cy));
        s->modules[s->module_count].local_rot   = Q16_FROM_FLOAT(rot);
        s->modules[s->module_count].state_bits  = MODULE_STATE_ACTIVE;
        s->modules[s->module_count].data.cannon.aim_direction  = Q16_FROM_FLOAT(0.0f);
        s->modules[s->module_count].data.cannon.ammunition     = 10;
        s->modules[s->module_count].data.cannon.reload_time    = CANNON_RELOAD_TIME_MS;
        s->modules[s->module_count].data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS; // start ready to fire
        s->module_count++;
    }

    // 3 masts — front x=165, middle x=-35, back x=-235
    float mast_xs[3] = { 165.0f, -35.0f, -235.0f };
    for (int i = 0; i < 3; i++) {
        s->modules[s->module_count].id          = mid++;
        s->modules[s->module_count].type_id     = MODULE_TYPE_MAST;
        s->modules[s->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(mast_xs[i]));
        s->modules[s->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
        s->modules[s->module_count].local_rot   = Q16_FROM_FLOAT(0.0f);
        s->modules[s->module_count].state_bits  = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
        s->modules[s->module_count].data.mast.angle          = Q16_FROM_FLOAT(0.0f);
        s->modules[s->module_count].data.mast.openness       = 0;
        s->modules[s->module_count].data.mast.wind_efficiency = Q16_FROM_FLOAT(1.0f);
        s->module_count++;
    }

    // Ladder at stern
    s->modules[s->module_count].id          = mid++;
    s->modules[s->module_count].type_id     = MODULE_TYPE_LADDER;
    s->modules[s->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-305.0f));
    s->modules[s->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
    s->modules[s->module_count].local_rot   = Q16_FROM_FLOAT(0.0f);
    s->modules[s->module_count].state_bits  = MODULE_STATE_ACTIVE;
    s->module_count++;

    /* Set up default weapon control groups now that all modules are registered */
    ship_init_default_weapon_groups(s);

    log_info("🔧 Ship slot %d (ID %u): %d modules, pos=(%.0f,%.0f)", idx, s->ship_id, s->module_count, world_x, world_y);
}

uint32_t websocket_server_create_ship(float x, float y, uint8_t company_id) {
    if (!global_sim) {
        log_warn("websocket_server_create_ship: no simulation linked");
        return 0;
    }
    if (ship_count >= MAX_SIMPLE_SHIPS) {
        log_warn("websocket_server_create_ship: MAX_SIMPLE_SHIPS (%d) reached", MAX_SIMPLE_SHIPS);
        return 0;
    }

    // Unique module ID range: monotonically increasing so recycled slots never collide
    uint16_t mid_base = (uint16_t)(next_mid_base & 0xFFFF);
    next_mid_base += 1000u;

    // Build the SimpleShip layout (uses next_ship_id internally — we override below)
    init_brigantine_ship(ship_count, x, y, mid_base, company_id);

    // Create the authoritative physics counterpart and use its entity ID
    Vec2Q16 sim_pos = {
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)),
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
    };
    entity_id sim_id = sim_create_ship(global_sim, sim_pos, Q16_FROM_INT(0));
    if (sim_id == INVALID_ENTITY_ID) {
        log_warn("websocket_server_create_ship: sim_create_ship failed");
        ships[ship_count].active = false;
        return 0;
    }

    // Sync IDs so the update loop matches them
    ships[ship_count].ship_id = sim_id;
    ship_count++;

    log_info("🚢 Admin spawned ship (ID: %u) at (%.0f, %.0f) company=%u", sim_id, x, y, company_id);
    return sim_id;
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
    
    // Spawn two brigantine ships: ship 1 at (100, 100), ship 2 at (100, 700) — 600px south
    init_brigantine_ship(0, 100.0f, 100.0f,  1000, COMPANY_PIRATES);
    init_brigantine_ship(1, 100.0f, 700.0f,  2000, COMPANY_NAVY);
    ship_count = 2;
    
    log_info("🚢 Ship 1 (ID: %u) — company: %s", ships[0].ship_id, company_name(ships[0].company_id));
    log_info("🚢 Ship 2 (ID: %u) — company: %s", ships[1].ship_id, company_name(ships[1].company_id));

    // Spawn NPC gunners on ship 2 (module IDs 2001-2006 are its 6 cannons).
    // They will target ship 1 automatically.  Fire every 5s; initial delay 2s.
    {
        uint32_t ship2_id = ships[1].ship_id;
        uint32_t ship1_id = ships[0].ship_id;
        // Port-side cannon (2001) and starboard-side cannon (2004)
        uint32_t npc1 = websocket_server_create_npc(ship2_id, 2001, NPC_ROLE_GUNNER);
        uint32_t npc2 = websocket_server_create_npc(ship2_id, 2004, NPC_ROLE_GUNNER);
        if (npc1) websocket_server_npc_set_target(npc1, ship1_id);
        if (npc2) websocket_server_npc_set_target(npc2, ship1_id);
        log_info("🤖 NPC gunners %u and %u spawned on ship 2, targeting ship 1", npc1, npc2);
    }

    // Spawn crew NPCs across both ships:
    //   - 6 gunners per ship: one per individual cannon.
    //     Module IDs: base+1..3 = port cannons, base+4..6 = starboard cannons.
    //   - 3 riggers per ship: one per mast (base+7, base+8, base+9).
    {
        /* 9 generic crew per ship — roles assigned at runtime by the manning panel.
         * Any crew member can become a gunner, rigger, or stand idle. */
        static const char* crew_names[18] = {
            "Bo",   "Mack", "Finn", "Ray",  "Cole", "Sven",
            "Ned",  "Hank", "Jim",
            "Dirk", "Walt", "Hal",  "Cruz", "Ike",  "Rex",
            "Lars", "Tam",  "Bren"
        };
        int crew_idx = 0;
        for (int s = 0; s < 2; s++) {
            uint32_t sid = ships[s].ship_id;
            for (int c = 0; c < 9; c++)
                spawn_ship_crew(sid, crew_names[crew_idx++]);
        }
        log_info("🧑 %d crew NPCs spawned across 2 ships (roles assigned by player)",
                 world_npc_count);
    }

    // Enhanced startup message
    printf("\n🌐 ═══════════════════════════════════════════════════════════════\n");
    printf("🔌 WebSocket Server Ready for Browser Clients!\n");
    printf("🌍 WebSocket listening on 0.0.0.0:%u\n", port);
    printf("🔄 Protocol bridge: WebSocket ↔ UDP translation active\n");
    printf("🎯 Browser clients can now connect via WebSocket\n");
    printf("🚢 Ship 1 at (%.1f, %.1f)  Ship 2 at (%.1f, %.1f)\n",
           ships[0].x, ships[0].y, ships[1].x, ships[1].y);
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
                    for (size_t i = 0; i < (size_t)received && i < 32; i++) {
                        offset += snprintf(hex_dump + offset, sizeof(hex_dump) - offset, "%02X ", (unsigned char)buffer[i]);
                    }
                    log_warn("Raw bytes (first 32): %s", hex_dump);
                    continue;
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
                                    static char game_state_frame[32768];
                                    static char game_state_response[28000];
                                    
                                    // Build ships array for initial state (increased buffer for modules)
                                    static char ships_str[20000];
                                    int ships_offset = 0;
                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "[");
                                    
                                    bool first_ship = true;
                                    for (int s = 0; s < ship_count && ships_offset < (int)sizeof(ships_str) - 512; s++) {
                                        if (ships[s].active) {
                                            ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                    "%s{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"ammo\":%u,\"infiniteAmmo\":%s,\"modules\":[",
                                                    first_ship ? "" : ",",
                                                    ships[s].ship_id, ships[s].x, ships[s].y, ships[s].rotation,
                                                    ships[s].velocity_x, ships[s].velocity_y,
                                                    ships[s].cannon_ammo, ships[s].infinite_ammo ? "true" : "false");
                                            
                                            // Add modules
                                            for (int m = 0; m < ships[s].module_count && ships_offset < (int)sizeof(ships_str) - 200; m++) {
                                                const ShipModule* module = &ships[s].modules[m];
                                                float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                                                float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                                                float module_rot = Q16_TO_FLOAT(module->local_rot);
                                                
                                                // Add module-specific data based on type
                                                if (module->type_id == MODULE_TYPE_MAST) {
                                                    // Mast: include openness, sail angle, wind efficiency, fiber HP
                                                    float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                                                    float wind_eff   = Q16_TO_FLOAT(module->data.mast.wind_efficiency);
                                                    float fh         = Q16_TO_FLOAT(module->data.mast.fiber_health);
                                                    float fhmax      = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f,\"windEfficiency\":%.3f,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f}",
                                                        m > 0 ? "," : "", module->id, module->type_id, 
                                                        module_x, module_y, module_rot, module->data.mast.openness, sail_angle, wind_eff, fh, fhmax);
                                                } else if (module->type_id == MODULE_TYPE_CANNON) {
                                                    // Cannon: include aim direction and state (ammo is ship-level now)
                                                    float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, aim_direction,
                                                        (unsigned)module->state_bits);
                                                } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                                                    // Helm: include wheel rotation, occupied status, state
                                                    float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, wheel_rot,
                                                        (module->data.helm.occupied_by != 0) ? "true" : "false",
                                                        (unsigned)module->state_bits);
                                                } else {
                                                    // Generic module (mast, ladder, etc.): transform + state
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, (unsigned)module->state_bits);
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
                                        
                                        // Log player input (silenced for debugging)
                                        // log_info("🎮 INPUT[P%u]: movement(%.2f, %.2f) rotation=%.2f° moving=%d",
                                        //         player->player_id, x, y, rotation * (180.0f / M_PI), player->is_moving);
                                        
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
                                    
                                    // Log movement state change (silenced for debugging)
                                    // log_info("🚶 MOVEMENT_STATE[P%u]: direction(%.2f, %.2f) is_moving=%d",
                                    //         player->player_id, x, y, is_moving);
                                    
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
                                    
                                    // Log rotation update (silenced for debugging)
                                    // log_info("🔄 ROTATION[P%u]: %.2f° (%.4f rad)",
                                    //         player->player_id, rotation * (180.0f / M_PI), rotation);
                                    
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"rotation_updated\"}");
                                } else {
                                    log_warn("Rotation update for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"module_interact\"")) {
                            // MODULE_INTERACT message
                            // log_info("🎮 Processing MODULE_INTERACT message");
                            
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
                            // log_info("🔓 Processing MODULE_UNMOUNT message");
                            
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
                            // log_info("⚡ Processing ACTION_EVENT message");
                            
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
                                    
                                    // log_info("⚡ Player %u action: %s", player->player_id, action);
                                    
                                    response[0] = '\0'; /* prevent action_processed from overwriting per-action responses */
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
                                    } else if (strcmp(action, "dismount") == 0) {
                                        // Dismount from helm / cannon / seat
                                        if (player->is_mounted) {
                                            handle_module_unmount(player, client);
                                        } else {
                                            log_info("🔓 Player %u dismount request ignored (not mounted)", player->player_id);
                                            send_interaction_failure(client, "not_mounted");
                                        }
                                    } else if (strcmp(action, "interact") == 0) {
                                        // Check proximity to world NPCs
                                        bool interacted = false;
                                        for (int n = 0; n < world_npc_count && !interacted; n++) {
                                            WorldNpc* npc = &world_npcs[n];
                                            if (!npc->active) continue;
                                            float dx = player->x - npc->x;
                                            float dy = player->y - npc->y;
                                            float dist_sq = dx * dx + dy * dy;
                                            float r = npc->interact_radius;
                                            if (dist_sq <= r * r) {
                                                log_info("💬 Player %u interacted with NPC %u (%s)",
                                                         player->player_id, npc->id, npc->name);
                                                char npc_msg[312];
                                                snprintf(npc_msg, sizeof(npc_msg),
                                                    "{\"type\":\"npc_dialogue\",\"npc_id\":%u,"
                                                    "\"npc_name\":\"%s\",\"text\":\"%s\"}",
                                                    npc->id, npc->name, npc->dialogue);
                                                char npc_frame[512];
                                                size_t npc_len = websocket_create_frame(
                                                    WS_OPCODE_TEXT, npc_msg, strlen(npc_msg),
                                                    npc_frame, sizeof(npc_frame));
                                                if (npc_len > 0)
                                                    send(client->fd, npc_frame, npc_len, 0);
                                                interacted = true;
                                            }
                                        }
                                        if (!interacted) {
                                            log_info("🤝 Player %u interacted (no NPC in range)", player->player_id);
                                        }
                                    } else if (strcmp(action, "attack") == 0) {
                                        // Walking melee attack — reject if mounted
                                        if (player->is_mounted) {
                                            log_warn("⚔️ Player %u attack rejected (mounted)", player->player_id);
                                        } else {
                                            // Parse target position from "target":{x,y}
                                            float target_x = player->x;
                                            float target_y = player->y;
                                            char* target_start = strstr(payload, "\"target\":{");
                                            if (target_start) {
                                                char* xp = strstr(target_start, "\"x\":");
                                                char* yp = strstr(target_start, "\"y\":");
                                                if (xp) target_x = strtof(xp + 4, NULL);
                                                if (yp) target_y = strtof(yp + 4, NULL);
                                            }

                                            // ── Sword attack ──────────────────────────────
                                            uint8_t aslot = player->inventory.active_slot;
                                            bool holding_sword = (aslot < INVENTORY_SLOTS &&
                                                player->inventory.slots[aslot].item == ITEM_SWORD &&
                                                player->inventory.slots[aslot].quantity > 0);

                                            if (holding_sword) {
                                                const uint32_t SWORD_COOLDOWN_MS = 600u;
                                                uint32_t now_ms = get_time_ms();
                                                if (now_ms - player->sword_last_attack_ms < SWORD_COOLDOWN_MS) {
                                                    log_warn("Player %u sword attack rejected: on cooldown", player->player_id);
                                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"sword_cooldown\"}");
                                                    goto sword_attack_done;
                                                }
                                                player->sword_last_attack_ms = now_ms;

                                                const float SWORD_RANGE  = 30.0f;
                                                const float SWORD_DAMAGE = 30.0f;
                                                const float SWORD_RANGE2 = SWORD_RANGE * SWORD_RANGE;

                                                // Direction vector toward target
                                                float atk_dx = target_x - player->x;
                                                float atk_dy = target_y - player->y;
                                                float atk_len = sqrtf(atk_dx*atk_dx + atk_dy*atk_dy);
                                                if (atk_len < 0.1f) { atk_dx = 1.0f; atk_dy = 0.0f; }
                                                else { atk_dx /= atk_len; atk_dy /= atk_len; }
                                                float atk_angle = atan2f(atk_dy, atk_dx);

                                                // ── Hit NPCs ──────────────────────────────
                                                for (int ni = 0; ni < world_npc_count; ni++) {
                                                    WorldNpc* tnpc = &world_npcs[ni];
                                                    if (!tnpc->active) continue;
                                                    // No friendly fire
                                                    if (player->parent_ship_id != 0 &&
                                                        tnpc->ship_id == player->parent_ship_id) continue;

                                                    float nx = tnpc->x - player->x;
                                                    float ny = tnpc->y - player->y;
                                                    if (nx*nx + ny*ny > SWORD_RANGE2) continue;

                                                    // 120-degree arc (±60°)
                                                    float npc_angle = atan2f(ny, nx);
                                                    float diff = npc_angle - atk_angle;
                                                    while (diff >  (float)M_PI) diff -= 2.0f*(float)M_PI;
                                                    while (diff < -(float)M_PI) diff += 2.0f*(float)M_PI;
                                                    if (fabsf(diff) > (float)M_PI / 3.0f * 2.0f) continue;

                                                    uint16_t dmg16 = (uint16_t)SWORD_DAMAGE;
                                                    bool killed_npc = false;
                                                    if (tnpc->health <= dmg16) {
                                                        tnpc->health = 0;
                                                        tnpc->active = false;
                                                        killed_npc = true;
                                                    } else {
                                                        tnpc->health -= dmg16;
                                                    }

                                                    // Small knockback impulse
                                                    float dist = sqrtf(nx*nx + ny*ny);
                                                    float kx = (dist > 0.1f) ? (nx/dist) : atk_dx;
                                                    float ky = (dist > 0.1f) ? (ny/dist) : atk_dy;
                                                    tnpc->velocity_x += kx * 30.0f;
                                                    tnpc->velocity_y += ky * 30.0f;

                                                    char hit_msg[256];
                                                    snprintf(hit_msg, sizeof(hit_msg),
                                                        "{\"type\":\"ENTITY_HIT\",\"entityType\":\"npc\",\"id\":%u,"
                                                        "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                                                        "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                                                        tnpc->id, tnpc->x, tnpc->y, SWORD_DAMAGE,
                                                        (unsigned)tnpc->health, (unsigned)tnpc->max_health,
                                                        killed_npc ? "true" : "false");
                                                    websocket_server_broadcast(hit_msg);

                                                    log_info("⚔️  Player %u sword hit NPC %u (HP %u/%u)%s",
                                                             player->player_id, tnpc->id,
                                                             (unsigned)tnpc->health, (unsigned)tnpc->max_health,
                                                             killed_npc ? " KILLED" : "");
                                                }

                                                // ── Hit Players (PvP) ─────────────────────
                                                for (int wpi = 0; wpi < WS_MAX_CLIENTS; wpi++) {
                                                    WebSocketPlayer* tp = &players[wpi];
                                                    if (!tp->active || tp->player_id == player->player_id) continue;
                                                    if (player->parent_ship_id != 0 &&
                                                        tp->parent_ship_id == player->parent_ship_id) continue;

                                                    float px2 = tp->x - player->x;
                                                    float py2 = tp->y - player->y;
                                                    if (px2*px2 + py2*py2 > SWORD_RANGE2) continue;

                                                    float p_angle = atan2f(py2, px2);
                                                    float pdiff   = p_angle - atk_angle;
                                                    while (pdiff >  (float)M_PI) pdiff -= 2.0f*(float)M_PI;
                                                    while (pdiff < -(float)M_PI) pdiff += 2.0f*(float)M_PI;
                                                    if (fabsf(pdiff) > (float)M_PI / 3.0f * 2.0f) continue;

                                                    uint16_t dmg16 = (uint16_t)SWORD_DAMAGE;
                                                    if (tp->health <= dmg16) tp->health = 0;
                                                    else tp->health -= dmg16;

                                                    char hit_msg[256];
                                                    snprintf(hit_msg, sizeof(hit_msg),
                                                        "{\"type\":\"ENTITY_HIT\",\"entityType\":\"player\",\"id\":%u,"
                                                        "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                                                        "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                                                        tp->player_id, tp->x, tp->y, SWORD_DAMAGE,
                                                        (unsigned)tp->health, (unsigned)tp->max_health,
                                                        tp->health == 0 ? "true" : "false");
                                                    websocket_server_broadcast(hit_msg);
                                                }

                                                // Broadcast sword swing (for client animation)
                                                char swing_msg[256];
                                                snprintf(swing_msg, sizeof(swing_msg),
                                                    "{\"type\":\"SWORD_SWING\",\"playerId\":%u,"
                                                    "\"x\":%.1f,\"y\":%.1f,\"angle\":%.3f,\"range\":%.0f}",
                                                    player->player_id, player->x, player->y,
                                                    atk_angle, SWORD_RANGE);
                                                websocket_server_broadcast(swing_msg);

                                            } else {
                                                // Unarmed / generic attack broadcast
                                                char attack_msg[256];
                                                snprintf(attack_msg, sizeof(attack_msg),
                                                    "{\"type\":\"player_attack\",\"player_id\":%u,"
                                                    "\"target_x\":%.2f,\"target_y\":%.2f}",
                                                    player->player_id, target_x, target_y);
                                                websocket_server_broadcast(attack_msg);
                                            }
                                        }
                                        sword_attack_done:;
                                    } else if (strcmp(action, "block") == 0) {
                                        // Walking block — reject if mounted
                                        if (player->is_mounted) {
                                            log_warn("🛡️ Player %u block rejected (mounted)", player->player_id);
                                        } else {
                                            log_info("🛡️ Player %u is blocking!", player->player_id);
                                            char block_msg[128];
                                            snprintf(block_msg, sizeof(block_msg),
                                                "{\"type\":\"player_block\",\"player_id\":%u}",
                                                player->player_id);
                                            websocket_server_broadcast(block_msg);
                                        }
                                    }
                                    
                                    if (response[0] == '\0') strcpy(response, "{\"type\":\"message_ack\",\"status\":\"action_processed\"}");
                                } else {
                                    log_warn("Action event for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strstr(payload, "\"type\":\"ship_sail_control\"")) {
                            // SHIP SAIL CONTROL message
                            // log_info("⛵ Processing SHIP_SAIL_CONTROL message");
                            
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
                            // log_info("🚢 Processing SHIP_RUDDER_CONTROL message");
                            
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
                            // log_info("🌀 Processing SHIP_SAIL_ANGLE_CONTROL message");
                            
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

                                    // Parse active_groups array e.g. [0,1]
                                    uint32_t active_groups[MAX_WEAPON_GROUPS];
                                    int active_group_count = 0;
                                    {
                                        char* ag_start = strstr(payload, "\"active_groups\":");
                                        if (ag_start) {
                                            ag_start += 16; /* skip "active_groups": */
                                            while (*ag_start && *ag_start != '[') ag_start++;
                                            if (*ag_start == '[') ag_start++;
                                            char* ag_end = strchr(ag_start, ']');
                                            char* p = ag_start;
                                            while (p && ag_end && p < ag_end &&
                                                   active_group_count < MAX_WEAPON_GROUPS) {
                                                char* num_end;
                                                long val = strtol(p, &num_end, 10);
                                                if (num_end == p) break;
                                                if (val >= 0 && val < MAX_WEAPON_GROUPS)
                                                    active_groups[active_group_count++] = (uint32_t)val;
                                                p = num_end;
                                                while (p < ag_end && (*p == ',' || *p == ' ')) p++;
                                            }
                                        }
                                    }

                                    log_info("🎯 cannon_aim: angle=%.1f° active_group_count=%d groups=[%s%s%s%s]",
                                             aim_angle * 180.0f / (float)M_PI,
                                             active_group_count,
                                             active_group_count > 0 ? (char[]){(char)('0'+active_groups[0]), 0} : "",
                                             active_group_count > 1 ? "," : "",
                                             active_group_count > 1 ? (char[]){(char)('0'+active_groups[1]), 0} : "",
                                             active_group_count > 2 ? ",..." : "");
                                    handle_cannon_aim(player, aim_angle, active_groups, active_group_count);
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
                                    // freefire: skip aim-angle check (set by client for freefire/targetfire modes)
                                    bool freefire = strstr(payload, "\"freefire\":true") != NULL;
                                    // Parse ammo_type (0=cannonball, 1=bar_shot)
                                    uint8_t ammo_type = PROJ_TYPE_CANNONBALL;
                                    char* at = strstr(payload, "\"ammo_type\":");
                                    if (at) ammo_type = (uint8_t)atoi(at + 12);
                                    if (ammo_type > PROJ_TYPE_BAR_SHOT) ammo_type = PROJ_TYPE_CANNONBALL;
                                    // Parse optional cannon_ids array
                                    uint32_t explicit_ids[MAX_CANNONS_PER_GROUP];
                                    int explicit_count = parse_json_uint32_array(
                                        payload, "cannon_ids", explicit_ids, MAX_CANNONS_PER_GROUP);
                                    
                                    handle_cannon_fire(player, fire_all, ammo_type,
                                                       explicit_count > 0 ? explicit_ids : NULL,
                                                       explicit_count,
                                                       freefire);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"cannons_fired\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                                handled = true;
                            }

                        } else if (strstr(payload, "\"type\":\"cannon_force_reload\"")) {
                            // CANNON FORCE RELOAD — discard current round, restart reload
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    handle_cannon_force_reload(player);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"force_reloaded\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"cannon_group_config\"")) {
                            // WEAPON GROUP CONFIG — set mode, cannon list, and optional target for a group
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse group_index (0–9)
                                    int group_index = -1;
                                    const char* gi = strstr(payload, "\"group_index\":");
                                    if (gi) group_index = atoi(gi + 14);

                                    // Parse mode string
                                    WeaponGroupMode mode = WEAPON_GROUP_MODE_HALTFIRE;
                                    if      (strstr(payload, "\"mode\":\"aiming\""))     mode = WEAPON_GROUP_MODE_AIMING;
                                    else if (strstr(payload, "\"mode\":\"freefire\""))   mode = WEAPON_GROUP_MODE_FREEFIRE;
                                    else if (strstr(payload, "\"mode\":\"targetfire\"")) mode = WEAPON_GROUP_MODE_TARGETFIRE;
                                    else if (strstr(payload, "\"mode\":\"haltfire\""))   mode = WEAPON_GROUP_MODE_HALTFIRE;

                                    // Parse cannon_ids array
                                    uint32_t cannon_ids[MAX_CANNONS_PER_GROUP];
                                    int cannon_count = parse_json_uint32_array(
                                        payload, "cannon_ids", cannon_ids, MAX_CANNONS_PER_GROUP);

                                    // Parse optional target_ship_id
                                    uint32_t target_ship_id = 0;
                                    const char* tsi = strstr(payload, "\"target_ship_id\":");
                                    if (tsi) target_ship_id = (uint32_t)strtoul(tsi + 17, NULL, 10);

                                    if (group_index >= 0 && group_index < MAX_WEAPON_GROUPS) {
                                        handle_cannon_group_config(player, group_index, mode,
                                                                   cannon_ids, cannon_count,
                                                                   target_ship_id);
                                        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"group_configured\"}");
                                    } else {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"invalid_group_index\"}");
                                    }
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"player_not_found\"}");
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"ping\"")) {
                            // JSON ping message
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"pong\",\"timestamp\":%u,\"server_time\":%u}",
                                    get_time_ms(), get_time_ms());
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"slot_select\"")) {
                            // INVENTORY: player changed active hotbar slot
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    int slot = 0;
                                    char* slot_ptr = strstr(payload, "\"slot\":");
                                    if (slot_ptr) sscanf(slot_ptr + 7, "%d", &slot);
                                    if (slot >= 0 && slot < INVENTORY_SLOTS)
                                        player->inventory.active_slot = (uint8_t)slot;
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"slot_selected\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"unequip\"")) {
                            // INVENTORY: player deselected active slot (Q key) — sentinel 255 = nothing equipped
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    player->inventory.active_slot = 255;
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"unequipped\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"give_item\"")) {
                            // INVENTORY: server-side item grant (used by admin/tests)
                            // {"type":"give_item","slot":0,"item":1,"quantity":10}
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    int slot = 0, item_id = 0, qty = 1;
                                    char* p_slot = strstr(payload, "\"slot\":");
                                    char* p_item = strstr(payload, "\"item\":");
                                    char* p_qty  = strstr(payload, "\"quantity\":");
                                    if (p_slot) sscanf(p_slot + 7,  "%d", &slot);
                                    if (p_item) sscanf(p_item + 7,  "%d", &item_id);
                                    if (p_qty)  sscanf(p_qty  + 11, "%d", &qty);
                                    if (slot >= 0 && slot < INVENTORY_SLOTS) {
                                        player->inventory.slots[slot].item     = (ItemKind)item_id;
                                        player->inventory.slots[slot].quantity = (uint8_t)(qty > 99 ? 99 : qty);
                                    }
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"item_given\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"place_deck\"")) {
                            // PLACE DECK: re-insert a destroyed deck on the player's ship.
                            // Consumes 1 ITEM_DECK from inventory (infinite for NPCs).
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int deck_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_DECK &&
                                            player->inventory.slots[s].quantity > 0) {
                                            deck_slot = s; break;
                                        }
                                    }
                                    if (deck_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_deck\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            bool deck_present = false;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                if (sim_ship->modules[m].id == 200) { deck_present = true; break; }
                                            }
                                            if (deck_present) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"deck_already_present\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                ShipModule new_deck = module_create(200, MODULE_TYPE_DECK, (Vec2Q16){0,0}, 0);
                                                new_deck.health = new_deck.max_health / 10; // start at 10%
                                                new_deck.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                                                sim_ship->modules[sim_ship->module_count++] = new_deck;
                                                SimpleShip* simple = find_ship(player->parent_ship_id);
                                                if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                                                    simple->modules[simple->module_count++] = new_deck;
                                                player->inventory.slots[deck_slot].quantity--;
                                                if (player->inventory.slots[deck_slot].quantity == 0)
                                                    player->inventory.slots[deck_slot].item = ITEM_NONE;
                                                log_info("🔨 Player %u placed deck on ship %u",
                                                         player->player_id, sim_ship->id);
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"deck_placed\"}");
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"place_plank\"")) {
                            // PLACE PLANK: re-insert a destroyed hull plank on the player's ship.
                            // Consumes 1 ITEM_PLANK from the player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    // Find a plank in inventory
                                    int plank_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_PLANK &&
                                            player->inventory.slots[s].quantity > 0) {
                                            plank_slot = s; break;
                                        }
                                    }
                                    if (plank_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_planks\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        // Find player's sim ship
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            // Determine which plank IDs (100-109) are present
                                            bool present[10] = {false};
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                uint16_t mid = sim_ship->modules[m].id;
                                                if (mid >= 100 && mid <= 109) present[mid - 100] = true;
                                            }
                                            // Find first missing plank
                                            int missing_idx = -1;
                                            for (int k = 0; k < 10; k++) {
                                                if (!present[k]) { missing_idx = k; break; }
                                            }
                                            if (missing_idx < 0) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_missing_planks\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                uint16_t plank_id = 100 + (uint16_t)missing_idx;
                                                static const float pp_cx[10] = {
                                                     246.25f,  246.25f,  115.0f,  -35.0f, -185.0f,
                                                    -281.25f, -281.25f, -185.0f,  -35.0f,  115.0f };
                                                static const float pp_cy[10] = {
                                                     45.0f, -45.0f, -90.0f, -90.0f, -90.0f,
                                                    -45.0f,  45.0f,  90.0f,  90.0f,  90.0f };
                                                Vec2Q16 plank_pos = {
                                                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(pp_cx[missing_idx])),
                                                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(pp_cy[missing_idx]))
                                                };
                                                ShipModule new_plank = module_create(
                                                    plank_id, MODULE_TYPE_PLANK, plank_pos, 0);
                                                // New planks start at 10% HP and heal passively
                                                new_plank.health = new_plank.max_health / 10;
                                                new_plank.state_bits |= MODULE_STATE_DAMAGED;
                                                sim_ship->modules[sim_ship->module_count++] = new_plank;
                                                // Consume 1 plank
                                                player->inventory.slots[plank_slot].quantity--;
                                                if (player->inventory.slots[plank_slot].quantity == 0)
                                                    player->inventory.slots[plank_slot].item = ITEM_NONE;
                                                log_info("🔨 Player %u placed plank %u on ship %u (%d planks remain in slot %d)",
                                                         player->player_id, plank_id, sim_ship->id,
                                                         player->inventory.slots[plank_slot].quantity, plank_slot);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"plank_placed\",\"plank_id\":%u}",
                                                    plank_id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"repair_plank\"")) {
                            // REPAIR PLANK: restore 5000 HP to the most damaged plank on the ship.
                            // Consumes 1 ITEM_REPAIR_KIT from the player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    // Find a repair kit in inventory
                                    int kit_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_REPAIR_KIT &&
                                            player->inventory.slots[s].quantity > 0) {
                                            kit_slot = s; break;
                                        }
                                    }
                                    if (kit_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_repair_kits\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            // Find most damaged plank
                                            ShipModule* worst_plank = NULL;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                ShipModule* mod = &sim_ship->modules[m];
                                                if (mod->type_id == MODULE_TYPE_PLANK &&
                                                    mod->health < mod->max_health) {
                                                    if (!worst_plank || mod->health < worst_plank->health)
                                                        worst_plank = mod;
                                                }
                                            }
                                            if (!worst_plank) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"planks_full_health\"}");
                                            } else {
                                                // Restore 5000 HP (half a plank's max) and start passive regen
                                                worst_plank->health += 5000;
                                                if (worst_plank->health > worst_plank->max_health)
                                                    worst_plank->health = worst_plank->max_health;
                                                worst_plank->state_bits |= MODULE_STATE_REPAIRING;
                                                // Consume 1 repair kit
                                                player->inventory.slots[kit_slot].quantity--;
                                                if (player->inventory.slots[kit_slot].quantity == 0)
                                                    player->inventory.slots[kit_slot].item = ITEM_NONE;
                                                log_info("🔧 Player %u repaired plank %u on ship %u to %d/%d HP",
                                                         player->player_id, worst_plank->id, sim_ship->id,
                                                         (int)worst_plank->health, (int)worst_plank->max_health);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"plank_repaired\","
                                                    "\"plank_id\":%u,\"health\":%d,\"maxHealth\":%d}",
                                                    worst_plank->id, (int)worst_plank->health, (int)worst_plank->max_health);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"use_hammer\"")) {
                            // USE HAMMER: apply 20% of target module's max_health as instant repair.
                            // Targets the specific module ID sent by the client (must be on same ship).
                            // Hammer is a reusable tool; not consumed.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else if (!global_sim) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                } else {
                                    // Parse moduleId from payload
                                    int req_module_id = -1;
                                    const char* p_mid = strstr(payload, "\"moduleId\":");
                                    if (p_mid) req_module_id = atoi(p_mid + 11);

                                    struct Ship* sim_ship = NULL;
                                    for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                        if (global_sim->ships[si].id == player->parent_ship_id) {
                                            sim_ship = &global_sim->ships[si]; break;
                                        }
                                    }
                                    if (!sim_ship) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    } else if (req_module_id < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"missing_module_id\"}");
                                    } else {
                                        ShipModule* target = NULL;
                                        for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                            if (sim_ship->modules[m].id == (uint16_t)req_module_id) {
                                                target = &sim_ship->modules[m]; break;
                                            }
                                        }
                                        if (!target || target->health <= 0) {
                                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"module_not_found\"}");
                                        } else {
                                            // Apply 20% of max_health as instant repair
                                            int32_t repair = (int32_t)(target->max_health * 20 / 100);
                                            target->health += repair;
                                            if (target->health > (int32_t)target->max_health)
                                                target->health = (int32_t)target->max_health;
                                            if (target->health >= (int32_t)target->max_health)
                                                target->state_bits &= ~MODULE_STATE_DAMAGED;
                                            // For masts: also repair 20% of fibers
                                            if (target->type_id == MODULE_TYPE_MAST) {
                                                float fh    = Q16_TO_FLOAT(target->data.mast.fiber_health);
                                                float fhmax = Q16_TO_FLOAT(target->data.mast.fiber_max_health);
                                                if (fhmax > 0.0f) {
                                                    fh += fhmax * 0.20f;
                                                    if (fh > fhmax) fh = fhmax;
                                                    target->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                                                    target->data.mast.wind_efficiency = Q16_FROM_FLOAT(fh / fhmax);
                                                }
                                            }
                                            log_info("🔨 Player %u hammer-repaired module %u (type %u) on ship %u to %d/%d HP",
                                                     player->player_id, target->id, target->type_id,
                                                     sim_ship->id, (int)target->health, (int)target->max_health);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"hammer_repair_applied\","
                                                "\"moduleId\":%u,\"health\":%d,\"maxHealth\":%d}",
                                                target->id, (int)target->health, (int)target->max_health);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"repair_sail\"")) {
                            // REPAIR SAIL FIBERS: restore openness (+50, cap 100) and wind_efficiency
                            // (+0.5, cap 1.0) on a specific mast. Consumes 1 ITEM_REPAIR_KIT.
                            // Payload: {"type":"repair_sail","shipId":N,"mastIndex":N}  (0=bow,1=mid,2=stern)
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int kit_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_REPAIR_KIT &&
                                            player->inventory.slots[s].quantity > 0) {
                                            kit_slot = s; break;
                                        }
                                    }
                                    if (kit_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_repair_kits\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        int req_idx = -1;
                                        const char* p_mi = strstr(payload, "\"mastIndex\":");
                                        if (p_mi) req_idx = atoi(p_mi + 12);

                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (req_idx < 0 || req_idx > 2) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"invalid_mast_index\"}");
                                        } else {
                                            uint16_t mast_id = simple->module_id_base + 7 + (uint16_t)req_idx;
                                            ShipModule* mast_mod = NULL;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                if (sim_ship->modules[m].id   == mast_id &&
                                                    sim_ship->modules[m].type_id == MODULE_TYPE_MAST) {
                                                    mast_mod = &sim_ship->modules[m]; break;
                                                }
                                            }
                                            if (!mast_mod) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"mast_not_present\"}");
                                            } else {
                                                float eff = Q16_TO_FLOAT(mast_mod->data.mast.wind_efficiency);
                                                if (mast_mod->data.mast.fiber_health >= mast_mod->data.mast.fiber_max_health && eff >= 1.0f) {
                                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"sail_intact\"}");
                                                } else {
                                                    // Restore 500 fiber HP per repair kit use
                                                    float fh    = Q16_TO_FLOAT(mast_mod->data.mast.fiber_health);
                                                    float fhmax = Q16_TO_FLOAT(mast_mod->data.mast.fiber_max_health);
                                                    if (fhmax <= 0.0f) fhmax = 15000.0f;
                                                    fh += 500.0f;
                                                    if (fh > fhmax) fh = fhmax;
                                                    mast_mod->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                                                    eff = fh / fhmax;
                                                    mast_mod->data.mast.wind_efficiency = Q16_FROM_FLOAT(eff);
                                                    // Mirror into SimpleShip so rigger NPC sees it too
                                                    ShipModule* sm = find_module_by_id(simple, mast_id);
                                                    if (sm) {
                                                        sm->data.mast.fiber_health    = mast_mod->data.mast.fiber_health;
                                                        sm->data.mast.wind_efficiency = mast_mod->data.mast.wind_efficiency;
                                                    }
                                                    player->inventory.slots[kit_slot].quantity--;
                                                    if (player->inventory.slots[kit_slot].quantity == 0)
                                                        player->inventory.slots[kit_slot].item = ITEM_NONE;
                                                    log_info("🧵 Player %u repaired sail fibers mast %u on ship %u (fiber HP %.0f/%.0f, eff %.2f)",
                                                             player->player_id, mast_id, sim_ship->id, fh, fhmax, eff);
                                                    snprintf(response, sizeof(response),
                                                        "{\"type\":\"message_ack\",\"status\":\"sail_repaired\","
                                                        "\"mastId\":%u,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f,\"windEfficiency\":%.3f}",
                                                        mast_id, fh, fhmax, eff);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"place_cannon_at\"")) {
                            // FREE-PLACE CANNON: place a cannon at an arbitrary ship-local position.
                            // Payload: {"type":"place_cannon_at","shipId":N,"localX":F,"localY":F,"rotation":F}
                            // Consumes 1 ITEM_CANNON from the placing player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    // Locate cannon in inventory
                                    int cannon_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_CANNON &&
                                            player->inventory.slots[s].quantity > 0) {
                                            cannon_slot = s; break;
                                        }
                                    }
                                    if (cannon_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_cannon\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        // Find the sim ship (use shipId from payload, fallback to player ship)
                                        uint32_t target_ship_id = player->parent_ship_id;
                                        const char* p_sid = strstr(payload, "\"shipId\":");
                                        if (p_sid) { uint32_t sid = 0; sscanf(p_sid + 9, "%u", &sid); if (sid) target_ship_id = sid; }

                                        SimpleShip* simple = find_ship(target_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == target_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP ||
                                                   simple->module_count >= MAX_MODULES_PER_SHIP) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                        } else {
                                            // Parse local position and rotation (client px → server units)
                                            float local_x = 0.0f, local_y = 0.0f, rotation = 0.0f;
                                            const char* px = strstr(payload, "\"localX\":");
                                            const char* py = strstr(payload, "\"localY\":");
                                            const char* pr = strstr(payload, "\"rotation\":");
                                            if (px) sscanf(px + 9,  "%f", &local_x);
                                            if (py) sscanf(py + 9,  "%f", &local_y);
                                            if (pr) sscanf(pr + 11, "%f", &rotation);

                                            // Allocate a unique module ID (scan max existing + 1 across both arrays)
                                            uint16_t max_id = 0;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++)
                                                if (sim_ship->modules[m].id > max_id) max_id = sim_ship->modules[m].id;
                                            for (uint8_t m = 0; m < simple->module_count; m++)
                                                if (simple->modules[m].id > max_id) max_id = simple->modules[m].id;
                                            uint16_t new_id = max_id + 1;

                                            // Build the module record once, copy into both arrays
                                            ShipModule nc;
                                            memset(&nc, 0, sizeof(ShipModule));
                                            nc.id          = new_id;
                                            nc.type_id     = MODULE_TYPE_CANNON;
                                            nc.local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x));
                                            nc.local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y));
                                            nc.local_rot   = Q16_FROM_FLOAT(rotation);
                                            nc.state_bits  = MODULE_STATE_ACTIVE;
                                            nc.health      = 8000;
                                            nc.max_health  = 8000;
                                            nc.data.cannon.aim_direction   = Q16_FROM_FLOAT(0.0f);
                                            nc.data.cannon.ammunition      = 10;
                                            nc.data.cannon.reload_time     = CANNON_RELOAD_TIME_MS;
                                            nc.data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS; // start ready to fire

                                            // Add to physics simulation
                                            sim_ship->modules[sim_ship->module_count++] = nc;
                                            // Add to SimpleShip (network broadcast + NPC visibility)
                                            simple->modules[simple->module_count++] = nc;

                                            // Consume 1 cannon from inventory
                                            player->inventory.slots[cannon_slot].quantity--;
                                            if (player->inventory.slots[cannon_slot].quantity == 0)
                                                player->inventory.slots[cannon_slot].item = ITEM_NONE;

                                            // Trigger NPC cannon sector re-dispatch so on-duty gunners
                                            // can immediately adopt the newly placed cannon if it is
                                            // closer to the current aim angle than their current post.
                                            update_npc_cannon_sector(simple, simple->active_aim_angle);

                                            log_info("🔨 Player %u placed cannon %u at (%.1f,%.1f) rot=%.2f on ship %u",
                                                     player->player_id, new_id, local_x, local_y, rotation, sim_ship->id);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"cannon_placed_at\",\"cannon_id\":%u}",
                                                new_id);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"place_mast_at\"")) {
                            // FREE-PLACE MAST: place a mast at an arbitrary ship-local position.
                            // Payload: {"type":"place_mast_at","shipId":N,"localX":F,"localY":F}
                            // Consumes 1 ITEM_SAIL from the placing player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int sail_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_SAIL &&
                                            player->inventory.slots[s].quantity > 0) {
                                            sail_slot = s; break;
                                        }
                                    }
                                    if (sail_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_sail\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        uint32_t target_ship_id = player->parent_ship_id;
                                        const char* p_sid = strstr(payload, "\"shipId\":");
                                        if (p_sid) { uint32_t sid = 0; sscanf(p_sid + 9, "%u", &sid); if (sid) target_ship_id = sid; }

                                        SimpleShip* simple_mast = find_ship(target_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == target_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple_mast) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP ||
                                                   simple_mast->module_count >= MAX_MODULES_PER_SHIP) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                        } else {
                                            float local_x = 0.0f, local_y = 0.0f;
                                            const char* px = strstr(payload, "\"localX\":");
                                            const char* py = strstr(payload, "\"localY\":");
                                            if (px) sscanf(px + 9, "%f", &local_x);
                                            if (py) sscanf(py + 9, "%f", &local_y);

                                            uint16_t max_id = 0;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++)
                                                if (sim_ship->modules[m].id > max_id) max_id = sim_ship->modules[m].id;
                                            for (uint8_t m = 0; m < simple_mast->module_count; m++)
                                                if (simple_mast->modules[m].id > max_id) max_id = simple_mast->modules[m].id;
                                            uint16_t new_id = max_id + 1;

                                            ShipModule nm;
                                            memset(&nm, 0, sizeof(ShipModule));
                                            nm.id          = new_id;
                                            nm.type_id     = MODULE_TYPE_MAST;
                                            nm.local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x));
                                            nm.local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y));
                                            nm.local_rot   = Q16_FROM_FLOAT(0.0f);
                                            nm.state_bits  = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
                                            nm.health      = 15000;
                                            nm.max_health  = 15000;
                                            nm.data.mast.angle             = Q16_FROM_FLOAT(0.0f);
                                            nm.data.mast.openness          = 0;
                                            nm.data.mast.fiber_health      = Q16_FROM_FLOAT(15000.0f);
                                            nm.data.mast.fiber_max_health  = Q16_FROM_FLOAT(15000.0f);
                                            nm.data.mast.wind_efficiency   = Q16_FROM_FLOAT(1.0f);

                                            // Add to physics simulation and to SimpleShip (NPC + network)
                                            sim_ship->modules[sim_ship->module_count++] = nm;
                                            simple_mast->modules[simple_mast->module_count++] = nm;

                                            player->inventory.slots[sail_slot].quantity--;
                                            if (player->inventory.slots[sail_slot].quantity == 0)
                                                player->inventory.slots[sail_slot].item = ITEM_NONE;

                                            log_info("⛵ Player %u placed mast %u at (%.1f,%.1f) on ship %u",
                                                     player->player_id, new_id, local_x, local_y, sim_ship->id);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"mast_placed_at\",\"mast_id\":%u}",
                                                new_id);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"place_cannon\"")) {
                            // PLACE CANNON: re-install a destroyed cannon on the player's ship.
                            // Consumes 1 ITEM_CANNON. Server finds the first missing cannon slot
                            // (IDs base+1..base+6) and recreates it at the correct position.
                            // Layout: cannon_xs[3]={-35,65,-135}; port y=+75 rot=PI, stbd y=-75 rot=0
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int cannon_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_CANNON &&
                                            player->inventory.slots[s].quantity > 0) {
                                            cannon_slot = s; break;
                                        }
                                    }
                                    if (cannon_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_cannon\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint16_t base = simple->module_id_base;
                                            bool present[6] = {false};
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                uint16_t mid = sim_ship->modules[m].id;
                                                if (mid >= base + 1 && mid <= base + 6)
                                                    present[mid - base - 1] = true;
                                            }
                                            int missing_idx = -1;
                                            for (int k = 0; k < 6; k++) {
                                                if (!present[k]) { missing_idx = k; break; }
                                            }
                                            if (missing_idx < 0) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_missing_cannons\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                static const float cannon_xs[3] = { -35.0f, 65.0f, -135.0f };
                                                int i = missing_idx;
                                                float cx  = cannon_xs[i % 3];
                                                float cy  = (i < 3) ? 75.0f : -75.0f;
                                                float rot = (i < 3) ? (float)M_PI : 0.0f;
                                                uint16_t cannon_id = base + 1 + (uint16_t)i;
                                                ShipModule* nc = &sim_ship->modules[sim_ship->module_count];
                                                memset(nc, 0, sizeof(ShipModule));
                                                nc->id          = cannon_id;
                                                nc->type_id     = MODULE_TYPE_CANNON;
                                                nc->local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cx));
                                                nc->local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cy));
                                                nc->local_rot   = Q16_FROM_FLOAT(rot);
                                                nc->state_bits  = MODULE_STATE_ACTIVE;
                                                nc->health      = 8000;
                                                nc->max_health  = 8000;
                                                nc->data.cannon.aim_direction   = Q16_FROM_FLOAT(0.0f);
                                                nc->data.cannon.ammunition      = 10;
                                                nc->data.cannon.reload_time     = CANNON_RELOAD_TIME_MS;
                                                nc->data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS; // start ready to fire
                                                sim_ship->module_count++;
                                                player->inventory.slots[cannon_slot].quantity--;
                                                if (player->inventory.slots[cannon_slot].quantity == 0)
                                                    player->inventory.slots[cannon_slot].item = ITEM_NONE;
                                                log_info("🔧 Player %u placed cannon %u on ship %u",
                                                         player->player_id, cannon_id, sim_ship->id);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"cannon_placed\",\"cannon_id\":%u}",
                                                    cannon_id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"place_mast\"")) {
                            // PLACE MAST: re-install a destroyed mast on the player's ship.
                            // Consumes 1 ITEM_SAIL. First missing mast slot (IDs base+7..base+9).
                            // Layout: mast_xs[3]={165,-35,-235}, y=0, rot=0.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int sail_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_SAIL &&
                                            player->inventory.slots[s].quantity > 0) {
                                            sail_slot = s; break;
                                        }
                                    }
                                    if (sail_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_sail\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint16_t base = simple->module_id_base;
                                            // Masts: base+7, base+8, base+9
                                            bool present[3] = {false};
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                uint16_t mid = sim_ship->modules[m].id;
                                                if (mid >= base + 7 && mid <= base + 9)
                                                    present[mid - base - 7] = true;
                                            }
                                            // Use the specific mast index sent by the client.
                                            // Fall back to the first missing slot if client doesn't send it.
                                            int requested_idx = -1;
                                            const char* p_mi = strstr(payload, "\"mastIndex\":");
                                            if (p_mi) requested_idx = atoi(p_mi + 12);

                                            int target_idx = -1;
                                            if (requested_idx >= 0 && requested_idx < 3 && !present[requested_idx]) {
                                                // Client specified a valid missing slot — use it directly
                                                target_idx = requested_idx;
                                            } else {
                                                // Fallback: first missing
                                                for (int k = 0; k < 3; k++) {
                                                    if (!present[k]) { target_idx = k; break; }
                                                }
                                            }
                                            int missing_idx = target_idx;
                                            if (missing_idx < 0) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_missing_masts\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                static const float mast_xs[3] = { 165.0f, -35.0f, -235.0f };
                                                uint16_t mast_id = base + 7 + (uint16_t)missing_idx;
                                                ShipModule* nm = &sim_ship->modules[sim_ship->module_count];
                                                memset(nm, 0, sizeof(ShipModule));
                                                nm->id          = mast_id;
                                                nm->type_id     = MODULE_TYPE_MAST;
                                                nm->local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(mast_xs[missing_idx]));
                                                nm->local_pos.y = Q16_FROM_FLOAT(0.0f);
                                                nm->local_rot   = Q16_FROM_FLOAT(0.0f);
                                                nm->state_bits  = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
                                                nm->health      = 15000;
                                                nm->max_health  = 15000;
                                                nm->data.mast.angle           = Q16_FROM_FLOAT(0.0f);
                                                nm->data.mast.openness        = 0;
                                                nm->data.mast.fiber_health     = Q16_FROM_FLOAT(15000.0f);
                                                nm->data.mast.fiber_max_health = Q16_FROM_FLOAT(15000.0f);
                                                nm->data.mast.wind_efficiency = Q16_FROM_FLOAT(1.0f);
                                                sim_ship->module_count++;
                                                // Mirror into SimpleShip so find_module_on_ship()
                                                // (used by NPC riggers) can see the new mast.
                                                if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                                                    simple->modules[simple->module_count++] = *nm;
                                                player->inventory.slots[sail_slot].quantity--;
                                                if (player->inventory.slots[sail_slot].quantity == 0)
                                                    player->inventory.slots[sail_slot].item = ITEM_NONE;
                                                log_info("⛵ Player %u placed mast %u on ship %u",
                                                         player->player_id, mast_id, sim_ship->id);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"mast_placed\",\"mast_id\":%u}",
                                                    mast_id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"replace_helm\"")) {
                            // REPLACE HELM: re-install the helm if destroyed.
                            // Consumes 1 ITEM_HELM. Helm ID = base+0, pos (-90, 0).
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int helm_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_HELM &&
                                            player->inventory.slots[s].quantity > 0) {
                                            helm_slot = s; break;
                                        }
                                    }
                                    if (helm_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_helm_item\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint16_t base = simple->module_id_base;
                                            // Check if helm already present
                                            bool helm_present = false;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                if (sim_ship->modules[m].type_id == MODULE_TYPE_HELM) {
                                                    helm_present = true; break;
                                                }
                                            }
                                            if (helm_present) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"helm_intact\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                ShipModule* nh = &sim_ship->modules[sim_ship->module_count];
                                                memset(nh, 0, sizeof(ShipModule));
                                                nh->id          = base;   // base+0
                                                nh->type_id     = MODULE_TYPE_HELM;
                                                nh->local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f));
                                                nh->local_pos.y = Q16_FROM_FLOAT(0.0f);
                                                nh->local_rot   = Q16_FROM_FLOAT(0.0f);
                                                nh->state_bits  = MODULE_STATE_ACTIVE;
                                                nh->health      = Q16_FROM_FLOAT(10000.0f);
                                                nh->max_health  = Q16_FROM_FLOAT(10000.0f);
                                                nh->data.helm.occupied_by    = 0;
                                                nh->data.helm.wheel_rotation = Q16_FROM_FLOAT(0.0f);
                                                sim_ship->module_count++;
                                                // Mirror into SimpleShip so find_module_on_ship()
                                                // (used by NPC helmsmen) can see the new helm.
                                                if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                                                    simple->modules[simple->module_count++] = *nh;
                                                player->inventory.slots[helm_slot].quantity--;
                                                if (player->inventory.slots[helm_slot].quantity == 0)
                                                    player->inventory.slots[helm_slot].item = ITEM_NONE;
                                                log_info("🔧 Player %u replaced helm %u on ship %u",
                                                         player->player_id, base, sim_ship->id);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"helm_placed\",\"helm_id\":%u}",
                                                    base);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"crew_assign\"")) {
                            // CREW ASSIGN: player sets a WorldNpc's manning task.
                            // {"type":"crew_assign","ship_id":N,"npc_id":N,"task":"Sails|Cannons|Repairs|Combat|Idle"}
                            uint32_t ca_ship = 0, ca_npc = 0;
                            char ca_task[16] = "Idle";
                            char* p;
                            p = strstr(payload, "\"ship_id\":"); if (p) sscanf(p + 10, "%u", &ca_ship);
                            p = strstr(payload, "\"npc_id\":");  if (p) sscanf(p +  9, "%u", &ca_npc);
                            p = strstr(payload, "\"task\":\"");
                            if (p) sscanf(p + 8, "%15[^\"]s", ca_task);
                            if (ca_ship != 0 && ca_npc != 0)
                                handle_crew_assign(ca_ship, ca_npc, ca_task);
                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"crew_assigned\"}");
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"upgrade_ship\"")) {
                            // UPGRADE SHIP: spend XP to advance one attribute on the player's ship.
                            // {"type":"upgrade_ship","shipId":N,"attribute":"resistance"}
                            uint32_t upg_ship_id = 0;
                            char upg_attr[32] = "";
                            char* p2;
                            p2 = strstr(payload, "\"shipId\":");    if (p2) sscanf(p2 +  9, "%u",  &upg_ship_id);
                            p2 = strstr(payload, "\"attribute\":\""); if (p2) sscanf(p2 + 13, "%31[^\"]s", upg_attr);

                            if (!global_sim || upg_ship_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                            } else {
                                struct Ship* upg_sim_ship = sim_get_ship(global_sim, (entity_id)upg_ship_id);
                                if (!upg_sim_ship) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                } else {
                                    ShipAttribute attr = ship_attr_from_name(upg_attr);
                                    if (attr == SHIP_ATTR_COUNT) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"unknown_attribute\"}");
                                    } else {
                                        uint8_t old_level = upg_sim_ship->level_stats.levels[attr];
                                        uint32_t cost     = ship_level_xp_cost(&upg_sim_ship->level_stats, attr);
                                        uint16_t total_pts_before = ship_level_total_points(&upg_sim_ship->level_stats);
                                        bool ok = ship_level_upgrade(&upg_sim_ship->level_stats, attr);
                                        if (!ok) {
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"error\",\"message\":\"upgrade_failed\","
                                                "\"xp\":%u,\"cost\":%u,\"level\":%u,"
                                                "\"attrCap\":%u,\"shipLevel\":%u,\"totalCap\":%u}",
                                                upg_sim_ship->level_stats.xp, cost, old_level,
                                                ship_attr_point_cap(attr),
                                                total_pts_before,
                                                SHIP_LEVEL_TOTAL_POINT_CAP);
                                        } else {
                                            uint8_t new_level = upg_sim_ship->level_stats.levels[attr];
                                            uint16_t ship_lvl = ship_level_total_points(&upg_sim_ship->level_stats);
                                            uint32_t next_cost = (ship_lvl < SHIP_LEVEL_TOTAL_POINT_CAP)
                                                ? SHIP_LEVEL_XP_BASE * (uint32_t)(ship_lvl + 1) : 0u;
                                            log_info("⬆️  Ship %u upgraded %s: L%u → L%u (XP remaining: %u, ship level: %u/%u, next cost: %u)",
                                                     upg_ship_id, upg_attr, old_level, new_level,
                                                     upg_sim_ship->level_stats.xp, ship_lvl,
                                                     SHIP_LEVEL_TOTAL_POINT_CAP, next_cost);
                                            /* Broadcast SHIP_LEVEL_UP to all clients */
                                            char lvl_msg[320];
                                            snprintf(lvl_msg, sizeof(lvl_msg),
                                                "{\"type\":\"SHIP_LEVEL_UP\",\"shipId\":%u,"
                                                "\"attribute\":\"%s\",\"level\":%u,\"xp\":%u,"
                                                "\"shipLevel\":%u,\"totalCap\":%u,\"nextUpgradeCost\":%u}",
                                                upg_ship_id, upg_attr, new_level,
                                                upg_sim_ship->level_stats.xp,
                                                ship_lvl, SHIP_LEVEL_TOTAL_POINT_CAP, next_cost);
                                            uint8_t lvl_frame[512];
                                            size_t lvl_flen = websocket_create_frame(WS_OPCODE_TEXT,
                                                lvl_msg, strlen(lvl_msg), (char*)lvl_frame, sizeof(lvl_frame));
                                            if (lvl_flen > 0) {
                                                for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                                                    struct WebSocketClient* wc = &ws_server.clients[ci];
                                                    if (wc->connected && wc->handshake_complete)
                                                        send(wc->fd, lvl_frame, lvl_flen, 0);
                                                }
                                            }
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"upgraded\","
                                                "\"attribute\":\"%s\",\"level\":%u,\"xp\":%u,"
                                                "\"shipLevel\":%u,\"totalCap\":%u,\"nextUpgradeCost\":%u}",
                                                upg_attr, new_level,
                                                upg_sim_ship->level_stats.xp,
                                                ship_lvl, SHIP_LEVEL_TOTAL_POINT_CAP, next_cost);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strstr(payload, "\"type\":\"upgrade_crew_stat\"")) {
                            // UPGRADE CREW STAT: spend an earned stat point to level one stat.
                            // {"type":"upgrade_crew_stat","npcId":N,"stat":"health"}
                            // Stats: health | damage | stamina | weight
                            // Cost: 1 stat point (earned per global level-up, no XP deducted).
                            // Stat points available = (npc_level - 1) - total_stats_spent.
                            // No per-stat cap — all 65 points can go into any one stat.
                            uint32_t uc_npc_id = 0;
                            char uc_stat[32] = "";
                            char* p3;
                            p3 = strstr(payload, "\"npcId\":");  if (p3) sscanf(p3 + 8, "%u", &uc_npc_id);
                            p3 = strstr(payload, "\"stat\":\""); if (p3) sscanf(p3 + 8, "%31[^\"]", uc_stat);

                            WorldNpc* uc_npc = NULL;
                            for (int ni = 0; ni < world_npc_count; ni++) {
                                if (world_npcs[ni].active && world_npcs[ni].id == uc_npc_id) {
                                    uc_npc = &world_npcs[ni]; break;
                                }
                            }
                            if (!uc_npc) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"npc_not_found\"}");
                            } else {
                                uint8_t* stat_ptr = NULL;
                                if      (strcmp(uc_stat, "health")  == 0) stat_ptr = &uc_npc->stat_health;
                                else if (strcmp(uc_stat, "damage")  == 0) stat_ptr = &uc_npc->stat_damage;
                                else if (strcmp(uc_stat, "stamina") == 0) stat_ptr = &uc_npc->stat_stamina;
                                else if (strcmp(uc_stat, "weight")  == 0) stat_ptr = &uc_npc->stat_weight;

                                if (!stat_ptr) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"unknown_stat\"}");
                                } else {
                                    /* Stat points available = levels earned - points already spent */
                                    uint8_t total_spent = (uint8_t)(
                                        uc_npc->stat_health + uc_npc->stat_damage +
                                        uc_npc->stat_stamina + uc_npc->stat_weight);
                                    uint8_t points_earned = (uint8_t)(uc_npc->npc_level - 1);
                                    if (total_spent >= points_earned) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"error\",\"message\":\"no_stat_points\","
                                            "\"npcLevel\":%u,\"pointsEarned\":%u,\"pointsSpent\":%u}",
                                            uc_npc->npc_level, points_earned, total_spent);
                                    } else {
                                        (*stat_ptr)++;
                                        /* Recalculate derived stats */
                                        uint16_t new_max = (uint16_t)(100 + uc_npc->stat_health * 20);
                                        if (new_max > uc_npc->max_health)
                                            uc_npc->health += (new_max - uc_npc->max_health);
                                        uc_npc->max_health = new_max;
                                        uint8_t stat_points_left = (uint8_t)(points_earned - (total_spent + 1));
                                        log_info("👤 NPC %u '%s' upgraded %s → %u (level %u, %u stat points left)",
                                                 uc_npc->id, uc_npc->name, uc_stat, *stat_ptr,
                                                 uc_npc->npc_level, stat_points_left);
                                        /* Broadcast NPC_STAT_UP */
                                        char su_msg[256];
                                        snprintf(su_msg, sizeof(su_msg),
                                            "{\"type\":\"NPC_STAT_UP\",\"npcId\":%u,\"stat\":\"%s\","
                                            "\"level\":%u,\"xp\":%u,\"maxHealth\":%u,\"npcLevel\":%u,"
                                            "\"statHealth\":%u,\"statDamage\":%u,\"statStamina\":%u,\"statWeight\":%u,"
                                            "\"statPoints\":%u}",
                                            uc_npc->id, uc_stat, *stat_ptr, uc_npc->xp,
                                            uc_npc->max_health, uc_npc->npc_level,
                                            uc_npc->stat_health, uc_npc->stat_damage,
                                            uc_npc->stat_stamina, uc_npc->stat_weight,
                                            stat_points_left);
                                        uint8_t su_frame[512];
                                        size_t su_flen = websocket_create_frame(WS_OPCODE_TEXT,
                                            su_msg, strlen(su_msg), (char*)su_frame, sizeof(su_frame));
                                        if (su_flen > 0) {
                                            for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                                                struct WebSocketClient* wc = &ws_server.clients[ci];
                                                if (wc->connected && wc->handshake_complete)
                                                    send(wc->fd, su_frame, su_flen, 0);
                                            }
                                        }
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"message_ack\",\"status\":\"stat_upgraded\","
                                            "\"stat\":\"%s\",\"level\":%u,\"statPoints\":%u}",
                                            uc_stat, *stat_ptr, stat_points_left);
                                    }
                                }
                            }
                            handled = true;

                        } else {
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
                    
                    /* ── Flush deferred cannon-group broadcast ────────────────────────────
                     * handle_cannon_group_config sets pending_group_broadcast_ship_id
                     * instead of broadcasting immediately, so that two rapid group-config
                     * messages in the same recv cycle (e.g. switching two groups to AIMING
                     * at once) collapse into a single broadcast sent here — after the
                     * response ACK is queued — containing the fully-updated state.
                     * ──────────────────────────────────────────────────────────────────── */
                    if (client->pending_group_broadcast_ship_id != 0) {
                        SimpleShip* bship = find_ship(client->pending_group_broadcast_ship_id);
                        if (bship) broadcast_cannon_group_state(bship);
                        client->pending_group_broadcast_ship_id = 0;
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
                        (void)send(client->fd, frame, frame_len, 0);
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
        // Each brigantine ship entry: ~2400 bytes (22 modules + levelStats).
        // MAX_SIMPLE_SHIPS=50 → worst case ~120000 bytes. Use static to avoid stack overflow.
        static char ships_json[64000];
        int ships_offset = 0;
        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "[");
        bool first_ship = true;
        
        // levelStats dirty tracking: only serialize when XP or total_points actually changes.
        // Indexed by sim->ships[] loop position (stable across a single tick build).
        static uint32_t last_levelstats_xp[MAX_SHIPS];
        static uint32_t last_levelstats_tp[MAX_SHIPS];  // total_points
        static bool levelstats_initialized = false;
        if (!levelstats_initialized) {
            memset(last_levelstats_xp, 0xFF, sizeof(last_levelstats_xp));
            memset(last_levelstats_tp, 0xFF, sizeof(last_levelstats_tp));
            levelstats_initialized = true;
        }
        
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

                // Look up matching SimpleShip for ammo data
                const SimpleShip* simple_ship = NULL;
                for (int ss = 0; ss < ship_count; ss++) {
                    if (ships[ss].ship_id == ship->id) { simple_ship = &ships[ss]; break; }
                }

                char ship_entry[6144];
                float hull_health_pct = Q16_TO_FLOAT(ship->hull_health); // 0.0–100.0
                int offset = snprintf(ship_entry, sizeof(ship_entry),
                        "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                        "\"rudder_angle\":%.3f,"
                        "\"hullHealth\":%.2f,\"company\":%u,"
                        "\"ammo\":%u,\"infiniteAmmo\":%s,\"modules\":[",
                        ship->id, pos_x, pos_y, rotation, vel_x, vel_y, ang_vel,
                        rudder_radians,
                        hull_health_pct,
                        simple_ship ? simple_ship->company_id : COMPANY_NEUTRAL,
                        simple_ship ? simple_ship->cannon_ammo : 0,
                        (simple_ship && simple_ship->infinite_ammo) ? "true" : "false");
                
                // Add modules array
                // Planks (100-109) and deck (200): only send health/ID, client generates positions
                // Gameplay modules (1000+): send full transform
                for (uint8_t m = 0; m < ship->module_count && offset < (int)sizeof(ship_entry) - 200; m++) {
                    const ShipModule* module = &ship->modules[m];
                    
                    if (module->type_id == MODULE_TYPE_PLANK) {
                        // Plank: only health data (client has hard-coded positions from hull)
                        offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                            "%s{\"id\":%u,\"typeId\":%u,\"health\":%d,\"maxHealth\":%d}",
                            m > 0 ? "," : "", module->id, module->type_id,
                            (int)module->health, (int)module->max_health);
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
                            // Mast: include openness, sail angle, wind efficiency, fiber HP, and health
                            float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                            float wind_eff   = Q16_TO_FLOAT(module->data.mast.wind_efficiency);
                            float fh         = Q16_TO_FLOAT(module->data.mast.fiber_health);
                            float fhmax      = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f,\"windEfficiency\":%.3f,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f,\"health\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.mast.openness, sail_angle, wind_eff,
                                fh, fhmax, (int)module->health, (int)module->max_health);
                        } else if (module->type_id == MODULE_TYPE_CANNON) {
                            // Cannon: include aim direction, state, and health
                            float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u,\"health\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, aim_direction,
                                (unsigned)module->state_bits,
                                (int)module->health, (int)module->max_health);
                        } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                            // Helm: include wheel rotation, occupied status, state, and health
                            float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s,\"state\":%u,\"health\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, wheel_rot,
                                (module->data.helm.occupied_by != 0) ? "true" : "false",
                                (unsigned)module->state_bits,
                                (int)module->health, (int)module->max_health);
                        } else {
                            // Generic module (ladder, etc.): transform + state + health
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"state\":%u,\"health\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, (unsigned)module->state_bits,
                                (int)module->health, (int)module->max_health);
                        }
                    }
                }
                
                uint32_t cur_xp = ship->level_stats.xp;
                uint32_t cur_tp = (uint32_t)ship_level_total_points(&ship->level_stats);
                bool lvl_dirty = (s >= MAX_SHIPS) ||
                                 (cur_xp != last_levelstats_xp[s]) ||
                                 (cur_tp != last_levelstats_tp[s]);

                if (lvl_dirty) {
                    if (s < MAX_SHIPS) {
                        last_levelstats_xp[s] = cur_xp;
                        last_levelstats_tp[s] = cur_tp;
                    }
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                        "],\"levelStats\":{"
                        "\"weight\":%u,\"resistance\":%u,\"damage\":%u,\"crew\":%u,\"sturdiness\":%u,"
                        "\"xp\":%u,\"maxCrew\":%u,"
                        "\"shipLevel\":%u,\"totalPoints\":%u,\"totalCap\":%u,"
                        "\"nextUpgradeCost\":%u,"
                        "\"attrCaps\":{\"weight\":%u,\"resistance\":%u,\"damage\":%u,\"crew\":%u,\"sturdiness\":%u}"
                        "}}",
                        ship->level_stats.levels[SHIP_ATTR_WEIGHT],
                        ship->level_stats.levels[SHIP_ATTR_RESISTANCE],
                        ship->level_stats.levels[SHIP_ATTR_DAMAGE],
                        ship->level_stats.levels[SHIP_ATTR_CREW],
                        ship->level_stats.levels[SHIP_ATTR_STURDINESS],
                        cur_xp,
                        (unsigned)ship_level_max_crew(&ship->level_stats),
                        cur_tp, cur_tp,
                        SHIP_LEVEL_TOTAL_POINT_CAP,
                        cur_tp < SHIP_LEVEL_TOTAL_POINT_CAP
                            ? SHIP_LEVEL_XP_BASE * (cur_tp + 1u)
                            : 0u,
                        ship_attr_point_cap(SHIP_ATTR_WEIGHT),
                        ship_attr_point_cap(SHIP_ATTR_RESISTANCE),
                        ship_attr_point_cap(SHIP_ATTR_DAMAGE),
                        ship_attr_point_cap(SHIP_ATTR_CREW),
                        ship_attr_point_cap(SHIP_ATTR_STURDINESS));
                } else {
                    // levelStats unchanged — close the modules array and ship object
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset, "]}");
                }
                {
                    int n = snprintf(ships_json + ships_offset, sizeof(ships_json) - (size_t)(ships_offset < (int)sizeof(ships_json) ? ships_offset : (int)sizeof(ships_json)-1), "%s", ship_entry);
                    if (n > 0) ships_offset += n;
                    if (ships_offset >= (int)sizeof(ships_json) - 1) ships_offset = (int)sizeof(ships_json) - 1;
                }
                first_ship = false;
            }
        } else {
            // Fallback to simple ships array (backward compatibility)
            for (int s = 0; s < ship_count; s++) {
                if (ships[s].active) {
                    if (!first_ship) {
                        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, ",");
                        if (ships_offset >= (int)sizeof(ships_json) - 1) ships_offset = (int)sizeof(ships_json) - 1;
                    }
                    
                    // Build ship entry with modules
                    char ship_entry[6144];
                    int offset = snprintf(ship_entry, sizeof(ship_entry),
                            "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                            "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                            "\"rudder_angle\":%.3f,"
                            "\"ammo\":%u,\"infiniteAmmo\":%s,\"modules\":[",
                            ships[s].ship_id, ships[s].x, ships[s].y, ships[s].rotation,
                            ships[s].velocity_x, ships[s].velocity_y, ships[s].angular_velocity,
                            0.0f,
                            ships[s].cannon_ammo, ships[s].infinite_ammo ? "true" : "false");
                    
                    // Add modules from simple ships
                    for (int m = 0; m < ships[s].module_count && offset < (int)sizeof(ship_entry) - 200; m++) {
                        const ShipModule* module = &ships[s].modules[m];
                        float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                        float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                        float module_rot = Q16_TO_FLOAT(module->local_rot);
                        
                        // Add module-specific data based on type
                        if (module->type_id == MODULE_TYPE_MAST) {
                            // Mast: include openness, sail angle, wind efficiency, fiber HP
                            float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                            float wind_eff   = Q16_TO_FLOAT(module->data.mast.wind_efficiency);
                            float fh         = Q16_TO_FLOAT(module->data.mast.fiber_health);
                            float fhmax      = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f,\"windEfficiency\":%.3f,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.mast.openness, sail_angle, wind_eff,
                                fh, fhmax);
                        } else if (module->type_id == MODULE_TYPE_CANNON) {
                            // Cannon: include aim direction, state (ammo is ship-level)
                            float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, aim_direction,
                                (unsigned)module->state_bits);
                        } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                            // Helm: include wheel rotation, occupied status, state
                            float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, wheel_rot,
                                (module->data.helm.occupied_by != 0) ? "true" : "false",
                                (unsigned)module->state_bits);
                        } else {
                            // Generic module (mast, ladder, etc.): transform + state
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, (unsigned)module->state_bits);
                        }
                    }
                    
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset, "]}");
                    {
                        int n2 = snprintf(ships_json + ships_offset, sizeof(ships_json) - (size_t)(ships_offset < (int)sizeof(ships_json) ? ships_offset : (int)sizeof(ships_json)-1), "%s", ship_entry);
                        if (n2 > 0) ships_offset += n2;
                        if (ships_offset >= (int)sizeof(ships_json) - 1) ships_offset = (int)sizeof(ships_json) - 1;
                    }
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

                // Build inventory JSON
                char inv_buf[220];
                int inv_off = 0;
                inv_off += snprintf(inv_buf + inv_off, sizeof(inv_buf) - inv_off,
                                    ",\"inventory\":{\"slots\":[");
                for (int s = 0; s < INVENTORY_SLOTS; s++) {
                    if (s > 0 && inv_off < (int)sizeof(inv_buf) - 1)
                        inv_buf[inv_off++] = ',';
                    inv_off += snprintf(inv_buf + inv_off, sizeof(inv_buf) - inv_off,
                                        "[%d,%d]",
                                        (int)players[p].inventory.slots[s].item,
                                        (int)players[p].inventory.slots[s].quantity);
                }
                inv_off += snprintf(inv_buf + inv_off, sizeof(inv_buf) - inv_off,
                                    "],\"armor\":%d,\"shield\":%d,\"activeSlot\":%d}",
                                    (int)players[p].inventory.armor,
                                    (int)players[p].inventory.shield,
                                    (int)players[p].inventory.active_slot);

                char player_entry[640];
                snprintf(player_entry, sizeof(player_entry),
                        "{\"id\":%u,\"name\":\"Player_%u\",\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"is_moving\":%s,"
                        "\"movement_direction_x\":%.2f,\"movement_direction_y\":%.2f,"
                        "\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\","
                        "\"is_mounted\":%s,\"mounted_module_id\":%u,\"controlling_ship\":%u,"
                        "\"company\":%u,\"health\":%u,\"max_health\":%u%s}",
                        players[p].player_id, players[p].player_id,
                        players[p].x, players[p].y, players[p].rotation,
                        players[p].velocity_x, players[p].velocity_y,
                        players[p].is_moving ? "true" : "false",
                        players[p].movement_direction_x, players[p].movement_direction_y,
                        players[p].parent_ship_id, players[p].local_x, players[p].local_y,
                        get_state_string(players[p].movement_state),
                        players[p].is_mounted ? "true" : "false",
                        players[p].mounted_module_id,
                        players[p].controlling_ship_id,
                        players[p].company_id,
                        players[p].health, players[p].max_health,
                        inv_buf);
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
            // log_info("🎯 Projectile count: %u", global_sim->projectile_count);
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

        // Build world NPCs JSON array
        char npcs_json[32768]; /* 64 NPCs × ~350 bytes/NPC — must be large enough */
        int npcs_offset = 0;
        npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset, "[");
        bool first_npc = true;
        for (int n = 0; n < world_npc_count; n++) {
            const WorldNpc* npc = &world_npcs[n];
            if (!npc->active) continue;
            if (!first_npc)
                npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset, ",");
            npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset,
                "{\"id\":%u,\"name\":\"%s\",\"type\":0,"
                "\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                "\"ship_id\":%u,\"local_x\":%.1f,\"local_y\":%.1f,"
                "\"interact_radius\":%.1f,\"state\":%u,\"role\":%u,\"company\":%u,"
                "\"assigned_cannon_id\":%u,"
                "\"npc_level\":%u,\"health\":%u,\"max_health\":%u,\"xp\":%u,"
                "\"stat_health\":%u,\"stat_damage\":%u,\"stat_stamina\":%u,\"stat_weight\":%u,"
                "\"stat_points\":%u}",
                npc->id, npc->name,
                npc->x, npc->y, npc->rotation,
                npc->ship_id, npc->local_x, npc->local_y,
                npc->interact_radius, (unsigned)npc->state, (unsigned)npc->role, (unsigned)npc->company_id,
                npc->assigned_cannon_id,
                (unsigned)npc->npc_level, (unsigned)npc->health, (unsigned)npc->max_health, npc->xp,
                (unsigned)npc->stat_health, (unsigned)npc->stat_damage, (unsigned)npc->stat_stamina, (unsigned)npc->stat_weight,
                (unsigned)((npc->npc_level > 0u ? (uint8_t)(npc->npc_level - 1u) : 0u) -
                    (npc->stat_health + npc->stat_damage + npc->stat_stamina + npc->stat_weight)));
            first_npc = false;
        }
        npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset, "]");
        
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
        
        static char game_state[131072]; // 128 KB: ships(64K) + players + projectiles + npcs
        snprintf(game_state, sizeof(game_state),
                "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":%s,\"players\":%s,\"projectiles\":%s,\"npcs\":%s}",
                current_time / 33, current_time, ships_json, players_json, projectiles_json, npcs_json);
        
        // Broadcast to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                static char frame[131086]; // Must be >= game_state size + WebSocket header (14)
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

/* =========================================================================
 * NPC Public API
 * ========================================================================= */

uint32_t websocket_server_create_npc(uint32_t ship_id, uint32_t module_id, NpcRole role) {
    if (npc_count >= MAX_NPC_AGENTS) {
        log_warn("Cannot create NPC: MAX_NPC_AGENTS (%d) reached", MAX_NPC_AGENTS);
        return 0;
    }
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) {
        log_warn("Cannot create NPC: ship %u not found", ship_id);
        return 0;
    }

    NpcAgent* npc = &npc_agents[npc_count++];
    memset(npc, 0, sizeof(NpcAgent));
    npc->npc_id       = next_npc_id++;
    npc->ship_id      = ship_id;
    npc->module_id    = module_id;
    npc->role         = role;
    npc->active       = true;
    npc->fire_interval = 5.0f;
    npc->fire_cooldown = 2.0f; // Small initial delay before first shot

    // Mark the module as occupied so players cannot mount it
    ShipModule* mod = find_module_on_ship(ship, module_id);
    if (mod) mod->state_bits |= MODULE_STATE_OCCUPIED;

    log_info("🤖 NPC %u created: role=%d ship=%u module=%u",
             npc->npc_id, (int)role, ship_id, module_id);
    return npc->npc_id;
}

void websocket_server_remove_npc(uint32_t npc_id) {
    for (int i = 0; i < npc_count; i++) {
        if (npc_agents[i].npc_id == npc_id) {
            // Release the module
            SimpleShip* ship = find_ship(npc_agents[i].ship_id);
            if (ship) {
                ShipModule* mod = find_module_on_ship(ship, npc_agents[i].module_id);
                if (mod) mod->state_bits &= ~MODULE_STATE_OCCUPIED;
            }
            // Compact the array
            memmove(&npc_agents[i], &npc_agents[i + 1],
                    (npc_count - i - 1) * sizeof(NpcAgent));
            npc_count--;
            log_info("🤖 NPC %u removed", npc_id);
            return;
        }
    }
    log_warn("websocket_server_remove_npc: NPC %u not found", npc_id);
}

void websocket_server_npc_set_target(uint32_t npc_id, uint32_t target_ship_id) {
    for (int i = 0; i < npc_count; i++) {
        if (npc_agents[i].npc_id == npc_id) {
            npc_agents[i].target_ship_id = target_ship_id;
            log_info("🤖 NPC %u: target set to ship %u", npc_id, target_ship_id);
            return;
        }
    }
    log_warn("websocket_server_npc_set_target: NPC %u not found", npc_id);
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
    uint32_t current_time = get_time_ms();
    
    // ===== SYNC SHIP STATE FROM SIMULATION =====
    // This ensures SimpleShip has current position/rotation for mounted player updates
    sync_simple_ships_from_simulation();

    // ===== BROADCAST HIT EVENTS FROM SIMULATION =====
    if (global_sim && global_sim->hit_event_count > 0) {
        char frame[512];
        for (uint8_t e = 0; e < global_sim->hit_event_count; e++) {
            const struct HitEvent* ev = &global_sim->hit_events[e];
            char msg[256];

            if (ev->is_sink) {
                // Ship hull_health reached 0 — enter sinking state instead of immediate despawn.
                entity_id sunk_id = ev->ship_id;
                SimpleShip* sinking_ship = NULL;
                for (int s = 0; s < ship_count; s++) {
                    if (ships[s].active && ships[s].ship_id == sunk_id) {
                        sinking_ship = &ships[s];
                        break;
                    }
                }
                if (sinking_ship && !sinking_ship->is_sinking) {
                    sinking_ship->is_sinking    = true;
                    sinking_ship->sink_start_ms = get_time_ms();

                    /* Zero the sim-ship velocity so the ship stops dead */
                    if (global_sim) {
                        for (uint32_t ss = 0; ss < global_sim->ship_count; ss++) {
                            if ((uint32_t)global_sim->ships[ss].id == sunk_id) {
                                global_sim->ships[ss].velocity.x = 0;
                                global_sim->ships[ss].velocity.y = 0;
                                global_sim->ships[ss].angular_velocity = 0;
                                break;
                            }
                        }
                    }

                    /* Dismount all players from the sinking ship */
                    for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                        if (!players[pi].active || players[pi].parent_ship_id != sunk_id) continue;
                        players[pi].is_mounted          = false;
                        players[pi].mounted_module_id   = 0;
                        players[pi].controlling_ship_id = 0;
                        players[pi].movement_state      = PLAYER_STATE_WALKING;
                    }

                    /* Dismount all NPCs from the sinking ship */
                    for (int ni = 0; ni < world_npc_count; ni++) {
                        if (!world_npcs[ni].active || world_npcs[ni].ship_id != sunk_id) continue;
                        dismount_npc(&world_npcs[ni], sinking_ship);
                    }

                    /* Broadcast SHIP_SINKING so clients start the animation immediately */
                    char sink_msg[128];
                    snprintf(sink_msg, sizeof(sink_msg),
                        "{\"type\":\"SHIP_SINKING\",\"shipId\":%u,\"x\":%.1f,\"y\":%.1f}",
                        sunk_id,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    websocket_server_broadcast(sink_msg);
                    log_info("🌊 Ship %u entering sinking state", sunk_id);
                }
                /* Skip building the broadcast msg for this event — no module_id / damage info */
                continue;
            } else if (ev->is_breach) {
                if (ev->destroyed) {
                    // Interior module destroyed through breach: remove from SimpleShip and broadcast MODULE_HIT
                    SimpleShip* simple = find_ship(ev->ship_id);
                    if (simple) {
                        for (int m = 0; m < simple->module_count; m++) {
                            if (simple->modules[m].id == ev->module_id) {
                                memmove(&simple->modules[m], &simple->modules[m + 1],
                                        (simple->module_count - m - 1) * sizeof(ShipModule));
                                simple->module_count--;
                                break;
                            }
                        }
                    }

                    // ── Deck destroyed: cascade-destroy all non-mast non-ladder modules ──
                    if (ev->module_id == 200) {
                        log_info("💥 Deck destroyed on ship %u — cascading destruction", ev->ship_id);

                        // Destroy on the sim ship
                        struct Ship* sim_ship = NULL;
                        if (global_sim) {
                            for (uint32_t ss = 0; ss < global_sim->ship_count; ss++) {
                                if ((uint32_t)global_sim->ships[ss].id == ev->ship_id) {
                                    sim_ship = &global_sim->ships[ss]; break;
                                }
                            }
                        }
                        if (sim_ship) {
                            uint8_t m = 0;
                            while (m < sim_ship->module_count) {
                                ModuleTypeId t = sim_ship->modules[m].type_id;
                                if (t == MODULE_TYPE_MAST || t == MODULE_TYPE_LADDER ||
                                    t == MODULE_TYPE_PLANK || t == MODULE_TYPE_DECK) { m++; continue; }
                                // Fire a MODULE_HIT event for each cascaded module
                                if (global_sim->hit_event_count < MAX_HIT_EVENTS) {
                                    struct HitEvent* ce = &global_sim->hit_events[global_sim->hit_event_count++];
                                    ce->ship_id         = ev->ship_id;
                                    ce->module_id       = sim_ship->modules[m].id;
                                    ce->is_breach       = true;
                                    ce->is_sink         = false;
                                    ce->destroyed       = true;
                                    ce->damage_dealt    = (float)sim_ship->modules[m].health;
                                    ce->hit_x           = ev->hit_x;
                                    ce->hit_y           = ev->hit_y;
                                    ce->shooter_ship_id = ev->shooter_ship_id;
                                }
                                memmove(&sim_ship->modules[m], &sim_ship->modules[m + 1],
                                        (sim_ship->module_count - m - 1) * sizeof(ShipModule));
                                sim_ship->module_count--;
                            }
                        }
                        // Also purge SimpleShip mirror
                        if (simple) {
                            uint8_t m = 0;
                            while (m < simple->module_count) {
                                ModuleTypeId t = simple->modules[m].type_id;
                                if (t == MODULE_TYPE_MAST || t == MODULE_TYPE_LADDER ||
                                    t == MODULE_TYPE_PLANK || t == MODULE_TYPE_DECK) { m++; continue; }
                                memmove(&simple->modules[m], &simple->modules[m + 1],
                                        (simple->module_count - m - 1) * sizeof(ShipModule));
                                simple->module_count--;
                            }
                        }
                        // Dismount any players whose module was just wiped
                        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                            if (!players[pi].active || players[pi].parent_ship_id != ev->ship_id) continue;
                            if (!players[pi].is_mounted) continue;
                            // Check if their mounted module still exists
                            bool still_there = false;
                            if (simple) {
                                for (int m = 0; m < simple->module_count; m++) {
                                    if ((uint32_t)simple->modules[m].id == players[pi].mounted_module_id) {
                                        still_there = true; break;
                                    }
                                }
                            }
                            if (!still_there) {
                                players[pi].is_mounted          = false;
                                players[pi].mounted_module_id   = 0;
                                players[pi].controlling_ship_id = 0;
                            }
                        }
                    }

                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"MODULE_HIT\",\"shipId\":%u,\"moduleId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                } else {
                    // Non-fatal interior module hit: just broadcast MODULE_DAMAGED for damage numbers
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"MODULE_DAMAGED\",\"shipId\":%u,\"moduleId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                }
            } else {
                if (ev->destroyed) {
                    // Plank destroyed: remove from SimpleShip and broadcast PLANK_HIT
                    SimpleShip* simple = find_ship(ev->ship_id);
                    if (simple) {
                        for (int m = 0; m < simple->module_count; m++) {
                            if (simple->modules[m].id == ev->module_id) {
                                memmove(&simple->modules[m], &simple->modules[m + 1],
                                        (simple->module_count - m - 1) * sizeof(ShipModule));
                                simple->module_count--;
                                break;
                            }
                        }
                    }
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"PLANK_HIT\",\"shipId\":%u,\"plankId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                } else {
                    // Non-fatal plank hit: just broadcast PLANK_DAMAGED for damage numbers
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"PLANK_DAMAGED\",\"shipId\":%u,\"plankId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                }
            }

            /* Award combat XP to NPC gunners on the shooter ship */
            if (ev->shooter_ship_id != 0 && ev->shooter_ship_id != ev->ship_id) {
                uint32_t xp_gain = 10 + (uint32_t)(ev->damage_dealt / 10.0f);
                for (int ni = 0; ni < world_npc_count; ni++) {
                    WorldNpc* gnpc = &world_npcs[ni];
                    if (gnpc->active && gnpc->role == NPC_ROLE_GUNNER &&
                        gnpc->ship_id == ev->shooter_ship_id) {
                        npc_apply_xp(gnpc, xp_gain);
                    }
                }
            }

            size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, msg, strlen(msg), frame, sizeof(frame));
            if (frame_len > 0) {
                for (int i = 0; i < WS_MAX_CLIENTS; i++) {
                    struct WebSocketClient* client = &ws_server.clients[i];
                    if (client->connected && client->handshake_complete)
                        send(client->fd, frame, frame_len, 0);
                }
            }
        }
        global_sim->hit_event_count = 0;
    }

    // ===== CANNONBALL vs ENTITY HIT DETECTION =====
    // Cannonballs (PROJ_TYPE_CANNONBALL) deal base 75 HP damage to NPCs and
    // players, scaled by the firing ship's damage level.  Unmounted entities
    // are knocked back; mounted ones are not.  The projectile is consumed on hit.
    if (global_sim) {
        const float ENTITY_HIT_RADIUS    = 40.0f;   // client pixels
        const float ENTITY_BASE_DAMAGE   = 75.0f;
        const float ENTITY_KNOCKBACK     = 40.0f;   // velocity impulse (client px/s)

        uint16_t pi = 0;
        while (pi < global_sim->projectile_count) {
            struct Projectile* proj = &global_sim->projectiles[pi];

            // Only cannonballs damage entities
            if (proj->type != PROJ_TYPE_CANNONBALL) { pi++; continue; }

            float px = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.x));
            float py = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.y));

            // Damage multiplier from firing ship level stats
            float dmg_mult = 1.0f;
            if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                struct Ship* fship = sim_get_ship(global_sim, (entity_id)proj->firing_ship_id);
                if (fship) dmg_mult = ship_level_damage_mult(&fship->level_stats);
            }
            float damage = ENTITY_BASE_DAMAGE * dmg_mult;
            float hit_r2  = ENTITY_HIT_RADIUS * ENTITY_HIT_RADIUS;

            bool proj_consumed = false;

            // ── Check NPCs ──────────────────────────────────────────────────
            for (int ni = 0; ni < world_npc_count && !proj_consumed; ni++) {
                WorldNpc* npc = &world_npcs[ni];
                if (!npc->active) continue;
                // No friendly fire: skip NPCs on the firing ship
                if (proj->firing_ship_id != INVALID_ENTITY_ID &&
                    npc->ship_id == (uint32_t)proj->firing_ship_id) continue;

                float dx = npc->x - px;
                float dy = npc->y - py;
                if (dx * dx + dy * dy > hit_r2) continue;

                // Apply damage
                uint16_t dmg16 = (damage >= 65535.0f) ? 65535u : (uint16_t)damage;
                if (npc->health <= dmg16) {
                    npc->health = 0;
                    npc->active = false; // NPC killed
                } else {
                    npc->health -= dmg16;
                }

                // Knockback via velocity — skip if stationed at a module
                bool npc_at_station = (npc->state == WORLD_NPC_STATE_AT_CANNON ||
                                       npc->state == WORLD_NPC_STATE_REPAIRING);
                if (!npc_at_station) {
                    float dist = sqrtf(dx * dx + dy * dy);
                    float kx   = (dist > 0.1f) ? (dx / dist) : 1.0f;
                    float ky   = (dist > 0.1f) ? (dy / dist) : 0.0f;
                    npc->velocity_x += kx * ENTITY_KNOCKBACK;
                    npc->velocity_y += ky * ENTITY_KNOCKBACK;
                }

                // Broadcast ENTITY_HIT
                char hit_msg[256];
                snprintf(hit_msg, sizeof(hit_msg),
                    "{\"type\":\"ENTITY_HIT\",\"entityType\":\"npc\",\"id\":%u,"
                    "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                    "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                    npc->id, npc->x, npc->y, damage,
                    (unsigned)npc->health, (unsigned)npc->max_health,
                    (!npc->active) ? "true" : "false");
                char hit_frame[320];
                size_t hfl = websocket_create_frame(WS_OPCODE_TEXT, hit_msg, strlen(hit_msg),
                                                    hit_frame, sizeof(hit_frame));
                if (hfl > 0) {
                    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                        struct WebSocketClient* wc = &ws_server.clients[ci];
                        if (wc->connected && wc->handshake_complete)
                            send(wc->fd, hit_frame, hfl, 0);
                    }
                }

                proj_consumed = true;
            }

            // ── Check Players ────────────────────────────────────────────────
            for (int wpi = 0; wpi < WS_MAX_CLIENTS && !proj_consumed; wpi++) {
                WebSocketPlayer* wp = &players[wpi];
                if (!wp->active) continue;
                // No friendly fire: skip players on the firing ship
                if (proj->firing_ship_id != INVALID_ENTITY_ID &&
                    wp->parent_ship_id == (uint32_t)proj->firing_ship_id) continue;

                float dx = wp->x - px;
                float dy = wp->y - py;
                if (dx * dx + dy * dy > hit_r2) continue;

                // Apply damage
                uint16_t dmg16 = (damage >= 65535.0f) ? 65535u : (uint16_t)damage;
                if (wp->health <= dmg16) {
                    wp->health = 0;
                } else {
                    wp->health -= dmg16;
                }

                // Knockback — skip if mounted to a module
                if (!wp->is_mounted) {
                    float dist = sqrtf(dx * dx + dy * dy);
                    float kx   = (dist > 0.1f) ? (dx / dist) : 1.0f;
                    float ky   = (dist > 0.1f) ? (dy / dist) : 0.0f;
                    if (wp->parent_ship_id != 0) {
                        // On a ship: push local position, then recalc world pos
                        wp->local_x += kx * ENTITY_KNOCKBACK;
                        wp->local_y += ky * ENTITY_KNOCKBACK;
                        SimpleShip* wp_ship = NULL;
                        for (int s = 0; s < ship_count; s++) {
                            if (ships[s].active && ships[s].ship_id == wp->parent_ship_id) {
                                wp_ship = &ships[s]; break;
                            }
                        }
                        if (wp_ship) ship_local_to_world(wp_ship, wp->local_x, wp->local_y,
                                                          &wp->x, &wp->y);
                    } else {
                        // Swimming: instant position delta + velocity impulse
                        wp->x += kx * ENTITY_KNOCKBACK;
                        wp->y += ky * ENTITY_KNOCKBACK;
                        wp->velocity_x += kx * ENTITY_KNOCKBACK * 3.0f;
                        wp->velocity_y += ky * ENTITY_KNOCKBACK * 3.0f;
                        // Sync to sim player
                        if (wp->sim_entity_id != 0) {
                            for (uint16_t spi = 0; spi < global_sim->player_count; spi++) {
                                if (global_sim->players[spi].id == wp->sim_entity_id) {
                                    global_sim->players[spi].position.x =
                                        Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->x));
                                    global_sim->players[spi].position.y =
                                        Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->y));
                                    global_sim->players[spi].velocity.x =
                                        Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->velocity_x));
                                    global_sim->players[spi].velocity.y =
                                        Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->velocity_y));
                                    break;
                                }
                            }
                        }
                    }
                }

                // Broadcast ENTITY_HIT
                char hit_msg[256];
                snprintf(hit_msg, sizeof(hit_msg),
                    "{\"type\":\"ENTITY_HIT\",\"entityType\":\"player\",\"id\":%u,"
                    "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                    "\"health\":%u,\"maxHealth\":%u}",
                    wp->player_id, wp->x, wp->y, damage,
                    (unsigned)wp->health, (unsigned)wp->max_health);
                char hit_frame[320];
                size_t hfl = websocket_create_frame(WS_OPCODE_TEXT, hit_msg, strlen(hit_msg),
                                                    hit_frame, sizeof(hit_frame));
                if (hfl > 0) {
                    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                        struct WebSocketClient* wc = &ws_server.clients[ci];
                        if (wc->connected && wc->handshake_complete)
                            send(wc->fd, hit_frame, hfl, 0);
                    }
                }

                proj_consumed = true;
            }

            if (proj_consumed) {
                // Remove the projectile from the simulation
                memmove(&global_sim->projectiles[pi],
                        &global_sim->projectiles[pi + 1],
                        (global_sim->projectile_count - pi - 1) * sizeof(struct Projectile));
                global_sim->projectile_count--;
                // Don't advance pi — re-check this slot
            } else {
                pi++;
            }
        }
    }

    // ===== TICK NPC AGENTS =====
    tick_npc_agents(dt);
    tick_world_npcs(dt);

    // ===== ASSIGN CREW TO WEAPON-GROUP CANNONS =====
    // Expire stale NEEDED flags, then dispatch idle gunners to NEEDED cannons.
    tick_cannon_needed_expiry();
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active) assign_weapon_group_crew(&ships[s]);
    }

    // ===== TICK SHIP WEAPON GROUPS (TARGETFIRE auto-aim) =====
    tick_ship_weapon_groups();

    // ===== TICK SINKING SHIPS (velocity=0, despawn after 8s) =====
    tick_sinking_ships();

    // ===== ADVANCE CANNON AIM TOWARD DESIRED (turn-speed limit) =====
    // Cannons rotate at a maximum of 60 degrees per second.
    {
        const float CANNON_TURN_SPEED = 60.0f * (float)(M_PI / 180.0f); // rad/s
        const float max_step = CANNON_TURN_SPEED * dt;
        for (int s = 0; s < ship_count; s++) {
            if (!ships[s].active) continue;
            for (int m = 0; m < ships[s].module_count; m++) {
                ShipModule* mod = &ships[s].modules[m];
                if (mod->type_id != MODULE_TYPE_CANNON) continue;
                float cur  = Q16_TO_FLOAT(mod->data.cannon.aim_direction);
                float tgt  = Q16_TO_FLOAT(mod->data.cannon.desired_aim_direction);
                float diff = tgt - cur;
                // Normalise diff to -PI..PI
                while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
                if (fabsf(diff) <= max_step) {
                    cur = tgt;
                } else {
                    cur += (diff > 0.0f ? max_step : -max_step);
                }
                mod->data.cannon.aim_direction = Q16_FROM_FLOAT(cur);
                // Mirror into sim-ship
                if (global_sim) {
                    for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                        if (global_sim->ships[si].id == ships[s].ship_id) {
                            for (uint8_t mi = 0; mi < global_sim->ships[si].module_count; mi++) {
                                if (global_sim->ships[si].modules[mi].id == mod->id) {
                                    global_sim->ships[si].modules[mi].data.cannon.aim_direction = mod->data.cannon.aim_direction;
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

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
        
        const float WALK_MAX_SPEED = CLIENT_TO_SERVER(40.0f);     // Maximum walking speed on deck (server units/s)
        
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
                
                // Auto-expire stale movement input: if no input received in 200ms, stop the player.
                // This prevents "stuck key" when a keyup event is dropped (focus loss, network blip, etc.).
                {
                    uint32_t now = get_time_ms();
                    if (ws_player->is_moving && (now - ws_player->last_input_time) > 200) {
                        ws_player->is_moving = false;
                        ws_player->movement_direction_x = 0.0f;
                        ws_player->movement_direction_y = 0.0f;
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
                            
                            // log_info("🚶 P%u: Move calc | speed=%.2f client/s | dt=%.4f | delta=(%.4f, %.4f) | old_local=(%.2f, %.2f) | new_local=(%.2f, %.2f)",
                            //          ws_player->player_id, walk_speed_client, dt,
                            //          local_move_x * walk_speed_client * dt, local_move_y * walk_speed_client * dt,
                            //          ws_player->local_x, ws_player->local_y,
                            //          new_local_x, new_local_y);
                            
                            // Resolve collisions with ship modules (helm, mast, cannon)
                            resolve_player_module_collisions(player_ship,
                                ws_player->is_mounted ? ws_player->mounted_module_id : 0,
                                &new_local_x, &new_local_y);
                            resolve_player_npc_collisions(player_ship, &new_local_x, &new_local_y);

                            // Check if player would walk off the deck (hull boundary)
                            if (is_outside_deck(player_ship->ship_id, new_local_x, new_local_y)) {
                                // Player walked off the edge - dismount into water
                                log_info("🌊 Player %u walked off the deck of ship %u (tick movement)", 
                                         ws_player->player_id, player_ship->ship_id);
                                
                                // Place player at the exit point (new_local_x/y is just outside the hull)
                                ship_local_to_world(player_ship, new_local_x, new_local_y, 
                                                  &ws_player->x, &ws_player->y);
                                
                                // Sync simulation position to the exit point
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->y));
                                
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
                                
                                // log_info("🚶 P%u: Walking on ship %u | local=(%.2f, %.2f) | world=(%.2f, %.2f)",
                                //          sim_player->id, ws_player->parent_ship_id,
                                //          ws_player->local_x, ws_player->local_y,
                                //          ws_player->x, ws_player->y);
                            }
                        } else {
                            // ===== SWIMMING MOVEMENT (WORLD COORDINATES) =====
                            // Apply acceleration in movement direction
                            q16_t accel_x = Q16_FROM_FLOAT(movement_x * SWIM_ACCELERATION * dt);
                            q16_t accel_y = Q16_FROM_FLOAT(movement_y * SWIM_ACCELERATION * dt);
                            
                            // log_info("⚡ P%u: Swimming | accel=(%.2f, %.2f) | dir=(%.2f, %.2f) | dt=%.3f",
                            //          sim_player->id,
                            //          Q16_TO_FLOAT(accel_x), Q16_TO_FLOAT(accel_y),
                            //          movement_x, movement_y, dt);
                            
                            sim_player->velocity.x += accel_x;
                            sim_player->velocity.y += accel_y;
                            
                            // Clamp to maximum speed
                            float current_vx = Q16_TO_FLOAT(sim_player->velocity.x);
                            float current_vy = Q16_TO_FLOAT(sim_player->velocity.y);
                            float current_speed = sqrtf(current_vx * current_vx + current_vy * current_vy);
                            
                            if (current_speed > SWIM_MAX_SPEED) {
                                // Scale velocity back to max speed
                                float scale = SWIM_MAX_SPEED / current_speed;
                                // log_info("🚀 P%u: Speed clamped %.2f → %.2f m/s | vel=(%.2f, %.2f) → (%.2f, %.2f)",
                                //          sim_player->id,
                                //          current_speed, SWIM_MAX_SPEED,
                                //          current_vx, current_vy,
                                //          current_vx * scale, current_vy * scale);
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
                                // log_info("🛑 P%u: Stopping | speed=%.2f → 0.00 m/s | vel=(%.2f, %.2f) → (0.00, 0.00)",
                                //          sim_player->id, current_speed, current_vx, current_vy);
                                sim_player->velocity.x = 0;
                                sim_player->velocity.y = 0;
                            } else {
                                // Reduce speed
                                float scale = (current_speed - decel_amount) / current_speed;
                                float new_vx = current_vx * scale;
                                float new_vy = current_vy * scale;
                                // log_info("⬇️ P%u: Decelerating | speed=%.2f → %.2f m/s | vel=(%.2f, %.2f) → (%.2f, %.2f)",
                                //          sim_player->id,
                                //          current_speed, current_speed - decel_amount,
                                //          current_vx, current_vy, new_vx, new_vy);
                                sim_player->velocity.x = Q16_FROM_FLOAT(new_vx);
                                sim_player->velocity.y = Q16_FROM_FLOAT(new_vy);
                            }
                        } else if (current_speed > 0.01f) {
                            // Snap to zero for very low speeds
                            // log_info("🛑 P%u: Snap to zero | speed=%.2f m/s (below threshold)",
                            //          sim_player->id, current_speed);
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
                // — only masts that have a rigger physically stationed there respond.
                for (uint8_t m = 0; m < ship->module_count; m++) {
                    if (ship->modules[m].type_id == MODULE_TYPE_MAST &&
                        is_mast_manned(ship->id, ship->modules[m].id)) {
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
                            // if (new_openness != current) {
                            //     log_info("⛵ Ship %u Mast %u: %u%% → %u%% (target: %u%%)",
                            //            ship->id, ship->modules[m].id,
                            //            current, new_openness, desired);
                            // }
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
            
            // Calculate average sail openness and fiber efficiency across all masts
            float total_openness = 0.0f;
            float total_wind_eff = 0.0f;
            int mast_count = 0;
            for (uint8_t m = 0; m < ship->module_count; m++) {
                if (ship->modules[m].type_id == MODULE_TYPE_MAST) {
                    total_openness += ship->modules[m].data.mast.openness;
                    total_wind_eff += Q16_TO_FLOAT(ship->modules[m].data.mast.wind_efficiency);
                    mast_count++;
                }
            }
            float avg_sail_openness = (mast_count > 0) ? (total_openness / mast_count) : 0.0f;
            // avg_wind_efficiency: 1.0 = pristine fibers, 0.0 = fully destroyed
            float avg_wind_efficiency = (mast_count > 0) ? (total_wind_eff / mast_count) : 1.0f;
            
            // Calculate forward force from wind and sails:
            // wind_power * sail_openness% * fiber_efficiency
            const float BASE_WIND_SPEED = 25.0f; // meters per second at full wind, full sails (5x increased)
            float wind_force_factor = (global_sim->wind_power * avg_sail_openness / 100.0f) * avg_wind_efficiency;
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
                log_info("⛵ Ship %u: masts=%d, avg_openness=%.1f%%, wind_eff=%.2f, wind=%.2f, target_speed=%.2f m/s, current_speed=%.2f m/s, pos=(%.1f,%.1f)",
                         ship->id, mast_count, avg_sail_openness, avg_wind_efficiency, global_sim->wind_power, target_speed, current_speed,
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
}