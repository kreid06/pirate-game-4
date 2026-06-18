#pragma once
#include "net/websocket_server_internal.h"

ShipModule* find_module_on_ship(SimpleShip* ship, uint32_t module_id);
void dismount_npc(WorldNpc* npc, SimpleShip* ship);
void handle_crew_assign(uint16_t ship_id, uint16_t npc_id, const char* task);
uint32_t spawn_ship_crew(uint16_t ship_id);
/** Spawn 1–3 swimming ghost-ship survivors at the wreck, assigned to killer company. */
int ghost_spawn_survivors(float wreck_x, float wreck_y, uint16_t killer_ship_id);
uint32_t spawn_unclaimed_npc(float wx, float wy, int index);
void tick_world_npcs(float dt);
void npc_set_manual_order(WorldNpc* npc, uint32_t player_id);
void npc_clear_manual_order(WorldNpc* npc);

/** Idle crew grid on the upper deck — up to NPC_IDLE_SLOT_MAX positions. */
#define NPC_IDLE_SLOT_MAX 50

/** Ship-local coords for idle slot index (0 .. NPC_IDLE_SLOT_MAX-1). */
void npc_idle_slot_pos(int slot_idx, float* lx, float* ly);
/** Active slot count for this ship (min of crew cap and NPC_IDLE_SLOT_MAX). */
int  npc_idle_slot_count_for_ship(uint16_t ship_id);
/** Lowest free slot on ship; reserves against onboard + en-route boarders. */
int  npc_alloc_ship_idle_slot(uint16_t ship_id, uint16_t for_npc_id);
/** Apply slot position to NPC local/idle/target (and world x/y if on ship). */
void npc_assign_ship_idle_slot(WorldNpc* npc, SimpleShip* ship, int slot_idx);

void generate_pirate_name(uint32_t seed, char* out, size_t out_size);
