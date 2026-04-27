#pragma once
#include "net/websocket_server.h"
#include <stdbool.h>
#include <stdint.h>

/* Convert world coordinates to/from dock-local space */
void dock_world_to_local(const PlacedStructure *dock, float wx, float wy, float *lx, float *ly);
void dock_local_to_world(const PlacedStructure *dock, float lx, float ly, float *wx, float *wy);

/* Returns true if the dock-local point is on a walkable dock surface */
bool dock_point_on_surface(float lx, float ly, bool has_scaffolding);

/* Push player (world coords) out of dock OBB collision */
void dock_apply_player_collision(const PlacedStructure *dock, float player_r,
                                 bool has_scaffolding, float *wx, float *wy);

/* Ship-dock physics: resolve ships entering the dock zone */
void handle_ship_dock_collisions(void);

/* Wall helpers used by island structure placement */
float wall_get_rad(float wx, float wy);
bool  wall_has_support(float wx, float wy);
