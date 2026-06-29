# Client FPS Audit Report — 2026-06-29

## Environment

- Branch: `cursor/client-fps-optimization-e2e4` (base: `develop`)
- Client build: `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0
- Server build: `cd server && make` → exit 0 (requires `libjson-c-dev libssl-dev libwebsockets-dev`)
- Target FPS default: 144 (`ClientConfig.graphics.targetFPS`)
- Client prediction: 120 Hz; server GAME_STATE: 30 Hz; fog worker: 20 Hz (`FOG_POST_EVERY_N_TICKS = 6`)
- Rendering: dual-canvas (WebGL ocean + Canvas 2D overlay)
- Test URL: `http://127.0.0.1:5173/pirate-game-4/?debug=true&perfstats=true`
- VM note: Cloud agent VM has no discrete GPU; GL scale sits at 33% floor and absolute FPS numbers are **not** representative of player hardware. Use relative before/after and pass timings for regression checks.

---

## Profiling Snapshot

### F0 baseline (open ocean idle, 35 s after guest login, live server)

Captured via headless Chromium (Playwright) with `?debug=true&perfstats=true`. WebSocket remained in reconnecting state in headless mode; render loop and HUD metrics still populated.

| Metric | Value | Rating @ 144 target |
|--------|-------|---------------------|
| FPS (HUD) | 42 | Bad |
| Frame ms (last) | 33.3 ms | Bad (>16 ms) |
| Frame ms p50 | 16.7 ms | Investigate |
| Frame ms p95 | 33.4 ms | Bad |
| Hitch count (session) | 1391 (includes load/auth) | Bad |
| GL scale | 33% (floor) | Bad — adaptive scaler under load |
| Pass timings (isl/q/ex/fog) | 0 / 0 / 0.2 / 0 ms | Good — idle ocean, minimal 2D work |
| Ping | n/a (WS reconnecting in headless) | — |

```json
{
  "frameMsLast": 33.3,
  "frameMsP50": 16.7,
  "frameMsP95": 33.4,
  "hitchCount": 1391,
  "fps": 42,
  "glScalePct": 33,
  "renderIslandMs": 0,
  "renderQueueMs": 0,
  "renderExecuteMs": 0.2,
  "renderFogMs": 0
}
```

**Interpretation:** Instrumented render passes are cheap at idle (execute ~0.2 ms, fog blit 0 ms). Sustained p95 ~33 ms with GL at 33% indicates **GPU fill-rate / software GL** or **main-thread work outside instrumented passes** (prediction interpolation, network parse, ghost-fleet entity count). Chrome Performance recording on local hardware required to separate render vs GC vs network.

### Before / after (this branch — wrap offsets + Set reuse + frame audit + fog worker)

| Change | Expected savings | Evidence |
|--------|------------------|----------|
| Pooled wrap-offset scratch + scalar AABB cull | −40 arrays + ~80–200 `Vec2.from`/frame at wrap seams | `RenderSystem.getWrapRenderOffsets` |
| Reused `_currentShipIdsScratch` Set | −1 `Set` alloc/frame in `queueWorldObjects` | `RenderSystem.ts:9649` |
| In-place `__frameAuditStats` mutation | −1 object alloc/frame in `recordFrameAudit` | `ClientApplication._frameAuditStatsObj` |
| FogWorker double-buffer postMessage | −128 B `buffer.slice()` copy @ 20 Hz | `FogWorker.ts` resultA/resultB alternation |

Local before/after Chrome profiles still required; VM absolute FPS not stable enough for regression proof.

---

## Applied Changes (2026-06-29)

### 1. Wrap-offset discovery pooling

**File:** `client/src/client/gfx/RenderSystem.ts`

- `getWrapRenderOffsets` reuses `_wrapOffsetScratch` slots (no per-entity array or `{dx,dy}` alloc).
- Static `_WRAP_CANDIDATE_OFFSETS` replaces per-call candidates array.
- Scalar AABB test against cached `_cullBounds*` (no `Vec2.from` + `camera.isWorldPositionVisible`).
- **Risk:** Low — same wrap semantics when `_refreshEntityCullBounds` runs before `buildWrappedRenderCopies`.

### 2. Ship-id Set reuse in queueWorldObjects

**File:** `client/src/client/gfx/RenderSystem.ts`

- `_currentShipIdsScratch.clear()` replaces `new Set<number>()` each frame for sinking-ghost tracking.
- **Risk:** None — same semantics, one fewer short-lived object per frame.

### 3. In-place frame audit stats object

**File:** `client/src/client/ClientApplication.ts`

- `_frameAuditStatsObj` mutated in place; `window.__frameAuditStats` keeps stable reference.
- **Risk:** None — debug HUD consumers read numeric fields only.

### 4. FogWorker zero-copy double buffer

**File:** `client/src/workers/FogWorker.ts`

- Alternates `resultA` / `resultB` Float32Arrays; transfers buffer without `slice(0)` copy.
- **Risk:** Low — worker-side only; main thread already wraps transferred buffer in new Float32Array.

### Prior audit carry-over (already on `develop`)

Entity culling scalar bounds, wrap output pooling, fog lower-res buffer, hybrid render world reuse, fog-visible ship filter, `renderDistance` culling, ship static composite, wrap ghost entity pool, adaptive GL scaler, `__frameAuditStats` + HUD p95/hitch/pass row, fog worker 20 Hz cadence, `?perfstats=true` URL wiring, hitch log with top-3 slow passes.

---

## Test Matrix F0–F9

| ID | Scenario | Duration | Frame p50/p95 | Hitches | GL scale | Pass isl/q/ex/fog | holdNew% | Smoothness | Status |
|----|----------|----------|---------------|---------|----------|-------------------|----------|------------|--------|
| F0 | Open ocean idle | 35 s | 16.7 / 33.4 ms | 1391* | 33% | 0/0/0.2/0 ms | n/a | 2/5 | **Recorded (VM)** |
| F1 | Coast / fog | 3 min | — | — | — | — | — | — | Manual |
| F2 | Island on foot | 3 min | — | — | — | — | — | — | Manual |
| F3 | On deck solo | 3 min | — | — | — | — | — | — | Manual |
| F4 | Naval combat | 5 min | — | — | — | — | — | — | Manual |
| F5 | Multi-ship AOI | 3 min | — | — | — | — | — | — | Manual |
| F6 | Build mode UI | 3 min | — | — | — | — | — | — | Manual |
| F7 | Tab background | 2 min | — | — | — | — | — | — | Manual |
| F8 | CPU 4× throttle | 3 min | — | — | — | — | — | — | Manual |
| F9 | GL scale compare | 3 min | — | — | — | — | — | Manual |

\*Hitch count includes loading/auth frames; reset by refreshing after stable gameplay for clean F0–F9 runs.

**Enable metrics in browser:**

```javascript
// Or use URL: ?debug=true&perfstats=true
window.__frameAuditStats   // frameMsP50/P95, hitchCount, glScalePct, render*Ms
window.__networkAuditStats // GAME_STATE inter-arrival — network vs render triage
// PredictionEngine.DEBUG_INTERP = true  // 1 Hz holdNew/holdOld console
```

---

## Top 10 Client Bottlenecks (ranked)

### 1. Render queue closure volume (ships × modules) — P1

- **Severity:** P1 (visible jank)
- **Evidence:** `queueWorldObjects` / `executeRenderQueue` — 15–30 closures per visible ship
- **Player symptom:** FPS drops with 2+ ships in fog (F5)
- **Root cause:** Per-module Canvas 2D draw lambdas queued each frame
- **Fix A:** OffscreenCanvas ship composite (distant LOD) / **Fix B:** GL batcher with interleaved compositing
- **Risk:** Pop-in at fog boundary; layer-order correctness for B
- **Recommendation:** Measure F5 before/after composite LOD spike

### 2. Fog blur on coast / zoom — P1

- **Severity:** P1 (visible jank)
- **Evidence:** `RenderSystem.drawFogMask` — scaled blur dominant in F1; F0 idle blit ~0 ms
- **Player symptom:** Stutter panning along fog edge, zoom scroll
- **Root cause:** Canvas 2D `blur()` on fog offscreen buffer when rays/camera dirty
- **Fix A:** Already scaled to `_glScale`; tune blur radius further / **Fix B:** GL shader feather
- **Risk:** Visual quality at fog boundary
- **Recommendation:** Ship A tuning after F1 Chrome profile on local hardware

### 3. Per-frame interpolation allocations — P1

- **Severity:** P1
- **Evidence:** `PredictionEngine.interpolateStates` → `lerpVec2` → `Vec2.from` every RAF frame
- **Player symptom:** GC micro-hitches even when render passes are cheap (F0 p95 >> p50)
- **Root cause:** Fresh interpolated world object graph each frame (~120+ Vec2/frame in busy AOI)
- **Fix A:** Reusable `_interpWorldScratch` + `lerpVec2Into(out, …)` / **Fix B:** Smaller server blobs
- **Risk:** Low if slot semantics preserved
- **Recommendation:** Spike Fix A with Memory timeline on F0/F5

### 4. GL migration gap — P2

- **Severity:** P2 (scale limit)
- **Evidence:** `GLWorldRenderer` — ocean only; islands/ships/structures Canvas 2D
- **Player symptom:** CPU-bound on dense scenes despite low GL draw count
- **Root cause:** Dual-canvas layer order prevents naive GL sprite batching under 2D stack
- **Fix A:** Interleaved compositing spike / **Fix B:** Full GL world pass
- **Risk:** Maintainability, visual regressions
- **Recommendation:** Spike interleaved compositing for cannonballs first

### 5. Network holdNew masquerading as FPS — P1 (server)

- **Severity:** P1 when holdNew > 30%
- **Evidence:** [`perf-reports/2026-06-18-network-audit.md`](2026-06-18-network-audit.md)
- **Player symptom:** Entities snap at 30 Hz despite high FPS
- **Root cause:** Server tick overruns → interpolation buffer starvation
- **Fix:** Server sim budget — see [`docs/NETWORK_TESTING_PROMPT.md`](../docs/NETWORK_TESTING_PROMPT.md)
- **Recommendation:** Run network audit if `DEBUG_INTERP` holdNew > 30%; do not mask with client hacks

### 6. Ghost-fleet entity load (server-side AOI) — P2

- **Severity:** P2
- **Evidence:** Server spawns 150+ sim ships; client processes GAME_STATE + queue for AOI entities
- **Player symptom:** Baseline frame ms higher than empty ocean theory
- **Root cause:** Large world state + prediction buffer even when off-screen
- **Fix A:** Client early-out (renderDistance + fog — partially done) / **Fix B:** Server AOI payload trim
- **Recommendation:** Compare F0 on empty dev world vs production ghost-fleet world

### 7. cloneWorldState / snapshot parse GC — P2

- **Severity:** P2
- **Evidence:** `PredictionEngine.cloneWorldState` every GAME_STATE (~30 Hz); modules still mapped
- **Player symptom:** Periodic GC spikes aligned with network packets
- **Fix A:** Extend dirty-key caching to modules / **Fix B:** Smaller server blobs
- **Recommendation:** Profile Memory + `__networkAuditStats.bytes` together

### 8. Ship wake radial gradients — P2

- **Severity:** P2
- **Evidence:** `drawShipWake` — `createRadialGradient` per visible moving ship each frame
- **Player symptom:** execute pass ↑ with 3+ moving ships (F5 naval)
- **Fix A:** Quantized wake alpha buckets / **Fix B:** Flat alpha ellipse
- **Risk:** Visual quality
- **Recommendation:** Profile F5 before changing

### 9. Adaptive GL stuck at 33% — P2 (environment-sensitive)

- **Severity:** P2 on low-end; P3 on discrete GPU
- **Evidence:** F0 HUD `GL … @33%`; VM software rendering
- **Player symptom:** Soft ocean, persistent low scale
- **Root cause:** Sustained frame over budget triggers downshift; VM cannot recover
- **Fix A:** Tune thresholds on real hardware / **Fix B:** User quality preset
- **Recommendation:** Re-test F0/F8 on player machine before changing scaler constants

### 10. Wrap-offset / Set / frame-audit allocs — P3 (mitigated this run)

- **Severity:** P3 after fix
- **Evidence:** Was per-entity wrap offset arrays + `Vec2.from`; `new Set()`; new stats object/frame
- **Fix A:** Shipped this run — pooled scratch + in-place audit
- **Recommendation:** Verify with Memory timeline on wrap-seam scenarios (F5)

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

1. **Interpolation world scratch pool** — in-place `interpolateStates` (Fix A for bottleneck #3)
2. **Render queue dispatch table** — replace per-frame closures with pooled items + pass-id switch (bottleneck #1)
3. **Fog blur radius reduction** at 33% GL scale (visual QA on F1 coast pan)
4. **OffscreenCanvas distant ship LOD** — composite static layers when zoom < 1.5 and off-center
5. **Pause menu toggle** for `showPerformanceStats` (still unwired in UI)
6. **PredictionEngine stats in HUD** — wire `getEnhancedPredictionStats()` for holdNew visibility without console

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
- [x] In-place `__frameAuditStats` (stable object reference)
- [ ] Pause menu toggle for `showPerformanceStats`
- [ ] HUD row for `PredictionEngine` holdNew / buffer spacing
- [ ] Reset hitch counter button or auto-reset on stable gameplay (session hitch count mixes load + play)
- [ ] Render queue closure pool / dispatch table (largest remaining GC source)
