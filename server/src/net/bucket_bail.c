#include "net/bucket_bail.h"
#include "net/websocket_server_internal.h"
#include "core/math.h"
#include "sim/module_types.h"
#include "util/time.h"
#include "util/log.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

/* Gunport snap positions — must match client GUNPORT_SNAP_POINTS (ship-local px). */
static const float GUNPORT_SNAP_X[12] = {
     152.5f,  77.5f,   2.5f, -72.5f, -147.5f, -222.5f,
     152.5f,  77.5f,   2.5f, -72.5f, -147.5f, -222.5f
};
static const float GUNPORT_SNAP_Y[12] = {
    -90.0f, -90.0f, -90.0f, -90.0f, -90.0f, -90.0f,
     90.0f,  90.0f,  90.0f,  90.0f,  90.0f,  90.0f
};

static float hull_health_pct(const struct Ship* ship) {
    if (!ship) return 100.0f;
    return Q16_TO_FLOAT(ship->hull_health);
}

static float water_fill(const struct Ship* ship) {
    float hp = hull_health_pct(ship);
    if (hp >= 100.0f) return 0.0f;
    if (hp <= 0.0f)   return 1.0f;
    return 1.0f - hp / 100.0f;
}

static float dist2d_sq(float ax, float ay, float bx, float by) {
    float dx = ax - bx;
    float dy = ay - by;
    return dx * dx + dy * dy;
}

static void gunport_snap_pos(const ShipModule* mod, float* gx, float* gy) {
    uint8_t idx = mod->data.gunport.snap_idx;
    if (idx < 12) {
        *gx = GUNPORT_SNAP_X[idx];
        *gy = GUNPORT_SNAP_Y[idx];
    } else {
        *gx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        *gy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
    }
}

/** Nearest point on the hull polygon edge to (lx, ly). */
static void nearest_hull_edge_point(float lx, float ly, const struct Ship* ship,
                                    float* out_x, float* out_y) {
    *out_x = lx;
    *out_y = ly;
    int n = ship->hull_vertex_count;
    if (n < 3) return;

    float best_d_sq = 1e20f;
    float best_x = lx, best_y = ly;
    for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        float ax = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[i].x));
        float ay = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[i].y));
        float bx = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[j].x));
        float by = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[j].y));
        float edx = bx - ax, edy = by - ay;
        float len_sq = edx * edx + edy * edy;
        float t = 0.0f;
        if (len_sq > 1e-10f) {
            t = ((lx - ax) * edx + (ly - ay) * edy) / len_sq;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
        }
        float cx = ax + t * edx, cy = ay + t * edy;
        float d_sq = dist2d_sq(lx, ly, cx, cy);
        if (d_sq < best_d_sq) {
            best_d_sq = d_sq;
            best_x = cx;
            best_y = cy;
        }
    }
    *out_x = best_x;
    *out_y = best_y;
}

/** Walk target slightly inboard of the hull opening so the NPC stands inside the deck. */
static void gunport_stand_pos(float snap_x, float snap_y, float* out_x, float* out_y) {
    float mag = sqrtf(snap_x * snap_x + snap_y * snap_y);
    if (mag > 1.0f) {
        *out_x = snap_x - (snap_x / mag) * 35.0f;
        *out_y = snap_y - (snap_y / mag) * 35.0f;
    } else {
        *out_x = snap_x;
        *out_y = snap_y;
    }
}

static bool dist2d(float ax, float ay, float bx, float by, float max_dist) {
    return dist2d_sq(ax, ay, bx, by) <= (max_dist * max_dist);
}

static bool gunport_set_open(SimpleShip* simple, struct Ship* sim,
                              uint16_t gunport_id, uint8_t open) {
    if (!simple || !sim) return false;
    for (uint8_t m = 0; m < sim->module_count; m++) {
        if (sim->modules[m].type_id != MODULE_TYPE_GUNPORT) continue;
        if (sim->modules[m].id != gunport_id) continue;
        if (sim->modules[m].data.gunport.is_open == open) return true;

        sim->modules[m].data.gunport.is_open = open;
        for (uint8_t ms = 0; ms < simple->module_count; ms++) {
            if (simple->modules[ms].id == gunport_id) {
                simple->modules[ms].data.gunport.is_open = open;
                break;
            }
        }

        q16_t gp_y = sim->modules[m].local_pos.y;
        uint8_t gp_snap = sim->modules[m].data.gunport.snap_idx;
        q16_t cannon_new_y = open
            ? ((gp_y < 0) ? gp_y + Q16_FROM_FLOAT(1.0f) : gp_y - Q16_FROM_FLOAT(1.0f))
            : ((gp_y < 0) ? gp_y + Q16_FROM_FLOAT(4.0f) : gp_y - Q16_FROM_FLOAT(4.0f));
        for (uint8_t cm = 0; cm < sim->module_count; cm++) {
            if (sim->modules[cm].type_id != MODULE_TYPE_CANNON) continue;
            if (sim->modules[cm].data.cannon.gunport_snap_idx != gp_snap) continue;
            sim->modules[cm].local_pos.y = cannon_new_y;
            for (uint8_t cms = 0; cms < simple->module_count; cms++) {
                if (simple->modules[cms].id == sim->modules[cm].id) {
                    simple->modules[cms].local_pos.y = cannon_new_y;
                    break;
                }
            }
            break;
        }
        recalc_ship_mass(simple);

        char gp_bcast[160];
        snprintf(gp_bcast, sizeof(gp_bcast),
                 "{\"type\":\"gunport_state\",\"gunportId\":%u,\"isOpen\":%s,\"shipId\":%u,\"mass\":%.0f}",
                 (unsigned)gunport_id, open ? "true" : "false",
                 (unsigned)simple->ship_id, simple->mass);
        broadcast_json_all(gp_bcast);
        return true;
    }
    return false;
}

static bool fill_meets_threshold(float fill, float threshold) {
    return fill >= threshold - BUCKET_SCOOP_FILL_GRACE;
}

bool bucket_player_has_equipped(const WebSocketPlayer* player) {
    if (!player) return false;
    int slot = (int)player->inventory.active_slot;
    if (slot >= 0 && slot < INVENTORY_SLOTS) {
        if (player->inventory.slots[slot].item == ITEM_BUCKET
            && player->inventory.slots[slot].quantity > 0)
            return true;
    }
    /* Active slot desync — allow if the player still carries a bucket. */
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == ITEM_BUCKET
            && player->inventory.slots[s].quantity > 0)
            return true;
    }
    return false;
}

bool bucket_near_well(const struct Ship* ship, float local_x, float local_y) {
    if (!ship) return false;
    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_WELL) continue;
        if (mod->deck_id != 0) continue;
        float wx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float wy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        if (dist2d(local_x, local_y, wx, wy, BUCKET_PROXIMITY_PX))
            return true;
    }
    return false;
}

bool bucket_can_fill_at(WebSocketPlayer* player, struct Ship* ship,
                          uint8_t deck_level, bool at_well) {
    (void)deck_level;
    (void)at_well;
    if (!player || !ship || player->parent_ship_id == 0) return false;
    if (!bucket_player_has_equipped(player)) return false;
    if (player->bucket_fill > 0) return false;
    if (ship->flags & SHIP_FLAG_SCAFFOLDED) return false;

    const SimpleShip* ss = find_ship(player->parent_ship_id);
    if (ss && ss->company_id == COMPANY_GHOST) return false;

    float fill = water_fill(ship);
    if (fill <= 0.0f) return false;

    /* Server-authoritative: deck and well proximity come from player state only. */
    uint8_t auth_deck = player->deck_level;
    bool near_well = (auth_deck == 0
        && bucket_near_well(ship, player->local_x, player->local_y));

    if (auth_deck == 0) {
        if (near_well)
            return fill_meets_threshold(fill, BUCKET_WELL_SCOOP_FILL);
        return fill_meets_threshold(fill, BUCKET_LOWER_SCOOP_FILL);
    }

    if (auth_deck == 1) {
        return fill_meets_threshold(fill, BUCKET_UPPER_SCOOP_FILL);
    }

    return false;
}

bool bucket_can_fill(WebSocketPlayer* player, struct Ship* ship) {
    bool at_well = bucket_near_well(ship, player->local_x, player->local_y);
    return bucket_can_fill_at(player, ship, player->deck_level, at_well);
}

static bool near_open_gunport(const WebSocketPlayer* player, const struct Ship* ship) {
    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_GUNPORT) continue;
        if (!mod->data.gunport.is_open) continue;
        float gx, gy;
        gunport_snap_pos(mod, &gx, &gy);
        if (dist2d(player->local_x, player->local_y, gx, gy, BUCKET_PROXIMITY_PX))
            return true;
    }
    return false;
}

static bool near_missing_plank(const WebSocketPlayer* player, const struct Ship* ship) {
    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_PLANK) continue;
        if (mod->health > 0) continue; /* intact plank — not a hull opening */
        float px = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float py = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        if (dist2d(player->local_x, player->local_y, px, py, BUCKET_PROXIMITY_PX))
            return true;
    }
    return false;
}

/** Minimum distance (client px) from a ship-local point to the hull polygon edge. */
static float dist_to_hull_edge_client(float lx, float ly, const struct Ship* ship) {
    float min_dist_sq = 1e20f;
    int n = ship->hull_vertex_count;
    if (n < 3) return 1e20f;
    for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        float ax = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[i].x));
        float ay = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[i].y));
        float bx = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[j].x));
        float by = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[j].y));
        float edx = bx - ax, edy = by - ay;
        float len_sq = edx * edx + edy * edy;
        float t = 0.0f;
        if (len_sq > 1e-10f) {
            t = ((lx - ax) * edx + (ly - ay) * edy) / len_sq;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
        }
        float cx = ax + t * edx, cy = ay + t * edy;
        float ex = lx - cx, ey = ly - cy;
        float d  = ex * ex + ey * ey;
        if (d < min_dist_sq) min_dist_sq = d;
    }
    return sqrtf(min_dist_sq);
}

static bool near_hull_edge(const WebSocketPlayer* player, const struct Ship* ship) {
    if (!player || !ship) return false;
    return dist_to_hull_edge_client(player->local_x, player->local_y, ship)
           <= BUCKET_PROXIMITY_PX;
}

bool bucket_is_valid_dump_zone_at(const WebSocketPlayer* player, const struct Ship* ship,
                                   uint8_t deck_level) {
    if (!player || !ship || player->parent_ship_id == 0) return false;
    /* Dump validity is evaluated on the deck the player is actually standing on. */
    if (deck_level != player->deck_level) return false;
    if (deck_level == 1) return near_hull_edge(player, ship);
    if (deck_level == 0) {
        return near_open_gunport(player, ship) || near_missing_plank(player, ship);
    }
    return false;
}

bool bucket_is_valid_dump_zone(const WebSocketPlayer* player, const struct Ship* ship) {
    return bucket_is_valid_dump_zone_at(player, ship, player->deck_level);
}

float bucket_drain_amount(uint8_t fill_level) {
    if (fill_level >= 2) return BUCKET_BAIL_FULL_HP;
    if (fill_level >= 1) return BUCKET_BAIL_HALF_HP;
    return 0.0f;
}

bool bucket_apply_fill(WebSocketPlayer* player, struct Ship* ship, bool success,
                       uint8_t req_deck, bool req_at_well,
                       char* response, size_t resp_len) {
    uint32_t now = get_time_ms();
    if (player->bucket_cooldown_until_ms > now) {
        snprintf(response, resp_len,
                 "{\"type\":\"message_ack\",\"status\":\"bucket_fill_cooldown\","
                 "\"remainingMs\":%u}",
                 (unsigned)(player->bucket_cooldown_until_ms - now));
        return true;
    }
    if (!bucket_player_has_equipped(player)) {
        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"bucket_not_equipped\"}");
        return true;
    }
    if (player->bucket_fill > 0) {
        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"bucket_already_full\"}");
        return true;
    }

    (void)req_deck;
    (void)req_at_well;
    if (!bucket_can_fill(player, ship)) {
        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"bucket_no_water_source\"}");
        return true;
    }

    uint8_t fill_level = success ? 2u : 1u;
    float scoop_amount = bucket_drain_amount(fill_level);

    const SimpleShip* ss = find_ship(player->parent_ship_id);
    if (!ss || ss->company_id != COMPANY_GHOST) {
        float health = hull_health_pct(ship);
        health += scoop_amount;
        if (health > 100.0f) health = 100.0f;
        ship->hull_health = Q16_FROM_FLOAT(health);
    }

    player->bucket_fill = fill_level;
    player->bucket_cooldown_until_ms = now + BUCKET_FILL_COOLDOWN_MS;
    snprintf(response, resp_len,
             "{\"type\":\"message_ack\",\"status\":\"bucket_filled\","
             "\"bucketFill\":%u,\"success\":%s,\"amount\":%.1f}",
             (unsigned)player->bucket_fill, success ? "true" : "false",
             (double)scoop_amount);
    return true;
}

bool bucket_apply_dump(WebSocketPlayer* player, struct Ship* ship,
                       uint8_t req_deck,
                       char* response, size_t resp_len) {
    (void)req_deck; /* validity uses server deck_level + player position only */

    if (!bucket_player_has_equipped(player)) {
        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"bucket_not_equipped\"}");
        return true;
    }
    if (player->bucket_fill == 0) {
        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"bucket_empty\"}");
        return true;
    }
    if (ship->flags & SHIP_FLAG_SCAFFOLDED) {
        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"bucket_ship_scaffolded\"}");
        return true;
    }

    float amount = bucket_drain_amount(player->bucket_fill);
    bool valid = bucket_is_valid_dump_zone(player, ship);

    const SimpleShip* ss = find_ship(player->parent_ship_id);
    /* Valid dump: water left the ship when scooped; empty the bucket, hull unchanged.
     * Invalid dump: water spills on deck — return flood to hull by amount (4 full / 2 half). */
    if ((!ss || ss->company_id != COMPANY_GHOST) && !valid) {
        float health = hull_health_pct(ship);
        health -= amount;
        if (health < 0.0f) health = 0.0f;
        ship->hull_health = Q16_FROM_FLOAT(health);
    }

    player->bucket_fill = 0;

    if (valid) {
        snprintf(response, resp_len,
                 "{\"type\":\"message_ack\",\"status\":\"bucket_dumped\","
                 "\"amount\":%.1f,\"bucketFill\":0,\"valid\":true}",
                 (double)amount);
    } else {
        snprintf(response, resp_len,
                 "{\"type\":\"message_ack\",\"status\":\"bucket_dump_invalid\","
                 "\"amount\":%.1f,\"bucketFill\":0,\"valid\":false}",
                 (double)amount);
    }
    return true;
}

/* ── NPC bucket bailer helpers ─────────────────────────────────────────────── */

static bool npc_near_open_gunport(float lx, float ly, const struct Ship* ship) {
    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_GUNPORT) continue;
        if (!mod->data.gunport.is_open) continue;
        float gx, gy;
        gunport_snap_pos(mod, &gx, &gy);
        if (dist2d(lx, ly, gx, gy, BUCKET_PROXIMITY_PX)) return true;
    }
    return false;
}

static bool npc_near_closed_gunport(float lx, float ly, const struct Ship* ship,
                                    uint16_t* out_id) {
    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_GUNPORT) continue;
        if (mod->data.gunport.is_open) continue;
        float gx, gy;
        gunport_snap_pos(mod, &gx, &gy);
        if (dist2d(lx, ly, gx, gy, BUCKET_PROXIMITY_PX)) {
            if (out_id) *out_id = mod->id;
            return true;
        }
    }
    return false;
}

static bool npc_near_missing_plank(float lx, float ly, const struct Ship* ship) {
    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_PLANK) continue;
        if (mod->health > 0) continue;
        float px = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float py = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        if (dist2d(lx, ly, px, py, BUCKET_PROXIMITY_PX)) return true;
    }
    return false;
}

static bool npc_near_hull_edge(float lx, float ly, const struct Ship* ship) {
    return dist_to_hull_edge_client(lx, ly, ship) <= BUCKET_PROXIMITY_PX;
}

bool bucket_npc_can_fill(const WorldNpc* npc, const struct Ship* ship) {
    if (!npc || !ship || npc->ship_id == 0) return false;
    if (npc->bucket_fill > 0) return false;
    if (ship->flags & SHIP_FLAG_SCAFFOLDED) return false;

    float fill = water_fill(ship);
    if (fill <= 0.0f) return false;

    bool near_well = (npc->deck_level == 0
        && bucket_near_well(ship, npc->local_x, npc->local_y));

    if (npc->deck_level == 0) {
        if (near_well)
            return fill_meets_threshold(fill, BUCKET_WELL_SCOOP_FILL);
        return fill_meets_threshold(fill, BUCKET_LOWER_SCOOP_FILL);
    }
    if (npc->deck_level == 1) {
        return fill_meets_threshold(fill, BUCKET_UPPER_SCOOP_FILL);
    }
    return false;
}

bool bucket_npc_is_valid_dump_zone(const WorldNpc* npc, const struct Ship* ship) {
    if (!npc || !ship || npc->ship_id == 0) return false;
    if (npc->deck_level == 1) return npc_near_hull_edge(npc->local_x, npc->local_y, ship);
    if (npc->deck_level == 0) {
        return npc_near_open_gunport(npc->local_x, npc->local_y, ship)
            || npc_near_missing_plank(npc->local_x, npc->local_y, ship);
    }
    return false;
}

void bucket_npc_find_scoop_target(const WorldNpc* npc, const struct Ship* ship,
                                  float* out_x, float* out_y, uint8_t* out_deck) {
    *out_x = 0.0f;
    *out_y = 0.0f;
    *out_deck = npc ? npc->deck_level : 1;
    if (!npc || !ship) return;

    float fill = water_fill(ship);

    if (fill_meets_threshold(fill, BUCKET_WELL_SCOOP_FILL)) {
        for (uint8_t m = 0; m < ship->module_count; m++) {
            const ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_WELL || mod->deck_id != 0) continue;
            *out_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
            *out_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
            *out_deck = 0;
            return;
        }
    }

    if (fill_meets_threshold(fill, BUCKET_UPPER_SCOOP_FILL)) {
        *out_deck = 1;
        *out_x = 200.0f;
        *out_y = -75.0f;
        return;
    }

    *out_deck = 0;
    *out_x = 0.0f;
    *out_y = 0.0f;
}

void bucket_npc_find_dump_target(const WorldNpc* npc, const struct Ship* ship,
                                 float* out_x, float* out_y) {
    *out_x = 0.0f;
    *out_y = 0.0f;
    if (!npc || !ship) return;

    float lx = npc->local_x;
    float ly = npc->local_y;

    if (npc->deck_level == 1) {
        nearest_hull_edge_point(lx, ly, ship, out_x, out_y);
        return;
    }

    /* Lower deck: nearest dump opening — open gunport, closed gunport, or missing plank. */
    float best_d_sq = 1e20f;
    float best_x = 0.0f, best_y = 0.0f;
    bool found = false;

    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_GUNPORT) continue;
        float gx, gy, wx, wy;
        gunport_snap_pos(mod, &gx, &gy);
        gunport_stand_pos(gx, gy, &wx, &wy);
        float d_sq = dist2d_sq(lx, ly, wx, wy);
        if (!found || d_sq < best_d_sq) {
            found = true;
            best_d_sq = d_sq;
            best_x = wx;
            best_y = wy;
        }
    }

    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_PLANK || mod->health > 0) continue;
        float px = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float py = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        float d_sq = dist2d_sq(lx, ly, px, py);
        if (!found || d_sq < best_d_sq) {
            found = true;
            best_d_sq = d_sq;
            best_x = px;
            best_y = py;
        }
    }

    if (found) {
        *out_x = best_x;
        *out_y = best_y;
        return;
    }

    /* No hull openings — fall back to nearest hull edge (invalid dump on lower deck). */
    nearest_hull_edge_point(lx, ly, ship, out_x, out_y);
}

bool bucket_npc_try_open_nearby_gunport(WorldNpc* npc, struct Ship* ship) {
    if (!npc || !ship || npc->ship_id == 0) return false;
    SimpleShip* simple = find_ship(npc->ship_id);
    if (!simple) return false;

    uint16_t gunport_id = 0;
    if (!npc_near_closed_gunport(npc->local_x, npc->local_y, ship, &gunport_id))
        return false;

    if (!gunport_set_open(simple, ship, gunport_id, 1)) return false;
    log_info("🪣 NPC %u (%s) opened gunport %u for bucket dump (ship %u)",
             npc->id, npc->name, (unsigned)gunport_id, (unsigned)npc->ship_id);
    return true;
}

bool bucket_npc_apply_fill(WorldNpc* npc, struct Ship* ship) {
    if (!npc || !ship) return false;
    uint32_t now = get_time_ms();
    if (npc->bucket_cooldown_until_ms > now) return false;
    if (!bucket_npc_can_fill(npc, ship)) return false;

    float scoop_amount = bucket_drain_amount(2u);
    const SimpleShip* ss = find_ship(npc->ship_id);
    if (!ss || ss->company_id != COMPANY_GHOST) {
        float health = hull_health_pct(ship);
        health += scoop_amount;
        if (health > 100.0f) health = 100.0f;
        ship->hull_health = Q16_FROM_FLOAT(health);
    }

    npc->bucket_fill = 2;
    npc->bucket_cooldown_until_ms = now + BUCKET_FILL_COOLDOWN_MS;
    return true;
}

bool bucket_npc_apply_dump(WorldNpc* npc, struct Ship* ship) {
    if (!npc || !ship || npc->bucket_fill == 0) return false;
    if (ship->flags & SHIP_FLAG_SCAFFOLDED) return false;

    float amount = bucket_drain_amount(npc->bucket_fill);
    bool valid = bucket_npc_is_valid_dump_zone(npc, ship);

    const SimpleShip* ss = find_ship(npc->ship_id);
    if ((!ss || ss->company_id != COMPANY_GHOST) && !valid) {
        float health = hull_health_pct(ship);
        health -= amount;
        if (health < 0.0f) health = 0.0f;
        ship->hull_health = Q16_FROM_FLOAT(health);
    }

    npc->bucket_fill = 0;
    return true;
}
