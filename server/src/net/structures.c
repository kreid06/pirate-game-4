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
#include "sim/island.h"

/* ── Island structure placement ─────────────────────────────────────────────
 * place_structure: payload = {"type":"place_structure","structure_type":"wooden_floor","x":123,"y":456}
 * Validates: player on island, item in active slot, workbench needs floor under it.
 * On success broadcasts structure_placed to all clients.
 */
#define STRUCT_FLOOR_RADIUS  30.0f  /* world-px half-extent of a floor tile (for overlap, not enforced hard) */
#define STRUCT_PLACE_RANGE  200.0f  /* player must be within this range of placement point */
#define STRUCT_FLOOR_REQ_R   55.0f  /* workbench centre must be within this of a floor tile */
#define STRUCT_INTERACT_R   110.0f  /* E-key range to open workbench */
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
    } else {
        snprintf(response, sizeof(response),
                 "{\"type\":\"place_structure_fail\",\"reason\":\"unknown_type\"}");
        goto ps_send;
    }

    /* Player must have the item somewhere in their inventory */
    int found_slot = -1;
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

    /* Cannot place within 500 px of an enemy-company structure */
    {
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
        /* Must also have a same-company floor tile within 3 tile-widths (150 px) */
        {
            const float FLOOR_UNDER_R = 150.0f;
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
    {
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
    placed_structures[placed_structure_count].placer_id  = player->player_id;
    strncpy(placed_structures[placed_structure_count].placer_name, player->name,
            sizeof(placed_structures[placed_structure_count].placer_name) - 1);
    placed_structures[placed_structure_count].placer_name[
        sizeof(placed_structures[placed_structure_count].placer_name) - 1] = '\0';
    placed_structures[placed_structure_count].open       = false;
    placed_structures[placed_structure_count].rotation   =
        (stype_enum == STRUCT_WOODEN_FLOOR || stype_enum == STRUCT_WORKBENCH ||
         stype_enum == STRUCT_SHIPYARD || stype_enum == STRUCT_CEILING) ? place_rotation : 0.0f;
    placed_structure_count++;

    log_info("🏗️ Player %u placed %s (id=%u) at (%.1f,%.1f) on island %u",
             player->player_id, stype, new_id, px, py, target_island_id);

    /* Broadcast to all clients */
    char bcast[384];
    bool new_is_door = (stype_enum == STRUCT_DOOR);
    float bcast_rot  = placed_structures[placed_structure_count - 1].rotation;
    snprintf(bcast, sizeof(bcast),
             "{\"type\":\"structure_placed\",\"id\":%u,\"structure_type\":\"%s\","
             "\"island_id\":%u,\"x\":%.1f,\"y\":%.1f,"
             "\"company_id\":%u,\"hp\":%u,\"max_hp\":%u,\"placer_name\":\"%s\""
             ",\"rotation\":%.2f%s}",
             new_id, stype, target_island_id, px, py,
             (unsigned)player->company_id, 100u, 100u, player->name,
             bcast_rot,
             new_is_door ? ",\"open\":false" : "");
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
        snprintf(response, sizeof(response),
                 "{\"type\":\"structure_interact_fail\",\"reason\":\"not_interactive\"}");
        goto si_send;
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
        int wood_total = 0, fiber_total = 0;
        for (int s2 = 0; s2 < INVENTORY_SLOTS; s2++) {
            if (player->inventory.slots[s2].item == ITEM_WOOD)  wood_total  += player->inventory.slots[s2].quantity;
            if (player->inventory.slots[s2].item == ITEM_FIBER) fiber_total += player->inventory.slots[s2].quantity;
        }
        if (wood_total < 20 || fiber_total < 10) {
            snprintf(response, sizeof(response),
                     "{\"type\":\"shipyard_action_fail\",\"reason\":\"missing_materials\"}");
            goto sya_send;
        }
        /* Consume */
        int need_wood = 20, need_fiber = 10;
        for (int s2 = 0; s2 < INVENTORY_SLOTS && (need_wood > 0 || need_fiber > 0); s2++) {
            if (need_wood > 0 && player->inventory.slots[s2].item == ITEM_WOOD) {
                int take = player->inventory.slots[s2].quantity < need_wood
                           ? player->inventory.slots[s2].quantity : need_wood;
                player->inventory.slots[s2].quantity -= (uint8_t)take;
                if (player->inventory.slots[s2].quantity == 0)
                    player->inventory.slots[s2].item = ITEM_NONE;
                need_wood -= take;
            }
            if (need_fiber > 0 && player->inventory.slots[s2].item == ITEM_FIBER) {
                int take = player->inventory.slots[s2].quantity < need_fiber
                           ? player->inventory.slots[s2].quantity : need_fiber;
                player->inventory.slots[s2].quantity -= (uint8_t)take;
                if (player->inventory.slots[s2].quantity == 0)
                    player->inventory.slots[s2].item = ITEM_NONE;
                need_fiber -= take;
            }
        }
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
        /* Save position/type before compacting — needed for cascade below */
        PlacedStructureType demolished_type = placed_structures[i].type;
        float fx = placed_structures[i].x;
        float fy = placed_structures[i].y;
        /* Shipyard: auto-release any scaffolded ship before demolishing */
        if (demolished_type == STRUCT_SHIPYARD
            && placed_structures[i].construction_phase == CONSTRUCTION_BUILDING
            && placed_structures[i].scaffolded_ship_id != 0) {
            uint32_t rel_id = placed_structures[i].scaffolded_ship_id;
            /* Clear scaffold flag and set initial_plank_count so normal sinking applies */
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
            /* Clear construction state before array compact */
            placed_structures[i].construction_phase  = CONSTRUCTION_EMPTY;
            placed_structures[i].modules_placed      = 0;
            placed_structures[i].scaffolded_ship_id  = 0;
        }
        /* Shift subsequent entries down to keep the array dense */
        for (uint32_t j = i; j + 1 < placed_structure_count; j++)
            placed_structures[j] = placed_structures[j + 1];
        placed_structure_count--;
        log_info("🔨 Player %u demolished structure %u", player->player_id, sid);
        /* Broadcast removal to all clients */
        char bcast[128];
        snprintf(bcast, sizeof(bcast),
                 "{\"type\":\"structure_demolished\",\"structure_id\":%u}", sid);
        websocket_server_broadcast(bcast);
        /* Cascade: if a floor was demolished, remove any workbenches sitting on it
           and any walls at its edges that have no other supporting floor. */
        if (demolished_type == STRUCT_WOODEN_FLOOR) {
            uint32_t j = 0;
            while (j < placed_structure_count) {
                if (placed_structures[j].type == STRUCT_WORKBENCH) {
                    float wdx = fabsf(placed_structures[j].x - fx);
                    float wdy = fabsf(placed_structures[j].y - fy);
                    if (wdx <= 25.0f && wdy <= 25.0f) {
                        uint32_t wid = placed_structures[j].id;
                        for (uint32_t k = j; k + 1 < placed_structure_count; k++)
                            placed_structures[k] = placed_structures[k + 1];
                        placed_structure_count--;
                        log_info("🔨 Cascade-demolished workbench %u (floor %u removed)", wid, sid);
                        char wbcast[128];
                        snprintf(wbcast, sizeof(wbcast),
                                 "{\"type\":\"structure_demolished\",\"structure_id\":%u}", wid);
                        websocket_server_broadcast(wbcast);
                        continue; /* don't increment — array shifted left */
                    }
                } else if (placed_structures[j].type == STRUCT_WALL ||
                           placed_structures[j].type == STRUCT_DOOR_FRAME ||
                           placed_structures[j].type == STRUCT_DOOR) {
                    /* Wall is at one of the 4 edge midpoints of the demolished floor? */
                    float wx = placed_structures[j].x;
                    float wy = placed_structures[j].y;
                    bool at_edge =
                        (fabsf(wx - fx) < 3.0f && fabsf(fabsf(wy - fy) - 25.0f) < 3.0f) ||
                        (fabsf(wy - fy) < 3.0f && fabsf(fabsf(wx - fx) - 25.0f) < 3.0f);
                    if (at_edge) {
                        /* Check if another active floor still supports this wall edge */
                        bool has_support = false;
                        for (uint32_t fi = 0; fi < placed_structure_count && !has_support; fi++) {
                            PlacedStructure* f = &placed_structures[fi];
                            if (!f->active || f->type != STRUCT_WOODEN_FLOOR) continue;
                            bool supports =
                                (fabsf(wx - f->x) < 3.0f && fabsf(fabsf(wy - f->y) - 25.0f) < 3.0f) ||
                                (fabsf(wy - f->y) < 3.0f && fabsf(fabsf(wx - f->x) - 25.0f) < 3.0f);
                            if (supports) has_support = true;
                        }
                        if (!has_support) {
                            uint32_t wid = placed_structures[j].id;
                            for (uint32_t k = j; k + 1 < placed_structure_count; k++)
                                placed_structures[k] = placed_structures[k + 1];
                            placed_structure_count--;
                            log_info("🔨 Cascade-demolished wall %u (floor %u removed)", wid, sid);
                            char wcast[128];
                            snprintf(wcast, sizeof(wcast),
                                     "{\"type\":\"structure_demolished\",\"structure_id\":%u}", wid);
                            websocket_server_broadcast(wcast);
                            continue;
                        }
                    }
                } else if (placed_structures[j].type == STRUCT_CEILING) {
                    /* Ceiling needs a floor within 150 px — check if any remain */
                    float cx2 = placed_structures[j].x;
                    float cy2 = placed_structures[j].y;
                    bool ceil_has_floor = false;
                    for (uint32_t fi = 0; fi < placed_structure_count && !ceil_has_floor; fi++) {
                        PlacedStructure* f = &placed_structures[fi];
                        if (!f->active || f->type != STRUCT_WOODEN_FLOOR) continue;
                        float fdx2 = f->x - cx2, fdy2 = f->y - cy2;
                        if (fdx2*fdx2 + fdy2*fdy2 <= 150.0f * 150.0f) ceil_has_floor = true;
                    }
                    if (!ceil_has_floor) {
                        uint32_t cid = placed_structures[j].id;
                        for (uint32_t k = j; k + 1 < placed_structure_count; k++)
                            placed_structures[k] = placed_structures[k + 1];
                        placed_structure_count--;
                        log_info("🔨 Cascade-demolished ceiling %u (floor %u removed)", cid, sid);
                        char cccast[128];
                        snprintf(cccast, sizeof(cccast),
                                 "{\"type\":\"structure_demolished\",\"structure_id\":%u}", cid);
                        websocket_server_broadcast(cccast);
                        continue;
                    }
                }
                j++;
            }
        }
        /* door_frame demolished: cascade any door panel sitting on it */
        if (demolished_type == STRUCT_DOOR_FRAME) {
            for (uint32_t j = 0; j < placed_structure_count; j++) {
                if (placed_structures[j].type != STRUCT_DOOR) continue;
                if (fabsf(placed_structures[j].x - fx) >= 3.0f ||
                    fabsf(placed_structures[j].y - fy) >= 3.0f) continue;
                uint32_t dpid = placed_structures[j].id;
                for (uint32_t k = j; k + 1 < placed_structure_count; k++)
                    placed_structures[k] = placed_structures[k + 1];
                placed_structure_count--;
                log_info("\U0001F528 Cascade-demolished door panel %u (frame removed)", dpid);
                char dpcast[128];
                snprintf(dpcast, sizeof(dpcast),
                         "{\"type\":\"structure_demolished\",\"structure_id\":%u}", dpid);
                websocket_server_broadcast(dpcast);
                break;
            }
        }
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
