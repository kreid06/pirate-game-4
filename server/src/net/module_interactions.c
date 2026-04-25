#include <math.h>
#include <string.h>
#include <stdio.h>
#include <sys/socket.h>
#include "net/module_interactions.h"

// ============================================================================
// MODULE INTERACTION SYSTEM
// ============================================================================

/**
 * Get human-readable module type name
 */
static const char* get_module_type_name(ModuleTypeId type_id) {
    switch (type_id) {
        case MODULE_TYPE_CANNON: return "CANNON";
        case MODULE_TYPE_HELM: return "HELM";
        case MODULE_TYPE_MAST: return "MAST";
        case MODULE_TYPE_LADDER: return "LADDER";
        case MODULE_TYPE_SEAT: return "SEAT";
        case MODULE_TYPE_PLANK: return "PLANK";
        case MODULE_TYPE_DECK: return "DECK";
        case MODULE_TYPE_STEERING_WHEEL: return "STEERING_WHEEL";
        case MODULE_TYPE_SWIVEL: return "SWIVEL";
        default: return "UNKNOWN";
    }
}

/**
 * Returns true if any intact plank on `ship` blocks the line segment from
 * (ox,oy) to (tx,ty) in client-space units.
 *
 * Method: treat each plank as an infinite line defined by its centre + normal.
 * If the origin and target lie on opposite sides of that line AND the crossing
 * falls within the plank's estimated half-span, the plank occludes.
 */
static bool plank_occludes_ray(const SimpleShip* ship,
                                float ox, float oy,   /* flame origin */
                                float tx, float ty)   /* target position */
{
    const float PLANK_HALF_SPAN = 260.0f; /* generous half-length for brigantine planks */
    float cos_rs = cosf(ship->rotation);
    float sin_rs = sinf(ship->rotation);
    for (int pm = 0; pm < ship->module_count; pm++) {
        const ShipModule* pl = &ship->modules[pm];
        if (pl->type_id != MODULE_TYPE_PLANK) continue;
        if (pl->state_bits & MODULE_STATE_DESTROYED) continue;
        /* Plank centre in world space (client units) */
        float plx = SERVER_TO_CLIENT(Q16_TO_FLOAT(pl->local_pos.x));
        float ply = SERVER_TO_CLIENT(Q16_TO_FLOAT(pl->local_pos.y));
        float pwx = ship->x + (plx * cos_rs - ply * sin_rs);
        float pwy = ship->y + (plx * sin_rs + ply * cos_rs);
        /* Plank normal: perpendicular to the plank's lengthwise direction */
        float plank_angle = ship->rotation + Q16_TO_FLOAT(pl->local_rot);
        float nx = -sinf(plank_angle);
        float ny =  cosf(plank_angle);
        /* Signed distances of origin and target from plank's infinite line */
        float d_o = (ox - pwx) * nx + (oy - pwy) * ny;
        float d_t = (tx - pwx) * nx + (ty - pwy) * ny;
        /* Same side → no crossing */
        if (d_o * d_t >= 0.0f) continue;
        /* Intersection parameter t along origin→target */
        float denom = d_o - d_t;
        if (fabsf(denom) < 1e-4f) continue;
        float t = d_o / denom;
        if (t <= 0.0f || t >= 1.0f) continue;
        /* Intersection world point */
        float ix = ox + t * (tx - ox);
        float iy = oy + t * (ty - oy);
        /* Check along-plank extent */
        float cos_pa = cosf(plank_angle), sin_pa = sinf(plank_angle);
        float along = (ix - pwx) * cos_pa + (iy - pwy) * sin_pa;
        if (fabsf(along) <= PLANK_HALF_SPAN) return true;
    }
    return false;
}

/**
 * Find module by ID on a ship
 */
ShipModule* find_module_by_id(SimpleShip* ship, uint32_t module_id) {
    if (!ship) return NULL;
    
    for (int i = 0; i < ship->module_count; i++) {
        if (ship->modules[i].id == module_id) {
            return &ship->modules[i];
        }
    }
    return NULL;
}

/**
 * Send interaction failure to client
 */
static void send_interaction_failure(struct WebSocketClient* client, const char* reason) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_failure\",\"reason\":\"%s\"}",
             reason);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Send mount success to client
 */
static void send_mount_success(struct WebSocketClient* client, ShipModule* module) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"module_id\":%u,\"module_kind\":\"%s\",\"mounted\":true}",
             module->id, get_module_type_name(module->type_id));
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Send mount success with a local-space mount offset so the client can
 * instantly snap the player to the correct position (e.g. swivel guns).
 */
static void send_mount_success_with_offset(struct WebSocketClient* client, ShipModule* module, float offset_x, float offset_y) {
    char response[320];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"module_id\":%u,\"module_kind\":\"%s\",\"mounted\":true,"
             "\"mount_offset\":{\"x\":%.2f,\"y\":%.2f}}",
             module->id, get_module_type_name(module->type_id), offset_x, offset_y);

    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Send interaction success (non-mounting actions)
 */
static void send_interaction_success(struct WebSocketClient* client, const char* action) {
    char response[256];
    snprintf(response, sizeof(response),
             "{\"type\":\"module_interact_success\",\"action\":\"%s\"}",
             action);
    
    char frame[512];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0) {
        send(client->fd, frame, frame_len, 0);
    }
}

/**
 * Broadcast player mounted state to nearby players
 */
static void broadcast_player_mounted(WebSocketPlayer* player, ShipModule* module, SimpleShip* ship) {
    char message[512];
    snprintf(message, sizeof(message),
             "{\"type\":\"player_mounted\",\"player_id\":%u,\"module_id\":%u,\"ship_id\":%u}",
             player->player_id, module->id, ship->ship_id);
    
    // Broadcast to all connected clients
    // TODO: Optimize to only send to nearby players
    websocket_server_broadcast(message);
}

// Module-specific interaction handlers
static void handle_cannon_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Check if cannon is already occupied by someone else
    if (module->state_bits & MODULE_STATE_OCCUPIED) {
        uint16_t occupier_id = 0; // TODO: Track which player occupies
        if (occupier_id != 0 && occupier_id != player->player_id) {
            log_info("Cannon %u already occupied by player %u", module->id, occupier_id);
            send_interaction_failure(client, "module_occupied");
            return;
        }
    }

    // NPC occupancy check: block mounting if an enemy NPC gunner is stationed here.
    for (int _ni = 0; _ni < world_npc_count; _ni++) {
        WorldNpc* _npc = &world_npcs[_ni];
        if (!_npc->active) continue;
        if (_npc->assigned_weapon_id != module->id) continue;
        if (_npc->state != WORLD_NPC_STATE_AT_GUN && _npc->state != WORLD_NPC_STATE_REPAIRING) continue;
        if (_npc->company_id == 0) continue;           // neutral never blocks
        if (player->company_id != 0 && _npc->company_id == player->company_id) continue; // friendly OK
        send_interaction_failure(client, "npc_occupied");
        return;
    }

    /* Company check: cannot mount a cannon on an enemy ship */
    if (ship->company_id != COMPANY_NEUTRAL &&
        player->company_id != COMPANY_NEUTRAL &&
        player->company_id != ship->company_id) {
        send_interaction_failure(client, "wrong_company");
        return;
    }

    // Mount player to cannon
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;

    // Snap player directly behind the cannon barrel.
    // The barrel's natural firing angle in ship-local space is (local_rot - PI/2).
    // "Behind" = opposite direction, offset CANNON_MOUNT_DIST px away from barrel tip.
    {
        float cannon_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float cannon_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        float barrel_angle   = Q16_TO_FLOAT(module->local_rot) - (float)(M_PI / 2.0);
        const float CANNON_MOUNT_DIST = 25.0f; // client pixels behind breech
        player->local_x = cannon_local_x - cosf(barrel_angle) * CANNON_MOUNT_DIST;
        player->local_y = cannon_local_y - sinf(barrel_angle) * CANNON_MOUNT_DIST;
        ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);
    }

    log_info("🎯 Player %u mounted to cannon %u at local (%.1f, %.1f)",
             player->player_id, module->id, player->local_x, player->local_y);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
    /* Push current group config to the player mounting a cannon so they can
     * immediately see which group (if any) this cannon belongs to. */
    send_cannon_group_state_to_client(client, ship);
}

static void handle_helm_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // log_info("🎮 handle_helm_interact called for player %u, module %u", player->player_id, module->id);
    
    // Check if helm is occupied
    if (module->data.helm.occupied_by != 0 && module->data.helm.occupied_by != player->player_id) {
        log_info("Helm %u already occupied by player %u", module->id, module->data.helm.occupied_by);
        send_interaction_failure(client, "module_occupied");
        return;
    }

    // NPC occupancy check: if an enemy NPC helmsman is stationed at this helm, block mounting.
    for (int _ni = 0; _ni < world_npc_count; _ni++) {
        WorldNpc* _npc = &world_npcs[_ni];
        if (!_npc->active) continue;
        if (_npc->assigned_weapon_id != module->id) continue;
        if (_npc->state != WORLD_NPC_STATE_AT_GUN && _npc->state != WORLD_NPC_STATE_REPAIRING) continue;
        if (_npc->company_id == 0) continue;  // neutral never blocks
        if (player->company_id != 0 && _npc->company_id == player->company_id) continue;  // friendly OK
        send_interaction_failure(client, "npc_occupied");
        return;
    }

    // Mount player and grant ship control
    module->data.helm.occupied_by = player->player_id;
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;
    player->controlling_ship_id = ship->ship_id;
    
    // Position player at mounted location relative to helm
    // Helm mounted position: x:-10, y:0 in client coordinates
    const float HELM_MOUNT_OFFSET_X = -10.0f;
    const float HELM_MOUNT_OFFSET_Y = 0.0f;
    
    // Calculate player's local position as helm position + offset
    // Convert module position from server Q16 to client coordinates
    float helm_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float helm_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    player->local_x = helm_local_x + HELM_MOUNT_OFFSET_X;
    player->local_y = helm_local_y + HELM_MOUNT_OFFSET_Y;
    
    // Update world position based on ship transform
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);
    
    log_info("⚓ Player %u mounted to helm %u at local (%.1f, %.1f), controlling ship %u", 
             player->player_id, module->id, player->local_x, player->local_y, ship->ship_id);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
    /* Push current group config to the newly-mounted helm player so they see
     * any groups configured by a previous helmsman without needing a resync. */
    send_cannon_group_state_to_client(client, ship);
}

static void handle_mast_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // If already mounted here, treat a second interact as a sail toggle
    if (player->is_mounted && player->mounted_module_id == module->id) {
        if (module->state_bits & MODULE_STATE_DEPLOYED) {
            module->state_bits &= ~MODULE_STATE_DEPLOYED;
            module->data.mast.openness = 0;
            log_info("⛵ Player %u furled mast %u sail", player->player_id, module->id);
        } else {
            module->state_bits |= MODULE_STATE_DEPLOYED;
            module->data.mast.openness = 100;
            log_info("⛵ Player %u deployed mast %u sail", player->player_id, module->id);
        }
        send_interaction_success(client, "sail_toggled");
        char message[256];
        snprintf(message, sizeof(message),
                 "{\"type\":\"sail_state\",\"ship_id\":%u,\"module_id\":%u,\"deployed\":%s}",
                 ship->ship_id, module->id, (module->state_bits & MODULE_STATE_DEPLOYED) ? "true" : "false");
        websocket_server_broadcast(message);
        return;
    }

    // Check if already occupied by someone else
    if ((module->state_bits & MODULE_STATE_OCCUPIED) && !(player->is_mounted && player->mounted_module_id == module->id)) {
        send_interaction_failure(client, "module_occupied");
        return;
    }

    // Mount the player to the mast
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;

    // Snap player to port side of the mast (offset +20px in local Y)
    float mast_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float mast_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    player->local_x = mast_local_x;
    player->local_y = mast_local_y + 20.0f;
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);

    log_info("⛵ Player %u mounted to mast %u at local (%.1f, %.1f)",
             player->player_id, module->id, player->local_x, player->local_y);

    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
}

static void handle_ladder_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Check if ladder is retracted — nobody can board via a retracted ladder
    if (module->state_bits & MODULE_STATE_RETRACTED) {
        send_interaction_failure(client, "ladder_retracted");
        return;
    }
    // Check if player is already on this ship — pressing E at a ladder toggles its retract state.
    // Any player already on the ship can do this; no company check.
    if (player->parent_ship_id == ship->ship_id) {
        bool now_retracted = !(module->state_bits & MODULE_STATE_RETRACTED);
        if (now_retracted)
            module->state_bits |= MODULE_STATE_RETRACTED;
        else
            module->state_bits &= ~(uint16_t)MODULE_STATE_RETRACTED;
        // Mirror state change into the simulation ship module array
        {
            struct Ship* _lss = find_sim_ship(ship->ship_id);
            if (_lss) {
                for (uint8_t _m = 0; _m < _lss->module_count; _m++) {
                    if (_lss->modules[_m].id == module->id) {
                        if (now_retracted)
                            _lss->modules[_m].state_bits |= MODULE_STATE_RETRACTED;
                        else
                            _lss->modules[_m].state_bits &= ~(uint16_t)MODULE_STATE_RETRACTED;
                        break;
                    }
                }
            }
        }
        log_info("🪜 Player %u toggled ladder %u on ship %u → %s (via E-interact)",
                 player->player_id, module->id, ship->ship_id,
                 now_retracted ? "RETRACTED" : "EXTENDED");
        char lad_msg[192];
        snprintf(lad_msg, sizeof(lad_msg),
                 "{\"type\":\"ladder_state\",\"ship_id\":%u,\"module_id\":%u,\"retracted\":%s}",
                 ship->ship_id, module->id, now_retracted ? "true" : "false");
        websocket_server_broadcast(lad_msg);
        send_interaction_success(client, now_retracted ? "ladder_retracted" : "ladder_extended");
        return;
    }
    
    // Player is swimming or on another ship — board via ladder.
    // Any player may board an unretracted ladder; no company restriction.
    if (player->parent_ship_id == 0) {
        // Get ladder position in ship-local coordinates (convert from server to client)
        float ladder_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float ladder_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        
        // Board player at ladder position (or nearby safe spot)
        board_player_on_ship(player, ship, ladder_local_x, ladder_local_y);
        
        log_info("🪜 Player %u boarded ship %u via ladder %u", 
                 player->player_id, ship->ship_id, module->id);
        
        // Send success response
        char response[256];
        snprintf(response, sizeof(response),
                 "{\"type\":\"player_boarded\",\"ship_id\":%u,\"state\":\"walking\"}",
                 ship->ship_id);
        
        char frame[512];
        size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
        if (frame_len > 0) {
            send(client->fd, frame, frame_len, 0);
        }
        
        // Broadcast boarding event to all players
        char broadcast[256];
        snprintf(broadcast, sizeof(broadcast),
                 "{\"type\":\"player_state_changed\",\"player_id\":%u,\"state\":\"walking\",\"ship_id\":%u}",
                 player->player_id, ship->ship_id);
        websocket_server_broadcast(broadcast);

        /* Unicast current weapon group config to the newly boarded player so
         * they see the ship's authoritative group state right away. */
        send_cannon_group_state_to_client(client, ship);
    } else {
        // Player is on a different ship - transfer them
        log_info("🪜 Player %u transferring from ship %u to ship %u via ladder",
                 player->player_id, player->parent_ship_id, ship->ship_id);
        
        float ladder_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
        float ladder_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
        
        board_player_on_ship(player, ship, ladder_local_x, ladder_local_y);
        send_interaction_success(client, "ship_transfer");
        /* Unicast group state after ship transfer too. */
        send_cannon_group_state_to_client(client, ship);
    }
}

static void handle_swivel_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Reject if already occupied by another player
    if (module->state_bits & MODULE_STATE_OCCUPIED) {
        send_interaction_failure(client, "module_occupied");
        return;
    }

    // NPC occupancy check: block mounting if an enemy NPC gunner is stationed here.
    for (int _ni = 0; _ni < world_npc_count; _ni++) {
        WorldNpc* _npc = &world_npcs[_ni];
        if (!_npc->active) continue;
        if (_npc->assigned_weapon_id != module->id) continue;
        if (_npc->state != WORLD_NPC_STATE_AT_GUN && _npc->state != WORLD_NPC_STATE_REPAIRING) continue;
        if (_npc->company_id == 0) continue;           // neutral never blocks
        if (player->company_id != 0 && _npc->company_id == player->company_id) continue; // friendly OK
        send_interaction_failure(client, "npc_occupied");
        return;
    }

    /* Company check: cannot mount a swivel on an enemy ship */
    if (ship->company_id != COMPANY_NEUTRAL &&
        player->company_id != COMPANY_NEUTRAL &&
        player->company_id != ship->company_id) {
        send_interaction_failure(client, "wrong_company");
        return;
    }

    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;

    // Snap player inward from the swivel toward the ship center.
    // Mount offset = normalize(-swivel_pos) * SWIVEL_MOUNT_DIST (client pixels).
    float swivel_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float swivel_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    float vec_x = -swivel_local_x;
    float vec_y = -swivel_local_y;
    float mag = sqrtf(vec_x * vec_x + vec_y * vec_y);
    const float SWIVEL_MOUNT_DIST = 18.0f; // client pixels inward from swivel pivot
    float offset_x = 0.0f, offset_y = 0.0f;
    if (mag > 1.0f) {
        offset_x = (vec_x / mag) * SWIVEL_MOUNT_DIST;
        offset_y = (vec_y / mag) * SWIVEL_MOUNT_DIST;
    }

    player->local_x = swivel_local_x + offset_x;
    player->local_y = swivel_local_y + offset_y;
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);

    log_info("🔫 Player %u mounted to swivel %u at local (%.1f, %.1f) (offset %.1f,%.1f)",
             player->player_id, module->id, player->local_x, player->local_y, offset_x, offset_y);

    send_mount_success_with_offset(client, module, offset_x, offset_y);
    broadcast_player_mounted(player, module, ship);
}

/**
 * Handle a swivel_aim message from a mounted player.
 * Converts the ship-relative aim angle into a barrel offset from the swivel's
 * natural direction, then clamps to the lateral limit of ±45°.
 */
void handle_swivel_aim(WebSocketPlayer* player, float aim_angle) {
    if (!player->is_mounted || player->parent_ship_id == 0) return;

    SimpleShip* ship = find_ship(player->parent_ship_id);
    if (!ship) return;

    /* Defense-in-depth: refuse aim if player company doesn't match ship company */
    if (ship->company_id != COMPANY_NEUTRAL &&
        player->company_id != COMPANY_NEUTRAL &&
        player->company_id != ship->company_id) return;

    ShipModule* module = find_module_by_id(ship, player->mounted_module_id);
    if (!module || module->type_id != MODULE_TYPE_SWIVEL) return;

    /* Natural barrel direction in ship space = local_rot - π/2.
     * Mirrors the cannon convention: barrel is at -Y in local frame,
     * so in ship frame it sits at (local_rot - π/2). */
    float swivel_base  = Q16_TO_FLOAT(module->local_rot);
    float desired_offset = aim_angle - swivel_base + (float)(M_PI / 2.0);

    /* Normalise to -π … +π */
    while (desired_offset >  (float)M_PI) desired_offset -= 2.0f * (float)M_PI;
    while (desired_offset < -(float)M_PI) desired_offset += 2.0f * (float)M_PI;

    /* Clamp to ±45° lateral limit */
    const float SWIVEL_AIM_LIMIT = 45.0f * ((float)M_PI / 180.0f);
    if (desired_offset >  SWIVEL_AIM_LIMIT) desired_offset =  SWIVEL_AIM_LIMIT;
    if (desired_offset < -SWIVEL_AIM_LIMIT) desired_offset = -SWIVEL_AIM_LIMIT;

    module->data.swivel.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);

    /* Mirror into global_sim so sim-path snapshots see the updated target */
    {
        struct Ship* _ss = find_sim_ship(ship->ship_id);
        if (_ss) {
            for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                if (_ss->modules[mi].id == module->id) {
                    _ss->modules[mi].data.swivel.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                    break;
                }
            }
        }
    }

    log_info("🔫 swivel_aim: player %u swivel %u → %.1f°",
             player->player_id, module->id,
             desired_offset * 180.0f / (float)M_PI);
}

static void handle_seat_interact(WebSocketPlayer* player, struct WebSocketClient* client, SimpleShip* ship, ShipModule* module) {
    // Check if seat is occupied
    if (module->data.seat.occupied_by != 0 && module->data.seat.occupied_by != player->player_id) {
        send_interaction_failure(client, "module_occupied");
        return;
    }
    
    module->data.seat.occupied_by = player->player_id;
    module->state_bits |= MODULE_STATE_OCCUPIED;
    player->is_mounted = true;
    player->mounted_module_id = module->id;
    
    log_info("💺 Player %u seated at %u", player->player_id, module->id);
    
    send_mount_success(client, module);
    broadcast_player_mounted(player, module, ship);
}

/**
 * Handle module unmount request from client
 */
void handle_module_unmount(WebSocketPlayer* player, struct WebSocketClient* client) {
    if (!player->is_mounted) {
        log_warn("Player %u tried to unmount but is not mounted", player->player_id);
        send_interaction_failure(client, "not_mounted");
        return;
    }
    
    // Find the module and ship
    SimpleShip* target_ship = NULL;
    ShipModule* module = NULL;
    
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active) {
            ShipModule* found_module = find_module_by_id(&ships[i], player->mounted_module_id);
            if (found_module) {
                target_ship = &ships[i];
                module = found_module;
                break;
            }
        }
    }
    
    if (module && target_ship) {
        // Clear module occupation
        switch (module->type_id) {
            case MODULE_TYPE_CANNON:
                // Cannons just use the OCCUPIED state bit
                module->state_bits &= ~MODULE_STATE_OCCUPIED;
                break;
            case MODULE_TYPE_HELM:
            case MODULE_TYPE_STEERING_WHEEL:
                module->data.helm.occupied_by = 0;
                player->controlling_ship_id = 0;
                break;
            case MODULE_TYPE_SEAT:
                module->data.seat.occupied_by = 0;
                break;
            default:
                module->state_bits &= ~MODULE_STATE_OCCUPIED;
                break;
        }
        
        log_info("🔓 Player %u unmounted from %s (ID: %u)", 
                 player->player_id, get_module_type_name(module->type_id), module->id);
    }
    
    // Clear player mount state
    player->is_mounted = false;
    player->mounted_module_id = 0;
    
    // Send success response
    send_interaction_success(client, "unmounted");
    
    // Broadcast unmount event
    char broadcast[512];
    snprintf(broadcast, sizeof(broadcast),
             "{\"type\":\"player_unmounted\",\"player_id\":%u}",
             player->player_id);
    websocket_server_broadcast(broadcast);
}

void handle_module_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    // Parse module_id from JSON
    uint32_t module_id = 0;
    char* module_id_start = strstr(payload, "\"module_id\":");
    if (module_id_start) {
        module_id_start += 12; // Skip past "module_id":
        module_id = (uint32_t)atoi(module_id_start);
    } else {
        log_error("module_interact missing module_id field");
        send_interaction_failure(client, "invalid_request");
        return;
    }
    
    log_info("🎮 [MODULE_INTERACT] Player %u -> Module %u", player->player_id, module_id);
    
    // For ladder interactions, we need to find which ship has this ladder
    // For other modules, player must be on the ship
    
    SimpleShip* target_ship = NULL;
    ShipModule* module = NULL;
    
    // Search all ships for the module
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active) {
            ShipModule* found_module = find_module_by_id(&ships[i], module_id);
            if (found_module) {
                target_ship = &ships[i];
                module = found_module;
                break;
            }
        }
    }
    
    if (!module || !target_ship) {
        log_warn("Module %u not found on any ship", module_id);
        send_interaction_failure(client, "module_not_found");
        return;
    }
    
    // Special handling for ladders - can be used from water or different ships
    bool is_ladder = (module->type_id == MODULE_TYPE_LADDER);

    // NPC occupancy check: if an enemy NPC is currently stationed at this module, block it.
    // (Enemy ship modules are otherwise freely usable — only NPC presence blocks access.)
    if (!is_ladder) {
        for (int _ni = 0; _ni < world_npc_count; _ni++) {
            WorldNpc* _npc = &world_npcs[_ni];
            if (!_npc->active) continue;
            if (_npc->assigned_weapon_id != module->id) continue;
            // Only block when the NPC is physically at the module, not just en route
            if (_npc->state != WORLD_NPC_STATE_AT_GUN &&
                _npc->state != WORLD_NPC_STATE_REPAIRING) continue;
            // Neutral NPCs (company 0) never block anyone
            if (_npc->company_id == 0) continue;
            // Friendly NPC — fine to share the module
            if (player->company_id != 0 && _npc->company_id == player->company_id) continue;
            // Enemy NPC is stationed here
            log_warn("⛔ Player %u (company %u) blocked from module %u: NPC %u (company %u) is stationed there",
                     player->player_id, player->company_id, module_id,
                     _npc->id, _npc->company_id);
            send_interaction_failure(client, "npc_occupied");
            return;
        }
    }

    // For non-ladder modules, player must be on the same ship
    if (!is_ladder && player->parent_ship_id != target_ship->ship_id) {
        if (player->parent_ship_id == 0) {
            log_warn("Player %u not on a ship, cannot interact with module %u", player->player_id, module_id);
            send_interaction_failure(client, "not_on_ship");
        } else {
            log_warn("Player %u on different ship, cannot interact with module %u on ship %u", 
                     player->player_id, module_id, target_ship->ship_id);
            send_interaction_failure(client, "wrong_ship");
        }
        return;
    }
    
    // Validate range
    float dx, dy, distance;
    float player_world_x, player_world_y, module_world_x, module_world_y;
    
    // Convert module position from Q16 to client coordinates
    float module_local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
    float module_local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
    
    // log_info("🔍 Module %u Q16 pos: (%d, %d)", module_id, module->local_pos.x, module->local_pos.y);
    // log_info("🔍 Module %u converted local pos: (%.1f, %.1f)", module_id, module_local_x, module_local_y);
    // log_info("🔍 Ship %u pos: (%.1f, %.1f), rot: %.3f", target_ship->ship_id, target_ship->x, target_ship->y, target_ship->rotation);
    // log_info("🔍 Player %u parent_ship_id: %u, local pos: (%.1f, %.1f), world pos: (%.1f, %.1f)", 
    //          player->player_id, player->parent_ship_id, player->local_x, player->local_y, player->x, player->y);
    
    if (player->parent_ship_id == target_ship->ship_id) {
        // Player on same ship - use ship-local coordinates
        // log_info("🔍 Using LOCAL coordinates (player on ship %u)", target_ship->ship_id);
        dx = player->local_x - module_local_x;
        dy = player->local_y - module_local_y;
        // log_info("🔍 Local distance: player (%.1f, %.1f) - module (%.1f, %.1f) = delta (%.1f, %.1f)", 
        //          player->local_x, player->local_y, module_local_x, module_local_y, dx, dy);
        
        // Calculate world coords for logging
        ship_local_to_world(target_ship, player->local_x, player->local_y, &player_world_x, &player_world_y);
        ship_local_to_world(target_ship, module_local_x, module_local_y, &module_world_x, &module_world_y);
    } else {
        // Player in water or on different ship - use world coordinates
        // log_info("🔍 Using WORLD coordinates (player in water or different ship)");
        ship_local_to_world(target_ship, module_local_x, module_local_y, &module_world_x, &module_world_y);
        dx = player->x - module_world_x;
        dy = player->y - module_world_y;
        // log_info("🔍 World distance: player (%.1f, %.1f) - module (%.1f, %.1f) = delta (%.1f, %.1f)", 
        //          player->x, player->y, module_world_x, module_world_y, dx, dy);
        
        player_world_x = player->x;
        player_world_y = player->y;
    }
    
    distance = sqrtf(dx * dx + dy * dy);
    // Ladders allow boarding from water — use a generous range; other modules require proximity
    const float MAX_INTERACT_RANGE = (module->type_id == MODULE_TYPE_LADDER) ? 120.0f : 60.0f;
    
    if (distance > MAX_INTERACT_RANGE) {
        log_warn("Player %u too far from module %u (%.1fpx > %.1fpx)", 
                 player->player_id, module_id, distance, MAX_INTERACT_RANGE);
        log_warn("  Player world pos: (%.1f, %.1f), Module world pos: (%.1f, %.1f)", 
                 player_world_x, player_world_y, module_world_x, module_world_y);
        send_interaction_failure(client, "out_of_range");
        return;
    }
    
    // Check module is active (not destroyed)
    if (module->state_bits & MODULE_STATE_DESTROYED) {
        log_warn("Module %u is destroyed, cannot interact", module_id);
        send_interaction_failure(client, "module_destroyed");
        return;
    }
    
    // Process interaction based on module type
    // log_info("✅ Player %u interacting with %s (ID: %u) at %.1fpx", 
    //          player->player_id, get_module_type_name(module->type_id), module_id, distance);
    
    switch (module->type_id) {
        case MODULE_TYPE_CANNON:
            handle_cannon_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL:
            handle_helm_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_MAST:
            handle_mast_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_LADDER:
            handle_ladder_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_SEAT:
            handle_seat_interact(player, client, target_ship, module);
            break;

        case MODULE_TYPE_SWIVEL:
            handle_swivel_interact(player, client, target_ship, module);
            break;
            
        case MODULE_TYPE_PLANK:
        case MODULE_TYPE_DECK:
            // Structural modules, no interaction
            log_warn("Cannot interact with structural module type %d", module->type_id);
            send_interaction_failure(client, "not_interactive");
            break;
            
        default:
            log_warn("Unhandled module type: %d", module->type_id);
            send_interaction_failure(client, "unknown_module_type");
            break;
    }
}
