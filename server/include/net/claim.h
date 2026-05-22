#pragma once
#include "net/websocket_server.h"

/**
 * Register a new island claim when a Flag Fort is placed.
 * Returns false if the island is already claimed or the table is full.
 */
bool claim_register_fort(uint8_t island_id, uint32_t company_id,
                         uint32_t fort_struct_id, uint32_t placer_id);

/**
 * Called automatically from destroy_placed_structure() when a STRUCT_FLAG_FORT
 * is destroyed. Drops the island claim instantly and orphans all linked structures.
 * Contested territory is awarded to the contesting company if one has progress > 0.
 */
void claim_on_fort_destroyed(uint32_t fort_structure_id);

/**
 * Tick claiming-flag timers. Must be called once per server tick with the
 * elapsed milliseconds since last tick.
 */
void claim_tick(uint32_t delta_ms);

/**
 * Apply harvest tax for the given gross yield.
 * Returns the net quantity the player should actually receive.
 */
int claim_apply_harvest_tax(WebSocketPlayer *player, float wx, float wy,
                            int gross_qty, ItemKind item);

/**
 * Called from handle_place_structure after a non-flag structure is added to
 * the world. Scans every other-company active non-orphaned structure whose
 * claim circle overlaps the new structure's claim circle, and appends each
 * such enemy ID to the new structure's `dominators[]` (oldest enemy first,
 * since the scan walks placed_structures in placement order).
 *
 * The enemy structures are NOT modified — only the newcomer takes on
 * dominators. Render-rule X then carves (new ∩ enemy) out of the new
 * structure's visible territory in the enemy's company color.
 *
 * Broadcasts a single `structure_dominators` message for the newcomer if
 * any dominators were registered. Safe to call for any structure type;
 * exits silently if the structure id is unknown.
 */
void claim_register_placement_dominators(uint16_t new_structure_id);
