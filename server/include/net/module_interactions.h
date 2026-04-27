#pragma once
#include "net/websocket_server_internal.h"

ShipModule* find_module_by_id(SimpleShip* ship, uint32_t module_id);
bool plank_occludes_ray(const SimpleShip* ship, float ox, float oy, float tx, float ty);
void send_interaction_failure(struct WebSocketClient* client, const char* reason);
void handle_module_unmount(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_swivel_aim(WebSocketPlayer* player, float aim_angle);
void handle_module_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
