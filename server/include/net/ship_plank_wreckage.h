#ifndef SHIP_PLANK_WRECKAGE_H
#define SHIP_PLANK_WRECKAGE_H

#include <stdbool.h>
#include <stdint.h>
#include "net/websocket_server.h"
#include "sim/module_ids.h"

#define PLANK_WRECKAGE_DURATION_MS 15000u

/** Map a plank module ID to slot index 0–9, or -1 if invalid. */
int ship_plank_slot_from_module_id(uint16_t module_id, uint8_t ship_seq);

/** Block a plank slot for PLANK_WRECKAGE_DURATION_MS after destruction. */
void ship_plank_start_wreckage(SimpleShip *ship, int slot);
void ship_plank_start_wreckage_for_module(SimpleShip *ship, uint16_t module_id);

/** True while wreckage is still clearing (lazy-expires stale entries). */
bool ship_plank_wreckage_blocks(const SimpleShip *ship, int slot);

/** Absolute wall-clock ms when wreckage clears; 0 if slot is not blocked. */
uint32_t ship_plank_wreckage_until_ms(const SimpleShip *ship, int slot);

void ship_plank_clear_wreckage(SimpleShip *ship, int slot);

#endif
