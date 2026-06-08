#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <sys/socket.h>
#include "net/websocket_server_internal.h"
#include "net/websocket_protocol.h"
#include "net/crafting.h"
#include "net/quality.h"





/** Count total quantity of an item — checks resource pool for raw materials, slots for everything else. */
int craft_count_item(WebSocketPlayer* player, ItemKind item) {
    if (item == ITEM_WOOD)  return (int)player->res_wood;
    if (item == ITEM_FIBER) return (int)player->res_fiber;
    if (item == ITEM_METAL) return (int)player->res_metal;
    if (item == ITEM_STONE) return (int)player->res_stone;
    int total = 0;
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == item)
            total += player->inventory.slots[s].quantity;
    }
    return total;
}

/** Consume `amount` units of `item` — deducts from resource pool for raw materials, slots otherwise. */
bool craft_consume(WebSocketPlayer* player, ItemKind item, int amount) {
    if (item == ITEM_WOOD) {
        if ((int)player->res_wood < amount) return false;
        player->res_wood -= (uint16_t)amount;
        return true;
    }
    if (item == ITEM_FIBER) {
        if ((int)player->res_fiber < amount) return false;
        player->res_fiber -= (uint16_t)amount;
        return true;
    }
    if (item == ITEM_METAL) {
        if ((int)player->res_metal < amount) return false;
        player->res_metal -= (uint16_t)amount;
        return true;
    }
    if (item == ITEM_STONE) {
        if ((int)player->res_stone < amount) return false;
        player->res_stone -= (uint16_t)amount;
        return true;
    }
    int remaining = amount;
    for (int s = 0; s < INVENTORY_SLOTS && remaining > 0; s++) {
        if (player->inventory.slots[s].item == item) {
            int take = (player->inventory.slots[s].quantity < remaining)
                       ? player->inventory.slots[s].quantity : remaining;
            player->inventory.slots[s].quantity -= (uint8_t)take;
            remaining -= take;
            if (player->inventory.slots[s].quantity == 0)
                player->inventory.slots[s].item = ITEM_NONE;
        }
    }
    return remaining == 0;
}

/** Grant `amount` units of `item` into inventory. Returns false if no space. */
bool craft_grant(WebSocketPlayer* player, ItemKind item, int amount) {
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == item &&
            player->inventory.slots[s].quantity < 99) {
            int new_qty = (int)player->inventory.slots[s].quantity + amount;
            if (new_qty > 99) new_qty = 99;
            player->inventory.slots[s].quantity = (uint8_t)new_qty;
            return true;
        }
    }
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == ITEM_NONE ||
            player->inventory.slots[s].quantity == 0) {
            player->inventory.slots[s].item     = item;
            player->inventory.slots[s].quantity = (uint8_t)(amount > 99 ? 99 : amount);
            return true;
        }
    }
    return false;
}

/**
 * Handle craft_item request from client.
 * Validates ingredients, consumes them, grants output item.
 */
void handle_craft_item(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[256];

    /* Parse recipe_id */
    char recipe_id[64] = {0};
    const char* rid_start = strstr(payload, "\"recipe_id\":");
    if (rid_start) {
        rid_start += 12;
        while (*rid_start == ' ' || *rid_start == '"') rid_start++;
        int i = 0;
        while (*rid_start && *rid_start != '"' && i < (int)sizeof(recipe_id) - 1)
            recipe_id[i++] = *rid_start++;
        recipe_id[i] = '\0';
    }

    if (recipe_id[0] == '\0') {
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_result\",\"success\":false,\"reason\":\"unknown_recipe\",\"recipe_id\":\"\"}");
        goto send_craft_resp;
    }

    /* Recipe table */
    typedef struct { ItemKind item; int count; } CraftIng;
    typedef struct {
        const char* id;
        ItemKind    output;
        int         output_count;
        CraftIng    ing[3];
        int         ing_count;
        bool        require_workbench;
    } CraftRecipe;

    static const CraftRecipe recipes[] = {
        /* ── Hand-craft recipes (no workbench required) ─────────────────── */
        { "craft_repair_kit",    ITEM_REPAIR_KIT,    1, { {ITEM_WOOD,  4}, {0,0},             {0,0} }, 1, false },
        /* Cloth armour set */
        { "craft_cloth_hat",     ITEM_CLOTH_HAT,     1, { {ITEM_FIBER,  8}, {0,0},            {0,0} }, 1, false },
        { "craft_cloth_shirt",   ITEM_CLOTH_SHIRT,   1, { {ITEM_FIBER, 25}, {0,0},            {0,0} }, 1, false },
        { "craft_cloth_pants",   ITEM_CLOTH_PANTS,   1, { {ITEM_FIBER, 20}, {0,0},            {0,0} }, 1, false },
        { "craft_cloth_shoes",   ITEM_CLOTH_SHOES,   1, { {ITEM_FIBER, 12}, {0,0},            {0,0} }, 1, false },
        { "craft_cloth_gloves",  ITEM_CLOTH_GLOVES,  1, { {ITEM_FIBER, 10}, {0,0},            {0,0} }, 1, false },
        { "craft_wooden_shield", ITEM_WOODEN_SHIELD, 1, { {ITEM_WOOD,   6}, {0,0},            {0,0} }, 1, false },
        { "craft_axe",           ITEM_AXE,           1, { {ITEM_WOOD,   2}, {ITEM_STONE,  5}, {0,0} }, 2, false },
        { "craft_pickaxe",       ITEM_PICKAXE,       1, { {ITEM_WOOD,   3}, {ITEM_STONE,  4}, {0,0} }, 2, false },
        { "craft_wooden_floor",  ITEM_WOODEN_FLOOR,  1, { {ITEM_WOOD,  20}, {0,0},            {0,0} }, 1, false },
        { "craft_workbench",     ITEM_WORKBENCH,     1, { {ITEM_WOOD,  10}, {0,0},            {0,0} }, 1, false },
        { "craft_hammer",        ITEM_HAMMER,        1, { {ITEM_WOOD,   4}, {0,0},            {0,0} }, 1, false },
        { "craft_claim_flag",    ITEM_CLAIM_FLAG,    1, { {ITEM_WOOD,   5}, {0,0},            {0,0} }, 1, false },
        /* Wood-only construction & ship parts — craftable from inventory */
        { "craft_wall",          ITEM_WALL,          1, { {ITEM_WOOD,  10}, {0,0},            {0,0} }, 1, false },
        { "craft_door",          ITEM_DOOR,          1, { {ITEM_WOOD,   4}, {0,0},            {0,0} }, 1, false },
        { "craft_floor",         ITEM_WOODEN_FLOOR,  1, { {ITEM_WOOD,  20}, {0,0},            {0,0} }, 1, false },
        { "craft_wood_ceiling",  ITEM_WOOD_CEILING,  1, { {ITEM_WOOD,  15}, {0,0},            {0,0} }, 1, false },
        { "craft_plank",         ITEM_PLANK,         1, { {ITEM_WOOD,  30}, {0,0},            {0,0} }, 1, false },
        { "craft_deck",          ITEM_DECK,          1, { {ITEM_WOOD,  75}, {0,0},            {0,0} }, 1, false },
        { "craft_ramp",          ITEM_RAMP,          1, { {ITEM_WOOD,  20}, {0,0},            {0,0} }, 1, true  },
        { "craft_helm_kit",      ITEM_HELM,          1, { {ITEM_WOOD,  10}, {0,0},            {0,0} }, 1, false },
        /* ── Workbench recipes (require workbench proximity) ─────────────── */
        { "craft_sail",          ITEM_SAIL,          1, { {ITEM_WOOD,  40}, {ITEM_FIBER, 100},{0,0} }, 2, true  },
        { "craft_cannon",        ITEM_CANNON,        1, { {ITEM_WOOD,   8}, {ITEM_METAL,  20},{0,0} }, 2, true  },
        { "craft_swivel",        ITEM_SWIVEL,        1, { {ITEM_WOOD,   5}, {ITEM_METAL,   8},{0,0} }, 2, true  },
        { "craft_sword",         ITEM_SWORD,         1, { {ITEM_WOOD,   2}, {ITEM_METAL,   5},{0,0} }, 2, true  },
        { "craft_shipyard",      ITEM_SHIPYARD,      1, { {ITEM_WOOD,  30}, {ITEM_PLANK,  10},{0,0} }, 2, true  },
        { "craft_stone_axe",     ITEM_AXE,           1, { {ITEM_WOOD,   2}, {ITEM_STONE,   5},{0,0} }, 2, true  },
        { "craft_stone_pickaxe", ITEM_PICKAXE,       1, { {ITEM_WOOD,   3}, {ITEM_STONE,   4},{0,0} }, 2, true  },
        { "craft_flag_fort",     ITEM_FLAG_FORT,     1, { {ITEM_WOOD,  40}, {ITEM_STONE,  40},{0,0} }, 2, true  },
        { "craft_company_fortress", ITEM_COMPANY_FORTRESS, 1, { {ITEM_WOOD,100},{ITEM_STONE,100},{ITEM_METAL,20} }, 3, true  },
        { "craft_bed",           ITEM_BED,           1, { {ITEM_WOOD,   8}, {ITEM_FIBER,  4}, {0,0} }, 2, false },
    };
    const int num_recipes = (int)(sizeof(recipes) / sizeof(recipes[0]));

    const CraftRecipe* recipe = NULL;
    for (int i = 0; i < num_recipes; i++) {
        if (strcmp(recipes[i].id, recipe_id) == 0) {
            recipe = &recipes[i];
            break;
        }
    }

    if (!recipe) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_result\",\"success\":false,\"reason\":\"unknown_recipe\",\"recipe_id\":\"%s\"}", recipe_id);
        goto send_craft_resp;
    }

    /* Workbench proximity check */
    if (recipe->require_workbench) {
        const float WB_RANGE2 = 200.0f * 200.0f;
        bool near_workbench = false;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            const PlacedStructure* s = &placed_structures[si];
            if (!s->active || s->type != STRUCT_WORKBENCH) continue;
            float dx = s->x - player->x;
            float dy = s->y - player->y;
            if (dx*dx + dy*dy <= WB_RANGE2) { near_workbench = true; break; }
        }
        if (!near_workbench) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"craft_result\",\"success\":false,\"reason\":\"not_at_workbench\",\"recipe_id\":\"%s\"}", recipe_id);
            goto send_craft_resp;
        }
    }

    /* Check ingredients */
    for (int i = 0; i < recipe->ing_count; i++) {
        if (craft_count_item(player, recipe->ing[i].item) < recipe->ing[i].count) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"craft_result\",\"success\":false,\"reason\":\"missing_ingredients\",\"recipe_id\":\"%s\"}", recipe_id);
            goto send_craft_resp;
        }
    }

    /* Check output space */
    if (!craft_grant(player, recipe->output, 0)) {
        /* Dry-run: just test if a slot exists — grant 0 won't do anything */
        /* Actually check differently: count free or matching slots */
        bool has_space = false;
        for (int s = 0; s < INVENTORY_SLOTS; s++) {
            if ((player->inventory.slots[s].item == recipe->output &&
                 player->inventory.slots[s].quantity < 99) ||
                player->inventory.slots[s].item == ITEM_NONE ||
                player->inventory.slots[s].quantity == 0) {
                has_space = true;
                break;
            }
        }
        if (!has_space) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"craft_result\",\"success\":false,\"reason\":\"inventory_full\",\"recipe_id\":\"%s\"}", recipe_id);
            goto send_craft_resp;
        }
    }

    /* Consume ingredients */
    for (int i = 0; i < recipe->ing_count; i++) {
        craft_consume(player, recipe->ing[i].item, recipe->ing[i].count);
    }

    /* Grant output */
    if (!craft_grant(player, recipe->output, recipe->output_count)) {
        /* Should not happen since we checked space, but handle gracefully */
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_result\",\"success\":false,\"reason\":\"inventory_full\",\"recipe_id\":\"%s\"}", recipe_id);
        goto send_craft_resp;
    }

    log_info("\u2692 Player %u crafted '%s'", player->player_id, recipe_id);
    snprintf(response, sizeof(response),
             "{\"type\":\"craft_result\",\"success\":true,\"recipe_id\":\"%s\"}", recipe_id);

send_craft_resp:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}

/* ── Quality / schematic crafting ──────────────────────────────────────────── */

/** Grant a non-stacking quality item into the first free slot with its payload. */
bool craft_grant_quality(WebSocketPlayer* player, ItemKind item, const QualityPayload* q) {
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == ITEM_NONE ||
            player->inventory.slots[s].quantity == 0) {
            player->inventory.slots[s].item     = item;
            player->inventory.slots[s].quantity = 1;
            player->inventory.slot_quality[s]   = *q;
            return true;
        }
    }
    return false;
}

bool schematic_add(WebSocketPlayer* player, ItemKind item, uint8_t crafts,
                   const QualityPayload* q) {
    if (crafts == 0) crafts = quality_item_max_crafts(item);
    for (int i = 0; i < MAX_PLAYER_SCHEMATICS; i++) {
        if (player->schematics[i].item == 0) {
            player->schematics[i].item             = (uint8_t)item;
            player->schematics[i].crafts_remaining = crafts;
            player->schematics[i].quality          = *q;
            if (i >= player->schematic_count) player->schematic_count = (uint8_t)(i + 1);
            return true;
        }
    }
    return false;
}

/* Canonical base recipe (ingredients + workbench req) for a quality-craftable item.
 * Mirrors the cheapest matching recipe in handle_craft_item's table. */
typedef struct { ItemKind item; int count; } BpIng;
static int bp_base_cost(ItemKind item, BpIng out[3], bool* require_wb) {
    *require_wb = false;
    switch (item) {
        case ITEM_CANNON:       out[0]=(BpIng){ITEM_WOOD,8};  out[1]=(BpIng){ITEM_METAL,20}; *require_wb=true;  return 2;
        case ITEM_SWIVEL:       out[0]=(BpIng){ITEM_WOOD,5};  out[1]=(BpIng){ITEM_METAL,8};  *require_wb=true;  return 2;
        case ITEM_SWORD:        out[0]=(BpIng){ITEM_WOOD,2};  out[1]=(BpIng){ITEM_METAL,5};  *require_wb=true;  return 2;
        case ITEM_AXE:          out[0]=(BpIng){ITEM_WOOD,2};  out[1]=(BpIng){ITEM_STONE,5};  return 2;
        case ITEM_PICKAXE:      out[0]=(BpIng){ITEM_WOOD,3};  out[1]=(BpIng){ITEM_STONE,4};  return 2;
        case ITEM_SAIL:         out[0]=(BpIng){ITEM_WOOD,40}; out[1]=(BpIng){ITEM_FIBER,100};*require_wb=true;  return 2;
        case ITEM_PLANK:        out[0]=(BpIng){ITEM_WOOD,30}; return 1;
        case ITEM_DECK:         out[0]=(BpIng){ITEM_WOOD,75}; return 1;
        case ITEM_HELM:         out[0]=(BpIng){ITEM_WOOD,10}; return 1;
        case ITEM_WOODEN_FLOOR: out[0]=(BpIng){ITEM_WOOD,20}; return 1;
        case ITEM_WALL:         out[0]=(BpIng){ITEM_WOOD,10}; return 1;
        case ITEM_WOOD_CEILING: out[0]=(BpIng){ITEM_WOOD,15}; return 1;
        case ITEM_DOOR:         out[0]=(BpIng){ITEM_WOOD,4};  return 1;
        case ITEM_FLAG_FORT:    out[0]=(BpIng){ITEM_WOOD,40}; out[1]=(BpIng){ITEM_STONE,40}; *require_wb=true;  return 2;
        case ITEM_SHIPYARD:     out[0]=(BpIng){ITEM_WOOD,30}; out[1]=(BpIng){ITEM_PLANK,10};*require_wb=true;  return 2;
        default: return 0;
    }
}

void handle_craft_blueprint(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[256];
    int index = -1;
    {
        const char* p = strstr(payload, "\"index\":");
        if (p) sscanf(p + 8, "%d", &index);
    }

    if (index < 0 || index >= MAX_PLAYER_SCHEMATICS ||
        player->schematics[index].item == 0 ||
        player->schematics[index].crafts_remaining == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_blueprint_result\",\"success\":false,\"reason\":\"invalid_schematic\",\"index\":%d}", index);
        goto bp_send;
    }

    PlayerBlueprint* bp = &player->schematics[index];
    ItemKind item = (ItemKind)bp->item;
    float    quality = quality_from_q8(bp->quality.quality_q8);

    BpIng ing[3]; bool require_wb = false;
    int ing_n = bp_base_cost(item, ing, &require_wb);
    if (ing_n == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_blueprint_result\",\"success\":false,\"reason\":\"unknown_item\",\"index\":%d}", index);
        goto bp_send;
    }

    /* Quality-scaled resource cost (Crude 1x .. Eternal 3x) */
    float cost_mult = quality_craft_cost_mult(quality);
    int   need[3];
    for (int i = 0; i < ing_n; i++) {
        need[i] = (int)ceilf((float)ing[i].count * cost_mult);
        if (need[i] < ing[i].count) need[i] = ing[i].count;
    }

    if (require_wb) {
        const float WB_RANGE2 = 200.0f * 200.0f;
        bool near_wb = false;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            const PlacedStructure* s = &placed_structures[si];
            if (!s->active || s->type != STRUCT_WORKBENCH) continue;
            float dx = s->x - player->x, dy = s->y - player->y;
            if (dx*dx + dy*dy <= WB_RANGE2) { near_wb = true; break; }
        }
        if (!near_wb) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"craft_blueprint_result\",\"success\":false,\"reason\":\"not_at_workbench\",\"index\":%d}", index);
            goto bp_send;
        }
    }

    for (int i = 0; i < ing_n; i++) {
        if (craft_count_item(player, ing[i].item) < need[i]) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"craft_blueprint_result\",\"success\":false,\"reason\":\"missing_ingredients\",\"index\":%d}", index);
            goto bp_send;
        }
    }

    /* Inventory space for the (non-stacking) quality item */
    bool has_space = false;
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == ITEM_NONE ||
            player->inventory.slots[s].quantity == 0) { has_space = true; break; }
    }
    if (!has_space) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_blueprint_result\",\"success\":false,\"reason\":\"inventory_full\",\"index\":%d}", index);
        goto bp_send;
    }

    for (int i = 0; i < ing_n; i++) craft_consume(player, ing[i].item, need[i]);

    /* All crafts identical: copy the blueprint's rolled payload verbatim. */
    if (!craft_grant_quality(player, item, &bp->quality)) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"craft_blueprint_result\",\"success\":false,\"reason\":\"inventory_full\",\"index\":%d}", index);
        goto bp_send;
    }

    bp->crafts_remaining--;
    uint8_t remaining = bp->crafts_remaining;
    int tier = quality_tier(quality);
    if (remaining == 0) {
        /* Blueprint exhausted — free the slot. */
        memset(bp, 0, sizeof(*bp));
        /* Recompute high-water count. */
        uint8_t hw = 0;
        for (int i = 0; i < MAX_PLAYER_SCHEMATICS; i++)
            if (player->schematics[i].item != 0) hw = (uint8_t)(i + 1);
        player->schematic_count = hw;
    }

    log_info("\u2692 Player %u craft-blueprint %d -> item %u (tier %d, %u crafts left)",
             player->player_id, index, (unsigned)item, tier, (unsigned)remaining);
    snprintf(response, sizeof(response),
             "{\"type\":\"craft_blueprint_result\",\"success\":true,\"index\":%d,"
             "\"item\":%u,\"tier\":%d,\"crafts_remaining\":%u}",
             index, (unsigned)item, tier, (unsigned)remaining);

bp_send:;
    char frame[512];
    size_t frame_len = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (frame_len > 0 && frame_len < sizeof(frame))
        send(client->fd, frame, frame_len, 0);
}

void send_schematic_list(WebSocketPlayer* player, struct WebSocketClient* client) {
    /* Up to 128 entries; each ~110 chars. Build into a heap buffer. */
    size_t cap = 256 + (size_t)MAX_PLAYER_SCHEMATICS * 160;
    char* msg = (char*)malloc(cap);
    if (!msg) return;
    size_t n = 0;
    n += (size_t)snprintf(msg + n, cap - n, "{\"type\":\"schematic_list\",\"items\":[");
    bool first = true;
    for (int i = 0; i < MAX_PLAYER_SCHEMATICS; i++) {
        PlayerBlueprint* bp = &player->schematics[i];
        if (bp->item == 0) continue;
        float q = quality_from_q8(bp->quality.quality_q8);
        n += (size_t)snprintf(msg + n, cap - n,
            "%s{\"i\":%d,\"item\":%u,\"q\":%.2f,\"tier\":%d,\"crafts\":%u,\"stats\":[%u,%u,%u,%u,%u]}",
            first ? "" : ",", i, (unsigned)bp->item, q, quality_tier(q),
            (unsigned)bp->crafts_remaining,
            (unsigned)bp->quality.stat_mult_q8[0], (unsigned)bp->quality.stat_mult_q8[1],
            (unsigned)bp->quality.stat_mult_q8[2], (unsigned)bp->quality.stat_mult_q8[3],
            (unsigned)bp->quality.stat_mult_q8[4]);
        first = false;
        if (n >= cap - 200) break;
    }
    n += (size_t)snprintf(msg + n, cap - n, "]}");

    size_t fcap = n + 16;
    char* frame = (char*)malloc(fcap);
    if (frame) {
        size_t flen = websocket_create_frame(WS_OPCODE_TEXT, msg, n, frame, fcap);
        if (flen > 0 && flen <= fcap) send(client->fd, frame, flen, 0);
        free(frame);
    }
    free(msg);
}
