#pragma once
#include "net/websocket_server.h"

int  craft_count_item(WebSocketPlayer* player, ItemKind item);
bool craft_consume(WebSocketPlayer* player, ItemKind item, int amount);
bool craft_grant(WebSocketPlayer* player, ItemKind item, int amount);
void handle_craft_item(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
