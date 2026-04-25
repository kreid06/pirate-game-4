#pragma once
#include "net/websocket_server.h"

bool craft_grant(WebSocketPlayer* player, ItemKind item, int amount);
void handle_craft_item(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
