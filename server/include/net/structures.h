#pragma once
#include "net/websocket_server.h"

void handle_place_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_structure_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_shipyard_action(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_demolish_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_demolish_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_salvage_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
