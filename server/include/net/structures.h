#pragma once
#include "net/websocket_server.h"

void handle_place_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_structure_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_shipyard_action(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_demolish_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_demolish_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_salvage_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/**
 * Shared structure destruction helper. Marks the structure with the given ID
 * inactive, broadcasts structure_demolished, then cascade-destroys any dependent
 * structures (workbenches/walls/ceilings/doors). Finally compacts inactive
 * entries out of placed_structures[]. Safe to call from any path.
 */
void destroy_placed_structure(uint32_t structure_id);

/**
 * Apply damage to a placed structure. Subtracts dmg from hp (clamped to 0),
 * broadcasts structure_hp_changed on partial damage, and calls
 * destroy_placed_structure on death. Returns true if the structure was destroyed.
 * The pointer s may be invalidated after this call returns true.
 */
bool apply_structure_damage(PlacedStructure *s, uint16_t dmg);
