#pragma once
#include "net/websocket_server.h"
#include <stdbool.h>
#include <stdint.h>

/* ── Shipyard geometry (client px) — keep in sync with client ShipyardGeometry.ts ── */
#define DOCK_BASE           50.0f
#define DOCK_ARM_T          50.0f
#define DOCK_INT_W          240.0f
#define DOCK_ARM_L          790.0f   /* was 840 — tighter fit for brigantine */
#define DOCK_BACK_T         50.0f
#define DOCK_HW             170.0f   /* (ARM_T + INT_W + ARM_T) / 2 */
#define DOCK_HH             420.0f   /* (BACK_T + ARM_L) / 2 — was 445 */

/* Brigantine build slot AABB in dock-local space (bow faces +Y when dock rot = 0). */
#define BRIG_SLOT_HALF_X    110.0f
#define BRIG_SLOT_Y_MIN    -355.0f
#define BRIG_SLOT_Y_MAX     425.0f

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

/* True if the brigantine build slot at (dock_x,dock_y,dock_rot_deg) overlaps island land. */
bool dock_brig_slot_overlaps_land(float dock_x, float dock_y, float dock_rot_deg);

/* Wall helpers used by island structure placement */
float wall_get_rad(float wx, float wy);
bool  wall_has_support(float wx, float wy);
