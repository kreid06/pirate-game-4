#include "net/structure_index.h"
#include "net/websocket_server_internal.h"
#include <string.h>

#define STRUCT_ID_INDEX_CAP      512
#define SHIP_SCAFFOLD_INDEX_CAP  512

static int16_t  struct_id_to_idx[STRUCT_ID_INDEX_CAP];
static int16_t  ship_scaffold_to_idx[SHIP_SCAFFOLD_INDEX_CAP];
static uint32_t shipyard_slots[MAX_PLACED_STRUCTURES];
static uint32_t shipyard_count;
static uint32_t chest_slots[MAX_PLACED_STRUCTURES];
static uint32_t chest_count;

void structure_index_rebuild(void)
{
    for (int i = 0; i < STRUCT_ID_INDEX_CAP; i++) struct_id_to_idx[i] = -1;
    for (int i = 0; i < SHIP_SCAFFOLD_INDEX_CAP; i++) ship_scaffold_to_idx[i] = -1;
    shipyard_count = 0;
    chest_count    = 0;

    for (uint32_t i = 0; i < placed_structure_count; i++) {
        PlacedStructure *s = &placed_structures[i];
        if (!s->active) continue;

        if (s->id > 0 && s->id < STRUCT_ID_INDEX_CAP)
            struct_id_to_idx[s->id] = (int16_t)i;

        if (s->type == STRUCT_SHIPYARD) {
            if (shipyard_count < MAX_PLACED_STRUCTURES)
                shipyard_slots[shipyard_count++] = i;
            if (s->scaffolded_ship_id > 0 &&
                s->scaffolded_ship_id < SHIP_SCAFFOLD_INDEX_CAP) {
                ship_scaffold_to_idx[s->scaffolded_ship_id] = (int16_t)i;
            }
        } else if (s->type == STRUCT_CHEST) {
            if (chest_count < MAX_PLACED_STRUCTURES)
                chest_slots[chest_count++] = i;
        }
    }
}

PlacedStructure *shipyard_by_scaffolded_ship(uint32_t ship_id)
{
    if (ship_id == 0) return NULL;
    if (ship_id < SHIP_SCAFFOLD_INDEX_CAP) {
        int16_t idx = ship_scaffold_to_idx[ship_id];
        if (idx >= 0) {
            PlacedStructure *s = &placed_structures[(uint32_t)idx];
            if (s->active && s->type == STRUCT_SHIPYARD &&
                s->scaffolded_ship_id == ship_id) {
                return s;
            }
        }
    }
    for (uint32_t i = 0; i < shipyard_count; i++) {
        PlacedStructure *s = &placed_structures[shipyard_slots[i]];
        if (s->active && s->scaffolded_ship_id == ship_id) return s;
    }
    return NULL;
}

PlacedStructure *shipyard_by_id(uint16_t struct_id)
{
    if (struct_id == 0) return NULL;
    if (struct_id < STRUCT_ID_INDEX_CAP) {
        int16_t idx = struct_id_to_idx[struct_id];
        if (idx >= 0) {
            PlacedStructure *s = &placed_structures[(uint32_t)idx];
            if (s->active && s->type == STRUCT_SHIPYARD && s->id == struct_id)
                return s;
        }
    }
    /* Fallback: next_structure_id is monotonic and never reused, so ids can
     * exceed STRUCT_ID_INDEX_CAP on long-running servers. */
    for (uint32_t i = 0; i < shipyard_count; i++) {
        PlacedStructure *s = &placed_structures[shipyard_slots[i]];
        if (s->active && s->id == struct_id) return s;
    }
    return NULL;
}

uint32_t structure_index_shipyard_count(void) { return shipyard_count; }
const uint32_t *structure_index_shipyard_slots(void) { return shipyard_slots; }

uint32_t structure_index_chest_count(void) { return chest_count; }
const uint32_t *structure_index_chest_slots(void) { return chest_slots; }
