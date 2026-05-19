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
