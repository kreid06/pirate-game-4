#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include "util/log.h"
#include "net/websocket_server_internal.h"

// ============================================================================
// PLAYER SAVE / LOAD  (./player_saves/<name>.json)
// ============================================================================

/** Replace characters that are unsafe in filenames with '_'. */
static void sanitize_filename(const char *name, char *out, size_t size) {
    size_t i = 0;
    while (i < size - 1 && *name) {
        char c = *name++;
        out[i++] = ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_') ? c : '_';
    }
    out[i] = '\0';
}

void save_player_to_file(const WebSocketPlayer *p) {
    if (!p || !p->active || p->name[0] == '\0') return;

    mkdir("player_saves", 0755);

    char safe[64];
    sanitize_filename(p->name, safe, sizeof(safe));
    char path[128];
    snprintf(path, sizeof(path), "player_saves/%s.json", safe);

    FILE *f = fopen(path, "w");
    if (!f) {
        log_warn("Could not save player '%s': %s", p->name, strerror(errno));
        return;
    }

    fprintf(f,
        "{\n"
        "  \"name\": \"%s\",\n"
        "  \"player_id\": %u,\n"
        "  \"x\": %.3f,\n"
        "  \"y\": %.3f,\n"
        "  \"parent_ship_id\": %u,\n"
        "  \"local_x\": %.3f,\n"
        "  \"local_y\": %.3f,\n"
        "  \"deck_level\": %u,\n"
        "  \"health\": %u,\n"
        "  \"max_health\": %u,\n"
        "  \"player_level\": %u,\n"
        "  \"player_xp\": %u,\n"
        "  \"stat_health\": %u,\n"
        "  \"stat_damage\": %u,\n"
        "  \"stat_stamina\": %u,\n"
        "  \"stat_weight\": %u,\n"
        "  \"company_id\": %u,\n"
        "  \"active_slot\": %u,\n"
        "  \"helm\": %u,\n"
        "  \"torso\": %u,\n"
        "  \"legs\": %u,\n"
        "  \"feet\": %u,\n"
        "  \"hands\": %u,\n"
        "  \"shield\": %u,\n"
        "  \"res_wood\": %u,\n"
        "  \"res_fiber\": %u,\n"
        "  \"res_metal\": %u,\n"
        "  \"res_stone\": %u,\n"
        "  \"slots\": [",
        p->name,
        (unsigned)p->player_id,
        (double)p->x, (double)p->y,
        (unsigned)p->parent_ship_id,
        (double)p->local_x, (double)p->local_y,
        (unsigned)p->deck_level,
        (unsigned)p->health, (unsigned)p->max_health,
        (unsigned)p->player_level, (unsigned)p->player_xp,
        (unsigned)p->stat_health, (unsigned)p->stat_damage,
        (unsigned)p->stat_stamina, (unsigned)p->stat_weight,
        (unsigned)p->company_id,
        (unsigned)p->inventory.active_slot,
        (unsigned)p->inventory.equipment.helm,
        (unsigned)p->inventory.equipment.torso,
        (unsigned)p->inventory.equipment.legs,
        (unsigned)p->inventory.equipment.feet,
        (unsigned)p->inventory.equipment.hands,
        (unsigned)p->inventory.equipment.shield,
        (unsigned)p->res_wood,
        (unsigned)p->res_fiber,
        (unsigned)p->res_metal,
        (unsigned)p->res_stone
    );

    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        const QualityPayload* q = &p->inventory.slot_quality[s];
        if (q->quality_q8 != 0) {
            fprintf(f, "%s{\"item\":%u,\"qty\":%u,\"q\":%u,\"sm\":[%u,%u,%u,%u,%u]}",
                    s == 0 ? "" : ",",
                    (unsigned)p->inventory.slots[s].item,
                    (unsigned)p->inventory.slots[s].quantity,
                    (unsigned)q->quality_q8,
                    (unsigned)q->stat_mult_q8[0], (unsigned)q->stat_mult_q8[1],
                    (unsigned)q->stat_mult_q8[2], (unsigned)q->stat_mult_q8[3],
                    (unsigned)q->stat_mult_q8[4]);
        } else {
            fprintf(f, "%s{\"item\":%u,\"qty\":%u}",
                    s == 0 ? "" : ",",
                    (unsigned)p->inventory.slots[s].item,
                    (unsigned)p->inventory.slots[s].quantity);
        }
    }
    fprintf(f, "],\n  \"schematics\": [");
    {
        bool sfirst = true;
        for (int i = 0; i < MAX_PLAYER_SCHEMATICS; i++) {
            const PlayerBlueprint* bp = &p->schematics[i];
            if (bp->item == 0) continue;
            fprintf(f, "%s{\"item\":%u,\"crafts\":%u,\"q\":%u,\"sm\":[%u,%u,%u,%u,%u]}",
                    sfirst ? "" : ",",
                    (unsigned)bp->item, (unsigned)bp->crafts_remaining,
                    (unsigned)bp->quality.quality_q8,
                    (unsigned)bp->quality.stat_mult_q8[0], (unsigned)bp->quality.stat_mult_q8[1],
                    (unsigned)bp->quality.stat_mult_q8[2], (unsigned)bp->quality.stat_mult_q8[3],
                    (unsigned)bp->quality.stat_mult_q8[4]);
            sfirst = false;
        }
    }
    fprintf(f, "]\n}\n");
    fclose(f);
    log_info("💾 Saved player '%s' (lvl %u, xp %u) to %s",
             p->name, p->player_level, p->player_xp, path);
}

static bool json_parse_uint_field(const char *json, const char *key, unsigned *out) {
    char search[64];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char *p = strstr(json, search);
    if (!p) return false;
    p += strlen(search);
    while (*p == ' ') p++;
    return sscanf(p, "%u", out) == 1;
}

static bool json_parse_float_field(const char *json, const char *key, float *out) {
    char search[64];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char *p = strstr(json, search);
    if (!p) return false;
    p += strlen(search);
    while (*p == ' ') p++;
    return sscanf(p, "%f", out) == 1;
}

/* Parse a {"q":..,"sm":[..]} quality payload from within [start,end). */
static void parse_quality_obj(const char *start, const char *end, QualityPayload *out) {
    memset(out, 0, sizeof(*out));
    const char *qp = strstr(start, "\"q\":");
    if (qp && (!end || qp < end)) {
        unsigned q = 0; sscanf(qp + 4, "%u", &q);
        out->quality_q8 = (uint8_t)q;
    }
    const char *sp = strstr(start, "\"sm\":");
    if (sp && (!end || sp < end)) {
        sp = strchr(sp, '[');
        if (sp && (!end || sp < end)) {
            sp++;
            for (int k = 0; k < STAT_COUNT; k++) {
                unsigned v = 0;
                if (sscanf(sp, "%u", &v) != 1) break;
                out->stat_mult_q8[k] = (uint16_t)v;
                sp = strchr(sp, ',');
                if (!sp || (end && sp >= end)) break;
                sp++;
            }
        }
    }
}

/** Restore persistent fields from a save file into *p.
 *  Returns true if a save file was found and loaded.
 *  p->name must already be set.  Sim / transient state is NOT modified. */
bool load_player_from_file(WebSocketPlayer *p) {
    if (!p || p->name[0] == '\0') return false;

    char safe[64];
    sanitize_filename(p->name, safe, sizeof(safe));
    char path[128];
    snprintf(path, sizeof(path), "player_saves/%s.json", safe);

    FILE *f = fopen(path, "r");
    if (!f) return false;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0 || sz > 8192) { fclose(f); return false; }

    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return false; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = '\0';

    unsigned tmp = 0;
    float ftmp = 0.f;

    if (json_parse_float_field(buf, "x", &ftmp)) p->x = ftmp;
    if (json_parse_float_field(buf, "y", &ftmp)) p->y = ftmp;
    if (json_parse_uint_field(buf, "player_id", &tmp) && tmp != 0) p->player_id = (uint32_t)tmp;
    unsigned saved_ship_id = 0;
    unsigned saved_deck_level = 1;
    float saved_lx = 0.f, saved_ly = 0.f;
    json_parse_uint_field(buf, "parent_ship_id", &saved_ship_id);
    json_parse_float_field(buf, "local_x", &saved_lx);
    json_parse_float_field(buf, "local_y", &saved_ly);
    json_parse_uint_field(buf, "deck_level", &saved_deck_level);
    if (json_parse_uint_field(buf, "health", &tmp))       p->health        = (uint16_t)tmp;
    if (json_parse_uint_field(buf, "max_health", &tmp))   p->max_health    = (uint16_t)tmp;
    if (json_parse_uint_field(buf, "player_level", &tmp)) p->player_level  = (uint8_t)tmp;
    if (json_parse_uint_field(buf, "player_xp", &tmp))    p->player_xp     = (uint32_t)tmp;
    if (json_parse_uint_field(buf, "stat_health", &tmp))  p->stat_health   = (uint8_t)tmp;
    if (json_parse_uint_field(buf, "stat_damage", &tmp))  p->stat_damage   = (uint8_t)tmp;
    if (json_parse_uint_field(buf, "stat_stamina", &tmp)) p->stat_stamina  = (uint8_t)tmp;
    if (json_parse_uint_field(buf, "stat_weight", &tmp))  p->stat_weight   = (uint8_t)tmp;
    /* deck_level is applied after board_player_on_ship to avoid being reset — see below */
    if (json_parse_uint_field(buf, "company_id", &tmp))   p->company_id    = (uint8_t)(tmp < COMPANY_SOLO ? COMPANY_SOLO : tmp); /* players never in company 0 */
    if (json_parse_uint_field(buf, "active_slot", &tmp))  p->inventory.active_slot = (uint8_t)tmp;
    if (json_parse_uint_field(buf, "helm",  &tmp))        p->inventory.equipment.helm   = (ItemKind)tmp;
    /* "torso" is the canonical field; fall back to legacy "armor" key */
    if (json_parse_uint_field(buf, "torso", &tmp))        p->inventory.equipment.torso  = (ItemKind)tmp;
    else if (json_parse_uint_field(buf, "armor", &tmp))   p->inventory.equipment.torso  = (ItemKind)tmp;
    if (json_parse_uint_field(buf, "legs",  &tmp))        p->inventory.equipment.legs   = (ItemKind)tmp;
    if (json_parse_uint_field(buf, "feet",  &tmp))        p->inventory.equipment.feet   = (ItemKind)tmp;
    if (json_parse_uint_field(buf, "hands", &tmp))        p->inventory.equipment.hands  = (ItemKind)tmp;
    if (json_parse_uint_field(buf, "shield",&tmp))        p->inventory.equipment.shield = (ItemKind)tmp;

    // If the player was on a ship and it still exists, restore local position
    if (saved_ship_id != 0) {
        SimpleShip *ship = find_ship((uint16_t)saved_ship_id);
        if (ship && ship->active) {
            // Use the same boarding helper the ladder/teleport code uses — ensures
            // parent_ship_id, local_x/y, movement_state, world pos and velocity are
            // all set consistently.
            board_player_on_ship(p, ship, saved_lx, saved_ly);
            // board_player_on_ship always sets deck_level=1; restore the saved deck
            p->deck_level = (uint8_t)(saved_deck_level <= 1 ? saved_deck_level : 1);
            log_info("💾 Restored '%s' onto ship %u at local (%.1f, %.1f) deck %u",
                     p->name, saved_ship_id, saved_lx, saved_ly, (unsigned)p->deck_level);
        } else {
            // Ship is gone — fall back to swimming at the saved world coords
            p->parent_ship_id = 0;
            p->movement_state = PLAYER_STATE_SWIMMING;
            log_info("💾 Ship %u no longer exists for '%s' — spawning in water",
                     saved_ship_id, p->name);
        }
    } else {
        p->movement_state = PLAYER_STATE_SWIMMING;
        p->deck_level = (uint8_t)(saved_deck_level <= 1 ? saved_deck_level : 1);
    }

    // Parse inventory slots array
    const char *slots_arr = strstr(buf, "\"slots\":");
    if (slots_arr) {
        slots_arr = strchr(slots_arr, '[');
        if (slots_arr) {
            memset(p->inventory.slots, 0, sizeof(p->inventory.slots));
            memset(p->inventory.slot_quality, 0, sizeof(p->inventory.slot_quality));
            const char *cur = slots_arr + 1;
            for (int s = 0; s < INVENTORY_SLOTS && cur; s++) {
                cur = strchr(cur, '{');
                if (!cur) break;
                const char *objend = strchr(cur, '}');
                unsigned item = 0, qty = 0;
                const char *ip = strstr(cur, "\"item\":");
                if (ip && (!objend || ip < objend)) sscanf(ip + 7, "%u", &item);
                const char *qp = strstr(cur, "\"qty\":");
                if (qp && (!objend || qp < objend)) sscanf(qp + 6, "%u", &qty);
                p->inventory.slots[s].item     = (ItemKind)item;
                p->inventory.slots[s].quantity = (uint8_t)qty;
                parse_quality_obj(cur, objend, &p->inventory.slot_quality[s]);
                cur = objend ? objend + 1 : NULL;
            }
        }
    }

    /* Parse schematic inventory (persistent blueprints; absent in old saves) */
    memset(p->schematics, 0, sizeof(p->schematics));
    p->schematic_count = 0;
    {
        const char *sch = strstr(buf, "\"schematics\":");
        if (sch) {
            sch = strchr(sch, '[');
            if (sch) {
                const char *cur = sch + 1;
                for (int i = 0; i < MAX_PLAYER_SCHEMATICS && cur; i++) {
                    cur = strchr(cur, '{');
                    if (!cur) break;
                    const char *objend = strchr(cur, '}');
                    unsigned item = 0, crafts = 0;
                    const char *ip = strstr(cur, "\"item\":");
                    if (ip && (!objend || ip < objend)) sscanf(ip + 7, "%u", &item);
                    const char *cp = strstr(cur, "\"crafts\":");
                    if (cp && (!objend || cp < objend)) sscanf(cp + 9, "%u", &crafts);
                    if (item != 0 && crafts > 0) {
                        p->schematics[i].item             = (uint8_t)item;
                        p->schematics[i].crafts_remaining = (uint8_t)crafts;
                        parse_quality_obj(cur, objend, &p->schematics[i].quality);
                        p->schematic_count = (uint8_t)(i + 1);
                    }
                    cur = objend ? objend + 1 : NULL;
                }
            }
        }
    }

    /* Load resource pool (new fields — default to 0 if absent in old saves) */
    if (json_parse_uint_field(buf, "res_wood",  &tmp)) p->res_wood  = (uint16_t)(tmp > 9999u ? 9999u : tmp);
    if (json_parse_uint_field(buf, "res_fiber", &tmp)) p->res_fiber = (uint16_t)(tmp > 9999u ? 9999u : tmp);
    if (json_parse_uint_field(buf, "res_metal", &tmp)) p->res_metal = (uint16_t)(tmp > 9999u ? 9999u : tmp);
    if (json_parse_uint_field(buf, "res_stone", &tmp)) p->res_stone = (uint16_t)(tmp > 9999u ? 9999u : tmp);

    /* Derive is_dead from health — a player saved at 0 HP was dead when disconnected */
    p->is_dead = (p->health == 0);

    free(buf);
    log_info("💾 Loaded player '%s' (id %u, lvl %u, xp %u) from %s",
             p->name, p->player_id, p->player_level, p->player_xp, path);
    return true;
}

uint32_t peek_saved_player_id(const char *name) {
    if (!name || name[0] == '\0') return 0;
    char safe[64];
    sanitize_filename(name, safe, sizeof(safe));
    char path[128];
    snprintf(path, sizeof(path), "player_saves/%s.json", safe);
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char buf[256];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    unsigned id = 0;
    json_parse_uint_field(buf, "player_id", &id);
    return (uint32_t)id;
}
