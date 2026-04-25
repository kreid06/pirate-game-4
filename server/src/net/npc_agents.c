#include <math.h>
#include <string.h>
#include <stdio.h>
#include "net/npc_agents.h"
#include "net/npc_world.h"
#include "net/module_interactions.h"

/* ── NPC global levelling constants ───────────────────────────────────────── */
/* Max global level: 1 base + 65 upgrades */
#define NPC_MAX_LEVEL       66u
/* XP needed to advance from level L to L+1: NPC_LEVEL_XP_BASE * L */
#define NPC_LEVEL_XP_BASE  100u

/* ── Player levelling constants ────────────────────────────────────────────── */
#define PLAYER_MAX_LEVEL     120u  /* 1 base + 119 upgrades */
#define PLAYER_LEVEL_XP_BASE NPC_LEVEL_XP_BASE
/* XP awarded per kill */
#define PLAYER_XP_PER_NPC_KILL    25u
#define PLAYER_XP_PER_PLAYER_KILL 75u

/* ============================================================================
 * NPC CANNON PRIORITY SYSTEM
 * ============================================================================*/
#define SWAP_HYSTERESIS (10.0f * ((float)M_PI / 180.0f))  /* 10° dead-band */

/**
 * Timeout (ms) after last activity before MODULE_STATE_NEEDED is cleared.
 */
#define CANNON_NEEDED_TIMEOUT_MS  2000
/* Duration of the client-side sinking animation; ship stays alive this long after hull_health=0 */
#define SHIP_SINK_DURATION_MS     8000

/* Forward declaration */
static void dispatch_gunner_to_weapon(WorldNpc* npc, SimpleShip* ship, uint32_t cannon_id, float abs_diff_deg);

/**
 * Aim a specific cannon on a ship toward a world-space target (CLIENT pixel coords).
 * Sets aim_direction on both SimpleShip and sim-ship cannon modules.
 */
__attribute__((unused))
static void npc_aim_cannon_at_world(SimpleShip* ship, ShipModule* cannon, float target_x, float target_y) {
    const float CANNON_AIM_RANGE = 30.0f * (float)(M_PI / 180.0);

    // World angle from cannon toward target (client-pixel space — same coord system as ship->x/y)
    float dx = target_x - ship->x;
    float dy = target_y - ship->y;
    float world_angle = atan2f(dy, dx);

    // Convert to ship-relative angle
    float relative_angle = world_angle - ship->rotation;
    while (relative_angle >  (float)M_PI) relative_angle -= 2.0f * (float)M_PI;
    while (relative_angle < -(float)M_PI) relative_angle += 2.0f * (float)M_PI;

    // desired_offset is the delta from the cannon's natural barrel direction
    float cannon_base_angle = Q16_TO_FLOAT(cannon->local_rot);
    float desired_offset = relative_angle - cannon_base_angle + (float)(M_PI / 2.0);
    while (desired_offset >  (float)M_PI) desired_offset -= 2.0f * (float)M_PI;
    while (desired_offset < -(float)M_PI) desired_offset += 2.0f * (float)M_PI;

    if (desired_offset >  CANNON_AIM_RANGE) desired_offset =  CANNON_AIM_RANGE;
    if (desired_offset < -CANNON_AIM_RANGE) desired_offset = -CANNON_AIM_RANGE;

    cannon->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);

    // Mirror into sim-ship so fire_cannon reads the correct value
    {
        struct Ship* sim_ship = find_sim_ship(ship->ship_id);
        if (sim_ship) {
            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                if (sim_ship->modules[m].id == cannon->id) {
                    sim_ship->modules[m].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                    break;
                }
            }
        }
    }
}

/**
 * Tick all active NPC agents — gunners aim/fire, helmsmen steer, riggers adjust sails.
 */
void tick_npc_agents(float dt) {
    for (int i = 0; i < npc_count; i++) {
        NpcAgent* npc = &npc_agents[i];
        if (!npc->active) continue;

        SimpleShip* ship = find_ship(npc->ship_id);
        if (!ship) continue;

        ShipModule* module = find_module_on_ship(ship, npc->module_id);
        if (!module) continue;

        switch (npc->role) {
            case NPC_ROLE_GUNNER: {
                npc->fire_cooldown -= dt;
                if (npc->target_ship_id == 0) break;

                SimpleShip* target = find_ship(npc->target_ship_id);
                if (!target) break;
                // Don't fire on allied ships
                if (is_allied(ship->company_id, target->company_id)) break;

                // Only aim/fire while the WorldNpc gunner is stationary at this weapon.
                // Find the corresponding WorldNpc for this module and check its state.
                bool npc_at_gun = false;
                for (int wn = 0; wn < world_npc_count; wn++) {
                    WorldNpc* wnpc = &world_npcs[wn];
                    if (wnpc->active && wnpc->role == NPC_ROLE_GUNNER &&
                        wnpc->ship_id == ship->ship_id &&
                        wnpc->assigned_weapon_id == module->id &&
                        wnpc->state == WORLD_NPC_STATE_AT_GUN) {
                        npc_at_gun = true;
                        break;
                    }
                }
                if (!npc_at_gun) break;

                /* ── Swivel path ──────────────────────────────────────────── */
                if (module->type_id == MODULE_TYPE_SWIVEL) {
                    WeaponGroup* grp = find_weapon_group(ship->ship_id, module->id, ship->company_id);
                    if (grp && grp->mode == WEAPON_GROUP_MODE_HALTFIRE) break; /* suppressed */

                    /* AIMING / FREEFIRE group → NPC defers to player's helm aim angle
                     * (same as cannon NPCs tracking ship->active_aim_angle).
                     * TARGETFIRE / not in any group → NPC auto-aims at target ship. */
                    bool player_controls_aim = grp &&
                        (grp->mode == WEAPON_GROUP_MODE_AIMING ||
                         grp->mode == WEAPON_GROUP_MODE_FREEFIRE);

                    float desired_off;
                    if (player_controls_aim) {
                        /* Sync to ship->active_aim_angle — same convention as handle_swivel_aim */
                        float sw_base = Q16_TO_FLOAT(module->local_rot);
                        desired_off = ship->active_aim_angle - sw_base + (float)(M_PI / 2.0f);
                        while (desired_off >  (float)M_PI) desired_off -= 2.0f * (float)M_PI;
                        while (desired_off < -(float)M_PI) desired_off += 2.0f * (float)M_PI;
                    } else {
                        /* Auto-aim at target ship centre */
                        float cos_r  = cosf(ship->rotation);
                        float sin_r  = sinf(ship->rotation);
                        float local_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                        float local_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                        float world_x = ship->x + (local_x * cos_r - local_y * sin_r);
                        float world_y = ship->y + (local_x * sin_r + local_y * cos_r);
                        float dx = target->x - world_x;
                        float dy = target->y - world_y;
                        float world_angle = atan2f(dy, dx);
                        float sw_base = Q16_TO_FLOAT(module->local_rot) - (float)(M_PI / 2.0f);
                        desired_off = world_angle - ship->rotation - sw_base;
                        while (desired_off >  (float)M_PI) desired_off -= 2.0f * (float)M_PI;
                        while (desired_off < -(float)M_PI) desired_off += 2.0f * (float)M_PI;
                    }

                    const float SWIVEL_AIM_RANGE = 90.0f * ((float)M_PI / 180.0f);
                    if (desired_off >  SWIVEL_AIM_RANGE) desired_off =  SWIVEL_AIM_RANGE;
                    if (desired_off < -SWIVEL_AIM_RANGE) desired_off = -SWIVEL_AIM_RANGE;
                    module->data.swivel.aim_direction = Q16_FROM_FLOAT(desired_off);
                    /* Mirror to global_sim */
                    {
                        struct Ship* _ss = find_sim_ship(ship->ship_id);
                        if (_ss) {
                            for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                                if (_ss->modules[mi].id == module->id) {
                                    _ss->modules[mi].data.swivel.aim_direction = Q16_FROM_FLOAT(desired_off);
                                    break;
                                }
                            }
                        }
                    }
                    /* Auto-aiming NPCs fire when reload is complete.
                     * Player-aim mode: swivel fires on the player's fire command. */
                    if (!player_controls_aim &&
                        module->data.swivel.time_since_fire >= module->data.swivel.reload_time) {
                        ShipModule* gsw = NULL;
                        {
                            struct Ship* _ss2 = find_sim_ship(ship->ship_id);
                            if (_ss2) {
                                for (uint8_t mi = 0; mi < _ss2->module_count; mi++) {
                                    if (_ss2->modules[mi].id == module->id) { gsw = &_ss2->modules[mi]; break; }
                                }
                            }
                        }
                        fire_swivel(ship, module, gsw, NULL, PROJ_TYPE_GRAPESHOT);
                    }
                    break;
                }

                /* ── Weapon-group override ──────────────────────────────────
                 * If this cannon belongs to a player's weapon control group,
                 * the group mode dictates what the NPC does:
                 *
                 *   HALTFIRE   → suppress everything; NPC does not aim or fire.
                 *   TARGETFIRE → aim is handled by tick_player_weapon_groups();
                 *                skip the NPC aim update below to avoid fighting it.
                 *   AIMING / FREEFIRE → NPC aims normally (follows ship aim angle).
                 * ─────────────────────────────────────────────────────────── */
                {
                    WeaponGroup* grp = find_weapon_group(ship->ship_id, module->id, ship->company_id);
                    if (grp) {
                        if (grp->mode == WEAPON_GROUP_MODE_HALTFIRE)   break; /* suppressed */
                        if (grp->mode == WEAPON_GROUP_MODE_TARGETFIRE)  break; /* aim owned by tick_player_weapon_groups */
                        /* AIMING / FREEFIRE: NPC follows ship aim angle normally */
                    }
                }

                // Sync cannon's desired aim to the ship's current aim angle every tick.
                // Mirrors the rigger pattern: the NpcAgent continuously applies the
                // authoritative ship value so no aim message is needed on arrival.
                {
                    float cannon_base_angle = Q16_TO_FLOAT(module->local_rot);
                    float desired_offset = ship->active_aim_angle - cannon_base_angle
                                          + (float)(M_PI / 2.0f);
                    while (desired_offset >  (float)M_PI) desired_offset -= 2.0f * (float)M_PI;
                    while (desired_offset < -(float)M_PI) desired_offset += 2.0f * (float)M_PI;
                    const float CANNON_AIM_RANGE        = 30.0f * ((float)M_PI / 180.0f);
                    const float CANNON_AIM_RESET_MARGIN = 15.0f * ((float)M_PI / 180.0f);
                    if (fabsf(desired_offset) > CANNON_AIM_RANGE + CANNON_AIM_RESET_MARGIN)
                        desired_offset = 0.0f; // Past grace zone — return to neutral
                    else if (fabsf(desired_offset) > CANNON_AIM_RANGE)
                        desired_offset = (desired_offset > 0.0f) ? CANNON_AIM_RANGE : -CANNON_AIM_RANGE;
                    module->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                    // Mirror into sim-ship
                    {
                        struct Ship* _ss = find_sim_ship(ship->ship_id);
                        if (_ss) {
                            for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                                if (_ss->modules[mi].id == module->id) {
                                    _ss->modules[mi].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);
                                    break;
                                }
                            }
                        }
                    }
                }

                break;
            }

            case NPC_ROLE_RIGGER: {
                // Set sail openness and angle to the ship's desired values
                if (module->type_id == MODULE_TYPE_MAST) {
                    uint8_t target_openness = ship->desired_sail_openness;
                    module->data.mast.openness = target_openness;
                    if (target_openness > 0)
                        module->state_bits |=  MODULE_STATE_DEPLOYED;
                    else
                        module->state_bits &= ~MODULE_STATE_DEPLOYED;

                    // Apply desired sail angle
                    module->data.mast.angle = Q16_FROM_FLOAT(ship->desired_sail_angle);
                    // Mirror into sim-ship
                    {
                        struct Ship* _ss = find_sim_ship(ship->ship_id);
                        if (_ss) {
                            for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                                if (_ss->modules[mi].id == module->id) {
                                    _ss->modules[mi].data.mast.angle = module->data.mast.angle;
                                    break;
                                }
                            }
                        }
                    }

                    // Gradually repair torn sail fibers at 500 HP/s.
                    float fh    = Q16_TO_FLOAT(module->data.mast.fiber_health);
                    float fhmax = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                    if (fhmax <= 0.0f) fhmax = 15000.0f;
                    if (fh < fhmax) {
                        fh += 500.0f * dt;
                        if (fh > fhmax) fh = fhmax;
                        module->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                        module->data.mast.wind_efficiency = Q16_FROM_FLOAT(fh / fhmax);
                    }
                }
                break;
            }

            case NPC_ROLE_HELMSMAN: {
                // Steer the ship toward the desired heading
                if (module->type_id == MODULE_TYPE_HELM ||
                    module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                    float diff = npc->desired_heading - ship->rotation;
                    while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                    while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;

                    const float TURN_RATE = 0.5f; // rad/s max
                    float turn = diff;
                    if (turn >  TURN_RATE * dt) turn =  TURN_RATE * dt;
                    if (turn < -TURN_RATE * dt) turn = -TURN_RATE * dt;
                    ship->rotation += turn;
                }
                break;
            }

            default:
                break;
        }
    }
}

/* Walk a gunner to the given cannon or swivel module. */
static void dispatch_gunner_to_weapon(WorldNpc* npc, SimpleShip* ship,
                                      uint32_t cannon_id, float abs_diff_deg) {
    ShipModule* cannon = find_module_by_id(ship, cannon_id);
    if (!cannon) return;
    float cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.x));
    float cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(cannon->local_pos.y));
    float barrel_angle = Q16_TO_FLOAT(cannon->local_rot) - (float)(M_PI / 2.0f);
    /* Swivels are smaller — NPC stands slightly closer to the pivot */
    const float CANNON_MOUNT_DIST = (cannon->type_id == MODULE_TYPE_SWIVEL) ? 18.0f : 25.0f;
    npc->assigned_weapon_id = cannon_id;
    npc->target_local_x     = cx - cosf(barrel_angle) * CANNON_MOUNT_DIST;
    npc->target_local_y     = cy - sinf(barrel_angle) * CANNON_MOUNT_DIST;
    npc->state              = WORLD_NPC_STATE_MOVING;

    /* Keep the corresponding NpcAgent's module_id in sync so that
     * tick_npc_agents can find and aim the correct cannon after dispatch. */
    for (int ai = 0; ai < npc_count; ai++) {
        if (npc_agents[ai].active && npc_agents[ai].npc_id == npc->id &&
            npc_agents[ai].ship_id == npc->ship_id) {
            npc_agents[ai].module_id = cannon_id;
            break;
        }
    }
    // log_info("🔫 NPC %u (%s) → cannon %u (%.0f° off aim)",
    //          npc->id, npc->name, cannon_id, abs_diff_deg);
    (void)abs_diff_deg;
}

/**
 * tick_cannon_needed_expiry — run once per server tick.
 */
void tick_cannon_needed_expiry(void) {
    uint32_t now = get_time_ms();
    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active) continue;
        for (int m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_CANNON && mod->type_id != MODULE_TYPE_SWIVEL) continue;
            if (!(mod->state_bits & MODULE_STATE_NEEDED)) continue;

            uint32_t last_aim = ship->cannon_last_needed_ms[m];
            if (last_aim == 0) {
                /* Never had NEEDED set properly — clear it */
                mod->state_bits &= ~MODULE_STATE_NEEDED;
                continue;
            }

            uint32_t aim_expiry = last_aim + CANNON_NEEDED_TIMEOUT_MS;

            /* A fired cannon stays NEEDED for the full reload + grace period */
            uint32_t fire_expiry = 0;
            if (ship->cannon_last_fire_ms[m] > 0) {
                fire_expiry = ship->cannon_last_fire_ms[m]
                            + CANNON_RELOAD_TIME_MS
                            + CANNON_NEEDED_TIMEOUT_MS;
            }

            uint32_t effective = (fire_expiry > aim_expiry) ? fire_expiry : aim_expiry;
            if (now > effective) {
                mod->state_bits &= ~MODULE_STATE_NEEDED;
            }
        }
    }
}

/**
 * Mark swivel guns as NEEDED when this ship's NPC agents have an active enemy target.
 */
void tick_swivel_crew_demand(SimpleShip* ship) {
    (void)ship; /* NEEDED for swivels is now driven by handle_cannon_aim sector-check, same as cannons */
}

/**
 * Assign free on-duty gunner NPCs to any weapon-group cannon that is currently
 * unmanned and has MODULE_STATE_NEEDED set.
 */
void assign_weapon_group_crew(SimpleShip* ship) {
    if (!ship) return;

    for (int m = 0; m < ship->module_count; m++) {
        ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON && mod->type_id != MODULE_TYPE_SWIVEL) continue;

        /* Only dispatch to weapons that are actively NEEDED. */
        if (!(mod->state_bits & MODULE_STATE_NEEDED)) continue;

        /* Check occupancy: player seated here? */
        bool occupied = false;
        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
            WebSocketPlayer* p = &players[pi];
            if (p->active && p->is_mounted && p->mounted_module_id == mod->id) {
                occupied = true; break;
            }
        }
        /* WorldNpc gunner stationed or en-route here? */
        bool en_route = false;
        if (!occupied) {
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* npc = &world_npcs[ni];
                if (npc->active && npc->role == NPC_ROLE_GUNNER &&
                    npc->ship_id == ship->ship_id &&
                    npc->assigned_weapon_id == mod->id) {
                    if (npc->state == WORLD_NPC_STATE_AT_GUN) occupied  = true;
                    else                                          en_route  = true;
                    break;
                }
            }
        }

        if (occupied || en_route) continue; /* already handled */

        /* Find the nearest free gunner NPC.  An NPC is "free" if it is either
         * unassigned (idle) or its current cannon no longer has NEEDED set
         * (the timeout expired — the cannon is inactive). */
        WorldNpc* best = NULL;
        float     best_dist = 1e9f;
        float     cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float     cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
        for (int ni = 0; ni < world_npc_count; ni++) {
            WorldNpc* npc = &world_npcs[ni];
            if (!npc->active || npc->ship_id != ship->ship_id) continue;
            if (npc->role != NPC_ROLE_GUNNER || !npc->wants_cannon) continue;
            if (npc->assigned_weapon_id != 0) {
                /* Only pull from a cannon whose NEEDED has expired */
                ShipModule* cur = find_module_on_ship(ship, npc->assigned_weapon_id);
                if (cur && (cur->state_bits & MODULE_STATE_NEEDED)) continue;
            }
            float dx = npc->local_x - cx;
            float dy = npc->local_y - cy;
            float dist = dx * dx + dy * dy;
            if (dist < best_dist) { best_dist = dist; best = npc; }
        }

        if (best) {
            // log_info("🎯 Cannon %u NEEDED+unmanned — dispatching NPC %u (%s)",
            //          mod->id, best->id, best->name);
            dispatch_gunner_to_weapon(best, ship, mod->id, 0.0f);
        }
    }

}

/**
 * Returns true if cannon_id is claimed by any player weapon group on the given ship.
 */
void update_npc_cannon_sector(SimpleShip* ship, float aim_angle) {
    if (!ship) return;

    /* ─ Step 1: rank ALL cannons by angular distance from aim ─────────────────
     * Group cannons are included; HALTFIRE group cannons receive a 2π penalty
     * so they always sort to the back of the list (lower crew priority) but
     * are never completely invisible to the sector system.                     */
    uint32_t sorted_ids [MAX_MODULES_PER_SHIP];
    float    sorted_diff[MAX_MODULES_PER_SHIP];
    int      weapon_count = 0;

    for (int m = 0; m < ship->module_count; m++) {
        ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON && mod->type_id != MODULE_TYPE_SWIVEL) continue;

        float fire_dir = Q16_TO_FLOAT(mod->local_rot) - (float)(M_PI / 2.0f);
        float diff = aim_angle - fire_dir;
        while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
        while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
        float abs_diff = fabsf(diff);

        /* Cannons urgently needing crew sort to the very front regardless of angle.
         * HALTFIRE group cannons sort to the back.  These two bonuses are mutually
         * exclusive in practice (HALTFIRE suppresses aiming so it never gets NEEDED). */
        if (mod->state_bits & MODULE_STATE_NEEDED)
            abs_diff -= 2.0f * (float)M_PI;   /* guaranteed negative → sorts first */
        else {
            WeaponGroup* grp = find_weapon_group(ship->ship_id, mod->id, ship->company_id);
            if (grp && grp->mode == WEAPON_GROUP_MODE_HALTFIRE)
                abs_diff += 2.0f * (float)M_PI; /* sorts last */
        }

        /* Insertion sort: smallest diff first */
        int pos = weapon_count;
        while (pos > 0 && sorted_diff[pos - 1] > abs_diff) {
            sorted_ids [pos] = sorted_ids [pos - 1];
            sorted_diff[pos] = sorted_diff[pos - 1];
            pos--;
        }
        sorted_ids [pos] = mod->id;
        sorted_diff[pos] = abs_diff;
        weapon_count++;
    }
    if (weapon_count == 0) return;

    /* ─ Step 2: dispatch unassigned or released gunners to NEEDED cannons only. ─ */
    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* npc = &world_npcs[i];
        if (!npc->active || npc->ship_id != ship->ship_id) continue;
        if (npc->role != NPC_ROLE_GUNNER || !npc->wants_cannon) continue;
        /* Locked NPCs stay pinned to their current cannon regardless of sector changes */
        if (npc->task_locked) continue;

        /* NPC is already heading to or sitting at a cannon — keep them
         * unless their cannon's NEEDED has expired AND another cannon
         * has NEEDED and is uncovered. */
        if (npc->assigned_weapon_id != 0) {
            ShipModule* cur = find_module_on_ship(ship, npc->assigned_weapon_id);
            bool cur_needed = cur && (cur->state_bits & MODULE_STATE_NEEDED);
            if (cur_needed) continue; /* their cannon is still active — stay */

            /* Their cannon's NEEDED expired.  Only move if there is another
             * NEEDED cannon that is uncovered. */
            bool any_needed_elsewhere = false;
            for (int mn = 0; mn < ship->module_count; mn++) {
                if (ship->modules[mn].id == npc->assigned_weapon_id) continue;
                if ((ship->modules[mn].type_id == MODULE_TYPE_CANNON ||
                     ship->modules[mn].type_id == MODULE_TYPE_SWIVEL) &&
                    (ship->modules[mn].state_bits & MODULE_STATE_NEEDED)) {
                    bool covered = false;
                    for (int j = 0; j < world_npc_count; j++) {
                        if (j == i) continue;
                        WorldNpc* o = &world_npcs[j];
                        if (o->active && o->role == NPC_ROLE_GUNNER &&
                            o->ship_id == ship->ship_id &&
                            o->assigned_weapon_id == ship->modules[mn].id) {
                            covered = true; break;
                        }
                    }
                    if (!covered) { any_needed_elsewhere = true; break; }
                }
            }
            if (!any_needed_elsewhere) continue; /* no NEEDED cannon uncovered — stay put */
        }

        /* Find the highest-priority NEEDED cannon not already covered by another NPC */
        uint32_t best_id = 0;
        float    best_diff = (float)M_PI * 4.0f; /* sorted_diff can be negative for NEEDED */
        for (int c = 0; c < weapon_count; c++) {
            uint32_t cid = sorted_ids[c];
            ShipModule* cmod = find_module_on_ship(ship, cid);
            if (!cmod || !(cmod->state_bits & MODULE_STATE_NEEDED)) continue;
            /* Already assigned to this one? Stay */
            if (cid == npc->assigned_weapon_id) { best_id = cid; best_diff = sorted_diff[c]; break; }
            /* Check nobody else is already covering it */
            bool covered = false;
            for (int j = 0; j < world_npc_count; j++) {
                if (j == i) continue;
                WorldNpc* o = &world_npcs[j];
                if (o->active && o->role == NPC_ROLE_GUNNER &&
                    o->ship_id == ship->ship_id &&
                    o->assigned_weapon_id == cid) { covered = true; break; }
            }
            if (!covered) { best_id = cid; best_diff = sorted_diff[c]; break; }
        }

        if (best_id == 0 || best_id == npc->assigned_weapon_id) continue;

        dispatch_gunner_to_weapon(npc, ship, best_id,
                                  best_diff * 180.0f / (float)M_PI);
    }

    // log_info("⚓ Ship %u priority dispatch: aim=%.0f°, top cannon %u (%.0f° off)",
    //          ship->ship_id, aim_angle * 180.0f / (float)M_PI,
    //          sorted_ids[0], sorted_diff[0] * 180.0f / (float)M_PI);
}

/*
 * Grant XP to a crew NPC and apply any level-ups.
 * Stops accumulating XP once NPC_MAX_LEVEL is reached.
 * Each level-up gives 1 stat point (= npc_level - 1 - total_stats_spent).
 */
void npc_apply_xp(WorldNpc* npc, uint32_t xp_gain) {
    if (npc->npc_level >= NPC_MAX_LEVEL) return; /* already max level — no more XP */
    npc->xp += xp_gain;
    /* Process level-ups: cost to advance from L to L+1 is NPC_LEVEL_XP_BASE * L */
    while (npc->npc_level < NPC_MAX_LEVEL) {
        uint32_t cost = NPC_LEVEL_XP_BASE * (uint32_t)npc->npc_level;
        if (npc->xp < cost) break;
        npc->xp -= cost;
        npc->npc_level++;
    }
}

/*
 * Grant XP to a player and apply any level-ups.
 * Each level-up gives 1 stat point (player_level - 1 - total_stats_spent).
 */
void player_apply_xp(WebSocketPlayer* p, uint32_t xp_gain) {
    if (p->player_level >= PLAYER_MAX_LEVEL) return;
    p->player_xp += xp_gain;
    while (p->player_level < PLAYER_MAX_LEVEL) {
        uint32_t cost = PLAYER_LEVEL_XP_BASE * (uint32_t)p->player_level;
        if (p->player_xp < cost) break;
        p->player_xp -= cost;
        p->player_level++;
        log_info("🎉 Player %u levelled up to %u!", p->player_id, (unsigned)p->player_level);
    }
}
