# Protocol Documentation

This directory contains the shared protocol definitions between the client and server.

## Message Types

### Client to Server
- **JOIN_GAME**: Player wants to join the game
- **INPUT_UPDATE**: Player input state (movement, actions)
- **PING**: Keepalive message

### Server to Client
- **GAME_STATE**: Full game state snapshot
- **STATE_UPDATE**: Incremental state update
- **PLAYER_JOINED**: New player connected
- **PLAYER_LEFT**: Player disconnected
- **PONG**: Response to ping

## Message Format

All messages use JSON format with the following structure:

```json
{
  "type": "MESSAGE_TYPE",
  "timestamp": 1234567890,
  "data": {
    // Message-specific payload
  }
}
```

## State Synchronization

The server maintains authoritative game state and sends updates to clients at 20Hz (50ms intervals). Clients perform prediction and interpolation for smooth gameplay.

### Prediction Strategy
1. Client receives input
2. Client immediately applies prediction
3. Client sends input to server
4. Server processes input and sends authoritative state
5. Client reconciles prediction with server state