#include "net/snapshot.h"
#include "util/log.h"
#include <string.h>
#include <assert.h>

// Helper functions
static struct PlayerSnapshotState* find_player_state(struct SnapshotManager* mgr, entity_id player_id);
static void quantize_entity_data(const struct Ship* ship, struct EntitySnapshot* snap);
static void quantize_player_data(const struct Player* player, struct EntitySnapshot* snap);
static void quantize_projectile_data(const struct Projectile* proj, struct EntitySnapshot* snap);
static uint16_t calculate_delta_size(const struct EntityDelta* delta);
static bool entities_differ(const struct EntitySnapshot* a, const struct EntitySnapshot* b);
static void create_entity_delta(const struct EntitySnapshot* baseline, 
                                const struct EntitySnapshot* current,
                                struct EntityDelta* delta);
static size_t apply_delta_compression(const struct EntitySnapshot* baseline, 
                                      const struct EntitySnapshot* entities, 
                                      uint16_t entity_count,
                                      uint8_t* output_buffer,
                                      size_t buffer_size);

int snapshot_manager_init(struct SnapshotManager* mgr) {
    if (!mgr) return -1;
    
    memset(mgr, 0, sizeof(struct SnapshotManager));
    mgr->global_snapshot_id = 1;
    mgr->compression_ratio_percent = 100; // Start at no compression
    
    log_info("Snapshot manager initialized");
    return 0;
}

void snapshot_manager_cleanup(struct SnapshotManager* mgr) {
    if (!mgr) return;
    
    log_info("Snapshot manager stats - Sent: %u snapshots, %u total bytes, avg %u bytes/snapshot",
             mgr->total_snapshots_sent, mgr->total_bytes_sent, 
             mgr->total_snapshots_sent > 0 ? mgr->total_bytes_sent / mgr->total_snapshots_sent : 0);
    
    memset(mgr, 0, sizeof(struct SnapshotManager));
}

int snapshot_add_player(struct SnapshotManager* mgr, entity_id player_id) {
    if (!mgr || player_id == INVALID_ENTITY_ID) return -1;
    
    // Check if player already exists
    if (find_player_state(mgr, player_id) != NULL) {
        log_warn("Player %u already exists in snapshot manager", player_id);
        return 0;
    }
    
    // Find empty slot
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        if (mgr->players[i].player_id == INVALID_ENTITY_ID) {
            struct PlayerSnapshotState* state = &mgr->players[i];
            memset(state, 0, sizeof(struct PlayerSnapshotState));
            
            state->player_id = player_id;
            state->last_baseline_id = 0;
            state->last_baseline_time = 0;
            
            // Initialize AOI subscription
            aoi_subscription_init(&state->aoi_subscription, player_id);
            
            mgr->active_player_count++;
            
            log_debug("Added player %u to snapshot manager (slot %u)", player_id, i);
            return 0;
        }
    }
    
    log_error("No free slots for player %u in snapshot manager", player_id);
    return -1;
}

void snapshot_remove_player(struct SnapshotManager* mgr, entity_id player_id) {
    if (!mgr || player_id == INVALID_ENTITY_ID) return;
    
    struct PlayerSnapshotState* state = find_player_state(mgr, player_id);
    if (!state) {
        log_warn("Player %u not found for removal", player_id);
        return;
    }
    
    log_debug("Removed player %u from snapshot manager", player_id);
    memset(state, 0, sizeof(struct PlayerSnapshotState));
    mgr->active_player_count--;
}

struct PlayerSnapshotState* snapshot_get_player(struct SnapshotManager* mgr, entity_id player_id) {
    return find_player_state(mgr, player_id);
}

int snapshot_generate_for_player(struct SnapshotManager* mgr, const struct Sim* sim,
                                 const struct AOIGrid* aoi, entity_id player_id,
                                 uint32_t current_time, uint8_t* packet_buffer,
                                 size_t buffer_size, size_t* packet_size) {
    if (!mgr || !sim || !aoi || !packet_buffer || !packet_size) return -1;
    
    struct PlayerSnapshotState* player_state = find_player_state(mgr, player_id);
    if (!player_state) {
        log_warn("Player %u not found for snapshot generation", player_id);
        return -1;
    }
    
    // Get player entity for position
    struct Player* player = sim_get_player((struct Sim*)sim, player_id);
    if (!player) {
        log_warn("Player entity %u not found in simulation", player_id);
        return -1;
    }
    
    // Update AOI subscription
    aoi_update_subscription(&player_state->aoi_subscription, aoi, player->position, current_time);
    
    // Determine if we should send a baseline or delta snapshot
    bool send_baseline = false;
    uint32_t time_since_baseline = current_time - player_state->last_baseline_time;
    
    if (player_state->last_baseline_id == 0 || 
        (mgr->global_snapshot_id - player_state->last_baseline_id) >= SNAPSHOT_BASELINE_INTERVAL ||
        time_since_baseline > 1000) { // Force baseline every 1 second
        send_baseline = true;
    }
    
    struct SnapshotPacket* packet = (struct SnapshotPacket*)packet_buffer;
    memset(packet, 0, sizeof(struct SnapshotPacket));
    
    // Fill header
    packet->header.type = PACKET_SERVER_SNAPSHOT;
    packet->header.version = PROTOCOL_VERSION;
    packet->header.server_time = current_time;
    packet->header.snap_id = mgr->global_snapshot_id++;
    packet->header.aoi_cell = (uint16_t)(player_state->aoi_subscription.cell_x << 8) | 
                              player_state->aoi_subscription.cell_y;
    
    if (send_baseline) {
        packet->header.base_id = packet->header.snap_id; // Self-referential baseline
        packet->header.flags = 0x01; // Baseline flag
        
        // Generate full entity snapshots
        uint16_t entity_count = 0;
        
        // Add subscribed entities based on AOI
        for (uint8_t i = 0; i < player_state->aoi_subscription.subscription_count && 
             entity_count < MAX_ENTITIES_PER_SNAPSHOT; i++) {
            
            entity_id entity_id = player_state->aoi_subscription.subscribed_entities[i];
            aoi_tier_t tier = player_state->aoi_subscription.tier_assignments[i];
            
            // Check if we should send this entity based on its tier frequency
            if (!should_send_snapshot_for_tier(tier, current_time, 
                                              player_state->last_snapshot_time[tier])) {
                continue;
            }
            
            // Try to find entity in simulation and convert to snapshot
            struct Ship* ship = sim_get_ship((struct Sim*)sim, entity_id);
            if (ship) {
                quantize_entity_data(ship, &packet->baseline_entities[entity_count]);
                entity_count++;
                continue;
            }
            
            struct Player* other_player = sim_get_player((struct Sim*)sim, entity_id);
            if (other_player) {
                quantize_player_data(other_player, &packet->baseline_entities[entity_count]);
                entity_count++;
                continue;
            }
            
            struct Projectile* proj = sim_get_projectile((struct Sim*)sim, entity_id);
            if (proj) {
                quantize_projectile_data(proj, &packet->baseline_entities[entity_count]);
                entity_count++;
                continue;
            }
        }
        
        packet->entity_count = entity_count;
        
        // Update baseline state
        player_state->last_baseline_id = packet->header.snap_id;
        player_state->last_baseline_time = current_time;
        memcpy(player_state->entity_baselines, packet->baseline_entities, 
               entity_count * sizeof(struct EntitySnapshot));
        player_state->baseline_count = entity_count;
        
        *packet_size = sizeof(struct SnapHeader) + sizeof(uint16_t) + 
                       entity_count * sizeof(struct EntitySnapshot);
        
        log_debug("Generated baseline snapshot for player %u: %u entities, %zu bytes",
                  player_id, entity_count, *packet_size);
        
    } else {
        // Generate delta snapshot
        packet->header.base_id = player_state->last_baseline_id;
        packet->header.flags = 0x02; // Delta flag
        
        uint16_t delta_count = 0;
        struct EntityDelta* deltas = (struct EntityDelta*)packet->delta_entities;
        
        // Generate deltas for subscribed entities
        for (uint8_t i = 0; i < player_state->aoi_subscription.subscription_count && 
             delta_count < MAX_ENTITIES_PER_SNAPSHOT; i++) {
            
            entity_id entity_id = player_state->aoi_subscription.subscribed_entities[i];
            aoi_tier_t tier = player_state->aoi_subscription.tier_assignments[i];
            
            if (!should_send_snapshot_for_tier(tier, current_time, 
                                              player_state->last_snapshot_time[tier])) {
                continue;
            }
            
            // Find baseline for this entity
            struct EntitySnapshot* baseline = NULL;
            for (uint16_t j = 0; j < player_state->baseline_count; j++) {
                if (player_state->entity_baselines[j].id == entity_id) {
                    baseline = &player_state->entity_baselines[j];
                    break;
                }
            }
            
            if (!baseline) continue; // No baseline, skip delta
            
            // Get current entity state
            struct EntitySnapshot current_snapshot = {0};
            
            struct Ship* ship = sim_get_ship((struct Sim*)sim, entity_id);
            if (ship) {
                quantize_entity_data(ship, &current_snapshot);
            } else {
                struct Player* other_player = sim_get_player((struct Sim*)sim, entity_id);
                if (other_player) {
                    quantize_player_data(other_player, &current_snapshot);
                } else {
                    struct Projectile* proj = sim_get_projectile((struct Sim*)sim, entity_id);
                    if (proj) {
                        quantize_projectile_data(proj, &current_snapshot);
                    } else {
                        continue; // Entity not found
                    }
                }
            }
            
            // Create delta
            struct EntityDelta delta;
            if (create_entity_delta(baseline, &current_snapshot, &delta) > 0) {
                deltas[delta_count] = delta;
                delta_count++;
            }
        }
        
        packet->entity_count = delta_count;
        
        // Calculate delta packet size
        size_t delta_data_size = 0;
        for (uint16_t i = 0; i < delta_count; i++) {
            delta_data_size += calculate_delta_size(&deltas[i]);
        }
        
        *packet_size = sizeof(struct SnapHeader) + sizeof(uint16_t) + delta_data_size;
        
        log_debug("Generated delta snapshot for player %u: %u deltas, %zu bytes",
                  player_id, delta_count, *packet_size);
    }
    
    // Update tier timestamps
    for (int tier = 0; tier < AOI_TIER_COUNT; tier++) {
        player_state->last_snapshot_time[tier] = current_time;
    }
    
    // Add checksum
    packet->header.checksum = protocol_checksum(packet, *packet_size - sizeof(packet->header.checksum));
    
    // Update bandwidth statistics
    update_bandwidth_stats(player_state, *packet_size);
    mgr->total_snapshots_sent++;
    mgr->total_bytes_sent += *packet_size;
    
    return 0;
}

// Entity conversion functions
void entity_to_snapshot(const struct Ship* ship, struct EntitySnapshot* snap) {
    quantize_entity_data(ship, snap);
}

void entity_to_snapshot_player(const struct Player* player, struct EntitySnapshot* snap) {
    quantize_player_data(player, snap);
}

void entity_to_snapshot_projectile(const struct Projectile* proj, struct EntitySnapshot* snap) {
    quantize_projectile_data(proj, snap);
}

int create_entity_delta(const struct EntitySnapshot* baseline, 
                       const struct EntitySnapshot* current,
                       struct EntityDelta* delta) {
    if (!baseline || !current || !delta || baseline->id != current->id) {
        return 0;
    }
    
    memset(delta, 0, sizeof(struct EntityDelta));
    delta->id = current->id;
    
    uint8_t data_index = 0;
    
    // Check position changes
    if (baseline->pos_x_q != current->pos_x_q || baseline->pos_y_q != current->pos_y_q) {
        delta->delta_flags |= DELTA_FLAG_POSITION;
        delta->changed_data[data_index++] = current->pos_x_q;
        delta->changed_data[data_index++] = current->pos_y_q;
    }
    
    // Check velocity changes
    if (baseline->vel_x_q != current->vel_x_q || baseline->vel_y_q != current->vel_y_q) {
        delta->delta_flags |= DELTA_FLAG_VELOCITY;
        delta->changed_data[data_index++] = current->vel_x_q;
        delta->changed_data[data_index++] = current->vel_y_q;
    }
    
    // Check rotation changes
    if (baseline->rotation_q != current->rotation_q) {
        delta->delta_flags |= DELTA_FLAG_ROTATION;
        delta->changed_data[data_index++] = current->rotation_q;
    }
    
    // Check health changes
    if (baseline->health != current->health) {
        delta->delta_flags |= DELTA_FLAG_HEALTH;
        delta->changed_data[data_index++] = current->health;
    }
    
    // Check state flag changes
    if (baseline->state_flags != current->state_flags) {
        delta->delta_flags |= DELTA_FLAG_STATE;
        delta->changed_data[data_index++] = current->state_flags;
    }
    
    return delta->delta_flags ? 1 : 0; // Return 1 if any changes, 0 if no changes
}

bool should_send_snapshot_for_tier(aoi_tier_t tier, uint32_t current_time, uint32_t last_time) {
    uint32_t interval_ms;
    
    switch (tier) {
        case AOI_TIER_HIGH: interval_ms = 1000 / SNAP_FREQ_HIGH; break; // 33ms
        case AOI_TIER_MID:  interval_ms = 1000 / SNAP_FREQ_MID;  break; // 67ms  
        case AOI_TIER_LOW:  interval_ms = 1000 / SNAP_FREQ_LOW;  break; // 200ms
        default: return false;
    }
    
    return (current_time - last_time) >= interval_ms;
}

void update_bandwidth_stats(struct PlayerSnapshotState* player, size_t packet_size) {
    if (!player) return;
    
    player->bytes_sent_total += packet_size;
    player->snapshots_sent++;
    
    // Reset per-second counter every second (simplified)
    static uint32_t last_reset_time = 0;
    uint32_t current_time = get_time_ms();
    
    if (current_time - last_reset_time >= 1000) {
        player->bytes_sent_this_second = 0;
        last_reset_time = current_time;
    }
    
    player->bytes_sent_this_second += packet_size;
}

// Helper functions implementation
static struct PlayerSnapshotState* find_player_state(struct SnapshotManager* mgr, entity_id player_id) {
    if (!mgr || player_id == INVALID_ENTITY_ID) return NULL;
    
    for (uint16_t i = 0; i < MAX_PLAYERS; i++) {
        if (mgr->players[i].player_id == player_id) {
            return &mgr->players[i];
        }
    }
    
    return NULL;
}

static void quantize_entity_data(const struct Ship* ship, struct EntitySnapshot* snap) {
    if (!ship || !snap) return;
    
    snap->id = ship->id;
    snap->pos_x_q = quantize_position(Q16_TO_FLOAT(ship->position.x));
    snap->pos_y_q = quantize_position(Q16_TO_FLOAT(ship->position.y));
    snap->vel_x_q = quantize_velocity(Q16_TO_FLOAT(ship->velocity.x));
    snap->vel_y_q = quantize_velocity(Q16_TO_FLOAT(ship->velocity.y));
    snap->rotation_q = quantize_rotation(Q16_TO_FLOAT(ship->rotation));
    snap->health = ship->health;
    snap->state_flags = (uint8_t)ship->flags;
}

static void quantize_player_data(const struct Player* player, struct EntitySnapshot* snap) {
    if (!player || !snap) return;
    
    snap->id = player->id;
    snap->pos_x_q = quantize_position(Q16_TO_FLOAT(player->position.x));
    snap->pos_y_q = quantize_position(Q16_TO_FLOAT(player->position.y));
    snap->vel_x_q = quantize_velocity(Q16_TO_FLOAT(player->velocity.x));
    snap->vel_y_q = quantize_velocity(Q16_TO_FLOAT(player->velocity.y));
    snap->rotation_q = 0; // Players don't have rotation
    snap->health = player->health;
    snap->state_flags = player->flags;
}

static void quantize_projectile_data(const struct Projectile* proj, struct EntitySnapshot* snap) {
    if (!proj || !snap) return;
    
    snap->id = proj->id;
    snap->pos_x_q = quantize_position(Q16_TO_FLOAT(proj->position.x));
    snap->pos_y_q = quantize_position(Q16_TO_FLOAT(proj->position.y));
    snap->vel_x_q = quantize_velocity(Q16_TO_FLOAT(proj->velocity.x));
    snap->vel_y_q = quantize_velocity(Q16_TO_FLOAT(proj->velocity.y));
    snap->rotation_q = 0; // Projectiles don't have rotation
    snap->health = 0; // Projectiles don't have health
    snap->state_flags = proj->flags;
}

static uint16_t calculate_delta_size(const struct EntityDelta* delta) {
    if (!delta) return 0;
    
    uint16_t size = sizeof(entity_id) + sizeof(uint8_t); // ID + flags
    
    // Add size for each changed field
    if (delta->flags & DELTA_FLAG_POSITION) size += 4; // pos_x + pos_y
    if (delta->flags & DELTA_FLAG_VELOCITY) size += 4; // vel_x + vel_y  
    if (delta->flags & DELTA_FLAG_ROTATION) size += 2; // rotation
    if (delta->flags & DELTA_FLAG_HEALTH) size += 1;   // health
    if (delta->flags & DELTA_FLAG_STATE) size += 1;    // state_flags
    
    return size;
}

static bool entities_differ(const struct EntitySnapshot* a, const struct EntitySnapshot* b) {
    if (!a || !b || a->id != b->id) return true;
    
    return (a->pos_x_q != b->pos_x_q ||
            a->pos_y_q != b->pos_y_q ||
            a->vel_x_q != b->vel_x_q ||
            a->vel_y_q != b->vel_y_q ||
            a->rotation_q != b->rotation_q ||
            a->health != b->health ||
            a->state_flags != b->state_flags);
}

static void create_entity_delta(const struct EntitySnapshot* baseline, 
                                const struct EntitySnapshot* current,
                                struct EntityDelta* delta) {
    if (!baseline || !current || !delta) return;
    
    memset(delta, 0, sizeof(struct EntityDelta));
    delta->entity_id = current->id;
    
    // Check each field for changes
    if (baseline->pos_x_q != current->pos_x_q || baseline->pos_y_q != current->pos_y_q) {
        delta->flags |= DELTA_FLAG_POSITION;
        delta->pos_x_q = current->pos_x_q;
        delta->pos_y_q = current->pos_y_q;
    }
    
    if (baseline->vel_x_q != current->vel_x_q || baseline->vel_y_q != current->vel_y_q) {
        delta->flags |= DELTA_FLAG_VELOCITY;
        delta->vel_x_q = current->vel_x_q;
        delta->vel_y_q = current->vel_y_q;
    }
    
    if (baseline->rotation_q != current->rotation_q) {
        delta->flags |= DELTA_FLAG_ROTATION;
        delta->rotation_q = current->rotation_q;
    }
    
    if (baseline->health != current->health) {
        delta->flags |= DELTA_FLAG_HEALTH;
        delta->health = current->health;
    }
    
    if (baseline->state_flags != current->state_flags) {
        delta->flags |= DELTA_FLAG_STATE;
        delta->state_flags = current->state_flags;
    }
}

static size_t apply_delta_compression(const struct EntitySnapshot* baseline, 
                                      const struct EntitySnapshot* entities, 
                                      uint16_t entity_count,
                                      uint8_t* output_buffer,
                                      size_t buffer_size) {
    if (!entities || !output_buffer || entity_count == 0) return 0;
    
    size_t bytes_written = 0;
    uint16_t deltas_created = 0;
    
    for (uint16_t i = 0; i < entity_count; i++) {
        const struct EntitySnapshot* current = &entities[i];
        
        // Find baseline for this entity (if any)
        const struct EntitySnapshot* base = NULL;
        if (baseline) {
            // Linear search for matching entity in baseline
            // In production, use a hash table for O(1) lookup
            for (uint16_t j = 0; j < entity_count; j++) {
                if (baseline[j].id == current->id) {
                    base = &baseline[j];
                    break;
                }
            }
        }
        
        if (!base || entities_differ(base, current)) {
            // Create delta for this entity
            struct EntityDelta delta;
            if (base) {
                create_entity_delta(base, current, &delta);
            } else {
                // New entity - include all fields
                memset(&delta, 0, sizeof(delta));
                delta.entity_id = current->id;
                delta.flags = DELTA_FLAG_ALL;
                delta.pos_x_q = current->pos_x_q;
                delta.pos_y_q = current->pos_y_q;
                delta.vel_x_q = current->vel_x_q;
                delta.vel_y_q = current->vel_y_q;
                delta.rotation_q = current->rotation_q;
                delta.health = current->health;
                delta.state_flags = current->state_flags;
            }
            
            // Serialize delta to output buffer
            uint16_t delta_size = calculate_delta_size(&delta);
            if (bytes_written + delta_size <= buffer_size) {
                // Copy delta data to buffer
                memcpy(output_buffer + bytes_written, &delta, delta_size);
                bytes_written += delta_size;
                deltas_created++;
            } else {
                log_warn("Delta compression buffer overflow - truncating");
                break;
            }
        }
    }
    
    log_info("Delta compression: %u entities → %u deltas (%zu bytes, %.1f%% of original)",
             entity_count, deltas_created, bytes_written,
             entity_count > 0 ? (bytes_written * 100.0f) / (entity_count * sizeof(struct EntitySnapshot)) : 0.0f);
    
    return bytes_written;
}
    // Count data fields based on flags
    if (delta->delta_flags & DELTA_FLAG_POSITION) size += 2 * sizeof(uint16_t);
    if (delta->delta_flags & DELTA_FLAG_VELOCITY) size += 2 * sizeof(uint16_t);
    if (delta->delta_flags & DELTA_FLAG_ROTATION) size += sizeof(uint16_t);
    if (delta->delta_flags & DELTA_FLAG_HEALTH) size += sizeof(uint16_t);
    if (delta->delta_flags & DELTA_FLAG_STATE) size += sizeof(uint16_t);
    
    return size;
}