#define _GNU_SOURCE
/* world_save.c — World-state persistence (JSON).
 *
 * Save layout (data/world_state.json):
 * {
 *   "meta":    { "timestamp": <unix_s>, "ship_count": N, "npc_count": N, ... },
 *   "ships":   [ { id, seq, type, company, x, y, rot, vx, vy, av,
 *                  sail_openness, sail_angle, ammo, infinite_ammo,
 *                  is_sinking,
 *                  "modules": [ { id, type, lx, ly, lr, health, max_health } ] } ],
 *   "world_npcs": [ { id, name, role, company, x, y, rot,
 *                     ship_id, lx, ly, health, max_health, level, xp,
 *                     stat_health, stat_damage, stat_stamina, stat_weight } ],
 *   "placed_structures": [ { id, type, x, y, rot, island_id, company,
 *                            hp, max_hp, placer_id, placer_name, open } ],
 *   "island_resources": [ { island_id, "resources": [ { idx, health, alive } ] } ]
 * }
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>
#include <errno.h>

#include "sim/world_save.h"
#include "net/websocket_server_internal.h"
#include "sim/island.h"
#include "util/log.h"

/* ── Tiny JSON helpers ─────────────────────────────────────────────────────── */

/** Search for "key": in *json and read an unsigned int.  Returns true on hit. */
static bool ws_json_uint(const char *json, const char *key, unsigned *out) {
    char pat[80];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    return sscanf(p, "%u", out) == 1;
}

/** Search for "key": and read a float. */
static bool ws_json_float(const char *json, const char *key, float *out) {
    char pat[80];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    return sscanf(p, "%f", out) == 1;
}

/** Read a boolean field: "key": true|false */
static bool ws_json_bool(const char *json, const char *key, bool *out) {
    char pat[80];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    *out = (strncmp(p, "true", 4) == 0);
    return true;
}

/** Copy the value of a string field into buf (at most buf_len-1 chars). */
static bool ws_json_str(const char *json, const char *key,
                        char *buf, size_t buf_len) {
    char pat[80];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return false;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i < buf_len - 1) buf[i++] = *p++;
    buf[i] = '\0';
    return true;
}

/* ============================================================================
 * SAVE
 * ========================================================================== */

int world_save(const char *path) {
    if (!path) path = WORLD_SAVE_DEFAULT_PATH;

    /* Ensure parent directory exists */
    mkdir("data", 0755);

    FILE *f = fopen(path, "w");
    if (!f) {
        log_warn("world_save: cannot open '%s': %s", path, strerror(errno));
        return -1;
    }

    time_t now = time(NULL);

    /* Count active entities for metadata */
    int active_ships = 0;
    for (int i = 0; i < ship_count; i++)
        if (ships[i].active) active_ships++;
    int active_npcs = 0;
    for (int i = 0; i < world_npc_count; i++)
        if (world_npcs[i].active) active_npcs++;
    int active_structs = (int)placed_structure_count;

    /* ── meta ── */
    fprintf(f,
        "{\n"
        "  \"meta\": {\n"
        "    \"timestamp\": %ld,\n"
        "    \"ship_count\": %d,\n"
        "    \"npc_count\": %d,\n"
        "    \"structure_count\": %d\n"
        "  },\n",
        (long)now, active_ships, active_npcs, active_structs);

    /* ── ships ── */
    fprintf(f, "  \"ships\": [");
    bool first_ship = true;
    for (int i = 0; i < ship_count; i++) {
        const SimpleShip *s = &ships[i];
        if (!s->active) continue;

        if (!first_ship) fprintf(f, ",");
        first_ship = false;

        fprintf(f,
            "\n    {\n"
            "      \"id\": %u,\n"
            "      \"seq\": %u,\n"
            "      \"type\": %u,\n"
            "      \"company\": %u,\n"
            "      \"x\": %.3f,\n"
            "      \"y\": %.3f,\n"
            "      \"rot\": %.6f,\n"
            "      \"vx\": %.3f,\n"
            "      \"vy\": %.3f,\n"
            "      \"av\": %.6f,\n"
            "      \"sail_openness\": %u,\n"
            "      \"sail_angle\": %.6f,\n"
            "      \"ammo\": %u,\n"
            "      \"infinite_ammo\": %s,\n"
            "      \"is_sinking\": %s,\n"
            "      \"modules\": [",
            (unsigned)s->ship_id,
            (unsigned)s->ship_seq,
            (unsigned)s->ship_type,
            (unsigned)s->company_id,
            (double)s->x,
            (double)s->y,
            (double)s->rotation,
            (double)s->velocity_x,
            (double)s->velocity_y,
            (double)s->angular_velocity,
            (unsigned)s->desired_sail_openness,
            (double)s->desired_sail_angle,
            (unsigned)s->cannon_ammo,
            s->infinite_ammo  ? "true" : "false",
            s->is_sinking     ? "true" : "false"
        );

        for (uint8_t m = 0; m < s->module_count; m++) {
            const ShipModule *mod = &s->modules[m];
            if (m > 0) fprintf(f, ",");
            fprintf(f,
                "\n        {"
                "\"id\":%u,"
                "\"type\":%u,"
                "\"lx\":%.4f,"
                "\"ly\":%.4f,"
                "\"lr\":%.6f,"
                "\"health\":%u,"
                "\"max_health\":%u"
                "}",
                (unsigned)mod->id,
                (unsigned)mod->type_id,
                (double)((float)mod->local_pos.x / 65536.0f),
                (double)((float)mod->local_pos.y / 65536.0f),
                (double)((float)mod->local_rot    / 65536.0f),
                (unsigned)(mod->health    < 0 ? 0 : (uint32_t)mod->health),
                (unsigned)(mod->max_health < 0 ? 0 : (uint32_t)mod->max_health)
            );
        }

        fprintf(f, "\n      ]\n    }");
    }
    fprintf(f, "\n  ],\n");

    /* ── world_npcs ── */
    fprintf(f, "  \"world_npcs\": [");
    bool first_npc = true;
    for (int i = 0; i < world_npc_count; i++) {
        const WorldNpc *n = &world_npcs[i];
        if (!n->active) continue;

        if (!first_npc) fprintf(f, ",");
        first_npc = false;

        fprintf(f,
            "\n    {\n"
            "      \"id\": %u,\n"
            "      \"name\": \"%s\",\n"
            "      \"role\": %u,\n"
            "      \"company\": %u,\n"
            "      \"x\": %.3f,\n"
            "      \"y\": %.3f,\n"
            "      \"rot\": %.6f,\n"
            "      \"ship_id\": %u,\n"
            "      \"lx\": %.3f,\n"
            "      \"ly\": %.3f,\n"
            "      \"health\": %u,\n"
            "      \"max_health\": %u,\n"
            "      \"level\": %u,\n"
            "      \"xp\": %u,\n"
            "      \"stat_health\": %u,\n"
            "      \"stat_damage\": %u,\n"
            "      \"stat_stamina\": %u,\n"
            "      \"stat_weight\": %u\n"
            "    }",
            (unsigned)n->id,
            n->name,
            (unsigned)n->role,
            (unsigned)n->company_id,
            (double)n->x,
            (double)n->y,
            (double)n->rotation,
            (unsigned)n->ship_id,
            (double)n->local_x,
            (double)n->local_y,
            (unsigned)n->health,
            (unsigned)n->max_health,
            (unsigned)n->npc_level,
            (unsigned)n->xp,
            (unsigned)n->stat_health,
            (unsigned)n->stat_damage,
            (unsigned)n->stat_stamina,
            (unsigned)n->stat_weight
        );
    }
    fprintf(f, "\n  ],\n");

    /* ── placed_structures ── */
    fprintf(f, "  \"placed_structures\": [");
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        const PlacedStructure *ps = &placed_structures[i];
        if (!ps->active) continue;

        if (i > 0) fprintf(f, ",");
        fprintf(f,
            "\n    {\n"
            "      \"id\": %u,\n"
            "      \"type\": %u,\n"
            "      \"x\": %.3f,\n"
            "      \"y\": %.3f,\n"
            "      \"rot\": %.3f,\n"
            "      \"island_id\": %u,\n"
            "      \"company\": %u,\n"
            "      \"hp\": %u,\n"
            "      \"max_hp\": %u,\n"
            "      \"placer_id\": %u,\n"
            "      \"placer_name\": \"%s\",\n"
            "      \"open\": %s\n"
            "    }",
            (unsigned)ps->id,
            (unsigned)ps->type,
            (double)ps->x,
            (double)ps->y,
            (double)ps->rotation,
            (unsigned)ps->island_id,
            (unsigned)ps->company_id,
            (unsigned)ps->hp,
            (unsigned)ps->max_hp,
            (unsigned)ps->placer_id,
            ps->placer_name,
            ps->open ? "true" : "false"
        );
    }
    fprintf(f, "\n  ],\n");

    /* ── island_resources ── */
    fprintf(f, "  \"island_resources\": [");
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        const IslandDef *isl = &ISLAND_PRESETS[ii];
        if (isl->resource_count == 0) continue;

        if (ii > 0) fprintf(f, ",");
        fprintf(f, "\n    {\n      \"island_id\": %d,\n      \"resources\": [", isl->id);

        for (int r = 0; r < isl->resource_count; r++) {
            const IslandResource *res = &isl->resources[r];
            if (r > 0) fprintf(f, ",");
            fprintf(f,
                "\n        {\"idx\":%d,\"health\":%d,\"alive\":%s}",
                r,
                res->health,
                res->health > 0 ? "true" : "false"
            );
        }
        fprintf(f, "\n      ]\n    }");
    }
    fprintf(f, "\n  ]\n}\n");

    fclose(f);
    log_info("💾 World saved to '%s' (%d ships, %d NPCs, %d structures)",
             path, active_ships, active_npcs, active_structs);
    return 0;
}

/* ============================================================================
 * LOAD
 * ========================================================================== */

/** Read up to max_bytes from path into a newly malloc'd buffer.
 *  Caller must free().  Returns NULL on error. */
static char *read_file_to_buf(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0 || sz > 64 * 1024 * 1024 /* 64 MiB max */) { fclose(f); return NULL; }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[sz] = '\0';
    if (out_len) *out_len = (size_t)sz;
    return buf;
}

/** Find the Nth JSON object '{...}' inside an array starting at *src.
 *  Advances *src past the closing '}' on success.
 *  Returns a malloc'd NUL-terminated copy of the object, or NULL at end. */
static char *next_json_object(const char **src) {
    const char *p = *src;
    while (*p && *p != '{' && *p != ']') p++;
    if (!*p || *p == ']') { *src = p; return NULL; }
    /* Find matching '}' — track nesting depth */
    const char *start = p++;
    int depth = 1;
    while (*p && depth > 0) {
        if (*p == '{') depth++;
        else if (*p == '}') depth--;
        p++;
    }
    if (depth != 0) { *src = p; return NULL; }
    size_t len = (size_t)(p - start);
    char *obj = malloc(len + 1);
    if (!obj) { *src = p; return NULL; }
    memcpy(obj, start, len);
    obj[len] = '\0';
    *src = p;
    return obj;
}

/** Find the JSON array for "key" and return a pointer to its '['. */
static const char *find_array(const char *json, const char *key) {
    char pat[80];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t') p++;
    if (*p != '[') return NULL;
    return p + 1; /* point just past '[' */
}

int world_load(const char *path) {
    if (!path) path = WORLD_SAVE_DEFAULT_PATH;

    size_t len = 0;
    char *buf = read_file_to_buf(path, &len);
    if (!buf) {
        log_warn("world_load: cannot open '%s': %s", path, strerror(errno));
        return -1;
    }

    /* ── ships ── */
    {
        /* Clear existing ships first (both SimpleShip and sim layers) */
        for (int i = 0; i < ship_count; i++) {
            ships[i].active = false;
            ships[i].module_count = 0;
        }
        ship_count   = 0;
        next_ship_seq = 1;

        /* Also wipe the authoritative sim-layer ships so init_simulation's
         * two default ships don't survive alongside the loaded ones. */
        if (global_sim) {
            memset(global_sim->ships, 0,
                   sizeof(global_sim->ships[0]) * global_sim->ship_count);
            global_sim->ship_count = 0;
        }

        const char *arr = find_array(buf, "ships");
        if (arr) {
            char *obj;
            while ((obj = next_json_object(&arr)) != NULL) {
                unsigned id = 0, seq = 1, type = 3, company = 1;
                float x = 0, y = 0, rot = 0, vx = 0, vy = 0, av = 0;
                float sail_angle = 0;
                unsigned sail_openness = 0, ammo = 0;
                bool infinite_ammo = false, is_sinking = false;

                ws_json_uint(obj,  "id",            &id);
                ws_json_uint(obj,  "seq",           &seq);
                ws_json_uint(obj,  "type",          &type);
                ws_json_uint(obj,  "company",       &company);
                ws_json_float(obj, "x",             &x);
                ws_json_float(obj, "y",             &y);
                ws_json_float(obj, "rot",           &rot);
                ws_json_float(obj, "vx",            &vx);
                ws_json_float(obj, "vy",            &vy);
                ws_json_float(obj, "av",            &av);
                ws_json_uint(obj,  "sail_openness", &sail_openness);
                ws_json_float(obj, "sail_angle",    &sail_angle);
                ws_json_uint(obj,  "ammo",          &ammo);
                ws_json_bool(obj,  "infinite_ammo", &infinite_ammo);
                ws_json_bool(obj,  "is_sinking",    &is_sinking);

                /* Recreate ship through the normal creation path */
                if (ship_count < MAX_SIMPLE_SHIPS) {
                    uint32_t new_id = websocket_server_create_ship(
                        x, y, (uint8_t)company, 0xFF);
                    if (new_id) {
                        SimpleShip *s = find_ship((uint16_t)new_id);
                        if (s) {
                            s->rotation           = rot;
                            s->velocity_x         = vx;
                            s->velocity_y         = vy;
                            s->angular_velocity   = av;
                            s->desired_sail_openness = (uint8_t)sail_openness;
                            s->desired_sail_angle = sail_angle;
                            s->cannon_ammo        = (uint16_t)ammo;
                            s->infinite_ammo      = infinite_ammo;
                            s->is_sinking         = is_sinking;
                        }

                        /* Restore module health states */
                        const char *marr = find_array(obj, "modules");
                        if (marr && s) {
                            char *mobj;
                            uint8_t mi = 0;
                            while ((mobj = next_json_object(&marr)) != NULL
                                   && mi < s->module_count) {
                                unsigned mtype = 0, mhealth = 0, mmax = 0;
                                float mlx = 0, mly = 0;
                                ws_json_uint(mobj,  "type",       &mtype);
                                ws_json_float(mobj, "lx",         &mlx);
                                ws_json_float(mobj, "ly",         &mly);
                                ws_json_uint(mobj,  "health",     &mhealth);
                                ws_json_uint(mobj,  "max_health", &mmax);

                                /* Match module by type + approximate position */
                                for (uint8_t k = 0; k < s->module_count; k++) {
                                    ShipModule *m = &s->modules[k];
                                    if ((unsigned)m->type_id != mtype) continue;
                                    float dx = (float)m->local_pos.x / 65536.0f - mlx;
                                    float dy = (float)m->local_pos.y / 65536.0f - mly;
                                    if (dx * dx + dy * dy > 0.01f) continue;
                                    m->health = (int32_t)mhealth;
                                    if (mmax > 0) m->max_health = (int32_t)mmax;
                                    break;
                                }
                                free(mobj);
                                mi++;
                            }
                        }
                    }
                }
                free(obj);
            }
        }
    }

    /* ── world_npcs ── */
    {
        /* Reset NPC list */
        for (int i = 0; i < world_npc_count; i++)
            world_npcs[i].active = false;
        world_npc_count  = 0;
        next_world_npc_id = 9000;

        const char *arr = find_array(buf, "world_npcs");
        if (arr && world_npc_count < MAX_WORLD_NPCS) {
            char *obj;
            while ((obj = next_json_object(&arr)) != NULL
                   && world_npc_count < MAX_WORLD_NPCS) {
                WorldNpc *n = &world_npcs[world_npc_count];
                memset(n, 0, sizeof(*n));

                unsigned id = 0, role = 0, company = 0, ship_id = 0;
                unsigned health = 100, max_health = 100, level = 1;
                unsigned xp = 0;
                unsigned sh = 0, sd = 0, ss = 0, sw = 0;
                float x = 0, y = 0, rot = 0, lx = 0, ly = 0;

                ws_json_uint(obj,  "id",          &id);
                ws_json_str (obj,  "name",        n->name, sizeof(n->name));
                ws_json_uint(obj,  "role",        &role);
                ws_json_uint(obj,  "company",     &company);
                ws_json_float(obj, "x",           &x);
                ws_json_float(obj, "y",           &y);
                ws_json_float(obj, "rot",         &rot);
                ws_json_uint(obj,  "ship_id",     &ship_id);
                ws_json_float(obj, "lx",          &lx);
                ws_json_float(obj, "ly",          &ly);
                ws_json_uint(obj,  "health",      &health);
                ws_json_uint(obj,  "max_health",  &max_health);
                ws_json_uint(obj,  "level",       &level);
                ws_json_uint(obj,  "xp",          &xp);
                ws_json_uint(obj,  "stat_health", &sh);
                ws_json_uint(obj,  "stat_damage", &sd);
                ws_json_uint(obj,  "stat_stamina",&ss);
                ws_json_uint(obj,  "stat_weight", &sw);

                n->id         = id ? (uint16_t)id : next_world_npc_id;
                n->role       = (NpcRole)role;
                n->company_id = (uint8_t)company;
                n->x          = x;
                n->y          = y;
                n->rotation   = rot;
                n->ship_id    = (uint16_t)ship_id;
                n->local_x    = lx;
                n->local_y    = ly;
                n->health     = (uint16_t)health;
                n->max_health = (uint16_t)max_health;
                n->npc_level  = (uint8_t)level;
                n->xp         = (uint32_t)xp;
                n->stat_health  = (uint8_t)sh;
                n->stat_damage  = (uint8_t)sd;
                n->stat_stamina = (uint8_t)ss;
                n->stat_weight  = (uint8_t)sw;
                n->move_speed = 80.0f;
                n->interact_radius = 60.0f;
                n->active     = true;

                if (n->id >= next_world_npc_id) next_world_npc_id = n->id + 1;
                world_npc_count++;
                free(obj);
            }
        }
    }

    /* ── placed_structures ── */
    {
        memset(placed_structures, 0, sizeof(PlacedStructure) * placed_structure_count);
        placed_structure_count = 0;
        next_structure_id = 1;

        const char *arr = find_array(buf, "placed_structures");
        if (arr) {
            char *obj;
            while ((obj = next_json_object(&arr)) != NULL
                   && placed_structure_count < MAX_PLACED_STRUCTURES) {
                PlacedStructure *ps = &placed_structures[placed_structure_count];
                memset(ps, 0, sizeof(*ps));

                unsigned id = 0, type = 0, island_id = 0, company = 0;
                unsigned hp = 100, max_hp = 100, placer_id = 0;
                float x = 0, y = 0, rot = 0;
                bool open = false;

                ws_json_uint(obj,  "id",          &id);
                ws_json_uint(obj,  "type",        &type);
                ws_json_float(obj, "x",           &x);
                ws_json_float(obj, "y",           &y);
                ws_json_float(obj, "rot",         &rot);
                ws_json_uint(obj,  "island_id",   &island_id);
                ws_json_uint(obj,  "company",     &company);
                ws_json_uint(obj,  "hp",          &hp);
                ws_json_uint(obj,  "max_hp",      &max_hp);
                ws_json_uint(obj,  "placer_id",   &placer_id);
                ws_json_str (obj,  "placer_name", ps->placer_name,
                             sizeof(ps->placer_name));
                ws_json_bool(obj,  "open",        &open);

                ps->id         = id ? (uint16_t)id : next_structure_id;
                ps->type       = (PlacedStructureType)type;
                ps->x          = x;
                ps->y          = y;
                ps->rotation   = rot;
                ps->island_id  = (uint8_t)island_id;
                ps->company_id = (uint8_t)company;
                ps->hp         = (uint16_t)hp;
                ps->max_hp     = (uint16_t)max_hp;
                ps->placer_id  = placer_id;
                ps->open       = open;
                ps->active     = true;

                if (ps->id >= next_structure_id) next_structure_id = ps->id + 1;
                placed_structure_count++;
                free(obj);
            }
        }
    }

    /* ── island_resources ── */
    {
        const char *arr = find_array(buf, "island_resources");
        if (arr) {
            char *iobj;
            while ((iobj = next_json_object(&arr)) != NULL) {
                unsigned island_id = 0;
                ws_json_uint(iobj, "island_id", &island_id);

                /* Find the matching preset */
                IslandDef *isl = NULL;
                for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                    if ((unsigned)ISLAND_PRESETS[ii].id == island_id) {
                        isl = &ISLAND_PRESETS[ii];
                        break;
                    }
                }

                if (isl) {
                    const char *rarr = find_array(iobj, "resources");
                    if (rarr) {
                        char *robj;
                        while ((robj = next_json_object(&rarr)) != NULL) {
                            unsigned idx = 0, health = 0;
                            ws_json_uint(robj, "idx",    &idx);
                            ws_json_uint(robj, "health", &health);
                            if ((int)idx < isl->resource_count)
                                isl->resources[idx].health = (int)health;
                            free(robj);
                        }
                    }
                }
                free(iobj);
            }
        }
    }

    free(buf);
    log_info("🌍 World loaded from '%s' (%d ships, %d NPCs, %d structures)",
             path, ship_count, world_npc_count, (int)placed_structure_count);
    return 0;
}

/* ============================================================================
 * ARCHIVE  —  hourly timestamped snapshots, oldest pruned to keep ≤ 48 files
 * ========================================================================== */

#include <dirent.h>

/** qsort comparator for C strings — sorts archive filenames ascending (oldest first). */
static int str_cmp_asc(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

int world_save_archive(void) {
    /* 1. Ensure archive directory exists */
    mkdir("data",             0755);
    mkdir(WORLD_SAVE_ARCHIVE_DIR, 0755);

    /* 2. Build timestamped filename */
    time_t now = time(NULL);
    struct tm *t = localtime(&now);
    char fname[64];
    strftime(fname, sizeof(fname), "world_%Y-%m-%d_%H-%M-%S.json", t);

    char full_path[256];
    snprintf(full_path, sizeof(full_path), "%s/%s",
             WORLD_SAVE_ARCHIVE_DIR, fname);

    /* 3. Write the snapshot */
    int rc = world_save(full_path);
    if (rc != 0) return rc;
    log_info("🗄️  Archive snapshot written: %s", full_path);

    /* 4. Prune oldest files to keep at most WORLD_ARCHIVE_MAX_FILES */
    DIR *dir = opendir(WORLD_SAVE_ARCHIVE_DIR);
    if (!dir) return 0; /* directory just created — nothing to prune */

    /* Collect filenames that start with "world_" */
    char *names[512];
    int   count = 0;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL && count < 512) {
        if (strncmp(de->d_name, "world_", 6) == 0 &&
            strstr(de->d_name, ".json")) {
            names[count++] = strdup(de->d_name);
        }
    }
    closedir(dir);

    if (count > WORLD_ARCHIVE_MAX_FILES) {
        /* Sort ascending so oldest (lexicographically smallest timestamp) come first */
        qsort(names, (size_t)count, sizeof(char *), str_cmp_asc);

        int to_delete = count - WORLD_ARCHIVE_MAX_FILES;
        for (int i = 0; i < to_delete; i++) {
            char del_path[256];
            snprintf(del_path, sizeof(del_path), "%s/%s",
                     WORLD_SAVE_ARCHIVE_DIR, names[i]);
            if (remove(del_path) == 0)
                log_info("🗑️  Pruned old archive: %s", names[i]);
            else
                log_warn("world_save_archive: failed to delete '%s': %s",
                         del_path, strerror(errno));
        }
    }

    for (int i = 0; i < count; i++) free(names[i]);
    return 0;
}

