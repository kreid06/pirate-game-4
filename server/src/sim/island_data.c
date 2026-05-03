/**
 * island_data.c — Mutable island definitions and procedural tree generation.
 *
 * Kept in a .c file (not the header) so that islands_generate_trees() can
 * populate wood-resource positions at server startup without fighting const.
 *
 * Tree coverage: every polygon island whose grass_poly_scale > 0 gets a
 * regular grid of trees (spacing TREE_GRID_SPACING px) with per-tree random
 * jitter.  Only grid points that fall inside the scaled grass polygon are
 * accepted.  Non-wood resources (fiber, rock) are defined statically below
 * and are NOT overwritten by this function.
 */

#define _GNU_SOURCE
#include "sim/island.h"
#include "net/websocket_server.h"  /* PlacedStructure — needed for island_resource_can_respawn */
#include "util/log.h"
#include <string.h>
#include <math.h>
#include <stdbool.h>

/* ── Island data ─────────────────────────────────────────────────────────── */

IslandDef ISLAND_PRESETS[ISLAND_COUNT] = {
    /* ── Island 1: Tropical bump-circle island ─────────────────────────── */
    {
        .id              = 1,
        .x               = 9000.0f,
        .y               = 62000.0f,
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
            { .ox = -65.0f, .oy = -55.0f, .type_id = RES_WOOD  },
            { .ox =  85.0f, .oy = -25.0f, .type_id = RES_WOOD  },
            { .ox =  15.0f, .oy =  80.0f, .type_id = RES_WOOD  },
            { .ox = -90.0f, .oy =  38.0f, .type_id = RES_WOOD  },
            { .ox =  45.0f, .oy = -78.0f, .type_id = RES_FIBER },
            { .ox = -28.0f, .oy =  32.0f, .type_id = RES_FIBER },
            { .ox =  70.0f, .oy =  50.0f, .type_id = RES_FIBER },
            { .ox =  -5.0f, .oy = -90.0f, .type_id = RES_ROCK  },
            { .ox =  60.0f, .oy =  75.0f, .type_id = RES_ROCK  },
            { .ox = -75.0f, .oy = -15.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 2: Giant continental landmass ──────────────────────────── *
     * Shape vertices come from templates/continental.json at startup.       */
    {
        .id              = 2,
        .x               = 9000.0f,
        .y               = 52000.0f,
        .preset          = "continental",
        .resource_count  = 8,
        .resources = {
            { .ox =  -800.0f, .oy = -1000.0f, .type_id = RES_FIBER },
            { .ox =  1000.0f, .oy = -1000.0f, .type_id = RES_FIBER },
            { .ox =  1200.0f, .oy =  1000.0f, .type_id = RES_FIBER },
            { .ox = -1500.0f, .oy =  -400.0f, .type_id = RES_FIBER },
            { .ox = -2500.0f, .oy = -1600.0f, .type_id = RES_ROCK  },
            { .ox =  2500.0f, .oy = -1000.0f, .type_id = RES_ROCK  },
            { .ox =  2400.0f, .oy =  1600.0f, .type_id = RES_ROCK  },
            { .ox = -2500.0f, .oy =  1400.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 3: Crescent (horseshoe) — Combat Cove / Smuggler Cove ──────
     * Shape vertices come from templates/crescent.json at startup.          */
    {
        .id               = 3,
        .x                = 79000.0f,
        .y                = 68000.0f,
        .preset           = "continental",
        .resource_count = 10,
        .resources = {
            { .ox = -3800.0f, .oy = -2000.0f, .type_id = RES_ROCK  },
            { .ox =  3500.0f, .oy = -1200.0f, .type_id = RES_ROCK  },
            { .ox = -2500.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox =  2200.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox = -3000.0f, .oy =  -800.0f, .type_id = RES_FIBER },
            { .ox =  2000.0f, .oy =  -600.0f, .type_id = RES_FIBER },
            { .ox = -1000.0f, .oy = -2000.0f, .type_id = RES_FIBER },
            { .ox =  -200.0f, .oy = -2500.0f, .type_id = RES_FIBER },
            { .ox = -3200.0f, .oy =  1600.0f, .type_id = RES_FIBER },
            { .ox =  2800.0f, .oy =  1500.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 4: Crescent — inherits template island 3, rotated 47° ──────
     * World centre (16000, 15000). Shape + biome polys copied from island 3
     * at startup, then rotated 47° by islands_apply_rotations(). */
    {
        .id               = 4,
        .x                = 16000.0f,
        .y                = 15000.0f,
        .preset           = "continental",
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .resource_count = 10,
        .resources = {
            { .ox = -3800.0f, .oy = -2000.0f, .type_id = RES_ROCK  },
            { .ox =  3500.0f, .oy = -1200.0f, .type_id = RES_ROCK  },
            { .ox = -2500.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox =  2200.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox = -3000.0f, .oy =  -800.0f, .type_id = RES_FIBER },
            { .ox =  2000.0f, .oy =  -600.0f, .type_id = RES_FIBER },
            { .ox = -1000.0f, .oy = -2000.0f, .type_id = RES_FIBER },
            { .ox =  -200.0f, .oy = -2500.0f, .type_id = RES_FIBER },
            { .ox = -3200.0f, .oy =  1600.0f, .type_id = RES_FIBER },
            { .ox =  2800.0f, .oy =  1500.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 5: Crescent — inherits template island 3, rotated 163° ─────
     * World centre (75000, 23000). Shape + biome polys copied from island 3
     * at startup, then rotated 163° by islands_apply_rotations(). */
    {
        .id               = 5,
        .x                = 75000.0f,
        .y                = 23000.0f,
        .preset           = "continental",
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .resource_count = 10,
        .resources = {
            { .ox = -3800.0f, .oy = -2000.0f, .type_id = RES_ROCK  },
            { .ox =  3500.0f, .oy = -1200.0f, .type_id = RES_ROCK  },
            { .ox = -2500.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox =  2200.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox = -3000.0f, .oy =  -800.0f, .type_id = RES_FIBER },
            { .ox =  2000.0f, .oy =  -600.0f, .type_id = RES_FIBER },
            { .ox = -1000.0f, .oy = -2000.0f, .type_id = RES_FIBER },
            { .ox =  -200.0f, .oy = -2500.0f, .type_id = RES_FIBER },
            { .ox = -3200.0f, .oy =  1600.0f, .type_id = RES_FIBER },
            { .ox =  2800.0f, .oy =  1500.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 6: Crescent — inherits template island 3, rotated 251° ─────
     * World centre (11000, 78000). Shape + biome polys copied from island 3
     * at startup, then rotated 251° by islands_apply_rotations(). */
    {
        .id               = 6,
        .x                = 11000.0f,
        .y                = 78000.0f,
        .preset           = "continental",
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .resource_count = 10,
        .resources = {
            { .ox = -3800.0f, .oy = -2000.0f, .type_id = RES_ROCK  },
            { .ox =  3500.0f, .oy = -1200.0f, .type_id = RES_ROCK  },
            { .ox = -2500.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox =  2200.0f, .oy =  2800.0f, .type_id = RES_ROCK  },
            { .ox = -3000.0f, .oy =  -800.0f, .type_id = RES_FIBER },
            { .ox =  2000.0f, .oy =  -600.0f, .type_id = RES_FIBER },
            { .ox = -1000.0f, .oy = -2000.0f, .type_id = RES_FIBER },
            { .ox =  -200.0f, .oy = -2500.0f, .type_id = RES_FIBER },
            { .ox = -3200.0f, .oy =  1600.0f, .type_id = RES_FIBER },
            { .ox =  2800.0f, .oy =  1500.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 7: Continental — rotated 78° ────────────────────────────────
     * Shape vertices come from templates/continental.json at startup.       */
    {
        .id               = 7,
        .x                = 82000.0f,
        .y                = 45000.0f,
        .preset           = "continental",
        .resource_count = 4,
        .resources = {
            { .ox =   -636.0f, .oy = -2899.0f, .type_id = RES_ROCK  },
            { .ox =   2475.0f, .oy =  1061.0f, .type_id = RES_ROCK  },
            { .ox =    566.0f, .oy =  2828.0f, .type_id = RES_ROCK  },
            { .ox =  -2758.0f, .oy =  -778.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 8: Continental — rotated 197° ────────────────────────────────
     * Shape vertices come from templates/continental.json at startup.       */
    {
        .id               = 8,
        .x                = 48000.0f,
        .y                = 82000.0f,
        .preset           = "continental",
        .resource_count = 4,
        .resources = {
            { .ox =  -2500.0f, .oy = -1600.0f, .type_id = RES_ROCK  },
            { .ox =   2500.0f, .oy = -1000.0f, .type_id = RES_ROCK  },
            { .ox =   2400.0f, .oy =  1600.0f, .type_id = RES_ROCK  },
            { .ox =  -2500.0f, .oy =  1400.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 9: Continental — rotated 324° ────────────────────────────────
     * Shape vertices come from templates/continental.json at startup.       */
    {
        .id               = 9,
        .x                = 45000.0f,
        .y                = 11000.0f,
        .preset           = "continental",
        .resource_count = 4,
        .resources = {
            { .ox =  -2500.0f, .oy = -1600.0f, .type_id = RES_ROCK  },
            { .ox =   2500.0f, .oy = -1000.0f, .type_id = RES_ROCK  },
            { .ox =   2400.0f, .oy =  1600.0f, .type_id = RES_ROCK  },
            { .ox =  -2500.0f, .oy =  1400.0f, .type_id = RES_ROCK  },
        },
    },
};

/* ── Tree generation ─────────────────────────────────────────────────────── */

/* Grid spacing between trees (client pixels). */
#define TREE_GRID_SPACING 160.0f
/* Half-amplitude of per-tree random jitter (client pixels). */
#define TREE_JITTER       40.0f

/* Fiber-plant procedural density settings.
   Spacing = TREE_GRID_SPACING / sqrt(2) ≈ 113 px gives ~2× more fiber than trees. */
#define FIBER_GRID_SPACING 113.0f
#define FIBER_JITTER        30.0f
/* Fiber is scattered over a slightly smaller polygon fraction to keep it
   interior and away from the rocky/treed edges. */
#define FIBER_POLY_SCALE    0.70f

/* Rock procedural density settings.
   On grass:  spacing = 160/sqrt(0.5) ≈ 226 px → ~50% of tree count.
   On sand:   spacing = 160 px → ~100% of tree count (matches tree density). */
#define ROCK_GRASS_SPACING 226.0f
#define ROCK_SAND_SPACING  226.0f
#define ROCK_JITTER         40.0f

/* Boulder procedural density settings.
   1:10 ratio to trees → spacing = TREE_GRID_SPACING * sqrt(10) ≈ 506 px.
   Spawns on both grass and sand. */
#define BOULDER_SPACING    506.0f
#define BOULDER_JITTER      60.0f

/**
 * Returns non-zero if world point (px, py) lies inside the scaled grass
 * polygon of the island (ray-cast even–odd rule).
 */
static int inside_grass_poly(const IslandDef *isl, float px, float py)
{
    if (isl->grass_vertex_count == 0) return 0;

    int inside = 0;
    int n = isl->grass_vertex_count;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = isl->x + isl->gvx[i];
        float yi = isl->y + isl->gvy[i];
        float xj = isl->x + isl->gvx[j];
        float yj = isl->y + isl->gvy[j];
        if ((yi > py) != (yj > py) &&
            px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            inside = !inside;
    }
    return inside;
}

/**
 * Returns non-zero if world point (px, py) lies inside the sand (outer)
 * polygon of the island (ray-cast even–odd rule, uses vx/vy).
 */
static int inside_sand_poly(const IslandDef *isl, float px, float py)
{
    if (isl->vertex_count == 0) return 0;
    int inside = 0;
    int n = isl->vertex_count;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = isl->x + isl->vx[i];
        float yi = isl->y + isl->vy[i];
        float xj = isl->x + isl->vx[j];
        float yj = isl->y + isl->vy[j];
        if ((yi > py) != (yj > py) &&
            px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            inside = !inside;
    }
    return inside;
}


/*
 * Derives a deterministic size scale [0.5, 1.8] from a resource's ox/oy.
 * Matches the JavaScript hash used by the client for visual consistency.
 */
static float resource_size_from_offset(float ox, float oy)
{
    unsigned int h  = ((unsigned int)(int)ox * 2654435761u) ^ ((unsigned int)(int)oy * 1664525u);
    unsigned int h2 = (h * 2246822519u) ^ ((h >> 13) * 2654435761u);
    (void)h2;
    return 0.5f + ((float)(h & 0xFFu) / 255.0f) * 1.3f;
}

static int resource_max_health(uint8_t type_id)
{
    switch (type_id) {
        case RES_WOOD:    return 100;
        case RES_ROCK:    return  60;
        case RES_BOULDER: return 400;
        case RES_FIBER:   return  30;
        default:          return  50;
    }
}

/* Apply size + health to every pre-defined resource in ISLAND_PRESETS[]. */
static void init_static_resource_fields(void)
{
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];
        for (int ri = 0; ri < isl->resource_count; ri++) {
            IslandResource *r = &isl->resources[ri];
            r->size       = resource_size_from_offset(r->ox, r->oy);
            r->max_health = resource_max_health(r->type_id);
            r->health     = r->max_health;
        }
    }
}

/**
 * Rotate vertex arrays (vx/vy, gvx/gvy, svx/svy) in-place for every island
 * whose rotation_deg field is nonzero.  Must be called once at startup AFTER
 * islands_load_from_files() and BEFORE islands_generate_trees().
 */
void islands_apply_rotations(void)
{
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];
        if (isl->rotation_deg == 0.0f) continue;

        float rad = isl->rotation_deg * ((float)M_PI / 180.0f);
        float c = cosf(rad), s = sinf(rad);

        for (int i = 0; i < isl->vertex_count; i++) {
            float x = isl->vx[i], y = isl->vy[i];
            isl->vx[i] = x * c - y * s;
            isl->vy[i] = x * s + y * c;
        }
        for (int i = 0; i < isl->grass_vertex_count; i++) {
            float x = isl->gvx[i], y = isl->gvy[i];
            isl->gvx[i] = x * c - y * s;
            isl->gvy[i] = x * s + y * c;
        }
        for (int i = 0; i < isl->shallow_vertex_count; i++) {
            float x = isl->svx[i], y = isl->svy[i];
            isl->svx[i] = x * c - y * s;
            isl->svy[i] = x * s + y * c;
        }
        /* Also rotate stone/metal biome polygons loaded from JSON */
        for (int pi = 0; pi < isl->stone_poly_count; pi++) {
            for (int i = 0; i < isl->stone_vc[pi]; i++) {
                float x = isl->stone_vx[pi][i], y = isl->stone_vy[pi][i];
                isl->stone_vx[pi][i] = x * c - y * s;
                isl->stone_vy[pi][i] = x * s + y * c;
            }
        }
        for (int pi = 0; pi < isl->metal_poly_count; pi++) {
            for (int i = 0; i < isl->metal_vc[pi]; i++) {
                float x = isl->metal_vx[pi][i], y = isl->metal_vy[pi][i];
                isl->metal_vx[pi][i] = x * c - y * s;
                isl->metal_vy[pi][i] = x * s + y * c;
            }
        }
    }
}

/* ── Zone resource generation ─────────────────────────────────────────────
 * Stone zones → RES_ROCK;  metal zones → RES_BOULDER.
 * Grid + jitter placement inside each zone polygon.
 */
#define STONE_ZONE_SPACING 300.0f  /* grid spacing (px) for stone nodes */
#define STONE_ZONE_JITTER  80.0f   /* max per-axis jitter */
#define METAL_ZONE_SPACING 173.0f  /* grid spacing (px) for metal/boulder nodes — ~3x area density vs stone */
#define METAL_ZONE_JITTER   35.0f

/** Ray-cast even-odd point-in-polygon for a biome poly (local offsets + island centre). */
static int inside_biome_poly(float cx, float cy,
                              const float *vx, const float *vy, int count,
                              float px, float py)
{
    if (count < 3) return 0;
    int inside = 0;
    for (int i = 0, j = count - 1; i < count; j = i++) {
        float xi = cx + vx[i], yi = cy + vy[i];
        float xj = cx + vx[j], yj = cy + vy[j];
        if ((yi > py) != (yj > py) &&
            px < (xj - xi) * (py - yi) / (yj - yi) + xi)
            inside = !inside;
    }
    return inside;
}

/** Returns non-zero if (px, py) is inside ANY stone or metal biome polygon. */
static int inside_any_stone_metal_biome(const IslandDef *isl, float px, float py)
{
    for (int pi = 0; pi < isl->stone_poly_count; pi++) {
        if (inside_biome_poly(isl->x, isl->y,
                              isl->stone_vx[pi], isl->stone_vy[pi],
                              isl->stone_vc[pi], px, py)) return 1;
    }
    for (int pi = 0; pi < isl->metal_poly_count; pi++) {
        if (inside_biome_poly(isl->x, isl->y,
                              isl->metal_vx[pi], isl->metal_vy[pi],
                              isl->metal_vc[pi], px, py)) return 1;
    }
    return 0;
}

/** Bounding box (world px) of a biome polygon. */
static void biome_bbox(float cx, float cy,
                       const float *vx, const float *vy, int count,
                       float *x0, float *y0, float *x1, float *y1)
{
    *x0 = *y0 =  1e30f;
    *x1 = *y1 = -1e30f;
    for (int i = 0; i < count; i++) {
        float wx = cx + vx[i], wy = cy + vy[i];
        if (wx < *x0) *x0 = wx;  if (wx > *x1) *x1 = wx;
        if (wy < *y0) *y0 = wy;  if (wy > *y1) *y1 = wy;
    }
}

void islands_generate_zone_resources(void)
{
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];

        /* ── Stone biome → RES_ROCK ────────────────────────────────── */
        for (int pi = 0; pi < isl->stone_poly_count; pi++) {
            if (isl->stone_vc[pi] < 3) continue;
            float bx0, by0, bx1, by1;
            biome_bbox(isl->x, isl->y,
                       isl->stone_vx[pi], isl->stone_vy[pi], isl->stone_vc[pi],
                       &bx0, &by0, &bx1, &by1);

            unsigned int seed = (unsigned int)((unsigned int)isl->id * 2654435761u)
                                + (unsigned int)(pi * 1234567u);
            int added = 0;
            for (float gx = bx0; gx <= bx1 && isl->resource_count < ISLAND_MAX_RESOURCES; gx += STONE_ZONE_SPACING) {
                for (float gy = by0; gy <= by1 && isl->resource_count < ISLAND_MAX_RESOURCES; gy += STONE_ZONE_SPACING) {
                    seed = seed * 1664525u + 1013904223u;
                    float jx = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * STONE_ZONE_JITTER);
                    seed = seed * 1664525u + 1013904223u;
                    float jy = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * STONE_ZONE_JITTER);
                    float wx = gx + jx, wy = gy + jy;
                    if (!inside_biome_poly(isl->x, isl->y,
                                          isl->stone_vx[pi], isl->stone_vy[pi],
                                          isl->stone_vc[pi], wx, wy)) continue;
                    IslandResource *r = &isl->resources[isl->resource_count];
                    r->ox         = wx - isl->x;
                    r->oy         = wy - isl->y;
                    r->type_id    = RES_ROCK;
                    r->size       = resource_size_from_offset(r->ox, r->oy);
                    r->max_health = resource_max_health(RES_ROCK);
                    r->health     = r->max_health;
                    isl->resource_count++;
                    added++;
                }
            }
            log_info("[islands] Island %d stone biome poly %d: placed %d rock nodes", isl->id, pi, added);
        }

        /* ── Metal biome → RES_BOULDER only ──────────────────────────── */
        for (int pi = 0; pi < isl->metal_poly_count; pi++) {
            if (isl->metal_vc[pi] < 3) continue;
            float bx0, by0, bx1, by1;
            biome_bbox(isl->x, isl->y,
                       isl->metal_vx[pi], isl->metal_vy[pi], isl->metal_vc[pi],
                       &bx0, &by0, &bx1, &by1);

            unsigned int seed = (unsigned int)((unsigned int)isl->id * 2246822519u)
                                + (unsigned int)(pi * 7654321u);
            int added = 0;
            for (float gx = bx0; gx <= bx1 && isl->resource_count < ISLAND_MAX_RESOURCES; gx += METAL_ZONE_SPACING) {
                for (float gy = by0; gy <= by1 && isl->resource_count < ISLAND_MAX_RESOURCES; gy += METAL_ZONE_SPACING) {
                    seed = seed * 1664525u + 1013904223u;
                    float jx = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * METAL_ZONE_JITTER);
                    seed = seed * 1664525u + 1013904223u;
                    float jy = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * METAL_ZONE_JITTER);
                    float wx = gx + jx, wy = gy + jy;
                    if (!inside_biome_poly(isl->x, isl->y,
                                          isl->metal_vx[pi], isl->metal_vy[pi],
                                          isl->metal_vc[pi], wx, wy)) continue;
                    IslandResource *r = &isl->resources[isl->resource_count];
                    r->ox         = wx - isl->x;
                    r->oy         = wy - isl->y;
                    r->type_id    = RES_BOULDER;
                    r->size       = resource_size_from_offset(r->ox, r->oy) * 0.50f;
                    r->max_health = resource_max_health(RES_BOULDER);
                    r->health     = r->max_health;
                    isl->resource_count++;
                    added++;
                }
            }
            log_info("[islands] Island %d metal biome poly %d: placed %d mixed nodes", isl->id, pi, added);
        }
    }
}

void islands_generate_trees(void)
{
    /* First pass: stamp size+health onto all statically declared resources. */
    init_static_resource_fields();

    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];

        /* Only polygon islands with an explicit grass polygon get procedural trees. */
        if (isl->vertex_count == 0 || isl->grass_vertex_count == 0) continue;

        /* Bounding box from explicit grass vertices */
        float half_bound = 0.0f;
        for (int gi = 0; gi < isl->grass_vertex_count; gi++) {
            float r = sqrtf(isl->gvx[gi]*isl->gvx[gi] + isl->gvy[gi]*isl->gvy[gi]);
            if (r > half_bound) half_bound = r;
        }

        /* One deterministic seed per island — the fiber pass derives its own
         * stream from the same formula XOR'd with a golden-ratio constant. */
        unsigned int seed = (unsigned int)((unsigned int)isl->id * 1664525u + 1013904223u);

        float x0 = isl->x - half_bound;
        float x1 = isl->x + half_bound;
        float y0 = isl->y - half_bound;
        float y1 = isl->y + half_bound;

        int added = 0;
        for (float gx = x0; gx <= x1 && isl->resource_count < ISLAND_MAX_RESOURCES; gx += TREE_GRID_SPACING) {
            for (float gy = y0; gy <= y1 && isl->resource_count < ISLAND_MAX_RESOURCES; gy += TREE_GRID_SPACING) {
                /* Two LCG steps for X and Y jitter in [-TREE_JITTER, +TREE_JITTER] */
                seed = seed * 1664525u + 1013904223u;
                float jx = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * TREE_JITTER);
                seed = seed * 1664525u + 1013904223u;
                float jy = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * TREE_JITTER);

                float tx = gx + jx;
                float ty = gy + jy;

                if (!inside_grass_poly(isl, tx, ty)) continue;
                if (inside_any_stone_metal_biome(isl, tx, ty)) continue;

                IslandResource *r = &isl->resources[isl->resource_count];
                r->ox         = tx - isl->x;
                r->oy         = ty - isl->y;
                r->type_id    = RES_WOOD;
                r->size       = resource_size_from_offset(r->ox, r->oy);
                r->max_health = resource_max_health(RES_WOOD);
                r->health     = r->max_health;
                isl->resource_count++;
                added++;
            }
        }

        /* Log how many trees were generated for this island. */
        (void)added; /* suppress unused-variable warning if logging is off */
    }

    /* ── Second pass: procedural fiber (tall-grass) for polygon islands ── */
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];

        if (isl->vertex_count == 0 || isl->grass_vertex_count == 0) continue;

        /* Derive fiber seed from the same island seed formula as the tree pass,
         * XOR'd with a golden-ratio constant to give an independent jitter stream
         * from the same world identity — no separate magic seed constant needed. */
        unsigned int island_seed = (unsigned int)((unsigned int)isl->id * 1664525u + 1013904223u);
        unsigned int seed = island_seed ^ 0x9E3779B9u;

        /* Bounding box from explicit grass vertices */
        float half_bound = 0.0f;
        for (int gi = 0; gi < isl->grass_vertex_count; gi++) {
            float r = sqrtf(isl->gvx[gi]*isl->gvx[gi] + isl->gvy[gi]*isl->gvy[gi]);
            if (r > half_bound) half_bound = r;
        }
        half_bound *= FIBER_POLY_SCALE;

        /* Shift fiber grid origin by half a cell in both axes — this is the
         * primary guarantee that fiber can never land on a tree grid point
         * even if the jitter RNG produced identical values. */
        float x0 = isl->x - half_bound + FIBER_GRID_SPACING * 0.5f;
        float x1 = isl->x + half_bound;
        float y0 = isl->y - half_bound + FIBER_GRID_SPACING * 0.5f;
        float y1 = isl->y + half_bound;

        int added_fiber = 0;
        for (float gx = x0; gx <= x1 && isl->resource_count < ISLAND_MAX_RESOURCES; gx += FIBER_GRID_SPACING) {
            for (float gy = y0; gy <= y1 && isl->resource_count < ISLAND_MAX_RESOURCES; gy += FIBER_GRID_SPACING) {
                seed = seed * 1664525u + 1013904223u;
                float jx = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * FIBER_JITTER);
                seed = seed * 1664525u + 1013904223u;
                float jy = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * FIBER_JITTER);

                float fx = gx + jx;
                float fy = gy + jy;

                /* Must be inside the grass polygon (shrunk by FIBER_POLY_SCALE search area). */
                if (!inside_grass_poly(isl, fx, fy)) continue;
                /* Stone/metal biome zones override — no fiber spawns inside them. */
                if (inside_any_stone_metal_biome(isl, fx, fy)) continue;

                IslandResource *r = &isl->resources[isl->resource_count];
                r->ox         = fx - isl->x;
                r->oy         = fy - isl->y;
                r->type_id    = RES_FIBER;
                r->size       = resource_size_from_offset(r->ox, r->oy);
                r->max_health = resource_max_health(RES_FIBER);
                r->health     = r->max_health;
                isl->resource_count++;
                added_fiber++;
            }
        }
        (void)added_fiber;
    }

    /* ── Third pass: procedural rocks for polygon islands ── */
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];

        if (isl->vertex_count == 0) continue;

        /* Derive rock seed independently from tree/fiber streams */
        unsigned int island_seed = (unsigned int)((unsigned int)isl->id * 1664525u + 1013904223u);
        unsigned int seed = island_seed ^ 0x517CC1B7u;

        /* Bounding box from sand vertices */
        float half_bound = 0.0f;
        for (int vi = 0; vi < isl->vertex_count; vi++) {
            float r = sqrtf(isl->vx[vi]*isl->vx[vi] + isl->vy[vi]*isl->vy[vi]);
            if (r > half_bound) half_bound = r;
        }

        /* Two passes: grass zone (sparse) then sand zone (denser) */
        for (int pass = 0; pass < 2; pass++) {
            float spacing = (pass == 0) ? ROCK_GRASS_SPACING : ROCK_SAND_SPACING;
            /* Offset grid origin per pass to avoid overlap at same points */
            float offset  = (pass == 0) ? 0.0f : spacing * 0.5f;

            float x0 = isl->x - half_bound + offset;
            float x1 = isl->x + half_bound;
            float y0 = isl->y - half_bound + offset;
            float y1 = isl->y + half_bound;

            for (float gx = x0; gx <= x1 && isl->resource_count < ISLAND_MAX_RESOURCES; gx += spacing) {
                for (float gy = y0; gy <= y1 && isl->resource_count < ISLAND_MAX_RESOURCES; gy += spacing) {
                    seed = seed * 1664525u + 1013904223u;
                    float jx = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * ROCK_JITTER);
                    seed = seed * 1664525u + 1013904223u;
                    float jy = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * ROCK_JITTER);

                    float rx = gx + jx;
                    float ry = gy + jy;

                    int on_grass = inside_grass_poly(isl, rx, ry);
                    int on_sand  = inside_sand_poly(isl, rx, ry);

                    if (pass == 0 && !on_grass) continue;          /* grass pass: grass only */
                    if (pass == 1 && (on_grass || !on_sand)) continue; /* sand pass: sand ring only */

                    IslandResource *r = &isl->resources[isl->resource_count];
                    r->ox         = rx - isl->x;
                    r->oy         = ry - isl->y;
                    r->type_id    = RES_ROCK;
                    r->size       = resource_size_from_offset(r->ox, r->oy);
                    r->max_health = resource_max_health(RES_ROCK);
                    r->health     = r->max_health;
                    isl->resource_count++;
                }
            }
        }
    }

    /* ── Fourth pass: procedural boulders (1:10 ratio vs trees, grass+sand) ── */
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];
        if (isl->vertex_count == 0) continue;

        unsigned int seed = ((unsigned int)isl->id * 1664525u + 1013904223u) ^ 0xDEADBEEFu;

        float half_bound = 0.0f;
        for (int vi = 0; vi < isl->vertex_count; vi++) {
            float r = sqrtf(isl->vx[vi]*isl->vx[vi] + isl->vy[vi]*isl->vy[vi]);
            if (r > half_bound) half_bound = r;
        }

        float x0 = isl->x - half_bound;
        float x1 = isl->x + half_bound;
        float y0 = isl->y - half_bound;
        float y1 = isl->y + half_bound;

        for (float gx = x0; gx <= x1 && isl->resource_count < ISLAND_MAX_RESOURCES; gx += BOULDER_SPACING) {
            for (float gy = y0; gy <= y1 && isl->resource_count < ISLAND_MAX_RESOURCES; gy += BOULDER_SPACING) {
                seed = seed * 1664525u + 1013904223u;
                float jx = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * BOULDER_JITTER);
                seed = seed * 1664525u + 1013904223u;
                float jy = ((float)(seed & 0xFFFFu) / 65535.0f - 0.5f) * (2.0f * BOULDER_JITTER);

                float bx = gx + jx;
                float by = gy + jy;

                /* Must be on the island (grass or sand) */
                if (!inside_sand_poly(isl, bx, by)) continue;

                IslandResource *r = &isl->resources[isl->resource_count];
                r->ox         = bx - isl->x;
                r->oy         = by - isl->y;
                r->type_id    = RES_BOULDER;
                r->size       = 0.8f + ((float)((seed >> 8) & 0xFFu) / 255.0f) * 0.8f; /* 0.8–1.6 */
                r->max_health = resource_max_health(RES_BOULDER);
                r->health     = r->max_health;
                isl->resource_count++;
            }
        }
    }
}

/* ── Spatial grid + alive list ───────────────────────────────────────────── */

void islands_build_grid(void)
{
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        IslandDef *isl = &ISLAND_PRESETS[ii];

        /* Clear grid and alive list */
        memset(isl->wood_grid, 0, sizeof(isl->wood_grid));
        isl->alive_wood_count = 0;

        if (isl->resource_count == 0) continue;

        /* Compute bounding box of all wood nodes to set grid origin */
        float min_x =  1e9f, min_y =  1e9f;
        float max_x = -1e9f, max_y = -1e9f;
        for (int ri = 0; ri < isl->resource_count; ri++) {
            const IslandResource *r = &isl->resources[ri];
            if (r->type_id != RES_WOOD) continue;
            float wx = isl->x + r->ox;
            float wy = isl->y + r->oy;
            if (wx < min_x) min_x = wx;
            if (wy < min_y) min_y = wy;
            if (wx > max_x) max_x = wx;
            if (wy > max_y) max_y = wy;
        }
        if (min_x > max_x) continue; /* no wood nodes on this island */

        /* Grid origin: one cell-width before the first node so all nodes
         * map to col/row >= 0 even with floating-point rounding */
        isl->grid_ox = min_x - ISLAND_GRID_CELL_PX;
        isl->grid_oy = min_y - ISLAND_GRID_CELL_PX;
        isl->grid_w  = (int)((max_x - isl->grid_ox) / ISLAND_GRID_CELL_PX) + 2;
        isl->grid_h  = (int)((max_y - isl->grid_oy) / ISLAND_GRID_CELL_PX) + 2;
        if (isl->grid_w > ISLAND_GRID_COLS) isl->grid_w = ISLAND_GRID_COLS;
        if (isl->grid_h > ISLAND_GRID_ROWS) isl->grid_h = ISLAND_GRID_ROWS;

        /* Insert each wood node into the grid + alive list */
        for (int ri = 0; ri < isl->resource_count; ri++) {
            const IslandResource *r = &isl->resources[ri];
            if (r->type_id != RES_WOOD) continue;

            /* Add to alive list */
            if (isl->alive_wood_count < ISLAND_MAX_RESOURCES)
                isl->alive_wood[isl->alive_wood_count++] = (uint16_t)ri;

            /* Add to spatial grid */
            int col = (int)((isl->x + r->ox - isl->grid_ox) / ISLAND_GRID_CELL_PX);
            int row = (int)((isl->y + r->oy - isl->grid_oy) / ISLAND_GRID_CELL_PX);
            if (col < 0 || col >= isl->grid_w || row < 0 || row >= isl->grid_h) continue;
            IslandGridCell *cell = &isl->wood_grid[row][col];
            if (cell->count < ISLAND_GRID_MAXPC)
                cell->ri[cell->count++] = (uint16_t)ri;
        }
    }
}

void island_mark_tree_dead(IslandDef *isl, int ri)
{
    /* Remove from alive list (swap-and-pop) */
    for (int k = 0; k < isl->alive_wood_count; k++) {
        if (isl->alive_wood[k] == (uint16_t)ri) {
            isl->alive_wood[k] = isl->alive_wood[--isl->alive_wood_count];
            break;
        }
    }
    /* Remove from spatial grid (swap-and-pop in the cell) */
    int col = (int)((isl->x + isl->resources[ri].ox - isl->grid_ox) / ISLAND_GRID_CELL_PX);
    int row = (int)((isl->y + isl->resources[ri].oy - isl->grid_oy) / ISLAND_GRID_CELL_PX);
    if (col < 0 || col >= isl->grid_w || row < 0 || row >= isl->grid_h) return;
    IslandGridCell *cell = &isl->wood_grid[row][col];
    for (int k = 0; k < cell->count; k++) {
        if (cell->ri[k] == (uint16_t)ri) {
            cell->ri[k] = cell->ri[--cell->count];
            return;
        }
    }
}

void island_mark_tree_alive(IslandDef *isl, int ri)
{
    /* Guard: already in alive list? */
    for (int k = 0; k < isl->alive_wood_count; k++) {
        if (isl->alive_wood[k] == (uint16_t)ri) return;
    }
    /* Append to alive list (cap at MAX_ALIVE_WOOD if defined) */
    if (isl->alive_wood_count < (int)(sizeof(isl->alive_wood) / sizeof(isl->alive_wood[0]))) {
        isl->alive_wood[isl->alive_wood_count++] = (uint16_t)ri;
    }
    /* Re-insert into spatial grid */
    int col = (int)((isl->x + isl->resources[ri].ox - isl->grid_ox) / ISLAND_GRID_CELL_PX);
    int row = (int)((isl->y + isl->resources[ri].oy - isl->grid_oy) / ISLAND_GRID_CELL_PX);
    if (col < 0 || col >= isl->grid_w || row < 0 || row >= isl->grid_h) return;
    IslandGridCell *cell = &isl->wood_grid[row][col];
    if (cell->count < (int)(sizeof(cell->ri) / sizeof(cell->ri[0]))) {
        cell->ri[cell->count++] = (uint16_t)ri;
    }
}

/**
 * Returns true if the resource at world position (rx, ry) may respawn.
 * Suppressed when any active structure is within RESPAWN_SUPPRESS_R px,
 * i.e. a player has built over the depleted node's footprint.
 */
bool island_resource_can_respawn(float rx, float ry,
                                 const PlacedStructure *structs,
                                 uint32_t struct_count)
{
    /* Any structure type within this radius blocks respawn. */
    const float RESPAWN_SUPPRESS_R = 60.0f;
    for (uint32_t i = 0; i < struct_count; i++) {
        if (!structs[i].active) continue;
        float dx = structs[i].x - rx;
        float dy = structs[i].y - ry;
        if (dx*dx + dy*dy < RESPAWN_SUPPRESS_R * RESPAWN_SUPPRESS_R)
            return false;
    }
    return true;
}
