#pragma once

#include "sim/module_types.h"
#include <stdbool.h>
#include <stdint.h>

struct Ship;
typedef struct SimpleShip SimpleShip;

/** Resource costs for each ship module type (wood, fiber, metal, stone). */
typedef struct {
    uint16_t wood;
    uint16_t fiber;
    uint16_t metal;
    uint16_t stone;
} ShipModuleResourceCost;

extern const ShipModuleResourceCost MODULE_RES_COST[];

bool ship_module_cost_valid(ModuleTypeId type);

/** True when the ship has at least one chest module. */
bool ship_chest_has_module(const SimpleShip *s);

/** Sum all chest module resources on the ship. */
void ship_chest_aggregate(const SimpleShip *s,
                          uint32_t *wood, uint32_t *fiber,
                          uint32_t *metal, uint32_t *stone);

/** True when aggregate chest resources are all zero. */
bool ship_chest_is_empty(const SimpleShip *s);

/** True when aggregate chest resources can afford a full module build/replace. */
bool ship_chest_can_afford(const SimpleShip *s, ModuleTypeId type);

/** Deduct a full module cost from chest modules in order. */
void ship_chest_consume(SimpleShip *s, ModuleTypeId type);

/** Prorated repair cost for `missing_ratio` in (0,1] of MODULE_RES_COST[type]. */
void ship_chest_compute_repair_cost(ModuleTypeId type, float missing_ratio,
                                    uint16_t *wood, uint16_t *fiber,
                                    uint16_t *metal, uint16_t *stone);

bool ship_chest_can_afford_repair(const SimpleShip *s, ModuleTypeId type,
                                  float missing_ratio);

/** Deduct prorated repair cost from chest modules. Returns false if unaffordable. */
bool ship_chest_consume_repair(SimpleShip *s, ModuleTypeId type, float missing_ratio);

/** Mirror chest module data from SimpleShip into the sim-layer ship. */
void ship_chest_sync_to_sim(const SimpleShip *simple, struct Ship *sim_ship);

/** Spawn a chest_ruin flotsam wreck at (wx, wy) with all resources from ship chest modules. */
bool ship_chest_spawn_ruin_wreck(const SimpleShip *s, float wx, float wy);
