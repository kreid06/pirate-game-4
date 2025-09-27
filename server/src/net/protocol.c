#include "net/protocol.h"
#include <string.h>

bool protocol_validate_packet(const void* packet, size_t size, packet_type_t expected_type) {
    if (!packet || size < 2) {
        return false; // Too small to contain type and version
    }
    
    const uint8_t* data = (const uint8_t*)packet;
    uint8_t type = data[0];
    uint8_t version = data[1];
    
    // Check version
    if (version != PROTOCOL_VERSION) {
        return false;
    }
    
    // Check type
    if (type != expected_type) {
        return false;
    }
    
    // Validate size based on packet type
    size_t expected_size = 0;
    switch (type) {
        case PACKET_CLIENT_HANDSHAKE:
            expected_size = sizeof(struct ClientHandshake);
            break;
        case PACKET_SERVER_HANDSHAKE:
            expected_size = sizeof(struct ServerHandshake);
            break;
        case PACKET_CLIENT_INPUT:
            expected_size = sizeof(struct CmdPacket);
            break;
        case PACKET_SERVER_SNAPSHOT:
            expected_size = sizeof(struct SnapHeader); // Variable size
            break;
        case PACKET_CLIENT_ACK:
        case PACKET_HEARTBEAT:
            expected_size = 4; // Minimal packet
            break;
        default:
            return false; // Unknown type
    }
    
    if (type != PACKET_SERVER_SNAPSHOT && size != expected_size) {
        return false; // Size mismatch for fixed-size packets
    }
    
    if (type == PACKET_SERVER_SNAPSHOT && size < expected_size) {
        return false; // Snapshot too small
    }
    
    return true;
}

uint16_t protocol_checksum(const void* data, size_t size) {
    if (!data || size == 0) {
        return 0;
    }
    
    // Simple checksum algorithm (could be improved with CRC16)
    const uint8_t* bytes = (const uint8_t*)data;
    uint32_t sum = 0;
    
    for (size_t i = 0; i < size; i++) {
        sum += bytes[i];
        sum = (sum & 0xFFFF) + (sum >> 16); // Fold carry bits
    }
    
    return (uint16_t)(~sum); // One's complement
}