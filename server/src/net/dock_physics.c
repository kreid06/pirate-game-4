#include "net/websocket_server_internal.h"
#include "net/dock_physics.h"
#define _USE_MATH_DEFINES
#include <math.h>
#include <string.h>
#include <stdbool.h>
#include <stdlib.h>
#include "util/log.h"

// Define M_PI if not available
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/**
 * Determine if a placed wall/door is horizontal (N/S edge, runs along X axis)
 * by scanning for a floor tile whose north or south edge midpoint matches (wx,wy).
 * Returns false (vertical) if no horizontal floor edge is found.
 */
/* Return the rotation (radians) of a wall/door at (wx,wy) by finding the nearest
   floor tile and computing atan2(wall - floor) + pi/2 (wall runs perpendicular
   to the floor-centre -> edge-midpoint vector, same formula used by the client). */
float wall_get_rad(float wx, float wy) {
    float best_dist2 = 35.0f * 35.0f;
    float best_rad   = 0.0f;
    for (uint32_t fi = 0; fi < placed_structure_count; fi++) {
        if (!placed_structures[fi].active) continue;
        if (placed_structures[fi].type != STRUCT_WOODEN_FLOOR) continue;
        float dx = wx - placed_structures[fi].x;
        float dy = wy - placed_structures[fi].y;
        float d2 = dx * dx + dy * dy;
        if (d2 < best_dist2) { best_dist2 = d2; best_rad = atan2f(dy, dx) + (float)M_PI / 2.0f; }
    }
    return best_rad;
}

/* Check whether any active floor tile has a wall/door at one of its rotated edge midpoints. */
bool wall_has_support(float wx, float wy) {
    const float EDGE_TOL = 4.0f, HALF = 25.0f;
    for (uint32_t fi = 0; fi < placed_structure_count; fi++) {
        PlacedStructure *f = &placed_structures[fi];
        if (!f->active || f->type != STRUCT_WOODEN_FLOOR) continue;
        float rad = f->rotation * (float)M_PI / 180.0f;
        float c = cosf(rad), sn = sinf(rad);
        /* Rotated edge midpoints: N(0,-H), S(0,+H), W(-H,0), E(+H,0) in local space */
        float edges[4][2] = {
            { f->x + HALF*sn,  f->y - HALF*c  }, /* N */
            { f->x - HALF*sn,  f->y + HALF*c  }, /* S */
            { f->x - HALF*c,   f->y - HALF*sn }, /* W */
            { f->x + HALF*c,   f->y + HALF*sn }, /* E */
        };
        for (int i = 0; i < 4; i++)
            if (fabsf(wx - edges[i][0]) < EDGE_TOL && fabsf(wy - edges[i][1]) < EDGE_TOL)
                return true;
    }
    return false;
}

/* ─── Shipyard (dry dock) geometry helpers ───────────────────────────────────
 * Dock-local coordinate system:
 *   +Y = dock length axis (mouth/open end); +X = dock width axis
 * Sizes in client pixels (rendering BASE = 50):
 *   ARM_T=50  INT_W=240  ARM_L=840  BACK_T=50  hw=170  hh=445            */
#define DOCK_HW       170.0f
#define DOCK_HH       445.0f
#define DOCK_ARM_T     50.0f
#define DOCK_BACK_T    50.0f
#define DOCK_STAIR_H   50.0f   /* stair opening at each end of each arm */

/* Coordinate convention: rotation matches ctx.rotate() — standard matrix.
 * local→world: wx = ox + lx·cos(r) − ly·sin(r),  wy = oy + lx·sin(r) + ly·cos(r)
 * world→local (inverse/transpose): use −rad */
void dock_world_to_local(const PlacedStructure *sy,
                                float wx, float wy, float *lx, float *ly) {
    float rad = sy->rotation * (float)M_PI / 180.0f;
    float c = cosf(-rad), s = sinf(-rad);
    float dx = wx - sy->x, dy = wy - sy->y;
    *lx = dx * c - dy * s;
    *ly = dx * s + dy * c;
}

void dock_local_to_world(const PlacedStructure *sy,
                                float lx, float ly, float *wx, float *wy) {
    float rad = sy->rotation * (float)M_PI / 180.0f;
    float c = cosf(rad), s = sinf(rad);
    *wx = sy->x + lx * c - ly * s;
    *wy = sy->y + lx * s + ly * c;
}

/* OBB pushout in dock-local space.  Returns true if a pushout occurred.
 * Only fires when the player circle overlaps the OBB from OUTSIDE (d2 > 0).
 * When d2 == 0 the player centre is inside the OBB — that means they are
 * standing ON the walkable surface, so no push is applied. */
static bool dock_obb_pushout(float cx, float cy, float hx, float hy,
                             float r, float *lx, float *ly) {
    float dx = *lx - cx, dy = *ly - cy;
    float cl_x = dx < -hx ? -hx : (dx > hx ? hx : dx);
    float cl_y = dy < -hy ? -hy : (dy > hy ? hy : dy);
    float px = dx - cl_x, py = dy - cl_y;
    float d2 = px * px + py * py;
    if (d2 < r * r && d2 > 0.0001f) {
        float d = sqrtf(d2), pen = r - d;
        *lx += (px / d) * pen;
        *ly += (py / d) * pen;
        return true;
    }
    return false;
}

/* True if dock-local point (lx,ly) is on a walkable dock surface. */
bool dock_point_on_surface(float lx, float ly, bool has_scaffolding) {
    const float P  = 10.0f;                      /* padding ~ player radius */
    const float ai = DOCK_HW - DOCK_ARM_T;       /* arm inner edge = 120   */
    /* Left arm top surface */
    if (lx >= -(DOCK_HW + P) && lx <= -(ai - P) && fabsf(ly) <= DOCK_HH + P) return true;
    /* Right arm top surface */
    if (lx >=  (ai - P)      && lx <=  (DOCK_HW + P) && fabsf(ly) <= DOCK_HH + P) return true;
    /* Back wall top surface */
    if (fabsf(lx) <= DOCK_HW + P &&
        ly >= -(DOCK_HH + P) && ly <= -(DOCK_HH - DOCK_BACK_T - P)) return true;
    /* Interior bay — fully walkable when scaffolding is up */
    if (has_scaffolding && fabsf(lx) <= ai + P &&
        ly >= -(DOCK_HH - DOCK_BACK_T - P) && ly <= DOCK_HH + P) return true;
    return false;
}

/* Apply dock U-wall OBB pushout (world space).
 * Arms span the full dock height (-445 to +445): centre Y=0, half-Y=DOCK_HH=445.
 * Back wall and scaffolding walkway (construction) are full-width OBBs. */
void dock_apply_player_collision(const PlacedStructure *sy, float player_r,
                                        bool has_scaffolding, float *wx, float *wy) {
    float lx, ly;
    dock_world_to_local(sy, *wx, *wy, &lx, &ly);

    float ai         = DOCK_HW - DOCK_ARM_T;              /* 120  */
    float arm_cx_l   = -(DOCK_HW - DOCK_ARM_T / 2.0f);   /* -145 */
    float arm_cx_r   =  (DOCK_HW - DOCK_ARM_T / 2.0f);   /* +145 */
    /* Arms run the full dock height: Y ∈ [-445, +445] → centre 0, half DOCK_HH */
    float back_cy    = -(DOCK_HH - DOCK_BACK_T / 2.0f);  /* -420 */

    dock_obb_pushout(arm_cx_l, 0.0f, DOCK_ARM_T / 2.0f, DOCK_HH, player_r, &lx, &ly);
    dock_obb_pushout(arm_cx_r, 0.0f, DOCK_ARM_T / 2.0f, DOCK_HH, player_r, &lx, &ly);
    dock_obb_pushout(0.0f,  back_cy, DOCK_HW, DOCK_BACK_T / 2.0f,   player_r, &lx, &ly);
    if (has_scaffolding) {
        float wcy = DOCK_HH - DOCK_BACK_T / 2.0f;        /* +420 */
        dock_obb_pushout(0.0f, wcy, ai, DOCK_BACK_T / 2.0f, player_r, &lx, &ly);
    }

    dock_local_to_world(sy, lx, ly, wx, wy);
}

/* Push non-scaffolded sim ships out of dock U-walls.
 * Called once per tick after scaffold pin and position sync.
 * Uses the actual brigantine hull polygon (same vertices as ship-ship SAT)
 * transformed to dock-local space, tested via polygon-vs-AABB SAT. */

/* Per-wall SAT: returns true if hull polygon (dock-local px) overlaps wall AABB.
 * Outputs penetration depth, outward normal (wall→ship), and a single contact
 * point suitable for torque calculation.
 *
 * Contact point strategy:
 *   - If hull vertices are inside the AABB: centroid of those vertices
 *   - Otherwise (edge-crossing, no vertex inside): SAT support vertex — the hull
 *     vertex furthest into the wall along -normal.  This handles the rotation
 *     case where edges sweep through the wall without any vertex entering it.
 *
 * Normal is oriented so it points from the wall center toward the ship origin. */
static bool dock_wall_sat(const float *hdx, const float *hdy, int N,
                          float dcx, float dcy, float dhx, float dhy,
                          float origin_lx, float origin_ly,
                          float *out_pen, float *out_nx, float *out_ny,
                          float *out_cx, float *out_cy)
{
    float min_pen = 1e30f, best_nx = 1.0f, best_ny = 0.0f;

    /* ── AABB axis X ── */
    float hmn = hdx[0], hmx = hdx[0];
    for (int i = 1; i < N; i++) { if (hdx[i] < hmn) hmn = hdx[i]; if (hdx[i] > hmx) hmx = hdx[i]; }
    if (hmx < dcx - dhx || hmn > dcx + dhx) return false;
    { float a = hmx - (dcx - dhx), b = (dcx + dhx) - hmn;
      if (a < b) { if (a < min_pen) { min_pen = a; best_nx =  1.0f; best_ny = 0.0f; } }
      else       { if (b < min_pen) { min_pen = b; best_nx = -1.0f; best_ny = 0.0f; } } }

    /* ── AABB axis Y ── */
    hmn = hdy[0]; hmx = hdy[0];
    for (int i = 1; i < N; i++) { if (hdy[i] < hmn) hmn = hdy[i]; if (hdy[i] > hmx) hmx = hdy[i]; }
    if (hmx < dcy - dhy || hmn > dcy + dhy) return false;
    { float a = hmx - (dcy - dhy), b = (dcy + dhy) - hmn;
      if (a < b) { if (a < min_pen) { min_pen = a; best_nx = 0.0f; best_ny =  1.0f; } }
      else       { if (b < min_pen) { min_pen = b; best_nx = 0.0f; best_ny = -1.0f; } } }

    /* ── Hull edge normals ── */
    for (int i = 0; i < N; i++) {
        int j = (i + 1) % N;
        float ex = hdx[j] - hdx[i], ey = hdy[j] - hdy[i];
        float len = sqrtf(ex * ex + ey * ey); if (len < 0.5f) continue;
        float nx = -ey / len, ny = ex / len;
        float ph_min = 1e30f, ph_max = -1e30f;
        for (int k = 0; k < N; k++) {
            float p = hdx[k] * nx + hdy[k] * ny;
            if (p < ph_min) ph_min = p; if (p > ph_max) ph_max = p;
        }
        float ap[4] = { (dcx-dhx)*nx+(dcy-dhy)*ny, (dcx+dhx)*nx+(dcy-dhy)*ny,
                        (dcx-dhx)*nx+(dcy+dhy)*ny, (dcx+dhx)*nx+(dcy+dhy)*ny };
        float aw_min = ap[0], aw_max = ap[0];
        for (int k = 1; k < 4; k++) { if (ap[k] < aw_min) aw_min = ap[k]; if (ap[k] > aw_max) aw_max = ap[k]; }
        if (ph_max < aw_min || ph_min > aw_max) return false;
        float a = ph_max - aw_min, b = aw_max - ph_min;
        if (a < b) { if (a < min_pen) { min_pen = a; best_nx =  nx; best_ny =  ny; } }
        else       { if (b < min_pen) { min_pen = b; best_nx = -nx; best_ny = -ny; } }
    }

    /* Orient normal: wall → ship origin */
    if ((origin_lx - dcx) * best_nx + (origin_ly - dcy) * best_ny < 0.0f) {
        best_nx = -best_nx; best_ny = -best_ny;
    }
    *out_pen = min_pen; *out_nx = best_nx; *out_ny = best_ny;

    /* ── Contact point ── */
    float sum_cx = 0.0f, sum_cy = 0.0f; int n_in = 0;
    for (int i = 0; i < N; i++) {
        if (hdx[i] >= dcx - dhx && hdx[i] <= dcx + dhx &&
            hdy[i] >= dcy - dhy && hdy[i] <= dcy + dhy) {
            sum_cx += hdx[i]; sum_cy += hdy[i]; n_in++;
        }
    }
    if (n_in > 0) {
        *out_cx = sum_cx / (float)n_in;
        *out_cy = sum_cy / (float)n_in;
    } else {
        /* Edge-crossing case: use the support vertex (most penetrating along -n) */
        float best_p = 1e30f; *out_cx = hdx[0]; *out_cy = hdy[0];
        for (int i = 0; i < N; i++) {
            float p = hdx[i] * best_nx + hdy[i] * best_ny;
            if (p < best_p) { best_p = p; *out_cx = hdx[i]; *out_cy = hdy[i]; }
        }
    }
    return true;
}

void handle_ship_dock_collisions(void) {
    if (!global_sim) return;

    static const struct { float cx, cy, hx, hy; } WALLS[3] = {
        { -(DOCK_HW - DOCK_ARM_T/2.0f), 0.0f,      DOCK_ARM_T/2.0f,  DOCK_HH          },
        {  (DOCK_HW - DOCK_ARM_T/2.0f), 0.0f,      DOCK_ARM_T/2.0f,  DOCK_HH          },
        {  0.0f, -(DOCK_HH - DOCK_BACK_T/2.0f),    DOCK_HW,          DOCK_BACK_T/2.0f },
    };
    static const float RESTITUTION  = 0.18f;
    /* Coulomb friction coefficient at wall contact. */
    static const float WALL_FRICTION = 0.6f;
    /* Baumgarte bias: fraction of remaining penetration converted to a
     * corrective velocity per tick.  0.3 → error halves every ~2 ticks. */
    static const float BAUMGARTE     = 0.3f;
    /* Penetration depth (client px) below which no Baumgarte bias is applied.
     * Prevents micro-jitter from tiny resting contacts. */
    static const float SLOP          = 0.5f;
    /* Solver iterations per tick.  Each pass re-tests all 3 walls against the
     * most recently corrected hull geometry and accumulated velocity, allowing
     * impulses from wall A to inform the response at wall B. */
    static const int   N_ITER        = 3;

    for (int di = 0; di < (int)placed_structure_count; di++) {
        PlacedStructure *sy = &placed_structures[di];
        if (!sy->active || sy->type != STRUCT_SHIPYARD) continue;

        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
            struct Ship *ship = &global_sim->ships[si];
            if ((uint32_t)ship->id == sy->scaffolded_ship_id) continue;

            /* Broad phase */
            float sxc  = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.x));
            float syc  = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.y));
            float brad = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->bounding_radius));
            float ddx  = sxc - sy->x, ddy = syc - sy->y;
            float broad = brad + DOCK_HH + DOCK_HW;
            if (ddx * ddx + ddy * ddy > broad * broad) continue;

            /* Build hull in dock-local px */
            int N = (int)ship->hull_vertex_count; if (N < 3) continue;
            float ship_rad = Q16_TO_FLOAT(ship->rotation);
            float cs = cosf(ship_rad), ss = sinf(ship_rad);
            float hdx[64], hdy[64];
            for (int vi = 0; vi < N; vi++) {
                float lhx = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[vi].x));
                float lhy = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->hull_vertices[vi].y));
                float wx  = sxc + lhx * cs - lhy * ss;
                float wy  = syc + lhx * ss + lhy * cs;
                dock_world_to_local(sy, wx, wy, &hdx[vi], &hdy[vi]);
            }
            float lx, ly;
            dock_world_to_local(sy, sxc, syc, &lx, &ly);

            /* Ship velocity in dock-local px/s */
            float dock_rad = sy->rotation * (float)M_PI / 180.0f;
            float dc = cosf(dock_rad), ds = sinf(dock_rad);
            float vx_w = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->velocity.x));
            float vy_w = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->velocity.y));
            float vx_dl =  vx_w * dc + vy_w * ds;
            float vy_dl = -vx_w * ds + vy_w * dc;
            float omega  = Q16_TO_FLOAT(ship->angular_velocity);

            /* Physics in client-px space: I_px = I_server * (WORLD_SCALE_FACTOR)^2 */
            float mass_f    = Q16_TO_FLOAT(ship->mass);
            float inertia_f = Q16_TO_FLOAT(ship->moment_inertia) * 100.0f;
            float inv_mass    = (mass_f    > 0.0f) ? 1.0f / mass_f    : 0.0f;
            float inv_inertia = (inertia_f > 0.0f) ? 1.0f / inertia_f : 0.0f;

            float total_push_x = 0.0f, total_push_y = 0.0f;

            /* Per-wall accumulated impulse (normal + friction).
             * Clamped across iterations so Coulomb friction is bounded by the
             * total normal impulse applied so far, not just this iteration's. */
            float P_n[3] = {0.0f, 0.0f, 0.0f};
            float P_f[3] = {0.0f, 0.0f, 0.0f};

            /* Working velocity — updated after every wall within every iteration
             * so wall B in iteration 2 sees the corrected state from wall A. */
            float cur_vx = vx_dl, cur_vy = vy_dl, cur_w = omega;

            /* ── Translational CCD pre-pass ──────────────────────────────────
             * The SAT solver below can only resolve overlaps it can see.  If
             * the ship moves faster than a wall's thickness in one tick it may
             * fully pass through before the SAT check runs, giving zero
             * penetration and therefore zero response (the classic tunnelling
             * bug).
             *
             * We sweep the bounding circle from (lx - vx_dl*dt, ly - vy_dl*dt)
             * — the position one tick ago — to (lx, ly) against each of the
             * three inner-facing dock wall segments.  If we find a hit, we
             * rewind to just before the TOI, reflect the penetrating velocity
             * component, and rebuild the hull array so the SAT solver still
             * runs on the corrected state.                                    */
            {
                float dt_tick = 1.0f / (float)TICK_RATE_HZ;
                float ax_ccd = lx - vx_dl * dt_tick;
                float ay_ccd = ly - vy_dl * dt_tick;
                float disp_x = lx - ax_ccd, disp_y = ly - ay_ccd;

                /* Only bother if the ship actually moved a meaningful amount */
                if (disp_x * disp_x + disp_y * disp_y > 0.25f) {
                    float ai_ccd = DOCK_HW - DOCK_ARM_T;                 /* 120 */
                    float bi_ccd = DOCK_HH - DOCK_BACK_T;                /* 395 */

                    /* Inner-facing wall segments in dock-local px.
                     * nx/ny is the outward (interior-facing) normal. */
                    struct { float x0,y0,x1,y1, nx,ny; } iw[3] = {
                        { -ai_ccd, -DOCK_HH, -ai_ccd,  DOCK_HH,   1.0f,  0.0f },
                        {  ai_ccd, -DOCK_HH,  ai_ccd,  DOCK_HH,  -1.0f,  0.0f },
                        { -ai_ccd,   -bi_ccd,  ai_ccd, -bi_ccd,   0.0f,  1.0f },
                    };

                    float best_t = 2.0f, best_nx = 0.0f, best_ny = 0.0f;

                    for (int wi = 0; wi < 3; wi++) {
                        float ex = iw[wi].x1 - iw[wi].x0;
                        float ey = iw[wi].y1 - iw[wi].y0;
                        float elen = sqrtf(ex*ex + ey*ey);
                        if (elen < 1e-6f) continue;

                        float enx = iw[wi].nx, eny = iw[wi].ny;
                        float d0 = (ax_ccd - iw[wi].x0)*enx + (ay_ccd - iw[wi].y0)*eny;
                        float d1 = (lx     - iw[wi].x0)*enx + (ly     - iw[wi].y0)*eny;
                        float dd  = d1 - d0;
                        if (fabsf(dd) < 1e-10f) continue;

                        /* Circle surface touches the wall line at t where d(t) == ±brad */
                        float target_d = (d0 > 0.0f) ? brad : -brad;
                        float t = (target_d - d0) / dd;
                        if (t < 0.0f || t > 1.0f) continue;

                        /* Confirm contact point is within segment extent */
                        float cx_t = ax_ccd + disp_x * t;
                        float cy_t = ay_ccd + disp_y * t;
                        float proj = ((cx_t - iw[wi].x0)*ex + (cy_t - iw[wi].y0)*ey)
                                     / (elen * elen);
                        if (proj < 0.0f || proj > 1.0f) continue;

                        if (t < best_t) {
                            best_t  = t;
                            best_nx = enx;
                            best_ny = eny;
                        }
                    }

                    if (best_t <= 1.0f) {
                        /* Rewind to just before the wall */
                        float safe_t  = fmaxf(best_t - 0.01f, 0.0f);
                        float new_lx  = ax_ccd + disp_x * safe_t;
                        float new_ly  = ay_ccd + disp_y * safe_t;

                        /* Reflect penetrating velocity component */
                        float vn_ccd  = vx_dl * best_nx + vy_dl * best_ny;
                        if (vn_ccd < 0.0f) {
                            vx_dl   -= (1.0f + RESTITUTION) * vn_ccd * best_nx;
                            vy_dl   -= (1.0f + RESTITUTION) * vn_ccd * best_ny;
                            cur_vx   = vx_dl;
                            cur_vy   = vy_dl;

                            /* Write corrected velocity back to sim ship (rotate
                             * dock-local → world, then px/s → server units/s) */
                            float vx_w2 = vx_dl * dc - vy_dl * ds;
                            float vy_w2 = vx_dl * ds + vy_dl * dc;
                            ship->velocity.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(vx_w2));
                            ship->velocity.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(vy_w2));
                        }

                        /* Write corrected position back to sim ship */
                        float new_wx2, new_wy2;
                        dock_local_to_world(sy, new_lx, new_ly, &new_wx2, &new_wy2);
                        ship->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_wx2));
                        ship->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_wy2));

                        /* Rebuild hull vertices in dock-local space so the SAT
                         * solver below sees the corrected position. */
                        float offset_x = new_lx - lx, offset_y = new_ly - ly;
                        lx = new_lx;
                        ly = new_ly;
                        for (int vi = 0; vi < N; vi++) {
                            hdx[vi] += offset_x;
                            hdy[vi] += offset_y;
                        }
                    }
                }
            } /* end translational CCD pre-pass */

            /* Warm start from contact cache: seed P_n/P_f with 80% of last
             * tick's accumulated impulse so the solver starts near the
             * converged answer instead of building up from zero.
             * Dock entity ID is encoded as 0xFF00 | dock_index so it never
             * collides with real entity IDs (which start from 1). */
            entity_id dock_pseudo_id = (entity_id)(0xFF00u | (uint16_t)di);
            struct ContactEntry* dock_ce = contact_cache_find(
                &global_sim->contact_cache, ship->id, dock_pseudo_id);
            if (dock_ce && dock_ce->n_contacts == 3) {
                for (int wi = 0; wi < 3; wi++) {
                    P_n[wi] = dock_ce->P_n[wi] * 0.8f;
                    P_f[wi] = dock_ce->P_f[wi] * 0.8f;
                }
                /* Apply warm-start impulse to working velocity */
                for (int wi = 0; wi < 3; wi++) {
                    if (P_n[wi] <= 0.0f) continue;
                    float pen, wnx, wny, wcx, wcy;
                    if (!dock_wall_sat(hdx, hdy, N,
                                       WALLS[wi].cx, WALLS[wi].cy,
                                       WALLS[wi].hx, WALLS[wi].hy,
                                       lx, ly,
                                       &pen, &wnx, &wny, &wcx, &wcy)) {
                        P_n[wi] = 0; P_f[wi] = 0; continue;
                    }
                    float wrx = wcx - lx, wry = wcy - ly;
                    cur_vx += P_n[wi] * wnx * inv_mass;
                    cur_vy += P_n[wi] * wny * inv_mass;
                    cur_w  += (wrx * (P_n[wi] * wny) - wry * (P_n[wi] * wnx)) * inv_inertia;
                    /* Friction warm-start */
                    float vt_x2 = -wny, vt_y2 = wnx; /* tangent direction */
                    cur_vx += P_f[wi] * vt_x2 * inv_mass;
                    cur_vy += P_f[wi] * vt_y2 * inv_mass;
                    cur_w  += (wrx * (P_f[wi] * vt_y2) - wry * (P_f[wi] * vt_x2)) * inv_inertia;
                }
            }

            /* dt in seconds (for Baumgarte bias = β/dt * max(pen-slop, 0)) */
            float dt_s = 1.0f / (float)TICK_RATE_HZ;

            for (int iter = 0; iter < N_ITER; iter++) {
                for (int wi = 0; wi < 3; wi++) {
                    float pen, nx, ny, cx, cy;
                    if (!dock_wall_sat(hdx, hdy, N,
                                       WALLS[wi].cx, WALLS[wi].cy,
                                       WALLS[wi].hx, WALLS[wi].hy,
                                       lx, ly,
                                       &pen, &nx, &ny, &cx, &cy)) continue;

                    /* Positional correction: apply fraction of remaining penetration
                     * each iteration (Baumgarte-style spreading).  Subsequent
                     * iterations re-detect the reduced penetration automatically. */
                    float corr = BAUMGARTE * fmaxf(pen - SLOP, 0.0f);
                    if (corr > 0.0f) {
                        lx += nx * corr; ly += ny * corr;
                        for (int vi = 0; vi < N; vi++) { hdx[vi] += nx * corr; hdy[vi] += ny * corr; }
                        total_push_x += nx * corr; total_push_y += ny * corr;
                    }

                    /* Lever arm from ship origin to contact point */
                    float rx = cx - lx, ry = cy - ly;

                    /* Velocity at contact: v_cm + ω×r */
                    float vc_x = cur_vx + cur_w * (-ry);
                    float vc_y = cur_vy + cur_w * ( rx);
                    float vc_n = vc_x * nx + vc_y * ny;

                    /* ── Normal impulse with Baumgarte velocity bias ── */
                    float rxn   = rx * ny - ry * nx;
                    float denom = inv_mass + rxn * rxn * inv_inertia;
                    if (denom < 1e-10f) continue;

                    /* bias = β/dt * max(pen - slop, 0): drains residual positional
                     * error that Baumgarte pos-correction didn't fully remove. */
                    float bias = (BAUMGARTE / dt_s) * fmaxf(pen - SLOP, 0.0f);

                    /* Impulse increment (clamped: normal impulse can only push, never pull) */
                    float dP = (-(1.0f + RESTITUTION) * vc_n + bias) / denom;
                    float P_n_new = fmaxf(P_n[wi] + dP, 0.0f);
                    float J = P_n_new - P_n[wi];
                    P_n[wi] = P_n_new;

                    cur_vx += J * nx * inv_mass;
                    cur_vy += J * ny * inv_mass;
                    cur_w  += (rx * (J * ny) - ry * (J * nx)) * inv_inertia;

                    /* ── Friction impulse (Coulomb, clamped against accumulated P_n) ── */
                    /* Re-sample velocity after normal impulse for correct tangential v */
                    float vc_x2 = cur_vx + cur_w * (-ry);
                    float vc_y2 = cur_vy + cur_w * ( rx);
                    float vc_n2 = vc_x2 * nx + vc_y2 * ny;
                    float vt_x  = vc_x2 - vc_n2 * nx;
                    float vt_y  = vc_y2 - vc_n2 * ny;
                    float vt_len = sqrtf(vt_x * vt_x + vt_y * vt_y);
                    if (vt_len > 0.001f) {
                        float tx = vt_x / vt_len, ty = vt_y / vt_len;
                        float rxt   = rx * ty - ry * tx;
                        float denom_t = inv_mass + rxt * rxt * inv_inertia;
                        if (denom_t > 1e-10f) {
                            float dPf    = -vt_len / denom_t;
                            float Pf_max = WALL_FRICTION * P_n[wi]; /* clamp against TOTAL accumulated normal */
                            float Pf_new = P_f[wi] + dPf;
                            if (Pf_new >  Pf_max) Pf_new =  Pf_max;
                            if (Pf_new < -Pf_max) Pf_new = -Pf_max;
                            float Jf = Pf_new - P_f[wi];
                            P_f[wi] = Pf_new;
                            cur_vx += Jf * tx * inv_mass;
                            cur_vy += Jf * ty * inv_mass;
                            cur_w  += (rx * (Jf * ty) - ry * (Jf * tx)) * inv_inertia;
                        }
                    }
                }
            } /* end N_ITER */

            /* ── Equal-and-opposite reaction pass ─────────────────────────
             *
             * Simple idea: for each active wall contact, measure the
             * residual approach velocity (linear + angular).  If the
             * contact point is still moving into the wall, apply the
             * exact impulse to zero it out.  The wall provides whatever
             * reaction is needed — no prediction, no clamps. */
            for (int wi = 0; wi < 3; wi++) {
                if (P_n[wi] <= 0.0f) continue;

                float pen, nx, ny, cx, cy;
                if (!dock_wall_sat(hdx, hdy, N,
                                   WALLS[wi].cx, WALLS[wi].cy,
                                   WALLS[wi].hx, WALLS[wi].hy,
                                   lx, ly,
                                   &pen, &nx, &ny, &cx, &cy)) continue;

                float rx = cx - lx, ry = cy - ly;
                float vc_x = cur_vx + cur_w * (-ry);
                float vc_y = cur_vy + cur_w * ( rx);
                float vc_n = vc_x * nx + vc_y * ny;

                if (vc_n < 0.0f) {
                    float rxn   = rx * ny - ry * nx;
                    float denom = inv_mass + rxn * rxn * inv_inertia;
                    if (denom < 1e-10f) continue;
                    float J = -vc_n / denom;
                    cur_vx += J * nx * inv_mass;
                    cur_vy += J * ny * inv_mass;
                    cur_w  += rxn * J * inv_inertia;
                    P_n[wi] += J;
                }
            }

            /* ── Dock angular velocity cap ────────────────────────────────
             *
             * The friction impulse in the N_ITER loop only resists rotation
             * when one or more hull vertices are actively touching a wall.
             * When the ship is centred in the dock it can freely spin up via
             * rudder input until a vertex eventually hits a wall.  By then the
             * angular momentum is so large that even the rotational CCD (below)
             * has to deliver a harsh bounce impulse.
             *
             * Instead, continuously limit cur_w to the angular velocity at
             * which the fastest-moving hull vertex would reach the nearest
             * inner wall within one tick:
             *
             *   For vertex i at distance R_i from the ship centre:
             *     dx_i(ω) = R_i * |ω| * dt   (arc length, linear approx)
             *
             *   Clearance to each inner wall face:
             *     left_clear  = hdx[i] - (-ai)  = hdx[i] + ai
             *     right_clear = ai - hdx[i]
             *     back_clear  = hdy[i] - (-bi)  = hdy[i] + bi
             *
             *   If dx_i(ω) > min_clearance_i → vertex would hit.
             *   ω_max_i = min_clearance_i / (R_i * dt)
             *
             *   ω_max = min over all vertices of ω_max_i, with a floor of
             *   DOCK_OMEGA_FLOOR so the ship can still make slow progress.  */
            {
                static const float DOCK_OMEGA_FLOOR = 0.04f; /* rad/s min */
                static const float DOCK_ANGULAR_EXTRA_DRAG = 0.80f; /* extra drag multiplier inside dock */
                float dt_tick = 1.0f / (float)TICK_RATE_HZ;
                float ai_cap  = DOCK_HW - DOCK_ARM_T;   /* 120 px inner half-width */
                float bi_cap  = DOCK_HH - DOCK_BACK_T;  /* 395 px inner half-height */

                float omega_max = 1e10f;

                for (int vi = 0; vi < N; vi++) {
                    float vx_l = hdx[vi], vy_l = hdy[vi];

                    /* Distance from ship centre to this vertex */
                    float dvx = vx_l - lx, dvy = vy_l - ly;
                    float R = sqrtf(dvx * dvx + dvy * dvy);
                    if (R < 0.5f) continue;      /* vertex too close to pivot */

                    /* Clearance to each inner wall face (negative = already through) */
                    float cl_left  = vx_l - (-ai_cap);   /* to left arm inner  */
                    float cl_right = ai_cap  - vx_l;     /* to right arm inner */
                    float cl_back  = vy_l - (-bi_cap);   /* to back wall inner */

                    /* Only constrain if vertex is actually inside the dock channel */
                    float min_cl = 1e10f;
                    if (vx_l > -ai_cap)            min_cl = fminf(min_cl, cl_left);
                    if (vx_l <  ai_cap)            min_cl = fminf(min_cl, cl_right);
                    if (vy_l > -bi_cap && fabsf(vx_l) < ai_cap)
                                                   min_cl = fminf(min_cl, cl_back);

                    if (min_cl < 0.0f) min_cl = 0.0f;   /* already penetrating */

                    /* Max ω so arc < clearance in one tick */
                    float w_lim = min_cl / (R * dt_tick);
                    if (w_lim < omega_max) omega_max = w_lim;
                }

                /* Apply floor */
                if (omega_max < DOCK_OMEGA_FLOOR) omega_max = DOCK_OMEGA_FLOOR;

                /* Clamp and also apply extra drag so accumulated angular momentum
                 * bleeds off quickly while inside the dock */
                cur_w *= DOCK_ANGULAR_EXTRA_DRAG;
                if (cur_w >  omega_max) cur_w =  omega_max;
                if (cur_w < -omega_max) cur_w = -omega_max;
            }

            /* Store accumulated impulse into contact cache for next tick */
            {
                struct ContactEntry* ce_dock = contact_cache_upsert(
                    &global_sim->contact_cache, ship->id, dock_pseudo_id);
                ce_dock->last_tick = global_sim->tick;
                ce_dock->n_contacts = 3;
                for (int wi = 0; wi < 3; wi++) {
                    ce_dock->P_n[wi] = P_n[wi];
                    ce_dock->P_f[wi] = P_f[wi];
                }
            }

            /* Write back position */
            if (total_push_x * total_push_x + total_push_y * total_push_y > 0.0001f) {
                float new_wx, new_wy;
                dock_local_to_world(sy, lx, ly, &new_wx, &new_wy);
                ship->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_wx));
                ship->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_wy));
            }

            /* ── Rotational CCD ───────────────────────────────────────────
             *
             * Each hull vertex traces a circular arc as the ship rotates by
             * dθ = cur_w · dt over one tick.  We test every arc against every
             * dock wall segment.  If any intersection is found, we rewind cur_w
             * to the earliest safe angle and apply a bounce impulse.
             *
             * Arc–line-segment intersection:
             *   Vertex at angle θ in dock-local space:
             *     Vx(θ) = ox + R·cos(α + θ)
             *     Vy(θ) = oy + R·sin(α + θ)
             *   where (ox,oy) = ship center in dock-local, R = distance from
             *   center to vertex, α = initial angle of vertex from center.
             *
             *   Each wall is 4 line segments (edges of the AABB).  For a segment
             *   from P to Q, the arc crosses that line when the signed distance
             *   from V(θ) to the line changes sign.  We sample the arc at
             *   N_ARC_SAMPLES points and detect zero-crossings, then refine
             *   with bisection.
             *
             * Dock walls (3 AABBs → up to 12 segments, but only inner-facing
             * edges matter):
             *   Left arm inner:  x = -(DOCK_HW - DOCK_ARM_T) = -120, y ∈ [-445, +445]
             *   Right arm inner: x = +(DOCK_HW - DOCK_ARM_T) = +120, y ∈ [-445, +445]
             *   Back wall inner: y = -(DOCK_HH - DOCK_BACK_T) = -395, x ∈ [-120, +120]
             */
            {
                float dt_tick = 1.0f / (float)TICK_RATE_HZ;
                float dtheta = cur_w * dt_tick;

                /* Skip if angular displacement is negligible */
                if (fabsf(dtheta) > 1e-5f) {
                    /* Inner-facing wall segments in dock-local coords.
                     * Only the edges facing the interior can be hit by rotation. */
                    const float arm_inner = DOCK_HW - DOCK_ARM_T;  /* 120 */
                    const float back_inner = -(DOCK_HH - DOCK_BACK_T); /* -395 */
                    struct { float x0, y0, x1, y1; float nx, ny; } segs[] = {
                        /* Left arm inner edge (faces +x) */
                        { -arm_inner, -DOCK_HH, -arm_inner, +DOCK_HH,  1.0f, 0.0f },
                        /* Right arm inner edge (faces -x) */
                        {  arm_inner, -DOCK_HH,  arm_inner, +DOCK_HH, -1.0f, 0.0f },
                        /* Back wall inner edge (faces +y) */
                        { -arm_inner, back_inner, arm_inner, back_inner, 0.0f, 1.0f },
                    };
                    const int N_SEGS = 3;

                    /* Pre-compute per-vertex polar coords relative to ship center
                     * in dock-local space. */
                    float vR[64], vAlpha[64];
                    for (int vi = 0; vi < N; vi++) {
                        float vdx = hdx[vi] - lx, vdy = hdy[vi] - ly;
                        vR[vi] = sqrtf(vdx * vdx + vdy * vdy);
                        vAlpha[vi] = atan2f(vdy, vdx);
                    }

                    /* Current ship rotation in dock-local frame.
                     * ship_rad is in world; subtract dock rotation to get dock-local. */
                    float dock_rad = sy->rotation * (float)M_PI / 180.0f;
                    float local_rot_base = ship_rad - dock_rad;

                    /* Find earliest TOI across all vertices × all wall segments.
                     *
                     * For each vertex, its dock-local position at fractional time t ∈ [0,1]:
                     *   θ(t) = local_rot_base + dtheta·t   (but vertex angle is baked into vAlpha)
                     *   Vx(t) = lx + R·cos(vAlpha + dtheta·t)
                     *   Vy(t) = ly + R·sin(vAlpha + dtheta·t)
                     *
                     * For axis-aligned wall segments, intersection reduces to:
                     *   Vertical wall (x = wx): cos(vAlpha + dtheta·t) = (wx - lx) / R
                     *   Horizontal wall (y = wy): sin(vAlpha + dtheta·t) = (wy - ly) / R
                     * These have closed-form acos/asin solutions. */

                    float best_t = 2.0f;  /* >1 means no hit */
                    float best_nx = 0.0f, best_ny = 0.0f;
                    int best_vi = -1;  /* which vertex hit */

                    for (int vi = 0; vi < N; vi++) {
                        if (vR[vi] < 0.5f) continue;  /* vertex at center, can't reach wall */

                        for (int si = 0; si < N_SEGS; si++) {
                            float wnx = segs[si].nx, wny = segs[si].ny;

                            if (fabsf(wnx) > 0.5f) {
                                /* Vertical wall: x = segs[si].x0 */
                                float wx = segs[si].x0;
                                float y_lo = fminf(segs[si].y0, segs[si].y1);
                                float y_hi = fmaxf(segs[si].y0, segs[si].y1);

                                /* cos(vAlpha + dtheta·t) = (wx - lx) / R */
                                float cosval = (wx - lx) / vR[vi];
                                if (cosval < -1.0f || cosval > 1.0f) continue;

                                float target_angle = acosf(cosval);
                                /* Two solution branches: +(target) and -(target) */
                                float solutions[2] = { target_angle, -target_angle };

                                for (int sb = 0; sb < 2; sb++) {
                                    /* Solve: vAlpha[vi] + dtheta·t ≡ solutions[sb] (mod 2π)
                                     * t = (solutions[sb] - vAlpha[vi] + 2πk) / dtheta */
                                    float base_angle = solutions[sb] - vAlpha[vi];

                                    /* Try multiple wraps to find t ∈ (0, 1] */
                                    for (int k = -2; k <= 2; k++) {
                                        float angle = base_angle + (float)k * 2.0f * (float)M_PI;
                                        float t = angle / dtheta;
                                        if (t <= 1e-4f || t > 1.0f) continue;
                                        if (t >= best_t) continue;

                                        /* Check y is within segment bounds */
                                        float vy_at_t = ly + vR[vi] * sinf(vAlpha[vi] + dtheta * t);
                                        if (vy_at_t < y_lo || vy_at_t > y_hi) continue;

                                        best_t = t;
                                        best_nx = wnx;
                                        best_ny = wny;
                                        best_vi = vi;
                                    }
                                }
                            } else {
                                /* Horizontal wall: y = segs[si].y0 */
                                float wy = segs[si].y0;
                                float x_lo = fminf(segs[si].x0, segs[si].x1);
                                float x_hi = fmaxf(segs[si].x0, segs[si].x1);

                                /* sin(vAlpha + dtheta·t) = (wy - ly) / R */
                                float sinval = (wy - ly) / vR[vi];
                                if (sinval < -1.0f || sinval > 1.0f) continue;

                                float target_angle = asinf(sinval);
                                /* Two solution branches: target and π - target */
                                float solutions[2] = { target_angle, (float)M_PI - target_angle };

                                for (int sb = 0; sb < 2; sb++) {
                                    float base_angle = solutions[sb] - vAlpha[vi];

                                    for (int k = -2; k <= 2; k++) {
                                        float angle = base_angle + (float)k * 2.0f * (float)M_PI;
                                        float t = angle / dtheta;
                                        if (t <= 1e-4f || t > 1.0f) continue;
                                        if (t >= best_t) continue;

                                        /* Check x is within segment bounds */
                                        float vx_at_t = lx + vR[vi] * cosf(vAlpha[vi] + dtheta * t);
                                        if (vx_at_t < x_lo || vx_at_t > x_hi) continue;

                                        best_t = t;
                                        best_nx = wnx;
                                        best_ny = wny;
                                        best_vi = vi;
                                    }
                                }
                            }
                        }
                    }

                    if (best_t <= 1.0f && best_vi >= 0) {
                        /* Rewind angular velocity to just before impact */
                        float safe_t = fmaxf(best_t - 0.02f, 0.0f);
                        float safe_dtheta = dtheta * safe_t;
                        cur_w = safe_dtheta / dt_tick;

                        /* ── Proper rigid-body impulse at the CCD contact ──
                         *
                         * Compute the contact point (vertex position at TOI),
                         * lever arm, and contact velocity.  Then apply the same
                         * normal + friction impulse formulas used in the SAT
                         * solver, so rotation is damped physically. */

                        /* Contact point: vertex position at safe_t */
                        float cp_x = lx + vR[best_vi] * cosf(vAlpha[best_vi] + dtheta * safe_t);
                        float cp_y = ly + vR[best_vi] * sinf(vAlpha[best_vi] + dtheta * safe_t);

                        /* Lever arm from ship center to contact */
                        float rx = cp_x - lx, ry = cp_y - ly;

                        /* Contact velocity: v_cm + ω × r */
                        float vc_x = cur_vx + cur_w * (-ry);
                        float vc_y = cur_vy + cur_w * ( rx);
                        float vc_n = vc_x * best_nx + vc_y * best_ny;

                        /* ── Normal impulse ── */
                        float rxn = rx * best_ny - ry * best_nx;
                        float denom_n = inv_mass + rxn * rxn * inv_inertia;
                        if (denom_n > 1e-10f && vc_n < 0.0f) {
                            float Jn = -(1.0f + RESTITUTION) * vc_n / denom_n;
                            if (Jn < 0.0f) Jn = 0.0f;  /* only push, never pull */

                            cur_vx += Jn * best_nx * inv_mass;
                            cur_vy += Jn * best_ny * inv_mass;
                            cur_w  += rxn * Jn * inv_inertia;

                            /* ── Friction impulse (Coulomb) ── */
                            /* Re-sample velocity after normal impulse */
                            float vc_x2 = cur_vx + cur_w * (-ry);
                            float vc_y2 = cur_vy + cur_w * ( rx);
                            float vc_n2 = vc_x2 * best_nx + vc_y2 * best_ny;
                            float vt_x = vc_x2 - vc_n2 * best_nx;
                            float vt_y = vc_y2 - vc_n2 * best_ny;
                            float vt_len = sqrtf(vt_x * vt_x + vt_y * vt_y);
                            if (vt_len > 0.001f) {
                                float tx = vt_x / vt_len, ty = vt_y / vt_len;
                                float rxt = rx * ty - ry * tx;
                                float denom_t = inv_mass + rxt * rxt * inv_inertia;
                                if (denom_t > 1e-10f) {
                                    float Jf = -vt_len / denom_t;
                                    float Jf_max = WALL_FRICTION * Jn;
                                    if (Jf < -Jf_max) Jf = -Jf_max;
                                    if (Jf >  Jf_max) Jf =  Jf_max;
                                    cur_vx += Jf * tx * inv_mass;
                                    cur_vy += Jf * ty * inv_mass;
                                    cur_w  += rxt * Jf * inv_inertia;
                                }
                            }
                        }

                        /* Push the ship center slightly away from the wall
                         * to prevent resting vertex from sitting on the edge. */
                        lx += best_nx * 1.5f;
                        ly += best_ny * 1.5f;
                        for (int vi2 = 0; vi2 < N; vi2++) {
                            hdx[vi2] += best_nx * 1.5f;
                            hdy[vi2] += best_ny * 1.5f;
                        }
                        float cw_x, cw_y;
                        dock_local_to_world(sy, lx, ly, &cw_x, &cw_y);
                        ship->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cw_x));
                        ship->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cw_y));
                    }
                }
            }

            /* Write back velocity: apply the total velocity delta to the ship.
             * cur_v* - initial v* = accumulated effect of all iterations. */
            float dv_x = cur_vx - vx_dl, dv_y = cur_vy - vy_dl, domega = cur_w - omega;
            if (dv_x * dv_x + dv_y * dv_y > 1e-8f || fabsf(domega) > 1e-8f) {
                float dvw_x = dv_x * dc - dv_y * ds;
                float dvw_y = dv_x * ds + dv_y * dc;
                ship->velocity.x = Q16_FROM_FLOAT(Q16_TO_FLOAT(ship->velocity.x) + CLIENT_TO_SERVER(dvw_x));
                ship->velocity.y = Q16_FROM_FLOAT(Q16_TO_FLOAT(ship->velocity.y) + CLIENT_TO_SERVER(dvw_y));
                ship->angular_velocity = Q16_FROM_FLOAT(Q16_TO_FLOAT(ship->angular_velocity) + domega);
            }
        }
    }
}
