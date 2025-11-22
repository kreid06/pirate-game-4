#include "net/websocket_server.h"
#include "net/websocket_protocol.h"
#include "net/network.h"
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

static void ship_clamp_to_deck(const SimpleShip* ship, float* local_x, float* local_y) {
    if (*local_x < ship->deck_min_x) *local_x = ship->deck_min_x;
    if (*local_x > ship->deck_max_x) *local_x = ship->deck_max_x;
    if (*local_y < ship->deck_min_y) *local_y = ship->deck_min_y;
    if (*local_y > ship->deck_max_y) *local_y = ship->deck_max_y;
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
    char* key_start = strstr(request, "Sec-WebSocket-Key: ");
    if (!key_start) return false;
    
    key_start += 19; // Length of "Sec-WebSocket-Key: "
    char* key_end = strstr(key_start, "\r\n");
    if (!key_end) return false;
    
    size_t key_len = key_end - key_start;
    char key[256];
    memcpy(key, key_start, key_len);
    key[key_len] = '\0';
    
    // Create accept key
    char accept_input[512];
    snprintf(accept_input, sizeof(accept_input), "%s%s", key, WS_MAGIC_KEY);
    
    unsigned char hash[SHA_DIGEST_LENGTH];
    SHA1((unsigned char*)accept_input, strlen(accept_input), hash);
    
    char* accept_key = base64_encode(hash, SHA_DIGEST_LENGTH);
    
    // Send handshake response
    char response[1024];
    snprintf(response, sizeof(response),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n",
        accept_key);
    
    ssize_t sent = send(client_fd, response, strlen(response), 0);
    free(accept_key);
    
    return sent > 0;
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
            
            // Spawn player in water near origin for testing swimming
            players[i].parent_ship_id = 0;
            players[i].x = 0.0f;
            players[i].y = 0.0f;
            players[i].local_x = 0.0f;
            players[i].local_y = 0.0f;
            players[i].movement_state = PLAYER_STATE_SWIMMING;
            
            log_info("🎮 Spawned player %u in water at (%.1f, %.1f) - Ship at (%.1f, %.1f)", 
                     player_id, players[i].x, players[i].y,
                     ship_count > 0 ? ships[0].x : 0.0f,
                     ship_count > 0 ? ships[0].y : 0.0f);
            
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

// Global movement tracking for adaptive tick rate
static uint32_t g_last_movement_time = 0;

static void update_movement_activity(void) {
    g_last_movement_time = get_time_ms();
}

static void debug_player_state(void) {
    int active_players = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active) {
            active_players++;
            log_info("🔍 Player %u: pos(%.1f, %.1f) active=%d", 
                     players[i].player_id, players[i].x, players[i].y, players[i].active);
        }
    }
    log_info("🔍 Total active players: %d", active_players);
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
                
                // Update local position (movement is in ship's coordinate frame)
                player->local_x += movement_x * WALK_SPEED * dt;
                player->local_y += movement_y * WALK_SPEED * dt;
                
                // Clamp to deck boundaries
                ship_clamp_to_deck(ship, &player->local_x, &player->local_y);
            }
            
            // Convert local position to world position
            ship_local_to_world(ship, player->local_x, player->local_y, 
                              &player->x, &player->y);
            
            // Player inherits ship velocity
            player->velocity_x = ship->velocity_x;
            player->velocity_y = ship->velocity_y;
            
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
                
                // Update local position (movement is in ship's coordinate frame)
                player->local_x += movement_x * WALK_SPEED * dt;
                player->local_y += movement_y * WALK_SPEED * dt;
                
                // Clamp to deck boundaries
                ship_clamp_to_deck(ship, &player->local_x, &player->local_y);
            }
            
            // Convert local position to world position
            ship_local_to_world(ship, player->local_x, player->local_y, 
                              &player->x, &player->y);
            
            // Player inherits ship velocity
            player->velocity_x = ship->velocity_x;
            player->velocity_y = ship->velocity_y;
            
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
size_t websocket_create_frame(uint8_t opcode, const char* payload, size_t payload_len, char* frame) {
    size_t frame_len = 0;
    
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
        return 0;
    }
    
    // Payload
    memcpy(frame + frame_len, payload, payload_len);
    frame_len += payload_len;
    
    return frame_len;
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
            
            // New WebSocket connection accepted
        } else {
            log_warn("WebSocket server full, rejecting connection");
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
                // Handle WebSocket handshake
                if (websocket_handshake(client->fd, buffer)) {
                    client->handshake_complete = true;
                    // WebSocket handshake completed
                } else {
                    log_warn("❌ WebSocket handshake failed for %s:%u", client->ip_address, client->port);
                    close(client->fd);
                    client->connected = false;
                }
            } else {
                // Handle WebSocket frames
                char payload[1024];
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
                                    char game_state_frame[4096];
                                    char game_state_response[3072];
                                    
                                    // Build ships array for initial state
                                    char ships_str[1024] = "[";
                                    bool first_ship = true;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].active) {
                                            if (!first_ship) strcat(ships_str, ",");
                                            char ship_entry[256];
                                            snprintf(ship_entry, sizeof(ship_entry),
                                                    "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,\"velocity_x\":%.2f,\"velocity_y\":%.2f}",
                                                    ships[s].ship_id, ships[s].x, ships[s].y, ships[s].rotation,
                                                    ships[s].velocity_x, ships[s].velocity_y);
                                            strcat(ships_str, ship_entry);
                                            first_ship = false;
                                        }
                                    }
                                    strcat(ships_str, "]");
                                    
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
                                    
                                    // Send handshake response first
                                    char frame[1024];
                                    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame);
                                    if (frame_len > 0) {
                                        send(client->fd, frame, frame_len, 0);
                                    }
                                    
                                    // Then send game state
                                    size_t game_state_frame_len = websocket_create_frame(WS_OPCODE_TEXT, game_state_response, strlen(game_state_response), game_state_frame);
                                    if (game_state_frame_len > 0) {
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
                            log_info("🎮 Processing INPUT_FRAME message");
                            ws_server.input_messages_received++;
                            ws_server.last_input_time = get_time_ms();
                            
                            log_info("🎮 Input frame received from %s:%u (Player: %u)", 
                                     client->ip_address, client->port, client->player_id);
                            log_info("🔍 Raw input_frame payload: %.*s", (int)payload_len, payload);
                            
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
                                        
                                        // Update player movement (using 0.033s as approximate tick time)
                                        uint32_t current_time = get_time_ms();
                                        float dt = (current_time - player->last_input_time) / 1000.0f;
                                        if (dt > 0.1f) dt = 0.033f; // Cap delta time
                                        
                                        update_player_movement(player, rotation, x, y, dt);
                                        player->last_input_time = current_time;
                                        
                                        // Track movement for adaptive tick rate
                                        if (x != 0.0f || y != 0.0f) {
                                            update_movement_activity();
                                        }
                                        
                                        log_info("🎮 Player %u at (%.1f, %.1f) facing %.3f rad", 
                                                 client->player_id, player->x, player->y, player->rotation);
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
                                        // TODO: Implement jumping
                                        log_info("🦘 Player %u jumped!", player->player_id);
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
                            
                        } else if (strstr(payload, "\"type\":\"ping\"")) {
                            // JSON ping message
                            log_info("🏓 Processing JSON PING message");
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
                        log_info("📝 Text command received (not JSON)");
                        if (strncmp(payload, "PING", 4) == 0) {
                            log_info("🏓 Processing text PING command");
                            strcpy(response, "PONG");
                            handled = true;
                            
                        } else if (strncmp(payload, "JOIN:", 5) == 0) {
                            // Extract player name
                            char* player_name = payload + 5;
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
                        char frame[1024];
                        size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame);
                        if (frame_len > 0) {
                            ssize_t sent = send(client->fd, frame, frame_len, 0);
                            if (sent > 0) {
                                ws_server.packets_sent++;
                                // Response sent
                            }
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
                    size_t frame_len = websocket_create_frame(WS_OPCODE_PONG, payload, payload_len, frame);
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
        // Build ships JSON array with physics properties
        char ships_json[2048] = "[";  // Increased buffer for physics data
        bool first_ship = true;
        for (int s = 0; s < ship_count; s++) {
            if (ships[s].active) {
                if (!first_ship) strcat(ships_json, ",");
                char ship_entry[512];  // Increased for physics properties
                snprintf(ship_entry, sizeof(ship_entry),
                        "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                        "\"mass\":%.1f,\"moment_of_inertia\":%.1f,"
                        "\"max_speed\":%.1f,\"turn_rate\":%.2f,"
                        "\"water_drag\":%.3f,\"angular_drag\":%.3f}",
                        ships[s].ship_id, ships[s].x, ships[s].y, ships[s].rotation,
                        ships[s].velocity_x, ships[s].velocity_y, ships[s].angular_velocity,
                        ships[s].mass, ships[s].moment_of_inertia,
                        ships[s].max_speed, ships[s].turn_rate,
                        ships[s].water_drag, ships[s].angular_drag);
                strcat(ships_json, ship_entry);
                first_ship = false;
            }
        }
        strcat(ships_json, "]");
        
        // Build players JSON array with ship relationship data
        char players_json[2048] = "[";
        bool first_player = true;
        int active_count = 0;
        
        for (int p = 0; p < WS_MAX_CLIENTS; p++) {
            if (players[p].active) {
                if (!first_player) strcat(players_json, ",");
                char player_entry[384];  // Increased size for additional fields
                snprintf(player_entry, sizeof(player_entry),
                        "{\"id\":%u,\"name\":\"Player_%u\",\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"is_moving\":%s,"
                        "\"movement_direction_x\":%.2f,\"movement_direction_y\":%.2f,"
                        "\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\"}",
                        players[p].player_id, players[p].player_id, 
                        players[p].x, players[p].y, players[p].rotation,
                        players[p].velocity_x, players[p].velocity_y, 
                        players[p].is_moving ? "true" : "false",
                        players[p].movement_direction_x, players[p].movement_direction_y,
                        players[p].parent_ship_id, players[p].local_x, players[p].local_y,
                        get_state_string(players[p].movement_state));
                strcat(players_json, player_entry);
                first_player = false;
                active_count++;
            }
        }
        strcat(players_json, "]");
        
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
        
        // Log broadcasting state less frequently (every 5 seconds)
        static uint32_t last_broadcast_log_time = 0;
        if (active_count > 0 && (current_time - last_broadcast_log_time) > 5000) {
            log_info("🌐 Broadcasting game state with %d active players (Rate: %dHz)", active_count, current_update_rate);
            last_broadcast_log_time = current_time;
        }
        
        char game_state[4096];  // Increased buffer size for ships + players
        snprintf(game_state, sizeof(game_state),
                "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":%s,\"players\":%s,\"projectiles\":[]}",
                current_time / 33, current_time, ships_json, players_json);
        
        // Broadcast to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                char frame[1024];
                size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, game_state, strlen(game_state), frame);
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
    
    return 0;
}

void websocket_server_broadcast(const char* message) {
    if (!ws_server.running || !message) return;
    
    char frame[2048];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame);
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
    
    int moving_players = 0;
    
    // Apply movement state for all active players
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active) {
            apply_player_movement_state(&players[i], dt);
            
            if (players[i].is_moving) {
                moving_players++;
            }
        }
    }
    
    // Tick processing complete
    last_tick_log_time = current_time;
}