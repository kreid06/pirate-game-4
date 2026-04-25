#pragma once
#include "net/websocket_server.h"

void tick_sinking_ships(void);
void ship_init_default_weapon_groups(SimpleShip* ship);
void init_brigantine_ship(int idx, float world_x, float world_y, uint8_t ship_seq, uint8_t company_id, uint8_t modules_placed);
void tick_ghost_ships(float dt);
