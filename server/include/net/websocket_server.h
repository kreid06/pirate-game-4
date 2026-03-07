#pragma once

#include "sim/types.h"
#include <stdint.h>
#include <stdbool.h>

// ── Company / Alliance system ─────────────────────────────────────────────
// A company groups ships, players, and NPCs into a faction.
// Two companies that share an alliance_id are friendly to each other;
// entities of different companies are hostile.
#define COMPANY_NEUTRAL  0   // Unclaimed/neutral — no friendly-fire protection
#define COMPANY_PIRATES  1   // Player's company
#define COMPANY_NAVY     2   // Enemy AI company

// Simple ship structure for WebSocket server
typedef struct SimpleShip {
    uint32_t ship_id;
    uint32_t ship_type;      // Ship type ID (1=sloop, 2=cutter, 3=brigantine, etc.)
    float x, y;              // World position
    float rotation;          // Radians
    float velocity_x, velocity_y;
    float angular_velocity;
    
    // Physics properties (from ship definitions)
    float mass;              // Ship mass (kg)
    float moment_of_inertia; // Rotational inertia (kg⋅m²)
    float max_speed;         // Maximum speed (m/s)
    float turn_rate;         // Maximum turn rate (rad/s)
    float water_drag;        // Linear drag coefficient (0-1)
    float angular_drag;      // Angular drag coefficient (0-1)
    
    float deck_min_x, deck_max_x;  // Walkable area
    float deck_min_y, deck_max_y;
    bool active;
    
    // Ship control state
    uint8_t desired_sail_openness;  // Target sail openness (0-100%)

    // Ship-level ammunition (shared pool for all cannons)
    uint16_t cannon_ammo;    // Remaining cannonballs (unused when infinite_ammo is true)
    bool infinite_ammo;      // When true, cannons never consume ammo

    // Crew AI — last aim angle (ship-local radians) used to compute sector of fire
    float active_aim_angle; // drives update_npc_cannon_sector(); default 0 = forward

    uint8_t company_id;      // COMPANY_* — which faction owns this ship

    // Ship modules (cannons, masts, helm, seats, etc.)
    ShipModule modules[MAX_MODULES_PER_SHIP];
    uint8_t module_count;
} SimpleShip;

// NPC behavior types
typedef enum {
    NPC_ROLE_NONE      = 0,
    NPC_ROLE_GUNNER    = 1,  // Mans a cannon: aims at enemy ship and fires
    NPC_ROLE_HELMSMAN  = 2,  // Controls the helm: steers toward/away from target
    NPC_ROLE_RIGGER    = 3,  // Manages a mast: sets sail openness based on orders
} NpcRole;

// NPC agent — server-side autonomous crew member mounted to a module
typedef struct NpcAgent {
    uint32_t npc_id;             // Unique NPC ID (starts at 5000)
    uint32_t ship_id;            // Ship this NPC belongs to
    uint32_t module_id;          // Module this NPC is mounted to (0 = unmounted)
    NpcRole  role;               // What this NPC does each tick
    bool     active;

    // Gunner state
    uint32_t target_ship_id;     // Enemy ship to aim at (0 = no target)
    float    fire_cooldown;      // Seconds remaining before next shot (counts down each tick)
    float    fire_interval;      // Seconds between shots (default 5.0)

    // Helmsman state
    float    desired_heading;    // Target heading in radians
    bool     intercept_mode;     // true = steer toward target; false = flee

    // Rigger state
    uint8_t  desired_openness;   // 0-100 sail openness to maintain
} NpcAgent;

#define MAX_NPC_AGENTS 64

// ── World NPCs ───────────────────────────────────────────────────────────────
// Visible, interactable character entities in the world (separate from NpcAgent AI controllers).
// All crews are sailors for now; a company/alliance system will sort friend from foe later.
#define MAX_WORLD_NPCS 64

// NPC movement/AI state machine
typedef enum {
    WORLD_NPC_STATE_IDLE      = 0, // Resting at or near assigned cannon
    WORLD_NPC_STATE_MOVING    = 1, // Walking across deck to a new cannon after a side switch
    WORLD_NPC_STATE_AT_CANNON = 2, // Arrived — ready to fire
} WorldNpcState;

typedef struct WorldNpc {
    uint32_t      id;
    char          name[32];
    bool          active;
    NpcRole       role;          // NPC_ROLE_GUNNER (cannon) or NPC_ROLE_RIGGER (sail)

    // World position (client units, updated and broadcast every tick)
    float         x, y;
    float         rotation;

    // Ship attachment
    uint32_t      ship_id;         // 0 = free-standing
    float         local_x, local_y; // Ship-local position in CLIENT units

    // Module associations
    // Rigger: port_cannon_id = mast module ID (starboard_cannon_id mirrors it).
    // Gunner: port_cannon_id = future locked-cannon preference (0 = any; player-set later).
    uint32_t      port_cannon_id;       // Rigger: mast ID.  Gunner: locked preference (0=free)
    uint32_t      starboard_cannon_id;  // Rigger: mast ID (mirrors port).  Gunner: unused (0)
    uint32_t      assigned_cannon_id;   // Module the NPC is currently heading to / stationed at
    bool          wants_cannon;         // Gunner: true = on cannon duty via manning panel

    // Movement / state machine
    WorldNpcState state;
    float         target_local_x;
    float         target_local_y;
    float         idle_local_x;   // Spawn-time resting position (returned to when idle)
    float         idle_local_y;
    float         move_speed; // Client units / second (default 80)

    float         interact_radius;
    char          dialogue[64];

    uint8_t       company_id;     // Inherited from ship at spawn time (COMPANY_*)
} WorldNpc;
// ────────────────────────────────────────────────────────────────────────────

// ── Player Inventory ────────────────────────────────────────────────────────
#define INVENTORY_SLOTS 10

typedef enum {
    ITEM_NONE          = 0,
    ITEM_PLANK         = 1,
    ITEM_REPAIR_KIT    = 2,
    ITEM_CANNON_BALL   = 3,
    ITEM_SWORD         = 4,
    ITEM_PISTOL        = 5,
    ITEM_HAMMER        = 6,
    ITEM_CLOTH_ARMOR   = 10,
    ITEM_LEATHER_ARMOR = 11,
    ITEM_IRON_ARMOR    = 12,
    ITEM_WOODEN_SHIELD = 20,
    ITEM_IRON_SHIELD   = 21,
} ItemKind;

typedef struct {
    ItemKind item;
    uint8_t  quantity; // 0 = empty; 1 for weapons/tools; 1-99 for stackables
} InventorySlot;

typedef struct {
    InventorySlot slots[INVENTORY_SLOTS];
    ItemKind armor;       // Equipped armor (ITEM_NONE if bare)
    ItemKind shield;      // Equipped shield (ITEM_NONE if none)
    uint8_t  active_slot; // Currently selected hotbar slot (0-9)
} PlayerInventory;
// ────────────────────────────────────────────────────────────────────────────

typedef enum {
    PLAYER_STATE_IDLE,
    PLAYER_STATE_WALKING,   // On ship deck
    PLAYER_STATE_SWIMMING,  // In water
    PLAYER_STATE_FALLING    // Airborne (jumped off ship)
} PlayerMovementState;

// WebSocket player structure
typedef struct WebSocketPlayer {
    uint32_t player_id;          // WebSocket client player ID (e.g., 1000, 1001)
    uint32_t sim_entity_id;      // Simulation entity ID (e.g., 1, 2, 3)
    char name[64];
    float x, y;
    float velocity_x, velocity_y;
    float rotation;
    
    // Hybrid input system - movement state (persistent)
    float movement_direction_x;  // -1.0 to 1.0 (normalized)
    float movement_direction_y;  // -1.0 to 1.0 (normalized)
    bool is_moving;              // true if actively moving
    
    // Rotation tracking for interpolation
    float last_rotation;         // Previous rotation value
    uint32_t last_rotation_update_time;
    
    uint32_t parent_ship_id;
    float local_x, local_y;
    PlayerMovementState movement_state;
    uint32_t last_input_time;
    bool active;
    
    // Module interaction state
    bool is_mounted;               // Is player mounted to a module
    uint32_t mounted_module_id;    // ID of mounted module (0 if not mounted)
    uint32_t controlling_ship_id;  // ID of ship being controlled (helm only, 0 if not controlling)
    
    // Cannon aiming state
    float cannon_aim_angle;        // World coordinates aim angle (radians)
    float cannon_aim_angle_relative; // Ship-relative aim angle (radians)

    uint8_t company_id;            // Inherited from the ship this player boards

    // Inventory
    PlayerInventory inventory;
} WebSocketPlayer;

struct WebSocketStats {
    int connected_clients;
    uint64_t packets_sent;
    uint64_t packets_received;
    uint64_t input_messages_received;
    uint64_t unknown_messages_received;
    uint32_t last_input_time;
    uint32_t last_unknown_time;
    uint16_t port;
};

/**
 * Initialize WebSocket server for browser clients
 * @param port Port to listen on (e.g., 8082 for browser clients)
 * @return 0 on success, -1 on error
 */
int websocket_server_init(uint16_t port);

/**
 * Set the simulation context for player collision detection
 * @param sim Simulation context
 */
void websocket_server_set_simulation(struct Sim* sim);

/**
 * Clean up WebSocket server and close all connections
 */
void websocket_server_cleanup(void);

/**
 * Update WebSocket server (handle connections, messages)
 * Should be called from main server loop
 * @param sim Simulation context for game state
 * @return 0 on success, -1 on error
 */
int websocket_server_update(struct Sim* sim);

/**
 * Apply movement state to all players (HYBRID approach)
 * Should be called every server tick (30Hz)
 * @param dt Delta time in seconds (typically 0.033)
 */
void websocket_server_tick(float dt);

/**
 * Broadcast message to all connected WebSocket clients
 * @param message Message to broadcast (will be framed as WebSocket text)
 */
void websocket_server_broadcast(const char* message);

/**
 * Get WebSocket server statistics
 * @param stats Output structure for statistics
 * @return 0 on success, -1 on error
 */
int websocket_server_get_stats(struct WebSocketStats* stats);

/**
 * Get WebSocket ships data for admin panel
 * @param out_ships Pointer to receive ships array
 * @param out_count Pointer to receive ship count
 * @return 0 on success, -1 on error
 */
int websocket_server_get_ships(SimpleShip** out_ships, int* out_count);

/**
 * Create an NPC agent and mount it to a module on a ship.
 * @param ship_id   Ship the NPC belongs to
 * @param module_id Module to mount (cannon, mast, helm)
 * @param role      NPC_ROLE_GUNNER / NPC_ROLE_HELMSMAN / NPC_ROLE_RIGGER
 * @return NPC ID on success, 0 on failure
 */
uint32_t websocket_server_create_npc(uint32_t ship_id, uint32_t module_id, NpcRole role);

/**
 * Remove an NPC agent by ID.
 */
void websocket_server_remove_npc(uint32_t npc_id);

/**
 * Set the target ship for a gunner or helmsman NPC.
 */
void websocket_server_npc_set_target(uint32_t npc_id, uint32_t target_ship_id);


/**
 * Get WebSocket players data for admin panel
 * @param out_players Pointer to receive players array
 * @param out_count Pointer to receive active player count
 * @return 0 on success, -1 on error
 */
int websocket_server_get_players(WebSocketPlayer** out_players, int* out_count);