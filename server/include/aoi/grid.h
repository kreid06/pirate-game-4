#ifndef AOI_GRID_H
#define AOI_GRID_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"
#include "sim/types.h"

// AOI configuration
#define AOI_CELL_SIZE_Q16 Q16_FROM_FLOAT(64.0f)  // 64m cells
#define AOI_GRID_WIDTH 128   // 8192m world (64m * 128)
#define AOI_GRID_HEIGHT 128  // 8192m world
#define AOI_MAX_ENTITIES_PER_CELL 32

// AOI priority tiers for update frequency
typedef enum {
    AOI_TIER_HIGH = 0,    // Top-N=8, 30 Hz
    AOI_TIER_MID = 1,     // Next-N=16, 15 Hz  
    AOI_TIER_LOW = 2,     // Remaining=8, 5 Hz
    AOI_TIER_COUNT = 3
} aoi_tier_t;

// AOI cell containing entities
struct AOICell {
    entity_id entities[AOI_MAX_ENTITIES_PER_CELL];
    uint8_t entity_count;
    uint8_t flags;
    uint16_t revision; // For tracking changes
};

// AOI grid system
struct AOIGrid {
    struct AOICell cells[AOI_GRID_HEIGHT][AOI_GRID_WIDTH];
    uint32_t total_entities;
    uint32_t update_revision;
};

// Per-player subscription state
struct AOISubscription {
    entity_id player_id;
    uint16_t cell_x, cell_y;        // Current cell
    entity_id subscribed_entities[32]; // Currently tracked
    aoi_tier_t tier_assignments[32];   // Priority tier per entity
    uint8_t subscription_count;
    uint32_t last_update_time[AOI_TIER_COUNT]; // Per-tier timestamps
};

// AOI system functions
int aoi_init(struct AOIGrid* grid);
void aoi_cleanup(struct AOIGrid* grid);

// Entity management
void aoi_insert_entity(struct AOIGrid* grid, entity_id id, Vec2Q16 position);
void aoi_remove_entity(struct AOIGrid* grid, entity_id id, Vec2Q16 position);
void aoi_update_entity(struct AOIGrid* grid, entity_id id, Vec2Q16 old_pos, Vec2Q16 new_pos);

// Spatial queries
int aoi_query_radius(const struct AOIGrid* grid, Vec2Q16 center, q16_t radius,
                     entity_id* out_entities, int max_entities);
int aoi_query_cells(const struct AOIGrid* grid, uint16_t center_x, uint16_t center_y, 
                    uint8_t radius_cells, entity_id* out_entities, int max_entities);

// Subscription management
int aoi_subscription_init(struct AOISubscription* sub, entity_id player_id);
void aoi_update_subscription(struct AOISubscription* sub, const struct AOIGrid* grid,
                            Vec2Q16 player_position, uint32_t current_time);

// Helper functions
static inline void aoi_world_to_cell(Vec2Q16 world_pos, uint16_t* cell_x, uint16_t* cell_y) {
    // Convert world position to cell coordinates
    int32_t x = Q16_TO_INT(q16_div(world_pos.x, AOI_CELL_SIZE_Q16)) + (AOI_GRID_WIDTH / 2);
    int32_t y = Q16_TO_INT(q16_div(world_pos.y, AOI_CELL_SIZE_Q16)) + (AOI_GRID_HEIGHT / 2);
    
    // Clamp to grid bounds
    if (x < 0) x = 0;
    if (x >= AOI_GRID_WIDTH) x = AOI_GRID_WIDTH - 1;
    if (y < 0) y = 0;
    if (y >= AOI_GRID_HEIGHT) y = AOI_GRID_HEIGHT - 1;
    
    *cell_x = (uint16_t)x;
    *cell_y = (uint16_t)y;
}

static inline Vec2Q16 aoi_cell_to_world(uint16_t cell_x, uint16_t cell_y) {
    // Convert cell coordinates to world position (cell center)
    q16_t world_x = q16_mul(Q16_FROM_INT((int32_t)cell_x - (AOI_GRID_WIDTH / 2)), AOI_CELL_SIZE_Q16);
    q16_t world_y = q16_mul(Q16_FROM_INT((int32_t)cell_y - (AOI_GRID_HEIGHT / 2)), AOI_CELL_SIZE_Q16);
    
    return (Vec2Q16){world_x, world_y};
}

#endif /* AOI_GRID_H */