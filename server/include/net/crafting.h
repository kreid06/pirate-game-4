#pragma once
#include "net/websocket_server.h"
#include "net/quality_payload.h"

int  craft_count_item(WebSocketPlayer* player, ItemKind item);
bool craft_consume(WebSocketPlayer* player, ItemKind item, int amount);
bool craft_grant(WebSocketPlayer* player, ItemKind item, int amount);
void handle_craft_item(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/* Grant a quality item into the first free inventory slot, attaching `q` as its
 * per-slot payload. Quality items do not stack. Returns false if inventory full. */
bool craft_grant_quality(WebSocketPlayer* player, ItemKind item, const QualityPayload* q);

/* Add a blueprint to the player's persistent schematic inventory. Returns false
 * if the schematic store is full. Entries with the same item but different
 * quality coexist as separate dropdown entries. */
bool schematic_add(WebSocketPlayer* player, ItemKind item, uint8_t crafts,
                   const QualityPayload* q);

/** Clear a schematic slot and recompute the high-water index. Returns false if empty. */
bool schematic_remove_at(WebSocketPlayer* player, int index);

void schematic_recompute_count(WebSocketPlayer* player);

/* Craft one item from a schematic (by index). Validates resources (quality-scaled
 * cost) + workbench, decrements the charge, grants a quality item. */
void handle_craft_blueprint(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/* Serialize and send the player's full schematic inventory to a client. */
void send_schematic_list(WebSocketPlayer* player, struct WebSocketClient* client);
