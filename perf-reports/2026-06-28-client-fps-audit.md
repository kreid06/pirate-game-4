# Client FPS Audit Report — 2026-06-28

## Environment

- Branch: `cursor/client-fps-optimization-d358` (base: `develop`)
- Client build: `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0
- Server build: `cd server && make` → exit 0
- Target FPS default: 144 (`ClientConfig.graphics.targetFPS`)
- Client prediction: 120 Hz; server GAME_STATE: 30 Hz; fog worker: 20 Hz (`FOG_POST_EVERY_N_TICKS = 6`)
- Rendering: dual-canvas (WebGL ocean + Canvas 2D overlay)
- Test URL: `http://127.0.0.1:5173/pirate-game-4/?debug=true&perfstats=true`
- VM note: Cloud agent VM has no discrete GPU; GL scale often sits at 33% floor and absolute FPS numbers are not representative of player hardware. Use relative before/after and pass timings for regression checks.

---

## Profiling Snapshot

### F0 baseline (open ocean idle, ~30 s, guest login, live server)

| Metric | Value | Rating @ 144 target |
|--------|-------|---------------------|
| FPS (HUD) | 33–58 (settled ~36) | Bad |
| Frame ms (HUD) | 13–33 ms (settled ~33 ms) | Bad (>16 ms) |
| p95 frame ms | 33.4 ms | Bad |
| Hitch count (session) | 2854 (includes load/connect) | Bad |
| GL scale | 33% (floor) | Bad — adaptive scaler under load |
| Pass timings (isl/q/ex/fog) | 0/0/0/3 ms | Good — idle ocean, fog blit only |
| Ping | 31 ms | Good |

**Interpretation:** On this VM, render passes themselves are cheap at idle (fog blit ~3 ms). Sustained ~33 ms frame time with GL at 33% suggests **GPU fill-rate / software GL** or **main-thread work outside instrumented passes** (prediction, network parse, ghost-fleet entity count). Chrome Performance recording on local hardware required to separate render vs GC vs network.

### Before / after (this branch — entity culling + wrap pool)

| Change | Expected savings | Evidence |
|--------|------------------|----------|
| Cached cull bounds + scalar visibility | −2× `getWorldBounds()` + `Vec2.from` per entity check | `RenderSystem._refreshEntityCullBounds`, `Camera.isWorldPositionVisibleAt` |
| Reused wrap output arrays | −3 `[]` alloc/frame in `queueWorldObjects` | `_wrapResultShips/Players/Cannonballs` |
| Frame audit sort scratch | −120-element spread alloc/frame | `_frameMsSortedScratch` in `recordFrameAudit` |
| Hitch log top-3 passes | Debug only — no hot-path cost | `[FRAME] hitch … slow passes: fog=…` |

Local before/after Chrome profiles still required; VM absolute FPS not stable enough for regression proof.

---

## Applied Changes (2026-06-28)

### 1. Entity culling — eliminate per-check allocations

**Files:** `client/src/client/gfx/Camera.ts`, `RenderSystem.ts`

- Added `getWorldBoundsRect()` and `isWorldPositionVisibleAt(wx, wy, margin)` — scalar AABB, no `Vec2.from` per entity.
- `_refreshEntityCullBounds(camera)` runs once at `queueWorldObjects` entry; `_shouldRenderEntityAt` uses cached frustum + `camera.positionX/Y` for render-distance check.
- **Risk:** Low — same cull semantics, fewer allocs when many ships/NPCs are in AOI.

### 2. Wrap ghost output pooling

**File:** `RenderSystem.ts`

- `buildWrappedRenderCopies` accepts optional `outScratch`; ships/players/cannonballs reuse `_wrapResult*` arrays.
- **Risk:** Low — same render list contents, no shared scratch across concurrent calls.

### 3. Hitch logging with slow-pass breakdown

**File:** `ClientApplication.ts`

- When `debug.enabled && showPerformanceStats`, hitch console line includes top-3 render passes from previous frame (`fog`, `execute`, `queue`, `island`).
- **Risk:** None — debug-gated.

### 4. `perfstats=true` URL parameter

**File:** `client/src/client/main.ts`

- `?debug=true&perfstats=true` enables `debug.enabled` + `showPerformanceStats` without console setup.
- **Risk:** None — dev-only HUD rows.

### 5. Frame audit ring — reuse sort buffer

**File:** `ClientApplication.ts`

- Replaced `[..._frameMsRing].sort()` with `_frameMsSortedScratch` copy-in-place.
- **Risk:** None.

### Prior audit carry-over (already on `develop`)

Fog lower-res buffer, hybrid render world reuse, fog-visible ship filter, `renderDistance` culling, ship static composite, wrap ghost entity pool, adaptive GL scaler tuning, `__frameAuditStats` + HUD p95/hitch/pass row, fog worker 20 Hz cadence.

---

## Test Matrix F0–F9

| ID | Scenario | Duration | Frame p50/p95 | Hitches | GL scale | Pass isl/q/ex/fog | holdNew% | Smoothness | Status |
|----|----------|----------|---------------|---------|----------|-------------------|----------|------------|--------|
| F0 | Open ocean idle | 30 s | ~33 / 33.4 ms | 2854* | 33% | 0/0/0/3 ms | n/a | 2/5 | **Recorded (VM)** |
| F1 | Coast / fog | 3 min | — | — | — | — | — | — | Manual |
| F2 | Island on foot | 3 min | — | — | — | — | — | — | Manual |
| F3 | On deck solo | 3 min | — | — | — | — | — | — | Manual |
| F4 | Naval combat | 5 min | — | — | — | — | — | — | Manual |
| F5 | Multi-ship AOI | 3 min | — | — | — | — | — | — | Manual |
| F6 | Build mode UI | 3 min | — | — | — | — | — | — | Manual |
| F7 | Tab background | 2 min | — | — | — | — | — | — | Manual |
| F8 | CPU 4× throttle | 3 min | — | — | — | — | — | — | Manual |
| F9 | GL scale compare | 3 min | — | — | — | — | — | — | Manual |

\*Hitch count includes loading/connect frames; reset by refreshing after stable gameplay for clean F0–F9 runs.

**Enable metrics in browser:**

```javascript
// Or use URL: ?debug=true&perfstats=true
window.__frameAuditStats   // frameMsP50/P95, hitchCount, glScalePct, render*Ms
window.__networkAuditStats // GAME_STATE inter-arrival — network vs render triage
// PredictionEngine.DEBUG_INTERP = true  // 1 Hz holdNew/holdOld console
```

---

## Top 10 Client Bottlenecks (ranked)

### 1. Fog blur on coast / zoom — P1

- **Severity:** P1 (visible jank)
- **Evidence:** `RenderSystem.drawFogMask` — scaled blur still dominant in F1; F0 idle blit ~3 ms
- **Player symptom:** Stutter panning along fog edge, zoom scroll
- **Root cause:** Canvas 2D `blur()` on fog offscreen buffer when rays/camera dirty
- **Fix A:** Already scaled to `_glScale`; tune blur radius further / **Fix B:** GL shader feather
- **Risk:** Visual quality at fog boundary
- **Recommendation:** Ship A tuning after F1 Chrome profile on local hardware

### 2. Render queue closure volume (ships × modules) — P1

- **Severity:** P1
- **Evidence:** `queueWorldObjects` / `executeRenderQueue` — 15–30 closures per visible ship
- **Player symptom:** FPS drops with 2+ ships in fog (F5)
- **Root cause:** Per-module Canvas 2D draw lambdas queued each frame
- **Fix A:** OffscreenCanvas ship composite (distant LOD) / **Fix B:** GL batcher with interleaved compositing
- **Risk:** Pop-in at fog boundary; layer-order correctness for B
- **Recommendation:** Measure F5 before/after composite LOD spike

### 3. GL migration gap — P2

- **Severity:** P2 (scale limit)
- **Evidence:** `GLWorldRenderer` — ocean only; islands/ships/structures Canvas 2D
- **Player symptom:** CPU-bound on dense scenes despite low GL draw count
- **Root cause:** Dual-canvas layer order prevents naive GL sprite batching under 2D stack
- **Fix A:** Interleaved compositing spike / **Fix B:** Full GL world pass
- **Risk:** Maintainability, visual regressions
- **Recommendation:** Spike interleaved compositing for cannonballs first (prior audit)

### 4. Entity culling allocations — P2 (mitigated this run)

- **Severity:** P2 → P3 after fix
- **Evidence:** Was `Vec2.from` + `getState().position.clone()` per `_shouldRenderEntityAt` call
- **Player symptom:** GC micro-hitches with 100+ NPCs in ghost-fleet load
- **Root cause:** Scalar culling path missing
- **Fix A:** Cached bounds + scalar checks — **shipped this run**
- **Recommendation:** Verify with Memory timeline on F5 multi-ship

### 5. Per-frame GC (hybrid world) — P2 (mitigated prior)

- **Severity:** P2
- **Evidence:** `_hybridRenderWorld` reuse in `ClientApplication.renderFrame`
- **Status:** Fixed in 2026-06-18 audit; verify no regressions

### 6. Network holdNew masquerading as FPS — P1 (server)

- **Severity:** P1 when holdNew > 30%
- **Evidence:** [`perf-reports/2026-06-18-network-audit.md`](2026-06-18-network-audit.md)
- **Player symptom:** Entities snap at 30 Hz despite high FPS
- **Root cause:** Server tick overruns → interpolation buffer starvation
- **Fix:** Server sim budget — see [`docs/NETWORK_TESTING_PROMPT.md`](../docs/NETWORK_TESTING_PROMPT.md)
- **Recommendation:** Run network audit if `DEBUG_INTERP` holdNew > 30%; do not mask with client hacks

### 7. Ghost-fleet entity load (server-side AOI) — P2

- **Severity:** P2
- **Evidence:** Server spawns 150+ sim ships; client still processes GAME_STATE + queue for AOI entities
- **Player symptom:** Baseline frame ms higher than empty ocean theory
- **Root cause:** Large world state + prediction buffer even when off-screen
- **Fix A:** Client-side early-out before queue (renderDistance + fog — partially done) / **Fix B:** Server AOI payload trim
- **Recommendation:** Compare F0 on empty dev world vs production ghost-fleet world

### 8. cloneWorldState / snapshot parse GC — P2

- **Severity:** P2
- **Evidence:** `PredictionEngine.cloneWorldState` every GAME_STATE (~30 Hz)
- **Player symptom:** Periodic GC spikes aligned with network packets
- **Fix A:** Extend dirty-key caching to modules / **Fix B:** Smaller server blobs
- **Recommendation:** Profile Memory + `__networkAuditStats.bytes` together

### 9. Adaptive GL stuck at 33% — P2 (environment-sensitive)

- **Severity:** P2 on low-end; P3 on discrete GPU
- **Evidence:** F0 HUD `GL … @33%`; VM software rendering
- **Player symptom:** Soft ocean, persistent low scale
- **Root cause:** Sustained frame over budget triggers downshift; VM cannot recover
- **Fix A:** Tune thresholds on real hardware / **Fix B:** User quality preset
- **Recommendation:** Re-test F0/F8 on player machine before changing scaler constants

### 10. MAX_TICKS_PER_FRAME backlog — P3

- **Severity:** P3
- **Evidence:** Cap 5 × 120 Hz in `ClientApplication.gameLoop`
- **Player symptom:** Input catch-up after tab focus, not sustained render jank
- **Fix:** Tune only with input latency measurements
- **Recommendation:** Defer

---

## Manual Chrome Trace Checklist

### F0 — Open ocean idle (baseline)

1. `?debug=true&perfstats=true` → guest login → wait 3 min idle on ocean
2. Note HUD: FPS, frame ms, p95, hitches, GL scale %
3. DevTools → Performance → Record 60 s (Screenshots on)
4. Export: Main thread busy %, top 5 functions, longest task
5. Console: `JSON.stringify(window.__frameAuditStats)` and `window.__networkAuditStats`

### F4 — Naval combat

1. Engage ghost fleet or spawn combat scenario; record 5 min
2. Same Chrome protocol; enable Memory if GC spikes > 5 ms
3. Compare pass timings: expect `execute` and `queue` ↑ vs F0

### F8 — CPU 4× slowdown

1. DevTools → Performance → CPU: 4× slowdown
2. Record 3 min F0-equivalent idle
3. Expect GL scale → 33%; note hitch rate vs acceptance table

---

## Proposed (Needs Human Review)

1. **Fog blur radius reduction** at 33% GL scale (visual QA on F1 coast pan)
2. **OffscreenCanvas distant ship LOD** — composite static layers when zoom < 1.5 and off-center
3. **GL interleaved compositing spike** — cannonballs before islands (layer-order constraint from 2026-06-18)
4. **Pause menu toggle** for `showPerformanceStats` (still unwired in UI)
5. **PredictionEngine stats in HUD** — wire `getEnhancedPredictionStats()` for holdNew visibility without console

Do **not** auto-apply: reducing `clientTickRate` below 120 Hz, disabling fog, toggling `enableShipPrediction` without deck QA, or lowering user `targetFPS` as a “fix”.

---

## Build Verification

- `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0
- `cd server && make` → exit 0

---

## Dev Panel Follow-up

- [x] `?perfstats=true` URL wiring
- [x] Hitch log with top-3 slow passes (debug)
- [x] Per-pass timers in HUD when `showPerformanceStats`
- [ ] Pause menu toggle for `showPerformanceStats`
- [ ] HUD row for `PredictionEngine` holdNew / buffer spacing
- [ ] Reset hitch counter button or auto-reset on stable gameplay (session hitch count mixes load + play)
