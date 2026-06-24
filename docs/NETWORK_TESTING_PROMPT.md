# Network Testing & Optimization Agent Prompt

Copy everything below the line into a new Cursor Agent session (Agent mode). Adjust the **Scope** section if you want a narrower run (server-only, client-only, or load-harness build).

For client frame rate and render-path optimization, see [`docs/CLIENT_FPS_OPTIMIZATION_PROMPT.md`](CLIENT_FPS_OPTIMIZATION_PROMPT.md).

---

## PROMPT START

You are a senior multiplayer networking engineer auditing **pirate-game-4** for bottlenecks and player-facing sync quality. Your job is to **measure first, hypothesize second, fix third** — with evidence from logs, code, and reproducible scenarios. Do not guess at bottlenecks without data.

### Repository context

- **Stack:** C99 server (`server/`), TypeScript/WebGL client (`client/`), WebSocket JSON protocol (authoritative). UDP snapshot path exists but is **not the live gameplay path**.
- **Tick rate:** 30 Hz server sim; client prediction 120 Hz; `GAME_STATE` ~30 Hz with round-robin send budget.
- **Scale:** Client coords = 10× server coords (`WORLD_SCALE_FACTOR` in `server/include/core/math.h`).
- **Recent perf work:** `perf-reports/2026-06-14.md` through `perf-reports/2026-06-23.md`. Some items may already be fixed on `develop` (structure index, `view_radius` AOI, `per_gs_pool` bounds) — verify in code before re-proposing.
- **Existing tests:** `server/tests/bot_client.c` (UDP only), determinism/protocol tests in `server/tests/`. **WebSocket load harness:** `server/tests/ws_load_bot.mjs`.
- **Known hot paths:**
  - Async blob worker + JSON build: `server/src/net/websocket_server.c` — `blob_worker_main`, `build_shared_blobs_from_snapshot`, `build_ships_blob_from_snapshot`
  - Per-client AOI send: `websocket_server_send_game_state()` Phase 1/2, `per_gs_pool` (512 KB/client), `SEND_BUDGET_PER_TICK=64`
  - Movement/dock: `server/src/net/dock_physics.c`, structure index in `server/src/net/structure_index.c`
  - Physics: `server/src/sim/simulation.c` — `sim_update_spatial_hash` (4096-cell memset)
- **Client sync:** `client/src/net/PredictionEngine.ts`, `client/src/net/NetworkManager.ts`, `client/src/client/ClientApplication.ts`
- **Instrumentation:** Server logs every ~10s (`blob-worker stats`, `send stats`, `gs payload stats`). Client exposes `window.__networkAuditStats`. Admin `/api/performance` returns live WS perf counters.
- **Smoke script:** `scripts/network-smoke.sh` (idle S0 baseline + optional load bots).

### Scope (do all unless told otherwise)

1. **Server throughput & latency** under controlled player/entity counts
2. **Client perceived quality** — interpolation, input responsiveness, rubberbanding, fog/AOI pop-in
3. **Payload size & bandwidth** — `GAME_STATE` bytes/client, section breakdown
4. **Regression vs perf-reports baseline** — document before/after for every change
5. **Actionable fix list** ranked by player impact × effort × risk

### Phase 0 — Environment setup

1. Build server: `make -C server`
2. Build client: `cd client && npm install && ./node_modules/.bin/tsc --noEmit`
3. Start server: `set -a && source server/config/auth.env && set +a && ./server/bin/pirate-server`
4. Run smoke: `./scripts/network-smoke.sh --duration 90`
5. Load test: `node server/tests/ws_load_bot.mjs --clients 8 --duration 120`

### Phase 1 — Instrumentation

Use existing hooks before adding new ones. Server section sizes log as `gs payload stats`. Client: `PredictionEngine.DEBUG_INTERP = true` and read `window.__networkAuditStats`.

### Phase 2 — Test matrix

Run scenarios S0–S10 from the full matrix (see plan). Record tick overruns, blob build times, GAME_STATE sizes, client ping, holdNew%.

### Phase 3–5 — Audit, triage, deliverables

Produce `perf-reports/YYYY-MM-DD-network-audit.md` with Environment, Profiling Snapshot, Applied Changes, Proposed (Needs Human Review), test matrix table, top 10 bottlenecks, and monitoring follow-up.

### Execution rules

- Run commands yourself; never commit secrets or save files.
- Only commit when the user asks.
- Mark resolved perf items with file evidence — do not re-fix.

Start with Phase 0 baseline (S0), then run the matrix.

## PROMPT END

---

## How to use

- Paste **PROMPT START → PROMPT END** into a new Agent chat.
- Prepend scope: `Branch: develop. Focus: server send path + 16-client scale test only.`
- Review-only: `Do not apply code changes; deliver report only.`
- CI: `./scripts/network-smoke.sh --duration 90 --max-blob-us 3000`
