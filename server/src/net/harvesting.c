#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include "net/harvesting.h"
#include "net/npc_agents.h"
#include "util/time.h"

#define HARVEST_RANGE 110.0f      /* world-px, generous for feel */
#define HARVEST_STAMINA_COST 15u   /* stamina drained per harvest action */

/* Respawn delays per resource type (milliseconds) */
#define RESPAWN_MS_WOOD    120000u  /* 2 minutes */
#define RESPAWN_MS_FIBER    60000u  /* 1 minute  */
#define RESPAWN_MS_ROCK    180000u  /* 3 minutes */
#define RESPAWN_MS_BOULDER 300000u  /* 5 minutes */

void handle_harvest_resource(WebSocketPlayer* player, struct WebSocketClient* client) {
    char response[256];

    /* Must be standing on an island */
    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"not_on_island\"}");
        goto send_and_ret;
    }

    /* Active item must be the axe */
    {
        uint8_t slot = player->inventory.active_slot;
        if (slot >= INVENTORY_SLOTS ||
            player->inventory.slots[slot].item != ITEM_AXE ||
            player->inventory.slots[slot].quantity == 0)
        {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_failure\",\"reason\":\"need_axe\"}");
            goto send_and_ret;
        }
    }

    /* Stamina check */
    if (player->stamina < HARVEST_STAMINA_COST) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"no_stamina\"}");
        goto send_and_ret;
    }
    player->stamina -= HARVEST_STAMINA_COST;
    player->stamina_last_used_ms = get_time_ms();

    /* Find the island definition */
    const IslandDef *isl = NULL;
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        if ((uint32_t)ISLAND_PRESETS[ii].id == player->on_island_id) {
            isl = &ISLAND_PRESETS[ii];
            break;
        }
    }
    if (!isl) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"island_not_found\"}");
        goto send_and_ret;
    }

    /* Find the nearest 'wood' resource node within range */
    float best_dist_sq = HARVEST_RANGE * HARVEST_RANGE;
    bool found = false;
    int best_ri = -1;
    for (int ri = 0; ri < isl->resource_count; ri++) {
        if (isl->resources[ri].type_id != RES_WOOD) continue;
        if (isl->resources[ri].health <= 0) continue; /* depleted */
        float wx = isl->x + isl->resources[ri].ox;
        float wy = isl->y + isl->resources[ri].oy;
        float dx = player->x - wx;
        float dy = player->y - wy;
        float d2 = dx * dx + dy * dy;
        if (d2 <= best_dist_sq) {
            best_dist_sq = d2;
            best_ri = ri;
            found = true;
        }
    }
    if (!found) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_failure\",\"reason\":\"too_far\"}");
        goto send_and_ret;
    }

    /* Deduct health from the resource and broadcast damage */
    {
        IslandDef *isl_chop = NULL;
        for (int ii = 0; ii < ISLAND_COUNT; ii++) {
            if ((uint32_t)ISLAND_PRESETS[ii].id == player->on_island_id) {
                isl_chop = &ISLAND_PRESETS[ii];
                break;
            }
        }
        if (isl_chop) {
            IslandResource *res = &isl_chop->resources[best_ri];
            const int WOOD_DAMAGE = 10;
            res->health -= WOOD_DAMAGE;
            if (res->health < 0) res->health = 0;
            if (res->health == 0) {
                island_mark_tree_dead(isl_chop, best_ri);
                res->respawn_at_ms = get_time_ms() + RESPAWN_MS_WOOD;
            }
            char dmsg[160];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                     player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
            websocket_server_broadcast(dmsg);
        }
    }

    /* Grant 2 planks — find an existing plank stack or a free slot */
    {
        int grant_slot = -1;
        /* Prefer an existing wood stack that isn't full */
        for (int s = 0; s < INVENTORY_SLOTS; s++) {
            if (player->inventory.slots[s].item == ITEM_WOOD &&
                player->inventory.slots[s].quantity < 99) {
                grant_slot = s;
                break;
            }
        }
        /* Fall back to first empty slot */
        if (grant_slot < 0) {
            for (int s = 0; s < INVENTORY_SLOTS; s++) {
                if (player->inventory.slots[s].item == ITEM_NONE ||
                    player->inventory.slots[s].quantity == 0) {
                    grant_slot = s;
                    break;
                }
            }
        }
        if (grant_slot < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_failure\",\"reason\":\"inventory_full\"}");
            goto send_and_ret;
        }

        if (player->inventory.slots[grant_slot].item == ITEM_WOOD) {
            int new_qty = (int)player->inventory.slots[grant_slot].quantity + 10;
            if (new_qty > 99) new_qty = 99;
            player->inventory.slots[grant_slot].quantity = (uint8_t)new_qty;
        } else {
            player->inventory.slots[grant_slot].item     = ITEM_WOOD;
            player->inventory.slots[grant_slot].quantity = 10;
        }

        player_apply_xp(player, PLAYER_XP_PER_WOOD_HARVEST);
        log_info("🪓 Player %u harvested wood → +10 wood +%u xp (slot %d qty=%d)",
                 player->player_id, PLAYER_XP_PER_WOOD_HARVEST, grant_slot,
                 (int)player->inventory.slots[grant_slot].quantity);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_success\",\"wood\":10}");
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
        const IslandDef *isl = NULL;
        for (int i = 0; i < ISLAND_COUNT; i++) {
            if (ISLAND_PRESETS[i].id == (int)player->on_island_id) {
                isl = &ISLAND_PRESETS[i];
                break;
            }
        }
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_failure\",\"reason\":\"island_not_found\"}");
            goto send_fiber_ret;
        }

        /* Find nearest fiber node within range */
        float best_dist_sq = (float)(HARVEST_RANGE * HARVEST_RANGE);
        bool  found = false;
        int   best_ri = -1;
        for (int ri = 0; ri < isl->resource_count; ri++) {
            if (isl->resources[ri].type_id != RES_FIBER) continue;
            if (isl->resources[ri].health <= 0) continue; /* depleted */
            float fx = isl->x + isl->resources[ri].ox;
            float fy = isl->y + isl->resources[ri].oy;
            float dx = player->x - fx;
            float dy = player->y - fy;
            float dist_sq = dx * dx + dy * dy;
            if (dist_sq <= best_dist_sq) {
                best_dist_sq = dist_sq;
                best_ri = ri;
                found = true;
            }
        }

        if (!found) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_failure\",\"reason\":\"too_far\"}");
            goto send_fiber_ret;
        }

        /* Deduct health and broadcast */
        if (best_ri >= 0) {
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

        /* Grant 5 fiber */
        if (!craft_grant(player, ITEM_FIBER, 5)) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_failure\",\"reason\":\"inventory_full\"}");
            goto send_fiber_ret;
        }

        /* 10% chance to also drop 1 wood */
        int bonus_wood = (rand() % 10 == 0) ? 1 : 0;
        if (bonus_wood) craft_grant(player, ITEM_WOOD, 1); /* ignore full — fiber already granted */

        player_apply_xp(player, PLAYER_XP_PER_FIBER_HARVEST);
        log_info("🌿 Player %u gathered fiber → +5 fiber +%u xp%s", player->player_id,
                 PLAYER_XP_PER_FIBER_HARVEST, bonus_wood ? " +1 wood (bonus)" : "");
        if (bonus_wood) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_success\",\"fiber\":5,\"wood\":1}");
        } else {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_fiber_success\",\"fiber\":5}");
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

    /* Check pickaxe equipped */
    {
        bool has_pickaxe = false;
        int active = player->inventory.active_slot;
        if (player->inventory.slots[active].item == ITEM_PICKAXE)
            has_pickaxe = true;
        if (!has_pickaxe) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"need_pickaxe\"}");
            goto send_rock_ret;
        }
    }

    /* Stamina check */
    if (player->stamina < HARVEST_STAMINA_COST) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_rock_failure\",\"reason\":\"no_stamina\"}");
        goto send_rock_ret;
    }
    player->stamina -= HARVEST_STAMINA_COST;
    player->stamina_last_used_ms = get_time_ms();

    {
        const IslandDef *isl = NULL;
        for (int i = 0; i < ISLAND_COUNT; i++) {
            if (ISLAND_PRESETS[i].id == (int)player->on_island_id) {
                isl = &ISLAND_PRESETS[i];
                break;
            }
        }
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"island_not_found\"}");
            goto send_rock_ret;
        }

        float best_dist_sq = (float)(HARVEST_RANGE * HARVEST_RANGE);
        bool  found = false;
        int   best_ri = -1;
        for (int ri = 0; ri < isl->resource_count; ri++) {
            if (isl->resources[ri].type_id != RES_ROCK) continue;
            if (isl->resources[ri].health <= 0) continue; /* depleted */
            float rx = isl->x + isl->resources[ri].ox;
            float ry = isl->y + isl->resources[ri].oy;
            float dx = player->x - rx;
            float dy = player->y - ry;
            float dist_sq = dx * dx + dy * dy;
            if (dist_sq <= best_dist_sq) {
                best_dist_sq = dist_sq;
                best_ri = ri;
                found = true;
            }
        }

        if (!found) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"too_far\"}");
            goto send_rock_ret;
        }

        /* Deduct health and broadcast */
        if (best_ri >= 0) {
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

        if (!craft_grant(player, ITEM_METAL, 3)) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_rock_failure\",\"reason\":\"inventory_full\"}");
            goto send_rock_ret;
        }

        player_apply_xp(player, PLAYER_XP_PER_ROCK_HARVEST);
        log_info("⛏ Player %u mined rock → +3 metal +%u xp", player->player_id, PLAYER_XP_PER_ROCK_HARVEST);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_rock_success\",\"metal\":3}");
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
        const IslandDef *isl = NULL;
        for (int i = 0; i < ISLAND_COUNT; i++) {
            if (ISLAND_PRESETS[i].id == (int)player->on_island_id) {
                isl = &ISLAND_PRESETS[i];
                break;
            }
        }
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_stone_failure\",\"reason\":\"island_not_found\"}");
            goto send_stone_ret;
        }

        float best_dist_sq = (float)(HARVEST_RANGE * HARVEST_RANGE);
        bool  found = false;
        int   best_ri = -1;
        for (int ri = 0; ri < isl->resource_count; ri++) {
            if (isl->resources[ri].type_id != RES_ROCK) continue;
            if (isl->resources[ri].health <= 0) continue; /* depleted */
            float rx = isl->x + isl->resources[ri].ox;
            float ry = isl->y + isl->resources[ri].oy;
            float dx = player->x - rx;
            float dy = player->y - ry;
            float dist_sq = dx * dx + dy * dy;
            if (dist_sq <= best_dist_sq) {
                best_dist_sq = dist_sq;
                best_ri = ri;
                found = true;
            }
        }

        if (!found) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_stone_failure\",\"reason\":\"too_far\"}");
            goto send_stone_ret;
        }

        /* Deduct health and broadcast */
        if (best_ri >= 0) {
            IslandResource *res = &isl->resources[best_ri];
            res->health -= 10;
            if (res->health < 0) res->health = 0;
            char dmsg[160];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"resource_damaged\",\"island_id\":%u,\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"hp\":%d,\"maxHp\":%d}",
                     player->on_island_id, best_ri, res->ox, res->oy, res->health, res->max_health);
            websocket_server_broadcast(dmsg);
        }

        if (!craft_grant(player, ITEM_STONE, 2)) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_stone_failure\",\"reason\":\"inventory_full\"}");
            goto send_stone_ret;
        }

        player_apply_xp(player, PLAYER_XP_PER_STONE_HARVEST);
        log_info("🪨 Player %u gathered stone → +2 stone +%u xp", player->player_id, PLAYER_XP_PER_STONE_HARVEST);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_stone_success\",\"stone\":2}");
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

    /* Check pickaxe equipped */
    {
        bool has_pickaxe = false;
        int active = player->inventory.active_slot;
        if (player->inventory.slots[active].item == ITEM_PICKAXE)
            has_pickaxe = true;
        if (!has_pickaxe) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"need_pickaxe\"}");
            goto send_boulder_ret;
        }
    }

    /* Stamina check */
    if (player->stamina < HARVEST_STAMINA_COST) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_boulder_failure\",\"reason\":\"no_stamina\"}");
        goto send_boulder_ret;
    }
    player->stamina -= HARVEST_STAMINA_COST;
    player->stamina_last_used_ms = get_time_ms();

    {
        const IslandDef *isl = NULL;
        for (int i = 0; i < ISLAND_COUNT; i++) {
            if (ISLAND_PRESETS[i].id == (int)player->on_island_id) {
                isl = &ISLAND_PRESETS[i];
                break;
            }
        }
        if (!isl) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"island_not_found\"}");
            goto send_boulder_ret;
        }

        float best_dist_sq = (float)(HARVEST_RANGE * HARVEST_RANGE);
        bool  found = false;
        int   best_ri = -1;
        for (int ri = 0; ri < isl->resource_count; ri++) {
            if (isl->resources[ri].type_id != RES_BOULDER) continue;
            if (isl->resources[ri].health <= 0) continue; /* depleted */
            float bx = isl->x + isl->resources[ri].ox;
            float by_ = isl->y + isl->resources[ri].oy;
            float dx = player->x - bx;
            float dy = player->y - by_;
            float dist_sq = dx * dx + dy * dy;
            if (dist_sq <= best_dist_sq) {
                best_dist_sq = dist_sq;
                best_ri = ri;
                found = true;
            }
        }

        if (!found) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"too_far\"}");
            goto send_boulder_ret;
        }

        /* Deduct health and broadcast */
        if (best_ri >= 0) {
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

        /* Grant 5 metal */
        if (!craft_grant(player, ITEM_METAL, 5)) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"harvest_boulder_failure\",\"reason\":\"inventory_full\"}");
            goto send_boulder_ret;
        }

        player_apply_xp(player, PLAYER_XP_PER_BOULDER_HARVEST);
        log_info("⛏️  Player %u mined boulder → +5 metal +%u xp", player->player_id, PLAYER_XP_PER_BOULDER_HARVEST);
        snprintf(response, sizeof(response),
                 "{\"type\":\"harvest_boulder_success\",\"metal\":5}");
    }

send_boulder_ret:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}
