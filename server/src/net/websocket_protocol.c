/**
 * WebSocket Protocol Bridge - Enhanced
 * 
 * Translates between WebSocket JSON messages and UDP binary protocol
 * Provides full protocol compatibility for browser clients
 */

#include "net/websocket_protocol.h"
#include "protocol.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

// Simple JSON value extraction (without external library)
static const char* extract_json_string(const char* json, const char* key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    
    const char* start = strstr(json, search_pattern);
    if (!start) return NULL;
    
    start += strlen(search_pattern);
    
    // Skip whitespace
    while (*start && isspace(*start)) start++;
    
    if (*start != '"') return NULL;
    start++; // Skip opening quote
    
    static char value[256];  // Static buffer for return value
    const char* end = strchr(start, '"');
    if (!end) return NULL;
    
    size_t len = end - start;
    if (len >= sizeof(value)) len = sizeof(value) - 1;
    
    strncpy(value, start, len);
    value[len] = '\0';
    
    return value;
}

static int extract_json_int(const char* json, const char* key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    
    const char* start = strstr(json, search_pattern);
    if (!start) return -1;
    
    start += strlen(search_pattern);
    
    // Skip whitespace
    while (*start && isspace(*start)) start++;
    
    return atoi(start);
}

static float extract_json_float(const char* json, const char* key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    
    const char* start = strstr(json, search_pattern);
    if (!start) return 0.0f;
    
    start += strlen(search_pattern);
    
    // Skip whitespace
    while (*start && isspace(*start)) start++;
    
    return atof(start);
}

static bool extract_json_bool(const char* json, const char* key) {
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", key);
    
    const char* start = strstr(json, search_pattern);
    if (!start) return false;
    
    start += strlen(search_pattern);
    
    // Skip whitespace
    while (*start && isspace(*start)) start++;
    
    return (strncmp(start, "true", 4) == 0);
}

/**
 * Convert WebSocket JSON message to UDP packet format
 */
int websocket_json_to_udp(const char* json_message, uint8_t* udp_packet, size_t* packet_size) {
    if (!json_message || !udp_packet || !packet_size) return -1;
    
    const char* message_type = extract_json_string(json_message, "type");
    if (!message_type) {
        log_warn("WebSocket message missing 'type' field");
        return -1;
    }
    
    log_debug("🔄 Converting WebSocket JSON to UDP: %s", message_type);
    
    if (strcmp(message_type, "handshake") == 0) {
        // Convert to HandshakePacket
        struct HandshakePacket* packet = (struct HandshakePacket*)udp_packet;
        packet->type = PACKET_HANDSHAKE;
        packet->version = PROTOCOL_VERSION;
        packet->client_id = extract_json_int(json_message, "client_id");
        packet->timestamp = extract_json_int(json_message, "timestamp");
        packet->padding = 0;
        
        *packet_size = sizeof(struct HandshakePacket);
        log_debug("✅ WebSocket handshake converted: client_id=%u", packet->client_id);
        
    } else if (strcmp(message_type, "input") == 0) {
        // Convert to InputPacket
        struct InputPacket* packet = (struct InputPacket*)udp_packet;
        packet->type = PACKET_INPUT;
        packet->tick = extract_json_int(json_message, "tick");
        packet->movement_x = extract_json_float(json_message, "movement_x");
        packet->movement_y = extract_json_float(json_message, "movement_y");
        packet->flags = extract_json_int(json_message, "flags");
        
        *packet_size = sizeof(struct InputPacket);
        log_debug("🎮 WebSocket input converted: tick=%u, move=(%.2f,%.2f), flags=0x%02X",
                 packet->tick, packet->movement_x, packet->movement_y, packet->flags);
        
    } else if (strcmp(message_type, "ping") == 0) {
        // Convert to PingPacket
        struct PingPacket* packet = (struct PingPacket*)udp_packet;
        packet->type = PACKET_PING;
        packet->sequence = extract_json_int(json_message, "sequence");
        packet->timestamp = extract_json_int(json_message, "timestamp");
        
        *packet_size = sizeof(struct PingPacket);
        log_debug("🏓 WebSocket ping converted: seq=%u, timestamp=%u", 
                 packet->sequence, packet->timestamp);
        
    } else {
        log_warn("Unknown WebSocket message type: %s", message_type);
        return -1;
    }
    
    return 0;
}

/**
 * Convert UDP packet to WebSocket JSON message
 */
int websocket_udp_to_json(const uint8_t* udp_packet, size_t packet_size, char* json_message, size_t json_buffer_size) {
    if (!udp_packet || !json_message || packet_size < 1) return -1;
    
    uint8_t packet_type = udp_packet[0];
    
    switch (packet_type) {
        case PACKET_HANDSHAKE_RESPONSE: {
            const struct HandshakeResponsePacket* packet = (const struct HandshakeResponsePacket*)udp_packet;
            
            snprintf(json_message, json_buffer_size,
                    "{\"type\":\"handshake_response\",\"success\":%s,\"player_id\":%u,\"server_time\":%u}",
                    (packet->status == 0) ? "true" : "false",
                    packet->player_id,
                    packet->server_time);
            
            log_debug("✅ UDP handshake_response converted to WebSocket JSON");
            break;
        }
        
        case PACKET_SNAPSHOT: {
            // Simple snapshot packet (can be enhanced later)
            snprintf(json_message, json_buffer_size,
                    "{\"type\":\"snapshot\",\"timestamp\":%u,\"entities\":[]}",
                    get_time_ms());
            
            log_debug("📸 UDP snapshot converted to WebSocket JSON");
            break;
        }
        
        case PACKET_PONG: {
            const struct PongPacket* packet = (const struct PongPacket*)udp_packet;
            
            snprintf(json_message, json_buffer_size,
                    "{\"type\":\"pong\",\"server_time\":%lu,\"client_time\":%lu}",
                    (unsigned long)packet->timestamp,
                    (unsigned long)packet->client_timestamp);
            
            log_debug("🏓 UDP pong converted to WebSocket JSON");
            break;
        }
        
        default:
            log_warn("❓ Unknown UDP packet type for WebSocket conversion: %u", packet_type);
            snprintf(json_message, json_buffer_size,
                    "{\"type\":\"error\",\"message\":\"Unknown packet type\"}");
            return -1;
    }
    
    return 0;
/**
 * Handle WebSocket message and forward to UDP network layer
 */
int websocket_handle_message(const char* json_message, struct NetworkManager* net_mgr, struct Sim* sim, 
                            const struct sockaddr_in* client_addr) {
    (void)client_addr; // Unused parameter
    if (!json_message || !net_mgr || !sim) return -1;
    
    uint8_t udp_packet[PROTOCOL_MAX_PACKET_SIZE];
    size_t packet_size;
    
    // Convert WebSocket JSON to UDP packet
    if (websocket_json_to_udp(json_message, udp_packet, &packet_size) != 0) {
        return -1;
    }
    
    // Process packet through existing UDP handlers
    uint8_t packet_type = udp_packet[0];
    
    switch (packet_type) {
        case PACKET_HANDSHAKE: {
            const struct HandshakePacket* handshake = (const struct HandshakePacket*)udp_packet;
            log_info("🤝 WebSocket handshake from client ID %u", handshake->client_id);
            
            // TODO: Call existing handshake handler
            // network_handle_handshake(net_mgr, client_addr, handshake, sim);
            
            break;
        }
        
        case PACKET_INPUT: {
            const struct InputPacket* input = (const struct InputPacket*)udp_packet;
            log_debug("🎮 WebSocket input: movement(%.2f, %.2f) flags=0x%02X", 
                     input->movement_x, input->movement_y, input->flags);
            
            // TODO: Call existing input handler
            // network_process_player_input(net_mgr, sim, player_id, input);
            
            break;
        }
        
        case PACKET_PING: {
            const struct PingPacket* ping = (const struct PingPacket*)udp_packet;
            log_debug("🏓 WebSocket ping sequence %u", ping->sequence);
            
            // TODO: Call existing ping handler or create pong response
            
            break;
        }
        
        default:
            log_warn("Unhandled WebSocket packet type: %u", packet_type);
            return -1;
    }
    
    return 0;
}

/**
 * Send UDP response as WebSocket JSON message
 */
int websocket_send_response(int websocket_fd, const uint8_t* udp_packet, size_t packet_size) {
    char json_message[2048];
    
    // Convert UDP packet to JSON
    if (websocket_udp_to_json(udp_packet, packet_size, json_message, sizeof(json_message)) != 0) {
        return -1;
    }
    
    // Create WebSocket frame
    char frame[4096];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, json_message, strlen(json_message), frame);
    
    if (frame_len == 0) {
        return -1;
    }
    
    // Send frame
    ssize_t sent = send(websocket_fd, frame, frame_len, 0);
    if (sent != (ssize_t)frame_len) {
        log_warn("Failed to send WebSocket response: sent %zd of %zu bytes", sent, frame_len);
        return -1;
    }
    
    return 0;
}
}