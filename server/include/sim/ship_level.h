#ifndef SIM_SHIP_LEVEL_H
#define SIM_SHIP_LEVEL_H

#include <stdint.h>
#include <stdbool.h>

/* Per-attribute max level */
#define SHIP_LEVEL_MAX 10

/* Attributes that can be levelled up on a ship */
typedef enum {
    SHIP_ATTR_WEIGHT     = 0,  /* Increases hull mass → more momentum, harder to stop/push */
    SHIP_ATTR_RESISTANCE = 1,  /* Reduces damage taken (-5 % per level above 1)            */
    SHIP_ATTR_DAMAGE     = 2,  /* Increases cannon damage dealt (+10 % per level above 1)  */
    SHIP_ATTR_CREW       = 3,  /* Increases max crew capacity (+2 per level above 1)       */
    SHIP_ATTR_STURDINESS = 4,  /* Reduces sink drain rate (-8 % per level above 1)         */
    SHIP_ATTR_COUNT      = 5
} ShipAttribute;

/* XP cost to advance one attribute from level L to L+1: SHIP_LEVEL_XP_BASE * L */
#define SHIP_LEVEL_XP_BASE 100u

typedef struct {
    uint8_t  levels[SHIP_ATTR_COUNT];  /* Current level (1–10) for each attribute */
    uint32_t xp;                       /* Unspent XP pool                         */
} ShipLevelStats;

/* Initialise all attributes to level 1 with 0 XP */
void      ship_level_init(ShipLevelStats* stats);

/* XP needed to upgrade attribute from its current level to next (UINT32_MAX if already maxed) */
uint32_t  ship_level_xp_cost(const ShipLevelStats* stats, ShipAttribute attr);

/* Attempt upgrade; returns true and deducts XP on success */
bool      ship_level_upgrade(ShipLevelStats* stats, ShipAttribute attr);

/* --- Attribute effect helpers --- */

/* Damage OUTPUT multiplier (>= 1.0) */
float     ship_level_damage_mult(const ShipLevelStats* stats);

/* Damage RECEIVED multiplier (<= 1.0) */
float     ship_level_resistance_mult(const ShipLevelStats* stats);

/* Sink drain-rate multiplier (<= 1.0) */
float     ship_level_sturdiness_mult(const ShipLevelStats* stats);

/* Hull mass multiplier (>= 1.0) */
float     ship_level_mass_mult(const ShipLevelStats* stats);

/* Max crew: 9 + 2*(crew_level - 1), range 9–27 */
uint8_t   ship_level_max_crew(const ShipLevelStats* stats);

/* Human-readable attribute name (for JSON keys) */
const char* ship_attr_name(ShipAttribute attr);

/* Parse attribute name string; returns SHIP_ATTR_COUNT on unknown */
ShipAttribute ship_attr_from_name(const char* name);

#endif /* SIM_SHIP_LEVEL_H */
