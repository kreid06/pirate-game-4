#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdbool.h>
#define _USE_MATH_DEFINES
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include "net/websocket_server_internal.h"
#include "net/ship_init.h"
#include "net/cannon_fire.h"
#include "../../../protocol/ship_definitions.h"
#include "net/module_interactions.h"
#include "sim/ship_level.h"
#include "net/quality.h"

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
        uint8_t sunk_company = ship->company_id;
        uint8_t sunk_level   = ship->npc_level ? ship->npc_level : 1;

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
            /* Shared RNG for loot + blueprint rolls */
            uint32_t rng = (uint32_t)(get_time_ms() ^ (sunk_id * 2654435761u) ^ 0xB17EC0DEu);

            /* -- Build loot: ammo only (blueprints carry the module drops) -- */
            uint8_t l_items[6] = {0};
            uint8_t l_qtys[6]  = {0};
            int     l_count    = 0;

            /* Cannonballs: 3–12 */
            uint8_t ball_qty = (uint8_t)(3 + (int)(quality_rand_unit(&rng) * 10.0f));
            l_items[l_count] = (uint8_t)ITEM_CANNON_BALL;
            l_qtys[l_count]  = ball_qty;
            l_count++;

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

            /* ── Ghost ships also drop 2-6 quality blueprints (ship modules only) ──
             * Quality is rolled ONCE here from the ghost's level; every craft
             * from the blueprint is identical (see docs/LOOT_QUALITY_SYSTEM.md). */
            w->wreck_bp_count = 0;
            if (sunk_company == COMPANY_GHOST) {
                static const ItemKind BP_POOL[] = {
                    ITEM_CANNON, ITEM_SWIVEL,
                    ITEM_SAIL, ITEM_PLANK, ITEM_DECK, ITEM_HELM, ITEM_WOODEN_FLOOR,
                    ITEM_WALL, ITEM_WOOD_CEILING, ITEM_DOOR, ITEM_FLAG_FORT, ITEM_SHIPYARD,
                };
                const int BP_POOL_N = (int)(sizeof(BP_POOL) / sizeof(BP_POOL[0]));
                int bp_n = 2 + (int)(quality_rand_unit(&rng) * 5.0f);   /* 2..6 */
                if (bp_n > 6) bp_n = 6;
                for (int bi = 0; bi < bp_n; bi++) {
                    ItemKind it = BP_POOL[(int)(quality_rand_unit(&rng) * BP_POOL_N) % BP_POOL_N];
                    float    q  = quality_roll_from_ghost_level(sunk_level, &rng);
                    w->wreck_bp_items[bi]  = (uint8_t)it;
                    /* Crafts = MaxCrafts * (rand + 0.25), clamped to [1, MaxCrafts] */
                    uint8_t mc     = quality_item_max_crafts(it);
                    float   factor = quality_rand_unit(&rng) + 0.25f;
                    if (factor > 1.0f) factor = 1.0f;
                    uint8_t bc = (uint8_t)((float)mc * factor);
                    if (bc < 1) bc = 1;
                    w->wreck_bp_crafts[bi] = bc;
                    quality_roll_payload(it, q, &rng, &w->wreck_bp_quality[bi]);
                }
                w->wreck_bp_count = (uint8_t)bp_n;
            }
            strncpy(w->placer_name, "shipwreck", sizeof(w->placer_name) - 1);
            placed_structure_count++;

            /* Best loot tier among the dropped blueprints (-1 = none) — used by
             * clients to color the salvage glint. */
            int wreck_tier = -1;
            for (int bi = 0; bi < w->wreck_bp_count; bi++) {
                if (w->wreck_bp_items[bi] == 0) continue;
                int t = quality_tier(quality_from_q8(w->wreck_bp_quality[bi].quality_q8));
                if (t > wreck_tier) wreck_tier = t;
            }

            /* Broadcast so clients can render the wreck */
            char wbcast[256];
            snprintf(wbcast, sizeof(wbcast),
                "{\"type\":\"wreck_spawned\",\"id\":%u,\"x\":%.1f,\"y\":%.1f,"
                "\"loot_count\":%u,\"bp_count\":%u,\"wreck_tier\":%d,\"expires_ms\":%u}",
                (unsigned)w->id, wx, wy,
                (unsigned)l_count, (unsigned)w->wreck_bp_count, wreck_tier,
                (unsigned)w->wreck_expires_ms);
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
    /* Default names for the first 4 groups — match the auto-assign sectors */
    static const char* DEFAULT_GROUP_NAMES[MAX_WEAPON_GROUPS] = {
        "Port", "Starboard", "Stern", "Bow", "", "", "", "", "", ""
    };

    /* Reset all groups to HALTFIRE with no cannons */
    for (int co = 0; co < MAX_COMPANIES; co++) {
        for (int g = 0; g < MAX_WEAPON_GROUPS; g++) {
            ship->weapon_groups[co][g].mode            = (uint8_t)WEAPON_GROUP_MODE_HALTFIRE;
            ship->weapon_groups[co][g].weapon_count    = 0;
            ship->weapon_groups[co][g].target_ship_id  = 0;
            strncpy(ship->weapon_groups[co][g].name,
                    DEFAULT_GROUP_NAMES[g],
                    sizeof(ship->weapon_groups[co][g].name) - 1);
            ship->weapon_groups[co][g].name[sizeof(ship->weapon_groups[co][g].name) - 1] = '\0';
        }
    }

    /* Partition cannons: port (local_y > 0) → group 0 (Port), starboard → group 1 (Starboard).
     * Apply to ALL company slots so that any company boarding the ship starts
     * with a sensible default layout. */
    for (int co = 0; co < MAX_COMPANIES; co++) {
        for (int m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_CANNON) continue;

            float local_y = Q16_TO_FLOAT(mod->local_pos.y);
            int   target_group = (local_y > 0.0f) ? 0 : 1;
            WeaponGroup* grp = &ship->weapon_groups[co][target_group];
            if (grp->weapon_count < MAX_WEAPONS_PER_GROUP) {
                grp->weapon_ids[grp->weapon_count++] = mod->id;
            }
        }
    }

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

    s->base_mass        = BRIGANTINE_MASS;
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
    s->modules[s->module_count].deck_id     = 0xFF; /* deck-independent — matches sim layer */
    s->module_count++;

    /* Bare skeleton — hull geometry only, no modules at all. */
    if (modules_placed == 0) {
        ship_init_default_weapon_groups(s);
        return;
    }

    /* Helm — offset 0x02 */
    s->modules[s->module_count].id              = MID(ship_seq, MODULE_OFFSET_HELM);
    s->modules[s->module_count].type_id         = MODULE_TYPE_HELM;
    s->modules[s->module_count].local_pos.x     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f));
    s->modules[s->module_count].local_pos.y     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f));
    s->modules[s->module_count].local_rot       = Q16_FROM_FLOAT(0.0f);
    s->modules[s->module_count].state_bits      = MODULE_STATE_ACTIVE;
    s->modules[s->module_count].health          = 10000;
    s->modules[s->module_count].target_health   = 10000;
    s->modules[s->module_count].max_health      = 10000;
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
            s->modules[s->module_count].data.cannon.gunport_snap_idx = 0xFF; // not linked to a gunport
            s->modules[s->module_count].data.cannon.reload_time    = CANNON_RELOAD_TIME_MS;
            s->modules[s->module_count].data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS;
            s->modules[s->module_count].deck_id = 1; /* top deck */
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
        s->modules[s->module_count].deck_id     = 0xFF; /* deck-independent — spans all decks */
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

    return sim_id;
}

/* Ghost cannon arc — ±90 degrees (much wider than normal 30°) */
#define GHOST_CANNON_ARC    (90.0f * (float)(M_PI / 180.0))
/* Body sway: sinusoidal oscillation frequency and amplitude */
#define GHOST_SWAY_RATE     0.25f   /* rad/s frequency (~25 s per full cycle) */
#define GHOST_SWAY_AMP      0.5236f /* ±30° sway amplitude */
/* Angular velocity PD controller — drives smooth, force-based turning */
#define GHOST_TURN_KP       4.0f    /* spring gain (proportional) */
#define GHOST_TURN_KD       3.0f    /* damping gain (derivative) */
#define GHOST_MAX_ANG_VEL   0.6f    /* max angular velocity rad/s — prevents hard snaps */
/* Top speed (client-px/s).  Ghost ships bypass sail physics and set velocity
 * directly; reduced to feel sluggish/haunting rather than supernaturally fast. */
#define GHOST_CHASE_SPEED   150.0f  /* chasing speed — half the previous 300 */
#define GHOST_WANDER_SPEED   50.0f  /* idle drift speed */
/* Slow spin rate added every tick while wandering */
#define GHOST_SPIN_RATE      1.0f   /* rad/s — roughly 1 full rotation per 6 s */

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
uint32_t websocket_server_create_ghost_ship(float x, float y, uint8_t level) {
    if (level < 1)  level = 1;
    if (level > 60) level = 60;
    uint16_t ship_id = websocket_server_create_ship(x, y, COMPANY_GHOST, 0xFF);
    if (ship_id == 0) return 0;

    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return ship_id;

    /* Tag as ghost and store level */
    ship->ship_type = SHIP_TYPE_GHOST;
    ship->npc_level = level;

    /* Ghost ships have no physical planks — hull damage is tracked directly via
     * hull_health in simulation.c (7 HP per cannonball hit, heals 1 HP/s).
     * Strip all plank modules from both SimpleShip and sim ship so the plank
     * drain logic never runs and the hit path goes through the ghost entry point. */
    {
        /* Strip planks, decks, and masts from SimpleShip — only cannons stay functional */
        int write = 0;
        for (int m = 0; m < ship->module_count; m++) {
            if (ship->modules[m].type_id != MODULE_TYPE_PLANK
                && ship->modules[m].type_id != MODULE_TYPE_DECK
                && ship->modules[m].type_id != MODULE_TYPE_MAST)
                ship->modules[write++] = ship->modules[m];
        }
        ship->module_count = write;

        /* Strip planks and decks from sim ship — KEEP masts so the client
         * receives them in GAME_STATE and renders the spectral phantom sails. */
        if (global_sim) {
            for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                if (global_sim->ships[si].id != ship_id) continue;
                struct Ship* sim_ship = &global_sim->ships[si];
                uint8_t sw = 0;
                for (uint8_t sm = 0; sm < sim_ship->module_count; sm++) {
                    if (sim_ship->modules[sm].type_id != MODULE_TYPE_PLANK
                        && sim_ship->modules[sm].type_id != MODULE_TYPE_DECK)
                        sim_ship->modules[sw++] = sim_ship->modules[sm];
                }
                sim_ship->module_count = sw;
                /* Ghost masts are fully deployed visually — set openness to 100 so
                 * the phantom sail renderer gets full-open geometry, and pin
                 * desired_sail_openness so the gradual-adjust loop keeps them there. */
                sim_ship->desired_sail_openness = 100;
                for (uint8_t _gm = 0; _gm < sim_ship->module_count; _gm++) {
                    if (sim_ship->modules[_gm].type_id == MODULE_TYPE_MAST)
                        sim_ship->modules[_gm].data.mast.openness = 100;
                }
                /* initial_plank_count = 0 so the drain tick never fires */
                sim_ship->initial_plank_count = 0;
                /* Ghost hull HP scaled by level:
                 * level  1 = 60 000 HP (1×), level 60 = 600 000 HP (10×)
                 * formula: 60000 * (1 + (level-1) * 9/59) */
                float hp_mult = 1.0f + (level - 1) * 9.0f / 59.0f;
                int32_t scaled_hp = (int32_t)(60000.0f * hp_mult);
                sim_ship->ghost_max_hull_hp = scaled_hp;
                sim_ship->hull_health = scaled_hp;
                /* Mark sim ship as ghost company so the hull-drain/heal and
                 * damage code paths use ghost-specific logic (company_id == 99). */
                sim_ship->company_id = COMPANY_GHOST;
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
     * IDs use MID(ship_seq, DYNAMIC_BASE) and MID(ship_seq, DYNAMIC_BASE+1) so
     * each ghost ship gets unique cannon IDs — no collisions when many ghosts exist. */
    uint16_t bow_port_mid = MID(ship->ship_seq, MODULE_OFFSET_DYNAMIC_BASE);
    uint16_t bow_stbd_mid = MID(ship->ship_seq, MODULE_OFFSET_DYNAMIC_BASE + 1u);
    if (ship->module_count + 2 <= MAX_MODULES_PER_SHIP) {
        /* Bow port cannon */
        ship->modules[ship->module_count].id          = bow_port_mid;
        ship->modules[ship->module_count].type_id     = MODULE_TYPE_CANNON;
        ship->modules[ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
        ship->modules[ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(22.0f));
        ship->modules[ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
        ship->modules[ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
        ship->modules[ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.gunport_snap_idx      = 0xFF; // not linked to a gunport
        ship->modules[ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
        ship->modules[ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
        ship->modules[ship->module_count].deck_id                           = 1; /* upper deck */
        ship->module_count++;

        /* Bow starboard cannon */
        ship->modules[ship->module_count].id          = bow_stbd_mid;
        ship->modules[ship->module_count].type_id     = MODULE_TYPE_CANNON;
        ship->modules[ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
        ship->modules[ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-22.0f));
        ship->modules[ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
        ship->modules[ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
        ship->modules[ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
        ship->modules[ship->module_count].data.cannon.gunport_snap_idx      = 0xFF; // not linked to a gunport
        ship->modules[ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
        ship->modules[ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
        ship->modules[ship->module_count].deck_id                           = 1; /* upper deck */
        ship->module_count++;
    }

    /* Mirror bow cannons into the sim ship so the game-state broadcast
     * (which serialises sim_ship->modules[]) sends them to the client.
     * Without this they would exist only in SimpleShip and never appear on screen. */
    if (global_sim) {
        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
            if (global_sim->ships[si].id != ship_id) continue;
            struct Ship* sim_ship = &global_sim->ships[si];
            if (sim_ship->module_count + 2 <= MAX_MODULES_PER_SHIP) {
                /* Bow port cannon */
                sim_ship->modules[sim_ship->module_count].id          = bow_port_mid;
                sim_ship->modules[sim_ship->module_count].type_id     = MODULE_TYPE_CANNON;
                sim_ship->modules[sim_ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
                sim_ship->modules[sim_ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(22.0f));
                sim_ship->modules[sim_ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
                sim_ship->modules[sim_ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
                sim_ship->modules[sim_ship->module_count].health      = 100;
                sim_ship->modules[sim_ship->module_count].max_health  = 100;
                sim_ship->modules[sim_ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.gunport_snap_idx      = 0xFF; // not linked to a gunport
                sim_ship->modules[sim_ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
                sim_ship->modules[sim_ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
                sim_ship->modules[sim_ship->module_count].deck_id                           = 1; /* upper deck */
                sim_ship->module_count++;

                /* Bow starboard cannon */
                sim_ship->modules[sim_ship->module_count].id          = bow_stbd_mid;
                sim_ship->modules[sim_ship->module_count].type_id     = MODULE_TYPE_CANNON;
                sim_ship->modules[sim_ship->module_count].local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(210.0f));
                sim_ship->modules[sim_ship->module_count].local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-22.0f));
                sim_ship->modules[sim_ship->module_count].local_rot   = Q16_FROM_FLOAT((float)M_PI / 2.0f);
                sim_ship->modules[sim_ship->module_count].state_bits  = MODULE_STATE_ACTIVE;
                sim_ship->modules[sim_ship->module_count].health      = 100;
                sim_ship->modules[sim_ship->module_count].max_health  = 100;
                sim_ship->modules[sim_ship->module_count].data.cannon.aim_direction         = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
                sim_ship->modules[sim_ship->module_count].data.cannon.gunport_snap_idx      = 0xFF; // not linked to a gunport
                sim_ship->modules[sim_ship->module_count].data.cannon.reload_time           = CANNON_RELOAD_TIME_MS;
                sim_ship->modules[sim_ship->module_count].data.cannon.time_since_fire       = CANNON_RELOAD_TIME_MS;
                sim_ship->modules[sim_ship->module_count].deck_id                           = 1; /* upper deck */
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

/* Maximum distance (client pixels) to scan for an enemy. */
#define GHOST_ATTACK_RANGE      2400.0f
/* Wander: new random heading every N seconds */
#define GHOST_WANDER_INTERVAL_S 5.0f

/* ── Ghost ship auto-spawner / AI culling ──────────────────────────────────── */
/* Max simultaneous ghost ships in the world */
#define GHOST_MAX_POPULATION       100
/* Minimum distance from any island edge (client px) for a valid spawn point */
#define GHOST_MIN_ISLAND_DIST      2500.0f
/* AI skipped if no player is within this distance. */
#define GHOST_AI_PLAYER_RANGE      7000.0f
/* Spawner fires at most once per this interval (seconds) */
#define GHOST_SPAWN_INTERVAL_S     5.0f
/* Attempts per spawner firing before giving up */
#define GHOST_SPAWN_MAX_ATTEMPTS   30
/* Per-ghost wander timer array indexed by ship slot. */
static float ghost_wander_timer[MAX_SIMPLE_SHIPS] = {0};
static float ghost_desired_heading[MAX_SIMPLE_SHIPS] = {0};
/* Sway phase (radians, accumulates each tick) — drives the ±30° sinusoidal oscillation */
static float ghost_sway_phase[MAX_SIMPLE_SHIPS] = {0};
/* Angular velocity state for the PD-controller smooth turning */
static float ghost_angular_vel[MAX_SIMPLE_SHIPS] = {0};
/* Forced aggro target (ship_id) set by damage events or pack-alert; 0 = none */
static uint32_t ghost_forced_target[MAX_SIMPLE_SHIPS] = {0};

/* Radius within which an alerted ghost propagates its target to idle fleet-mates */
#define GHOST_PACK_ALERT_RADIUS  3000.0f

void tick_ghost_ships(float dt) {
    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active) continue;
        if (ship->ship_type != SHIP_TYPE_GHOST) continue;
        if (ship->is_sinking) continue;

        /* ── AI culling: skip processing when no player is within render range ──
         * Render distance is approximately 5000 client px; we add 500 px tolerance
         * so ghosts begin reacting slightly before they enter the player's view. */
        {
            const float AI_RANGE2 = GHOST_AI_PLAYER_RANGE * GHOST_AI_PLAYER_RANGE;
            bool player_nearby = false;
            for (int pi = 0; pi < WS_MAX_CLIENTS && !player_nearby; pi++) {
                if (!players[pi].active) continue;
                float px, py;
                if (players[pi].parent_ship_id != 0) {
                    /* Player is aboard a ship — use the ship's world position.
                     * Fall back to player's own coords if ship lookup fails
                     * (stale parent_ship_id after a sink event). */
                    SimpleShip* ps = find_ship(players[pi].parent_ship_id);
                    if (ps) { px = ps->x; py = ps->y; }
                    else    { px = players[pi].x; py = players[pi].y; }
                } else {
                    px = players[pi].x; py = players[pi].y;
                }
                float dx = px - ship->x, dy = py - ship->y;
                if (dx * dx + dy * dy <= AI_RANGE2) player_nearby = true;
            }
            if (!player_nearby) {
                /* No player in range — freeze the ghost in place by zeroing velocity
                 * so it doesn't drift from momentum when culled. */
                ship->velocity_x = 0.0f;
                ship->velocity_y = 0.0f;
                struct Ship* _gs = find_sim_ship(ship->ship_id);
                if (_gs) { _gs->velocity.x = 0; _gs->velocity.y = 0; }
                continue;
            }
        }

        /* ── 1. Resolve target (forced aggro takes priority over range scan) ── */
        SimpleShip* target = NULL;

        /* Forced target: set by damage events or pack-alert.  Pursue regardless
         * of normal attack range; clear once the target is gone. */
        if (ghost_forced_target[s] != 0) {
            SimpleShip* ft = find_ship(ghost_forced_target[s]);
            if (ft && ft->active && !ft->is_sinking && !is_allied(ship->company_id, ft->company_id)) {
                target = ft;
            } else {
                ghost_forced_target[s] = 0; /* target gone — fall through to range scan */
            }
        }

        /* Normal attack-range scan (only if no forced target) */
        if (!target) {
            float best_dist2 = GHOST_ATTACK_RANGE * GHOST_ATTACK_RANGE;
            for (int t = 0; t < ship_count; t++) {
                if (t == s) continue;
                SimpleShip* cand = &ships[t];
                if (!cand->active || cand->is_sinking) continue;
                if (is_allied(ship->company_id, cand->company_id)) continue;
                float dx = cand->x - ship->x;
                float dy = cand->y - ship->y;
                float d2 = dx * dx + dy * dy;
                if (d2 < best_dist2) { best_dist2 = d2; target = cand; }
            }
        }

        /* ── Pack aggro: if this ghost has a target, alert nearby idle ghosts ── */
        if (target) {
            const float PACK_R2 = GHOST_PACK_ALERT_RADIUS * GHOST_PACK_ALERT_RADIUS;
            for (int t = 0; t < ship_count; t++) {
                if (t == s) continue;
                SimpleShip* ally = &ships[t];
                if (!ally->active || ally->is_sinking) continue;
                if (ally->ship_type != SHIP_TYPE_GHOST) continue;
                if (ghost_forced_target[t] != 0) continue; /* already has forced target */
                /* Check if ally already has a natural target in range */
                bool ally_has_target = false;
                float ar2 = GHOST_ATTACK_RANGE * GHOST_ATTACK_RANGE;
                for (int u = 0; u < ship_count && !ally_has_target; u++) {
                    if (u == t) continue;
                    SimpleShip* c = &ships[u];
                    if (!c->active || c->is_sinking) continue;
                    if (is_allied(ally->company_id, c->company_id)) continue;
                    float dx2 = c->x - ally->x, dy2 = c->y - ally->y;
                    if (dx2*dx2 + dy2*dy2 < ar2) ally_has_target = true;
                }
                if (ally_has_target) continue;
                /* Alert if within pack radius */
                float adx = ally->x - ship->x, ady = ally->y - ship->y;
                if (adx*adx + ady*ady <= PACK_R2)
                    ghost_forced_target[t] = target->ship_id;
            }
        }

        /* ── 2. Steer and configure weapons ─────────────────────────────── */
        float desired_heading;
        float move_speed;

        if (target) {
            /* Attack mode — smooth sinusoidal sway ±30° around bearing to target */
            float dx = target->x - ship->x;
            float dy = target->y - ship->y;
            ghost_sway_phase[s] += GHOST_SWAY_RATE * dt;
            float center_heading = atan2f(dy, dx);
            desired_heading = center_heading + sinf(ghost_sway_phase[s]) * GHOST_SWAY_AMP;
            move_speed = GHOST_CHASE_SPEED;

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
                wander_seed ^= (uint32_t)(s * 2654435761u) ^ (uint32_t)(ghost_sway_phase[s] * 1000.0f);
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

        /* ── 3. Smooth angular velocity using a PD spring controller ──────────
         * This replaces the old hard-clamped turn rate with a force-based
         * approach: angular acceleration proportional to heading error (spring)
         * minus damping proportional to current angular velocity.  The result is
         * a smooth, continuous sway with no hard snapping. */
        float diff = desired_heading - ship->rotation;
        while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
        while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;

        float angular_accel = GHOST_TURN_KP * diff - GHOST_TURN_KD * ghost_angular_vel[s];
        ghost_angular_vel[s] += angular_accel * dt;
        if (ghost_angular_vel[s] >  GHOST_MAX_ANG_VEL) ghost_angular_vel[s] =  GHOST_MAX_ANG_VEL;
        if (ghost_angular_vel[s] < -GHOST_MAX_ANG_VEL) ghost_angular_vel[s] = -GHOST_MAX_ANG_VEL;
        ship->rotation += ghost_angular_vel[s] * dt;

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

        /* Gentle LERP toward desired velocity — matches reduced speed feel. */
        const float ACCEL_RATE = 0.07f;
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

/* ── Damage aggro notification ───────────────────────────────────────────────
 * Called from the hit-event loop in websocket_server.c whenever a ghost ship
 * takes hull damage.  Forces the ghost to pursue the attacker even if outside
 * normal GHOST_ATTACK_RANGE. */
void ghost_notify_damaged(uint32_t victim_ship_id, uint32_t attacker_ship_id) {
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active && ships[s].ship_id == victim_ship_id &&
            ships[s].ship_type == SHIP_TYPE_GHOST) {
            ghost_forced_target[s] = attacker_ship_id;
            return;
        }
    }
}

/* ── Ghost fleet spawn points ─────────────────────────────────────────────── */

GhostSpawnPoint ghost_spawn_points[MAX_GHOST_SPAWN_POINTS];
int             ghost_spawn_point_count = 0;

/* Per-ship-slot spawn-point tag.
 * ghost_spawn_tags[slot] == spawn_point_id means that ship slot belongs to the
 * fleet assigned to that spawn point.  0 = untagged (random / player ship).
 * Because we check ships[s].active, stale entries in dead/reused slots are
 * naturally ignored — no explicit cleanup is required. */
static uint32_t ghost_spawn_tags[MAX_SHIPS];

void ghost_spawns_load(void) {
    FILE *f = fopen(GHOST_SPAWNS_PATH, "r");
    if (!f) {
        log_info("No ghost spawn points file found at %s — starting empty", GHOST_SPAWNS_PATH);
        return;
    }

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0 || sz > 1024 * 1024) { fclose(f); return; }

    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return; }
    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[rd] = '\0';

    /* Simple hand-rolled JSON array parser for:
     * {"spawn_points":[{"id":1,"x":1000,"y":2000,"level":30,"fleet_size":3},...]} */
    ghost_spawn_point_count = 0;
    uint32_t max_id = 0;

    const char *arr = strstr(buf, "\"spawn_points\"");
    if (!arr) { free(buf); return; }
    arr = strchr(arr, '[');
    if (!arr) { free(buf); return; }

    const char *p = arr + 1;
    while (*p && ghost_spawn_point_count < MAX_GHOST_SPAWN_POINTS) {
        /* Skip whitespace */
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',') p++;
        if (*p != '{') break;

        GhostSpawnPoint sp = {0};
        const char *obj_end = strchr(p, '}');
        if (!obj_end) break;

        const char *v;
        v = strstr(p, "\"id\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.id = (uint32_t)atoi(v + 1); }
        v = strstr(p, "\"x\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.x = (float)atof(v + 1); }
        v = strstr(p, "\"y\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.y = (float)atof(v + 1); }

        /* Support both range fields (level_min/level_max) and legacy single field (level) */
        v = strstr(p, "\"level_min\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.level_min = (uint8_t)atoi(v + 1); }
        v = strstr(p, "\"level_max\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.level_max = (uint8_t)atoi(v + 1); }
        if (sp.level_min == 0 && sp.level_max == 0) {
            /* Legacy: single "level" field */
            v = strstr(p, "\"level\"");
            if (v && v < obj_end) {
                v = strchr(v, ':'); if (v) {
                    uint8_t lv = (uint8_t)atoi(v + 1);
                    sp.level_min = sp.level_max = lv;
                }
            }
        }

        v = strstr(p, "\"fleet_min\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.fleet_min = (uint8_t)atoi(v + 1); }
        v = strstr(p, "\"fleet_max\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.fleet_max = (uint8_t)atoi(v + 1); }
        if (sp.fleet_min == 0 && sp.fleet_max == 0) {
            /* Legacy: single "fleet_size" field */
            v = strstr(p, "\"fleet_size\"");
            if (v && v < obj_end) {
                v = strchr(v, ':'); if (v) {
                    uint8_t fs = (uint8_t)atoi(v + 1);
                    sp.fleet_min = sp.fleet_max = fs;
                }
            }
        }

        v = strstr(p, "\"angle_deg\"");
        if (v && v < obj_end) { v = strchr(v, ':'); if (v) sp.angle_deg = (float)atof(v + 1); }

        /* Clamp */
        if (sp.level_min < 1)  sp.level_min = 1;
        if (sp.level_min > 60) sp.level_min = 60;
        if (sp.level_max < sp.level_min) sp.level_max = sp.level_min;
        if (sp.level_max > 60) sp.level_max = 60;
        if (sp.fleet_min < 1)  sp.fleet_min = 1;
        if (sp.fleet_min > 10) sp.fleet_min = 10;
        if (sp.fleet_max < sp.fleet_min) sp.fleet_max = sp.fleet_min;
        if (sp.fleet_max > 10) sp.fleet_max = 10;
        if (sp.angle_deg < 0.0f || sp.angle_deg >= 360.0f)
            sp.angle_deg = fmodf(sp.angle_deg + 360.0f, 360.0f);
        if (sp.id > max_id) max_id = sp.id;

        ghost_spawn_points[ghost_spawn_point_count++] = sp;
        p = obj_end + 1;
    }

    free(buf);
    log_info("Loaded %d ghost fleet spawn point(s) from %s", ghost_spawn_point_count, GHOST_SPAWNS_PATH);
}

void ghost_spawns_save(void) {
    FILE *f = fopen(GHOST_SPAWNS_PATH, "w");
    if (!f) {
        log_error("Failed to open %s for writing", GHOST_SPAWNS_PATH);
        return;
    }

    fprintf(f, "{\n  \"spawn_points\": [\n");
    for (int i = 0; i < ghost_spawn_point_count; i++) {
        const GhostSpawnPoint *sp = &ghost_spawn_points[i];
        fprintf(f,
                "    {\"id\":%u,\"x\":%.1f,\"y\":%.1f"
                ",\"level_min\":%u,\"level_max\":%u"
                ",\"fleet_min\":%u,\"fleet_max\":%u"
                ",\"angle_deg\":%.1f}%s\n",
                sp->id, sp->x, sp->y,
                (unsigned)sp->level_min, (unsigned)sp->level_max,
                (unsigned)sp->fleet_min, (unsigned)sp->fleet_max,
                sp->angle_deg,
                i < ghost_spawn_point_count - 1 ? "," : "");
    }
    fprintf(f, "  ]\n}\n");
    fclose(f);
    log_info("Saved %d ghost fleet spawn point(s) to %s", ghost_spawn_point_count, GHOST_SPAWNS_PATH);
}

/* ── Ghost ship auto-spawner ─────────────────────────────────────────────────
 * If static spawn points are defined (ghost_spawn_point_count > 0), fleets
 * are spawned at those positions whenever the area is vacant.
 * If no spawn points are configured, falls back to random open-water spawning.
 * Called each server tick; internally rate-limited to GHOST_SPAWN_INTERVAL_S.
 */
void tick_ghost_ship_spawner(float dt) {
    static float spawn_timer = 0.0f;
    static uint32_t spawn_rng = 0xdeadbeef;

    spawn_timer -= dt;
    if (spawn_timer > 0.0f) return;
    spawn_timer = GHOST_SPAWN_INTERVAL_S;

    /* Count active ghost ships */
    int ghost_count = 0;
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active && !ships[s].is_sinking &&
            ships[s].ship_type == SHIP_TYPE_GHOST)
            ghost_count++;
    }
    if (ghost_count >= GHOST_MAX_POPULATION) return;

    /* Don't spawn if the sim is nearly full */
    if (global_sim && (int)global_sim->ship_count >= (MAX_SHIPS - 20)) return;

    /* ── Point-based spawning ──────────────────────────────────────────────── */
    if (ghost_spawn_point_count > 0) {
        for (int pi = 0; pi < ghost_spawn_point_count; pi++) {
            GhostSpawnPoint *sp = &ghost_spawn_points[pi];

            /* A spawn point is occupied as long as ANY ghost ship tagged with
             * this point's id is still active and not sinking.  We don't use
             * a proximity radius — ships roam freely and the fleet is tied to
             * its spawn point by membership, not by location. */
            bool occupied = false;
            for (int s = 0; s < ship_count && !occupied; s++) {
                if (!ships[s].active || ships[s].is_sinking) continue;
                if (ships[s].ship_type != SHIP_TYPE_GHOST)  continue;
                if (ghost_spawn_tags[s] == sp->id)
                    occupied = true;
            }
            if (occupied) continue;

            /* All tagged members are gone — pick a new randomised fleet */
            spawn_rng = spawn_rng * 1664525u + 1013904223u;
            int fleet_range = (int)(sp->fleet_max - sp->fleet_min + 1);
            int fleet_size  = sp->fleet_min + (int)(spawn_rng % (uint32_t)fleet_range);

            /* Cap to global population limit and sim headroom */
            int remaining    = GHOST_MAX_POPULATION - ghost_count;
            int sim_headroom = global_sim ? (MAX_SHIPS - 20 - (int)global_sim->ship_count) : 0;
            if (sim_headroom < remaining) remaining = sim_headroom;
            if (fleet_size > remaining) fleet_size = remaining;
            if (fleet_size <= 0) return;

            /* Formation base angle from the spawn point's configured heading */
            float base_angle = sp->angle_deg * ((float)M_PI / 180.0f);

            for (int fi = 0; fi < fleet_size; fi++) {
                float angle = base_angle + (float)fi * (2.0f * (float)M_PI / (float)fleet_size);
                spawn_rng = spawn_rng * 1664525u + 1013904223u;
                float jitter = (((float)(spawn_rng & 0xFFFFu) / 65535.0f) - 0.5f) * 0.524f;
                angle += jitter;
                spawn_rng = spawn_rng * 1664525u + 1013904223u;
                float radius = 300.0f + ((float)(spawn_rng & 0xFFFFu) / 65535.0f) * 300.0f;
                float sx = sp->x + cosf(angle) * radius;
                float sy = sp->y + sinf(angle) * radius;
                if (sx < 1000.0f) sx = 1000.0f;
                if (sx > MAP_WIDTH  - 1000.0f) sx = MAP_WIDTH  - 1000.0f;
                if (sy < 1000.0f) sy = 1000.0f;
                if (sy > MAP_HEIGHT - 1000.0f) sy = MAP_HEIGHT - 1000.0f;

                /* Each ship in the fleet gets a random level within the range */
                spawn_rng = spawn_rng * 1664525u + 1013904223u;
                int lv_range = (int)(sp->level_max - sp->level_min + 1);
                uint8_t ship_level = sp->level_min + (uint8_t)(spawn_rng % (uint32_t)lv_range);

                uint32_t new_id = websocket_server_create_ghost_ship(sx, sy, ship_level);

                /* Tag the newly created ship slot so we can track fleet membership */
                if (new_id != 0) {
                    for (int s = 0; s < ship_count; s++) {
                        if (ships[s].active && ships[s].ship_id == new_id) {
                            ghost_spawn_tags[s] = sp->id;
                            break;
                        }
                    }
                }
            }
            ghost_count += fleet_size;
            if (ghost_count >= GHOST_MAX_POPULATION) return;
        }
        return;
    }

    /* ── Fallback: random open-water spawning (no spawn points defined) ────── */
    for (int attempt = 0; attempt < GHOST_SPAWN_MAX_ATTEMPTS; attempt++) {
        spawn_rng = spawn_rng * 1664525u + 1013904223u;
        float rx = (float)(spawn_rng & 0xFFFFu) / 65535.0f * MAP_WIDTH;
        spawn_rng = spawn_rng * 1664525u + 1013904223u;
        float ry = (float)(spawn_rng & 0xFFFFu) / 65535.0f * MAP_HEIGHT;

        bool too_close = false;
        for (int ii = 0; ii < ISLAND_COUNT && !too_close; ii++) {
            const IslandDef* isl = &ISLAND_PRESETS[ii];
            float dx = rx - isl->x;
            float dy = ry - isl->y;
            float dist = sqrtf(dx * dx + dy * dy);
            float island_edge = isl->beach_radius_px + isl->beach_max_bump;
            if (dist < island_edge + GHOST_MIN_ISLAND_DIST)
                too_close = true;
        }
        if (too_close) continue;

        if (rx < 1000.0f || rx > MAP_WIDTH  - 1000.0f) continue;
        if (ry < 1000.0f || ry > MAP_HEIGHT - 1000.0f) continue;

        #define GHOST_MIN_PLAYER_DIST 2000.0f
        bool near_player = false;
        for (int ps = 0; ps < ship_count && !near_player; ps++) {
            if (!ships[ps].active || ships[ps].ship_type == SHIP_TYPE_GHOST) continue;
            float pdx = rx - ships[ps].x;
            float pdy = ry - ships[ps].y;
            if (pdx * pdx + pdy * pdy < GHOST_MIN_PLAYER_DIST * GHOST_MIN_PLAYER_DIST)
                near_player = true;
        }
        if (near_player) continue;

        spawn_rng = spawn_rng * 1664525u + 1013904223u;
        uint8_t level = (uint8_t)(1 + (spawn_rng % 60));
        spawn_rng = spawn_rng * 1664525u + 1013904223u;
        int fleet_size = (int)(3 + (spawn_rng % 3));

        int remaining = GHOST_MAX_POPULATION - ghost_count;
        int sim_headroom = global_sim ? (MAX_SHIPS - 20 - (int)global_sim->ship_count) : 0;
        if (sim_headroom < remaining) remaining = sim_headroom;
        if (fleet_size > remaining) fleet_size = remaining;
        if (fleet_size <= 0) return;

        spawn_rng = spawn_rng * 1664525u + 1013904223u;
        float fleet_base_angle = ((float)(spawn_rng & 0xFFFFu) / 65535.0f) * 2.0f * (float)M_PI;

        for (int fi = 0; fi < fleet_size; fi++) {
            float base_angle = fleet_base_angle + (float)fi * (2.0f * (float)M_PI / (float)fleet_size);
            spawn_rng = spawn_rng * 1664525u + 1013904223u;
            float jitter = (((float)(spawn_rng & 0xFFFFu) / 65535.0f) - 0.5f) * 0.524f;
            float angle  = base_angle + jitter;
            spawn_rng = spawn_rng * 1664525u + 1013904223u;
            float radius = 300.0f + ((float)(spawn_rng & 0xFFFFu) / 65535.0f) * 300.0f;
            float sx = rx + cosf(angle) * radius;
            float sy = ry + sinf(angle) * radius;
            if (sx < 1000.0f) sx = 1000.0f;
            if (sx > MAP_WIDTH  - 1000.0f) sx = MAP_WIDTH  - 1000.0f;
            if (sy < 1000.0f) sy = 1000.0f;
            if (sy > MAP_HEIGHT - 1000.0f) sy = MAP_HEIGHT - 1000.0f;
            websocket_server_create_ghost_ship(sx, sy, level);
        }
        return;
    }
}

/* ── Ship Claiming Flag tick ────────────────────────────────────────────────
 * Called each server tick (dt in seconds).
 * - Checks if enemy players/NPCs are on the flagged ship's deck (contested).
 * - If contested: reverses progress at FLAG_REVERSE_SPEED x normal rate.
 * - If uncontested: advances progress normally.
 * - When progress reaches FLAG_CLAIM_DURATION_MS: claim the ship and remove flag.
 * ----------------------------------------------------------------------- */
void tick_claim_flags(float dt) {
    float dt_ms = dt * 1000.0f;

    for (int fi = 0; fi < MAX_CLAIM_FLAGS; fi++) {
        ClaimFlag* flag = &claim_flags[fi];
        if (!flag->active) continue;

        SimpleShip* ship = find_ship(flag->ship_id);
        if (!ship || !ship->active || ship->is_sinking) {
            /* Ship gone — remove flag silently */
            flag->active = false;
            char bcast[80];
            snprintf(bcast, sizeof(bcast),
                "{\"type\":\"flag_removed\",\"shipId\":%u,\"removerId\":0}", (unsigned)flag->ship_id);
            websocket_server_broadcast(bcast);
            continue;
        }

        /* Check contestation: any player or NPC on the ship with a DIFFERENT company */
        bool contested = false;
        for (int pi = 0; pi < MAX_PLAYERS; pi++) {
            WebSocketPlayer* p = &players[pi];
            if (!p->active) continue;
            if (p->parent_ship_id != flag->ship_id) continue;
            if (p->company_id == flag->planter_company) continue; /* friendly */
            contested = true;
            break;
        }
        if (!contested) {
            for (int ni = 0; ni < world_npc_count; ni++) {
                WorldNpc* npc = &world_npcs[ni];
                if (!npc->active) continue;
                if (npc->ship_id != flag->ship_id) continue;
                if (npc->company_id == flag->planter_company) continue; /* friendly */
                contested = true;
                break;
            }
        }
        flag->contested = contested;

        if (contested) {
            /* Reverse at 10x speed */
            flag->progress_ms -= dt_ms * FLAG_REVERSE_SPEED;
            if (flag->progress_ms < 0.0f) flag->progress_ms = 0.0f;
        } else {
            flag->progress_ms += dt_ms;
        }

        /* Broadcast progress update every second (approx) — clients interpolate */
        {
            static uint32_t last_flag_broadcast = 0;
            uint32_t now = get_time_ms();
            if (now - last_flag_broadcast >= 1000) {
                last_flag_broadcast = now;
                char fbcast[192];
                snprintf(fbcast, sizeof(fbcast),
                    "{\"type\":\"flag_update\",\"shipId\":%u,\"planterId\":%u,"
                    "\"planterCompany\":%u,\"progressMs\":%.0f,\"totalMs\":%u,\"contested\":%s}",
                    (unsigned)flag->ship_id, (unsigned)flag->planter_id,
                    (unsigned)flag->planter_company, flag->progress_ms,
                    FLAG_CLAIM_DURATION_MS,
                    flag->contested ? "true" : "false");
                websocket_server_broadcast(fbcast);
            }
        }

        /* Check completion */
        if (flag->progress_ms >= (float)FLAG_CLAIM_DURATION_MS) {
            flag->active = false;

            /* Claim the ship */
            uint8_t prev_company = ship->company_id;
            ship->company_id = flag->planter_company;
            struct Ship* sim_ship = find_sim_ship(flag->ship_id);
            if (sim_ship) sim_ship->company_id = flag->planter_company;

            log_info("🚩 Ship %u captured! Company %u → %u by player %u",
                     flag->ship_id, (unsigned)prev_company,
                     (unsigned)flag->planter_company, (unsigned)flag->planter_id);

            char cbcast[128];
            snprintf(cbcast, sizeof(cbcast),
                "{\"type\":\"ship_claimed\",\"shipId\":%u,\"companyId\":%u}",
                (unsigned)flag->ship_id, (unsigned)flag->planter_company);
            websocket_server_broadcast(cbcast);

            /* Also announce the capture */
            char abcast[160];
            snprintf(abcast, sizeof(abcast),
                "{\"type\":\"flag_capture_complete\",\"shipId\":%u,\"planterCompany\":%u}",
                (unsigned)flag->ship_id, (unsigned)flag->planter_company);
            websocket_server_broadcast(abcast);
        }
    }
}
