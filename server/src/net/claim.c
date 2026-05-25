/**
 * claim.c — Island territory claim system.
 *
 * Mechanics:
 *  - A Flag Fort (STRUCT_FLAG_FORT) anchors a company's claim on an entire island.
 *    Only one fort per island; placing a second on an already-claimed island fails.
 *
 *  - Every active company-owned structure (wall, floor, workbench, flag fort, …)
 *    projects CLAIM_RADIUS_DEFAULT (400 px) of territory around it, provided the
 *    structure is reachable via an unbroken graph of same-company structures back
 *    to the flag fort.  Orphaned structures (fort destroyed, chain broken) keep
 *    their HP/physics but project no radius and cannot block enemy builds.
 *
 *  - A Claiming Flag (STRUCT_CLAIM_FLAG) placed inside contested territory
 *    ticks toward ISLAND_CLAIM_CAPTURE_MS (60 s).  If an enemy stands within
 *    CLAIM_RADIUS_DEFAULT of the flag, progress reverses at ISLAND_CLAIM_REVERSE×
 *    speed.  On completion, all enemy structures within CLAIM_RADIUS_DEFAULT of
 *    the flag transfer to the placer's company.
 *
 *  - On Fort destruction: the island claim drops instantly.  Contested territory
 *    goes to whoever was contesting it (if a claim flag had progress).  All
 *    structures linked to the dead fort become orphaned (claim_orphaned = true).
 *
 *  - Harvest tax: ISLAND_CLAIM_TAX_RATE (10 %) of each harvest is diverted to
 *    the island owner when a player of a different company harvests on that island.
 */

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdbool.h>
#include <sys/socket.h>

#include "net/websocket_server_internal.h"
#include "net/websocket_protocol.h"
#include "net/structures.h"
#include "net/claim.h"
#include "sim/island.h"
#include "util/log.h"
#include "util/time.h"

/* ── Global claim table ──────────────────────────────────────────────────── */

IslandClaim island_claims[MAX_ISLAND_CLAIMS];
int         island_claim_count = 0;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

static inline float dist2(float ax, float ay, float bx, float by) {
    float dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}

/** Effective claim radius for a structure type. */
static inline float struct_claim_radius(PlacedStructureType t) {
    if (t == STRUCT_FLAG_FORT)      return CLAIM_RADIUS_FLAG_FORT;
    if (t == STRUCT_COMPANY_FORTRESS) return CLAIM_RADIUS_COMPANY_FORT;
    return CLAIM_RADIUS_DEFAULT;
}

/** Only floors, flag forts, and company forts participate in the DOM system.
 *  Workbenches, claim flags, and any future decorative structures must never
 *  appear in a DOM list or have their own DOM list populated. */
static inline bool dom_eligible(PlacedStructureType t) {
    return t == STRUCT_WOODEN_FLOOR
        || t == STRUCT_FLAG_FORT
        || t == STRUCT_COMPANY_FORTRESS;
}

/** Remove `id` from `s->dominators[]` if present. Returns true if removed. */
static inline bool dominators_remove(PlacedStructure *s, uint32_t id) {
    int found = -1;
    for (int k = 0; k < s->dominator_count; k++) {
        if (s->dominators[k] == id) { found = k; break; }
    }
    if (found < 0) return false;
    for (int k = found; k < s->dominator_count - 1; k++) {
        s->dominators[k] = s->dominators[k + 1];
    }
    s->dominator_count--;
    return true;
}

/** Prepend `id` to `s->dominators[]` at index 0, deduping first. Returns true
 *  if the list was changed. Drops the tail when at capacity. */
static inline bool dominators_prepend(PlacedStructure *s, uint32_t id) {
    dominators_remove(s, id);
    int cap = s->dominator_count;
    if (cap >= MAX_DOMINATORS) cap = MAX_DOMINATORS - 1;
    for (int k = cap; k > 0; k--) s->dominators[k] = s->dominators[k - 1];
    s->dominators[0] = id;
    if (s->dominator_count < MAX_DOMINATORS) s->dominator_count++;
    return true;
}

/** Append `id` at the tail of `s->dominators[]` (no-op if already present
 *  or at capacity). Returns true if the list was changed. */
static inline bool dominators_append(PlacedStructure *s, uint32_t id) {
    for (int k = 0; k < s->dominator_count; k++) {
        if (s->dominators[k] == id) return false;
    }
    if (s->dominator_count >= MAX_DOMINATORS) return false;
    s->dominators[s->dominator_count++] = id;
    return true;
}

/** Move `id` to the LAST slot of `s->dominators[]` if it is currently in the
 *  list above the last slot. No-op if absent or already at the bottom.
 *  Returns true if the list order changed. */
static inline bool dominators_demote_to_bottom(PlacedStructure *s, uint32_t id) {
    int found = -1;
    for (int k = 0; k < s->dominator_count; k++) {
        if (s->dominators[k] == id) { found = k; break; }
    }
    if (found < 0) return false;
    if (found == s->dominator_count - 1) return false;
    for (int k = found; k < s->dominator_count - 1; k++) {
        s->dominators[k] = s->dominators[k + 1];
    }
    s->dominators[s->dominator_count - 1] = id;
    return true;
}

/** Broadcast `{"type":"structure_dominators","structure_id":N,"dominators":[…]}`
 *  for a single structure. */
static void broadcast_structure_dominators(const PlacedStructure *s) {
    char msg[1024];
    int dp = snprintf(msg, sizeof(msg),
        "{\"type\":\"structure_dominators\",\"structure_id\":%u,\"dominators\":[",
        s->id);
    for (int k = 0; k < s->dominator_count; k++) {
        dp += snprintf(msg + dp, sizeof(msg) - dp,
                       "%s%u", k ? "," : "", s->dominators[k]);
    }
    snprintf(msg + dp, sizeof(msg) - dp, "]}");
    websocket_server_broadcast(msg);
}

/** When a structure becomes inactive (orphaned by BFS disconnect or claim
 *  capture), it should no longer carry priority in anyone else's dominators
 *  list. Demote `orphaned_id` to the BOTTOM of every other structure's
 *  dominators[] (preserves the entry so that if the structure reactivates
 *  later, it remains in the list but at lowest priority). Broadcasts a
 *  fresh dominators message per affected structure. */
static void claim_demote_orphaned_in_all_dominators(uint32_t orphaned_id) {
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *ps = &placed_structures[i];
        if (!ps->active) continue;
        if (ps->id == orphaned_id) continue;
        if (dominators_demote_to_bottom(ps, orphaned_id)) {
            broadcast_structure_dominators(ps);
        }
    }
}

/** Public: erase a destroyed structure's id from every other structure's
 *  dominators[] list and broadcast updates. Called from
 *  destroy_placed_structure() so that a demolished anchor stops carving any
 *  territory it previously dominated. */
void claim_remove_id_from_all_dominators(uint32_t dead_id) {
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *ps = &placed_structures[i];
        if (!ps->active) continue;
        if (ps->id == dead_id) continue;
        if (dominators_remove(ps, dead_id)) {
            broadcast_structure_dominators(ps);
        }
    }
}

/** Public: sweep every active structure's dominators[] and drop any entry
 *  whose id does not resolve to an active loaded structure. Intended to run
 *  once after world_load to scrub stale references from older save files or
 *  corrupted state. Silent (no broadcast) — callers run this before any
 *  clients connect. */
void claim_dominators_sanity_sweep(void) {
    uint32_t scrubbed = 0;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *ps = &placed_structures[i];
        if (!ps->active) continue;
        int w = 0;
        for (int r = 0; r < ps->dominator_count; r++) {
            uint32_t did = ps->dominators[r];
            bool valid = false;
            if (did != ps->id) {
                for (uint32_t j = 0; j < placed_structure_count; j++) {
                    if (placed_structures[j].id == did && placed_structures[j].active) {
                        valid = true;
                        break;
                    }
                }
            }
            if (valid) {
                ps->dominators[w++] = did;
            } else {
                scrubbed++;
            }
        }
        ps->dominator_count = (uint8_t)w;
    }
    if (scrubbed > 0) {
        log_info("🧹 Dominators sanity sweep: removed %u stale id(s)", scrubbed);
    }
}

/** Public: clear a single structure's dominators[] list and repopulate it
 *  by scanning every active non-orphaned non-same-company non-claim-flag
 *  structure whose claim disc overlaps the target's. Used after a capture
 *  flips the contested section so victims/challengers end with a list
 *  that exactly reflects their NEW dominance relationships, regardless of
 *  any prior incremental state. Broadcasts the new list if it changed. */
void claim_recompute_dominators(uint32_t structure_id) {
    PlacedStructure *me = NULL;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].id == structure_id) {
            me = &placed_structures[i];
            break;
        }
    }
    if (!me || !me->active) return;
    /* Only DOM-eligible structures (floors, flag forts, company forts) can
     * have a DOM list.  Workbenches etc. are ignored entirely. */
    if (!dom_eligible(me->type)) return;

    /* Snapshot prior list so we can suppress redundant broadcasts. */
    uint32_t prev[MAX_DOMINATORS];
    int prev_n = me->dominator_count;
    for (int k = 0; k < prev_n; k++) prev[k] = me->dominators[k];
    me->dominator_count = 0;

    float mx = me->x, my = me->y;
    float mr = struct_claim_radius(me->type);
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *other = &placed_structures[i];
        if (other == me) continue;
        if (!other->active) continue;
        if (other->claim_orphaned) continue;
        if (other->company_id == me->company_id) continue;
        if (other->company_id == 0) continue;
        /* Only DOM-eligible types can be dominators; flag forts are handled
         * through the capture path, not the recompute path. */
        if (!dom_eligible(other->type)) continue;
        if (other->type == STRUCT_FLAG_FORT) continue;
        float pr = struct_claim_radius(other->type);
        float dx = other->x - mx, dy = other->y - my;
        float thresh = mr + pr;
        if (dx * dx + dy * dy > thresh * thresh) continue;
        dominators_append(me, other->id);
    }

    bool changed = (me->dominator_count != prev_n);
    if (!changed) {
        for (int k = 0; k < prev_n; k++) {
            if (prev[k] != me->dominators[k]) { changed = true; break; }
        }
    }
    if (changed) broadcast_structure_dominators(me);
}

/** Broadcast a territory_update JSON message with optional fort position. */
static void broadcast_territory_update(uint8_t island_id, uint32_t company_id,
                                       bool claimed) {
    /* Find the Company Fortress position for this island */
    float fort_x = 0.0f, fort_y = 0.0f;
    bool  is_company_fort = false;
    if (claimed) {
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *s = &placed_structures[si];
            if (!s->active) continue;
            if (s->island_id != island_id) continue;
            if (s->company_id != (uint8_t)company_id) continue;
            if (s->type == STRUCT_COMPANY_FORTRESS && s->fortress_complete) {
                fort_x = s->x;
                fort_y = s->y;
                is_company_fort = true;
                break;
            }
        }
        if (!is_company_fort) {
            /* Fall back to flag fort position */
            for (uint32_t si = 0; si < placed_structure_count; si++) {
                PlacedStructure *s = &placed_structures[si];
                if (!s->active) continue;
                if (s->type != STRUCT_FLAG_FORT) continue;
                if (s->island_id == island_id && s->company_id == (uint8_t)company_id) {
                    fort_x = s->x;
                    fort_y = s->y;
                    break;
                }
            }
        }
    }
    char msg[256];
    snprintf(msg, sizeof(msg),
             "{\"type\":\"territory_update\",\"island_id\":%u,"
             "\"company_id\":%u,\"claimed\":%s"
             ",\"fort_x\":%.1f,\"fort_y\":%.1f,\"fort_radius\":%.0f"
             ",\"is_company_fortress\":%s}",
             island_id, company_id, claimed ? "true" : "false",
             fort_x, fort_y, (float)CLAIM_RADIUS_FLAG_FORT,
             is_company_fort ? "true" : "false");
    websocket_server_broadcast(msg);
}

/* ── Flood-fill connectivity ─────────────────────────────────────────────── */

/**
 * BFS from the fort to mark every same-company structure that is within
 * CLAIM_RADIUS_DEFAULT of at least one other already-marked structure.
 * Returns the number of connected structures (including the fort).
 * Sets claim_orphaned = false on connected, true on disconnected.
 */
static void claim_rebuild_graph(uint16_t fort_struct_id, uint32_t company_id) {
    /* Simple bool array — one bit per placed structure slot. */
    static bool visited[MAX_PLACED_STRUCTURES];
    static uint16_t queue[MAX_PLACED_STRUCTURES];
    memset(visited, 0, sizeof(visited));
    int qh = 0, qt = 0;

    /* Capture pre-rebuild orphaned state so we can detect active→orphaned
     * transitions caused by this rebuild and demote them in others'
     * dominators lists. */
    static bool was_orphaned[MAX_PLACED_STRUCTURES];
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        was_orphaned[i] = placed_structures[i].claim_orphaned;
    }

    /* Seed: find the fort in the placed_structures array. */
    int fort_idx = -1;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].active &&
            placed_structures[i].id == fort_struct_id) {
            fort_idx = (int)i;
            break;
        }
    }
    if (fort_idx < 0) {
        /* Fort not found — mark all company structures orphaned. */
        for (uint32_t i = 0; i < placed_structure_count; i++) {
            if (placed_structures[i].active &&
                placed_structures[i].company_id == company_id) {
                bool prev = placed_structures[i].claim_orphaned;
                placed_structures[i].claim_orphaned = true;
                if (!prev) {
                    claim_demote_orphaned_in_all_dominators(placed_structures[i].id);
                }
            }
        }
        return;
    }

    uint8_t isl_id = placed_structures[fort_idx].island_id;

    /* BFS */
    visited[fort_idx] = true;
    placed_structures[fort_idx].claim_orphaned = false;
    queue[qt++] = (uint16_t)fort_idx;

    while (qh < qt) {
        uint16_t cur = queue[qh++];
        float cx = placed_structures[cur].x;
        float cy = placed_structures[cur].y;
        float cr = struct_claim_radius(placed_structures[cur].type);

        for (uint32_t j = 0; j < placed_structure_count; j++) {
            if (visited[j]) continue;
            PlacedStructure *s = &placed_structures[j];
            if (!s->active) continue;
            if (s->company_id != company_id) continue;
            if (s->island_id  != isl_id)     continue;
            /* Within claim radius of the current node? */
            float r2 = cr + struct_claim_radius(s->type);
            if (dist2(cx, cy, s->x, s->y) <= r2 * r2) {
                visited[j] = true;
                s->claim_orphaned = false;
                queue[qt++] = (uint16_t)j;
            }
        }
    }

    /* Mark everything not reached as orphaned. */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->company_id != company_id) continue;
        if (s->island_id  != isl_id) continue;
        if (!visited[i]) s->claim_orphaned = true;
    }

    /* Demote any structure that transitioned active→orphaned in this rebuild
     * to the bottom of every other structure's dominators[]. */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->claim_orphaned && !was_orphaned[i]) {
            claim_demote_orphaned_in_all_dominators(s->id);
        }
    }
}

/* ── Public API ─────────────────────────────────────────────────────────── */

IslandClaim *island_get_claim(uint8_t island_id) {
    for (int i = 0; i < island_claim_count; i++) {
        if (island_claims[i].active && island_claims[i].island_id == island_id)
            return &island_claims[i];
    }
    return NULL;
}

/**
 * Called when a Flag Fort is placed. Flag Forts project a radius but do NOT
 * register an IslandClaim (only a completed Company Fortress does that).
 * Returns true always (placement is handled by structures.c).
 */
bool claim_register_fort(uint8_t island_id, uint32_t company_id,
                         uint32_t fort_struct_id, uint32_t placer_id) {
    (void)island_id; (void)company_id; (void)fort_struct_id; (void)placer_id;
    log_info("🚩 Flag Fort #%u placed by company %u on island %u (radius claim)",
             fort_struct_id, company_id, island_id);
    return true;
}

/**
 * Register a completed Company Fortress island claim.
 * Destroys ALL other incomplete Company Fortresses on this island (any company).
 * Returns false if the island already has a completed Company Fortress.
 */
bool claim_register_company_fortress(uint8_t island_id, uint32_t company_id,
                                     uint32_t struct_id, uint32_t placer_id) {
    /* Reject if already claimed by another company's fortress */
    IslandClaim *existing = island_get_claim(island_id);
    if (existing && existing->company_id != company_id) {
        /* Another company already owns this island — should not happen due to contest */
        return false;
    }
    if (existing && existing->company_id == company_id) {
        /* We already have a claim — update to new struct_id */
        existing->fort_structure_id = struct_id;
        existing->fort_placer_id    = placer_id;
    } else {
        /* Allocate new slot */
        IslandClaim *slot = NULL;
        for (int i = 0; i < island_claim_count; i++) {
            if (!island_claims[i].active) { slot = &island_claims[i]; break; }
        }
        if (!slot) {
            if (island_claim_count >= MAX_ISLAND_CLAIMS) return false;
            slot = &island_claims[island_claim_count++];
        }
        memset(slot, 0, sizeof(*slot));
        slot->active            = true;
        slot->island_id         = island_id;
        slot->company_id        = company_id;
        slot->fort_structure_id = struct_id;
        slot->fort_placer_id    = placer_id;
    }

    /* Destroy ALL other incomplete Company Fortresses on this island */
    int destroyed = 0;
    for (uint32_t si = 0; si < placed_structure_count; si++) {
        PlacedStructure *s = &placed_structures[si];
        if (!s->active) continue;
        if (s->type != STRUCT_COMPANY_FORTRESS) continue;
        if (s->island_id != island_id) continue;
        if (s->id == struct_id) continue;              /* keep the one that just completed */
        if (s->fortress_complete) continue;            /* keep other completed ones (shouldn't exist) */
        s->active = false;
        char dmsg[128];
        snprintf(dmsg, sizeof(dmsg),
                 "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
        websocket_server_broadcast(dmsg);
        destroyed++;
    }
    if (destroyed > 0)
        log_info("🏰 Destroyed %d incomplete fortress(es) on island %u", destroyed, island_id);

    log_info("🏰 Island %u claimed by company %u via Company Fortress #%u (placer %u)",
             island_id, company_id, struct_id, placer_id);
    broadcast_territory_update(island_id, company_id, true);
    return true;
}

void claim_on_fort_destroyed(uint32_t fort_structure_id) {
    for (int i = 0; i < island_claim_count; i++) {
        IslandClaim *ic = &island_claims[i];
        if (!ic->active) continue;
        if (ic->fort_structure_id != fort_structure_id) continue;

        uint8_t  isl_id = ic->island_id;
        uint32_t old_co = ic->company_id;

        ic->active = false;

        log_info("🏰 Island %u Company Fortress claim by company %u LOST (struct #%u destroyed)",
                 isl_id, old_co, fort_structure_id);
        broadcast_territory_update(isl_id, old_co, false);
        return;
    }
    /* Not found in IslandClaim table — was a flag fort (radius-only) or incomplete fortress */
}

/* ── Territory query ─────────────────────────────────────────────────────── */

bool territory_is_claimed_by(float wx, float wy, uint32_t company_id) {
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->company_id != company_id) continue;
        if (s->claim_orphaned) continue;
        float r = struct_claim_radius(s->type);
        if (dist2(wx, wy, s->x, s->y) <= r * r) return true;
    }
    return false;
}

bool territory_is_claimed_by_any(float wx, float wy, uint32_t *out_company_id) {
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->claim_orphaned) continue;
        if (s->company_id == COMPANY_UNCLAIMED) continue;
        float r = struct_claim_radius(s->type);
        if (dist2(wx, wy, s->x, s->y) <= r * r) {
            if (out_company_id) *out_company_id = s->company_id;
            return true;
        }
    }
    return false;
}

bool territory_is_contested(float wx, float wy) {
    uint32_t first_co = 0;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->claim_orphaned) continue;
        if (s->company_id == COMPANY_UNCLAIMED) continue;
        float r = struct_claim_radius(s->type);
        if (dist2(wx, wy, s->x, s->y) > r * r) continue;

        if (first_co == 0) {
            first_co = s->company_id;
        } else if (s->company_id != first_co) {
            return true;  /* Two different companies overlap here */
        }
    }
    return false;
}

/* Lookup a placed structure by id. Returns NULL if not found / inactive. */
static PlacedStructure *find_placed(uint32_t id) {
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].id == id) return &placed_structures[i];
    }
    return NULL;
}

bool claim_point_in_my_territory(float wx, float wy, uint32_t my_company) {
    if (my_company == 0) return false;

    /* (a) my own structures, uncarved by any enemy dominator. */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->claim_orphaned) continue;
        if (s->company_id != my_company) continue;
        float sr = struct_claim_radius(s->type);
        if (dist2(wx, wy, s->x, s->y) > sr * sr) continue;

        bool carved = false;
        for (uint8_t k = 0; k < s->dominator_count; k++) {
            PlacedStructure *d = find_placed(s->dominators[k]);
            if (!d) continue;
            if (!d->active) continue;
            if (d->claim_orphaned) continue;
            if (d->company_id == my_company) continue; /* same-company never carves */
            float dr = struct_claim_radius(d->type);
            if (dist2(wx, wy, d->x, d->y) <= dr * dr) { carved = true; break; }
        }
        if (!carved) return true;
    }

    /* (b) enemy structures whose dominators list contains one of mine. */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *victim = &placed_structures[i];
        if (!victim->active) continue;
        if (victim->claim_orphaned) continue;
        if (victim->company_id == my_company) continue;
        if (victim->company_id == COMPANY_UNCLAIMED) continue;
        if (victim->dominator_count == 0) continue;
        float vr = struct_claim_radius(victim->type);
        if (dist2(wx, wy, victim->x, victim->y) > vr * vr) continue;

        for (uint8_t k = 0; k < victim->dominator_count; k++) {
            PlacedStructure *d = find_placed(victim->dominators[k]);
            if (!d) continue;
            if (!d->active) continue;
            if (d->claim_orphaned) continue;
            if (d->company_id != my_company) continue;
            float dr = struct_claim_radius(d->type);
            if (dist2(wx, wy, d->x, d->y) <= dr * dr) return true;
        }
    }
    return false;
}

/* ── Claim flag tick ─────────────────────────────────────────────────────── */

/**
 * Transfer all structures within radius of (fx,fy) from old_co → new_co.
 */
/* ── Company Fortress build-tick ─────────────────────────────────────────
   Advances/pauses the 15-minute build timer on every incomplete fortress.   */
static uint32_t fortress_broadcast_acc_ms = 0;
static void fortress_tick(uint32_t delta_ms) {
    fortress_broadcast_acc_ms += delta_ms;
    bool do_broadcast = (fortress_broadcast_acc_ms >= 1000u);
    if (do_broadcast) fortress_broadcast_acc_ms = 0;

    for (uint32_t si = 0; si < placed_structure_count; si++) {
        PlacedStructure *s = &placed_structures[si];
        if (!s->active) continue;
        if (s->type != STRUCT_COMPANY_FORTRESS) continue;
        if (s->fortress_complete) continue;

        float    fx  = s->x, fy = s->y;
        uint8_t  isl = s->island_id;
        uint8_t  co  = s->company_id;

        /* Detect any enemy player within contest radius */
        bool contested = false;
        for (uint32_t pi = 0; pi < MAX_PLAYERS; pi++) {
            WebSocketPlayer *p = &players[pi];
            if (!p->active || p->player_id == 0) continue;
            if ((uint8_t)p->company_id == co) continue;
            if ((uint8_t)p->on_island_id != isl) continue;
            float dx = p->x - fx, dy = p->y - fy;
            if (dx*dx + dy*dy <= CLAIM_RADIUS_COMPANY_FORT * CLAIM_RADIUS_COMPANY_FORT) {
                contested = true;
                break;
            }
        }
        s->claim_contested = contested;

        if (!contested) {
            s->claim_progress_ms += (float)delta_ms;
            if (s->claim_progress_ms >= (float)COMPANY_FORTRESS_BUILD_MS) {
                s->claim_progress_ms = (float)COMPANY_FORTRESS_BUILD_MS;
                s->fortress_complete = true;
                s->hp                = s->max_hp;

                log_info("🏰 Company Fortress #%u (company %u, island %u) COMPLETED!",
                         s->id, co, isl);
                claim_register_company_fortress(isl, (uint32_t)co,
                                                s->id, s->placer_id);
                char msg[192];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"fortress_complete\",\"structure_id\":%u"
                         ",\"company_id\":%u,\"island_id\":%u}", s->id, co, isl);
                websocket_server_broadcast(msg);
                continue;
            }
        }

        if (do_broadcast) {
            char msg[192];
            snprintf(msg, sizeof(msg),
                     "{\"type\":\"fortress_build_progress\",\"structure_id\":%u"
                     ",\"company_id\":%u,\"island_id\":%u"
                     ",\"progress_ms\":%.0f,\"total_ms\":%u,\"contested\":%s}",
                     s->id, co, isl, s->claim_progress_ms,
                     COMPANY_FORTRESS_BUILD_MS, contested ? "true" : "false");
            websocket_server_broadcast(msg);
        }
    }
}

/* ── Flag-Fort heal/activation tick ──────────────────────────────────────
 * Flag forts start at FLAG_FORT_INITIAL_HP_PCT of max_hp and heal back
 * toward max_hp at a constant rate (max_hp / FLAG_FORT_BUILD_MS per ms)
 * while no enemy player is inside their claim radius. Crossing the
 * FLAG_FORT_ACTIVE_HP_PCT threshold flips `fortress_complete`; the same
 * threshold is used in reverse (combat damage that drops HP below 30%
 * sets fortress_complete=false until it heals back). */
static uint32_t flag_fort_broadcast_acc_ms = 0;
static void flag_fort_tick(uint32_t delta_ms) {
    flag_fort_broadcast_acc_ms += delta_ms;
    bool do_broadcast = (flag_fort_broadcast_acc_ms >= 1000u);
    if (do_broadcast) flag_fort_broadcast_acc_ms = 0;

    for (uint32_t si = 0; si < placed_structure_count; si++) {
        PlacedStructure *s = &placed_structures[si];
        if (!s->active) continue;
        if (s->type != STRUCT_FLAG_FORT) continue;

        /* ════════════════════════════════════════════════════════════════
         * PHASE: UNCLAIMING — fort was captured; its HP drains at 1%/s
         * toward 0, then it enters the CLAIMING countdown for destruction.
         * Checked BEFORE the claim_orphaned skip because UNCLAIMING forts
         * are marked claim_orphaned=true (stops territory projection) but
         * still need to tick. */
        if (s->claim_phase == FLAG_FORT_PHASE_DEMOLISHING) {
            uint8_t  isl = s->island_id;
            uint8_t  co  = s->company_id;
            float    dt  = (float)delta_ms;
            /* 1% of max_hp per second — slow visible drain */
            float drain = (float)s->max_hp * dt / 100000.0f;
            s->claim_progress_ms -= drain;
            if (s->claim_progress_ms < 0.0f) s->claim_progress_ms = 0.0f;
            s->hp        = (uint16_t)s->claim_progress_ms;
            s->target_hp = s->hp; /* prevent any repair system from countering the drain */

            if (s->hp == 0) {
                /* HP fully drained → enter CLAIMING for final countdown.
                 * Defenders (original owner's company) can stall the timer;
                 * if the zone is empty or attacker-only it counts down to
                 * destruction with no grace period. */
                s->claim_phase       = FLAG_FORT_PHASE_CLAIMING;
                s->claim_progress_ms = 0.99f * (float)FLAG_FORT_CLAIM_MS;  /* start at 99% so bar goes 99%→0 */
                s->claim_state       = CLAIM_FLAG_STATE_CONTEST;
                s->claim_grace_ms    = 0.0f;
                s->claim_contested   = false;
                log_info("🚩 Flag Fort #%u (company %u, island %u) HP drained → CLAIMING (final countdown)",
                         s->id, co, isl);
                char umsg[320];
                snprintf(umsg, sizeof(umsg),
                         "{\"type\":\"flag_fort_build_progress\",\"structure_id\":%u"
                         ",\"company_id\":%u,\"island_id\":%u"
                         ",\"hp\":0,\"max_hp\":%u,\"fortress_complete\":false"
                         ",\"contested\":false,\"claim_phase\":%u"
                         ",\"claim_progress_ms\":%.0f,\"claim_total_ms\":%u"
                         ",\"claim_state\":%u,\"claim_grace_ms\":0}",
                         s->id, co, isl, s->max_hp,
                         (unsigned)FLAG_FORT_PHASE_CLAIMING,
                         s->claim_progress_ms, FLAG_FORT_CLAIM_MS,
                         (unsigned)CLAIM_FLAG_STATE_CONTEST);
                websocket_server_broadcast(umsg);
            } else if (do_broadcast) {
                char umsg[256];
                snprintf(umsg, sizeof(umsg),
                         "{\"type\":\"flag_fort_build_progress\",\"structure_id\":%u"
                         ",\"company_id\":%u,\"island_id\":%u"
                         ",\"hp\":%u,\"max_hp\":%u,\"fortress_complete\":false"
                         ",\"contested\":false,\"claim_phase\":%u"
                         ",\"claim_progress_ms\":%.0f,\"claim_total_ms\":0}",
                         s->id, co, isl, s->hp, s->max_hp,
                         (unsigned)FLAG_FORT_PHASE_DEMOLISHING,
                         s->claim_progress_ms);
                websocket_server_broadcast(umsg);
            }
            continue;
        }

        /* Post-demolish CLAIMING (hp==0, claim_orphaned=true) must still tick
         * so the destruction countdown runs.  All other orphaned forts skip. */
        if (s->claim_orphaned && !(s->claim_phase == FLAG_FORT_PHASE_CLAIMING && s->hp == 0)) continue;

        float    fx  = s->x, fy = s->y;
        uint8_t  isl = s->island_id;
        uint8_t  co  = s->company_id;
        float    dt  = (float)delta_ms;

        /* ── Save migration / sanity: if claim_phase is uninitialised (0) on
         * a structure whose HP already indicates a later phase, snap it. This
         * covers world saves written before claim_phase existed. */
        if (s->claim_phase == FLAG_FORT_PHASE_CLAIMING) {
            float hp_pct = (s->max_hp > 0) ? ((float)s->hp / (float)s->max_hp) : 0.0f;
            if (hp_pct >= FLAG_FORT_ACTIVE_HP_PCT) {
                s->claim_phase       = FLAG_FORT_PHASE_ACTIVE;
                s->fortress_complete = true;
                s->claim_progress_ms = (float)s->hp;
            } else if (hp_pct > FLAG_FORT_INITIAL_HP_PCT + 0.001f) {
                /* Already past initial HP — must be mid-build. */
                s->claim_phase       = FLAG_FORT_PHASE_BUILDING;
                s->claim_progress_ms = (float)s->hp;
            }
        }

        /* ════════════════════════════════════════════════════════════════
         * PHASE: CLAIMING (1 min ground-claim, mirrors claim_flag rules)
         *   - non-damageable (handled at damage source)
         *   - HP pinned at 10% (we leave it where placement put it)
         *   - claim_progress_ms counts FLAG_FORT_CLAIM_MS → 0
         *   - enemy player in radius → CONTEST (stall, no progress)
         *   - allies-only → CLAIMING (after 5 s grace)
         *   - empty → CONTEST (stall)
         * On reaching 0 → transition to BUILDING phase. */
        if (s->claim_phase == FLAG_FORT_PHASE_CLAIMING) {
            /* hp==0 means this fort transitioned here from UNCLAIMING (it
             * was captured and its HP was drained to zero).  In that mode
             * the contestant logic is inverted: the ORIGINAL OWNER's players
             * stall the destruction timer; everyone else (or an empty zone)
             * counts it down toward the fort being destroyed. */
            bool is_post_capture = (s->hp == 0);

            bool ally_present  = false;
            bool enemy_present = false;
            for (uint32_t pi = 0; pi < MAX_PLAYERS; pi++) {
                WebSocketPlayer *p = &players[pi];
                if (!p->active || p->player_id == 0) continue;
                if ((uint8_t)p->on_island_id != isl) continue;
                float dx = p->x - fx, dy = p->y - fy;
                if (dx*dx + dy*dy > CLAIM_RADIUS_FLAG_FORT * CLAIM_RADIUS_FLAG_FORT) continue;
                if ((uint8_t)p->company_id == co) ally_present = true;
                else                              enemy_present = true;
            }

            uint8_t desired;
            if (is_post_capture) {
                /* Defenders (original owner) stall; empty or attacker → countdown */
                desired = ally_present ? CLAIM_FLAG_STATE_CONTEST : CLAIM_FLAG_STATE_CLAIMING;
            } else if (enemy_present) {
                desired = CLAIM_FLAG_STATE_CONTEST;
            } else if (ally_present) {
                desired = CLAIM_FLAG_STATE_CLAIMING;
            } else {
                desired = CLAIM_FLAG_STATE_CONTEST;
            }

            if (desired == CLAIM_FLAG_STATE_CONTEST) {
                s->claim_state    = CLAIM_FLAG_STATE_CONTEST;
                s->claim_grace_ms = 0.0f;
            } else { /* CLAIMING */
                if (is_post_capture) {
                    /* No grace period for post-capture countdown */
                    if (s->claim_state != CLAIM_FLAG_STATE_CLAIMING) {
                        s->claim_state    = CLAIM_FLAG_STATE_CLAIMING;
                        s->claim_grace_ms = 0.0f;
                    }
                } else if (s->claim_state == CLAIM_FLAG_STATE_CLAIMING) {
                    /* already counting down */
                } else if (s->claim_state == CLAIM_FLAG_STATE_CLAIMING_GRACE) {
                    s->claim_grace_ms += dt;
                    if (s->claim_grace_ms >= (float)FLAG_FORT_CLAIM_GRACE_MS) {
                        s->claim_state    = CLAIM_FLAG_STATE_CLAIMING;
                        s->claim_grace_ms = 0.0f;
                    }
                } else {
                    s->claim_state    = CLAIM_FLAG_STATE_CLAIMING_GRACE;
                    s->claim_grace_ms = 0.0f;
                }
            }
            s->claim_contested = (s->claim_state == CLAIM_FLAG_STATE_CONTEST);

            if (s->claim_state == CLAIM_FLAG_STATE_CLAIMING) {
                /* Post-capture UNCLAIMING drains 10× faster than a normal claim */
                s->claim_progress_ms -= (is_post_capture ? 10.0f * dt : dt);
                if (s->claim_progress_ms <= 0.0f) {
                    if (is_post_capture) {
                        /* Post-capture countdown expired — fort is destroyed */
                        log_info("🚩 Flag Fort #%u (company %u, island %u) reclaim window expired → destroyed",
                                 s->id, co, isl);
                        destroy_placed_structure(s->id);
                        continue;
                    }
                    /* Claim phase complete → enter BUILDING.
                     * Re-purpose claim_progress_ms as the float-HP accumulator. */
                    s->claim_phase       = FLAG_FORT_PHASE_BUILDING;
                    s->claim_progress_ms = (float)s->hp;
                    s->claim_state       = CLAIM_FLAG_STATE_CONTEST;
                    s->claim_grace_ms    = 0.0f;
                    s->claim_contested   = false;
                    log_info("🚩 Flag Fort #%u (company %u, island %u) claim phase complete → BUILDING",
                             s->id, co, isl);
                }
            }

            if (do_broadcast) {
                char msg[320];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"flag_fort_build_progress\",\"structure_id\":%u"
                         ",\"company_id\":%u,\"island_id\":%u"
                         ",\"hp\":%u,\"max_hp\":%u,\"fortress_complete\":false"
                         ",\"contested\":%s,\"claim_phase\":%u"
                         ",\"claim_progress_ms\":%.0f,\"claim_total_ms\":%u"
                         ",\"claim_state\":%u,\"claim_grace_ms\":%.0f}",
                         s->id, co, isl,
                         s->hp, s->max_hp,
                         s->claim_contested ? "true" : "false",
                         (unsigned)s->claim_phase,
                         s->claim_progress_ms,
                         FLAG_FORT_CLAIM_MS,
                         (unsigned)s->claim_state,
                         s->claim_grace_ms);
                websocket_server_broadcast(msg);
            }
            continue;
        }

        /* ════════════════════════════════════════════════════════════════
         * PHASE: BUILDING / ACTIVE (existing heal + activation gate)
         * Detect any enemy player within the fort's claim radius — heal is
         * paused while contested (mirrors Company Fortress behaviour). */
        bool contested = false;
        for (uint32_t pi = 0; pi < MAX_PLAYERS; pi++) {
            WebSocketPlayer *p = &players[pi];
            if (!p->active || p->player_id == 0) continue;
            if ((uint8_t)p->company_id == co) continue;
            if ((uint8_t)p->on_island_id != isl) continue;
            float dx = p->x - fx, dy = p->y - fy;
            if (dx*dx + dy*dy <= CLAIM_RADIUS_FLAG_FORT * CLAIM_RADIUS_FLAG_FORT) {
                contested = true;
                break;
            }
        }
        s->claim_contested = contested;

        /* hp is uint16_t and per-tick heal is sub-1 (≈0.027 hp at 16ms), so
         * naïve integer accumulation truncates to zero every tick. We carry
         * a float accumulator in claim_progress_ms (repurposed for flag forts:
         * "fractional current hp" in [0, max_hp]) and re-derive integer hp
         * by truncation each tick. The float is normally `hp + fractional`
         * (0 ≤ fractional < 1). External writes to s->hp (combat damage or
         * repair) will set hp to a value that is NOT equal to truncate(float)
         * — detect that and resync the float to hp so healing resumes from
         * the new integer value. */
        if ((uint16_t)s->claim_progress_ms != s->hp) {
            s->claim_progress_ms = (float)s->hp;
        }

        /* Save migration: target_hp is the heal ceiling. Forts saved before this
         * field existed read back as 0 — default to max_hp so they can repair. */
        if (s->target_hp == 0 || s->target_hp > s->max_hp) s->target_hp = s->max_hp;
        /* Heal toward target_hp (target_hp ≤ max_hp; combat damage permanently
         * lowers target_hp via apply_structure_damage). Contesting no longer
         * pauses building progression — only combat damage can slow it. */
        if (s->claim_progress_ms < (float)s->target_hp) {
            float heal = (float)s->max_hp * (float)delta_ms / (float)FLAG_FORT_BUILD_MS;
            s->claim_progress_ms += heal;
            if (s->claim_progress_ms > (float)s->target_hp) s->claim_progress_ms = (float)s->target_hp;
            s->hp = (uint16_t)s->claim_progress_ms;
        }

        /* Activation / deactivation gate (BUILDING ↔ ACTIVE). */
        bool should_be_active = ((float)s->hp >= FLAG_FORT_ACTIVE_HP_PCT * (float)s->max_hp);
        uint8_t new_phase = should_be_active ? FLAG_FORT_PHASE_ACTIVE : FLAG_FORT_PHASE_BUILDING;
        if (new_phase != s->claim_phase || should_be_active != s->fortress_complete) {
            bool was_active = s->fortress_complete;
            s->claim_phase       = new_phase;
            s->fortress_complete = should_be_active;
            char amsg[224];
            snprintf(amsg, sizeof(amsg),
                     "{\"type\":\"flag_fort_active\",\"structure_id\":%u"
                     ",\"company_id\":%u,\"island_id\":%u,\"active\":%s"
                     ",\"claim_phase\":%u}",
                     s->id, co, isl, should_be_active ? "true" : "false",
                     (unsigned)new_phase);
            websocket_server_broadcast(amsg);
            log_info("🚩 Flag Fort #%u (company %u, island %u) %s (hp=%u/%u)",
                     s->id, co, isl,
                     should_be_active ? "ACTIVATED" : "deactivated",
                     s->hp, s->max_hp);

            if (should_be_active && !was_active) {
                /* Fort just became active — its own DOM list was already
                 * populated at placement. Flag forts never appear in enemy
                 * DOM lists, so no reverse registration is needed here. */
            }
        }

        if (do_broadcast) {
            char msg[352];
            snprintf(msg, sizeof(msg),
                     "{\"type\":\"flag_fort_build_progress\",\"structure_id\":%u"
                     ",\"company_id\":%u,\"island_id\":%u"
                     ",\"hp\":%u,\"max_hp\":%u,\"target_hp\":%u,\"fortress_complete\":%s"
                     ",\"contested\":%s,\"claim_phase\":%u}",
                     s->id, co, isl,
                     s->hp, s->max_hp, s->target_hp,
                     s->fortress_complete ? "true" : "false",
                     contested ? "true" : "false",
                     (unsigned)s->claim_phase);
            websocket_server_broadcast(msg);
        }
    }
}

void claim_tick(uint32_t delta_ms) {
    /* Advance Company Fortress build timers */
    fortress_tick(delta_ms);
    /* Advance Flag Fort heal/activation gate */
    flag_fort_tick(delta_ms);
    /* Advance any in-progress player-initiated structure repairs */
    structure_repair_tick(delta_ms);

    /* ── Claim-flag progress ──────────────────────────────────────────── */
    for (uint32_t si = 0; si < placed_structure_count; si++) {
        PlacedStructure *s = &placed_structures[si];
        if (!s->active) continue;
        if (s->type != STRUCT_CLAIM_FLAG) continue;

        float dt = (float)delta_ms;

        /* Resolve source structures by id */
        PlacedStructure *src_mine  = NULL;
        PlacedStructure *src_enemy = NULL;
        for (uint32_t ti = 0; ti < placed_structure_count; ti++) {
            PlacedStructure *t = &placed_structures[ti];
            if (!t->active) continue;
            if (t->id == s->claim_linked_fort)  src_mine  = t;
            if (t->id == s->claim_source_enemy) src_enemy = t;
        }
        /* If mine is gone/orphaned or company ownership changed, the flag is
         * invalid.  src_enemy being orphaned is intentional (inactive territory
         * capture) — keep the flag alive in that case. */
        if (!src_mine || !src_enemy ||
            src_mine->claim_orphaned ||
            src_mine->company_id  != s->company_id ||
            src_enemy->company_id == s->company_id) {
            s->active = false;
            char dmsg[128];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
            websocket_server_broadcast(dmsg);
            continue;
        }

        /* Detect ally / enemy presence inside the CONTESTED AREA = intersection
         * of the two source claim circles. */
        float ra = (src_mine->type  == STRUCT_FLAG_FORT)        ? CLAIM_RADIUS_FLAG_FORT
                 : (src_mine->type  == STRUCT_COMPANY_FORTRESS) ? CLAIM_RADIUS_COMPANY_FORT
                                                                 : CLAIM_RADIUS_DEFAULT;
        float rb = (src_enemy->type == STRUCT_FLAG_FORT)        ? CLAIM_RADIUS_FLAG_FORT
                 : (src_enemy->type == STRUCT_COMPANY_FORTRESS) ? CLAIM_RADIUS_COMPANY_FORT
                                                                 : CLAIM_RADIUS_DEFAULT;
        bool ally_present  = false;
        bool enemy_present = false;
        for (uint32_t pi = 0; pi < MAX_PLAYERS; pi++) {
            WebSocketPlayer *p = &players[pi];
            if (!p->active || p->player_id == 0) continue;
            float dxa = p->x - src_mine->x,  dya = p->y - src_mine->y;
            float dxb = p->x - src_enemy->x, dyb = p->y - src_enemy->y;
            if (dxa*dxa + dya*dya > ra*ra) continue;
            if (dxb*dxb + dyb*dyb > rb*rb) continue;
            /* Player is inside the contested area. Ally = same company; non-ally =
             * different company (incl. unaffiliated). TODO: factor in alliances. */
            if ((uint8_t)p->company_id == s->company_id) ally_present  = true;
            else                                          enemy_present = true;
        }

        /* Desired state from presence:
         *  - enemy in area → CONTEST (stall), regardless of whether allies are present
         *  - enemy absent, ally present → CLAIMING
         *  - nobody present → CONTEST (stall — unclaimed area, no one pushing) */
        uint8_t desired;
        if (enemy_present)                       desired = CLAIM_FLAG_STATE_CONTEST;
        else if (ally_present)                   desired = CLAIM_FLAG_STATE_CLAIMING;
        else                                     desired = CLAIM_FLAG_STATE_CONTEST;

        /* Apply state transitions:
         *  - going TO contest is immediate
         *  - going TO claiming requires a 5 s grace accumulator
         *  - REVERSING state is not used (enemy presence just stalls, not reverses) */
        if (desired == CLAIM_FLAG_STATE_CONTEST) {
            s->claim_state    = CLAIM_FLAG_STATE_CONTEST;
            s->claim_grace_ms = 0.0f;
        } else if (desired == CLAIM_FLAG_STATE_CLAIMING) {
            if (s->claim_state == CLAIM_FLAG_STATE_CLAIMING) {
                /* already counting down */
            } else if (s->claim_state == CLAIM_FLAG_STATE_CLAIMING_GRACE) {
                s->claim_grace_ms += dt;
                if (s->claim_grace_ms >= (float)CLAIM_FLAG_GRACE_MS) {
                    s->claim_state    = CLAIM_FLAG_STATE_CLAIMING;
                    s->claim_grace_ms = 0.0f;
                }
            } else {
                s->claim_state    = CLAIM_FLAG_STATE_CLAIMING_GRACE;
                s->claim_grace_ms = 0.0f;
            }
        }

        /* Convenience flag for legacy clients */
        s->claim_contested = (s->claim_state == CLAIM_FLAG_STATE_CONTEST);

        /* Apply progress based on state */
        bool do_capture = false, do_destroy = false;
        if (s->claim_state == CLAIM_FLAG_STATE_CLAIMING) {
            s->claim_progress_ms -= dt;
            if (s->claim_progress_ms <= 0.0f) {
                s->claim_progress_ms = 0.0f;
                do_capture = true;
            }
        } else if (s->claim_state == CLAIM_FLAG_STATE_REVERSING) {
            s->claim_progress_ms += dt * FLAG_REVERSE_SPEED;
            if (s->claim_progress_ms >= (float)FLAG_CLAIM_DURATION_MS) {
                s->claim_progress_ms = (float)FLAG_CLAIM_DURATION_MS;
                do_destroy = true;
            }
        }

        /* Broadcast progress ~once per second */
        {
            static uint32_t last_broadcast_ms = 0;
            uint32_t now = get_time_ms();
            if (now - last_broadcast_ms >= 1000u) {
                last_broadcast_ms = now;
                char msg[256];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"claim_flag_progress\",\"id\":%u,"
                         "\"island_id\":%u,\"company_id\":%u,"
                         "\"progress\":%.0f,\"total\":%.0f,\"contested\":%s,"
                         "\"state\":%u,\"grace_ms\":%.0f,\"grace_total\":%u,"
                         "\"targets_fortress\":false}",
                         s->id, s->island_id, s->company_id,
                         s->claim_progress_ms,
                         (float)FLAG_CLAIM_DURATION_MS,
                         s->claim_contested ? "true" : "false",
                         (unsigned)s->claim_state,
                         s->claim_grace_ms,
                         CLAIM_FLAG_GRACE_MS);
                websocket_server_broadcast(msg);
            }
        }

        if (do_capture) {
            uint32_t orphaned_id = src_enemy->id;
            uint32_t old_co      = src_enemy->company_id;
            uint8_t  isl         = src_enemy->island_id;

            /* ── Inactive-territory capture: src_enemy is already orphaned.
             * BFS through all connected orphaned structures of old_co on this
             * island (claim-radius adjacency) and transfer them to the
             * challenger in one sweep.  Flag forts are left to their ongoing
             * DEMOLISHING drain; all other structures are re-owned. */
            if (src_enemy->claim_orphaned) {
                static bool     ict_visited[MAX_PLACED_STRUCTURES];
                static uint32_t ict_ids[MAX_PLACED_STRUCTURES];
                static int32_t  ict_queue[MAX_PLACED_STRUCTURES];
                memset(ict_visited, 0, sizeof(bool) * placed_structure_count);
                int ict_n = 0, iqh = 0, iqt = 0;

                for (uint32_t i = 0; i < placed_structure_count; i++) {
                    if (placed_structures[i].id == src_enemy->id) {
                        ict_visited[i] = true;
                        ict_ids[ict_n++] = src_enemy->id;
                        ict_queue[iqt++] = (int32_t)i;
                        break;
                    }
                }
                while (iqh < iqt) {
                    int32_t ci = ict_queue[iqh++];
                    PlacedStructure *cur = &placed_structures[ci];
                    float cr = struct_claim_radius(cur->type);
                    for (uint32_t j = 0; j < placed_structure_count; j++) {
                        if (ict_visited[j]) continue;
                        PlacedStructure *nxt = &placed_structures[j];
                        if (!nxt->active || !nxt->claim_orphaned) continue;
                        if (nxt->company_id != old_co) continue;
                        if (nxt->island_id  != isl)   continue;
                        float nr = struct_claim_radius(nxt->type);
                        float sr = cr + nr;
                        float ndx = cur->x - nxt->x, ndy = cur->y - nxt->y;
                        if (ndx*ndx + ndy*ndy > sr * sr) continue;
                        ict_visited[j] = true;
                        ict_ids[ict_n++] = nxt->id;
                        ict_queue[iqt++] = (int32_t)j;
                    }
                }

                /* ── Reachability filter: only transfer structures that are
                 * BFS-reachable from src_mine via claim-radius adjacency.
                 * claim_rebuild_graph uses identical adjacency to decide
                 * fortress-connectivity.  Structures further into the orphaned
                 * cluster (reachable only through the enemy flag fort, which is
                 * NOT transferred) would be re-orphaned by claim_rebuild_graph
                 * immediately after capture, making them unusable as mine
                 * sources for the next claim flag. */
                {
                    static bool     ict_reach[MAX_PLACED_STRUCTURES];  /* indexed by ict slot */
                    static PlacedStructure *ict_ptrs[MAX_PLACED_STRUCTURES];
                    static int32_t  rq[MAX_PLACED_STRUCTURES];
                    memset(ict_reach, 0, sizeof(bool) * (size_t)ict_n);

                    /* Cache pointers for speed (avoid repeated linear scans). */
                    for (int k = 0; k < ict_n; k++) {
                        ict_ptrs[k] = NULL;
                        for (uint32_t i = 0; i < placed_structure_count; i++) {
                            if (placed_structures[i].active &&
                                placed_structures[i].id == ict_ids[k]) {
                                ict_ptrs[k] = &placed_structures[i]; break;
                            }
                        }
                    }

                    float mine_cr = struct_claim_radius(src_mine->type);
                    int rqh2 = 0, rqt2 = 0;

                    /* Seed: cluster structures directly adjacent to src_mine. */
                    for (int k = 0; k < ict_n; k++) {
                        if (!ict_ptrs[k]) continue;
                        float cr_sum = mine_cr + struct_claim_radius(ict_ptrs[k]->type);
                        float ddx = ict_ptrs[k]->x - src_mine->x;
                        float ddy = ict_ptrs[k]->y - src_mine->y;
                        if (ddx*ddx + ddy*ddy <= cr_sum * cr_sum) {
                            ict_reach[k] = true;
                            rq[rqt2++] = k;
                        }
                    }

                    /* BFS through cluster. */
                    while (rqh2 < rqt2) {
                        int ck = rq[rqh2++];
                        PlacedStructure *cp = ict_ptrs[ck];
                        if (!cp) continue;
                        float cp_cr = struct_claim_radius(cp->type);
                        for (int k = 0; k < ict_n; k++) {
                            if (ict_reach[k] || !ict_ptrs[k]) continue;
                            float cr_sum = cp_cr + struct_claim_radius(ict_ptrs[k]->type);
                            float ddx = ict_ptrs[k]->x - cp->x;
                            float ddy = ict_ptrs[k]->y - cp->y;
                            if (ddx*ddx + ddy*ddy <= cr_sum * cr_sum) {
                                ict_reach[k] = true;
                                rq[rqt2++] = k;
                            }
                        }
                    }

                    /* Compact ict_ids to only the reachable subset. */
                    int new_n = 0;
                    for (int k = 0; k < ict_n; k++) {
                        if (ict_reach[k]) ict_ids[new_n++] = ict_ids[k];
                    }
                    ict_n = new_n;
                }

                int converted_n = 0;
                for (int k = 0; k < ict_n; k++) {
                    PlacedStructure *os = NULL;
                    for (uint32_t i = 0; i < placed_structure_count; i++) {
                        if (placed_structures[i].active && placed_structures[i].id == ict_ids[k]) {
                            os = &placed_structures[i]; break;
                        }
                    }
                    if (!os) continue;
                    /* Flag forts are already draining in DEMOLISHING — leave them. */
                    if (os->type == STRUCT_FLAG_FORT) continue;
                    /* Drop any island claim held by orphaned company fortresses. */
                    if (os->type == STRUCT_COMPANY_FORTRESS && os->fortress_complete) {
                        for (int ii = 0; ii < island_claim_count; ii++) {
                            if (island_claims[ii].active
                                    && island_claims[ii].island_id == isl
                                    && island_claims[ii].fort_structure_id == os->id) {
                                island_claims[ii].active = false;
                                broadcast_territory_update(isl, old_co, false);
                                break;
                            }
                        }
                    }
                    os->company_id     = (uint8_t)s->company_id;
                    os->claim_orphaned = false; /* claim_rebuild_graph re-validates */
                    char cmsg[128];
                    snprintf(cmsg, sizeof(cmsg),
                             "{\"type\":\"structure_company_updated\","
                             "\"structure_id\":%u,\"company_id\":%u}",
                             os->id, (unsigned)s->company_id);
                    websocket_server_broadcast(cmsg);
                    converted_n++;
                }

                /* DOM fix — must run AFTER all company_id transfers are done
                 * so every recompute sees the final ownership state.
                 *
                 * Pass 1: purge each transferred structure's ID from every
                 *   other structure's DOM list (stale since company changed).
                 * Pass 2: rebuild each transferred structure's own DOM list
                 *   (may now be dominated by remaining old-co structures).
                 *
                 * No Pass 3: we intentionally do NOT rebuild DOM for old-co
                 * structures.  Captured structures didn't win territory via a
                 * claim flag, so they must not appear as dominators in enemy
                 * DOM lists. Enemy DOM lists stay unchanged; new dominance is
                 * established only when a subsequent claim flag is placed. */
                for (int k = 0; k < ict_n; k++) {
                    claim_remove_id_from_all_dominators(ict_ids[k]);
                }
                for (int k = 0; k < ict_n; k++) {
                    claim_recompute_dominators(ict_ids[k]);
                }

                log_info("🏴 Claim Flag #%u: inactive sweep → %d structure(s) transferred (co %u→%u, island %u)",
                         s->id, converted_n, old_co, s->company_id, isl);
                s->active = false;
                char dmsg_ict[128];
                snprintf(dmsg_ict, sizeof(dmsg_ict),
                         "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
                websocket_server_broadcast(dmsg_ict);
                continue;
            }

            /* ── Active-territory capture (existing path) ─────────────────── */
            float ra2 = ra * ra;
            float rb2 = rb * rb;

            /* ── Build union-of-discs anchor lists for full-section geometry.
             * The contested section is the union of ALL (Mi × Ej) lens pairs on
             * this island, not just the single (src_mine × src_enemy) pair that
             * was registered at placement time.  Using only the single pair would
             * leave structures that lie in other overlapping lenses uncaptured. */
            static float mine_anch_x[256], mine_anch_y[256], mine_anch_r[256];
            static float enmy_anch_x[256], enmy_anch_y[256], enmy_anch_r[256];
            int mine_an = 0, enmy_an = 0;
            for (uint32_t ai = 0; ai < placed_structure_count; ai++) {
                PlacedStructure *an = &placed_structures[ai];
                if (!an->active || an->claim_orphaned || an->island_id != isl) continue;
                if (an->type == STRUCT_CLAIM_FLAG) continue;
                float ar = struct_claim_radius(an->type);
                if (ar <= 0.0f) continue;
                if (an->type == STRUCT_FLAG_FORT && !an->fortress_complete) continue;
                if (an->company_id == (uint8_t)s->company_id && mine_an < 256) {
                    mine_anch_x[mine_an] = an->x; mine_anch_y[mine_an] = an->y;
                    mine_anch_r[mine_an] = ar; mine_an++;
                } else if (an->company_id == old_co && enmy_an < 256) {
                    enmy_anch_x[enmy_an] = an->x; enmy_anch_y[enmy_an] = an->y;
                    enmy_anch_r[enmy_an] = ar; enmy_an++;
                }
            }

            /* ── Collect victims & challengers using union-of-lens geometry.
             * A structure is in the contested section if it lies inside ANY mine
             * disc AND inside ANY enemy disc (union of all Mi×Ej lens pairs).
             * victims:     enemy territorial anchors (claim radius > 0) in section
             * challengers: own-company anchors in the section (excl. claim flag) */
            uint32_t victim_ids[MAX_PLACED_STRUCTURES];
            uint32_t chall_ids[MAX_PLACED_STRUCTURES];
            int victim_n = 0, chall_n = 0;
            for (uint32_t i = 0; i < placed_structure_count; i++) {
                PlacedStructure *ps = &placed_structures[i];
                if (!ps->active || ps->claim_orphaned) continue;
                if (ps->island_id != isl || ps->id == s->id) continue;
                bool v_in_mine = false;
                for (int _a = 0; _a < mine_an && !v_in_mine; _a++) {
                    float _dx = ps->x - mine_anch_x[_a], _dy = ps->y - mine_anch_y[_a];
                    if (_dx*_dx + _dy*_dy <= mine_anch_r[_a] * mine_anch_r[_a]) v_in_mine = true;
                }
                if (!v_in_mine) continue;
                bool v_in_enmy = false;
                for (int _a = 0; _a < enmy_an && !v_in_enmy; _a++) {
                    float _dx = ps->x - enmy_anch_x[_a], _dy = ps->y - enmy_anch_y[_a];
                    if (_dx*_dx + _dy*_dy <= enmy_anch_r[_a] * enmy_anch_r[_a]) v_in_enmy = true;
                }
                if (!v_in_enmy) continue;
                if (ps->company_id == old_co) {
                    if (struct_claim_radius(ps->type) > 0.0f)
                        if (victim_n < MAX_PLACED_STRUCTURES) victim_ids[victim_n++] = ps->id;
                } else if (ps->company_id == (uint8_t)s->company_id) {
                    if (chall_n < MAX_PLACED_STRUCTURES) chall_ids[chall_n++] = ps->id;
                }
            }
            /* Does the enemy fort's centre lie inside the contested section?
             * It is trivially inside its own disc; check against all mine discs. */
            bool enemy_center_in_intersection = false;
            for (int _a = 0; _a < mine_an && !enemy_center_in_intersection; _a++) {
                float _dx = src_enemy->x - mine_anch_x[_a], _dy = src_enemy->y - mine_anch_y[_a];
                if (_dx*_dx + _dy*_dy <= mine_anch_r[_a] * mine_anch_r[_a])
                    enemy_center_in_intersection = true;
            }

            /* Only add src_enemy to the victim list (eligible for DEMOLISHING)
             * when its centre is inside the intersection.  When the centre is
             * outside we do a DOM-only territorial shift instead. */
            if (enemy_center_in_intersection) {
                bool found = false;
                for (int k = 0; k < victim_n; k++) if (victim_ids[k] == src_enemy->id) { found = true; break; }
                if (!found && victim_n < MAX_PLACED_STRUCTURES) victim_ids[victim_n++] = src_enemy->id;
            }
            log_info("📸 Claim capture: %d victim(s), %d challenger(s) on island %u (dom_co=%u → sub_co=%u, enemy_in_area=%d)",
                     victim_n, chall_n, isl, s->company_id, old_co, (int)enemy_center_in_intersection);

            if (enemy_center_in_intersection) {
                /* ── Full capture: orphan src_enemy and start DEMOLISHING. */
                src_enemy->claim_orphaned = true;
                if (src_enemy->type == STRUCT_FLAG_FORT) {
                    src_enemy->claim_phase       = FLAG_FORT_PHASE_DEMOLISHING;
                    src_enemy->fortress_complete = false;
                    src_enemy->claim_progress_ms = (float)src_enemy->hp;
                }
                claim_demote_orphaned_in_all_dominators(orphaned_id);

                /* If the orphaned structure was a Company Fortress that owned an
                 * IslandClaim, drop that claim record. */
                if (src_enemy->type == STRUCT_COMPANY_FORTRESS && src_enemy->fortress_complete) {
                    for (int ii = 0; ii < island_claim_count; ii++) {
                        if (island_claims[ii].active
                                && island_claims[ii].island_id == isl
                                && island_claims[ii].fort_structure_id == orphaned_id) {
                            island_claims[ii].active = false;
                            break;
                        }
                    }
                    broadcast_territory_update(isl, old_co, false);
                }

                char cmsg[256];
                snprintf(cmsg, sizeof(cmsg),
                         "{\"type\":\"territory_flipped\",\"flag_id\":%u"
                         ",\"orphaned_structure_id\":%u"
                         ",\"old_company_id\":%u,\"new_company_id\":%u"
                         ",\"island_id\":%u}",
                         s->id, orphaned_id, old_co, s->company_id, isl);
                websocket_server_broadcast(cmsg);
                log_info("🏴 Claim Flag #%u captured: structure #%u (company %u) → DEMOLISHING by company %u",
                         s->id, orphaned_id, old_co, s->company_id);
            } else {
                /* ── DOM-only capture: the contested zone overlaps the enemy
                 *    fort's territory but the fort's centre is outside the
                 *    intersection, so the fort cannot be demolished.
                 *    Push all challengers to the top of the enemy fort's DOM
                 *    list and remove the fort ID from every challenger
                 *    structure's DOM list. */
                bool changed = false;
                if (dominators_prepend(src_enemy, src_mine->id)) changed = true;
                for (int ci = 0; ci < chall_n; ci++)
                    if (dominators_prepend(src_enemy, chall_ids[ci])) changed = true;
                if (changed) broadcast_structure_dominators(src_enemy);

                for (uint32_t i = 0; i < placed_structure_count; i++) {
                    PlacedStructure *ps = &placed_structures[i];
                    if (!ps->active) continue;
                    if (ps->company_id != (uint8_t)s->company_id) continue;
                    if (dominators_remove(ps, src_enemy->id))
                        broadcast_structure_dominators(ps);
                }
                log_info("🏴 Claim Flag #%u: enemy fort #%u centre outside intersection → DOM-only (no demolish)",
                         s->id, src_enemy->id);
            }

            /* ── Orphan every other enemy structure whose position lies inside
             *    the captured section (not just src_enemy). Each one is
             *    demoted in all DOM lists; flag forts are queued for deferred
             *    destruction; company fortresses lose their island claim. */
            for (int vi = 0; vi < victim_n; vi++) {
                if (victim_ids[vi] == orphaned_id) continue; /* already handled */
                PlacedStructure *vs = NULL;
                for (uint32_t k = 0; k < placed_structure_count; k++) {
                    if (placed_structures[k].id == victim_ids[vi]) { vs = &placed_structures[k]; break; }
                }
                if (!vs || !vs->active || vs->claim_orphaned) continue;

                vs->claim_orphaned = true;
                if (vs->type == STRUCT_FLAG_FORT) {
                    /* Same UNCLAIMING mechanic as the primary enemy fort. */
                    vs->claim_phase       = FLAG_FORT_PHASE_DEMOLISHING;
                    vs->fortress_complete = false;
                    vs->claim_progress_ms = (float)vs->hp;
                }
                claim_demote_orphaned_in_all_dominators(vs->id);

                if (vs->type == STRUCT_COMPANY_FORTRESS && vs->fortress_complete) {
                    for (int ii = 0; ii < island_claim_count; ii++) {
                        if (island_claims[ii].active
                                && island_claims[ii].island_id == isl
                                && island_claims[ii].fort_structure_id == vs->id) {
                            island_claims[ii].active = false;
                            break;
                        }
                    }
                    broadcast_territory_update(isl, old_co, false);
                }

                char omsg[128];
                snprintf(omsg, sizeof(omsg),
                         "{\"type\":\"structure_orphaned\",\"structure_id\":%u"
                         ",\"old_company_id\":%u}",
                         vs->id, old_co);
                websocket_server_broadcast(omsg);
                log_info("🏴   also orphaned structure #%u (type=%d, company=%u)",
                         vs->id, vs->type, old_co);
            }

            /* ── Promote each challenger above every victim in the victim's
             *    `dominators` list.
             *
             *  Pass 1 (section-based): prepend every structure in chall_ids[]
             *  that is in the contested section.
             *
             *  Pass 2 (disc-overlap): scan ALL active, non-orphaned,
             *  challenger-company structures with a non-zero claim radius
             *  (active flag forts, company fortresses) whose disc overlaps
             *  the victim's disc. This covers the common case where chall_n
             *  is 0 (the claim flag was the only challenger structure in the
             *  section) but a permanent territorial anchor exists nearby. */
            for (int vi = 0; vi < victim_n; vi++) {
                PlacedStructure *victim = NULL;
                for (uint32_t k = 0; k < placed_structure_count; k++) {
                    if (placed_structures[k].id == victim_ids[vi]) { victim = &placed_structures[k]; break; }
                }
                if (!victim) continue;

                bool changed = false;

                /* Pass 1 — section challengers */
                for (int ci = 0; ci < chall_n; ci++) {
                    if (dominators_prepend(victim, chall_ids[ci])) changed = true;
                }

                /* Pass 2 — disc-overlap territorial anchors */
                float vr = struct_claim_radius(victim->type);
                for (uint32_t i = 0; i < placed_structure_count; i++) {
                    PlacedStructure *ps = &placed_structures[i];
                    if (!ps->active) continue;
                    if (ps->claim_orphaned) continue;
                    if (ps->company_id != (uint8_t)s->company_id) continue;
                    if (ps->type == STRUCT_CLAIM_FLAG) continue;
                    /* Only include permanent anchors with actual claim radii. */
                    float pr = struct_claim_radius(ps->type);
                    if (pr <= 0.0f) continue;
                    /* Flag forts must be fortress_complete to count. */
                    if (ps->type == STRUCT_FLAG_FORT && !ps->fortress_complete) continue;
                    float dx = ps->x - victim->x, dy = ps->y - victim->y;
                    if (dx*dx + dy*dy > (vr + pr) * (vr + pr)) continue;
                    if (dominators_prepend(victim, ps->id)) changed = true;
                }

                if (changed) broadcast_structure_dominators(victim);
            }

            /* Company-wide victim-ID removal from all challenger structures. */
            for (int vi = 0; vi < victim_n; vi++) {
                for (uint32_t i = 0; i < placed_structure_count; i++) {
                    PlacedStructure *ps = &placed_structures[i];
                    if (!ps->active) continue;
                    if (ps->company_id != (uint8_t)s->company_id) continue;
                    if (dominators_remove(ps, victim_ids[vi])) {
                        broadcast_structure_dominators(ps);
                    }
                }
            }

            /* ── Encroached flag forts: enemy flag forts whose claim disc
             *    overlaps the contested area (src_mine.disc ∩ src_enemy.disc)
             *    but whose centre is OUTSIDE the intersection are not orphaned
             *    — only their DOM list is updated to push the challenger
             *    structures to the top. */
            {
                float fort_r = struct_claim_radius(STRUCT_FLAG_FORT);
                for (uint32_t i = 0; i < placed_structure_count; i++) {
                    PlacedStructure *ff = &placed_structures[i];
                    if (!ff->active) continue;
                    if (ff->claim_orphaned) continue;
                    if (ff->island_id != isl) continue;
                    if (ff->company_id != old_co) continue;
                    if (ff->type != STRUCT_FLAG_FORT) continue;
                    float dx_m = ff->x - src_mine->x,  dy_m = ff->y - src_mine->y;
                    float dx_e = ff->x - src_enemy->x, dy_e = ff->y - src_enemy->y;
                    /* Skip forts already inside the intersection (orphaned above). */
                    if (dx_m*dx_m + dy_m*dy_m <= ra2 && dx_e*dx_e + dy_e*dy_e <= rb2) continue;
                    /* Fort disc must touch both source discs to overlap the area. */
                    float sum_m = fort_r + ra, sum_e = fort_r + rb;
                    if (dx_m*dx_m + dy_m*dy_m > sum_m*sum_m) continue;
                    if (dx_e*dx_e + dy_e*dy_e > sum_e*sum_e) continue;

                    bool changed = false;
                    /* Always prepend src_mine (the anchor that triggered the
                     * contest) plus any other challengers inside the area. */
                    if (dominators_prepend(ff, src_mine->id)) changed = true;
                    for (int ci = 0; ci < chall_n; ci++) {
                        PlacedStructure *cs = NULL;
                        for (uint32_t k = 0; k < placed_structure_count; k++) {
                            if (placed_structures[k].id == chall_ids[ci]) {
                                cs = &placed_structures[k]; break;
                            }
                        }
                        if (!cs || !cs->active || cs->claim_orphaned) continue;
                        if (dominators_prepend(ff, chall_ids[ci])) changed = true;
                    }
                    if (changed) {
                        broadcast_structure_dominators(ff);
                        log_info("🏴   encroached flag fort #%u: challenger DOM entries prepended",
                                 ff->id);
                    }
                }
            }

            /* ── Convert non-territorial structures inside the contested
             *    section to the challenger's company. Any active non-orphaned
             *    structure on this island belonging to ANY other company whose
             *    POSITION lies inside the disc intersection (src_mine ∩
             *    src_enemy) is reassigned. This mirrors the presence-detection
             *    geometry exactly and does not depend on the BFS section grid.
             *    Territorial anchors (flag forts, company fortresses, claim
             *    flags) are excluded — those are handled by the orphan/
             *    dominator pipeline above. */
            {
                static uint32_t conv_ids[MAX_PLACED_STRUCTURES];
                int converted_n = 0;
                for (uint32_t i = 0; i < placed_structure_count; i++) {
                    PlacedStructure *ps = &placed_structures[i];
                    if (!ps->active) continue;
                    if (ps->island_id != isl) continue;
                    /* Skip challenger's own structures and unclaimed ones. */
                    if (ps->company_id == (uint8_t)s->company_id) continue;
                    if (ps->company_id == 0) continue;
                    if (ps->type == STRUCT_FLAG_FORT) continue;
                    if (ps->type == STRUCT_COMPANY_FORTRESS) continue;
                    if (ps->type == STRUCT_CLAIM_FLAG) continue;
                    /* Must be in the contested section: inside ANY mine disc AND any enemy disc. */
                    bool c_in_mine = false;
                    for (int _a = 0; _a < mine_an && !c_in_mine; _a++) {
                        float _dx = ps->x - mine_anch_x[_a], _dy = ps->y - mine_anch_y[_a];
                        if (_dx*_dx + _dy*_dy <= mine_anch_r[_a] * mine_anch_r[_a]) c_in_mine = true;
                    }
                    if (!c_in_mine) continue;
                    bool c_in_enmy = false;
                    for (int _a = 0; _a < enmy_an && !c_in_enmy; _a++) {
                        float _dx = ps->x - enmy_anch_x[_a], _dy = ps->y - enmy_anch_y[_a];
                        if (_dx*_dx + _dy*_dy <= enmy_anch_r[_a] * enmy_anch_r[_a]) c_in_enmy = true;
                    }
                    if (!c_in_enmy) continue;

                    uint8_t from_co = ps->company_id;
                    ps->company_id     = (uint8_t)s->company_id;
                    ps->claim_orphaned = false; /* now inside new owner's territory */
                    conv_ids[converted_n++] = ps->id;
                    char upd[128];
                    snprintf(upd, sizeof(upd),
                             "{\"type\":\"structure_company_updated\","
                             "\"structure_id\":%u,\"company_id\":%u}",
                             ps->id, (unsigned)s->company_id);
                    websocket_server_broadcast(upd);
                    log_info("🏴   converted structure #%u (type=%d) from company %u → %u",
                             ps->id, ps->type, from_co, s->company_id);
                }
                if (converted_n > 0) {
                    log_info("🏴 Claim Flag #%u converted %d structure(s) to company %u",
                             s->id, converted_n, s->company_id);
                    /* DOM fix — 2-pass only:
                     * Pass 1: purge converted IDs from all DOM lists (stale enemy refs).
                     * Pass 2: rebuild DOM for each converted structure (new ownership).
                     *
                     * No Pass 3: captured structures must not be added as dominators
                     * into enemy DOM lists.  Only the captured structures' own lists
                     * get updated with nearby enemy IDs.  Enemy DOM lists are not
                     * touched — new dominance is established via a subsequent claim flag. */
                    for (int k = 0; k < converted_n; k++) {
                        claim_remove_id_from_all_dominators(conv_ids[k]);
                    }
                    for (int k = 0; k < converted_n; k++) {
                        claim_recompute_dominators(conv_ids[k]);
                    }
                }
            }

            /* Consume the claim flag */
            s->active = false;
            char dmsg2[128];
            snprintf(dmsg2, sizeof(dmsg2),
                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
            websocket_server_broadcast(dmsg2);

        } else if (do_destroy) {
            /* Reverse timer maxed — flag defeated. */
            log_info("🏴 Claim Flag #%u destroyed (timer reversed to full)", s->id);
            s->active = false;
            char dmsg[128];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
            websocket_server_broadcast(dmsg);
        }
    }

    /* Rebuild claim graphs */
    for (int i = 0; i < island_claim_count; i++) {
        IslandClaim *ic = &island_claims[i];
        if (!ic->active) continue;
        claim_rebuild_graph((uint16_t)ic->fort_structure_id, ic->company_id);
    }
}

/* ── Harvest tax ─────────────────────────────────────────────────────────── */

int claim_apply_harvest_tax(WebSocketPlayer *player, float wx, float wy,
                            int gross_qty, ItemKind item) {
    /* Find the island the player is on */
    uint8_t isl_id = (uint8_t)player->on_island_id;
    if (isl_id == 0) return gross_qty;

    IslandClaim *ic = island_get_claim(isl_id);
    if (!ic) return gross_qty;                    /* unclaimed island — no tax */
    if (ic->company_id == player->company_id)
        return gross_qty;                          /* harvesting on own island */

    /* Apply tax */
    int tax = (int)(gross_qty * ISLAND_CLAIM_TAX_RATE);
    if (tax < 1) tax = 1;
    int net = gross_qty - tax;
    if (net < 0) net = 0;

    /* Notify the harvester */
    {
        char msg[128];
        snprintf(msg, sizeof(msg),
                 "{\"type\":\"harvest_taxed\",\"tax\":%d,\"item\":\"%s\","
                 "\"island_id\":%u,\"owner_company\":%u}",
                 tax,
                 item == ITEM_WOOD  ? "wood"  :
                 item == ITEM_STONE ? "stone" :
                 item == ITEM_FIBER ? "fiber" : "resource",
                 isl_id, ic->company_id);
        /* Send only to harvester — find their client fd */
        for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
            if (!ws_server.clients[ci].connected) continue;
            if (ws_server.clients[ci].player_id != player->player_id) continue;
            char frame[256];
            size_t flen = websocket_create_frame(WS_OPCODE_TEXT, msg, strlen(msg),
                                                 frame, sizeof(frame));
            if (flen > 0 && flen < sizeof(frame))
                send(ws_server.clients[ci].fd, frame, flen, 0);
            break;
        }
    }

    log_info("💰 Tax: player %u harvested %d %s on island %u (owned by co %u) → net %d, tax %d",
             player->player_id, gross_qty,
             item == ITEM_WOOD ? "wood" : item == ITEM_STONE ? "stone" : "fiber",
             isl_id, ic->company_id, net, tax);

    /* TODO: credit tax to island owner's company treasury when that system exists */

    (void)wx; (void)wy;
    return net;
}

/* ── Placement-time dominators population ───────────────────────────────────
 * Called from handle_place_structure right after a non-claim-flag structure
 * is added to placed_structures[]. Implements Render-Rule-X: a newly placed
 * structure starts at the BOTTOM of dominance vs. every existing enemy
 * structure that overlaps it, so the enemy keeps the overlap region until a
 * claim flag flips the priority. The enemy structures themselves are not
 * touched. */
void claim_register_placement_dominators(uint16_t new_structure_id) {
    PlacedStructure *me = NULL;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].id == new_structure_id) {
            me = &placed_structures[i];
            break;
        }
    }
    if (!me || !me->active) return;

    float mx = me->x, my = me->y;
    float mr = struct_claim_radius(me->type);
    bool changed_me = false;

    /* Only DOM-eligible structures participate; claim flags and workbenches
     * are transient or non-territorial — skip them entirely. */
    if (!dom_eligible(me->type)) return;

    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *other = &placed_structures[i];
        if (other == me) continue;
        if (!other->active) continue;
        if (other->claim_orphaned) continue;
        if (other->company_id == me->company_id) continue;
        if (other->company_id == 0) continue;
        /* Only DOM-eligible types can be dominators. */
        if (!dom_eligible(other->type)) continue;
        /* Non-active flag forts (claiming/building phase) don't yet project
         * territorial dominance — skip them. Active ones (fortress_complete)
         * are legitimate dominators and must appear in the placed structure's
         * own DOM list. */
        if (other->type == STRUCT_FLAG_FORT && !other->fortress_complete) continue;
        float pr = struct_claim_radius(other->type);
        float dx = other->x - mx, dy = other->y - my;
        float thresh = mr + pr;
        if (dx * dx + dy * dy > thresh * thresh) continue;

        /* Only update the placed structure's own DOM list.
         * Surrounding enemy structures are never modified at placement time;
         * their DOM lists are updated only on capture. */
        if (dominators_append(me, other->id)) changed_me = true;
    }
    if (changed_me) broadcast_structure_dominators(me);
}

/* ───────────────────────────────────────────────────────────────────────────
 *  Claim section flood-fill (see net/claim.h for semantics).
 * ─────────────────────────────────────────────────────────────────────────── */

/* Resolve a dominator id to its current PlacedStructure (or NULL). Linear,
 * but `placed_structure_count` is small in practice and dominator lists are
 * tiny (MAX_DOMINATORS).
 */
static PlacedStructure *find_struct_by_id(uint32_t id) {
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].id == id) return &placed_structures[i];
    }
    return NULL;
}

ClaimSectionGrid *claim_section_build(uint8_t island_id, uint8_t company_id,
                                      float px, float py) {
    /* Gather Mi / Ej indices and compute the union bbox. */
    uint32_t cap = placed_structure_count + 1;
    uint32_t *mine_idx  = (uint32_t*)malloc(sizeof(uint32_t) * cap);
    uint32_t *enemy_idx = (uint32_t*)malloc(sizeof(uint32_t) * cap);
    if (!mine_idx || !enemy_idx) { free(mine_idx); free(enemy_idx); return NULL; }
    int n_mine = 0, n_enemy = 0;
    float bbx_min = px, bby_min = py, bbx_max = px, bby_max = py;
    bool have_bb = false;

    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *ps = &placed_structures[i];
        if (!ps->active) continue;
        if (ps->claim_orphaned) continue;
        if (ps->island_id != island_id) continue;
        if (ps->type == STRUCT_FLAG_FORT && !ps->fortress_complete) continue;
        if (ps->type == STRUCT_CLAIM_FLAG) continue;   /* not a territorial anchor */
        if (ps->company_id == COMPANY_UNCLAIMED) continue;
        float r = struct_claim_radius(ps->type);
        if (ps->company_id == company_id) {
            mine_idx[n_mine++] = i;
        } else {
            enemy_idx[n_enemy++] = i;
        }
        float xmin = ps->x - r, xmax = ps->x + r;
        float ymin = ps->y - r, ymax = ps->y + r;
        if (!have_bb) {
            bbx_min = xmin; bbx_max = xmax;
            bby_min = ymin; bby_max = ymax;
            have_bb = true;
        } else {
            if (xmin < bbx_min) bbx_min = xmin;
            if (xmax > bbx_max) bbx_max = xmax;
            if (ymin < bby_min) bby_min = ymin;
            if (ymax > bby_max) bby_max = ymax;
        }
    }

    if (n_mine == 0 || n_enemy == 0) {
        free(mine_idx); free(enemy_idx);
        return NULL;
    }

    /* Always include the placement point in the grid bbox (1-cell margin). */
    if (px < bbx_min) bbx_min = px;
    if (px > bbx_max) bbx_max = px;
    if (py < bby_min) bby_min = py;
    if (py > bby_max) bby_max = py;

    const float cell = 8.0f;
    float ox = bbx_min - cell;
    float oy = bby_min - cell;
    int   w  = (int)ceilf((bbx_max - ox) / cell) + 2;
    int   h  = (int)ceilf((bby_max - oy) / cell) + 2;
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) {
        free(mine_idx); free(enemy_idx);
        return NULL;
    }

    size_t n = (size_t)w * (size_t)h;
    uint8_t *slice = (uint8_t*)calloc(n, 1);
    uint8_t *own   = (uint8_t*)calloc(n, 1);
    if (!slice || !own) {
        free(slice); free(own);
        free(mine_idx); free(enemy_idx);
        return NULL;
    }

    /* tmp_own: cells inside some Mi.disc but not inside any of that Mi's
     * dominator discs. */
    for (int km = 0; km < n_mine; km++) {
        PlacedStructure *mi = &placed_structures[mine_idx[km]];
        float mr  = struct_claim_radius(mi->type);
        float mr2 = mr * mr;
        int gx0 = (int)floorf((mi->x - mr - ox) / cell);
        int gx1 = (int)ceilf ((mi->x + mr - ox) / cell);
        int gy0 = (int)floorf((mi->y - mr - oy) / cell);
        int gy1 = (int)ceilf ((mi->y + mr - oy) / cell);
        if (gx0 < 0) gx0 = 0;
        if (gy0 < 0) gy0 = 0;
        if (gx1 >= w) gx1 = w - 1;
        if (gy1 >= h) gy1 = h - 1;
        for (int gy = gy0; gy <= gy1; gy++) {
            float wy = oy + ((float)gy + 0.5f) * cell;
            float dy = wy - mi->y;
            for (int gx = gx0; gx <= gx1; gx++) {
                float wx = ox + ((float)gx + 0.5f) * cell;
                float dx = wx - mi->x;
                if (dx*dx + dy*dy > mr2) continue;
                bool carved = false;
                for (int di = 0; di < mi->dominator_count; di++) {
                    PlacedStructure *d = find_struct_by_id(mi->dominators[di]);
                    if (!d || !d->active || d->claim_orphaned) continue;
                    if (d->type == STRUCT_FLAG_FORT && !d->fortress_complete) continue;
                    float dr  = struct_claim_radius(d->type);
                    float ddx = wx - d->x, ddy = wy - d->y;
                    if (ddx*ddx + ddy*ddy <= dr*dr) { carved = true; break; }
                }
                if (!carved) own[(size_t)gy * w + gx] = 1;
            }
        }
    }

    /* Lens union: for each (Mi, Ej) with overlapping discs, mark cells
     * inside both discs. */
    for (int km = 0; km < n_mine; km++) {
        PlacedStructure *mi = &placed_structures[mine_idx[km]];
        float mr  = struct_claim_radius(mi->type);
        float mr2 = mr * mr;
        for (int ke = 0; ke < n_enemy; ke++) {
            PlacedStructure *ej = &placed_structures[enemy_idx[ke]];
            float er  = struct_claim_radius(ej->type);
            float er2 = er * er;
            float dxc = mi->x - ej->x, dyc = mi->y - ej->y;
            float sum = mr + er;
            if (dxc*dxc + dyc*dyc >= sum*sum) continue;

            float lxmn = (mi->x - mr) > (ej->x - er) ? (mi->x - mr) : (ej->x - er);
            float lxmx = (mi->x + mr) < (ej->x + er) ? (mi->x + mr) : (ej->x + er);
            float lymn = (mi->y - mr) > (ej->y - er) ? (mi->y - mr) : (ej->y - er);
            float lymx = (mi->y + mr) < (ej->y + er) ? (mi->y + mr) : (ej->y + er);
            int gx0 = (int)floorf((lxmn - ox) / cell);
            int gx1 = (int)ceilf ((lxmx - ox) / cell);
            int gy0 = (int)floorf((lymn - oy) / cell);
            int gy1 = (int)ceilf ((lymx - oy) / cell);
            if (gx0 < 0) gx0 = 0;
            if (gy0 < 0) gy0 = 0;
            if (gx1 >= w) gx1 = w - 1;
            if (gy1 >= h) gy1 = h - 1;
            for (int gy = gy0; gy <= gy1; gy++) {
                float wy   = oy + ((float)gy + 0.5f) * cell;
                float dy_m = wy - mi->y, dy_e = wy - ej->y;
                for (int gx = gx0; gx <= gx1; gx++) {
                    float wx   = ox + ((float)gx + 0.5f) * cell;
                    float dx_m = wx - mi->x, dx_e = wx - ej->x;
                    if (dx_m*dx_m + dy_m*dy_m > mr2) continue;
                    if (dx_e*dx_e + dy_e*dy_e > er2) continue;
                    slice[(size_t)gy * w + gx] = 1;
                }
            }
        }
    }

    /* slice ∖ own */
    for (size_t i = 0; i < n; i++) if (own[i]) slice[i] = 0;
    free(own);
    free(mine_idx);
    free(enemy_idx);

    /* Locate placement cell. */
    int cgx = (int)floorf((px - ox) / cell);
    int cgy = (int)floorf((py - oy) / cell);
    if (cgx < 0 || cgy < 0 || cgx >= w || cgy >= h) { free(slice); return NULL; }
    if (!slice[(size_t)cgy * w + cgx]) { free(slice); return NULL; }

    /* BFS flood-fill (4-connected). */
    uint8_t *section = (uint8_t*)calloc(n, 1);
    int     *stack   = (int*)malloc(sizeof(int) * n);
    if (!section || !stack) { free(slice); free(section); free(stack); return NULL; }
    int sp = 0;
    int seed = cgy * w + cgx;
    section[seed] = 1;
    stack[sp++] = seed;
    while (sp > 0) {
        int k = stack[--sp];
        int x = k % w, y = k / w;
        if (x > 0     && slice[k - 1] && !section[k - 1]) { section[k - 1] = 1; stack[sp++] = k - 1; }
        if (x < w - 1 && slice[k + 1] && !section[k + 1]) { section[k + 1] = 1; stack[sp++] = k + 1; }
        if (y > 0     && slice[k - w] && !section[k - w]) { section[k - w] = 1; stack[sp++] = k - w; }
        if (y < h - 1 && slice[k + w] && !section[k + w]) { section[k + w] = 1; stack[sp++] = k + w; }
    }
    free(slice);
    free(stack);

    ClaimSectionGrid *g = (ClaimSectionGrid*)malloc(sizeof(*g));
    if (!g) { free(section); return NULL; }
    g->origin_x  = ox;
    g->origin_y  = oy;
    g->cell_size = cell;
    g->w         = w;
    g->h         = h;
    g->cells     = section;
    return g;
}

void claim_section_free(ClaimSectionGrid *g) {
    if (!g) return;
    free(g->cells);
    free(g);
}

bool claim_section_contains(const ClaimSectionGrid *g, float x, float y) {
    if (!g) return false;
    int gx = (int)floorf((x - g->origin_x) / g->cell_size);
    int gy = (int)floorf((y - g->origin_y) / g->cell_size);
    if (gx < 0 || gy < 0 || gx >= g->w || gy >= g->h) return false;
    return g->cells[(size_t)gy * g->w + gx] != 0;
}

/**
 * Returns true if any cell of the section grid lies within radius r of (cx,cy).
 * Used to detect flag forts whose claim disc overlaps the contested section
 * without the fort's own centre being inside it.
 */
bool claim_section_disc_overlaps(const ClaimSectionGrid *g,
                                 float cx, float cy, float r) {
    if (!g || r <= 0.0f) return false;
    float r2  = r * r;
    int gx0 = (int)floorf((cx - r - g->origin_x) / g->cell_size);
    int gx1 = (int)ceilf ((cx + r - g->origin_x) / g->cell_size);
    int gy0 = (int)floorf((cy - r - g->origin_y) / g->cell_size);
    int gy1 = (int)ceilf ((cy + r - g->origin_y) / g->cell_size);
    if (gx0 < 0) gx0 = 0;
    if (gy0 < 0) gy0 = 0;
    if (gx1 >= g->w) gx1 = g->w - 1;
    if (gy1 >= g->h) gy1 = g->h - 1;
    for (int gy = gy0; gy <= gy1; gy++) {
        float wy = g->origin_y + ((float)gy + 0.5f) * g->cell_size;
        float dy = wy - cy;
        for (int gx = gx0; gx <= gx1; gx++) {
            if (!g->cells[(size_t)gy * g->w + gx]) continue;
            float wx = g->origin_x + ((float)gx + 0.5f) * g->cell_size;
            float dx = wx - cx;
            if (dx*dx + dy*dy <= r2) return true;
        }
    }
    return false;
}
