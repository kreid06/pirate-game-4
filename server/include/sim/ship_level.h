#ifndef SIM_SHIP_LEVEL_H
#define SIM_SHIP_LEVEL_H

#include <stdint.h>
#include <stdbool.h>

/*
 * Ship Levelling System
 * ─────────────────────
 * Each attribute can be upgraded independently by spending XP.
 * Upgrading from level L to L+1 costs SHIP_LEVEL_XP_BASE * L XP.
 *
 * Attribute point caps (max upgrades that can be invested):
 *   Resistance : 35 pts  →  −2% damage taken/level  → 30% of base at max (70% blocked)
 *   Damage     : 35 pts  →  +4% damage out /level   → 240% of base at max
 *   Sturdiness : 25 pts  →  −3% drain rate /level   → 25% of base drain (4× longer) at max
 *   Weight     : 50 pts  (WIP)
 *   Crew       : 50 pts  (WIP)
 *
 * Hard limits:
 *   SHIP_LEVEL_ATTR_POINT_CAP  = 50  – no single attribute may exceed this many points
 *   SHIP_LEVEL_TOTAL_POINT_CAP = 65  – sum of ALL attribute points may not exceed this
 *
 * These caps create meaningful tradeoffs: you cannot fully max Resistance + Damage alone
 * (35+35 = 70 > 65), let alone all five attributes.
 */

/* Per-attribute point investments caps */
#define SHIP_ATTR_POINTS_WEIGHT      50u   /* WIP – capped by global per-attr cap */
#define SHIP_ATTR_POINTS_RESISTANCE  35u
#define SHIP_ATTR_POINTS_DAMAGE      35u
#define SHIP_ATTR_POINTS_CREW        50u   /* WIP – capped by global per-attr cap */
#define SHIP_ATTR_POINTS_STURDINESS  25u

/* Hard cap: no attribute may exceed this many point investments */
#define SHIP_LEVEL_ATTR_POINT_CAP    50u

/* Hard cap: total points across ALL attributes */
#define SHIP_LEVEL_TOTAL_POINT_CAP   65u

/* XP cost to advance one attribute from level L to L+1: SHIP_LEVEL_XP_BASE * L */
#define SHIP_LEVEL_XP_BASE 100u

/* Attributes that can be levelled up on a ship */
typedef enum {
    SHIP_ATTR_WEIGHT     = 0,  /* Increases hull mass, harder to push/stop (WIP)            */
    SHIP_ATTR_RESISTANCE = 1,  /* Reduces damage taken  (−2%/level, floor 0.30)             */
    SHIP_ATTR_DAMAGE     = 2,  /* Increases cannon damage dealt (+4%/level, ceiling 2.40)   */
    SHIP_ATTR_CREW       = 3,  /* Increases max crew capacity (+2/level, WIP)               */
    SHIP_ATTR_STURDINESS = 4,  /* Slows sinking (drain ×0.97/level, floor 0.25 = 4× longer) */
    SHIP_ATTR_COUNT      = 5
} ShipAttribute;

typedef struct {
    uint8_t  levels[SHIP_ATTR_COUNT];  /* Current level (1 = baseline) for each attribute */
    uint32_t xp;                       /* Unspent XP pool                                 */
} ShipLevelStats;

/* Initialise all attributes to level 1 with 0 XP */
void      ship_level_init(ShipLevelStats* stats);

/* Sum of all points spent across all attributes (= sum of levels[i] − 1) */
uint16_t  ship_level_total_points(const ShipLevelStats* stats);

/* Per-attribute point cap (varies by attribute) */
uint8_t   ship_attr_point_cap(ShipAttribute attr);

/* XP needed to upgrade attribute from its current level to next (UINT32_MAX if already maxed) */
uint32_t  ship_level_xp_cost(const ShipLevelStats* stats, ShipAttribute attr);

/* Attempt upgrade; returns true and deducts XP on success.
 * Fails if: not enough XP, attribute already at its point cap, or total points cap reached. */
bool      ship_level_upgrade(ShipLevelStats* stats, ShipAttribute attr);

/* --- Attribute effect helpers --- */

/* Damage OUTPUT multiplier: 1.0 + 0.04*(level-1), max 2.40 at L36 */
float     ship_level_damage_mult(const ShipLevelStats* stats);

/* Damage RECEIVED multiplier: 1.0 − 0.02*(level-1), floor 0.30 at L36 */
float     ship_level_resistance_mult(const ShipLevelStats* stats);

/* Sink drain-rate multiplier: 1.0 − 0.03*(level-1), floor 0.25 at L26 (= 4× longer) */
float     ship_level_sturdiness_mult(const ShipLevelStats* stats);

/* Hull mass multiplier (WIP): 1.0 + 0.05*(level-1) */
float     ship_level_mass_mult(const ShipLevelStats* stats);

/* Max crew (WIP): 9 + 2*(crew_level − 1) */
uint8_t   ship_level_max_crew(const ShipLevelStats* stats);

/* Human-readable attribute name (for JSON keys) */
const char* ship_attr_name(ShipAttribute attr);

/* Parse attribute name string; returns SHIP_ATTR_COUNT on unknown */
ShipAttribute ship_attr_from_name(const char* name);

#endif /* SIM_SHIP_LEVEL_H */
