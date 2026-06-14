# Branching & Contribution Guide

## ⚠️ `main` is the deploy button

Pushing to `main` triggers automatic **production** deploys via GitHub Actions:

| Paths changed on `main` | Workflow | Effect |
|-------------------------|----------|--------|
| `server/**`, `protocol/**`, `server/auth/**` | `deploy-server.yml` | SSHes to the prod VPS, rebuilds, restarts `pirate-server` + `pirate-auth` |
| `client/**`, `protocol/**` | `deploy-client.yml` | Publishes the client to GitHub Pages |

**Never push work-in-progress to `main`.** Treat a merge into `main` as "ship to
players right now." Everything else flows through `develop` first.

## Branch model

```
main      ──●─────────────●───────────────●──     production (auto-deploy)
            ▲             ▲               ▲
            │ release PR  │ release PR    │ release PR
develop   ──●──●──●──●────●──●──●──●──────●──●──   integration trunk (safe, no deploy)
              ▲  ▲              ▲
              │  │              │  merge PRs
         feature/*  fix/*   perf/daily-*
```

- **`main`** — Production / release trunk. Only ever updated by a deliberate release
  PR from `develop`. Protected; no direct commits.
- **`develop`** — Integration trunk. Default base for all PRs. Pushing here does **not**
  deploy, so it's safe to accumulate and test multiple changes before a release.
- **Short-lived branches** — Always cut from `develop`, always PR back into `develop`.

### Branch naming

| Prefix | Use for | Example |
|--------|---------|---------|
| `feature/` | New gameplay/systems | `feature/loot-tiers` |
| `fix/` | Bug fixes | `fix/npc-utf8-overflow` |
| `perf/` | Performance work (incl. the daily automation) | `perf/daily-2026-06-14` |
| `chore/` | Tooling, deps, refactors with no behavior change | `chore/bump-vite` |
| `exp/` | Throwaway experiments (never merged as-is) | `exp/quadtree-aoi` |

Keep names short, lowercase, hyphenated. One logical change per branch.

## Daily performance automation fits here

The daily perf automation opens **draft** PRs `perf/daily-YYYY-MM-DD` **into `develop`**
(never `main`). Draft + `develop` base means it can never trigger a production deploy.
You review the PR, and it only reaches players later via a normal release PR
(`develop` → `main`).

## Everyday workflow

```bash
# Start a change
git checkout develop && git pull
git checkout -b feature/my-thing

# ... work, committing in small steps ...

# Verify before pushing (see "Definition of done")
make -C server
cd client && npx tsc --noEmit && cd ..

# Push and open a PR INTO develop
git push -u origin feature/my-thing
gh pr create --base develop --title "feature: my thing" --body "..."
```

## Releasing to production

```bash
# When develop is tested and you want players to get it:
gh pr create --base main --head develop --title "release: 2026-06-14"
# Review, then merge. The merge into main is what deploys.
```

For a server-only or client-only release, the path filters mean only the relevant
deploy runs. Bumping `protocol/**` deploys **both** — coordinate client/server protocol
changes in the same release.

---

# How to add a new feature in this project

This is a client-predicted, server-authoritative game. The #1 source of bugs is
**client/server divergence**, so most features touch both sides and must stay in sync.

## 1. Decide where authority lives
- The **server** (C, `server/src/`) is authoritative for simulation, collision,
  anti-cheat, and persistence.
- The **client** (TS, `client/src/`) predicts locally for responsiveness and
  reconciles against server snapshots.
- New mechanics almost always need: server simulation + a snapshot field + client
  parsing + client prediction/render.

## 2. Map the touch points
| Concern | Server | Client |
|---------|--------|--------|
| Simulation / rules | `server/src/sim/simulation.c`, `server/src/net/websocket_server.c` | `client/src/sim/Physics.ts` |
| Networking / messages | `server/src/net/snapshot.c`, blob assembly in `websocket_server.c` | `client/src/net/NetworkManager.ts`, `PredictionEngine.ts` |
| Shared constants | C `#define`s / consts | `client/src/sim/Types.ts` (`PhysicsConfig`) |
| Persistence | `server/src/sim/world_save.c` | n/a |
| Rendering / UI | n/a | `client/src/client/gfx/RenderSystem.ts`, `client/src/client/...` |

## 3. Keep constants in parity
Physics/movement constants exist on **both** sides and must match exactly
(walk/sprint/swim speeds, accel/decel, drag, radii, AOI view radius). When you add or
change one, change its twin in the same PR. Mismatches cause rubber-banding and
correction storms.

## 4. Respect the netcode model
- **Semi-authority movement**: the server adopts the client's reported position
  (speed-clamped). Don't add server logic that silently relocates the player without a
  forced-correction path the client understands.
- **AOI / broadcast**: per-client GAME_STATE is distance-filtered (5000-unit radius).
  New broadcast entities must be AOI-filtered and use per-entry serialization, not a
  single shared blob that can overflow.
- **Buffer discipline**: when serializing arrays into fixed buffers, size for the
  worst case (`MAX_*` × max-entry-bytes) and guard `snprintf` size arithmetic against
  signed/unsigned wrap. (This class of bug produced the NPC UTF-8 frame corruption.)
- **Caps & cleanup**: entity arrays have hard caps (`MAX_WORLD_NPCS`, `MAX_SHIPS`,
  `WS_MAX_CLIENTS`). Trim/compact tails when entities die so per-tick work and
  snapshots don't process dead slots.

## 5. Persist if it should survive restart
If the feature adds persistent state (entities, player progression, world config),
extend `world_save.c` save **and** load, and add the fields to the relevant structs.
Don't store secrets or large transient blobs in `world_state.json`.

## 6. Definition of done (run before every PR)
- `make -C server` compiles with **no new warnings**.
- `cd client && npx tsc --noEmit` passes.
- Client and server constants/protocol are in sync.
- New broadcast data is AOI-filtered and buffer-safe.
- No gameplay-perceptible change to movement/anti-cheat unless that's the explicit goal.
- PR targets `develop` (not `main`).

## 7. Useful references in `docs/`
- `architecture.md` — client/server responsibilities and data flow
- `client-side-prediction.md`, `HYBRID_INPUT_PROTOCOL.md` — movement/netcode model
- `PROTOCOL.md` — message formats
- `PLAYER_SHIP_ARCHITECTURE.md`, `MODULE_ARCHITECTURE_DIAGRAM.md` — ship/module systems
- `DEPLOYMENT.md`, `SSL_SETUP.md` — deploy and infra
