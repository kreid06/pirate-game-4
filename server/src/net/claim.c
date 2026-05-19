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
    return (t == STRUCT_FLAG_FORT) ? CLAIM_RADIUS_FLAG_FORT : CLAIM_RADIUS_DEFAULT;
}

/** Broadcast a territory_update JSON message. */
static void broadcast_territory_update(uint8_t island_id, uint32_t company_id,
                                       bool claimed) {
    char msg[128];
    snprintf(msg, sizeof(msg),
             "{\"type\":\"territory_update\",\"island_id\":%u,"
             "\"company_id\":%u,\"claimed\":%s}",
             island_id, company_id, claimed ? "true" : "false");
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
 * Register a new island claim when a flag fort is successfully placed.
 * Returns false if the island is already claimed.
 */
bool claim_register_fort(uint8_t island_id, uint32_t company_id,
                         uint32_t fort_struct_id, uint32_t placer_id) {
    if (island_get_claim(island_id)) return false;  /* already claimed */

    /* Find or allocate a slot */
    IslandClaim *slot = NULL;
    for (int i = 0; i < island_claim_count; i++) {
        if (!island_claims[i].active) { slot = &island_claims[i]; break; }
    }
    if (!slot) {
        if (island_claim_count >= MAX_ISLAND_CLAIMS) return false;
        slot = &island_claims[island_claim_count++];
    }
    memset(slot, 0, sizeof(*slot));
    slot->active          = true;
    slot->island_id       = island_id;
    slot->company_id      = company_id;
    slot->fort_structure_id = fort_struct_id;
    slot->fort_placer_id  = placer_id;

    /* Initial graph build — the fort is the only structure so far. */
    claim_rebuild_graph((uint16_t)fort_struct_id, company_id);

    log_info("🏴 Island %u claimed by company %u (fort #%u, placer %u)",
             island_id, company_id, fort_struct_id, placer_id);
    broadcast_territory_update(island_id, company_id, true);
    return true;
}

void claim_on_fort_destroyed(uint32_t fort_structure_id) {
    for (int i = 0; i < island_claim_count; i++) {
        IslandClaim *ic = &island_claims[i];
        if (!ic->active) continue;
        if (ic->fort_structure_id != fort_structure_id) continue;

        uint8_t  isl_id  = ic->island_id;
        uint32_t old_co  = ic->company_id;

        /* --- Check for an active claim flag on this island that was contesting
               this claim; if so, award territory to the contester. --- */
        uint32_t conquer_company = 0;
        float    best_progress   = 0.0f;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *s = &placed_structures[si];
            if (!s->active) continue;
            if (s->type != STRUCT_CLAIM_FLAG) continue;
            if (s->island_id != isl_id) continue;
            if (s->company_id == old_co) continue;
            if (s->claim_progress_ms > best_progress) {
                best_progress   = s->claim_progress_ms;
                conquer_company = s->company_id;
            }
        }

        /* Drop the claim */
        ic->active = false;

        /* Orphan all structures that were part of this claim */
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *s = &placed_structures[si];
            if (!s->active) continue;
            if (s->company_id != old_co) continue;
            if (s->island_id  != isl_id) continue;
            s->claim_orphaned = true;
        }

        log_info("🏴 Island %u claim by company %u LOST (fort #%u destroyed)",
                 isl_id, old_co, fort_structure_id);
        broadcast_territory_update(isl_id, old_co, false);

        /* If a contester exists, immediately re-register with them */
        if (conquer_company != 0) {
            /* Find any claim flag structure from the conquering company as the
               new "fort" — they'll need to place a real fort to become permanent */
            for (uint32_t si = 0; si < placed_structure_count; si++) {
                PlacedStructure *cf = &placed_structures[si];
                if (!cf->active) continue;
                if (cf->type != STRUCT_CLAIM_FLAG) continue;
                if (cf->island_id != isl_id) continue;
                if (cf->company_id != conquer_company) continue;
                /* Transfer ownership of the island temporarily — contested territory
                   now belongs to the conquering company */
                log_info("🏴 Island %u contested territory awarded to company %u",
                         isl_id, conquer_company);
                broadcast_territory_update(isl_id, conquer_company, true);
                break;
            }
        }
        return;
    }
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
static void claim_flag_convert_territory(float fx, float fy,
                                         uint32_t old_co, uint32_t new_co,
                                         uint8_t island_id,
                                         uint32_t linked_fort) {
    const float R2 = CLAIM_RADIUS_DEFAULT * CLAIM_RADIUS_DEFAULT;
    int converted = 0;
    for (uint32_t si = 0; si < placed_structure_count; si++) {
        PlacedStructure *s = &placed_structures[si];
        if (!s->active) continue;
        if (s->island_id != island_id) continue;
        if (s->company_id != old_co) continue;
        if (dist2(fx, fy, s->x, s->y) > R2) continue;
        s->company_id = (uint8_t)new_co;
        s->claim_orphaned = false;
        converted++;

        /* Broadcast individual structure ownership change */
        char msg[128];
        snprintf(msg, sizeof(msg),
                 "{\"type\":\"structure_captured\",\"id\":%u,\"company_id\":%u}",
                 s->id, new_co);
        websocket_server_broadcast(msg);
    }

    /* Re-link converted structures to the conquering fort */
    claim_rebuild_graph((uint16_t)linked_fort, new_co);

    log_info("🏴 Claim flag converted %d structures from company %u → %u (island %u)",
             converted, old_co, new_co, island_id);
}

void claim_tick(uint32_t delta_ms) {
    for (uint32_t si = 0; si < placed_structure_count; si++) {
        PlacedStructure *s = &placed_structures[si];
        if (!s->active) continue;
        if (s->type != STRUCT_CLAIM_FLAG) continue;

        float dt = (float)delta_ms;

        /* Update contested state */
        s->claim_contested = claim_flag_is_contested(
            s->x, s->y, s->company_id, s->island_id);

        if (s->claim_contested) {
            /* Reverse — timer goes backward at ISLAND_CLAIM_REVERSE speed */
            s->claim_progress_ms -= dt * ISLAND_CLAIM_REVERSE;
            if (s->claim_progress_ms < 0.0f) s->claim_progress_ms = 0.0f;
        } else {
            /* Advance */
            s->claim_progress_ms += dt;
        }

        /* Broadcast progress update to all clients (throttle: once per second) */
        {
            static uint32_t last_broadcast_ms = 0;
            uint32_t now = get_time_ms();
            if (now - last_broadcast_ms >= 1000u) {
                last_broadcast_ms = now;
                char msg[192];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"claim_flag_progress\",\"id\":%u,"
                         "\"island_id\":%u,\"company_id\":%u,"
                         "\"progress\":%.0f,\"total\":%.0f,\"contested\":%s}",
                         s->id, s->island_id, s->company_id,
                         s->claim_progress_ms,
                         (float)ISLAND_CLAIM_CAPTURE_MS,
                         s->claim_contested ? "true" : "false");
                websocket_server_broadcast(msg);
            }
        }

        /* Capture complete? */
        if (s->claim_progress_ms >= (float)ISLAND_CLAIM_CAPTURE_MS) {
            /* Determine the enemy company being contested */
            uint32_t enemy_co = 0;
            IslandClaim *ic = island_get_claim(s->island_id);
            if (ic) enemy_co = ic->company_id;

            /* Find linked fort ID */
            uint32_t lf = s->claim_linked_fort;

            log_info("🏴 Claim flag #%u captured territory for company %u (island %u)",
                     s->id, s->company_id, s->island_id);

            /* Convert structures in radius */
            if (enemy_co != 0 && enemy_co != s->company_id)
                claim_flag_convert_territory(s->x, s->y, enemy_co,
                                             s->company_id, s->island_id, lf);

            /* Broadcast capture event */
            {
                char msg[128];
                snprintf(msg, sizeof(msg),
                         "{\"type\":\"territory_captured\",\"island_id\":%u,"
                         "\"company_id\":%u,\"x\":%.1f,\"y\":%.1f}",
                         s->island_id, s->company_id, s->x, s->y);
                websocket_server_broadcast(msg);
            }

            /* Remove the claim flag (it consumed itself) */
            s->active = false;
        }
    }

    /* After each tick, rebuild claim graphs for any company that had a structure
       orphaned (simple heuristic: rebuild all active claims). */
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
