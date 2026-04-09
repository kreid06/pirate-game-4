#pragma once
#include <math.h>
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

#define ISLAND_MAX_RESOURCES 16
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

/* ── World island list (server-authoritative) ───────────────────────────── */

static const IslandDef ISLAND_PRESETS[] = {
    {
        .id              = 1,
        .x               = 800.0f,
        .y               = 600.0f,
        .beach_radius_px = 185.0f,
        .grass_radius_px = 148.0f,
        /* Mirror of client RenderSystem.ISLAND_PRESETS['tropical'].beachBumps */
        .beach_bumps     = { 0, 14, -9, 20,  6, -13, 16,  3, -7, 18, -5, 10, 12, -11,  7, -9 },
        .beach_max_bump  = 20.0f,
        /* Mirror of client RenderSystem.ISLAND_PRESETS['tropical'].grassBumps */
        .grass_bumps     = { 0,  9, -6, 13,  4,  -9, 10,  2, -4, 11, -3,  7,  8,  -7,  5, -6 },
        .grass_max_bump  = 13.0f,
        .preset          = "tropical",
        .resource_count  = 10,
        .resources = {
            { .ox = -65.0f, .oy = -55.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  85.0f, .oy = -25.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  15.0f, .oy =  80.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -90.0f, .oy =  38.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  45.0f, .oy = -78.0f, .type = ISLAND_RES_FIBER },
            { .ox = -28.0f, .oy =  32.0f, .type = ISLAND_RES_FIBER },
            { .ox =  70.0f, .oy =  50.0f, .type = ISLAND_RES_FIBER },
            { .ox =  -5.0f, .oy = -90.0f, .type = ISLAND_RES_ROCK  },
            { .ox =  60.0f, .oy =  75.0f, .type = ISLAND_RES_ROCK  },
            { .ox = -75.0f, .oy = -15.0f, .type = ISLAND_RES_ROCK  },
        },
    },
    {
        /* ── Giant continental landmass ─────────────────────────────────────
         * Roughly oval with a small southern bay.  ~6200 px wide × 6100 px
         * tall, area ≈ 25,000,000 sq px (5000 × 5000 units).
         * Centre at world (6000, 5000); polygon vertices are WORLD coords
         * (absolute, not offsets) emitted to the client.
         * Vertex offsets from centre traced clockwise from north.
         */
        .id               = 2,
        .x                = 6000.0f,
        .y                = 5000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        /* 28-vertex coastline.  C zero-fills remaining vx/vy slots. */
        .vertex_count     = 28,
        .poly_bound_r     = 3300.0f,
        .grass_poly_scale = 0.82f,
        /*            N      NNE    NE     ENE    E-NE   E-near  E      ESE  */
        .vx = {     0,  800, 1600, 2300, 2750, 2950, 3100, 2900,
        /*          SE     SSE    S-SE   S      S-bay  bay-in bay-fl bay-in */
                 2550, 1950, 1250,  500,  250,  100,    0, -100,
        /*         bay-ex SW-S   SW     WSW    W-SW   W-near W      WNW  */
                 -350,-1050,-1850,-2450,-2850,-2950,-3100,-2900,
        /*          NW     NNW    N-NW   N-near  */
                -2550,-1950,-1250, -500 },
        /*            N      NNE    NE     ENE    E-NE   E-near  E      ESE  */
        .vy = {  -3000,-2850,-2650,-2250,-1450, -500,  400, 1200,
        /*          SE     SSE    S-SE   S      S-bay  bay-in bay-fl bay-in */
                  2050, 2600, 2900, 3050, 2450, 1850, 1650, 1850,
        /*         bay-ex SW-S   SW     WSW    W-SW   W-near W      WNW  */
                  2450, 2950, 2650, 2150, 1450,  500, -400,-1250,
        /*          NW     NNW    N-NW   N-near  */
                 -2050,-2550,-2800,-2950 },
        .resource_count   = 16,
        .resources = {
            /* Wood — 8 forest clusters across the interior */
            { .ox = -1500.0f, .oy = -1800.0f, .type = ISLAND_RES_WOOD  },
            { .ox =   500.0f, .oy = -2400.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  1800.0f, .oy = -1800.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  2200.0f, .oy =   300.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  1600.0f, .oy =  1800.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -1200.0f, .oy =  1500.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -2100.0f, .oy =   800.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -2000.0f, .oy = -1200.0f, .type = ISLAND_RES_WOOD  },
            /* Fiber — 4 meadow patches */
            { .ox =  -800.0f, .oy = -1000.0f, .type = ISLAND_RES_FIBER },
            { .ox =  1000.0f, .oy = -1000.0f, .type = ISLAND_RES_FIBER },
            { .ox =  1200.0f, .oy =  1000.0f, .type = ISLAND_RES_FIBER },
            { .ox = -1500.0f, .oy =  -400.0f, .type = ISLAND_RES_FIBER },
            /* Rock — 4 mountain outcrops near the edges */
            { .ox = -2500.0f, .oy = -1600.0f, .type = ISLAND_RES_ROCK  },
            { .ox =  2500.0f, .oy = -1000.0f, .type = ISLAND_RES_ROCK  },
            { .ox =  2400.0f, .oy =  1600.0f, .type = ISLAND_RES_ROCK  },
            { .ox = -2500.0f, .oy =  1400.0f, .type = ISLAND_RES_ROCK  },
        },
    },
};

#define ISLAND_COUNT ((int)(sizeof(ISLAND_PRESETS) / sizeof(ISLAND_PRESETS[0])))
