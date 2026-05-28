#include "sim/deck_utils.h"

// can_place_module_on_deck: returns true if deck_id exists (or is 0xFF for deck-independent)
bool can_place_module_on_deck(const struct Ship* ship, uint8_t deck_id) {
    return validate_module_placement(ship, deck_id);
}

// can_player_move_to_deck: returns true if transitioning between the two deck ids is valid
bool can_player_move_to_deck(const struct Ship* ship, uint8_t from_deck_id, uint8_t to_deck_id) {
    return validate_player_deck_transition(ship, from_deck_id, to_deck_id);
}

