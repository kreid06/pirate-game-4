#include <string.h>
#include <stdio.h>
#include <sys/socket.h>
#include "net/websocket_server_internal.h"
#include "net/websocket_protocol.h"
#include "net/crafting.h"





/** Count total quantity of an item across all inventory slots. */
int craft_count_item(WebSocketPlayer* player, ItemKind item) {
    int total = 0;
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == item)
            total += player->inventory.slots[s].quantity;
    }
    return total;
}

/** Consume `amount` units of `item` from inventory. Returns true on success. */
bool craft_consume(WebSocketPlayer* player, ItemKind item, int amount) {
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
        /* ── Workbench recipes (require workbench proximity) ─────────────── */
        { "craft_plank",         ITEM_PLANK,         1, { {ITEM_WOOD,  30}, {0,0},            {0,0} }, 1, true  },
        { "craft_deck",          ITEM_DECK,          1, { {ITEM_WOOD,  75}, {0,0},            {0,0} }, 1, true  },
        { "craft_sail",          ITEM_SAIL,          1, { {ITEM_WOOD,  40}, {ITEM_FIBER, 100},{0,0} }, 2, true  },
        { "craft_helm",          ITEM_HELM,          1, { {ITEM_WOOD,  10}, {0,0},            {0,0} }, 1, true  },
        { "craft_cannon",        ITEM_CANNON,        1, { {ITEM_WOOD,   8}, {ITEM_METAL,  20},{0,0} }, 2, true  },
        { "craft_swivel",        ITEM_SWIVEL,        1, { {ITEM_WOOD,   5}, {ITEM_METAL,   8},{0,0} }, 2, true  },
        { "craft_sword",         ITEM_SWORD,         1, { {ITEM_WOOD,   2}, {ITEM_METAL,   5},{0,0} }, 2, true  },
        { "craft_wall",          ITEM_WALL,          1, { {ITEM_WOOD,  10}, {0,0},            {0,0} }, 1, true  },
        { "craft_door_frame",    ITEM_DOOR_FRAME,    1, { {ITEM_WOOD,   6}, {0,0},            {0,0} }, 1, true  },
        { "craft_door",          ITEM_DOOR,          1, { {ITEM_WOOD,   4}, {0,0},            {0,0} }, 1, true  },
        { "craft_shipyard",      ITEM_SHIPYARD,      1, { {ITEM_WOOD,  30}, {ITEM_PLANK,  10},{0,0} }, 2, true  },
        { "craft_floor",         ITEM_WOODEN_FLOOR,  1, { {ITEM_WOOD,  20}, {0,0},            {0,0} }, 1, true  },
        { "craft_wood_ceiling",  ITEM_WOOD_CEILING,  1, { {ITEM_WOOD,  15}, {0,0},            {0,0} }, 1, true  },
        { "craft_stone_axe",     ITEM_AXE,           1, { {ITEM_WOOD,   2}, {ITEM_STONE,   5},{0,0} }, 2, true  },
        { "craft_stone_pickaxe", ITEM_PICKAXE,       1, { {ITEM_WOOD,   3}, {ITEM_STONE,   4},{0,0} }, 2, true  },
        { "craft_flag_fort",     ITEM_FLAG_FORT,     1, { {ITEM_WOOD,  40}, {ITEM_STONE,  40},{0,0} }, 2, true  },
        { "craft_company_fortress", ITEM_COMPANY_FORTRESS, 1, { {ITEM_WOOD,100},{ITEM_STONE,100},{ITEM_METAL,20} }, 3, true  },
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
