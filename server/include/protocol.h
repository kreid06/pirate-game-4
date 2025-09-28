/**
 * Protocol Constants - Week 3-4 Enhanced
 * Basic protocol definitions for network communication
 */

#ifndef PROTOCOL_H
#define PROTOCOL_H

#include <stdint.h>

// Protocol constants
#define PROTOCOL_MAX_PACKET_SIZE 1024
#define PROTOCOL_VERSION 1

// Packet types
#define PACKET_HANDSHAKE 1
#define PACKET_HANDSHAKE_RESPONSE 2
#define PACKET_INPUT 3
#define PACKET_SNAPSHOT 4
#define PACKET_PING 5
#define PACKET_PONG 6

// Action flags for input
#define ACTION_SHOOT 0x01
#define ACTION_USE 0x02
#define ACTION_RELOAD 0x04
#define ACTION_INTERACT 0x08

// Fixed-point conversion macros (Q15 for input, Q16 for simulation)
#define Q15_TO_FLOAT(q15) ((float)(q15) / 32768.0f)
#define FLOAT_TO_Q15(f) ((int16_t)((f) * 32768.0f))

// Basic packet structures
struct HandshakePacket {
    uint8_t type;           // PACKET_HANDSHAKE
    uint8_t version;        // PROTOCOL_VERSION
    uint32_t client_id;     // Client identifier
    uint64_t timestamp;     // Client timestamp
    uint16_t padding;       // Ensure 16-byte size
};

struct HandshakeResponsePacket {
    uint8_t type;           // PACKET_HANDSHAKE_RESPONSE
    uint8_t status;         // 0 = success, 1 = error
    uint16_t player_id;     // Assigned player ID
    uint32_t server_time;   // Server timestamp
    uint32_t padding;       // Alignment
};

struct InputPacket {
    uint8_t type;           // PACKET_INPUT
    uint8_t flags;          // Input flags
    uint32_t tick;          // Client tick
    uint64_t timestamp;     // Client timestamp
    float movement_x;       // Movement X
    float movement_y;       // Movement Y
};

struct PingPacket {
    uint8_t type;           // PACKET_PING
    uint8_t padding;
    uint64_t timestamp;     // Client timestamp
    uint32_t sequence;      // Ping sequence number
    uint16_t padding2;
};

struct PongPacket {
    uint8_t type;           // PACKET_PONG
    uint8_t padding;
    uint64_t timestamp;     // Server timestamp
    uint64_t client_timestamp; // Original client timestamp
};

#endif // PROTOCOL_H