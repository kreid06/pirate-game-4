#ifndef NET_SNAPSHOT_H
#define NET_SNAPSHOT_H

#include <stdint.h>
#include <stdbool.h>
#include "core/math.h"
#include "sim/types.h"
#include "net/protocol.h"
#include "aoi/grid.h"

// Snapshot configuration
#define SNAPSHOT_BASELINE_INTERVAL 30    // Send full baseline every 30 snapshots (~1 sec)
#define SNAPSHOT_HISTORY_SIZE 32         // Keep last 32 snapshots for delta compression
#define MAX_ENTITIES_PER_SNAPSHOT 64     // Max entities in one snapshot packet

// Snapshot frequency tiers
typedef enum {
    SNAP_FREQ_HIGH = 30,    // 30 Hz for high priority entities
    SNAP_FREQ_MID = 15,     // 15 Hz for medium priority entities  
    SNAP_FREQ_LOW = 5       // 5 Hz for low priority entities
} snapshot_frequency_t;

// Delta flags for efficient encoding
#define DELTA_FLAG_POSITION    (1 << 0)
#define DELTA_FLAG_VELOCITY    (1 << 1)
#define DELTA_FLAG_ROTATION    (1 << 2)
#define DELTA_FLAG_HEALTH      (1 << 3)
#define DELTA_FLAG_STATE       (1 << 4)
#define DELTA_FLAG_ALL         (DELTA_FLAG_POSITION | DELTA_FLAG_VELOCITY | DELTA_FLAG_ROTATION | DELTA_FLAG_HEALTH | DELTA_FLAG_STATE)

// Compressed entity snapshot data
struct EntitySnapshot {
    entity_id id;
    uint16_t pos_x_q;      // Quantized position (1/512m precision)
    uint16_t pos_y_q;      // Quantized position  
    uint16_t vel_x_q;      // Quantized velocity (1/256 m/s precision)
    uint16_t vel_y_q;      // Quantized velocity
    uint16_t rotation_q;   // Quantized rotation (1/1024 rad precision)
    uint8_t health;        // Health 0-255
    uint8_t state_flags;   // Entity state bits
};

// Delta-compressed entity update
struct EntityDelta {
    entity_id entity_id;
    uint8_t flags;         // Which fields changed (DELTA_FLAG_*)
    uint16_t pos_x_q;      // Position X (only if DELTA_FLAG_POSITION)
    uint16_t pos_y_q;      // Position Y (only if DELTA_FLAG_POSITION)
    uint16_t vel_x_q;      // Velocity X (only if DELTA_FLAG_VELOCITY)
    uint16_t vel_y_q;      // Velocity Y (only if DELTA_FLAG_VELOCITY)
    uint16_t rotation_q;   // Rotation (only if DELTA_FLAG_ROTATION)
    uint8_t health;        // Health (only if DELTA_FLAG_HEALTH)
    uint8_t state_flags;   // State flags (only if DELTA_FLAG_STATE)
} __attribute__((packed));

// Snapshot packet with delta compression
struct SnapshotPacket {
    struct SnapHeader header;
    union {
        struct EntitySnapshot baseline_entities[MAX_ENTITIES_PER_SNAPSHOT];
        struct EntityDelta delta_entities[MAX_ENTITIES_PER_SNAPSHOT];
    };
    uint16_t entity_count;
} __attribute__((packed));

// Per-player snapshot state
struct PlayerSnapshotState {
    entity_id player_id;
    
    // Baseline tracking
    uint16_t last_baseline_id;
    uint32_t last_baseline_time;
    
    // Delta compression history
    struct EntitySnapshot entity_baselines[MAX_ENTITIES_PER_SNAPSHOT];
    uint16_t baseline_count;
    
    // Priority and frequency management
    struct AOISubscription aoi_subscription;
    uint32_t last_snapshot_time[AOI_TIER_COUNT];
    
    // Bandwidth tracking
    uint32_t bytes_sent_this_second;
    uint32_t bytes_sent_total;
    uint32_t snapshots_sent;
};

// Snapshot manager
struct SnapshotManager {
    struct PlayerSnapshotState players[MAX_PLAYERS];
    uint16_t active_player_count;
    
    // Global snapshot counters
    uint16_t global_snapshot_id;
    uint32_t total_snapshots_sent;
    uint32_t total_bytes_sent;
    
    // Performance metrics
    uint32_t compression_ratio_percent; // Average compression ratio
    uint32_t avg_snapshot_size_bytes;
};

// Snapshot system functions
int snapshot_manager_init(struct SnapshotManager* mgr);
void snapshot_manager_cleanup(struct SnapshotManager* mgr);

// Compatibility aliases
#define snapshot_init snapshot_manager_init
#define snapshot_cleanup snapshot_manager_cleanup
#define snapshot_init_player snapshot_add_player
#define snapshot_update(mgr, time) // No-op for now

// Player management
int snapshot_add_player(struct SnapshotManager* mgr, entity_id player_id);
void snapshot_remove_player(struct SnapshotManager* mgr, entity_id player_id);
struct PlayerSnapshotState* snapshot_get_player(struct SnapshotManager* mgr, entity_id player_id);

// Snapshot generation and compression
int snapshot_generate_for_player(struct SnapshotManager* mgr, const struct Sim* sim,
                                 const struct AOIGrid* aoi, entity_id player_id,
                                 uint32_t current_time, uint8_t* packet_buffer, 
                                 size_t buffer_size, size_t* packet_size);

// Entity snapshot utilities
void entity_to_snapshot(const struct Ship* ship, struct EntitySnapshot* snap);
void entity_to_snapshot_player(const struct Player* player, struct EntitySnapshot* snap);
void entity_to_snapshot_projectile(const struct Projectile* proj, struct EntitySnapshot* snap);

// Delta compression
int create_entity_delta(const struct EntitySnapshot* baseline, 
                       const struct EntitySnapshot* current,
                       struct EntityDelta* delta);
size_t encode_delta_packet(const struct EntityDelta* deltas, uint16_t count,
                          uint16_t baseline_id, uint16_t snapshot_id,
                          uint8_t* packet_buffer, size_t buffer_size);

// Bandwidth optimization
bool should_send_snapshot_for_tier(aoi_tier_t tier, uint32_t current_time, uint32_t last_time);
void update_bandwidth_stats(struct PlayerSnapshotState* player, size_t packet_size);

#endif /* NET_SNAPSHOT_H */