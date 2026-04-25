#pragma once
#include "net/websocket_server_internal.h"

ShipModule* find_module_on_ship(SimpleShip* ship, uint32_t module_id);
void dismount_npc(WorldNpc* npc, SimpleShip* ship);
void handle_crew_assign(uint16_t ship_id, uint16_t npc_id, const char* task);
uint32_t spawn_ship_crew(uint16_t ship_id, const char* name);
uint32_t spawn_unclaimed_npc(float wx, float wy, int index);
void tick_world_npcs(float dt);
