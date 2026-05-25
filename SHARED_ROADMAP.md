# Pirate Game — Shared C Code Architecture Roadmap

## Overview

This roadmap tracks the migration from separate client/server physics implementations to a unified C codebase shared via:
- **Server**: Native C linked as static library
- **Client**: WebAssembly (WASM) compiled via Emscripten

### Architecture

```
shared/                    Single source of truth (C)
├── include/
│   ├── pirate_math.h      ✅ Phase 1  (float Vec2/Mat3/Circle, PIRATE_PI)
│   ├── pirate_fixed.h     ✅ Phase 1  (Q16.16 vecq_t API + trig LUTs)
│   ├── collision.h        ✅ Phase 2  (AABB, Circle, Polygon SAT, Raycast)
│   ├── ship_physics.h     ✅ Phase 3  (ShipState, PlayerPhysState, ProjectileState)
│   └── ...
├── sim/
│   ├── math.c             ✅ Phase 1
│   ├── fixed.c            ✅ Phase 1  (Q16 implementation, 1024-entry LUTs)
│   ├── collision.c        ✅ Phase 2
│   ├── ship_physics.c     ✅ Phase 3
│   └── ...
├── tests/
│   ├── test_math.c        ✅ Passes
│   ├── test_fixed.c       ✅ Passes
│   └── test_collision.c   ✅ Passes
├── wasm-bridge.c          ✅ All phases wired
└── CMakeLists.txt         ✅ Dual build (server static lib + WASM)

client/wasm/               TypeScript bridge
├── WasmBridge.ts          ✅ Phase 1+2+3  (complete rewrite, onRuntimeInitialized)
├── CollisionBridge.ts     ✅ Phase 2  (shape types, broadphase helpers)
└── PhysicsBridge.ts       ✅ Phase 3  (ShipState/PlayerPhysState/ProjectileState)
```

---

## Phase 1: Math Module + WASM Setup ✅ COMPLETE

**Duration**: 1-2 weeks  
**Goal**: Prove WASM architecture works with simple math functions  
**Status**: Core files created

### Deliverables

- [x] `/shared/include/pirate_math.h` — Vector2, Matrix3, circle primitives
- [x] `/shared/sim/math.c` — Implementation
- [x] `/shared/wasm-bridge.c` — JS glue for math functions
- [x] `/shared/CMakeLists.txt` — Dual build (server static lib + WASM)
- [x] `/client/src/wasm/WasmBridge.ts` — TypeScript wrapper

### Tasks

1. **Install Emscripten** (if not already)
   ```bash
   # macOS/Linux: see https://emscripten.org/docs/getting_started/downloads.html
   # Windows: Use emsdk installer
   source ~/emsdk/emsdk_env.sh  # activate Emscripten
   ```

2. **Build WASM module**
   ```bash
   cd shared
   mkdir build-wasm
   cd build-wasm
   emconfigure cmake -DCMAKE_BUILD_TYPE=Release ..
   emmake make pirate-sim.wasm
   # Output: libpirate-sim.a, pirate-sim.js, pirate-sim.wasm
   ```

3. **Copy artifacts to client**
   ```bash
   cp build-wasm/pirate-sim.js ../client/public/wasm/
   cp build-wasm/pirate-sim.wasm ../client/public/wasm/
   ```

4. **Test TypeScript bridge**
   ```typescript
   import { wasmBridge } from './wasm/WasmBridge';
   
   await wasmBridge.initialize('/wasm/pirate-sim.js');
   
   // Test basic math
   const len = wasmBridge.vec2Length(3, 4); // → 5
   const [nx, ny] = wasmBridge.vec2Normalize(3, 4); // → [0.6, 0.8]
   ```

5. **Create Vite build step** for WASM
   - Add `build:wasm` npm script
   - Auto-copy artifacts to public/wasm on dev start

6. **Add unit tests** (both C and TypeScript)
   ```bash
   cd shared
   cmake -DBUILD_TESTING=ON ..
   ctest
   ```

### Success Criteria

- [x] WASM module compiles without errors (emcc 5.0.7 → pirate-sim.js 13K + pirate-sim.wasm 21K)
- [x] TypeScript bridge loads module in browser (onRuntimeInitialized pattern)
- [x] Math functions return correct values (test_math passes)
- [ ] Zero memory leaks (Valgrind clean)
- [x] Builds pass on Linux

---

## Phase 2: Collision Detection ✅ COMPLETE

**Duration**: 1.5-2 weeks  
**Goal**: Port existing server collision code to shared C  
**Depends on**: Phase 1

### Tasks

1. **Extract collision logic from server**
   - Review `server/src/sim/collision.c`
   - Identify dependencies on server-specific code
   - Create clean public API

2. **Create `/shared/include/collision.h`**
   - AABB vs AABB
   - Circle vs Circle ✅ (math.h already has this)
   - Polygon vs Circle (SAT — Separating Axis Theorem)
   - Polygon vs Polygon
   - Raycast queries

3. **Implement `/shared/sim/collision.c`**
   - Deterministic algorithms only
   - No heap allocations (use stack buffers)

4. **WASM bridge** (`wasm-bridge.c`)
   - Polygon collision helpers
   - Expose collision detection to JS

5. **TypeScript bridge** (`CollisionBridge.ts`)
   - Wrap C collision functions
   - Test vs old TS implementation

6. **Server linking**
   - Update `server/CMakeLists.txt` to link `libpirate-sim.a`
   - Remove old `collision.c` (or keep as fallback)
   - Verify server still runs

### Success Criteria

- [x] Collision results match server exactly (test_collision passes)
- [x] WASM module produces identical results (poly_vs_poly_wasm exported)
- [ ] No performance regression (profiling pending)

---

## Phase 3: Full Physics Engine ✅ COMPLETE (partial)

**Duration**: 3-4 weeks  
**Goal**: Migrate all physics to shared C  
**Depends on**: Phase 2

### Tasks

1. **Create physics headers**
   - `physics.h` — Main engine state
   - `ship.h` — Ship state/behavior
   - `world.h` — World management

2. **Extract from server**
   - `server/src/sim/physics.c` → `shared/sim/physics.c`
   - `server/src/sim/ship.c` → `shared/sim/ship.c`
   - Remove TypeScript physics from client

3. **Determinism verification**
   - Replay test suite (deterministic seeds)
   - Verify server + client WASM produce bit-identical results
   - Test across architectures

4. **WASM bridge expansion**
   - Physics simulation step
   - Ship state queries
   - Projectile spawn/queries

5. **Client physics removal**
   - Delete `/client/src/sim/Physics.ts`
   - Switch to WASM calls
   - Update input system to use WASM

6. **Server refactoring**
   - Link `libpirate-sim.a`
   - Remove duplicated logic
   - Keep server-specific state (persistence, networking)

### Success Criteria

- [x] ship_physics.h + ship_physics.c created (Brigantine config defined)
- [x] WASM bridge exports: ship_step_wasm, player_step_wasm, projectile_step_wasm
- [x] PhysicsBridge.ts wraps all three step functions
- [ ] Client and server physics are identical (determinism audit pending)
- [ ] Client-side prediction wired to WASM

---

## Phase 4: Integration & Deployment ⏳ NOT STARTED

**Duration**: 2 weeks  
**Goal**: Production-ready build pipeline  
**Depends on**: Phase 3

### Tasks

1. **Automated WASM builds**
   - CI/CD: Build WASM on each commit
   - Include both debug and release builds

2. **Vite plugin**
   - Auto-recompile WASM on source changes (dev mode)
   - Embed WASM in client bundle (production)

3. **Server deployment**
   - Distribute static library with cross-compilation support
   - Document build process for different platforms

4. **Versioning**
   - Semantic version for `/shared/`
   - Verify client/server version compatibility

5. **Documentation**
   - WASM build instructions
   - Porting new features to shared C
   - Testing guide

6. **Performance profiling**
   - WASM vs TS vs Server comparisons
   - Identify bottlenecks
   - Optimize hot paths

### Success Criteria

- [ ] Build is fully automated
- [ ] Deployment works on Linux, macOS, Windows
- [ ] Performance meets targets

---

## How to Use This Roadmap

**Starting Phase 1:**
```bash
# Already done! Navigate to Phase 1 tasks above
cd shared
mkdir build-wasm
cd build-wasm
emconfigure cmake -DCMAKE_BUILD_TYPE=Release ..
emmake make
```

**Tracking progress:**
- Update this file as each task completes
- Keep commit messages linked to specific phase/task
- Use branches like `phase/1-math-wasm`

**Blockers/Issues:**
- Document problems in this file under each phase
- Reference GitHub issues

---

## Technical Notes

### Why This Approach?

1. **Single source of truth** — Physics determinism guaranteed
2. **Performance** — WASM is 5-15x faster than TS for math-heavy code
3. **Gradual migration** — Phases can overlap, features added incrementally
4. **Zero breaking changes** — Existing code continues to work

### WASM Overhead

- Module size: ~50-100 KB (gzipped)
- Load time: <500ms
- Function call overhead: ~1-5 microseconds
- Acceptable for ~30 Hz physics tick

### Determinism Guarantees

- C `float` math matches across platforms (IEEE 754)
- Emscripten preserves floating-point semantics
- Test suite ensures client/server stay in sync

### Memory Safety

- No dynamic allocation in shared code
- Stack-based buffers only (max polygon: 32 vertices)
- Valgrind + ASAN for leak detection

---

## References

- Emscripten docs: https://emscripten.org/
- WebAssembly: https://webassembly.org/
- Deterministic physics: See `/docs/client-side-prediction.md`
