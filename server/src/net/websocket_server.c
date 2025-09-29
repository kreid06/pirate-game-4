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
#include <arpa/inet.h>
#include <sys/socket.h>
#include <openssl/sha.h>
#include <openssl/evp.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>

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
typedef struct {
    uint32_t player_id;
    float x, y;
    float velocity_x, velocity_y;
    uint32_t last_input_time;
    bool active;
} WebSocketPlayer;

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
};

static struct WebSocketServer ws_server = {0};

// Global player data for simple movement tracking
static WebSocketPlayer players[WS_MAX_CLIENTS] = {0};
static int next_player_id = 1000;

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
            players[i].x = 400.0f; // Default spawn position
            players[i].y = 300.0f;
            players[i].velocity_x = 0.0f;
            players[i].velocity_y = 0.0f;
            players[i].last_input_time = get_time_ms();
            players[i].active = true;
            log_info("🎮 Created player %u at (%.1f, %.1f)", player_id, players[i].x, players[i].y);
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

static void update_player_movement(WebSocketPlayer* player, float movement_x, float movement_y, float dt) {
    const float PLAYER_SPEED = 200.0f; // pixels per second
    const float FRICTION = 0.85f;
    
    // Apply movement input
    player->velocity_x = movement_x * PLAYER_SPEED;
    player->velocity_y = movement_y * PLAYER_SPEED;
    
    // Update position
    player->x += player->velocity_x * dt;
    player->y += player->velocity_y * dt;
    
    // Simple bounds checking (assuming 800x600 world)
    if (player->x < 0) player->x = 0;
    if (player->x > 800) player->x = 800;
    if (player->y < 0) player->y = 0;
    if (player->y > 600) player->y = 600;
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
        actual_payload_len = (buffer[2] << 8) | buffer[3];
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
    
    // Enhanced startup message
    printf("\n🌐 ═══════════════════════════════════════════════════════════════\n");
    printf("🔌 WebSocket Server Ready for Browser Clients!\n");
    printf("🌍 WebSocket listening on 0.0.0.0:%u\n", port);
    printf("🔄 Protocol bridge: WebSocket ↔ UDP translation active\n");
    printf("🎯 Browser clients can now connect via WebSocket\n");
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
            
            log_info("🔗 New WebSocket connection from %s:%u (slot %d)", 
                     ws_server.clients[slot].ip_address, ws_server.clients[slot].port, slot);
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
                    log_info("✅ WebSocket handshake completed for %s:%u", client->ip_address, client->port);
                } else {
                    log_warn("❌ WebSocket handshake failed for %s:%u", client->ip_address, client->port);
                    close(client->fd);
                    client->connected = false;
                }
            } else {
                // Handle WebSocket frames
                char payload[1024];
                size_t payload_len;
                int opcode = websocket_parse_frame(buffer, received, payload, &payload_len);
                
                if (opcode == WS_OPCODE_TEXT || opcode == WS_OPCODE_BINARY) {
                    log_info("📨 WebSocket message from %s:%u: %.*s", 
                            client->ip_address, client->port, (int)payload_len, payload);
                    
                    char response[1024];
                    bool handled = false;
                    
                    // Check if message is JSON or text command
                    if (payload[0] == '{') {
                        // JSON message - parse type
                        if (strstr(payload, "\"type\":\"handshake\"")) {
                            // Check if client already has a player
                            if (client->player_id != 0) {
                                WebSocketPlayer* existing_player = find_player(client->player_id);
                                if (existing_player) {
                                    log_info("🤝 Client %s:%u reconnecting with existing player ID %u", 
                                             client->ip_address, client->port, client->player_id);
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"player_id\":%u,\"server_time\":%u,\"status\":\"reconnected\"}",
                                            client->player_id, get_time_ms());
                                    handled = true;
                                } else {
                                    // Player ID exists but player not found - reset it
                                    log_warn("Client %s:%u had invalid player ID %u, resetting", 
                                             client->ip_address, client->port, client->player_id);
                                    client->player_id = 0;
                                }
                            }
                            
                            if (client->player_id == 0) {
                                // Handshake message - create new player
                                uint32_t player_id = next_player_id++;
                                client->player_id = player_id;
                                
                                // Create player for this client
                                WebSocketPlayer* player = create_player(player_id);
                                if (!player) {
                                    log_error("Failed to create player for client %s:%u", client->ip_address, client->port);
                                    client->player_id = 0; // Reset on failure
                                    continue;
                                }
                                
                                snprintf(response, sizeof(response),
                                        "{\"type\":\"handshake_response\",\"player_id\":%u,\"server_time\":%u,\"status\":\"connected\"}",
                                        player_id, get_time_ms());
                                handled = true;
                                log_info("🤝 WebSocket handshake from %s:%u (ID: %u)", client->ip_address, client->port, player_id);
                            }
                            
                            if (handled) {
                                // Send initial game state after handshake
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    char game_state_frame[2048];
                                    char game_state_response[1024];
                                    snprintf(game_state_response, sizeof(game_state_response),
                                            "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":[],\"players\":[{\"id\":%u,\"name\":\"Player\",\"x\":%.1f,\"y\":%.1f}],\"projectiles\":[]}",
                                            get_time_ms() / 33, get_time_ms(), client->player_id, player->x, player->y);
                                    
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
                                        log_info("🎮 Sent initial game state to %s:%u", client->ip_address, client->port);
                                    }
                                    
                                    // Skip normal response sending since we already sent
                                    ws_server.packets_sent += 2;
                                    ws_server.packets_received++;
                                    continue;
                                }
                            }
                            
                        } else if (strstr(payload, "\"type\":\"input_frame\"")) {
                            // Input frame message - parse movement data
                            if (client->player_id == 0) {
                                log_warn("Input frame from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
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
                                        
                                        // Update player movement (using 0.033s as approximate tick time)
                                        uint32_t current_time = get_time_ms();
                                        float dt = (current_time - player->last_input_time) / 1000.0f;
                                        if (dt > 0.1f) dt = 0.033f; // Cap delta time
                                        
                                        update_player_movement(player, x, y, dt);
                                        player->last_input_time = current_time;
                                        
                                        log_info("🎮 Player %u moved to (%.1f, %.1f)", 
                                                 client->player_id, player->x, player->y);
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
                            
                        } else if (strstr(payload, "\"type\":\"ping\"")) {
                            // JSON ping message
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"pong\",\"timestamp\":%u,\"server_time\":%u}",
                                    get_time_ms(), get_time_ms());
                            handled = true;
                            
                        } else {
                            // Unknown JSON message
                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"processed\"}");
                            handled = true;
                        }
                        
                    } else {
                        // Text command (simple protocol)
                        if (strncmp(payload, "PING", 4) == 0) {
                            strcpy(response, "PONG");
                            handled = true;
                            
                        } else if (strncmp(payload, "JOIN:", 5) == 0) {
                            // Extract player name
                            char* player_name = payload + 5;
                            uint32_t player_id = 1000 + i;
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"handshake_response\",\"player_id\":%u,\"player_name\":\"%s\",\"server_time\":%u}",
                                    player_id, player_name, get_time_ms());
                            handled = true;
                            log_info("🎮 Player joined via WebSocket: %s (ID: %u)", player_name, player_id);
                            
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
                                log_info("📤 WebSocket response sent to %s:%u (%zd bytes)", 
                                        client->ip_address, client->port, sent);
                            }
                        }
                    }
                    
                    ws_server.packets_received++;
                    
                } else if (opcode == WS_OPCODE_CLOSE) {
                    log_info("🔌 WebSocket client %s:%u disconnected", client->ip_address, client->port);
                    if (client->player_id > 0) {
                        remove_player(client->player_id);
                        client->player_id = 0;
                    }
                    close(client->fd);
                    client->connected = false;
                } else if (opcode == WS_OPCODE_PING) {
                    // Respond with pong
                    char frame[64];
                    size_t frame_len = websocket_create_frame(WS_OPCODE_PONG, payload, payload_len, frame);
                    if (frame_len > 0) {
                        send(client->fd, frame, frame_len, 0);
                    }
                }
            }
        } else if (received == 0) {
            // Client disconnected
            log_info("🔌 WebSocket client %s:%u disconnected", client->ip_address, client->port);
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
    
    // Send periodic game state updates (every ~500ms)
    static uint32_t last_game_state_time = 0;
    static uint32_t last_debug_time = 0;
    uint32_t current_time = get_time_ms();
    
    // Debug player state every 10 seconds
    if (current_time - last_debug_time > 10000) {
        debug_player_state();
        last_debug_time = current_time;
    }
    
    if (current_time - last_game_state_time > 500) {
        // Build players JSON array with current positions
        char players_json[512] = "[";
        bool first_player = true;
        int active_count = 0;
        
        for (int p = 0; p < WS_MAX_CLIENTS; p++) {
            if (players[p].active) {
                if (!first_player) strcat(players_json, ",");
                char player_entry[128];
                snprintf(player_entry, sizeof(player_entry),
                        "{\"id\":%u,\"name\":\"Player_%u\",\"x\":%.1f,\"y\":%.1f}",
                        players[p].player_id, players[p].player_id, 
                        players[p].x, players[p].y);
                strcat(players_json, player_entry);
                first_player = false;
                active_count++;
            }
        }
        strcat(players_json, "]");
        
        if (active_count > 0) {
            log_info("🌐 Broadcasting game state with %d active players", active_count);
        }
        
        char game_state[1024];
        snprintf(game_state, sizeof(game_state),
                "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":[],\"players\":%s,\"projectiles\":[]}",
                current_time / 33, current_time, players_json);
        
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
    stats->port = ws_server.port;
    
    return 0;
}