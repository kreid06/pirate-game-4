#pragma once

#include "sim/types.h"
#include "sim/module_ids.h"
#include <stdint.h>
#include <stdbool.h>

// ── Company / Alliance system ─────────────────────────────────────────────
// A company groups ships, players, and NPCs into a faction.
// Two companies that share an alliance_id are friendly to each other;
// entities of different companies are hostile.
#define COMPANY_UNCLAIMED 0  // No owner — ship/NPC has no faction
#define COMPANY_NEUTRAL   0  // Alias for COMPANY_UNCLAIMED (backward compat)
#define COMPANY_SOLO      1  // Player-owned, no guild affiliation
#define COMPANY_PIRATES   2  // Pirates guild faction
#define COMPANY_NAVY      3  // Navy faction — enemy AI
#define COMPANY_GHOST    99  // Phantom Brig faction — hostile to all
#define MAX_COMPANIES     4  // Total number of distinct built-in company slots (0–3)
#define COMPANY_DYNAMIC_BASE 100  // Player-created companies start here

#define MAX_DYNAMIC_COMPANIES 64  // Max number of player-created companies

/** A player-created company (id >= COMPANY_DYNAMIC_BASE). */
typedef struct {
    uint32_t id;              // Unique company ID (>= COMPANY_DYNAMIC_BASE)
    char     name[32];        // Display name chosen by founder
    uint32_t founder_id;      // player_id of the founding player
    bool     active;
} DynamicCompany;

// ── Ship type identifiers ─────────────────────────────────────────────────
#define SHIP_TYPE_SLOOP      1   // Small, fast sloop
#define SHIP_TYPE_CUTTER     2   // Light cutter
#define SHIP_TYPE_BRIGANTINE 3   // Medium brigantine (default)
#define SHIP_TYPE_GHOST      99  // Ghostship — autonomous enemy, spectral visual

// ── Weapon Control Groups ────────────────────────────────────────────────────
typedef enum {
    WEAPON_GROUP_MODE_AIMING     = 0,
    WEAPON_GROUP_MODE_FREEFIRE   = 1,
    WEAPON_GROUP_MODE_HALTFIRE   = 2,
    WEAPON_GROUP_MODE_TARGETFIRE = 3,
} WeaponGroupMode;

#define MAX_WEAPON_GROUPS      10
#define MAX_WEAPONS_PER_GROUP  16

typedef struct {
    module_id_t     weapon_ids[MAX_WEAPONS_PER_GROUP]; /* module_id_t = MID(ship_seq, offset) */
    uint8_t         weapon_count;
    uint8_t         mode;             /* WeaponGroupMode enum value */
    uint16_t        target_ship_id;
} WeaponGroup;
// ────────────────────────────────────────────────────────────────────────────

// Simple ship structure for WebSocket server
typedef struct SimpleShip {
    uint16_t ship_id;
    uint8_t  ship_seq;        /* 8-bit sequence number — top byte of all module IDs.
                               * module_id = MID(ship_seq, offset) = (ship_seq<<8)|offset
                               * See server/include/sim/module_ids.h for offset table. */
    uint8_t  ship_type;      // Ship type ID (1=sloop, 2=cutter, 3=brigantine, etc.)
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
    float   desired_sail_angle;     // Target sail angle in radians (clamped ±60°)

    // Ship-level ammunition (shared pool for all cannons)
    uint16_t cannon_ammo;    // Remaining cannonballs (unused when infinite_ammo is true)
    bool infinite_ammo;      // When true, cannons never consume ammo

    // Crew AI — last aim angle (ship-local radians) used to compute sector of fire
    float active_aim_angle; // drives update_npc_cannon_sector(); default 0 = forward

    uint8_t company_id;      // COMPANY_* — which faction owns this ship

    // Ship modules (cannons, masts, helm, seats, etc.)
    ShipModule modules[MAX_MODULES_PER_SHIP];
    uint8_t module_count;
    /** Wall-clock time (ms) when each cannon module last fired.
     *  Indexed by the module's position in modules[] (0-based).
     *  0 = never fired (treated as "fresh" — crew stays without penalty).
     *  Updated by fire_cannon(); used by is_cannon_stale() to decide if
     *  crew are allowed to leave for a busier cannon. */
    uint32_t cannon_last_fire_ms[MAX_MODULES_PER_SHIP];
    /** Wall-clock time (ms) when each cannon was last "needed" (aimed-in-sector
     *  or fired).  NEEDED stays true until this timestamp + CANNON_NEEDED_TIMEOUT_MS
     *  expires.  Cleared by tick_cannon_needed_expiry(). */
    uint32_t cannon_last_needed_ms[MAX_MODULES_PER_SHIP];
    /* Per-ship weapon control groups — isolated per company so that enemy
     * boarders cannot read or sabotage the original crew's group config.
     * Index 0 = COMPANY_UNCLAIMED, 1 = COMPANY_SOLO, 2 = COMPANY_PIRATES, 3 = COMPANY_NAVY.
     * NPC/tick code always accesses [ship->company_id]; player config
     * writes to [player->company_id]. */
    WeaponGroup weapon_groups[MAX_COMPANIES][MAX_WEAPON_GROUPS];

    /* Sinking state — entered when hull_health hits 0; ship stays alive for SHIP_SINK_DURATION_MS */
    bool     is_sinking;
    uint32_t sink_start_ms;

    /* Reverse thrust — set when the helmsman holds S; propels the ship slowly backward */
    bool reverse_thrust;

    /* Display name — set by the owning player; broadcast to all clients */
    char ship_name[32];
} SimpleShip;

// NPC behavior types
typedef enum {
    NPC_ROLE_NONE      = 0,
    NPC_ROLE_GUNNER    = 1,  // Mans a cannon: aims at enemy ship and fires
    NPC_ROLE_HELMSMAN  = 2,  // Controls the helm: steers toward/away from target
    NPC_ROLE_RIGGER    = 3,  // Manages a mast: sets sail openness based on orders
    NPC_ROLE_REPAIRER  = 4,  // Seeks damaged modules and repairs them
} NpcRole;

// NPC agent — server-side autonomous crew member mounted to a module
typedef struct NpcAgent {
    uint16_t    npc_id;          // Unique NPC ID (starts at 5000)
    uint16_t    ship_id;          // Ship this NPC belongs to
    module_id_t module_id;        // Module this NPC is mounted to (0 = unmounted)
    NpcRole  role;               // What this NPC does each tick
    bool     active;

    // Gunner state
    uint16_t target_ship_id;     // Enemy ship to aim at (0 = no target)
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
    WORLD_NPC_STATE_AT_GUN = 2, // Arrived — ready to fire
    WORLD_NPC_STATE_REPAIRING = 3, // Arrived at a damaged module and actively repairing it
} WorldNpcState;

typedef struct WorldNpc {
    uint16_t      id;
    char          name[32];
    bool          active;
    NpcRole       role;          // NPC_ROLE_GUNNER (cannon) or NPC_ROLE_RIGGER (sail)

    // World position (client units, updated and broadcast every tick)
    float         x, y;
    float         rotation;

    // Ship attachment
    uint16_t      ship_id;         // 0 = free-standing
    float         local_x, local_y; // Ship-local position in CLIENT units

    // Module associations
    // Rigger: port_cannon_id = mast module ID (starboard_cannon_id mirrors it).
    // Gunner: port_cannon_id = future locked-cannon preference (0 = any; player-set later).
    module_id_t   port_cannon_id;       /* Rigger: mast ID.  Gunner: locked preference (0=free) */
    module_id_t   starboard_cannon_id;  /* Rigger: mast ID (mirrors port).  Gunner: unused (0) */
    module_id_t   assigned_weapon_id;   /* Module the NPC is currently heading to / stationed at */
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
    uint32_t      owner_player_id; // For COMPANY_SOLO NPCs: the player who recruited/owns them (0 = none)

    // Knockback velocity (client units/s, decays each tick)
    float         velocity_x, velocity_y;

    // ── Crew levelling ───────────────────────────────────────────────────────
    uint8_t       npc_level;      // 1–10
    uint16_t      health;         // current HP
    uint16_t      max_health;     // base 100 + stat_health * 20
    uint32_t      xp;             // accumulated experience
    // Stat upgrade levels (0 = unupgraded, max 5 each)
    uint8_t       stat_health;    // +20 max HP per level
    uint8_t       stat_damage;    // +10% damage per level
    uint8_t       stat_stamina;   // +10% reload/work speed per level
    uint8_t       stat_weight;    // +10% carry capacity per level

    // ── Status effects ──────────────────────────────────────────────────────
    uint32_t      fire_timer_ms;  // >0 = burning; auto-extinguishes at 0
    bool          in_water;       // true when NPC has been knocked off the ship deck

    // ── Task lock ───────────────────────────────────────────────────────────
    bool          task_locked;    // When true: player has pinned this NPC to their current module;
                                  // rejected by handle_crew_assign & auto cannon-sector dispatch.

    // ── Boarding approach ──────────────────────────────────────────────────
    // When boarding_ship_id != 0 the NPC is swimming (ship_id == 0) toward a hull
    // entry point.  On arrival it snaps aboard and walks to (boarding_local_x/y).
    uint16_t      boarding_ship_id;  // target ship to board; 0 = not boarding
    float         boarding_local_x;  // on-deck destination (ship-local) after boarding
    float         boarding_local_y;

    // ── Repairer idle dwell timer ───────────────────────────────────────
    // When > 0, NPC is dwelling at a roam module; counts down in ms per tick.
    // Cleared to 0 when any module on the ship takes damage.
    uint32_t      roam_wait_ms;
} WorldNpc;
// ────────────────────────────────────────────────────────────────────────────

// ── Player Inventory ────────────────────────────────────────────────────────
#define INVENTORY_SLOTS 58   /* total regular inventory slots per player      */
#define HOTBAR_SLOTS    10   /* first HOTBAR_SLOTS of slots[] shown on hotbar */

typedef enum {
    ITEM_NONE          = 0,
    ITEM_PLANK         = 1,
    ITEM_REPAIR_KIT    = 2,
    ITEM_CANNON_BALL   = 3,
    ITEM_CANNON        = 7,
    ITEM_SAIL          = 8,
    ITEM_HELM          = 9,
    ITEM_SWORD         = 4,
    ITEM_PISTOL        = 5,
    ITEM_HAMMER        = 6,
    ITEM_CLOTH_ARMOR   = 10,
    ITEM_LEATHER_ARMOR = 11,
    ITEM_IRON_ARMOR    = 12,
    ITEM_WOODEN_SHIELD = 20,
    ITEM_IRON_SHIELD   = 21,
    ITEM_DECK          = 13,
    ITEM_SWIVEL        = 14,
    ITEM_AXE           = 15,
    ITEM_WOODEN_FLOOR  = 16,
    ITEM_WORKBENCH     = 17,
    ITEM_WALL          = 18,
    ITEM_DOOR_FRAME    = 19,
    ITEM_DOOR          = 20,
    ITEM_WOOD          = 22,
    ITEM_FIBER         = 23,
    ITEM_METAL         = 24,
    ITEM_PICKAXE       = 25,
    ITEM_SHIPYARD      = 26,
    ITEM_STONE         = 27,
    ITEM_WOOD_CEILING  = 28,
    ITEM_CLAIM_FLAG    = 29,  /* Claiming flag — plant on an enemy ship to capture it */
} ItemKind;

/* ── Ship Claiming Flag ────────────────────────────────────────────────────── */
#define FLAG_CLAIM_DURATION_MS    300000u  /* 5 minutes to capture (300 s) */
#define FLAG_REVERSE_SPEED         10.0f   /* Countdown reverses 10x speed when contested */
#define MAX_CLAIM_FLAGS            16      /* Max simultaneous flags across all ships */

typedef struct {
    bool     active;
    uint16_t ship_id;           /* Target ship being claimed */
    uint32_t planter_id;        /* Player who planted the flag */
    uint8_t  planter_company;   /* Company that will gain the ship on capture */
    float    progress_ms;       /* 0 = just planted, FLAG_CLAIM_DURATION_MS = claimed */
    bool     contested;         /* true = enemy players/NPCs on deck — timer reverses */
    float    local_x, local_y;  /* Ship-local position of the flag pole */
} ClaimFlag;

extern ClaimFlag claim_flags[MAX_CLAIM_FLAGS];
extern int       claim_flag_count;

/* ── Island structures ────────────────────────────────────────────────────── */
typedef enum {
    STRUCT_WOODEN_FLOOR = 0,
    STRUCT_WORKBENCH    = 1,
    STRUCT_WALL         = 2,
    STRUCT_DOOR_FRAME   = 3,  /* posts with open centre, always passable */
    STRUCT_DOOR         = 4,  /* panel that snaps onto a door frame */
    STRUCT_SHIPYARD     = 5,  /* placed in shallow water near island — used to build ships */
    STRUCT_WRECK        = 6,  /* spawns at sea when a ship sinks — can be salvaged */
    STRUCT_CEILING      = 7,  /* wood ceiling tile — requires a wall or adjacent ceiling */
} PlacedStructureType;

/** Shallow-water ring width as a multiple of the island's own radius.
 *  e.g. 1.5 → a 185 px beach island gets ~278 px of shallow water. */

typedef enum {
    CONSTRUCTION_EMPTY    = 0,  /* no ship under construction */
    CONSTRUCTION_BUILDING = 1,  /* skeleton laid; modules can be installed */
} ShipConstructionPhase;

/* Bitmask values for PlacedStructure.modules_placed — defined in sim/types.h */

typedef struct {
    /* 4-byte aligned fields first */
    uint32_t placer_id;           /* player_id who built this — used for company promotion */
    float    x, y;                /* world position */
    float    rotation;            /* degrees — 0 = no rotation; only meaningful for floor/workbench */
    /* enum fields (int-sized = 4 bytes each) */
    PlacedStructureType   type;
    ShipConstructionPhase construction_phase; /* Shipyard-only; zero for all other types */
    /* 2-byte fields */
    uint16_t id;                  /* unique structure ID (max MAX_PLACED_STRUCTURES=512) */
    uint16_t hp;                  /* current hit points */
    uint16_t max_hp;              /* maximum hit points */
    uint16_t scaffolded_ship_id;  /* ship_id attached to this shipyard (0 = none) */
    /* 1-byte fields */
    uint8_t  island_id;           /* which island this structure is on (ISLAND_COUNT=2) */
    uint8_t  company_id;          /* COMPANY_* — faction that owns this structure */
    uint8_t  modules_placed;      /* bitmask of MODULE_* bits (legacy) */
    uint8_t  construction_company; /* company that owns the ship being built */
    /* bool fields */
    bool     active;
    bool     open;                /* doors only: true = open (passable) */
    /* Wreck-only salvage loot (STRUCT_WRECK); unused for other types */
    uint8_t  wreck_items[6];     /* ItemKind as uint8_t, 0 = empty slot   */
    uint8_t  wreck_qtys[6];      /* quantity per loot slot                */
    uint8_t  wreck_loot_count;   /* number of remaining non-empty slots   */
    uint32_t wreck_expires_ms;   /* wall-clock ms for auto-despawn; 0 = persist */
    /* 64-byte string last (avoids breaking alignment of above) */
    char     placer_name[64];     /* display name of builder */
} PlacedStructure;

#define MAX_PLACED_STRUCTURES 512

typedef struct {
    ItemKind item;
    uint8_t  quantity; // 0 = empty; 1 for weapons/tools; 1-99 for stackables
} InventorySlot;

/** Equipment worn by a player — one item per body slot. */
typedef struct {
    ItemKind helm;    /* head armour            */
    ItemKind torso;   /* chest armour           */
    ItemKind legs;    /* leg armour             */
    ItemKind feet;    /* boot armour            */
    ItemKind hands;   /* glove armour           */
    ItemKind shield;  /* off-hand shield        */
} PlayerEquipment;

typedef struct {
    InventorySlot   slots[INVENTORY_SLOTS]; /* regular bag slots 0..57       */
    PlayerEquipment equipment;              /* 6 body-slot items             */
    uint8_t         active_slot;            /* hotbar selection 0-9; 255=off */
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
    entity_id sim_entity_id;     // Simulation entity ID (e.g., 1, 2, 3)
    char name[64];
    float x, y;
    float velocity_x, velocity_y;
    float rotation;
    
    // Hybrid input system - movement state (persistent)
    float movement_direction_x;  // -1.0 to 1.0 (normalized)
    float movement_direction_y;  // -1.0 to 1.0 (normalized)
    bool is_moving;              // true if actively moving
    bool is_sprinting;           // true if Shift+W sprint is active (land/deck only)
    
    // Rotation tracking for interpolation
    float last_rotation;         // Previous rotation value
    uint32_t last_rotation_update_time;
    
    uint16_t parent_ship_id;
    float local_x, local_y;
    PlayerMovementState movement_state;
    uint32_t last_input_time;
    bool active;
    
    // Module interaction state
    bool is_mounted;               // Is player mounted to a module
    module_id_t mounted_module_id; /* ID of mounted module — MID(ship_seq, offset); 0 if not mounted */
    uint16_t controlling_ship_id;  // ID of ship being controlled (helm only, 0 if not controlling)
    
    // Cannon aiming state
    float cannon_aim_angle;        // World coordinates aim angle (radians)
    float cannon_aim_angle_relative; // Ship-relative aim angle (radians)

    uint8_t company_id;            // Inherited from the ship this player boards

    // Health
    uint16_t health;             // Current HP (0 = dead)
    uint16_t max_health;         // Max HP (default 100)

    // Stamina pool — drained by sprinting, attacking, and harvesting; regens when idle
    uint16_t stamina;            // Current stamina (0–max_stamina)
    uint16_t max_stamina;        // Max stamina (base 100 + 10 * stat_stamina)
    uint32_t stamina_last_used_ms; // Wall-clock ms of last stamina drain (regen delayed 2 s after)

    // Player XP / levelling (mirrors WorldNpc system)
    uint8_t  player_level;       // 1–120
    uint32_t player_xp;          // accumulated XP
    uint8_t  stat_health;        // health stat points spent
    uint8_t  stat_damage;        // damage stat points spent
    uint8_t  stat_stamina;       // stamina stat points spent
    uint8_t  stat_weight;        // weight stat points spent

    // Melee combat
    uint32_t sword_last_attack_ms; // Wall-clock ms of last sword swing (0 = never)

    // Inventory
    PlayerInventory inventory;

    // Status effects
    uint32_t fire_timer_ms;  // >0 = burning; auto-extinguishes at 0

    /* Island walking — 0 = in water, >0 = on island with that id */
    uint32_t on_island_id;
    /* Dock walking — 0 = not on shipyard dock, >0 = structure id of the dock */
    uint32_t on_dock_id;
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
 * Create a new brigantine ship at runtime (e.g. from admin panel).
 * Registers both the SimpleShip layout and its physics counterpart in the sim.
 * @param x  World X position in client pixels
 * @param y  World Y position in client pixels
 * @param company_id  COMPANY_* constant (COMPANY_PIRATES, COMPANY_NAVY, etc.)
 * @return Entity ID of the new ship, or 0 on failure
 */
uint32_t websocket_server_create_ship(float x, float y, uint8_t company_id, uint8_t modules_placed);

/**
 * Spawn a ghost ship at the given world position (client pixels).
 * Ghost ships (SHIP_TYPE_GHOST) are autonomous enemy vessels with spectral
 * visuals.  They use COMPANY_NAVY (hostile to pirates) and their cannons are
 * configured for TARGETFIRE automatically.
 * @param x  World X position in client pixels
 * @param y  World Y position in client pixels
 * @return Entity ID of the new ghost ship, or 0 on failure
 */
uint32_t websocket_server_create_ghost_ship(float x, float y);

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
uint16_t websocket_server_create_npc(uint16_t ship_id, module_id_t module_id, NpcRole role);

/**
 * Remove an NPC agent by ID.
 */
void websocket_server_remove_npc(uint16_t npc_id);

/**
 * Set the target ship for a gunner or helmsman NPC.
 */
void websocket_server_npc_set_target(uint16_t npc_id, uint16_t target_ship_id);


/**
 * Get WebSocket players data for admin panel
 * @param out_players Pointer to receive players array
 * @param out_count Pointer to receive active player count
 * @return 0 on success, -1 on error
 */
int websocket_server_get_players(WebSocketPlayer** out_players, int* out_count);
/** Set the company of a connected player (admin use). Returns 0 on success, -1 if not found. */
int websocket_server_set_player_company(uint32_t player_id, uint8_t company_id);

/**
 * Get placed structures array for admin panel.
 * @param out_structs  Pointer to receive the array pointer
 * @param out_count    Pointer to receive the number of used slots (including inactive)
 * @return 0 on success, -1 on error
 */
int websocket_server_get_placed_structures(PlacedStructure **out_structs, uint32_t *out_count);