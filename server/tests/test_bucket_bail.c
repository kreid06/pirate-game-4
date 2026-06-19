#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "core/math.h"
#include "net/bucket_bail.h"
#include "net/websocket_server.h"
#include "sim/simulation.h"

SimpleShip* find_ship(uint16_t ship_id) {
    (void)ship_id;
    return NULL;
}

static void setup_player_with_bucket(WebSocketPlayer* player, uint8_t deck_level) {
    memset(player, 0, sizeof(*player));
    player->parent_ship_id = 1;
    player->deck_level = deck_level;
    player->inventory.active_slot = 0;
    player->inventory.slots[0].item = ITEM_BUCKET;
    player->inventory.slots[0].quantity = 1;
}

static struct Ship flooded_ship(float hull_pct) {
    struct Ship ship;
    memset(&ship, 0, sizeof(ship));
    ship.hull_health = Q16_FROM_FLOAT(hull_pct);
    return ship;
}

static void test_spoofed_at_well_rejected(void) {
    WebSocketPlayer player;
    setup_player_with_bucket(&player, 1);
    struct Ship ship = flooded_ship(90.0f); /* ~10% flood — not enough for upper deck */

    assert(!bucket_can_fill_at(&player, &ship, 0, true));
    assert(!bucket_can_fill(&player, &ship));
    printf("  spoofed atWell/deckLevel rejected on upper deck\n");
}

static void test_upper_deck_threshold(void) {
    WebSocketPlayer player;
    setup_player_with_bucket(&player, 1);
    struct Ship low = flooded_ship(90.0f);
    struct Ship high = flooded_ship(20.0f);

    assert(!bucket_can_fill(&player, &low));
    assert(bucket_can_fill(&player, &high));
    printf("  upper deck requires 75%% flood threshold\n");
}

int main(void) {
    printf("Testing bucket bail authority...\n");
    test_spoofed_at_well_rejected();
    test_upper_deck_threshold();
    printf("Bucket bail tests passed!\n");
    return 0;
}
