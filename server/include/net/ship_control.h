#pragma once
#include "net/websocket_server.h"

struct WebSocketClient;

bool is_mast_manned(uint16_t ship_id, uint32_t mast_id);
void handle_ship_sail_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, int desired_openness);
void handle_ship_rudder_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, bool turning_left, bool turning_right, bool moving_backward);
void handle_ship_sail_angle_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, float desired_angle);

/**
 * Normalize all helm control inputs to neutral when a player leaves the helm
 * or dies while controlling a ship.  Resets rudder and reverse thrust to zero;
 * sail openness is intentionally left unchanged so the sails stay set.
 */
void helm_release_controls(uint16_t ship_id);