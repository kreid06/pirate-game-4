#ifndef CORE_HASH_H
#define CORE_HASH_H

#include <stdint.h>
#include <stddef.h>

// State hashing for determinism validation
// Uses xxHash64 if available, otherwise falls back to FNV-1a

uint64_t hash_init(void);
uint64_t hash_update(uint64_t hash, const void* data, size_t size);
uint64_t hash_finalize(uint64_t hash);

// Convenience function for single-shot hashing
uint64_t hash_data(const void* data, size_t size);

// Specialized hash functions for simulation state
uint64_t hash_sim_state(const struct Sim* sim);

#endif /* CORE_HASH_H */