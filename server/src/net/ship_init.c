#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#define _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "net/websocket_server_internal.h"
#include "net/ship_init.h"
#include "net/cannon_fire.h"
#include "../../protocol/ship_definitions.h"
#include "net/module_interactions.h"
#include "sim/ship_level.h"

void tick_sinking_ships(void) {
    uint32_t now = get_time_ms();
    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active || !ship->is_sinking) continue;

        /* Keep the vessel stationary — zero velocity in the sim ship every tick */
        {
            struct Ship* _ss = find_sim_ship(ship->ship_id);
            if (_ss) { _ss->velocity.x = 0; _ss->velocity.y = 0; _ss->angular_velocity = 0; }
        }
        ship->velocity_x = 0.0f;
        ship->velocity_y = 0.0f;
        ship->angular_velocity = 0.0f;

        /* After 8 s, fully despawn and broadcast SHIP_SINK */
        if ((now - ship->sink_start_ms) < SHIP_SINK_DURATION_MS) continue;

        entity_id sunk_id = ship->ship_id;
        float wx = ship->x, wy = ship->y;

        /* Eject any remaining players to the water */
        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
            if (!players[pi].active || players[pi].parent_ship_id != sunk_id) continue;
            players[pi].parent_ship_id      = 0;
            players[pi].movement_state      = PLAYER_STATE_SWIMMING;
            players[pi].is_mounted          = false;
            players[pi].mounted_module_id   = 0;
            players[pi].controlling_ship_id = 0;
            players[pi].x = SERVER_TO_CLIENT(CLIENT_TO_SERVER(wx));
            players[pi].y = SERVER_TO_CLIENT(CLIENT_TO_SERVER(wy));
        }

        /* Eject any remaining NPCs — clear ship_id so they are orphaned in the world */
        for (int ni = 0; ni < world_npc_count; ni++) {
            if (!world_npcs[ni].active || world_npcs[ni].ship_id != sunk_id) continue;
            world_npcs[ni].ship_id  = 0;
            world_npcs[ni].in_water = true;
            world_npcs[ni].fire_timer_ms = 0;
        }

        /* Destroy in sim */
        if (global_sim) sim_destroy_entity(global_sim, sunk_id);

        /* Swap-and-pop */
        ships[s] = ships[ship_count - 1];
        memset(&ships[ship_count - 1], 0, sizeof(SimpleShip));
        ship_count--;
        s--; /* re-check this slot */

        /* Broadcast final SHIP_SINK */
        char msg[128];
        snprintf(msg, sizeof(msg),
            "{\"type\":\"SHIP_SINK\",\"shipId\":%u,\"x\":%.1f,\"y\":%.1f}",
            sunk_id, SERVER_TO_CLIENT(CLIENT_TO_SERVER(wx)), SERVER_TO_CLIENT(CLIENT_TO_SERVER(wy)));
        websocket_server_broadcast(msg);
        log_info("⚓ Ship %u fully despawned after sinking", sunk_id);

        /* ── Spawn shipwreck ────────────────────────────────────────────────
         * Build a loot table from the sunk ship's modules + ammo, then place
         * a STRUCT_WRECK at the same world position.  Players can swim out
         * and E-interact to salvage one slot at a time.                   */
        if (placed_structure_count < MAX_PLACED_STRUCTURES) {
            /* -- Build loot -- */
            uint8_t l_items[6] = {0};
            uint8_t l_qtys[6]  = {0};
            int     l_count    = 0;

            /* Always drop some planks (2-6) */
            l_items[l_count] = (uint8_t)ITEM_PLANK;
            l_qtys[l_count]  = 2 + (uint8_t)(sunk_id % 5);  /* deterministic 2-6 */
            l_count++;

            /* Count cannon modules on the sunk ship and add loot.
             * The sim entity is already destroyed by this point, so use
             * ship_id as a deterministic seed for loot quantities.       */
            {
                /* Seed cannonballs 1-8 based on ship_id */
                uint8_t ball_qty = (uint8_t)((sunk_id * 7 + 3) % 8 + 1);
                if (l_count < 6) {
                    l_items[l_count] = (uint8_t)ITEM_CANNON_BALL;
                    l_qtys[l_count]  = ball_qty;
                    l_count++;
                }
                /* 50% chance of a salvageable cannon */
                if (l_count < 6 && (sunk_id % 2) == 0) {
                    l_items[l_count] = (uint8_t)ITEM_CANNON;
                    l_qtys[l_count]  = 1;
                    l_count++;
                }
                /* 33% chance of a sail */
                if (l_count < 6 && (sunk_id % 3) == 0) {
                    l_items[l_count] = (uint8_t)ITEM_SAIL;
                    l_qtys[l_count]  = 1;
                    l_count++;
                }
            }

            /* -- Place wreck -- */
            PlacedStructure *w = &placed_structures[placed_structure_count];
            memset(w, 0, sizeof(*w));
            w->active           = true;
            w->id               = next_structure_id++;
            w->type             = STRUCT_WRECK;
            w->x                = wx;
            w->y                = wy;
            w->island_id        = 0;          /* at sea */
            w->hp               = (uint16_t)l_count;
            w->max_hp           = (uint16_t)l_count;
            w->wreck_loot_count = (uint8_t)l_count;
            w->wreck_expires_ms = get_time_ms() + 300000; /* 5 min auto-despawn */
            for (int li = 0; li < l_count; li++) {
                w->wreck_items[li] = l_items[li];
                w->wreck_qtys[li]  = l_qtys[li];
            }
            strncpy(w->placer_name, "shipwreck", sizeof(w->placer_name) - 1);
            placed_structure_count++;

            /* Broadcast so clients can render the wreck */
            char wbcast[256];
            snprintf(wbcast, sizeof(wbcast),
                "{\"type\":\"wreck_spawned\",\"id\":%u,\"x\":%.1f,\"y\":%.1f,"
                "\"loot_count\":%u,\"expires_ms\":%u}",
                (unsigned)w->id, wx, wy,
                (unsigned)l_count, (unsigned)w->wreck_expires_ms);
            websocket_server_broadcast(wbcast);
            log_info("🪵 Wreck %u spawned at (%.0f,%.0f) with %d loot slots",
                     (unsigned)w->id, wx, wy, l_count);
        }
    }
}

/**
 * Partition the ship's cannon modules into sensible default weapon control groups.
 * Group 0 = port-side cannons  (local_y > 0), mode = HALTFIRE
 * Group 1 = starboard cannons  (local_y < 0), mode = HALTFIRE
 * Groups 2-9 = empty,                          mode = HALTFIRE
 *
 * All groups start HALTFIRE so the ship is silent until the player actively
 * configures them.  Called once after all modules have been added to the ship.
 */
void ship_init_default_weapon_groups(SimpleShip* ship) {
    /* Reset all groups to HALTFIRE with no cannons */
    /* Reset all company slots to HALTFIRE with no cannons */
    for (int co = 0; co < MAX_COMPANIES; co++) {
        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            ship->weapon_groups[co][g].mode         = (uint8_t)WEAPON_GROUP_MODE_HALTFIRE;
            ship->weapon_groups[co][g].weapon_count = 0;
            ship->weapon_groups[co][g].target_ship_id = 0;
        }
    }

    /* Partition cannons: port (local_y > 0) → group 1, starboard → group 2.
     * Apply to ALL company slots so that any company boarding the ship starts
     * with a sensible default layout. */
    for (int co = 0; co < MAX_COMPANIES; co++) {
        for (int m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_CANNON) continue;

            float local_y = Q16_TO_FLOAT(mod->local_pos.y);
            int   target_group = (local_y > 0.0f) ? 1 : 2;
            WeaponGroup* grp = &ship->weapon_groups[co][target_group];
            if (grp->weapon_count < MAX_WEAPONS_PER_GROUP) {
                grp->weapon_ids[grp->weapon_count++] = mod->id;
            }
        }
    }

    log_info("🔫 Ship %u: default groups — port=%d cannons (grp1), starboard=%d cannons (grp2) [all %d company slots]",
             ship->ship_id,
             ship->weapon_groups[0][1].weapon_count,
             ship->weapon_groups[0][2].weapon_count,
             MAX_COMPANIES);
}

// Initialize a brigantine ship at the given slot index, world position (client pixels), and company.
// ship_seq : 8-bit sequence number — top byte of all module IDs: MID(ship_seq, offset).
//            See server/include/sim/module_ids.h for the offset table.
// modules_placed: bitmask of MODULE_HULL_LEFT..MODULE_CANNON_STBD.
//            0xFF = all modules present (normal spawn).  0x00 = bare skeleton.
void init_brigantine_ship(int idx, float world_x, float world_y, uint8_t ship_seq, uint8_t company_id, uint8_t modules_placed) {
    SimpleShip* s = &ships[idx];
    memset(s, 0, sizeof(SimpleShip));

    /* ship_id = ship_seq on a single server.
     * Widen to (server_id<<8)|ship_seq when cluster support is added.
     * ship_seq & 0xFF always extracts the module-namespace byte. */
    s->ship_id  = ship_seq;
    s->ship_seq = ship_seq;
    s->ship_type = 3;  // Brigantine
    s->company_id = company_id;
    s->x = world_x;
    s->y = world_y;
    s->active = true;

    s->mass             = BRIGANTINE_MASS;
    s->moment_of_inertia = BRIGANTINE_MOMENT_OF_INERTIA;
    s->max_speed        = BRIGANTINE_MAX_SPEED;
    s->turn_rate        = BRIGANTINE_TURN_RATE;
    s->water_drag       = BRIGANTINE_WATER_DRAG;
    s->angular_drag     = BRIGANTINE_ANGULAR_DRAG;

    // Deck bounds (server units = client px / 10)
    s->deck_min_x = -31.0f;
    s->deck_max_x =  30.0f;
    s->deck_min_y =  -8.0f;
    s->deck_max_y =   8.0f;

    s->module_count = 0;
    s->cannon_ammo  = 0;       // unused — infinite_ammo is on
    s->infinite_ammo = true;

    /* Emergency ladder — offset 0x01 — always present on every ship */
    s->modules[s->module_count].id          = MID(ship_seq, MODULE_OFFSET_LADDER);
    s->modules[s->module_count].type_id     = MODULE_TYPE_LADDER;
    s->modules[s->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-305.0f));
    s->modules[s->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
    s->modules[s->module_count].local_rot   = Q16_FROM_FLOAT(0.0f);
    s->modules[s->module_count].state_bits  = MODULE_STATE_ACTIVE;
    s->module_count++;

    /* Bare skeleton — hull geometry only, no modules at all. */
    if (modules_placed == 0) {
        ship_init_default_weapon_groups(s);
        log_info("🔧 Ship slot %d (ID %u, seq=%u): SKELETON (emergency ladder only), pos=(%.0f,%.0f)", idx, s->ship_id, ship_seq, world_x, world_y);
        return;
    }

    /* Helm — offset 0x02 */
    s->modules[s->module_count].id           = MID(ship_seq, MODULE_OFFSET_HELM);
    s->modules[s->module_count].type_id      = MODULE_TYPE_HELM;
    s->modules[s->module_count].local_pos.x  = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f));
    s->modules[s->module_count].local_pos.y  = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
    s->modules[s->module_count].local_rot    = Q16_FROM_FLOAT(0.0f);
    s->modules[s->module_count].state_bits   = MODULE_STATE_ACTIVE;
    s->modules[s->module_count].data.helm.occupied_by    = 0;
    s->modules[s->module_count].data.helm.wheel_rotation = Q16_FROM_FLOAT(0.0f);
    s->module_count++;

    /* 6 cannons — BROADSIDE loadout (x=fore/aft, y=port/starboard)
     * Port offsets 0x03..0x05 — only if MODULE_CANNON_PORT was placed
     * Stbd offsets 0x06..0x08 — only if MODULE_CANNON_STBD was placed */
    {
        float cannon_xs[3] = { -35.0f, 65.0f, -135.0f };
        bool has_port = (modules_placed & MODULE_CANNON_PORT) != 0;
        bool has_stbd = (modules_placed & MODULE_CANNON_STBD) != 0;
        for (int i = 0; i < 6; i++) {
            bool is_port = (i < 3);
            if (is_port && !has_port) continue;
            if (!is_port && !has_stbd) continue;
            float cx  = cannon_xs[i % 3];
            float cy  = is_port ? 75.0f : -75.0f;
            float rot = is_port ? (float)M_PI : 0.0f;
            s->modules[s->module_count].id          = MID(ship_seq, MODULE_OFFSET_CANNON(i));
            s->modules[s->module_count].type_id     = MODULE_TYPE_CANNON;
            s->modules[s->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cx));
            s->modules[s->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cy));
            s->modules[s->module_count].local_rot   = Q16_FROM_FLOAT(rot);
            s->modules[s->module_count].state_bits  = MODULE_STATE_ACTIVE;
            s->modules[s->module_count].data.cannon.aim_direction  = Q16_FROM_FLOAT(0.0f);
            s->modules[s->module_count].data.cannon.ammunition     = 10;
            s->modules[s->module_count].data.cannon.reload_time    = CANNON_RELOAD_TIME_MS;
            s->modules[s->module_count].data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS;
            s->module_count++;
        }
    }

    /* 3 masts — offsets 0x09..0x0B — only if MODULE_MAST was placed */
    if (modules_placed & MODULE_MAST) {
    float mast_xs[3] = { 165.0f, -35.0f, -235.0f };
    for (int i = 0; i < 3; i++) {
        s->modules[s->module_count].id          = MID(ship_seq, MODULE_OFFSET_MAST(i));
        s->modules[s->module_count].type_id     = MODULE_TYPE_MAST;
        s->modules[s->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(mast_xs[i]));
        s->modules[s->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
        s->modules[s->module_count].local_rot   = Q16_FROM_FLOAT(0.0f);
        s->modules[s->module_count].state_bits  = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
        s->modules[s->module_count].data.mast.angle          = Q16_FROM_FLOAT(0.0f);
        s->modules[s->module_count].data.mast.openness       = 0;
        s->modules[s->module_count].data.mast.wind_efficiency = Q16_FROM_FLOAT(1.0f);
        s->module_count++;
    }
    } /* end if MODULE_MAST */

    /* 10 planks — offsets 0x0C..0x15 (MODULE_OFFSET_PLANK(0..9)) */
    {
        static const float plank_cx[10] = {
             246.25f,  246.25f,  115.0f,  -35.0f, -185.0f,
            -281.25f, -281.25f, -185.0f,  -35.0f,  115.0f
        };
        static const float plank_cy[10] = {
             45.0f, -45.0f, -90.0f, -90.0f, -90.0f,
            -45.0f,  45.0f,  90.0f,  90.0f,  90.0f
        };
        for (int i = 0; i < 10 && s->module_count < MAX_MODULES_PER_SHIP; i++) {
            Vec2Q16 pos = {
                Q16_FROM_FLOAT(CLIENT_TO_SERVER(plank_cx[i])),
                Q16_FROM_FLOAT(CLIENT_TO_SERVER(plank_cy[i]))
            };
            s->modules[s->module_count++] = module_create(
                MID(ship_seq, MODULE_OFFSET_PLANK(i)), MODULE_TYPE_PLANK, pos, 0);
        }
    }

    /* Deck — offset 0x16 */
    if (s->module_count < MAX_MODULES_PER_SHIP) {
        s->modules[s->module_count++] = module_create(
            MID(ship_seq, MODULE_OFFSET_DECK), MODULE_TYPE_DECK, (Vec2Q16){0, 0}, 0);
    }

    /* Set up default weapon control groups now that all modules are registered */
    ship_init_default_weapon_groups(s);

    log_info("🔧 Ship slot %d (ID %u, seq=%u): %d modules, pos=(%.0f,%.0f)", idx, s->ship_id, ship_seq, s->module_count, world_x, world_y);
}

uint32_t websocket_server_create_ship(float x, float y, uint8_t company_id, uint8_t modules_placed) {
    if (!global_sim) {
        log_warn("websocket_server_create_ship: no simulation linked");
        return 0;
    }
    if (ship_count >= MAX_SIMPLE_SHIPS) {
        log_warn("websocket_server_create_ship: MAX_SIMPLE_SHIPS (%d) reached", MAX_SIMPLE_SHIPS);
        return 0;
    }

    // Allocate a unique ship_seq for this ship — passed to both layers so module IDs match.
    uint8_t seq = next_ship_seq++;
    if (next_ship_seq == 0) next_ship_seq = 1; /* skip 0 — reserved as MODULE_ID_INVALID */

    // Build the SimpleShip layout
    init_brigantine_ship(ship_count, x, y, seq, company_id, modules_placed);

    // Create the authoritative physics counterpart using the same seq
    Vec2Q16 sim_pos = {
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)),
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
    };
    entity_id sim_id = sim_create_ship(global_sim, sim_pos, Q16_FROM_INT(0), modules_placed, seq);
    if (sim_id == INVALID_ENTITY_ID) {
        log_warn("websocket_server_create_ship: sim_create_ship failed");
        ships[ship_count].active = false;
        return 0;
    }

    // Sync ship_id to the sim entity ID so the update loop matches them
    ships[ship_count].ship_id = sim_id;
    ship_count++;

    log_info("🚢 Admin spawned ship (ID: %u, seq=%u) at (%.0f, %.0f) company=%u", sim_id, seq, x, y, company_id);
    return sim_id;
}

/* Ghost cannon arc — ±90 degrees (much wider than normal 30°) */
#define GHOST_CANNON_ARC    (90.0f * (float)(M_PI / 180.0))
/* Cannon sweep: side-to-side oscillation rate while chasing */
#define GHOST_SWEEP_RATE    0.14f  /* rad/s — very slow haunting sweep (5× slower) */
/* Sweep amplitude (radians). ~40° wide arc swing side-to-side */
#define GHOST_SWING_AMP     0.785f  /* ±45° sweep amplitude */
/* How much the ship BODY sways left/right while chasing (radians) */
#define GHOST_HEADING_SWING 0.785f /* ±45° — slow haunting weave while pursuing */

/**
 * Aim a ghost-ship cannon at a world target.
 *
 * aim_direction is the OFFSET from the cannon's natural firing direction
 * (defined by local_rot).  The turret can swing at most ±45° (GHOST_AIM_LIMIT)
 * from that natural direction.  If the target falls outside that arc the turret
 * parks at the limit and the fire gate (fire_diff check) prevents firing.
 *
 * Convention that matches the client renderer and fire-angle math:
 *   natural world fire angle = ship->rotation + local_rot - π/2
 *   actual world fire angle  = natural + aim_direction
 */
#define GHOST_AIM_LIMIT  ((float)(M_PI / 4.0f))   /* ±45° turret travel */
static void ghost_aim_cannon(SimpleShip* ship, ShipModule* cannon,
                             float target_x, float target_y) {
    float dx = target_x - ship->x;
    float dy = target_y - ship->y;
    float world_angle = atan2f(dy, dx);

    /* Angle to target relative to ship heading */
    float relative_angle = world_angle - ship->rotation;
    while (relative_angle >  (float)M_PI) relative_angle -= 2.0f * (float)M_PI;
    while (relative_angle < -(float)M_PI) relative_angle += 2.0f * (float)M_PI;

    /* How far the turret must rotate from its rest position (local_rot - π/2)
     * to point at the target.  desired_offset == 0 means cannon aims along
     * its natural direction. */
    float cannon_base_angle = Q16_TO_FLOAT(cannon->local_rot);
    float desired_offset = relative_angle - cannon_base_angle + (float)(M_PI / 2.0f);
    while (desired_offset >  (float)M_PI) desired_offset -= 2.0f * (float)M_PI;
    while (desired_offset < -(float)M_PI) desired_offset += 2.0f * (float)M_PI;

    /* Clamp to ±45° — the turret physically cannot rotate further */
    if (desired_offset >  GHOST_AIM_LIMIT) desired_offset =  GHOST_AIM_LIMIT;
    if (desired_offset < -GHOST_AIM_LIMIT) desired_offset = -GHOST_AIM_LIMIT;

    cannon->data.cannon.desired_aim_direction = Q16_FROM_FLOAT(desired_offset);

    /* Mirror desired AND current aim_direction onto the sim cannon.
     * Match by position rather than ID because SimpleShip uses mid_base+n IDs
     * while sim_create_ship uses ship_id*1000+n — they never match by default.
     * Position is identical in both (same CLIENT_TO_SERVER values). */
    if (global_sim) {
        float cx = Q16_TO_FLOAT(cannon->local_pos.x);
        float cy = Q16_TO_FLOAT(cannon->local_pos.y);
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            if (global_sim->ships[s].id == ship->ship_id) {
                struct Ship* sim_ship = &global_sim->ships[s];
                for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                    if (sim_ship->modules[m].type_id != MODULE_TYPE_CANNON) continue;
                    float sx = Q16_TO_FLOAT(sim_ship->modules[m].local_pos.x);
                    float sy = Q16_TO_FLOAT(sim_ship->modules[m].local_pos.y);
                    float d2 = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy);
                    if (d2 < 0.01f) {
                        sim_ship->modules[m].data.cannon.desired_aim_direction =
                            Q16_FROM_FLOAT(desired_offset);
                        break;
                    }
                }
                break;
            }
        }
    }
}

/* ============================================================================
 * PHANTOM BRIG SPAWN  (ship_type = SHIP_TYPE_GHOST = 99)
 * Creates a "Phantom Brig" brigantine at the given world position.  The ship
 * belongs to COMPANY_GHOST (99) and has its port/starboard cannon groups set to
 * TARGETFIRE from the start so tick_ghost_ships can auto-aim them.
 * Phantom Brigs deal hull-only damage — interior module breaches are filtered
 * out in the hit-event processing loop.
 * ========================================================================= */
uint32_t websocket_server_create_ghost_ship(float x, float y) {
    uint16_t ship_id = websocket_server_create_ship(x, y, COMPANY_GHOST, 0xFF);
    if (ship_id == 0) return 0;

    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return ship_id;

    /* Tag as ghost */
    ship->ship_type = SHIP_TYPE_GHOST;

    /* Ghost ships have no physical planks — hull damage is tracked directly via
     * hull_health in simulation.c (7 HP per cannonball hit, heals 1 HP/s).
     * Strip all plank modules from both SimpleShip and sim ship so the plank
     * drain logic never runs and the hit path goes through the ghost entry point. */
    {
        /* Strip planks from SimpleShip */
        int write = 0;
        for (int m = 0; m < ship->module_count; m++) {
            if (ship->modules[m].type_id != MODULE_TYPE_PLANK)
                ship->modules[write++] = ship->modules[m];
        }
        ship->module_count = write;

        /* Strip planks from sim ship */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id != ship_id) continue;
                struct Ship* sim_ship = &global_sim->ships[si];
                uint8_t sw = 0;
                for (uint8_t sm = 0; sm < sim_ship->module_count; sm++) {
                    if (sim_ship->modules[sm].type_id != MODULE_TYPE_PLANK)
                        sim_ship->modules[sw++] = sim_ship->modules[sm];
                }
                sim_ship->module_count = sw;
                /* initial_plank_count = 0 so the drain tick never fires */
                sim_ship->initial_plank_count = 0;
                /* Ghost hull HP stored as raw int32, not Q16. */
                sim_ship->hull_health = 60000;
                break;
            }
        }
    }

    /* Ghost ships have infinite spectral ammo */
    ship->infinite_ammo = 1;

    /* Ghost ships do NOT use weapon groups — tick_ghost_ships() fires cannons
     * directly with a custom 90° arc + oscillating sweep AI.
     * Disable all weapon groups so tick_ship_weapon_groups() ignores this ship. */
    for (int co = 0; co < MAX_COMPANIES; co++) {
        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            ship->weapon_groups[co][g].mode = (uint8_t)WEAPON_GROUP_MODE_HALTFIRE;
            ship->weapon_groups[co][g].target_ship_id = 0;
        }
    }

    /* Add 2 bow-facing cannons at the front of the hull.
     * local_rot = PI/2 → barrel_angle = local_rot - PI/2 = 0 (fires forward).
     * IDs 300 and 301 are reserved for ghost bow cannons (won't conflict with
     * sequential IDs 0–11 or hardcoded plank IDs 100–109 / deck ID 200). */
    if (ship->module_count + 2 <= MAX_MODULES_PER_SHIP) {
        /* Bow port cannon (ID 300) */
        ship->modules[ship->module_count].id          = 300;
        ship->modules[ship->module_count].type_id     = MODULE_TYPE_CANNON;
        ship->modules[ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
        ship->modules[ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(22.0f));
        ship->modules[ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
        ship->modules[ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
        ship->modules[ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
        ship->modules[ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
        ship->module_count++;

        /* Bow starboard cannon (ID 301) */
        ship->modules[ship->module_count].id          = 301;
        ship->modules[ship->module_count].type_id     = MODULE_TYPE_CANNON;
        ship->modules[ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
        ship->modules[ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-22.0f));
        ship->modules[ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
        ship->modules[ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
        ship->modules[ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
        ship->modules[ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
        ship->module_count++;
    }

    /* Mirror bow cannons (300, 301) into the sim ship so the game-state
     * broadcast (which serialises ship->modules[] on the sim ship) sends them
     * to the client.  Without this they would exist only in SimpleShip and
     * never appear on screen. */
    if (global_sim) {
        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
            if (global_sim->ships[si].id != ship_id) continue;
            struct Ship* sim_ship = &global_sim->ships[si];
            if (sim_ship->module_count + 2 <= MAX_MODULES_PER_SHIP) {
                /* Bow port cannon (ID 300) */
                sim_ship->modules[sim_ship->module_count].id          = 300;
                sim_ship->modules[sim_ship->module_count].type_id     = MODULE_TYPE_CANNON;
                sim_ship->modules[sim_ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
                sim_ship->modules[sim_ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(22.0f));
                sim_ship->modules[sim_ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
                sim_ship->modules[sim_ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
                sim_ship->modules[sim_ship->module_count].health      = 100;
                sim_ship->modules[sim_ship->module_count].max_health  = 100;
                sim_ship->modules[sim_ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
                sim_ship->modules[sim_ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
                sim_ship->module_count++;

                /* Bow starboard cannon (ID 301) */
                sim_ship->modules[sim_ship->module_count].id          = 301;
                sim_ship->modules[sim_ship->module_count].type_id     = MODULE_TYPE_CANNON;
                sim_ship->modules[sim_ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
                sim_ship->modules[sim_ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-22.0f));
                sim_ship->modules[sim_ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
                sim_ship->modules[sim_ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
                sim_ship->modules[sim_ship->module_count].health      = 100;
                sim_ship->modules[sim_ship->module_count].max_health  = 100;
                sim_ship->modules[sim_ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
                sim_ship->modules[sim_ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
                sim_ship->module_count++;
            }
            break;
        }
    }

    /* Spawn a helmsman NPC agent so the ship steers itself.
     * The helmsman uses the MODULE_TYPE_HELM to turn. */
    ShipModule* helm = NULL;
    for (int m = 0; m < ship->module_count; m++) {
        if (ship->modules[m].type_id == MODULE_TYPE_HELM ||
            ship->modules[m].type_id == MODULE_TYPE_STEERING_WHEEL) {
            helm = &ship->modules[m];
            break;
        }
    }
    if (helm) {
        uint16_t npc_id = websocket_server_create_npc(ship_id, helm->id, NPC_ROLE_HELMSMAN);
        (void)npc_id;  /* we don't need to track it separately */
    }

    log_info("👻 Phantom Brig spawned (ID: %u) at (%.0f, %.0f)", ship_id, x, y);
    return ship_id;
}

/* ============================================================================
 * GHOST SHIP AI  —  tick_ghost_ships(dt)
 *
 *  Called every server tick (after tick_sinking_ships).
 *  For each active SHIP_TYPE_GHOST ship:
 *    1. Scan enemy ships within GHOST_ATTACK_RANGE client-px.
 *    2. If target found: steer toward it + set all TARGETFIRE groups on it.
 *    3. If no target: wander (change heading every GHOST_WANDER_INTERVAL_MS ms).
 *    4. Apply thrust forward (ghost ships accelerate under their own spectral
 *       power — we write directly to velocity like the helmsman AI does).
 *
 *  Per-ship wander timer is stored in `ship->active_aim_angle` re-purposed as
 *  a float wander_timer (slightly hacky but avoids a struct change).  When in
 *  attack mode we do NOT touch it, so on loss-of-target the wander resumes.
 * ========================================================================= */

/* Maximum distance (client pixels) to scan for an enemy.
 * ~800 px ≈ 4-5 ship lengths — about half a screen width at normal zoom. */
#define GHOST_ATTACK_RANGE      2400.0f
/* Wander: new random heading every N seconds */
#define GHOST_WANDER_INTERVAL_S 5.0f
/* Top speed (client-px / s) while chasing — a bit slower than a player ship */
#define GHOST_CHASE_SPEED       20.0f  /* slow, eerie drifting pursuit */
/* Idle drift speed (client-px / s) */
#define GHOST_WANDER_SPEED      10.0f  /* very slow spectral drift */
/* Turn rate (rad / s) — slightly sluggish on purpose */
#define GHOST_TURN_RATE         2.0f   /* rad/s — very agile, feels supernatural */
/* Slow spin rate added every tick while wandering — makes the brig spiral/spiral */
#define GHOST_SPIN_RATE         1.0f   /* rad/s — roughly 1 full rotation per 6 s */
/* Per-ghost wander timer array indexed by ship slot.  Initialised to 0.
 * Value = seconds remaining until next heading change.  When it hits 0 we
 * pick a new heading and reset. */
static float ghost_wander_timer[MAX_SIMPLE_SHIPS] = {0};
static float ghost_desired_heading[MAX_SIMPLE_SHIPS] = {0};
/* Oscillating sweeping aim phase (radians, accumulates over time) */
static float ghost_aim_phase[MAX_SIMPLE_SHIPS] = {0};

void tick_ghost_ships(float dt) {
    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active) continue;
        if (ship->ship_type != SHIP_TYPE_GHOST) continue;
        if (ship->is_sinking) continue;

        /* ── 1. Find nearest enemy (COMPANY_PIRATES or any non-NAVY ship) ── */
        SimpleShip* target = NULL;
        float best_dist2   = GHOST_ATTACK_RANGE * GHOST_ATTACK_RANGE;

        for (int t = 0; t < ship_count; t++) {
            if (t == s) continue;
            SimpleShip* cand = &ships[t];
            if (!cand->active || cand->is_sinking) continue;
            if (is_allied(ship->company_id, cand->company_id)) continue; /* skip friendly */

            float dx = cand->x - ship->x;
            float dy = cand->y - ship->y;
            float d2 = dx * dx + dy * dy;
            if (d2 < best_dist2) {
                best_dist2 = d2;
                target     = cand;
            }
        }

        /* ── 2. Steer and configure weapons ─────────────────────────────── */
        float desired_heading;
        float move_speed;

        if (target) {
            /* Attack mode — head toward the target ship */
            float dx      = target->x - ship->x;
            float dy      = target->y - ship->y;
            /* Body sway: oscillate the ship heading so it weaves while chasing */
            ghost_aim_phase[s] += GHOST_SWEEP_RATE * dt;
            float phase_sin = sinf(ghost_aim_phase[s]);
            desired_heading = atan2f(dy, dx) + phase_sin * GHOST_HEADING_SWING;
            move_speed      = GHOST_CHASE_SPEED;

            /* Find the sim ship once — reload state lives in sim modules, not
             * SimpleShip modules (SimpleShip copy is reset by fire_cannon but
             * never re-incremented; only the sim reload loop increments it). */
            struct Ship* ghost_sim = find_sim_ship(ship->ship_id);

            for (int m = 0; m < ship->module_count; m++) {
                ShipModule* cannon = &ship->modules[m];
                if (cannon->type_id != MODULE_TYPE_CANNON) continue;

                /* Aim each cannon independently at the target.  desired_aim_direction
                 * is the offset from the cannon's natural direction (local_rot - π/2).
                 * The function clamps to ±45°; if the target is outside that arc the
                 * turret parks at the limit and the fire gate below blocks firing. */
                ghost_aim_cannon(ship, cannon, target->x, target->y);

                /* Find matching sim module by position (ID schemes differ between
                 * SimpleShip and sim ship — position is always identical). */
                ShipModule* sim_cannon = NULL;
                if (ghost_sim) {
                    float cx = Q16_TO_FLOAT(cannon->local_pos.x);
                    float cy = Q16_TO_FLOAT(cannon->local_pos.y);
                    for (uint8_t sm = 0; sm < ghost_sim->module_count; sm++) {
                        if (ghost_sim->modules[sm].type_id != MODULE_TYPE_CANNON) continue;
                        float sx = Q16_TO_FLOAT(ghost_sim->modules[sm].local_pos.x);
                        float sy = Q16_TO_FLOAT(ghost_sim->modules[sm].local_pos.y);
                        float d2 = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy);
                        if (d2 < 0.01f) { sim_cannon = &ghost_sim->modules[sm]; break; }
                    }
                }
                uint32_t tsf  = sim_cannon ? sim_cannon->data.cannon.time_since_fire
                                           : cannon->data.cannon.time_since_fire;
                uint32_t trel = sim_cannon ? sim_cannon->data.cannon.reload_time
                                           : cannon->data.cannon.reload_time;

                /* Fire when reloaded AND the barrel is actually pointing within
                 * ±30° of the target (gives the turret time to track without
                 * bursting instantly; also naturally rejects out-of-arc targets
                 * because the turret parks at ±45° and fire_diff stays large). */
                if (tsf >= trel) {
                    float actual_aim = sim_cannon
                        ? Q16_TO_FLOAT(sim_cannon->data.cannon.aim_direction)
                        : Q16_TO_FLOAT(cannon->data.cannon.aim_direction);
                    float wfa = ship->rotation
                        + Q16_TO_FLOAT(cannon->local_rot) - (float)(M_PI / 2.0f)
                        + actual_aim;
                    float fire_diff = wfa - atan2f(dy, dx);
                    while (fire_diff >  (float)M_PI) fire_diff -= 2.0f * (float)M_PI;
                    while (fire_diff < -(float)M_PI) fire_diff += 2.0f * (float)M_PI;
                    if (fabsf(fire_diff) < (float)(M_PI / 6.0f)) { /* ±30° fire gate */
                        fire_cannon(ship, cannon, NULL, false, PROJ_TYPE_CANNONBALL);
                        if (sim_cannon) sim_cannon->data.cannon.time_since_fire = 0;
                    }
                }
            }
        } else {
            /* Wander mode — pick a new random heading every 5-8 s and drift
             * slowly toward it.  Uses the wander timer + a stable per-ship seed
             * so each ghost wanders independently without a shared rand() state. */
            ghost_wander_timer[s] -= dt;
            if (ghost_wander_timer[s] <= 0.0f) {
                /* Cheap deterministic pseudo-random: mix ship index with a
                 * counter scaled by current heading to get varied offsets. */
                static uint32_t wander_seed = 0x9e3779b9u;
                wander_seed ^= (uint32_t)(s * 2654435761u) ^ (uint32_t)(ghost_aim_phase[s] * 1000.0f);
                wander_seed = wander_seed * 1664525u + 1013904223u; /* LCG */
                /* Turn ±PI from current heading for an organic wandering arc */
                float turn_offset = ((float)(wander_seed & 0xFFFFu) / 65535.0f) * 2.0f * (float)M_PI
                                    - (float)M_PI;
                ghost_desired_heading[s] = ghost_desired_heading[s] + turn_offset * 0.65f;
                while (ghost_desired_heading[s] >  (float)M_PI) ghost_desired_heading[s] -= 2.0f * (float)M_PI;
                while (ghost_desired_heading[s] < -(float)M_PI) ghost_desired_heading[s] += 2.0f * (float)M_PI;
                /* Next heading change in 5–8 s */
                wander_seed = wander_seed * 1664525u + 1013904223u;
                ghost_wander_timer[s] = 5.0f + ((float)(wander_seed & 0xFFFFu) / 65535.0f) * 3.0f;
            }
            desired_heading = ghost_desired_heading[s];
            move_speed      = GHOST_WANDER_SPEED;
        }

        /* Store in ship slot for rendering-side debug convenience */
        ghost_desired_heading[s] = desired_heading;

        /* ── 3. Apply rotation (same pattern as NPC_ROLE_HELMSMAN) ────────── */
        float diff = desired_heading - ship->rotation;
        while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
        while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;

        float turn = diff;
        if (turn >  GHOST_TURN_RATE * dt) turn =  GHOST_TURN_RATE * dt;
        if (turn < -GHOST_TURN_RATE * dt) turn = -GHOST_TURN_RATE * dt;
        ship->rotation += turn;

        /* Normalise rotation to -PI..PI */
        while (ship->rotation >  (float)M_PI) ship->rotation -= 2.0f * (float)M_PI;
        while (ship->rotation < -(float)M_PI) ship->rotation += 2.0f * (float)M_PI;

        /* Mirror rotation into the physics simulation */
        {
            struct Ship* _gs = find_sim_ship(ship->ship_id);
            if (_gs) _gs->rotation = Q16_FROM_FLOAT(ship->rotation);
        }

        /* ── 4. Apply forward thrust (ghost ships ignore normal sail physics) ── */
        float thrust_x = cosf(ship->rotation) * move_speed;
        float thrust_y = sinf(ship->rotation) * move_speed;

        /* Smooth approach to desired velocity (soft cap) */
        const float ACCEL_RATE = 0.08f; /* blend factor per tick */
        ship->velocity_x += (thrust_x - ship->velocity_x) * ACCEL_RATE;
        ship->velocity_y += (thrust_y - ship->velocity_y) * ACCEL_RATE;

        /* Mirror velocity into sim */
        {
            struct Ship* _gs = find_sim_ship(ship->ship_id);
            if (_gs) {
                _gs->velocity.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ship->velocity_x));
                _gs->velocity.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ship->velocity_y));
            }
        }
    }
}

/* ── Wreck auto-despawn ───────────────────────────────────────────────────
 * Called every tick.  Removes STRUCT_WRECK entries whose expiry time has
 * passed, broadcasting a wreck_removed message for each.                */
void tick_wrecks(void) {
    uint32_t now = get_time_ms();
    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *w = &placed_structures[i];
        if (!w->active || w->type != STRUCT_WRECK) continue;
        if (w->wreck_expires_ms != 0 && now >= w->wreck_expires_ms) {
            w->active = false;
            char bcast[64];
            snprintf(bcast, sizeof(bcast),
                     "{\"type\":\"wreck_removed\",\"id\":%u}", (unsigned)w->id);
            websocket_server_broadcast(bcast);
            log_info("🪵 Wreck %u expired and was removed", (unsigned)w->id);
        }
    }
}

