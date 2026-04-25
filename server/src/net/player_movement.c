#include <math.h>
#include <string.h>
#include <stdio.h>
#define _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "net/websocket_server_internal.h"
#include "net/player_movement.h"
#include "sim/island.h"

// Global movement tracking for adaptive tick rate
uint32_t g_last_movement_time = 0;

void update_movement_activity(void) {
    g_last_movement_time = get_time_ms();
}

void debug_player_state(void) {
    // Debug function - logging disabled
}

