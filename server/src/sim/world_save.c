#define _GNU_SOURCE
/* world_save.c — World-state persistence (JSON).
 *
 * Save layout (data/world_state.json):
 * {
 *   "meta":    { "timestamp": <unix_s>, "ship_count": N, "npc_count": N, ... },
 *   "ships":   [ { id, seq, type, company, x, y, rot, vx, vy, av,
 *                  sail_openness, sail_angle, ammo, infinite_ammo,
 *                  is_sinking,
 *                  "modules": [ { id, type, lx, ly, lr, health, max_health } ],
 *                  "weapon_groups": [...],
 *                  "level_stats": { xp, w, r, d, c, s } } ],
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
#include <math.h>
#include <sys/stat.h>
#include <errno.h>

#include "sim/world_save.h"
#include "sim/ship_level.h"
#include "net/websocket_server_internal.h"
#include "net/module_interactions.h"
#include "sim/island.h"
#include "sim/module_types.h"
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

    /* Ensure parent directories exist */
    mkdir("data",       0755);
    mkdir("data/saves", 0755);

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

        /* Check if the sim-layer ship still has SHIP_FLAG_SCAFFOLDED set */
        bool is_scaffolded = false;
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id == (uint32_t)s->ship_id) {
                    is_scaffolded = (global_sim->ships[si].flags & SHIP_FLAG_SCAFFOLDED) != 0;
                    break;
                }
            }
        }

        fprintf(f,
            "\n    {\n"
            "      \"id\": %u,\n"
            "      \"seq\": %u,\n"
            "      \"name\": \"%s\",\n"
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
            "      \"is_scaffolded\": %s,\n"
            "      \"modules\": [",
            (unsigned)s->ship_id,
            (unsigned)s->ship_seq,
            s->ship_name,
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
            s->is_sinking     ? "true" : "false",
            is_scaffolded     ? "true" : "false"
        );

        for (uint8_t m = 0; m < s->module_count; m++) {
            const ShipModule *mod = &s->modules[m];
            if (m > 0) fprintf(f, ",");
            /* gp_snap: gunport.snap_idx or cannon.gunport_snap_idx; 0xFF = not linked */
            unsigned save_gp_snap =
                (mod->type_id == MODULE_TYPE_CANNON) ? (unsigned)mod->data.cannon.gunport_snap_idx :
                (mod->type_id == MODULE_TYPE_GUNPORT) ? (unsigned)mod->data.gunport.snap_idx : 0xFFu;
            unsigned save_gp_open =
                (mod->type_id == MODULE_TYPE_GUNPORT) ? (unsigned)mod->data.gunport.is_open : 0u;
            fprintf(f,
                "\n        {"
                "\"id\":%u,"
                "\"type\":%u,"
                "\"lx\":%.4f,"
                "\"ly\":%.4f,"
                "\"lr\":%.6f,"
                "\"health\":%u,"
                "\"max_health\":%u,"
                "\"gp_snap\":%u,"
                "\"gp_open\":%u,"
                "\"deck\":%u"
                "}",
                (unsigned)mod->id,
                (unsigned)mod->type_id,
                (double)((float)mod->local_pos.x / 65536.0f),
                (double)((float)mod->local_pos.y / 65536.0f),
                (double)((float)mod->local_rot    / 65536.0f),
                (unsigned)(mod->health    < 0 ? 0 : (uint32_t)mod->health),
                (unsigned)(mod->max_health < 0 ? 0 : (uint32_t)mod->max_health),
                save_gp_snap,
                save_gp_open,
                (unsigned)mod->deck_id
            );
        }

        fprintf(f, "\n      ]");
        /* Weapon groups — serialise all groups that have at least one weapon */
        fprintf(f, ",\n      \"weapon_groups\": [");
        bool first_wg = true;
        for (uint8_t co = 0; co < MAX_COMPANIES; co++) {
            for (uint8_t g = 0; g < MAX_WEAPON_GROUPS; g++) {
                const WeaponGroup *wg = &s->weapon_groups[co][g];
                if (wg->weapon_count == 0) continue;
                if (!first_wg) fprintf(f, ",");
                first_wg = false;
                fprintf(f, "\n        {\"co\":%u,\"idx\":%u,\"mode\":%u,\"target\":%u,\"gpopen\":%u,\"wids\":[",
                        (unsigned)co, (unsigned)g, (unsigned)wg->mode,
                        (unsigned)wg->target_ship_id, (unsigned)wg->gunports_open);
                for (uint8_t wi = 0; wi < wg->weapon_count && wi < MAX_WEAPONS_PER_GROUP; wi++) {
                    if (wi > 0) fprintf(f, ",");
                    fprintf(f, "%u", (unsigned)wg->weapon_ids[wi]);
                }
                fprintf(f, "]}");
            }
        }
        fprintf(f, "\n      ]");
        /* Ship level stats — sourced from the authoritative sim layer */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if ((uint32_t)global_sim->ships[si].id != (uint32_t)s->ship_id) continue;
                const ShipLevelStats *ls = &global_sim->ships[si].level_stats;
                fprintf(f,
                    ",\n      \"level_stats\": {"
                    "\"xp\":%u,"
                    "\"w\":%u,\"r\":%u,\"d\":%u,\"c\":%u,\"s\":%u"
                    "}",
                    (unsigned)ls->xp,
                    (unsigned)ls->levels[SHIP_ATTR_WEIGHT],
                    (unsigned)ls->levels[SHIP_ATTR_RESISTANCE],
                    (unsigned)ls->levels[SHIP_ATTR_DAMAGE],
                    (unsigned)ls->levels[SHIP_ATTR_CREW],
                    (unsigned)ls->levels[SHIP_ATTR_STURDINESS]
                );
                break;
            }
        }
        fprintf(f, "\n    }");
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
            "      \"stat_weight\": %u,\n"
            "      \"assigned_weapon_id\": %u,\n"
            "      \"wants_cannon\": %u,\n"
            "      \"npc_state\": %u,\n"
            "      \"owner_player_id\": %u\n"
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
            (unsigned)n->stat_weight,
            (unsigned)n->assigned_weapon_id,
            (unsigned)n->wants_cannon,
            (unsigned)n->state,
            (unsigned)n->owner_player_id
        );
    }
    fprintf(f, "\n  ],\n");

    /* ── placed_structures ── */
    fprintf(f, "  \"placed_structures\": [");
    bool first_struct = true;
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        const PlacedStructure *ps = &placed_structures[i];
        if (!ps->active) continue;
        /* Wrecks are transient; do not persist across restarts */
        if (ps->type == STRUCT_WRECK) continue;

        if (!first_struct) fprintf(f, ",");
        first_struct = false;
        /* Build "dominators":[…] list (omitted when empty). */
        char dom_buf[512]; dom_buf[0] = '\0';
        if (ps->dominator_count > 0) {
            int dp = 0;
            dp += snprintf(dom_buf + dp, sizeof(dom_buf) - dp, ",\n      \"dominators\": [");
            for (uint8_t di = 0; di < ps->dominator_count && dp < (int)sizeof(dom_buf) - 16; di++) {
                dp += snprintf(dom_buf + dp, sizeof(dom_buf) - dp,
                               "%s%u", di == 0 ? "" : ",", (unsigned)ps->dominators[di]);
            }
            snprintf(dom_buf + dp, sizeof(dom_buf) - dp, "]");
        }
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
            "      \"target_hp\": %u,\n"
            "      \"placer_id\": %u,\n"
            "      \"placer_name\": \"%s\",\n"
            "      \"open\": %s,\n"
            "      \"locked\": %s,\n"
            "      \"construction_phase\": %u,\n"
            "      \"construction_company\": %u,\n"
            "      \"modules_placed\": %u,\n"
            "      \"scaffolded_ship_id\": %u%s\n"
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
            (unsigned)ps->target_hp,
            (unsigned)ps->placer_id,
            ps->placer_name,
            ps->open ? "true" : "false",
            ps->door_locked ? "true" : "false",
            (unsigned)ps->construction_phase,
            (unsigned)ps->construction_company,
            (unsigned)ps->modules_placed,
            (unsigned)ps->scaffolded_ship_id,
            dom_buf
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
                "\n        {\"idx\":%d,\"health\":%d,\"alive\":%s,\"respawn_at\":%u}",
                r,
                res->health,
                res->health > 0 ? "true" : "false",
                res->respawn_at_ms
            );
        }
        fprintf(f, "\n      ]\n    }");
    }
    fprintf(f, "\n  ]\n}\n");
    fclose(f);

    /* ── dynamic_companies: saved to data/dynamic_companies.json ── */
    {
        char dcp[256];
        snprintf(dcp, sizeof(dcp), "data/dynamic_companies.json");
        FILE *fc = fopen(dcp, "w");
        if (fc) {
            fprintf(fc, "{\n  \"next_id\": %u,\n  \"companies\": [", next_dynamic_company_id);
            bool first_co = true;
            for (int ci = 0; ci < dynamic_company_count; ci++) {
                const DynamicCompany *dc = &dynamic_companies[ci];
                if (!dc->active) continue;
                if (!first_co) fprintf(fc, ",");
                first_co = false;
                fprintf(fc, "\n    {\"id\":%u,\"name\":\"%s\",\"founderId\":%u}",
                        dc->id, dc->name, dc->founder_id);
            }
            fprintf(fc, "\n  ]\n}\n");
            fclose(fc);
        }
    }
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
    /* Remap table: saved entity IDs → newly allocated entity IDs.  Used below
     * to fix up NPC ship_id references that pointed to old IDs.           */
    uint32_t id_remap_old[MAX_SIMPLE_SHIPS];
    uint32_t id_remap_new[MAX_SIMPLE_SHIPS];
    int      id_remap_count = 0;
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
                bool infinite_ammo = false, is_sinking = false, is_scaffolded = false;

                char ship_name[32] = {0};
                ws_json_uint(obj,  "id",            &id);
                ws_json_uint(obj,  "seq",           &seq);
                ws_json_str (obj,  "name",          ship_name, sizeof(ship_name));
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
                ws_json_bool(obj,  "is_scaffolded", &is_scaffolded);

                /* Recreate ship through the normal creation path */
                if (ship_count < MAX_SIMPLE_SHIPS) {
                    /* Scaffolded ships are bare skeletons; finished ships get all modules */
                    uint8_t mods_placed = is_scaffolded ? 0 : 0xFF;
                    uint32_t new_id = websocket_server_create_ship(
                        x, y, (uint8_t)company, mods_placed);
                    /* Record old→new mapping so NPC ship_ids can be patched */
                    if (new_id && id && id_remap_count < MAX_SIMPLE_SHIPS) {
                        id_remap_old[id_remap_count] = (uint32_t)id;
                        id_remap_new[id_remap_count] = new_id;
                        id_remap_count++;
                    }
                    if (new_id) {
                        SimpleShip *s = find_ship((uint16_t)new_id);
                        if (s) {
                            if (ship_name[0])
                                strncpy(s->ship_name, ship_name, sizeof(s->ship_name) - 1);
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

                        /* Also restore rotation/velocity on the sim layer so that
                         * sync_simple_ships_from_simulation() doesn't overwrite the
                         * SimpleShip values with the zero-rotation spawn defaults. */
                        if (global_sim) {
                            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                if ((uint32_t)global_sim->ships[si].id != new_id) continue;
                                global_sim->ships[si].rotation =
                                    Q16_FROM_FLOAT(rot);
                                global_sim->ships[si].velocity.x =
                                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(vx));
                                global_sim->ships[si].velocity.y =
                                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(vy));
                                global_sim->ships[si].angular_velocity =
                                    Q16_FROM_FLOAT(av);
                                /* Restore scaffolded flag — prevents plank-drain sinking */
                                if (is_scaffolded)
                                    global_sim->ships[si].flags |= SHIP_FLAG_SCAFFOLDED;
                                break;
                            }
                        }

                        /* Restore module health states */
                        const char *marr = find_array(obj, "modules");
                        if (marr && s) {
                            char *mobj;
                            uint8_t mi = 0;
                            if (is_scaffolded) {
                                /* Scaffolded ship: no default modules were created.
                                 * Add each saved module directly using the new ship_seq. */
                                struct Ship *sim_ship = NULL;
                                if (global_sim) {
                                    for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                        if ((uint32_t)global_sim->ships[si].id == new_id) {
                                            sim_ship = &global_sim->ships[si];
                                            break;
                                        }
                                    }
                                }
                                while ((mobj = next_json_object(&marr)) != NULL) {
                                    unsigned saved_id = 0, mtype = 0, mhealth = 0, mmax = 0;
                                    unsigned mgp_snap = 0xFF, mgp_open = 0, mdeck = 0xFF;
                                    float mlx = 0, mly = 0, mlr = 0;
                                    ws_json_uint(mobj,  "id",         &saved_id);
                                    ws_json_uint(mobj,  "type",       &mtype);
                                    ws_json_float(mobj, "lx",         &mlx);
                                    ws_json_float(mobj, "ly",         &mly);
                                    ws_json_float(mobj, "lr",         &mlr);
                                    ws_json_uint(mobj,  "health",     &mhealth);
                                    ws_json_uint(mobj,  "max_health", &mmax);
                                    ws_json_uint(mobj,  "gp_snap",    &mgp_snap);
                                    ws_json_uint(mobj,  "gp_open",    &mgp_open);
                                    ws_json_uint(mobj,  "deck",       &mdeck);
                                    /* Rebuild MID with new ship_seq, preserving the offset */
                                    uint8_t offset = (uint8_t)(saved_id & 0xFF);
                                    uint16_t new_mid = (uint16_t)((s->ship_seq << 8) | offset);
                                    Vec2Q16 pos = {
                                        (q16_t)(int32_t)(mlx * 65536.0f),
                                        (q16_t)(int32_t)(mly * 65536.0f)
                                    };
                                    q16_t rot = (q16_t)(int32_t)(mlr * 65536.0f);
                                    ShipModule new_mod = module_create(new_mid, (ModuleTypeId)mtype, pos, rot);
                                    new_mod.health     = (int32_t)mhealth;
                                    new_mod.max_health = (int32_t)(mmax > 0 ? mmax : (unsigned)new_mod.max_health);
                                    /* Restore gunport / cannon link data */
                                    if ((ModuleTypeId)mtype == MODULE_TYPE_CANNON)
                                        new_mod.data.cannon.gunport_snap_idx = (uint8_t)mgp_snap;
                                    else if ((ModuleTypeId)mtype == MODULE_TYPE_GUNPORT) {
                                        new_mod.data.gunport.snap_idx = (uint8_t)mgp_snap;
                                        new_mod.data.gunport.is_open  = (uint8_t)(mgp_open & 1);
                                    }
                                    new_mod.deck_id = (uint8_t)mdeck;
                                    /* Add to SimpleShip layer */
                                    if (s->module_count < MAX_MODULES_PER_SHIP)
                                        s->modules[s->module_count++] = new_mod;
                                    /* Add to sim layer */
                                    if (sim_ship && sim_ship->module_count < MAX_MODULES_PER_SHIP)
                                        sim_ship->modules[sim_ship->module_count++] = new_mod;
                                    free(mobj);
                                    mi++;
                                }
                            } else {
                                /* Finished ship: modules were created by websocket_server_create_ship;
                                 * match saved modules by type + position to restore health.
                                 * Dynamically-placed modules (ramps) have no default slot — add them. */
                                while ((mobj = next_json_object(&marr)) != NULL) {
                                    unsigned mtype = 0, mhealth = 0, mmax = 0, msaved_id = 0;
                                    unsigned mgp_snap = 0xFF, mgp_open = 0, mdeck = 0xFF;
                                    float mlx = 0, mly = 0, mlr = 0;
                                    ws_json_uint(mobj,  "id",         &msaved_id);
                                    ws_json_uint(mobj,  "type",       &mtype);
                                    ws_json_float(mobj, "lx",         &mlx);
                                    ws_json_float(mobj, "ly",         &mly);
                                    ws_json_float(mobj, "lr",         &mlr);
                                    ws_json_uint(mobj,  "health",     &mhealth);
                                    ws_json_uint(mobj,  "max_health", &mmax);
                                    ws_json_uint(mobj,  "gp_snap",    &mgp_snap);
                                    ws_json_uint(mobj,  "gp_open",    &mgp_open);
                                    ws_json_uint(mobj,  "deck",       &mdeck);

                                    bool matched = false;
                                    /* Match module by type + approximate position */
                                    for (uint8_t k = 0; k < s->module_count; k++) {
                                        ShipModule *m = &s->modules[k];
                                        if ((unsigned)m->type_id != mtype) continue;
                                        float dx = (float)m->local_pos.x / 65536.0f - mlx;
                                        float dy = (float)m->local_pos.y / 65536.0f - mly;
                                        if (dx * dx + dy * dy > 0.01f) continue;
                                        m->health    = (int32_t)mhealth;
                                        m->local_rot = (q16_t)(int32_t)(mlr * 65536.0f);
                                        if (mmax > 0) m->max_health = (int32_t)mmax;
                                        /* Restore gunport / cannon link data */
                                        if ((ModuleTypeId)mtype == MODULE_TYPE_CANNON)
                                            m->data.cannon.gunport_snap_idx = (uint8_t)mgp_snap;
                                        else if ((ModuleTypeId)mtype == MODULE_TYPE_GUNPORT) {
                                            m->data.gunport.snap_idx = (uint8_t)mgp_snap;
                                            m->data.gunport.is_open  = (uint8_t)(mgp_open & 1);
                                        }
                                        m->deck_id = (uint8_t)mdeck;
                                        matched = true;
                                        break;
                                    }

                                    /* Dynamically-placed modules (e.g. ramps, gunports) have no
                                     * default slot — add them to both SimpleShip and sim layers.
                                     * mmax == 0 catches indestructible modules (gunports) which
                                     * are intentionally stored with health=0 / max_health=0. */
                                    if (!matched && (mhealth > 0 || mmax == 0)) {
                                        Vec2Q16 pos = {
                                            (q16_t)(int32_t)(mlx * 65536.0f),
                                            (q16_t)(int32_t)(mly * 65536.0f)
                                        };
                                        q16_t rot = (q16_t)(int32_t)(mlr * 65536.0f);
                                        /* Derive a safe ID: use offset from saved id + new seq */
                                        uint8_t offset = msaved_id ? (uint8_t)(msaved_id & 0xFF) : 0xFF;
                                        uint16_t new_mid = (uint16_t)((s->ship_seq << 8) | offset);
                                        /* Avoid ID collision with already-created modules */
                                        bool id_used = false;
                                        for (uint8_t k = 0; k < s->module_count; k++) {
                                            if (s->modules[k].id == new_mid) { id_used = true; break; }
                                        }
                                        if (id_used) {
                                            uint16_t max_id = 0;
                                            for (uint8_t k = 0; k < s->module_count; k++)
                                                if (s->modules[k].id > max_id) max_id = s->modules[k].id;
                                            new_mid = max_id + 1;
                                        }
                                        ShipModule new_mod = module_create(new_mid, (ModuleTypeId)mtype, pos, rot);
                                        new_mod.health     = (int32_t)mhealth;
                                        new_mod.max_health = (int32_t)(mmax > 0 ? mmax : (unsigned)new_mod.max_health);
                                        /* Restore gunport / cannon link data for dynamically-placed modules */
                                        if ((ModuleTypeId)mtype == MODULE_TYPE_CANNON)
                                            new_mod.data.cannon.gunport_snap_idx = (uint8_t)mgp_snap;
                                        else if ((ModuleTypeId)mtype == MODULE_TYPE_GUNPORT) {
                                            new_mod.data.gunport.snap_idx = (uint8_t)mgp_snap;
                                            new_mod.data.gunport.is_open  = (uint8_t)(mgp_open & 1);
                                        }
                                        new_mod.deck_id = (uint8_t)mdeck;
                                        if (s->module_count < MAX_MODULES_PER_SHIP)
                                            s->modules[s->module_count++] = new_mod;
                                        /* Mirror into sim layer */
                                        if (global_sim) {
                                            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                                if ((uint32_t)global_sim->ships[si].id != new_id) continue;
                                                struct Ship *sim_s = &global_sim->ships[si];
                                                if (sim_s->module_count < MAX_MODULES_PER_SHIP)
                                                    sim_s->modules[sim_s->module_count++] = new_mod;
                                                break;
                                            }
                                        }
                                    }
                                    free(mobj);
                                    mi++;
                                }
                            }
                        }
                    /* Restore ship level stats into the sim layer */
                    if (global_sim) {
                        const char *ls_obj = strstr(obj, "\"level_stats\":");
                        if (ls_obj) {
                            ls_obj += 14; /* skip "level_stats": */
                            unsigned ls_xp = 0, ls_w = 1, ls_r = 1, ls_d = 1, ls_c = 1, ls_ss = 1;
                            ws_json_uint(ls_obj, "xp", &ls_xp);
                            ws_json_uint(ls_obj, "w",  &ls_w);
                            ws_json_uint(ls_obj, "r",  &ls_r);
                            ws_json_uint(ls_obj, "d",  &ls_d);
                            ws_json_uint(ls_obj, "c",  &ls_c);
                            ws_json_uint(ls_obj, "s",  &ls_ss);
                            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                if ((uint32_t)global_sim->ships[si].id != new_id) continue;
                                ShipLevelStats *ls = &global_sim->ships[si].level_stats;
                                ls->xp                          = (uint32_t)ls_xp;
                                ls->levels[SHIP_ATTR_WEIGHT]     = (uint8_t)(ls_w  > 0 ? ls_w  : 1);
                                ls->levels[SHIP_ATTR_RESISTANCE] = (uint8_t)(ls_r  > 0 ? ls_r  : 1);
                                ls->levels[SHIP_ATTR_DAMAGE]     = (uint8_t)(ls_d  > 0 ? ls_d  : 1);
                                ls->levels[SHIP_ATTR_CREW]       = (uint8_t)(ls_c  > 0 ? ls_c  : 1);
                                ls->levels[SHIP_ATTR_STURDINESS] = (uint8_t)(ls_ss > 0 ? ls_ss : 1);
                                break;
                            }
                        }
                    }
                    /* Restore weapon groups — module IDs are remapped from old seq to new seq */
                    if (s) {
                        const char *wgarr = find_array(obj, "weapon_groups");
                        if (wgarr) {
                            char *wgobj;
                            while ((wgobj = next_json_object(&wgarr)) != NULL) {
                                unsigned co = 0, gidx = 0, gmode = 0, gtarget = 0, ggpopen = 0;
                                ws_json_uint(wgobj, "co",     &co);
                                ws_json_uint(wgobj, "idx",    &gidx);
                                ws_json_uint(wgobj, "mode",   &gmode);
                                ws_json_uint(wgobj, "target", &gtarget);
                                ws_json_uint(wgobj, "gpopen", &ggpopen);
                                if (co < MAX_COMPANIES && gidx < MAX_WEAPON_GROUPS) {
                                    WeaponGroup *wg = &s->weapon_groups[co][gidx];
                                    wg->mode           = (uint8_t)gmode;
                                    wg->target_ship_id = (uint16_t)gtarget;
                                    wg->gunports_open  = (uint8_t)(ggpopen & 1);
                                    wg->weapon_count   = 0;
                                    /* Parse wids array and remap: upper byte was old ship_seq */
                                    const char *wids = strstr(wgobj, "\"wids\":[");
                                    if (wids) {
                                        wids += 8;
                                        while (*wids && *wids != ']' &&
                                               wg->weapon_count < MAX_WEAPONS_PER_GROUP) {
                                            while (*wids == ' ' || *wids == ',') wids++;
                                            if (*wids == ']' || *wids == '\0') break;
                                            unsigned saved_wid = 0;
                                            if (sscanf(wids, "%u", &saved_wid) != 1) break;
                                            unsigned wid_seq = (saved_wid >> 8) & 0xFF;
                                            unsigned wid_off =  saved_wid       & 0xFF;
                                            module_id_t new_wid = (wid_seq == seq)
                                                ? (module_id_t)((s->ship_seq << 8) | wid_off)
                                                : (module_id_t)saved_wid;
                                            wg->weapon_ids[wg->weapon_count++] = new_wid;
                                            while (*wids && *wids != ',' && *wids != ']') wids++;
                                        }
                                    }
                                }
                                free(wgobj);
                            }
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
                n->deck_level = 1; /* default upper deck; corrected below if assigned to a module */

                unsigned id = 0, role = 0, company = 0, ship_id = 0;
                unsigned health = 100, max_health = 100, level = 1;
                unsigned xp = 0;
                unsigned sh = 0, sd = 0, ss = 0, sw = 0;
                unsigned assigned_weapon_id = 0, wants_cannon = 0, npc_state = 0;
                float x = 0, y = 0, rot = 0, lx = 0, ly = 0;

                ws_json_uint(obj,  "id",                 &id);
                ws_json_str (obj,  "name",               n->name, sizeof(n->name));
                ws_json_uint(obj,  "role",               &role);
                ws_json_uint(obj,  "company",            &company);
                ws_json_float(obj, "x",                  &x);
                ws_json_float(obj, "y",                  &y);
                ws_json_float(obj, "rot",                &rot);
                ws_json_uint(obj,  "ship_id",            &ship_id);
                ws_json_float(obj, "lx",                 &lx);
                ws_json_float(obj, "ly",                 &ly);
                ws_json_uint(obj,  "health",             &health);
                ws_json_uint(obj,  "max_health",         &max_health);
                ws_json_uint(obj,  "level",              &level);
                ws_json_uint(obj,  "xp",                 &xp);
                ws_json_uint(obj,  "stat_health",        &sh);
                ws_json_uint(obj,  "stat_damage",        &sd);
                ws_json_uint(obj,  "stat_stamina",       &ss);
                ws_json_uint(obj,  "stat_weight",        &sw);
                ws_json_uint(obj,  "assigned_weapon_id", &assigned_weapon_id);
                ws_json_uint(obj,  "wants_cannon",       &wants_cannon);
                ws_json_uint(obj,  "npc_state",          &npc_state);
                uint32_t owner_player_id = 0;
                ws_json_uint(obj,  "owner_player_id",    &owner_player_id);

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
                n->assigned_weapon_id = (module_id_t)assigned_weapon_id;
                n->wants_cannon       = (bool)wants_cannon;
                n->state              = (WorldNpcState)npc_state;
                n->owner_player_id    = owner_player_id;
                n->active     = true;

                /* Remap ship_id from the saved entity ID to the newly
                 * allocated one (ships get fresh IDs on every load).     */
                if (n->ship_id != 0) {
                    for (int ri = 0; ri < id_remap_count; ri++) {
                        if (id_remap_old[ri] == (uint32_t)n->ship_id) {
                            n->ship_id = (uint16_t)id_remap_new[ri];
                            break;
                        }
                    }
                }

                /* Restore module occupied state so ship logic sees the NPC
                 * as already at their station on the first tick after load.
                 * Also re-derive deck_level from the module's deck_id so NPCs
                 * assigned to lower-deck weapons don't land on the wrong deck. */
                if (n->assigned_weapon_id != 0 && n->ship_id != 0
                    && (n->state == WORLD_NPC_STATE_AT_GUN
                        || n->state == WORLD_NPC_STATE_IDLE)) {
                    SimpleShip* ss = find_ship(n->ship_id);
                    if (ss) {
                        ShipModule* mod = find_module_by_id(ss, n->assigned_weapon_id);
                        if (mod) {
                            mod->state_bits |= MODULE_STATE_OCCUPIED;
                            /* deck_id 0xFF = deck-independent (e.g. mast); treat as upper */
                            n->deck_level = (mod->deck_id != 0xFF) ? mod->deck_id : 1;
                            log_info("🤖 NPC %u restored to module %u on ship %u (deck %u)",
                                     n->id, n->assigned_weapon_id, n->ship_id, (unsigned)n->deck_level);
                        }
                    }
                }

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
                unsigned hp = 100, max_hp = 100, target_hp = 0, placer_id = 0;
                unsigned construction_phase = 0, construction_company = 0, scaffolded_ship_id = 0;
                unsigned modules_placed_saved = 0;
                float x = 0, y = 0, rot = 0;
                bool open = false;
                bool door_locked = false;

                ws_json_uint(obj,  "id",                   &id);
                ws_json_uint(obj,  "type",                 &type);
                ws_json_float(obj, "x",                    &x);
                ws_json_float(obj, "y",                    &y);
                ws_json_float(obj, "rot",                  &rot);
                ws_json_uint(obj,  "island_id",            &island_id);
                ws_json_uint(obj,  "company",              &company);
                ws_json_uint(obj,  "hp",                   &hp);
                ws_json_uint(obj,  "max_hp",               &max_hp);
                ws_json_uint(obj,  "target_hp",            &target_hp);
                ws_json_uint(obj,  "placer_id",            &placer_id);
                ws_json_str (obj,  "placer_name",          ps->placer_name,
                             sizeof(ps->placer_name));
                ws_json_bool(obj,  "open",                 &open);
                ws_json_bool(obj,  "locked",               &door_locked);
                ws_json_uint(obj,  "construction_phase",   &construction_phase);
                ws_json_uint(obj,  "construction_company", &construction_company);
                ws_json_uint(obj,  "modules_placed",       &modules_placed_saved);
                ws_json_uint(obj,  "scaffolded_ship_id",   &scaffolded_ship_id);

                /* dominators: [ id, id, … ] — restore dominance order list. */
                {
                    const char *dkey = strstr(obj, "\"dominators\"");
                    if (dkey) {
                        const char *lb = strchr(dkey, '[');
                        const char *rb = lb ? strchr(lb, ']') : NULL;
                        if (lb && rb && rb > lb) {
                            const char *p = lb + 1;
                            while (p < rb && ps->dominator_count < MAX_DOMINATORS) {
                                while (p < rb && (*p == ' ' || *p == ',' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
                                if (p >= rb) break;
                                char *endp = NULL;
                                unsigned long v = strtoul(p, &endp, 10);
                                if (endp == p) break;
                                ps->dominators[ps->dominator_count++] = (uint32_t)v;
                                p = endp;
                            }
                        }
                    }
                }

                ps->id         = id ? (uint16_t)id : next_structure_id;
                ps->type       = (PlacedStructureType)type;
                ps->x          = x;
                ps->y          = y;
                ps->rotation   = rot;
                ps->island_id  = (uint8_t)island_id;
                ps->company_id = (uint8_t)company;
                ps->hp         = (uint16_t)hp;
                ps->max_hp     = (uint16_t)max_hp;
                /* Saves prior to target_hp default it to max_hp (no past damage). */
                ps->target_hp  = target_hp ? (uint16_t)target_hp : (uint16_t)max_hp;
                ps->placer_id  = placer_id;
                ps->open       = open;
                ps->door_locked = door_locked;
                ps->active     = true;

                /* Restore shipyard construction state */
                ps->construction_phase   = (ShipConstructionPhase)construction_phase;
                ps->construction_company = (uint8_t)construction_company;
                ps->modules_placed       = (uint8_t)modules_placed_saved;
                /* Remap scaffolded_ship_id: old entity ID → new entity ID */
                if (scaffolded_ship_id != 0) {
                    for (int ri = 0; ri < id_remap_count; ri++) {
                        if (id_remap_old[ri] == scaffolded_ship_id) {
                            scaffolded_ship_id = id_remap_new[ri];
                            break;
                        }
                    }
                }
                ps->scaffolded_ship_id = (uint16_t)scaffolded_ship_id;

                /* Cannons: initialise aim to match base orientation so the barrel
                 * starts at "0 relative to base" rather than world-angle 0.
                 * Barrel points local −y, so facing world angle = rot°·π/180 − π/2. */
                if (ps->type == STRUCT_CANNON) {
                    ps->cannon_aim_angle =
                        ps->rotation * (float)M_PI / 180.0f - (float)(M_PI / 2.0);
                    ps->cannon_desired_aim_angle = ps->cannon_aim_angle;
                }

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
                            unsigned idx = 0, health = 0, respawn_at = 0;
                            ws_json_uint(robj, "idx",        &idx);
                            ws_json_uint(robj, "health",     &health);
                            ws_json_uint(robj, "respawn_at", &respawn_at);
                            if ((int)idx < isl->resource_count) {
                                isl->resources[idx].health = (int)health;
                                isl->resources[idx].respawn_at_ms = respawn_at;
                                /* Rebuild alive_wood: remove depleted trees from the list */
                                if (health == 0 && isl->resources[idx].type_id == RES_WOOD) {
                                    island_mark_tree_dead(isl, (int)idx);
                                }
                            }
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

    /* ── Load dynamic companies ── */
    {
        FILE *fc = fopen("data/dynamic_companies.json", "r");
        if (fc) {
            fseek(fc, 0, SEEK_END);
            long csz = ftell(fc); rewind(fc);
            if (csz > 0 && csz < 32768) {
                char *cbuf = (char *)malloc((size_t)csz + 1);
                if (cbuf) {
                    fread(cbuf, 1, (size_t)csz, fc);
                    cbuf[csz] = '\0';
                    /* Parse next_id */
                    unsigned nid = 0;
                    const char *np = strstr(cbuf, "\"next_id\"");
                    if (np) { np = strchr(np, ':'); if (np) sscanf(np+1, " %u", &nid); }
                    if (nid >= COMPANY_DYNAMIC_BASE) next_dynamic_company_id = nid;
                    /* Parse companies array */
                    const char *arr = strstr(cbuf, "\"companies\"");
                    if (arr) arr = strchr(arr, '[');
                    dynamic_company_count = 0;
                    while (arr && (arr = strchr(arr, '{')) != NULL
                           && dynamic_company_count < MAX_DYNAMIC_COMPANIES) {
                        DynamicCompany *dc = &dynamic_companies[dynamic_company_count];
                        memset(dc, 0, sizeof(*dc));
                        unsigned cid = 0, fid = 0;
                        char cname[32] = "";
                        const char *ip = strstr(arr, "\"id\":"); if (ip) sscanf(ip+5, " %u", &cid);
                        const char *fp = strstr(arr, "\"founderId\":"); if (fp) sscanf(fp+12, " %u", &fid);
                        const char *nn = strstr(arr, "\"name\":\"");
                        if (nn) { nn += 8; sscanf(nn, "%31[^\"]", cname); }
                        if (cid >= COMPANY_DYNAMIC_BASE) {
                            dc->id = cid;
                            dc->founder_id = fid;
                            dc->active = true;
                            strncpy(dc->name, cname, sizeof(dc->name)-1);
                            dynamic_company_count++;
                        }
                        arr = strchr(arr, '}');
                        if (arr) arr++;
                    }
                    free(cbuf);
                    log_info("🏴 Loaded %d dynamic companies", dynamic_company_count);
                }
            }
            fclose(fc);
        }
    }

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
    mkdir("data/saves",       0755);
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

