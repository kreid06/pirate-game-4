#include "core/rng.h"
#include <string.h>
#include <math.h>
#include <stdbool.h>

// xorshift64* algorithm - fast and good quality for games
void rng_seed(struct RNGState* rng, uint32_t seed) {
    if (!rng) return;
    
    // Ensure seed is never zero (xorshift requirement)
    if (seed == 0) seed = 1;
    
    rng->seed = seed;
    rng->state = seed;
    rng->calls = 0;
    
    // Mix the initial state to avoid poor initial sequences
    for (int i = 0; i < 4; i++) {
        rng_next(rng);
    }
    rng->calls = 0; // Reset call counter after mixing
}

uint32_t rng_next(struct RNGState* rng) {
    if (!rng) return 0;
    
    // xorshift64*
    rng->state ^= rng->state >> 12;
    rng->state ^= rng->state << 25;
    rng->state ^= rng->state >> 27;
    rng->calls++;
    
    return (uint32_t)((rng->state * 0x2545F4914F6CDD1DULL) >> 32);
}

uint32_t rng_range(struct RNGState* rng, uint32_t min, uint32_t max) {
    if (!rng || min >= max) return min;
    
    uint32_t range = max - min;
    uint32_t random = rng_next(rng);
    
    // Use modulo with bias rejection for uniform distribution
    uint32_t limit = UINT32_MAX - (UINT32_MAX % range);
    while (random >= limit) {
        random = rng_next(rng);
    }
    
    return min + (random % range);
}

float rng_float(struct RNGState* rng) {
    if (!rng) return 0.0f;
    
    uint32_t random = rng_next(rng);
    // Convert to [0.0, 1.0) range
    return (float)random / (float)UINT32_MAX;
}

float rng_gaussian(struct RNGState* rng, float mean, float stddev) {
    if (!rng) return mean;
    
    // Box-Muller transform for Gaussian distribution
    static bool has_spare = false;
    static float spare;
    
    if (has_spare) {
        has_spare = false;
        return spare * stddev + mean;
    }
    
    has_spare = true;
    
    float u = rng_float(rng);
    float v = rng_float(rng);
    
    // Avoid log(0) by clamping u
    if (u < 1e-7f) u = 1e-7f;
    
    float mag = stddev * sqrtf(-2.0f * logf(u));
    spare = mag * cosf(2.0f * 3.14159265359f * v);
    
    return mag * sinf(2.0f * 3.14159265359f * v) + mean;
}

void rng_save_state(const struct RNGState* rng, uint8_t* buffer, size_t buffer_size) {
    if (!rng || !buffer || buffer_size < sizeof(struct RNGState)) {
        return;
    }
    
    memcpy(buffer, rng, sizeof(struct RNGState));
}

void rng_load_state(struct RNGState* rng, const uint8_t* buffer, size_t buffer_size) {
    if (!rng || !buffer || buffer_size < sizeof(struct RNGState)) {
        return;
    }
    
    memcpy(rng, buffer, sizeof(struct RNGState));
}

uint64_t rng_hash_state(const struct RNGState* rng) {
    if (!rng) return 0;
    
    // Simple hash of the RNG state for determinism verification
    uint64_t hash = rng->state;
    hash ^= (uint64_t)rng->seed << 32;
    hash ^= rng->calls;
    
    return hash;
}