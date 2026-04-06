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
};

#define ISLAND_COUNT ((int)(sizeof(ISLAND_PRESETS) / sizeof(ISLAND_PRESETS[0])))
