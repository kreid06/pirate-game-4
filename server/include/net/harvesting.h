#pragma once
#include "net/websocket_server_internal.h"

void handle_harvest_resource(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_fiber(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_rock(WebSocketPlayer* player, struct WebSocketClient* client);
void handle_harvest_stone(WebSocketPlayer* player, struct WebSocketClient* client);
