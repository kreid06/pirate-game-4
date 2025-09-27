# Protocol Documentation

This directory contains the shared protocol definitions between the client and server.

> 📋 **See [PROTOCOL_SPECIFICATION.md](../docs/PROTOCOL_SPECIFICATION.md) for complete protocol documentation**

## Quick Reference

### Connection Protocol
- **Transport**: UDP on port 8080 (game), HTTP on port 8081 (admin)
- **Packet Format**: Binary with magic header + JSON/binary payload
- **Frequency**: 30Hz server physics, 20-30Hz client updates
- **Coordinates**: Q16.16 fixed-point math

### Message Types

#### Client → Server
| Type | Value | Purpose |
|------|-------|---------|
| `JOIN_GAME` | 0x01 | Initial connection |
| `INPUT_UPDATE` | 0x02 | Player controls |
| `PING` | 0x03 | Latency check |
| `LEAVE_GAME` | 0x04 | Disconnect |

#### Server → Client  
| Type | Value | Purpose |
|------|-------|---------|
| `WELCOME` | 0x81 | Connection accepted |
| `GAME_STATE` | 0x82 | Full world snapshot |
| `STATE_UPDATE` | 0x83 | Delta updates |
| `PLAYER_JOINED` | 0x84 | New player |
| `PLAYER_LEFT` | 0x85 | Player disconnect |
| `PONG` | 0x86 | Ping response |

### Packet Structure
```c
struct GamePacket {
    uint32_t magic;         // 0x50495241 ('PIRA')
    uint16_t version;       // Protocol version
    uint16_t type;          // Message type
    uint32_t sequence;      // Sequence number  
    uint32_t timestamp;     // Timestamp (ms)
    uint16_t payload_size;  // Payload bytes
    uint8_t  checksum;      // Packet validation
    uint8_t  flags;         // Control flags
    // Payload data follows...
};
```

### State Synchronization
- **Server Authority**: Physics simulation runs at 30Hz
- **Client Prediction**: Immediate input response + server reconciliation  
- **Delta Compression**: Only send changed data
- **Lag Compensation**: Server rewinds for hit validation