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
- `PORT`: Server port (default: 8080)
- `MAX_PLAYERS`: Maximum concurrent players (default: 100)
- `TICK_RATE`: Physics simulation tick rate (default: 60)