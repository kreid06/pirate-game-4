# Client FPS Audit Report — 2026-06-30

## Environment

- Branch: `cursor/client-fps-optimization-6db1` (base: `develop`)
- Client build: `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0
- Server build: `cd server && make` → exit 0 (requires `libjson-c-dev libssl-dev libwebsockets-dev`)
- Target FPS default: 144 (`ClientConfig.graphics.targetFPS`)
- Client prediction: 120 Hz; server GAME_STATE: 30 Hz; fog worker: 20 Hz (`FOG_POST_EVERY_N_TICKS = 6`)
- Rendering: dual-canvas (WebGL ocean + Canvas 2D overlay)
- Test URL: `http://127.0.0.1:5173/pirate-game-4/?debug=true&perfstats=true`
- WebSocket: `ws://localhost:8082` (corrected from stale `.env.example` default `8080`)
- VM note: Cloud agent VM uses SwiftShader software GL; headless Chromium caps at **60 Hz** (16.7 ms frames). Absolute FPS/GL scale are **not** representative of player hardware. Use pass timings and allocation reductions for regression checks; run Chrome Performance on local hardware for F1–F9.

---

## Profiling Snapshot

### F0 baseline — open ocean idle (40 s after guest login, live server)

Captured via Playwright (`client/scripts/f0-profile.mjs`) with `?debug=true&perfstats=true`, guest auth, WebSocket connected (`ws://localhost:8082`), `window.__resetFrameAudit()` after load.

| Metric | Before (develop) | After (this branch) | Rating @ 144 target |
|--------|------------------|---------------------|---------------------|
| FPS (HUD) | 60 | 60 | Bad vs 144 target; **VM 60 Hz cap** |
| Frame ms p50 | 16.7 ms | 16.7 ms | Investigate (VSync-limited) |
| Frame ms p95 | 16.7 ms | 16.7 ms | Bad vs 144; flat = display cap |
| Hitch count (40 s gameplay) | ~2400 | ~2400 | **Artifact**: budget 6.9 ms @ 144 target; 16.7 ms frames all exceed 2× budget |
| GL scale | 33% (floor) | 33% | Bad — software GL under load |
| Pass isl/q/ex/fog | 0/0/0.2/0 ms | 0/0/0.3/1 ms | Good — idle ocean |
| Ping (live WS) | connected | connected | — |
| `__networkAuditStats` | n/a in headless path | pending GAME_STATE cadence* | Manual on browser |

\*Headless receives server ack; `__networkAuditStats` populates after sustained `GAME_STATE:` traffic — verify in browser console during manual F0.

```json
{
  "frameMsLast": 16.7,
  "frameMsP50": 16.7,
  "frameMsP95": 16.7,
  "hitchCount": 2401,
  "fps": 60,
  "glScalePct": 33,
  "renderIslandMs": 0,
  "renderQueueMs": 0,
  "renderExecuteMs": 0.3,
  "renderFogMs": 1
}
```

**Interpretation:** Instrumented render passes remain cheap at idle (execute ~0.3 ms, fog ~1 ms with live server fog rays). Flat p50/p95 at 16.7 ms confirms **display-bound** headless cap, not render-pass regression. Hitch counter at 144 FPS target counts every 60 Hz frame — use `window.__resetFrameAudit()` after load for clean samples, or interpret hitches against actual display rate.

### Before / after (this branch)

| Change | Expected savings | Evidence |
|--------|------------------|----------|
| Interpolation scratch pool (`PredictionEngine`) | −~120+ `Vec2.from`/frame + 4× `Map`/frame + entity spread objects in busy AOI | Pooled `_interpWorldScratch`, entity shells, `lerpVec2Keyed`, reused `_fromByIdScratch` |
| `_pruneHullCache` Set reuse | −1 `Set` alloc when cache prunes | `_pruneLiveIdsScratch` |
| `window.__resetFrameAudit()` | Clean hitch baseline after load | `ClientApplication.resetFrameAudit()` |
| `VITE_WS_PORT=8082` in `.env.example` | Fixes local dev WS connection (was 8080 UDP port) | Playwright logs: `Connected to physics server` |

VM frame ms unchanged (expected — allocation/GC savings invisible at 60 Hz idle with 0.3 ms execute pass). Validate with Chrome Memory timeline on F0/F5 local hardware.

---

## Applied Changes (2026-06-30)

### 1. Interpolation world scratch pool

**File:** `client/src/net/PredictionEngine.ts`

- Reused `_interpWorldScratch` world object returned from `interpolateStates` (no per-frame world literal).
- Pooled entity shells in `_interpEntityShellById`; update via `Object.assign` instead of spread.
- `lerpVec2Keyed` writes into pooled `Vec2` instances (one alloc per entity field, then in-place).
- Reused scratch arrays for ships/players/npcs/cannonballs results; cleared `_fromByIdScratch` per pass.
- `_carrierDetectionScratch` copied in-place instead of `new Map()` each frame.
- **Risk:** Low — returned world is consumed same-frame; shells keyed by entity id.

### 2. Hull cache prune Set reuse

**File:** `client/src/net/PredictionEngine.ts`

- `_pruneLiveIdsScratch.clear()` replaces `new Set(ships.map(...))` on cache prune.
- **Risk:** None.

### 3. Frame audit reset hook

**File:** `client/src/client/ClientApplication.ts`

- `resetFrameAudit()` clears hitch counter and frame ring.
- Exposed as `window.__resetFrameAudit()` when `debug.enabled`.
- **Risk:** None — debug-only.

### 4. F0 profiling script + WS port fix

**Files:** `client/scripts/f0-profile.mjs`, `client/.env.example`

- Playwright baseline collector for automated F0 runs.
- Default dev WS port corrected to **8082** (game server WebSocket bind per `server/src/server.c`).

### Prior audit carry-over (already on `develop`)

Wrap-offset pooling, ship-id Set reuse, in-place `__frameAuditStats`, FogWorker double-buffer, entity culling, fog lower-res buffer, hybrid render world reuse, adaptive GL scaler, hitch log with top-3 slow passes, `?perfstats=true` URL wiring.

---

## Test Matrix F0–F9

| ID | Scenario | Duration | Frame p50/p95 | Hitches | GL scale | Pass isl/q/ex/fog | holdNew% | Smoothness | Status |
|----|----------|----------|---------------|---------|----------|-------------------|----------|------------|--------|
| F0 | Open ocean idle | 40 s | 16.7 / 16.7 ms | ~2400* | 33% | 0/0/0.3/1 ms | manual | 2/5 | **Recorded (VM)** |
| F1 | Coast / fog | 3 min | — | — | — | — | — | — | Manual |
| F2 | Island on foot | 3 min | — | — | — | — | — | — | Manual |
| F3 | On deck solo | 3 min | — | — | — | — | — | — | Manual |
| F4 | Naval combat | 5 min | — | — | — | — | — | — | Manual |
| F5 | Multi-ship AOI | 3 min | — | — | — | — | — | — | Manual |
| F6 | Build mode UI | 3 min | — | — | — | — | — | — | Manual |
| F7 | Tab background | 2 min | — | — | — | — | — | Manual |
| F8 | CPU 4× throttle | 3 min | — | — | — | — | — | Manual |
| F9 | GL scale compare | 3 min | — | — | — | — | — | Manual |

\*At 144 FPS hitch threshold on 60 Hz display — use `__resetFrameAudit()` and compare against display rate, not raw count.

**Enable metrics in browser:**

```javascript
// URL: ?debug=true&perfstats=true
window.__frameAuditStats      // frameMsP50/P95, hitchCount, glScalePct, render*Ms
window.__resetFrameAudit()    // reset after stable gameplay
window.__networkAuditStats    // GAME_STATE inter-arrival — network vs render triage
// PredictionEngine.DEBUG_INTERP = true  // 1 Hz holdNew/holdOld console
```

---

## Top 10 Client Bottlenecks (ranked)

### 1. Render queue closure volume (ships × modules) — P1

- **Severity:** P1 (visible jank)
- **Evidence:** `RenderSystem.queueWorldObjects` / `executeRenderQueue` — 15–30 closures per visible ship
- **Player symptom:** FPS drops with 2+ ships in fog (F5)
- **Root cause:** Per-module Canvas 2D draw lambdas queued each frame
- **Fix A:** OffscreenCanvas ship composite (distant LOD) / **Fix B:** GL batcher
- **Risk:** Pop-in at fog boundary
- **Recommendation:** Spike Fix A on F5; measure execute pass ms

### 2. Fog blur on coast / zoom — P1

- **Severity:** P1
- **Evidence:** `RenderSystem.drawFogMask`; F0 live server shows fog ~1 ms vs 0 ms offline
- **Player symptom:** Stutter panning fog edge, zoom scroll (F1)
- **Root cause:** Canvas 2D `blur()` when rays/camera dirty
- **Fix A:** Tune blur radius at 33% GL / **Fix B:** GL shader feather
- **Risk:** Visual quality
- **Recommendation:** F1 Chrome profile before tuning

### 3. Per-frame interpolation allocations — P2 (mitigated this run)

- **Severity:** P2 after scratch pool
- **Evidence:** Was `lerpVec2` → `Vec2.from` every entity every RAF; now pooled
- **Player symptom:** GC micro-hitches when p95 >> p50
- **Fix A:** **Shipped** — interpolation scratch pool / **Fix B:** Smaller server blobs
- **Recommendation:** Memory timeline F0/F5 on local hardware to confirm GC reduction

### 4. GL migration gap — P2

- **Severity:** P2 (scale limit)
- **Evidence:** `GLWorldRenderer` — ocean only; islands/ships Canvas 2D
- **Player symptom:** CPU-bound dense scenes despite low GL draw count
- **Fix A:** Interleaved compositing spike for cannonballs / **Fix B:** Full GL world
- **Recommendation:** Spike cannonballs first (F4)

### 5. Network holdNew masquerading as FPS — P1 (server)

- **Severity:** P1 when holdNew > 30%
- **Evidence:** [`perf-reports/2026-06-18-network-audit.md`](2026-06-18-network-audit.md)
- **Player symptom:** Entities snap at 30 Hz despite high FPS
- **Root cause:** Server tick overruns → interpolation buffer starvation
- **Fix:** Server sim budget — [`docs/NETWORK_TESTING_PROMPT.md`](../docs/NETWORK_TESTING_PROMPT.md)
- **Recommendation:** Do not mask with client-only hacks

### 6. Ghost-fleet entity load — P2

- **Severity:** P2
- **Evidence:** Server spawns 150+ sim ships; client processes AOI entities
- **Player symptom:** Baseline frame ms higher than empty-ocean theory
- **Fix A:** Client early-out (renderDistance + fog — partial) / **Fix B:** Server AOI trim
- **Recommendation:** Compare F0 empty dev vs production ghost-fleet

### 7. cloneWorldState / snapshot parse GC — P2

- **Severity:** P2
- **Evidence:** `PredictionEngine.cloneWorldState` @ ~30 Hz; modules still mapped
- **Player symptom:** Periodic GC aligned with GAME_STATE packets
- **Fix A:** Extend dirty-key caching to modules / **Fix B:** Smaller blobs
- **Recommendation:** Profile Memory + `__networkAuditStats.bytes`

### 8. Ship wake radial gradients — P2

- **Severity:** P2
- **Evidence:** `drawShipWake` — `createRadialGradient` per moving ship
- **Player symptom:** execute pass ↑ with 3+ moving ships (F5)
- **Fix A:** Quantized wake alpha buckets / **Fix B:** Flat alpha ellipse
- **Recommendation:** Profile F5 before changing

### 9. Adaptive GL stuck at 33% — P2 (environment-sensitive)

- **Severity:** P2 on low-end; P3 on discrete GPU
- **Evidence:** F0 HUD `GL … @33%`; VM SwiftShader
- **Player symptom:** Soft ocean at quality floor
- **Fix A:** Tune thresholds on real hardware / **Fix B:** User quality preset
- **Recommendation:** Re-test F0/F8 on player machine

### 10. Dev WS port misconfiguration — P3 (fixed)

- **Severity:** P3
- **Evidence:** `.env.example` listed `VITE_WS_PORT=8080` (UDP); server WS on **8082**
- **Player symptom:** Client stuck reconnecting; no GAME_STATE / network audit
- **Fix A:** **Shipped** — `.env.example` → 8082
- **Recommendation:** Document in README dev setup

---

## Manual Chrome Trace Checklist

### F0 — Open ocean idle (baseline)

1. Start server: `set -a && source server/config/auth.env && set +a && ./server/bin/pirate-server`
2. Start auth: `cd server/auth && npm start`
3. Client: `cd client && npm run dev` — ensure `.env` has `VITE_WS_PORT=8082`
4. Open `?debug=true&perfstats=true` → guest login → wait 3 min idle
5. Console: `window.__resetFrameAudit()` after load stabilizes
6. Note HUD: FPS, frame ms, p95, GL scale %, pass row
7. DevTools → Performance → Record 60 s (Screenshots on)
8. Export: Main thread busy %, top 5 functions, longest task
9. `JSON.stringify(window.__frameAuditStats)` and `window.__networkAuditStats`

### F4 — Naval combat

1. Engage ghost fleet; record 5 min
2. Enable Memory if GC spikes > 5 ms
3. Compare pass timings: expect `execute` and `queue` ↑ vs F0

### F8 — CPU 4× slowdown

1. DevTools → Performance → CPU: 4× slowdown
2. Record 3 min F0-equivalent idle
3. Expect GL scale → 33%; note hitch rate vs acceptance table

---

## Proposed (Needs Human Review)

1. **Render queue dispatch table** — replace per-frame closures with pooled items + pass-id switch (bottleneck #1)
2. **Fog blur radius reduction** at 33% GL scale (visual QA on F1 coast pan)
3. **OffscreenCanvas distant ship LOD** — composite static layers when zoom < 1.5
4. **Pause menu toggle** for `showPerformanceStats`
5. **PredictionEngine stats in HUD** — wire `getEnhancedPredictionStats()` for holdNew visibility
6. **Module clone caching** in `cloneWorldState` (extend `_hullRefCache` pattern)

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
- [x] In-place `__frameAuditStats`
- [x] `window.__resetFrameAudit()` for clean profiling sessions
- [x] `client/scripts/f0-profile.mjs` automated F0 collector
- [ ] Pause menu toggle for `showPerformanceStats`
- [ ] HUD row for `PredictionEngine` holdNew / buffer spacing
- [ ] Render queue closure pool / dispatch table (largest remaining GC source)
