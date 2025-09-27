#include "aoi/grid.h"
#include "util/log.h"
#include <string.h>

int aoi_init(struct AOIGrid* grid) {
    if (!grid) return -1;
    
    // Clear all cells
    memset(grid, 0, sizeof(struct AOIGrid));
    
    log_info("AOI grid initialized: %dx%d cells, %.1fm cell size", 
             AOI_GRID_WIDTH, AOI_GRID_HEIGHT, Q16_TO_FLOAT(AOI_CELL_SIZE_Q16));
    
    return 0;
}

void aoi_cleanup(struct AOIGrid* grid) {
    if (!grid) return;
    
    memset(grid, 0, sizeof(struct AOIGrid));
    log_info("AOI grid cleaned up");
}

void aoi_insert_entity(struct AOIGrid* grid, entity_id id, Vec2Q16 position) {
    if (!grid || id == INVALID_ENTITY_ID) return;
    
    uint16_t cell_x, cell_y;
    aoi_world_to_cell(position, &cell_x, &cell_y);
    
    struct AOICell* cell = &grid->cells[cell_y][cell_x];
    
    // Check if cell has space
    if (cell->entity_count >= AOI_MAX_ENTITIES_PER_CELL) {
        log_warn("AOI cell (%u,%u) full, cannot insert entity %u", cell_x, cell_y, id);
        return;
    }
    
    // Check if entity already exists in cell
    for (uint8_t i = 0; i < cell->entity_count; i++) {
        if (cell->entities[i] == id) {
            log_debug("Entity %u already in cell (%u,%u)", id, cell_x, cell_y);
            return;
        }
    }
    
    // Add entity to cell
    cell->entities[cell->entity_count] = id;
    cell->entity_count++;
    cell->revision++;
    
    grid->total_entities++;
    grid->update_revision++;
    
    log_debug("Inserted entity %u into cell (%u,%u)", id, cell_x, cell_y);
}

void aoi_remove_entity(struct AOIGrid* grid, entity_id id, Vec2Q16 position) {
    if (!grid || id == INVALID_ENTITY_ID) return;
    
    uint16_t cell_x, cell_y;
    aoi_world_to_cell(position, &cell_x, &cell_y);
    
    struct AOICell* cell = &grid->cells[cell_y][cell_x];
    
    // Find and remove entity
    for (uint8_t i = 0; i < cell->entity_count; i++) {
        if (cell->entities[i] == id) {
            // Shift remaining entities down
            memmove(&cell->entities[i], &cell->entities[i + 1],
                   (cell->entity_count - i - 1) * sizeof(entity_id));
            cell->entity_count--;
            cell->revision++;
            
            grid->total_entities--;
            grid->update_revision++;
            
            log_debug("Removed entity %u from cell (%u,%u)", id, cell_x, cell_y);
            return;
        }
    }
    
    log_warn("Entity %u not found in expected cell (%u,%u)", id, cell_x, cell_y);
}

void aoi_update_entity(struct AOIGrid* grid, entity_id id, Vec2Q16 old_pos, Vec2Q16 new_pos) {
    if (!grid || id == INVALID_ENTITY_ID) return;
    
    uint16_t old_x, old_y, new_x, new_y;
    aoi_world_to_cell(old_pos, &old_x, &old_y);
    aoi_world_to_cell(new_pos, &new_x, &new_y);
    
    // If entity stayed in same cell, no AOI update needed
    if (old_x == new_x && old_y == new_y) {
        return;
    }
    
    // Remove from old cell and add to new cell
    aoi_remove_entity(grid, id, old_pos);
    aoi_insert_entity(grid, id, new_pos);
}

int aoi_query_radius(const struct AOIGrid* grid, Vec2Q16 center, q16_t radius,
                     entity_id* out_entities, int max_entities) {
    if (!grid || !out_entities || max_entities <= 0) return 0;
    
    // Convert radius to cell count
    uint8_t radius_cells = (uint8_t)(Q16_TO_INT(q16_div(radius, AOI_CELL_SIZE_Q16)) + 1);
    
    uint16_t center_x, center_y;
    aoi_world_to_cell(center, &center_x, &center_y);
    
    return aoi_query_cells(grid, center_x, center_y, radius_cells, out_entities, max_entities);
}

int aoi_query_cells(const struct AOIGrid* grid, uint16_t center_x, uint16_t center_y, 
                    uint8_t radius_cells, entity_id* out_entities, int max_entities) {
    if (!grid || !out_entities || max_entities <= 0) return 0;
    
    int entity_count = 0;
    
    // Search in square around center
    int16_t min_x = (int16_t)center_x - radius_cells;
    int16_t max_x = (int16_t)center_x + radius_cells;
    int16_t min_y = (int16_t)center_y - radius_cells;
    int16_t max_y = (int16_t)center_y + radius_cells;
    
    // Clamp to grid bounds
    if (min_x < 0) min_x = 0;
    if (max_x >= AOI_GRID_WIDTH) max_x = AOI_GRID_WIDTH - 1;
    if (min_y < 0) min_y = 0;
    if (max_y >= AOI_GRID_HEIGHT) max_y = AOI_GRID_HEIGHT - 1;
    
    // Iterate through cells and collect entities
    for (int16_t y = min_y; y <= max_y; y++) {
        for (int16_t x = min_x; x <= max_x; x++) {
            const struct AOICell* cell = &grid->cells[y][x];
            
            for (uint8_t i = 0; i < cell->entity_count && entity_count < max_entities; i++) {
                // Avoid duplicates (shouldn't happen but be safe)
                bool duplicate = false;
                for (int j = 0; j < entity_count; j++) {
                    if (out_entities[j] == cell->entities[i]) {
                        duplicate = true;
                        break;
                    }
                }
                
                if (!duplicate) {
                    out_entities[entity_count++] = cell->entities[i];
                }
            }
        }
    }
    
    return entity_count;
}

int aoi_subscription_init(struct AOISubscription* sub, entity_id player_id) {
    if (!sub || player_id == INVALID_ENTITY_ID) return -1;
    
    memset(sub, 0, sizeof(struct AOISubscription));
    sub->player_id = player_id;
    
    return 0;
}

void aoi_update_subscription(struct AOISubscription* sub, const struct AOIGrid* grid,
                            Vec2Q16 player_position, uint32_t current_time) {
    if (!sub || !grid) return;
    
    // Update player's current cell
    aoi_world_to_cell(player_position, &sub->cell_x, &sub->cell_y);
    
    // Query nearby entities (3x3 cell area = ~192m radius)
    entity_id nearby_entities[96]; // 32 entities * 3 cells
    int nearby_count = aoi_query_cells(grid, sub->cell_x, sub->cell_y, 1, 
                                      nearby_entities, sizeof(nearby_entities)/sizeof(nearby_entities[0]));
    
    // Reset subscription
    sub->subscription_count = 0;
    
    // Assign entities to priority tiers based on distance/importance
    // For now, simple distance-based assignment
    for (int i = 0; i < nearby_count && sub->subscription_count < 32; i++) {
        entity_id id = nearby_entities[i];
        
        if (id == sub->player_id) continue; // Don't subscribe to self
        
        // Assign tier based on position in list (closer = higher priority)
        aoi_tier_t tier;
        if (i < 8) {
            tier = AOI_TIER_HIGH;
        } else if (i < 24) {
            tier = AOI_TIER_MID;
        } else {
            tier = AOI_TIER_LOW;
        }
        
        sub->subscribed_entities[sub->subscription_count] = id;
        sub->tier_assignments[sub->subscription_count] = tier;
        sub->subscription_count++;
    }
    
    // Update tier timestamps
    for (int tier = 0; tier < AOI_TIER_COUNT; tier++) {
        sub->last_update_time[tier] = current_time;
    }
}