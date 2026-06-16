#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <json-c/json.h>
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
#include "core/rng.h"

/* RNG used for fleet-size and level rolls in the ghost spawn system. */
static struct RNGState ghost_spawn_rng;

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
            players[pi].deck_level          = 1; /* reset so next boarding starts upper deck */
            players[pi].local_x             = 0.0f; /* clear stale ship-local coords */
            players[pi].local_y             = 0.0f;
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

        /* Remove NpcAgents belonging to this ship (compacts the array in-place) */
        for (int ai = 0; ai < npc_count; ) {
            if (npc_agents[ai].ship_id == (uint16_t)sunk_id) {
                /* Clear MODULE_STATE_OCCUPIED on the module the agent held */
                SimpleShip* _as = find_ship(npc_agents[ai].ship_id);
                if (_as) {
                    ShipModule* _am = find_module_by_id(_as, npc_agents[ai].module_id);
                    if (_am) _am->state_bits &= ~MODULE_STATE_OCCUPIED;
                }
                memmove(&npc_agents[ai], &npc_agents[ai + 1],
                        (size_t)(npc_count - ai - 1) * sizeof(NpcAgent));
                npc_count--;
            } else {
                ai++;
            }
        }

        /* ── Kill XP: award the killer ship on ghost ship despawn ─────────────
         * Formula: 100 × ghost_level so higher-level ghosts give more XP.
         * Allied ships within 2000 client units also receive 50% of that XP. */
        if (sunk_company == COMPANY_GHOST) {
            uint16_t killer_id = ship->killer_ship_id;
            if (killer_id != 0) {
                struct Ship* killer_sim = find_sim_ship(killer_id);
                SimpleShip* killer_ss   = find_ship(killer_id);
                if (killer_sim && killer_ss) {
                    uint32_t kill_xp = 100u * (uint32_t)(sunk_level > 0 ? sunk_level : 1u);
                    killer_sim->level_stats.xp += kill_xp;
                    log_info("⚓ Ghost ship %u (lvl %u) sunk by ship %u — awarded %u kill XP",
                             sunk_id, (unsigned)sunk_level, (unsigned)killer_id, kill_xp);

                    /* Notify killer ship's clients */
                    {
                        char _xmsg[128];
                        float _kx = SERVER_TO_CLIENT(killer_ss->x);
                        float _ky = SERVER_TO_CLIENT(killer_ss->y);
                        snprintf(_xmsg, sizeof(_xmsg),
                            "{\"type\":\"ship_xp_gained\",\"shipId\":%u,\"xp\":%u,\"x\":%.1f,\"y\":%.1f,\"shared\":false}",
                            (unsigned)killer_id, kill_xp, _kx, _ky);
                        websocket_server_broadcast(_xmsg);
                    }

                    /* Share 50% with allied ships within 2000 client units (200 srv units) */
                    const float SHARE_RANGE2 = 200.0f * 200.0f;
                    uint32_t share_xp = kill_xp / 2u;
                    for (int _si = 0; _si < ship_count; _si++) {
                        SimpleShip* ally = &ships[_si];
                        if (!ally->active) continue;
                        if (ally->ship_id == killer_id) continue;
                        if (ally->company_id == COMPANY_GHOST) continue;
                        if (!is_allied(ally->company_id, killer_ss->company_id)) continue;
                        float _dx = ally->x - killer_ss->x;
                        float _dy = ally->y - killer_ss->y;
                        if (_dx * _dx + _dy * _dy > SHARE_RANGE2) continue;
                        struct Ship* ally_sim = find_sim_ship(ally->ship_id);
                        if (!ally_sim) continue;
                        ally_sim->level_stats.xp += share_xp;
                        log_info("⚓ Allied ship %u received %u shared kill XP from ghost %u kill",
                                 (unsigned)ally->ship_id, share_xp, sunk_id);

                        /* Notify allied ship's clients */
                        {
                            char _axmsg[128];
                            float _ax = SERVER_TO_CLIENT(ally->x);
                            float _ay = SERVER_TO_CLIENT(ally->y);
                            snprintf(_axmsg, sizeof(_axmsg),
                                "{\"type\":\"ship_xp_gained\",\"shipId\":%u,\"xp\":%u,\"x\":%.1f,\"y\":%.1f,\"shared\":true}",
                                (unsigned)ally->ship_id, share_xp, _ax, _ay);
                            websocket_server_broadcast(_axmsg);
                        }
                    }
                }
            }
        }

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

/* Forward declaration — defined in the spawn-point section below. */
static int find_ship_slot(uint16_t ship_id);

/* Maximum distance (client pixels) to scan for an enemy.
 * ~800 px ≈ 4-5 ship lengths — about half a screen width at normal zoom. */
#define GHOST_ATTACK_RANGE      2400.0f
#define GHOST_WAKE_RADIUS       6000.0f  /* non-ghost must be closer than this to wake ghost AI */
/* Wander: new random heading every N seconds */
#define GHOST_WANDER_INTERVAL_S 5.0f

/* ── Ghost ship auto-spawner / AI culling ──────────────────────────────────── */
/* Max simultaneous ghost ships in the world */
#define GHOST_MAX_POPULATION       150
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
/* Timestamp (ms) of the last combat event (damage dealt or received) for each ghost slot.
 * Used to de-aggro a forced target that has left range with no combat for 30 s. */
static uint32_t ghost_last_combat_ms[MAX_SIMPLE_SHIPS] = {0};
/* De-aggro timeout: forced target is cleared if target has been out of GHOST_ATTACK_RANGE
 * for longer than this with no damage exchanged. */
#define GHOST_DEAGGRO_MS  30000u

/* Radius within which an alerted ghost propagates its target to idle fleet-mates */
#define GHOST_PACK_ALERT_RADIUS  3000.0f

/* ── Ghost ship level + fleet tracking ───────────────────────────────────── *
 * Level 1–10 scales chase speed (+15%/level) and wander speed.              *
 * spawn_idx: index into ghost_spawns[] that created this ship, -1 = manual.
 * fleet_idx: index into ghost_fleets[], -1 if not in a fleet.
 * fleet_role: 0 = fleet lead, 1+ = follower (formation slot index).         */
static int ghost_ship_level[MAX_SIMPLE_SHIPS];
static int ghost_ship_spawn_idx[MAX_SIMPLE_SHIPS];
static int ghost_ship_fleet_idx[MAX_SIMPLE_SHIPS];
static int ghost_ship_fleet_role[MAX_SIMPLE_SHIPS];

/* ── Ghost fleet table ───────────────────────────────────────────────────── */
#define MAX_GHOST_FLEETS 64
#define MAX_FLEET_SIZE   10

typedef struct {
    int      spawn_idx;
    uint16_t ship_ids[MAX_FLEET_SIZE];
    int      ship_count;
    int      level;
    bool     active;
} GhostFleet;

static GhostFleet ghost_fleets[MAX_GHOST_FLEETS];
static int ghost_fleet_count = 0;

/* ── Spawn queue ─────────────────────────────────────────────────────────── */
/* Zones whose timers have fired are enqueued here instead of being spawned
 * immediately.  The queue drains whenever a free fleet slot exists — either
 * at the top of each tick or the moment a fleet fully sinks.  This prevents
 * the "table full" spam and keeps fleet creation latency smooth. */
#define MAX_SPAWN_QUEUE 128

typedef struct {
    int spawn_idx;
    int fleet_size;
    int level;
} SpawnQueueEntry;

static SpawnQueueEntry spawn_queue[MAX_SPAWN_QUEUE];
static int spawn_queue_head = 0; /* next entry to consume */
static int spawn_queue_tail = 0; /* next slot to insert  */
static int spawn_queue_len  = 0;

/* Wedge formation: local offsets (units of GHOST_FLEET_SPACING).
 * lx = forward axis (positive = ahead), ly = lateral (positive = left).
 *
 *       [0] Lead
 *    [1]   [2]       ← 1 unit behind, ±1 unit lateral
 *  [3]       [4]     ← 2 units behind, ±2 units lateral
 * [5]   [6] [7]  [8] ← 3 units behind
 *           [9]      ← 4 units behind, centred (rearguard)
 */
#define GHOST_FLEET_SPACING 200.0f
static const float fleet_form_lx[MAX_FLEET_SIZE] = { 0, -1, -1, -2, -2, -3, -3, -3, -3, -4 };
static const float fleet_form_ly[MAX_FLEET_SIZE] = { 0,  1, -1,  2, -2,  1, -1,  3, -3,  0 };

/* ── Ghost spawn-point table ─────────────────────────────────────────────── */
#define MAX_GHOST_SPAWNS 64
#define GHOST_SPAWNS_PATH "data/ghost_spawns.json"

typedef struct {
    int   id;
    char  label[64];
    float x, y;
    float radius;
    int   level_min, level_max;
    int   count_min, count_max;
    float respawn_delay_s;
    /* runtime */
    int   active_count;
    float respawn_timer;
    bool  enabled;
} GhostSpawnPoint;

static GhostSpawnPoint ghost_spawns[MAX_GHOST_SPAWNS];
static int ghost_spawn_count = 0;
static bool ghost_spawns_enabled = false;
/* Global cap: maximum total ghost ships across ALL zones (0 = unlimited). */
static int ghost_global_max_cap = 0;

void tick_ghost_ships(float dt) {
    /* ── Global fast-path: skip all AI when no non-ghost ships are alive.
     * This keeps the server idle when no players are connected. */
    bool any_non_ghost = false;
    for (int s = 0; s < ship_count; s++) {
        SimpleShip *c = &ships[s];
        if (c->active && !c->is_sinking && c->ship_type != SHIP_TYPE_GHOST) {
            any_non_ghost = true;
            break;
        }
    }
    if (!any_non_ghost) return;

    for (int s = 0; s < ship_count; s++) {
        SimpleShip* ship = &ships[s];
        if (!ship->active) continue;
        if (ship->ship_type != SHIP_TYPE_GHOST) continue;
        if (ship->is_sinking) continue;

        /* ── AI culling: skip processing when no player is within render range ──
         * Render distance is approximately 5000 client px; we add 2000 px buffer
         * so ghosts begin reacting before they enter the player's view. */
        {
            const float AI_RANGE2 = GHOST_AI_PLAYER_RANGE * GHOST_AI_PLAYER_RANGE;
            bool player_nearby = false;
            for (int pi = 0; pi < WS_MAX_CLIENTS && !player_nearby; pi++) {
                if (!players[pi].active) continue;
                float px, py;
                if (players[pi].parent_ship_id != 0) {
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
         * of normal attack range; clear once the target is gone or de-aggro fires. */
        if (ghost_forced_target[s] != 0) {
            SimpleShip* ft = find_ship(ghost_forced_target[s]);
            if (ft && ft->active && !ft->is_sinking && !is_allied(ship->company_id, ft->company_id)) {
                float ftdx = ft->x - ship->x, ftdy = ft->y - ship->y;
                float ft_dist2 = ftdx * ftdx + ftdy * ftdy;
                float ar2 = GHOST_ATTACK_RANGE * GHOST_ATTACK_RANGE;

                if (ft_dist2 <= ar2) {
                    /* Target is in range — keep aggro and refresh combat timer */
                    ghost_last_combat_ms[s] = get_time_ms();
                    target = ft;
                } else {
                    /* Target out of range — check de-aggro timeout */
                    uint32_t now = get_time_ms();
                    if (ghost_last_combat_ms[s] == 0)
                        ghost_last_combat_ms[s] = now; /* first tick out of range */
                    if (now - ghost_last_combat_ms[s] >= GHOST_DEAGGRO_MS) {
                        /* 30 s out of range with no combat — drop aggro */
                        ghost_forced_target[s]  = 0;
                        ghost_last_combat_ms[s] = 0;
                    } else {
                        target = ft; /* still chasing, haven't timed out yet */
                    }
                }
            } else {
                ghost_forced_target[s]  = 0; /* target gone — fall through to range scan */
                ghost_last_combat_ms[s] = 0;
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
            {
                float lvl_scale = 1.0f + (ghost_ship_level[s] - 1) * 0.15f;
                move_speed = GHOST_CHASE_SPEED * lvl_scale;
            }

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
            /* Wander mode — fleet followers hold formation; lead ships wander. */
            int fi   = ghost_ship_fleet_idx[s];
            int role = ghost_ship_fleet_role[s];
            bool in_formation = false;

            if (fi >= 0 && role > 0 && ghost_fleets[fi].active) {
                uint16_t lead_id   = ghost_fleets[fi].ship_ids[0];
                int      lead_slot = find_ship_slot(lead_id);
                if (lead_slot >= 0 && ships[lead_slot].active && !ships[lead_slot].is_sinking) {
                    SimpleShip *lead = &ships[lead_slot];
                    int ri = (role < MAX_FLEET_SIZE) ? role : (MAX_FLEET_SIZE - 1);
                    float local_fwd = fleet_form_lx[ri] * GHOST_FLEET_SPACING;
                    float local_lat = fleet_form_ly[ri] * GHOST_FLEET_SPACING;
                    float cos_h = cosf(lead->rotation);
                    float sin_h = sinf(lead->rotation);
                    float form_x = lead->x + local_fwd * cos_h - local_lat * sin_h;
                    float form_y = lead->y + local_fwd * sin_h + local_lat * cos_h;
                    float dx = form_x - ship->x;
                    float dy = form_y - ship->y;
                    float dist = sqrtf(dx * dx + dy * dy);
                    float lvl_scale = 1.0f + (ghost_ship_level[s] - 1) * 0.10f;
                    if (dist > GHOST_FLEET_SPACING * 0.4f) {
                        desired_heading = atan2f(dy, dx);
                        float catch_up  = 1.0f + dist / GHOST_FLEET_SPACING;
                        move_speed = fminf(GHOST_WANDER_SPEED * lvl_scale * catch_up,
                                           GHOST_CHASE_SPEED  * lvl_scale);
                    } else {
                        desired_heading = lead->rotation;
                        move_speed = GHOST_WANDER_SPEED * lvl_scale;
                    }
                    in_formation = true;
                }
            }

            if (!in_formation) {
                ghost_wander_timer[s] -= dt;
                if (ghost_wander_timer[s] <= 0.0f) {
                    static uint32_t wander_seed = 0x9e3779b9u;
                    wander_seed ^= (uint32_t)(s * 2654435761u) ^ (uint32_t)(ghost_sway_phase[s] * 1000.0f);
                    wander_seed = wander_seed * 1664525u + 1013904223u;
                    float turn_offset = ((float)(wander_seed & 0xFFFFu) / 65535.0f) * 2.0f * (float)M_PI
                                        - (float)M_PI;
                    ghost_desired_heading[s] = ghost_desired_heading[s] + turn_offset * 0.65f;
                    while (ghost_desired_heading[s] >  (float)M_PI) ghost_desired_heading[s] -= 2.0f * (float)M_PI;
                    while (ghost_desired_heading[s] < -(float)M_PI) ghost_desired_heading[s] += 2.0f * (float)M_PI;
                    wander_seed = wander_seed * 1664525u + 1013904223u;
                    ghost_wander_timer[s] = 5.0f + ((float)(wander_seed & 0xFFFFu) / 65535.0f) * 3.0f;
                }
                desired_heading = ghost_desired_heading[s];
                float lvl_scale = 1.0f + (ghost_ship_level[s] - 1) * 0.10f;
                move_speed = GHOST_WANDER_SPEED * lvl_scale;
            }
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
            ghost_forced_target[s]  = attacker_ship_id;
            ghost_last_combat_ms[s] = get_time_ms(); /* damage received — reset de-aggro clock */
            return;
        }
    }
}

/* ── Dealt-damage notification ────────────────────────────────────────────────
 * Called whenever a ghost ship projectile hits its current forced target so the
 * de-aggro timer is reset (ghost is actively fighting — don't drop aggro). */
void ghost_notify_dealt_damage(uint32_t attacker_ship_id) {
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active && ships[s].ship_id == attacker_ship_id &&
            ships[s].ship_type == SHIP_TYPE_GHOST) {
            ghost_last_combat_ms[s] = get_time_ms();
            return;
        }
    }
}

/* ── Ghost spawn points: see load_ghost_spawns / tick_ghost_spawn_points ─── */

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

/* ============================================================================
 * GHOST SPAWN-POINT SYSTEM
 * ============================================================================ */

/* Helper: find ship slot index (0-based) by ship_id. Returns -1 if not found. */
static int find_ship_slot(uint16_t ship_id) {
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active && ships[i].ship_id == ship_id) return i;
    }
    return -1;
}

/* load_ghost_spawns — parse data/ghost_spawns.json at startup.
 * Also initialises the per-ship parallel arrays. */
void load_ghost_spawns(const char *path) {
    /* Seed the spawn RNG from wall-clock time so each server run gives
     * different level/fleet-size rolls. */
    rng_seed(&ghost_spawn_rng, (uint32_t)get_time_ms() ^ 0xDEADBEEFu);

    /* Initialise per-ship tracking arrays */
    for (int i = 0; i < MAX_SIMPLE_SHIPS; i++) {
        ghost_ship_level[i]     = 1;
        ghost_ship_spawn_idx[i] = -1;
        ghost_ship_fleet_idx[i] = -1;
        ghost_ship_fleet_role[i] = 0;
    }
    /* Initialise fleet table */
    memset(ghost_fleets, 0, sizeof(ghost_fleets));
    ghost_fleet_count    = 0;
    ghost_spawn_count    = 0;
    ghost_spawns_enabled = false;
    ghost_global_max_cap = 0;   /* reset so the file value always wins */

    /* Reset spawn queue */
    spawn_queue_head = 0;
    spawn_queue_tail = 0;
    spawn_queue_len  = 0;

    if (!path) path = GHOST_SPAWNS_PATH;

    json_object *root = json_object_from_file(path);
    if (!root) {
        log_warn("ghost_spawns: could not load '%s' — ghost ships disabled", path);
        return;
    }

    json_object *j_enabled;
    if (json_object_object_get_ex(root, "enabled", &j_enabled))
        ghost_spawns_enabled = json_object_get_boolean(j_enabled);

    json_object *j_cap;
    if (json_object_object_get_ex(root, "global_max_cap", &j_cap))
        ghost_global_max_cap = json_object_get_int(j_cap);
    if (ghost_global_max_cap < 0) ghost_global_max_cap = 0;

    json_object *arr;
    if (!json_object_object_get_ex(root, "spawns", &arr) ||
        !json_object_is_type(arr, json_type_array)) {
        log_warn("ghost_spawns: no 'spawns' array in '%s'", path);
        json_object_put(root);
        return;
    }

    int n = json_object_array_length(arr);
    for (int i = 0; i < n && ghost_spawn_count < MAX_GHOST_SPAWNS; i++) {
        json_object *e = json_object_array_get_idx(arr, i);
        GhostSpawnPoint *sp = &ghost_spawns[ghost_spawn_count];
        memset(sp, 0, sizeof(*sp));
        sp->enabled = true;

        json_object *jv;
        if (json_object_object_get_ex(e, "id",              &jv)) sp->id              = json_object_get_int(jv);
        if (json_object_object_get_ex(e, "label",           &jv)) snprintf(sp->label, sizeof(sp->label), "%s", json_object_get_string(jv));
        if (json_object_object_get_ex(e, "x",               &jv)) sp->x               = (float)json_object_get_double(jv);
        if (json_object_object_get_ex(e, "y",               &jv)) sp->y               = (float)json_object_get_double(jv);
        if (json_object_object_get_ex(e, "radius",          &jv)) sp->radius          = (float)json_object_get_double(jv);
        if (json_object_object_get_ex(e, "level_min",       &jv)) sp->level_min       = json_object_get_int(jv);
        if (json_object_object_get_ex(e, "level_max",       &jv)) sp->level_max       = json_object_get_int(jv);
        if (json_object_object_get_ex(e, "count_min",       &jv)) sp->count_min       = json_object_get_int(jv);
        if (json_object_object_get_ex(e, "count_max",       &jv)) sp->count_max       = json_object_get_int(jv);
        if (json_object_object_get_ex(e, "respawn_delay_s", &jv)) sp->respawn_delay_s = (float)json_object_get_double(jv);

        /* Clamp */
        if (sp->level_min < 1)  sp->level_min = 1;
        if (sp->level_max < sp->level_min) sp->level_max = sp->level_min;
        if (sp->level_max > 60) sp->level_max = 60;
        if (sp->count_min < 0) sp->count_min = 0;
        if (sp->count_max < sp->count_min) sp->count_max = sp->count_min;
        if (sp->respawn_delay_s <= 0.0f) sp->respawn_delay_s = 60.0f;
        if (sp->radius <= 0.0f) sp->radius = 2000.0f;

        sp->active_count = 0;
        sp->respawn_timer = 0.0f;
        ghost_spawn_count++;
    }

    json_object_put(root);
    log_info("👻 ghost_spawns: loaded %d spawn point(s), enabled=%s",
             ghost_spawn_count, ghost_spawns_enabled ? "true" : "false");
}

/* websocket_server_create_ghost_ship_level — level-scaled ghost ship creation.
 * level 1–60 scales speed and hull HP.  spawn_idx = index into ghost_spawns[] (or -1). */
uint32_t websocket_server_create_ghost_ship_level(float x, float y, int level, int spawn_idx) {
    if (level < 1)  level = 1;
    if (level > 60) level = 60;

    uint32_t ship_id = websocket_server_create_ghost_ship(x, y, (uint8_t)level);
    if (!ship_id) return 0;

    int slot = find_ship_slot((uint16_t)ship_id);
    if (slot >= 0) {
        ghost_ship_level[slot]     = level;
        ghost_ship_spawn_idx[slot] = spawn_idx;
    }
    return ship_id;
}

/* Forward declarations: ghost_ship_sunk uses these, which are defined later */
static void enqueue_spawn(int spawn_idx, int fleet_size, int level);
static bool try_drain_spawn_queue(void);

/* ghost_ship_sunk — call this when a ghost ship completes its sink animation.
 * Frees the spawn-point slot, updates fleet membership, and starts the
 * respawn timer when the fleet has fully sunk. */
void ghost_ship_sunk(uint16_t ship_id) {
    int slot = find_ship_slot(ship_id);
    if (slot < 0) return;

    int sp_idx = ghost_ship_spawn_idx[slot];
    int fi     = ghost_ship_fleet_idx[slot];

    /* ── Decrement spawn-zone count ── */
    if (sp_idx >= 0 && sp_idx < ghost_spawn_count) {
        GhostSpawnPoint *sp = &ghost_spawns[sp_idx];
        if (sp->active_count > 0) sp->active_count--;
    }

    /* ── Remove from fleet, promote if lead ── */
    if (fi >= 0 && fi < MAX_GHOST_FLEETS && ghost_fleets[fi].active) {
        GhostFleet *fleet = &ghost_fleets[fi];
        for (int i = 0; i < fleet->ship_count; i++) {
            if (fleet->ship_ids[i] != ship_id) continue;
            /* Shift the rest down; re-assign roles */
            for (int j = i; j < fleet->ship_count - 1; j++) {
                fleet->ship_ids[j] = fleet->ship_ids[j + 1];
                int sh = find_ship_slot(fleet->ship_ids[j]);
                if (sh >= 0) ghost_ship_fleet_role[sh] = j; /* j is new index */
            }
            fleet->ship_count--;
            break;
        }
        if (fleet->ship_count == 0) {
            fleet->active = false;
            /* Start respawn timer now that the whole fleet is gone */
            if (sp_idx >= 0 && sp_idx < ghost_spawn_count) {
                GhostSpawnPoint *sp = &ghost_spawns[sp_idx];
                if (sp->active_count < sp->count_min && sp->respawn_timer <= 0.0f)
                    sp->respawn_timer = sp->respawn_delay_s;
            }
            /* Fleet slot freed — immediately try to spawn a queued fleet */
            try_drain_spawn_queue();
        }
    } else {
        /* Manual / unfleeted ship — start timer immediately */
        if (sp_idx >= 0 && sp_idx < ghost_spawn_count) {
            GhostSpawnPoint *sp = &ghost_spawns[sp_idx];
            if (sp->active_count < sp->count_min && sp->respawn_timer <= 0.0f)
                sp->respawn_timer = sp->respawn_delay_s;
        }
    }

    ghost_ship_spawn_idx[slot]  = -1;
    ghost_ship_fleet_idx[slot]  = -1;
    ghost_ship_fleet_role[slot] = 0;
    ghost_ship_level[slot]      = 1;
}

/* spawn_ghost_fleet — create a full fleet at once in a wedge formation.
 * fleet_size ships are spawned; the lead ship is placed at the zone centre
 * (with slight scatter) and followers are offset in the wedge pattern.
 * All ships share the same level and fleet slot. */
static void spawn_ghost_fleet(int spawn_idx, int fleet_size, int level) {
    GhostSpawnPoint *spn = &ghost_spawns[spawn_idx];

    /* Find a free fleet slot */
    int fi = -1;
    for (int i = 0; i < ghost_fleet_count; i++) {
        if (!ghost_fleets[i].active) { fi = i; break; }
    }
    if (fi < 0) {
        if (ghost_fleet_count >= MAX_GHOST_FLEETS) {
            /* Should not happen — callers check for a free slot first.
             * Re-enqueue so the spawn retries when a slot frees up. */
            enqueue_spawn(spawn_idx, fleet_size, level);
            return;
        }
        fi = ghost_fleet_count++;
    }

    GhostFleet *fleet = &ghost_fleets[fi];
    memset(fleet, 0, sizeof(*fleet));
    fleet->spawn_idx  = spawn_idx;
    fleet->level      = level;
    fleet->active     = true;

    if (fleet_size > MAX_FLEET_SIZE) fleet_size = MAX_FLEET_SIZE;
    if (fleet_size < 1)              fleet_size = 1;

    /* Fleet initial heading — random direction */
    float heading = rng_float(&ghost_spawn_rng) * 2.0f * (float)M_PI;
    float cos_h   = cosf(heading);
    float sin_h   = sinf(heading);

    /* Lead position: zone centre + small scatter */
    float scatter = spn->radius * 0.25f;
    float angle   = rng_float(&ghost_spawn_rng) * 2.0f * (float)M_PI;
    float lead_x  = spn->x + cosf(angle) * scatter;
    float lead_y  = spn->y + sinf(angle) * scatter;

    for (int i = 0; i < fleet_size; i++) {
        float local_fwd = fleet_form_lx[i] * GHOST_FLEET_SPACING;
        float local_lat = fleet_form_ly[i] * GHOST_FLEET_SPACING;
        float sx = lead_x + local_fwd * cos_h - local_lat * sin_h;
        float sy = lead_y + local_fwd * sin_h + local_lat * cos_h;

        uint32_t ship_id = websocket_server_create_ghost_ship_level(sx, sy, level, spawn_idx);
        if (!ship_id) {
            log_warn("spawn_ghost_fleet: failed to create ship %d/%d", i + 1, fleet_size);
            break;
        }

        fleet->ship_ids[fleet->ship_count] = (uint16_t)ship_id;

        int slot = find_ship_slot((uint16_t)ship_id);
        if (slot >= 0) {
            ghost_ship_fleet_idx[slot]  = fi;
            ghost_ship_fleet_role[slot] = fleet->ship_count; /* 0 = lead */
            /* Initialise wander heading to the fleet heading */
            ghost_desired_heading[slot] = heading;
        }

        fleet->ship_count++;
        spn->active_count++;
    }

    log_info("👻 Spawn zone %d (%s): fleet %d — %d×Lv%d ghost ship(s) in wedge at (%.0f,%.0f)",
             spn->id, spn->label, fi, fleet->ship_count, level, lead_x, lead_y);
}

/* ── Spawn queue helpers ─────────────────────────────────────────────────── */

static int count_global_active_ghosts(void) {
    int n = 0;
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active && ships[s].ship_type == SHIP_TYPE_GHOST && !ships[s].is_sinking)
            n++;
    }
    return n;
}

static bool spawn_zone_in_queue(int spawn_idx) {
    int i = spawn_queue_head;
    for (int n = 0; n < spawn_queue_len; n++) {
        if (spawn_queue[i].spawn_idx == spawn_idx) return true;
        i = (i + 1) % MAX_SPAWN_QUEUE;
    }
    return false;
}

static void enqueue_spawn(int spawn_idx, int fleet_size, int level) {
    if (spawn_queue_len >= MAX_SPAWN_QUEUE) return; /* silently drop — very unlikely */
    spawn_queue[spawn_queue_tail].spawn_idx  = spawn_idx;
    spawn_queue[spawn_queue_tail].fleet_size = fleet_size;
    spawn_queue[spawn_queue_tail].level      = level;
    spawn_queue_tail = (spawn_queue_tail + 1) % MAX_SPAWN_QUEUE;
    spawn_queue_len++;
}

/* Attempt to spawn the oldest queued fleet entry.
 * Returns true when a spawn was issued so callers can loop until empty. */
static bool try_drain_spawn_queue(void) {
    if (spawn_queue_len == 0) return false;

    /* Need a free fleet slot */
    bool has_slot = false;
    for (int i = 0; i < ghost_fleet_count; i++) {
        if (!ghost_fleets[i].active) { has_slot = true; break; }
    }
    if (!has_slot && ghost_fleet_count >= MAX_GHOST_FLEETS) return false;

    int global_active = count_global_active_ghosts();
    if (ghost_global_max_cap > 0 && global_active >= ghost_global_max_cap) return false;

    SpawnQueueEntry e = spawn_queue[spawn_queue_head];
    spawn_queue_head  = (spawn_queue_head + 1) % MAX_SPAWN_QUEUE;
    spawn_queue_len--;

    int fleet_size = e.fleet_size;
    if (ghost_global_max_cap > 0) {
        int headroom = ghost_global_max_cap - global_active;
        if (headroom <= 0) return false;
        if (fleet_size > headroom) fleet_size = headroom;
    }

    spawn_ghost_fleet(e.spawn_idx, fleet_size, e.level);
    return true;
}

/* tick_ghost_spawn_points — called each server tick.
 * Counts active ghost ships per spawn point and spawns a fresh fleet when
 * the zone is clear (active_count == 0) and the respawn timer expires. */
void tick_ghost_spawn_points(float dt) {
    if (!ghost_spawns_enabled || ghost_spawn_count == 0) return;

    /* Recount active ships for each spawn zone and the global total */
    for (int sp = 0; sp < ghost_spawn_count; sp++)
        ghost_spawns[sp].active_count = 0;

    int global_active = 0;
    for (int s = 0; s < ship_count; s++) {
        if (!ships[s].active || ships[s].ship_type != SHIP_TYPE_GHOST) continue;
        if (ships[s].is_sinking) continue;
        global_active++;
        int sp_idx = ghost_ship_spawn_idx[s];
        if (sp_idx >= 0 && sp_idx < ghost_spawn_count)
            ghost_spawns[sp_idx].active_count++;
    }

    for (int sp = 0; sp < ghost_spawn_count; sp++) {
        GhostSpawnPoint *spn = &ghost_spawns[sp];
        if (!spn->enabled) continue;

        /* Zone must be fully clear before a new fleet spawns */
        if (spn->active_count > 0) {
            spn->respawn_timer = 0.0f;
            continue;
        }

        /* Don't enqueue the same zone twice */
        if (spawn_zone_in_queue(sp)) continue;

        /* Count down respawn timer */
        if (spn->respawn_timer > 0.0f) {
            spn->respawn_timer -= dt;
            if (spn->respawn_timer > 0.0f) continue;
            spn->respawn_timer = 0.0f;
        }

        /* Respect the global cap — stop queuing when already at limit */
        if (ghost_global_max_cap > 0 && global_active >= ghost_global_max_cap) break;

        /* Roll fleet size in [count_min, count_max] and a single level for
         * the whole fleet in [level_min, level_max].
         * Use the dedicated RNG so every zone/respawn gets a truly different
         * value instead of the float-precision-collapsed get_time_ms() hack
         * (which made all zones that spawn in the same tick use level_min). */
        int fleet_size = (int)rng_range(&ghost_spawn_rng,
                                        (uint32_t)spn->count_min,
                                        (uint32_t)spn->count_max);
        int lvl        = (int)rng_range(&ghost_spawn_rng,
                                        (uint32_t)spn->level_min,
                                        (uint32_t)spn->level_max);

        if (fleet_size < 1) fleet_size = 1;

        if (ghost_global_max_cap > 0) {
            int headroom = ghost_global_max_cap - global_active;
            if (headroom <= 0) break;
            if (fleet_size > headroom) fleet_size = headroom;
        }

        global_active += fleet_size; /* optimistic accounting for subsequent zones */
        enqueue_spawn(sp, fleet_size, lvl);
    }

    /* Immediately drain newly queued entries if slots are available */
    while (try_drain_spawn_queue())
        ;
}

/* ghost_spawns_to_json — serialise the spawn-point config to JSON.
 * Returns bytes written (excluding NUL), or -1 on truncation. */
int ghost_spawns_to_json(char *buf, size_t buf_size) {
    /* Count live ghost ships for the status field */
    int live_total = 0;
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active && ships[s].ship_type == SHIP_TYPE_GHOST && !ships[s].is_sinking)
            live_total++;
    }
    int pos = 0;
    pos += snprintf(buf + pos, buf_size - pos,
                    "{\"enabled\":%s,\"global_max_cap\":%d,\"active_total\":%d,\"spawns\":[",
                    ghost_spawns_enabled ? "true" : "false",
                    ghost_global_max_cap,
                    live_total);
    for (int i = 0; i < ghost_spawn_count; i++) {
        GhostSpawnPoint *sp = &ghost_spawns[i];
        if (i > 0) pos += snprintf(buf + pos, buf_size - pos, ",");
        pos += snprintf(buf + pos, buf_size - pos,
            "{\"id\":%d,\"label\":\"%s\","
            "\"x\":%.1f,\"y\":%.1f,\"radius\":%.1f,"
            "\"level_min\":%d,\"level_max\":%d,"
            "\"count_min\":%d,\"count_max\":%d,"
            "\"respawn_delay_s\":%.1f,"
            "\"active_count\":%d}",
            sp->id, sp->label,
            sp->x, sp->y, sp->radius,
            sp->level_min, sp->level_max,
            sp->count_min, sp->count_max,
            sp->respawn_delay_s,
            sp->active_count);
        if (pos >= (int)buf_size - 4) return -1;
    }
    pos += snprintf(buf + pos, buf_size - pos, "]}");
    return pos;
}
