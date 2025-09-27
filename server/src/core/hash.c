#include "core/hash.h"
#include "sim/types.h"

#ifdef HAVE_XXHASH
#include <xxhash.h>
#define USE_XXHASH 1
#else
#define USE_XXHASH 0
#endif

// FNV-1a constants for 64-bit
#define FNV_OFFSET_BASIS 14695981039346656037ULL
#define FNV_PRIME 1099511628211ULL

uint64_t hash_init(void) {
#if USE_XXHASH
    return 0; // xxHash uses separate state
#else
    return FNV_OFFSET_BASIS;
#endif
}

uint64_t hash_update(uint64_t hash, const void* data, size_t size) {
    if (!data || size == 0) return hash;
    
#if USE_XXHASH
    // For xxHash, we'll use single-shot hashing in hash_finalize
    // This is a simplified implementation
    (void)hash;
    return XXH64(data, size, 0);
#else
    // FNV-1a hash implementation
    const uint8_t* bytes = (const uint8_t*)data;
    for (size_t i = 0; i < size; i++) {
        hash ^= bytes[i];
        hash *= FNV_PRIME;
    }
    return hash;
#endif
}

uint64_t hash_finalize(uint64_t hash) {
    return hash; // No finalization needed for FNV-1a or this xxHash usage
}

uint64_t hash_data(const void* data, size_t size) {
#if USE_XXHASH
    return XXH64(data, size, 0);
#else
    uint64_t hash = hash_init();
    hash = hash_update(hash, data, size);
    return hash_finalize(hash);
#endif
}

uint64_t hash_sim_state(const struct Sim* sim) {
    if (!sim) return 0;
    
    uint64_t hash = hash_init();
    
    // Hash simulation metadata in deterministic order
    hash = hash_update(hash, &sim->tick, sizeof(sim->tick));
    hash = hash_update(hash, &sim->time_ms, sizeof(sim->time_ms));
    
    // Hash RNG state
    uint64_t rng_hash = rng_hash_state(&sim->rng);
    hash = hash_update(hash, &rng_hash, sizeof(rng_hash));
    
    // Hash entity counts
    hash = hash_update(hash, &sim->ship_count, sizeof(sim->ship_count));
    hash = hash_update(hash, &sim->player_count, sizeof(sim->player_count));
    hash = hash_update(hash, &sim->projectile_count, sizeof(sim->projectile_count));
    
    // Hash ships in ID order (they should already be sorted)
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        const struct Ship* ship = &sim->ships[i];
        
        // Hash critical state fields
        hash = hash_update(hash, &ship->id, sizeof(ship->id));
        hash = hash_update(hash, &ship->position, sizeof(ship->position));
        hash = hash_update(hash, &ship->velocity, sizeof(ship->velocity));
        hash = hash_update(hash, &ship->rotation, sizeof(ship->rotation));
        hash = hash_update(hash, &ship->angular_velocity, sizeof(ship->angular_velocity));
        hash = hash_update(hash, &ship->health, sizeof(ship->health));
        hash = hash_update(hash, &ship->flags, sizeof(ship->flags));
    }
    
    // Hash players in ID order
    for (uint16_t i = 0; i < sim->player_count; i++) {
        const struct Player* player = &sim->players[i];
        
        hash = hash_update(hash, &player->id, sizeof(player->id));
        hash = hash_update(hash, &player->ship_id, sizeof(player->ship_id));
        hash = hash_update(hash, &player->position, sizeof(player->position));
        hash = hash_update(hash, &player->velocity, sizeof(player->velocity));
        hash = hash_update(hash, &player->health, sizeof(player->health));
        hash = hash_update(hash, &player->flags, sizeof(player->flags));
        hash = hash_update(hash, &player->actions, sizeof(player->actions));
    }
    
    // Hash projectiles in ID order
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        const struct Projectile* proj = &sim->projectiles[i];
        
        hash = hash_update(hash, &proj->id, sizeof(proj->id));
        hash = hash_update(hash, &proj->shooter_id, sizeof(proj->shooter_id));
        hash = hash_update(hash, &proj->position, sizeof(proj->position));
        hash = hash_update(hash, &proj->velocity, sizeof(proj->velocity));
        hash = hash_update(hash, &proj->spawn_time, sizeof(proj->spawn_time));
        hash = hash_update(hash, &proj->damage, sizeof(proj->damage));
        hash = hash_update(hash, &proj->type, sizeof(proj->type));
    }
    
    // Hash physics constants
    hash = hash_update(hash, &sim->water_friction, sizeof(sim->water_friction));
    hash = hash_update(hash, &sim->air_friction, sizeof(sim->air_friction));
    hash = hash_update(hash, &sim->buoyancy_factor, sizeof(sim->buoyancy_factor));
    
    return hash_finalize(hash);
}