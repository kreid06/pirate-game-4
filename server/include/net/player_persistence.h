#pragma once
#include "net/websocket_server.h"

void     save_player_to_file(const WebSocketPlayer* player);
bool     load_player_from_file(WebSocketPlayer* player);
/** Returns the stored player_id from a save file for the given name, or 0 if not found. */
uint32_t peek_saved_player_id(const char *name);
