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
#include "sim/island.h"
#include "util/log.h"
#include "util/time.h"

/* ── Global claim table ──────────────────────────────────────────────────── */

IslandClaim island_claims[MAX_ISLAND_CLAIMS];
int         island_claim_count = 0;

/* ── Dominance overrides ─────────────────────────────────────────────────── */

DominanceOverride dominance_overrides[MAX_DOMINANCE_OVERRIDES];
int               dominance_override_count = 0;

bool dominance_override_check(uint8_t island_id, uint32_t a_co, uint32_t b_co) {
    for (int i = 0; i < dominance_override_count; i++) {
        DominanceOverride *o = &dominance_overrides[i];
        if (!o->active) continue;
        if (o->island_id == island_id &&
            o->dominant_co == a_co &&
            o->subordinate_co == b_co) return true;
    }
    return false;
}

int dominance_override_serialize_json(const DominanceOverride *o, char *buf, int cap) {
    int n = 0;
    n += snprintf(buf + n, cap - n,
                  "{\"island_id\":%u,\"dominant_co\":%u,\"subordinate_co\":%u,"
                  "\"dom_circles\":[",
                  o->island_id, o->dominant_co, o->subordinate_co);
    for (int i = 0; i < o->dom_circle_count && n < cap - 64; i++) {
        n += snprintf(buf + n, cap - n, "%s[%.1f,%.1f,%.1f]",
                      i ? "," : "",
                      o->dom_circles[i].cx, o->dom_circles[i].cy, o->dom_circles[i].r);
    }
    n += snprintf(buf + n, cap - n, "],\"sub_circles\":[");
    for (int i = 0; i < o->sub_circle_count && n < cap - 64; i++) {
        n += snprintf(buf + n, cap - n, "%s[%.1f,%.1f,%.1f]",
                      i ? "," : "",
                      o->sub_circles[i].cx, o->sub_circles[i].cy, o->sub_circles[i].r);
    }
    n += snprintf(buf + n, cap - n, "]}");
    return n;
}

void dominance_override_add(uint8_t island_id, uint32_t dominant_co, uint32_t subordinate_co,
                            const OverrideCircle *dom_circ, int dom_n,
                            const OverrideCircle *sub_circ, int sub_n) {
    if (dominant_co == 0 || subordinate_co == 0 || dominant_co == subordinate_co) return;
    /* If the reverse override exists, remove it (dominance just flipped back). */
    for (int i = 0; i < dominance_override_count; i++) {
        DominanceOverride *o = &dominance_overrides[i];
        if (o->active && o->island_id == island_id &&
            o->dominant_co == subordinate_co && o->subordinate_co == dominant_co) {
            o->active = false;
        }
    }
    /* Find existing record (append circles) or a free slot. */
    DominanceOverride *slot = NULL;
    for (int i = 0; i < dominance_override_count; i++) {
        DominanceOverride *o = &dominance_overrides[i];
        if (o->active && o->island_id == island_id &&
            o->dominant_co == dominant_co && o->subordinate_co == subordinate_co) {
            slot = o; break;
        }
    }
    if (!slot) {
        for (int i = 0; i < dominance_override_count; i++) {
            if (!dominance_overrides[i].active) { slot = &dominance_overrides[i]; break; }
        }
        if (!slot) {
            if (dominance_override_count >= MAX_DOMINANCE_OVERRIDES) return;
            slot = &dominance_overrides[dominance_override_count++];
        }
        slot->active         = true;
        slot->island_id      = island_id;
        slot->dominant_co    = dominant_co;
        slot->subordinate_co = subordinate_co;
        slot->dom_circle_count = 0;
        slot->sub_circle_count = 0;
    }
    /* Append circles, deduping on (cx, cy, r). */
    for (int i = 0; i < dom_n && slot->dom_circle_count < MAX_OVERRIDE_CIRCLES; i++) {
        bool dup = false;
        for (int k = 0; k < slot->dom_circle_count; k++) {
            OverrideCircle *e = &slot->dom_circles[k];
            if (e->cx == dom_circ[i].cx && e->cy == dom_circ[i].cy && e->r == dom_circ[i].r) {
                dup = true; break;
            }
        }
        if (!dup) slot->dom_circles[slot->dom_circle_count++] = dom_circ[i];
    }
    for (int i = 0; i < sub_n && slot->sub_circle_count < MAX_OVERRIDE_CIRCLES; i++) {
        bool dup = false;
        for (int k = 0; k < slot->sub_circle_count; k++) {
            OverrideCircle *e = &slot->sub_circles[k];
            if (e->cx == sub_circ[i].cx && e->cy == sub_circ[i].cy && e->r == sub_circ[i].r) {
                dup = true; break;
            }
        }
        if (!dup) slot->sub_circles[slot->sub_circle_count++] = sub_circ[i];
    }
}

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
                placed_structures[i].company_id == company_id)
                placed_structures[i].claim_orphaned = true;
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

void claim_tick(uint32_t delta_ms) {
    /* Advance Company Fortress build timers */
    fortress_tick(delta_ms);

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
        /* If either source is gone or orphaned, the contested area no longer
         * exists — destroy the flag without effect. */
        if (!src_mine || !src_enemy ||
            src_mine->claim_orphaned || src_enemy->claim_orphaned ||
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
            /* ── Capture! Orphan the enemy source structure (B). Fort/fortress
             *    handling is a deferred "special case" — for now they are also
             *    just orphaned. This breaks the enemy's claim radius at the
             *    contested area without removing the structure itself. */
            uint32_t orphaned_id = src_enemy->id;
            uint32_t old_co      = src_enemy->company_id;
            uint8_t  isl         = src_enemy->island_id;

            /* Snapshot the dominator's and subordinate's claim source circles
             * on this island BEFORE orphaning anything. The captured region —
             * used by the client to render territory transfer — is the
             * intersection of these two unions. Newly placed structures (by
             * either side) after the claim are NOT included, so the dominator
             * cannot extend the takeover by placing more forts. */
            OverrideCircle dom_circ[MAX_OVERRIDE_CIRCLES];
            OverrideCircle sub_circ[MAX_OVERRIDE_CIRCLES];
            int dom_n = 0, sub_n = 0;
            for (uint32_t i = 0; i < placed_structure_count; i++) {
                PlacedStructure *ps = &placed_structures[i];
                if (!ps->active) continue;
                if (ps->claim_orphaned) continue;
                if (ps->island_id != isl) continue;
                /* Exclude the claim flag itself (it'll be consumed). */
                if (ps->id == s->id) continue;
                if (ps->company_id == s->company_id) {
                    if (dom_n < MAX_OVERRIDE_CIRCLES) {
                        dom_circ[dom_n].cx = ps->x; dom_circ[dom_n].cy = ps->y;
                        dom_circ[dom_n].r  = struct_claim_radius(ps->type);
                        dom_n++;
                    }
                } else if (ps->company_id == old_co) {
                    if (sub_n < MAX_OVERRIDE_CIRCLES) {
                        sub_circ[sub_n].cx = ps->x; sub_circ[sub_n].cy = ps->y;
                        sub_circ[sub_n].r  = struct_claim_radius(ps->type);
                        sub_n++;
                    }
                }
            }

            src_enemy->claim_orphaned = true;

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
            log_info("🏴 Claim Flag #%u captured contested area: structure #%u (company %u) orphaned by company %u",
                     s->id, orphaned_id, old_co, s->company_id);

            /* Record dominance override (with captured snapshot) */
            dominance_override_add(isl, s->company_id, old_co,
                                   dom_circ, dom_n, sub_circ, sub_n);
            {
                /* Find the override we just stored/appended-to and broadcast it. */
                for (int oi = 0; oi < dominance_override_count; oi++) {
                    DominanceOverride *o = &dominance_overrides[oi];
                    if (!o->active) continue;
                    if (o->island_id != isl) continue;
                    if (o->dominant_co != s->company_id) continue;
                    if (o->subordinate_co != old_co) continue;
                    char omsg[16384];
                    int  on = snprintf(omsg, sizeof(omsg), "{\"type\":\"dominance_override\",");
                    /* Strip the leading '{' of the serialized object and merge. */
                    char inner[16000];
                    int  inlen = dominance_override_serialize_json(o, inner, sizeof(inner));
                    (void)inlen;
                    /* inner starts with '{' — skip it. */
                    on += snprintf(omsg + on, sizeof(omsg) - on, "%s", inner + 1);
                    websocket_server_broadcast(omsg);
                    break;
                }
            }

            /* Consume the claim flag */
            s->active = false;
            char dmsg[128];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
            websocket_server_broadcast(dmsg);
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
