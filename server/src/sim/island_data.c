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
     * ~6200 × 6100 px, centre (6000, 5000).                                *
     * Wood resources are left empty here — islands_generate_trees() fills  *
     * them procedurally at startup.                                         */
    {
        .id               = 2,
        .x                = 9000.0f,
        .y                = 52000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .rotation_deg     = 0.0f,
        .vertex_count     = 28,
        .poly_bound_r     = 3300.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        /*             N     NNE    NE    ENE   E-NE  E-near   E    ESE */
        .vx = {        0,   800, 1600, 2300, 2750,  2950, 3100, 2900,
        /*            SE    SSE   S-SE     S  S-bay bay-in bay-fl bay-in */
                    2550,  1950,  1250,   500,  250,   100,    0,  -100,
        /*         bay-ex  SW-S    SW    WSW  W-SW  W-near    W    WNW  */
                    -350, -1050, -1850, -2450, -2850, -2950, -3100, -2900,
        /*            NW    NNW   N-NW  N-near */
                   -2550, -1950, -1250,  -500 },
        /*             N     NNE    NE    ENE   E-NE  E-near   E    ESE */
        .vy = {    -3000, -2850, -2650, -2250, -1450,  -500,  400, 1200,
        /*            SE    SSE   S-SE     S  S-bay bay-in bay-fl bay-in */
                    2050,  2600,  2900,  3050,  2450,  1850, 1650, 1850,
        /*         bay-ex  SW-S    SW    WSW  W-SW  W-near    W    WNW  */
                    2450,  2950,  2650,  2150,  1450,   500, -400, -1250,
        /*            NW    NNW   N-NW  N-near */
                   -2050, -2550, -2800, -2950 },

        /* Explicit grass polygon (sand vertices scaled ×0.82) */
        .grass_vertex_count = 28,
        .gvx = {       0,   656,  1312,  1886,  2255,  2419,  2542,  2378,
                    2091,  1599,  1025,   410,   205,    82,     0,   -82,
                    -287,  -861, -1517, -2009, -2337, -2419, -2542, -2378,
                   -2091, -1599, -1025,  -410 },
        .gvy = {   -2460, -2337, -2173, -1845, -1189,  -410,   328,   984,
                    1681,  2132,  2378,  2501,  2009,  1517,  1353,  1517,
                    2009,  2419,  2173,  1763,  1189,   410,  -328, -1025,
                   -1681, -2091, -2296, -2419 },

        /* Explicit shallow-water polygon */
        .shallow_vertex_count = 25,
        .svx = {    445,  1219,  2222,  3121,  3832,  3843,  3728,  3644,
                   2839,  2233,  1365,   477,    17,  -339, -1018, -2429,
                  -3276, -3924, -4290, -4300, -4050, -2962, -2095, -1384,
                   -339 },
        .svy = {  -3747, -3570, -3298, -2503, -1374,  -423,   612,  1573,
                   2807,  3215,  3486,  3612,  3131,  2995,  3434,  3110,
                   2472,  1448,   329,  -664, -1866, -2974, -3392, -3894,
                  -3894 },

        /* Static non-wood resources — wood is generated by islands_generate_trees() */
        .resource_count = 8,
        .resources = {
            /* Fiber — meadow patches */
            { .ox =  -800.0f, .oy = -1000.0f, .type_id = RES_FIBER },
            { .ox =  1000.0f, .oy = -1000.0f, .type_id = RES_FIBER },
            { .ox =  1200.0f, .oy =  1000.0f, .type_id = RES_FIBER },
            { .ox = -1500.0f, .oy =  -400.0f, .type_id = RES_FIBER },
            /* Rock — mountain outcrops near the edges */
            { .ox = -2500.0f, .oy = -1600.0f, .type_id = RES_ROCK  },
            { .ox =  2500.0f, .oy = -1000.0f, .type_id = RES_ROCK  },
            { .ox =  2400.0f, .oy =  1600.0f, .type_id = RES_ROCK  },
            { .ox = -2500.0f, .oy =  1400.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 3: Crescent (horseshoe) — Combat Cove / Smuggler Cove ──────
     * ~10,000 × ~8,200 px, world centre (47500, 52500).  Opens southward.
     * Combat Cove = large inner bay between the two arms.
     * Smuggler Cove = secondary inlet on inner-west face of left arm.
     * Beach = concave cove on outer-east face of right arm.
     * CW winding in screen-space (y-down).                                  */
    {
        .id               = 3,
        .x                = 79000.0f,
        .y                = 68000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .vertex_count     = 70,
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .grass_vertex_count = 67,
        .gvx = {
            -2536, -1357,  -197,   927,  2511,  3799,  4518,  4504,
             4078,  3490,  3167,  2800,  2594,  2447,  1977,  1596,
             1023,   773,   949,  1170,  1478,  1610,  1875,  2124,
             2712,  3329,  3255,  2932,  2286,  2183,  2036,  1508,
              803,   156,  -446, -1048, -1488, -1738, -1812, -2105,
            -2281, -2179, -2370, -2732, -3171, -4118, -4442, -4141,
            -3605, -3145, -2666, -2555, -2224, -1892, -1407, -1395,
            -1929, -2739, -3071, -3800, -4268, -4821, -4692, -4158,
            -3679, -3476, -3568,
        },
        .gvy = {
            -3184, -3405, -3498, -3019, -2411, -1386,  -109,   596,
             1213,  1654,  2006,  2153,  2535,  3005,  3152,  3313,
             3401,  3166,  2946,  2711,  2564,  2153,  1683,  1844,
             1830,  1316,   758,   185,   141,   -21,  -447,  -990,
            -1372, -1842, -1886, -1592, -1137,  -373,   -35,   244,
              156,   -94,  -344,  -593,  -501,    31,   562,  1325,
             1428,  1446,  1520,  1888,  2441,  2883,  3228,  3454,
             3362,  3104,  2920,  2592,  1925,  1225,   175,  -661,
            -1121, -1784, -2724,
        },
        .vx = {
            -3152, -1494,  -296,  1457,  2926,  4400,  4900,  5000,
             4700,  4100,  3100,  3203,  3100,  2932,  2521,  1743,
             1061,   550,   248,   865,  1400,  1682,  1756,  2161,
             2695,  2879,  2916,  2566,  2179,  1719,  1498,  1166,
              835,   319,  -252,  -879, -1321, -1560, -1855, -2279,
            -2610, -2518, -2703, -3108, -3495, -3955, -4250, -4176,
            -3661, -3163, -2629, -2239, -2058, -1560,  -961, -1050,
            -1443, -1991, -2673, -3509, -4133, -4549, -4734, -4865,
            -5215, -5049, -4914, -5088, -4867, -4203,
        },
        .vy = {
            -3490, -3877, -4116, -3811, -2798, -1600,  -200,   700,
             1300,  1800,  2200,  2531,  2800,  3250,  3514,  3721,
             3826,  3866,  3289,  2594,  2200,  1649,  1041,  1612,
             1686,  1170,   875,   507,   378,   323,  -285,  -599,
            -1041, -1464, -1501, -1409,  -783,  -120,   396,   525,
              267,  -120,  -267,  -304,    -9,    83,   488,  1004,
             1152,  1152,  1115,  1561,  2268,  2859,  3321,  3787,
             3944,  3640,  3382,  3381,  3358,  3058,  2665,  2111,
             1392,   342,  -652, -1373, -2552, -3160,
        },
        .shallow_vertex_count = 27,
        .svx = {
            -4231, -2702,  -768,  1793,  4501,  5809,  6361,  6564,
             6251,  5643,  4372,  2898,  1958,  1056,   155,  -529,
            -1232, -2087, -3104, -4744, -6092, -6682, -7142, -7326,
            -7603, -7253, -5963,
        },
        .svy = {
            -5048, -5545, -5711, -5288, -4127, -2506,  -774,   239,
             1694,  3168,  4071,  4918,  5342,  5115,  4630,  4513,
             5115,  5508,  5393,  5092,  3924,  2468,  1326,   -74,
            -1179, -2635, -4182,
        },
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

    /* ── Island 4: Crescent — rotated 47° ─────────────────────────────────
     * World centre (19800, 25200). */
    {
        .id               = 4,
        .x                = 16000.0f,
        .y                = 15000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .vertex_count     = 70,
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .grass_vertex_count = 67,
        .gvx = {
               599,   1565,   2424,   2840,   3476,   3605,   3161,   2636,
              1894,   1171,    693,    335,    -85,   -529,   -957,  -1335,
             -1790,  -1788,  -1507,  -1185,   -867,   -477,     48,    100,
               511,   1308,   1666,   1864,   1456,   1504,   1715,   1752,
              1551,   1454,   1075,    450,   -183,   -913,  -1210,  -1614,
             -1670,  -1417,  -1365,  -1430,  -1796,  -2831,  -3440,  -3793,
             -3503,  -3202,  -2930,  -3123,  -3302,  -3399,  -3320,  -3477,
             -3774,  -4138,  -4230,  -4487,  -4319,  -4184,  -3328,  -2352,
             -1689,  -1066,   -441,
        },
        .gvy = {
             -4026,  -3315,  -2530,  -1381,    192,   1833,   3230,   3700,
              3810,   3680,   3684,   3516,   3626,   3839,   3596,   3427,
              3068,   2725,   2703,   2705,   2830,   2646,   2519,   2811,
              3231,   3332,   2898,   2270,   1768,   1582,   1184,    428,
              -348,  -1142,  -1612,  -1852,  -1864,  -1525,  -1349,  -1373,
             -1562,  -1658,  -1968,  -2402,  -2661,  -2991,  -2865,  -2125,
             -1663,  -1314,   -913,   -581,     38,    582,   1172,   1335,
               882,    114,   -255,  -1011,  -1809,  -2690,  -3312,  -3492,
             -3455,  -3759,  -4467,
        },
        .vx = {
               403,   1817,   2808,   3781,   4042,   4171,   3488,   2898,
              2255,   1480,    505,    333,     66,   -377,   -851,  -1533,
             -2075,  -2452,  -2236,  -1307,   -654,    -59,    436,    295,
               605,   1108,   1349,   1379,   1210,    936,   1230,   1233,
              1331,   1288,    926,    431,   -328,   -976,  -1555,  -1938,
             -1975,  -1630,  -1648,  -1897,  -2377,  -2758,  -3255,  -3582,
             -3339,  -3000,  -2608,  -2669,  -3062,  -3155,  -3084,  -3486,
             -3869,  -4020,  -4296,  -4866,  -5275,  -5339,  -5178,  -4862,
             -4575,  -3694,  -2874,  -2466,  -1453,   -555,
        },
        .vy = {
             -4685,  -3737,  -3024,  -1534,    232,   2127,   3447,   4134,
              4324,   4226,   3768,   4069,   4177,   4361,   4240,   3812,
              3385,   3039,   2424,   2402,   2524,   2355,   1994,   2680,
              3121,   2904,   2729,   2222,   1851,   1477,    901,    444,
               -99,   -765,  -1208,  -1604,  -1500,  -1223,  -1087,  -1309,
             -1727,  -1923,  -2159,  -2480,  -2562,  -2836,  -2775,  -2369,
             -1892,  -1528,  -1162,   -573,     42,    809,   1562,   1815,
              1634,   1026,    352,   -260,   -733,  -1241,  -1645,  -2118,
             -2865,  -3459,  -4039,  -4658,  -5300,  -5229,
        },
        .shallow_vertex_count = 27,
        .svx = {
               806,   2213,   3653,   5090,   6088,   5795,   4904,   4302,
              3024,   1532,      4,  -1620,  -2572,  -3021,  -3280,  -3661,
             -4581,  -5452,  -6061,  -6959,  -7025,  -6362,  -5841,  -4942,
             -4323,  -3019,  -1008,
        },
        .svy = {
             -6537,  -5758,  -4457,  -2295,    477,   2539,   4124,   4964,
              5727,   6288,   5974,   5474,   5075,   4261,   3271,   2691,
              2587,   2230,   1408,      3,  -1779,  -3204,  -4319,  -5408,
             -6365,  -7102,  -7213,
        },
        .resource_count = 10,
        .resources = {
            { .ox =   2000.0f, .oy =  -3800.0f, .type_id = RES_ROCK  },
            { .ox =   1200.0f, .oy =   3500.0f, .type_id = RES_ROCK  },
            { .ox =  -2800.0f, .oy =  -2500.0f, .type_id = RES_ROCK  },
            { .ox =  -2800.0f, .oy =   2200.0f, .type_id = RES_ROCK  },
            { .ox =    800.0f, .oy =  -3000.0f, .type_id = RES_FIBER },
            { .ox =    600.0f, .oy =   2000.0f, .type_id = RES_FIBER },
            { .ox =   2000.0f, .oy =  -1000.0f, .type_id = RES_FIBER },
            { .ox =   2500.0f, .oy =   -200.0f, .type_id = RES_FIBER },
            { .ox =  -1600.0f, .oy =  -3200.0f, .type_id = RES_FIBER },
            { .ox =  -1500.0f, .oy =   2800.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 5: Crescent — rotated 163° ─────────────────────────────────
     * World centre (70200, 25200). */
    {
        .id               = 5,
        .x                = 75000.0f,
        .y                = 23000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .vertex_count     = 70,
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .grass_vertex_count = 67,
        .gvx = {
              3356,   2293,   1211,     -4,  -1696,  -3228,  -4289,  -4481,
             -4254,  -3821,  -3615,  -3307,  -3222,  -3219,  -2812,  -2495,
             -1973,  -1665,  -1769,  -1911,  -2163,  -2169,  -2285,  -2570,
             -3129,  -3568,  -3334,  -2858,  -2227,  -2081,  -1816,  -1153,
              -367,    389,    978,   1468,   1755,   1771,   1743,   1942,
              2136,   2111,   2367,   2786,   3179,   3929,   4084,   3573,
              3030,   2585,   2105,   1891,   1413,    966,    402,    324,
               862,   1712,   2083,   2876,   3519,   4252,   4436,   4170,
              3846,   3846,   4209,
        },
        .gvy = {
              2303,   2859,   3288,   3158,   3040,   2436,   1425,    747,
                32,   -561,   -992,  -1240,  -1666,  -2158,  -2436,  -2702,
             -2953,  -2802,  -2540,  -2250,  -2020,  -1588,  -1061,  -1142,
              -957,   -285,    227,    680,    534,    658,   1023,   1388,
              1547,   1807,   1673,   1216,    652,   -151,   -496,   -849,
              -816,   -547,   -364,   -232,   -448,  -1234,  -1836,  -2478,
             -2420,  -2302,  -2233,  -2553,  -2985,  -3310,  -3498,  -3711,
             -3779,  -3769,  -3690,  -3590,  -3089,  -2581,  -1539,   -584,
                -4,    690,   1562,
        },
        .vx = {
              4035,   2562,   1486,   -279,  -1980,  -3740,  -4627,  -4986,
             -4875,  -4447,  -3608,  -3803,  -3783,  -3754,  -3438,  -2755,
             -2133,  -1656,  -1199,  -1586,  -1982,  -2091,  -1984,  -2538,
             -3070,  -3095,  -3044,  -2602,  -2194,  -1738,  -1349,   -940,
              -494,    123,    680,   1253,   1492,   1527,   1658,   2026,
              2418,   2443,   2663,   3061,   3345,   3758,   3922,   3700,
              3164,   2688,   2188,   1685,   1305,    656,    -52,   -103,
               227,    840,   1567,   2367,   2971,   3456,   3748,   4035,
              4580,   4728,   4890,   5267,   5400,   4943,
        },
        .vy = {
              2416,   3271,   3850,   4070,   3531,   2817,   1624,    792,
               131,   -523,  -1198,  -1484,  -1771,  -2251,  -2623,  -3049,
             -3349,  -3536,  -3073,  -2228,  -1695,  -1085,   -482,   -910,
              -824,   -277,     16,    265,    276,    194,    711,    914,
              1240,   1493,   1362,   1090,    363,   -341,   -921,  -1168,
             -1018,   -621,   -535,   -618,  -1013,  -1236,  -1709,  -2181,
             -2172,  -2026,  -1835,  -2147,  -2771,  -3190,  -3457,  -3929,
             -4194,  -4063,  -4016,  -4259,  -4420,  -4254,  -3933,  -3441,
             -2856,  -1803,   -813,   -175,   1018,   1793,
        },
        .shallow_vertex_count = 27,
        .svx = {
              5522,   4205,   2404,   -169,  -3098,  -4822,  -5857,  -6347,
             -6473,  -6323,  -5371,  -4209,  -3434,  -2505,  -1502,   -814,
              -317,    385,   1392,   3048,   4679,   5668,   6442,   7028,
              7615,   7706,   6925,
        },
        .svy = {
              3590,   4513,   5237,   5581,   5263,   4095,   2600,   1691,
               208,  -1380,  -2615,  -3856,  -4536,  -4583,  -4382,  -4470,
             -5252,  -5878,  -6065,  -6257,  -5534,  -4314,  -3356,  -2071,
             -1095,    399,   2256,
        },
        .resource_count = 10,
        .resources = {
            { .ox =   3800.0f, .oy =   2000.0f, .type_id = RES_ROCK  },
            { .ox =  -3500.0f, .oy =   1200.0f, .type_id = RES_ROCK  },
            { .ox =   2500.0f, .oy =  -2800.0f, .type_id = RES_ROCK  },
            { .ox =  -2200.0f, .oy =  -2800.0f, .type_id = RES_ROCK  },
            { .ox =   3000.0f, .oy =    800.0f, .type_id = RES_FIBER },
            { .ox =  -2000.0f, .oy =    600.0f, .type_id = RES_FIBER },
            { .ox =   1000.0f, .oy =   2000.0f, .type_id = RES_FIBER },
            { .ox =    200.0f, .oy =   2500.0f, .type_id = RES_FIBER },
            { .ox =   3200.0f, .oy =  -1600.0f, .type_id = RES_FIBER },
            { .ox =  -2800.0f, .oy =  -1500.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 6: Crescent — rotated 251° ─────────────────────────────────
     * World centre (19800, 68400). */
    {
        .id               = 6,
        .x                = 11000.0f,
        .y                = 78000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .vertex_count     = 70,
        .poly_bound_r     = 5800.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        .grass_vertex_count = 67,
        .gvx = {
             -2185,  -2778,  -3243,  -3156,  -3097,  -2547,  -1574,   -903,
              -181,    428,    866,   1124,   1552,   2045,   2337,   2613,
              2883,   2742,   2477,   2182,   1943,   1512,    981,   1052,
               847,    160,   -343,   -780,   -611,   -731,  -1086,  -1427,
             -1559,  -1792,  -1638,  -1164,   -591,    213,    557,    916,
               890,    621,    446,    329,    559,   1370,   1978,   2601,
              2524,   2391,   2305,   2617,   3032,   3342,   3510,   3720,
              3807,   3827,   3761,   3688,   3210,   2728,   1693,    729,
               138,   -555,  -1414,
        },
        .gvy = {
              3434,   2392,   1325,    106,  -1589,  -3141,  -4236,  -4453,
             -4251,  -3838,  -3648,  -3348,  -3278,  -3292,  -2895,  -2588,
             -2075,  -1762,  -1856,  -1989,  -2232,  -2223,  -2321,  -2609,
             -3160,  -3576,  -3324,  -2832,  -2207,  -2057,  -1780,  -1104,
              -313,    452,   1036,   1509,   1777,   1765,   1725,   1911,
              2106,   2091,   2353,   2776,   3161,   3884,   4017,   3484,
              2944,   2503,   2026,   1801,   1308,    850,    279,    194,
               729,   1579,   1953,   2749,   3409,   4160,   4379,   4147,
              3844,   3867,   4260,
        },
        .vx = {
             -2274,  -3179,  -3795,  -4078,  -3598,  -2945,  -1784,   -966,
              -301,    367,   1071,   1350,   1638,   2118,   2502,   2951,
              3272,   3476,   3029,   2171,   1624,   1012,    413,    821,
               717,    169,   -122,   -356,   -352,   -254,   -757,   -946,
             -1256,  -1488,  -1337,  -1046,   -310,    394,    978,   1238,
              1102,    706,    628,    724,   1129,   1366,   1845,   2309,
              2281,   2119,   1910,   2205,   2814,   3211,   3453,   3923,
              4199,   4090,   4068,   4339,   4521,   4372,   4061,   3580,
              3014,   1967,    983,    358,   -828,  -1619,
        },
        .vy = {
              4117,   2675,   1620,   -137,  -1856,  -3639,  -4568,  -4955,
             -4867,  -4463,  -3647,  -3853,  -3843,  -3830,  -3528,  -2859,
             -2249,  -1779,  -1305,  -1662,  -2040,  -2127,  -1999,  -2568,
             -3097,  -3103,  -3042,  -2591,  -2183,  -1731,  -1324,   -907,
              -451,    175,    727,   1290,   1504,   1514,   1625,   1984,
              2381,   2420,   2643,   3038,   3308,   3713,   3860,   3622,
              3086,   2616,   2123,   1609,   1207,    544,   -173,   -240,
                80,    697,   1426,   2217,   2815,   3306,   3608,   3913,
              4478,   4663,   4859,   5258,   5433,   5003,
        },
        .shallow_vertex_count = 27,
        .svx = {
             -3395,  -4363,  -5150,  -5584,  -5368,  -4261,  -2803,  -1911,
              -433,   1158,   2426,   3707,   4413,   4493,   4327,   4439,
              5237,   5887,   6110,   6359,   5694,   4509,   3579,   2315,
              1361,   -130,  -2013,
        },
        .svy = {
              5644,   4360,   2585,     26,  -2912,  -4677,  -5762,  -6284,
             -6462,  -6367,  -5459,  -4341,  -3591,  -2664,  -1654,   -969,
              -500,    180,   1179,   2828,   4483,   5514,   6321,   6951,
              7573,   7716,   7000,
        },
        .resource_count = 10,
        .resources = {
            { .ox =  -2000.0f, .oy =   3800.0f, .type_id = RES_ROCK  },
            { .ox =  -1200.0f, .oy =  -3500.0f, .type_id = RES_ROCK  },
            { .ox =   2800.0f, .oy =   2500.0f, .type_id = RES_ROCK  },
            { .ox =   2800.0f, .oy =  -2200.0f, .type_id = RES_ROCK  },
            { .ox =   -800.0f, .oy =   3000.0f, .type_id = RES_FIBER },
            { .ox =   -600.0f, .oy =  -2000.0f, .type_id = RES_FIBER },
            { .ox =  -2000.0f, .oy =   1000.0f, .type_id = RES_FIBER },
            { .ox =  -2500.0f, .oy =    200.0f, .type_id = RES_FIBER },
            { .ox =   1600.0f, .oy =   3200.0f, .type_id = RES_FIBER },
            { .ox =   1500.0f, .oy =  -2800.0f, .type_id = RES_FIBER },
        },
    },

    /* ── Island 7: Continental — rotated 78° ────────────────────────────────
     * World centre (64800, 37800). */
    {
        .id               = 7,
        .x                = 82000.0f,
        .y                = 45000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .rotation_deg     = 78.0f,
        .vertex_count     = 28,
        .poly_bound_r     = 3300.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        /* Base continental sand polygon (will be rotated 78° at startup) */
        .vx = {        0,   800,  1600,  2300,  2750,  2950,  3100,  2900,
                    2550,  1950,  1250,   500,   250,   100,     0,  -100,
                    -350, -1050, -1850, -2450, -2850, -2950, -3100, -2900,
                   -2550, -1950, -1250,  -500 },
        .vy = {   -3000, -2850, -2650, -2250, -1450,  -500,   400,  1200,
                   2050,  2600,  2900,  3050,  2450,  1850,  1650,  1850,
                   2450,  2950,  2650,  2150,  1450,   500,  -400, -1250,
                  -2050, -2550, -2800, -2950 },
        /* Base grass polygon (will be rotated 78° at startup) */
        .grass_vertex_count = 28,
        .gvx = {       0,   656,  1312,  1886,  2255,  2419,  2542,  2378,
                    2091,  1599,  1025,   410,   205,    82,     0,   -82,
                    -287,  -861, -1517, -2009, -2337, -2419, -2542, -2378,
                   -2091, -1599, -1025,  -410 },
        .gvy = {   -2460, -2337, -2173, -1845, -1189,  -410,   328,   984,
                    1681,  2132,  2378,  2501,  2009,  1517,  1353,  1517,
                    2009,  2419,  2173,  1763,  1189,   410,  -328, -1025,
                   -1681, -2091, -2296, -2419 },
        /* Base shallow polygon (will be rotated 78° at startup) */
        .shallow_vertex_count = 25,
        .svx = {    445,  1219,  2222,  3121,  3832,  3843,  3728,  3644,
                   2839,  2233,  1365,   477,    17,  -339, -1018, -2429,
                  -3276, -3924, -4290, -4300, -4050, -2962, -2095, -1384,
                   -339 },
        .svy = {  -3747, -3570, -3298, -2503, -1374,  -423,   612,  1573,
                   2807,  3215,  3486,  3612,  3131,  2995,  3434,  3110,
                   2472,  1448,   329,  -664, -1866, -2974, -3392, -3894,
                  -3894 },
        .resource_count = 4,
        .resources = {
            { .ox =   -636.0f, .oy = -2899.0f, .type_id = RES_ROCK  },
            { .ox =   2475.0f, .oy =  1061.0f, .type_id = RES_ROCK  },
            { .ox =    566.0f, .oy =  2828.0f, .type_id = RES_ROCK  },
            { .ox =  -2758.0f, .oy =  -778.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 8: Continental — rotated 197° ────────────────────────────────
     * World centre (43200, 68400). */
    {
        .id               = 8,
        .x                = 48000.0f,
        .y                = 82000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .rotation_deg     = 197.0f,
        .vertex_count     = 28,
        .poly_bound_r     = 3300.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        /* Base continental sand polygon (will be rotated 197° at startup) */
        .vx = {        0,   800,  1600,  2300,  2750,  2950,  3100,  2900,
                    2550,  1950,  1250,   500,   250,   100,     0,  -100,
                    -350, -1050, -1850, -2450, -2850, -2950, -3100, -2900,
                   -2550, -1950, -1250,  -500 },
        .vy = {   -3000, -2850, -2650, -2250, -1450,  -500,   400,  1200,
                   2050,  2600,  2900,  3050,  2450,  1850,  1650,  1850,
                   2450,  2950,  2650,  2150,  1450,   500,  -400, -1250,
                  -2050, -2550, -2800, -2950 },
        /* Base grass polygon (will be rotated 197° at startup) */
        .grass_vertex_count = 28,
        .gvx = {       0,   656,  1312,  1886,  2255,  2419,  2542,  2378,
                    2091,  1599,  1025,   410,   205,    82,     0,   -82,
                    -287,  -861, -1517, -2009, -2337, -2419, -2542, -2378,
                   -2091, -1599, -1025,  -410 },
        .gvy = {   -2460, -2337, -2173, -1845, -1189,  -410,   328,   984,
                    1681,  2132,  2378,  2501,  2009,  1517,  1353,  1517,
                    2009,  2419,  2173,  1763,  1189,   410,  -328, -1025,
                   -1681, -2091, -2296, -2419 },
        /* Base shallow polygon (will be rotated 197° at startup) */
        .shallow_vertex_count = 25,
        .svx = {    445,  1219,  2222,  3121,  3832,  3843,  3728,  3644,
                   2839,  2233,  1365,   477,    17,  -339, -1018, -2429,
                  -3276, -3924, -4290, -4300, -4050, -2962, -2095, -1384,
                   -339 },
        .svy = {  -3747, -3570, -3298, -2503, -1374,  -423,   612,  1573,
                   2807,  3215,  3486,  3612,  3131,  2995,  3434,  3110,
                   2472,  1448,   329,  -664, -1866, -2974, -3392, -3894,
                  -3894 },
        .resource_count = 4,
        .resources = {
            { .ox =  -2500.0f, .oy = -1600.0f, .type_id = RES_ROCK  },
            { .ox =   2500.0f, .oy = -1000.0f, .type_id = RES_ROCK  },
            { .ox =   2400.0f, .oy =  1600.0f, .type_id = RES_ROCK  },
            { .ox =  -2500.0f, .oy =  1400.0f, .type_id = RES_ROCK  },
        },
    },

    /* ── Island 9: Continental — rotated 324° ────────────────────────────────
     * World centre (45000, 19800). */
    {
        .id               = 9,
        .x                = 45000.0f,
        .y                = 11000.0f,
        .beach_radius_px  = 0.0f,
        .grass_radius_px  = 0.0f,
        .beach_bumps      = {0},
        .grass_bumps      = {0},
        .beach_max_bump   = 0.0f,
        .grass_max_bump   = 0.0f,
        .preset           = "continental",
        .rotation_deg     = 324.0f,
        .vertex_count     = 28,
        .poly_bound_r     = 3300.0f,
        .grass_poly_scale  = 0.82f,
        .shallow_poly_scale = 1.375f,
        /* Base continental sand polygon (will be rotated 324° at startup) */
        .vx = {        0,   800,  1600,  2300,  2750,  2950,  3100,  2900,
                    2550,  1950,  1250,   500,   250,   100,     0,  -100,
                    -350, -1050, -1850, -2450, -2850, -2950, -3100, -2900,
                   -2550, -1950, -1250,  -500 },
        .vy = {   -3000, -2850, -2650, -2250, -1450,  -500,   400,  1200,
                   2050,  2600,  2900,  3050,  2450,  1850,  1650,  1850,
                   2450,  2950,  2650,  2150,  1450,   500,  -400, -1250,
                  -2050, -2550, -2800, -2950 },
        /* Base grass polygon (will be rotated 324° at startup) */
        .grass_vertex_count = 28,
        .gvx = {       0,   656,  1312,  1886,  2255,  2419,  2542,  2378,
                    2091,  1599,  1025,   410,   205,    82,     0,   -82,
                    -287,  -861, -1517, -2009, -2337, -2419, -2542, -2378,
                   -2091, -1599, -1025,  -410 },
        .gvy = {   -2460, -2337, -2173, -1845, -1189,  -410,   328,   984,
                    1681,  2132,  2378,  2501,  2009,  1517,  1353,  1517,
                    2009,  2419,  2173,  1763,  1189,   410,  -328, -1025,
                   -1681, -2091, -2296, -2419 },
        /* Base shallow polygon (will be rotated 324° at startup) */
        .shallow_vertex_count = 25,
        .svx = {    445,  1219,  2222,  3121,  3832,  3843,  3728,  3644,
                   2839,  2233,  1365,   477,    17,  -339, -1018, -2429,
                  -3276, -3924, -4290, -4300, -4050, -2962, -2095, -1384,
                   -339 },
        .svy = {  -3747, -3570, -3298, -2503, -1374,  -423,   612,  1573,
                   2807,  3215,  3486,  3612,  3131,  2995,  3434,  3110,
                   2472,  1448,   329,  -664, -1866, -2974, -3392, -3894,
                  -3894 },
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
#define METAL_ZONE_SPACING 300.0f  /* grid spacing (px) for metal/boulder nodes */
#define METAL_ZONE_JITTER   60.0f

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
                    r->size       = resource_size_from_offset(r->ox, r->oy) * 0.70f;
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
