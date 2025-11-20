# Server Optimization Roadmap
**Based on optimized_computations.md guidelines**

## Implementation Status

### ✅ Phase 1: Foundation (COMPLETED)
- [x] Fixed 30Hz simulation tick
- [x] AOI (Area of Interest) grid system
- [x] Tiered input system (4 levels: IDLE/BACKGROUND/NORMAL/CRITICAL)
- [x] WebSocket snapshot-delta compression
- [x] Admin panel with statistics

### 🔄 Phase 2: Data Layout Optimization (IN PROGRESS)
**Goal**: Convert from AoS to SoA for SIMD-friendly processing

#### 2.1 Physics Data Structures (Week 4)
- [ ] Convert Ship structure to SoA layout
  - Separate arrays: `position_x[]`, `position_y[]`, `velocity_x[]`, etc.
  - Enable SIMD batch operations (4-8 ships per instruction)
  - **Expected gain**: 2-4x physics throughput

#### 2.2 Entity Component System Pattern
- [ ] Implement archetype-based storage
- [ ] Cache-friendly iteration patterns
- [ ] Memory pool allocators for hot paths

**Files to modify**:
- `server/include/sim/types.h` - Add SoA versions
- `server/src/sim/simulation.c` - Convert physics loops
- `server/include/core/simd_math.h` - NEW: SIMD helpers

---

### 🎯 Phase 3: Physics LOD System (Week 5)
**Goal**: Distance-based quality levels for physics simulation

#### 3.1 LOD Tier Definitions
```c
typedef enum {
    PHYSICS_LOD_FULL,       // < 50m: Full simulation, CCD enabled
    PHYSICS_LOD_MEDIUM,     // 50-150m: Simplified constraints, no CCD
    PHYSICS_LOD_LOW,        // 150-300m: Kinematic interpolation only
    PHYSICS_LOD_MINIMAL     // > 300m: No physics, position updates only
} physics_lod_tier_t;
```

#### 3.2 Implementation Tasks
- [ ] Distance calculation to player camera positions
- [ ] LOD tier assignment per entity
- [ ] Constraint count reduction by LOD
- [ ] Simplified buoyancy for distant ships (single-point vs multi-sample)
- [ ] Auto-sleep for LOD_MINIMAL entities

**Expected gain**: 60-80% reduction in physics work for large worlds

**Files to create**:
- `server/include/sim/physics_lod.h`
- `server/src/sim/physics_lod.c`

---

### ⚡ Phase 4: Constraint Solver Optimization (Week 5-6)
**Goal**: Implement PGS (Projected Gauss-Seidel) with early-out

#### 4.1 Solver Improvements
- [ ] Cache Jacobian invariants (anchor points, effective mass)
- [ ] Implement warm-start from previous frame
- [ ] Add early-out convergence check (delta threshold)
- [ ] Tune Baumgarte stabilization (ERP/CFM) for 30Hz tick

#### 4.2 Iteration Budget
```c
// Adaptive iteration counts by LOD
FULL:   vel_iters=8,  pos_iters=2
MEDIUM: vel_iters=4,  pos_iters=1
LOW:    vel_iters=2,  pos_iters=0
```

**Expected gain**: 30-50% faster constraint solving

**Files to modify**:
- `server/src/sim/Physics.ts` → Port to C with optimizations
- Create `server/src/sim/constraint_solver.c`

---

### 📊 Phase 5: Profiling & Performance Budgets (Week 6)
**Goal**: Runtime monitoring and automatic degradation

#### 5.1 Performance Metrics
- [ ] Track counts per frame:
  - Active bodies, contacts, constraints
  - Solver iterations used
  - AOI entity counts per player
  - Input validation operations
  
- [ ] Add performance histograms:
  - Frame time distribution
  - Contacts per island
  - Snapshot bytes per client
  - Tier distribution (input & physics LOD)

#### 5.2 Budget Enforcement
```c
typedef struct {
    uint32_t max_active_bodies;      // 500
    uint32_t max_contacts_per_tick;  // 2000
    uint32_t max_constraints;        // 1000
    uint32_t max_aoi_entities;       // 50 per player
    float max_tick_time_ms;          // 30ms (leave 3ms headroom)
} performance_budget_t;
```

#### 5.3 Graceful Degradation
- [ ] When budget exceeded:
  1. Reduce solver iterations
  2. Drop CCD for non-critical objects
  3. Increase physics LOD distances
  4. Reduce AOI radius
  5. Force distant ships to sleep

**Files to create**:
- `server/include/core/performance_monitor.h`
- `server/src/core/performance_monitor.c`
- `server/include/core/performance_budget.h`

---

### 🚀 Phase 6: SIMD & Parallelism (Week 7-8)
**Goal**: Multi-threaded physics and vectorized math

#### 6.1 SIMD Math Library
- [ ] SSE2/SSE4.1 vector operations (x86_64)
- [ ] Batch operations for 4-8 entities at once
- [ ] Vectorized collision detection

#### 6.2 Task-Based Parallelism
- [ ] Thread pool for worker threads
- [ ] Sector-based ownership (minimize contention)
- [ ] Parallel broadphase
- [ ] Parallel constraint solving (island-level)

**Expected gain**: 3-4x throughput on 4+ core systems

**Files to create**:
- `server/include/core/simd_math.h`
- `server/src/core/simd_vec2.c`
- `server/include/core/thread_pool.h`
- `server/src/core/thread_pool.c`

---

## Performance Targets

### Current Baseline (30Hz, single-threaded)
- **Max players**: ~50 with physics
- **Tick budget**: 33ms
- **Typical usage**: 15-20ms per tick

### Target After Optimizations
- **Max players**: 200+ with full physics
- **Tick budget**: 33ms
- **Typical usage**: 8-12ms per tick (61% reduction)
- **Headroom**: 20ms for gameplay logic

### Expected Gains by Phase
| Phase | Cumulative Speedup | Max Players |
|-------|-------------------|-------------|
| Phase 1 (Current) | 1.0x | 50 |
| Phase 2 (SoA) | 2.0x | 100 |
| Phase 3 (LOD) | 4.0x | 150 |
| Phase 4 (Solver) | 5.5x | 180 |
| Phase 5 (Budgets) | 6.0x | 200 |
| Phase 6 (SIMD+MT) | 16.0x | 500+ |

---

## Implementation Priority

### Immediate (This Week)
1. **Performance monitoring foundation** (Phase 5.1)
   - Add frame time tracking
   - Basic histogram collection
   - Admin panel visualization

2. **Physics LOD skeleton** (Phase 3.1)
   - Define LOD tiers
   - Distance calculation
   - Tier assignment logic

### Short-term (Next 2 Weeks)
3. **Data layout conversion** (Phase 2.1)
   - Ship SoA structure
   - Convert physics integration loop

4. **Constraint solver improvements** (Phase 4.1)
   - Cache invariants
   - Early-out convergence

### Medium-term (Month 2)
5. **Full LOD implementation** (Phase 3.2)
6. **Performance budgets** (Phase 5.2-5.3)
7. **SIMD math library** (Phase 6.1)

### Long-term (Month 3+)
8. **Multi-threading** (Phase 6.2)
9. **Advanced optimizations** based on profiling data

---

## Success Metrics

### Developer Experience
- [ ] Real-time profiler in admin panel
- [ ] Frame time breakdown visualization
- [ ] Performance regression alerts

### Runtime Performance
- [ ] Maintain 30Hz with 200+ players
- [ ] <1% frame drops under normal load
- [ ] <5ms 99th percentile tick time

### Scalability
- [ ] Linear scaling with player count (up to LOD threshold)
- [ ] Graceful degradation under extreme load
- [ ] No hard crashes due to performance issues

---

## Next Steps

1. **Create performance monitoring system** (immediately)
2. **Implement physics LOD tiers** (this week)
3. **Begin SoA conversion** (next week)
4. **Profile and validate improvements** (ongoing)

Each phase builds on the previous, ensuring we maintain stability while improving performance.
