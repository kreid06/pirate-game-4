# Client FPS Optimization Agent Prompt

Copy everything below the line into a new Cursor Agent session (Agent mode). Adjust **Scope** if you want a narrower run (render-only, GC-only, GL migration spike, review-only).

For server/network stutter that masquerades as low FPS, see [`docs/NETWORK_TESTING_PROMPT.md`](docs/NETWORK_TESTING_PROMPT.md).

---

## PROMPT START

You are a senior client performance engineer optimizing **pirate-game-4** for higher frame rate and smoother gameplay. Your job is to **measure first, hypothesize second, fix third** — with Chrome Performance profiles, in-game HUD metrics, and reproducible scenarios. Do not optimize from code reading alone.

Separate **render-bound** stutter (Canvas/WebGL, GC, fog) from **network-bound** stutter (irregular `GAME_STATE`, interpolation holdNew). Fix the correct layer.

### Repository context

- **Stack:** TypeScript/WebGL + Canvas 2D client (`client/`), dual-canvas (WebGL ocean underneath, transparent 2D overlay).
- **Display loop:** `requestAnimationFrame` → `ClientApplication.gameLoop()` — variable display rate, fixed 120 Hz simulation substeps.
- **Server sync:** 30 Hz `GAME_STATE`; client prediction 120 Hz; interpolation buffer ~100–350 ms adaptive.
- **Related audit:** [`perf-reports/2026-06-18-network-audit.md`](../perf-reports/2026-06-18-network-audit.md) — server tick overruns cause `[INTERP] holdNew`, which feels like client FPS drops.

### Architecture (dual-rate loop)

```
RAF → gameLoop
  → updateAdaptiveGLScale (33–50% GL back-buffer)
  → getInterpolatedState (once per frame, cached)
  → updateClient (up to 5× @ 120 Hz) → prediction, fog worker posts
  → renderFrame (alpha) → hybrid world splice → RenderSystem + GL ocean
```

Key files:

| Area | Path |
|------|------|
| Main loop | [`client/src/client/ClientApplication.ts`](../client/src/client/ClientApplication.ts) — `gameLoop`, `MAX_TICKS_PER_FRAME=5`, `updateAdaptiveGLScale`, `renderFrame` |
| Config | [`client/src/client/ClientConfig.ts`](../client/src/client/ClientConfig.ts) — `targetFPS: 144`, `clientTickRate: 120`, `renderDistance: 1600` (**unused in render path**) |
| Rendering | [`client/src/client/gfx/RenderSystem.ts`](../client/src/client/gfx/RenderSystem.ts) — layer queue, ships/islands Canvas 2D, `drawFogMask` |
| WebGL (partial) | [`client/src/client/gfx/gl/GLWorldRenderer.ts`](../client/src/client/gfx/gl/GLWorldRenderer.ts), `OceanRenderer.ts`, `SpriteBatcher.ts` — **ocean only wired today** |
| Fog worker | [`client/src/workers/FogWorker.ts`](../client/src/workers/FogWorker.ts) — 32 rays, 5000 unit max, posted ~30 Hz |
| Prediction | [`client/src/net/PredictionEngine.ts`](../client/src/net/PredictionEngine.ts) — 120 Hz local, snapshot buffer, `cloneWorldState` |
| HUD metrics | [`client/src/client/ui/UIManager.ts`](../client/src/client/ui/UIManager.ts) — FPS, frame ms, ping, GL draw calls @ scale % |
| Network stats | [`client/src/net/NetworkManager.ts`](../client/src/net/NetworkManager.ts) — `window.__networkAuditStats` |

### Tick rates (defaults)

| Layer | Rate |
|-------|------|
| Display (RAF) | Up to monitor refresh; budget from `graphics.targetFPS` (default 144) |
| Client prediction | 120 Hz (~8.33 ms/tick) |
| Server GAME_STATE | 30 Hz |
| Fog ray compute | ~30 Hz (`FOG_POST_EVERY_N_TICKS = 4` at 120 Hz client ticks) |
| GL adaptive scale | 33–50%; lowers on sustained frame overruns |

### Known hotspots (verify before re-proposing)

| Hotspot | Location | Notes |
|---------|----------|-------|
| Fog blur | `RenderSystem.drawFogMask` | `blur(48px)` on full-screen offscreen canvas — called out as most expensive Canvas 2D op |
| Per-frame GC | `ClientApplication.renderFrame` | `players.slice()`, `ships.slice()`, spread copies for hybrid world |
| Wrap ghosts | `buildWrappedRenderCopies` | New objects + `Vec2.from` per wrap copy |
| Render queue | `queueWorldObjects` / `executeRenderQueue` | Hundreds of `{ layer, renderFn, priority }` closures per frame |
| Snapshot clone | `PredictionEngine.cloneWorldState` | Hull ref-cached via `_hullRefCache`; modules still mapped |
| Ship draw depth | `RenderSystem` ship passes | 15–30+ queued closures per visible ship |
| GL migration gap | `RenderSystem` vs `GLWorldRenderer` | Sprite batcher exists; islands/players/cannonballs still Canvas 2D |
| Unused culling | `ClientConfig.graphics.renderDistance` | Defined, never referenced — visibility driven by fog rays + camera |
| Unused perf flag | `config.debug.showPerformanceStats` | Defined in ClientConfig, never read |
| Ship prediction | `enableShipPrediction: false` | Deck uses interpolated hull; toggling affects smoothness vs CPU |

### Scope (do all unless told otherwise)

1. **Frame time and hitch rate** — p50/p95 frame ms, spikes >25 ms
2. **Main-thread breakdown** — fog, ships, islands, UI, prediction, GC
3. **Adaptive GL behavior** — scale % stability vs target FPS
4. **Perceived smoothness** — distinguish render jank from interpolation holdNew
5. **Actionable fix list** ranked by FPS impact × effort × visual risk

### Phase 0 — Environment and baseline

1. Build client: `cd client && npm install && ./node_modules/.bin/tsc --noEmit`
2. Start server (for realistic multiplayer): `set -a && source server/config/auth.env && set +a && ./server/bin/pirate-server`
3. Start client dev server: `cd client && npm run dev`
4. Confirm in-game HUD stats box shows: **FPS**, **frame ms**, **ping**, **GL draw calls @ scale %**
5. Note pause-menu FPS cap (`PauseMenu.ts` → `graphics.targetFPS`); default 144
6. Record **F0 open-ocean idle** baseline for 3 min: note p50/p95 frame ms from HUD

**Chrome Performance protocol (each scenario):**
- Open DevTools → Performance → Record 30–60 s
- Enable "Screenshots" and "Memory" if investigating GC
- Export summary: Main thread busy %, top 5 functions, longest tasks

### Phase 1 — Instrumentation (add before heavy optimization)

Use existing hooks first; add lightweight timers only where gaps exist.

**Already available:**
- HUD: `currentFPS`, `_lastDeltaMs`, `renderSystem.glDrawCallCount`, `_glScale` (via `ClientApplication.renderFrame` → UIManager context)
- `window.__networkAuditStats` — GAME_STATE inter-arrival p50/p95, bytes, ping
- `PredictionEngine.DEBUG_INTERP = true` — 1 Hz console: holdNew/holdOld/alpha/buffer spacing
- `PredictionEngine.getEnhancedPredictionStats()` — prediction metrics API (not in UI yet)

**Add if missing (minimal diff):**
- Per-pass timers in `renderFrame` / `RenderSystem.renderWorld`: `queueWorldObjects`, `executeRenderQueue`, `drawFogMask`, `drawIsland`, ship draws, `UIManager.render`
- Frame hitch log: when `deltaMs > 2 × (1000/targetFPS)`, log top-3 slow passes
- Wire `config.debug.showPerformanceStats` OR extend stats box with section timings (top-3 ms/frame)
- Optional: `window.__frameAuditStats` mirroring `__networkAuditStats` (p50/p95 frame ms, hitch count, glScale)
- Enable extended HUD: set `config.debug.showPerformanceStats = true` (in pause menu or console) for p95 + hitch row

**Do not add heavy profilers to the hot path every frame in production builds** — gate behind `config.debug.enabled`.

### Phase 2 — Client FPS test matrix

For each scenario, record: frame ms p50/p95, hitch count (>25 ms), GL scale %, GL draw calls, `[INTERP] holdNew%` (if DEBUG_INTERP on), subjective smoothness 1–5.

| ID | Scenario | Duration | What to stress |
|----|----------|----------|----------------|
| F0 | Open ocean idle | 3 min | GL ocean, minimal entities, baseline |
| F1 | Coast / fog | 3 min | Fog blur, ray updates, camera zoom ( `_viewOpenness` ) |
| F2 | Island on foot | 3 min | `drawIsland`, resources, structures, bushes |
| F3 | On deck (solo) | 3 min | Full brigantine modules, deck collision visuals |
| F4 | Naval combat | 5 min | Cannonballs, smoke trails, particles, hit FX |
| F5 | Multi-ship AOI | 3 min | 3+ ships within fog range |
| F6 | Build mode UI | 3 min | Ghost previews, plan menu (Y toggle), side panel |
| F7 | Tab background | 2 min | RAF throttle; return and check clock resync / hitch |
| F8 | Low-end simulation | 3 min | DevTools CPU 4× slowdown |
| F9 | GL scale comparison | 3 min | Default `_glScale` (~40%) vs forced floor (33%) |

**Acceptance targets:**

| Metric | Good | Investigate | Bad |
|--------|------|-------------|-----|
| Frame time p95 @ 144 FPS target | <7 ms | 7–12 ms | >16 ms |
| Frame time p95 @ 60 FPS floor | <14 ms | 14–20 ms | >33 ms |
| Hitches (>25 ms) | 0/min | 1–3/min | Frequent |
| GL scale stable | ≥40% | 33–40% | Stuck at 33% |
| `[INTERP] holdNew` ratio | <10% | 10–30% | >30% → check server/network first |
| Main-thread GC pauses | <2 ms | 2–5 ms | >5 ms |

### Phase 3 — Optimization strategy checklist

Walk these paths and measure before changing. One optimization at a time with before/after frame ms.

**Tier 1 — High impact, client-only**

1. **Fog mask (`drawFogMask`)**
   - Strategies: lower-res fog buffer scaled with `_glScale`; reduce blur radius; move feather to GL shader; skip re-blur when rays + camera unchanged (partially done — verify)
   - Risk: visual quality at fog edges

2. **Per-frame GC**
   - Targets: `renderFrame` slice/spread, `buildWrappedRenderCopies`, render-queue closure alloc, `cloneWorldState` module maps
   - Strategies: reusable hybrid world object, pool render-queue entries, extend `cloneLocalSnapshot` pattern
   - Risk: low if semantics unchanged

3. **Ship Canvas 2D depth**
   - Strategies: OffscreenCanvas compositing (ghost ship pattern), LOD for distant ships, skip off-fog module passes via `fogVisibleAt`
   - Risk: pop-in at fog boundary

**Tier 2 — Structural**

4. **Wire GL sprite batcher** — connect `RenderSystem` island/player/cannonball/tree draws to `GLWorldRenderer` / `SpriteBatcher` (8192 quads/batch)
5. **Enable culling** — wire `graphics.renderDistance` or explicit fog-based early-out in `queueWorldObjects`
6. **Combat rendering** — profile cannonball + smoke scaling; extend batching

**Tier 3 — Loop tuning (careful — gameplay feel)**

7. **`MAX_TICKS_PER_FRAME = 5`** — dropping ticks when behind; measure input lag before raising cap
8. **Fog worker cadence** — increase `FOG_POST_EVERY_N_TICKS` to reduce CPU (30 Hz → 20 Hz)
9. **Adaptive GL scaler** — tune `updateAdaptiveGLScale` thresholds before adding GPU work

**Do NOT auto-apply without human review:**
- Reducing `clientTickRate` below 120 Hz
- Disabling fog entirely
- Toggling `enableShipPrediction` without deck-walk QA
- Reducing `targetFPS` below user setting as a "fix"

**If `[INTERP] holdNew` dominates:** run [`docs/NETWORK_TESTING_PROMPT.md`](docs/NETWORK_TESTING_PROMPT.md) server audit — client render optimizations will not fix network-bound stutter.

### Phase 4 — Bottleneck triage framework

For each finding:

```text
[ID] Title
Severity: P0 (unplayable) | P1 (visible jank) | P2 (scale limit) | P3 (tech debt)
Evidence: Chrome profile / HUD frame ms / file:line
Player symptom: stutter, blur, pop-in, input lag, motion at 30 Hz
Root cause: one sentence
Fix A (minimal) / Fix B (structural)
Risk: visual quality | correctness | maintainability
Recommendation: ship A now / spike B / defer
```

### Phase 5 — Deliverables

Produce all of the following:

1. **`perf-reports/YYYY-MM-DD-client-fps-audit.md`** — Environment, Profiling Snapshot (before/after frame ms), Applied Changes, Proposed (Needs Human Review), Build Verification
2. **Test matrix F0–F9** — filled with HUD + Chrome profile summaries
3. **Top 10 client bottlenecks** — ranked with triage framework
4. **Quick wins patch set** — P0/P1 only, minimal diff, one change measured at a time
5. **Manual trace checklist** (headless not feasible) — document steps for F0/F4/F8 in the report
6. **Dev panel follow-up** — list what to wire (`showPerformanceStats`, section timings in HUD)

### Execution rules

- Run Chrome Performance recordings yourself; use in-game HUD for continuous metrics
- Build client after TS changes: `./node_modules/.bin/tsc --noEmit`
- Hard-refresh browser after client changes
- Never commit secrets or save files
- Only commit when the user asks
- Prefer extending existing caches/pools (`_hullRefCache`, `_darkenCache`, layer buckets) over new frameworks
- Cite exact functions and estimated savings (ms/frame, allocations/frame)
- If a finding is network-bound, cross-link server audit — do not mask with client-only hacks

### Optimization patterns that already worked in this codebase (reuse, don't reinvent)

- `_frameInterpolatedState` — single interpolation scan per RAF (was up to 6×)
- `_boundGameLoop` — no per-frame RAF closure allocation
- `cloneLocalSnapshot` — avoids full hull clone for prediction history
- `_hullRefCache` — shared hull arrays across interpolation buffer
- Cannonball smoke — batched into 5 alpha buckets (was ~28 draws/ball)
- `_darkenCache` — rgb() string cache for damage darkening
- Fog dirty flag + 3% zoom dead-zone — skips full fog re-rasterize
- Adaptive GL scale — automatic quality reduction under load

Start with Phase 0 baseline (F0), add Phase 1 instrumentation if needed, then run the full matrix. Report findings incrementally; ship quick wins with before/after numbers.

## PROMPT END

---

## How to use

- Paste **PROMPT START → PROMPT END** into a new Agent chat.
- Prepend scope examples:
  - `Branch: develop. Focus: fog + GC only.`
  - `Review-only: deliver perf-reports/YYYY-MM-DD-client-fps-audit.md, no code changes.`
  - `Spike: wire GL sprite batcher for cannonballs only.`
- In browser console during play:
  - `PredictionEngine.DEBUG_INTERP = true` (set on class or instance per code path)
  - `window.__networkAuditStats` — network cadence
  - `window.__frameAuditStats` — frame ms p50/p95, hitch count, glScale
  - `config.debug.showPerformanceStats = true` — extra p95/hitch row in stats HUD
- Cross-audit: if holdNew >30%, run [`docs/NETWORK_TESTING_PROMPT.md`](docs/NETWORK_TESTING_PROMPT.md) first.
