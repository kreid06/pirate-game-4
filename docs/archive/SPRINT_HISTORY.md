# Sprint History Archive

A consolidated record of completed development sprints and milestones.

---

## Pre-Sprint: Action Plan

**Assessment at start**: Server at prototype stage (2/10).

### 2-Week Foundation Goals
- Q16.16 deterministic math, UDP networking, simulation core
- AOI spatial grid, snapshot system, memory pools

### 6-Week Production Goals
- Rewind buffer / lag compensation, input validation / anti-cheat
- Performance optimization (SIMD, profiling), CI/CD pipeline

**Acceptance Criteria**:
- Tick p95 ≤ 6ms @ 100 players + 150 NPCs
- Area egress ≤ 5 Mbps, per-player p95 ≤ 50 kbps
- ±1 frame fairness @ 150ms RTT
- 100% synthetic anti-cheat detection, <1% false positives
- 2-hour soak test with 0 crashes/leaks

---

## Phase 1: Player-Ship Architecture

**Outcome**: ✅ Complete

### What Was Built
- `SimpleShip` struct (position, rotation, velocity, deck boundaries)
- Player `parent_ship_id` / `local_x,y` / `movement_state` fields
- `ship_local_to_world()` and `ship_clamp_to_deck()` helper functions
- WALKING (ship-local coords) vs SWIMMING (world coords) movement
- Updated `GAME_STATE` broadcast includes ships array and player local positions

### Network Protocol Added
```json
{
  "ships": [{ "id": 1, "x": 400, "y": 300, "rotation": 0, ... }],
  "players": [{ "id": 1000, "parent_ship": 1, "local_x": 0, "local_y": 0, "state": "WALKING", ... }]
}
```

### Known Limitations at Completion
- Ships stationary (no sailing physics yet)
- Only one test ship
- No boarding / jump mechanics
- SimpleShip not yet integrated with sim/types.h Ship struct

---

## Week 1: Deterministic Core Foundation

**Outcome**: ✅ All targets met

### Completed Systems
| System | Files | Notes |
|--------|-------|-------|
| Q16.16 Fixed-Point Math | `include/core/math.h`, `src/core/math.c` | 400+ lines, saturation arithmetic |
| Deterministic RNG | `include/core/rng.h`, `src/core/rng.c` | xorshift64* |
| Trigonometry Tables | — | 1024-entry sin/cos lookup |
| Entity-Component-System | `include/sim/types.h`, `src/sim/simulation.c` | SoA layout, 500+ lines |
| 30Hz Fixed-Step Physics | `src/sim/simulation.c` | State hashing via xxHash64 |
| AOI Spatial Grid | `include/aoi/grid.h`, `src/aoi/grid.c` | 128×128 cells @ 64m each |
| UDP Protocol Foundation | `include/net/protocol.h`, `src/net/protocol.c` | Bit-packed, checksummed |
| Build & Test Infrastructure | `CMakeLists.txt`, `build.sh`, `tests/` | ASAN/UBSAN, bot client |

### Performance Results
| Metric | Target | Achieved |
|--------|--------|----------|
| Tick p95 | ≤ 6ms | ~1.2 µs (99.98% headroom) |
| Determinism | 100% replay | ✅ 900-tick hash-validated |
| AOI coverage | 64m cells | ✅ Full spatial queries working |

---

## Week 2: Reliability & Network Integration

**Outcome**: ✅ All targets met — rated 10/10

### Completed Systems
| System | Files | Lines |
|--------|-------|-------|
| Reliability Layer | `src/net/reliability.c`, `include/net/reliability.h` | 700+ |
| Snapshot System | `src/net/snapshot.c`, `include/net/snapshot.h` | 500+ |
| Network Manager | `src/net/network.c`, `include/net/network.h` | — |
| Server Main Loop | `src/core/server.c` | — |

### Key Features
- 32-bit sliding window ACK/NACK with exponential backoff (500ms timeout, 5 retries)
- Delta-compressed snapshots (~70% bandwidth reduction)
- Priority tiers: 30Hz / 15Hz / 5Hz based on AOI distance
- RTT with EMA smoothing (7/8 factor), 30-second connection timeout
- Non-blocking UDP with rate limiting (100 packets/tick max)

### Performance Results
- 25 kbps baseline per player (target ≤ 50 kbps)
- <500ms packet loss recovery
- Designed for 100+ concurrent players

---

## Week 3–4: Lag Compensation & Anti-Cheat

**Outcome**: ✅ Core systems complete; network integration completed separately

### Core Features Built
| Feature | File | Description |
|---------|------|-------------|
| Rewind Buffer | `src/core/rewind_buffer.c` | 16-frame ring buffer, 350ms+ coverage |
| Input Validation | `src/core/input_validation.c` | Rate limit 120Hz, movement bounds, anomaly detection |
| Hit Validation | — | Raycast against historical positions |
| Simulation Bridge | `src/sim/simulation.c` | `simulation_has_entity()`, `simulation_process_player_input()` |

### Anti-Cheat Thresholds
- Max input rate: 120Hz (8.33ms intervals)
- Anomaly auto-ban: 85% score threshold
- Movement vectors: normalized bounds check

### Network Build Integration (completed after core)
- All Week 3–4 systems integrated into network layer
- Full build passes: `gcc … -o bin/pirate-server`
- UDP port 8080 bound at startup
- Handshake, input validation, snapshot generation all operational

### Performance
- Rewind coverage: 350ms+ at 30Hz
- Input validation: <1ms per packet
- Delta compression: 60–80% snapshot bandwidth reduction

---

## Migration Plan Summary (Player-Ship Separation)

The migration from "players ARE ships" to "players walk ON ships" was completed across these phases:

| Phase | Goal | Status |
|-------|------|--------|
| Phase 1 | Ship entity system + coordinate conversion | ✅ Done |
| Phase 2 | Player-ship relationship + movement update | ✅ Done |
| Phase 3 | Game state broadcast update | ✅ Done |
| Phase 4 | Integration with existing Sim structs | 🔄 Ongoing |
| Phase 5 | Multiple ships, full combat, advanced physics | 🔄 Future |
