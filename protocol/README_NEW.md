# Pirate Game Protocol Examples

This directory contains working examples of how to implement the Pirate Game network protocol.

## 🚀 Live Server Status

✅ **WebSocket Server** - Port 8080 - Browser clients  
✅ **UDP Game Server** - Port 8081 - Native clients  
✅ **HTTP Admin Panel** - Port 8082 - Web dashboard  

## 📁 Files

### `protocol_implementation.ts`
- Original UDP-focused implementation examples
- Node.js/native client patterns
- Direct UDP communication examples

### `protocol_implementation_websocket.ts`
- **NEW!** Complete WebSocket client implementation
- Browser-compatible 
- Full-featured with reconnection, error handling, latency monitoring
- Same protocol as UDP but over WebSocket transport

### `websocket_test.html`
- Interactive HTML test page
- Live WebSocket connection testing
- Real-time protocol command testing

## 🧪 Quick Testing

### 1. Test WebSocket (Browser)
```bash
# Start simple HTTP server
cd protocol
python3 -m http.server 3000

# Open: http://localhost:3000/websocket_test.html
# Click "Connect" to test WebSocket on port 8080
```

### 2. Test UDP (Command Line)
```bash
# Test PING
echo "PING" | nc -u localhost 8081
# Response: PONG

# Test JOIN
echo "JOIN:TestPlayer" | nc -u localhost 8081  
# Response: {"type":"WELCOME","player_id":1234,"server_time":12345,"player_name":"TestPlayer"}

# Test STATE
echo "STATE" | nc -u localhost 8081
# Response: {"type":"GAME_STATE","tick":123,"time":12345,"ships":[],"players":[],"projectiles":[]}
```

### 3. Test Admin Panel (HTTP)
```bash
# Open in browser: http://localhost:8082
# Features:
# - Server status dashboard
# - Live map visualization  
# - Real-time statistics
# - Physics object monitoring
```

## 🔄 Protocol Bridge

The server automatically translates between UDP and WebSocket:

```
Native Client --UDP--> Server <--WebSocket-- Browser Client
             (Port 8081)     (Port 8080)
```

Both clients can:
- Join the same game world
- Send the same commands (`PING`, `JOIN:Name`, `STATE`)
- Receive the same responses
- Interact with each other in real-time

Happy sailing! ⚓🏴‍☠️