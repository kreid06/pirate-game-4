/**
 * WebSocket Protocol Bridge Header
 */

#ifndef WEBSOCKET_PROTOCOL_H
#define WEBSOCKET_PROTOCOL_H

#include <stdint.h>
#include <stddef.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "net/network.h"
#include "sim/simulation.h"

// WebSocket opcodes (from websocket_server.c)
#define WS_OPCODE_TEXT 0x1
#define WS_OPCODE_BINARY 0x2

/**
 * Convert WebSocket JSON message to UDP packet format
 */
int websocket_json_to_udp(const char* json_message, uint8_t* udp_packet, size_t* packet_size);

/**
 * Convert UDP packet to WebSocket JSON message
 */
int websocket_udp_to_json(const uint8_t* udp_packet, size_t packet_size, char* json_message, size_t json_buffer_size);

/**
 * Handle WebSocket message and forward to UDP network layer
 */
int websocket_handle_message(const char* json_message, struct NetworkManager* net_mgr, struct Sim* sim, 
                            const struct sockaddr_in* client_addr);

/**
 * Send UDP response as WebSocket JSON message
 */
int websocket_send_response(int websocket_fd, const uint8_t* udp_packet, size_t packet_size);

/**
 * Create WebSocket frame (external function from websocket_server.c)
 */
size_t websocket_create_frame(uint8_t opcode, const char* payload, size_t payload_len, char* frame);

#endif // WEBSOCKET_PROTOCOL_H