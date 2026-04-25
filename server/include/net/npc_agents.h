#pragma once
#include "net/websocket_server_internal.h"

void tick_npc_agents(float dt);
void tick_cannon_needed_expiry(void);
void tick_swivel_crew_demand(SimpleShip* ship);
void assign_weapon_group_crew(SimpleShip* ship);
void update_npc_cannon_sector(SimpleShip* ship, float aim_angle);
void npc_apply_xp(WorldNpc* npc, uint32_t xp_gain);
void player_apply_xp(WebSocketPlayer* p, uint32_t xp_gain);
