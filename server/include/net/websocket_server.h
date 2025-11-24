#pragma once

#include "sim/types.h"
#include <stdint.h>
#include <stdbool.h>

// Simple ship structure for WebSocket server
typedef struct SimpleShip {
    uint32_t ship_id;
    uint32_t ship_type;      // Ship type ID (1=sloop, 2=cutter, 3=brigantine, etc.)
    float x, y;              // World position
    float rotation;          // Radians
    float velocity_x, velocity_y;
    float angular_velocity;
    
    // Physics properties (from ship definitions)
    float mass;              // Ship mass (kg)
    float moment_of_inertia; // Rotational inertia (kg⋅m²)
    float max_speed;         // Maximum speed (m/s)
    float turn_rate;         // Maximum turn rate (rad/s)
    float water_drag;        // Linear drag coefficient (0-1)
    float angular_drag;      // Angular drag coefficient (0-1)
    
    float deck_min_x, deck_max_x;  // Walkable area
    float deck_min_y, deck_max_y;
    bool active;
    
    // Ship modules (cannons, masts, helm, seats, etc.)
    ShipModule modules[MAX_MODULES_PER_SHIP];
    uint8_t module_count;
} SimpleShip;

// Player movement states
typedef enum {
    PLAYER_STATE_WALKING,   // On ship deck
    PLAYER_STATE_SWIMMING,  // In water
    PLAYER_STATE_FALLING    // Airborne (jumped off ship)
} PlayerMovementState;

// WebSocket player structure
typedef struct WebSocketPlayer {
    uint32_t player_id;          // WebSocket client player ID (e.g., 1000, 1001)
    uint32_t sim_entity_id;      // Simulation entity ID (e.g., 1, 2, 3)
    char name[64];
    float x, y;
    float velocity_x, velocity_y;
    float rotation;
    
    // Hybrid input system - movement state (persistent)
    float movement_direction_x;  // -1.0 to 1.0 (normalized)
    float movement_direction_y;  // -1.0 to 1.0 (normalized)
    bool is_moving;              // true if actively moving
    
    // Rotation tracking for interpolation
    float last_rotation;         // Previous rotation value
    uint32_t last_rotation_update_time;
    
    uint32_t parent_ship_id;
    float local_x, local_y;
    PlayerMovementState movement_state;
    uint32_t last_input_time;
    bool active;
    
    // Module interaction state
    bool is_mounted;               // Is player mounted to a module
    uint32_t mounted_module_id;    // ID of mounted module (0 if not mounted)
    uint32_t controlling_ship_id;  // ID of ship being controlled (helm only, 0 if not controlling)
} WebSocketPlayer;

struct WebSocketStats {
    int connected_clients;
    uint64_t packets_sent;
    uint64_t packets_received;
    uint64_t input_messages_received;
    uint64_t unknown_messages_received;
    uint32_t last_input_time;
    uint32_t last_unknown_time;
    uint16_t port;
};

/**
 * Initialize WebSocket server for browser clients
 * @param port Port to listen on (e.g., 8082 for browser clients)
 * @return 0 on success, -1 on error
 */
int websocket_server_init(uint16_t port);

/**
 * Set the simulation context for player collision detection
 * @param sim Simulation context
 */
void websocket_server_set_simulation(struct Sim* sim);

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
 * Apply movement state to all players (HYBRID approach)
 * Should be called every server tick (30Hz)
 * @param dt Delta time in seconds (typically 0.033)
 */
void websocket_server_tick(float dt);

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

/**
 * Get WebSocket ships data for admin panel
 * @param out_ships Pointer to receive ships array
 * @param out_count Pointer to receive ship count
 * @return 0 on success, -1 on error
 */
int websocket_server_get_ships(SimpleShip** out_ships, int* out_count);

/**
 * Get WebSocket players data for admin panel
 * @param out_players Pointer to receive players array
 * @param out_count Pointer to receive active player count
 * @return 0 on success, -1 on error
 */
int websocket_server_get_players(WebSocketPlayer** out_players, int* out_count);