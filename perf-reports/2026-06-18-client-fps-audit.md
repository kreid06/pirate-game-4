# Client FPS Audit Report — 2026-06-18

## Environment

- Branch: `develop` (uncommitted client instrumentation)
- Client build: `./node_modules/.bin/tsc --noEmit` → exit 0
- Target FPS default: 144 (`ClientConfig.graphics.targetFPS`)
- Client prediction: 120 Hz; server GAME_STATE: 30 Hz
- Rendering: dual-canvas (WebGL ocean + Canvas 2D overlay)

Manual Chrome Performance recordings for F0–F9 are required to fill frame-level evidence; this report combines **code audit** + **instrumentation baseline**.

---

## Profiling Snapshot (code audit + expected hotspots)

| Area | Expected cost | Evidence |
|------|---------------|----------|
| Fog mask | High on coast/zoom changes | `RenderSystem.drawFogMask` — full-screen `blur(48px)` |
| Ship render queue | High with 2+ ships in view | 15–30 closures/ship in `queueWorldObjects` |
| Hybrid world GC | Medium every frame | `renderFrame` — `players.slice()`, spread copies |
| GL ocean | Low–medium | Adaptive scale 33–50%; only ocean on GPU today |
| Prediction/interp | Low per frame | Cached `_frameInterpolatedState` once/RAF |
| Network masquerading as FPS | Variable | `[INTERP] holdNew` when server ticks slip — see network audit |

---

## Applied Changes (this audit)

### Tier 1 (2026-06-18)

1. **Fog mask — lower-res buffer** (`RenderSystem.drawFogMask`)
   - Internal fog canvas rasterized at `fogRenderScale` (synced from `_glScale`, default 50%)
   - Blur radius scaled proportionally (`48 * scale` px); upscaled blit to main canvas
   - Dirty cache tracks scaled camera coords + render scale

2. **Per-frame GC — hybrid render world** (`ClientApplication.renderFrame`)
   - Reusable `_hybridRenderWorld` / scratch player & ship arrays
   - `_hybridLocalPlayer` / `_hybridLocalShip` objects patched in place
   - Eliminates `players.slice()`, `ships.slice()`, and spread world copies on the hot path

3. **Ship fog cull** (`RenderSystem.queueWorldObjects`)
   - `_collectFogVisibleShips` scratch buffer replaces `.filter()` alloc
   - Wake trail sampling skipped for off-fog ships (carrier always included)

### Tier 2 (2026-06-18)

4. **`graphics.renderDistance` culling** (`RenderSystem._shouldRenderEntityAt`)
   - Wired config value (default 1600 world units) into ship/player/cannonball/NPC queue gates
   - Combines camera frustum + render distance + fog; local player/carrier bypass fog/distance

5. **GL sprite batcher — players & cannonballs** — **reverted to Canvas 2D**
   - GL canvas is below the full 2D stack; batched sprites drew under islands/ships (same as island resources)
   - GL remains **ocean only** until interleaved compositing exists

6. **GL island resources** — **reverted**
   - Island sprites must stay on Canvas 2D: the GL canvas sits *below* the entire 2D stack, so batched resources rendered under beach/grass/structures and lost zoom-scaled screen sizing in the pass order.
   - `SpriteAtlas` metal boulder tones kept for a future unified layer migration.

### Tier 3 (2026-06-18)

7. **Fog worker cadence** — `FOG_POST_EVERY_N_TICKS` 4 → 6 (30 Hz → **20 Hz** ray posts)
8. **Adaptive GL scaler** — faster downshift (15 bad frames / 1.2 s cooldown), faster recovery (120 good frames / 2 s)
9. **Render pass timings** — `perfTimingsEnabled` when `debug.enabled && showPerformanceStats`; HUD + `__frameAuditStats` show isl/q/ex/fog ms
10. **Wrap ghost pool** — pooled wrap-seam copies (fixed: per-call result array — shared scratch was clobbering ships/players/cannonballs lists)

11. **Ship static layer composite** (`RenderSystem.drawShipStaticComposite`)
    - Hull + planks in one L3 pass (two aligned blits from existing caches, one transform setup)
    - Skips redundant L1 hull + L2 upper-deck-cover when composite active (avoids double deck)
    - Lower-deck view (F3) and zoom > 3 fall back to split hull/plank/cover passes

### Instrumentation (earlier in audit)

**`window.__frameAuditStats`** — `ClientApplication.recordFrameAudit()`

Rolling 120-frame ring: `frameMsLast`, `frameMsP50`, `frameMsP95`, `hitchCount`, `fps`, `glScalePct`.

**Hitch logging (debug)** — when `config.debug.enabled && config.debug.showPerformanceStats`, logs `[FRAME] hitch` if frame ms > 2× target budget.

**Extended stats HUD** — `UIManager.ts`: when `showPerformanceStats` is true, stats box shows `p95 Xms  hitches N`.

**Enable in console:**
```javascript
// After game load — or set in pause menu debug if wired
app.getConfig().debug.showPerformanceStats = true;
app.getConfig().debug.enabled = true;
```

---

## Test Matrix F0–F9 (manual checklist)

Run each scenario 3–5 min; record HUD + `window.__frameAuditStats` + Chrome Performance summary.

| ID | Scenario | Status | Notes |
|----|----------|--------|-------|
| F0 | Open ocean idle | Manual | Baseline p95; GL scale should stay ~40% |
| F1 | Coast / fog | Manual | Expect p95 spike on pan/zoom (fog blur) |
| F2 | Island on foot | Manual | `drawIsland` + resources |
| F3 | On deck solo | Manual | Full module stack |
| F4 | Naval combat | Manual | Projectiles + smoke |
| F5 | Multi-ship AOI | Manual | Queue depth scales with ships |
| F6 | Build mode UI | Manual | Ghost previews |
| F7 | Tab background | Manual | Hitch on return; check hitchCount |
| F8 | CPU 4× throttle | Manual | GL scale should drop toward 33% |
| F9 | GL scale compare | Manual | Force low scale vs default |

**Chrome trace steps (F0 / F4 / F8):**
1. DevTools → Performance → Record 60 s
2. Note Main thread longest task, Scripting vs Rendering %
3. If GC spikes: enable Memory checkbox, look for Major GC > 5 ms
4. Compare with `__frameAuditStats.frameMsP95` and `__networkAuditStats.interArrivalP95Ms`

---

## Top 10 Client Bottlenecks (ranked)

### 1. Fog blur — P1

- **Evidence:** `drawFogMask`, `blur(48px)` on full-screen canvas
- **Symptom:** Stutter when panning along coast or zoom changes
- **Fix A:** Lower-res fog buffer tied to `_glScale`; **Fix B:** GL shader feather
- **Recommendation:** Spike A with before/after F1 p95

### 2. Per-frame allocations in renderFrame — P1

- **Evidence:** `players.slice()`, spread hybrid world (`ClientApplication.ts` ~5018)
- **Symptom:** GC hitches, irregular frame ms
- **Fix A:** In-place splice local player; **Fix B:** reusable world view object
- **Recommendation:** Ship A first; profile with Memory timeline

### 3. Render queue closure volume — P1

- **Evidence:** `queueWorldObjects` / `executeRenderQueue`
- **Symptom:** CPU scales with visible ships × modules
- **Fix:** OffscreenCanvas compositing for distant ships; fog cull module passes
- **Recommendation:** Measure F5 before/after

### 4. GL migration incomplete — P2 (partial)

- **Status:** Ocean + player bodies + cannonball spheres on GL batcher; island resources stay Canvas 2D (layer order)
- **Remaining:** Island terrain to GL or interleaved 2D/GL compositing before resource batching; ships/structures Canvas 2D

### 5. Unused renderDistance — P2 (fixed)

- **Status:** `_shouldRenderEntityAt` gates queueWorldObjects for ships, players, cannonballs, NPCs

### 6. Wrap ghost allocations — P2

- **Evidence:** `buildWrappedRenderCopies` — new objects per wrap
- **Symptom:** Extra GC on map edges
- **Fix:** Pool wrap copies or limit to active wrap count
- **Recommendation:** Defer unless F0–F2 show GC in wrap scenarios

### 7. cloneWorldState module maps — P2

- **Evidence:** `PredictionEngine.cloneWorldState` on each GAME_STATE
- **Symptom:** GC every 33 ms from snapshot parse path (not every RAF)
- **Fix:** Extend dirty-key caching to modules
- **Recommendation:** Profile alongside network payload size

### 8. MAX_TICKS_PER_FRAME backlog drop — P3

- **Evidence:** Cap at 5 × 120 Hz ticks/frame
- **Symptom:** Input catch-up after tab focus; not render-bound
- **Fix:** Tune cap only with input latency measurements
- **Recommendation:** Defer

### 9. showPerformanceStats was unwired — P3 (fixed)

- **Status:** Now drives HUD p95/hitch row + hitch console logs

### 10. Network-bound holdNew — P1 (server-side)

- **Evidence:** [`perf-reports/2026-06-18-network-audit.md`](2026-06-18-network-audit.md)
- **Symptom:** Entities move at 30 Hz despite high FPS
- **Fix:** Server sim budget — not client render
- **Recommendation:** Run network audit if `DEBUG_INTERP` holdNew > 30%

---

## Proposed (Needs Human Review)

1. Fog blur radius / resolution tradeoff (visual QA on F1)
2. GL sprite migration order (cannonballs → players → islands)
3. AOI-style culling for render queue vs fog-only culling
4. Reducing `clientTickRate` or fog worker cadence

---

## Build Verification

- `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0

---

## Dev Panel Follow-up

- [x] Per-pass timers: `queueWorldObjects`, `drawFogMask`, `executeRenderQueue`, `drawIsland` (gate on `debug.enabled && showPerformanceStats`)
- [ ] Pause menu toggle for `showPerformanceStats`
- [ ] Document `__frameAuditStats` in CLIENT_FPS prompt (done)

---

## Quick Reference (in browser)

```javascript
window.__frameAuditStats      // p50/p95 frame ms, hitches, glScale
window.__networkAuditStats    // GAME_STATE cadence — separate network issues
// PredictionEngine.DEBUG_INTERP = true  // on class if exposed
```
