#pragma once
#include <stdint.h>
#include "net/websocket_server.h"

/** Rebuild shipyard/chest/id lookup tables from placed_structures[]. */
void structure_index_rebuild(void);

/** Active shipyard whose scaffolded_ship_id matches ship_id, or NULL. */
PlacedStructure *shipyard_by_scaffolded_ship(uint32_t ship_id);

/** Active shipyard with structure id, or NULL. */
PlacedStructure *shipyard_by_id(uint16_t struct_id);

/** Compact list of placed_structures[] slot indices for active shipyards. */
uint32_t structure_index_shipyard_count(void);
const uint32_t *structure_index_shipyard_slots(void);

/** Compact list of placed_structures[] slot indices for active land chests. */
uint32_t structure_index_chest_count(void);
const uint32_t *structure_index_chest_slots(void);
