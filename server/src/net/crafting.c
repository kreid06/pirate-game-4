#include <string.h>
#include <stdio.h>
#include <sys/socket.h>
#include "net/websocket_server_internal.h"
#include "net/websocket_protocol.h"
#include "net/crafting.h"





/** Count total quantity of an item across all inventory slots. */
static int craft_count_item(WebSocketPlayer* player, ItemKind item) {
    int total = 0;
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item == item)
            total += player->inventory.slots[s].quantity;
    }
    return total;
}

/** Consume `amount` units of `item` from inventory. Returns true on success. */
static bool craft_consume(WebSocketPlayer* player, ItemKind item, int amount) {
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
        CraftIng    ing[2];
        int         ing_count;
    } CraftRecipe;

    static const CraftRecipe recipes[] = {
        { "craft_plank",         ITEM_PLANK,        1, { {ITEM_WOOD, 30}, {0,0}             }, 1 },
        { "craft_sail",          ITEM_SAIL,          1, { {ITEM_WOOD, 40}, {ITEM_FIBER, 100} }, 2 },
        { "craft_helm",          ITEM_HELM,          1, { {ITEM_WOOD, 10}, {0,0}             }, 1 },
        { "craft_cannon",        ITEM_CANNON,        1, { {ITEM_WOOD,  8}, {ITEM_METAL, 20}  }, 2 },
        { "craft_swivel",        ITEM_SWIVEL,        1, { {ITEM_WOOD,  5}, {ITEM_METAL,  8}  }, 2 },
        { "craft_sword",         ITEM_SWORD,         1, { {ITEM_WOOD,  2}, {ITEM_METAL,  5}  }, 2 },
        { "craft_wall",          ITEM_WALL,          4, { {ITEM_WOOD, 10}, {0,0}             }, 1 },
        { "craft_door_frame",    ITEM_DOOR_FRAME,    1, { {ITEM_WOOD,  6}, {0,0}             }, 1 },
        { "craft_door",          ITEM_DOOR,          1, { {ITEM_WOOD,  4}, {0,0}             }, 1 },
        { "craft_shipyard",      ITEM_SHIPYARD,      1, { {ITEM_WOOD, 30}, {ITEM_PLANK, 10}  }, 2 },
        /* Workbench-only recipes */
        { "craft_floor",         ITEM_WOODEN_FLOOR,  1, { {ITEM_WOOD, 20}, {0,0}             }, 1 },
        { "craft_workbench",     ITEM_WORKBENCH,     1, { {ITEM_WOOD, 15}, {ITEM_STONE, 10}  }, 2 },
        { "craft_wood_ceiling",  ITEM_WOOD_CEILING,  1, { {ITEM_WOOD, 15}, {0,0}             }, 1 },
        { "craft_stone_axe",     ITEM_AXE,           1, { {ITEM_WOOD,  2}, {ITEM_STONE,  5}  }, 2 },
        { "craft_stone_pickaxe", ITEM_PICKAXE,       1, { {ITEM_WOOD,  2}, {ITEM_STONE,  4}  }, 2 },
        { "craft_hammer",        ITEM_HAMMER,        1, { {ITEM_WOOD,  4}, {0,0}             }, 1 },
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
