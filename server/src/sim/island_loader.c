/**
 * island_loader.c — Load island configuration and template shape data at startup.
 *
 * File layout (server/data/islands/):
 *
 *   islands.json            — Array of all island instance configs:
 *     { "id": N, "centre": {"x":…,"y":…}, "template": "<name>", "rotation_deg": … }
 *
 *   templates/<name>.json   — Shape + biome data for a template:
 *     { "name": "<name>", "poly_bound_r": …,
 *       "sand_verts_JSON": […], "grass_verts_JSON": […], "shallow_verts_JSON": […],
 *       "metal_polys_JSON": [[…],…], "stone_polys_JSON": [[…],…] }
 *
 * Resources (fiber, rock, wood) come from island_data.c / islands_generate_trees()
 * and are not touched here.
 */

#include "sim/island.h"
#include "util/log.h"

#include <json-c/json.h>
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

/* ── Vertex loading helpers ──────────────────────────────────────────────── */

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

static int load_vert_array(struct json_object *arr, float *dst_x, float *dst_y)
{
    return load_vert_array_n(arr, dst_x, dst_y, ISLAND_MAX_VERTS);
}

static int load_multi_poly(struct json_object *polys,
                            float dst_vx[][ISLAND_BIOME_MAX_VERTS],
                            float dst_vy[][ISLAND_BIOME_MAX_VERTS],
                            int   dst_vc[],
                            int   max_polys)
{
    if (!polys) return 0;
    int np = (int)json_object_array_length(polys);
    if (np > max_polys) {
        log_warn("[islands] biome poly count %d exceeds limit %d, clamping", np, max_polys);
        np = max_polys;
    }
    for (int pi = 0; pi < np; pi++) {
        struct json_object *ring = json_object_array_get_idx(polys, pi);
        dst_vc[pi] = load_vert_array_n(ring, dst_vx[pi], dst_vy[pi], ISLAND_BIOME_MAX_VERTS);
    }
    return np;
}

/* ── Template store ──────────────────────────────────────────────────────── */

#define MAX_TEMPLATES 16

typedef struct {
    char  name[64];
    float poly_bound_r;
    float grass_poly_scale;
    float shallow_poly_scale;

    int   vertex_count;
    float vx[ISLAND_MAX_VERTS];
    float vy[ISLAND_MAX_VERTS];

    int   grass_vertex_count;
    float gvx[ISLAND_MAX_VERTS];
    float gvy[ISLAND_MAX_VERTS];

    int   shallow_vertex_count;
    float svx[ISLAND_MAX_VERTS];
    float svy[ISLAND_MAX_VERTS];

    int   stone_poly_count;
    int   stone_vc[ISLAND_MAX_BIOME_POLYS];
    float stone_vx[ISLAND_MAX_BIOME_POLYS][ISLAND_BIOME_MAX_VERTS];
    float stone_vy[ISLAND_MAX_BIOME_POLYS][ISLAND_BIOME_MAX_VERTS];

    int   metal_poly_count;
    int   metal_vc[ISLAND_MAX_BIOME_POLYS];
    float metal_vx[ISLAND_MAX_BIOME_POLYS][ISLAND_BIOME_MAX_VERTS];
    float metal_vy[ISLAND_MAX_BIOME_POLYS][ISLAND_BIOME_MAX_VERTS];
} IslandTemplate;

static IslandTemplate s_templates[MAX_TEMPLATES];
static int            s_template_count = 0;

static IslandTemplate *find_template(const char *name)
{
    for (int i = 0; i < s_template_count; i++)
        if (strcmp(s_templates[i].name, name) == 0)
            return &s_templates[i];
    return NULL;
}

static void load_template_file(const char *path)
{
    if (s_template_count >= MAX_TEMPLATES) {
        log_warn("[islands] template limit (%d) reached, skipping %s", MAX_TEMPLATES, path);
        return;
    }
    struct json_object *root = json_object_from_file(path);
    if (!root) { log_warn("[islands] could not parse template: %s", path); return; }

    IslandTemplate *t = &s_templates[s_template_count];
    memset(t, 0, sizeof(*t));

    struct json_object *j = NULL;

    if (json_object_object_get_ex(root, "name", &j))
        snprintf(t->name, sizeof(t->name), "%s", json_object_get_string(j));
    if (json_object_object_get_ex(root, "poly_bound_r", &j))
        t->poly_bound_r = (float)json_object_get_double(j);
    if (json_object_object_get_ex(root, "grass_poly_scale", &j))
        t->grass_poly_scale = (float)json_object_get_double(j);
    if (json_object_object_get_ex(root, "shallow_poly_scale", &j))
        t->shallow_poly_scale = (float)json_object_get_double(j);

    struct json_object *sand = NULL, *grass = NULL, *shallow = NULL;
    json_object_object_get_ex(root, "sand_verts_JSON",    &sand);
    json_object_object_get_ex(root, "grass_verts_JSON",   &grass);
    json_object_object_get_ex(root, "shallow_verts_JSON", &shallow);

    if (sand) {
        t->vertex_count = load_vert_array(sand, t->vx, t->vy);
        if (t->poly_bound_r == 0.0f) {
            float max_r = 0.0f;
            for (int i = 0; i < t->vertex_count; i++) {
                float r = sqrtf(t->vx[i]*t->vx[i] + t->vy[i]*t->vy[i]);
                if (r > max_r) max_r = r;
            }
            t->poly_bound_r = max_r + 50.0f;
        }
    }
    if (grass)   t->grass_vertex_count   = load_vert_array(grass,   t->gvx, t->gvy);
    if (shallow) t->shallow_vertex_count = load_vert_array(shallow, t->svx, t->svy);

    struct json_object *stone_polys = NULL, *metal_polys = NULL;
    json_object_object_get_ex(root, "stone_polys_JSON", &stone_polys);
    json_object_object_get_ex(root, "metal_polys_JSON", &metal_polys);
    if (stone_polys)
        t->stone_poly_count = load_multi_poly(stone_polys, t->stone_vx, t->stone_vy, t->stone_vc, ISLAND_MAX_BIOME_POLYS);
    if (metal_polys)
        t->metal_poly_count = load_multi_poly(metal_polys, t->metal_vx, t->metal_vy, t->metal_vc, ISLAND_MAX_BIOME_POLYS);

    json_object_put(root);
    s_template_count++;
    log_info("[islands] Loaded template '%s' (sand=%d grass=%d shallow=%d metal_polys=%d)",
             t->name, t->vertex_count, t->grass_vertex_count, t->shallow_vertex_count, t->metal_poly_count);
}

/* ── Main loader ─────────────────────────────────────────────────────────── */

void islands_load_from_files(const char *dir)
{
    /* ── 1. Load all templates from templates/ sub-directory ─────────────── */
    char tmpl_dir[512];
    snprintf(tmpl_dir, sizeof(tmpl_dir), "%s/templates", dir);

    DIR *dp = opendir(tmpl_dir);
    if (!dp) {
        log_warn("[islands] no templates/ directory found at %s", tmpl_dir);
    } else {
        struct dirent *ent;
        while ((ent = readdir(dp)) != NULL) {
            const char *nm = ent->d_name;
            size_t len = strlen(nm);
            if (len < 5 || strcmp(nm + len - 5, ".json") != 0) continue;
            char path[1024];
            snprintf(path, sizeof(path), "%s/%s", tmpl_dir, nm);
            load_template_file(path);
        }
        closedir(dp);
    }

    /* ── 2. Load islands.json instance configs ───────────────────────────── */
    char islands_path[512];
    snprintf(islands_path, sizeof(islands_path), "%s/islands.json", dir);

    struct json_object *arr = json_object_from_file(islands_path);
    if (!arr) {
        log_warn("[islands] could not load %s — keeping compiled-in defaults", islands_path);
        goto template_inheritance;
    }
    if (!json_object_is_type(arr, json_type_array)) {
        log_warn("[islands] %s is not a JSON array", islands_path);
        json_object_put(arr);
        goto template_inheritance;
    }

    for (int i = 0; i < (int)json_object_array_length(arr); i++) {
        struct json_object *entry = json_object_array_get_idx(arr, i);
        struct json_object *j     = NULL;

        if (!json_object_object_get_ex(entry, "id", &j)) continue;
        int id = json_object_get_int(j);

        IslandDef *isl = NULL;
        for (int k = 0; k < ISLAND_COUNT; k++) {
            if (ISLAND_PRESETS[k].id == id) { isl = &ISLAND_PRESETS[k]; break; }
        }
        if (!isl) { log_warn("[islands] islands.json has unknown id %d", id); continue; }

        /* Centre */
        struct json_object *centre = NULL;
        if (json_object_object_get_ex(entry, "centre", &centre)) {
            struct json_object *cx = NULL, *cy = NULL;
            json_object_object_get_ex(centre, "x", &cx);
            json_object_object_get_ex(centre, "y", &cy);
            if (cx) isl->x = (float)json_object_get_double(cx);
            if (cy) isl->y = (float)json_object_get_double(cy);
        }

        /* Rotation */
        if (json_object_object_get_ex(entry, "rotation_deg", &j))
            isl->rotation_deg = (float)json_object_get_double(j);

        /* Template name */
        if (json_object_object_get_ex(entry, "template", &j))
            snprintf(isl->template_name, sizeof(isl->template_name), "%s",
                     json_object_get_string(j));
    }
    json_object_put(arr);

template_inheritance:
    /* ── 3. Apply template shape + biome data to instances ───────────────── */
    for (int i = 0; i < ISLAND_COUNT; i++) {
        IslandDef *isl = &ISLAND_PRESETS[i];
        if (isl->template_name[0] == '\0') continue;

        IslandTemplate *t = find_template(isl->template_name);
        if (!t) {
            log_warn("[islands] island %d references unknown template '%s'",
                     isl->id, isl->template_name);
            continue;
        }

        isl->vertex_count = t->vertex_count;
        memcpy(isl->vx,  t->vx,  sizeof(float) * (size_t)t->vertex_count);
        memcpy(isl->vy,  t->vy,  sizeof(float) * (size_t)t->vertex_count);

        isl->grass_vertex_count = t->grass_vertex_count;
        memcpy(isl->gvx, t->gvx, sizeof(float) * (size_t)t->grass_vertex_count);
        memcpy(isl->gvy, t->gvy, sizeof(float) * (size_t)t->grass_vertex_count);

        isl->shallow_vertex_count = t->shallow_vertex_count;
        memcpy(isl->svx, t->svx, sizeof(float) * (size_t)t->shallow_vertex_count);
        memcpy(isl->svy, t->svy, sizeof(float) * (size_t)t->shallow_vertex_count);

        if (isl->poly_bound_r       == 0.0f) isl->poly_bound_r       = t->poly_bound_r;
        if (isl->grass_poly_scale   == 0.0f) isl->grass_poly_scale   = t->grass_poly_scale;
        if (isl->shallow_poly_scale == 0.0f) isl->shallow_poly_scale = t->shallow_poly_scale;

        isl->stone_poly_count = t->stone_poly_count;
        memcpy(isl->stone_vc, t->stone_vc, sizeof(isl->stone_vc));
        memcpy(isl->stone_vx, t->stone_vx, sizeof(isl->stone_vx));
        memcpy(isl->stone_vy, t->stone_vy, sizeof(isl->stone_vy));

        isl->metal_poly_count = t->metal_poly_count;
        memcpy(isl->metal_vc, t->metal_vc, sizeof(isl->metal_vc));
        memcpy(isl->metal_vx, t->metal_vx, sizeof(isl->metal_vx));
        memcpy(isl->metal_vy, t->metal_vy, sizeof(isl->metal_vy));

        log_info("[islands] island %d applied template '%s' (sand=%d metal_polys=%d)",
                 isl->id, t->name, isl->vertex_count, isl->metal_poly_count);
    }
}

