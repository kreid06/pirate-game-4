#ifndef BUCKET_BAIL_H
#define BUCKET_BAIL_H

#include "net/websocket_server.h"
#include "sim/simulation.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BUCKET_FILL_COOLDOWN_MS   1250u
#define BUCKET_PROXIMITY_PX       60.0f
#define BUCKET_BAIL_HALF_HP       2.0f
#define BUCKET_BAIL_FULL_HP       4.0f
#define BUCKET_LOWER_SCOOP_FILL   0.25f  /* lower deck — water must reach 25% hull flood */
#define BUCKET_UPPER_SCOOP_FILL   0.75f  /* upper deck — water must reach 75% hull flood */
#define BUCKET_WELL_SCOOP_FILL    0.01f  /* bilge well — scoop at 1% flood */
#define BUCKET_SCOOP_FILL_GRACE   0.03f  /* tolerance while minigame runs (~2s heal drift) */

/*
 * Bucket dump rules (server-authoritative):
 *   - Player must be within BUCKET_PROXIMITY_PX of a valid dump point on their current deck.
 *   - Upper deck (deck_level 1): within BUCKET_PROXIMITY_PX of the hull rail edge.
 *   - Lower deck (deck_level 0): valid only near an open gunport or destroyed plank (hull opening).
 *   - Invalid dump: hull_health -= amount (4 full / 2 half bucket), flood rises; bucket still emptied.
 *   - Valid dump: hull unchanged (water already left ship at scoop time); bucket emptied.
 */

bool bucket_player_has_equipped(const WebSocketPlayer* player);
bool bucket_near_well(const struct Ship* ship, float local_x, float local_y);
bool bucket_can_fill(WebSocketPlayer* player, struct Ship* ship);
bool bucket_can_fill_at(WebSocketPlayer* player, struct Ship* ship,
                         uint8_t deck_level, bool at_well);
bool bucket_is_valid_dump_zone(const WebSocketPlayer* player, const struct Ship* ship);
bool bucket_is_valid_dump_zone_at(const WebSocketPlayer* player, const struct Ship* ship,
                                  uint8_t deck_level);
float bucket_drain_amount(uint8_t fill_level);

bool bucket_apply_fill(WebSocketPlayer* player, struct Ship* ship, bool success,
                       uint8_t req_deck, bool req_at_well,
                       char* response, size_t resp_len);
bool bucket_apply_dump(WebSocketPlayer* player, struct Ship* ship,
                       uint8_t req_deck,
                       char* response, size_t resp_len);

#endif /* BUCKET_BAIL_H */
