#pragma once
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
/**
 * Island definitions — static world features.
 *
 * Islands are fixed positions defined at server startup.
 * The server broadcasts them once to every client on connect via the ISLANDS message.
 * The client uses the preset name to pick visual parameters (beach colour, tree style, etc.)
 *
 * Coordinate note: x, y, beach_radius_px and grass_radius_px are all in CLIENT PIXELS,
 * matching SimpleShip.x/y and WebSocketPlayer.x/y.  Divide by WORLD_SCALE_FACTOR (10)
 * to get server/simulation units.
 *
 * Radii:
 *   beach_radius_px — base radius of the ship-collision boundary
 *   grass_radius_px — base radius of the player-walkable area
 *   beach_bumps[]   — per-vertex radial offsets (px); must match client ISLAND_PRESETS beachBumps
 *   grass_bumps[]   — per-vertex radial offsets (px); must match client ISLAND_PRESETS grassBumps
 *   beach_max_bump  — max(abs(beach_bumps)); used as broad-phase margin
 *   grass_max_bump  — max(abs(grass_bumps)); used as broad-phase margin
 */

#define ISLAND_MAX_RESOURCES 4096
#define ISLAND_MAX_COUNT     16
#define ISLAND_BUMP_COUNT    16
#define ISLAND_MAX_VERTS     128

/* Resource type enum — integer values used internally.
 * res_type_str() converts back to the string expected by the client. */
typedef enum { RES_WOOD = 0, RES_FIBER = 1, RES_ROCK = 2, RES_FOOD = 3 } ResType;

/* Convenience aliases matching old ISLAND_RES_* macro names */
#define ISLAND_RES_WOOD  RES_WOOD
#define ISLAND_RES_FIBER RES_FIBER
#define ISLAND_RES_FOOD  RES_FOOD
#define ISLAND_RES_ROCK  RES_ROCK

static inline const char *res_type_str(uint8_t t) {
    switch (t) {
        case RES_WOOD:  return "wood";
        case RES_FIBER: return "fiber";
        case RES_ROCK:  return "rock";
        default:        return "food";
    }
}

typedef struct {
    float   ox, oy;    /* Offset from island centre (world px) */
    uint8_t type_id;   /* ResType — RES_WOOD / RES_FIBER / RES_ROCK / RES_FOOD */
    float   size;      /* Size scale: 0.5–1.8 (1.0 = default). Derived from hash of ox/oy. */
    int     health;    /* Current health */
    int     max_health;/* Max health (set at init, depends on type) */
} IslandResource;

/* ── Spatial grid for wood (tree) nodes ─────────────────────────────────────
 * Built once by islands_build_grid() after islands_generate_trees().
 * Used by cannonball and player-collision loops for O(1) neighbourhood
 * lookup instead of scanning all resource_count nodes.
 *
 * Cell size is chosen to be 2× tree grid spacing so each cell holds ≤4 trees.
 * 32×32 covers a 10240×10240 px area — larger than any current island.
 */
#define ISLAND_GRID_CELL_PX  320.0f   /* must be >= TREE_GRID_SPACING */
#define ISLAND_GRID_COLS     32
#define ISLAND_GRID_ROWS     32
#define ISLAND_GRID_MAXPC    8        /* max wood-node indices stored per cell */

typedef struct {
    uint16_t ri[ISLAND_GRID_MAXPC]; /* indices into IslandDef.resources[] */
    uint8_t  count;
} IslandGridCell;

typedef struct {
    int            id;
    float          x, y;                           /* World-space centre (client px) */
    float          beach_radius_px;                /* Base ship-collision radius */
    float          grass_radius_px;                /* Base player-walkable radius */
    float          beach_bumps[ISLAND_BUMP_COUNT]; /* Radial offsets matching client beachBumps */
    float          grass_bumps[ISLAND_BUMP_COUNT]; /* Radial offsets matching client grassBumps */
    float          beach_max_bump;                 /* max(|beach_bumps|) — broad-phase margin */
    float          grass_max_bump;                 /* max(|grass_bumps|) — broad-phase margin */
    const char    *preset;                         /* Visual preset name sent to clients */
    IslandResource resources[ISLAND_MAX_RESOURCES];
    int            resource_count;

    /* ── Polygon island (vertex_count > 0 overrides bump-circle) ──────────
     * Vertices are offsets from (x, y) in world pixels.  When vertex_count
     * is nonzero the bump-circle fields (beach_radius_px etc.) are ignored
     * for player-walk and structure-placement checks.
     */
    int   vertex_count;                 /* 0 = bump-circle mode */
    float vx[ISLAND_MAX_VERTS];         /* vertex X offsets from centre (world px) */
    float vy[ISLAND_MAX_VERTS];         /* vertex Y offsets from centre (world px) */
    float poly_bound_r;                 /* broad-phase radius = max dist to vertex + margin */
    float grass_poly_scale;             /* legacy/metadata — no longer used for collision; explicit gvx/gvy always required */
    float shallow_poly_scale;           /* legacy/metadata — no longer used for collision; explicit svx/svy always required */

    /* Explicit grass polygon — when grass_vertex_count > 0 these override the
     * scale-based grass derivation for both server collision and client rendering. */
    int   grass_vertex_count;           /* 0 = no grass zone; explicit gvx/gvy required */
    float gvx[ISLAND_MAX_VERTS];        /* grass vertex X offsets from centre (world px) */
    float gvy[ISLAND_MAX_VERTS];        /* grass vertex Y offsets from centre (world px) */

    /* Explicit shallow water polygon — when shallow_vertex_count > 0 the shallow zone is
     * defined as: inside shallow polygon AND outside sand polygon.
     * 0 = no shallow zone for this island. */
    int   shallow_vertex_count;
    float svx[ISLAND_MAX_VERTS];        /* shallow water poly X offsets from centre (world px) */
    float svy[ISLAND_MAX_VERTS];        /* shallow water poly Y offsets from centre (world px) */

    /* ── Wood spatial grid (built by islands_build_grid) ─────────────────
     * grid_ox/oy = world-px of cell [0][0] corner.
     * Cell [row][col] covers X in [grid_ox + col*CELL, +CELL), same for Y. */
    IslandGridCell wood_grid[ISLAND_GRID_ROWS][ISLAND_GRID_COLS];
    float          grid_ox, grid_oy;  /* world px origin of the grid */
    int            grid_w,  grid_h;   /* active column and row count */

    /* ── Alive wood index list ────────────────────────────────────────────
     * Shrinks as trees are destroyed; maintained by island_mark_tree_dead(). */
    uint16_t alive_wood[ISLAND_MAX_RESOURCES];
    int      alive_wood_count;
} IslandDef;

/**
 * Sample the bumpy boundary radius at a given angle (radians).
 * Uses linear interpolation between adjacent bump vertices.
 * base_r + bumps[] are all in client pixels.
 */
static inline float island_boundary_r(
    float base_r, const float *bumps, float angle)
{
    /* Normalise angle to [0, 2π) */
    const float TWO_PI = 6.2831853f;
    angle = angle - TWO_PI * floorf(angle / TWO_PI);
    float t  = angle / TWO_PI * ISLAND_BUMP_COUNT;
    int   i0 = (int)t % ISLAND_BUMP_COUNT;
    int   i1 = (i0 + 1) % ISLAND_BUMP_COUNT;
    float f  = t - (int)t;
    return base_r + bumps[i0] + f * (bumps[i1] - bumps[i0]);
}

/**
 * Ray-cast point-in-polygon test for polygon-mode islands.
 * px, py are world-space coordinates (client pixels).
 * Returns true if the point lies inside the beach polygon.
 */
static inline bool island_poly_contains(
    const IslandDef *isl, float px, float py)
{
    int   n  = isl->vertex_count;
    bool  inside = false;
    float rx = px - isl->x;   /* relative to island centre */
    float ry = py - isl->y;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = isl->vx[i], yi = isl->vy[i];
        float xj = isl->vx[j], yj = isl->vy[j];
        if (((yi > ry) != (yj > ry)) &&
            (rx < (xj - xi) * (ry - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}

/**
 * For a point (px,py) KNOWN TO BE INSIDE the beach polygon, find the
 * nearest exit — the edge with the shallowest penetration depth.
 *
 * Vertices are traced CLOCKWISE in screen-space (y-down).  The outward
 * normal for edge i→j is therefore (ey/len, -ex/len).
 *
 * Returns true and writes *out_nx,*out_ny (unit outward normal) and
 * *out_depth (penetration in client pixels).
 * Returns false only if the polygon has no valid edges (shouldn't happen).
 */
static inline bool island_poly_pushout(
    const IslandDef *isl, float px, float py,
    float *out_nx, float *out_ny, float *out_depth)
{
    int   n      = isl->vertex_count;
    float rx     = px - isl->x;   /* relative to island centre */
    float ry     = py - isl->y;
    float min_pen = 1e30f;
    *out_nx = 1.0f; *out_ny = 0.0f; *out_depth = 0.0f;
    bool found = false;

    for (int i = 0; i < n; i++) {
        int   j  = (i + 1) % n;
        float ex = isl->vx[j] - isl->vx[i];
        float ey = isl->vy[j] - isl->vy[i];
        float len = sqrtf(ex*ex + ey*ey);
        if (len < 0.001f) continue;
        /* Outward normal for CW winding in y-down space */
        float nx =  ey / len;
        float ny = -ex / len;
        /* Signed distance: positive = outside this edge */
        float d = nx * (rx - isl->vx[i]) + ny * (ry - isl->vy[i]);
        if (d >= 0.0f) continue;  /* concave inward edge or already outside — skip */
        float pen = -d;
        if (pen < min_pen) {
            min_pen   = pen;
            *out_nx   = nx;
            *out_ny   = ny;
            found     = true;
        }
    }
    if (found) *out_depth = min_pen;
    return found;
}

/* ── World island list (server-authoritative) ───────────────────────────── *
 * Defined in server/src/sim/island_data.c so that islands_generate_trees()  *
 * can populate tree positions at startup without const restrictions.          */

#define ISLAND_COUNT 3
extern IslandDef ISLAND_PRESETS[];

/** Shallow-water ring width as a multiple of the island's own radius.
 *  e.g. 1.5 → a 185 px beach island gets ~278 px of shallow water. */
#define SHALLOW_WATER_SCALE 0.375f

/**
 * Minimum distance from point (px, py) to any edge of the island's sand polygon.
 * Only valid when isl->vertex_count > 0.
 */
static inline float island_poly_edge_dist(const IslandDef *isl, float px, float py) {
    float min_dist = 1e30f;
    int n = isl->vertex_count;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float ax = isl->x + isl->vx[j], ay = isl->y + isl->vy[j];
        float bx = isl->x + isl->vx[i], by = isl->y + isl->vy[i];
        float ex = bx - ax, ey = by - ay;
        float len2 = ex * ex + ey * ey;
        float t = len2 > 0.0f ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0.0f;
        if (t < 0.0f) t = 0.0f; else if (t > 1.0f) t = 1.0f;
        float cx = ax + t * ex - px, cy = ay + t * ey - py;
        float d = sqrtf(cx * cx + cy * cy);
        if (d < min_dist) min_dist = d;
    }
    return min_dist;
}

/**
 * Point-in-polygon test for the explicit shallow water polygon (svx/svy).
 * Only valid when isl->shallow_vertex_count > 0.
 */
static inline bool island_shallow_poly_contains(const IslandDef *isl, float px, float py) {
    int n = isl->shallow_vertex_count;
    int inside = 0;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = isl->x + isl->svx[i], yi = isl->y + isl->svy[i];
        float xj = isl->x + isl->svx[j], yj = isl->y + isl->svy[j];
        if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            inside = !inside;
    }
    return inside != 0;
}

/**
 * Returns true if (px, py) is in the shallow-water zone of the given island:
 *   - outside the island's beach boundary, AND
 *   - within (island_radius * SHALLOW_WATER_SCALE) of that boundary.
 * px, py are world coordinates in CLIENT pixels.
 */
static inline bool island_in_shallow_water(const IslandDef *isl, float px, float py) {
    float dx = px - isl->x, dy = py - isl->y;
    float dist_sq = dx * dx + dy * dy;

    if (isl->vertex_count > 0) {
        if (isl->shallow_vertex_count > 0) {
            /* Explicit shallow polygon — compute its broad-phase bound */
            float shallow_bound_r = 0.0f;
            for (int vi = 0; vi < isl->shallow_vertex_count; vi++) {
                float r = sqrtf(isl->svx[vi]*isl->svx[vi] + isl->svy[vi]*isl->svy[vi]);
                if (r > shallow_bound_r) shallow_bound_r = r;
            }
            if (dist_sq > shallow_bound_r * shallow_bound_r) return false;
            if (island_poly_contains(isl, px, py)) return false;
            return island_shallow_poly_contains(isl, px, py);
        }
        /* No explicit shallow polygon — no shallow zone for this island */
        return false;
    } else {
        float shallow_depth = isl->beach_radius_px * SHALLOW_WATER_SCALE;
        float broad_outer = isl->beach_radius_px + isl->beach_max_bump + shallow_depth;
        if (dist_sq > broad_outer * broad_outer) return false;
        float angle   = atan2f(dy, dx);
        float beach_r = island_boundary_r(isl->beach_radius_px, isl->beach_bumps, angle);
        float dist    = sqrtf(dist_sq);
        return (dist > beach_r) && (dist < beach_r + shallow_depth);
    }
}

/**
 * Returns a value in [0, 1] representing how deep inside the shallow-water
 * zone (px, py) is:
 *   0.0 = at or beyond the outer edge (no extra drag)
 *   1.0 = right at the island beach boundary (maximum extra drag)
 * Returns 0.0 when outside the shallow zone or inside the island.
 * For polygon islands the gradient follows the polygon edge (not a circle).
 */
static inline float island_shallow_water_depth(const IslandDef *isl, float px, float py) {
    float dx = px - isl->x, dy = py - isl->y;
    float dist_sq = dx * dx + dy * dy;

    if (isl->vertex_count > 0) {
        if (isl->shallow_vertex_count > 0) {
            /* Explicit shallow polygon broad-phase */
            float shallow_bound_r = 0.0f;
            for (int vi = 0; vi < isl->shallow_vertex_count; vi++) {
                float r = sqrtf(isl->svx[vi]*isl->svx[vi] + isl->svy[vi]*isl->svy[vi]);
                if (r > shallow_bound_r) shallow_bound_r = r;
            }
            if (dist_sq > shallow_bound_r * shallow_bound_r) return 0.0f;
            if (island_poly_contains(isl, px, py)) return 0.0f;
            if (!island_shallow_poly_contains(isl, px, py)) return 0.0f;
            /* Gradient: 1.0 at sand edge, 0.0 at shallow boundary */
            float edge_dist = island_poly_edge_dist(isl, px, py);
            float shallow_depth = shallow_bound_r - isl->poly_bound_r;
            if (shallow_depth <= 0.0f || edge_dist >= shallow_depth) return 0.0f;
            float t = 1.0f - edge_dist / shallow_depth;
            return (t > 1.0f) ? 1.0f : t;
        }
        /* No explicit shallow polygon — no shallow zone for this island */
        return 0.0f;
    } else {
        float shallow_depth = isl->beach_radius_px * SHALLOW_WATER_SCALE;
        float broad_outer = isl->beach_radius_px + isl->beach_max_bump + shallow_depth;
        if (dist_sq > broad_outer * broad_outer) return 0.0f;
        float angle   = atan2f(dy, dx);
        float beach_r = island_boundary_r(isl->beach_radius_px, isl->beach_bumps, angle);
        float dist    = sqrtf(dist_sq);
        if (dist <= beach_r || dist >= beach_r + shallow_depth) return 0.0f;
        float t = 1.0f - (dist - beach_r) / shallow_depth;
        return (t < 0.0f) ? 0.0f : (t > 1.0f ? 1.0f : t);
    }
}

/**
 * Load island polygon data (sand/grass/shallow vertices, centre) from JSON
 * files in the given directory.  File names must be island_<id>.json.
 * Call once at server startup BEFORE islands_generate_trees().
 * Islands without a matching file keep their compiled-in data.
 */
void islands_load_from_files(const char *dir);

/**
 * Procedurally generate tree (wood resource) positions for all polygon
 * islands, filling their resource arrays with a grid+jitter pattern that
 * covers the entire grass polygon interior.  Call once at server startup
 * before any client connects.
 */
void islands_generate_trees(void);

/**
 * Build the spatial wood grid and alive_wood list for all islands.
 * Must be called once after islands_generate_trees() completes.
 */
void islands_build_grid(void);

/**
 * Remove a wood node from the alive_wood list and from the spatial grid.
 * Call whenever a tree's health reaches zero.
 * @param isl  The island that owns the resource.
 * @param ri   Index into isl->resources[].
 */
void island_mark_tree_dead(IslandDef *isl, int ri);

/**
 * Returns true if the resource at (rx, ry) is allowed to respawn.
 * A resource is suppressed when any active structure lies within
 * RESPAWN_SUPPRESS_R world-pixels of it — e.g. a player has built over
 * the cleared stump.
 *
 * structs      : pointer to the PlacedStructure array (websocket_server.c)
 * struct_count : number of entries (active + inactive)
 */
#include "net/websocket_server.h"  /* PlacedStructure */
bool island_resource_can_respawn(float rx, float ry,
                                 const PlacedStructure *structs,
                                 uint32_t struct_count);
