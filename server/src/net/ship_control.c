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

/** Returns true if a friendly rigger (same company as player_company_id, or neutral NPC)
 *  is stationed at mast_id. A neutral NPC (company 0) obeys any player.
 *  A player with company 0 can only command neutral NPCs. */
static bool is_mast_manned_by_friendly(uint16_t ship_id, uint32_t mast_id, uint8_t player_company_id) {
    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* w = &world_npcs[i];
        if (!w->active || w->ship_id != ship_id) continue;
        if (w->role != NPC_ROLE_RIGGER) continue;
        if (w->assigned_weapon_id != mast_id) continue;
        if (w->state != WORLD_NPC_STATE_AT_GUN) continue;
        // A rigger is here — is it friendly?
        if (w->company_id == 0) return true;            // neutral obeys anyone
        if (player_company_id != 0 &&
            w->company_id == player_company_id) return true;  // same company
        return false;  // enemy rigger
    }
    return false;  // no rigger at this mast
}

/**
 * Handle sail openness control from helm-mounted player
 * Sets the desired openness - actual openness will gradually adjust in tick
 */
void handle_ship_sail_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, int desired_openness) {
/* Gate: at least one friendly rigger must be stationed at a mast before allowing sail control.
     * Enemy/neutral-to-player riggers on a mast cannot be commanded. */
    {
        bool any_rigger = false;
        for (int m = 0; m < ship->module_count && !any_rigger; m++) {
            if (ship->modules[m].type_id == MODULE_TYPE_MAST)
                any_rigger = is_mast_manned_by_friendly(ship->ship_id, ship->modules[m].id, player->company_id);
        }
        if (!any_rigger) {
            log_info("⛵ Sail control rejected for player %u — no friendly rigger manning any mast on ship %u",
                     player->player_id, ship->ship_id);
            return;
        }
    }

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
 * Handle sail angle control from helm-mounted player
 */
void handle_ship_sail_angle_control(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, float desired_angle) {
    // Clamp to range -60 to +60 degrees
    if (desired_angle < -60.0f) desired_angle = -60.0f;
    if (desired_angle > 60.0f) desired_angle = 60.0f;

    // log_info("🌀 Player %u adjusting sail angle on ship %u: %.1f° (manned masts only)", player->player_id, ship->ship_id, desired_angle);

    // Convert to radians for Q16 storage
    float angle_radians = desired_angle * (3.14159f / 180.0f);
    q16_t angle_q16 = Q16_FROM_FLOAT(angle_radians);

    // Update simulation ship masts — only those with a rigger stationed at them
    {
        struct Ship* sim_ship = find_sim_ship(ship->ship_id);
        if (sim_ship) {
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                if (sim_ship->modules[m].type_id == MODULE_TYPE_MAST &&
                    is_mast_manned_by_friendly(ship->ship_id, sim_ship->modules[m].id, player->company_id)) {
                    sim_ship->modules[m].data.mast.angle = angle_q16;
                }
            }
        }
    }

    // Also update SimpleShip for compatibility (manned masts only)
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].type_id == MODULE_TYPE_MAST &&
            is_mast_manned_by_friendly(ship->ship_id, ship->modules[i].id, player->company_id)) {
            ship->modules[i].data.mast.angle = angle_q16;
        }
    }

    // Persist desired angle so rigger NPCs can apply it when they arrive at a mast
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
