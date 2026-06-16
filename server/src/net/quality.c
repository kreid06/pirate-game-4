#include "net/quality.h"
#include <math.h>

/* ── RNG ──────────────────────────────────────────────────────────────────── */

float quality_rand_unit(uint32_t *state) {
    uint32_t x = *state ? *state : 0x9e3779b9u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return (float)(x & 0x00FFFFFFu) / (float)0x01000000u;   /* [0,1) */
}

/* ── Encode / tier helpers ────────────────────────────────────────────────── */

uint8_t quality_to_q8(float quality) {
    if (quality < 0.0f) quality = 0.0f;
    float q = quality * 32.0f;
    if (q > 255.0f) q = 255.0f;
    return (uint8_t)(q + 0.5f);
}

float quality_from_q8(uint8_t q8) {
    return (float)q8 / 32.0f;
}

int quality_tier(float quality) {
    int t = (int)floorf(quality);
    if (t < 0) t = 0;
    if (t > 6) t = 6;
    return t;
}

float quality_stat_mult(const QualityPayload *p, QualityStatId stat) {
    if (!p || stat < 0 || stat >= STAT_COUNT) return 1.0f;
    uint16_t m = p->stat_mult_q8[stat];
    if (m == 0) return 1.0f;            /* stat not applicable → neutral */
    return (float)m / 256.0f;
}

/* ── Per-item stat caps & craft counts (docs §3) ──────────────────────────── */

/* multiplier * 256 */
#define CAP_3_0X 768u
#define CAP_2_0X 512u
#define CAP_1_5X 384u

uint8_t quality_item_caps_q8(ItemKind item, uint16_t out[STAT_COUNT]) {
    for (int i = 0; i < STAT_COUNT; i++) out[i] = 0;

    switch (item) {
        case ITEM_CANNON:
        case ITEM_SWIVEL:
            out[STAT_DURABILITY]    = CAP_3_0X;
            out[STAT_WEAPON_DAMAGE] = CAP_3_0X;
            return 20;

        case ITEM_SWORD:
        case ITEM_AXE:
        case ITEM_PICKAXE:
            out[STAT_DURABILITY]    = CAP_3_0X;
            out[STAT_WEAPON_DAMAGE] = CAP_3_0X;
            return 10;

        case ITEM_SAIL:
            out[STAT_DURABILITY]         = CAP_3_0X;
            out[STAT_SAIL_EFFECTIVENESS] = CAP_1_5X;
            return 10;

        case ITEM_PLANK:    out[STAT_DURABILITY] = CAP_3_0X; return 20;
        case ITEM_DECK:     out[STAT_DURABILITY] = CAP_3_0X; return 6;
        case ITEM_HELM:     out[STAT_DURABILITY] = CAP_3_0X; return 8;  /* steering wheel */

        case ITEM_WOODEN_FLOOR: out[STAT_DURABILITY] = CAP_3_0X; return 40;
        case ITEM_WALL:         out[STAT_DURABILITY] = CAP_3_0X; return 40; /* door-frame merged in */
        case ITEM_WOOD_CEILING: out[STAT_DURABILITY] = CAP_3_0X; return 40;
        case ITEM_DOOR:         out[STAT_DURABILITY] = CAP_3_0X; return 20;

        case ITEM_FLAG_FORT:
            out[STAT_DURABILITY]        = CAP_3_0X;
            out[STAT_STRUCT_RESISTANCE] = CAP_2_0X;
            out[STAT_REPAIR_SPEED]      = CAP_2_0X;
            return 3;

        case ITEM_SHIPYARD: out[STAT_DURABILITY] = CAP_3_0X; return 5;

        default:
            return 0;   /* not a quality-craftable item */
    }
}

bool quality_item_is_craftable(ItemKind item) {
    uint16_t caps[STAT_COUNT];
    return quality_item_caps_q8(item, caps) > 0;
}

uint8_t quality_item_max_crafts(ItemKind item) {
    uint16_t caps[STAT_COUNT];
    return quality_item_caps_q8(item, caps);
}

/* ── Rolls ────────────────────────────────────────────────────────────────── */

float quality_roll_from_ghost_level(int ghost_level, uint32_t *rng_state) {
    if (ghost_level < 0) ghost_level = 0;
    float base   = (float)ghost_level / 10.0f;
    float spread = 0.75f + 0.5f * quality_rand_unit(rng_state);  /* [0.75, 1.25) */
    float q = base * spread;
    if (q < 0.0f) q = 0.0f;
    return q;
}

void quality_roll_payload(ItemKind item, float quality, uint32_t *rng_state,
                          QualityPayload *out) {
    uint16_t caps[STAT_COUNT];
    quality_item_caps_q8(item, caps);

    out->quality_q8 = quality_to_q8(quality);

    /* Tier bonus: +QUALITY_TIER_BONUS_PER_TIER per tier level, applied to
     * durability (resistance) and weapon damage after the quality roll cap.
     * This guarantees higher-tier blueprints always outperform lower-tier
     * ones regardless of the random spread. */
    int tier = quality_tier(quality);
    float tier_bonus = (float)tier * QUALITY_TIER_BONUS_PER_TIER;

    for (int s = 0; s < STAT_COUNT; s++) {
        if (caps[s] == 0) { out->stat_mult_q8[s] = 0; continue; }

        float cap   = (float)caps[s] / 256.0f;            /* e.g. 3.0 */
        float step  = (cap - 1.0f) / 7.0f;
        float r     = 0.25f + quality_rand_unit(rng_state);   /* [0.25, 1.25) */
        float bonus = step * (quality + 1.0f) * r;
        float final_mult = 1.0f + bonus;
        if (final_mult < 1.0f) final_mult = 1.0f;
        if (final_mult > cap)  final_mult = cap;

        /* Apply per-tier flat bonus to resistance (durability) and damage. */
        if (s == STAT_DURABILITY || s == STAT_WEAPON_DAMAGE) {
            final_mult += tier_bonus;
        }

        float m = final_mult * 256.0f;
        if (m > 65535.0f) m = 65535.0f;
        out->stat_mult_q8[s] = (uint16_t)(m + 0.5f);
    }
}

float quality_craft_cost_mult(float quality) {
    if (quality < 0.0f) quality = 0.0f;
    if (quality > 6.0f) quality = 6.0f;
    return 1.0f + 2.0f * quality / 6.0f;   /* 1.0 .. 3.0 */
}
