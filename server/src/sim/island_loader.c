/**
 * island_loader.c — Load island polygon data from JSON files at startup.
 *
 * Reads server/data/islands/island_<id>.json for each entry in ISLAND_PRESETS
 * and overwrites the sand/grass/shallow polygon fields in place.
 * Resources (fiber, rock, wood) are not touched — they come from island_data.c
 * and islands_generate_trees().
 *
 * JSON format (same as island editor export):
 *   {
 *     "islandId": <int>,
 *     "centre": { "x": <float>, "y": <float> },
 *     "sand_verts_JSON":    [ { "x": <float>, "y": <float> }, ... ],
 *     "grass_verts_JSON":   [ ... ],   // optional
 *     "shallow_verts_JSON": [ ... ]    // optional
 *   }
 */

#include "sim/island.h"
#include "util/log.h"

#include <json-c/json.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

/* Load an array of {x,y} objects into dst_x/dst_y, clamped to max_n.
 * Returns the number of verts loaded. */
static int load_vert_array_n(struct json_object *arr,
                              float *dst_x, float *dst_y, int max_n)
{
    if (!arr) return 0;
    int n = (int)json_object_array_length(arr);
    if (n > max_n) {
        log_warn("[islands] vertex count %d exceeds limit %d, clamping", n, max_n);
        n = max_n;
    }
    for (int j = 0; j < n; j++) {
        struct json_object *v  = json_object_array_get_idx(arr, j);
        struct json_object *vx = NULL, *vy = NULL;
        json_object_object_get_ex(v, "x", &vx);
        json_object_object_get_ex(v, "y", &vy);
        dst_x[j] = vx ? (float)json_object_get_double(vx) : 0.0f;
        dst_y[j] = vy ? (float)json_object_get_double(vy) : 0.0f;
    }
    return n;
}

/* Load an array of {x,y} objects into dst_x/dst_y.
 * Returns the number of verts loaded (clamped to ISLAND_MAX_VERTS). */
static int load_vert_array(struct json_object *arr,
                           float *dst_x, float *dst_y)
{
    return load_vert_array_n(arr, dst_x, dst_y, ISLAND_MAX_VERTS);
}

void islands_load_from_files(const char *dir)
{
    for (int i = 0; i < ISLAND_COUNT; i++) {
        IslandDef *isl = &ISLAND_PRESETS[i];

        char path[512];
        snprintf(path, sizeof(path), "%s/island_%d.json", dir, isl->id);

        struct json_object *root = json_object_from_file(path);
        if (!root) {
            /* File not found or invalid — keep compiled-in data */
            continue;
        }

        /* ── Centre ──────────────────────────────────────────────────────── */
        struct json_object *centre = NULL;
        if (json_object_object_get_ex(root, "centre", &centre)) {
            struct json_object *cx = NULL, *cy = NULL;
            json_object_object_get_ex(centre, "x", &cx);
            json_object_object_get_ex(centre, "y", &cy);
            if (cx) isl->x = (float)json_object_get_double(cx);
            if (cy) isl->y = (float)json_object_get_double(cy);
        }

        /* ── Sand polygon ────────────────────────────────────────────────── */
        struct json_object *sand = NULL;
        json_object_object_get_ex(root, "sand_verts_JSON", &sand);
        if (sand) {
            int n = load_vert_array(sand, isl->vx, isl->vy);
            isl->vertex_count = n;

            /* Recompute broad-phase bound from actual vertices */
            float max_r = 0.0f;
            for (int j = 0; j < n; j++) {
                float r = sqrtf(isl->vx[j]*isl->vx[j] + isl->vy[j]*isl->vy[j]);
                if (r > max_r) max_r = r;
            }
            isl->poly_bound_r = max_r + 50.0f; /* small margin */
        }

        /* ── Grass polygon ───────────────────────────────────────────────── */
        struct json_object *grass = NULL;
        json_object_object_get_ex(root, "grass_verts_JSON", &grass);
        if (grass) {
            isl->grass_vertex_count = load_vert_array(grass, isl->gvx, isl->gvy);
        }

        /* ── Shallow polygon ─────────────────────────────────────────────── */
        struct json_object *shallow = NULL;
        json_object_object_get_ex(root, "shallow_verts_JSON", &shallow);
        if (shallow) {
            isl->shallow_vertex_count = load_vert_array(shallow, isl->svx, isl->svy);
        }

        /* ── Stone biome polygon ─────────────────────────────────────────── */
        struct json_object *stone_j = NULL;
        json_object_object_get_ex(root, "stone_verts_JSON", &stone_j);
        if (stone_j)
            isl->stone_vertex_count = load_vert_array(stone_j, isl->stvx, isl->stvy);

        /* ── Metal biome polygon ─────────────────────────────────────────── */
        struct json_object *metal_j = NULL;
        json_object_object_get_ex(root, "metal_verts_JSON", &metal_j);
        if (metal_j)
            isl->metal_vertex_count = load_vert_array(metal_j, isl->mtvx, isl->mtvy);

        json_object_put(root);

        log_info("[islands] Loaded island %d from %s (sand=%d grass=%d shallow=%d stone=%d metal=%d)",
                 isl->id, path,
                 isl->vertex_count, isl->grass_vertex_count, isl->shallow_vertex_count,
                 isl->stone_vertex_count, isl->metal_vertex_count);
    }
}
