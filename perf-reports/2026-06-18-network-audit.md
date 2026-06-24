# Network Audit Report — 2026-06-18

## Environment

- Branch: `develop` (uncommitted instrumentation + harness work)
- Server build: `gcc -Wall -Wextra -std=c99 -O2 -g`
- Client typecheck: `./node_modules/.bin/tsc --noEmit` → exit 0
- Auth: `server/config/auth.env` (gitignored, not committed)
- Harness: `server/tests/ws_load_bot.mjs`, `scripts/network-smoke.sh`
- Prior live session (1 human player): terminal capture from same VM, tick ~163k+

---

## Profiling Snapshot

| Scenario | Players | blob last/max (µs) | send build/dispatch (µs) | gs total (bytes) | Tick overruns | Notes |
|----------|---------|-------------------|---------------------------|------------------|---------------|-------|
| S0 idle (smoke) | 0 | 20 / 243 | 2–3 / 0–1 | 0 (no clients) | 0 | 5 Hz broadcast, ~37 NPCs |
| S7 partial (smoke) | 4 bots | 20 / 200 | 2–13 / 0–167 | **11,453** | 0 | 457 GAME_STATE/bot-run, ~11.4 KB/frame |
| Live human (prior) | 1 | 1689 / **32455** | 8–13 / **401** | n/a | **many** | sim 29–116 ms; send spikes to 27 ms |

Section breakdown at 4 bots (last `gs payload stats` sample):

| Section | Bytes | % of total |
|---------|-------|------------|
| ships | 3,615 | 32% |
| npcs | 6,770 | 59% |
| players | 903 | 8% |
| projectiles/tmb/ditem/co | 8 | <1% |

Load-bot summary (4 clients, 15 s): `avgGameStateBytes: 11376`, all 4 handshakes OK.

---

## Applied Changes (this audit)

### 1. GAME_STATE section size logging

**File:** `server/src/net/websocket_server.c`  
**What:** Track last/max payload bytes and per-section sizes (ships, players, npcs, projectiles, tombstones, droppedItems, companies). Logged every 10 s as `gs payload stats`.

### 2. Live admin performance API

**Files:** `server/include/net/websocket_server.h`, `server/src/net/websocket_server.c`, `server/src/admin/admin_api.c`  
**What:** Replaced fake `/api/performance` JSON with `websocket_server_get_perf_snapshot()` — blob build times, send timings, payload sizes, sim tick/entity counts.

### 3. Client GAME_STATE audit stats

**File:** `client/src/net/NetworkManager.ts`  
**What:** Rolling inter-arrival times and payload bytes exposed as `window.__networkAuditStats` (p50/p95 spacing, ping, lastBytes).

### 4. WebSocket load harness

**Files:** `server/tests/ws_load_bot.mjs`, `server/tests/README_ws_load_bot.md`  
**What:** Raw HTTP upgrade + masked RFC6455 frames; N bots send `movement_state` (~25 Hz) + `input_frame`. Counts `{"type":"GAME_STATE"}` frames.

### 5. Network smoke script

**File:** `scripts/network-smoke.sh`  
**What:** Starts server, optional load bots, parses blob/send logs, fails on blob threshold, curls admin API.

### 6. Reusable audit prompt

**File:** `docs/NETWORK_TESTING_PROMPT.md`  
**What:** Copy-paste agent prompt for future regression runs.

---

## Previously Resolved (verified in tree)

| ID | Item | Status |
|----|------|--------|
| A | `per_gs_pool` signed offset / `-Warray-bounds` | **Resolved** — `size_t _goff`, capped `_GS`/`_MC1` |
| B | `view_radius` hardcoded 5000 | **Resolved** — `SERVER_TO_CLIENT(_vp->view_radius)` in send loop |
| C | O(structures) dock/shipyard scans | **Resolved** — `structure_index.c` on hot paths |

---

## Test Matrix Results

| ID | Scenario | Status | Key metrics |
|----|----------|--------|-------------|
| S0 | Idle baseline | **Automated** | blob ~20 µs, 0 overruns, gs=0 |
| S1 | Solo explorer / fog AOI | Manual | Use `__networkAuditStats` coast vs open sea |
| S2 | Dock/shipyard | Manual | structure_index paths; no regression expected |
| S3 | Crowded deck 4–8 | Manual | — |
| S4 | Naval combat | Manual | projectiles global in blob (not AOI-filtered) |
| S5 | Island build | Manual | STRUCTURES separate message |
| S6 | Grapple cross-ship | Manual | semi-authority movement |
| S7 | Scale 8→64 | **Partial** | 4 bots OK; 0 defer/eagain; needs 16/32/64 run |
| S8 | Adverse latency | Not run | `tc netem` on loopback |
| S9 | Tab background | Not run | client clock resync |
| S10 | Long soak 30 min | Not run | — |

---

## Top 10 Bottlenecks (ranked)

### 1. Simulation step dominates tick under load — P0

- **Evidence:** Live session: `sim=49308–116774 us` vs `send=924–6774 us`; ticks 46–122 ms (budget 33 ms)
- **Symptom:** Server falls behind 30 Hz; clients see irregular snapshot spacing → `[INTERP] holdNew`
- **Root cause:** Physics/collision/NPC work in `sim_step()` exceeds budget with active player
- **Fix:** Profile `sim_step` sections; defer non-critical work — **Needs Human Review** (collision correctness)
- **Recommendation:** Spike with section timers in `simulation.c`; do not auto-opt collisions

### 2. Blob worker max_build spikes — P1

- **Evidence:** Live: `max_build=32455 µs`; idle/smoke: `max=200–1149 µs`
- **Symptom:** Occasional frame hitch when worker misses deadline
- **Root cause:** Ship JSON + shared blob build in `build_shared_blobs_from_snapshot`
- **Fix A:** Continue dirty-key caching; **Fix B:** split ship JSON incremental updates
- **Recommendation:** Monitor `lag` counter; spike if lag > 2 sustained

### 3. NPC section largest AOI payload — P2

- **Evidence:** 6,770 / 11,453 bytes (59%) with 4 bots at default view
- **Symptom:** Bandwidth scales with NPC count × clients
- **Root cause:** Per-NPC JSON in blob; AOI filters count not size of entries
- **Fix:** Stronger NPC dirty cache; distance-based detail reduction — **Needs Human Review** (fairness)
- **Recommendation:** Measure S7 at 16 clients before changing NPC serialization

### 4. Projectiles/tombstones/ditems/companies not AOI-filtered — P2

- **Evidence:** Code comment ~L14054; global `_MC1` for all clients
- **Symptom:** Combat with many projectiles inflates every client's GAME_STATE
- **Root cause:** Intentional deferral in send loop
- **Fix:** AOI-filter projectiles by position; cap max per client
- **Recommendation:** Spike after quantifying projectile count in S4

### 5. `sim_update_spatial_hash` full memset — P2

- **Evidence:** `simulation.c:1953` — `memset` entire 4096-cell grid each tick (~1.5 MB)
- **Symptom:** Fixed per-tick cost even with few entities
- **Fix:** Dirty-cell incremental clear — **Needs Human Review** (collision audit)
- **Recommendation:** Defer until sim profiling confirms significant share

### 6. Send dispatch spikes with 1 player — P2

- **Evidence:** Live: `dispatch=401/27678 µs`, `loop=413/27691 µs`
- **Symptom:** TCP send backpressure; possible single-frame delay
- **Root cause:** Large GAME_STATE + kernel socket buffer
- **Fix:** Already has RR budget + EAGAIN handling; consider zlib or binary protocol long-term
- **Recommendation:** Watch `eagain` at 16+ clients (smoke: 0 at 4)

### 7. Dual client input protocol overhead — P3

- **Evidence:** `movement_state` ~25 Hz + `input_frame` tiered; `updateNearbyPlayerCount` unwired
- **Symptom:** Redundant upstream bytes; crowded-area 60 Hz tier inactive
- **Fix A:** Wire nearby-player count to tiers; **Fix B:** drop legacy `input_frame` when hybrid stable
- **Recommendation:** Measure bytes/min in NetworkManager stats first

### 8. `player_inventory_weight` duplicate calls — P3

- **Evidence:** Comment ~L15746; grep shows multiple call sites per tick
- **Symptom:** Minor CPU in movement hot path
- **Fix:** Hoist once per player per tick (comment already notes intent)
- **Recommendation:** Ship minimal hoist when touching movement code

### 9. Admin/monitoring was blind — P3 (fixed)

- **Evidence:** `/api/performance` returned hardcoded fake values
- **Status:** Fixed in this audit
- **Recommendation:** Add Grafana scrape or CI smoke on `/api/performance`

### 10. No automated WS load test before this audit — P3 (fixed)

- **Evidence:** UDP `bot_client.c` only; CMake disables bot-client
- **Status:** `ws_load_bot.mjs` + `network-smoke.sh` added
- **Recommendation:** CI job: smoke 90 s, 4 bots, fail if blob last > 3500 µs idle or gs > 400 KB at 4 clients

---

## Build Verification

- `make -C server` → exit 0
- `cd client && ./node_modules/.bin/tsc --noEmit` → exit 0
- `./scripts/network-smoke.sh --duration 15 --clients 4` → exit 0, 4/4 bots connected

---

## Proposed (Needs Human Review)

1. **AOI-filter projectiles** in per-client GAME_STATE assembly
2. **Incremental spatial hash** clear in `sim_update_spatial_hash`
3. **NPC payload LOD** (omit idle fields / reduce precision at distance)
4. **Collision/physics profiling** before any sim_step optimization
5. **Retire or wire `input_frame`** tiers vs hybrid-only protocol

---

## Monitoring Follow-up

Wire into CI / dashboard (already available via logs + admin API):

| Counter | Source |
|---------|--------|
| blob last/max_build_us | log + `/api/performance` |
| send_build/dispatch/loop | log + `/api/performance` |
| gs_total + section bytes | log + `/api/performance` |
| rr_deferred, eagain | log + `/api/performance` |
| tick overrun sections | `server.c` warn log |
| Client inter-arrival p95 | `window.__networkAuditStats` |
| holdNew ratio | `PredictionEngine.DEBUG_INTERP = true` |

---

## Client Experience Checklist (manual)

1. Enable `PredictionEngine.DEBUG_INTERP = true` → holdNew should stay <10% on LAN
2. Compare `__networkAuditStats.lastBytes` at coast (~3k view_radius) vs open sea (~5k)
3. Ping green (<80 ms) on LAN; investigate if p95 >200 ms
4. Dock walk + deck transitions — no rubberband (structure_index regression watch)
5. Tab away 30 s → return; check for clock resync snap
