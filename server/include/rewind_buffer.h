/**
 * Rewind Buffer - Server-Side Lag Compensation
 * Week 3-4: Implements 16-frame ring buffer for hit validation
 */

#ifndef REWIND_BUFFER_H
#define REWIND_BUFFER_H

#include <stdint.h>
#include <stdbool.h>
#include <math.h>

// Forward declarations
#ifndef MAX_CLIENTS
#define MAX_CLIENTS 32
#endif

// Basic math types for rewind buffer (separate namespace to avoid conflicts)
typedef struct {
    float x, y;
} rewind_vec2_t;

// Simplified simulation types for rewind buffer
typedef struct {
    uint32_t id;
    rewind_vec2_t position;
    rewind_vec2_t velocity;
    float health;
    float rotation;
} rewind_ship_t;

typedef struct {
    uint32_t id;
    rewind_vec2_t position;
    rewind_vec2_t velocity;
    uint32_t ship_id;
} rewind_player_t;

typedef struct {
    uint32_t id;
    rewind_vec2_t position;
    rewind_vec2_t velocity;
    rewind_vec2_t firingVelocity;
    uint32_t owner_id;
} rewind_cannonball_t;

typedef struct {
    uint32_t tick;
    float time;
    int num_ships;
    int num_players;
    int num_cannonballs;
    rewind_ship_t ships[16];
    rewind_player_t players[MAX_CLIENTS];
    rewind_cannonball_t cannonballs[64];
} rewind_simulation_state_t;

// Helper functions with rewind_ prefix to avoid conflicts
static inline rewind_vec2_t rewind_vec2_create(float x, float y) {
    rewind_vec2_t v = {x, y};
    return v;
}

static inline rewind_vec2_t rewind_vec2_add(rewind_vec2_t a, rewind_vec2_t b) {
    return rewind_vec2_create(a.x + b.x, a.y + b.y);
}

static inline rewind_vec2_t rewind_vec2_sub(rewind_vec2_t a, rewind_vec2_t b) {
    return rewind_vec2_create(a.x - b.x, a.y - b.y);
}

static inline rewind_vec2_t rewind_vec2_scale(rewind_vec2_t v, float s) {
    return rewind_vec2_create(v.x * s, v.y * s);
}

static inline float rewind_vec2_distance(rewind_vec2_t a, rewind_vec2_t b) {
    float dx = a.x - b.x;
    float dy = a.y - b.y;
    return sqrtf(dx * dx + dy * dy);
}

static inline float rewind_vec2_length(rewind_vec2_t v) {
    return sqrtf(v.x * v.x + v.y * v.y);
}

// Time function declaration (will be implemented elsewhere)
// uint64_t get_time_ms(void);  // Commented out to avoid conflicts

// Player constants
#define PLAYER_MAX_SPEED 5.0f

// Rewind buffer constants
#define REWIND_BUFFER_SIZE 16        // 16 frames = ~350ms at 45Hz
#define MAX_REWIND_TIME_MS 350       // Maximum rewind time in milliseconds

/**
 * Rewind buffer entry containing historical game state
 */
typedef struct {
    uint32_t tick;                   // Server tick number
    uint64_t timestamp;              // Timestamp in milliseconds
    rewind_simulation_state_t state; // Complete simulation state
    bool valid;                      // Entry is valid and can be used
    float network_delays[MAX_CLIENTS]; // Per-client network delays
} rewind_entry_t;

/**
 * Ring buffer for storing historical states
 */
typedef struct {
    rewind_entry_t entries[REWIND_BUFFER_SIZE];
    int current_index;               // Current write position
    int valid_entries;               // Number of valid entries
    uint32_t oldest_tick;           // Oldest valid tick in buffer
    uint32_t newest_tick;           // Newest valid tick in buffer
    
    // Statistics
    uint64_t total_rewinds;
    uint64_t successful_rewinds;
    uint64_t failed_rewinds;
    float average_rewind_distance;
} rewind_buffer_t;

/**
 * Hit validation result
 */
typedef struct {
    bool hit_valid;                  // Hit was valid at rewind time
    rewind_vec2_t hit_position;      // Position where hit occurred
    uint32_t target_ship_id;        // ID of ship that was hit
    float damage_dealt;             // Damage that should be applied
    uint32_t rewind_tick;           // Tick that was rewound to
    float rewind_time_ms;           // How far back we rewound
} hit_validation_result_t;

/**
 * Movement validation envelope
 */
typedef struct {
    rewind_vec2_t min_position;      // Minimum possible position
    rewind_vec2_t max_position;      // Maximum possible position
    rewind_vec2_t expected_position; // Expected position
    float tolerance;                // Position tolerance
    bool position_valid;            // Position is within envelope
} movement_envelope_t;

// Function declarations

/**
 * Initialize rewind buffer system
 */
void rewind_buffer_init(rewind_buffer_t* buffer);

/**
 * Store current simulation state in rewind buffer
 */
void rewind_buffer_store(rewind_buffer_t* buffer, uint32_t tick, 
                        const void* state,  // Generic state pointer
                        const float* network_delays);

/**
 * Get state from specific tick for hit validation
 */
const rewind_entry_t* rewind_buffer_get_state(const rewind_buffer_t* buffer, 
                                              uint32_t tick);

/**
 * Validate hit against historical state
 */
hit_validation_result_t rewind_buffer_validate_hit(const rewind_buffer_t* buffer,
                                                  uint32_t client_id,
                                                  uint32_t reported_tick,
                                                  rewind_vec2_t shot_origin,
                                                  rewind_vec2_t shot_direction,
                                                  float shot_range);

/**
 * Validate player movement against physics envelope
 */
movement_envelope_t rewind_buffer_validate_movement(const rewind_buffer_t* buffer,
                                                   uint32_t player_id,
                                                   uint32_t from_tick,
                                                   uint32_t to_tick,
                                                   rewind_vec2_t reported_position);

/**
 * Get rewind buffer statistics
 */
void rewind_buffer_get_stats(const rewind_buffer_t* buffer,
                            uint64_t* total_rewinds,
                            uint64_t* successful_rewinds,
                            float* average_rewind_distance,
                            int* buffer_utilization);

/**
 * Clean up old entries (called periodically)
 */
void rewind_buffer_cleanup(rewind_buffer_t* buffer, uint32_t current_tick);

/**
 * Check if rewind buffer can handle the requested rewind
 */
bool rewind_buffer_can_rewind(const rewind_buffer_t* buffer, uint32_t target_tick);

#endif // REWIND_BUFFER_H