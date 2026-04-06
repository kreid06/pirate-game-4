#pragma once
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
 *   beach_radius_px — outer solid boundary; ships collide with this edge
 *   grass_radius_px — inner walkable area; players land here and walk at WALK_SPEED
 */

#define ISLAND_MAX_RESOURCES 16
#define ISLAND_MAX_COUNT     16

/* Resource types — must match client-side IslandResource['type'] literals */
#define ISLAND_RES_WOOD  "wood"
#define ISLAND_RES_FIBER "fiber"
#define ISLAND_RES_FOOD  "food"

typedef struct {
    float ox, oy;       /* Offset from island centre (world px) */
    const char *type;   /* ISLAND_RES_WOOD / ISLAND_RES_FIBER / ISLAND_RES_FOOD */
} IslandResource;

typedef struct {
    int            id;
    float          x, y;               /* World-space centre (client px) */
    float          beach_radius_px;    /* Outer hard boundary — ship collision */
    float          grass_radius_px;    /* Inner walkable area — player landing */
    const char    *preset;             /* Visual preset name sent to clients */
    IslandResource resources[ISLAND_MAX_RESOURCES];
    int            resource_count;
} IslandDef;

/* ── World island list (server-authoritative) ───────────────────────────── */

static const IslandDef ISLAND_PRESETS[] = {
    {
        .id              = 1,
        .x               = 800.0f,
        .y               = 600.0f,
        .beach_radius_px = 185.0f,
        .grass_radius_px = 148.0f,
        .preset          = "tropical",
        .resource_count  = 7,
        .resources = {
            { .ox = -65.0f, .oy = -55.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  85.0f, .oy = -25.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  15.0f, .oy =  80.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -90.0f, .oy =  38.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  45.0f, .oy = -78.0f, .type = ISLAND_RES_FIBER },
            { .ox = -28.0f, .oy =  32.0f, .type = ISLAND_RES_FIBER },
            { .ox =  70.0f, .oy =  50.0f, .type = ISLAND_RES_FIBER },
        },
    },
};

#define ISLAND_COUNT ((int)(sizeof(ISLAND_PRESETS) / sizeof(ISLAND_PRESETS[0])))
