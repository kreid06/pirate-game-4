# Pirate Game - Client/Server Architecture

A multiplayer pirate ship physics game with split client/server architecture for scalable online gameplay.

## Project Structure

```
pirate-game-4/
├── client/          # TypeScript/Vite web client
├── server/          # C-based Linux server
├── protocol/        # Shared protocol definitions
├── docs/           # Documentation
└── .github/        # GitHub configuration
```

## Components

### Client (`client/`)
- **Language**: TypeScript
- **Framework**: Vite + WebGL/Canvas
- **Purpose**: Browser-based game client with prediction
- **Features**: Input handling, rendering, client-side prediction

### Server (`server/`)
- **Language**: C
- **Platform**: Linux
- **Purpose**: Authoritative game server
- **Features**: Physics simulation, state management, networking

### Protocol (`protocol/`)
- **Format**: JSON schemas
- **Purpose**: Message definitions for client-server communication
- **Features**: Type safety, validation, documentation

## Getting Started

### Client Development
```bash
cd client
npm install
npm run dev
```

### Server Development (Linux/WSL)
```bash
cd server
make install-deps
make
./bin/pirate-server
```

## Architecture Notes

### Client-Side Prediction
The client predicts player movement locally for responsive input while awaiting server confirmation.

### Server Authority
The server maintains the authoritative game state and resolves conflicts between client predictions.

### Network Protocol
WebSocket-based communication with JSON messages. Future consideration for WebTransport.

### Physics Determinism
Both client and server use identical physics algorithms to ensure consistent simulation.

## Development Workflow

1. **Protocol First**: Define messages in `protocol/schemas/`
2. **Server Implementation**: Implement authoritative logic in C
3. **Client Integration**: Connect client to server protocol
4. **Testing**: Validate synchronization and performance

## Deployment

### Client
- Build with `npm run build`
- Deploy static files to CDN/web server
- Configure WebSocket endpoint

### Server
- Compile on target Linux environment
- Configure firewall for WebSocket port
- Run as systemd service for production

## Contributing

See individual component READMEs for specific development instructions:
- [Client Development](client/README.md)
- [Server Development](server/README.md)
- [Protocol Documentation](protocol/README.md)