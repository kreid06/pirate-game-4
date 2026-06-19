#include "net/ship_plank_wreckage.h"
#include "util/time.h"

int ship_plank_slot_from_module_id(uint16_t module_id, uint8_t ship_seq)
{
    if (!MID_BELONGS_TO(module_id, ship_seq))
        return -1;
    uint8_t off = MID_OFFSET(module_id);
    if (!MODULE_OFFSET_IS_PLANK(off))
        return -1;
    int slot = (int)(off - MODULE_OFFSET_PLANK_BASE);
    if (slot < 0 || slot >= 10)
        return -1;
    return slot;
}

void ship_plank_start_wreckage(SimpleShip *ship, int slot)
{
    if (!ship || slot < 0 || slot >= 10)
        return;
    ship->plank_wreckage_until_ms[slot] = get_time_ms() + PLANK_WRECKAGE_DURATION_MS;
}

void ship_plank_start_wreckage_for_module(SimpleShip *ship, uint16_t module_id)
{
    if (!ship)
        return;
    int slot = ship_plank_slot_from_module_id(module_id, ship->ship_seq);
    if (slot >= 0)
        ship_plank_start_wreckage(ship, slot);
}

bool ship_plank_wreckage_blocks(const SimpleShip *ship, int slot)
{
    if (!ship || slot < 0 || slot >= 10)
        return false;
    uint32_t until = ship->plank_wreckage_until_ms[slot];
    if (until == 0)
        return false;
    if (get_time_ms() >= until)
        return false;
    return true;
}

uint32_t ship_plank_wreckage_until_ms(const SimpleShip *ship, int slot)
{
    if (!ship || slot < 0 || slot >= 10)
        return 0;
    uint32_t until = ship->plank_wreckage_until_ms[slot];
    if (until == 0 || get_time_ms() >= until)
        return 0;
    return until;
}

void ship_plank_clear_wreckage(SimpleShip *ship, int slot)
{
    if (!ship || slot < 0 || slot >= 10)
        return;
    ship->plank_wreckage_until_ms[slot] = 0;
}
