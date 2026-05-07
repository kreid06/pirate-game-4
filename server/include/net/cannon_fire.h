#pragma once
#include "net/websocket_server.h"

/* Shared constants used by websocket_server.c and cannon_fire.c */
#define FIRE_DURATION_MS   4000u   /* ms an entity burns after ignition   */
#define TREE_TRUNK_R_PX    18.0f   /* tree trunk collision radius vs player (px) */

struct WebSocketClient;

int parse_json_uint32_array(const char* json, const char* key, uint32_t* out, int max_out);
void handle_cannon_group_config(WebSocketPlayer* player, int group_index, WeaponGroupMode mode, module_id_t* weapon_ids, int weapon_count, uint16_t target_ship_id);
void tick_ship_weapon_groups(void);
void handle_cannon_aim(WebSocketPlayer* player, float aim_angle, uint32_t* active_group_indices, int active_group_count);
void broadcast_cannon_group_state(SimpleShip* ship, uint8_t company_id);
void handle_cannon_force_reload(WebSocketPlayer* player);
void handle_cannon_fire(WebSocketPlayer* player, bool fire_all, uint8_t ammo_type, module_id_t* explicit_ids, int explicit_count, bool skip_aim_check);
void update_flame_waves(uint32_t time_elapsed);
void check_projectile_static_collisions(struct Sim* sim);
void fire_cannon(SimpleShip* ship, ShipModule* cannon, WebSocketPlayer* player, bool manually_fired, uint8_t ammo_type);
void fire_island_cannon(PlacedStructure* cannon_struct, WebSocketPlayer* player, uint8_t ammo_type);
void handle_island_cannon_aim(WebSocketPlayer* player, float aim_angle);
int  handle_island_cannon_fire(WebSocketPlayer* player, uint8_t ammo_type);