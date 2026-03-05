# Pirate Game 4 — Progress & Roadmap

Multiplayer pirate ship physics game. Client (TypeScript/Vite) + Server (C/Linux) communicating over WebSocket.

**Quick start:**
```bash
# Client
cd client && npm install && npm run dev    # http://localhost:5173

# Server
cd server && make && ./bin/pirate-server   # ws://localhost:8082
```

---

## What's Working Now

- [x] WebSocket server (port 8082) with full handshake and GAME_STATE broadcasts
- [x] Player spawning on ship, WASD walking in ship-local coordinates
- [x] Ship rendering with module system (cannons, helm, masts, ladders)
- [x] Mount helm → switch to ship control mode (rudder/sail inputs)
- [x] Cannon aiming (right-click) and firing (left-click / double-click broadside)
- [x] Projectile spawning with correct directional physics
- [x] Admin panel (port 8081) for live server monitoring
- [x] Brigantine physics properties broadcast in GAME_STATE
- [x] Client-side prediction for player movement
- [x] SSL/WSS support via nginx reverse proxy

---

## In Progress

- [ ] Ship sailing physics — wind, momentum, water drag applying to ship movement
- [ ] Sim/types.h Ship struct integration (currently using SimpleShip parallel struct)
- [ ] Cannon reload feedback visible on client
- [ ] Player boarding — jump off ship into water, swim to another ship

---

## Roadmap

### Next Up
- **Ship combat** — cannonball damage model, hull HP, sinking
- **Multiple ships** — spawn more ships, assign players to them
- **Wind system** — directional wind affecting sail efficiency
- **Collision** — ship-ship and ship-terrain collisions

### Medium Term
- **Persistence** — player name/stats saved across sessions
- **Map / world** — islands, shallow water, hazards
- **Crew roles** — captain, gunner, navigator with different controls
- **Chat** — in-game player chat

### Long Term
- **Fleet battles** — coordinated multi-ship PvP
- **Economy** — cargo, trading ports, plunder
- **AI ships** — NPC vessels with basic sailing behaviour
- **Mobile controls** — touch support for mobile browsers

---

## Architecture

```
client/    TypeScript · Vite · Canvas 2D
server/    C · Linux · libwebsockets
protocol/  Shared JSON schemas & C header (ship_definitions.h)
docs/      Technical references
```

Full protocol reference: [docs/PROTOCOL.md](docs/PROTOCOL.md)  
Architecture deep-dive: [docs/architecture.md](docs/architecture.md)  
Development history: [docs/archive/SPRINT_HISTORY.md](docs/archive/SPRINT_HISTORY.md)