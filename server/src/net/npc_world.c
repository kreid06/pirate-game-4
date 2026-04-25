#include <math.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "net/npc_world.h"
#include "net/npc_agents.h"
#include "net/module_interactions.h"

// ── Repairer occupancy: small precomputed set rebuilt each tick ──────────────
typedef struct { uint16_t npc_id; uint16_t ship_id; module_id_t mod_id; } NpcOccEntry;

static bool occ_taken_by_other(const NpcOccEntry* buf, int cnt,
                                uint16_t self_npc_id, uint16_t ship_id, module_id_t mod_id) {
    for (int k = 0; k < cnt; k++)
        if (buf[k].ship_id == ship_id && buf[k].mod_id == mod_id && buf[k].npc_id != self_npc_id)
            return true;
    return false;
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
        npc->role = NPC_ROLE_RIGGER;
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
        /* Become a gunner — sector system places at the closest cannon */
        npc->role         = NPC_ROLE_GUNNER;
        npc->wants_cannon = true;
        update_npc_cannon_sector(ship, ship->active_aim_angle);
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

/**
 * Spawn a generic crew member.  Role is set at runtime by the manning panel
 * (Sails → RIGGER, Cannons → GUNNER, Idle → NONE).
 * Returns the new NPC id, or 0 on failure.
 */
uint32_t spawn_ship_crew(uint16_t ship_id, const char* name) {
    if (world_npc_count >= MAX_WORLD_NPCS) {
        log_warn("spawn_ship_crew: MAX_WORLD_NPCS reached");
        return 0;
    }
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
    WorldNpc* npc = &world_npcs[world_npc_count++];
    memset(npc, 0, sizeof(WorldNpc));
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
    strncpy(npc->name,     name,              sizeof(npc->name)     - 1);
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

    /* Stagger idle positions along ship centreline */
    int slot_idx = (int)(npc->id % 9);
    npc->local_x        = -200.0f + slot_idx * 50.0f;
    npc->local_y        = 0.0f;
    npc->idle_local_x   = npc->local_x;   /* remembered for life */
    npc->idle_local_y   = npc->local_y;
    npc->target_local_x = npc->local_x;
    npc->target_local_y = npc->local_y;
    ship_local_to_world(ship, npc->local_x, npc->local_y, &npc->x, &npc->y);
    log_info("🧑 Crew '%s' (id %u) on ship %u — idle", npc->name, npc->id, ship_id);
    return npc->id;
}

/* ============================================================================
 * UNCLAIMED NPC SPAWN
 * Spawns a free-floating, neutral NPC in the water at world position (wx, wy).
 * Called when a ghost ship is destroyed — 2-3 survivors wash up as recruitable.
 * index 0-2 produces a scatter offset so they don't all stack.
 * ========================================================================= */
uint32_t spawn_unclaimed_npc(float wx, float wy, int index) {
    if (world_npc_count >= MAX_WORLD_NPCS) {
        log_warn("spawn_unclaimed_npc: MAX_WORLD_NPCS reached");
        return 0;
    }
    static const char* const SURVIVOR_NAMES[] = {
        "Phantom Sailor", "Ghost Deckhand", "Spectre Mariner",
        "Wraith Jackal",  "Haunt Gunner",  "Moor Spirit",
    };
    const int NAME_COUNT = (int)(sizeof(SURVIVOR_NAMES) / sizeof(SURVIVOR_NAMES[0]));
    /* Scatter: each survivor drifts slightly away from the wreck */
    static const float OFFSETS_X[3] = {  20.0f, -30.0f,  10.0f };
    static const float OFFSETS_Y[3] = { -20.0f,  10.0f,  40.0f };
    float ox = OFFSETS_X[index < 3 ? index : 0];
    float oy = OFFSETS_Y[index < 3 ? index : 0];

    WorldNpc* npc = &world_npcs[world_npc_count++];
    memset(npc, 0, sizeof(WorldNpc));
    npc->id              = next_world_npc_id++;
    npc->active          = true;
    npc->role            = NPC_ROLE_NONE;
    npc->ship_id         = 0;         /* free-standing — not on any ship */
    npc->company_id      = 0;         /* unclaimed: COMPANY_NEUTRAL */
    npc->move_speed      = 60.0f;
    npc->interact_radius = 60.0f;     /* larger — floating in the water */
    npc->state           = WORLD_NPC_STATE_IDLE;
    npc->in_water        = true;
    npc->x               = wx + ox;
    npc->y               = wy + oy;
    npc->local_x         = 0.0f;
    npc->local_y         = 0.0f;

    const char* chosen = SURVIVOR_NAMES[(npc->id) % NAME_COUNT];
    strncpy(npc->name,     chosen,       sizeof(npc->name)     - 1);
    strncpy(npc->dialogue, "Help me...", sizeof(npc->dialogue) - 1);

    npc->npc_level   = 1;
    npc->max_health  = 100;
    npc->health      = 100;
    npc->xp          = 0;

    log_info("👻 Unclaimed NPC '%s' (id %u) in water at (%.0f, %.0f)",
             npc->name, npc->id, npc->x, npc->y);
    return npc->id;
}

/**
 * Tick world NPCs: animate movement across deck, then update world positions.
 */
void tick_world_npcs(float dt) {
    g_npcs_dirty = true; // NPCs ticked this frame — JSON must be rebuilt
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

        if (npc->state == WORLD_NPC_STATE_MOVING) {
            // ── Repairer walking home: interrupt if new damage appears ──────────
            if (npc->role == NPC_ROLE_REPAIRER && npc->assigned_weapon_id == 0 && global_sim) {
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
                    if (!intr_deck_present && !intr_deck_taken) {
                        npc->target_local_x     = 0.0f;
                        npc->target_local_y     = 0.0f;
                        npc->assigned_weapon_id = _intr_deck_mid;
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
                        uint32_t pmid_k = MID(_intr_seq, MODULE_OFFSET_PLANK(k));
                        if (!occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, pmid_k))
                            { intr_missing = k; break; }
                    }
                    if (intr_missing >= 0) {
                        float pcx = s_plank_cx[intr_missing], pcy = s_plank_cy[intr_missing];
                        float pmag = sqrtf(pcx * pcx + pcy * pcy);
                        if (pmag > 0.0f) { pcx -= (pcx / pmag) * 28.0f; pcy -= (pcy / pmag) * 28.0f; }
                        npc->target_local_x     = pcx;
                        npc->target_local_y     = pcy;
                        npc->assigned_weapon_id = MID(_intr_seq, MODULE_OFFSET_PLANK(intr_missing));
                        occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                        log_info("🔨 NPC %u (%s) interrupted — redirecting to missing plank %u",
                                 npc->id, npc->name, npc->assigned_weapon_id);
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
                            bool taken = occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, (uint32_t)mod->id);
                            if (!taken && ratio < intr_worst)  { intr_mod   = mod; intr_worst  = ratio; }
                            if ( taken && ratio < intr_stack_r){ intr_stack = mod; intr_stack_r = ratio; }
                        }
                        if (!intr_mod) intr_mod = intr_stack;
                        if (intr_mod) {
                            float mx, my;
                            get_module_interact_pos(intr_mod, &mx, &my);
                            npc->target_local_x     = mx;
                            npc->target_local_y     = my;
                            npc->assigned_weapon_id = (uint32_t)intr_mod->id;
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

                /* ── Boarding arrival: NPC swam to the hull entry point ── */
                if (npc->boarding_ship_id != 0 && npc->ship_id == 0) {
                    SimpleShip* bship = find_ship(npc->boarding_ship_id);
                    if (bship) {
                        /* Convert the hull entry world pos → ship-local coords */
                        float bcos = cosf(-bship->rotation);
                        float bsin = sinf(-bship->rotation);
                        float bdx  = npc->local_x - bship->x;  /* local_x == world_x when ship_id==0 */
                        float bdy  = npc->local_y - bship->y;
                        npc->local_x           = bdx * bcos - bdy * bsin;
                        npc->local_y           = bdx * bsin + bdy * bcos;
                        npc->ship_id           = npc->boarding_ship_id;
                        npc->in_water          = false;
                        npc->target_local_x    = npc->boarding_local_x;
                        npc->target_local_y    = npc->boarding_local_y;
                        npc->boarding_ship_id  = 0;
                        npc->state             = WORLD_NPC_STATE_MOVING;
                        log_info("\u2693 NPC %u (%s) boarded ship %u, walking to (%.0f, %.0f)",
                                 npc->id, npc->name, npc->ship_id,
                                 npc->target_local_x, npc->target_local_y);
                    } else {
                        /* Ship disappeared — cancel boarding */
                        npc->boarding_ship_id = 0;
                        npc->state = WORLD_NPC_STATE_IDLE;
                    }
                    continue; /* re-evaluate on next tick */
                }
                if (npc->assigned_weapon_id != 0) {
                    /* Repair crew arrives at a damaged module; gunners/riggers arrive at a post */
                    npc->state = (npc->role == NPC_ROLE_REPAIRER)
                               ? WORLD_NPC_STATE_REPAIRING
                               : WORLD_NPC_STATE_AT_GUN;

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
                                mast->data.mast.angle = Q16_FROM_FLOAT(rship->desired_sail_angle);
                                {
                                    struct Ship* _ss = find_sim_ship(rship->ship_id);
                                    if (_ss) {
                                        for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                                            if (_ss->modules[mi].id == mast->id) {
                                                _ss->modules[mi].data.mast.angle = mast->data.mast.angle;
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
                }
            } else {
                npc->local_x += (dx / dist) * step;
                npc->local_y += (dy / dist) * step;
                npc->rotation = atan2f(dy, dx); // Face direction of travel
            }
        }

        // Integrate knockback velocity and apply drag
        if (npc->velocity_x != 0.0f || npc->velocity_y != 0.0f) {
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
        if (npc->ship_id != 0) {
            SimpleShip* ship = find_ship(npc->ship_id);
            if (ship) ship_local_to_world(ship, npc->local_x, npc->local_y, &npc->x, &npc->y);
        } else {
            /* Off-ship NPCs: local_x/y ARE the world coordinates — keep x/y in sync */
            npc->x = npc->local_x;
            npc->y = npc->local_y;
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
                        SimpleShip* simple = find_ship(npc->ship_id);
                        if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                            simple->modules[simple->module_count++] = new_deck;
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
                        Vec2Q16 pos = {
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(s_plank_cx[idx])),
                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(s_plank_cy[idx]))
                        };
                        ShipModule new_plank = module_create((uint16_t)target_id, MODULE_TYPE_PLANK, pos, 0);
                        new_plank.health      = new_plank.max_health / 10; // start at 10% HP
                        new_plank.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                        sim_ship->modules[sim_ship->module_count++] = new_plank;
                        // Also register in SimpleShip so hit-event tracking stays in sync
                        SimpleShip* simple = find_ship(npc->ship_id);
                        if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                            simple->modules[simple->module_count++] = new_plank;
                        log_info("🔨 NPC %u (%s) placed missing plank %u on ship %u",
                                 npc->id, npc->name, target_id, sim_ship->id);
                    }
                }

                // Now repair the module (whether freshly placed or already present)
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    ShipModule* mod = &sim_ship->modules[m];
                    if ((uint32_t)mod->id != target_id) continue;
                    if (mod->state_bits & MODULE_STATE_DESTROYED) break;

                    // Initiate passive regen
                    mod->state_bits |= MODULE_STATE_REPAIRING;

                                    // Repair main HP at 10%/s, capped at target_health
                                    {
                                        if (mod->health < (int32_t)mod->target_health) {
                                            float heal = (float)mod->max_health * 0.10f * dt;
                                            mod->health += (int32_t)heal;
                                            if (mod->health >= (int32_t)mod->target_health) {
                                                mod->health = (int32_t)mod->target_health;
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
                log_info("✅ NPC %u (%s) finished with module %u",
                         npc->id, npc->name, npc->assigned_weapon_id);
                /* Award XP for completing a repair */
                npc_apply_xp(npc, 25);
                npc->assigned_weapon_id = 0;
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
                if (!occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, _idle_deck_mid)) {
                    npc->target_local_x     = 0.0f;
                    npc->target_local_y     = 0.0f;
                    npc->assigned_weapon_id = _idle_deck_mid;
                    npc->state              = WORLD_NPC_STATE_MOVING;
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
                uint32_t plank_mid_k = MID(_idle_seq, MODULE_OFFSET_PLANK(k));
                if (!occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, plank_mid_k))
                    { missing_idx = k; break; }
            }

            if (missing_idx >= 0) {
                // Stop 28 client units inward from the hull edge
                float pcx = s_plank_cx[missing_idx], pcy = s_plank_cy[missing_idx];
                float pmag = sqrtf(pcx * pcx + pcy * pcy);
                if (pmag > 0.0f) { pcx -= (pcx / pmag) * 28.0f; pcy -= (pcy / pmag) * 28.0f; }
                npc->target_local_x     = pcx;
                npc->target_local_y     = pcy;
                npc->assigned_weapon_id = MID(_idle_seq, MODULE_OFFSET_PLANK(missing_idx));
                npc->state              = WORLD_NPC_STATE_MOVING;
                occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                log_info("🔨 NPC %u (%s) → walking to place missing plank %u",
                         npc->id, npc->name, npc->assigned_weapon_id);
                continue;
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
                bool taken = occ_taken_by_other(occ_buf, occ_cnt, npc->id, npc->ship_id, (uint32_t)mod->id);
                if (!taken && ratio < worst_ratio) { target_mod = mod; worst_ratio = ratio; }
                if ( taken && ratio < stack_ratio)  { stack_mod  = mod; stack_ratio = ratio; }
            }
            // If no untaken module available, allow stacking on the most-damaged taken one
            if (!target_mod) target_mod = stack_mod;

            if (target_mod) {
                float mx, my;
                get_module_interact_pos(target_mod, &mx, &my);
                npc->target_local_x     = mx;
                npc->target_local_y     = my;
                npc->assigned_weapon_id = (uint32_t)target_mod->id;
                npc->state              = WORLD_NPC_STATE_MOVING;
                occ_buf[occ_cnt++] = (NpcOccEntry){ npc->id, npc->ship_id, npc->assigned_weapon_id };
                log_info("🔧 NPC %u (%s) → walking to repair module %u (%.0f%% HP)",
                         npc->id, npc->name, target_mod->id, worst_ratio * 100.0f);
                continue;
            }

            // --- 3. Nothing to do: wander to a random ship module
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
                            get_module_interact_pos(mod, &mx, &my);
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
