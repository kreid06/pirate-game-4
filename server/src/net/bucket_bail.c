#include "net/bucket_bail.h"
#include "net/websocket_server_internal.h"
#include "core/math.h"
#include "sim/module_types.h"
#include "util/time.h"
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

static bool dist2d(float ax, float ay, float bx, float by, float max_dist) {
    float dx = ax - bx;
    float dy = ay - by;
    return (dx * dx + dy * dy) <= (max_dist * max_dist);
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
        uint8_t idx = mod->data.gunport.snap_idx;
        float gx, gy;
        if (idx < 12) {
            gx = GUNPORT_SNAP_X[idx];
            gy = GUNPORT_SNAP_Y[idx];
        } else {
            gx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
            gy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        }
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
