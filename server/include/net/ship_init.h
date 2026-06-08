#pragma once
#include "net/websocket_server.h"
#include <stdint.h>

void tick_sinking_ships(void);
void tick_wrecks(void);
void tick_claim_flags(float dt);
void ship_init_default_weapon_groups(SimpleShip* ship);
void init_brigantine_ship(int idx, float world_x, float world_y, uint8_t ship_seq, uint8_t company_id, uint8_t modules_placed);
void tick_ghost_ships(float dt);
void tick_ghost_ship_spawner(float dt);
void ghost_notify_damaged(uint32_t victim_ship_id, uint32_t attacker_ship_id);

/* ── Ghost fleet spawn points ─────────────────────────────────────────────────
 * Static world positions where ghost fleets respawn when the area is clear.
 * Persisted to data/ghost_spawns.json; edited via the map editor.            */
#define MAX_GHOST_SPAWN_POINTS 128
#define GHOST_SPAWNS_PATH      "data/ghost_spawns.json"

typedef struct {
    uint32_t id;
    float    x, y;
    uint8_t  level_min;   /* 1–60 — each ship rolls a random level in [level_min, level_max] */
    uint8_t  level_max;   /* 1–60 */
    uint8_t  fleet_min;   /* 1–10 — fleet size is randomised each spawn in [fleet_min, fleet_max] */
    uint8_t  fleet_max;   /* 1–10 */
    float    angle_deg;   /* 0–360 — base formation rotation; ships fan out from this heading */
} GhostSpawnPoint;

extern GhostSpawnPoint ghost_spawn_points[MAX_GHOST_SPAWN_POINTS];
extern int             ghost_spawn_point_count;

void ghost_spawns_load(void);
void ghost_spawns_save(void);
