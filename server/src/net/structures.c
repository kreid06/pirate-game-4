#include <math.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#define _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "net/websocket_server_internal.h"
#include "net/websocket_protocol.h"
#include "net/structures.h"
#include "net/dock_physics.h"
#include "net/cannon_fire.h"
#include "net/crafting.h"
#include "net/claim.h"
#include "sim/island.h"
#include "util/time.h"

/* ── Spatial hash for ceiling-connectivity flood-fill (O(N) cascade) ─────────
 * Tiles sit on a 50-px grid; walls sit at edge midpoints (25-px offset). We key
 * by 25-px cells so both ceilings and walls/door_frames have unique integer
 * coordinates. Open-addressing linear-probe hash, capacity = MAX_PLACED_STRUCTURES*4
 * (load factor ≤ 0.25, no resize ever needed). */
#define CELL_HASH_CAP (MAX_PLACED_STRUCTURES * 4)
typedef struct { int32_t cx, cy, idx; } CellEntry;

static inline int32_t cell_x(float x) { return (int32_t)lroundf(x / 25.0f); }
static inline int32_t cell_y(float y) { return (int32_t)lroundf(y / 25.0f); }

static inline uint32_t cell_hash(int32_t cx, int32_t cy) {
    uint32_t h = (uint32_t)cx * 2654435761u ^ (uint32_t)cy * 40503u;
    return h & (CELL_HASH_CAP - 1);
}

static void cell_put(CellEntry *t, int32_t cx, int32_t cy, int32_t idx) {
    uint32_t h = cell_hash(cx, cy);
    while (t[h].idx >= 0) {
        if (t[h].cx == cx && t[h].cy == cy) { t[h].idx = idx; return; }
        h = (h + 1) & (CELL_HASH_CAP - 1);
    }
    t[h].cx = cx; t[h].cy = cy; t[h].idx = idx;
}

static int32_t cell_get(const CellEntry *t, int32_t cx, int32_t cy) {
    uint32_t h = cell_hash(cx, cy);
    while (t[h].idx >= 0) {
        if (t[h].cx == cx && t[h].cy == cy) return t[h].idx;
        h = (h + 1) & (CELL_HASH_CAP - 1);
    }
    return -1;
}

/*
 * cascade_orphan_ceilings — flood-fill from walls/door_frames through edge-adjacent
 * ceilings; demolish any ceiling not reachable to a wall.
 *
 * O(N) using two spatial hashes (walls + ceilings) and a BFS queue. Ceilings are
 * square 50×50 tiles, so rotation only permutes the 4 edge offsets — they always
 * map to the same set of 4 cells regardless of placement angle.
 *
 * Caller must already have removed/marked-inactive the wall that triggered this.
 */
static void cascade_orphan_ceilings(uint32_t trigger_id, const char *trigger_kind) {
    static CellEntry walls[CELL_HASH_CAP];
    static CellEntry ceils[CELL_HASH_CAP];
    static int32_t   queue[MAX_PLACED_STRUCTURES];
    static bool      reached[MAX_PLACED_STRUCTURES];

    for (uint32_t i = 0; i < CELL_HASH_CAP; i++) { walls[i].idx = -1; ceils[i].idx = -1; }
    for (uint32_t i = 0; i < placed_structure_count; i++) reached[i] = false;
    int32_t qh = 0, qt = 0;

    /* Build wall-support map */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        const PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->type != STRUCT_WALL && s->type != STRUCT_DOOR_FRAME) continue;
        cell_put(walls, cell_x(s->x), cell_y(s->y), (int32_t)i);
    }

    /* Build ceiling map and seed the queue with directly-supported ceilings */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        const PlacedStructure *c = &placed_structures[i];
        if (!c->active || c->type != STRUCT_CEILING) continue;
        int32_t cx = cell_x(c->x), cy = cell_y(c->y);
        cell_put(ceils, cx, cy, (int32_t)i);
        if (cell_get(walls, cx,     cy - 1) >= 0 ||
            cell_get(walls, cx,     cy + 1) >= 0 ||
            cell_get(walls, cx - 1, cy    ) >= 0 ||
            cell_get(walls, cx + 1, cy    ) >= 0) {
            reached[i] = true;
            queue[qt++] = (int32_t)i;
        }
    }

    /* BFS: spread reachability through edge-adjacent ceilings (Δ = ±2 cells = ±50px) */
    while (qh < qt) {
        int32_t ai = queue[qh++];
        const PlacedStructure *a = &placed_structures[ai];
        int32_t cx = cell_x(a->x), cy = cell_y(a->y);
        const int32_t dx[4] = {  2, -2,  0,  0 };
        const int32_t dy[4] = {  0,  0,  2, -2 };
        for (int k = 0; k < 4; k++) {
            int32_t bi = cell_get(ceils, cx + dx[k], cy + dy[k]);
            if (bi >= 0 && !reached[bi]) {
                reached[bi] = true;
                queue[qt++] = bi;
            }
        }
    }

    /* Demolish unreached ceilings */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *c = &placed_structures[i];
        if (!c->active || c->type != STRUCT_CEILING) continue;
        if (reached[i]) continue;
        c->active = false;
        char cm[128];
        snprintf(cm, sizeof(cm),
                 "{\"type\":\"structure_demolished\",\"structure_id\":%u}", c->id);
        websocket_server_broadcast(cm);
        log_info("🔨 Cascade-demolished ceiling %u (lost wall connectivity after %s %u removed)",
                 c->id, trigger_kind, trigger_id);
    }
}

/* ── Island structure placement ─────────────────────────────────────────────
 * place_structure: payload = {"type":"place_structure","structure_type":"wooden_floor","x":123,"y":456}
 * Validates: player on island, item in active slot, workbench needs floor under it.
 * On success broadcasts structure_placed to all clients.
 */
#define STRUCT_FLOOR_RADIUS  30.0f  /* world-px half-extent of a floor tile (for overlap, not enforced hard) */
#define STRUCT_PLACE_RANGE  200.0f  /* player must be within this range of placement point */
#define STRUCT_FLOOR_REQ_R   55.0f  /* workbench centre must be within this of a floor tile */
/* Half the floor-tile side length (50px / 2 = 25px). Players must be this close to interact. */
#define STRUCT_INTERACT_R    50.0f  /* E-key interact range (world-px) — one full floor tile */
#define SHIPYARD_INTERACT_R 700.0f  /* larger range for the big shipyard structure */

/*
 * SAT (Separating Axis Theorem) overlap test for two 50×50 square tiles.
 * Returns true if the two OBBs share any interior point (touching edges allowed).
 * a_rad / b_rad are the tiles' rotations in radians.
 */
static bool floor_tiles_overlap(float ax, float ay, float a_rad,
                                float bx, float by, float b_rad)
{
    const float HALF = 25.0f;
    /* Small epsilon — absorbs float rounding on exact touching-edge adjacency.
       Must be > 0.1 to cover the %.1f broadcast precision gap (up to ±0.05 per
       coordinate, ±0.07 diagonal) between a tile's stored position and the
       client's snapped position derived from the broadcast value. */
    const float EPS  = 0.2f;
    float cA = cosf(a_rad), sA = sinf(a_rad);
    float cB = cosf(b_rad), sB = sinf(b_rad);
    float dx = bx - ax, dy = by - ay;
    /* 4 SAT axes: local X and Y axes of each box */
    float axes[4][2] = {
        {  cA,  sA }, { -sA, cA },
        {  cB,  sB }, { -sB, cB },
    };
    for (int i = 0; i < 4; i++) {
        float nx = axes[i][0], ny = axes[i][1];
        float d = fabsf(dx * nx + dy * ny);
        float rA = HALF * fabsf(cA*nx + sA*ny) + HALF * fabsf(-sA*nx + cA*ny);
        float rB = HALF * fabsf(cB*nx + sB*ny) + HALF * fabsf(-sB*nx + cB*ny);
        /* Touching edge (d ≈ rA+rB) is allowed — only interior overlap rejected */
        if (d >= rA + rB - EPS) return false;
    }
    return true;
}

/* Dominant company on an island.
 * Per-pair rule:
 *   - A dominance override (from a successful claim flag) wins outright.
 *   - Otherwise the company with the EARLIER fort (lower structure id) wins —
 *     i.e. whoever claimed the area first keeps their territory when a later
 *     company places forts/structures next door.
 * Returns the unique company that dominates ALL others on the island, or 0
 * if there is no fort/fortress on the island or no unique dominator. */
static uint32_t island_dominant_company(uint32_t island_id) __attribute__((unused));
static uint32_t island_dominant_company(uint32_t island_id) {
    /* Gather forts per company on this island (oldest id per company). */
    typedef struct { uint32_t co; uint32_t id; } CoFort;
    CoFort forts[32]; int nf = 0;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->claim_orphaned) continue;
        if ((uint32_t)s->island_id != island_id) continue;
        if (s->type != STRUCT_COMPANY_FORTRESS && s->type != STRUCT_FLAG_FORT) continue;
        /* Skip CF that hasn't completed yet — only completed structures count. */
        if (s->type == STRUCT_COMPANY_FORTRESS && !s->fortress_complete) continue;
        /* Merge into existing slot for this company (keep oldest / lowest id). */
        bool merged = false;
        for (int k = 0; k < nf; k++) {
            if (forts[k].co == s->company_id) {
                if (s->id < forts[k].id) forts[k].id = s->id;
                merged = true; break;
            }
        }
        if (!merged && nf < 32) {
            forts[nf].co = s->company_id; forts[nf].id = s->id;
            nf++;
        }
    }
    if (nf == 0) return 0;
    if (nf == 1) return forts[0].co;
    /* A company is "the" dominant company iff it dominates every other. */
    for (int a = 0; a < nf; a++) {
        bool dominates_all = true;
        for (int b = 0; b < nf; b++) {
            if (a == b) continue;
            /* Natural rule: earlier (lower id) fort wins. Per-structure
             * dominator promotions from claim captures are evaluated in
             * the client renderer (territory carving), not here. */
            if (forts[a].id < forts[b].id) continue;
            dominates_all = false; break;
        }
        if (dominates_all) return forts[a].co;
    }
    return 0;
}

void handle_place_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[256];

    /* Parse placement position and structure type up front.
       Round px/py to 1 decimal place so the stored position exactly matches the
       %.1f broadcast precision — prevents snap candidates derived from broadcast
       values being falsely rejected as overlapping the snap source tile. */
    float px = player->x, py = player->y;
    {
        char* pxs = strstr(payload, "\"x\":");
        char* pys = strstr(payload, "\"y\":");
        if (pxs) sscanf(pxs + 4, "%f", &px);
        if (pys) sscanf(pys + 4, "%f", &py);
    }
    /* Snap to 0.1 px grid to match broadcast precision */
    px = roundf(px * 10.0f) / 10.0f;
    py = roundf(py * 10.0f) / 10.0f;

    char stype[32] = {0};
    {
        char* st = strstr(payload, "\"structure_type\":\"");
        if (st) {
            st += 18;
            int ti = 0;
            while (ti < 31 && *st && *st != '"') stype[ti++] = *st++;
        }
    }

    /* Placement point (px,py) must lie within a valid island beach boundary.
       Only wooden floors are rejected for water placement — other structures
       require a floor tile anyway, so the floor-edge/floor-centre checks
       below are sufficient to keep them on land. */
    uint32_t target_island_id = 0;
    {
        for (int ii = 0; ii < ISLAND_COUNT; ii++) {
            const IslandDef *isl = &ISLAND_PRESETS[ii];
            float dx     = px - isl->x, dy = py - isl->y;
            float dist_sq = dx*dx + dy*dy;
            bool on_isl;
            if (isl->vertex_count > 0) {
                on_isl = (dist_sq < isl->poly_bound_r * isl->poly_bound_r)
                      && island_poly_contains(isl, px, py);
            } else {
                float broad_r = isl->beach_radius_px + isl->beach_max_bump;
                if (dist_sq >= broad_r * broad_r) { on_isl = false; }
                else {
                    float angle   = atan2f(dy, dx);
                    float narrow_r = island_boundary_r(isl->beach_radius_px, isl->beach_bumps, angle);
                    on_isl = (dist_sq < narrow_r * narrow_r);
                }
            }
            if (on_isl) { target_island_id = (uint32_t)isl->id; break; }
        }
    }
    if (target_island_id == 0 && strcmp(stype, "wooden_floor") == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"place_structure_fail\",\"reason\":\"in_water\"}");
        goto ps_send;
    }

    /* Shipyard: must be placed in shallow water — outside the island beach
       boundary but within SHALLOW_WATER_DEPTH_PX of it. */
    if (strcmp(stype, "shipyard") == 0) {
        bool in_shallow = false;
        for (int ii = 0; ii < ISLAND_COUNT && !in_shallow; ii++) {
            if (island_in_shallow_water(&ISLAND_PRESETS[ii], px, py)) {
                in_shallow = true;
                target_island_id = (uint32_t)ISLAND_PRESETS[ii].id;
            }
        }
        if (!in_shallow) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"needs_shallow_water\"}");
            goto ps_send;
        }
        /* Prevent stacking multiple shipyards too close together */
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_SHIPYARD) continue;
            float ddx = placed_structures[si].x - px;
            float ddy = placed_structures[si].y - py;
            if (ddx*ddx + ddy*ddy < 120.0f * 120.0f) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"occupied\"}");
                goto ps_send;
            }
        }
    }

    PlacedStructureType stype_enum;
    ItemKind required_item;
    if (strcmp(stype, "wooden_floor") == 0) {
        stype_enum    = STRUCT_WOODEN_FLOOR;
        required_item = ITEM_WOODEN_FLOOR;
    } else if (strcmp(stype, "workbench") == 0) {
        stype_enum    = STRUCT_WORKBENCH;
        required_item = ITEM_WORKBENCH;
    } else if (strcmp(stype, "wall") == 0) {
        stype_enum    = STRUCT_WALL;
        required_item = ITEM_WALL;
    } else if (strcmp(stype, "door_frame") == 0) {
        stype_enum    = STRUCT_DOOR_FRAME;
        required_item = ITEM_DOOR_FRAME;
    } else if (strcmp(stype, "door") == 0) {
        stype_enum    = STRUCT_DOOR;
        required_item = ITEM_DOOR;
    } else if (strcmp(stype, "shipyard") == 0) {
        stype_enum    = STRUCT_SHIPYARD;
        required_item = ITEM_SHIPYARD;
    } else if (strcmp(stype, "wood_ceiling") == 0) {
        stype_enum    = STRUCT_CEILING;
        required_item = ITEM_WOOD_CEILING;
    } else if (strcmp(stype, "cannon") == 0) {
        stype_enum    = STRUCT_CANNON;
        required_item = ITEM_CANNON;
    } else if (strcmp(stype, "flag_fort") == 0) {
        stype_enum    = STRUCT_FLAG_FORT;
        required_item = ITEM_FLAG_FORT;  /* crafted from 40 wood + 40 stone */
    } else if (strcmp(stype, "company_fortress") == 0) {
        stype_enum    = STRUCT_COMPANY_FORTRESS;
        required_item = ITEM_COMPANY_FORTRESS;  /* 100 wood + 100 stone + 20 metal */
    } else if (strcmp(stype, "claim_flag") == 0) {
        stype_enum    = STRUCT_CLAIM_FLAG;
        required_item = ITEM_CLAIM_FLAG;
    } else {
        snprintf(response, sizeof(response),
                 "{\"type\":\"place_structure_fail\",\"reason\":\"unknown_type\"}");
        goto ps_send;
    }

    /* Player must have the item somewhere in their inventory (skip for ITEM_NONE) */
    int found_slot = -1;
    if (required_item != ITEM_NONE) {
        for (int s = 0; s < INVENTORY_SLOTS; s++) {
            if (player->inventory.slots[s].item == required_item &&
                player->inventory.slots[s].quantity > 0) {
                found_slot = s;
                break;
            }
        }
        if (found_slot < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"missing_item\"}");
            goto ps_send;
        }
    }

    /* Player must be reasonably close to placement point */
    {
        float dx = player->x - px, dy = player->y - py;
        /* Shipyards extend far into water — allow placing from land (700 px) */
        float place_range = (strcmp(stype, "shipyard") == 0) ? 700.0f : STRUCT_PLACE_RANGE;
        if (dx*dx + dy*dy > place_range * place_range) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"too_far\"}");
            goto ps_send;
        }
    }

    /* ── Dominance bypass ────────────────────────────────────────────────
     * Dominators-only law (matches client Render Rule X):
     * if the placement point is owned by the player's company per the
     * per-pixel dominators test (own uncarved territory OR captured enemy
     * overlap), then enemy claim areas are subordinate at this point and
     * do not block placement. */
    bool in_my_dominant_area = false;
    if (player->company_id != 0 && target_island_id != 0 &&
        claim_point_in_my_territory(px, py, (uint32_t)player->company_id)) {
        in_my_dominant_area = true;
    }

    /* Cannot place within 500 px of an enemy-company structure
       — bypassed when the player is inside their own dominant claim area.
       Also bypassed for claim flags: they are intentionally placed where
       enemy structures are present (the contested area). */
    if (stype_enum != STRUCT_CLAIM_FLAG && !in_my_dominant_area) {
        bool enemy_block = false;
        for (uint32_t si = 0; si < placed_structure_count && !enemy_block; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].company_id == (uint8_t)player->company_id) continue; /* own */
            float dx = placed_structures[si].x - px;
            float dy = placed_structures[si].y - py;
            if (dx*dx + dy*dy < 500.0f * 500.0f) enemy_block = true;
        }
        if (enemy_block) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"enemy_territory\"}");
            goto ps_send;
        }
    }

    /* ── Flag Fort: validate island is unclaimed; register claim on placement ── */
    if (stype_enum == STRUCT_FLAG_FORT) {
        if (target_island_id == 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"not_on_island\"}");
            goto ps_send;
        }
        if (island_get_claim((uint8_t)target_island_id)) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"island_already_claimed\"}");
            goto ps_send;
        }
        /* Max 3 flag forts per company per island */
        {
            int company_fort_count = 0;
            for (uint32_t si = 0; si < placed_structure_count; si++) {
                PlacedStructure *ex = &placed_structures[si];
                if (!ex->active) continue;
                if (ex->type != STRUCT_FLAG_FORT) continue;
                if ((uint8_t)ex->island_id != (uint8_t)target_island_id) continue;
                if (ex->company_id != (uint8_t)player->company_id) continue;
                company_fort_count++;
            }
            if (company_fort_count >= 3) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"fort_exists\"}");
                goto ps_send;
            }
        }
        /* Item (ITEM_FLAG_FORT) is consumed by the normal item-slot path below */
    }

    /* ── Claiming Flag: must be placed in a CONTESTED AREA ── */
    /* Contested area = a point covered by BOTH (a) a claim radius of the placer's
     * company AND (b) a claim radius of ANY other company. The flag is uniquely
     * identified by the (mine_src, enemy_src) source pair — only one active flag
     * per pair per company at a time. */
    uint32_t cf_src_mine = 0, cf_src_enemy = 0;
    if (stype_enum == STRUCT_CLAIM_FLAG) {
        /* Find best "mine" source: closest active non-orphaned structure of the
         * placer's company whose claim radius covers (px,py).
         * INACTIVE flag forts (HP below 30%) are excluded — a fresh or
         * heavily-damaged flag fort cannot champion a claim flag. */
        float best_mine_d2 = 0.0f;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *ex = &placed_structures[si];
            if (!ex->active) continue;
            if (ex->claim_orphaned) continue;
            if (ex->company_id != (uint8_t)player->company_id) continue;
            if (ex->type == STRUCT_FLAG_FORT && !ex->fortress_complete) continue;
            float cr = (ex->type == STRUCT_FLAG_FORT)        ? CLAIM_RADIUS_FLAG_FORT
                     : (ex->type == STRUCT_COMPANY_FORTRESS) ? CLAIM_RADIUS_COMPANY_FORT
                                                              : CLAIM_RADIUS_DEFAULT;
            float dx = px - ex->x, dy = py - ex->y;
            float d2 = dx*dx + dy*dy;
            if (d2 > cr * cr) continue;
            if (cf_src_mine == 0 || d2 < best_mine_d2) {
                cf_src_mine  = ex->id;
                best_mine_d2 = d2;
            }
        }
        if (cf_src_mine == 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"not_in_my_territory\"}");
            goto ps_send;
        }
        /* Find best "enemy" source: closest active non-orphaned structure of a
         * DIFFERENT company whose claim radius covers (px,py). */
        float best_enemy_d2 = 0.0f;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *ex = &placed_structures[si];
            if (!ex->active) continue;
            if (ex->claim_orphaned) continue;
            if (ex->company_id == COMPANY_UNCLAIMED) continue;
            if (ex->company_id == (uint8_t)player->company_id) continue;
            float cr = (ex->type == STRUCT_FLAG_FORT)        ? CLAIM_RADIUS_FLAG_FORT
                     : (ex->type == STRUCT_COMPANY_FORTRESS) ? CLAIM_RADIUS_COMPANY_FORT
                                                              : CLAIM_RADIUS_DEFAULT;
            float dx = px - ex->x, dy = py - ex->y;
            float d2 = dx*dx + dy*dy;
            if (d2 > cr * cr) continue;
            if (cf_src_enemy == 0 || d2 < best_enemy_d2) {
                cf_src_enemy  = ex->id;
                best_enemy_d2 = d2;
            }
        }
        if (cf_src_enemy == 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"not_in_contested_area\"}");
            goto ps_send;
        }
        /* Uniqueness: one active claim flag per (my company, enemy company,
         * island). A "contested area" between two companies on the same island
         * is treated as a single region — my company may only contest it with
         * one flag at a time, regardless of which fort/structure pair was
         * chosen as the (mine, enemy) source. */
        uint8_t enemy_company = 0;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *ex = &placed_structures[si];
            if (ex->active && ex->id == cf_src_enemy) {
                enemy_company = ex->company_id;
                break;
            }
        }
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            PlacedStructure *ex = &placed_structures[si];
            if (!ex->active) continue;
            if (ex->type != STRUCT_CLAIM_FLAG) continue;
            if (ex->company_id != (uint8_t)player->company_id) continue;
            if (ex->island_id  != (uint8_t)target_island_id) continue;
            /* Find this existing flag's enemy company. */
            uint8_t ex_enemy_company = 0;
            for (uint32_t sj = 0; sj < placed_structure_count; sj++) {
                PlacedStructure *es = &placed_structures[sj];
                if (es->active && es->id == ex->claim_source_enemy) {
                    ex_enemy_company = es->company_id;
                    break;
                }
            }
            if (ex_enemy_company == enemy_company) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"contested_area_already_claimed\"}");
                goto ps_send;
            }
        }
    }

    /* ── Company Fortress: must be on an island ── */
    if (stype_enum == STRUCT_COMPANY_FORTRESS) {
        if (target_island_id == 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"not_on_island\"}");
            goto ps_send;
        }
        /* Multiple in-progress fortresses are allowed; only one can complete */
    }

    /* Cannot place within claim radius of an enemy non-orphaned structure
       (orphaned structures = dead fort — they are passable for building purposes).
       Bypassed when the player is inside their own dominant claim area, mirroring
       the client's overlay logic where subordinate enemy claims are visually carved out. */
    if (stype_enum != STRUCT_CLAIM_FLAG && !in_my_dominant_area) {  /* claim flags are placed IN contested territory */
        bool enemy_block = territory_is_claimed_by_any(px, py, NULL);
        if (enemy_block) {
            uint32_t owner_co = 0;
            territory_is_claimed_by_any(px, py, &owner_co);
            if (owner_co != 0 && owner_co != (uint32_t)player->company_id) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"enemy_territory\"}");
                goto ps_send;
            }
        }
    }

    /* Parse rotation early so all subsequent checks can use it */
    float place_rotation_deg = 0.0f;
    {
        const char* rots = strstr(payload, "\"rotation\":");
        if (rots) sscanf(rots + 11, "%f", &place_rotation_deg);
    }
    const float place_rad = place_rotation_deg * (float)M_PI / 180.0f;

    /* Wooden floor: OBB-OBB overlap check via SAT.
       No two floor tiles may share interior space regardless of their rotation angles. */
    if (stype_enum == STRUCT_WOODEN_FLOOR) {
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_WOODEN_FLOOR) continue;
            float exist_rad = placed_structures[si].rotation * (float)M_PI / 180.0f;
            if (floor_tiles_overlap(px, py, place_rad,
                                    placed_structures[si].x, placed_structures[si].y, exist_rad)) {
                log_debug("place_structure FAIL occupied: new floor at (%.2f,%.2f) rot=%.2f"
                          " blocked by floor id=%u at (%.2f,%.2f) rot=%.2f (dist=%.2f)",
                          px, py, place_rotation_deg,
                          placed_structures[si].id,
                          placed_structures[si].x, placed_structures[si].y,
                          placed_structures[si].rotation,
                          sqrtf((px - placed_structures[si].x) * (px - placed_structures[si].x) +
                                (py - placed_structures[si].y) * (py - placed_structures[si].y)));
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"occupied\",\"blocker_id\":%u}",
                         placed_structures[si].id);
                goto ps_send;
            }
        }
    }

    /* Wooden floor: must not intersect a tree (wood resource) on any island.
       Obstacle radius TREE_R=20 px; test via circle-OBB closest-point in the floor's local space. */
    if (stype_enum == STRUCT_WOODEN_FLOOR) {
        const float TREE_R  = 20.0f;
        const float HALF    = 25.0f; /* half tile */
        float rc = cosf(-place_rad), rs = sinf(-place_rad);
        bool blocked = false;
        for (int ii = 0; ii < ISLAND_COUNT && !blocked; ii++) {
            const IslandDef *isl = &ISLAND_PRESETS[ii];
            for (int ri = 0; ri < isl->resource_count && !blocked; ri++) {
                if (isl->resources[ri].type_id != RES_WOOD) continue;
                if (isl->resources[ri].health <= 0) continue; /* depleted — no longer an obstacle */
                float tx = isl->x + isl->resources[ri].ox;
                float ty = isl->y + isl->resources[ri].oy;
                /* Rotate tree into floor's local space */
                float lx = (tx - px) * rc - (ty - py) * rs;
                float ly = (tx - px) * rs + (ty - py) * rc;
                /* Closest point on local AABB [-HALF, HALF] x [-HALF, HALF] */
                float cx = lx < -HALF ? -HALF : (lx > HALF ? HALF : lx);
                float cy = ly < -HALF ? -HALF : (ly > HALF ? HALF : ly);
                float cdx = lx - cx, cdy = ly - cy;
                if (cdx*cdx + cdy*cdy < TREE_R * TREE_R) blocked = true;
            }
        }
        if (blocked) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"blocked_by_tree\"}");
            goto ps_send;
        }
    }

    /* Workbench: centre point must fall inside the rotated floor tile (50x50 px)
       AND that floor tile must belong to the same company as the placing player. */
    if (stype_enum == STRUCT_WORKBENCH) {
        bool has_floor     = false;
        bool wrong_company = false;
        const float HALF_TILE = 25.0f;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_WOODEN_FLOOR) continue;
            /* Rotate placement point into floor's local space */
            float rad = placed_structures[si].rotation * (float)M_PI / 180.0f;
            float c   = cosf(-rad), s = sinf(-rad);
            float ddx = px - placed_structures[si].x;
            float ddy = py - placed_structures[si].y;
            float lx  = ddx * c - ddy * s;
            float ly  = ddx * s + ddy * c;
            if (fabsf(lx) <= HALF_TILE && fabsf(ly) <= HALF_TILE) {
                if (placed_structures[si].company_id != (uint8_t)player->company_id)
                    wrong_company = true;
                else
                    has_floor = true;
                break;
            }
        }
        if (!has_floor) {
            snprintf(response, sizeof(response), wrong_company
                     ? "{\"type\":\"place_structure_fail\",\"reason\":\"wrong_company\"}"
                     : "{\"type\":\"place_structure_fail\",\"reason\":\"needs_floor\"}");
            goto ps_send;
        }
    }

    /* Cannon: centre point must fall inside the rotated floor tile (50x50 px)
       AND that floor tile must belong to the same company as the placing player. */
    if (stype_enum == STRUCT_CANNON) {
        bool has_floor     = false;
        bool wrong_company = false;
        const float HALF_TILE = 25.0f;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_WOODEN_FLOOR) continue;
            float rad = placed_structures[si].rotation * (float)M_PI / 180.0f;
            float c   = cosf(-rad), s = sinf(-rad);
            float ddx = px - placed_structures[si].x;
            float ddy = py - placed_structures[si].y;
            float lx  = ddx * c - ddy * s;
            float ly  = ddx * s + ddy * c;
            if (fabsf(lx) <= HALF_TILE && fabsf(ly) <= HALF_TILE) {
                if (placed_structures[si].company_id != (uint8_t)player->company_id)
                    wrong_company = true;
                else
                    has_floor = true;
                break;
            }
        }
        if (!has_floor) {
            snprintf(response, sizeof(response), wrong_company
                     ? "{\"type\":\"place_structure_fail\",\"reason\":\"wrong_company\"}"
                     : "{\"type\":\"place_structure_fail\",\"reason\":\"needs_floor\"}");
            goto ps_send;
        }
    }

    /* Wall / Door: must snap to an edge midpoint of an existing same-company floor tile.
       Edge midpoints are at (fx, fy±25) and (fx±25, fy) for floor at (fx, fy). */
    if (stype_enum == STRUCT_WALL || stype_enum == STRUCT_DOOR_FRAME) {
        const float EDGE_TOL  = 3.0f;
        const float HALF_TILE = 25.0f;
        bool has_edge     = false;
        bool wrong_company = false;
        bool wall_occupied = false;
        float wall_rad    = 0.0f;  /* actual wall orientation in world space */
        /* First: overlap check — no two walls/doors at same position */
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_WALL &&
                placed_structures[si].type != STRUCT_DOOR_FRAME) continue;
            if (fabsf(placed_structures[si].x - px) < EDGE_TOL &&
                fabsf(placed_structures[si].y - py) < EDGE_TOL) {
                wall_occupied = true; break;
            }
        }
        if (wall_occupied) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"occupied\"}");
            goto ps_send;
        }
        /* Validate floor-edge alignment and determine orientation.
           Each floor may be rotated, so compute the 4 edge-midpoint positions
           by rotating the canonical ±HALF_TILE offsets by that floor's angle. */
        for (uint32_t si = 0; si < placed_structure_count && !has_edge; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_WOODEN_FLOOR) continue;
            float fx  = placed_structures[si].x;
            float fy  = placed_structures[si].y;
            float rad = placed_structures[si].rotation * (float)M_PI / 180.0f;
            float c   = cosf(rad), s = sinf(rad);
            /* 4 local-space offsets: N(0,-H), S(0,+H), W(-H,0), E(+H,0) */
            /* horiz = true for N/S edges (wall runs along X in local space) */
            const struct { float ldx; float ldy; bool horiz; } edges[4] = {
                {  0.0f,        -HALF_TILE,  true  }, /* N */
                {  0.0f,         HALF_TILE,  true  }, /* S */
                { -HALF_TILE,    0.0f,        false }, /* W */
                {  HALF_TILE,    0.0f,        false }, /* E */
            };
            for (int ei = 0; ei < 4 && !has_edge; ei++) {
                float ex = fx + edges[ei].ldx * c - edges[ei].ldy * s;
                float ey = fy + edges[ei].ldx * s + edges[ei].ldy * c;
                if (fabsf(px - ex) < EDGE_TOL && fabsf(py - ey) < EDGE_TOL) {
                    if (placed_structures[si].company_id != (uint8_t)player->company_id)
                        wrong_company = true;
                    else {
                        has_edge   = true;
                        /* N/S edges → wall runs along floor local-X (floor_rad + 0)
                           E/W edges → wall runs along floor local-Y (floor_rad + π/2) */
                        wall_rad = rad + (edges[ei].horiz ? 0.0f : (float)M_PI / 2.0f);
                    }
                }
            }
        }
        if (!has_edge) {
            snprintf(response, sizeof(response), wrong_company
                     ? "{\"type\":\"place_structure_fail\",\"reason\":\"wrong_company\"}"
                     : "{\"type\":\"place_structure_fail\",\"reason\":\"needs_floor_edge\"}");
            goto ps_send;
        }
        /* Check if any player is occupying the wall/door space */
        {
            const float PLAYER_R = 8.0f;
            const float HW = 25.0f, HH = 5.0f;  /* half-extents in wall local space */
            float wc = cosf(-wall_rad), ws = sinf(-wall_rad);
            bool player_in_way = false;
            for (int pi2 = 0; pi2 < MAX_PLAYERS && !player_in_way; pi2++) {
                if (!players[pi2].active) continue;
                float cpx = players[pi2].x - px;
                float cpy = players[pi2].y - py;
                /* Rotate into wall local space */
                float lx = cpx * wc - cpy * ws;
                float ly = cpx * ws + cpy * wc;
                float clx = lx < -HW ? -HW : (lx > HW ? HW : lx);
                float cly = ly < -HH ? -HH : (ly > HH ? HH : ly);
                float dpx = lx - clx, dpy = ly - cly;
                if (dpx*dpx + dpy*dpy < PLAYER_R * PLAYER_R) player_in_way = true;
            }
            if (player_in_way) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"blocked_by_player\"}");
                goto ps_send;
            }
        }
        /* Check if any non-floor structure (workbench/door) blocks this space */
        {
            const float BLOCK_R = 35.0f;
            bool struct_in_way = false;
            for (uint32_t si = 0; si < placed_structure_count && !struct_in_way; si++) {
                if (!placed_structures[si].active) continue;
                if (placed_structures[si].type == STRUCT_WOODEN_FLOOR) continue;
                if (placed_structures[si].type == STRUCT_WALL) continue;
                if (placed_structures[si].type == STRUCT_DOOR_FRAME) continue;
                if (placed_structures[si].type == STRUCT_DOOR) continue;
                if (placed_structures[si].type == STRUCT_CEILING) continue;
                float dpx = placed_structures[si].x - px;
                float dpy = placed_structures[si].y - py;
                if (dpx*dpx + dpy*dpy < BLOCK_R * BLOCK_R) struct_in_way = true;
            }
            if (struct_in_way) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"occupied\"}");
                goto ps_send;
            }
        }
    }

    /* Ceiling: must be adjacent to a wall/door_frame (at one of its 4 edge midpoints)
       OR adjacent (edge-touching) to an existing ceiling tile. */
    if (stype_enum == STRUCT_CEILING) {
        const float EDGE_TOL  = 3.0f;
        const float HALF_TILE = 25.0f;
        const float TILE      = 50.0f;
        /* Overlap: no two ceilings at same position */
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (placed_structures[si].type != STRUCT_CEILING) continue;
            if (fabsf(placed_structures[si].x - px) < EDGE_TOL &&
                fabsf(placed_structures[si].y - py) < EDGE_TOL) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"occupied\"}");
                goto ps_send;
            }
        }
        bool supported = false;
        /* Check 1: a wall or door_frame exists at one of this ceiling's 4 edge midpoints */
        {
            float c = cosf(place_rad), s = sinf(place_rad);
            const struct { float ldx; float ldy; } edge_offs[4] = {
                {  0.0f,      -HALF_TILE },
                {  0.0f,       HALF_TILE },
                { -HALF_TILE,  0.0f      },
                {  HALF_TILE,  0.0f      },
            };
            for (int ei = 0; ei < 4 && !supported; ei++) {
                float ex = px + edge_offs[ei].ldx * c - edge_offs[ei].ldy * s;
                float ey = py + edge_offs[ei].ldx * s + edge_offs[ei].ldy * c;
                for (uint32_t si = 0; si < placed_structure_count && !supported; si++) {
                    if (!placed_structures[si].active) continue;
                    if (placed_structures[si].type != STRUCT_WALL &&
                        placed_structures[si].type != STRUCT_DOOR_FRAME) continue;
                    if (fabsf(placed_structures[si].x - ex) < EDGE_TOL &&
                        fabsf(placed_structures[si].y - ey) < EDGE_TOL) {
                        supported = true;
                    }
                }
            }
        }
        /* Check 2: an adjacent ceiling tile exists (center is ~TILE away) */
        if (!supported) {
            for (uint32_t si = 0; si < placed_structure_count && !supported; si++) {
                if (!placed_structures[si].active) continue;
                if (placed_structures[si].type != STRUCT_CEILING) continue;
                float cr = placed_structures[si].rotation * (float)M_PI / 180.0f;
                float cc = cosf(cr), cs = sinf(cr);
                /* 4 adjacent tile centres from this existing ceiling */
                const struct { float ldx; float ldy; } adj[4] = {
                    {  TILE, 0.0f }, { -TILE, 0.0f },
                    { 0.0f,  TILE }, { 0.0f, -TILE },
                };
                for (int ai = 0; ai < 4 && !supported; ai++) {
                    float ax = placed_structures[si].x + adj[ai].ldx * cc - adj[ai].ldy * cs;
                    float ay = placed_structures[si].y + adj[ai].ldx * cs + adj[ai].ldy * cc;
                    if (fabsf(ax - px) < EDGE_TOL && fabsf(ay - py) < EDGE_TOL) {
                        supported = true;
                    }
                }
            }
        }
        if (!supported) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"needs_wall_or_ceiling\"}");
            goto ps_send;
        }
        /* Must also have a same-company floor tile within 2 tile-widths (100 px) */
        {
            const float FLOOR_UNDER_R = 100.0f;
            bool has_floor = false;
            for (uint32_t si = 0; si < placed_structure_count && !has_floor; si++) {
                if (!placed_structures[si].active) continue;
                if (placed_structures[si].type != STRUCT_WOODEN_FLOOR) continue;
                if (placed_structures[si].company_id != (uint8_t)player->company_id) continue;
                float fdx = placed_structures[si].x - px;
                float fdy = placed_structures[si].y - py;
                if (fdx*fdx + fdy*fdy <= FLOOR_UNDER_R * FLOOR_UNDER_R) has_floor = true;
            }
            if (!has_floor) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"place_structure_fail\",\"reason\":\"needs_floor_nearby\"}");
                goto ps_send;
            }
        }
    }

    /* Door (panel): must snap onto an existing door_frame at the same position */
    if (stype_enum == STRUCT_DOOR) {
        const float POS_TOL = 3.0f;
        bool has_frame  = false;
        bool door_taken = false;
        for (uint32_t si = 0; si < placed_structure_count; si++) {
            if (!placed_structures[si].active) continue;
            if (fabsf(placed_structures[si].x - px) >= POS_TOL ||
                fabsf(placed_structures[si].y - py) >= POS_TOL) continue;
            if (placed_structures[si].type == STRUCT_DOOR_FRAME) has_frame  = true;
            if (placed_structures[si].type == STRUCT_DOOR)       door_taken = true;
        }
        if (door_taken) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"occupied\"}");
            goto ps_send;
        }
        if (!has_frame) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"place_structure_fail\",\"reason\":\"needs_door_frame\"}");
            goto ps_send;
        }
    }

    /* Parse rotation (floors and workbenches only; ignored for walls/doors) */
    float place_rotation = place_rotation_deg; /* already parsed above */

    /* Space for more structures? */
    if (placed_structure_count >= MAX_PLACED_STRUCTURES) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"place_structure_fail\",\"reason\":\"world_full\"}");
        goto ps_send;
    }

    /* Consume 1 item from the found slot */
    if (found_slot >= 0) {
        player->inventory.slots[found_slot].quantity--;
        if (player->inventory.slots[found_slot].quantity == 0)
            player->inventory.slots[found_slot].item = ITEM_NONE;
    }

    /* Add structure */
    uint16_t new_id = next_structure_id++;
    placed_structures[placed_structure_count].active     = true;
    placed_structures[placed_structure_count].id         = new_id;
    placed_structures[placed_structure_count].type       = stype_enum;
    placed_structures[placed_structure_count].island_id  = target_island_id;
    placed_structures[placed_structure_count].x          = px;
    placed_structures[placed_structure_count].y          = py;
    placed_structures[placed_structure_count].company_id = (uint8_t)player->company_id;
    placed_structures[placed_structure_count].max_hp     = 100;
    placed_structures[placed_structure_count].hp         = 100;
    placed_structures[placed_structure_count].target_hp  = 100;
    placed_structures[placed_structure_count].placer_id  = player->player_id;
    strncpy(placed_structures[placed_structure_count].placer_name, player->name,
            sizeof(placed_structures[placed_structure_count].placer_name) - 1);
    placed_structures[placed_structure_count].placer_name[
        sizeof(placed_structures[placed_structure_count].placer_name) - 1] = '\0';
    placed_structures[placed_structure_count].open       = false;
    placed_structures[placed_structure_count].rotation   =
        (stype_enum == STRUCT_WOODEN_FLOOR || stype_enum == STRUCT_WORKBENCH ||
         stype_enum == STRUCT_SHIPYARD || stype_enum == STRUCT_CEILING ||
         stype_enum == STRUCT_CANNON) ? place_rotation : 0.0f;
    /* Cannon: initialise aim angle to match the placement rotation so first fire goes the right way.
       The barrel points "up" in local space (−y), which corresponds to rotRad − π/2 in world space. */
    if (stype_enum == STRUCT_CANNON) {
        placed_structures[placed_structure_count].cannon_aim_angle =
            place_rotation * (float)M_PI / 180.0f - (float)(M_PI / 2.0);
        placed_structures[placed_structure_count].cannon_desired_aim_angle =
            placed_structures[placed_structure_count].cannon_aim_angle;
    }
    placed_structure_count++;

    /* ── Post-placement: register claims ─────────────────────────────────── */

    /* Flag Fort: override HP and register the island claim */
    if (stype_enum == STRUCT_FLAG_FORT) {
        /* Flag forts go through 3 phases:
         *   CLAIMING (1 min, claim_flag-style contest) — semi-transparent,
         *     non-damageable, no HP bar. SKIPPED if the placement point lies
         *     inside this company's existing ACTIVE territory on this island
         *     (i.e., within an active flag fort / company fortress radius).
         *   BUILDING (heals 10%→30% HP over 5 min) — damageable, normal HP
         *     bar, flashing claim border on client. Mechanics identical to
         *     previous "first phase".
         *   ACTIVE (≥30% HP) — full territory participation.
         * While CLAIMING or BUILDING a flag fort does NOT push dominance
         * onto enemy territory (it cannot be used as the "mine" source for
         * a claim flag); the client also renders it as its own non-merging
         * blob in the overlay. */
        PlacedStructure *ff = &placed_structures[placed_structure_count - 1];
        ff->max_hp            = 500;
        ff->hp                = (uint16_t)(500 * FLAG_FORT_INITIAL_HP_PCT);
        ff->target_hp         = ff->max_hp; /* heal ceiling; permanently reduced by combat damage */
        ff->fortress_complete = false;
        ff->claim_contested   = false;
        ff->claim_state       = CLAIM_FLAG_STATE_CONTEST;
        ff->claim_grace_ms    = 0.0f;

        /* Detect "placed in already-active friendly territory" — search for
         * any active (non-orphaned, fortress_complete) flag fort or company
         * fortress belonging to the SAME company on the SAME island whose
         * claim radius contains the placement point. */
        bool in_friendly_active = false;
        for (uint32_t qi = 0; qi < placed_structure_count - 1; qi++) {
            PlacedStructure *q = &placed_structures[qi];
            if (!q->active) continue;
            if (q->claim_orphaned) continue;
            if (!q->fortress_complete) continue;
            if (q->company_id != ff->company_id) continue;
            if (q->island_id  != ff->island_id)  continue;
            if (q->type != STRUCT_FLAG_FORT && q->type != STRUCT_COMPANY_FORTRESS) continue;
            float qr = (q->type == STRUCT_COMPANY_FORTRESS) ? CLAIM_RADIUS_COMPANY_FORT : CLAIM_RADIUS_FLAG_FORT;
            float dx = ff->x - q->x, dy = ff->y - q->y;
            if (dx*dx + dy*dy <= qr*qr) { in_friendly_active = true; break; }
        }

        if (in_friendly_active) {
            /* Skip claim phase entirely; jump straight to BUILDING.
             * claim_progress_ms is now the float HP accumulator (see flag_fort_tick). */
            ff->claim_phase       = FLAG_FORT_PHASE_BUILDING;
            ff->claim_progress_ms = (float)ff->hp;
        } else {
            /* Enter CLAIMING phase. claim_progress_ms counts FLAG_FORT_CLAIM_MS → 0
             * (mirrors claim_flag). Transition to BUILDING re-purposes it as the
             * fractional-HP accumulator. */
            ff->claim_phase       = FLAG_FORT_PHASE_CLAIMING;
            ff->claim_progress_ms = (float)FLAG_FORT_CLAIM_MS;
        }

        claim_register_fort((uint8_t)target_island_id,
                            (uint32_t)player->company_id,
                            (uint32_t)new_id,
                            player->player_id);
    }

    /* Company Fortress: start build timer (HP = 1 until complete) */
    if (stype_enum == STRUCT_COMPANY_FORTRESS) {
        placed_structures[placed_structure_count - 1].max_hp            = 1000;
        placed_structures[placed_structure_count - 1].hp                = 1;   /* incomplete */
        placed_structures[placed_structure_count - 1].target_hp         = 1000;
        placed_structures[placed_structure_count - 1].claim_progress_ms = 0.0f;
        placed_structures[placed_structure_count - 1].fortress_complete  = false;
        placed_structures[placed_structure_count - 1].claim_contested    = false;
        log_info("🏰 Player %u started building Company Fortress #%u on island %u",
                 player->player_id, new_id, target_island_id);
    }

    /* Claim Flag: link to (mine, enemy) source structures, start countdown at full */
    if (stype_enum == STRUCT_CLAIM_FLAG) {
        PlacedStructure *cf = &placed_structures[placed_structure_count - 1];
        cf->claim_linked_fort       = cf_src_mine;
        cf->claim_source_enemy      = cf_src_enemy;
        cf->claim_progress_ms       = (float)FLAG_CLAIM_DURATION_MS; /* starts FULL, ticks down to 0 = capture */
        cf->claim_contested         = true;                          /* placed in CONTEST state */
        cf->claim_state             = CLAIM_FLAG_STATE_CONTEST;
        cf->claim_grace_ms          = 0.0f;
        cf->claim_targets_fortress  = false;                         /* legacy field — unused in new flow */
    }

    /* Render-Rule-X: populate dominators for the newcomer.
     * Skipped for claim flags (transient) — their effect is the capture
     * itself, not standing dominance. */
    if (stype_enum != STRUCT_CLAIM_FLAG) {
        claim_register_placement_dominators(new_id);
    }

    log_info("🏗️ Player %u placed %s (id=%u) at (%.1f,%.1f) on island %u",
             player->player_id, stype, new_id, px, py, target_island_id);

    /* Broadcast to all clients */
    char bcast[384];
    bool new_is_door = (stype_enum == STRUCT_DOOR);
    bool new_is_cannon = (stype_enum == STRUCT_CANNON);
    float bcast_rot  = placed_structures[placed_structure_count - 1].rotation;
    char cannon_extra[64] = "";
    if (new_is_cannon) {
        snprintf(cannon_extra, sizeof(cannon_extra),
                 ",\"cannon_aim_angle\":%.4f",
                 placed_structures[placed_structure_count - 1].cannon_aim_angle);
    }
    uint16_t bcast_hp     = placed_structures[placed_structure_count - 1].hp;
    uint16_t bcast_max_hp = placed_structures[placed_structure_count - 1].max_hp;
    uint16_t bcast_target = placed_structures[placed_structure_count - 1].target_hp;
    /* Flag-fort phase initial broadcast (claim/build/active). Other types: 0. */
    uint8_t bcast_phase = (stype_enum == STRUCT_FLAG_FORT)
        ? placed_structures[placed_structure_count - 1].claim_phase : 0u;
    char phase_extra[48] = "";
    if (stype_enum == STRUCT_FLAG_FORT) {
        snprintf(phase_extra, sizeof(phase_extra), ",\"claim_phase\":%u", (unsigned)bcast_phase);
    }
    snprintf(bcast, sizeof(bcast),
             "{\"type\":\"structure_placed\",\"id\":%u,\"structure_type\":\"%s\","
             "\"island_id\":%u,\"x\":%.1f,\"y\":%.1f,"
             "\"company_id\":%u,\"hp\":%u,\"max_hp\":%u,\"target_hp\":%u,\"placer_name\":\"%s\""
             ",\"rotation\":%.2f%s%s%s}",
             new_id, stype, target_island_id, px, py,
             (unsigned)player->company_id, (unsigned)bcast_hp, (unsigned)bcast_max_hp,
             (unsigned)bcast_target, player->name,
             bcast_rot,
             new_is_door ? ",\"open\":false" : "",
             cannon_extra,
             phase_extra);
    websocket_server_broadcast(bcast);
    return; /* already sent via broadcast */

ps_send:;
    /* Log any failure for debugging */
    {
        const char *reason_key = "\"reason\":\"";
        const char *rp = strstr(response, reason_key);
        if (rp) {
            rp += strlen(reason_key);
            char reason_buf[64] = {0};
            int ri = 0;
            while (ri < 63 && rp[ri] && rp[ri] != '"') { reason_buf[ri] = rp[ri]; ri++; }
            log_debug("place_structure FAIL player=%u name='%s' pos=(%.1f,%.1f) reason=%s",
                      player->player_id, player->name, px, py, reason_buf);
        }
    }
    char frame[512];
    size_t flen = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (flen > 0 && flen < sizeof(frame)) send(client->fd, frame, flen, 0);
}

/*
 * structure_interact: player presses E near a placed structure.
 * Only workbenches currently do anything (open crafting UI).
 */
void handle_structure_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[256];

    /* Parse structure_id first — needed for the wreck path which works at sea */
    uint32_t sid = 0;
    {
        char* sp = strstr(payload, "\"structure_id\":");
        if (sp) sscanf(sp + 15, "%u", &sid);
    }

    /* ── Wreck salvage (works anywhere in the sea, not island-gated) ─────── */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *w = &placed_structures[i];
        if (!w->active || w->type != STRUCT_WRECK || w->id != sid) continue;

        /* Range check — must be within 400 client units to salvage */
        float dx = player->x - w->x;
        float dy = player->y - w->y;
        if (dx*dx + dy*dy > 400.0f * 400.0f) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"too_far\"}");
            goto si_send;
        }

        if (w->wreck_loot_count == 0) {
            /* Empty wreck — remove it */
            w->active = false;
            char bcast[64];
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"wreck_removed\",\"id\":%u}", (unsigned)w->id);
            websocket_server_broadcast(bcast);
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"empty\"}");
            goto si_send;
        }

        /* Find the first non-empty loot slot */
        int slot = -1;
        for (int li = 0; li < 6; li++) {
            if (w->wreck_items[li] != 0 && w->wreck_qtys[li] > 0) {
                slot = li;
                break;
            }
        }
        if (slot < 0) {
            w->wreck_loot_count = 0;
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"empty\"}");
            goto si_send;
        }

        ItemKind item = (ItemKind)w->wreck_items[slot];
        uint8_t  qty  = w->wreck_qtys[slot];

        if (!craft_grant(player, item, (int)qty)) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"inventory_full\"}");
            goto si_send;
        }

        /* Consume the loot slot */
        w->wreck_items[slot] = 0;
        w->wreck_qtys[slot]  = 0;
        w->wreck_loot_count--;
        w->hp = w->wreck_loot_count;

        log_info("🪵 Player %u salvaged item %u x%u from wreck %u (%u slots remain)",
                 player->player_id, (unsigned)item, (unsigned)qty,
                 (unsigned)w->id, (unsigned)w->wreck_loot_count);

        /* Broadcast wreck state update */
        char bcast[96];
        if (w->wreck_loot_count == 0) {
            w->active = false;
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"wreck_removed\",\"id\":%u}", (unsigned)w->id);
        } else {
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"wreck_updated\",\"id\":%u,\"loot_count\":%u}",
                     (unsigned)w->id, (unsigned)w->wreck_loot_count);
        }
        websocket_server_broadcast(bcast);

        snprintf(response, sizeof(response),
                 "{\"type\":\"salvage_success\",\"item\":%u,\"quantity\":%u,"
                 "\"wreck_id\":%u,\"remaining\":%u}",
                 (unsigned)item, (unsigned)qty,
                 (unsigned)w->id, (unsigned)w->wreck_loot_count);
        goto si_send;
    }

    /* ── Island-gated structures ─────────────────────────────────────────── */
    if (player->on_island_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"structure_interact_fail\",\"reason\":\"not_on_island\"}");
        goto si_send;
    }

    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (!placed_structures[i].active || placed_structures[i].id != sid) continue;
        float dx = player->x - placed_structures[i].x;
        float dy = player->y - placed_structures[i].y;
        float max_ir = (placed_structures[i].type == STRUCT_SHIPYARD)
                       ? SHIPYARD_INTERACT_R : STRUCT_INTERACT_R;
        if (dx*dx + dy*dy > max_ir * max_ir) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"structure_interact_fail\",\"reason\":\"too_far\"}");
            goto si_send;
        }
        if (placed_structures[i].type == STRUCT_WORKBENCH) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"crafting_open\",\"structure_id\":%u,\"structure_type\":\"workbench\"}",
                     sid);
            goto si_send;
        }
        if (placed_structures[i].type == STRUCT_SHIPYARD) {
            const char* phase_str = placed_structures[i].construction_phase == CONSTRUCTION_BUILDING
                                    ? "building" : "empty";
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_state\",\"structure_id\":%u,"
                     "\"phase\":\"%s\",\"modules_placed\":[],"
                     "\"scaffolded_ship_id\":%u}",
                     sid, phase_str, placed_structures[i].scaffolded_ship_id);
            goto si_send;
        }
        if (placed_structures[i].type == STRUCT_DOOR) {
            /* Toggle door open/closed and broadcast to all clients */
            placed_structures[i].open = !placed_structures[i].open;
            char bcast[128];
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"door_toggled\",\"id\":%u,\"open\":%s}",
                     sid, placed_structures[i].open ? "true" : "false");
            websocket_server_broadcast(bcast);
            return; /* broadcast sent, no per-client response needed */
        }
        if (placed_structures[i].type == STRUCT_CANNON) {
            /* Company check: must be same company or neutral */
            if (placed_structures[i].company_id != 0 &&
                player->company_id != 0 &&
                placed_structures[i].company_id != player->company_id) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"structure_interact_fail\",\"reason\":\"wrong_company\"}");
                goto si_send;
            }
            /* Occupancy check: another player is already on this cannon */
            if (placed_structures[i].cannon_mounted_player_id != 0 &&
                placed_structures[i].cannon_mounted_player_id != player->player_id) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"structure_interact_fail\",\"reason\":\"occupied\"}");
                goto si_send;
            }
            /* Mount the player to the cannon */
            placed_structures[i].cannon_mounted_player_id = player->player_id;
            player->is_mounted = true;
            player->mounted_cannon_structure_id = placed_structures[i].id;
            /* Position player behind the cannon base (opposite the barrel).
               Use the fixed placement rotation so the mount point is always at the
               back of the cannon carriage regardless of current aim angle.
               The barrel points in direction (rotRad - π/2), so the back is +π/2
               from rotRad: back_dir = (-sin(rotRad), cos(rotRad)). */
            float _mount_x, _mount_y;
            {
                const float MOUNT_DIST = 30.0f;
                float rot_rad = placed_structures[i].rotation * (float)M_PI / 180.0f;
                /* back of cannon = opposite of barrel direction = rotRad + π/2 offset */
                _mount_x = placed_structures[i].x + (-sinf(rot_rad)) * MOUNT_DIST;
                _mount_y = placed_structures[i].y + ( cosf(rot_rad)) * MOUNT_DIST;
                player->x = _mount_x;
                player->y = _mount_y;
            }
            log_info("🎯 Player %u mounted to island cannon %u at (%.1f,%.1f)",
                     player->player_id, placed_structures[i].id, _mount_x, _mount_y);
            /* Broadcast mount event */
            {
                char bcast[160];
                snprintf(bcast, sizeof(bcast),
                         "{\"type\":\"player_mounted\",\"player_id\":%u,"
                         "\"structure_id\":%u,\"is_island_cannon\":true}",
                         player->player_id, placed_structures[i].id);
                websocket_server_broadcast(bcast);
            }
            snprintf(response, sizeof(response),
                     "{\"type\":\"island_cannon_mounted\",\"structure_id\":%u,"
                     "\"aim_angle\":%.4f,\"reload_ms\":%u,"
                     "\"mount_x\":%.2f,\"mount_y\":%.2f,"
                     "\"rotation\":%.4f}",
                     placed_structures[i].id,
                     placed_structures[i].cannon_aim_angle,
                     placed_structures[i].cannon_reload_ms,
                     _mount_x, _mount_y,
                     placed_structures[i].rotation * (float)M_PI / 180.0f);
            goto si_send;
        }
        snprintf(response, sizeof(response),
                 "{\"type\":\"structure_interact_fail\",\"reason\":\"not_interactive\"}");
        goto si_send;
    }

    /* DIAG: dump active structures for the requested id */
    {
        log_info("⚒ [DIAG] structure_interact not_found: sid=%u player=%u on_island=%u count=%u",
                 sid, player->player_id, player->on_island_id, placed_structure_count);
        unsigned shown = 0;
        for (uint32_t i = 0; i < placed_structure_count && shown < 12; i++) {
            log_info("    [%u] id=%u type=%u active=%d x=%.0f y=%.0f island=%u",
                     i, placed_structures[i].id, placed_structures[i].type,
                     placed_structures[i].active ? 1 : 0,
                     placed_structures[i].x, placed_structures[i].y,
                     placed_structures[i].island_id);
            shown++;
        }
    }
    snprintf(response, sizeof(response),
             "{\"type\":\"structure_interact_fail\",\"reason\":\"not_found\"}");

si_send:;
    char frame[512];
    size_t flen = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
    if (flen > 0 && flen < sizeof(frame)) send(client->fd, frame, flen, 0);
}

/* ── Helper: build shipyard_state JSON into buf (caller provides space) ── */
static void build_shipyard_state_json(char* buf, size_t bufsz,
                                      const PlacedStructure* sy,
                                      uint32_t ship_spawned) {
    const char* phase_str = sy->construction_phase == CONSTRUCTION_BUILDING ? "building" : "empty";
    if (ship_spawned) {
        snprintf(buf, bufsz,
                 "{\"type\":\"shipyard_state\",\"structure_id\":%u,"
                 "\"phase\":\"%s\",\"modules_placed\":[],"
                 "\"ship_spawned\":%u,\"scaffolded_ship_id\":%u}",
                 sy->id, phase_str, ship_spawned, sy->scaffolded_ship_id);
    } else {
        snprintf(buf, bufsz,
                 "{\"type\":\"shipyard_state\",\"structure_id\":%u,"
                 "\"phase\":\"%s\",\"modules_placed\":[],"
                 "\"scaffolded_ship_id\":%u}",
                 sy->id, phase_str, sy->scaffolded_ship_id);
    }
}

/*
 * shipyard_action: player interacts with shipyard construction system.
 * Actions: "craft_skeleton", "add_module" (with "module" field), "release_ship".
 */
void handle_shipyard_action(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[512];

    /* Parse fields */
    uint32_t sid = 0;
    char action[32]  = "";
    char module[32]  = "";
    const char* f;
    if ((f = strstr(payload, "\"shipyard_id\":"))) sscanf(f + 14, "%u", &sid);
    if ((f = strstr(payload, "\"action\":\""))) {
        f += 10; int n = 0;
        while (f[n] && f[n] != '"' && n < 31) { action[n] = f[n]; n++; } action[n] = 0;
    }
    if ((f = strstr(payload, "\"module\":\""))) {
        f += 10; int n = 0;
        while (f[n] && f[n] != '"' && n < 31) { module[n] = f[n]; n++; } module[n] = 0;
    }

    /* Find shipyard */
    PlacedStructure* sy = NULL;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].active && placed_structures[i].id == sid
            && placed_structures[i].type == STRUCT_SHIPYARD) {
            sy = &placed_structures[i]; break;
        }
    }
    if (!sy) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"shipyard_action_fail\",\"reason\":\"not_found\"}");
        goto sya_send;
    }
    /* Distance check (generous radius for large structure) */
    {
        float ddx = player->x - sy->x, ddy = player->y - sy->y;
        if (ddx*ddx + ddy*ddy > SHIPYARD_INTERACT_R * SHIPYARD_INTERACT_R) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_action_fail\",\"reason\":\"too_far\"}");
            goto sya_send;
        }
    }

    if (strcmp(action, "craft_skeleton") == 0) {
        /* ── Lay keel: 20 Wood + 10 Fiber ── spawns a REAL empty ship ── */
        if (sy->construction_phase != CONSTRUCTION_EMPTY) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_action_fail\",\"reason\":\"already_building\"}");
            goto sya_send;
        }
        /* Count totals (may span multiple slots) */
        if (craft_count_item(player, ITEM_WOOD) < 20 || craft_count_item(player, ITEM_FIBER) < 10) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_action_fail\",\"reason\":\"missing_materials\"}");
            goto sya_send;
        }
        /* Consume */
        craft_consume(player, ITEM_WOOD, 20);
        craft_consume(player, ITEM_FIBER, 10);
        /* Spawn a real empty ship (modules_placed = 0 → bare hull only) */
        uint16_t new_ship_id = websocket_server_create_ship(sy->x, sy->y + 450.0f, player->company_id, 0);
        if (new_ship_id == 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_action_fail\",\"reason\":\"ship_limit\"}");
            goto sya_send;
        }
        /* Set SHIP_FLAG_SCAFFOLDED on the sim ship to prevent sinking */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id == new_ship_id) {
                    global_sim->ships[si].flags |= SHIP_FLAG_SCAFFOLDED;
                    break;
                }
            }
        }
        sy->construction_phase   = CONSTRUCTION_BUILDING;
        sy->construction_company = player->company_id;
        sy->scaffolded_ship_id   = new_ship_id;
        log_info("⚓ Shipyard %u: skeleton spawned as ship %u", sid, new_ship_id);

    } else if (strcmp(action, "add_module") == 0) {
        /* add_module is no longer handled by the dock — modules are placed
         * directly on the ship using the ship's own build mode. */
        snprintf(response, sizeof(response),
                 "{\"type\":\"shipyard_action_fail\",\"reason\":\"use_build_mode\"}");
        goto sya_send;

    } else if (strcmp(action, "release_ship") == 0) {
        /* ── Release the ship from scaffolding ──────────────────────────── */
        if (sy->construction_phase != CONSTRUCTION_BUILDING || sy->scaffolded_ship_id == 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_action_fail\",\"reason\":\"no_ship\"}");
            goto sya_send;
        }
        uint32_t released_id = sy->scaffolded_ship_id;
        /* Clear SHIP_FLAG_SCAFFOLDED and set initial_plank_count = 10 */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id == released_id) {
                    global_sim->ships[si].flags &= (uint16_t)~SHIP_FLAG_SCAFFOLDED;
                    global_sim->ships[si].initial_plank_count = 10;
                    break;
                }
            }
        }
        sy->construction_phase  = CONSTRUCTION_EMPTY;
        sy->modules_placed      = 0;
        sy->scaffolded_ship_id  = 0;
        char bcast[512];
        build_shipyard_state_json(bcast, sizeof(bcast), sy, released_id);
        websocket_server_broadcast(bcast);
        log_info("⚓ Shipyard %u: released ship %u", sid, released_id);
        return; /* broadcast sent */

    } else {
        snprintf(response, sizeof(response),
                 "{\"type\":\"shipyard_action_fail\",\"reason\":\"unknown_action\"}");
        goto sya_send;
    }

    /* Broadcast updated state to all clients */
    {
        char bcast[512];
        build_shipyard_state_json(bcast, sizeof(bcast), sy, 0);
        websocket_server_broadcast(bcast);
    }
    return;

sya_send:;
    {
        char frame[600];
        size_t flen = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response),
                                             frame, sizeof(frame));
        if (flen > 0 && flen < sizeof(frame)) send(client->fd, frame, flen, 0);
    }
}

/*
 * destroy_placed_structure — shared destruction helper.
 *
 * 1. Finds the structure by ID, marks it inactive, broadcasts structure_demolished.
 * 2. If it was a floor, cascade-destroys dependent workbenches, walls, door_frames,
 *    ceilings, and doors (using active=false + broadcast for each).
 * 3. If it was a door_frame, cascade-destroys any door sitting on it.
 * 4. Compacts inactive entries from placed_structures[] in one final pass so the
 *    array stays dense and placed_structure_count stays accurate.
 *
 * Safe to call from any code path (demolish, cannon hit, etc.).
 */
void destroy_placed_structure(uint32_t structure_id) {
    /* Find the target */
    uint32_t idx = UINT32_MAX;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (placed_structures[i].active && placed_structures[i].id == structure_id) {
            idx = i; break;
        }
    }
    if (idx == UINT32_MAX) return; /* not found */

    PlacedStructureType dtype = placed_structures[idx].type;
    float fx = placed_structures[idx].x;
    float fy = placed_structures[idx].y;

    /* Mark primary dead and broadcast */
    placed_structures[idx].active = false;
    char msg[192];
    snprintf(msg, sizeof(msg),
             "{\"type\":\"structure_demolished\",\"structure_id\":%u}", structure_id);
    websocket_server_broadcast(msg);
    log_info("🔨 Destroyed structure %u (type %d)", structure_id, (int)dtype);

    /* ── Territory claim: fort/company-fortress destroyed → drop island claim ─ */
    if (dtype == STRUCT_FLAG_FORT) {
        claim_on_fort_destroyed(structure_id);
    }
    if (dtype == STRUCT_COMPANY_FORTRESS) {
        claim_on_fort_destroyed(structure_id);  /* same handler — drops IslandClaim if one exists */
    }

    /* ── Cascade: floor destroyed ──────────────────────────────────────── */
    if (dtype == STRUCT_WOODEN_FLOOR) {
        for (uint32_t ci = 0; ci < placed_structure_count; ci++) {
            PlacedStructure* c = &placed_structures[ci];
            if (!c->active) continue;

            if (c->type == STRUCT_WORKBENCH) {
                if (fabsf(c->x - fx) > 25.0f || fabsf(c->y - fy) > 25.0f) continue;
                /* Any other active floor still supporting this workbench? */
                bool has = false;
                for (uint32_t fi = 0; fi < placed_structure_count && !has; fi++) {
                    PlacedStructure* f = &placed_structures[fi];
                    if (!f->active || f->type != STRUCT_WOODEN_FLOOR) continue;
                    if (fabsf(c->x - f->x) <= 25.0f && fabsf(c->y - f->y) <= 25.0f) has = true;
                }
                if (!has) {
                    c->active = false;
                    char cm[128];
                    snprintf(cm, sizeof(cm),
                             "{\"type\":\"structure_demolished\",\"structure_id\":%u}", c->id);
                    websocket_server_broadcast(cm);
                    log_info("🔨 Cascade-demolished workbench %u (floor %u removed)", c->id, structure_id);
                }

            } else if (c->type == STRUCT_WALL || c->type == STRUCT_DOOR_FRAME ||
                       c->type == STRUCT_DOOR) {
                /* Is this wall/door adjacent to the demolished floor? */
                float at_dx = c->x - fx, at_dy = c->y - fy;
                if (at_dx*at_dx + at_dy*at_dy > 30.0f * 30.0f) continue;
                bool has = wall_has_support(c->x, c->y);
                if (!has) {
                    bool was_frame = (c->type == STRUCT_DOOR_FRAME);
                    float dfx = c->x, dfy = c->y;
                    c->active = false;
                    char cm[128];
                    snprintf(cm, sizeof(cm),
                             "{\"type\":\"structure_demolished\",\"structure_id\":%u}", c->id);
                    websocket_server_broadcast(cm);
                    log_info("🔨 Cascade-demolished wall/frame/door %u (floor %u removed)", c->id, structure_id);
                    /* door_frame lost: cascade any door on it */
                    if (was_frame) {
                        for (uint32_t di = 0; di < placed_structure_count; di++) {
                            PlacedStructure* dp = &placed_structures[di];
                            if (!dp->active || dp->type != STRUCT_DOOR) continue;
                            if (fabsf(dp->x - dfx) >= 3.0f || fabsf(dp->y - dfy) >= 3.0f) continue;
                            dp->active = false;
                            char dm[128];
                            snprintf(dm, sizeof(dm),
                                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", dp->id);
                            websocket_server_broadcast(dm);
                            break;
                        }
                    }
                }

            } else if (c->type == STRUCT_CANNON) {
                /* Cannon requires a same-company floor tile within its footprint.
                 * Check using the same OBB test as place_cannon. */
                const float HALF_TILE = 25.0f;
                bool has_floor = false;
                for (uint32_t fi = 0; fi < placed_structure_count && !has_floor; fi++) {
                    PlacedStructure* f = &placed_structures[fi];
                    if (!f->active || f->type != STRUCT_WOODEN_FLOOR) continue;
                    if (f->company_id != c->company_id) continue;
                    float rad = f->rotation * (float)M_PI / 180.0f;
                    float fc  = cosf(-rad), fs = sinf(-rad);
                    float ddx = c->x - f->x;
                    float ddy = c->y - f->y;
                    float lx  = ddx * fc - ddy * fs;
                    float ly  = ddx * fs + ddy * fc;
                    if (fabsf(lx) <= HALF_TILE && fabsf(ly) <= HALF_TILE) has_floor = true;
                }
                if (!has_floor) {
                    c->active = false;
                    char cm[128];
                    snprintf(cm, sizeof(cm),
                             "{\"type\":\"structure_demolished\",\"structure_id\":%u}", c->id);
                    websocket_server_broadcast(cm);
                    log_info("🔨 Cascade-demolished cannon %u (floor %u removed)", c->id, structure_id);
                }

            }
            /* Note: ceilings handled below by cascade_orphan_ceilings() — the
             * strict wall-connectivity rule supersedes any floor-proximity check. */
        }
    }

    /* ── Cascade: door_frame destroyed ────────────────────────────────── */
    if (dtype == STRUCT_DOOR_FRAME) {
        for (uint32_t di = 0; di < placed_structure_count; di++) {
            PlacedStructure* dp = &placed_structures[di];
            if (!dp->active || dp->type != STRUCT_DOOR) continue;
            if (fabsf(dp->x - fx) >= 3.0f || fabsf(dp->y - fy) >= 3.0f) continue;
            dp->active = false;
            char dm[128];
            snprintf(dm, sizeof(dm),
                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", dp->id);
            websocket_server_broadcast(dm);
            break;
        }
    }

    /* ── Cascade: any wall/door_frame loss may orphan ceilings ──────────────
     * Fires for direct wall/door_frame demolish AND for floor demolish (since
     * the floor-cascade above may have just removed walls without re-checking
     * ceilings). cascade_orphan_ceilings() rebuilds the wall map from current
     * active state, so it's safe and idempotent. */
    if (dtype == STRUCT_WALL || dtype == STRUCT_DOOR_FRAME ||
        dtype == STRUCT_WOODEN_FLOOR) {
        const char *kind = dtype == STRUCT_WALL       ? "wall"
                         : dtype == STRUCT_DOOR_FRAME ? "door_frame"
                                                      : "floor";
        cascade_orphan_ceilings(structure_id, kind);
    }

    /* ── Compact inactive entries out of the array in one pass ─────────── */
    uint32_t write = 0;
    for (uint32_t read = 0; read < placed_structure_count; read++) {
        if (placed_structures[read].active)
            placed_structures[write++] = placed_structures[read];
    }
    placed_structure_count = write;
}

/*
 * apply_structure_damage — shared hit-damage helper.
 * Subtracts dmg from s->hp, broadcasts structure_hp_changed on partial damage,
 * and delegates to destroy_placed_structure on death.
 * Returns true if the structure was destroyed (s is then stale).
 */
bool apply_structure_damage(PlacedStructure *s, uint16_t dmg) {
    /* Claim flags are immune to damage — they only "die" by completing/reversing
     * their territory-claim timer (handled in claim.c). */
    if (s->type == STRUCT_CLAIM_FLAG) return false;
    /* Flag forts are non-damageable during the CLAIMING phase — they only
     * become vulnerable once the 1-min ground claim succeeds and they enter
     * BUILDING. */
    if (s->type == STRUCT_FLAG_FORT && s->claim_phase == FLAG_FORT_PHASE_CLAIMING) return false;
    s->hp = (s->hp > dmg) ? (uint16_t)(s->hp - dmg) : 0u;
    /* All structures track a heal ceiling that combat damage permanently
     * lowers. For most types there is no auto-repair (so target_hp just
     * mirrors hp), but flag forts use it to cap their heal-back. */
    s->target_hp = (s->target_hp > dmg) ? (uint16_t)(s->target_hp - dmg) : 0u;
    /* Stamp the damage time so player-funded repairs can enforce a cooldown
     * (no repairing structures that took combat damage in the last 30s). */
    s->last_damaged_ms = get_time_ms();
    if (s->hp == 0) {
        uint32_t sid = s->id;
        destroy_placed_structure(sid);
        return true;
    }
    char msg[224];
    snprintf(msg, sizeof(msg),
             "{\"type\":\"structure_hp_changed\","
             "\"structure_id\":%u,\"hp\":%u,\"max_hp\":%u,\"target_hp\":%u"
             ",\"x\":%.1f,\"y\":%.1f}",
             s->id, (unsigned)s->hp, (unsigned)s->max_hp, (unsigned)s->target_hp, s->x, s->y);
    websocket_server_broadcast(msg);
    return false;
}

/*
 * demolish_structure: player holds E on a placed structure to remove it.
 * Validates proximity, then removes from placed_structures[] and broadcasts.
 */
void handle_demolish_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[256];

    uint32_t sid = 0;
    const char* sp = strstr(payload, "\"structure_id\":");
    if (sp) sscanf(sp + 15, "%u", &sid);

    for (uint32_t i = 0; i < placed_structure_count; i++) {
        if (!placed_structures[i].active || placed_structures[i].id != sid) continue;
        float dx = player->x - placed_structures[i].x;
        float dy = player->y - placed_structures[i].y;
        if (dx*dx + dy*dy > STRUCT_INTERACT_R * STRUCT_INTERACT_R) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"demolish_fail\",\"reason\":\"too_far\"}");
            goto ds_send;
        }
        /* Only the owner's company may demolish their own structures */
        if (placed_structures[i].company_id != (uint8_t)player->company_id) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"demolish_fail\",\"reason\":\"wrong_company\"}");
            goto ds_send;
        }
        /* Shipyard: auto-release any scaffolded ship before demolishing */
        if (placed_structures[i].type == STRUCT_SHIPYARD
            && placed_structures[i].construction_phase == CONSTRUCTION_BUILDING
            && placed_structures[i].scaffolded_ship_id != 0) {
            uint32_t rel_id = placed_structures[i].scaffolded_ship_id;
            if (global_sim) {
                for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                    if (global_sim->ships[si].id == rel_id) {
                        global_sim->ships[si].flags &= (uint16_t)~SHIP_FLAG_SCAFFOLDED;
                        global_sim->ships[si].initial_plank_count = 10;
                        break;
                    }
                }
            }
            char abcast[256];
            snprintf(abcast, sizeof(abcast),
                     "{\"type\":\"ship_auto_released\",\"ship_id\":%u}", rel_id);
            websocket_server_broadcast(abcast);
            log_info("⚓ Shipyard %u demolished — auto-released ship %u", sid, rel_id);
            placed_structures[i].construction_phase  = CONSTRUCTION_EMPTY;
            placed_structures[i].modules_placed      = 0;
            placed_structures[i].scaffolded_ship_id  = 0;
        }
        log_info("🔨 Player %u demolished structure %u", player->player_id, sid);
        destroy_placed_structure(sid);
        return; /* already sent via broadcast */
    }

    snprintf(response, sizeof(response),
             "{\"type\":\"demolish_fail\",\"reason\":\"not_found\"}");

ds_send:;
    char ds_frame[256];
    size_t ds_flen = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), ds_frame, sizeof(ds_frame));
    if (ds_flen > 0 && ds_flen < sizeof(ds_frame)) send(client->fd, ds_frame, ds_flen, 0);
}

/*
 * demolish_module: player presses E while holding axe on a ship module.
 * Validates proximity and company, then removes the module from both the
 * SimpleShip layout and the physics sim, and broadcasts the removal.
 */
void handle_demolish_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    uint32_t ship_id   = 0;
    uint32_t module_id = 0;
    const char* sp = strstr(payload, "\"shipId\":");
    if (sp) sscanf(sp + 9, "%u", &ship_id);
    const char* mp = strstr(payload, "\"moduleId\":");
    if (mp) sscanf(mp + 11, "%u", &module_id);

    char response[256];

    if (ship_id == 0 || module_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"demolish_fail\",\"reason\":\"missing_ids\"}");
        goto dm_send;
    }

    /* Player must be aboard the target ship */
    if (player->parent_ship_id != (uint16_t)ship_id) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"demolish_fail\",\"reason\":\"not_on_ship\"}");
        goto dm_send;
    }

    {
        SimpleShip* ship = find_ship((uint16_t)ship_id);
        if (!ship || !ship->active) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"demolish_fail\",\"reason\":\"ship_not_found\"}");
            goto dm_send;
        }

        /* Company check: only same-company members may demolish */
        if (ship->company_id != 0 && ship->company_id != (uint8_t)player->company_id) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"demolish_fail\",\"reason\":\"wrong_company\"}");
            goto dm_send;
        }

        /* Find the module */
        int mod_idx = -1;
        for (int i = 0; i < (int)ship->module_count; i++) {
            if (ship->modules[i].id == (uint16_t)module_id) {
                mod_idx = i;
                break;
            }
        }
        if (mod_idx < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"demolish_fail\",\"reason\":\"module_not_found\"}");
            goto dm_send;
        }

        ShipModule* mod = &ship->modules[mod_idx];

        /* Planks use the placement/repair system — not demolishable here */
        if (mod->type_id == MODULE_TYPE_PLANK) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"demolish_fail\",\"reason\":\"cant_demolish_planks\"}");
            goto dm_send;
        }

        /* Range check: compare player local coords (client-px) to module local pos */
        {
            const float DEMOLISH_RANGE_PX = 120.0f;
            float mod_lx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
            float mod_ly = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
            float dx = player->local_x - mod_lx;
            float dy = player->local_y - mod_ly;
            if (dx * dx + dy * dy > DEMOLISH_RANGE_PX * DEMOLISH_RANGE_PX) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"demolish_fail\",\"reason\":\"too_far\"}");
                goto dm_send;
            }
        }

        /* Dismount anyone occupying this module */
        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
            if (!players[pi].active) continue;
            if (players[pi].is_mounted &&
                players[pi].mounted_module_id == (module_id_t)module_id) {
                players[pi].is_mounted          = false;
                players[pi].mounted_module_id   = 0;
                players[pi].controlling_ship_id = 0;
            }
        }

        log_info("🪓 Player %u demolished module %u (type %u) on ship %u",
                 player->player_id, module_id, (unsigned)mod->type_id, ship_id);

        /* Remove from SimpleShip */
        memmove(&ship->modules[mod_idx],
                &ship->modules[mod_idx + 1],
                ((size_t)ship->module_count - (size_t)mod_idx - 1) * sizeof(ShipModule));
        ship->module_count--;

        /* Remove from global_sim counterpart */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id != (entity_id)ship_id) continue;
                struct Ship* sim_ship = &global_sim->ships[si];
                for (int mi = 0; mi < (int)sim_ship->module_count; mi++) {
                    if (sim_ship->modules[mi].id != (uint16_t)module_id) continue;
                    memmove(&sim_ship->modules[mi],
                            &sim_ship->modules[mi + 1],
                            ((size_t)sim_ship->module_count - (size_t)mi - 1) * sizeof(ShipModule));
                    sim_ship->module_count--;
                    break;
                }
                break;
            }
        }

        /* Broadcast removal to all clients */
        {
            char bcast[128];
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"module_demolished\",\"shipId\":%u,\"moduleId\":%u}",
                     ship_id, module_id);
            websocket_server_broadcast(bcast);
        }
        return; /* already broadcast */
    }

dm_send:;
    char dm_frame[256];
    size_t dm_flen = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), dm_frame, sizeof(dm_frame));
    if (dm_flen > 0 && dm_flen < sizeof(dm_frame))
        send(client->fd, dm_frame, dm_flen, 0);
}

/* ── Salvage a ship module for loot ──────────────────────────────────────────
 * Player must be aboard the ship (no range check — opened via menu).
 * Same-company or unclaimed ship only.
 * Planks and decks cannot be salvaged here.
 * Grants loot based on module type, removes module, broadcasts module_demolished.
 */
void handle_salvage_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    uint32_t ship_id   = 0;
    uint32_t module_id = 0;
    const char* sp = strstr(payload, "\"shipId\":");
    if (sp) sscanf(sp + 9, "%u", &ship_id);
    const char* mp = strstr(payload, "\"moduleId\":");
    if (mp) sscanf(mp + 11, "%u", &module_id);

    char response[256];

    if (ship_id == 0 || module_id == 0) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"salvage_fail\",\"reason\":\"missing_ids\"}");
        goto sv_send;
    }

    /* Player must be aboard the target ship */
    if (player->parent_ship_id != (uint16_t)ship_id) {
        snprintf(response, sizeof(response),
                 "{\"type\":\"salvage_fail\",\"reason\":\"not_on_ship\"}");
        goto sv_send;
    }

    {
        SimpleShip* ship = find_ship((uint16_t)ship_id);
        if (!ship || !ship->active) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"ship_not_found\"}");
            goto sv_send;
        }

        /* Company check: only same-company members (or unclaimed ship) may salvage */
        if (ship->company_id != 0 && ship->company_id != (uint8_t)player->company_id) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"wrong_company\"}");
            goto sv_send;
        }

        /* Find the module */
        int mod_idx = -1;
        for (int i = 0; i < (int)ship->module_count; i++) {
            if (ship->modules[i].id == (uint16_t)module_id) {
                mod_idx = i;
                break;
            }
        }
        if (mod_idx < 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"module_not_found\"}");
            goto sv_send;
        }

        ShipModule* mod = &ship->modules[mod_idx];

        /* Planks and decks use the placement/repair system — not salvageable */
        if (mod->type_id == MODULE_TYPE_PLANK || mod->type_id == MODULE_TYPE_DECK) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"salvage_fail\",\"reason\":\"cant_salvage_planks\"}");
            goto sv_send;
        }

        /* Loot table: item kind and quantity by module type */
        ItemKind loot_item = ITEM_PLANK;
        int      loot_qty  = 1;
        switch (mod->type_id) {
            case MODULE_TYPE_HELM:
            case MODULE_TYPE_STEERING_WHEEL: loot_item = ITEM_HELM;   loot_qty = 1; break;
            case MODULE_TYPE_CANNON:         loot_item = ITEM_CANNON; loot_qty = 1; break;
            case MODULE_TYPE_MAST:           loot_item = ITEM_SAIL;   loot_qty = 1; break;
            case MODULE_TYPE_SWIVEL:         loot_item = ITEM_SWIVEL; loot_qty = 1; break;
            case MODULE_TYPE_LADDER:         loot_item = ITEM_PLANK;  loot_qty = 2; break;
            case MODULE_TYPE_SEAT:           loot_item = ITEM_PLANK;  loot_qty = 1; break;
            default:                         loot_item = ITEM_PLANK;  loot_qty = 1; break;
        }

        /* Dismount anyone occupying this module */
        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
            if (!players[pi].active) continue;
            if (players[pi].is_mounted &&
                players[pi].mounted_module_id == (module_id_t)module_id) {
                players[pi].is_mounted          = false;
                players[pi].mounted_module_id   = 0;
                players[pi].controlling_ship_id = 0;
            }
        }

        /* Grant loot — ignore inventory-full for now, item is lost silently */
        craft_grant(player, loot_item, loot_qty);

        log_info("🪓 Player %u salvaged module %u (type %u) on ship %u — loot item %u x%d",
                 player->player_id, module_id, (unsigned)mod->type_id, ship_id,
                 (unsigned)loot_item, loot_qty);

        /* Remove from SimpleShip */
        memmove(&ship->modules[mod_idx],
                &ship->modules[mod_idx + 1],
                ((size_t)ship->module_count - (size_t)mod_idx - 1) * sizeof(ShipModule));
        ship->module_count--;

        /* Remove from global_sim counterpart */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id != (entity_id)ship_id) continue;
                struct Ship* sim_ship = &global_sim->ships[si];
                for (int mi = 0; mi < (int)sim_ship->module_count; mi++) {
                    if (sim_ship->modules[mi].id != (uint16_t)module_id) continue;
                    memmove(&sim_ship->modules[mi],
                            &sim_ship->modules[mi + 1],
                            ((size_t)sim_ship->module_count - (size_t)mi - 1) * sizeof(ShipModule));
                    sim_ship->module_count--;
                    break;
                }
                break;
            }
        }

        /* Broadcast removal to all clients (reuse module_demolished message) */
        {
            char bcast[128];
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"module_demolished\",\"shipId\":%u,\"moduleId\":%u}",
                     ship_id, module_id);
            websocket_server_broadcast(bcast);
        }

        /* Send salvage success response to the requesting client */
        snprintf(response, sizeof(response),
                 "{\"type\":\"salvage_success\",\"moduleId\":%u,\"item\":%u,\"quantity\":%d}",
                 module_id, (unsigned)loot_item, loot_qty);
    }

sv_send:;
    char sv_frame[256];
    size_t sv_flen = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), sv_frame, sizeof(sv_frame));
    if (sv_flen > 0 && sv_flen < sizeof(sv_frame))
        send(client->fd, sv_frame, sv_flen, 0);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Repair system (any structure with target_hp < max_hp)
 * ────────────────────────────────────────────────────────────────────────────
 * Full restore (target_hp = 0 → max_hp) costs the structure's full recipe and
 * takes STRUCTURE_REPAIR_FULL_MS. Partial repairs scale linearly: the cost is
 * ceil(recipe_qty * missing / max_hp), and the duration shrinks proportionally
 * so the per-tick HP gain is constant across full and partial repairs.
 */

typedef struct {
    ItemKind item;
    uint16_t qty;
} RepairIng;

/* Canonical full-build recipe per structure type (one tile/unit worth).
 * Sourced from server/src/net/crafting.c — see "craft_*" recipes. */
static int repair_recipe_for_struct(PlacedStructureType type,
                                    RepairIng out[4]) {
    switch (type) {
        case STRUCT_WOODEN_FLOOR:     out[0] = (RepairIng){ ITEM_WOOD,  2 }; return 1; /* craft yields 2 per 4 wood */
        case STRUCT_CEILING:          out[0] = (RepairIng){ ITEM_WOOD, 15 }; return 1;
        case STRUCT_WORKBENCH:        out[0] = (RepairIng){ ITEM_WOOD, 10 }; return 1;
        case STRUCT_WALL:             out[0] = (RepairIng){ ITEM_WOOD,  3 }; return 1; /* craft yields 4 per 10 wood ≈ 2.5; round up */
        case STRUCT_DOOR_FRAME:       out[0] = (RepairIng){ ITEM_WOOD,  6 }; return 1;
        case STRUCT_DOOR:             out[0] = (RepairIng){ ITEM_WOOD,  4 }; return 1;
        case STRUCT_SHIPYARD:
            out[0] = (RepairIng){ ITEM_WOOD,  30 };
            out[1] = (RepairIng){ ITEM_PLANK, 10 };
            return 2;
        case STRUCT_CANNON:
            out[0] = (RepairIng){ ITEM_WOOD,   8 };
            out[1] = (RepairIng){ ITEM_METAL, 20 };
            return 2;
        case STRUCT_FLAG_FORT:
            out[0] = (RepairIng){ ITEM_WOOD,  40 };
            out[1] = (RepairIng){ ITEM_STONE, 40 };
            return 2;
        case STRUCT_COMPANY_FORTRESS:
            out[0] = (RepairIng){ ITEM_WOOD,  100 };
            out[1] = (RepairIng){ ITEM_STONE, 100 };
            out[2] = (RepairIng){ ITEM_METAL,  20 };
            return 3;
        default: return 0; /* claim_flag, wreck — not repairable */
    }
}

/* Compute prorated repair cost: ceil(recipe_qty * missing_hp / max_hp), min 1
 * per ingredient. Returns the ingredient count. */
static int compute_repair_cost(PlacedStructureType type,
                               uint16_t missing_hp, uint16_t max_hp,
                               RepairIng out[4]) {
    RepairIng base[4];
    int n = repair_recipe_for_struct(type, base);
    if (n <= 0 || missing_hp == 0 || max_hp == 0) return 0;
    for (int i = 0; i < n; i++) {
        uint32_t scaled = ((uint32_t)base[i].qty * (uint32_t)missing_hp + (uint32_t)max_hp - 1u) / (uint32_t)max_hp;
        if (scaled < 1u) scaled = 1u;
        out[i].item = base[i].item;
        out[i].qty  = (uint16_t)scaled;
    }
    return n;
}

void handle_repair_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload) {
    char response[256];

    uint32_t sid = 0;
    const char* sp = strstr(payload, "\"structure_id\":");
    if (sp) sscanf(sp + 15, "%u", &sid);

    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active || s->id != sid) continue;

        /* Range */
        float dx = player->x - s->x;
        float dy = player->y - s->y;
        if (dx*dx + dy*dy > STRUCT_INTERACT_R * STRUCT_INTERACT_R) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"too_far\"}", sid);
            goto rs_send;
        }
        /* Company */
        if (s->company_id != (uint8_t)player->company_id) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"wrong_company\"}", sid);
            goto rs_send;
        }
        /* Excluded types */
        if (s->type == STRUCT_CLAIM_FLAG || s->type == STRUCT_WRECK) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"not_repairable\"}", sid);
            goto rs_send;
        }
        if (s->type == STRUCT_FLAG_FORT && s->claim_phase == FLAG_FORT_PHASE_CLAIMING) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"claiming\"}", sid);
            goto rs_send;
        }

        /* Toggle-cancel: same player re-interacts → cancel (no refund) */
        if (s->repair_player_id == player->player_id) {
            s->repair_player_id   = 0;
            s->repair_progress_ms = 0.0f;
            s->repair_start_hp    = 0;
            char cmsg[160];
            snprintf(cmsg, sizeof(cmsg),
                     "{\"type\":\"repair_cancelled\",\"structure_id\":%u,\"player_id\":%u}",
                     sid, player->player_id);
            websocket_server_broadcast(cmsg);
            return;
        }
        if (s->repair_player_id != 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"in_progress\"}", sid);
            goto rs_send;
        }

        /* Already at full ceiling? Nothing to repair. */
        if (s->target_hp >= s->max_hp) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"already_full\"}", sid);
            goto rs_send;
        }

        /* Combat-damage cooldown: cannot start a repair within 30s of the
         * last combat hit. Prevents instant-heal under fire. */
        {
            uint32_t now_ms = get_time_ms();
            uint32_t since  = now_ms - s->last_damaged_ms;
            if (s->last_damaged_ms != 0 && since < 30000u) {
                uint32_t remaining = 30000u - since;
                snprintf(response, sizeof(response),
                         "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"recently_damaged\",\"cooldown_ms\":%u}",
                         sid, remaining);
                goto rs_send;
            }
        }

        /* Compute cost */
        uint16_t missing = (uint16_t)(s->max_hp - s->target_hp);
        RepairIng cost[4];
        int nc = compute_repair_cost(s->type, missing, s->max_hp, cost);
        if (nc <= 0) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"not_repairable\"}", sid);
            goto rs_send;
        }
        /* Check resources */
        for (int k = 0; k < nc; k++) {
            if (craft_count_item(player, cost[k].item) < (int)cost[k].qty) {
                snprintf(response, sizeof(response),
                         "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"insufficient_resources\"}", sid);
                goto rs_send;
            }
        }
        /* Consume */
        for (int k = 0; k < nc; k++) {
            craft_consume(player, cost[k].item, (int)cost[k].qty);
        }

        /* Start repair */
        s->repair_player_id   = player->player_id;
        s->repair_progress_ms = 0.0f;
        s->repair_start_hp    = s->hp;
        s->repair_broadcast_acc_ms = 0;

        /* Broadcast started */
        char smsg[256];
        snprintf(smsg, sizeof(smsg),
                 "{\"type\":\"repair_started\",\"structure_id\":%u,\"player_id\":%u,"
                 "\"hp\":%u,\"max_hp\":%u,\"target_hp\":%u}",
                 sid, player->player_id,
                 (unsigned)s->hp, (unsigned)s->max_hp, (unsigned)s->target_hp);
        websocket_server_broadcast(smsg);
        log_info("🔧 Player %u started repair on structure %u (missing %u hp)",
                 player->player_id, sid, (unsigned)missing);
        return;
    }

    snprintf(response, sizeof(response),
             "{\"type\":\"repair_fail\",\"structure_id\":%u,\"reason\":\"not_found\"}", sid);

rs_send:;
    char frm[256];
    size_t flen = websocket_create_frame(
        WS_OPCODE_TEXT, response, strlen(response), frm, sizeof(frm));
    if (flen > 0 && flen < sizeof(frm)) send(client->fd, frm, flen, 0);
}

void structure_repair_tick(uint32_t delta_ms) {
    if (delta_ms == 0) return;
    /* Rate: STRUCTURE_REPAIR_FULL_MS restores max_hp worth of HP. */
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;
        if (s->repair_player_id == 0) continue;

        /* If structure was destroyed mid-repair, repair_player_id was cleared
         * by destroy_placed_structure (active=false). Skip stale state. */
        if (s->target_hp >= s->max_hp || s->max_hp == 0) {
            /* Nothing more to repair */
            s->repair_player_id   = 0;
            s->repair_progress_ms = 0.0f;
            continue;
        }
        /* Flag fort entering CLAIMING is impossible mid-repair, but defensive: */
        if (s->type == STRUCT_FLAG_FORT && s->claim_phase == FLAG_FORT_PHASE_CLAIMING) {
            s->repair_player_id   = 0;
            s->repair_progress_ms = 0.0f;
            continue;
        }

        s->repair_progress_ms += (float)delta_ms;
        s->repair_broadcast_acc_ms += delta_ms;
        /* HP gained = max_hp * delta / STRUCTURE_REPAIR_FULL_MS, accumulated */
        float hp_gained_f = (float)s->max_hp * s->repair_progress_ms / (float)STRUCTURE_REPAIR_FULL_MS;
        uint16_t hp_gain_int = (uint16_t)hp_gained_f;
        if (hp_gain_int > 0) {
            /* Reset accumulator carry for next tick */
            float consumed_ms = (float)hp_gain_int * (float)STRUCTURE_REPAIR_FULL_MS / (float)s->max_hp;
            s->repair_progress_ms -= consumed_ms;
            if (s->repair_progress_ms < 0.0f) s->repair_progress_ms = 0.0f;

            uint16_t cap = s->max_hp;
            uint32_t new_hp        = (uint32_t)s->hp + (uint32_t)hp_gain_int;
            uint32_t new_target_hp = (uint32_t)s->target_hp + (uint32_t)hp_gain_int;
            if (new_hp        > cap) new_hp        = cap;
            if (new_target_hp > cap) new_target_hp = cap;
            s->hp        = (uint16_t)new_hp;
            s->target_hp = (uint16_t)new_target_hp;
        }

        /* Throttle hp_changed broadcasts to ~1Hz so clients see steady
         * progress without flooding. Always broadcast on completion. */
        int complete = (s->target_hp >= s->max_hp) ? 1 : 0;
        if (s->repair_broadcast_acc_ms < 1000u && !complete) continue;
        s->repair_broadcast_acc_ms = 0;

        /* Broadcast hp change */
        char msg[224];
        snprintf(msg, sizeof(msg),
                 "{\"type\":\"structure_hp_changed\","
                 "\"structure_id\":%u,\"hp\":%u,\"max_hp\":%u,\"target_hp\":%u"
                 ",\"x\":%.1f,\"y\":%.1f}",
                 s->id, (unsigned)s->hp, (unsigned)s->max_hp, (unsigned)s->target_hp, s->x, s->y);
        websocket_server_broadcast(msg);

        /* Completion */
        if (complete) {
            uint32_t pid = s->repair_player_id;
            s->repair_player_id   = 0;
            s->repair_progress_ms = 0.0f;
            s->repair_broadcast_acc_ms = 0;
            char cmsg[160];
            snprintf(cmsg, sizeof(cmsg),
                     "{\"type\":\"repair_complete\",\"structure_id\":%u,\"player_id\":%u}",
                     s->id, pid);
            websocket_server_broadcast(cmsg);
            log_info("🔧 Repair complete on structure %u (player %u)", s->id, pid);
        }
    }
}
