#include "net/ship_schematics.h"
#include "net/crafting.h"
#include "net/quality.h"
#include "net/websocket_server_internal.h"
#include "net/websocket_protocol.h"
#include "util/log.h"
#include "util/time.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void ws_send_json(struct WebSocketClient* client, const char* msg) {
    if (!client || !msg) return;
    char frame[512];
    size_t len = strlen(msg);
    size_t flen = websocket_create_frame(WS_OPCODE_TEXT, msg, len, frame, sizeof(frame));
    if (flen > 0 && flen <= sizeof(frame))
        send(client->fd, frame, flen, 0);
}

bool ship_schematic_item_allowed(ItemKind item) {
    switch (item) {
        case ITEM_PLANK:
        case ITEM_DECK:
        case ITEM_CANNON:
        case ITEM_SWIVEL:
        case ITEM_SAIL:
        case ITEM_HELM:
        case ITEM_RAMP:
            return true;
        default:
            return false;
    }
}

ItemKind ship_schematic_item_from_module_type(ModuleTypeId type) {
    switch (type) {
        case MODULE_TYPE_PLANK:           return ITEM_PLANK;
        case MODULE_TYPE_DECK:            return ITEM_DECK;
        case MODULE_TYPE_CANNON:          return ITEM_CANNON;
        case MODULE_TYPE_SWIVEL:          return ITEM_SWIVEL;
        case MODULE_TYPE_MAST:            return ITEM_SAIL;
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL:  return ITEM_HELM;
        case MODULE_TYPE_RAMP:            return ITEM_RAMP;
        default:                          return ITEM_NONE;
    }
}

static int ship_schematic_best_slot(const SimpleShip* ship, ItemKind item, uint8_t* out_prio) {
    int best_slot = -1;
    uint8_t best_prio = 255;
    for (uint8_t i = 0; i < ship->ship_schematic_count; i++) {
        const ShipPoolBlueprint* bp = &ship->ship_schematics[i];
        if (bp->item != (uint8_t)item || bp->crafts_remaining == 0) continue;
        if (best_slot < 0 || bp->priority < best_prio) {
            best_slot = (int)i;
            best_prio = bp->priority;
        }
    }
    if (out_prio && best_slot >= 0) *out_prio = best_prio;
    return best_slot;
}

static bool player_can_manage_ship_pool(WebSocketPlayer* player, SimpleShip* ship) {
    if (!player || !ship || !ship->active) return false;
    if (player->parent_ship_id != ship->ship_id) return false;
    if (player->company_id != ship->company_id) return false;
    if (ship->company_id == COMPANY_UNCLAIMED || ship->company_id == COMPANY_GHOST) return false;
    return true;
}

static void ship_pool_remove_slot(SimpleShip* ship, int slot) {
    if (!ship || slot < 0 || slot >= (int)ship->ship_schematic_count) return;
    for (int i = slot; i < (int)ship->ship_schematic_count - 1; i++)
        ship->ship_schematics[i] = ship->ship_schematics[i + 1];
    ship->ship_schematic_count--;
    memset(&ship->ship_schematics[ship->ship_schematic_count], 0, sizeof(ShipPoolBlueprint));
}

static uint8_t ship_pool_next_priority(const SimpleShip* ship, uint8_t item) {
    uint8_t max_prio = 0;
    bool found = false;
    for (uint8_t i = 0; i < ship->ship_schematic_count; i++) {
        if (ship->ship_schematics[i].item != item) continue;
        found = true;
        if (ship->ship_schematics[i].priority >= max_prio)
            max_prio = (uint8_t)(ship->ship_schematics[i].priority + 1);
    }
    return found ? max_prio : 0;
}

bool ship_schematic_consume_for_item(SimpleShip* ship, ItemKind item, QualityPayload* out_q) {
    if (!ship || !out_q || !ship_schematic_item_allowed(item)) return false;

    uint8_t best_prio = 255;
    int best_slot = ship_schematic_best_slot(ship, item, &best_prio);
    if (best_slot < 0) return false;

    ShipPoolBlueprint* bp = &ship->ship_schematics[best_slot];
    *out_q = bp->quality;
    log_info("📋 Ship %u pool consume item=%u slot=%d priority=%u crafts_before=%u",
             (unsigned)ship->ship_id, (unsigned)item, best_slot, (unsigned)best_prio,
             (unsigned)bp->crafts_remaining);
    if (--bp->crafts_remaining == 0)
        ship_pool_remove_slot(ship, best_slot);
    return true;
}

void send_ship_schematic_list(SimpleShip* ship, struct WebSocketClient* client) {
    if (!ship || !client) return;

    size_t cap = 256 + (size_t)MAX_SHIP_SCHEMATICS * 180;
    char* msg = (char*)malloc(cap);
    if (!msg) return;

    size_t n = 0;
    n += (size_t)snprintf(msg + n, cap - n,
        "{\"type\":\"ship_schematic_list\",\"ship_id\":%u,\"items\":[",
        (unsigned)ship->ship_id);

    bool first = true;
    for (uint8_t i = 0; i < ship->ship_schematic_count; i++) {
        ShipPoolBlueprint* bp = &ship->ship_schematics[i];
        if (bp->item == 0 || bp->crafts_remaining == 0) continue;
        float q = quality_from_q8(bp->quality.quality_q8);
        n += (size_t)snprintf(msg + n, cap - n,
            "%s{\"i\":%u,\"item\":%u,\"q\":%.2f,\"tier\":%d,\"crafts\":%u,\"prio\":%u,\"stats\":[%u,%u,%u,%u,%u]}",
            first ? "" : ",",
            (unsigned)i, (unsigned)bp->item, q, quality_tier(q),
            (unsigned)bp->crafts_remaining, (unsigned)bp->priority,
            (unsigned)bp->quality.stat_mult_q8[0], (unsigned)bp->quality.stat_mult_q8[1],
            (unsigned)bp->quality.stat_mult_q8[2], (unsigned)bp->quality.stat_mult_q8[3],
            (unsigned)bp->quality.stat_mult_q8[4]);
        first = false;
        if (n >= cap - 200) break;
    }
    n += (size_t)snprintf(msg + n, cap - n, "]}");

    char frame[4096];
    size_t flen = websocket_create_frame(WS_OPCODE_TEXT, msg, n, frame, sizeof(frame));
    if (flen > 0 && flen <= sizeof(frame))
        send(client->fd, frame, flen, 0);
    free(msg);
}

void ship_schematic_broadcast_list(uint16_t ship_id) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return;
    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
        if (!ws_server.clients[ci].connected || !ws_server.clients[ci].handshake_complete ||
            ws_server.clients[ci].player_id == 0) continue;
        WebSocketPlayer* p = find_player(ws_server.clients[ci].player_id);
        if (!p || !p->active || p->parent_ship_id != ship_id) continue;
        send_ship_schematic_list(ship, &ws_server.clients[ci]);
    }
}

static uint16_t parse_ship_id(const char* payload) {
    const char* p = strstr(payload, "\"ship_id\":");
    if (!p) return 0;
    unsigned sid = 0;
    sscanf(p + 10, "%u", &sid);
    return (uint16_t)sid;
}

void handle_request_ship_schematics(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    uint16_t ship_id = parse_ship_id(payload);
    if (ship_id == 0) ship_id = player->parent_ship_id;
    SimpleShip* ship = find_ship(ship_id);
    if (!ship || !player_can_manage_ship_pool(player, ship)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"ship_schematic_denied\"}");
        return;
    }
    send_ship_schematic_list(ship, client);
}

void handle_ship_schematic_deposit(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    uint16_t ship_id = parse_ship_id(payload);
    int bp_index = -1;
    const char* pi = strstr(payload, "\"player_bp_index\":");
    if (pi) sscanf(pi + 18, "%d", &bp_index);

    SimpleShip* ship = find_ship(ship_id);
    if (!ship || !player_can_manage_ship_pool(player, ship)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"ship_schematic_denied\"}");
        return;
    }
    if (bp_index < 0 || bp_index >= MAX_PLAYER_SCHEMATICS ||
        player->schematics[bp_index].item == 0 ||
        player->schematics[bp_index].crafts_remaining == 0) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_schematic\"}");
        return;
    }
    if (ship->ship_schematic_count >= MAX_SHIP_SCHEMATICS) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"ship_schematic_full\"}");
        return;
    }

    PlayerBlueprint* src = &player->schematics[bp_index];
    ItemKind item = (ItemKind)src->item;
    if (!ship_schematic_item_allowed(item)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"item_not_allowed\"}");
        return;
    }

    ShipPoolBlueprint* dst = &ship->ship_schematics[ship->ship_schematic_count++];
    dst->item             = src->item;
    dst->crafts_remaining = src->crafts_remaining;
    dst->quality          = src->quality;
    dst->priority         = ship_pool_next_priority(ship, src->item);

    if (!schematic_remove_at(player, bp_index)) {
        ship_pool_remove_slot(ship, (int)ship->ship_schematic_count - 1);
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_schematic\"}");
        return;
    }

    send_schematic_list(player, client);
    send_ship_schematic_list(ship, client);
    ship_schematic_broadcast_list(ship_id);
    log_info("📋 Player %u deposited schematic item=%u onto ship %u (pool size=%u)",
             player->player_id, (unsigned)item, (unsigned)ship_id,
             (unsigned)ship->ship_schematic_count);
}

void handle_ship_schematic_withdraw(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    uint16_t ship_id = parse_ship_id(payload);
    int pool_index = -1;
    const char* pi = strstr(payload, "\"pool_index\":");
    if (pi) sscanf(pi + 13, "%d", &pool_index);

    SimpleShip* ship = find_ship(ship_id);
    if (!ship || !player_can_manage_ship_pool(player, ship)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"ship_schematic_denied\"}");
        return;
    }
    if (pool_index < 0 || pool_index >= (int)ship->ship_schematic_count) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_pool_index\"}");
        return;
    }

    ShipPoolBlueprint* src = &ship->ship_schematics[pool_index];
    if (!schematic_add(player, (ItemKind)src->item, src->crafts_remaining, &src->quality)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"player_schematic_full\"}");
        return;
    }

    ship_pool_remove_slot(ship, pool_index);
    send_schematic_list(player, client);
    send_ship_schematic_list(ship, client);
    ship_schematic_broadcast_list(ship_id);
}

bool ship_has_workbench(const SimpleShip* ship) {
    if (!ship) return false;
    for (uint8_t m = 0; m < ship->module_count; m++) {
        if (ship->modules[m].type_id == MODULE_TYPE_WORKBENCH) return true;
    }
    return false;
}

#define WRECK_BP_SLOTS 6

static int spawn_schematic_wreck_batch(float wx, float wy, int batch_idx,
                                       const ShipPoolBlueprint* batch, int batch_count) {
    if (batch_count <= 0 || placed_structure_count >= MAX_PLACED_STRUCTURES) return 0;

    PlacedStructure* w = &placed_structures[placed_structure_count];
    memset(w, 0, sizeof(*w));
    w->active           = true;
    w->id               = next_structure_id++;
    w->type             = STRUCT_WRECK;
    {
        float ang = (float)batch_idx * 0.85f;
        w->x = wx + cosf(ang) * 18.0f;
        w->y = wy + sinf(ang) * 18.0f;
    }
    w->island_id        = 0;
    w->wreck_expires_ms = get_time_ms() + 900000u; /* 15 min */
    w->wreck_loot_count = 0;

    for (int i = 0; i < batch_count && i < WRECK_BP_SLOTS; i++) {
        w->wreck_bp_items[i]  = batch[i].item;
        w->wreck_bp_crafts[i] = batch[i].crafts_remaining;
        w->wreck_bp_quality[i] = batch[i].quality;
    }
    w->wreck_bp_count = (uint8_t)batch_count;
    w->hp             = (uint16_t)(batch_count > 0 ? batch_count : 1);
    w->max_hp         = w->hp;

    int wreck_tier = -1;
    for (int bi = 0; bi < batch_count; bi++) {
        int t = quality_tier(quality_from_q8(batch[bi].quality.quality_q8));
        if (t > wreck_tier) wreck_tier = t;
    }

    snprintf(w->placer_name, sizeof(w->placer_name), "workbench_ruin");
    placed_structure_count++;

    char wbcast[280];
    snprintf(wbcast, sizeof(wbcast),
        "{\"type\":\"wreck_spawned\",\"id\":%u,\"x\":%.1f,\"y\":%.1f,"
        "\"loot_count\":0,\"bp_count\":%u,\"wreck_tier\":%d"
        ",\"wreck_type\":\"schematic_cache\""
        ",\"expires_ms\":%u}",
        (unsigned)w->id, w->x, w->y,
        (unsigned)w->wreck_bp_count, wreck_tier,
        (unsigned)w->wreck_expires_ms);
    websocket_server_broadcast(wbcast);
    return 1;
}

int ship_schematic_spawn_pool_wrecks(SimpleShip* ship, float wx, float wy) {
    if (!ship || ship->ship_schematic_count == 0) return 0;

    ShipPoolBlueprint copies[MAX_SHIP_SCHEMATICS];
    uint8_t total = ship->ship_schematic_count;
    if (total > MAX_SHIP_SCHEMATICS) total = MAX_SHIP_SCHEMATICS;
    memcpy(copies, ship->ship_schematics, (size_t)total * sizeof(ShipPoolBlueprint));

    memset(ship->ship_schematics, 0, sizeof(ship->ship_schematics));
    ship->ship_schematic_count = 0;

    int wrecks = 0;
    int offset = 0;
    while (offset < (int)total) {
        int batch = (int)total - offset;
        if (batch > WRECK_BP_SLOTS) batch = WRECK_BP_SLOTS;
        wrecks += spawn_schematic_wreck_batch(wx, wy, wrecks, &copies[offset], batch);
        offset += batch;
    }

    log_info("📋 Ship %u workbench destroyed — spawned %d schematic cache wreck(s) (%u blueprints)",
             (unsigned)ship->ship_id, wrecks, (unsigned)total);
    return wrecks;
}

void handle_ship_schematic_reorder(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    uint16_t ship_id = parse_ship_id(payload);
    unsigned item = 0;
    const char* pi = strstr(payload, "\"item\":");
    if (pi) sscanf(pi + 7, "%u", &item);

    SimpleShip* ship = find_ship(ship_id);
    if (!ship || !player_can_manage_ship_pool(player, ship)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"ship_schematic_denied\"}");
        return;
    }
    if (!ship_schematic_item_allowed((ItemKind)item)) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_item\"}");
        return;
    }

    const char* order_start = strstr(payload, "\"order\":[");
    if (!order_start) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"missing_order\"}");
        return;
    }
    order_start += 9;

    int slots[MAX_SHIP_SCHEMATICS];
    int order_count = 0;
    const char* cur = order_start;
    while (*cur && *cur != ']' && order_count < MAX_SHIP_SCHEMATICS) {
        while (*cur == ' ' || *cur == ',') cur++;
        if (*cur == ']') break;
        int idx = -1;
        if (sscanf(cur, "%d", &idx) == 1) {
            slots[order_count++] = idx;
            while (*cur && *cur != ',' && *cur != ']') cur++;
        } else {
            break;
        }
    }

    /* Validate: every index must refer to a pool entry of the requested item type,
     * and the order must include every such entry exactly once. */
    int expected = 0;
    for (uint8_t i = 0; i < ship->ship_schematic_count; i++) {
        if (ship->ship_schematics[i].item == (uint8_t)item) expected++;
    }
    if (order_count != expected) {
        ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_order\"}");
        return;
    }

    bool seen[MAX_SHIP_SCHEMATICS] = {false};
    for (int i = 0; i < order_count; i++) {
        int slot = slots[i];
        if (slot < 0 || slot >= (int)ship->ship_schematic_count || seen[slot]) {
            ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_order\"}");
            return;
        }
        if (ship->ship_schematics[slot].item != (uint8_t)item) {
            ws_send_json(client, "{\"type\":\"error\",\"message\":\"invalid_order\"}");
            return;
        }
        seen[slot] = true;
        ship->ship_schematics[slot].priority = (uint8_t)i;
    }

    log_info("📋 Ship %u schematic priority updated item=%u (%d entries)",
             (unsigned)ship_id, item, order_count);
    for (int i = 0; i < order_count; i++) {
        log_info("   prio %d → pool slot %d", i, slots[i]);
    }

    send_ship_schematic_list(ship, client);
    ship_schematic_broadcast_list(ship_id);
}
