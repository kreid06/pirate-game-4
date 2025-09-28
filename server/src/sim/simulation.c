#include "sim/simulation.h"
#include "net/protocol.h"
#include "core/hash.h"
#include "util/log.h"
#include <string.h>
#include <assert.h>

// Include hash function implementation
extern uint64_t hash_sim_state(const struct Sim* sim);

// Forward declarations
static void update_ship_physics(struct Ship* ship, q16_t dt);
static void update_player_physics(struct Player* player, struct Sim* sim, q16_t dt);
static void update_projectile_physics(struct Projectile* projectile, q16_t dt);
static void handle_ship_collisions(struct Sim* sim);
static entity_id allocate_entity_id(struct Sim* sim);

/**
 * Allocate a new unique entity ID
 */
static entity_id allocate_entity_id(struct Sim* sim) {
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
    
    // Reset all counts and state
    memset(sim, 0, sizeof(struct Sim));
    
    log_info("Simulation cleaned up");
}

void sim_step(struct Sim* sim, q16_t dt) {
    if (!sim) return;
    
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
    // Simple bubble sort is fine for small counts
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        for (uint16_t j = i + 1; j < sim->ship_count; j++) {
            if (sim->ships[i].id > sim->ships[j].id) {
                struct Ship temp = sim->ships[i];
                sim->ships[i] = sim->ships[j];
                sim->ships[j] = temp;
            }
        }
    }
    
    // Update each ship's physics
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        update_ship_physics(&sim->ships[i], dt);
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
        
        // Check lifetime (4 seconds for cannonballs)
        uint32_t lifetime_ms = sim->time_ms - proj->spawn_time;
        if (lifetime_ms > 4000) {
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
    
    // Create simple rectangular hull (8m × 3m)
    ship->hull_vertex_count = 4;
    ship->hull_vertices[0] = (Vec2Q16){Q16_FROM_FLOAT(-4.0f), Q16_FROM_FLOAT(-1.5f)};
    ship->hull_vertices[1] = (Vec2Q16){Q16_FROM_FLOAT(4.0f),  Q16_FROM_FLOAT(-1.5f)};
    ship->hull_vertices[2] = (Vec2Q16){Q16_FROM_FLOAT(4.0f),  Q16_FROM_FLOAT(1.5f)};
    ship->hull_vertices[3] = (Vec2Q16){Q16_FROM_FLOAT(-4.0f), Q16_FROM_FLOAT(1.5f)};
    
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
    player->radius = Q16_FROM_FLOAT(0.4f); // 40cm radius
    player->health = 100;
    
    if (ship_id == 0) {
        player->flags |= PLAYER_FLAG_IN_WATER;
    }
    
    sim->player_count++;
    
    log_debug("Created player %u at (%.2f, %.2f), ship %u", id,
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y), ship_id);
    
    return id;
}

entity_id sim_create_projectile(struct Sim* sim, Vec2Q16 position, Vec2Q16 velocity, entity_id shooter_id) {
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
    proj->damage = Q16_FROM_INT(25); // 25 damage per hit
    proj->lifetime = Q16_FROM_INT(10); // 10 second lifetime
    proj->spawn_time = sim->time_ms;
    proj->damage = 50;
    proj->type = 0; // Cannonball
    
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
                entity_id projectile = sim_create_projectile(sim, cannon_pos, cannon_velocity, player->id);
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
        // Player in water - apply swimming physics
        player->flags |= PLAYER_FLAG_IN_WATER;
        
        // Apply water friction
        q16_t water_friction = Q16_FROM_FLOAT(0.9f);
        player->velocity = vec2_mul_scalar(player->velocity, water_friction);
        
        // Integrate position
        Vec2Q16 displacement = vec2_mul_scalar(player->velocity, dt);
        player->position = vec2_add(player->position, displacement);
    }
}

static void update_projectile_physics(struct Projectile* projectile, q16_t dt) {
    if (!projectile) return;
    
    // Apply gravity
    Vec2Q16 gravity_acc = {0, GRAVITY_Q16};
    projectile->velocity = vec2_add(projectile->velocity, 
                                   vec2_mul_scalar(gravity_acc, dt));
    
    // Apply air friction
    q16_t air_friction = Q16_FROM_FLOAT(0.999f);
    projectile->velocity = vec2_mul_scalar(projectile->velocity, air_friction);
    
    // Integrate position
    Vec2Q16 displacement = vec2_mul_scalar(projectile->velocity, dt);
    projectile->position = vec2_add(projectile->position, displacement);
}

static void handle_ship_collisions(struct Sim* sim) {
    if (!sim || sim->ship_count < 2) return;
    
    // Simple O(n²) collision detection for now
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        for (uint16_t j = i + 1; j < sim->ship_count; j++) {
            struct Ship* ship1 = &sim->ships[i];
            struct Ship* ship2 = &sim->ships[j];
            
            // Broad phase: check bounding circles
            Vec2Q16 diff = vec2_sub(ship2->position, ship1->position);
            q16_t dist_sq = vec2_length_sq(diff);
            q16_t combined_radius = q16_add_sat(ship1->bounding_radius, ship2->bounding_radius);
            q16_t radius_sq = q16_mul(combined_radius, combined_radius);
            
            if (dist_sq < radius_sq) {
                // Collision detected - simple elastic response
                Vec2Q16 collision_normal = vec2_normalize(diff);
                if (vec2_length_sq(collision_normal) == 0) {
                    collision_normal = (Vec2Q16){Q16_ONE, 0}; // Fallback normal
                }
                
                // Separate ships
                q16_t overlap = q16_sub_sat(combined_radius, vec2_length(diff));
                Vec2Q16 separation = vec2_mul_scalar(collision_normal, q16_div(overlap, Q16_FROM_INT(2)));
                
                ship1->position = vec2_sub(ship1->position, separation);
                ship2->position = vec2_add(ship2->position, separation);
                
                // Exchange some velocity (simplified)
                q16_t rel_velocity = vec2_dot(vec2_sub(ship2->velocity, ship1->velocity), collision_normal);
                if (rel_velocity < 0) { // Ships are approaching
                    Vec2Q16 impulse = vec2_mul_scalar(collision_normal, q16_mul(rel_velocity, Q16_FROM_FLOAT(0.5f)));
                    ship1->velocity = vec2_add(ship1->velocity, impulse);
                    ship2->velocity = vec2_sub(ship2->velocity, impulse);
                }
                
                log_debug("Ship collision: %u <-> %u", ship1->id, ship2->id);
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

static entity_id allocate_entity_id(struct Sim* sim) {
    // Simple incremental ID allocation
    static entity_id next_id = 1;
    
    (void)sim; // Unused parameter
    
    if (next_id == INVALID_ENTITY_ID) {
        log_error("Entity ID overflow");
        return INVALID_ENTITY_ID;
    }
    
    return next_id++;
}

// Network integration functions
entity_id simulation_create_player_entity(struct Sim* sim, const char* player_name) {
    if (!sim || !player_name) return INVALID_ENTITY_ID;
    
    // Create player at default spawn location
    Vec2Q16 spawn_pos = {Q16_FROM_INT(100), Q16_FROM_INT(100)};
    
    // First create a ship for the player
    entity_id ship_id = sim_create_ship(sim, spawn_pos, Q16_FROM_INT(0));
    if (ship_id == INVALID_ENTITY_ID) return INVALID_ENTITY_ID;
    
    // Then create the player entity linked to the ship
    entity_id player_id = sim_create_player(sim, spawn_pos, ship_id);
    if (player_id == INVALID_ENTITY_ID) {
        // Failed to create player - clean up ship
        sim_destroy_entity(sim, ship_id);
        return INVALID_ENTITY_ID;
    }
    
    // Store player name (if we had storage for it)
    log_info("Created player entity %u (%s) with ship %u", player_id, player_name, ship_id);
    
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
void handle_projectile_collisions(struct Sim* sim) {
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        struct Projectile* proj = &sim->projectiles[i];
        
        // Get spatial cell for projectile
        int32_t cell_x = Q16_TO_INT(proj->position.x) / 1024;
        int32_t cell_y = Q16_TO_INT(proj->position.y) / 1024;
        
        if (cell_x < 0 || cell_y < 0 || cell_x >= SPATIAL_HASH_SIZE || cell_y >= SPATIAL_HASH_SIZE) {
            continue; // Out of bounds
        }
        
        uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
        struct SpatialCell* cell = &sim->spatial_hash[hash_index];
        
        // Check collision with ships in this cell
        for (uint16_t j = 0; j < cell->ship_count; j++) {
            struct Ship* ship = cell->ships[j];
            if (ship->id == proj->owner_id) continue; // Can't hit own ship
            
            // Simple distance check (ship radius ~50 units)
            q16_t dx = ship->position.x - proj->position.x;
            q16_t dy = ship->position.y - proj->position.y;
            q16_t dist_sq = q16_mul(dx, dx) + q16_mul(dy, dy);
            q16_t hit_radius_sq = Q16_FROM_INT(50 * 50); // 50 unit radius
            
            if (dist_sq < hit_radius_sq) {
                // Hit! Apply damage and remove projectile
                ship->hull_health = ship->hull_health > proj->damage ? 
                                   ship->hull_health - proj->damage : 0;
                
                log_info("🎯 Projectile %u hit ship %u for %d damage (hull: %d)", 
                        proj->id, ship->id, Q16_TO_INT(proj->damage), 
                        Q16_TO_INT(ship->hull_health));
                
                // Mark projectile for removal
                proj->lifetime = 0;
            }
        }
        
        // Check collision with players
        for (uint16_t j = 0; j < cell->player_count; j++) {
            struct Player* player = cell->players[j];
            if (player->id == proj->owner_id) continue; // Can't hit self
            
            q16_t dx = player->position.x - proj->position.x;
            q16_t dy = player->position.y - proj->position.y;
            q16_t dist_sq = q16_mul(dx, dx) + q16_mul(dy, dy);
            q16_t hit_radius_sq = Q16_FROM_INT(16 * 16); // Smaller player radius
            
            if (dist_sq < hit_radius_sq) {
                // Player hit! Apply damage
                player->health = player->health > proj->damage ? 
                                player->health - proj->damage : 0;
                
                log_info("💀 Projectile %u hit player %u for %d damage (health: %d)", 
                        proj->id, player->id, Q16_TO_INT(proj->damage), 
                        Q16_TO_INT(player->health));
                
                proj->lifetime = 0; // Remove projectile
            }
        }
    }
}

void handle_player_ship_collisions(struct Sim* sim) {
    for (uint16_t i = 0; i < sim->player_count; i++) {
        struct Player* player = &sim->players[i];
        
        // Get spatial cell
        int32_t cell_x = Q16_TO_INT(player->position.x) / 1024;
        int32_t cell_y = Q16_TO_INT(player->position.y) / 1024;
        
        if (cell_x < 0 || cell_y < 0 || cell_x >= SPATIAL_HASH_SIZE || cell_y >= SPATIAL_HASH_SIZE) {
            continue;
        }
        
        uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
        struct SpatialCell* cell = &sim->spatial_hash[hash_index];
        
        // Check collision with ships
        for (uint16_t j = 0; j < cell->ship_count; j++) {
            struct Ship* ship = cell->ships[j];
            
            // Distance check for ship boarding/landing
            q16_t dx = ship->position.x - player->position.x;
            q16_t dy = ship->position.y - player->position.y;
            q16_t dist_sq = q16_mul(dx, dx) + q16_mul(dy, dy);
            q16_t board_radius_sq = Q16_FROM_INT(60 * 60); // Boarding range
            
            if (dist_sq < board_radius_sq) {
                // Player is near ship - handle boarding logic
                if (player->ship_id == INVALID_ENTITY_ID && ship->id != player->id) {
                    // Player not on ship and this isn't their ship - potential boarding
                    if (player->action_flags & PLAYER_ACTION_BOARD) {
                        player->ship_id = ship->id;
                        log_info("🏴‍☠️ Player %u boarded ship %u", player->id, ship->id);
                    }
                } else if (player->ship_id == ship->id) {
                    // Player is on this ship - sync position relative to ship
                    // This keeps player "attached" to the moving ship
                    player->position.x = ship->position.x + player->relative_pos.x;
                    player->position.y = ship->position.y + player->relative_pos.y;
                }
            } else {
                // Player moved away from ship
                if (player->ship_id == ship->id) {
                    // Player fell off or jumped off
                    player->ship_id = INVALID_ENTITY_ID;
                    log_info("🌊 Player %u left ship %u", player->id, ship->id);
                }
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