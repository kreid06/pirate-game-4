#ifndef NET_PROTOCOL_H
#define NET_PROTOCOL_H

#include <stdint.h>
#include <stdbool.h>
#include <netinet/in.h>
#include "core/math.h"

// Protocol version and limits
#define PROTOCOL_VERSION 1
#define MAX_PACKET_SIZE 1400
#define MAX_ENTITIES_PER_SNAPSHOT 64
#define CMD_SEQUENCE_WINDOW 64

// Packet types
typedef enum {
    PACKET_CLIENT_HANDSHAKE = 1,
    PACKET_SERVER_HANDSHAKE = 2,
    PACKET_CLIENT_INPUT = 3,
    PACKET_SERVER_SNAPSHOT = 4,
    PACKET_CLIENT_ACK = 5,
    PACKET_HEARTBEAT = 6,
} packet_type_t;

// Client → Server command packet
struct __attribute__((packed)) CmdPacket {
    uint8_t  type;        // PACKET_CLIENT_INPUT
    uint8_t  version;     // PROTOCOL_VERSION
    uint16_t seq;         // Monotonic sequence number
    uint16_t dt_ms;       // Delta time echo (for RTT calculation)
    int16_t  thrust;      // Q0.15 fixed-point [-1.0, 1.0]
    int16_t  turn;        // Q0.15 fixed-point [-1.0, 1.0]
    uint16_t actions;     // Bitfield actions
    uint32_t client_time; // Client timestamp (ms)
    uint16_t checksum;    // Simple checksum for corruption detection
};

// Server → Client snapshot header
struct __attribute__((packed)) SnapHeader {
    uint8_t  type;        // PACKET_SERVER_SNAPSHOT
    uint8_t  version;     // PROTOCOL_VERSION
    uint32_t server_time; // Server tick timestamp
    uint16_t base_id;     // Baseline snapshot ID for delta compression
    uint16_t snap_id;     // This snapshot ID
    uint16_t aoi_cell;    // AOI cell ID for validation
    uint8_t  entity_count; // Number of entities in this snapshot
    uint8_t  flags;       // Compression flags, priority tier
    uint16_t checksum;    // Packet integrity
};

// Per-entity update (quantized and bit-packed)
struct __attribute__((packed)) EntityUpdate {
    uint16_t entity_id;   // Entity identifier
    uint16_t pos_x;       // Position X * 512 (1/512m precision)
    uint16_t pos_y;       // Position Y * 512
    uint16_t vel_x;       // Velocity X * 256 (1/256 m/s precision)  
    uint16_t vel_y;       // Velocity Y * 256
    uint16_t rotation;    // Rotation * 1024/2π (1/1024 radian precision)
    uint8_t  state_flags; // Health, actions, module states
    uint8_t  reserved;    // Padding for alignment
};

// Handshake packets
struct __attribute__((packed)) ClientHandshake {
    uint8_t  type;        // PACKET_CLIENT_HANDSHAKE
    uint8_t  version;     // PROTOCOL_VERSION
    uint32_t client_id;   // Unique client identifier
    char     player_name[16]; // Null-terminated player name
    uint16_t checksum;
};

struct __attribute__((packed)) ServerHandshake {
    uint8_t  type;        // PACKET_SERVER_HANDSHAKE
    uint8_t  version;     // PROTOCOL_VERSION
    uint16_t player_id;   // Assigned player ID
    uint32_t server_time; // Current server time for synchronization
    uint16_t checksum;
};

// Reliability layer
struct ReliabilityState {
    uint16_t local_seq;        // Next sequence to send
    uint16_t remote_seq;       // Last received sequence
    uint32_t ack_bitfield;     // Bitmask of recently received packets
    uint32_t last_ack_time;    // When we last received an ack
    uint16_t resend_queue[16]; // Packets waiting for resend
    uint8_t  resend_count;     // Number of packets in resend queue
};

// Protocol functions
bool protocol_validate_packet(const void* packet, size_t size, packet_type_t expected_type);
uint16_t protocol_checksum(const void* data, size_t size);

// Quantization helpers
static inline uint16_t quantize_position(float pos) {
    return (uint16_t)(pos * 512.0f + 32768.0f); // Bias for signed range
}

static inline float unquantize_position(uint16_t pos) {
    return (float)(pos - 32768) / 512.0f;
}

static inline uint16_t quantize_velocity(float vel) {
    return (uint16_t)(vel * 256.0f + 32768.0f);
}

static inline float unquantize_velocity(uint16_t vel) {
    return (float)(vel - 32768) / 256.0f;
}

static inline uint16_t quantize_rotation(float angle) {
    // Normalize angle to [0, 2π) then quantize
    while (angle < 0) angle += 6.28318530718f;
    while (angle >= 6.28318530718f) angle -= 6.28318530718f;
    return (uint16_t)(angle * 1024.0f / 6.28318530718f);
}

static inline float unquantize_rotation(uint16_t rot) {
    return (float)rot * 6.28318530718f / 1024.0f;
}

#endif /* NET_PROTOCOL_H */