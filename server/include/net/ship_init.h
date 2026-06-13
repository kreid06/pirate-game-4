#pragma once
#include "net/websocket_server.h"

void tick_sinking_ships(void);
void tick_wrecks(void);
void tick_claim_flags(float dt);
void ship_init_default_weapon_groups(SimpleShip* ship);
void init_brigantine_ship(int idx, float world_x, float world_y, uint8_t ship_seq, uint8_t company_id, uint8_t modules_placed);
void tick_ghost_ships(float dt);

/* Ghost ship spawn-point system */
void load_ghost_spawns(const char *path);
void tick_ghost_spawn_points(float dt);
void ghost_ship_sunk(uint16_t ship_id);
uint32_t websocket_server_create_ghost_ship_level(float x, float y, int level, int spawn_idx);

/* Serialise current spawn-point state to a caller-supplied buffer (for API). */
int ghost_spawns_to_json(char *buf, size_t buf_size);
