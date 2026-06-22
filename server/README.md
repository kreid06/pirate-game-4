# Pirate Game Server

## Build Instructions

### Prerequisites
- GCC or Clang compiler
- Make
- libwebsockets-dev (for WebSocket support)
- libjson-c-dev (for JSON parsing)

### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install build-essential libwebsockets-dev libjson-c-dev
```

### Build
```bash
make
```

### Run
```bash
./bin/pirate-server
```

## Architecture
- **src/core/**: Core server logic and game state management
- **src/sim/**: Physics simulation engine (deterministic)
- **src/net/**: Network layer and WebSocket handling
- **src/common/**: Shared utilities and data structures
- **include/**: Header files

## Configuration

Server configuration is handled via environment variables or config files:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8082 (WebSocket), 8081 (admin), 8080 (UDP) |
| `MAX_PLAYERS` | Maximum concurrent players | 100 |
| `TICK_RATE` | Physics simulation tick rate | 60 |
| **`JWT_SECRET`** | Shared HMAC secret for login tokens (auth + game server) | **Required** |

**JWT setup:** see [docs/JWT_SECRET.md](docs/JWT_SECRET.md) for generating, setting, and deploying `JWT_SECRET`.
