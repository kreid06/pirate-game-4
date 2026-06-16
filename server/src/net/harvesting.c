#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include "net/harvesting.h"
#include "net/websocket_server_internal.h"
#include "net/npc_agents.h"
#include "net/claim.h"
#include "util/time.h"

/* Players must be within one full floor-tile (50px) to harvest a resource. */
#define HARVEST_RANGE 50.0f
#define BOULDER_HARVEST_RANGE (HARVEST_RANGE * 1.40625f)  /* scales with node size in find_nearest_resource */
#define HARVEST_STAMINA_COST 15u   /* stamina drained per harvest action */

/* Respawn delays per resource type (milliseconds) */
#define RESPAWN_MS_WOOD    120000u  /* 2 minutes */
#define RESPAWN_MS_FIBER    60000u  /* 1 minute  */
#define RESPAWN_MS_ROCK    180000u  /* 3 minutes */
#define RESPAWN_MS_BOULDER 300000u  /* 5 minutes */

/* ── Shared harvest helpers ─────────────────────────────────────────────── */

const IslandDef *get_island_for_player(const WebSocketPlayer *player) {
    for (int i = 0; i < ISLAND_COUNT; i++) {
        if ((uint32_t)ISLAND_PRESETS[i].id == player->on_island_id)
            return &ISLAND_PRESETS[i];
    }
    return NULL;
}

int find_nearest_resource(const IslandDef *isl, float px, float py,
                          int res_type, float base_range) {
    /* Effective range scales with node size: larger nodes are easier to reach.
     * size < 1.0 → still uses base_range (no penalty for small nodes).
     * We track best as (d / eff_range)^2 so different-sized nodes are compared fairly. */
    float best_score = 1.0f;  /* 1.0 = exactly at the boundary; < 1.0 = inside */
    int   best_ri    = -1;
    for (int ri = 0; ri < isl->resource_count; ri++) {
        const IslandResource *r = &isl->resources[ri];
        if (r->type_id != res_type) continue;
        if (r->health  <= 0)        continue;
        float dx   = px - (isl->x + r->ox);
        float dy   = py - (isl->y + r->oy);
        float d2   = dx * dx + dy * dy;
        float eff  = base_range * (r->size >= 1.0f ? r->size : 1.0f);
        float score = d2 / (eff * eff);
        if (score <= 1.0f && score < best_score) { best_score = score; best_ri = ri; }
    }
    return best_ri;
}

void handle_harvest_resource(WebSocketPlayer* player, struct WebSocketClient* client) {
    char response[256];

    /* Must be standing on an island */
    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"not_on_island\"}");
        goto send_and_ret;
    }

    /* Active item must be an axe (stone or metal) */
    {
        uint8_t slot = player->inventory.active_slot;
        ItemKind equipped = (slot < INVENTORY_SLOTS) ? player->inventory.slots[slot].item : ITEM_NONE;
        bool is_axe = (equipped == ITEM_AXE || equipped == ITEM_METAL_AXE)
                      && player->inventory.slots[slot].quantity > 0;
        if (!is_axe) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_failure\",\"reason\":\"need_axe\"}");
            goto send_and_ret;
        }
        /* Metal axe bonus: +5 extra wood per swing */
        (void)equipped; /* referenced below at wood grant */
    }

    /* Stamina cost — if depleted, deal the cost as HP damage instead of blocking */
    if (player->stamina >= HARVEST_STAMINA_COST) {
        player->stamina -= HARVEST_STAMINA_COST;
    } else {
        uint16_t _dmg = HARVEST_STAMINA_COST;
        player->stamina = 0;
        if (_dmg >= player->health) {
            player_die(player);
            goto send_and_ret;
        }
        player->health -= _dmg;
        player->last_damage_ms = get_time_ms();
    }
    player->stamina_last_used_ms = get_time_ms();

    /* Find the island definition */
    IslandDef *isl = (IslandDef *)get_island_for_player(player);
    if (!isl) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"island_not_found\"}");
        goto send_and_ret;
    }

    /* Find the nearest 'wood' resource node within range */
    int best_ri = find_nearest_resource(isl, player->x, player->y,
                                        RES_WOOD, HARVEST_RANGE);
    if (best_ri < 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"too_far\"}");
        goto send_and_ret;
    }

    /* Deduct health from the resource and broadcast damage */
    {
        IslandResource *res = &isl->resources[best_ri];
        const int WOOD_DAMAGE = 10;
        res->health -= WOOD_DAMAGE;
        if (res->health < 0) res->health = 0;
        if (res->health == 0) {
            island_mark_tree_dead(isl, best_ri);
            res->respawn_at_ms = get_time_ms() + RESPAWN_MS_WOOD;
        }
        char dmsg[160];
        snprintf(dmsg, sizeof(dmsg),
                 "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                 player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
        websocket_server_broadcast(dmsg);
    }

    /* Grant wood — metal axe yields 5 extra per swing */
    {
        uint8_t _aslot = player->inventory.active_slot;
        int gross_wood = (player->inventory.slots[_aslot].item == ITEM_METAL_AXE) ? 15 : 10;
        int net_wood = claim_apply_harvest_tax(player, player->x, player->y,
                                               gross_wood, ITEM_WOOD);
        if (net_wood <= 0) {
            /* All taxed away (edge case) — still count as success */
            player_apply_xp(player, PLAYER_XP_PER_WOOD_HARVEST);
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_success\",\"wood\":0}");
            goto send_and_ret;
        }

        /* Grant wood to resource pool (capped at 9999) */
        int new_wood = (int)player->res_wood + net_wood;
        if (new_wood > 9999) new_wood = 9999;
        player->res_wood = (uint16_t)new_wood;

        player_apply_xp(player, PLAYER_XP_PER_WOOD_HARVEST);
        log_info("🪓 Player %u harvested wood → +%d wood (pool=%u) +%u xp",
                 player->player_id, net_wood, player->res_wood, PLAYER_XP_PER_WOOD_HARVEST);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_success\",\"wood\":%d}", net_wood);
    }

send_and_ret:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}

/**
 * Handle harvest_fiber: player presses E near a fiber plant.
 * Grants 5 ITEM_FIBER if a fiber resource node is within HARVEST_RANGE.
 */
void handle_harvest_fiber(WebSocketPlayer* player, struct WebSocketClient* client) {
    char response[256];

    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_fiber_failure\",\"reason\":\"not_on_island\"}");
        goto send_fiber_ret;
    }

    {
        /* Find the island */
        IslandDef *isl = (IslandDef *)get_island_for_player(player);
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_failure\",\"reason\":\"island_not_found\"}");
            goto send_fiber_ret;
        }

        /* Find nearest fiber node within range */
        int best_ri = find_nearest_resource(isl, player->x, player->y,
                                            RES_FIBER, HARVEST_RANGE);
        if (best_ri < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_failure\",\"reason\":\"too_far\"}");
            goto send_fiber_ret;
        }

        /* Deduct health and broadcast */
        {
            IslandResource *res = &isl->resources[best_ri];
            res->health -= 10;
            if (res->health < 0) res->health = 0;
            if (res->health == 0) res->respawn_at_ms = get_time_ms() + RESPAWN_MS_FIBER;
            char dmsg[160];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                     player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
            websocket_server_broadcast(dmsg);
        }
        int net_fiber = claim_apply_harvest_tax(player, player->x, player->y, 5, ITEM_FIBER);
        if (net_fiber > 0) {
            int new_fiber = (int)player->res_fiber + net_fiber;
            if (new_fiber > 9999) new_fiber = 9999;
            player->res_fiber = (uint16_t)new_fiber;
        }

        /* 10% chance to also grant 1 wood */
        int bonus_wood = (rand() % 10 == 0) ? 1 : 0;
        if (bonus_wood) {
            int new_wood = (int)player->res_wood + 1;
            if (new_wood > 9999) new_wood = 9999;
            player->res_wood = (uint16_t)new_wood;
        }

        player_apply_xp(player, PLAYER_XP_PER_FIBER_HARVEST);
        log_info("🌿 Player %u gathered fiber → +%d fiber (pool=%u) +%u xp%s", player->player_id,
                 net_fiber, player->res_fiber, PLAYER_XP_PER_FIBER_HARVEST, bonus_wood ? " +1 wood (bonus)" : "");
        if (bonus_wood) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_success\",\"fiber\":%d,\"wood\":1}", net_fiber);
        } else {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_success\",\"fiber\":%d}", net_fiber);
        }
    }

send_fiber_ret:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}

/**
 * Handle harvest_rock: player presses E (with pickaxe) near a rock outcrop.
 * Grants 3 ITEM_METAL if a rock resource node is within HARVEST_RANGE.
 */
void handle_harvest_rock(WebSocketPlayer* player, struct WebSocketClient* client) {
    char response[256];

    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_rock_failure\",\"reason\":\"not_on_island\"}");
        goto send_rock_ret;
    }

    /* Check pickaxe equipped (stone or metal) */
    {
        int active = player->inventory.active_slot;
        ItemKind _pk = player->inventory.slots[active].item;
        bool has_pickaxe = (_pk == ITEM_PICKAXE || _pk == ITEM_METAL_PICKAXE);
        if (!has_pickaxe) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"need_pickaxe\"}");
            goto send_rock_ret;
        }
    }

    /* Stamina cost — if depleted, deal the cost as HP damage instead of blocking */
    if (player->stamina >= HARVEST_STAMINA_COST) {
        player->stamina -= HARVEST_STAMINA_COST;
    } else {
        uint16_t _dmg = HARVEST_STAMINA_COST;
        player->stamina = 0;
        if (_dmg >= player->health) {
            player_die(player);
            goto send_rock_ret;
        }
        player->health -= _dmg;
        player->last_damage_ms = get_time_ms();
    }
    player->stamina_last_used_ms = get_time_ms();

    {
        IslandDef *isl = (IslandDef *)get_island_for_player(player);
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"island_not_found\"}");
            goto send_rock_ret;
        }

        int best_ri = find_nearest_resource(isl, player->x, player->y,
                                            RES_ROCK, HARVEST_RANGE);
        if (best_ri < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"too_far\"}");
            goto send_rock_ret;
        }

        /* Deduct health and broadcast */
        {
            IslandResource *res = &isl->resources[best_ri];
            res->health -= 10;
            if (res->health < 0) res->health = 0;
            if (res->health == 0) res->respawn_at_ms = get_time_ms() + RESPAWN_MS_ROCK;
            char dmsg[160];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                     player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
            websocket_server_broadcast(dmsg);
        }

        {
            int _pkactive = player->inventory.active_slot;
            int rock_yield = (player->inventory.slots[_pkactive].item == ITEM_METAL_PICKAXE) ? 5 : 3;
            int new_metal = (int)player->res_metal + rock_yield;
            if (new_metal > 9999) new_metal = 9999;
            player->res_metal = (uint16_t)new_metal;
        }

        {
            int _pkactive2 = player->inventory.active_slot;
            int _ry = (player->inventory.slots[_pkactive2].item == ITEM_METAL_PICKAXE) ? 5 : 3;
            player_apply_xp(player, PLAYER_XP_PER_ROCK_HARVEST);
            log_info("⛏ Player %u mined rock → +%d metal (pool=%u) +%u xp", player->player_id, _ry, player->res_metal, PLAYER_XP_PER_ROCK_HARVEST);
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_success\",\"metal\":%d}", _ry);
        }
    }

send_rock_ret:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}

/**
 * Handle harvest_stone: player presses E near a rock outcrop (no tool required).
 * Grants 2 ITEM_STONE from the nearest RES_ROCK node within HARVEST_RANGE.
 */
void handle_harvest_stone(WebSocketPlayer* player, struct WebSocketClient* client) {
    char response[256];

    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_stone_failure\",\"reason\":\"not_on_island\"}");
        goto send_stone_ret;
    }

    {
        IslandDef *isl = (IslandDef *)get_island_for_player(player);
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_stone_failure\",\"reason\":\"island_not_found\"}");
            goto send_stone_ret;
        }

        int best_ri = find_nearest_resource(isl, player->x, player->y,
                                            RES_ROCK, HARVEST_RANGE);
        if (best_ri < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_stone_failure\",\"reason\":\"too_far\"}");
            goto send_stone_ret;
        }

        /* Deduct health and broadcast */
        {
            IslandResource *res = &isl->resources[best_ri];
            res->health -= 10;
            if (res->health < 0) res->health = 0;
            char dmsg[160];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                     player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
            websocket_server_broadcast(dmsg);
        }

        int net_stone = claim_apply_harvest_tax(player, player->x, player->y, 2, ITEM_STONE);
        if (net_stone > 0) {
            int new_stone = (int)player->res_stone + net_stone;
            if (new_stone > 9999) new_stone = 9999;
            player->res_stone = (uint16_t)new_stone;
        }

        player_apply_xp(player, PLAYER_XP_PER_STONE_HARVEST);
        log_info("🪨 Player %u gathered stone → +%d stone (pool=%u) +%u xp", player->player_id, net_stone, player->res_stone, PLAYER_XP_PER_STONE_HARVEST);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_stone_success\",\"stone\":%d}", net_stone);
    }

send_stone_ret:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}

/**
 * Handle harvest_boulder: player presses E (with pickaxe) near a large boulder.
 * Grants 5 ITEM_STONE if a boulder resource node is within HARVEST_RANGE.
 * Boulders have 400 max health and are a separate resource type from RES_ROCK.
 */
void handle_harvest_boulder(WebSocketPlayer* player, struct WebSocketClient* client) {
    char response[256];

    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_boulder_failure\",\"reason\":\"not_on_island\"}");
        goto send_boulder_ret;
    }

    /* Check pickaxe equipped (stone or metal) */
    {
        int active = player->inventory.active_slot;
        ItemKind _bpk = player->inventory.slots[active].item;
        bool has_pickaxe = (_bpk == ITEM_PICKAXE || _bpk == ITEM_METAL_PICKAXE);
        if (!has_pickaxe) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"need_pickaxe\"}");
            goto send_boulder_ret;
        }
    }

    /* Stamina cost — if depleted, deal the cost as HP damage instead of blocking */
    if (player->stamina >= HARVEST_STAMINA_COST) {
        player->stamina -= HARVEST_STAMINA_COST;
    } else {
        uint16_t _dmg = HARVEST_STAMINA_COST;
        player->stamina = 0;
        if (_dmg >= player->health) {
            player_die(player);
            goto send_boulder_ret;
        }
        player->health -= _dmg;
        player->last_damage_ms = get_time_ms();
    }
    player->stamina_last_used_ms = get_time_ms();

    {
        IslandDef *isl = (IslandDef *)get_island_for_player(player);
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"island_not_found\"}");
            goto send_boulder_ret;
        }

        /* Find the nearest boulder — check stone boulders first, then metal */
        int best_ri = find_nearest_resource(isl, player->x, player->y,
                                            RES_STONE_BOULDER, BOULDER_HARVEST_RANGE);
        int best_type = RES_STONE_BOULDER;
        if (best_ri < 0) {
            best_ri   = find_nearest_resource(isl, player->x, player->y,
                                              RES_BOULDER, BOULDER_HARVEST_RANGE);
            best_type = RES_BOULDER;
        }
        if (best_ri < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"too_far\"}");
            goto send_boulder_ret;
        }

        /* Deduct health and broadcast */
        {
            IslandResource *res = &isl->resources[best_ri];
            const int BOULDER_DAMAGE = 20;
            res->health -= BOULDER_DAMAGE;
            if (res->health < 0) res->health = 0;
            if (res->health == 0) res->respawn_at_ms = get_time_ms() + RESPAWN_MS_BOULDER;
            char dmsg[160];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                     player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
            websocket_server_broadcast(dmsg);
        }

        /* Grant stone or metal — metal pickaxe yields +3 extra */
        int _bpkact = player->inventory.active_slot;
        int boulder_bonus = (player->inventory.slots[_bpkact].item == ITEM_METAL_PICKAXE) ? 3 : 0;
        const char *item_name = (best_type == RES_BOULDER) ? "metal" : "stone";
        if (best_type == RES_BOULDER) {
            int new_metal = (int)player->res_metal + 5 + boulder_bonus;
            if (new_metal > 9999) new_metal = 9999;
            player->res_metal = (uint16_t)new_metal;
        } else {
            int new_stone = (int)player->res_stone + 5 + boulder_bonus;
            if (new_stone > 9999) new_stone = 9999;
            player->res_stone = (uint16_t)new_stone;
        }

        player_apply_xp(player, PLAYER_XP_PER_BOULDER_HARVEST);
        log_info("⛏️  Player %u mined boulder → +5 %s +%u xp", player->player_id, item_name, PLAYER_XP_PER_BOULDER_HARVEST);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_boulder_success\",\"%s\":5}", item_name);
    }

send_boulder_ret:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}
