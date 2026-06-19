#include "net/ship_chest_resources.h"
#include "net/websocket_server_internal.h"
#include "util/log.h"
#include "util/time.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

const ShipModuleResourceCost MODULE_RES_COST[] = {
    [MODULE_TYPE_HELM]        = {  5,  0,  3,  0 },
    [MODULE_TYPE_CANNON]      = {  2,  0,  5,  0 },
    [MODULE_TYPE_MAST]        = { 20, 10,  0,  0 },
    [MODULE_TYPE_SWIVEL]      = {  1,  0,  3,  0 },
    [MODULE_TYPE_PLANK]       = { 10,  0,  0,  0 },
    [MODULE_TYPE_DECK]        = { 15,  0,  0,  0 },
    [MODULE_TYPE_RAMP]        = {  8,  0,  0,  0 },
    [MODULE_TYPE_HATCH_COVER] = {  8,  0,  0,  0 },
    [MODULE_TYPE_GUNPORT]     = {  6,  0,  2,  0 },
    [MODULE_TYPE_WORKBENCH]   = { 12,  0,  0,  0 },
    [MODULE_TYPE_CHEST]       = { 12,  0,  0,  0 },
    [MODULE_TYPE_BED]         = { 10,  5,  0,  0 },
};

#define MODULE_RES_COST_COUNT ((int)(sizeof(MODULE_RES_COST) / sizeof(MODULE_RES_COST[0])))

bool ship_module_cost_valid(ModuleTypeId type) {
    return (int)type >= 0 && (int)type < MODULE_RES_COST_COUNT;
}

bool ship_chest_has_module(const SimpleShip *s) {
    if (!s) return false;
    for (uint8_t m = 0; m < s->module_count; m++) {
        if (s->modules[m].type_id == MODULE_TYPE_CHEST) return true;
    }
    return false;
}

void ship_chest_aggregate(const SimpleShip *s,
                          uint32_t *wood, uint32_t *fiber,
                          uint32_t *metal, uint32_t *stone) {
    uint32_t w = 0, f = 0, me = 0, st = 0;
    if (s) {
        for (uint8_t m = 0; m < s->module_count; m++) {
            if (s->modules[m].type_id != MODULE_TYPE_CHEST) continue;
            w  += s->modules[m].data.chest.wood;
            f  += s->modules[m].data.chest.fiber;
            me += s->modules[m].data.chest.metal;
            st += s->modules[m].data.chest.stone;
        }
    }
    if (wood)  *wood  = w;
    if (fiber) *fiber = f;
    if (metal) *metal = me;
    if (stone) *stone = st;
}

bool ship_chest_is_empty(const SimpleShip *s) {
    uint32_t w, f, me, st;
    ship_chest_aggregate(s, &w, &f, &me, &st);
    return (w + f + me + st) == 0;
}

bool ship_chest_can_afford(const SimpleShip *s, ModuleTypeId type) {
    if (!s) return false;
    if (!ship_module_cost_valid(type)) return true;
    uint32_t wood, fiber, metal, stone;
    ship_chest_aggregate(s, &wood, &fiber, &metal, &stone);
    const ShipModuleResourceCost *cost = &MODULE_RES_COST[type];
    return wood  >= cost->wood
        && fiber >= cost->fiber
        && metal >= cost->metal
        && stone >= cost->stone;
}

static void ship_chest_consume_amounts(SimpleShip *s,
                                        uint16_t need_wood, uint16_t need_fiber,
                                        uint16_t need_metal, uint16_t need_stone) {
    if (!s) return;
    for (uint8_t m = 0; m < s->module_count &&
         (need_wood || need_fiber || need_metal || need_stone); m++) {
        if (s->modules[m].type_id != MODULE_TYPE_CHEST) continue;
        ChestModuleData *c = &s->modules[m].data.chest;
        uint16_t take;
        take = need_wood  <= c->wood  ? need_wood  : c->wood;  c->wood  -= take; need_wood  -= take;
        take = need_fiber <= c->fiber ? need_fiber : c->fiber; c->fiber -= take; need_fiber -= take;
        take = need_metal <= c->metal ? need_metal : c->metal; c->metal -= take; need_metal -= take;
        take = need_stone <= c->stone ? need_stone : c->stone; c->stone -= take; need_stone -= take;
    }
}

void ship_chest_consume(SimpleShip *s, ModuleTypeId type) {
    if (!s || !ship_module_cost_valid(type)) return;
    const ShipModuleResourceCost *cost = &MODULE_RES_COST[type];
    ship_chest_consume_amounts(s, cost->wood, cost->fiber, cost->metal, cost->stone);
}

static uint16_t scale_repair_cost(uint16_t base, float missing_ratio) {
    if (base == 0) return 0;
    if (missing_ratio <= 0.0f) return 0;
    if (missing_ratio >= 1.0f) return base;
    float scaled = (float)base * missing_ratio;
    uint32_t out = (uint32_t)ceilf(scaled);
    if (out < 1u) out = 1u;
    return (uint16_t)out;
}

void ship_chest_compute_repair_cost(ModuleTypeId type, float missing_ratio,
                                    uint16_t *wood, uint16_t *fiber,
                                    uint16_t *metal, uint16_t *stone) {
    if (wood)  *wood  = 0;
    if (fiber) *fiber = 0;
    if (metal) *metal = 0;
    if (stone) *stone = 0;
    if (!ship_module_cost_valid(type)) return;
    if (missing_ratio <= 0.0f) return;
    if (missing_ratio > 1.0f) missing_ratio = 1.0f;
    const ShipModuleResourceCost *base = &MODULE_RES_COST[type];
    if (wood)  *wood  = scale_repair_cost(base->wood,  missing_ratio);
    if (fiber) *fiber = scale_repair_cost(base->fiber, missing_ratio);
    if (metal) *metal = scale_repair_cost(base->metal, missing_ratio);
    if (stone) *stone = scale_repair_cost(base->stone, missing_ratio);
}

bool ship_chest_can_afford_repair(const SimpleShip *s, ModuleTypeId type,
                                  float missing_ratio) {
    if (!s || !ship_chest_has_module(s)) return false;
    if (!ship_module_cost_valid(type)) return true;
    uint16_t need_wood, need_fiber, need_metal, need_stone;
    ship_chest_compute_repair_cost(type, missing_ratio,
                                   &need_wood, &need_fiber, &need_metal, &need_stone);
    uint32_t wood, fiber, metal, stone;
    ship_chest_aggregate(s, &wood, &fiber, &metal, &stone);
    return wood  >= need_wood
        && fiber >= need_fiber
        && metal >= need_metal
        && stone >= need_stone;
}

bool ship_chest_consume_repair(SimpleShip *s, ModuleTypeId type, float missing_ratio) {
    if (!s || !ship_chest_can_afford_repair(s, type, missing_ratio)) return false;
    uint16_t need_wood, need_fiber, need_metal, need_stone;
    ship_chest_compute_repair_cost(type, missing_ratio,
                                   &need_wood, &need_fiber, &need_metal, &need_stone);
    ship_chest_consume_amounts(s, need_wood, need_fiber, need_metal, need_stone);
    return true;
}

void ship_chest_sync_to_sim(const SimpleShip *simple, struct Ship *sim_ship) {
    if (!simple || !sim_ship) return;
    for (uint8_t sm = 0; sm < simple->module_count; sm++) {
        if (simple->modules[sm].type_id != MODULE_TYPE_CHEST) continue;
        for (uint8_t m = 0; m < sim_ship->module_count; m++) {
            if (sim_ship->modules[m].id == simple->modules[sm].id &&
                sim_ship->modules[m].type_id == MODULE_TYPE_CHEST) {
                sim_ship->modules[m].data.chest = simple->modules[sm].data.chest;
                break;
            }
        }
    }
}

bool ship_chest_spawn_ruin_wreck(const SimpleShip *s, float wx, float wy) {
    if (!s || placed_structure_count >= MAX_PLACED_STRUCTURES) return false;

    uint32_t wood, fiber, metal, stone;
    ship_chest_aggregate(s, &wood, &fiber, &metal, &stone);
    if ((wood + fiber + metal + stone) == 0) return false;

    PlacedStructure *wr = &placed_structures[placed_structure_count];
    memset(wr, 0, sizeof(*wr));
    wr->active               = true;
    wr->id                   = next_structure_id++;
    wr->type                 = STRUCT_WRECK;
    wr->x                    = wx;
    wr->y                    = wy;
    wr->island_id            = 0;
    wr->wreck_resource_cache = true;
    wr->chest_wood           = (uint16_t)(wood  > 65535u ? 65535u : wood);
    wr->chest_fiber          = (uint16_t)(fiber > 65535u ? 65535u : fiber);
    wr->chest_metal          = (uint16_t)(metal > 65535u ? 65535u : metal);
    wr->chest_stone          = (uint16_t)(stone > 65535u ? 65535u : stone);
    wr->wreck_expires_ms     = get_time_ms() + 900000u;
    snprintf(wr->placer_name, sizeof(wr->placer_name), "chest_ruin");
    placed_structure_count++;

    char wbcast[256];
    snprintf(wbcast, sizeof(wbcast),
        "{\"type\":\"wreck_spawned\",\"id\":%u,\"x\":%.1f,\"y\":%.1f"
        ",\"wreck_type\":\"chest_ruin\""
        ",\"wood\":%u,\"fiber\":%u,\"metal\":%u,\"stone\":%u"
        ",\"expires_ms\":%u}",
        (unsigned)wr->id, wx, wy,
        (unsigned)wr->chest_wood, (unsigned)wr->chest_fiber,
        (unsigned)wr->chest_metal, (unsigned)wr->chest_stone,
        (unsigned)wr->wreck_expires_ms);
    websocket_server_broadcast(wbcast);
    log_info("📦 Ship chest ruin %u spawned at sink (%.0f,%.0f) [w=%u f=%u m=%u s=%u]",
             (unsigned)wr->id, wx, wy,
             (unsigned)wr->chest_wood, (unsigned)wr->chest_fiber,
             (unsigned)wr->chest_metal, (unsigned)wr->chest_stone);
    return true;
}
