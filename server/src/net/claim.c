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
 * Check whether any enemy player is within CLAIM_RADIUS_DEFAULT of (fx,fy).
 * "Enemy" = different company_id than flag_company.
 */
static bool claim_flag_is_contested(float fx, float fy,
                                    uint32_t flag_company,
                                    uint8_t island_id) {
    /* Use global players array from websocket_server_internal.h */
    for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
        WebSocketPlayer *p = &players[pi];
        if (!p->active) continue;
        if ((uint8_t)p->on_island_id != island_id) continue;
        if (p->company_id == flag_company) continue;
        if (dist2(fx, fy, p->x, p->y) <= CLAIM_RADIUS_DEFAULT * CLAIM_RADIUS_DEFAULT)
            return true;
    }
    return false;
}

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

        /* Find the target structure (flag fort or company fortress) */
        PlacedStructureType target_type = s->claim_targets_fortress
                                         ? STRUCT_COMPANY_FORTRESS
                                         : STRUCT_FLAG_FORT;
        PlacedStructure *target = NULL;
        for (uint32_t ti = 0; ti < placed_structure_count; ti++) {
            PlacedStructure *t = &placed_structures[ti];
            if (!t->active) continue;
            if (t->type != target_type) continue;
            if (t->id == s->claim_linked_fort) { target = t; break; }
        }
        if (!target) {
            s->active = false;
            char dmsg[128];
            snprintf(dmsg, sizeof(dmsg),
                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", s->id);
            websocket_server_broadcast(dmsg);
            continue;
        }

        /* Contested = defender (target owner) inside our flag's radius */
        s->claim_contested = claim_flag_is_contested(
            s->x, s->y, s->company_id, s->island_id);

        if (s->claim_contested) {
            s->claim_progress_ms -= dt * ISLAND_CLAIM_REVERSE;
            if (s->claim_progress_ms < 0.0f) s->claim_progress_ms = 0.0f;
        } else {
            s->claim_progress_ms += dt;
        }

        /* Broadcast progress ~once per second */
        {
            static uint32_t last_broadcast_ms = 0;
            uint32_t now = get_time_ms();
            if (now - last_broadcast_ms >= 1000u) {
                last_broadcast_ms = now;
                char msg[192];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"claim_flag_progress\",\"id\":%u,"
                         "\"island_id\":%u,\"company_id\":%u,"
                         "\"progress\":%.0f,\"total\":%.0f,\"contested\":%s,"
                         "\"targets_fortress\":%s}",
                         s->id, s->island_id, s->company_id,
                         s->claim_progress_ms,
                         (float)ISLAND_CLAIM_CAPTURE_MS,
                         s->claim_contested ? "true" : "false",
                         s->claim_targets_fortress ? "true" : "false");
                websocket_server_broadcast(msg);
            }
        }

        if (s->claim_progress_ms >= (float)ISLAND_CLAIM_CAPTURE_MS) {
            /* ── Capture! ── */
            if (s->claim_targets_fortress) {
                /* Flip Company Fortress: winner starts rebuild from 0 */
                uint32_t old_co = target->company_id;
                uint8_t  isl    = target->island_id;
                target->company_id        = s->company_id;
                target->claim_progress_ms = 0.0f;
                target->fortress_complete = false;
                target->hp                = 1;
                target->claim_contested   = false;

                /* Drop old IslandClaim */
                for (int ii = 0; ii < island_claim_count; ii++) {
                    if (island_claims[ii].active
                            && island_claims[ii].island_id == isl
                            && island_claims[ii].company_id == old_co) {
                        island_claims[ii].active = false;
                        break;
                    }
                }
                broadcast_territory_update(isl, old_co, false);

                char msg[256];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"fortress_captured\",\"structure_id\":%u"
                         ",\"new_company_id\":%u,\"old_company_id\":%u"
                         ",\"island_id\":%u}",
                         target->id, s->company_id, old_co, isl);
                websocket_server_broadcast(msg);
                log_info("🏴 Company Fortress #%u on island %u captured by company %u from %u",
                         target->id, isl, s->company_id, old_co);
            } else {
                /* Flag Fort capture: flip owner */
                uint32_t old_co = target->company_id;
                uint8_t  isl    = target->island_id;
                target->company_id = s->company_id;
                broadcast_territory_update(isl, s->company_id, true);
                log_info("🏴 Flag Fort #%u on island %u captured by company %u from %u",
                         target->id, isl, s->company_id, old_co);
            }

            /* Consume the claim flag */
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
