#include "sim/ship_level.h"
#include <string.h>
#include <stdint.h>

void ship_level_init(ShipLevelStats* stats) {
    memset(stats, 0, sizeof(*stats));
    for (int i = 0; i < SHIP_ATTR_COUNT; i++)
        stats->levels[i] = 1;
}

uint32_t ship_level_xp_cost(const ShipLevelStats* stats, ShipAttribute attr) {
    if (attr >= SHIP_ATTR_COUNT) return UINT32_MAX;
    uint8_t lvl = stats->levels[attr];
    if (lvl >= SHIP_LEVEL_MAX) return UINT32_MAX; /* already maxed */
    return SHIP_LEVEL_XP_BASE * (uint32_t)lvl;
}

bool ship_level_upgrade(ShipLevelStats* stats, ShipAttribute attr) {
    if (attr >= SHIP_ATTR_COUNT) return false;
    uint32_t cost = ship_level_xp_cost(stats, attr);
    if (cost == UINT32_MAX) return false; /* maxed */
    if (stats->xp < cost)   return false; /* not enough XP */
    stats->xp -= cost;
    stats->levels[attr]++;
    return true;
}

/* +10 % per level above 1 */
float ship_level_damage_mult(const ShipLevelStats* stats) {
    return 1.0f + 0.10f * (float)(stats->levels[SHIP_ATTR_DAMAGE] - 1);
}

/* -5 % damage taken per level above 1 (floor 0.55 at L10) */
float ship_level_resistance_mult(const ShipLevelStats* stats) {
    float r = 1.0f - 0.05f * (float)(stats->levels[SHIP_ATTR_RESISTANCE] - 1);
    return r < 0.55f ? 0.55f : r;
}

/* -8 % drain rate per level above 1 (floor 0.28 at L10) */
float ship_level_sturdiness_mult(const ShipLevelStats* stats) {
    float r = 1.0f - 0.08f * (float)(stats->levels[SHIP_ATTR_STURDINESS] - 1);
    return r < 0.28f ? 0.28f : r;
}

/* +5 % hull mass per level above 1 (max 1.45 at L10) */
float ship_level_mass_mult(const ShipLevelStats* stats) {
    return 1.0f + 0.05f * (float)(stats->levels[SHIP_ATTR_WEIGHT] - 1);
}

/* Base 9, +2 per level above 1 → max 27 at L10 */
uint8_t ship_level_max_crew(const ShipLevelStats* stats) {
    return (uint8_t)(9 + 2 * (stats->levels[SHIP_ATTR_CREW] - 1));
}

const char* ship_attr_name(ShipAttribute attr) {
    switch (attr) {
        case SHIP_ATTR_WEIGHT:     return "weight";
        case SHIP_ATTR_RESISTANCE: return "resistance";
        case SHIP_ATTR_DAMAGE:     return "damage";
        case SHIP_ATTR_CREW:       return "crew";
        case SHIP_ATTR_STURDINESS: return "sturdiness";
        default:                   return "unknown";
    }
}

ShipAttribute ship_attr_from_name(const char* name) {
    if (!name) return SHIP_ATTR_COUNT;
    for (ShipAttribute a = 0; a < SHIP_ATTR_COUNT; a++)
        if (strcmp(name, ship_attr_name(a)) == 0) return a;
    return SHIP_ATTR_COUNT; /* unknown */
}
