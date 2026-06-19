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

/** Scale base module cost by quality tier multiplier (Crude 1× .. Eternal 3×).
 *  Placement only — repair must use module_base_cost() instead. */
void module_compute_scaled_cost(ModuleTypeId type, float mult, ShipModuleResourceCost *out);

/** Unscaled base module cost (mirrors MODULE_RES_COST). Used for repair/refund. */
void module_base_cost(ModuleTypeId type, ShipModuleResourceCost *out);

/** True when aggregate chest resources can afford a full module build/replace. */
bool ship_chest_can_afford(const SimpleShip *s, ModuleTypeId type);

/** True when aggregate chest resources can afford an explicit cost. */
bool ship_chest_can_afford_cost(const SimpleShip *s, const ShipModuleResourceCost *cost);

/** Deduct a full module cost from chest modules in order. */
void ship_chest_consume(SimpleShip *s, ModuleTypeId type);

/** Deduct an explicit cost from chest modules in order. */
void ship_chest_consume_cost(SimpleShip *s, const ShipModuleResourceCost *cost);

/** Prorated repair cost for `missing_ratio` in (0,1] of the base module cost.
 *  Always uses unscaled MODULE_RES_COST — quality tier never affects repair. */
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
