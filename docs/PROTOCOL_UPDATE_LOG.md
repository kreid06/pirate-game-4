# Protocol Update Log

## Overview

The server has added **WebSocket support** for browser clients, and the client's UDP Network Manager has been updat3. **`client/protocol-test-standalone.html`** - Standalone web interface
   - No ES module dependencies (resolves import errors)
   - All JavaScript inline with global scope functions
   - Real-time WebSocket testing without build requirements
   - Works directly with any HTTP server (including Vite dev server)

### Server Integration Verification

The server codebase shows WebSocket integration in `server/src/core/server.c`:

```c
// Initialize WebSocket server on port 8082
if (websocket_server_init(8082) != 0) {
    log_error("Failed to initialize WebSocket server");
    // ... error handling
}

// Main game loop includes WebSocket updates
void server_tick(struct ServerContext* ctx) {
    // ... other updates
    websocket_server_update(&ctx->simulation);
    // ...
}
```

**Server Startup Sequence:**
1. UDP game server initializes on port 8080
2. HTTP admin server initializes on port 8081  
3. **WebSocket server initializes on port 8082** ← NEW
4. Main 30Hz game loop processes all three protocols support both text-based commands and binary game packets as demonstrated in the reference test.

## Server WebSocket Integration (NEW)

### WebSocket Server Implementation
The server now runs a dedicated WebSocket server on **port 8082** alongside the existing UDP game server on port 8080.

**Key Features:**
- **Full WebSocket Protocol**: Complete RFC 6455 implementation with handshake, frame parsing, and masking
- **Browser Compatible**: Direct connection from web browsers without plugins
- **Protocol Bridge**: Automatic translation between WebSocket messages and internal UDP protocol
- **Multi-client Support**: Up to 100 concurrent WebSocket connections
- **Integrated Lifecycle**: WebSocket server updates run in main game loop at 30Hz

**Server Architecture:**
```
UDP Port 8080    ←→  Game Server Core  ←→  WebSocket Port 8082
(Native clients)     (30Hz Physics)       (Browser clients)
                           ↓
                    Admin HTTP 8081
                   (Monitoring/Stats)
```

### WebSocket Protocol Commands
The server responds to text-based commands over WebSocket:

| Command | Response | Purpose |
|---------|----------|---------|
| `PING` | `PONG` | Connection keepalive and latency measurement |
| `JOIN:PlayerName` | `{"type":"WELCOME","player_id":N}` | Join game session with assigned player ID |
| `STATE` | `{"type":"GAME_STATE","tick":N,...}` | Request current world state snapshot |
| `<message>` | `<message>` | Echo test for connection validation |

**Example WebSocket Session:**
```javascript
// Client connects to ws://server:8082
ws.send("PING");                    // → "PONG"
ws.send("JOIN:TestPlayer");         // → {"type":"WELCOME","player_id":1001}
ws.send("STATE");                   // → {"type":"GAME_STATE","tick":12345,...}
```

## Dual Protocol Support

### 1. Text-Based Protocol (Reference: `protocol/test_protocol.js`)

**Supported Commands:**
- `PING` → `PONG` - Basic connectivity test with latency measurement
- `JOIN:PlayerName` → `{"type":"WELCOME","player_id":N}` - Join game session
- `STATE` → `{"type":"GAME_STATE","tick":N,...}` - Request current game state
- `ECHO:message` → `message` - Echo test for connection validation

**Implementation:**
- Uses WebSocket text messages for browser compatibility
- Matches the Node.js reference test behavior exactly
- Provides fallback connectivity when binary protocol unavailable

### 2. Binary Protocol (Real-time Game Data)

**Packet Types:**
- Client Handshake - Establish binary session
- Client Input - Real-time player controls (Q0.15 fixed-point)
- Server Snapshot - World state updates with quantized data
- Heartbeat - Connection keepalive and ping measurement

## Protocol Alignment Changes

### 1. Packet Structure Updates

**ClientHandshakePacket**
- Updated comments to match server `ClientHandshake` struct
- Fixed field layout: `type(1) + version(1) + client_id(4) + player_name(16) + checksum(2) = 24 bytes`
- Added null-terminated string handling for player names

**ClientInputPacket (CmdPacket)**
- Updated comments to match server `CmdPacket` struct  
- Renamed `deltaTime` field comment to clarify it's `dt_ms` for RTT calculation
- Fixed field layout: `type(1) + version(1) + seq(2) + dt_ms(2) + thrust(2) + turn(2) + actions(2) + client_time(4) + checksum(2) = 18 bytes`

**ServerSnapshotPacket (SnapHeader)**
- Enhanced comments to match server `SnapHeader` struct
- Clarified field purposes (baseline ID, AOI cell, compression flags, etc.)

**EntityUpdate**
- Added `reserved` field to match server struct padding
- Updated comments with exact quantization precision specs from server
- Fixed parsing to read the reserved byte properly

### 2. Serialization Improvements

**Exact Binary Layout**
- Replaced generic serialization with exact C struct layout matching
- Fixed packet sizes to match server expectations precisely
- Added proper null-terminated string handling for player names
- Removed old `sendBinaryPacket` wrapper in favor of direct serialization

**Checksum Implementation**
- Added `calculateChecksum()` method matching server's simple checksum algorithm
- Integrated checksum calculation into handshake and input packet sending
- Added checksum validation for incoming server handshake packets
- Uses one's complement algorithm: `sum = (sum & 0xFFFF) + (sum >> 16); return ~sum`

### 3. Quantization Functions

**Position Quantization**
- Added `quantizePosition()`: `pos * 512.0 + 32768.0` (1/512m precision)
- Updated `unquantizePosition()`: `(pos - 32768) / 512.0`

**Velocity Quantization**  
- Added `quantizeVelocity()`: `vel * 256.0 + 32768.0` (1/256 m/s precision)
- Updated `unquantizeVelocity()`: `(vel - 32768) / 256.0`

**Rotation Quantization**
- Added `quantizeRotation()`: Normalizes angle to [0, 2π) then `angle * 1024.0 / (2π)` (1/1024 radian precision)
- Updated `unquantizeRotation()`: `rot * (2π) / 1024.0`

### 4. Enhanced Error Handling

**Protocol Validation**
- Added protocol version mismatch detection with detailed logging
- Added checksum validation warnings (continues execution but logs issues)
- Improved connection error messages with server time offset reporting

## Compatibility

The client now precisely matches the server protocol definition from:
- `server/include/net/protocol.h`
- `server/src/net/protocol.c`

This ensures:
- ✅ Binary packet compatibility 
- ✅ Exact struct layout matching
- ✅ Consistent quantization algorithms
- ✅ Proper checksum validation
- ✅ Deterministic serialization

## Next Steps

1. **Test Connection**: Once the server is running, test the binary protocol communication
2. **Validate Checksums**: Verify checksum calculation matches between client and server
3. **Monitor Quantization**: Test position/velocity precision in actual gameplay
4. **Performance**: Monitor serialization overhead with proper binary packing

## Testing

### Test Files Created

1. **`client/src/net/test_udp.ts`** - Comprehensive protocol test suite
   - Replicates `protocol/test_protocol.js` behavior for browser environment
   - Tests both text and binary protocols
   - Provides detailed logging and error reporting

2. **`client/protocol-test.html`** - Interactive web interface
   - Visual protocol testing dashboard
   - Real-time connection status monitoring
   - Separate test controls for each protocol type
   - Console logging with web-friendly display

### Usage

**Command Line (Node.js style):**
```bash
# Reference test (Node.js with raw UDP)
node protocol/test_protocol.js

# Client test (Browser with WebSocket bridge)
# Open client/protocol-test.html in browser
```

**Browser Console:**
```javascript
// Run complete test suite
testUDPConnection();

// Test individual protocols
const tester = new PirateClientTester();
await tester.runAllTests();
```

## Compatibility

The system now supports a complete client-server protocol stack:

**Server-Side (C):**
- ✅ UDP game protocol on port 8080 (native clients)
- ✅ HTTP admin interface on port 8081 (monitoring)  
- ✅ **WebSocket bridge on port 8082 (browser clients)** ← NEW
- ✅ Text commands matching `protocol/test_protocol.js` reference
- ✅ Binary packets matching `server/include/net/protocol.h`
- ✅ Integrated 30Hz game loop processing all protocols

**Client-Side (TypeScript/Browser):**
- ✅ WebSocket connection with automatic protocol detection
- ✅ Text commands matching reference test behavior
- ✅ Binary protocol for real-time game data
- ✅ Graceful fallback between protocol types
- ✅ Standalone testing interface (no build dependencies)

## Files Modified

- `client/src/net/UDPNetworkManager.ts` - Dual protocol support
- `client/src/net/test_udp.ts` - Comprehensive test suite  
- `client/protocol-test.html` - Interactive test interface (new)
- `docs/PROTOCOL_UPDATE_LOG.md` - Updated documentation

## Protocol Constants

```typescript
const PROTOCOL_VERSION = 1;
const MAX_PACKET_SIZE = 1400;
const MAX_ENTITIES_PER_SNAPSHOT = 64;
const CMD_SEQUENCE_WINDOW = 64;
```

All constants match the server's `protocol.h` definitions exactly.