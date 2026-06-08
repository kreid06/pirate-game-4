#ifndef SIM_DECK_UTILS_H
#define SIM_DECK_UTILS_H

#include "sim/types.h"
#include <stdbool.h>
#include <math.h>

/* All deck collision/snap coordinates are in client pixels (float),
 * matching SimpleShip.local_x/y and WebSocketPlayer.local_x/y coordinate space. */

// Returns pointer to deck or NULL if deck_id is out of range
static inline const ShipDeck* ship_get_deck(const struct Ship* ship, uint8_t deck_id) {
    for (uint8_t d = 0; d < ship->deck_count; d++) {
        if (ship->decks[d].id == deck_id) return &ship->decks[d];
    }
    return NULL;
}

// Returns true if deck_id exists on this ship
static inline bool ship_has_deck(const struct Ship* ship, uint8_t deck_id) {
    return ship_get_deck(ship, deck_id) != NULL;
}

// Validate module placement: deck_id 0xFF means no deck (always valid for floating modules)
static inline bool validate_module_placement(const struct Ship* ship, uint8_t deck_id) {
    if (deck_id == 0xFF) return true; // deck-independent module
    return ship_has_deck(ship, deck_id);
}

// Returns true if a deck transition from from_deck to to_deck is valid (adjacent z_index)
static inline bool validate_player_deck_transition(const struct Ship* ship, uint8_t from_deck_id, uint8_t to_deck_id) {
    const ShipDeck* from = ship_get_deck(ship, from_deck_id);
    const ShipDeck* to   = ship_get_deck(ship, to_deck_id);
    if (!from || !to) return false;
    int dz = (int)to->z_index - (int)from->z_index;
    return dz == 1 || dz == -1;
}

/* Point-in-polygon test for deck collision boundary.
 * local_x, local_y: player position in client pixels, ship-local space.
 * Returns true if the point is inside the deck's collision polygon. */
static inline bool is_player_within_deck_bounds(const struct Ship* ship, uint8_t deck_id,
                                                 float local_x, float local_y) {
    const ShipDeck* deck = ship_get_deck(ship, deck_id);
    if (!deck || deck->collision_count < 3) return true; // no polygon = open
    int inside = 0;
    int n = (int)deck->collision_count;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = deck->collision_px[i][0], yi = deck->collision_px[i][1];
        float xj = deck->collision_px[j][0], yj = deck->collision_px[j][1];
        if (((yi > local_y) != (yj > local_y)) &&
            (local_x < (xj - xi) * (local_y - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside != 0;
}

#endif // SIM_DECK_UTILS_H
