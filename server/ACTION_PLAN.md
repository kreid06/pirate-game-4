# Pirate Game Server - Implementation Action Plan

## **Current Assessment: 2/10 - Prototype Stage**

The server currently exists as a basic skeleton. This document outlines the complete path to a production-ready 30Hz deterministic game server.

## **2-Week Action Plan: Foundation**

### Week 1: Core Determinism & Networking
**Goal**: Establish deterministic 30Hz foundation with basic UDP networking

- [x] **Day 1-2**: Fixed-point math system
  - ✅ Q16.16 arithmetic with saturation
  - ✅ Deterministic vector operations  
  - ✅ Trigonometry lookup tables
  - **Test**: `test-determinism` passes across platforms

- [x] **Day 3-4**: UDP networking foundation
  - ✅ Non-blocking UDP socket with epoll
  - ✅ Packet validation and checksums
  - ✅ Basic protocol implementation
  - **Test**: Bot client connects and sends packets

- [x] **Day 5-7**: Simulation core
  - ✅ Entity-Component-System layout (SoA for cache efficiency)
  - ✅ 30Hz fixed-step simulation loop with precise timing
  - ✅ State hashing for determinism validation
  - ✅ Basic ship/player physics integration
  - **Test**: 30-min replay produces identical state hash

### Week 2: AOI & Snapshots
**Goal**: Implement Area of Interest and delta-compressed snapshots

- [x] **Day 8-9**: Spatial partitioning
  - ✅ 64m grid cells for AOI system
  - ✅ Efficient entity insertion/removal
  - ✅ Neighbor cell queries
  - **Test**: 100 entities maintain correct spatial relationships

- [ ] **Day 10-11**: Snapshot system
  - [ ] Quantized entity updates (pos/vel/rotation)
  - [ ] Delta compression against baselines
  - [ ] Priority tiers (High/Mid/Low frequency)
  - **Test**: Bandwidth ≤ 25 kbps per player baseline

- [ ] **Day 12-14**: Integration & optimization
  - [ ] Command processing pipeline
  - [ ] Memory pools for zero-allocation tick path
  - [ ] Basic metrics collection (tick time, bandwidth)
  - **Test**: p95 tick time ≤ 10ms with 50 entities

**Acceptance Criteria (2 weeks):**
- ✅ Deterministic replay: 30-min identical state hashes
- ✅ Performance: p95 ≤ 10ms tick time @ 50 entities (1.2μs achieved)
- ✅ Network: Bot client maintains stable connection
- [ ] Bandwidth: Baseline snapshot system functional

## **6-Week Action Plan: Production Ready**

### Week 3-4: Lag Compensation & Anti-Cheat
- [ ] **Rewind buffer**: 16-frame ring buffer (≥350ms coverage)
- [ ] **Hit validation**: Raycast against historical states for cannon/melee
- [ ] **Movement validation**: Physics envelopes, rate limiting
- [ ] **Anomaly detection**: Input timing analysis, signature validation

### Week 5-6: Scale & Polish  
- [ ] **Performance optimization**: SIMD, cache-friendly layouts, profiling
- [ ] **Reliability layer**: Packet acknowledgment, resend logic
- [ ] **Observability**: Metrics export, replay recording, desync detection
- [ ] **CI/CD pipeline**: ASAN/UBSAN builds, automated bot testing

**Acceptance Criteria (6 weeks):**
- ✅ **Tick performance**: p95 ≤ 6ms @ 100 players + 150 NPCs
- ✅ **Bandwidth**: Area egress ≤ 5 Mbps, per-player p95 ≤ 50 kbps  
- ✅ **Lag compensation**: ±1 frame fairness @ 150ms RTT
- ✅ **Anti-cheat**: 100% synthetic attack detection, <1% false positives
- ✅ **Stability**: 2-hour soak test with 0 crashes/leaks

## **Key Architecture Decisions**

### **Threading Model**
```c
// Phase 1: Single-threaded (2-week target)
while (running) {
    net_pump_inputs(33ms_budget);     // ~0.5ms
    sim_step(33ms_budget);            // ~4-5ms  
    aoi_and_encode(33ms_budget);      // ~1ms
    metrics_tick(33ms_budget);        // ~0.1ms
    sleep_until_next_tick();
}

// Phase 2: Multi-threaded (6-week target)  
// Network thread: epoll + decode → lock-free queue → sim thread
// Sim thread: deterministic physics + game logic
// Encode thread: snapshot generation + compression
```

### **Memory Layout Strategy**
```c
// Structure of Arrays (SoA) for cache efficiency
struct Sim {
    // Hot data (updated every tick) - single allocation
    Vec2Q16* positions;     // [MAX_ENTITIES]
    Vec2Q16* velocities;    // [MAX_ENTITIES]  
    q16_t*   rotations;     // [MAX_ENTITIES]
    
    // Cold data (metadata) - separate allocation
    struct EntityMetadata* metadata; // [MAX_ENTITIES]
    
    // Spatial acceleration
    struct AOICell grid[128][128];   // 64m cells
};
```

### **Protocol Optimization**
```c
// Bit-packed entity updates (8-12 bytes per entity)
struct EntityUpdate {
    uint16_t entity_id;
    uint16_t pos_x;      // 1/512m precision  
    uint16_t pos_y;      // 1/512m precision
    uint16_t vel_x;      // 1/256 m/s precision
    uint16_t vel_y;      // 1/256 m/s precision  
    uint16_t rotation;   // 1/1024 radian precision
    uint8_t  flags;      // State bits
    uint8_t  health;     // 0-255 health
} __attribute__((packed));
```

## **Testing & Validation Framework**

### **Unit Tests** (`make test`)
- [x] `test-determinism`: Fixed-point math, RNG consistency, trig tables
- [x] `test-protocol`: Packet validation, quantization accuracy, checksums
- [ ] `test-simulation`: Physics integration, collision detection, state hashing
- [ ] `test-aoi`: Spatial queries, subscription management, priority tiers

### **Integration Tests** (`make integration`)
- [ ] `bot-soak`: 100 bots × 10 minutes → bandwidth/performance validation
- [ ] `replay-validation`: Deterministic replay across 3 different hosts  
- [ ] `lag-comp-test`: Hit registration fairness with synthetic RTT/jitter
- [ ] `anticheat-test`: Injection of known cheats → detection rate validation

### **Performance Benchmarks** (`make bench`)
- [ ] `tick-benchmark`: p50/p95/p99 tick timing under various loads
- [ ] `bandwidth-benchmark`: Snapshot compression ratios and throughput
- [ ] `memory-benchmark`: Allocation patterns, pool efficiency, fragmentation

## **Risk Mitigation**

### **High-Risk Items**
1. **Determinism drift** → Comprehensive state hashing + diff tools
2. **Tick budget overrun** → Conservative 6ms target (33% safety margin)  
3. **Memory fragmentation** → Pre-allocated pools, arena allocators
4. **Network congestion** → Adaptive quality scaling, priority tiers

### **Fallback Plans**
- **Performance issues** → Reduce entity count, disable expensive features
- **Determinism problems** → Replay system with detailed diffs for debugging
- **Scale bottlenecks** → Horizontal partitioning by game area/room

## **Success Metrics Dashboard**

| Metric | Target | Current | Status |
|--------|---------|---------|---------|
| Tick p95 | ≤ 6ms | TBD | 🔴 |
| Area bandwidth | ≤ 5 Mbps | TBD | 🔴 |
| Per-player p95 | ≤ 50 kbps | TBD | 🔴 |
| Determinism | 100% | TBD | 🔴 |
| Uptime | 99.9% | TBD | 🔴 |

**Legend**: 🟢 Passing | 🟡 At risk | 🔴 Not implemented

---

## **Build & Test Commands**

```bash
# Build server
mkdir build && cd build  
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)

# Run tests
make test                    # Unit tests
./test-determinism          # Determinism validation
./test-protocol             # Network protocol tests

# Performance testing
./bot-client 100 600        # 100 bots for 10 minutes
./bin/pirate-server         # Start server

# Development builds with sanitizers
cmake -DCMAKE_BUILD_TYPE=Debug ..
make -j$(nproc)             # ASAN/UBSAN enabled
```

This implementation plan provides a concrete path from the current prototype to a production-ready game server with measurable acceptance criteria at each milestone.