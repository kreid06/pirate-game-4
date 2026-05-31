#pragma once
#include "net/websocket_server.h"

/* Forward declaration to avoid implicit struct declaration in parameter lists */
struct WebSocketClient;

void handle_place_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_structure_interact(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_land_chest_transfer(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_land_chest_drop(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_shipyard_action(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_demolish_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_demolish_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);
void handle_salvage_module(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/**
 * Shared structure destruction helper. Marks the structure with the given ID
 * inactive, broadcasts structure_demolished, then cascade-destroys any dependent
 * structures (workbenches/walls/ceilings/doors). Finally compacts inactive
 * entries out of placed_structures[]. Safe to call from any path.
 */
void destroy_placed_structure(uint32_t structure_id);

/**
 * Apply damage to a placed structure. Subtracts dmg from hp (clamped to 0),
 * broadcasts structure_hp_changed on partial damage, and calls
 * destroy_placed_structure on death. Returns true if the structure was destroyed.
 * The pointer s may be invalidated after this call returns true.
 */
bool apply_structure_damage(PlacedStructure *s, uint32_t dmg);

/**
 * handle_repair_structure: player initiates a constant-rate repair on a
 * damaged structure they own (target_hp < max_hp). Computes the resource cost
 * proportional to (max_hp - target_hp) / max_hp from the structure's recipe,
 * consumes the items up-front, and sets repair state on the structure. A
 * second call by the same player cancels the active repair (no refund).
 * Excludes claim flags and flag forts still in the CLAIMING phase.
 */
void handle_repair_structure(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/**
 * handle_door_lock: player locks or unlocks a door they own.
 * Only the owning company can lock/unlock. Broadcasts door_lock_toggled on success.
 */
void handle_door_lock(WebSocketPlayer* player, struct WebSocketClient* client, const char* payload);

/**
 * Per-tick advance of any in-progress structure repairs. Raises hp and
 * target_hp at a constant rate (STRUCTURE_REPAIR_FULL_MS for one max_hp of
 * damage) and broadcasts structure_hp_changed when integer values change.
 * Emits repair_complete when target_hp reaches max_hp.
 */
void structure_repair_tick(uint32_t delta_ms);

/**
 * Scan placed_structures[] and destroy any active entry whose hp has reached 0
 * but was not properly cleaned up (e.g. due to a missed destroy path). Runs at
 * most once every 30 s. Claim flags and flag forts in CLAIMING phase are exempt
 * (they use timer-based removal, not HP). Logs each structure it purges.
 */
void structure_garbage_collect(void);
