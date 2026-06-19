#pragma once
#include "net/websocket_server.h"
#include "net/quality_payload.h"
#include "sim/module_types.h"
#include <stdbool.h>

struct WebSocketClient;

bool ship_schematic_item_allowed(ItemKind item);

/** Map a ship module type to the pool item id used for schematic lookup (ITEM_NONE if unsupported). */
ItemKind ship_schematic_item_from_module_type(ModuleTypeId type);

/* Pick lowest priority value (0 = first) pool entry for `item`, apply quality to `out_q`, decrement crafts.
 * Returns false if no usable entry. Removes the slot when crafts hit 0. */
bool ship_schematic_consume_for_item(SimpleShip* ship, ItemKind item, QualityPayload* out_q);

void send_ship_schematic_list(SimpleShip* ship, struct WebSocketClient* client);
void ship_schematic_broadcast_list(uint16_t ship_id);

void handle_request_ship_schematics(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_ship_schematic_deposit(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_ship_schematic_withdraw(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_ship_schematic_reorder(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/** True when the ship still has at least one workbench module. */
bool ship_has_workbench(const SimpleShip* ship);

/** Dump the ship schematic pool into one or more sea wrecks at (wx, wy).
 * Clears the pool. Returns the number of wrecks spawned. */
int ship_schematic_spawn_pool_wrecks(SimpleShip* ship, float wx, float wy);
