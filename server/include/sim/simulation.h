#ifndef SIM_SIMULATION_H
#define SIM_SIMULATION_H

#include "types.h"
#include "core/math.h"
#include "core/rng.h"

// Forward declarations
struct CmdPacket;

// Simulation initialization and lifecycle
int sim_init(struct Sim* sim, const struct SimConfig* config);
void sim_cleanup(struct Sim* sim);

// Main simulation step (deterministic)
void sim_step(struct Sim* sim, q16_t dt);

// State management
uint64_t sim_state_hash(const struct Sim* sim);
void sim_serialize_state(const struct Sim* sim, uint8_t* buffer, size_t* buffer_size);
int sim_deserialize_state(struct Sim* sim, const uint8_t* buffer, size_t buffer_size);

// Entity management
entity_id sim_create_ship(struct Sim* sim, Vec2Q16 position, q16_t rotation);
entity_id sim_create_player(struct Sim* sim, Vec2Q16 position, entity_id ship_id);
entity_id sim_create_projectile(struct Sim* sim, Vec2Q16 position, Vec2Q16 velocity, entity_id shooter_id);

bool sim_destroy_entity(struct Sim* sim, entity_id id);
struct Ship* sim_get_ship(struct Sim* sim, entity_id id);
struct Player* sim_get_player(struct Sim* sim, entity_id id);
struct Projectile* sim_get_projectile(struct Sim* sim, entity_id id);

// Input processing
void sim_process_input(struct Sim* sim, const struct InputCmd* cmd);

// Network integration functions
entity_id simulation_create_player_entity(struct Sim* sim, const char* player_name);
bool simulation_has_entity(const struct Sim* sim, entity_id entity_id);
int simulation_process_player_input(struct Sim* sim, entity_id player_id, const struct CmdPacket* cmd);

// Compatibility aliases for network integration
#define simulation_init sim_init
#define simulation_cleanup sim_cleanup  
#define simulation_step(sim) sim_step(sim, FIXED_DT_Q16)

// Physics subsystems
void sim_update_ships(struct Sim* sim, q16_t dt);
void sim_update_players(struct Sim* sim, q16_t dt);
void sim_update_projectiles(struct Sim* sim, q16_t dt);
void sim_handle_collisions(struct Sim* sim);

#endif /* SIM_SIMULATION_H */