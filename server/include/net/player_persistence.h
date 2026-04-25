#pragma once
#include "net/websocket_server.h"

void save_player_to_file(const WebSocketPlayer* player);
void load_player_from_file(WebSocketPlayer* player);
