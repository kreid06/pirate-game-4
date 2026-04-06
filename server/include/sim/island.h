#pragma once
/**
 * Island definitions — static world features.
 *
 * Islands are fixed positions defined at server startup.
 * The server broadcasts them once to every client on connect via the ISLANDS message.
 * The client uses the preset name to pick visual parameters (beach colour, tree style, etc.)
 *
 * Preset names (must match client-side RenderSystem.ISLAND_PRESETS keys):
 *   "tropical"  — warm sand, lush green, palm trees + fiber
 *   "jungle"    — dark sand, very dark green, dense trees
 *   "desert"    — pale sand, sparse dry brush
 *   "rocky"     — grey sand, sparse grass, no trees
 *   "pine"      — cool sand, dark pine forest
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
    float          x, y;       /* World-space centre (px) */
    const char    *preset;     /* One of the preset name strings above */
    IslandResource resources[ISLAND_MAX_RESOURCES];
    int            resource_count;
} IslandDef;

/* ── Built-in island presets ─────────────────────────────────────────────── */

static const IslandDef ISLAND_PRESETS[] = {
    {
        .id = 1, .x = 800.0f, .y = 600.0f, .preset = "tropical",
        .resource_count = 7,
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
    {
        .id = 2, .x = -600.0f, .y = 400.0f, .preset = "jungle",
        .resource_count = 8,
        .resources = {
            { .ox = -70.0f, .oy = -60.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  90.0f, .oy = -30.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  20.0f, .oy =  90.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -100.0f,.oy =  45.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  55.0f, .oy = -85.0f, .type = ISLAND_RES_FIBER },
            { .ox = -35.0f, .oy =  40.0f, .type = ISLAND_RES_FIBER },
            { .ox =  80.0f, .oy =  60.0f, .type = ISLAND_RES_FIBER },
            { .ox = -50.0f, .oy = -30.0f, .type = ISLAND_RES_FIBER },
        },
    },
    {
        .id = 3, .x = 1400.0f, .y = -500.0f, .preset = "desert",
        .resource_count = 4,
        .resources = {
            { .ox = -60.0f, .oy = -40.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  70.0f, .oy =  20.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  10.0f, .oy =  60.0f, .type = ISLAND_RES_FIBER },
            { .ox = -40.0f, .oy =  30.0f, .type = ISLAND_RES_FIBER },
        },
    },
    {
        .id = 4, .x = -1200.0f, .y = -800.0f, .preset = "rocky",
        .resource_count = 3,
        .resources = {
            { .ox = -55.0f, .oy = -45.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  65.0f, .oy =  15.0f, .type = ISLAND_RES_WOOD  },
            { .ox =   5.0f, .oy =  55.0f, .type = ISLAND_RES_FIBER },
        },
    },
    {
        .id = 5, .x = 300.0f, .y = -1100.0f, .preset = "pine",
        .resource_count = 6,
        .resources = {
            { .ox = -60.0f, .oy = -50.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  75.0f, .oy = -20.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  10.0f, .oy =  75.0f, .type = ISLAND_RES_WOOD  },
            { .ox = -80.0f, .oy =  35.0f, .type = ISLAND_RES_WOOD  },
            { .ox =  40.0f, .oy = -70.0f, .type = ISLAND_RES_FIBER },
            { .ox = -25.0f, .oy =  28.0f, .type = ISLAND_RES_FIBER },
        },
    },
};

#define ISLAND_COUNT ((int)(sizeof(ISLAND_PRESETS) / sizeof(ISLAND_PRESETS[0])))
