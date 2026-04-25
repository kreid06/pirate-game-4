#pragma once

// Internal header shared by all websocket_server split-out modules.
// Provides access to the global state and helper function declarations.

#include "net/websocket_server.h"
#include "sim/simulation.h"
#include "sim/island.h"
#include <stdbool.h>
#include <stdint.h>

// ── Constants ─────────────────────────────────────────────────────────────────

#define WS_MAX_CLIENTS    100
#define MAX_SIMPLE_SHIPS  50

// ── Internal struct definitions ───────────────────────────────────────────────
// These are defined only in websocket_server.c but needed by split-out modules.

struct WebSocketClient {
    int fd;
    bool connected;
    bool handshake_complete;
    uint32_t last_ping_time;
    char ip_address[16]; // INET_ADDRSTRLEN
    uint16_t port;
    uint32_t player_id;
    uint16_t pending_group_broadcast_ship_id;
    uint8_t  pending_group_broadcast_company_id;
    char recv_buf[65536];
    size_t recv_buf_len;
    char frag_buf[4096];
    size_t frag_buf_len;
    uint8_t frag_opcode;
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

// ── Global state (defined in websocket_server.c) ──────────────────────────────

extern struct WebSocketServer ws_server;
extern struct Sim* global_sim;

extern WebSocketPlayer players[];
extern int next_player_id;

extern NpcAgent npc_agents[];
extern int npc_count;
extern uint16_t next_npc_id;

extern WorldNpc world_npcs[];
extern int world_npc_count;
extern uint16_t next_world_npc_id;
extern bool g_npcs_dirty;

extern SimpleShip ships[];
extern int ship_count;
extern uint8_t next_ship_seq;

extern PlacedStructure placed_structures[];
extern uint32_t placed_structure_count;
extern uint16_t next_structure_id;

// ── Helper function declarations ──────────────────────────────────────────────

SimpleShip* find_ship(uint16_t ship_id);
struct Ship* find_sim_ship(uint32_t ship_id);
WebSocketPlayer* find_player(uint32_t player_id);
WebSocketPlayer* find_player_by_sim_id(entity_id sim_entity_id);

void ship_local_to_world(const SimpleShip* ship, float lx, float ly, float* wx, float* wy);
void ship_world_to_local(const SimpleShip* ship, float wx, float wy, float* lx, float* ly);
bool is_outside_deck(uint16_t ship_id, float local_x, float local_y);

void board_player_on_ship(WebSocketPlayer* player, SimpleShip* ship, float local_x, float local_y);
void dismount_player_from_ship(WebSocketPlayer* player, const char* reason);

void websocket_server_broadcast(const char* message);

// Additional includes needed by extracted modules
#include "net/websocket_protocol.h"
#include "sim/module_types.h"
#include "sim/ship_level.h"
#include "util/time.h"
#include "util/log.h"

// ── Non-static helpers (implemented in websocket_server.c, accessible to all modules) ──
bool is_allied(uint8_t a, uint8_t b);
void send_cannon_group_state_to_client(struct WebSocketClient* client, SimpleShip* ship);
WeaponGroup* find_weapon_group(uint16_t ship_id, uint32_t cannon_id, uint8_t company_id);
void fire_swivel(SimpleShip* ship, ShipModule* sw, ShipModule* gsw, WebSocketPlayer* player, uint8_t ammo_type);
bool craft_grant(WebSocketPlayer* player, ItemKind item, int amount);
