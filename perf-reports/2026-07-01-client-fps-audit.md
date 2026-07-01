# Client FPS Audit Report — 2026-07-01

## Environment

- Branch: `cursor/client-fps-optimization-8a53` (base: `develop`)
- Client build: `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0
- Server build: `cd server && make` → exit 0 (requires `libjson-c-dev libssl-dev libwebsockets-dev`)
- Target FPS default: 144 (`ClientConfig.graphics.targetFPS`)
- Client prediction: 120 Hz; server GAME_STATE: 30 Hz; fog worker: 20 Hz (`FOG_POST_EVERY_N_TICKS = 6`)
- Rendering: dual-canvas (WebGL ocean + Canvas 2D overlay)
- Test URL: `http://127.0.0.1:5173/pirate-game-4/?debug=true&perfstats=true`
- WebSocket: `ws://localhost:8082`
- VM note: Cloud agent VM uses SwiftShader software GL; headless Chromium caps at **60 Hz** (16.7 ms frames). Absolute FPS/GL scale are **not** representative of player hardware. Use pass timings and allocation reductions for regression checks; run Chrome Performance on local hardware for F1–F9.

---

## Profiling Snapshot

### F0 baseline — open ocean idle (10 s warmup + 5 s sample, live server)

Captured via Playwright (`client/scripts/f0-profile.mjs`) with guest auth, WebSocket connected.

| Metric | Before (develop) | After (this branch) | Rating @ 144 target |
|--------|------------------|---------------------|---------------------|
| FPS (HUD) | 60 | 60 | Bad vs 144 target; **VM 60 Hz cap** |
| Frame ms p50 | 16.7 ms | 16.7 ms | Investigate (VSync-limited) |
| Frame ms p95 | 16.7 ms | 16.8 ms | Bad vs 144; flat = display cap |
| Hitch count (15 s gameplay) | ~901 | ~901 | **Artifact**: budget 6.9 ms @ 144 target; 16.7 ms frames all exceed 2× budget |
| GL scale | 33% (floor) | 33% | Bad — software GL under load |
| Pass isl/q/ex/fog | 0/0/0.2/1 ms | 0/0/0.2/1.1 ms | Good — idle ocean |
| Ping (live WS) | connected | connected | — |

```json
{
  "frameMsLast": 16.7,
  "frameMsP50": 16.7,
  "frameMsP95": 16.8,
  "hitchCount": 901,
  "fps": 60,
  "glScalePct": 33,
  "renderIslandMs": 0,
  "renderQueueMs": 0,
  "renderExecuteMs": 0.2,
  "renderFogMs": 1.1
}
```

**Interpretation:** F0 idle is display-bound on the VM (flat p50/p95 at 16.7 ms). Render passes remain cheap (execute ~0.2 ms, fog ~1 ms). Camera-follow scratch pooling targets deck-walking scenarios (F3) where up to 5× 120 Hz ticks per RAF previously allocated `players.slice()` + spread copies — not exercised in open-ocean F0.

---

## Applied Changes (2026-07-01)

### 1. Camera-follow scratch pool

**File:** `client/src/client/ClientApplication.ts`

- Reused `_cameraFollowWorld`, `_cameraFollowPlayersScratch`, `_cameraFollowLocalPlayer`, `_cameraFollowAnchoredPos` in the deck/boarded camera-follow path inside `updateClient`.
- Replaces per-tick `players.slice()`, `{ ..._interp, players }` spread, `{ ..._predLocal, position }`, and `Vec2.from` for mounted helm (uses interpolated ship position ref directly).
- Runs up to **5× per RAF** when prediction ticks catch up — primary savings on F3 (on deck).
- **Risk:** Low — scratch objects consumed same-frame for camera only; mounted path reads ship position without mutation.

### 2. Pause menu Perf HUD toggle

**Files:** `client/src/client/ui/PauseMenu.ts`, `client/src/client/ClientApplication.ts`

- Display tab: **Perf HUD (p95 / pass ms)** checkbox (`#ps-perf-stats`).
- Persists to `config.debug.showPerformanceStats`; enables `debug.enabled` when toggled on.
- `applySettings` now applies FPS cap, antialiasing, particle quality, and perf HUD live (previously only audio/keybinds).
- **Risk:** None — debug-only HUD extension.

### Prior audit carry-over (already on `develop`)

Interpolation scratch pool, wrap-offset pool, ship-id Set reuse, in-place `__frameAuditStats`, FogWorker double-buffer, entity culling, fog lower-res buffer + dirty flag, hybrid render world reuse, adaptive GL scaler, hitch log with top-3 slow passes, `?perfstats=true` URL wiring, `window.__resetFrameAudit()`, F0 Playwright script.

---

## Test Matrix F0–F9

| ID | Scenario | Duration | Frame p50/p95 | Hitches | GL scale | Pass isl/q/ex/fog | holdNew% | Smoothness | Status |
|----|----------|----------|---------------|---------|----------|-------------------|----------|------------|--------|
| F0 | Open ocean idle | 15 s | 16.7 / 16.8 ms | ~901* | 33% | 0/0/0.2/1.1 ms | manual | 2/5 | **Recorded (VM)** |
| F1 | Coast / fog | 3 min | — | — | — | — | — | — | Manual |
| F2 | Island on foot | 3 min | — | — | — | — | — | — | Manual |
| F3 | On deck solo | 3 min | — | — | — | — | — | — | Manual — **validate camera pool** |
| F4 | Naval combat | 5 min | — | — | — | — | — | — | Manual |
| F5 | Multi-ship AOI | 3 min | — | — | — | — | — | — | Manual |
| F6 | Build mode UI | 3 min | — | — | — | — | — | — | Manual |
| F7 | Tab background | 2 min | — | — | — | — | — | — | Manual |
| F8 | CPU 4× throttle | 3 min | — | — | — | — | — | Manual |
| F9 | GL scale compare | 3 min | — | — | — | — | — | Manual |

\*At 144 FPS hitch threshold on 60 Hz display — use `window.__resetFrameAudit()` and compare against display rate, not raw count.

**Enable metrics in browser:**

```javascript
// URL: ?debug=true&perfstats=true
// Or: Pause menu → Settings → Display → Perf HUD
window.__frameAuditStats
window.__resetFrameAudit()
window.__networkAuditStats
// PredictionEngine.DEBUG_INTERP = true
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
- **Evidence:** `RenderSystem.drawFogMask`; F0 live server shows fog ~1 ms
- **Player symptom:** Stutter panning fog edge, zoom scroll (F1)
- **Root cause:** Canvas 2D `blur()` when rays/camera dirty (partially mitigated by dirty flag + 3% zoom dead-zone)
- **Fix A:** Tune blur radius at 33% GL / **Fix B:** GL shader feather
- **Risk:** Visual quality
- **Recommendation:** F1 Chrome profile before tuning

### 3. Per-frame camera-follow allocations — P2 (mitigated this run)

- **Severity:** P2 after scratch pool
- **Evidence:** Was `players.slice()` + spread up to 5×/RAF on deck; now pooled
- **Player symptom:** GC micro-hitches when boarding/walking deck (F3)
- **Fix A:** **Shipped** — camera-follow scratch pool / **Fix B:** Reduce tick cap
- **Recommendation:** Memory timeline F3 on local hardware

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
- **Evidence:** `PredictionEngine.cloneWorldState` @ ~30 Hz; modules still mapped; `new Map(carrierDetection)` per clone
- **Player symptom:** Periodic GC aligned with GAME_STATE packets
- **Fix A:** Module ref cache with dirty detection / **Fix B:** Map pool on buffer eviction
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

### 10. Render queue dispatch table — P2 (tech debt)

- **Severity:** P2
- **Evidence:** Hundreds of `{ layer, renderFn, priority }` closures per frame in busy scenes
- **Player symptom:** GC pauses when p95 >> p50
- **Fix A:** Pooled queue entries + pass-id switch / **Fix B:** GL batcher
- **Recommendation:** Spike after F5 profile confirms closure volume

---

## Manual Chrome Trace Checklist

### F0 — Open ocean idle (baseline)

1. Start auth: `cd server/auth && npm run build && npm start` (with `server/config/auth.env`)
2. Start server: `set -a && source server/config/auth.env && set +a && ./server/bin/pirate-server`
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
4. **PredictionEngine stats in HUD** — wire `getEnhancedPredictionStats()` for holdNew visibility
5. **Module clone caching / Map pool** in `cloneWorldState` (extend `_hullRefCache` pattern)

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
- [x] Pause menu toggle for `showPerformanceStats`
- [ ] HUD row for `PredictionEngine` holdNew / buffer spacing
- [ ] Render queue closure pool / dispatch table (largest remaining GC source)
