#include "sim/simulation.h"
#include "sim/module_types.h"
#include "sim/ship_level.h"
#include "net/protocol.h"
#include "core/hash.h"
#include "core/math.h"
#include "util/log.h"
#include <string.h>
#include <assert.h>
#include <math.h>

// Include hash function implementation
extern uint64_t hash_sim_state(const struct Sim* sim);

// Forward declarations
static void update_ship_physics(struct Ship* ship, q16_t dt);
static void update_player_physics(struct Player* player, struct Sim* sim, q16_t dt);
static void update_projectile_physics(struct Projectile* projectile, q16_t dt);
static void handle_ship_collisions(struct Sim* sim);
static void handle_player_player_collisions(struct Sim* sim);
static entity_id allocate_entity_id(struct Sim* sim);

/**
 * Allocate a new unique entity ID
 */
static entity_id allocate_entity_id(struct Sim* sim) {
    (void)sim; // Mark as intentionally unused
    static entity_id next_id = 1;
    
    // Simple sequential allocation
    // TODO: Add recycling for production use
    entity_id id = next_id++;
    
    // Avoid overflow (entity_id is uint16_t)
    if (next_id == 0) next_id = 1;
    
    return id;
}

int sim_init(struct Sim* sim, const struct SimConfig* config) {
    if (!sim || !config) {
        log_error("Invalid simulation or config parameters");
        return -1;
    }
    
    // Clear all state
    memset(sim, 0, sizeof(struct Sim));
    
    // Initialize RNG with seed
    rng_seed(&sim->rng, config->random_seed);
    
    // Set physics constants
    sim->water_friction = config->water_friction;
    sim->air_friction = config->air_friction;
    sim->buoyancy_factor = config->buoyancy_factor;
    
    // Initialize global wind (default moderate wind)
    sim->wind_power = 0.5f;      // 50% wind power
    sim->wind_direction = 0.0f;  // East direction (for future use)
    
    // Initialize entity counts
    sim->ship_count = 0;
    sim->player_count = 0;
    sim->projectile_count = 0;
    
    // Initialize spatial hash
    memset(sim->spatial_hash, 0, sizeof(sim->spatial_hash));
    
    log_info("Simulation initialized with seed %u", config->random_seed);
    return 0;
}

void sim_cleanup(struct Sim* sim) {
    if (!sim) return;
    
    log_info("📋 Starting simulation cleanup...");
    
    // Log final simulation state
    log_info("Final simulation state:");
    log_info("  Tick: %u", sim->tick);
    log_info("  Ships: %u", sim->ship_count);
    log_info("  Players: %u", sim->player_count);  
    log_info("  Projectiles: %u", sim->projectile_count);
    
    // Reset all counts and state
    memset(sim, 0, sizeof(struct Sim));
    
    log_info("✅ Simulation cleanup complete");
}

void sim_step(struct Sim* sim, q16_t dt) {
    if (!sim) return;

    // Clear hit events from the previous tick before any subsystem runs
    sim->hit_event_count = 0;
    
    // Increment simulation tick
    sim->tick++;
    sim->time_ms += Q16_TO_INT(dt);
    
    // Update all subsystems in deterministic order
    sim_update_ships(sim, dt);
    sim_update_players(sim, dt);
    sim_update_projectiles(sim, dt);
    
    // Handle collisions
    sim_handle_collisions(sim);
    
    // Update spatial acceleration structures
    sim_update_spatial_hash(sim);
}

void sim_update_ships(struct Sim* sim, q16_t dt) {
    // Sort ships by ID to ensure deterministic order
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        for (uint16_t j = i + 1; j < sim->ship_count; j++) {
            if (sim->ships[i].id > sim->ships[j].id) {
                struct Ship temp = sim->ships[i];
                sim->ships[i] = sim->ships[j];
                sim->ships[j] = temp;
            }
        }
    }

    float dt_secs = Q16_TO_FLOAT(dt);

    // Update each ship's physics and sinking
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        struct Ship* ship = &sim->ships[i];
        update_ship_physics(ship, dt);

        // Update per-module state (reload timers, etc.)
        for (uint8_t m = 0; m < ship->module_count; m++) {
            module_update(&ship->modules[m], dt);
        }

        // ---- Sinking / water mechanic ----
        // Count remaining planks and detect leaks (< 30% HP).
        // Leaking planks do NOT self-damage — they stay at their current HP but
        // contribute to the hull drain rate at half the missing-plank rate.
        int planks_remaining = 0;
        int planks_leaking = 0;

        for (uint8_t m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_PLANK) continue;
            if (mod->health <= 0) continue; // already destroyed elsewhere

            bool is_leaking = (mod->health < mod->max_health * 30 / 100);

            if (is_leaking) {
                planks_leaking++;
            }
            planks_remaining++;

            // Passive healing at 2.5%/s — only while repair has been initiated
            if ((mod->state_bits & MODULE_STATE_REPAIRING) &&
                mod->health < (int32_t)mod->max_health) {
                float heal = (float)mod->max_health * 0.025f * dt_secs;
                mod->health += (int32_t)heal;
                if (mod->health >= (int32_t)mod->max_health) {
                    mod->health = (int32_t)mod->max_health;
                    mod->state_bits &= (uint16_t)~MODULE_STATE_REPAIRING;
                }
            }
        }

        // Passive healing for deck at same 2.5%/s rate
        for (uint8_t m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_DECK) continue;
            if (mod->health <= 0 || mod->health >= (int32_t)mod->max_health) continue;
            if (!(mod->state_bits & MODULE_STATE_REPAIRING)) continue;
            float heal = (float)mod->max_health * 0.025f * dt_secs;
            mod->health += (int32_t)heal;
            if (mod->health >= (int32_t)mod->max_health) {
                mod->health = (int32_t)mod->max_health;
                mod->state_bits &= (uint16_t)~MODULE_STATE_REPAIRING;
                mod->state_bits &= (uint16_t)~MODULE_STATE_DAMAGED;
            }
        }

        int missing = (int)ship->initial_plank_count - planks_remaining;

        /* Ghost ships store hull_health as a raw int32 (0–60000), not Q16-encoded.
         * Heal 100/s while alive; do nothing once already at 0 (dead). */
        if (ship->company_id == 99) {
            if (ship->hull_health > 0) {
                int32_t healed = ship->hull_health + (int32_t)(100.0f * dt_secs);
                ship->hull_health = (healed > 60000) ? 60000 : healed;
            }
            /* Skip the normal plank-drain logic entirely for ghost ships. */
        } else if (missing == 0 && planks_leaking == 0) {
            // Full integrity: crew bails water — hull_health rises at 1 HP/s (capped at 100)
            float health = Q16_TO_FLOAT(ship->hull_health) + 1.0f * dt_secs;
            if (health > 100.0f) health = 100.0f;
            ship->hull_health = Q16_FROM_FLOAT(health);
        } else {
            // Hull is compromised — compute drain rate
            float drain_rate = 0.0f;

            // Missing planks: exponential drain (1/1.2) * 2^(missing-1)
            if (missing > 0) {
                int shift = missing - 1;
                if (shift > 15) shift = 15;
                drain_rate += (1.0f / 1.2f) * (float)(1 << shift);
            }

            // Each leaking plank contributes half the single-missing-plank base rate
            drain_rate += 0.5f * (1.0f / 1.2f) * (float)planks_leaking;

            float drain = drain_rate * ship_level_sturdiness_mult(&ship->level_stats) * dt_secs;
            float health = Q16_TO_FLOAT(ship->hull_health) - drain;
            if (health <= 0.0f) {
                health = 0.0f;
                // Fire SHIP_SINK event (once, when health first hits 0)
                if (ship->hull_health > 0 && sim->hit_event_count < MAX_HIT_EVENTS) {
                    struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                    ev->ship_id   = ship->id;
                    ev->module_id = 0;
                    ev->is_breach = false;
                    ev->is_sink   = true;
                    ev->hit_x     = Q16_TO_FLOAT(ship->position.x);
                    ev->hit_y     = Q16_TO_FLOAT(ship->position.y);
                }
            }
            ship->hull_health = Q16_FROM_FLOAT(health);
        }
    }
}

void sim_update_players(struct Sim* sim, q16_t dt) {
    // Sort players by ID for deterministic order
    for (uint16_t i = 0; i < sim->player_count; i++) {
        for (uint16_t j = i + 1; j < sim->player_count; j++) {
            if (sim->players[i].id > sim->players[j].id) {
                struct Player temp = sim->players[i];
                sim->players[i] = sim->players[j];
                sim->players[j] = temp;
            }
        }
    }
    
    // Periodic player position log disabled — too noisy
    static uint32_t pos_log_count = 0; (void)(pos_log_count++);
    if (false && pos_log_count > 0 && sim->player_count > 0) {
        log_info("📍 Player positions:");
        for (uint16_t i = 0; i < sim->player_count; i++) {
            struct Player* p = &sim->players[i];
            log_info("  P%u: pos(%.2f, %.2f) vel(%.2f, %.2f) radius=%.2f ship_id=%u",
                p->id,
                Q16_TO_FLOAT(p->position.x), Q16_TO_FLOAT(p->position.y),
                Q16_TO_FLOAT(p->velocity.x), Q16_TO_FLOAT(p->velocity.y),
                Q16_TO_FLOAT(p->radius),
                p->ship_id);
        }
    }
    
    // Update each player's physics
    for (uint16_t i = 0; i < sim->player_count; i++) {
        update_player_physics(&sim->players[i], sim, dt);
    }
}

void sim_update_projectiles(struct Sim* sim, q16_t dt) {
    // Sort projectiles by ID for deterministic order
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        for (uint16_t j = i + 1; j < sim->projectile_count; j++) {
            if (sim->projectiles[i].id > sim->projectiles[j].id) {
                struct Projectile temp = sim->projectiles[i];
                sim->projectiles[i] = sim->projectiles[j];
                sim->projectiles[j] = temp;
            }
        }
    }
    
    // Update each projectile's physics and check lifetime
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        struct Projectile* proj = &sim->projectiles[i];
        
        // Check lifetime — use proj->lifetime if set, otherwise fall back to 4s default
        uint32_t lifetime_ms = sim->time_ms - proj->spawn_time;
        uint32_t max_lifetime = (proj->lifetime > 0)
            ? (uint32_t)(Q16_TO_FLOAT(proj->lifetime) * 1000.0f)
            : 4000;
        if (lifetime_ms > max_lifetime) {
            // Remove expired projectile
            memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                   (sim->projectile_count - i - 1) * sizeof(struct Projectile));
            sim->projectile_count--;
            i--; // Adjust index after removal
            continue;
        }
        
        update_projectile_physics(proj, dt);
    }
}

void sim_handle_collisions(struct Sim* sim) {
    // Handle ship-to-ship collisions
    handle_ship_collisions(sim);
    
    // Handle player-to-player collisions
    handle_player_player_collisions(sim);
    
    // Handle projectile collisions with ships and players
    handle_projectile_collisions(sim);
    
    // Handle player-ship collisions (boarding, falling off)
    handle_player_ship_collisions(sim);
}

// Entity creation functions
entity_id sim_create_ship(struct Sim* sim, Vec2Q16 position, q16_t rotation) {
    if (!sim || sim->ship_count >= MAX_SHIPS) {
        return INVALID_ENTITY_ID;
    }
    
    entity_id id = allocate_entity_id(sim);
    if (id == INVALID_ENTITY_ID) return id;
    
    struct Ship* ship = &sim->ships[sim->ship_count];
    memset(ship, 0, sizeof(struct Ship));
    
    ship->id = id;
    ship->position = position;
    ship->rotation = rotation;
    ship->velocity = VEC2_ZERO;
    ship->angular_velocity = 0;
    ship->mass = Q16_FROM_FLOAT(1000.0f); // 1000 kg default
    ship->moment_inertia = Q16_FROM_FLOAT(50000.0f); // kg⋅m²
    ship->bounding_radius = Q16_FROM_FLOAT(10.0f); // 10m radius
    ship->hull_health = Q16_FROM_INT(100);
    ship->desired_sail_openness = 0;  // Sails start closed
    ship->rudder_angle = 0.0f;        // Rudder centered
    ship->target_rudder_angle = 0.0f; // No input

    ship_level_init(&ship->level_stats);
    
    // Create brigantine hull with curved bow/stern sections (47 vertices)
    // Matches client-side createCurvedShipHull() from ShipUtils.ts
    // Hull points (in client pixels): bow(190,90), bowTip(415,0), bowBottom(190,-90),
    //                                  sternBottom(-260,-90), sternTip(-345,0), stern(-260,90)
    // Scaled down by WORLD_SCALE_FACTOR for server Q16 stability
    ship->hull_vertex_count = 47;
    int idx = 0;
    
    // Curved bow section (port side: bow -> bowTip -> bowBottom) - 13 points
    for (int i = 0; i <= 12; i++) {
        float t = (float)i / 12.0f;
        // Quadratic bezier: P(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
        float x = (1-t)*(1-t)*190.0f + 2*(1-t)*t*415.0f + t*t*190.0f;
        float y = (1-t)*(1-t)*90.0f + 2*(1-t)*t*0.0f + t*t*(-90.0f);
        // Minimal expansion for bow curve (1.02x) to match side thickness
        x *= 1.02f;
        y *= 1.1f;  // Keep Y expansion for width consistency
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Straight starboard side (bowBottom -> sternBottom) - 12 points
    for (int i = 1; i <= 12; i++) {
        float t = (float)i / 12.0f;
        float x = 190.0f + t * (-260.0f - 190.0f);
        float y = -90.0f + t * (-90.0f - (-90.0f));
        // Only expand Y (width) for straight sides, keep X (length) unchanged
        // x *= 1.0f;  // No X expansion
        y *= 1.1f;  // Width expansion
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Curved stern section (sternBottom -> sternTip -> stern) - 12 points
    for (int i = 1; i <= 12; i++) {
        float t = (float)i / 12.0f;
        float x = (1-t)*(1-t)*(-260.0f) + 2*(1-t)*t*(-345.0f) + t*t*(-260.0f);
        float y = (1-t)*(1-t)*(-90.0f) + 2*(1-t)*t*0.0f + t*t*90.0f;
        // Minimal expansion for stern curve (1.02x) to match side thickness
        x *= 1.02f;
        y *= 1.1f;  // Keep Y expansion for width consistency
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Straight port side (stern -> bow) - 11 points (excluding last to avoid duplication)
    for (int i = 1; i < 12; i++) {
        float t = (float)i / 12.0f;
        float x = -260.0f + t * (190.0f - (-260.0f));
        float y = 90.0f + t * (90.0f - 90.0f);
        // Only expand Y (width) for straight sides, keep X (length) unchanged
        // x *= 1.0f;  // No X expansion
        y *= 1.1f;  // Width expansion
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Calculate bounding radius from actual hull extent
    // Hull base extends from -345 to 415 in x (client), -90 to 90 in y (client)
    // After scaling: bow/stern 1.02x X, all 1.1x Y → max ~423 x, 99 y
    // Max distance from center is sqrt(423^2 + 99^2) ≈ 434.5 client units = 43.45 server units
    ship->bounding_radius = Q16_FROM_FLOAT(CLIENT_TO_SERVER(435.0f)); // Conservative bounding radius
    
    // Initialize BROADSIDE loadout modules
    // Matches BrigantineLoadouts.BROADSIDE from BrigantineTestBuilder.ts
    // Module IDs are based on ship entity ID so two ships have distinct IDs
    // (ship 1 → 1000-1010, ship 2 → 2000-2010, etc.)
    ship->module_count = 0;
    uint16_t module_id = (uint16_t)(ship->id * 1000);
    
    // Helm
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_HELM,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    
    // Port side cannons (3) — local_rot = -PI/2 (barrel faces port/left)
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-35.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(75.0f))},
        Q16_FROM_FLOAT(3.1415927f) // -PI/2: port barrel faces left
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(65.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(75.0f))},
        Q16_FROM_FLOAT(3.1415927f)
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-135.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(75.0f))},
        Q16_FROM_FLOAT(3.1415927f)
    );
    
    // Starboard side cannons (3) — local_rot = PI/2 (barrel faces starboard/right)
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-35.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(-75.0f))},
        Q16_FROM_FLOAT(0.0f) // PI/2: starboard barrel faces right
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(65.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(-75.0f))},
        Q16_FROM_FLOAT(0.0f)
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-135.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(-75.0f))},
        Q16_FROM_FLOAT(0.0f)
    );
    
    // Three masts (front, middle, back)
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_MAST,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(165.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_MAST,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-35.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_MAST,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-235.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    
    // Add ladder at specified position (-305, 0 in client coords)
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_LADDER,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-305.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    
    // Initialize 10 hull planks with positions matching client hull geometry.
    // Positions are the segment midpoints derived from createCompleteHullSegments()
    // in modules.ts using HULL_POINTS. Order: bow_port, bow_starboard,
    // 3x starboard_side, stern_starboard, stern_port, 3x port_side.
    // All values in client-space coords (divided by WORLD_SCALE_FACTOR to get server units).
    static const float plank_cx[10] = {
         246.25f,  246.25f,   // bow_port, bow_starboard
         115.0f,  -35.0f, -185.0f,  // starboard_side [0-2]
        -281.25f, -281.25f,  // stern_starboard, stern_port
        -185.0f,  -35.0f,   115.0f   // port_side [0-2]
    };
    static const float plank_cy[10] = {
         45.0f,  -45.0f,
        -90.0f,  -90.0f,  -90.0f,
        -45.0f,   45.0f,
         90.0f,   90.0f,   90.0f
    };
    for (int i = 0; i < 10; i++) {
        Vec2Q16 pos = {
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(plank_cx[i])),
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(plank_cy[i]))
        };
        ShipModule plank = module_create(100 + i, MODULE_TYPE_PLANK, pos, 0);
        ship->modules[ship->module_count++] = plank;
    }
    ship->initial_plank_count = 10;
    
    // Deck module (ID 200) - position not used, client generates from hull polygon
    ship->modules[ship->module_count++] = module_create(
        200, MODULE_TYPE_DECK,
        (Vec2Q16){0, 0},
        0
    );
    
    log_info("⚓ Created brigantine ship %u with BROADSIDE loadout: %u modules (6 cannons, 3 masts, 1 helm, 1 ladder, 10 planks, 1 deck)",
             id, ship->module_count);
    
    sim->ship_count++;
    
    log_debug("Created ship %u at (%.2f, %.2f)", id, 
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y));
    
    return id;
}

entity_id sim_create_player(struct Sim* sim, Vec2Q16 position, entity_id ship_id) {
    if (!sim || sim->player_count >= MAX_PLAYERS) {
        return INVALID_ENTITY_ID;
    }
    
    entity_id id = allocate_entity_id(sim);
    if (id == INVALID_ENTITY_ID) return id;
    
    struct Player* player = &sim->players[sim->player_count];
    memset(player, 0, sizeof(struct Player));
    
    player->id = id;
    player->ship_id = ship_id;
    player->position = position;
    player->velocity = VEC2_ZERO;
    player->radius = Q16_FROM_FLOAT(CLIENT_TO_SERVER(8.0f)); // 8 client pixels = 0.8 server units
    player->health = 100;
    
    if (ship_id == 0) {
        player->flags |= PLAYER_FLAG_IN_WATER;
    }
    
    sim->player_count++;
    
    log_debug("Created player %u at (%.2f, %.2f), ship %u", id,
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y), ship_id);
    
    return id;
}

entity_id sim_create_projectile(struct Sim* sim, Vec2Q16 position, Vec2Q16 velocity, entity_id shooter_id, uint8_t proj_type) {
    if (!sim || sim->projectile_count >= MAX_PROJECTILES) {
        return INVALID_ENTITY_ID;
    }
    
    entity_id id = allocate_entity_id(sim);
    if (id == INVALID_ENTITY_ID) return id;
    
    struct Projectile* proj = &sim->projectiles[sim->projectile_count];
    memset(proj, 0, sizeof(struct Projectile));
    
    proj->id = id;
    proj->owner_id = shooter_id;
    proj->position = position;
    proj->velocity = velocity;
    proj->damage = 3000; // 3000 base damage (x weapon_damage multiplier 1.0)
    proj->lifetime = Q16_FROM_INT(10); // 10 second lifetime
    proj->spawn_time = sim->time_ms;
    proj->type = proj_type;
    
    sim->projectile_count++;
    
    log_debug("Created projectile %u at (%.2f, %.2f), vel (%.2f, %.2f)", id,
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y),
              Q16_TO_FLOAT(velocity.x), Q16_TO_FLOAT(velocity.y));
    
    return id;
}

// Entity lookup functions
struct Ship* sim_get_ship(struct Sim* sim, entity_id id) {
    if (!sim) return NULL;
    
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id == id) {
            return &sim->ships[i];
        }
    }
    return NULL;
}

struct Player* sim_get_player(struct Sim* sim, entity_id id) {
    if (!sim) return NULL;
    
    for (uint16_t i = 0; i < sim->player_count; i++) {
        if (sim->players[i].id == id) {
            return &sim->players[i];
        }
    }
    return NULL;
}

struct Projectile* sim_get_projectile(struct Sim* sim, entity_id id) {
    if (!sim) return NULL;
    
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        if (sim->projectiles[i].id == id) {
            return &sim->projectiles[i];
        }
    }
    return NULL;
}

void sim_process_input(struct Sim* sim, const struct InputCmd* cmd) {
    if (!sim || !cmd) return;
    
    struct Player* player = sim_get_player(sim, cmd->player_id);
    if (!player) return;
    
    // Convert Q0.15 input to Q16.16
    q16_t thrust = (q16_t)(cmd->thrust << 1);
    q16_t turn = (q16_t)(cmd->turn << 1);
    
    // Apply input to player's ship if they're on one
    if (player->ship_id != 0) {
        struct Ship* ship = sim_get_ship(sim, player->ship_id);
        if (ship) {
            // Apply thrust in ship's forward direction
            Vec2Q16 forward = {q16_cos(ship->rotation), q16_sin(ship->rotation)};
            Vec2Q16 thrust_force = vec2_mul_scalar(forward, q16_mul(thrust, Q16_FROM_FLOAT(5000.0f)));
            
            // Apply force (F = ma, so a = F/m)
            Vec2Q16 acceleration = vec2_mul_scalar(thrust_force, q16_div(Q16_ONE, ship->mass));
            ship->velocity = vec2_add(ship->velocity, vec2_mul_scalar(acceleration, FIXED_DT_Q16));
            
            // Apply turn torque
            q16_t torque = q16_mul(turn, Q16_FROM_FLOAT(10000.0f)); // N⋅m
            q16_t angular_acc = q16_div(torque, ship->moment_inertia);
            ship->angular_velocity = q16_add_sat(ship->angular_velocity, 
                                                q16_mul(angular_acc, FIXED_DT_Q16));
        }
    }
    
    // Handle action buttons
    if (cmd->actions & PLAYER_ACTION_FIRE_CANNON) {
        // Fire cannon if player has one equipped
        struct Player* player = sim_get_player(sim, cmd->player_id);
        if (player && player->ship_id != INVALID_ENTITY_ID) {
            // Find the ship the player is on
            struct Ship* ship = sim_get_ship(sim, player->ship_id);
            if (ship) {
                // Create cannonball projectile
                Vec2Q16 cannon_pos = {
                    ship->position.x + q16_mul(Q16_FROM_INT(30), q16_cos(ship->rotation)),
                    ship->position.y + q16_mul(Q16_FROM_INT(30), q16_sin(ship->rotation))
                };
                Vec2Q16 cannon_velocity = {
                    ship->velocity.x + q16_mul(Q16_FROM_INT(200), q16_cos(ship->rotation)),
                    ship->velocity.y + q16_mul(Q16_FROM_INT(200), q16_sin(ship->rotation))
                };
                entity_id projectile = sim_create_projectile(sim, cannon_pos, cannon_velocity, player->id, PROJ_TYPE_CANNONBALL);
                log_info("🔥 Player %u fired cannon from ship %u (projectile %u)", 
                        player->id, ship->id, projectile);
            }
        }
    }
    
    if (cmd->actions & PLAYER_ACTION_JUMP) {
        // Handle player jump
        struct Player* player = sim_get_player(sim, cmd->player_id);
        if (player) {
            // Add vertical velocity for jump
            player->velocity.y = q16_add_sat(player->velocity.y, Q16_FROM_INT(5)); // 5 m/s upward
            
            // If jumping from a ship, leave the ship
            if (player->ship_id != INVALID_ENTITY_ID) {
                log_info("🦘 Player %u jumped off ship %u", player->id, player->ship_id);
                player->ship_id = INVALID_ENTITY_ID;
            } else {
                log_info("🦘 Player %u jumped", player->id);
            }
        }
    }
}

// Physics implementation
static void update_ship_physics(struct Ship* ship, q16_t dt) {
    if (!ship) return;
    
    // Apply water friction to velocity
    q16_t friction = Q16_FROM_FLOAT(0.95f);
    ship->velocity = vec2_mul_scalar(ship->velocity, friction);
    
    // Apply angular friction
    ship->angular_velocity = q16_mul(ship->angular_velocity, friction);
    
    // Integrate position and rotation
    Vec2Q16 displacement = vec2_mul_scalar(ship->velocity, dt);
    ship->position = vec2_add(ship->position, displacement);
    
    ship->rotation = q16_add_sat(ship->rotation, q16_mul(ship->angular_velocity, dt));
    
    // Normalize rotation to [0, 2π]
    q16_t two_pi = Q16_FROM_FLOAT(6.28318530718f);
    while (ship->rotation < 0) {
        ship->rotation = q16_add_sat(ship->rotation, two_pi);
    }
    while (ship->rotation >= two_pi) {
        ship->rotation = q16_sub_sat(ship->rotation, two_pi);
    }
}

static void update_player_physics(struct Player* player, struct Sim* sim, q16_t dt) {
    if (!player || !sim) return;
    
    // If player is on a ship, update position relative to ship
    if (player->ship_id != 0) {
        struct Ship* ship = sim_get_ship(sim, player->ship_id);
        if (ship) {
            // For now, just keep player at ship center
            player->position = ship->position;
            player->velocity = ship->velocity;
            player->flags &= ~PLAYER_FLAG_IN_WATER;
        }
    } else {
        // Player in water - swimming physics
        player->flags |= PLAYER_FLAG_IN_WATER;
        
        // Note: Velocity is controlled by WebSocket server (acceleration/deceleration)
        // No friction applied here - deceleration is handled when player stops moving
        
        // Integrate position
        Vec2Q16 displacement = vec2_mul_scalar(player->velocity, dt);
        player->position = vec2_add(player->position, displacement);
    }
}

static void update_projectile_physics(struct Projectile* projectile, q16_t dt) {
    if (!projectile) return;
    
    // Integrate position (straight-line travel — no gravity in top-down view)
    Vec2Q16 displacement = vec2_mul_scalar(projectile->velocity, dt);
    projectile->position = vec2_add(projectile->position, displacement);
}

// Helper: Transform hull vertex from local to world space
static Vec2Q16 transform_hull_vertex(Vec2Q16 local_vertex, Vec2Q16 position, q16_t rotation) {
    // Rotate: [cos -sin] [x]
    //         [sin  cos] [y]
    q16_t cos_r = q16_cos(rotation);
    q16_t sin_r = q16_sin(rotation);
    
    q16_t rotated_x = q16_sub_sat(q16_mul(local_vertex.x, cos_r), q16_mul(local_vertex.y, sin_r));
    q16_t rotated_y = q16_add_sat(q16_mul(local_vertex.x, sin_r), q16_mul(local_vertex.y, cos_r));
    
    return (Vec2Q16){
        q16_add_sat(position.x, rotated_x),
        q16_add_sat(position.y, rotated_y)
    };
}

// Helper: Get edge normal for SAT
static Vec2Q16 get_edge_normal(Vec2Q16 v1, Vec2Q16 v2) {
    Vec2Q16 edge = vec2_sub(v2, v1);
    // Perpendicular: (-y, x)
    Vec2Q16 normal = {-edge.y, edge.x};
    return vec2_normalize(normal);
}

// Helper: Project polygon onto axis and return min/max
static void project_polygon_onto_axis(const struct Ship* ship, Vec2Q16 axis, q16_t* out_min, q16_t* out_max) {
    q16_t min_proj = Q16_MAX;
    q16_t max_proj = Q16_MIN;
    
    for (uint8_t i = 0; i < ship->hull_vertex_count; i++) {
        Vec2Q16 world_vertex = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
        q16_t projection = vec2_dot(world_vertex, axis);
        
        if (projection < min_proj) min_proj = projection;
        if (projection > max_proj) max_proj = projection;
    }
    
    *out_min = min_proj;
    *out_max = max_proj;
}

// SAT polygon-polygon collision detection
static bool check_polygon_collision(const struct Ship* ship1, const struct Ship* ship2, 
                                    Vec2Q16* out_normal, q16_t* out_depth) {
    q16_t min_overlap = Q16_MAX;
    Vec2Q16 min_axis = VEC2_ZERO;
    
    // Test all edge normals from both ships
    for (int ship_idx = 0; ship_idx < 2; ship_idx++) {
        const struct Ship* ship = (ship_idx == 0) ? ship1 : ship2;
        
        for (uint8_t i = 0; i < ship->hull_vertex_count; i++) {
            uint8_t next_i = (i + 1) % ship->hull_vertex_count;
            
            Vec2Q16 v1 = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
            Vec2Q16 v2 = transform_hull_vertex(ship->hull_vertices[next_i], ship->position, ship->rotation);
            
            Vec2Q16 axis = get_edge_normal(v1, v2);
            if (vec2_length_sq(axis) < Q16_FROM_FLOAT(0.0001f)) continue; // Skip degenerate edges
            
            // Project both polygons onto this axis
            q16_t min1, max1, min2, max2;
            project_polygon_onto_axis(ship1, axis, &min1, &max1);
            project_polygon_onto_axis(ship2, axis, &min2, &max2);
            
            // Check for separation
            if (max1 < min2 || max2 < min1) {
                return false; // Separating axis found - no collision
            }
            
            // Calculate overlap
            q16_t overlap = (max1 < max2) ? q16_sub_sat(max1, min2) : q16_sub_sat(max2, min1);
            
            if (overlap < min_overlap) {
                min_overlap = overlap;
                min_axis = axis;
            }
        }
    }
    
    // No separating axis found - collision detected
    if (out_normal) {
        // Ensure normal points from ship1 to ship2
        Vec2Q16 center_diff = vec2_sub(ship2->position, ship1->position);
        if (vec2_dot(min_axis, center_diff) < 0) {
            min_axis = (Vec2Q16){-min_axis.x, -min_axis.y};  // Negate the vector
        }
        *out_normal = min_axis;
    }
    if (out_depth) *out_depth = min_overlap;
    
    return true;
}

static void handle_ship_collisions(struct Sim* sim) {
    if (!sim || sim->ship_count < 2) return;
    
    // O(n²) collision detection with SAT polygon collision
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        for (uint16_t j = i + 1; j < sim->ship_count; j++) {
            struct Ship* ship1 = &sim->ships[i];
            struct Ship* ship2 = &sim->ships[j];
            
            // Broad phase: check bounding circles first for early rejection
            Vec2Q16 diff = vec2_sub(ship2->position, ship1->position);
            q16_t dist_sq = vec2_length_sq(diff);
            q16_t combined_radius = q16_add_sat(ship1->bounding_radius, ship2->bounding_radius);
            q16_t radius_sq = q16_mul(combined_radius, combined_radius);
            
            if (dist_sq >= radius_sq) {
                continue; // Too far apart, skip expensive polygon check
            }
            
            // Narrow phase: SAT polygon-polygon collision
            Vec2Q16 collision_normal;
            q16_t overlap_depth;
            
            if (check_polygon_collision(ship1, ship2, &collision_normal, &overlap_depth)) {
                // Collision detected with actual hull polygons
                
                // Separate ships along collision normal
                Vec2Q16 separation = vec2_mul_scalar(collision_normal, q16_div(overlap_depth, Q16_FROM_INT(2)));
                ship1->position = vec2_sub(ship1->position, separation);
                ship2->position = vec2_add(ship2->position, separation);
                
                // Apply impulse-based collision response
                q16_t rel_velocity = vec2_dot(vec2_sub(ship2->velocity, ship1->velocity), collision_normal);
                
                if (rel_velocity < 0) { // Ships are approaching
                    // Coefficient of restitution (bounciness)
                    q16_t restitution = Q16_FROM_FLOAT(0.3f);
                    
                    // Calculate impulse magnitude: J = -(1 + e) * v_rel / (1/m1 + 1/m2)
                    q16_t numerator = q16_mul(q16_add_sat(Q16_ONE, restitution), -rel_velocity);
                    q16_t inv_mass_sum = q16_add_sat(q16_div(Q16_ONE, ship1->mass), q16_div(Q16_ONE, ship2->mass));
                    q16_t impulse_mag = q16_div(numerator, inv_mass_sum);
                    
                    Vec2Q16 impulse = vec2_mul_scalar(collision_normal, impulse_mag);
                    
                    // Apply impulses (F = ma, so dv = F/m)
                    Vec2Q16 impulse1 = vec2_mul_scalar(impulse, q16_div(Q16_ONE, ship1->mass));
                    Vec2Q16 impulse2 = vec2_mul_scalar(impulse, q16_div(Q16_ONE, ship2->mass));
                    
                    ship1->velocity = vec2_sub(ship1->velocity, impulse1);
                    ship2->velocity = vec2_add(ship2->velocity, impulse2);
                    
                    // Apply rotational impulse at collision point
                    // For simplicity, apply small angular velocity change
                    q16_t angular_impulse = q16_mul(impulse_mag, Q16_FROM_FLOAT(0.001f));
                    ship1->angular_velocity = q16_sub_sat(ship1->angular_velocity, angular_impulse);
                    ship2->angular_velocity = q16_add_sat(ship2->angular_velocity, angular_impulse);
                }
                
                log_info("⚓ Ship hull collision: %u <-> %u (overlap: %.2f, normal: (%.2f, %.2f))", 
                         ship1->id, ship2->id, Q16_TO_FLOAT(overlap_depth),
                         Q16_TO_FLOAT(collision_normal.x), Q16_TO_FLOAT(collision_normal.y));
            }
        }
    }
}

uint64_t sim_state_hash(const struct Sim* sim) {
    return hash_sim_state(sim);
}

void sim_serialize_state(const struct Sim* sim, uint8_t* buffer, size_t* buffer_size) {
    if (!sim || !buffer || !buffer_size) return;
    
    // Simple binary serialization (for replay storage)
    size_t required_size = sizeof(struct Sim);
    if (*buffer_size < required_size) {
        *buffer_size = required_size;
        return;
    }
    
    memcpy(buffer, sim, sizeof(struct Sim));
    *buffer_size = sizeof(struct Sim);
}

int sim_deserialize_state(struct Sim* sim, const uint8_t* buffer, size_t buffer_size) {
    if (!sim || !buffer || buffer_size < sizeof(struct Sim)) {
        return -1;
    }
    
    memcpy(sim, buffer, sizeof(struct Sim));
    return 0;
}

// Network integration functions
entity_id simulation_create_player_entity(struct Sim* sim, const char* player_name) {
    if (!sim || !player_name) return INVALID_ENTITY_ID;
    
    // Find the first available ship (should be the brigantine spawned at server start)
    entity_id ship_id = INVALID_ENTITY_ID;
    if (sim->ship_count > 0) {
        ship_id = sim->ships[0].id;  // Use the first ship (the brigantine)
    } else {
        log_error("No ships available! Cannot spawn player %s", player_name);
        return INVALID_ENTITY_ID;
    }
    
    // Spawn player on the existing ship at a default position on deck
    Vec2Q16 spawn_pos = sim->ships[0].position;
    entity_id player_id = sim_create_player(sim, spawn_pos, ship_id);
    if (player_id == INVALID_ENTITY_ID) {
        return INVALID_ENTITY_ID;
    }
    
    log_info("Created player entity %u (%s) on brigantine ship %u", player_id, player_name, ship_id);
    
    return player_id;
}

bool simulation_has_entity(const struct Sim* sim, entity_id entity_id) {
    if (!sim || entity_id == INVALID_ENTITY_ID) return false;
    
    // Check if entity exists in any of our arrays
    for (uint32_t i = 0; i < sim->player_count; i++) {
        if (sim->players[i].id == entity_id) return true;
    }
    
    for (uint32_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id == entity_id) return true;
    }
    
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        if (sim->projectiles[i].id == entity_id) return true;
    }
    
    return false;
}

// Spatial hash and collision detection functions
void sim_update_spatial_hash(struct Sim* sim) {
    // Clear the spatial hash
    memset(sim->spatial_hash, 0, sizeof(sim->spatial_hash));
    
    // Add all ships to spatial hash
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        struct Ship* ship = &sim->ships[i];
        spatial_hash_add_ship(sim, ship);
    }
    
    // Add all players to spatial hash
    for (uint16_t i = 0; i < sim->player_count; i++) {
        struct Player* player = &sim->players[i];
        spatial_hash_add_player(sim, player);
    }
    
    // Add all projectiles to spatial hash
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        struct Projectile* projectile = &sim->projectiles[i];
        spatial_hash_add_projectile(sim, projectile);
    }
}

void spatial_hash_add_ship(struct Sim* sim, struct Ship* ship) {
    // Simple spatial hash: divide world into 1024x1024 unit cells
    int32_t cell_x = Q16_TO_INT(ship->position.x) / 1024;
    int32_t cell_y = Q16_TO_INT(ship->position.y) / 1024;
    
    // Clamp to hash bounds
    if (cell_x < 0) cell_x = 0;
    if (cell_y < 0) cell_y = 0;
    if (cell_x >= SPATIAL_HASH_SIZE) cell_x = SPATIAL_HASH_SIZE - 1;
    if (cell_y >= SPATIAL_HASH_SIZE) cell_y = SPATIAL_HASH_SIZE - 1;
    
    uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
    struct SpatialCell* cell = &sim->spatial_hash[hash_index];
    
    // Add ship to cell (if room)
    if (cell->ship_count < MAX_ENTITIES_PER_CELL) {
        cell->ships[cell->ship_count++] = ship;
    }
}

void spatial_hash_add_player(struct Sim* sim, struct Player* player) {
    int32_t cell_x = Q16_TO_INT(player->position.x) / 1024;
    int32_t cell_y = Q16_TO_INT(player->position.y) / 1024;
    
    if (cell_x < 0) cell_x = 0;
    if (cell_y < 0) cell_y = 0;
    if (cell_x >= SPATIAL_HASH_SIZE) cell_x = SPATIAL_HASH_SIZE - 1;
    if (cell_y >= SPATIAL_HASH_SIZE) cell_y = SPATIAL_HASH_SIZE - 1;
    
    uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
    struct SpatialCell* cell = &sim->spatial_hash[hash_index];
    
    if (cell->player_count < MAX_ENTITIES_PER_CELL) {
        cell->players[cell->player_count++] = player;
    }
}

void spatial_hash_add_projectile(struct Sim* sim, struct Projectile* projectile) {
    int32_t cell_x = Q16_TO_INT(projectile->position.x) / 1024;
    int32_t cell_y = Q16_TO_INT(projectile->position.y) / 1024;
    
    if (cell_x < 0) cell_x = 0;
    if (cell_y < 0) cell_y = 0;
    if (cell_x >= SPATIAL_HASH_SIZE) cell_x = SPATIAL_HASH_SIZE - 1;
    if (cell_y >= SPATIAL_HASH_SIZE) cell_y = SPATIAL_HASH_SIZE - 1;
    
    uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
    struct SpatialCell* cell = &sim->spatial_hash[hash_index];
    
    if (cell->projectile_count < MAX_ENTITIES_PER_CELL) {
        cell->projectiles[cell->projectile_count++] = projectile;
    }
}

// Enhanced collision detection functions
// Map a hull vertex index (0..hull_vertex_count-1) to a plank index (0-9).
// Hull layout for brigantine (47 vertices):
//   0-12  : bow curve  (0-6 = bow_port plank 0, 7-12 = bow_stbd plank 1)
//   13-24 : stbd straight side split into 3 sections (planks 2,3,4)
//   25-36 : stern curve (25-30 = stern_stbd plank 5, 31-36 = stern_port plank 6)
//   37-47 : port straight side split into 3 sections (planks 7,8,9)
static int hull_vertex_to_plank_index(int v) {
    if (v <= 6)  return 0; // bow_port
    if (v <= 12) return 1; // bow_stbd
    if (v <= 16) return 2; // stbd_front
    if (v <= 20) return 3; // stbd_mid
    if (v <= 24) return 4; // stbd_rear
    if (v <= 30) return 5; // stern_stbd
    if (v <= 36) return 6; // stern_port
    if (v <= 39) return 7; // port_rear
    if (v <= 43) return 8; // port_mid
    return 9;              // port_front
}

// Find the simulation module index that a breaching cannonball hits.
// Uses original hit radius - projectiles must actually be inside the hull to hit modules.
// lx/ly are in ship-local server units.
// Returns -1 if no module is close enough.
static int find_module_hit(const struct Ship* ship, float lx, float ly) {
    for (int m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON &&
            mod->type_id != MODULE_TYPE_MAST   &&
            mod->type_id != MODULE_TYPE_HELM)   continue;
        if (mod->state_bits & MODULE_STATE_DESTROYED) continue;

        // Use original tight hit radius - projectile must be truly inside
        float radius;
        switch (mod->type_id) {
            case MODULE_TYPE_CANNON: radius = CLIENT_TO_SERVER(15.0f); break; // Reduced from 28
            case MODULE_TYPE_MAST:   radius = CLIENT_TO_SERVER(25.0f); break; // Reduced from 38
            case MODULE_TYPE_HELM:   radius = CLIENT_TO_SERVER(15.0f); break; // Reduced from 28
            default:                 radius = 0.0f;                    break;
        }
        float mx = Q16_TO_FLOAT(mod->local_pos.x);
        float my = Q16_TO_FLOAT(mod->local_pos.y);
        
        // Circle collision check with tight radius
        float dx = mx - lx, dy = my - ly;
        if (dx*dx + dy*dy < radius*radius)
            return m;
    }
    return -1;
}

// Ray-casting point-in-polygon test (works for convex or concave polygons).
// Vertices are in server units (Q16 float values).
static bool point_in_hull(float px, float py, const Vec2Q16* verts, int n) {
    bool inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = Q16_TO_FLOAT(verts[i].x), yi = Q16_TO_FLOAT(verts[i].y);
        float xj = Q16_TO_FLOAT(verts[j].x), yj = Q16_TO_FLOAT(verts[j].y);
        if (((yi > py) != (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}

/*
 * Bar shot hit zones (client-px, matching sail geometry in modules.ts):
 *   SAIL_HALF_WIDTH = 40  (sailWidth=80, half = 40) — outer edge of sail cloth
 *   MAST_POLE_RADIUS = 15 — solid mast centre; structural HP damage
 *
 * A shot inside SAIL_HALF_WIDTH hits the fibers.
 * A shot also inside MAST_POLE_RADIUS additionally damages the mast structure.
 */
#define BAR_SHOT_SAIL_RADIUS   CLIENT_TO_SERVER(40.0f)
#define BAR_SHOT_MAST_RADIUS   CLIENT_TO_SERVER(15.0f)

/* Return value: index into ship->modules[], or -1 for no hit.
 * *out_center_hit  is set to true only when the bar overlaps the mast pole. */
static int find_mast_hit(const struct Ship* ship, float lx, float ly,
                         uint16_t skip_module_id, bool* out_center_hit) {
    for (int m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->id == skip_module_id) continue;  // still inside radius of last-hit mast
        if (mod->type_id != MODULE_TYPE_MAST) continue;
        if (mod->state_bits & MODULE_STATE_DESTROYED) continue;

        float mx = Q16_TO_FLOAT(mod->local_pos.x);
        float my = Q16_TO_FLOAT(mod->local_pos.y);
        float dx = mx - lx, dy = my - ly;
        float dist_sq = dx*dx + dy*dy;

        if (dist_sq < BAR_SHOT_SAIL_RADIUS * BAR_SHOT_SAIL_RADIUS) {
            *out_center_hit = (dist_sq < BAR_SHOT_MAST_RADIUS * BAR_SHOT_MAST_RADIUS);
            return m;
        }
    }
    return -1;
}

void handle_projectile_collisions(struct Sim* sim) {
    // NOTE: hit_event_count is NOT reset here — sim_update_ships may have already
    // queued SHIP_SINK events this tick. The count is reset at the start of the
    // next tick by the caller (websocket_server.c drains events after sim_step).

    uint32_t i = 0;
    while (i < sim->projectile_count) {
        struct Projectile* proj = &sim->projectiles[i];
        bool removed = false;

        /* Liquid flame flies through hull/planks/modules — fire effects are applied
         * in the websocket_server entity-scan loop each tick.  Skip all geometric
         * collision for this projectile type and let it expire via lifetime. */
        if (proj->type == PROJ_TYPE_LIQUID_FLAME) { i++; continue; }

        // ---- Broad-phase: iterate all ships (small count, skip spatial hash) ----
        for (uint16_t s = 0; s < sim->ship_count && !removed; s++) {
            struct Ship* ship = &sim->ships[s];
            if (ship->id == proj->owner_id) continue;
            // Skip friendly-fire (same company, both non-neutral)
            if (proj->firing_company != 0 && proj->firing_company == ship->company_id) continue;

            // Broad-phase bounding radius
            float dx = Q16_TO_FLOAT(ship->position.x) - Q16_TO_FLOAT(proj->position.x);
            float dy = Q16_TO_FLOAT(ship->position.y) - Q16_TO_FLOAT(proj->position.y);
            float dist_sq = dx*dx + dy*dy;
            float brad = Q16_TO_FLOAT(ship->bounding_radius);
            if (dist_sq > brad * brad) {
                // Ball is outside bounding circle - clear breach flag if it was set for this ship
                if (proj->inside_ship_id == ship->id) proj->inside_ship_id = 0;
                continue;
            }

            // ---- Narrow-phase: transform projectile into ship-local coords ----
            float rot = Q16_TO_FLOAT(ship->rotation);
            float rel_x = Q16_TO_FLOAT(proj->position.x) - Q16_TO_FLOAT(ship->position.x);
            float rel_y = Q16_TO_FLOAT(proj->position.y) - Q16_TO_FLOAT(ship->position.y);
            float lx = rel_x * cosf(-rot) - rel_y * sinf(-rot);
            float ly = rel_x * sinf(-rot) + rel_y * cosf(-rot);

            // ---- BAR SHOT: bypass hull entirely, slices through mast/sail modules ----
            if (proj->type == PROJ_TYPE_BAR_SHOT) {
                bool center_hit = false;
                int hit_m = find_mast_hit(ship, lx, ly, (uint16_t)proj->last_hit_module_id, &center_hit);
                if (hit_m >= 0) {
                    ShipModule* hit_mod = &ship->modules[hit_m];
                    uint16_t mod_id = hit_mod->id;

                    float damage_dealt = 0.0f;
                    bool mast_destroyed = false;

                    if (center_hit) {
                        // ── Mast pole hit: full structural damage ──
                        float dmg_before = (float)hit_mod->health;
                        q16_t effective_damage = Q16_FROM_FLOAT(
                            Q16_TO_FLOAT(proj->damage)
                            * ship_level_resistance_mult(&ship->level_stats)
                        );
                        module_apply_damage(hit_mod, effective_damage);
                        damage_dealt = dmg_before - (float)hit_mod->health;
                        if (damage_dealt < 0) damage_dealt = 0;

                        mast_destroyed = (hit_mod->health <= 0);
                        if (mast_destroyed) {
                            log_info("⛵💥 Bar shot %u destroyed mast %u (pole hit) on ship %u",
                                     proj->id, mod_id, ship->id);
                            memmove(&ship->modules[hit_m], &ship->modules[hit_m + 1],
                                    (ship->module_count - hit_m - 1) * sizeof(ShipModule));
                            ship->module_count--;
                        } else {
                            log_info("⛵💥 Bar shot %u hit mast pole %u on ship %u — %d HP remaining",
                                     proj->id, mod_id, ship->id, (int)hit_mod->health);
                        }
                    } else {
                        // ── Sail fiber hit: damage fiber_health, derive wind_efficiency from HP ratio ──
                        // NOTE: fiber_health is stored as a proper Q16 float (Q16_FROM_FLOAT(15000.0)).
                        // proj->damage is stored as a plain integer in q16_t (e.g. 3000 raw ≠ Q16 for 3000.0).
                        // Using Q16_TO_FLOAT(proj->damage) gives ~0.046, not 3000 — so bypass Q16 here.
                        float fh = Q16_TO_FLOAT(hit_mod->data.mast.fiber_health);
                        float fhmax = Q16_TO_FLOAT(hit_mod->data.mast.fiber_max_health);
                        if (fhmax <= 0.0f) fhmax = 15000.0f;

                        float fiber_dmg = (float)proj->damage
                                          * ship_level_resistance_mult(&ship->level_stats);
                        fh -= fiber_dmg;
                        if (fh < 0.0f) fh = 0.0f;
                        hit_mod->data.mast.fiber_health = Q16_FROM_FLOAT(fh);

                        // wind_efficiency tracks fiber HP ratio (0.0 at destroyed, 1.0 at full)
                        float new_eff = fh / fhmax;
                        hit_mod->data.mast.wind_efficiency = Q16_FROM_FLOAT(new_eff);

                        damage_dealt = fiber_dmg;
                        log_info("⛵🧵 Bar shot %u shredded sail fiber %u on ship %u (fiber HP %.0f/%.0f, eff %.2f)",
                                 proj->id, mod_id, ship->id, fh, fhmax, new_eff);
                    }

                    if (sim->hit_event_count < MAX_HIT_EVENTS) {
                        struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                        ev->ship_id         = ship->id;
                        ev->module_id       = mod_id;
                        ev->is_breach       = true;
                        ev->is_sink         = false;
                        ev->destroyed       = mast_destroyed;
                        ev->damage_dealt    = damage_dealt;
                        ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                        ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                        ev->shooter_ship_id = proj->firing_ship_id;
                    }

                    if (center_hit && proj->firing_ship_id != INVALID_ENTITY_ID) {
                        struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                        if (attacker)
                            attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                    }

                    if (center_hit) {
                        // Bar shot hit the mast pole directly — stop it here.
                        memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                                (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                        sim->projectile_count--;
                        removed = true;
                    } else {
                        // Sail fiber hit — record which mast was just hit so it's skipped next
                        // tick while still in range; projectile keeps flying.
                        proj->last_hit_module_id = mod_id;
                    }
                    break;
                }
                // Bar shot outside all mast radii: clear the skip lock
                if (proj->last_hit_module_id != 0) proj->last_hit_module_id = 0;
                // Bar shot misses: keep flying (no hull interaction)
                continue;
            }

            // Point-in-polygon test
            bool inside_hull = point_in_hull(lx, ly, ship->hull_vertices, ship->hull_vertex_count);

            // If ball was marked as breaching this ship but has now exited the hull, clear it
            if (proj->inside_ship_id == ship->id && !inside_hull) {
                proj->inside_ship_id = 0;
                if (proj->last_hit_module_id == 200) proj->last_hit_module_id = 0; // clear deck hit flag
                log_info("🚪 Projectile %u exited hull of ship %u", proj->id, ship->id);
                continue;
            }

            if (!inside_hull) continue;

            // ---- Ball is inside the hull polygon ----
            
            // Log whether this is a first-time entry or already inside
            if (proj->inside_ship_id != ship->id) {
                log_info("🎯 Projectile %u entering hull of ship %u for first time (lx=%.1f, ly=%.1f)", 
                         proj->id, ship->id, lx, ly);
            } else {
                log_info("🔄 Projectile %u already inside ship %u hull (lx=%.1f, ly=%.1f)", 
                         proj->id, ship->id, lx, ly);
            }

            if (proj->inside_ship_id == ship->id) {
                // ---- Deck pass-through: damage deck once per hull entry (priority) ----
                // Deck ID is always 200; use last_hit_module_id==200 to fire only once per pass.
                if (proj->last_hit_module_id != 200) {
                    for (uint8_t m = 0; m < ship->module_count; m++) {
                        ShipModule* deck = &ship->modules[m];
                        if (deck->type_id != MODULE_TYPE_DECK) continue;
                        if (deck->health <= 0) break;

                        proj->last_hit_module_id = 200; // mark deck as hit for this pass

                        float dmg_before = (float)deck->health;
                        q16_t eff_dmg = Q16_FROM_FLOAT(
                            Q16_TO_FLOAT(proj->damage)
                            * ship_level_resistance_mult(&ship->level_stats));
                        module_apply_damage(deck, eff_dmg);
                        float deck_dmg = dmg_before - (float)deck->health;
                        if (deck_dmg < 0) deck_dmg = 0;

                        log_info("🪵 Projectile %u grazed deck on ship %u (%.0f HP remaining) — passing through",
                                 proj->id, ship->id, (float)deck->health);

                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id         = ship->id;
                            ev->module_id       = deck->id;
                            ev->is_breach       = true;
                            ev->is_sink         = false;
                            ev->destroyed       = (deck->health <= 0);
                            ev->damage_dealt    = deck_dmg;
                            ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id = proj->firing_ship_id;
                        }
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(deck_dmg / 100.0f);
                        }
                        break;
                    }
                }

                // Ball already breached this hull — check for interior module hits at current position
                /* Ghost ships have no planks; absorb any projectile that managed to get inside
                 * (shouldn't happen after entry-point intercept, but belt-and-suspenders). */
                if (ship->company_id == 99) {
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                }

                int hit_m = find_module_hit(ship, lx, ly);
                if (!removed && hit_m >= 0) {
                    ShipModule* hit_mod = &ship->modules[hit_m];
                    uint16_t mod_id = hit_mod->id;
                    
                    log_info("🎯 Interior module check: projectile %u at (%.1f, %.1f) hit module %u (type %d)",
                             proj->id, lx, ly, mod_id, hit_mod->type_id);

                    float dmg_before = (float)hit_mod->health;
                    q16_t effective_damage = Q16_FROM_FLOAT(
                        Q16_TO_FLOAT(proj->damage)
                        * ship_level_resistance_mult(&ship->level_stats)
                    );
                    module_apply_damage(hit_mod, effective_damage);
                    float damage_dealt = dmg_before - (float)hit_mod->health;
                    if (damage_dealt < 0) damage_dealt = 0;

                    if (hit_mod->health <= 0) {
                        // Module destroyed — emit event and remove it
                        log_info("💥 Projectile %u (inside hull) destroyed module %u on ship %u",
                                 proj->id, mod_id, ship->id);

                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id          = ship->id;
                            ev->module_id        = mod_id;
                            ev->is_breach        = true;
                            ev->is_sink          = false;
                            ev->destroyed        = true;
                            ev->damage_dealt     = damage_dealt;
                            ev->hit_x            = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y            = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id  = proj->firing_ship_id;
                        }

                        /* Award XP to the attacker ship */
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                        }

                        memmove(&ship->modules[hit_m], &ship->modules[hit_m + 1],
                                (ship->module_count - hit_m - 1) * sizeof(ShipModule));
                        ship->module_count--;
                    } else {
                        log_info("💥 Projectile %u hit module %u on ship %u — %d HP remaining",
                                 proj->id, mod_id, ship->id, (int)hit_mod->health);

                        // Non-fatal hit — still emit event for damage numbers
                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id          = ship->id;
                            ev->module_id        = mod_id;
                            ev->is_breach        = true;
                            ev->is_sink          = false;
                            ev->destroyed        = false;
                            ev->damage_dealt     = damage_dealt;
                            ev->hit_x            = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y            = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id  = proj->firing_ship_id;
                        }

                        /* Award XP to the attacker ship */
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                        }
                    }

                    // Projectile absorbed regardless of whether module was destroyed
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                }
                // No module hit yet — ball keeps traveling
                continue;
            }

            // ---- Ball is entering the hull for the first time — check entry plank ----

            /* ── Ghost ship: no planks — apply direct spectral hull damage ─────── */
            if (ship->company_id == 99) {
                /* hull_health is a raw int32 (0–60000), proj->damage is also a plain int. */
                int32_t hp = ship->hull_health - (int32_t)proj->damage;
                if (hp < 0) hp = 0;
                if (sim->hit_event_count < MAX_HIT_EVENTS) {
                    struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                    ev->ship_id         = ship->id;
                    ev->module_id       = 0;
                    ev->is_breach       = false;
                    ev->is_sink         = (ship->hull_health > 0 && hp == 0);
                    ev->destroyed       = false;
                    ev->damage_dealt    = (float)proj->damage;
                    ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                    ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                    ev->shooter_ship_id = proj->firing_ship_id;
                }
                ship->hull_health = hp;
                if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                    struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                    if (attacker) attacker->level_stats.xp += 20u;
                }
                memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                        (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                sim->projectile_count--;
                removed = true;
            }

            if (removed) break; /* skip normal plank lookup */

            // Find nearest hull vertex to determine which plank was hit
            int nearest_v = 0;
            float nearest_d2 = 1e30f;
            for (int v = 0; v < ship->hull_vertex_count; v++) {
                float vx = Q16_TO_FLOAT(ship->hull_vertices[v].x) - lx;
                float vy = Q16_TO_FLOAT(ship->hull_vertices[v].y) - ly;
                float d2 = vx*vx + vy*vy;
                if (d2 < nearest_d2) { nearest_d2 = d2; nearest_v = v; }
            }
            
            float nearest_distance = sqrtf(nearest_d2);
            
            // Only check for plank hit if cannonball is NEAR the hull boundary
            // At 30 Hz, cannonballs travel ~17 client px/tick (500 px/s / 30)
            // Use 2x that as safety margin = 34 client pixels
            const float MAX_PLANK_HIT_DISTANCE = CLIENT_TO_SERVER(34.0f);
            
            log_info("🎯 Projectile %u crossing hull of ship %u: nearest vertex=%d, distance=%.1f (max=%.1f)",
                     proj->id, ship->id, nearest_v, nearest_distance, MAX_PLANK_HIT_DISTANCE);
            
            if (nearest_distance > MAX_PLANK_HIT_DISTANCE) {
                // Cannonball is too far from hull edge - skipped past planks in one tick
                // This happens with fast projectiles at 30 Hz tick rate
                // Mark as inside and check for interior modules on next iteration
                log_info("⚠️ Projectile %u too far from hull edge (%.1f > %.1f) - skipped planks, now inside",
                         proj->id, nearest_distance, MAX_PLANK_HIT_DISTANCE);
                proj->inside_ship_id = ship->id;
                // Don't remove projectile - it will be checked for interior module hits
                // on the next iteration of the ship loop (or next tick)
                continue;
            }

            // Map vertex → plank module
            int plank_idx = hull_vertex_to_plank_index(nearest_v);
            uint16_t plank_module_id = (uint16_t)(100 + plank_idx);

            // Find and destroy the plank module
            int hit_plank_idx = -1;
            for (uint8_t m = 0; m < ship->module_count; m++) {
                if (ship->modules[m].id == plank_module_id) {
                    hit_plank_idx = m;
                    break;
                }
            }
            
            if (hit_plank_idx < 0) {
                log_info("⚠️ Plank %u not found in ship %u modules (may already be destroyed)", 
                         plank_module_id, ship->id);
            }

            if (hit_plank_idx >= 0 && !(ship->modules[hit_plank_idx].state_bits & MODULE_STATE_DESTROYED)) {
                ShipModule* hit_plank = &ship->modules[hit_plank_idx];

                float plank_hp_before = (float)hit_plank->health;
                q16_t effective_damage = Q16_FROM_FLOAT(
                    Q16_TO_FLOAT(proj->damage)
                    * ship_level_resistance_mult(&ship->level_stats)
                );
                module_apply_damage(hit_plank, effective_damage);
                float plank_damage_dealt = plank_hp_before - (float)hit_plank->health;
                if (plank_damage_dealt < 0) plank_damage_dealt = 0;

                if (hit_plank->health <= 0) {
                    // Plank destroyed — emit event and remove it
                    log_info("🎯 Projectile %u destroyed plank %u on ship %u (vertex %d)",
                             proj->id, plank_module_id, ship->id, nearest_v);

                    if (sim->hit_event_count < MAX_HIT_EVENTS) {
                        struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                        ev->ship_id         = ship->id;
                        ev->module_id       = plank_module_id;
                        ev->is_breach       = false;
                        ev->is_sink         = false;
                        ev->destroyed       = true;
                        ev->damage_dealt    = plank_damage_dealt;
                        ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                        ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                        ev->shooter_ship_id = proj->firing_ship_id;
                    }

                    /* Award XP to the attacker ship */
                    if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                        struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                        if (attacker)
                            attacker->level_stats.xp += 10u + (uint32_t)(plank_damage_dealt / 100.0f);
                    }

                    memmove(&ship->modules[hit_plank_idx], &ship->modules[hit_plank_idx + 1],
                            (ship->module_count - hit_plank_idx - 1) * sizeof(ShipModule));
                    ship->module_count--;
                } else {
                    log_info("🎯 Projectile %u hit plank %u on ship %u — %d HP remaining",
                             proj->id, plank_module_id, ship->id, (int)hit_plank->health);

                    if (sim->hit_event_count < MAX_HIT_EVENTS) {
                        struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                        ev->ship_id         = ship->id;
                        ev->module_id       = plank_module_id;
                        ev->is_breach       = false;
                        ev->is_sink         = false;
                        ev->destroyed       = false;
                        ev->damage_dealt    = plank_damage_dealt;
                        ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                        ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                        ev->shooter_ship_id = proj->firing_ship_id;
                    }

                    /* Award XP to the attacker ship */
                    if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                        struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                        if (attacker)
                            attacker->level_stats.xp += 10u + (uint32_t)(plank_damage_dealt / 100.0f);
                    }
                }

                // Projectile absorbed by plank (intact or destroyed)
                memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                        (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                sim->projectile_count--;
                removed = true;
            } else {
                // --- Plank already removed: ball passes through the breach ---
                // Mark as inside so it can damage interior modules
                proj->inside_ship_id = ship->id;
                
                log_info("🕳️  Projectile %u entered breach at plank %u on ship %u — checking for interior modules",
                         proj->id, plank_module_id, ship->id);
                
                // Immediately check for interior module hits (don't wait for next tick)
                int hit_m = find_module_hit(ship, lx, ly);
                if (hit_m >= 0) {
                    ShipModule* hit_mod = &ship->modules[hit_m];
                    uint16_t mod_id = hit_mod->id;

                    float dmg_before = (float)hit_mod->health;
                    q16_t effective_damage = Q16_FROM_FLOAT(
                        Q16_TO_FLOAT(proj->damage)
                        * ship_level_resistance_mult(&ship->level_stats)
                    );
                    module_apply_damage(hit_mod, effective_damage);
                    float damage_dealt = dmg_before - (float)hit_mod->health;
                    if (damage_dealt < 0) damage_dealt = 0;

                    if (hit_mod->health <= 0) {
                        // Module destroyed — emit event and remove it
                        log_info("💥 Projectile %u (through breach) destroyed module %u on ship %u",
                                 proj->id, mod_id, ship->id);

                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id          = ship->id;
                            ev->module_id        = mod_id;
                            ev->is_breach        = true;
                            ev->is_sink          = false;
                            ev->destroyed        = true;
                            ev->damage_dealt     = damage_dealt;
                            ev->hit_x            = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y            = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id  = proj->firing_ship_id;
                        }

                        /* Award XP to the attacker ship */
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                        }

                        memmove(&ship->modules[hit_m], &ship->modules[hit_m + 1],
                                (ship->module_count - hit_m - 1) * sizeof(ShipModule));
                        ship->module_count--;
                    } else {
                        log_info("💥 Projectile %u (through breach) hit module %u on ship %u — %d HP remaining",
                                 proj->id, mod_id, ship->id, (int)hit_mod->health);

                        // Non-fatal hit — still emit event for damage numbers
                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id          = ship->id;
                            ev->module_id        = mod_id;
                            ev->is_breach        = true;
                            ev->is_sink          = false;
                            ev->destroyed        = false;
                            ev->damage_dealt     = damage_dealt;
                            ev->hit_x            = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y            = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id  = proj->firing_ship_id;
                        }

                        /* Award XP to the attacker ship */
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                        }
                    }

                    // Projectile absorbed by module hit
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                } else {
                    // No interior module hit - projectile continues through the ship
                    // It will be checked again next tick or removed when it exits the hull
                }
            }
        }

        // ---- Player collision (unchanged) ----
        for (uint16_t j = 0; j < sim->player_count && !removed; j++) {
            struct Player* player = &sim->players[j];
            if (player->id == proj->owner_id) continue;
            if (player->ship_id == proj->owner_id) continue;

            float dx = Q16_TO_FLOAT(player->position.x) - Q16_TO_FLOAT(proj->position.x);
            float dy = Q16_TO_FLOAT(player->position.y) - Q16_TO_FLOAT(proj->position.y);
            float dist_sq = dx*dx + dy*dy;
            const float player_r = CLIENT_TO_SERVER(16.0f);
            if (dist_sq < player_r * player_r) {
                player->health = player->health > Q16_TO_INT(proj->damage) ?
                                 player->health - Q16_TO_INT(proj->damage) : 0;
                log_info("💀 Projectile %u hit player %u for %d damage (health: %d)",
                         proj->id, player->id, Q16_TO_INT(proj->damage), player->health);

                memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                        (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                sim->projectile_count--;
                removed = true;
            }
        }

        if (!removed) i++;
    }
}

/**
 * Handle player-to-player collisions with physics-based push
 */
static void handle_player_player_collisions(struct Sim* sim) {
    // Early exit if not enough players
    if (sim->player_count < 2) return;
    
    // Log that we're checking collisions
    static uint32_t check_count = 0;
    if (check_count++ % 100 == 0) {
        log_info("🔍 Checking player collisions: %u players", sim->player_count);
    }
    
    // Check all pairs of players for collisions
    for (uint16_t i = 0; i < sim->player_count; i++) {
        for (uint16_t j = i + 1; j < sim->player_count; j++) {
            struct Player* p1 = &sim->players[i];
            struct Player* p2 = &sim->players[j];
            
            // Calculate distance between players using distance squared for efficiency
            q16_t dx = q16_sub_sat(p2->position.x, p1->position.x);
            q16_t dy = q16_sub_sat(p2->position.y, p1->position.y);
            q16_t dist_sq = q16_add_sat(q16_mul(dx, dx), q16_mul(dy, dy));
            
            // Calculate minimum distance (sum of radii) for collision check
            q16_t min_dist = q16_add_sat(p1->radius, p2->radius);
            
            // Broad phase: Check if players are close enough to potentially collide
            // Add a small buffer zone (1.5x radius) to catch fast-moving players
            q16_t check_dist = q16_mul(min_dist, Q16_FROM_FLOAT(1.5f));
            q16_t check_dist_sq = q16_mul(check_dist, check_dist);
            
            // Skip if players are too far apart
            if (dist_sq >= check_dist_sq) continue;
            
            // Log when players are within check distance
            log_info("⚠️ Players nearby: P%u <-> P%u (dist²: %d, check²: %d)",
                p1->id, p2->id, Q16_TO_INT(dist_sq), Q16_TO_INT(check_dist_sq));
            
            // Calculate actual distance for precise collision check
            Vec2Q16 delta = {dx, dy};
            q16_t dist = vec2_length(delta);
            
            // Skip if exactly on top of each other (avoid division by zero)
            if (dist < Q16_FROM_FLOAT(0.01f)) {
                log_info("💥 Players on same position! P%u <-> P%u - pushing apart", p1->id, p2->id);
                // Push them apart in a random direction if overlapping perfectly
                p1->position.x -= Q16_FROM_FLOAT(0.5f);
                p2->position.x += Q16_FROM_FLOAT(0.5f);
                continue;
            }
            
            // Check if players are actually overlapping
            if (dist < min_dist) {
                q16_t overlap = q16_sub_sat(min_dist, dist);
                
                // Log collision for debugging
                log_info("💥 Player collision: P%u <-> P%u (overlap: %d.%02d units, dist: %d.%02d, min: %d.%02d)",
                    p1->id, p2->id, 
                    Q16_TO_INT(overlap), (int)((Q16_TO_FLOAT(overlap) * 100) - (Q16_TO_INT(overlap) * 100)),
                    Q16_TO_INT(dist), (int)((Q16_TO_FLOAT(dist) * 100) - (Q16_TO_INT(dist) * 100)),
                    Q16_TO_INT(min_dist), (int)((Q16_TO_FLOAT(min_dist) * 100) - (Q16_TO_INT(min_dist) * 100)));
                
                // Calculate collision normal (direction from p1 to p2)
                q16_t normal_x = q16_div(dx, dist);
                q16_t normal_y = q16_div(dy, dist);
                
                // ALWAYS separate overlapping players first (regardless of velocity)
                q16_t separation = q16_mul(overlap, Q16_FROM_FLOAT(0.5f));
                q16_t sep_x = q16_mul(normal_x, separation);
                q16_t sep_y = q16_mul(normal_y, separation);
                
                p1->position.x = q16_sub_sat(p1->position.x, sep_x);
                p1->position.y = q16_sub_sat(p1->position.y, sep_y);
                p2->position.x = q16_add_sat(p2->position.x, sep_x);
                p2->position.y = q16_add_sat(p2->position.y, sep_y);
                
                // Calculate relative velocity for impulse
                q16_t rel_vel_x = q16_sub_sat(p2->velocity.x, p1->velocity.x);
                q16_t rel_vel_y = q16_sub_sat(p2->velocity.y, p1->velocity.y);
                q16_t vel_along_normal = q16_add_sat(q16_mul(rel_vel_x, normal_x), q16_mul(rel_vel_y, normal_y));
                
                // Apply velocity changes only if players are moving toward each other
                if (vel_along_normal < 0) {
                    // Velocity correction with restitution and dampening
                    q16_t restitution = Q16_FROM_FLOAT(0.3f);  // Bounciness
                    q16_t dampening = Q16_FROM_FLOAT(0.7f);    // Energy loss
                    
                    // Calculate impulse (equal mass assumption)
                    q16_t impulse = q16_mul(-(Q16_ONE + restitution), vel_along_normal);
                    impulse = q16_div(impulse, Q16_FROM_INT(2)); // Divide by 2 for equal mass
                    
                    q16_t impulse_x = q16_mul(normal_x, impulse);
                    q16_t impulse_y = q16_mul(normal_y, impulse);
                    
                    // Apply impulse to both players
                    p1->velocity.x = q16_mul(q16_sub_sat(p1->velocity.x, impulse_x), dampening);
                    p1->velocity.y = q16_mul(q16_sub_sat(p1->velocity.y, impulse_y), dampening);
                    p2->velocity.x = q16_mul(q16_add_sat(p2->velocity.x, impulse_x), dampening);
                    p2->velocity.y = q16_mul(q16_add_sat(p2->velocity.y, impulse_y), dampening);
                    
                    // Apply friction
                    q16_t friction = Q16_FROM_FLOAT(0.95f);
                    p1->velocity.x = q16_mul(p1->velocity.x, friction);
                    p1->velocity.y = q16_mul(p1->velocity.y, friction);
                    p2->velocity.x = q16_mul(p2->velocity.x, friction);
                    p2->velocity.y = q16_mul(p2->velocity.y, friction);
                }
            }
        }
    }
}

// Helper: Check if point is inside polygon using ray casting
static bool point_in_polygon(Vec2Q16 point, const struct Ship* ship) {
    bool inside = false;
    
    for (uint8_t i = 0, j = ship->hull_vertex_count - 1; i < ship->hull_vertex_count; j = i++) {
        // Transform hull vertices to world space
        Vec2Q16 vi = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
        Vec2Q16 vj = transform_hull_vertex(ship->hull_vertices[j], ship->position, ship->rotation);
        
        // Ray casting algorithm
        if (((vi.y > point.y) != (vj.y > point.y)) &&
            (point.x < q16_add_sat(vi.x, q16_mul(q16_div(q16_sub_sat(vj.x, vi.x), 
                                                          q16_sub_sat(vj.y, vi.y)),
                                                  q16_sub_sat(point.y, vi.y))))) {
            inside = !inside;
        }
    }
    
    return inside;
}

// Helper: Find closest point on ship hull edge to player
static Vec2Q16 closest_point_on_hull(Vec2Q16 player_pos, const struct Ship* ship, q16_t* out_distance, Vec2Q16* out_edge_normal) {
    Vec2Q16 closest = player_pos;
    Vec2Q16 edge_normal = {0, 0};
    q16_t min_dist_sq = Q16_MAX;
    
    for (uint8_t i = 0; i < ship->hull_vertex_count; i++) {
        uint8_t next_i = (i + 1) % ship->hull_vertex_count;
        
        Vec2Q16 v1 = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
        Vec2Q16 v2 = transform_hull_vertex(ship->hull_vertices[next_i], ship->position, ship->rotation);
        
        // Find closest point on line segment v1-v2 to player_pos
        Vec2Q16 edge = vec2_sub(v2, v1);
        Vec2Q16 to_player = vec2_sub(player_pos, v1);
        
        q16_t edge_length_sq = vec2_length_sq(edge);
        if (edge_length_sq < Q16_FROM_FLOAT(0.0001f)) continue; // Skip degenerate edges
        
        // Project player onto edge: t = dot(to_player, edge) / |edge|^2
        q16_t t = q16_div(vec2_dot(to_player, edge), edge_length_sq);
        
        // Clamp t to [0, 1] to stay on segment
        if (t < 0) t = 0;
        if (t > Q16_ONE) t = Q16_ONE;
        
        // Closest point on edge
        Vec2Q16 point_on_edge = {
            q16_add_sat(v1.x, q16_mul(edge.x, t)),
            q16_add_sat(v1.y, q16_mul(edge.y, t))
        };
        
        q16_t dist_sq = vec2_length_sq(vec2_sub(player_pos, point_on_edge));
        
        if (dist_sq < min_dist_sq) {
            min_dist_sq = dist_sq;
            closest = point_on_edge;
            
            // Calculate edge normal (perpendicular to edge, pointing outward)
            // For CCW winding, normal = (-edge.y, edge.x) points outward (right side)
            q16_t edge_length = vec2_length(edge);
            if (edge_length > Q16_FROM_FLOAT(0.01f)) {
                edge_normal.x = -q16_div(edge.y, edge_length);
                edge_normal.y = q16_div(edge.x, edge_length);
                
                // Ensure normal points away from ship center
                Vec2Q16 edge_center = {
                    (v1.x >> 1) + (v2.x >> 1),
                    (v1.y >> 1) + (v2.y >> 1)
                };
                Vec2Q16 to_center = vec2_sub(ship->position, edge_center);
                if (vec2_dot(edge_normal, to_center) > 0) {
                    // Normal pointing inward, flip it
                    edge_normal.x = -edge_normal.x;
                    edge_normal.y = -edge_normal.y;
                }
            }
        }
    }
    
    if (out_distance) {
        *out_distance = vec2_length(vec2_sub(player_pos, closest));
    }
    
    if (out_edge_normal) {
        *out_edge_normal = edge_normal;
    }
    
    return closest;
}

void handle_player_ship_collisions(struct Sim* sim) {
    // Debug log periodically (disabled — too noisy)
    static uint32_t debug_count = 0;
    bool should_log = false; (void)(debug_count++);
    
    // First, check for swimming player collisions with ship hulls
    for (uint16_t i = 0; i < sim->player_count; i++) {
        struct Player* player = &sim->players[i];
        
        // Only check collision for swimming players (not on a ship)
        if (player->ship_id != INVALID_ENTITY_ID) continue;
        
        // Check collision with all ships
        for (uint16_t s = 0; s < sim->ship_count; s++) {
            struct Ship* ship = &sim->ships[s];
            
            // Quick broad-phase check using bounding radius
            Vec2Q16 diff = vec2_sub(player->position, ship->position);
            q16_t dist_sq = vec2_length_sq(diff);
            q16_t check_radius = q16_add_sat(ship->bounding_radius, player->radius);
            q16_t check_radius_sq = q16_mul(check_radius, check_radius);
            
            if (should_log) {
                log_info("🔍 Collision check P%u vs S%u: dist=%.2f, check_radius=%.2f, hull_verts=%u",
                    player->id, ship->id, 
                    Q16_TO_FLOAT(vec2_length(diff)), 
                    Q16_TO_FLOAT(check_radius),
                    ship->hull_vertex_count);
            }
            
            if (dist_sq > check_radius_sq) continue; // Too far away
            
            // Check if player is inside ship hull polygon
            bool inside = point_in_polygon(player->position, ship);
            
            if (inside) {
                // Player is colliding with ship hull - push them out
                q16_t penetration_depth;
                Vec2Q16 edge_normal;
                Vec2Q16 closest_hull_point = closest_point_on_hull(player->position, ship, &penetration_depth, &edge_normal);
                
                // Use edge normal for collision response (more accurate than radial direction)
                Vec2Q16 normal = edge_normal;
                q16_t normal_length = vec2_length(normal);
                
                // Fallback to radial direction if edge normal is invalid
                if (normal_length < Q16_FROM_FLOAT(0.01f)) {
                    Vec2Q16 separation = vec2_sub(player->position, closest_hull_point);
                    q16_t sep_length = vec2_length(separation);
                    if (sep_length > Q16_FROM_FLOAT(0.01f)) {
                        normal = vec2_normalize(separation);
                    } else {
                        // Last resort: push away from ship center
                        normal = vec2_normalize(vec2_sub(player->position, ship->position));
                    }
                }
                
                // Push player out to just outside the hull (radius + small margin)
                q16_t target_distance = q16_add_sat(player->radius, Q16_FROM_FLOAT(0.1f)); // radius + 0.1 unit margin
                Vec2Q16 target_pos = vec2_add(closest_hull_point, vec2_mul_scalar(normal, target_distance));
                player->position = target_pos;
                
                // Reflect velocity if moving into the hull
                q16_t vel_along_normal = vec2_dot(player->velocity, normal);
                if (vel_along_normal < 0) {
                    // Moving into the hull - reflect velocity with restitution
                    q16_t restitution = Q16_FROM_FLOAT(0.3f); // 30% bounce (reduced for smoother feel)
                    
                    // Separate velocity into normal and tangential components
                    Vec2Q16 vel_normal = vec2_mul_scalar(normal, vel_along_normal);
                    Vec2Q16 vel_tangent = vec2_sub(player->velocity, vel_normal);
                    
                    // Reflect normal component with restitution, keep tangential (sliding)
                    Vec2Q16 vel_reflected = vec2_mul_scalar(vel_normal, -restitution);
                    player->velocity = vec2_add(vel_tangent, vel_reflected);
                }
                
                log_info("🚫 Player %u collided with ship %u hull - repositioned to %.2f units from edge", 
                         player->id, ship->id, Q16_TO_FLOAT(target_distance));
            }
        }
    }
}

int simulation_process_player_input(struct Sim* sim, entity_id player_id, const struct CmdPacket* cmd) {
    if (!sim || !cmd || player_id == INVALID_ENTITY_ID) return -1;
    
    // Find the player
    struct Player* player = sim_get_player(sim, player_id);
    if (!player) {
        log_warn("Player %u not found for input processing", player_id);
        return -1;
    }
    
    // Convert network command to input command and process
    struct InputCmd input_cmd = {0};
    input_cmd.player_id = player_id;
    input_cmd.sequence = cmd->seq;
    input_cmd.client_time = cmd->client_time;
    input_cmd.thrust = cmd->thrust;
    input_cmd.turn = cmd->turn;
    input_cmd.actions = cmd->actions;
    input_cmd.dt_ms = cmd->dt_ms;
    
    sim_process_input(sim, &input_cmd);
    
    return 0;
}

// Missing entity management function
bool sim_destroy_entity(struct Sim* sim, entity_id id) {
    if (!sim || id == INVALID_ENTITY_ID) return false;
    
    // Remove from ships
    for (uint32_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id == id) {
            // Move last ship to this position
            if (i + 1 < sim->ship_count) {
                sim->ships[i] = sim->ships[sim->ship_count - 1];
            }
            sim->ship_count--;
            return true;
        }
    }
    
    // Remove from players
    for (uint32_t i = 0; i < sim->player_count; i++) {
        if (sim->players[i].id == id) {
            // Move last player to this position
            if (i + 1 < sim->player_count) {
                sim->players[i] = sim->players[sim->player_count - 1];
            }
            sim->player_count--;
            return true;
        }
    }
    
    // Remove from projectiles
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        if (sim->projectiles[i].id == id) {
            // Move last projectile to this position
            if (i + 1 < sim->projectile_count) {
                sim->projectiles[i] = sim->projectiles[sim->projectile_count - 1];
            }
            sim->projectile_count--;
            return true;
        }
    }
    
    return false; // Entity not found
}