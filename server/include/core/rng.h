#ifndef CORE_RNG_H
#define CORE_RNG_H

#include <stdint.h>

// Deterministic RNG state for replay consistency
struct RNGState {
    uint64_t state;
    uint32_t seed;
    uint32_t calls; // For debugging/replay verification
};

// Initialize RNG with seed
void rng_seed(struct RNGState* rng, uint32_t seed);

// Generate next random number (xorshift64)
uint32_t rng_next(struct RNGState* rng);

// Utility functions for common distributions
uint32_t rng_range(struct RNGState* rng, uint32_t min, uint32_t max);
float rng_float(struct RNGState* rng); // [0.0, 1.0)
float rng_gaussian(struct RNGState* rng, float mean, float stddev);

// State management for replay/determinism validation
void rng_save_state(const struct RNGState* rng, uint8_t* buffer, size_t buffer_size);
void rng_load_state(struct RNGState* rng, const uint8_t* buffer, size_t buffer_size);
uint64_t rng_hash_state(const struct RNGState* rng);

#endif /* CORE_RNG_H */