#pragma once

#include "sim/types.h"
#include <stdint.h>
#include <stdbool.h>

struct WebSocketStats {
    int connected_clients;
    uint64_t packets_sent;
    uint64_t packets_received;
    uint16_t port;
};

/**
 * Initialize WebSocket server for browser clients
 * @param port Port to listen on (e.g., 8082)
 * @return 0 on success, -1 on error
 */
int websocket_server_init(uint16_t port);

/**
 * Clean up WebSocket server and close all connections
 */
void websocket_server_cleanup(void);

/**
 * Update WebSocket server (handle connections, messages)
 * Should be called from main server loop
 * @param sim Simulation context for game state
 * @return 0 on success, -1 on error
 */
int websocket_server_update(struct Sim* sim);

/**
 * Broadcast message to all connected WebSocket clients
 * @param message Message to broadcast (will be framed as WebSocket text)
 */
void websocket_server_broadcast(const char* message);

/**
 * Get WebSocket server statistics
 * @param stats Output structure for statistics
 * @return 0 on success, -1 on error
 */
int websocket_server_get_stats(struct WebSocketStats* stats);