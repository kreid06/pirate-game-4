#include <string.h>
#include <stdio.h>
#include "net/websocket_server_internal.h"
#include "net/ship_control.h"
#include "net/npc_world.h"

bool is_mast_manned(uint16_t ship_id, uint32_t mast_id) {
    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* w = &world_npcs[i];
        if (!w->active || w->ship_id != ship_id) continue;
        if (w->role == NPC_ROLE_RIGGER &&
            w->assigned_weapon_id == mast_id &&
            w->state == WORLD_NPC_STATE_AT_GUN)
            return true;
    }
    return false;
}

/**
 * Handle sail openness control from helm-mounted player
 * Sets the desired openness - actual openness will gradually adjust in tick
 */
void handle_ship_sail_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, int desired_openness) {
    (void)player; /* no per-player gate — any helmsman can control sails */

    if (desired_openness < 0) desired_openness = 0;
    if (desired_openness > 100) desired_openness = 100;

    // log_info("⛵ Player %u setting desired sail openness on ship %u: %d%% (applies to manned masts only)",
    //          player->player_id, ship->ship_id, desired_openness);

    // Store desired openness — the tick will only apply it to individually manned masts
    {
        struct Ship* _ss = find_sim_ship(ship->ship_id);
        if (_ss) _ss->desired_sail_openness = (uint8_t)desired_openness;
    }

    // Also store in simple ship for compatibility
    ship->desired_sail_openness = (uint8_t)desired_openness;
    
    // Send acknowledgment
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"ship_control_ack\",\"control\":\"sail\",\"value\":%d}",
             desired_openness);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Handle rudder control from helm-mounted player
 * Sets target rudder angle - actual angle will gradually adjust in tick
 */
void handle_ship_rudder_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, bool turning_left, bool turning_right, bool moving_backward) {
    (void)player;
    const char* direction = "STRAIGHT";
    float target_angle = 0.0f;
    
    if (turning_left && !turning_right) {
        direction = "LEFT";
        target_angle = -50.0f;  // Max left rudder angle
    } else if (turning_right && !turning_left) {
        direction = "RIGHT";
        target_angle = 50.0f;   // Max right rudder angle
    } else {
        direction = "STRAIGHT";
        target_angle = 0.0f;    // Center rudder
    }
    
    // Update simulation ship target rudder angle and reverse flag
    {
        struct Ship* _ss = find_sim_ship(ship->ship_id);
        if (_ss) _ss->target_rudder_angle = target_angle;
    }
    ship->reverse_thrust = moving_backward;
    
    // Send acknowledgment
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"ship_control_ack\",\"control\":\"rudder\",\"direction\":\"%s\"}",
             direction);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Normalize helm control inputs to neutral.
 * Called whenever a player leaves the helm (dismount, death, disconnect).
 * Rudder is centred and reverse thrust cleared; sail openness is left as-is
 * so the sails remain deployed at whatever setting the helmsman last used.
 */
void helm_release_controls(uint16_t ship_id) {
    if (!ship_id) return;

    /* Sim ship carries rudder angles */
    struct Ship* sim = find_sim_ship(ship_id);
    if (sim) {
        sim->target_rudder_angle = 0.0f;
        sim->rudder_angle        = 0.0f;
    }

    /* SimpleShip carries reverse_thrust */
    SimpleShip* ss = find_ship(ship_id);
    if (ss) {
        ss->reverse_thrust = false;
    }
}

/**
 * Handle sail angle control from helm-mounted player
 */
void handle_ship_sail_angle_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, float desired_angle) {
    (void)player;
    // Clamp to range -60 to +60 degrees
    if (desired_angle < -60.0f) desired_angle = -60.0f;
    if (desired_angle > 60.0f) desired_angle = 60.0f;

    // log_info("🌀 Player %u adjusting sail angle on ship %u: %.1f° (manned masts only)", player->player_id, ship->ship_id, desired_angle);

    // Convert to radians and persist as target angle.  Rigger NPCs will steer
    // manned masts toward this value gradually in tick_npc_agents().
    float angle_radians = desired_angle * (3.14159f / 180.0f);
    ship->desired_sail_angle = angle_radians;
    
    // Send acknowledgment
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"ship_control_ack\",\"control\":\"sail_angle\",\"value\":%.1f}",
             desired_angle);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}
