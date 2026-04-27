#pragma once
#include <stdint.h>
#include "net/websocket_server.h"

extern uint32_t g_last_movement_time;

void update_movement_activity(void);
void debug_player_state(void);
