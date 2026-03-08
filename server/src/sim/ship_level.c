#include "sim/ship_level.h"
#include <string.h>
#include <stdint.h>

/* Per-attribute point caps, ordered to match ShipAttribute enum */
static const uint8_t s_attr_point_caps[SHIP_ATTR_COUNT] = {
    SHIP_ATTR_POINTS_WEIGHT,      /* SHIP_ATTR_WEIGHT     */
    SHIP_ATTR_POINTS_RESISTANCE,  /* SHIP_ATTR_RESISTANCE */
    SHIP_ATTR_POINTS_DAMAGE,      /* SHIP_ATTR_DAMAGE     */
    SHIP_ATTR_POINTS_CREW,        /* SHIP_ATTR_CREW       */
    SHIP_ATTR_POINTS_STURDINESS,  /* SHIP_ATTR_STURDINESS */
};

void ship_level_init(ShipLevelStats* stats) {
    memset(stats, 0, sizeof(*stats));
    for (int i = 0; i < SHIP_ATTR_COUNT; i++)
        stats->levels[i] = 1;
}

uint16_t ship_level_total_points(const ShipLevelStats* stats) {
    uint16_t total = 0;
    for (int i = 0; i < SHIP_ATTR_COUNT; i++)
        total += (uint16_t)(stats->levels[i] - 1);
    return total;
}

uint8_t ship_attr_point_cap(ShipAttribute attr) {
    if (attr >= SHIP_ATTR_COUNT) return 0;
    uint8_t cap = s_attr_point_caps[attr];
    return cap < SHIP_LEVEL_ATTR_POINT_CAP ? cap : (uint8_t)SHIP_LEVEL_ATTR_POINT_CAP;
}

uint32_t ship_level_xp_cost(const ShipLevelStats* stats, ShipAttribute attr) {
    if (attr >= SHIP_ATTR_COUNT) return UINT32_MAX;
    uint8_t points_spent = (uint8_t)(stats->levels[attr] - 1);
    if (points_spent >= ship_attr_point_cap(attr)) return UINT32_MAX; /* at attribute cap */
    if (ship_level_total_points(stats) >= SHIP_LEVEL_TOTAL_POINT_CAP) return UINT32_MAX; /* at total cap */
    return SHIP_LEVEL_XP_BASE * (uint32_t)stats->levels[attr];
}

bool ship_level_upgrade(ShipLevelStats* stats, ShipAttribute attr) {
    if (attr >= SHIP_ATTR_COUNT) return false;
    uint8_t points_spent = (uint8_t)(stats->levels[attr] - 1);
    if (points_spent >= ship_attr_point_cap(attr)) return false; /* attribute maxed */
    if (ship_level_total_points(stats) >= SHIP_LEVEL_TOTAL_POINT_CAP) return false; /* total cap */
    uint32_t cost = SHIP_LEVEL_XP_BASE * (uint32_t)stats->levels[attr];
    if (stats->xp < cost) return false; /* not enough XP */
    stats->xp -= cost;
    stats->levels[attr]++;
    return true;
}

/*
 * Damage OUTPUT multiplier.
 * +4% per level above 1; at L36 (35 pts): 1.0 + 0.04*35 = 2.40 (240% of base).
 */
float ship_level_damage_mult(const ShipLevelStats* stats) {
    return 1.0f + 0.04f * (float)(stats->levels[SHIP_ATTR_DAMAGE] - 1);
}

/*
 * Damage RECEIVED multiplier.
 * −2% per level above 1; at L36 (35 pts): 1.0 − 0.02*35 = 0.30 (70% blocked).
 */
float ship_level_resistance_mult(const ShipLevelStats* stats) {
    float r = 1.0f - 0.02f * (float)(stats->levels[SHIP_ATTR_RESISTANCE] - 1);
    return r < 0.30f ? 0.30f : r;
}

/*
 * Sink drain-rate multiplier.
 * −3% per level above 1; at L26 (25 pts): 1.0 − 0.03*25 = 0.25 (ship sinks 4× slower).
 */
float ship_level_sturdiness_mult(const ShipLevelStats* stats) {
    float r = 1.0f - 0.03f * (float)(stats->levels[SHIP_ATTR_STURDINESS] - 1);
    return r < 0.25f ? 0.25f : r;
}

/*
 * Hull mass multiplier (WIP).
 * +5% per level above 1.
 */
float ship_level_mass_mult(const ShipLevelStats* stats) {
    return 1.0f + 0.05f * (float)(stats->levels[SHIP_ATTR_WEIGHT] - 1);
}

/*
 * Maximum crew capacity (WIP).
 * Base 9, +2 per level above 1.
 */
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
    return SHIP_ATTR_COUNT;
}
