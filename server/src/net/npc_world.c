#include <math.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#define _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "net/npc_world.h"
#include "net/npc_agents.h"
#include "net/module_interactions.h"
#include "net/ship_schematics.h"
#include "net/ship_chest_resources.h"
#include "net/ship_plank_wreckage.h"
#include "sim/module_types.h"

// ── Repairer occupancy: small precomputed set rebuilt each tick ──────────────
typedef struct { uint16_t npc_id; uint16_t ship_id; module_id_t mod_id; } NpcOccEntry;

static bool occ_taken_by_other(const NpcOccEntry* buf, int cnt,
                                uint16_t self_npc_id, uint16_t ship_id, module_id_t mod_id) {
    for (int k = 0; k < cnt; k++)
        if (buf[k].ship_id == ship_id && buf[k].mod_id == mod_id && buf[k].npc_id != self_npc_id)
            return true;
    return false;
}

/** Sync a sim-layer module back into the SimpleShip mirror. */
static void npc_sync_module_to_simple(SimpleShip* simple, const ShipModule* mod) {
    if (!simple || !mod) return;
    for (uint8_t m = 0; m < simple->module_count; m++) {
        if (simple->modules[m].id == mod->id) {
            simple->modules[m] = *mod;
            return;
        }
    }
}

/** After NPC places a fresh module, apply the highest-priority ship pool schematic if any. */
static void npc_apply_ship_pool_schematic(SimpleShip* simple, struct Ship* sim_ship,
                                          int mod_idx, ItemKind item) {
    if (!simple || !sim_ship || mod_idx < 0 || mod_idx >= (int)sim_ship->module_count) return;
    QualityPayload q;
    if (!ship_schematic_consume_for_item(simple, item, &q)) return;

    ShipModule* mod = &sim_ship->modules[mod_idx];
    module_apply_quality(mod, &q);
    mod->health        = mod->max_health / 10;
    mod->target_health = mod->max_health;

    npc_sync_module_to_simple(simple, mod);
    ship_schematic_broadcast_list(simple->ship_id);
    log_info("📋 NPC placed module with pool schematic item=%u on ship %u module %u",
             (unsigned)item, (unsigned)simple->ship_id, (unsigned)mod->id);
}

/** When repairing an existing plain module, consume the top-priority pool schematic once. */
static void npc_try_apply_pool_schematic_on_repair(SimpleShip* simple, struct Ship* sim_ship,
                                                   uint32_t target_id) {
    if (!simple || !sim_ship) return;
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* mod = &sim_ship->modules[m];
        if ((uint32_t)mod->id != target_id) continue;
        if (mod->quality.quality_q8 != 0) return;

        ItemKind item = ship_schematic_item_from_module_type(mod->type_id);
        if (item == ITEM_NONE) return;

        QualityPayload q;
        if (!ship_schematic_consume_for_item(simple, item, &q)) return;

        float ratio = (mod->max_health > 0)
            ? (float)mod->health / (float)mod->max_health
            : 0.1f;
        module_apply_quality(mod, &q);
        mod->health = (int32_t)((float)mod->max_health * ratio);
        if (mod->health < 1) mod->health = 1;
        mod->target_health = mod->max_health;

        npc_sync_module_to_simple(simple, mod);
        ship_schematic_broadcast_list(simple->ship_id);
        log_info("📋 NPC repair applied pool schematic item=%u on ship %u module %u",
                 (unsigned)item, (unsigned)simple->ship_id, (unsigned)mod->id);
        return;
    }
}

static float npc_repair_missing_ratio(const ShipModule* mod) {
    float ratio = 0.0f;
    if (mod->max_health > 0) {
        int32_t gap = mod->max_health - mod->health;
        if (gap < 0) gap = 0;
        ratio = (float)gap / (float)mod->max_health;
    }
    if (mod->type_id == MODULE_TYPE_MAST) {
        float fhmax = Q16_TO_FLOAT(mod->data.mast.fiber_max_health);
        if (fhmax > 0.0f) {
            float fh = Q16_TO_FLOAT(mod->data.mast.fiber_health);
            float fiber_ratio = (fhmax - fh) / fhmax;
            if (fiber_ratio > ratio) ratio = fiber_ratio;
        }
    }
    if (ratio < 0.001f) ratio = 0.001f;
    return ratio > 1.0f ? 1.0f : ratio;
}

static bool npc_repair_job_info(struct Ship* sim_ship, uint32_t target_id,
                                ModuleTypeId* out_type, float* out_ratio) {
    if (MID_OFFSET((uint16_t)target_id) == MODULE_OFFSET_DECK) {
        *out_type  = MODULE_TYPE_DECK;
        *out_ratio = 1.0f;
        return true;
    }
    if (MODULE_OFFSET_IS_PLANK(MID_OFFSET((uint16_t)target_id))) {
        *out_type  = MODULE_TYPE_PLANK;
        *out_ratio = 1.0f;
        return true;
    }
    if (!sim_ship) return false;
    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
        ShipModule* mod = &sim_ship->modules[m];
        if ((uint32_t)mod->id != target_id) continue;
        *out_type  = mod->type_id;
        *out_ratio = npc_repair_missing_ratio(mod);
        return true;
    }
    return false;
}

static bool npc_repair_job_affordable(SimpleShip* simple, struct Ship* sim_ship, uint32_t target_id) {
    ModuleTypeId type;
    float ratio;
    if (!npc_repair_job_info(sim_ship, target_id, &type, &ratio)) return false;
    return ship_chest_can_afford_repair(simple, type, ratio);
}

static bool npc_pay_repair_resources(SimpleShip* simple, struct Ship* sim_ship, uint32_t target_id) {
    ModuleTypeId type;
    float ratio;
    if (!simple || !npc_repair_job_info(sim_ship, target_id, &type, &ratio)) return false;
    if (!ship_chest_consume_repair(simple, type, ratio)) return false;
    ship_chest_sync_to_sim(simple, sim_ship);
    return true;
}

/**
 * Allocate a slot in the world_npcs array.
 * Reuses the first inactive slot if one exists, otherwise appends.
 * Returns a pointer to a zeroed slot ready to be filled, or NULL if the
 * hard cap is reached.  Trims world_npc_count from the tail after a slot
 * is freed so the active count stays accurate.
 */
static WorldNpc* npc_alloc_slot(void)
{
    /* Trim trailing inactive slots so world_npc_count reflects live entries */
    while (world_npc_count > 0 && !world_npcs[world_npc_count - 1].active)
        world_npc_count--;

    /* Reuse an inactive slot in the middle */
    for (int i = 0; i < world_npc_count; i++) {
        if (!world_npcs[i].active) {
            memset(&world_npcs[i], 0, sizeof(WorldNpc));
            return &world_npcs[i];
        }
    }

    /* Append */
    if (world_npc_count >= MAX_WORLD_NPCS) return NULL;
    WorldNpc* slot = &world_npcs[world_npc_count++];
    memset(slot, 0, sizeof(WorldNpc));
    return slot;
}

/**
 * Compute the ship-local stand position (client units) for an NPC interacting
 * with a module.  Each module type gets a type-aware offset so NPCs stand
 * beside or behind the module rather than walking into its visual centre.
 */
static void get_module_interact_pos(const ShipModule* mod, float* out_x, float* out_y) {
    float cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
    float cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
    switch (mod->type_id) {
        case MODULE_TYPE_CANNON:
        case MODULE_TYPE_SWIVEL: {
            /* Stand behind the barrel — mirrors dispatch_gunner_to_weapon logic */
            float barrel_angle = Q16_TO_FLOAT(mod->local_rot) - (float)(M_PI / 2.0f);
            float dist = (mod->type_id == MODULE_TYPE_SWIVEL) ? 18.0f : 25.0f;
            *out_x = cx - cosf(barrel_angle) * dist;
            *out_y = cy - sinf(barrel_angle) * dist;
            break;
        }
        case MODULE_TYPE_PLANK: {
            /* Stand 28 client units inward from the hull edge */
            float mag = sqrtf(cx * cx + cy * cy);
            if (mag > 0.0f) { *out_x = cx - (cx / mag) * 28.0f; *out_y = cy - (cy / mag) * 28.0f; }
            else             { *out_x = cx; *out_y = cy; }
            break;
        }
        case MODULE_TYPE_MAST: {
            /* Stand 20 units toward ship centre from the mast base */
            float mag = sqrtf(cx * cx + cy * cy);
            if (mag > 0.0f) { *out_x = cx - (cx / mag) * 20.0f; *out_y = cy - (cy / mag) * 20.0f; }
            else             { *out_x = cx; *out_y = cy + 20.0f; }
            break;
        }
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL: {
            /* Stand slightly forward of the wheel */
            *out_x = cx;
            *out_y = cy + 22.0f;
            break;
        }
        case MODULE_TYPE_LADDER: {
            /* Stand beside the ladder so the NPC doesn't block it */
            *out_x = cx + 22.0f;
            *out_y = cy;
            break;
        }
        default:
            /* DECK, SEAT, CUSTOM: stand at module centre */
            *out_x = cx;
            *out_y = cy;
            break;
    }
}

/**
 * Stand position used exclusively by repair NPCs.
 * Hull-edge modules (cannon, swivel, gunport, plank) are pulled inward toward
 * the ship centre so the repairer stays protected inside the hull rather than
 * standing on the exposed edge.  All other module types fall through to the
 * normal interact-pos logic.
 */
#define REPAIR_CANNON_INSET  45.0f   /* units toward centre for cannon/swivel */
#define REPAIR_GUNPORT_INSET 50.0f   /* gunports sit right on the hull wall   */
#define REPAIR_PLANK_INSET   40.0f   /* extra inset vs the gunner's 28 units  */

static void get_module_repair_pos(const ShipModule* mod, float* out_x, float* out_y) {
    float cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
    float cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
    float mag = sqrtf(cx * cx + cy * cy);

    switch (mod->type_id) {
        case MODULE_TYPE_CANNON:
        case MODULE_TYPE_SWIVEL: {
            /* Pull inward from the module position toward ship centre.
             * This avoids the "behind barrel" vector which ends up at the
             * hull edge for broadside cannons. */
            if (mag > 0.0f) {
                *out_x = cx - (cx / mag) * REPAIR_CANNON_INSET;
                *out_y = cy - (cy / mag) * REPAIR_CANNON_INSET;
            } else {
                *out_x = cx;
                *out_y = cy;
            }
            break;
        }
        case MODULE_TYPE_GUNPORT: {
            if (mag > 0.0f) {
                *out_x = cx - (cx / mag) * REPAIR_GUNPORT_INSET;
                *out_y = cy - (cy / mag) * REPAIR_GUNPORT_INSET;
            } else {
                *out_x = cx;
                *out_y = cy;
            }
            break;
        }
        case MODULE_TYPE_PLANK: {
            /* Use a larger inset than the gunner's 28-unit offset */
            if (mag > 0.0f) {
                *out_x = cx - (cx / mag) * REPAIR_PLANK_INSET;
                *out_y = cy - (cy / mag) * REPAIR_PLANK_INSET;
            } else {
                *out_x = cx;
                *out_y = cy;
            }
            break;
        }
        default:
            /* Helms, masts, seats, decks — existing interact-pos is fine */
            get_module_interact_pos(mod, out_x, out_y);
            break;
    }
}

/**
 * Find a module on a SimpleShip by module ID.
 * Returns a pointer into ship->modules[], or NULL if not found.
 */
ShipModule* find_module_on_ship(SimpleShip* ship, uint32_t module_id) {
    for (int m = 0; m < ship->module_count; m++) {
        if (ship->modules[m].id == module_id)
            return &ship->modules[m];
    }
    return NULL;
}

/* Dismount the NPC from whatever module/role it currently holds, freeing that
 * slot for other crew.  Does NOT set a new target or role — caller does that. */
void dismount_npc(WorldNpc* npc, SimpleShip* ship) {
    if (npc->role == NPC_ROLE_GUNNER) {
        npc->wants_cannon       = false;
        npc->assigned_weapon_id = 0;
        /* Re-run sector so remaining gunners can claim the vacated cannon */
        if (ship) update_npc_cannon_sector(ship, ship->active_aim_angle);

    } else if (npc->role == NPC_ROLE_RIGGER) {
        /* Free the mast — clear id so is_mast_manned() returns false immediately */
        npc->assigned_weapon_id = 0;
        npc->port_cannon_id     = 0;
        npc->starboard_cannon_id= 0;
    }
    npc->role  = NPC_ROLE_NONE;
    npc->state = WORLD_NPC_STATE_MOVING; /* will be overridden by caller if needed */
}

/**
 * Apply a single crew task assignment from the client manning-priority panel.
 *
 * task == "Sails"   → become RIGGER, walk to the next free mast
 * task == "Gunners" → become GUNNER,  sector system places at closest cannon
 * task == "Combat"  → same as Cannons
 * anything else     → become NONE,    walk back to idle spawn position
 */
void handle_crew_assign(uint16_t ship_id, uint16_t npc_id, const char* task) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return;

    WorldNpc* npc = NULL;
    for (int i = 0; i < world_npc_count; i++) {
        if (world_npcs[i].active && world_npcs[i].id == npc_id && world_npcs[i].ship_id == ship_id) {
            npc = &world_npcs[i];
            break;
        }
    }
    if (!npc) {
        log_warn("crew_assign: NPC %u not found on ship %u", npc_id, ship_id);
        return;
    }

    /* Locked NPCs cannot be reassigned via the crew panel or crew_assign messages */
    if (npc->task_locked) {
        log_info("🔒 crew_assign: NPC %u (%s) is task-locked — reassignment blocked", npc_id, npc->name);
        return;
    }

    npc_clear_manual_order(npc);

    /* Dismount from current module before applying new role */
    dismount_npc(npc, ship);

    bool want_sails   = (strncmp(task, "Sails",   5) == 0);
    bool want_cannons = (strncmp(task, "Gunners", 7) == 0 || strncmp(task, "Combat", 6) == 0);
    bool want_repairs = (strncmp(task, "Repairs", 7) == 0);

    if (want_sails) {
        /* Become a rigger — find the first mast not already occupied by another rigger */
        uint32_t free_mast = 0;
        for (int m = 0; m < ship->module_count && free_mast == 0; m++) {
            if (ship->modules[m].type_id != MODULE_TYPE_MAST) continue;
            uint32_t mid = ship->modules[m].id;
            bool occupied = false;
            for (int j = 0; j < world_npc_count; j++) {
                WorldNpc* other = &world_npcs[j];
                if (!other->active || other->id == npc->id) continue;
                if (other->ship_id != ship_id) continue;
                if (other->role == NPC_ROLE_RIGGER && other->assigned_weapon_id == mid) {
                    occupied = true;
                    break;
                }
            }
            if (!occupied) free_mast = mid;
        }
        npc->role       = NPC_ROLE_RIGGER;
        npc->deck_level = 1; /* masts are always on the top deck */
        if (free_mast != 0) {
            ShipModule* mast = find_module_by_id(ship, free_mast);
            if (mast) {
                float mx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mast->local_pos.x));
                float my = SERVER_TO_CLIENT(Q16_TO_FLOAT(mast->local_pos.y));
                npc->target_local_x     = mx;
                npc->target_local_y     = my + 20.0f;
                npc->assigned_weapon_id = free_mast;
            }
            // log_info("⛵ NPC %u (%s) → RIGGER, walking to mast %u", npc->id, npc->name, free_mast);
        } else {
            /* All masts full — wait at centre until one frees up */
            npc->target_local_x = 0.0f;
            npc->target_local_y = 0.0f;
            // log_info("⛵ NPC %u (%s) → RIGGER, all masts occupied — standby", npc->id, npc->name);
        }
        npc->state = WORLD_NPC_STATE_MOVING;

    } else if (want_cannons) {
        /* Become a gunner — sector system places at the closest NEEDED cannon */
        npc->role         = NPC_ROLE_GUNNER;
        npc->wants_cannon = true;
        update_npc_cannon_sector(ship, ship->active_aim_angle);
        if (npc->assigned_weapon_id == 0) {
            /* No cannon is NEEDED yet — stand by in place until one is */
            npc->state          = WORLD_NPC_STATE_IDLE;
            npc->target_local_x = npc->local_x;
            npc->target_local_y = npc->local_y;
        }
        // log_info("🔫 NPC %u (%s) → GUNNER, sector dispatch issued", npc->id, npc->name);

    } else if (want_repairs) {
        /* Become a repairer — walk to idle position, tick_world_npcs will dispatch to a module */
        npc->role           = NPC_ROLE_REPAIRER;
        npc->assigned_weapon_id = 0;
        npc->target_local_x = npc->idle_local_x;
        npc->target_local_y = npc->idle_local_y;
        npc->state          = WORLD_NPC_STATE_MOVING;
        log_info("🔧 NPC %u (%s) → REPAIRER, standing by for damage", npc->id, npc->name);

    } else {
        /* Stand down — return to crew pool at spawn-time idle position */
        npc->role           = NPC_ROLE_NONE;
        npc->target_local_x = npc->idle_local_x;
        npc->target_local_y = npc->idle_local_y;
        npc->state          = WORLD_NPC_STATE_MOVING;
        update_npc_cannon_sector(ship, ship->active_aim_angle);
        log_info("💤 NPC %u (%s) → IDLE, returning to spawn pos (%.0f, %.0f)",
                 npc->id, npc->name, npc->idle_local_x, npc->idle_local_y);
        return;
    }
    /* NOTE: sail openness is NOT changed here; it is player-controlled only. */
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Pirate name generator.
 * Produces a unique name in one of two formats, seeded by the NPC's sequential
 * ID so each pirate always gets the same name (deterministic, survives saves):
 *
 *   Format A: "[Adj] [First]"          e.g. "Mad Jack", "Silver Sam"
 *   Format B: "[First] the [Epithet]"  e.g. "Sam the Bold", "Jack the Grim"
 *
 * Pool sizes: 12 adj × 16 first  +  16 first × 16 epithets  =  448 distinct names.
 * ──────────────────────────────────────────────────────────────────────────── */
void generate_pirate_name(uint32_t seed, char* out, size_t out_size) {
    static const char* const FIRST_NAMES[] = {
        "Jack",       "Sam",       "Finn",   "Morgan", "Billy",    "Tom",
        "Ned",        "Rafe",      "Sven",   "Drake",  "Davy",     "Walt",
        "Mack",       "Bo",        "Cole",   "Hank",
        "xFerocityz", "Anesthyl",  "Raes"
    };
    static const char* const EPITHETS[] = {
        "Bold",  "Red",   "Grim",  "Swift",  "Black", "Salt",
        "Storm", "Gale",  "Dread", "Scar",   "Grin",  "Haul",
        "Tide",  "Hawk",  "Rum",   "Fang"
    };
    static const char* const ADJ_PREFIXES[] = {
        "Mad",    "Black",  "Silver", "Iron",   "Salty",  "Dead",
        "Wild",   "Grim",   "Red",    "Rusty",  "Blind",  "Stormy"
    };
    const int N_FIRST   = (int)(sizeof(FIRST_NAMES)  / sizeof(FIRST_NAMES[0]));
    const int N_EPITHET = (int)(sizeof(EPITHETS)      / sizeof(EPITHETS[0]));
    const int N_ADJ     = (int)(sizeof(ADJ_PREFIXES)  / sizeof(ADJ_PREFIXES[0]));

    /* Xorshift32 — fast, deterministic */
    uint32_t r = seed * 2654435761u;
    r ^= r << 13; r ^= r >> 17; r ^= r << 5;

    if ((r % 2) == 0) {
        /* Format A: "[Adj] [First]" */
        const char* adj = ADJ_PREFIXES[r % (uint32_t)N_ADJ];
        r ^= r << 13; r ^= r >> 17; r ^= r << 5;
        const char* first = FIRST_NAMES[r % (uint32_t)N_FIRST];
        snprintf(out, out_size, "%s %s", adj, first);
    } else {
        /* Format B: "[First] the [Epithet]" */
        r ^= r << 13; r ^= r >> 17; r ^= r << 5;
        const char* first = FIRST_NAMES[r % (uint32_t)N_FIRST];
        r ^= r << 13; r ^= r >> 17; r ^= r << 5;
        const char* epithet = EPITHETS[r % (uint32_t)N_EPITHET];
        snprintf(out, out_size, "%s the %s", first, epithet);
    }
}

/**
 * Spawn a generic crew member.  Role is set at runtime by the manning panel
 * (Sails → RIGGER, Cannons → GUNNER, Idle → NONE).
 * Returns the new NPC id, or 0 on failure.
 */
uint32_t spawn_ship_crew(uint16_t ship_id) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) {
        log_warn("spawn_ship_crew: ship %u not found", ship_id);
        return 0;
    }
    /* Enforce per-ship crew cap derived from the Crew level attribute */
    if (global_sim) {
        struct Ship* sim_ship = sim_get_ship(global_sim, (entity_id)ship_id);
        if (sim_ship) {
            uint8_t max_crew = ship_level_max_crew(&sim_ship->level_stats);
            int crew_count = 0;
            for (int i = 0; i < world_npc_count; i++) {
                if (world_npcs[i].active && world_npcs[i].ship_id == ship_id)
                    crew_count++;
            }
            if (crew_count >= (int)max_crew) {
                log_warn("spawn_ship_crew: ship %u crew cap (%u) reached", ship_id, max_crew);
                return 0;
            }
        }
    }
    /* Trim + reuse inactive slots before checking global cap */
    WorldNpc* npc = npc_alloc_slot();
    if (!npc) {
        log_warn("spawn_ship_crew: MAX_WORLD_NPCS reached");
        return 0;
    }
    npc->id             = next_world_npc_id++;
    npc->active         = true;
    npc->role           = NPC_ROLE_NONE;  /* assigned dynamically by manning panel */
    npc->ship_id        = ship_id;
    npc->company_id     = ship->company_id; /* faction set once at spawn — never changed by ship transfers */
    npc->wants_cannon   = false;
    npc->move_speed     = 80.0f;
    npc->interact_radius= 40.0f;
    npc->state          = WORLD_NPC_STATE_IDLE;
    npc->assigned_weapon_id = 0;
    /* Generate a unique pirate name seeded by this NPC's ID */
    generate_pirate_name(npc->id, npc->name, sizeof(npc->name));
    strncpy(npc->dialogue, "Aye aye, Captain!", sizeof(npc->dialogue) - 1);

    /* Crew levelling — fresh recruit */
    npc->npc_level   = 1;
    npc->stat_health = 0;
    npc->stat_damage = 0;
    npc->stat_stamina= 0;
    npc->stat_weight = 0;
    npc->max_health  = (uint16_t)(100 + npc->stat_health * 20);
    npc->health      = npc->max_health;
    npc->xp          = 0;
    npc->deck_level  = 1; /* crew operate on the upper deck */
    npc->stamina            = 100;
    npc->max_stamina        = 100;
    npc->stamina_last_used_ms = 0;
    npc->oxygen             = 100;
    npc->max_oxygen         = 100;
    npc->stam_accum         = 0.0f;
    npc->oxygen_accum       = 0.0f;
    npc->suffoc_accum       = 0.0f;

    int slot_idx = npc_alloc_ship_idle_slot(ship_id, npc->id);
    npc_assign_ship_idle_slot(npc, ship, slot_idx);
    log_info("🧑 Crew '%s' (id %u) on ship %u — idle slot %d",
             npc->name, npc->id, ship_id, slot_idx);
    return npc->id;
}

/* ============================================================================
 * GHOST SHIP SURVIVOR — swimming at the wreck, pre-assigned to the company
 * that destroyed the ghost so they can be commanded aboard without recruiting.
 * ========================================================================= */
static uint32_t find_ship_company_player(uint16_t ship_id, uint8_t company_id) {
    for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
        if (!players[pi].active) continue;
        if (players[pi].parent_ship_id != ship_id) continue;
        if (players[pi].company_id != company_id) continue;
        return players[pi].player_id;
    }
    return 0;
}

static uint32_t spawn_swimming_npc_at(float wx, float wy, int scatter_index,
                                      uint8_t company_id, uint32_t owner_player_id) {
    WorldNpc* npc = npc_alloc_slot();
    if (!npc) {
        log_warn("spawn_swimming_npc_at: MAX_WORLD_NPCS reached");
        return 0;
    }

    static const float OFFSETS_X[3] = {  30.0f, -40.0f,  15.0f };
    static const float OFFSETS_Y[3] = { -25.0f,  20.0f,  45.0f };
    int idx = scatter_index < 3 ? scatter_index : 0;
    float px = wx + OFFSETS_X[idx];
    float py = wy + OFFSETS_Y[idx];

    npc->id              = next_world_npc_id++;
    npc->active          = true;
    npc->role            = NPC_ROLE_NONE;
    npc->ship_id         = 0;
    npc->company_id      = company_id;
    npc->owner_player_id = owner_player_id;
    npc->wants_cannon    = false;
    npc->move_speed      = 60.0f;
    npc->interact_radius = 60.0f;
    npc->state           = WORLD_NPC_STATE_IDLE;
    npc->assigned_weapon_id = 0;
    npc->in_water        = true;
    npc->deck_level      = 0;
    /* Off-ship NPCs: local_x/y are the world coordinates (see tick_world_npcs). */
    npc->local_x         = px;
    npc->local_y         = py;
    npc->x               = px;
    npc->y               = py;
    npc->idle_local_x    = px;
    npc->idle_local_y    = py;
    npc->target_local_x  = px;
    npc->target_local_y  = py;

    generate_pirate_name(npc->id, npc->name, sizeof(npc->name));
    strncpy(npc->dialogue,
            company_id == COMPANY_UNCLAIMED ? "Help me..." : "Aye, Captain!",
            sizeof(npc->dialogue) - 1);

    npc->npc_level   = 1;
    npc->stat_health = 0;
    npc->stat_damage = 0;
    npc->stat_stamina= 0;
    npc->stat_weight = 0;
    npc->max_health  = 100;
    npc->health      = 100;
    npc->xp          = 0;
    npc->stamina            = 100;
    npc->max_stamina        = 100;
    npc->stamina_last_used_ms = 0;
    npc->oxygen             = 100;
    npc->max_oxygen         = 100;
    npc->stam_accum         = 0.0f;
    npc->oxygen_accum       = 0.0f;
    npc->suffoc_accum       = 0.0f;

    log_info("👻 Ghost survivor '%s' (id %u) swimming at (%.0f, %.0f) company %u",
             npc->name, npc->id, px, py, (unsigned)company_id);
    return npc->id;
}

int ghost_spawn_survivors(float wreck_x, float wreck_y, uint16_t killer_ship_id) {
    uint8_t  company = COMPANY_UNCLAIMED;
    uint32_t owner   = 0;
    if (killer_ship_id != 0) {
        SimpleShip* killer = find_ship(killer_ship_id);
        if (killer && killer->company_id != COMPANY_GHOST
                   && killer->company_id != COMPANY_UNCLAIMED) {
            company = killer->company_id;
            if (company == COMPANY_SOLO)
                owner = find_ship_company_player(killer_ship_id, company);
        }
    }

    int n = 1 + (int)(next_world_npc_id % 3); /* 1, 2, or 3 */
    int spawned = 0;
    for (int i = 0; i < n; i++) {
        if (spawn_swimming_npc_at(wreck_x, wreck_y, i, company, owner) != 0)
            spawned++;
    }
    if (spawned > 0)
        g_npcs_dirty = true;
    log_info("👻 Ghost wreck at (%.0f, %.0f): spawned %d/%d survivors (killer ship %u, company %u)",
             wreck_x, wreck_y, spawned, n, (unsigned)killer_ship_id, (unsigned)company);
    return spawned;
}

/* ============================================================================
 * IDLE CREW SLOT GRID — sequential board positions on the upper deck.
 * 10 columns × 5 rows = 50 slots; active count capped by ship crew level.
 * ========================================================================= */
#define NPC_IDLE_SLOTS_PER_ROW  10
#define NPC_IDLE_SLOT_SPACING_X 50.0f
#define NPC_IDLE_ROW_SPACING_Y  28.0f
#define NPC_IDLE_ORIGIN_X      -225.0f
#define NPC_IDLE_ORIGIN_Y       -56.0f

void npc_idle_slot_pos(int slot_idx, float* lx, float* ly) {
    if (slot_idx < 0) slot_idx = 0;
    if (slot_idx >= NPC_IDLE_SLOT_MAX) slot_idx = NPC_IDLE_SLOT_MAX - 1;
    int row = slot_idx / NPC_IDLE_SLOTS_PER_ROW;
    int col = slot_idx % NPC_IDLE_SLOTS_PER_ROW;
    *lx = NPC_IDLE_ORIGIN_X + (float)col * NPC_IDLE_SLOT_SPACING_X;
    *ly = NPC_IDLE_ORIGIN_Y + (float)row * NPC_IDLE_ROW_SPACING_Y;
}

int npc_idle_slot_count_for_ship(uint16_t ship_id) {
    int cap = NPC_IDLE_SLOT_MAX;
    if (global_sim && ship_id != 0) {
        struct Ship* sim = sim_get_ship(global_sim, (entity_id)ship_id);
        if (sim) {
            int crew_cap = (int)ship_level_max_crew(&sim->level_stats);
            if (crew_cap < cap) cap = crew_cap;
        }
    }
    return cap;
}

static bool npc_idle_slot_matches(float ix, float iy, int slot_idx) {
    float sx, sy;
    npc_idle_slot_pos(slot_idx, &sx, &sy);
    float dx = ix - sx, dy = iy - sy;
    return (dx * dx + dy * dy) < 36.0f; /* 6 px tolerance */
}

static bool npc_idle_slot_taken(uint16_t ship_id, int slot_idx, uint16_t ignore_npc_id) {
    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* n = &world_npcs[i];
        if (!n->active || n->id == ignore_npc_id) continue;
        bool on_ship    = (n->ship_id == ship_id);
        bool boarding   = (n->boarding_ship_id == ship_id && n->ship_id == 0);
        if (!on_ship && !boarding) continue;

        float ix, iy;
        if (boarding) {
            ix = n->boarding_local_x;
            iy = n->boarding_local_y;
        } else {
            ix = n->idle_local_x;
            iy = n->idle_local_y;
        }
        if (npc_idle_slot_matches(ix, iy, slot_idx)) return true;
    }
    return false;
}

int npc_alloc_ship_idle_slot(uint16_t ship_id, uint16_t for_npc_id) {
    int max_slots = npc_idle_slot_count_for_ship(ship_id);
    for (int s = 0; s < max_slots; s++) {
        if (!npc_idle_slot_taken(ship_id, s, for_npc_id))
            return s;
    }
    /* All slots taken — stack on the last legal slot */
    return max_slots > 0 ? max_slots - 1 : 0;
}

void npc_assign_ship_idle_slot(WorldNpc* npc, SimpleShip* ship, int slot_idx) {
    if (!npc) return;
    float lx, ly;
    npc_idle_slot_pos(slot_idx, &lx, &ly);
    npc->local_x        = lx;
    npc->local_y        = ly;
    npc->idle_local_x   = lx;
    npc->idle_local_y   = ly;
    npc->target_local_x = lx;
    npc->target_local_y = ly;
    if (ship && npc->ship_id == ship->ship_id)
        ship_local_to_world(ship, lx, ly, &npc->x, &npc->y);
}

/* ============================================================================
 * UNCLAIMED NPC SPAWN — neutral swimmer (fallback when killer company unknown).
 * ========================================================================= */
uint32_t spawn_unclaimed_npc(float wx, float wy, int index) {
    return spawn_swimming_npc_at(wx, wy, index, COMPANY_UNCLAIMED, 0);
}

/* Max distance from the issuing player before a manual move order is cancelled. */
#define NPC_COMMAND_RANGE 900.0f

void npc_set_manual_order(WorldNpc* npc, uint32_t player_id) {
    if (!npc) return;
    npc->order_player_id = player_id;
    npc->roam_wait_ms    = 0;
}

void npc_clear_manual_order(WorldNpc* npc) {
    if (!npc) return;
    npc->order_player_id = 0;
}

static bool npc_manual_order_out_of_range(const WorldNpc* npc) {
    if (npc->order_player_id == 0) return false;
    WebSocketPlayer* p = find_player(npc->order_player_id);
    if (!p || !p->active) return true;
    float dx = p->x - npc->x;
    float dy = p->y - npc->y;
    float range = npc->interact_radius + NPC_COMMAND_RANGE;
    return (dx * dx + dy * dy) > range * range;
}

static void npc_cancel_manual_order(WorldNpc* npc, const char* reason) {
    if (npc->order_player_id == 0) return;
    log_info("🛑 NPC %u (%s) manual order cancelled — %s",
             npc->id, npc->name, reason ? reason : "unknown");
    npc_clear_manual_order(npc);
    npc->boarding_ship_id  = 0;
    npc->assigned_weapon_id = 0;
    if (npc->ship_id != 0) {
        npc->idle_local_x = npc->local_x;
        npc->idle_local_y = npc->local_y;
    }
    npc->state = WORLD_NPC_STATE_IDLE;
}

/* ── Friendly boarding (same company; enemy ships need grapples — future) ── */

#define NPC_HULL_TOUCH_RADIUS 18.0f  /* client px — ~NPC body radius */

static bool npc_point_in_hull_client(float lx, float ly, const struct Ship* sim_ship) {
    int n = sim_ship->hull_vertex_count;
    bool inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[i].x));
        float yi = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[i].y));
        float xj = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[j].x));
        float yj = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[j].y));
        if (((yi > ly) != (yj > ly)) &&
            (lx < (xj - xi) * (ly - yi) / (yj - yi + 1e-12f) + xi))
            inside = !inside;
    }
    return inside;
}

static float npc_dist_to_hull_edge_client(float lx, float ly, const struct Ship* sim_ship) {
    float min_dist_sq = 1e20f;
    int n = sim_ship->hull_vertex_count;
    for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        float ax = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[i].x));
        float ay = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[i].y));
        float bx = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[j].x));
        float by = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->hull_vertices[j].y));
        float edx = bx - ax, edy = by - ay;
        float len_sq = edx * edx + edy * edy;
        float t = 0.0f;
        if (len_sq > 1e-10f) {
            t = ((lx - ax) * edx + (ly - ay) * edy) / len_sq;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
        }
        float cx = ax + t * edx, cy = ay + t * edy;
        float ex = lx - cx, ey = ly - cy;
        float d  = ex * ex + ey * ey;
        if (d < min_dist_sq) min_dist_sq = d;
    }
    return sqrtf(min_dist_sq);
}

static bool npc_touching_hull(float wx, float wy,
                              const SimpleShip* ship, const struct Ship* sim_ship) {
    if (!ship || !sim_ship || sim_ship->hull_vertex_count < 3) return false;
    float lx, ly;
    ship_world_to_local(ship, wx, wy, &lx, &ly);
    if (npc_point_in_hull_client(lx, ly, sim_ship)) return true;
    return npc_dist_to_hull_edge_client(lx, ly, sim_ship) <= NPC_HULL_TOUCH_RADIUS;
}

/** True when an NPC may walk/swim aboard without grapples (same faction). */
static bool npc_can_friendly_board(const WorldNpc* npc, const SimpleShip* ship) {
    if (!npc || !ship) return false;
    if (npc->company_id == COMPANY_UNCLAIMED) return false;
    if (npc->company_id != ship->company_id) return false;
    /* SOLO shares company_id across players — commander must be aboard the target. */
    if (npc->company_id == COMPANY_SOLO) {
        if (npc->order_player_id == 0) return false;
        WebSocketPlayer* cmd = find_player(npc->order_player_id);
        return cmd && cmd->active && cmd->parent_ship_id == ship->ship_id;
    }
    return true;
}

/** Snap a swimming NPC onto a friendly ship; returns true on success. */
static bool npc_complete_boarding(WorldNpc* npc) {
    if (npc->boarding_ship_id == 0 || npc->ship_id != 0) return false;

    SimpleShip* bship = find_ship(npc->boarding_ship_id);
    if (!bship || !bship->active) {
        npc->boarding_ship_id = 0;
        return false;
    }
    if (!npc_can_friendly_board(npc, bship)) return false;

    float wx = npc->local_x;  /* world coords while ship_id == 0 */
    float wy = npc->local_y;
    float bcos = cosf(-bship->rotation);
    float bsin = sinf(-bship->rotation);
    float bdx  = wx - bship->x;
    float bdy  = wy - bship->y;
    npc->local_x           = bdx * bcos - bdy * bsin;
    npc->local_y           = bdx * bsin + bdy * bcos;
    npc->ship_id           = npc->boarding_ship_id;
    npc->in_water          = false;
    npc->deck_level        = 1;
    npc->target_local_x    = npc->boarding_local_x;
    npc->target_local_y    = npc->boarding_local_y;
    npc->boarding_ship_id  = 0;
    npc->state             = WORLD_NPC_STATE_MOVING;
    npc->idle_local_x      = npc->boarding_local_x;
    npc->idle_local_y      = npc->boarding_local_y;
    ship_local_to_world(bship, npc->local_x, npc->local_y, &npc->x, &npc->y);
    log_info("\u2693 NPC %u (%s) boarded ship %u, walking to slot (%.0f, %.0f)",
             npc->id, npc->name, npc->ship_id,
             npc->target_local_x, npc->target_local_y);
    return true;
}

static void npc_abort_foreign_boarding(WorldNpc* npc, uint16_t ship_id) {
    npc->boarding_ship_id = 0;
    npc->state            = WORLD_NPC_STATE_IDLE;
    log_info("\U0001f6ab NPC %u (%s) reached ship %u hull but cannot board (different company)",
             npc->id, npc->name, (unsigned)ship_id);
}

/**
 * Tick world NPCs: animate movement across deck, then update world positions.
 */
void tick_world_npcs(float dt) {
    g_npcs_dirty = true; // NPCs ticked this frame — JSON must be rebuilt
    /* Trim trailing inactive slots so world_npc_count stays accurate */
    while (world_npc_count > 0 && !world_npcs[world_npc_count - 1].active)
        world_npc_count--;
    // Plank centre positions in client-space local coords (match HULL_POINTS in modules.ts)
    // Order: bow_port, bow_starboard, 3× starboard, stern_starboard, stern_port, 3× port
    static const float s_plank_cx[10] = {
         246.25f,  246.25f,  115.0f,  -35.0f, -185.0f,
        -281.25f, -281.25f, -185.0f,  -35.0f,  115.0f
    };
    static const float s_plank_cy[10] = {
         45.0f, -45.0f, -90.0f, -90.0f, -90.0f,
        -45.0f,  45.0f,  90.0f,  90.0f,  90.0f
    };

    // Snapshot current repairer assignments for O(1) occupancy checks.
    // Updated inline when a new claim is made mid-tick.
    NpcOccEntry occ_buf[MAX_WORLD_NPCS];
    int occ_cnt = 0;
    for (int _bi = 0; _bi < world_npc_count; _bi++) {
        WorldNpc* _bn = &world_npcs[_bi];
        if (_bn->active && _bn->role == NPC_ROLE_REPAIRER && _bn->assigned_weapon_id != 0)
            occ_buf[occ_cnt++] = (NpcOccEntry){ _bn->id, _bn->ship_id, _bn->assigned_weapon_id };
    }

    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* npc = &world_npcs[i];
        if (!npc->active) continue;

        /* Grapple rope owns world position — updated later in update_grapple_hooks(). */
        const bool grappled = world_npc_is_grapple_target(i);

        if (!grappled && npc->state == WORLD_NPC_STATE_MOVING) {
            /* Player-issued move: cancel if the commander walked out of range. */
            if (npc->order_player_id != 0 && npc_manual_order_out_of_range(npc)) {
                npc_cancel_manual_order(npc, "commander out of range");
                continue;
            }

            /* Swim-to-board: track a moving ship and keep the hull target updated. */
            if (npc->ship_id == 0 && npc->boarding_ship_id != 0) {
                SimpleShip* bship = find_ship(npc->boarding_ship_id);
                if (!bship || !bship->active) {
                    npc_cancel_manual_order(npc, "boarding target lost");
                    continue;
                }
                npc->target_local_x = bship->x;
                npc->target_local_y = bship->y;
            }

            // ── Repairer walking home: interrupt if new damage appears ──────────
            if (npc->order_player_id == 0 &&
                npc->role == NPC_ROLE_REPAIRER && npc->assigned_weapon_id == 0 && global_sim) {
                struct Ship* intr_ship = find_sim_ship(npc->ship_id);
                if (intr_ship) {
                    // Resolve ship_seq for MID-based module IDs
                    SimpleShip* _intr_ss = find_ship(npc->ship_id);
                    uint8_t _intr_seq = _intr_ss ? _intr_ss->ship_seq : (uint8_t)(npc->ship_id & 0xFF);
                    uint16_t _intr_deck_mid = MID(_intr_seq, MODULE_OFFSET_DECK);

                    // Check for missing deck (highest priority)
                    bool intr_deck_present = false;
                    for (uint8_t m = 0; m < intr_ship->module_count; m++) {
                        if (intr_ship->modules[m].type_id == MODULE_TYPE_DECK) { intr_deck_present = true; break; }
                    }
                    bool intr_deck_taken = !intr_deck_present &&
                        occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, _intr_deck_mid);
                    if (!intr_deck_present && !intr_deck_taken &&
                        _intr_ss && npc_repair_job_affordable(_intr_ss, intr_ship, _intr_deck_mid)) {
                        npc->target_local_x          = 0.0f;
                        npc->target_local_y          = 0.0f;
                        npc->assigned_weapon_id      = _intr_deck_mid;
                        npc->repair_resources_paid   = false;
                        occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, _intr_deck_mid };
                        log_info("🔨 NPC %u (%s) interrupted — redirecting to replace missing deck",
                                 npc->id, npc->name);
                    } else {
                    // Check for missing planks first
                    bool present[10] = {false};
                    for (uint8_t m = 0; m < intr_ship->module_count; m++) {
                        uint16_t mid = intr_ship->modules[m].id;
                        if (MODULE_OFFSET_IS_PLANK(MID_OFFSET(mid))) present[MID_OFFSET(mid) - MODULE_OFFSET_PLANK_BASE] = true;
                    }
                    int intr_missing = -1;
                    for (int k = 0; k < 10; k++) {
                        if (present[k]) continue;
                        if (_intr_ss && ship_plank_wreckage_blocks(_intr_ss, k)) continue;
                        uint32_t pmid_k = MID(_intr_seq, MODULE_OFFSET_PLANK(k));
                        if (!occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, pmid_k))
                            { intr_missing = k; break; }
                    }
                    if (intr_missing >= 0) {
                        uint32_t intr_plank_mid = MID(_intr_seq, MODULE_OFFSET_PLANK(intr_missing));
                        if (_intr_ss && npc_repair_job_affordable(_intr_ss, intr_ship, intr_plank_mid)) {
                        float pcx = s_plank_cx[intr_missing], pcy = s_plank_cy[intr_missing];
                        float pmag = sqrtf(pcx * pcx + pcy * pcy);
                        if (pmag > 0.0f) { pcx -= (pcx / pmag) * 28.0f; pcy -= (pcy / pmag) * 28.0f; }
                        npc->target_local_x          = pcx;
                        npc->target_local_y          = pcy;
                        npc->assigned_weapon_id      = intr_plank_mid;
                        npc->repair_resources_paid   = false;
                        occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                        log_info("🔨 NPC %u (%s) interrupted — redirecting to missing plank %u",
                                 npc->id, npc->name, npc->assigned_weapon_id);
                        }
                    } else {
                        // Check for damaged modules
                        ShipModule* intr_mod = NULL;
                        ShipModule* intr_stack = NULL;
                        float intr_worst = 1.0f, intr_stack_r = 1.0f;
                        for (uint8_t m = 0; m < intr_ship->module_count; m++) {
                            ShipModule* mod = &intr_ship->modules[m];
                            if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                            if (mod->max_health == 0) continue;
                            float ratio = (float)mod->health / (float)mod->max_health;
                            if (ratio >= 1.0f) continue;
                            if (_intr_ss && !npc_repair_job_affordable(_intr_ss, intr_ship, (uint32_t)mod->id)) continue;
                            bool taken = occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, (uint32_t)mod->id);
                            if (!taken && ratio < intr_worst)  { intr_mod   = mod; intr_worst  = ratio; }
                            if ( taken && ratio < intr_stack_r){ intr_stack = mod; intr_stack_r = ratio; }
                        }
                        if (!intr_mod) intr_mod = intr_stack;
                        if (intr_mod) {
                            float mx, my;
                            get_module_interact_pos(intr_mod, &mx, &my);
                            npc->target_local_x          = mx;
                            npc->target_local_y          = my;
                            npc->assigned_weapon_id      = (uint32_t)intr_mod->id;
                            npc->repair_resources_paid   = false;
                            occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                            log_info("🔧 NPC %u (%s) interrupted — redirecting to damaged module %u (%.0f%% HP)",
                                     npc->id, npc->name, intr_mod->id, intr_worst * 100.0f);
                        }
                    }
                    } // end deck-missing else
                }
            }

            float dx   = npc->target_local_x - npc->local_x;
            float dy   = npc->target_local_y - npc->local_y;
            float dist = sqrtf(dx * dx + dy * dy);
            float step = npc->move_speed * dt;
            if (dist <= step || dist < 0.5f) {
                npc->local_x = npc->target_local_x;
                npc->local_y = npc->target_local_y;

                /* ── Boarding arrival: reached swim target on/near hull ── */
                if (npc->boarding_ship_id != 0 && npc->ship_id == 0) {
                    uint16_t tgt_ship = npc->boarding_ship_id;
                    if (npc_complete_boarding(npc)) {
                        continue; /* re-evaluate on next tick */
                    }
                    SimpleShip* tgt = find_ship(tgt_ship);
                    if (tgt && tgt->active) {
                        npc_abort_foreign_boarding(npc, tgt_ship);
                    } else {
                        npc->boarding_ship_id = 0;
                        npc->state            = WORLD_NPC_STATE_IDLE;
                    }
                    continue;
                }
                if (npc->assigned_weapon_id != 0) {
                    /* Repair crew arrives at a damaged module; gunners/riggers arrive at a post */
                    npc->state = (npc->role == NPC_ROLE_REPAIRER)
                               ? WORLD_NPC_STATE_REPAIRING
                               : WORLD_NPC_STATE_AT_GUN;
                    if (npc->order_player_id != 0 && npc->ship_id != 0) {
                        npc->idle_local_x = npc->local_x;
                        npc->idle_local_y = npc->local_y;
                    }
                    npc_clear_manual_order(npc);

                    /* Rigger just arrived at mast — immediately apply current sail angle/openness
                     * so the sail snaps to the correct position without waiting for the next
                     * sail-angle update message from the helm player. */
                    if (npc->role == NPC_ROLE_RIGGER) {
                        SimpleShip* rship = find_ship(npc->ship_id);
                        if (rship) {
                            ShipModule* mast = find_module_by_id(rship, npc->assigned_weapon_id);
                            if (mast && mast->type_id == MODULE_TYPE_MAST) {
                                uint8_t tgt_open = rship->desired_sail_openness;
                                mast->data.mast.openness = tgt_open;
                                if (tgt_open > 0) mast->state_bits |=  MODULE_STATE_DEPLOYED;
                                else              mast->state_bits &= ~MODULE_STATE_DEPLOYED;
                                {
                                    struct Ship* _ss = find_sim_ship(rship->ship_id);
                                    if (_ss) {
                                        for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                                            if (_ss->modules[mi].id == mast->id) {
                                                _ss->modules[mi].data.mast.openness = mast->data.mast.openness;
                                                _ss->modules[mi].state_bits = mast->state_bits;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    npc->state = WORLD_NPC_STATE_IDLE;
                    if (npc->order_player_id != 0) {
                        if (npc->ship_id != 0) {
                            npc->idle_local_x = npc->local_x;
                            npc->idle_local_y = npc->local_y;
                        }
                        npc_clear_manual_order(npc);
                    }
                }
            } else {
                npc->local_x += (dx / dist) * step;
                npc->local_y += (dy / dist) * step;
                npc->rotation = atan2f(dy, dx); // Face direction of travel

                /* Same-company hull contact: board immediately (skip swimming to centre). */
                if (npc->ship_id == 0 && npc->boarding_ship_id != 0) {
                    uint16_t tgt_ship = npc->boarding_ship_id;
                    SimpleShip* bship = find_ship(tgt_ship);
                    struct Ship* sim  = find_sim_ship(tgt_ship);
                    if (bship && sim &&
                        npc_touching_hull(npc->local_x, npc->local_y, bship, sim)) {
                        if (npc_complete_boarding(npc)) {
                            continue;
                        }
                        npc_abort_foreign_boarding(npc, tgt_ship);
                        continue;
                    }
                }
            }
        }

        // Integrate knockback velocity and apply drag
        if (!grappled && (npc->velocity_x != 0.0f || npc->velocity_y != 0.0f)) {
            const float DRAG = 8.0f; // decay rate (higher = stops faster)
            npc->local_x   += npc->velocity_x * dt;
            npc->local_y   += npc->velocity_y * dt;
            float decay     = 1.0f - DRAG * dt;
            if (decay < 0.0f) decay = 0.0f;
            npc->velocity_x *= decay;
            npc->velocity_y *= decay;
            if (fabsf(npc->velocity_x) < 0.5f) npc->velocity_x = 0.0f;
            if (fabsf(npc->velocity_y) < 0.5f) npc->velocity_y = 0.0f;
        }

        /* Deck-bounds water check: if the NPC slid off the ship edges, mark in_water.
         * Ship is ~480 wide x 120 tall client units; use generous margins.
         * If ship_id == 0 (ship sank) the NPC is always in water. */
        {
            const float DECK_HALF_LEN = 260.0f;
            const float DECK_HALF_WID =  75.0f;
            bool was_water = npc->in_water;
            npc->in_water = (npc->ship_id == 0) ||
                            (fabsf(npc->local_x) > DECK_HALF_LEN ||
                             fabsf(npc->local_y) > DECK_HALF_WID);
            if (!was_water && npc->in_water && npc->fire_timer_ms > 0) {
                /* Fell into water while burning — extinguish immediately */
                npc->fire_timer_ms = 0;
                char fx[192];
                char fxf[256];
                snprintf(fx, sizeof(fx),
                    "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"npc\",\"id\":%u}",
                    npc->id);
                size_t fxfl = websocket_create_frame(WS_OPCODE_TEXT, fx, strlen(fx), fxf, sizeof(fxf));
                if (fxfl > 0) {
                    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                        struct WebSocketClient* wc = &ws_server.clients[ci];
                        if (wc->connected && wc->handshake_complete) send(wc->fd, fxf, fxfl, 0);
                    }
                }
            }
        }

        // Keep world position in sync with ship transform
        if (!grappled) {
            if (npc->ship_id != 0) {
                SimpleShip* ship = find_ship(npc->ship_id);
                if (ship) ship_local_to_world(ship, npc->local_x, npc->local_y, &npc->x, &npc->y);
            } else {
                /* Off-ship NPCs: local_x/y ARE the world coordinates — keep x/y in sync */
                npc->x = npc->local_x;
                npc->y = npc->local_y;
            }
        }

        /* ── Passive HP regeneration ──────────────────────────────────────────
         * Same cadence as player regen: +2 HP every 5 s, 10 s combat delay. */
        if (npc->health > 0 && npc->health < npc->max_health) {
            uint32_t now_regen = get_time_ms();
            if (npc->last_damage_ms == 0 || (now_regen - npc->last_damage_ms) >= 10000u) {
                npc->hp_regen_accum_ms += (uint32_t)(dt * 1000.0f + 0.5f);
                if (npc->hp_regen_accum_ms >= 5000u) {
                    npc->hp_regen_accum_ms -= 5000u;
                    uint16_t healed = (npc->health + 2u > npc->max_health)
                                    ? npc->max_health : (uint16_t)(npc->health + 2u);
                    npc->health = healed;
                }
            } else {
                npc->hp_regen_accum_ms = 0;
            }
        }

        /* ── Swim stamina drain / oxygen / suffocation ────────────────────────
         * Rates match the player system (websocket_server.c).
         * Fractional accumulators carry sub-unit remainders across 30 Hz ticks
         * so the per-second rate is honoured exactly — no minimum-1-per-tick floor. */
        {
            const float NPC_SWIM_DRAIN_PER_S  = 2.0f;   /* matches SWIM_DRAIN_PER_S  */
            const float NPC_O2_DRAIN_PER_S    = 4.0f;   /* matches OXYGEN_DRAIN_PER_S */
            const float NPC_O2_REGEN_PER_S    = 20.0f;  /* matches OXYGEN_REGEN_PER_S */
            const float NPC_SUFFOC_DMG_PER_S  = 10.0f;
            const float NPC_STAM_REGEN_PER_S  = 20.0f;
            const uint32_t NPC_STAM_REGEN_DELAY = 2000u;

            if (npc->in_water) {
                uint32_t now_sw = get_time_ms();
                if (npc->stamina > 0) {
                    /* Drain stamina via accumulator */
                    npc->stam_accum += NPC_SWIM_DRAIN_PER_S * dt;
                    uint16_t sw_drain = (uint16_t)npc->stam_accum;
                    if (sw_drain > 0) {
                        npc->stam_accum -= (float)sw_drain;
                        npc->stamina = (sw_drain >= npc->stamina) ? 0
                                     : (uint16_t)(npc->stamina - sw_drain);
                    }
                    npc->stamina_last_used_ms = now_sw;
                } else {
                    /* Stamina empty — drain oxygen via accumulator */
                    npc->oxygen_accum += NPC_O2_DRAIN_PER_S * dt;
                    uint16_t o2_drain = (uint16_t)npc->oxygen_accum;
                    if (o2_drain > 0) {
                        npc->oxygen_accum -= (float)o2_drain;
                        if (o2_drain >= npc->oxygen) {
                            npc->oxygen = 0;
                            /* Suffocation damage via accumulator */
                            npc->suffoc_accum += NPC_SUFFOC_DMG_PER_S * dt;
                            uint16_t suf = (uint16_t)npc->suffoc_accum;
                            if (suf > 0) {
                                npc->suffoc_accum -= (float)suf;
                                npc->last_damage_ms = now_sw;
                                if (suf >= npc->health) {
                                    npc->health = 0;
                                    npc->active = false;
                                    while (world_npc_count > 0 && !world_npcs[world_npc_count - 1].active)
                                        world_npc_count--;
                                    continue; /* NPC is gone — skip rest of loop body */
                                }
                                npc->health -= suf;
                            }
                        } else {
                            npc->oxygen -= o2_drain;
                        }
                    }
                    npc->stamina_last_used_ms = now_sw;
                }
                /* Ensure suffoc accumulator doesn't creep while O2 > 0 */
                if (npc->oxygen > 0) npc->suffoc_accum = 0.0f;
            } else {
                /* On land / ship — regen stamina after delay */
                uint32_t now_sw = get_time_ms();
                npc->oxygen_accum = 0.0f;
                npc->suffoc_accum = 0.0f;
                if (npc->stamina < npc->max_stamina &&
                    npc->stamina_last_used_ms > 0 &&
                    (now_sw - npc->stamina_last_used_ms) >= NPC_STAM_REGEN_DELAY) {
                    npc->stam_accum += NPC_STAM_REGEN_PER_S * dt;
                    uint16_t gain = (uint16_t)npc->stam_accum;
                    if (gain > 0) {
                        npc->stam_accum -= (float)gain;
                        uint32_t newSt = (uint32_t)npc->stamina + gain;
                        npc->stamina = (newSt > npc->max_stamina)
                            ? npc->max_stamina : (uint16_t)newSt;
                    }
                } else if (npc->stamina >= npc->max_stamina) {
                    npc->stam_accum = 0.0f; /* reset when full to avoid over-accumulating */
                }
                /* Regen oxygen quickly when out of water */
                if (npc->oxygen < npc->max_oxygen) {
                    npc->oxygen_accum += NPC_O2_REGEN_PER_S * dt;
                    uint16_t o2_gain = (uint16_t)npc->oxygen_accum;
                    if (o2_gain > 0) {
                        npc->oxygen_accum -= (float)o2_gain;
                        uint32_t newO = (uint32_t)npc->oxygen + o2_gain;
                        npc->oxygen = (newO > npc->max_oxygen) ? npc->max_oxygen : (uint16_t)newO;
                    }
                } else {
                    npc->oxygen_accum = 0.0f;
                }
            }
        }

        // ── Repair crew (NPC_ROLE_REPAIRER) ───────────────────────────────────────────────
        if (npc->role != NPC_ROLE_REPAIRER) continue;
        if (!global_sim) continue;

        struct Ship* sim_ship = find_sim_ship(npc->ship_id);

        // ── REPAIRING: actively fix the assigned module ──────────────────────────
        if (npc->state == WORLD_NPC_STATE_REPAIRING) {
            bool still_working = false;

            if (sim_ship) {
                uint32_t target_id = npc->assigned_weapon_id;
                SimpleShip* simple = find_ship(npc->ship_id);

                if (!npc->repair_resources_paid) {
                    if (!npc_pay_repair_resources(simple, sim_ship, target_id)) {
                        log_info("📦 NPC %u (%s) — no ship chest resources for module %u",
                                 npc->id, npc->name, target_id);
                        npc->assigned_weapon_id   = 0;
                        npc->repair_resources_paid = false;
                        npc->state                = WORLD_NPC_STATE_IDLE;
                        continue;
                    }
                    npc->repair_resources_paid = true;
                }

                // If the deck is missing, place it first
                if (MID_OFFSET((uint16_t)target_id) == MODULE_OFFSET_DECK) {
                    bool deck_exists = false;
                    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                        if (sim_ship->modules[m].type_id == MODULE_TYPE_DECK) { deck_exists = true; break; }
                    }
                    if (!deck_exists && sim_ship->module_count < MAX_MODULES_PER_SHIP) {
                        ShipModule new_deck = module_create((uint16_t)target_id, MODULE_TYPE_DECK, (Vec2Q16){0,0}, 0);
                        new_deck.health      = new_deck.max_health / 10;
                        new_deck.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                        sim_ship->modules[sim_ship->module_count++] = new_deck;
                        if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                            simple->modules[simple->module_count++] = new_deck;
                        if (simple)
                            npc_apply_ship_pool_schematic(simple, sim_ship,
                                (int)sim_ship->module_count - 1, ITEM_DECK);
                        log_info("🔨 NPC %u (%s) placed missing deck on ship %u",
                                 npc->id, npc->name, sim_ship->id);
                    }
                }

                // If it's a plank slot that's empty, place a new plank first
                if (MODULE_OFFSET_IS_PLANK(MID_OFFSET((uint16_t)target_id))) {
                    bool module_exists = false;
                    for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                        if ((uint32_t)sim_ship->modules[m].id == target_id) {
                            module_exists = true; break;
                        }
                    }
                    if (!module_exists && sim_ship->module_count < MAX_MODULES_PER_SHIP) {
                        int idx = (int)(MID_OFFSET((uint16_t)target_id) - MODULE_OFFSET_PLANK_BASE);
                        if (simple && ship_plank_wreckage_blocks(simple, idx)) {
                            still_working = true;
                        } else {
                        Vec2Q16 pos = {
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(s_plank_cx[idx])),
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(s_plank_cy[idx]))
                        };
                        ShipModule new_plank = module_create((uint16_t)target_id, MODULE_TYPE_PLANK, pos, 0);
                        new_plank.health      = new_plank.max_health / 10; // start at 10% HP
                        new_plank.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                        sim_ship->modules[sim_ship->module_count++] = new_plank;
                        // Also register in SimpleShip so hit-event tracking stays in sync
                        if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                            simple->modules[simple->module_count++] = new_plank;
                        if (simple)
                            npc_apply_ship_pool_schematic(simple, sim_ship,
                                (int)sim_ship->module_count - 1, ITEM_PLANK);
                        log_info("🔨 NPC %u (%s) placed missing plank %u on ship %u",
                                 npc->id, npc->name, target_id, sim_ship->id);
                        if (simple)
                            ship_plank_clear_wreckage(simple, idx);
                        }
                    }
                }

                if (simple)
                    npc_try_apply_pool_schematic_on_repair(simple, sim_ship, target_id);

                // Now repair the module (whether freshly placed or already present)
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    ShipModule* mod = &sim_ship->modules[m];
                    if ((uint32_t)mod->id != target_id) continue;
                    if (mod->state_bits & MODULE_STATE_DESTROYED) break;

                    // Initiate passive regen
                    mod->state_bits |= MODULE_STATE_REPAIRING;

                    // NPC crew restore the repair ceiling as part of active work.
                    // (damage lowers target_health; NPCs bypass that ceiling so
                    //  they can bring the module back to full health.)
                    if (mod->target_health < (int32_t)mod->max_health)
                        mod->target_health = mod->max_health;

                                    // Repair main HP at 10%/s, capped at target_health
                                    {
                                        if (mod->health < (int32_t)mod->target_health) {
                                            int32_t iheal = (int32_t)((float)mod->max_health * 0.10f * dt);
                                            if (iheal < 1) iheal = 1;
                                            mod->health += iheal;
                                            if (mod->health >= (int32_t)mod->target_health) {
                                                mod->health = (int32_t)mod->target_health;
                                                /* fully healed — still_working stays false → NPC finishes */
                                            } else {
                                                still_working = true;
                                            }
                                        }
                                    }

                    // Repair mast sail fibers at 10%/s
                    if (mod->type_id == MODULE_TYPE_MAST) {
                        float fh    = Q16_TO_FLOAT(mod->data.mast.fiber_health);
                        float fhmax = Q16_TO_FLOAT(mod->data.mast.fiber_max_health);
                        if (fhmax > 0.0f && fh < fhmax) {
                            fh += fhmax * 0.10f * dt;
                            if (fh > fhmax) fh = fhmax;
                            mod->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                            mod->data.mast.wind_efficiency = Q16_FROM_FLOAT(fh / fhmax);
                            if (fh < fhmax) still_working = true;
                        }
                    }
                    break;
                }
            }

            if (!still_working) {
                log_debug("✅ NPC %u (%s) finished with module %u",
                         npc->id, npc->name, npc->assigned_weapon_id);
                /* Award XP for completing a repair */
                npc_apply_xp(npc, 25);
                npc->assigned_weapon_id    = 0;
                npc->repair_resources_paid = false;
                // Fall through to the IDLE scan below so the NPC goes directly to
                // the next damaged/missing module without returning home first.
                npc->state = WORLD_NPC_STATE_IDLE;
            }
        }

        // ── IDLE: scan for next damaged or missing module ────────────────────────
        // This runs both when the NPC was already idle AND immediately after
        // finishing a repair (state was just set to IDLE above).
        if (npc->state == WORLD_NPC_STATE_IDLE) {
            if (!sim_ship) continue;

            // Resolve ship_seq for MID-based module IDs
            SimpleShip* _idle_ss = find_ship(npc->ship_id);
            uint8_t _idle_seq = _idle_ss ? _idle_ss->ship_seq : (uint8_t)(npc->ship_id & 0xFF);
            uint16_t _idle_deck_mid = MID(_idle_seq, MODULE_OFFSET_DECK);

            // --- 0. Check for missing deck (highest priority) -------------------
            bool deck_present = false;
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                if (sim_ship->modules[m].type_id == MODULE_TYPE_DECK) { deck_present = true; break; }
            }
            if (!deck_present) {
                if (!occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, _idle_deck_mid) &&
                    npc_repair_job_affordable(_idle_ss, sim_ship, _idle_deck_mid)) {
                    npc->target_local_x          = 0.0f;
                    npc->target_local_y          = 0.0f;
                    npc->assigned_weapon_id      = _idle_deck_mid;
                    npc->repair_resources_paid   = false;
                    npc->state                   = WORLD_NPC_STATE_MOVING;
                    occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, _idle_deck_mid };
                    log_info("🔨 NPC %u (%s) → walking to replace missing deck", npc->id, npc->name);
                    continue;
                }
            }

            // --- 1. Check for missing planks (highest priority) ------------------
            bool present[10] = {false};
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                uint16_t mid = sim_ship->modules[m].id;
                if (MODULE_OFFSET_IS_PLANK(MID_OFFSET(mid))) present[MID_OFFSET(mid) - MODULE_OFFSET_PLANK_BASE] = true;
            }
            int missing_idx = -1;
            for (int k = 0; k < 10; k++) {
                if (present[k]) continue;
                if (_idle_ss && ship_plank_wreckage_blocks(_idle_ss, k)) continue;
                uint32_t plank_mid_k = MID(_idle_seq, MODULE_OFFSET_PLANK(k));
                if (!occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, plank_mid_k))
                    { missing_idx = k; break; }
            }

            if (missing_idx >= 0) {
                uint32_t plank_mid = MID(_idle_seq, MODULE_OFFSET_PLANK(missing_idx));
                if (!npc_repair_job_affordable(_idle_ss, sim_ship, plank_mid)) {
                    /* no resources — skip plank placement */
                } else {
                // Pull inward toward ship centre by REPAIR_PLANK_INSET units
                float pcx = s_plank_cx[missing_idx], pcy = s_plank_cy[missing_idx];
                float pmag = sqrtf(pcx * pcx + pcy * pcy);
                if (pmag > 0.0f) { pcx -= (pcx / pmag) * REPAIR_PLANK_INSET; pcy -= (pcy / pmag) * REPAIR_PLANK_INSET; }
                npc->target_local_x          = pcx;
                npc->target_local_y          = pcy;
                npc->assigned_weapon_id      = plank_mid;
                npc->repair_resources_paid   = false;
                npc->state                   = WORLD_NPC_STATE_MOVING;
                occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                log_debug("🔨 NPC %u (%s) → walking to place missing plank %u",
                         npc->id, npc->name, npc->assigned_weapon_id);
                continue;
                }
            }

            // --- 2. Check for damaged modules ------------------------------------
            // First pass: prefer a module NOT already claimed by another NPC.
            // If everything damaged is taken, fall back to stacking on the worst one.
            ShipModule* target_mod  = NULL;
            ShipModule* stack_mod   = NULL; // fallback: most-damaged taken module
            float worst_ratio  = 1.0f;
            float stack_ratio  = 1.0f;
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                ShipModule* mod = &sim_ship->modules[m];
                if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                if (mod->max_health == 0) continue;
                float ratio = (float)mod->health / (float)mod->max_health;
                // For masts, also consider fiber (sail) health damage
                if (mod->type_id == MODULE_TYPE_MAST) {
                    float fhmax = Q16_TO_FLOAT(mod->data.mast.fiber_max_health);
                    if (fhmax > 0.0f) {
                        float fh = Q16_TO_FLOAT(mod->data.mast.fiber_health);
                        float fiber_ratio = fh / fhmax;
                        if (fiber_ratio < ratio) ratio = fiber_ratio;
                    }
                }
                if (ratio >= 1.0f) continue;
                if (_idle_ss && !npc_repair_job_affordable(_idle_ss, sim_ship, (uint32_t)mod->id)) continue;
                bool taken = occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, (uint32_t)mod->id);
                if (!taken && ratio < worst_ratio) { target_mod = mod; worst_ratio = ratio; }
                if ( taken && ratio < stack_ratio)  { stack_mod  = mod; stack_ratio = ratio; }
            }
            // If no untaken module available, allow stacking on the most-damaged taken one
            if (!target_mod) target_mod = stack_mod;

            if (target_mod) {
                float mx, my;
                get_module_repair_pos(target_mod, &mx, &my);
                npc->target_local_x          = mx;
                npc->target_local_y          = my;
                npc->assigned_weapon_id      = (uint32_t)target_mod->id;
                npc->repair_resources_paid   = false;
                npc->state                   = WORLD_NPC_STATE_MOVING;
                occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                log_info("🔧 NPC %u (%s) → walking to repair module %u (%.0f%% HP)",
                         npc->id, npc->name, target_mod->id, worst_ratio * 100.0f);
                continue;
            }

            // --- 3. Nothing to do: wander to a random ship module
            if (npc->order_player_id != 0) continue;
            if (npc->state == WORLD_NPC_STATE_IDLE) {
                float hdx = npc->target_local_x - npc->local_x;
                float hdy = npc->target_local_y - npc->local_y;
                bool at_dest = sqrtf(hdx * hdx + hdy * hdy) < 2.0f;

                if (at_dest) {
                    if (npc->roam_wait_ms > 0) {
                        /* Still dwelling — count down the timer */
                        uint32_t dec = (uint32_t)(dt * 1000.0f);
                        npc->roam_wait_ms = (npc->roam_wait_ms > dec) ? npc->roam_wait_ms - dec : 0;
                    } else if (sim_ship && sim_ship->module_count > 0) {
                        /* Timer expired — pick a new random module and start a fresh dwell */
                        float mx_list[MAX_MODULES_PER_SHIP];
                        float my_list[MAX_MODULES_PER_SHIP];
                        int   mod_choices = 0;
                        for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                            ShipModule* mod = &sim_ship->modules[m];
                            if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                            float mx, my;
                            get_module_repair_pos(mod, &mx, &my);
                            float ddx = mx - npc->local_x, ddy = my - npc->local_y;
                            if (sqrtf(ddx * ddx + ddy * ddy) < 10.0f) continue;
                            mx_list[mod_choices] = mx;
                            my_list[mod_choices] = my;
                            mod_choices++;
                        }
                        if (mod_choices > 0) {
                            unsigned int seed = (unsigned int)(npc->id * 2654435761u)
                                              ^ (unsigned int)(npc->local_x * 7.0f)
                                              ^ (unsigned int)(npc->local_y * 13.0f);
                            int pick = (int)((seed >> 8) % (unsigned int)mod_choices);
                            npc->target_local_x = mx_list[pick];
                            npc->target_local_y = my_list[pick];
                            npc->state          = WORLD_NPC_STATE_MOVING;
                            /* Dwell will start when NPC arrives at the new destination */
                            npc->roam_wait_ms   = 15000 + (uint32_t)(rand() % 45001);
                        }
                    }
                }
            }
        }
    }
}
