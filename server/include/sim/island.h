#pragma once
#include <math.h>
#include <stdbool.h>
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

#define ISLAND_MAX_RESOURCES 1024
#define ISLAND_MAX_COUNT     16
#define ISLAND_BUMP_COUNT    16
#define ISLAND_MAX_VERTS     64

/* Resource types — must match client-side IslandResource['type'] literals */
#define ISLAND_RES_WOOD  "wood"
#define ISLAND_RES_FIBER "fiber"
#define ISLAND_RES_FOOD  "food"
#define ISLAND_RES_ROCK  "rock"

typedef struct {
    float ox, oy;       /* Offset from island centre (world px) */
    const char *type;   /* ISLAND_RES_WOOD / ISLAND_RES_FIBER / ISLAND_RES_FOOD */
    float size;         /* Size scale: 0.5–1.8 (1.0 = default). Derived from hash of ox/oy. */
    int   health;       /* Current health */
    int   max_health;   /* Max health (set at init, depends on type) */
} IslandResource;

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
    float grass_poly_scale;             /* inner-grass polygon scale (e.g. 0.78) */
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

#define ISLAND_COUNT 2
extern IslandDef ISLAND_PRESETS[];

/**
 * Procedurally generate tree (wood resource) positions for all polygon
 * islands, filling their resource arrays with a grid+jitter pattern that
 * covers the entire grass polygon interior.  Call once at server startup
 * before any client connects.
 */
void islands_generate_trees(void);
