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

/**
 * Erase `dead_id` from every other active structure's dominators[] list and
 * broadcast a fresh `structure_dominators` message for each affected
 * structure. Called from destroy_placed_structure() when an anchor is
 * demolished/destroyed, so it no longer carves territory it once dominated.
 */
void claim_remove_id_from_all_dominators(uint32_t dead_id);

/**
 * Scrub every active structure's dominators[] of any id that does not
 * resolve to a currently-active loaded structure (or that equals the
 * structure's own id). Intended to run once at startup after world_load to
 * heal stale references from older save files. Silent — no broadcasts.
 */
void claim_dominators_sanity_sweep(void);

/**
 * Clear `structure_id`'s dominators[] list and repopulate it by rescanning
 * every overlapping other-company active non-orphaned non-claim-flag
 * structure. Broadcasts the new list if it differs from the prior one.
 * Used post-capture to give victims/challengers a clean, authoritative list
 * regardless of any prior incremental mutations.
 */
void claim_recompute_dominators(uint32_t structure_id);

/* ── Section flood-fill ─────────────────────────────────────────────────────
 *
 * A "section" is one connected component of the union of CLAIMABLE SLICE
 * pieces on an island, where each slice piece = lens(Mi, Ej) ∖ tmp_own.
 *   - Mi ranges over `company_id`'s active non-orphaned anchors on the island
 *     (excluding incomplete flag forts).
 *   - Ej ranges over OTHER companies' active non-orphaned anchors.
 *   - tmp_own = ⋃ over Mi of (Mi.disc ∖ ⋃ Mi.dominators discs).
 *
 * Built on a coarse cell grid (8 world units) covering the bounding box of
 * all qualifying anchors. The grid is flood-filled from (px,py); only the
 * connected component containing the placement point is retained.
 *
 * Returns NULL if (px,py) is not inside any slice piece.
 */
typedef struct {
    float    origin_x, origin_y;
    float    cell_size;
    int      w, h;
    uint8_t *cells;   /* w*h, 1 = in section */
} ClaimSectionGrid;

ClaimSectionGrid *claim_section_build(uint8_t island_id, uint8_t company_id,
                                      float px, float py);
void              claim_section_free(ClaimSectionGrid *g);
bool              claim_section_contains(const ClaimSectionGrid *g,
                                         float x, float y);
bool              claim_section_disc_overlaps(const ClaimSectionGrid *g,
                                              float cx, float cy, float r);

