#pragma once
#include "net/websocket_server_internal.h"
#include "sim/island.h"

void handle_harvest_resource(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_fiber(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_rock(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_stone(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_boulder(WebSocketPlayer* player, struct WebSocketClient* client);

/** Returns the IslandDef for the island the player is currently on, or NULL. */
const IslandDef *get_island_for_player(const WebSocketPlayer *player);

/**
 * Finds the nearest resource of the given type within range_sq (squared px).
 * Returns the resource index into isl->resources[], or -1 if none found.
 */
int find_nearest_resource(const IslandDef *isl, float px, float py,
                          int res_type, float range_sq);
