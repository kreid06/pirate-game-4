#ifndef NET_QUALITY_H
#define NET_QUALITY_H

#include <stdint.h>
#include <stdbool.h>
#include "net/quality_payload.h"     /* QualityStatId, QualityPayload */
#include "net/websocket_server.h"   /* ItemKind */

/*
 * Loot Quality & Schematic system — see docs/LOOT_QUALITY_SYSTEM.md.
 *
 * Ghost ships drop blueprints whose `quality` (a continuous float) is rolled once
 * at drop time. Crafting a blueprint produces an item carrying a QualityPayload of
 * per-stat multipliers. All crafts from one blueprint are IDENTICAL: the payload is
 * rolled once at drop and copied verbatim to every crafted item.
 */

/* Display tier band 0..6 from a continuous quality float. */
int quality_tier(float quality);

/*
 * Multiplicative bonus applied to STAT_DURABILITY and STAT_WEAPON_DAMAGE
 * per tier level, after the quality roll cap.
 *   final = quality_mult × (1 + tier × QUALITY_TIER_BONUS_PER_TIER)
 * Tier 1 → ×1.10, Tier 2 → ×1.20, …, Tier 6 → ×1.60.
 * Intentionally exceeds the quality cap — higher-tier blueprints always
 * outperform lower-tier ones regardless of the random roll.
 */
#define QUALITY_TIER_BONUS_PER_TIER 0.10f

/* Encode / decode helpers. */
uint8_t quality_to_q8(float quality);
float   quality_from_q8(uint8_t q8);
float   quality_stat_mult(const QualityPayload *p, QualityStatId stat); /* 1.0 if n/a */

/* True if `item` can drop as a quality blueprint. */
bool quality_item_is_craftable(ItemKind item);

/* Max number of crafts a blueprint of `item` yields. 0 if not craftable. */
uint8_t quality_item_max_crafts(ItemKind item);

/*
 * Fill out[STAT_COUNT] with each stat's cap multiplier in q8 (multiplier*256).
 * A slot of 0 means the stat does not apply to this item. Returns max-crafts.
 */
uint8_t quality_item_caps_q8(ItemKind item, uint16_t out_caps_q8[STAT_COUNT]);

/*
 * Roll quality for a ghost of `ghost_level`:
 *   base    = ghost_level / 10.0
 *   quality = base * rand(0.75, 1.25)     // ±25% spread, "let it ride" (no cap)
 * rng_state is advanced in place.
 */
float quality_roll_from_ghost_level(int ghost_level, uint32_t *rng_state);

/*
 * Roll a full payload for `item` at the given `quality` (Model B: base + bonus):
 *   step  = (cap - 1.0) / 7
 *   bonus = step * (quality + 1) * (0.25 + rand[0,1))
 *   final = clamp(1.0 + bonus, 1.0, cap)
 * Stats that don't apply to the item get stat_mult_q8 = 0.
 */
void quality_roll_payload(ItemKind item, float quality, uint32_t *rng_state,
                          QualityPayload *out);

/* Craft resource cost multiplier: ceil-friendly float in [1.0, 3.0] for a payload's
 * quality. cost = base * (1 + 2 * min(quality,6) / 6). Callers ceil per ingredient. */
float quality_craft_cost_mult(float quality);

/* Deterministic xorshift32 unit RNG in [0,1). Advances state in place. */
float quality_rand_unit(uint32_t *state);

#endif /* NET_QUALITY_H */
