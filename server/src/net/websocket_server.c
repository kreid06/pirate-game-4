#include "net/websocket_server.h"
#include "net/websocket_server_internal.h"
#include "sim/ship_level.h"
#include "sim/island.h"
#include "net/websocket_protocol.h"
#include "net/network.h"
#include "sim/simulation.h"
#include "core/math.h"
#include "util/log.h"
#include "util/time.h"
#include <string.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#define _USE_MATH_DEFINES
#include <math.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <openssl/sha.h>
#include <openssl/evp.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <openssl/hmac.h>
#include <stdlib.h>
#include <sys/stat.h>

// Include shared ship definitions from protocol folder
#include "../../protocol/ship_definitions.h"

// Define M_PI if not available
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// WebSocket magic key for handshake
#define WS_MAGIC_KEY "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define WS_MAX_CLIENTS 100

// ── JWT helpers ───────────────────────────────────────────────────────────────
#include "net/websocket_auth.h"

// WebSocket opcodes
#define WS_OPCODE_CONTINUATION 0x0
#define WS_OPCODE_TEXT 0x1
#define WS_OPCODE_BINARY 0x2
#define WS_OPCODE_CLOSE 0x8
#define WS_OPCODE_PING 0x9
#define WS_OPCODE_PONG 0xA

// Simple player data structure for movement
// (Definition in websocket_server.h)

/* struct WebSocketClient and struct WebSocketServer are defined in
 * websocket_server_internal.h (pulled in via module_interactions.h). */

struct WebSocketServer ws_server = {0};

// Global simulation pointer for player collision detection
struct Sim* global_sim = NULL;

// ── Company / Alliance registry ───────────────────────────────────────────
typedef struct { uint8_t id; const char* name; uint8_t alliance_id; } Company;
static const Company g_companies[] = {
    { COMPANY_NEUTRAL, "Neutral", 0 },
    { COMPANY_PIRATES, "Pirates", 1 },
    { COMPANY_NAVY,    "Navy",    2 },
};
// Returns true if companies a and b are in the same non-zero alliance (i.e. friendly).
bool is_allied(uint8_t a, uint8_t b) {
    if (a == COMPANY_NEUTRAL || b == COMPANY_NEUTRAL) return false;
    if (a == b) return true;
    uint8_t a_al = 0, b_al = 0;
    for (int i = 0; i < 3; i++) {
        if (g_companies[i].id == a) a_al = g_companies[i].alliance_id;
        if (g_companies[i].id == b) b_al = g_companies[i].alliance_id;
    }
    return a_al != 0 && a_al == b_al;
}
static const char* company_name(uint8_t id) {
    for (int i = 0; i < 3; i++)
        if (g_companies[i].id == id) return g_companies[i].name;
    return "Unknown";
}

/* Strip bytes outside ASCII printable range (0x20–0x7E) from a player name.
 * This prevents invalid UTF-8 sequences entering the JSON broadcast when the
 * name is truncated or originates from a file saved with a different encoding. */
static void sanitize_player_name(char* name) {
    unsigned char* r = (unsigned char*)name;
    char* w = name;
    while (*r) {
        if (*r >= 0x20u && *r < 0x7Fu)
            *w++ = (char)*r;
        r++;
    }
    *w = '\0';
}

// Helper function to get movement state string
static const char* get_state_string(PlayerMovementState state) {
    switch (state) {
        case PLAYER_STATE_WALKING: return "WALKING";
        case PLAYER_STATE_SWIMMING: return "SWIMMING";
        case PLAYER_STATE_FALLING: return "FALLING";
        default: return "UNKNOWN";
    }
}

// Global player data for simple movement tracking
WebSocketPlayer players[WS_MAX_CLIENTS] = {0};
int next_player_id = 1000;

// NPC agents
NpcAgent npc_agents[MAX_NPC_AGENTS] = {0};
int npc_count = 0;
uint16_t next_npc_id = 5000;

// World NPCs (visible, interactable entities)
WorldNpc world_npcs[MAX_WORLD_NPCS] = {0};
int world_npc_count = 0;
uint16_t next_world_npc_id = 9000;
bool g_npcs_dirty = true; // set whenever NPC state changes; cleared after JSON rebuild

// Global ship data (simple ships for testing)
#define MAX_SIMPLE_SHIPS 50
SimpleShip ships[MAX_SIMPLE_SHIPS] = {0};
int ship_count = 0;
/* 8-bit ship sequence counter — top byte of all module IDs (see module_ids.h).
 * Also used as ship_id on a single server: ship_id = ship_seq.
 * On a multi-server cluster, ship_id will widen to (server_id<<8)|ship_seq;
 * ship_seq stays frozen as the module namespace byte in both cases.
 * Starts at 1; wraps to 1 after 255 (0 is MODULE_ID_INVALID's ship). */
uint8_t next_ship_seq = 1;

// ── Island placed structures ─────────────────────────────────────────────────
PlacedStructure placed_structures[MAX_PLACED_STRUCTURES];
uint32_t placed_structure_count = 0;
uint16_t next_structure_id = 1;

// ── Tombstone item caches (dropped on player death) ──────────────────────────
#define MAX_TOMBSTONES    64u
#define TOMBSTONE_TTL_MS  900000u   /* 15 minutes */

typedef struct {
    uint32_t        id;
    float           x, y;
    char            owner_name[64];
    PlayerInventory inventory;      /* full copy of player inventory at time of death */
    uint32_t        spawn_time_ms;
    bool            active;
} Tombstone;

static Tombstone tombstones[MAX_TOMBSTONES];
static uint32_t  next_tombstone_id = 1;

// ── Dropped items (manually dropped by players) ──────────────────────────────
#define MAX_DROPPED_ITEMS  256u
#define DROPPED_ITEM_TTL_MS 300000u  /* 5 minutes */

typedef struct {
    uint32_t id;
    uint8_t  item_kind;   /* ItemKind value */
    uint8_t  quantity;
    float    x, y;
    uint32_t spawn_time_ms;
    bool     active;
} DroppedItem;

static DroppedItem dropped_items[MAX_DROPPED_ITEMS];
static uint32_t    next_dropped_item_id = 1;

int websocket_server_get_placed_structures(PlacedStructure **out_structs, uint32_t *out_count) {
    if (!out_structs || !out_count) return -1;
    *out_structs = placed_structures;
    *out_count   = placed_structure_count;
    return 0;
}

// ── O(1) ship lookup ────────────────────────────────────────────────────────
// Ship IDs are derived from ship_seq (same value on a single server).
// ship_seq is the module-ID namespace byte; ship_id is the routable address.
// On a multi-server cluster ship_id will widen to (server_id<<8)|ship_seq;
// ship_seq always remains extractable as ship_id & 0xFF.
#define SHIP_ID_LOOKUP_SIZE 512
static SimpleShip* g_ship_by_id[SHIP_ID_LOOKUP_SIZE]; // zero-initialised by C

SimpleShip* find_ship(uint16_t ship_id) {
    if (ship_id > 0 && ship_id < SHIP_ID_LOOKUP_SIZE) {
        SimpleShip* cached = g_ship_by_id[ship_id];
        if (cached && cached->active && cached->ship_id == ship_id) return cached;
    }
    for (int i = 0; i < ship_count; i++) {
        if (ships[i].active && ships[i].ship_id == ship_id) {
            if (ship_id < SHIP_ID_LOOKUP_SIZE) g_ship_by_id[ship_id] = &ships[i];
            return &ships[i];
        }
    }
    return NULL;
}

// Coordinate conversion helpers
void ship_local_to_world(const SimpleShip* ship, float local_x, float local_y, float* world_x, float* world_y) {
    float cos_r = cosf(ship->rotation);
    float sin_r = sinf(ship->rotation);
    *world_x = ship->x + (local_x * cos_r - local_y * sin_r);
    *world_y = ship->y + (local_x * sin_r + local_y * cos_r);
}

// Update world positions of all players mounted to this ship
static void update_mounted_players_on_ship(uint16_t ship_id) {
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) return;
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].is_mounted && players[i].parent_ship_id == ship_id) {
            // Update player's world position based on their local position and ship transform
            ship_local_to_world(ship, players[i].local_x, players[i].local_y, 
                              &players[i].x, &players[i].y);
        }
    }
}

// ── O(1) simulation-ship lookup ─────────────────────────────────────────────
// Declared early so sync_simple_ships_from_simulation can use it.
// Full definition lives after find_ship_by_id (below).
#define SIM_SHIP_ID_SIZE 512
static struct Ship* g_sim_ship_by_id[SIM_SHIP_ID_SIZE]; // zero-init by C
struct Ship* find_sim_ship(uint32_t id);          // forward declaration

// ── find_sim_ship definition ─────────────────────────────────────────────────
struct Ship* find_sim_ship(uint32_t id) {
    if (id > 0 && id < SIM_SHIP_ID_SIZE) {
        struct Ship* cached = g_sim_ship_by_id[id];
        if (cached && (uint32_t)cached->id == id) return cached;
    }
    if (!global_sim) return NULL;
    for (uint32_t i = 0; i < global_sim->ship_count; i++) {
        if ((uint32_t)global_sim->ships[i].id == id) {
            if (id < SIM_SHIP_ID_SIZE) g_sim_ship_by_id[id] = &global_sim->ships[i];
            return &global_sim->ships[i];
        }
    }
    return NULL;
}

// Sync SimpleShip state from simulation ships (position, rotation, velocity)
static void sync_simple_ships_from_simulation(void) {
    if (!global_sim || global_sim->ship_count == 0) return;

    // Rebuild sim-ship cache once per tick so all subsequent callers get O(1) lookups.
    memset(g_sim_ship_by_id, 0, sizeof(g_sim_ship_by_id));
    for (uint32_t ci = 0; ci < global_sim->ship_count; ci++) {
        uint32_t sid = (uint32_t)global_sim->ships[ci].id;
        if (sid > 0 && sid < SIM_SHIP_ID_SIZE)
            g_sim_ship_by_id[sid] = &global_sim->ships[ci];
    }

    // ── Pin scaffolded ships to their shipyard before syncing ──────────────
    // For every active shipyard that has a scaffolded_ship_id, snap the sim
    // ship's position/rotation to the dock center and zero its velocities so
    // it never drifts away during construction.
    for (int pi = 0; pi < MAX_PLACED_STRUCTURES; pi++) {
        PlacedStructure* sy = &placed_structures[pi];
        if (!sy->active) continue;
        if (sy->type != STRUCT_SHIPYARD) continue;
        if (sy->scaffolded_ship_id == 0) continue;

        struct Ship* sim_ship = find_sim_ship(sy->scaffolded_ship_id);
        if (!sim_ship) continue;

        // Dock rotation: degrees → radians; add π/2 so the ship bow (+X) faces
        // the dock mouth (+Y direction in the dock's local frame).
        float dock_rot_rad = sy->rotation * (float)M_PI / 180.0f + (float)(M_PI / 2.0);

        sim_ship->position.x     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(sy->x));
        sim_ship->position.y     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(sy->y));
        sim_ship->rotation       = Q16_FROM_FLOAT(dock_rot_rad);
        sim_ship->velocity.x     = 0;
        sim_ship->velocity.y     = 0;
        sim_ship->angular_velocity = 0;
    }

    for (int s = 0; s < ship_count; s++) {
        if (!ships[s].active) continue;
        struct Ship* sim_ship = find_sim_ship(ships[s].ship_id);
        if (!sim_ship) continue;

        // Sync position, rotation, velocity from simulation to SimpleShip
        ships[s].x              = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->position.x));
        ships[s].y              = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->position.y));
        ships[s].rotation       = Q16_TO_FLOAT(sim_ship->rotation);
        ships[s].velocity_x     = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->velocity.x));
        ships[s].velocity_y     = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_ship->velocity.y));
        ships[s].angular_velocity = Q16_TO_FLOAT(sim_ship->angular_velocity);
        // Propagate company to sim layer for projectile friendly-fire checks
        sim_ship->company_id    = ships[s].company_id;

        // Update mounted players' world positions with new ship transform
        update_mounted_players_on_ship(ships[s].ship_id);
    }
    /* NOTE: handle_ship_dock_collisions() is intentionally NOT called here.
     * It must run AFTER the wind/rudder block in websocket_server_tick so the
     * dock angular-velocity constraint is not overwritten by the rudder setter. */
}

__attribute__((unused))
static void ship_clamp_to_deck(const SimpleShip* ship, float* local_x, float* local_y) {
    if (*local_x < ship->deck_min_x) *local_x = ship->deck_min_x;
    if (*local_x > ship->deck_max_x) *local_x = ship->deck_max_x;
    if (*local_y < ship->deck_min_y) *local_y = ship->deck_min_y;
    if (*local_y > ship->deck_max_y) *local_y = ship->deck_max_y;
}

// Helper to convert world coordinates to ship-local coordinates
__attribute__((unused))
void ship_world_to_local(const SimpleShip* ship, float world_x, float world_y, float* local_x, float* local_y) {
    float dx = world_x - ship->x;
    float dy = world_y - ship->y;
    float cos_r = cosf(-ship->rotation);
    float sin_r = sinf(-ship->rotation);
    *local_x = dx * cos_r - dy * sin_r;
    *local_y = dx * sin_r + dy * cos_r;
}

// Helper: minimum distance from a local point (server float units) to the nearest hull edge segment.
static float swivel_dist_to_hull_edge(float sx, float sy, const struct Ship* ship) {
    float min_dist_sq = 1e20f;
    uint8_t n = ship->hull_vertex_count;
    for (uint8_t i = 0; i < n; i++) {
        uint8_t j = (i + 1) % n;
        float ax = Q16_TO_FLOAT(ship->hull_vertices[i].x);
        float ay = Q16_TO_FLOAT(ship->hull_vertices[i].y);
        float bx = Q16_TO_FLOAT(ship->hull_vertices[j].x);
        float by = Q16_TO_FLOAT(ship->hull_vertices[j].y);
        float dx = bx - ax, dy = by - ay;
        float len_sq = dx*dx + dy*dy;
        float t = 0.0f;
        if (len_sq > 1e-10f) {
            t = ((sx-ax)*dx + (sy-ay)*dy) / len_sq;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
        }
        float cx = ax + t*dx, cy = ay + t*dy;
        float ex = sx - cx, ey = sy - cy;
        float d = ex*ex + ey*ey;
        if (d < min_dist_sq) min_dist_sq = d;
    }
    return sqrtf(min_dist_sq);
}

// Helper to check if player is outside hull polygon (using simulation ship hull)
bool is_outside_deck(uint16_t ship_id, float local_x, float local_y) {
    struct Ship* sim_ship = find_sim_ship(ship_id);
    if (!sim_ship || sim_ship->hull_vertex_count < 3) return false;

    // Fast AABB pre-check: hull fits within ±300 × ±100 server units for a brigantine.
    // Convert client local coords to server units for the comparison.
    float sx = CLIENT_TO_SERVER(local_x);
    float sy = CLIENT_TO_SERVER(local_y);
    // Compute hull AABB.
    float hmin_x = Q16_TO_FLOAT(sim_ship->hull_vertices[0].x);
    float hmax_x = hmin_x;
    float hmin_y = Q16_TO_FLOAT(sim_ship->hull_vertices[0].y);
    float hmax_y = hmin_y;
    for (uint8_t _v = 1; _v < sim_ship->hull_vertex_count; _v++) {
        float vx = Q16_TO_FLOAT(sim_ship->hull_vertices[_v].x);
        float vy = Q16_TO_FLOAT(sim_ship->hull_vertices[_v].y);
        if (vx < hmin_x) hmin_x = vx; if (vx > hmax_x) hmax_x = vx;
        if (vy < hmin_y) hmin_y = vy; if (vy > hmax_y) hmax_y = vy;
    }
    if (sx < hmin_x || sx > hmax_x || sy < hmin_y || sy > hmax_y) return true; // clearly outside
    
    // Convert client local coordinates to server coordinates for comparison
    Vec2Q16 point = {
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x)),
        Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y))
    };
    
    // Point-in-polygon test using ray casting algorithm
    bool inside = false;
    uint8_t vertex_count = sim_ship->hull_vertex_count;
    
    for (uint8_t i = 0, j = vertex_count - 1; i < vertex_count; j = i++) {
        Vec2Q16 vi = sim_ship->hull_vertices[i];
        Vec2Q16 vj = sim_ship->hull_vertices[j];
        
        // Check if point is between the y-coordinates of the edge
        if (((vi.y > point.y) != (vj.y > point.y))) {
            // Calculate the x-coordinate where the ray intersects the edge
            q16_t slope = q16_div(vj.x - vi.x, vj.y - vi.y);
            q16_t x_intersect = vi.x + q16_mul(slope, point.y - vi.y);
            
            if (point.x < x_intersect) {
                inside = !inside;
            }
        }
    }
    
    return !inside; // Return true if OUTSIDE
}

// Collision radii (client pixels) for module types that block player movement
static float module_collision_radius(ModuleTypeId type) {
    switch (type) {
        case MODULE_TYPE_HELM:
        case MODULE_TYPE_STEERING_WHEEL: return 18.0f;
        case MODULE_TYPE_MAST:           return 14.0f;
        case MODULE_TYPE_CANNON:         return 20.0f;
        case MODULE_TYPE_SWIVEL:         return 10.0f;
        default:                         return 0.0f; // ladder/plank/deck/seat — passable
    }
}

// ── Dock physics (shipyard CCD solver) ──────────────────────────────────────
#include "net/dock_physics.h"


/**
 * Resolve player-vs-module collisions in ship-local space.
 * Pushes (new_local_x, new_local_y) out of any module it overlaps.
 * Skips the module the player is currently mounted to.
 */
static void resolve_player_module_collisions(const SimpleShip* ship,
                                             module_id_t mounted_module_id,
                                             float* new_local_x, float* new_local_y)
{
    const float PLAYER_RADIUS = 8.0f; // client pixels — matches sim radius

    for (uint8_t m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];

        // Skip modules the player is mounted to
        if (mod->id == mounted_module_id) continue;

        float mod_radius = module_collision_radius(mod->type_id);
        if (mod_radius <= 0.0f) continue; // passable

        // Module position in ship-local client pixels
        float mod_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
        float mod_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));

        float dx = *new_local_x - mod_x;
        float dy = *new_local_y - mod_y;
        float dist_sq = dx * dx + dy * dy;
        float min_dist = PLAYER_RADIUS + mod_radius;

        if (dist_sq < min_dist * min_dist) {
            float dist = sqrtf(dist_sq);
            if (dist < 0.001f) {
                // Exact overlap — push sideways
                *new_local_x += min_dist;
            } else {
                // Push player out along the collision normal
                float overlap = min_dist - dist;
                *new_local_x += (dx / dist) * overlap;
                *new_local_y += (dy / dist) * overlap;
            }
        }
    }
}

/*
 * Pushes (new_local_x, new_local_y) out of any active WorldNpc on the same ship.
 * NPCs are treated as solid obstacles; only the player position is adjusted.
 */
static void resolve_player_npc_collisions(const SimpleShip* ship,
                                          float* new_local_x, float* new_local_y)
{
    const float PLAYER_RADIUS = 8.0f;
    const float NPC_RADIUS    = 8.0f;
    const float MIN_DIST      = PLAYER_RADIUS + NPC_RADIUS;

    for (int i = 0; i < world_npc_count; i++) {
        WorldNpc* npc = &world_npcs[i];
        if (!npc->active) continue;
        if (npc->ship_id != ship->ship_id) continue;

        float dx = *new_local_x - npc->local_x;
        float dy = *new_local_y - npc->local_y;
        float dist_sq = dx * dx + dy * dy;

        if (dist_sq < MIN_DIST * MIN_DIST) {
            float dist = sqrtf(dist_sq);
            if (dist < 0.001f) {
                *new_local_x += MIN_DIST;
            } else {
                float overlap = MIN_DIST - dist;
                *new_local_x += (dx / dist) * overlap;
                *new_local_y += (dy / dist) * overlap;
            }
        }
    }
}

// Helper to board a player onto a ship
void board_player_on_ship(WebSocketPlayer* player, SimpleShip* ship, float local_x, float local_y) {
    player->parent_ship_id = ship->ship_id;
    // company_id is NOT inherited from ship — assigned by admin or player choice
    player->local_x = local_x;
    player->local_y = local_y;
    player->movement_state = PLAYER_STATE_WALKING;
    
    // Update world position to match ship
    ship_local_to_world(ship, player->local_x, player->local_y, &player->x, &player->y);
    
    // Inherit ship velocity
    player->velocity_x = ship->velocity_x;
    player->velocity_y = ship->velocity_y;
    
    log_info("⚓ Player %u boarded ship %u at local (%.1f, %.1f)", 
             player->player_id, ship->ship_id, player->local_x, player->local_y);
}

// Helper to dismount a player from a ship (into water)
void dismount_player_from_ship(WebSocketPlayer* player, const char* reason) {
    if (player->parent_ship_id == 0) {
        return; // Already in water
    }
    
    log_info("🌊 Player %u dismounting from ship %u (reason: %s)", 
             player->player_id, player->parent_ship_id, reason);
    
    // Keep current world position but clear ship reference
    player->parent_ship_id = 0;
    player->local_x = 0.0f;
    player->local_y = 0.0f;
    player->movement_state = PLAYER_STATE_SWIMMING;
    
    // Keep some of the ship's velocity (player carries momentum)
    player->velocity_x *= 0.5f;
    player->velocity_y *= 0.5f;
    
    // Clear mounted state if player was on a module
    if (player->is_mounted) {
        player->is_mounted = false;
        player->mounted_module_id = 0;
        player->controlling_ship_id = 0;
    }
}

// Base64 encoding for WebSocket handshake
static char* base64_encode(const unsigned char* input, int length) {
    BIO *bio, *b64;
    BUF_MEM *buffer_ptr;
    
    b64 = BIO_new(BIO_f_base64());
    bio = BIO_new(BIO_s_mem());
    bio = BIO_push(b64, bio);
    
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(bio, input, length);
    BIO_flush(bio);
    BIO_get_mem_ptr(bio, &buffer_ptr);
    
    char* result = malloc(buffer_ptr->length + 1);
    memcpy(result, buffer_ptr->data, buffer_ptr->length);
    result[buffer_ptr->length] = '\0';
    
    BIO_free_all(bio);
    return result;
}

// WebSocket handshake
static bool websocket_handshake(int client_fd, const char* request) {
    size_t request_len = strlen(request);
    log_info("🤝 Starting WebSocket handshake, request length: %zu bytes", request_len);
    
    // Log raw bytes for debugging if request is suspiciously short
    if (request_len < 20) {
        log_error("⚠️ Request too short (%zu bytes) for HTTP handshake. Raw bytes (hex):", request_len);
        for (size_t i = 0; i < request_len && i < 50; i++) {
            fprintf(stderr, "%02X ", (unsigned char)request[i]);
        }
        fprintf(stderr, "\n");
        log_debug("ASCII representation: '%s'", request);
        return false;
    }
    
    // Log first line of request for debugging
    const char* first_line_end = strstr(request, "\r\n");
    if (first_line_end) {
        size_t first_line_len = first_line_end - request;
        char first_line[256];
        size_t copy_len = (first_line_len < sizeof(first_line) - 1) ? first_line_len : sizeof(first_line) - 1;
        memcpy(first_line, request, copy_len);
        first_line[copy_len] = '\0';
        log_debug("📋 Request first line: '%s'", first_line);
    }
    
    // Check for WebSocket upgrade request - must be GET
    if (!strstr(request, "GET ")) {
        log_error("❌ Handshake failed: Not a GET request (might be POST/OPTIONS or non-HTTP data)");
        log_debug("First 100 chars of request: '%.100s'", request);
        return false;
    }
    
    if (!strstr(request, "Upgrade: websocket") && !strstr(request, "Upgrade: WebSocket")) {
        log_error("❌ Handshake failed: Missing 'Upgrade: websocket' header");
        return false;
    }
    
    char* key_start = strstr(request, "Sec-WebSocket-Key: ");
    if (!key_start) {
        log_error("❌ Handshake failed: Missing 'Sec-WebSocket-Key' header");
        log_debug("Request headers:\n%s", request);
        return false;
    }
    
    key_start += 19; // Length of "Sec-WebSocket-Key: "
    char* key_end = strstr(key_start, "\r\n");
    if (!key_end) {
        log_error("❌ Handshake failed: Malformed Sec-WebSocket-Key (no CRLF)");
        return false;
    }
    
    size_t key_len = key_end - key_start;
    if (key_len == 0 || key_len > 255) {
        log_error("❌ Handshake failed: Invalid key length: %zu", key_len);
        return false;
    }
    
    char key[256];
    memcpy(key, key_start, key_len);
    key[key_len] = '\0';
    
    log_debug("📋 Extracted WebSocket key: '%s' (length: %zu)", key, key_len);
    
    // Create accept key
    char accept_input[512];
    snprintf(accept_input, sizeof(accept_input), "%s%s", key, WS_MAGIC_KEY);
    
    unsigned char hash[SHA_DIGEST_LENGTH];
    SHA1((unsigned char*)accept_input, strlen(accept_input), hash);
    
    char* accept_key = base64_encode(hash, SHA_DIGEST_LENGTH);
    if (!accept_key) {
        log_error("❌ Handshake failed: base64_encode returned NULL");
        return false;
    }
    
    log_debug("🔑 Computed Sec-WebSocket-Accept: '%s'", accept_key);
    
    // Send handshake response
    char response[1024];
    int response_len = snprintf(response, sizeof(response),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n",
        accept_key);
    
    if (response_len < 0 || response_len >= (int)sizeof(response)) {
        log_error("❌ Handshake failed: Response buffer overflow");
        free(accept_key);
        return false;
    }
    
    log_debug("📤 Sending handshake response (%d bytes)", response_len);
    
    ssize_t sent = send(client_fd, response, strlen(response), 0);
    free(accept_key);
    
    if (sent <= 0) {
        log_error("❌ Handshake failed: send() returned %zd, errno: %d (%s)", 
                  sent, errno, strerror(errno));
        return false;
    }
    
    if (sent != response_len) {
        log_warn("⚠️ Handshake partial send: %zd/%d bytes", sent, response_len);
    }
    
    log_info("✅ WebSocket handshake completed successfully (%zd bytes sent)", sent);
    return true;
}

// Parse WebSocket frame
// Forward declarations
WebSocketPlayer* find_player(uint32_t player_id);
static WebSocketPlayer* create_player(uint32_t player_id);
static void remove_player(uint32_t player_id);

/* ── Tombstone helpers ────────────────────────────────────────────────────── */

/**
 * Called on every authoritative player death.
 * 1. Copies all inventory items into a new tombstone.
 * 2. Wipes the player's inventory.
 * 3. Broadcasts tombstone_spawned to all clients.
 */
static void player_die(WebSocketPlayer* player) {
    /* Check whether the player has any items worth dropping */
    bool has_items = false;
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (player->inventory.slots[s].item != ITEM_NONE &&
            player->inventory.slots[s].quantity > 0) { has_items = true; break; }
    }
    if (!has_items) {
        /* also check worn equipment */
        has_items = (player->inventory.equipment.helm   != ITEM_NONE ||
                     player->inventory.equipment.torso  != ITEM_NONE ||
                     player->inventory.equipment.legs   != ITEM_NONE ||
                     player->inventory.equipment.feet   != ITEM_NONE ||
                     player->inventory.equipment.hands  != ITEM_NONE ||
                     player->inventory.equipment.shield != ITEM_NONE);
    }

    /* Find a free tombstone slot */
    Tombstone* t = NULL;
    if (has_items) {
        for (int i = 0; i < (int)MAX_TOMBSTONES; i++) {
            if (!tombstones[i].active) { t = &tombstones[i]; break; }
        }
    }

    if (t) {
        t->id = next_tombstone_id++;
        if (next_tombstone_id == 0) next_tombstone_id = 1;
        t->x = player->x;
        t->y = player->y;
        strncpy(t->owner_name, player->name, sizeof(t->owner_name) - 1);
        t->owner_name[sizeof(t->owner_name) - 1] = '\0';
        t->inventory      = player->inventory;  /* full struct copy */
        t->spawn_time_ms  = get_time_ms();
        t->active         = true;

        /* Broadcast tombstone_spawned ─────────────────────────────────── */
        char msg[1024];
        int off = snprintf(msg, sizeof(msg),
            "{\"type\":\"tombstone_spawned\",\"id\":%u,\"x\":%.1f,\"y\":%.1f,"
            "\"ownerName\":\"%s\",\"ttlMs\":%u,"
            "\"equip\":{\"helm\":%d,\"torso\":%d,\"legs\":%d,"
                       "\"feet\":%d,\"hands\":%d,\"shield\":%d},\"slots\":[",
            t->id, t->x, t->y, t->owner_name, TOMBSTONE_TTL_MS,
            (int)t->inventory.equipment.helm,  (int)t->inventory.equipment.torso,
            (int)t->inventory.equipment.legs,  (int)t->inventory.equipment.feet,
            (int)t->inventory.equipment.hands, (int)t->inventory.equipment.shield);
        for (int s = 0; s < INVENTORY_SLOTS && off < (int)sizeof(msg) - 8; s++) {
            if (s > 0) msg[off++] = ',';
            off += snprintf(msg + off, sizeof(msg) - off, "[%d,%d]",
                (int)t->inventory.slots[s].item,
                (int)t->inventory.slots[s].quantity);
        }
        off += snprintf(msg + off, sizeof(msg) - off, "]}");
        websocket_server_broadcast(msg);
        log_info("⚰️  Tombstone %u spawned for %s at (%.1f,%.1f)",
                 t->id, t->owner_name, t->x, t->y);
    }

    /* Wipe player inventory regardless of whether a tombstone was created */
    memset(&player->inventory, 0, sizeof(PlayerInventory));
    player->inventory.active_slot = 255; /* sentinel: nothing equipped */
}

/**
 * Handle a collect_tombstone request from a client.
 * Player must be within 80 px of the tombstone.
 * Items are transferred into the player's inventory; tombstone is removed.
 */
static void handle_collect_tombstone(WebSocketPlayer* player,
                                     struct WebSocketClient* client,
                                     const char* payload) {
    uint32_t tomb_id = 0;
    const char* p_id = strstr(payload, "\"id\":");
    if (p_id) tomb_id = (uint32_t)atoi(p_id + 5);

    /* Locate tombstone */
    Tombstone* t = NULL;
    for (int i = 0; i < (int)MAX_TOMBSTONES; i++) {
        if (tombstones[i].active && tombstones[i].id == tomb_id) {
            t = &tombstones[i]; break;
        }
    }
    if (!t) {
        char resp[128];
        snprintf(resp, sizeof(resp),
            "{\"type\":\"tombstone_collect_fail\",\"reason\":\"not_found\",\"id\":%u}", tomb_id);
        char frame[192];
        size_t fl = websocket_create_frame(WS_OPCODE_TEXT, resp, strlen(resp), frame, sizeof(frame));
        if (fl > 0) send(client->fd, frame, fl, 0);
        return;
    }

    /* Range check: 80 px */
    float dx = player->x - t->x;
    float dy = player->y - t->y;
    if (dx * dx + dy * dy > 80.0f * 80.0f) {
        char resp[128];
        snprintf(resp, sizeof(resp),
            "{\"type\":\"tombstone_collect_fail\",\"reason\":\"too_far\",\"id\":%u}", tomb_id);
        char frame[192];
        size_t fl = websocket_create_frame(WS_OPCODE_TEXT, resp, strlen(resp), frame, sizeof(frame));
        if (fl > 0) send(client->fd, frame, fl, 0);
        return;
    }

    /* Transfer hotbar slots */
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (t->inventory.slots[s].item != ITEM_NONE && t->inventory.slots[s].quantity > 0)
            craft_grant(player, t->inventory.slots[s].item,
                        (int)t->inventory.slots[s].quantity);
    }
    /* Transfer worn equipment */
    if (t->inventory.equipment.helm   != ITEM_NONE) craft_grant(player, t->inventory.equipment.helm,   1);
    if (t->inventory.equipment.torso  != ITEM_NONE) craft_grant(player, t->inventory.equipment.torso,  1);
    if (t->inventory.equipment.legs   != ITEM_NONE) craft_grant(player, t->inventory.equipment.legs,   1);
    if (t->inventory.equipment.feet   != ITEM_NONE) craft_grant(player, t->inventory.equipment.feet,   1);
    if (t->inventory.equipment.hands  != ITEM_NONE) craft_grant(player, t->inventory.equipment.hands,  1);
    if (t->inventory.equipment.shield != ITEM_NONE) craft_grant(player, t->inventory.equipment.shield, 1);

    /* Remove tombstone and broadcast */
    t->active = false;
    char msg[128];
    snprintf(msg, sizeof(msg),
        "{\"type\":\"tombstone_collected\",\"id\":%u,\"playerId\":%u}",
        tomb_id, player->player_id);
    websocket_server_broadcast(msg);
    log_info("⚰️  Tombstone %u collected by player %u (%s)",
             tomb_id, player->player_id, player->name);
}

/* ── Dropped-item helpers ─────────────────────────────────────────────────── */

/* Helper: frame + send a short text message to one client. */
static void ws_send_text(int fd, const char* msg) {
    char frame[256];
    size_t fl = websocket_create_frame(WS_OPCODE_TEXT, msg, strlen(msg), frame, sizeof(frame));
    if (fl > 0) send(fd, frame, fl, 0);
}

/* Helper: serialize tombstone inventory and send tombstone_items to one client. */
static void send_tombstone_items(struct WebSocketClient* client, Tombstone* t) {
    char msg[2048];
    int off = snprintf(msg, sizeof(msg),
        "{\"type\":\"tombstone_items\",\"id\":%u,\"ownerName\":\"%s\","
        "\"equip\":{\"helm\":%d,\"torso\":%d,\"legs\":%d,"
                   "\"feet\":%d,\"hands\":%d,\"shield\":%d},\"slots\":[",
        t->id, t->owner_name,
        (int)t->inventory.equipment.helm,  (int)t->inventory.equipment.torso,
        (int)t->inventory.equipment.legs,  (int)t->inventory.equipment.feet,
        (int)t->inventory.equipment.hands, (int)t->inventory.equipment.shield);
    for (int s = 0; s < INVENTORY_SLOTS && off < (int)sizeof(msg) - 16; s++) {
        if (s > 0) msg[off++] = ',';
        off += snprintf(msg + off, sizeof(msg) - off, "[%d,%d]",
            (int)t->inventory.slots[s].item,
            (int)t->inventory.slots[s].quantity);
    }
    off += snprintf(msg + off, sizeof(msg) - off, "]}");
    char frame[2200];
    size_t fl = websocket_create_frame(WS_OPCODE_TEXT, msg, (size_t)off, frame, sizeof(frame));
    if (fl > 0) send(client->fd, frame, fl, 0);
}

/**
 * Handle tombstone_open: player opened the tombstone menu.
 * Range-checks and sends back tombstone_items to just this client.
 */
static void handle_tombstone_open(WebSocketPlayer* player,
                                   struct WebSocketClient* client,
                                   const char* payload) {
    uint32_t tomb_id = 0;
    const char* p_id = strstr(payload, "\"id\":");
    if (p_id) tomb_id = (uint32_t)atoi(p_id + 5);

    Tombstone* t = NULL;
    for (int i = 0; i < (int)MAX_TOMBSTONES; i++) {
        if (tombstones[i].active && tombstones[i].id == tomb_id) {
            t = &tombstones[i]; break;
        }
    }
    if (!t) {
        char resp[128];
        snprintf(resp, sizeof(resp),
            "{\"type\":\"tombstone_collect_fail\",\"reason\":\"not_found\",\"id\":%u}", tomb_id);
        ws_send_text(client->fd, resp);
        return;
    }
    float dx = player->x - t->x, dy = player->y - t->y;
    if (dx * dx + dy * dy > 80.0f * 80.0f) {
        char resp[128];
        snprintf(resp, sizeof(resp),
            "{\"type\":\"tombstone_collect_fail\",\"reason\":\"too_far\",\"id\":%u}", tomb_id);
        ws_send_text(client->fd, resp);
        return;
    }
    send_tombstone_items(client, t);
}

/**
 * Handle tombstone_take_slot: player dragged one slot out of the tombstone.
 * Grants that item to the player, clears the tombstone slot.
 * If tombstone becomes empty, removes it and broadcasts tombstone_collected.
 * Otherwise sends updated tombstone_items back to the requesting client.
 */
static void handle_tombstone_take_slot(WebSocketPlayer* player,
                                        struct WebSocketClient* client,
                                        const char* payload) {
    uint32_t tomb_id = 0;
    int slot = -1;
    const char* p_id = strstr(payload, "\"id\":");
    const char* p_sl = strstr(payload, "\"slot\":");
    if (p_id) tomb_id = (uint32_t)atoi(p_id + 5);
    if (p_sl) slot    = atoi(p_sl + 7);

    if (slot < 0 || slot >= INVENTORY_SLOTS) return;

    Tombstone* t = NULL;
    for (int i = 0; i < (int)MAX_TOMBSTONES; i++) {
        if (tombstones[i].active && tombstones[i].id == tomb_id) {
            t = &tombstones[i]; break;
        }
    }
    if (!t) return;
    float dx = player->x - t->x, dy = player->y - t->y;
    if (dx * dx + dy * dy > 80.0f * 80.0f) return;

    InventorySlot* isl = &t->inventory.slots[slot];
    if (isl->item == ITEM_NONE || isl->quantity == 0) return;

    craft_grant(player, isl->item, (int)isl->quantity);
    isl->item     = ITEM_NONE;
    isl->quantity = 0;

    /* Check if tombstone is now completely empty */
    bool any_left = false;
    for (int s = 0; s < INVENTORY_SLOTS; s++) {
        if (t->inventory.slots[s].item != ITEM_NONE && t->inventory.slots[s].quantity > 0)
            { any_left = true; break; }
    }
    if (!any_left) {
        if (t->inventory.equipment.helm   != ITEM_NONE ||
            t->inventory.equipment.torso  != ITEM_NONE ||
            t->inventory.equipment.legs   != ITEM_NONE ||
            t->inventory.equipment.feet   != ITEM_NONE ||
            t->inventory.equipment.hands  != ITEM_NONE ||
            t->inventory.equipment.shield != ITEM_NONE)
            any_left = true;
    }

    if (!any_left) {
        t->active = false;
        char msg[128];
        snprintf(msg, sizeof(msg),
            "{\"type\":\"tombstone_collected\",\"id\":%u,\"playerId\":%u}",
            tomb_id, player->player_id);
        websocket_server_broadcast(msg);
        log_info("⚰️  Tombstone %u emptied slot-by-slot by player %u", tomb_id, player->player_id);
        return;
    }

    /* Send refreshed tombstone contents back to this client */
    send_tombstone_items(client, t);
}

static void handle_drop_item(WebSocketPlayer* player,
                              struct WebSocketClient* client,
                              const char* payload)
{
    int slot = -1;
    const char* ps = strstr(payload, "\"slot\":");
    if (ps) sscanf(ps + 7, "%d", &slot);
    if (slot < 0 || slot >= INVENTORY_SLOTS) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"invalid_slot\"}");
        return;
    }
    InventorySlot* isl = &player->inventory.slots[slot];
    if (isl->item == ITEM_NONE || isl->quantity == 0) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"empty_slot\"}");
        return;
    }
    DroppedItem* di = NULL;
    for (int i = 0; i < (int)MAX_DROPPED_ITEMS; i++) {
        if (!dropped_items[i].active) { di = &dropped_items[i]; break; }
    }
    if (!di) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"world_full\"}");
        return;
    }
    di->id            = next_dropped_item_id++;
    if (next_dropped_item_id == 0) next_dropped_item_id = 1;
    di->item_kind     = (uint8_t)isl->item;
    di->quantity      = isl->quantity;
    di->x             = player->x;
    di->y             = player->y;
    di->spawn_time_ms = get_time_ms();
    di->active        = true;
    isl->item     = ITEM_NONE;
    isl->quantity = 0;
    char resp[128];
    snprintf(resp, sizeof(resp),
        "{\"type\":\"message_ack\",\"status\":\"item_dropped\",\"drop_id\":%u}", di->id);
    ws_send_text(client->fd, resp);
    log_info("📦  Player %u dropped item %u qty %u at (%.1f,%.1f) id=%u",
             player->player_id, (unsigned)di->item_kind, (unsigned)di->quantity,
             (double)di->x, (double)di->y, di->id);
}

static void handle_pickup_item(WebSocketPlayer* player,
                                struct WebSocketClient* client,
                                const char* payload)
{
    uint32_t item_id = 0;
    const char* pi = strstr(payload, "\"item_id\":");
    if (pi) sscanf(pi + 10, "%u", &item_id);
    if (item_id == 0) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"invalid_id\"}");
        return;
    }
    DroppedItem* di = NULL;
    for (int i = 0; i < (int)MAX_DROPPED_ITEMS; i++) {
        if (dropped_items[i].active && dropped_items[i].id == item_id) {
            di = &dropped_items[i]; break;
        }
    }
    if (!di) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"not_found\"}");
        return;
    }
    float dx = di->x - player->x;
    float dy = di->y - player->y;
    if (dx * dx + dy * dy > 80.0f * 80.0f) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"too_far\"}");
        return;
    }
    int free_slot = -1;
    for (int i = 0; i < INVENTORY_SLOTS; i++) {
        if (player->inventory.slots[i].item == ITEM_NONE ||
            player->inventory.slots[i].quantity == 0) {
            free_slot = i; break;
        }
    }
    if (free_slot < 0) {
        ws_send_text(client->fd, "{\"type\":\"error\",\"message\":\"inventory_full\"}");
        return;
    }
    player->inventory.slots[free_slot].item     = (ItemKind)di->item_kind;
    player->inventory.slots[free_slot].quantity = di->quantity;
    di->active = false;
    char resp[128];
    snprintf(resp, sizeof(resp),
        "{\"type\":\"message_ack\",\"status\":\"item_picked_up\",\"slot\":%d}", free_slot);
    ws_send_text(client->fd, resp);
    log_info("📦  Player %u picked up drop id %u (item %u) into slot %d",
             player->player_id, item_id, (unsigned)di->item_kind, free_slot);
}



// ── Player persistence ──────────────────────────────────────────────────────
#include "net/player_persistence.h"
#include "net/module_interactions.h"

// ============================================================================

// ── O(1) player lookup ──────────────────────────────────────────────────────
// Player IDs are sequential starting at 1000.  Using (id & mask) as the slot
// gives a direct collision-free index for the first 1048 sequential IDs.
// Self-validating: every hit re-checks active+player_id.
#define PLAYER_ID_MASK 2047u   // 2048 slots
static WebSocketPlayer* g_player_by_id[PLAYER_ID_MASK + 1]; // zero-initialised by C

// Player management functions
WebSocketPlayer* find_player(uint32_t player_id) {
    uint32_t slot = player_id & PLAYER_ID_MASK;
    WebSocketPlayer* cached = g_player_by_id[slot];
    if (cached && cached->active && cached->player_id == player_id) return cached;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].player_id == player_id) {
            g_player_by_id[slot] = &players[i];
            return &players[i];
        }
    }
    return NULL;
}

WebSocketPlayer* find_player_by_sim_id(entity_id sim_entity_id) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].sim_entity_id == sim_entity_id) {
            return &players[i];
        }
    }
    return NULL;
}

static WebSocketPlayer* create_player(uint32_t player_id) {
    // Check if player already exists
    WebSocketPlayer* existing = find_player(player_id);
    if (existing) {
        log_warn("Player %u already exists, reusing existing player", player_id);
        return existing;
    }
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (!players[i].active) {
            // Clear the player structure first
            memset(&players[i], 0, sizeof(WebSocketPlayer));
            
            players[i].player_id = player_id;
            players[i].sim_entity_id = 0; // Will be set when added to simulation
            
            // Spawn player in water well above the ship for testing collision
            players[i].parent_ship_id = 0;
            players[i].x = 100.0f;  // Directly above the ship at (100, 100) in client coords
            players[i].y = 600.0f;  // 500 units above in client coords
            players[i].local_x = 0.0f;
            players[i].local_y = 0.0f;
            players[i].movement_state = PLAYER_STATE_SWIMMING;
            players[i].health = 100;
            players[i].max_health = 100;
            players[i].player_level = 1;
            players[i].player_xp = 0;
            players[i].stat_health = 0;
            players[i].stat_damage = 0;
            players[i].stat_stamina = 0;
            players[i].stat_weight = 0;
            
            // ===== ADD PLAYER TO C SIMULATION FOR COLLISION DETECTION =====
            if (global_sim) {
                Vec2Q16 spawn_pos = {
                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(players[i].x)),
                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(players[i].y))
                };
                entity_id sim_player_id = sim_create_player(global_sim, spawn_pos, 0);
                if (sim_player_id != INVALID_ENTITY_ID) {
                    players[i].sim_entity_id = sim_player_id;
                    log_info("✅ Player %u added to simulation (sim_entity_id: %u)", player_id, sim_player_id);
                } else {
                    log_warn("❌ Failed to add player %u to simulation", player_id);
                }
            }
            
            // Player spawned in water
            
            /* Original ship spawn code - commented out for swimming tests
            // Spawn player on the first ship if it exists
            if (ship_count > 0 && ships[0].active) {
                players[i].parent_ship_id = ships[0].ship_id;
                players[i].local_x = 0.0f;  // Center of ship deck
                players[i].local_y = 0.0f;
                players[i].movement_state = PLAYER_STATE_WALKING;
                
                // Calculate world position from ship position
                ship_local_to_world(&ships[0], players[i].local_x, players[i].local_y, 
                                   &players[i].x, &players[i].y);
                
                log_info("🎮 Spawned player %u on ship %u at local (%.1f, %.1f), world (%.1f, %.1f)", 
                         player_id, ships[0].ship_id, players[i].local_x, players[i].local_y,
                         players[i].x, players[i].y);
            } else {
                // No ship available - spawn in water at origin
                players[i].parent_ship_id = 0;
                players[i].x = 0.0f;
                players[i].y = 0.0f;
                players[i].local_x = 0.0f;
                players[i].local_y = 0.0f;
                players[i].movement_state = PLAYER_STATE_SWIMMING;
                
                log_info("🎮 Spawned player %u in water at (%.1f, %.1f)", 
                         player_id, players[i].x, players[i].y);
            }
            */
            
            players[i].velocity_x = 0.0f;
            players[i].velocity_y = 0.0f;
            players[i].rotation = 0.0f;
            
            // Initialize hybrid input system fields
            players[i].movement_direction_x = 0.0f;
            players[i].movement_direction_y = 0.0f;
            players[i].is_moving = false;
            players[i].last_rotation = 0.0f;
            players[i].last_rotation_update_time = get_time_ms();
            
            players[i].last_input_time = get_time_ms();
            players[i].active = true;
            
            // Initialize module interaction state
            players[i].is_mounted = false;
            players[i].mounted_module_id = 0;
            players[i].controlling_ship_id = 0;

            // Initialize inventory — 4 starter items: swivel, hammer, sword, axe + building items
            memset(&players[i].inventory, 0, sizeof(PlayerInventory));
            players[i].inventory.active_slot = 2; // Default to sword (slot 2)
            players[i].inventory.slots[0].item     = ITEM_SWIVEL;
            players[i].inventory.slots[0].quantity = 3;
            players[i].inventory.slots[1].item     = ITEM_HAMMER;
            players[i].inventory.slots[1].quantity = 1;
            players[i].inventory.slots[2].item     = ITEM_SWORD;
            players[i].inventory.slots[2].quantity = 1;
            players[i].inventory.slots[3].item     = ITEM_AXE;
            players[i].inventory.slots[3].quantity = 1;
            players[i].inventory.slots[4].item     = ITEM_WOODEN_FLOOR;
            players[i].inventory.slots[4].quantity = 10;
            players[i].inventory.slots[5].item     = ITEM_WORKBENCH;
            players[i].inventory.slots[5].quantity = 2;
            players[i].inventory.slots[6].item     = ITEM_SHIPYARD;
            players[i].inventory.slots[6].quantity = 1;
            // slots 7-9 remain empty (zeroed by memset)

            return &players[i];
        }
    }
    return NULL;
}

static void remove_player(uint32_t player_id) {
    if (player_id == 0) {
        log_warn("Attempted to remove player with invalid ID 0");
        return;
    }
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].player_id == player_id) {
            // If mounted, clear the module's occupied state so other players can use it.
            if (players[i].is_mounted && players[i].mounted_module_id != 0) {
                /* Use O(1) ship lookup; parent_ship_id is set when mounted */
                SimpleShip* ms = find_ship(players[i].parent_ship_id);
                if (ms) {
                    ShipModule* mod = find_module_by_id(ms, players[i].mounted_module_id);
                    if (mod) {
                        switch (mod->type_id) {
                            case MODULE_TYPE_HELM:
                            case MODULE_TYPE_STEERING_WHEEL:
                                mod->data.helm.occupied_by = 0;
                                break;
                            case MODULE_TYPE_SEAT:
                                mod->data.seat.occupied_by = 0;
                                break;
                            default:
                                break;
                        }
                        mod->state_bits &= ~MODULE_STATE_OCCUPIED;
                        log_info("🔓 Cleared occupied state on module %u (player %u disconnected)",
                                 mod->id, player_id);
                    }
                }
            }
            // Remove the physics/collision entity from the simulation first so
            // there are no invisible collision bodies left behind.
            if (global_sim && players[i].sim_entity_id != 0) {
                bool removed = sim_destroy_entity(global_sim, players[i].sim_entity_id);
                if (removed) {
                    log_info("🎮 Removed sim entity %u for player %u", players[i].sim_entity_id, player_id);
                } else {
                    log_warn("sim_destroy_entity could not find entity %u for player %u", players[i].sim_entity_id, player_id);
                }
            }
            // Save player data before clearing
            save_player_to_file(&players[i]);
            // Clear the entire player structure
            memset(&players[i], 0, sizeof(WebSocketPlayer));
            log_info("🎮 Removed player %u", player_id);
            return;
        }
    }
    log_warn("Attempted to remove non-existent player %u", player_id);
}

// ── Ship control (sail/rudder) ───────────────────────────────────────────────
#include "net/ship_control.h"
#include "net/npc_agents.h"
#include "net/npc_world.h"

// ── Cannon aim, fire, weapon groups ─────────────────────────────────────────
#include "net/cannon_fire.h"

// Forward declarations now in ship_init.h

/**
 * Handle harvest_resource request from client.
 * Requires: player is on an island, active slot holds ITEM_AXE,
 * and a 'wood' resource node is within HARVEST_RANGE world-px.
 * Grants 1–2 planks into the first available inventory slot.
 */
#define HARVEST_RANGE 110.0f   /* world-px, generous for feel */


// ── Island structure placement — now in structures.c ──────────────────────
#include "net/structures.h"
/* handle_harvest_resource, handle_harvest_fiber, handle_harvest_rock removed — now in harvesting.c */
#include "net/harvesting.h"


// ── Crafting helpers — now in crafting.c ──────────────────────────────────
#include "net/crafting.h"

// ── Module Interactions (handle_cannon/helm/mast/ladder/swivel/seat interact,
//    handle_module_interact, handle_module_unmount, plank_occludes_ray,
//    find_module_by_id, send_interaction_failure) — now in module_interactions.c
// (included via #include "net/module_interactions.h" above)


// ── Player movement — now in player_movement.c ────────────────────────────
#include "net/player_movement.h"

static int websocket_parse_frame(const char* buffer, size_t buffer_len, char* payload, size_t* payload_len, size_t* frame_size_out) {
    if (frame_size_out) *frame_size_out = 0;
    if (buffer_len < 2) return -1;
    
    uint8_t first_byte = buffer[0];
    uint8_t second_byte = buffer[1];
    
    bool fin = (first_byte & 0x80) != 0;
    (void)fin; /* caller reads buffer[0] & 0x80 directly */
    uint8_t opcode = first_byte & 0x0F;
    bool masked = (second_byte & 0x80) != 0;
    uint8_t payload_length = second_byte & 0x7F;
    
    if (!masked) return -1; /* clients must always mask frames */
    
    size_t header_len = 2;
    uint64_t actual_payload_len = payload_length;
    
    // Extended payload length
    if (payload_length == 126) {
        if (buffer_len < 4) return -1;
        actual_payload_len = ((unsigned char)buffer[2] << 8) | (unsigned char)buffer[3];
        header_len += 2;
    } else if (payload_length == 127) {
        if (buffer_len < 10) return -1;
        // For simplicity, we don't handle 64-bit lengths
        return -1;
    }
    
    // CRITICAL: Check payload won't overflow destination buffer (assumed to be 4096 bytes)
    if (actual_payload_len > 4095) {
        log_warn("⚠️ Dropping oversized WebSocket frame: %lu bytes (max 4095) - connection remains active", 
                  (unsigned long)actual_payload_len);
        /* Advance past the frame even though we drop the payload */
        size_t total = header_len + 4 + (size_t)actual_payload_len;
        if (buffer_len >= total && frame_size_out) *frame_size_out = total;
        *payload_len = 0;
        return opcode;
    }
    
    if (buffer_len < header_len + 4 + actual_payload_len) return -1; /* incomplete frame */
    
    // Extract masking key
    uint8_t mask[4];
    memcpy(mask, buffer + header_len, 4);
    header_len += 4;
    
    // Unmask payload
    for (size_t i = 0; i < actual_payload_len; i++) {
        payload[i] = buffer[header_len + i] ^ mask[i % 4];
    }
    payload[actual_payload_len] = '\0';
    *payload_len = actual_payload_len;
    
    if (frame_size_out) *frame_size_out = header_len + actual_payload_len;
    return opcode;
}

/* Send all bytes, looping on partial writes (e.g. large frames filling the kernel send buffer). */
static ssize_t send_all(int fd, const char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, buf + sent, len - sent, 0);
        if (n <= 0) return (ssize_t)sent;
        sent += (size_t)n;
    }
    return (ssize_t)sent;
}

// Create WebSocket frame
// NOTE: Caller must ensure frame buffer is large enough (payload_len + 10 bytes for header)
size_t websocket_create_frame(uint8_t opcode, const char* payload, size_t payload_len, char* frame, size_t frame_size) {
    size_t frame_len = 0;
    
    // Calculate required frame size (header + payload)
    size_t required_size = payload_len + 10; // Max header is 10 bytes
    
    // Validate buffer size
    if (required_size > frame_size) {
        log_error("❌ Frame buffer overflow prevented: need %zu bytes, have %zu bytes (payload: %zu)", 
                  required_size, frame_size, payload_len);
        return 0;
    }
    
    // First byte: FIN = 1, opcode
    frame[frame_len++] = 0x80 | opcode;
    
    // Payload length
    if (payload_len < 126) {
        frame[frame_len++] = payload_len;
    } else if (payload_len < 65536) {
        frame[frame_len++] = 126;
        frame[frame_len++] = (payload_len >> 8) & 0xFF;
        frame[frame_len++] = payload_len & 0xFF;
    } else {
        // 8-byte extended payload length (for payloads >= 64 KB, e.g. ISLANDS)
        frame[frame_len++] = 127;
        for (int shift = 56; shift >= 0; shift -= 8)
            frame[frame_len++] = (payload_len >> shift) & 0xFF;
    }
    
    // Payload
    memcpy(frame + frame_len, payload, payload_len);
    frame_len += payload_len;
    
    return frame_len;
}

void websocket_server_set_simulation(struct Sim* sim) {
    global_sim = sim;
    log_info("✅ WebSocket server linked to simulation for collision detection");
}

/**
 * Each tick: keep sinking ships frozen and despawn them after SHIP_SINK_DURATION_MS.
 */

// ── Ship initialisation, ghost ships, sinking — now in ship_init.c ──────────
#include "net/ship_init.h"
int websocket_server_init(uint16_t port) {
    /* Generate procedural tree positions for all polygon islands. Must be
     * called before any client connects so the ISLANDS message is complete. */
    islands_load_from_files("data/islands");
    islands_generate_trees();
    islands_build_grid();

    memset(&ws_server, 0, sizeof(ws_server));
    ws_server.port = port;
    
    // Create TCP socket
    ws_server.socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (ws_server.socket_fd < 0) {
        log_error("Failed to create WebSocket TCP socket: %s", strerror(errno));
        return -1;
    }
    
    // Set socket options
    int reuse = 1;
    if (setsockopt(ws_server.socket_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
        log_warn("Failed to set SO_REUSEADDR on WebSocket socket: %s", strerror(errno));
    }
    
    // Set non-blocking
    int flags = fcntl(ws_server.socket_fd, F_GETFL, 0);
    if (flags == -1 || fcntl(ws_server.socket_fd, F_SETFL, flags | O_NONBLOCK) == -1) {
        log_error("Failed to set WebSocket socket non-blocking: %s", strerror(errno));
        close(ws_server.socket_fd);
        return -1;
    }
    
    // Bind socket
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(ws_server.socket_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        log_error("Failed to bind WebSocket socket to port %u: %s", port, strerror(errno));
        close(ws_server.socket_fd);
        return -1;
    }
    
    // Start listening
    if (listen(ws_server.socket_fd, 10) < 0) {
        log_error("Failed to listen on WebSocket socket: %s", strerror(errno));
        close(ws_server.socket_fd);
        return -1;
    }
    
    ws_server.running = true;
    log_info("WebSocket server initialized on port %u", port);
    
    // Spawn two brigantine ships with fixed seq 1 and 2; advance counter past them
    init_brigantine_ship(0, 100.0f, 100.0f, 1, COMPANY_PIRATES, 0xFF);
    init_brigantine_ship(1, 100.0f, 700.0f, 2, COMPANY_NAVY,    0xFF);
    next_ship_seq = 3; /* advance past the two hard-coded ships */
    ship_count = 2;
    
    log_info("🚢 Ship 1 (ID: %u) — company: %s", ships[0].ship_id, company_name(ships[0].company_id));
    log_info("🚢 Ship 2 (ID: %u) — company: %s", ships[1].ship_id, company_name(ships[1].company_id));

    // Spawn NPC gunners on ship 2 (module IDs 2001-2006 are its 6 cannons).
    // They will target ship 1 automatically.  Fire every 5s; initial delay 2s.
    {
        uint32_t ship2_id = ships[1].ship_id;
        uint32_t ship1_id = ships[0].ship_id;
        // Port-side cannon and starboard-side cannon on ship 2
        // MID(2, MODULE_OFFSET_CANNON_PORT_0) = 0x0203 = 515
        // MID(2, MODULE_OFFSET_CANNON_STBD_0) = 0x0206 = 518
        uint16_t npc1 = websocket_server_create_npc(ship2_id, MID(2, MODULE_OFFSET_CANNON_PORT_0), NPC_ROLE_GUNNER);
        uint16_t npc2 = websocket_server_create_npc(ship2_id, MID(2, MODULE_OFFSET_CANNON_STBD_0), NPC_ROLE_GUNNER);
        if (npc1) websocket_server_npc_set_target(npc1, ship1_id);
        if (npc2) websocket_server_npc_set_target(npc2, ship1_id);
        log_info("🤖 NPC gunners %u and %u spawned on ship 2, targeting ship 1", npc1, npc2);
    }

    // Spawn crew NPCs across both ships:
    //   - 6 gunners per ship: one per individual cannon.
    //     Module IDs: base+1..3 = port cannons, base+4..6 = starboard cannons.
    //   - 3 riggers per ship: one per mast (base+7, base+8, base+9).
    {
        /* 9 generic crew per ship — roles assigned at runtime by the manning panel.
         * Any crew member can become a gunner, rigger, or stand idle. */
        static const char* crew_names[18] = {
            "Bo",   "Mack", "Finn", "Ray",  "Cole", "Sven",
            "Ned",  "Hank", "Jim",
            "Dirk", "Walt", "Hal",  "Cruz", "Ike",  "Rex",
            "Lars", "Tam",  "Bren"
        };
        int crew_idx = 0;
        for (int s = 0; s < 2; s++) {
            uint32_t sid = ships[s].ship_id;
            for (int c = 0; c < 9; c++)
                spawn_ship_crew(sid, crew_names[crew_idx++]);
        }
        log_info("🧑 %d crew NPCs spawned across 2 ships (roles assigned by player)",
                 world_npc_count);
    }

    // Enhanced startup message
    printf("\n🌐 ═══════════════════════════════════════════════════════════════\n");
    printf("🔌 WebSocket Server Ready for Browser Clients!\n");
    printf("🌍 WebSocket listening on 0.0.0.0:%u\n", port);
    printf("🔄 Protocol bridge: WebSocket ↔ UDP translation active\n");
    printf("🎯 Browser clients can now connect via WebSocket\n");
    printf("🚢 Ship 1 at (%.1f, %.1f)  Ship 2 at (%.1f, %.1f)\n",
           ships[0].x, ships[0].y, ships[1].x, ships[1].y);
    printf("═══════════════════════════════════════════════════════════════\n\n");
    
    return 0;
}

void websocket_server_cleanup(void) {
    if (!ws_server.running) {
        log_info("WebSocket server already stopped");
        return;
    }
    
    log_info("📋 Starting WebSocket server cleanup...");
    
    // Signal shutdown
    ws_server.running = false;
    
    // Close all client connections gracefully
    int closed_clients = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (ws_server.clients[i].connected) {
            // Send close frame if possible
            uint8_t close_frame[] = {0x88, 0x00}; // Close frame with no payload
            send(ws_server.clients[i].fd, close_frame, sizeof(close_frame), MSG_NOSIGNAL);
            
            // Close the socket
            close(ws_server.clients[i].fd);
            ws_server.clients[i].connected = false;
            ws_server.clients[i].fd = -1;
            closed_clients++;
        }
    }
    
    if (closed_clients > 0) {
        log_info("🔌 Closed %d WebSocket client connections", closed_clients);
    }
    
    // Close server socket
    if (ws_server.socket_fd >= 0) {
        shutdown(ws_server.socket_fd, SHUT_RDWR);
        close(ws_server.socket_fd);
        ws_server.socket_fd = -1;
        log_info("🔌 WebSocket server socket closed");
    }
    
    log_info("✅ WebSocket server cleanup complete");
}


// ── Projectile vs. static-world collision — now in cannon_fire.c ─────────────

int websocket_server_update(struct Sim* sim) {
    if (!ws_server.running) return 0;

    /* Check cannonball hits against structures and trees from last sim tick */
    check_projectile_static_collisions(sim);

    // Accept new connections
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    int client_fd = accept(ws_server.socket_fd, (struct sockaddr*)&client_addr, &addr_len);
    
    if (client_fd >= 0) {
        // Find empty client slot
        int slot = -1;
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            if (!ws_server.clients[i].connected) {
                slot = i;
                break;
            }
        }
        
        if (slot >= 0) {
            // Set client non-blocking
            int flags = fcntl(client_fd, F_GETFL, 0);
            if (flags != -1) {
                fcntl(client_fd, F_SETFL, flags | O_NONBLOCK);
            }
            
            // Initialize client
            ws_server.clients[slot].fd = client_fd;
            ws_server.clients[slot].connected = true;
            ws_server.clients[slot].handshake_complete = false;
            ws_server.clients[slot].last_ping_time = get_time_ms();
            ws_server.clients[slot].player_id = 0; // Will be assigned during handshake
            ws_server.clients[slot].recv_buf_len = 0;
            ws_server.clients[slot].frag_buf_len = 0;
            ws_server.clients[slot].frag_opcode = 0;
            inet_ntop(AF_INET, &client_addr.sin_addr, ws_server.clients[slot].ip_address, INET_ADDRSTRLEN);
            ws_server.clients[slot].port = ntohs(client_addr.sin_port);
            
            log_info("🔌 New WebSocket connection from %s:%u (slot %d, fd %d)", 
                     ws_server.clients[slot].ip_address, 
                     ws_server.clients[slot].port, 
                     slot, client_fd);
        } else {
            log_warn("❌ WebSocket server full (%d/%d), rejecting connection from %s:%u",
                     ws_server.client_count, WS_MAX_CLIENTS,
                     inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
            close(client_fd);
        }
    }
    
    // Process existing clients
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (!ws_server.clients[i].connected) continue;
        
        struct WebSocketClient* client = &ws_server.clients[i];
        /* Recv directly into the accumulation buffer at the current write offset
         * so no bytes are ever silently dropped (avoids TCP stream desync). */
        size_t avail = sizeof(client->recv_buf) - client->recv_buf_len;
        ssize_t received = (avail > 0)
            ? recv(client->fd, client->recv_buf + client->recv_buf_len, avail, 0)
            : 0;
        
        if (received > 0) {
            client->recv_buf_len += (size_t)received;
            
            if (!client->handshake_complete) {
                /* Null-terminate for string functions */
                if (client->recv_buf_len < sizeof(client->recv_buf))
                    client->recv_buf[client->recv_buf_len] = '\0';
                else
                    client->recv_buf[sizeof(client->recv_buf) - 1] = '\0';
                log_debug("📨 Received handshake request from %s:%u (%zd bytes)", 
                         client->ip_address, client->port, received);
                
                // Handle WebSocket handshake
                if (websocket_handshake(client->fd, client->recv_buf)) {
                    client->handshake_complete = true;
                    client->recv_buf_len = 0; /* clear - upgrade is done */
                    log_info("✅ WebSocket handshake successful for %s:%u", 
                            client->ip_address, client->port);
                } else {
                    log_error("❌ WebSocket handshake FAILED for %s:%u - closing connection", 
                             client->ip_address, client->port);
                    close(client->fd);
                    client->connected = false;
                }
            } else {
                /* recv_buf already has the new bytes; no copy needed */

                if (client->recv_buf_len < 2) continue; /* need at least a frame header */

                /* Process ALL complete frames currently in the accumulation buffer */
                while (client->recv_buf_len >= 2) {

                /* Peek at FIN bit before parse consumes the buffer position */
                bool ws_fin = (client->recv_buf[0] & 0x80) != 0;

                // Handle WebSocket frames
                char payload[4096];
                size_t payload_len = 0;
                size_t frame_size = 0;
                int opcode = websocket_parse_frame(client->recv_buf, client->recv_buf_len, payload, &payload_len, &frame_size);
                
                if (opcode < 0 || frame_size == 0) {
                    /* Incomplete frame — keep buffered data and wait for more */
                    if (client->recv_buf_len >= sizeof(client->recv_buf) - 1) {
                        /* recv_buf completely full with an unparseable frame —
                         * the frame must be larger than our buffer. Close connection. */
                        log_warn("recv_buf overflow for %s:%u (Player: %u), closing connection",
                                client->ip_address, client->port, client->player_id);
                        if (client->player_id > 0) {
                            remove_player(client->player_id);
                            client->player_id = 0;
                        }
                        close(client->fd);
                        client->connected = false;
                    }
                    break; /* wait for more TCP data */
                }

                /* Consume this frame from the accumulation buffer */
                memmove(client->recv_buf, client->recv_buf + frame_size,
                        client->recv_buf_len - frame_size);
                client->recv_buf_len -= frame_size;

                /* Handle WebSocket message fragmentation (RFC 6455 §5.4) */
                if (!ws_fin || opcode == WS_OPCODE_CONTINUATION) {
                    if (opcode == WS_OPCODE_CONTINUATION) {
                        /* Continuation frame — append payload to fragment buffer */
                        size_t fspace = sizeof(client->frag_buf) - client->frag_buf_len;
                        size_t fcopy  = payload_len < fspace ? payload_len : fspace;
                        memcpy(client->frag_buf + client->frag_buf_len, payload, fcopy);
                        client->frag_buf_len += fcopy;
                        if (!ws_fin) continue; /* more fragments coming */
                        /* FIN=1 on continuation — assemble full message */
                        size_t alen = client->frag_buf_len < sizeof(payload) - 1
                                      ? client->frag_buf_len : sizeof(payload) - 1;
                        memcpy(payload, client->frag_buf, alen);
                        payload[alen] = '\0';
                        payload_len = alen;
                        opcode = (int)client->frag_opcode;
                        client->frag_buf_len = 0;
                    } else {
                        /* FIN=0 on a data frame — first fragment */
                        client->frag_opcode = (uint8_t)opcode;
                        client->frag_buf_len = 0;
                        size_t fspace = sizeof(client->frag_buf);
                        size_t fcopy  = payload_len < fspace ? payload_len : fspace;
                        memcpy(client->frag_buf, payload, fcopy);
                        client->frag_buf_len = fcopy;
                        continue; /* wait for continuation frames */
                    }
                }
                
                // Frame received - processing
                
                if (opcode == WS_OPCODE_TEXT || opcode == WS_OPCODE_BINARY) {
                    
                    char response[1024];
                    bool handled = false;

                    // Check if message is JSON or text command
                    if (payload[0] == '{') {
                        // JSON message — extract "type" value once so branch conditions
                        // can use strcmp instead of strstr on the full payload.
                        char msg_type[64] = "";
                        {
                            const char* _tp = strstr(payload, "\"type\":\"");
                            if (_tp) {
                                _tp += 8; // skip past "type":"
                                int _ti = 0;
                                while (_ti < 63 && _tp[_ti] && _tp[_ti] != '"')
                                    { msg_type[_ti] = _tp[_ti]; _ti++; }
                                msg_type[_ti] = '\0';
                            }
                        }

                        if (strcmp(msg_type, "handshake") == 0) {
                            // Processing HANDSHAKE message
                            // Extract player name from handshake if provided
                            char player_name[32] = "Player";
                            char* name_start = strstr(payload, "\"playerName\":\"");
                            if (name_start) {
                                name_start += 14; // Skip past "playerName":"
                                char* name_end = strchr(name_start, '"');
                                if (name_end) {
                                    size_t name_len = name_end - name_start;
                                    if (name_len > 0 && name_len < sizeof(player_name) - 1) {
                                        strncpy(player_name, name_start, name_len);
                                        player_name[name_len] = '\0';
                                    }
                                }
                            }

                            // Sanitize the name extracted from JSON — strip non-ASCII-printable bytes
                            // so that no invalid UTF-8 can reach the JSON broadcast.
                            sanitize_player_name(player_name);

                            // If a JWT token is included, extract display_name from it
                            // (overrides playerName field; verified against JWT_SECRET if set)
                            char* tok_start = strstr(payload, "\"token\":\"");
                            if (tok_start) {
                                tok_start += 9;
                                char* tok_end = strchr(tok_start, '"');
                                if (tok_end) {
                                    size_t tok_len = (size_t)(tok_end - tok_start);
                                    char *jwt_buf = malloc(tok_len + 1);
                                    if (jwt_buf) {
                                        strncpy(jwt_buf, tok_start, tok_len);
                                        jwt_buf[tok_len] = '\0';
                                        char jwt_name[32] = {0};
                                        if (jwt_extract_display_name(jwt_buf, jwt_name, sizeof(jwt_name))) {
                                            strncpy(player_name, jwt_name, sizeof(player_name) - 1);
                                            player_name[sizeof(player_name) - 1] = '\0';
                                            sanitize_player_name(player_name);
                                        }
                                        free(jwt_buf);
                                    }
                                }
                            }
                            
                            // Check if client already has a player
                            if (client->player_id != 0) {
                                WebSocketPlayer* existing_player = find_player(client->player_id);
                                if (existing_player) {
                                    log_info("🤝 Client %s:%u reconnecting with existing player ID %u", 
                                             client->ip_address, client->port, client->player_id);
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"player_id\":%u,\"playerName\":\"%s\",\"server_time\":%u,\"status\":\"reconnected\"}",
                                            client->player_id, player_name, get_time_ms());
                                    handled = true;
                                } else {
                                    // Player ID exists but player not found - reset it
                                    log_warn("Client %s:%u had invalid player ID %u, resetting", 
                                             client->ip_address, client->port, client->player_id);
                                    client->player_id = 0;
                                }
                            }

                            // Kick any other active session with the same name (duplicate login)
                            if (!handled) {
                                for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                                    if (!players[pi].active) continue;
                                    if (strncmp(players[pi].name, player_name, sizeof(players[pi].name)) != 0) continue;
                                    uint32_t old_id = players[pi].player_id;
                                    log_info("👤 Duplicate login for '%s': kicking old session (player_id %u)",
                                             player_name, old_id);
                                    // Find and close the old client connection
                                    for (int ci2 = 0; ci2 < WS_MAX_CLIENTS; ci2++) {
                                        if (ws_server.clients[ci2].connected &&
                                            ws_server.clients[ci2].player_id == old_id) {
                                            // Send a kick notification before closing
                                            const char *kick_json =
                                                "{\"type\":\"kicked\",\"reason\":\"Logged in from another session\"}";
                                            size_t klen = strlen(kick_json);
                                            char kframe[256];
                                            size_t kflen = websocket_create_frame(
                                                WS_OPCODE_TEXT, kick_json, klen, kframe, sizeof(kframe));
                                            if (kflen > 0)
                                                (void)send(ws_server.clients[ci2].fd, kframe, kflen, 0);
                                            close(ws_server.clients[ci2].fd);
                                            ws_server.clients[ci2].connected = false;
                                            ws_server.clients[ci2].player_id = 0;
                                            break;
                                        }
                                    }
                                    // remove_player saves the data before clearing
                                    remove_player(old_id);
                                    break;
                                }
                            }
                            
                            if (client->player_id == 0 && !handled) {
                                // Handshake message - create new player
                                uint32_t player_id = next_player_id++;
                                client->player_id = player_id;
                                
                                // Create player for this client
                                WebSocketPlayer* player = create_player(player_id);
                                if (!player) {
                                    log_error("Failed to create player for client %s:%u", client->ip_address, client->port);
                                    client->player_id = 0; // Reset on failure
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"status\":\"error\",\"message\":\"Server full\"}");
                                    handled = true;
                                } else {
                                    // Set player name first so load can find the save file
                                    strncpy(player->name, player_name, sizeof(player->name) - 1);
                                    player->name[sizeof(player->name) - 1] = '\0';
                                    sanitize_player_name(player->name);

                                    // Restore persistent data (position, XP, inventory, etc.)
                                    bool resumed = load_player_from_file(player);

                                    // If position was restored, sync the sim entity position too
                                    if (resumed && global_sim && player->sim_entity_id != 0) {
                                        struct Player* sim_pl = sim_get_player(global_sim, player->sim_entity_id);
                                        if (sim_pl) {
                                            sim_pl->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(player->x));
                                            sim_pl->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(player->y));
                                        }
                                    }

                                    const char *join_status = resumed ? "resumed" : "connected";
                                    snprintf(response, sizeof(response),
                                            "{\"type\":\"handshake_response\",\"player_id\":%u,\"playerName\":\"%s\",\"server_time\":%u,\"status\":\"%s\"}",
                                            player_id, player_name, get_time_ms(), join_status);
                                    handled = true;
                                    log_info("🤝 WebSocket handshake from %s:%u (Player: %s, ID: %u, %s)", 
                                             client->ip_address, client->port, player_name, player_id, join_status);
                                }
                            }
                            
                            // Send initial game state after successful handshake
                            if (handled && client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    static char game_state_frame[32768];
                                    static char game_state_response[28000];
                                    
                                    // Build ships array for initial state (increased buffer for modules)
                                    static char ships_str[20000];
                                    int ships_offset = 0;
                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "[");
                                    
                                    bool first_ship = true;
                                    for (int s = 0; s < ship_count && ships_offset < (int)sizeof(ships_str) - 512; s++) {
                                        if (ships[s].active) {
                                            ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                    "%s{\"id\":%u,\"seq\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"ammo\":%u,\"infiniteAmmo\":%s,\"modules\":[",
                                                    first_ship ? "" : ",",
                                                    ships[s].ship_id, ships[s].ship_seq,
                                                    ships[s].x, ships[s].y, ships[s].rotation,
                                                    ships[s].velocity_x, ships[s].velocity_y,
                                                    ships[s].cannon_ammo, ships[s].infinite_ammo ? "true" : "false");
                                            
                                            // Add modules
                                            for (int m = 0; m < ships[s].module_count && ships_offset < (int)sizeof(ships_str) - 200; m++) {
                                                const ShipModule* module = &ships[s].modules[m];
                                                float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                                                float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                                                float module_rot = Q16_TO_FLOAT(module->local_rot);
                                                
                                                // Add module-specific data based on type
                                                if (module->type_id == MODULE_TYPE_MAST) {
                                                    // Mast: include openness, sail angle, wind efficiency, fiber HP
                                                    float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                                                    float wind_eff   = Q16_TO_FLOAT(module->data.mast.wind_efficiency);
                                                    float fh         = Q16_TO_FLOAT(module->data.mast.fiber_health);
                                                    float fhmax      = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f,\"windEfficiency\":%.3f,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f}",
                                                        m > 0 ? "," : "", module->id, module->type_id, 
                                                        module_x, module_y, module_rot, module->data.mast.openness, sail_angle, wind_eff, fh, fhmax);
                                                } else if (module->type_id == MODULE_TYPE_CANNON) {
                                                    // Cannon: include aim direction and state (ammo is ship-level now)
                                                    float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, aim_direction,
                                                        (unsigned)module->state_bits);
                                                } else if (module->type_id == MODULE_TYPE_SWIVEL) {
                                                    // Swivel: include current aim direction and state
                                                    float aim_dir = Q16_TO_FLOAT(module->data.swivel.aim_direction);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, aim_dir,
                                                        (unsigned)module->state_bits);
                                                } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                                                    // Helm: include wheel rotation, occupied status, state
                                                    float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, wheel_rot,
                                                        (module->data.helm.occupied_by != 0) ? "true" : "false",
                                                        (unsigned)module->state_bits);
                                                } else {
                                                    // Generic module (mast, ladder, etc.): transform + state
                                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset,
                                                        "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"state\":%u}",
                                                        m > 0 ? "," : "", module->id, module->type_id,
                                                        module_x, module_y, module_rot, (unsigned)module->state_bits);
                                                }
                                            }
                                            
                                            ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "]}");
                                            first_ship = false;
                                        }
                                    }
                                    ships_offset += snprintf(ships_str + ships_offset, sizeof(ships_str) - ships_offset, "]");
                                    
                                    log_info("📊 Initial game state: ships_str size=%d, buffer=%zu", 
                                             ships_offset, sizeof(ships_str));
                                    
                                    snprintf(game_state_response, sizeof(game_state_response),
                                            "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":%s,\"players\":[{\"id\":%u,\"name\":\"%s\","
                                            "\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,"
                                            "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"is_moving\":%s,"
                                            "\"movement_direction_x\":%.2f,\"movement_direction_y\":%.2f,"
                                            "\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\"}],\"projectiles\":[]}",
                                            get_time_ms() / 33, get_time_ms(), ships_str, 
                                            client->player_id, player->name, player->x, player->y, player->rotation,
                                            player->velocity_x, player->velocity_y,
                                            player->is_moving ? "true" : "false",
                                            player->movement_direction_x, player->movement_direction_y,
                                            player->parent_ship_id, player->local_x, player->local_y,
                                            get_state_string(player->movement_state));
                                    
                                    size_t response_len = strlen(game_state_response);
                                    log_info("📊 Game state response: %zu bytes (buffer: %zu bytes)", 
                                             response_len, sizeof(game_state_response));
                                    
                                    // Send handshake response first
                                    char frame[2048];  // Increased to match earlier fix
                                    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
                                    if (frame_len > 0 && frame_len < sizeof(frame)) {
                                        send(client->fd, frame, frame_len, 0);
                                    }
                                    
                                    // Then send game state
                                    size_t game_state_frame_len = websocket_create_frame(WS_OPCODE_TEXT, game_state_response, strlen(game_state_response), game_state_frame, sizeof(game_state_frame));
                                    if (game_state_frame_len > 0 && game_state_frame_len < sizeof(game_state_frame)) {
                                        send(client->fd, game_state_frame, game_state_frame_len, 0);
                                        // Sent initial game state
                                    }

                                    // Send ISLANDS so client can render island geometry
                                    {
                                        static char hs_islands_buf[600000];
                                        int hsi_pos = 0;
                                        hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos,
                                                            "{\"type\":\"ISLANDS\",\"islands\":[");
                                        for (int hii = 0; hii < ISLAND_COUNT; hii++) {
                                            const IslandDef *isl = &ISLAND_PRESETS[hii];
                                            hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos,
                                                                "%s{\"id\":%d,\"x\":%.1f,\"y\":%.1f,\"preset\":\"%s\"",
                                                                hii ? "," : "",
                                                                isl->id, isl->x, isl->y, isl->preset);
                                            if (isl->vertex_count > 0) {
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, ",\"vertices\":[");
                                                for (int vi = 0; vi < isl->vertex_count; vi++) {
                                                    hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos,
                                                                        "%s{\"x\":%.1f,\"y\":%.1f}",
                                                                        vi ? "," : "",
                                                                        isl->x + isl->vx[vi], isl->y + isl->vy[vi]);
                                                }
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, "]");
                                            }
                                            if (isl->grass_vertex_count > 0) {
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, ",\"grassVertices\":[");
                                                for (int vi = 0; vi < isl->grass_vertex_count; vi++) {
                                                    hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos,
                                                                        "%s{\"x\":%.1f,\"y\":%.1f}",
                                                                        vi ? "," : "",
                                                                        isl->x + isl->gvx[vi], isl->y + isl->gvy[vi]);
                                                }
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, "]");
                                            }
                                            if (isl->shallow_vertex_count > 0) {
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, ",\"shallowVertices\":[");
                                                for (int vi = 0; vi < isl->shallow_vertex_count; vi++) {
                                                    hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos,
                                                                        "%s{\"x\":%.1f,\"y\":%.1f}",
                                                                        vi ? "," : "",
                                                                        isl->x + isl->svx[vi], isl->y + isl->svy[vi]);
                                                }
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, "]");
                                            }
                                            if (isl->shallow_poly_scale > 0.0f) {
                                                /* shallowPolyScale removed — no longer used by client */
                                                (void)isl->shallow_poly_scale;
                                            }
                                            hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, ",\"resources\":[");
                                            for (int hri = 0; hri < isl->resource_count; hri++) {
                                                const IslandResource *r = &isl->resources[hri];
                                                hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos,
                                                                    "%s{\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"type\":\"%s\",\"size\":%.3f,\"hp\":%d,\"maxHp\":%d}",
                                                                    hri ? "," : "",
                                                                    hri, r->ox, r->oy, res_type_str(r->type_id), r->size, r->health, r->max_health);
                                            }
                                            hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, "]}");
                                        }
                                        hsi_pos += snprintf(hs_islands_buf + hsi_pos, sizeof(hs_islands_buf) - hsi_pos, "]}");
                                        static char hs_isl_frame[600000];
                                        size_t hs_isl_len = websocket_create_frame(
                                            WS_OPCODE_TEXT, hs_islands_buf, (size_t)hsi_pos,
                                            hs_isl_frame, sizeof(hs_isl_frame));
                                        if (hs_isl_len > 0 && hs_isl_len < sizeof(hs_isl_frame)) {
                                            send_all(client->fd, hs_isl_frame, hs_isl_len);
                                            log_info("🏝️  Sent ISLANDS to JSON-handshake player %u (payload=%d bytes)", client->player_id, hsi_pos);
                                        } else {
                                            log_error("❌ ISLANDS frame creation failed: payload=%d, frame_len=%zu", hsi_pos, hs_isl_len);
                                        }
                                    }

                                    // Send current placed structures
                                    {
                                        static char hs_structs_buf[8192];
                                        int hs_sp = 0;
                                        hs_sp += snprintf(hs_structs_buf + hs_sp, sizeof(hs_structs_buf) - hs_sp,
                                                          "{\"type\":\"STRUCTURES\",\"structures\":[");
                                        bool hs_sfirst = true;
                                        for (uint32_t si = 0; si < placed_structure_count; si++) {
                                            if (!placed_structures[si].active) continue;
                                        const char* hs_stype =
                                            placed_structures[si].type == STRUCT_WOODEN_FLOOR ? "wooden_floor" :
                                            placed_structures[si].type == STRUCT_WORKBENCH    ? "workbench" :
                                            placed_structures[si].type == STRUCT_WALL         ? "wall" :
                                            placed_structures[si].type == STRUCT_DOOR_FRAME   ? "door_frame" :
                                            placed_structures[si].type == STRUCT_DOOR         ? "door" :
                                            placed_structures[si].type == STRUCT_SHIPYARD     ? "shipyard" : "unknown";
                                        bool hs_is_door = (placed_structures[si].type == STRUCT_DOOR);
                                        bool hs_is_sy   = (placed_structures[si].type == STRUCT_SHIPYARD);
                                        /* Build extra fields for shipyard construction state */
                                        char hs_sy_extra[256] = "";
                                        if (hs_is_sy) {
                                            char hs_mj[128] = "[]";
                                            if (placed_structures[si].modules_placed) {
                                                int hm = 0;
                                                hs_mj[hm++] = '[';
                                                const char* hmn[6] = {"hull_left","hull_right","deck","mast","cannon_port","cannon_stbd"};
                                                bool hmf = true;
                                                for (int b = 0; b < 6; b++) {
                                                    if (placed_structures[si].modules_placed & (1u << b)) {
                                                        if (!hmf) hs_mj[hm++] = ',';
                                                        hm += snprintf(hs_mj + hm, (int)sizeof(hs_mj) - hm, "\"%s\"", hmn[b]);
                                                        hmf = false;
                                                    }
                                                }
                                                hs_mj[hm++] = ']';
                                                hs_mj[hm]   = '\0';
                                            }
                                            const char* hs_phase = placed_structures[si].construction_phase == CONSTRUCTION_BUILDING ? "building" : "empty";
                                            snprintf(hs_sy_extra, sizeof(hs_sy_extra),
                                                     ",\"construction_phase\":\"%s\",\"modules_placed\":%s",
                                                     hs_phase, hs_mj);
                                        }
                                        hs_sp += snprintf(hs_structs_buf + hs_sp, sizeof(hs_structs_buf) - hs_sp,
                                                          "%s{\"id\":%u,\"structure_type\":\"%s\","
                                                          "\"island_id\":%u,\"x\":%.1f,\"y\":%.1f,"
                                                          "\"company_id\":%u,\"hp\":%u,\"max_hp\":%u,\"placer_name\":\"%s\""
                                                          ",\"rotation\":%.2f%s%s}",
                                                          hs_sfirst ? "" : ",",
                                                          placed_structures[si].id, hs_stype,
                                                          placed_structures[si].island_id,
                                                          placed_structures[si].x, placed_structures[si].y,
                                                          (unsigned)placed_structures[si].company_id,
                                                          (unsigned)placed_structures[si].hp,
                                                          (unsigned)placed_structures[si].max_hp,
                                                          placed_structures[si].placer_name,
                                                          placed_structures[si].rotation,
                                                          hs_is_door ? (placed_structures[si].open ? ",\"open\":true" : ",\"open\":false") : "",
                                                          hs_sy_extra);
                                            hs_sfirst = false;
                                        }
                                        hs_sp += snprintf(hs_structs_buf + hs_sp, sizeof(hs_structs_buf) - hs_sp, "]}");
                                        char hs_sf[8448];
                                        size_t hs_sflen = websocket_create_frame(
                                            WS_OPCODE_TEXT, hs_structs_buf, (size_t)hs_sp,
                                            hs_sf, sizeof(hs_sf));
                                        if (hs_sflen > 0 && hs_sflen < sizeof(hs_sf))
                                            send(client->fd, hs_sf, hs_sflen, 0);
                                        log_info("📦 Sent STRUCTURES (%u) to JSON-handshake player %u",
                                                 placed_structure_count, client->player_id);
                                    }

                                    // Skip normal response sending since we already sent
                                    ws_server.packets_sent += 2;
                                    ws_server.packets_received++;
                                    continue;
                                }
                            }
                            
                        } else if (strcmp(msg_type, "input_frame") == 0) {
                            // Input frame message - parse movement data
                            ws_server.input_messages_received++;
                            ws_server.last_input_time = get_time_ms();
                            
                            if (client->player_id == 0) {
                                log_warn("Input frame from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse rotation from input frame
                                    float rotation = 0.0f;
                                    char* rotation_start = strstr(payload, "\"rotation\":");
                                    if (rotation_start) {
                                        sscanf(rotation_start + 11, "%f", &rotation);
                                    }
                                    
                                    // Simple JSON parsing for movement (basic implementation)
                                    char* movement_start = strstr(payload, "\"movement\":{");
                                    if (movement_start) {
                                        float x = 0.0f, y = 0.0f;
                                        char* x_start = strstr(movement_start, "\"x\":");
                                        char* y_start = strstr(movement_start, "\"y\":");
                                        
                                        if (x_start) sscanf(x_start + 4, "%f", &x);
                                        if (y_start) sscanf(y_start + 4, "%f", &y);
                                        
                                        // Validate movement values
                                        if (x < -1.0f) x = -1.0f;
                                        if (x > 1.0f) x = 1.0f;
                                        if (y < -1.0f) y = -1.0f;
                                        if (y > 1.0f) y = 1.0f;
                                        
                                        // Validate rotation (should be in [-π, π])
                                        if (rotation < -M_PI) rotation = -M_PI;
                                        if (rotation > M_PI) rotation = M_PI;
                                        
                                        // Store movement state for tick-based processing
                                        // (Don't apply movement immediately - let websocket_server_tick handle it)
                                        player->movement_direction_x = x;
                                        player->movement_direction_y = y;
                                        player->is_moving = (x != 0.0f || y != 0.0f);
                                        player->is_sprinting = (strstr(payload, "\"is_sprinting\":true") != NULL);
                                        player->rotation = rotation;
                                        player->last_input_time = get_time_ms();
                                        
                                        // Log player input (silenced for debugging)
                                        // log_info("🎮 INPUT[P%u]: movement(%.2f, %.2f) rotation=%.2f° moving=%d",
                                        //         player->player_id, x, y, rotation * (180.0f / M_PI), player->is_moving);
                                        
                                        // Track movement for adaptive tick rate
                                        if (player->is_moving) {
                                            update_movement_activity();
                                        }
                                        
                                        // Player input processed
                                    } else {
                                        log_warn("Invalid input frame format from player %u", client->player_id);
                                    }
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"input_received\"}");
                                } else {
                                    log_warn("Input frame for non-existent player %u from %s:%u", 
                                             client->player_id, client->ip_address, client->port);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "movement_state") == 0) {
                            // HYBRID: Movement state change message
                            ws_server.input_messages_received++;
                            ws_server.last_input_time = get_time_ms();
                            
                            if (client->player_id == 0) {
                                log_warn("Movement state from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse movement direction
                                    float x = 0.0f, y = 0.0f;
                                    char* movement_start = strstr(payload, "\"movement\":{");
                                    if (movement_start) {
                                        char* x_start = strstr(movement_start, "\"x\":");
                                        char* y_start = strstr(movement_start, "\"y\":");
                                        if (x_start) sscanf(x_start + 4, "%f", &x);
                                        if (y_start) sscanf(y_start + 4, "%f", &y);
                                    }
                                    
                                    // Parse is_moving flag
                                    bool is_moving = false;
                                    if (strstr(payload, "\"is_moving\":true")) {
                                        is_moving = true;
                                    }
                                    
                                    // Validate movement values
                                    if (x < -1.0f) x = -1.0f;
                                    if (x > 1.0f) x = 1.0f;
                                    if (y < -1.0f) y = -1.0f;
                                    if (y > 1.0f) y = 1.0f;
                                    
                                    // Update player's movement state (NOT apply movement yet - that happens every tick)
                                    player->movement_direction_x = x;
                                    player->movement_direction_y = y;
                                    player->is_moving = is_moving;
                                    player->is_sprinting = (strstr(payload, "\"is_sprinting\":true") != NULL);
                                    player->last_input_time = get_time_ms();
                                    
                                    // Log movement state change (silenced for debugging)
                                    // log_info("🚶 MOVEMENT_STATE[P%u]: direction(%.2f, %.2f) is_moving=%d",
                                    //         player->player_id, x, y, is_moving);
                                    
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"state_updated\"}");
                                } else {
                                    log_warn("Movement state for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "rotation_update") == 0) {
                            // HYBRID: Rotation update message
                            
                            if (client->player_id == 0) {
                                log_warn("Rotation update from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse rotation
                                    float rotation = 0.0f;
                                    char* rotation_start = strstr(payload, "\"rotation\":");
                                    if (rotation_start) {
                                        sscanf(rotation_start + 11, "%f", &rotation);
                                    }
                                    
                                    // Validate rotation (should be in [-π, π])
                                    if (rotation < -M_PI) rotation = -M_PI;
                                    if (rotation > M_PI) rotation = M_PI;
                                    
                                    // Update player rotation
                                    player->last_rotation = player->rotation;
                                    player->rotation = rotation;
                                    player->last_rotation_update_time = get_time_ms();
                                    
                                    // Log rotation update (silenced for debugging)
                                    // log_info("🔄 ROTATION[P%u]: %.2f° (%.4f rad)",
                                    //         player->player_id, rotation * (180.0f / M_PI), rotation);
                                    
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"rotation_updated\"}");
                                } else {
                                    log_warn("Rotation update for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "module_interact") == 0) {
                            // MODULE_INTERACT message
                            log_info("🎮 Processing MODULE_INTERACT from player %u", client->player_id);
                            
                            if (client->player_id == 0) {
                                log_warn("Module interact from client %s:%u with no player ID", client->ip_address, client->port);
                                send_interaction_failure(client, "no_player");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_module_interact(player, client, payload);
                                } else {
                                    log_warn("Module interact for non-existent player %u", client->player_id);
                                    send_interaction_failure(client, "player_not_found");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "module_unmount") == 0) {
                            // MODULE_UNMOUNT message
                            // log_info("🔓 Processing MODULE_UNMOUNT message");
                            
                            if (client->player_id == 0) {
                                log_warn("Module unmount from client %s:%u with no player ID", client->ip_address, client->port);
                                send_interaction_failure(client, "no_player");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_module_unmount(player, client);
                                } else {
                                    log_warn("Module unmount for non-existent player %u", client->player_id);
                                    send_interaction_failure(client, "player_not_found");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "harvest_resource") == 0) {
                            // HARVEST RESOURCE: player presses E with axe near a tree
                            if (client->player_id == 0) {
                                log_warn("harvest_resource from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"harvest_failure\",\"reason\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_harvest_resource(player, client);
                                } else {
                                    log_warn("harvest_resource for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"harvest_failure\",\"reason\":\"player_not_found\"}");
                                }
                                handled = true;
                            }

                        } else if (strcmp(msg_type, "harvest_fiber") == 0) {
                            // HARVEST FIBER: player presses E near a fiber plant
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_harvest_fiber(player, client);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "harvest_rock") == 0) {
                            // HARVEST ROCK: player presses E with pickaxe near a rock
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_harvest_rock(player, client);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "collect_tombstone") == 0) {
                            // TOMBSTONE: take-all (legacy / "Take All" button)
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_collect_tombstone(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "tombstone_open") == 0) {
                            // TOMBSTONE MENU: player opened the tombstone storage UI
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_tombstone_open(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "tombstone_take_slot") == 0) {
                            // TOMBSTONE MENU: player dragged/clicked one slot from the tombstone
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_tombstone_take_slot(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_structure") == 0) {
                            // ISLAND BUILDING: place a floor tile or workbench
                            if (client->player_id == 0) {
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_place_structure(player, client, payload);
                                handled = true;
                            }

                        } else if (strcmp(msg_type, "structure_interact") == 0) {
                            // ISLAND BUILDING: E-key on placed structure (open workbench)
                            if (client->player_id == 0) {
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_structure_interact(player, client, payload);
                                handled = true;
                            }

                        } else if (strcmp(msg_type, "demolish_structure") == 0) {
                            // Hold E: demolish a placed structure
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_demolish_structure(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "demolish_module") == 0) {
                            // Axe + E: remove a ship module permanently
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_demolish_module(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "respawn_request") == 0) {
                            // Player chose a spawn location on the respawn screen
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->health == 0) {
                                    // Restore full health
                                    player->health = player->max_health;

                                    // Parse optional shipId
                                    uint32_t ship_id = 0;
                                    const char* p_sid = strstr(payload, "\"shipId\":");
                                    if (p_sid) ship_id = (uint32_t)atoi(p_sid + 9);

                                    if (ship_id != 0) {
                                        // Spawn aboard a friendly ship
                                        SimpleShip* target_ship = NULL;
                                        for (int si = 0; si < MAX_SIMPLE_SHIPS; si++) {
                                            if (ships[si].ship_id == ship_id) {
                                                target_ship = &ships[si];
                                                break;
                                            }
                                        }
                                        if (target_ship) {
                                            board_player_on_ship(player, target_ship, 0.0f, 0.0f);
                                            log_info("⚔️  Player %u respawned on ship %u", player->player_id, ship_id);
                                        } else {
                                            // Ship not found — fall back to world spawn
                                            player->x = 800.0f;
                                            player->y = 600.0f;
                                            player->parent_ship_id = 0;
                                            player->movement_state = PLAYER_STATE_SWIMMING;
                                            // Sync sim entity so the tick loop doesn't snap the player back
                                            if (global_sim && player->sim_entity_id != 0) {
                                                struct Player* sp = sim_get_player(global_sim, player->sim_entity_id);
                                                if (sp) {
                                                    sp->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(player->x));
                                                    sp->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(player->y));
                                                    sp->velocity.x = 0; sp->velocity.y = 0;
                                                }
                                            }
                                            log_warn("⚔️  Respawn ship %u not found — spawning at world origin", ship_id);
                                        }
                                    } else {
                                        // Spawn at provided world coordinates, island, or default
                                        float spawn_x = 800.0f, spawn_y = 600.0f;

                                        // Check for islandId — pick a random point on that island
                                        const char* p_iid = strstr(payload, "\"islandId\":");
                                        if (p_iid) {
                                            int island_id = atoi(p_iid + 11);
                                            IslandDef *isl = NULL;
                                            for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                                                if (ISLAND_PRESETS[ii].id == island_id) {
                                                    isl = &ISLAND_PRESETS[ii];
                                                    break;
                                                }
                                            }
                                            if (isl) {
                                                if (isl->vertex_count > 0 && isl->grass_vertex_count > 0) {
                                                    // Polygon island — rejection sampling within explicit grass poly
                                                    float bound = 0.0f;
                                                    for (int vi = 0; vi < isl->grass_vertex_count; vi++) {
                                                        float r = sqrtf(isl->gvx[vi]*isl->gvx[vi] + isl->gvy[vi]*isl->gvy[vi]);
                                                        if (r > bound) bound = r;
                                                    }
                                                    int attempts = 0;
                                                    do {
                                                        float rx = ((float)rand() / (float)RAND_MAX) * 2.0f * bound - bound;
                                                        float ry = ((float)rand() / (float)RAND_MAX) * 2.0f * bound - bound;
                                                        float wx = isl->x + rx, wy = isl->y + ry;
                                                        int n = isl->grass_vertex_count, inside = 0;
                                                        for (int vi = 0, vj = n - 1; vi < n; vj = vi++) {
                                                            float xi = isl->x + isl->gvx[vi], yi = isl->y + isl->gvy[vi];
                                                            float xj = isl->x + isl->gvx[vj], yj = isl->y + isl->gvy[vj];
                                                            if (((yi > wy) != (yj > wy)) &&
                                                                (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi))
                                                                inside = !inside;
                                                        }
                                                        if (inside) { spawn_x = wx; spawn_y = wy; break; }
                                                    } while (++attempts < 200);
                                                } else if (isl->vertex_count > 0) {
                                                    // Polygon island without explicit grass — spawn within sand polygon
                                                    float bound = isl->poly_bound_r;
                                                    int attempts = 0;
                                                    do {
                                                        float rx = ((float)rand() / (float)RAND_MAX) * 2.0f * bound - bound;
                                                        float ry = ((float)rand() / (float)RAND_MAX) * 2.0f * bound - bound;
                                                        float wx = isl->x + rx, wy = isl->y + ry;
                                                        int n = isl->vertex_count, inside = 0;
                                                        for (int vi = 0, vj = n - 1; vi < n; vj = vi++) {
                                                            float xi = isl->x + isl->vx[vi], yi = isl->y + isl->vy[vi];
                                                            float xj = isl->x + isl->vx[vj], yj = isl->y + isl->vy[vj];
                                                            if (((yi > wy) != (yj > wy)) &&
                                                                (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi))
                                                                inside = !inside;
                                                        }
                                                        if (inside) { spawn_x = wx; spawn_y = wy; break; }
                                                    } while (++attempts < 200);
                                                } else {
                                                    // Circular island — random point within inner grass radius
                                                    float r_max = isl->grass_radius_px - isl->grass_max_bump;
                                                    if (r_max < 10.0f) r_max = 10.0f;
                                                    float angle = ((float)rand() / (float)RAND_MAX) * 6.2831853f;
                                                    float dist  = sqrtf((float)rand() / (float)RAND_MAX) * r_max;
                                                    spawn_x = isl->x + cosf(angle) * dist;
                                                    spawn_y = isl->y + sinf(angle) * dist;
                                                }
                                                log_info("⚔️  Player %u respawning on island %d at (%.1f, %.1f)",
                                                    player->player_id, island_id, spawn_x, spawn_y);
                                            }
                                        } else {
                                            const char* p_x = strstr(payload, "\"worldX\":");
                                            const char* p_y = strstr(payload, "\"worldY\":");
                                            if (p_x) spawn_x = strtof(p_x + 9, NULL);
                                            if (p_y) spawn_y = strtof(p_y + 9, NULL);
                                        }
                                        player->x = spawn_x;
                                        player->y = spawn_y;
                                        player->parent_ship_id = 0;
                                        player->movement_state = PLAYER_STATE_SWIMMING;
                                        // Sync sim entity so the tick loop doesn't snap the player back
                                        if (global_sim && player->sim_entity_id != 0) {
                                            struct Player* sp = sim_get_player(global_sim, player->sim_entity_id);
                                            if (sp) {
                                                sp->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(spawn_x));
                                                sp->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(spawn_y));
                                                sp->velocity.x = 0; sp->velocity.y = 0;
                                            }
                                        }
                                        log_info("⚔️  Player %u respawned at world (%.1f, %.1f)", player->player_id, spawn_x, spawn_y);
                                    }

                                    // Broadcast a teleport event so clients update this player's position
                                    char tp_msg[256];
                                    snprintf(tp_msg, sizeof(tp_msg),
                                        "{\"type\":\"player_teleported\",\"player_id\":%u,"
                                        "\"x\":%.1f,\"y\":%.1f,\"parent_ship\":%u,"
                                        "\"local_x\":%.1f,\"local_y\":%.1f}",
                                        player->player_id, player->x, player->y,
                                        player->parent_ship_id, player->local_x, player->local_y);
                                    websocket_server_broadcast(tp_msg);

                                    // Persist new position so relog doesn't load pre-death location
                                    save_player_to_file(player);
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "shipyard_action") == 0) {
                            // Ship construction: craft_skeleton / add_module / release_ship
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_shipyard_action(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "craft_item") == 0) {
                            // Craft a recipe at a workbench
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) handle_craft_item(player, client, payload);
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "action_event") == 0) {
                            // HYBRID: Action event message
                            // log_info("⚡ Processing ACTION_EVENT message");
                            
                            if (client->player_id == 0) {
                                log_warn("Action event from client %s:%u with no player ID", client->ip_address, client->port);
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse action type
                                    char action[32] = {0};
                                    char* action_start = strstr(payload, "\"action\":\"");
                                    if (action_start) {
                                        action_start += 10; // Skip past "action":"
                                        int i = 0;
                                        while (i < 31 && action_start[i] != '"' && action_start[i] != '\0') {
                                            action[i] = action_start[i];
                                            i++;
                                        }
                                        action[i] = '\0';
                                    }
                                    
                                    // log_info("⚡ Player %u action: %s", player->player_id, action);
                                    
                                    response[0] = '\0'; /* prevent action_processed from overwriting per-action responses */
                                    // Process action immediately (no state persistence)
                                    if (strcmp(action, "fire_cannon") == 0) {
                                        // TODO: Implement cannon firing
                                        log_info("💥 Player %u fired cannon!", player->player_id);
                                    } else if (strcmp(action, "jump") == 0) {
                                        // Jump action - dismount from ship if on one
                                        if (player->parent_ship_id != 0) {
                                            log_info("🦘 Player %u jumped off ship %u!", player->player_id, player->parent_ship_id);
                                            dismount_player_from_ship(player, "jumped");
                                            
                                            // Send state update to player
                                            char jump_response[256];
                                            snprintf(jump_response, sizeof(jump_response),
                                                    "{\"type\":\"player_state_changed\",\"player_id\":%u,\"state\":\"swimming\",\"ship_id\":0}",
                                                    player->player_id);
                                            
                                            char jump_frame[512];
                                            size_t jump_frame_len = websocket_create_frame(WS_OPCODE_TEXT, jump_response, 
                                                                                          strlen(jump_response), jump_frame, sizeof(jump_frame));
                                            if (jump_frame_len > 0) {
                                                send(client->fd, jump_frame, jump_frame_len, 0);
                                            }
                                            
                                            // Broadcast to other players
                                            websocket_server_broadcast(jump_response);
                                        } else {
                                            log_info("🦘 Player %u jumped (already in water)", player->player_id);
                                        }
                                    } else if (strcmp(action, "dismount") == 0) {
                                        // Dismount from helm / cannon / seat
                                        if (player->is_mounted) {
                                            handle_module_unmount(player, client);
                                        } else {
                                            log_info("🔓 Player %u dismount request ignored (not mounted)", player->player_id);
                                            send_interaction_failure(client, "not_mounted");
                                        }
                                    } else if (strcmp(action, "interact") == 0) {
                                        // Check proximity to world NPCs
                                        bool interacted = false;
                                        for (int n = 0; n < world_npc_count && !interacted; n++) {
                                            WorldNpc* npc = &world_npcs[n];
                                            if (!npc->active) continue;
                                            float dx = player->x - npc->x;
                                            float dy = player->y - npc->y;
                                            float dist_sq = dx * dx + dy * dy;
                                            float r = npc->interact_radius;
                                            if (dist_sq <= r * r) {
                                                log_info("💬 Player %u interacted with NPC %u (%s)",
                                                         player->player_id, npc->id, npc->name);
                                                char npc_msg[312];
                                                snprintf(npc_msg, sizeof(npc_msg),
                                                    "{\"type\":\"npc_dialogue\",\"npc_id\":%u,"
                                                    "\"npc_name\":\"%s\",\"text\":\"%s\"}",
                                                    npc->id, npc->name, npc->dialogue);
                                                char npc_frame[512];
                                                size_t npc_len = websocket_create_frame(
                                                    WS_OPCODE_TEXT, npc_msg, strlen(npc_msg),
                                                    npc_frame, sizeof(npc_frame));
                                                if (npc_len > 0)
                                                    send(client->fd, npc_frame, npc_len, 0);
                                                interacted = true;
                                            }
                                        }
                                        if (!interacted) {
                                            log_info("🤝 Player %u interacted (no NPC in range)", player->player_id);
                                        }
                                    } else if (strcmp(action, "attack") == 0) {
                                        // Walking melee attack — reject if mounted
                                        if (player->is_mounted) {
                                            log_warn("⚔️ Player %u attack rejected (mounted)", player->player_id);
                                        } else {
                                            // Parse target position from "target":{x,y}
                                            float target_x = player->x;
                                            float target_y = player->y;
                                            char* target_start = strstr(payload, "\"target\":{");
                                            if (target_start) {
                                                char* xp = strstr(target_start, "\"x\":");
                                                char* yp = strstr(target_start, "\"y\":");
                                                if (xp) target_x = strtof(xp + 4, NULL);
                                                if (yp) target_y = strtof(yp + 4, NULL);
                                            }

                                            // ── Sword attack ──────────────────────────────
                                            uint8_t aslot = player->inventory.active_slot;
                                            bool holding_sword = (aslot < INVENTORY_SLOTS &&
                                                player->inventory.slots[aslot].item == ITEM_SWORD &&
                                                player->inventory.slots[aslot].quantity > 0);

                                            if (holding_sword) {
                                                const uint32_t SWORD_COOLDOWN_MS = 1000u;
                                                uint32_t now_ms = get_time_ms();
                                                if (now_ms - player->sword_last_attack_ms < SWORD_COOLDOWN_MS) {
                                                    log_warn("Player %u sword attack rejected: on cooldown", player->player_id);
                                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"sword_cooldown\"}");
                                                    goto sword_attack_done;
                                                }
                                                player->sword_last_attack_ms = now_ms;

                                                const float SWORD_RANGE  = 45.0f;
                                                const float SWORD_RANGE2 = SWORD_RANGE * SWORD_RANGE;
                                                // Base 30 damage, +10% per stat_damage point (mirrors NPC stat)
                                                const float SWORD_DAMAGE = 30.0f * (1.0f + 0.1f * (float)player->stat_damage);

                                                // Direction vector toward target
                                                float atk_dx = target_x - player->x;
                                                float atk_dy = target_y - player->y;
                                                float atk_len = sqrtf(atk_dx*atk_dx + atk_dy*atk_dy);
                                                if (atk_len < 0.1f) { atk_dx = 1.0f; atk_dy = 0.0f; }
                                                else { atk_dx /= atk_len; atk_dy /= atk_len; }
                                                float atk_angle = atan2f(atk_dy, atk_dx);

                                                // ── Hit NPCs ──────────────────────────────
                                                for (int ni = 0; ni < world_npc_count; ni++) {
                                                    WorldNpc* tnpc = &world_npcs[ni];
                                                    if (!tnpc->active) continue;
                                    // No friendly fire: skip NPCs of the same company
                                    if (player->company_id != 0 &&
                                        tnpc->company_id == player->company_id) continue;
                                                    float nx = tnpc->x - player->x;
                                                    float ny = tnpc->y - player->y;
                                                    if (nx*nx + ny*ny > SWORD_RANGE2) continue;

                                                    // 120-degree arc (±60°)
                                                    float npc_angle = atan2f(ny, nx);
                                                    float diff = npc_angle - atk_angle;
                                                    while (diff >  (float)M_PI) diff -= 2.0f*(float)M_PI;
                                                    while (diff < -(float)M_PI) diff += 2.0f*(float)M_PI;
                                                    if (fabsf(diff) > (float)M_PI / 3.0f * 2.0f) continue;

                                                    uint16_t dmg16 = (uint16_t)SWORD_DAMAGE;
                                                    bool killed_npc = false;
                                                    if (tnpc->health <= dmg16) {
                                                        tnpc->health = 0;
                                                        tnpc->active = false;
                                                        killed_npc = true;
                                                        // Award XP to the attacker
                                                        player_apply_xp(player, PLAYER_XP_PER_NPC_KILL);
                                                    } else {
                                                        tnpc->health -= dmg16;
                                                    }

                                                    // Small knockback impulse
                                                    float dist = sqrtf(nx*nx + ny*ny);
                                                    float kx = (dist > 0.1f) ? (nx/dist) : atk_dx;
                                                    float ky = (dist > 0.1f) ? (ny/dist) : atk_dy;
                                                    tnpc->velocity_x += kx * 30.0f;
                                                    tnpc->velocity_y += ky * 30.0f;

                                                    char hit_msg[256];
                                                    snprintf(hit_msg, sizeof(hit_msg),
                                                        "{\"type\":\"ENTITY_HIT\",\"entityType\":\"npc\",\"id\":%u,"
                                                        "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                                                        "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                                                        tnpc->id, tnpc->x, tnpc->y, SWORD_DAMAGE,
                                                        (unsigned)tnpc->health, (unsigned)tnpc->max_health,
                                                        killed_npc ? "true" : "false");
                                                    websocket_server_broadcast(hit_msg);

                                                    log_info("⚔️  Player %u sword hit NPC %u (HP %u/%u)%s",
                                                             player->player_id, tnpc->id,
                                                             (unsigned)tnpc->health, (unsigned)tnpc->max_health,
                                                             killed_npc ? " KILLED" : "");
                                                }

                                                // ── Hit Players (PvP) ─────────────────────
                                                for (int wpi = 0; wpi < WS_MAX_CLIENTS; wpi++) {
                                                    WebSocketPlayer* tp = &players[wpi];
                                                    if (!tp->active || tp->player_id == player->player_id) continue;
                                    // No friendly fire: skip players of the same company
                                    if (player->company_id != 0 &&
                                        tp->company_id == player->company_id) continue;
                                                    float px2 = tp->x - player->x;
                                                    float py2 = tp->y - player->y;
                                                    if (px2*px2 + py2*py2 > SWORD_RANGE2) continue;

                                                    float p_angle = atan2f(py2, px2);
                                                    float pdiff   = p_angle - atk_angle;
                                                    while (pdiff >  (float)M_PI) pdiff -= 2.0f*(float)M_PI;
                                                    while (pdiff < -(float)M_PI) pdiff += 2.0f*(float)M_PI;
                                                    if (fabsf(pdiff) > (float)M_PI / 3.0f * 2.0f) continue;

                                                    uint16_t dmg16 = (uint16_t)SWORD_DAMAGE;
                                                    bool killed_player = (tp->health <= dmg16);
                                                    if (killed_player) tp->health = 0;
                                                    else tp->health -= dmg16;
                                                    // Award XP to the attacker on kill
                                                    if (killed_player) {
                                                        player_apply_xp(player, PLAYER_XP_PER_PLAYER_KILL);
                                                        player_die(tp);  /* drop tombstone, wipe inv */
                                                    }

                                                    char hit_msg[256];
                                                    snprintf(hit_msg, sizeof(hit_msg),
                                                        "{\"type\":\"ENTITY_HIT\",\"entityType\":\"player\",\"id\":%u,"
                                                        "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                                                        "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                                                        tp->player_id, tp->x, tp->y, SWORD_DAMAGE,
                                                        (unsigned)tp->health, (unsigned)tp->max_health,
                                                        killed_player ? "true" : "false");
                                                    websocket_server_broadcast(hit_msg);
                                                }

                                                // Broadcast sword swing (for client animation)
                                                char swing_msg[256];
                                                snprintf(swing_msg, sizeof(swing_msg),
                                                    "{\"type\":\"SWORD_SWING\",\"playerId\":%u,"
                                                    "\"x\":%.1f,\"y\":%.1f,\"angle\":%.3f,\"range\":%.0f}",
                                                    player->player_id, player->x, player->y,
                                                    atk_angle, SWORD_RANGE);
                                                websocket_server_broadcast(swing_msg);

                                            } else {
                                                // Unarmed / generic attack broadcast
                                                char attack_msg[256];
                                                snprintf(attack_msg, sizeof(attack_msg),
                                                    "{\"type\":\"player_attack\",\"player_id\":%u,"
                                                    "\"target_x\":%.2f,\"target_y\":%.2f}",
                                                    player->player_id, target_x, target_y);
                                                websocket_server_broadcast(attack_msg);
                                            }
                                        }
                                        sword_attack_done:;
                                    } else if (strcmp(action, "block") == 0) {
                                        // Walking block — reject if mounted
                                        if (player->is_mounted) {
                                            log_warn("🛡️ Player %u block rejected (mounted)", player->player_id);
                                        } else {
                                            log_info("🛡️ Player %u is blocking!", player->player_id);
                                            char block_msg[128];
                                            snprintf(block_msg, sizeof(block_msg),
                                                "{\"type\":\"player_block\",\"player_id\":%u}",
                                                player->player_id);
                                            websocket_server_broadcast(block_msg);
                                        }
                                    }
                                    
                                    if (response[0] == '\0') strcpy(response, "{\"type\":\"message_ack\",\"status\":\"action_processed\"}");
                                } else {
                                    log_warn("Action event for non-existent player %u", client->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"player_not_found\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "ship_sail_control") == 0) {
                            // SHIP SAIL CONTROL message
                            // log_info("⛵ Processing SHIP_SAIL_CONTROL message");
                            
                            if (client->player_id == 0) {
                                log_warn("Ship sail control from client with no player ID");
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->is_mounted && player->controlling_ship_id != 0) {
                                    // Find the ship being controlled
                                    SimpleShip* ship = NULL;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].ship_id == player->controlling_ship_id) {
                                            ship = &ships[s];
                                            break;
                                        }
                                    }
                                    
                                    if (ship) {
                                        // Parse desired_openness
                                        int desired_openness = 50; // Default
                                        char* openness_start = strstr(payload, "\"desired_openness\":");
                                        if (openness_start) {
                                            sscanf(openness_start + 19, "%d", &desired_openness);
                                        }
                                        
                                        handle_ship_sail_control(player, client, ship, desired_openness);
                                    } else {
                                        log_warn("Player %u controlling non-existent ship %u", player->player_id, player->controlling_ship_id);
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    }
                                } else {
                                    log_warn("Ship sail control from player %u not controlling a ship", client->player_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_controlling_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "ship_rudder_control") == 0) {
                            // SHIP RUDDER CONTROL message
                            // log_info("🚢 Processing SHIP_RUDDER_CONTROL message");
                            
                            if (client->player_id == 0) {
                                log_warn("Ship rudder control from client with no player ID");
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->is_mounted && player->controlling_ship_id != 0) {
                                    // Find the ship being controlled
                                    SimpleShip* ship = NULL;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].ship_id == player->controlling_ship_id) {
                                            ship = &ships[s];
                                            break;
                                        }
                                    }
                                    
                                    if (ship) {
                                        // Parse turning_left and turning_right
                                        bool turning_left = strstr(payload, "\"turning_left\":true") != NULL;
                                        bool turning_right = strstr(payload, "\"turning_right\":true") != NULL;
                                        bool moving_backward = strstr(payload, "\"moving_backward\":true") != NULL;
                                        
                                        handle_ship_rudder_control(player, client, ship, turning_left, turning_right, moving_backward);
                                    } else {
                                        log_warn("Player %u controlling non-existent ship %u", player->player_id, player->controlling_ship_id);
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    }
                                } else {
                                    log_warn("Ship rudder control from player %u not controlling a ship", client->player_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_controlling_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "ship_sail_angle_control") == 0) {
                            // SHIP SAIL ANGLE CONTROL message
                            // log_info("🌀 Processing SHIP_SAIL_ANGLE_CONTROL message");
                            
                            if (client->player_id == 0) {
                                log_warn("Ship sail angle control from client with no player ID");
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->is_mounted && player->controlling_ship_id != 0) {
                                    // Find the ship being controlled
                                    SimpleShip* ship = NULL;
                                    for (int s = 0; s < ship_count; s++) {
                                        if (ships[s].ship_id == player->controlling_ship_id) {
                                            ship = &ships[s];
                                            break;
                                        }
                                    }
                                    
                                    if (ship) {
                                        // Parse desired_angle
                                        float desired_angle = 0.0f; // Default
                                        char* angle_start = strstr(payload, "\"desired_angle\":");
                                        if (angle_start) {
                                            sscanf(angle_start + 16, "%f", &desired_angle);
                                        }
                                        
                                        handle_ship_sail_angle_control(player, client, ship, desired_angle);
                                    } else {
                                        log_warn("Player %u controlling non-existent ship %u", player->player_id, player->controlling_ship_id);
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    }
                                } else {
                                    log_warn("Ship sail angle control from player %u not controlling a ship", client->player_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_controlling_ship\"}");
                                }
                                handled = true;
                            }
                            
                        } else if (strcmp(msg_type, "cannon_aim") == 0) {
                            // CANNON AIM message
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    // Parse aim_angle
                                    float aim_angle = 0.0f;
                                    char* angle_start = strstr(payload, "\"aim_angle\":");
                                    if (angle_start) {
                                        sscanf(angle_start + 12, "%f", &aim_angle);
                                    }

                                    // Parse active_groups array e.g. [0,1]
                                    uint32_t active_groups[MAX_WEAPON_GROUPS];
                                    int active_group_count = 0;
                                    {
                                        char* ag_start = strstr(payload, "\"active_groups\":");
                                        if (ag_start) {
                                            ag_start += 16; /* skip "active_groups": */
                                            while (*ag_start && *ag_start != '[') ag_start++;
                                            if (*ag_start == '[') ag_start++;
                                            char* ag_end = strchr(ag_start, ']');
                                            char* p = ag_start;
                                            while (p && ag_end && p < ag_end &&
                                                   active_group_count < MAX_WEAPON_GROUPS) {
                                                char* num_end;
                                                long val = strtol(p, &num_end, 10);
                                                if (num_end == p) break;
                                                if (val >= 0 && val < MAX_WEAPON_GROUPS)
                                                    active_groups[active_group_count++] = (uint32_t)val;
                                                p = num_end;
                                                while (p < ag_end && (*p == ',' || *p == ' ')) p++;
                                            }
                                        }
                                    }

                                    log_info("🎯 cannon_aim: angle=%.1f° active_group_count=%d groups=[%s%s%s%s]",
                                             aim_angle * 180.0f / (float)M_PI,
                                             active_group_count,
                                             active_group_count > 0 ? (char[]){(char)('0'+active_groups[0]), 0} : "",
                                             active_group_count > 1 ? "," : "",
                                             active_group_count > 1 ? (char[]){(char)('0'+active_groups[1]), 0} : "",
                                             active_group_count > 2 ? ",..." : "");
                                    handle_cannon_aim(player, aim_angle, active_groups, active_group_count);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"aim_updated\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                                handled = true;
                            }

                        } else if (strcmp(msg_type, "swivel_aim") == 0) {
                            // SWIVEL AIM — update the aim direction of the player's mounted swivel
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    float aim_angle = 0.0f;
                                    char* angle_start = strstr(payload, "\"aim_angle\":");
                                    if (angle_start) sscanf(angle_start + 12, "%f", &aim_angle);
                                    handle_swivel_aim(player, aim_angle);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"swivel_aim_updated\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                                handled = true;
                            }

                        } else if (strcmp(msg_type, "cannon_fire") == 0 || strcmp(msg_type, "fire_weapon") == 0) {
                            // FIRE WEAPON message (cannon, swivel, future: ballista/catapult)
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                handled = true;
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    // Parse fire_all flag
                                    bool fire_all = strstr(payload, "\"fire_all\":true") != NULL;
                                    // freefire: skip aim-angle check (set by client for freefire/targetfire modes)
                                    bool freefire = strstr(payload, "\"freefire\":true") != NULL;
                                    // Parse ammo_type:
                                    //   cannon ammo: 0=cannonball, 1=bar_shot
                                    //   swivel ammo: 10=grapeshot, 11=liquid_flame, 12=canister_shot
                                    uint8_t ammo_type = PROJ_TYPE_CANNONBALL;
                                    char* at = strstr(payload, "\"ammo_type\":");
                                    if (at) ammo_type = (uint8_t)atoi(at + 12);
                                    /* Translate client UI IDs (10/11/12) → internal PROJ_TYPE (2/3/4) */
                                    if      (ammo_type == 10) ammo_type = PROJ_TYPE_GRAPESHOT;
                                    else if (ammo_type == 11) ammo_type = PROJ_TYPE_LIQUID_FLAME;
                                    else if (ammo_type == 12) ammo_type = PROJ_TYPE_CANISTER_SHOT;
                                    /* Reject anything not a valid cannon (0-1) or swivel (2-4) type */
                                    if (ammo_type > 1 && (ammo_type < PROJ_TYPE_GRAPESHOT || ammo_type > PROJ_TYPE_CANISTER_SHOT))
                                        ammo_type = PROJ_TYPE_CANNONBALL;
                                    // Parse optional weapon_ids array
                                    uint32_t _explicit_raw[MAX_WEAPONS_PER_GROUP];
                                    int explicit_count = parse_json_uint32_array(
                                        payload, "weapon_ids", _explicit_raw, MAX_WEAPONS_PER_GROUP);
                                    module_id_t explicit_ids[MAX_WEAPONS_PER_GROUP];
                                    for (int _i = 0; _i < explicit_count; _i++)
                                        explicit_ids[_i] = (module_id_t)_explicit_raw[_i];
                                    
                                    handle_cannon_fire(player, fire_all, ammo_type,
                                                       explicit_count > 0 ? explicit_ids : NULL,
                                                       explicit_count,
                                                       freefire);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"cannons_fired\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                                handled = true;
                            }

                        } else if (strcmp(msg_type, "cannon_force_reload") == 0) {
                            // CANNON FORCE RELOAD — discard current round, restart reload
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player && player->parent_ship_id != 0) {
                                    handle_cannon_force_reload(player);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"force_reloaded\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "cannon_group_config") == 0) {
                            // WEAPON GROUP CONFIG — set mode, cannon list, and optional target for a group
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    // Parse group_index (0–9)
                                    int group_index = -1;
                                    const char* gi = strstr(payload, "\"group_index\":");
                                    if (gi) group_index = atoi(gi + 14);

                                    // Parse mode string
                                    WeaponGroupMode mode = WEAPON_GROUP_MODE_HALTFIRE;
                                    if      (strstr(payload, "\"mode\":\"aiming\""))     mode = WEAPON_GROUP_MODE_AIMING;
                                    else if (strstr(payload, "\"mode\":\"freefire\""))   mode = WEAPON_GROUP_MODE_FREEFIRE;
                                    else if (strstr(payload, "\"mode\":\"targetfire\"")) mode = WEAPON_GROUP_MODE_TARGETFIRE;
                                    else if (strstr(payload, "\"mode\":\"haltfire\""))   mode = WEAPON_GROUP_MODE_HALTFIRE;

                                    // Parse weapon_ids array
                                    uint32_t _wids_raw[MAX_WEAPONS_PER_GROUP];
                                    int weapon_count = parse_json_uint32_array(
                                        payload, "weapon_ids", _wids_raw, MAX_WEAPONS_PER_GROUP);
                                    module_id_t weapon_ids[MAX_WEAPONS_PER_GROUP];
                                    for (int _i = 0; _i < weapon_count; _i++)
                                        weapon_ids[_i] = (module_id_t)_wids_raw[_i];

                                    // Parse optional target_ship_id
                                    uint16_t target_ship_id = 0;
                                    const char* tsi = strstr(payload, "\"target_ship_id\":");
                                    if (tsi) target_ship_id = (uint16_t)strtoul(tsi + 17, NULL, 10);

                                    if (group_index >= 0 && group_index < MAX_WEAPON_GROUPS) {
                                        handle_cannon_group_config(player, group_index, mode,
                                                                   weapon_ids, weapon_count,
                                                                   target_ship_id);
                                        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"group_configured\"}");
                                    } else {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"invalid_group_index\"}");
                                    }
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"player_not_found\"}");
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "ping") == 0) {
                            // JSON ping message
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"pong\",\"timestamp\":%u,\"server_time\":%u}",
                                    get_time_ms(), get_time_ms());
                            handled = true;

                        } else if (strcmp(msg_type, "slot_select") == 0) {
                            // INVENTORY: player changed active hotbar slot
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    int slot = 0;
                                    char* slot_ptr = strstr(payload, "\"slot\":");
                                    if (slot_ptr) sscanf(slot_ptr + 7, "%d", &slot);
                                    if (slot >= 0 && slot < INVENTORY_SLOTS)
                                        player->inventory.active_slot = (uint8_t)slot;
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"slot_selected\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "unequip") == 0) {
                            // INVENTORY: player deselected active slot (Q key) — sentinel 255 = nothing equipped
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    player->inventory.active_slot = 255;
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"unequipped\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "inv_swap") == 0) {
                            // INVENTORY: swap two slots {"type":"inv_swap","slot_a":0,"slot_b":5}
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    int slot_a = -1, slot_b = -1;
                                    char* pa = strstr(payload, "\"slot_a\":");
                                    char* pb = strstr(payload, "\"slot_b\":");
                                    if (pa) sscanf(pa + 9, "%d", &slot_a);
                                    if (pb) sscanf(pb + 9, "%d", &slot_b);
                                    if (slot_a >= 0 && slot_a < INVENTORY_SLOTS &&
                                        slot_b >= 0 && slot_b < INVENTORY_SLOTS &&
                                        slot_a != slot_b) {
                                        InventorySlot tmp = player->inventory.slots[slot_a];
                                        player->inventory.slots[slot_a] = player->inventory.slots[slot_b];
                                        player->inventory.slots[slot_b] = tmp;
                                        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"inv_swapped\"}");
                                    } else {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"invalid_slots\"}");
                                    }
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "drop_item") == 0) {
                            // DROP: player dragged item out of inventory {"type":"drop_item","slot":N}
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_drop_item(player, client, payload);
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "pickup_item") == 0) {
                            // PICKUP: player pressed E on a dropped item {"type":"pickup_item","item_id":N}
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    handle_pickup_item(player, client, payload);
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "give_item") == 0) {
                            // INVENTORY: server-side item grant (used by admin/tests)
                            // {"type":"give_item","slot":0,"item":1,"quantity":10}
                            if (client->player_id != 0) {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (player) {
                                    int slot = 0, item_id = 0, qty = 1;
                                    char* p_slot = strstr(payload, "\"slot\":");
                                    char* p_item = strstr(payload, "\"item\":");
                                    char* p_qty  = strstr(payload, "\"quantity\":");
                                    if (p_slot) sscanf(p_slot + 7,  "%d", &slot);
                                    if (p_item) sscanf(p_item + 7,  "%d", &item_id);
                                    if (p_qty)  sscanf(p_qty  + 11, "%d", &qty);
                                    if (slot >= 0 && slot < INVENTORY_SLOTS) {
                                        player->inventory.slots[slot].item     = (ItemKind)item_id;
                                        player->inventory.slots[slot].quantity = (uint8_t)(qty > 99 ? 99 : qty);
                                    }
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"item_given\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_deck") == 0) {
                            // PLACE DECK: re-insert a destroyed deck on the player's ship.
                            // Consumes 1 ITEM_DECK from inventory (infinite for NPCs).
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int deck_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_DECK &&
                                            player->inventory.slots[s].quantity > 0) {
                                            deck_slot = s; break;
                                        }
                                    }
                                    if (deck_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_deck\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            bool deck_present = false;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                if (sim_ship->modules[m].type_id == MODULE_TYPE_DECK) { deck_present = true; break; }
                                            }
                                            if (deck_present) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"deck_already_present\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                SimpleShip* simple = find_ship(player->parent_ship_id);
                                                uint8_t deck_seq = simple ? simple->ship_seq : (uint8_t)(player->parent_ship_id & 0xFF);
                                                uint16_t deck_mid = MID(deck_seq, MODULE_OFFSET_DECK);
                                                ShipModule new_deck = module_create(deck_mid, MODULE_TYPE_DECK, (Vec2Q16){0,0}, 0);
                                                new_deck.health = new_deck.max_health / 10; // start at 10%
                                                new_deck.state_bits |= MODULE_STATE_DAMAGED | MODULE_STATE_REPAIRING;
                                                sim_ship->modules[sim_ship->module_count++] = new_deck;
                                                if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                                                    simple->modules[simple->module_count++] = new_deck;
                                                player->inventory.slots[deck_slot].quantity--;
                                                if (player->inventory.slots[deck_slot].quantity == 0)
                                                    player->inventory.slots[deck_slot].item = ITEM_NONE;
                                                log_info("🔨 Player %u placed deck on ship %u",
                                                         player->player_id, sim_ship->id);
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"deck_placed\"}");
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_plank") == 0) {
                            // PLACE PLANK: re-insert a destroyed hull plank on the player's ship.
                            // Consumes 1 ITEM_PLANK from the player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                /* Accept both on-deck (parent_ship_id) and on-scaffold (on_dock_id) */
                                uint16_t target_ship_id = player ? player->parent_ship_id : 0;
                                if (player && target_ship_id == 0 && player->on_dock_id != 0) {
                                    for (int _pdi = 0; _pdi < (int)placed_structure_count; _pdi++) {
                                        if (placed_structures[_pdi].active &&
                                            placed_structures[_pdi].id == player->on_dock_id) {
                                            target_ship_id = placed_structures[_pdi].scaffolded_ship_id;
                                            break;
                                        }
                                    }
                                }
                                if (!player || target_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    /* Parse sectionName and segmentIndex from the JSON payload.
                                     * Lookup table mirrors createCompleteHullSegments() order in client. */
                                    typedef struct { const char* section; int seg; } PlankKey;
                                    static const PlankKey PLANK_KEYS[10] = {
                                        { "bow_port",        0 }, /* ID 100 */
                                        { "bow_starboard",   1 }, /* ID 101 */
                                        { "starboard_side",  0 }, /* ID 102 */
                                        { "starboard_side",  1 }, /* ID 103 */
                                        { "starboard_side",  2 }, /* ID 104 */
                                        { "stern_starboard", 4 }, /* ID 105 */
                                        { "stern_port",      5 }, /* ID 106 */
                                        { "port_side",       0 }, /* ID 107 */
                                        { "port_side",       1 }, /* ID 108 */
                                        { "port_side",       2 }, /* ID 109 */
                                    };
                                    char section_name[48] = {0};
                                    int  seg_index = -1;
                                    {
                                        char* sn = strstr(payload, "\"sectionName\":\"");
                                        if (sn) {
                                            sn += 15;
                                            int _si = 0;
                                            while (_si < 47 && sn[_si] != '"' && sn[_si] != '\0')
                                                { section_name[_si] = sn[_si]; _si++; }
                                            section_name[_si] = '\0';
                                        }
                                        char* ix = strstr(payload, "\"segmentIndex\":");
                                        if (ix) seg_index = atoi(ix + 15);
                                    }
                                    /* Map sectionName+segmentIndex → plank slot 0-9 */
                                    int plank_slot_idx = -1;
                                    for (int k = 0; k < 10; k++) {
                                        if (strcmp(section_name, PLANK_KEYS[k].section) == 0 &&
                                            seg_index == PLANK_KEYS[k].seg) {
                                            plank_slot_idx = k;
                                            break;
                                        }
                                    }
                                    if (plank_slot_idx < 0) {
                                        /* Unknown slot — fall back to first missing */
                                        log_warn("place_plank: unknown slot '%s'[%d], using first missing",
                                                 section_name, seg_index);
                                    }
                                    // Find a plank in inventory
                                    int plank_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_PLANK &&
                                            player->inventory.slots[s].quantity > 0) {
                                            plank_slot = s; break;
                                        }
                                    }
                                    if (plank_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_planks\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        // Find the sim ship (accept both on-deck and on-scaffold)
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == target_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        SimpleShip* simple_ship = find_ship(target_ship_id);
                                        if (!sim_ship || !simple_ship) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint8_t ship_seq = simple_ship->ship_seq;
                                            // Determine which plank slots are already present using MID encoding
                                            bool present[10] = {false};
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                uint16_t mid = sim_ship->modules[m].id;
                                                uint8_t off = MID_OFFSET(mid);
                                                if (MID_BELONGS_TO(mid, ship_seq) &&
                                                    off >= MODULE_OFFSET_PLANK_BASE &&
                                                    off < MODULE_OFFSET_PLANK_BASE + 10) {
                                                    present[off - MODULE_OFFSET_PLANK_BASE] = true;
                                                }
                                            }
                                            /* Use the client-requested slot; fall back to first missing */
                                            int missing_idx = plank_slot_idx >= 0 ? plank_slot_idx : -1;
                                            if (missing_idx >= 0 && present[missing_idx]) {
                                                /* Requested slot already has a plank */
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"plank_already_present\"}");
                                                missing_idx = -2; /* skip placement */
                                            }
                                            if (missing_idx == -1) {
                                                /* Fallback: first missing */
                                                for (int k = 0; k < 10; k++) {
                                                    if (!present[k]) { missing_idx = k; break; }
                                                }
                                            }
                                            if (missing_idx < 0) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_missing_planks\"}");
                                            } else if (missing_idx != -2 && sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else if (missing_idx >= 0) {
                                                uint16_t plank_id = MID(ship_seq, MODULE_OFFSET_PLANK(missing_idx));
                                                static const float pp_cx[10] = {
                                                     246.25f,  246.25f,  115.0f,  -35.0f, -185.0f,
                                                    -281.25f, -281.25f, -185.0f,  -35.0f,  115.0f };
                                                static const float pp_cy[10] = {
                                                     45.0f, -45.0f, -90.0f, -90.0f, -90.0f,
                                                    -45.0f,  45.0f,  90.0f,  90.0f,  90.0f };
                                                Vec2Q16 plank_pos = {
                                                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(pp_cx[missing_idx])),
                                                    Q16_FROM_FLOAT(CLIENT_TO_SERVER(pp_cy[missing_idx]))
                                                };
                                                ShipModule new_plank = module_create(
                                                    plank_id, MODULE_TYPE_PLANK, plank_pos, 0);
                                                // New planks start at 10% HP and heal passively
                                                new_plank.health = new_plank.max_health / 10;
                                                new_plank.state_bits |= MODULE_STATE_DAMAGED;
                                                // Add to sim ship (physics) and SimpleShip (broadcast) layers
                                                sim_ship->modules[sim_ship->module_count++] = new_plank;
                                                if (simple_ship->module_count < MAX_MODULES_PER_SHIP)
                                                    simple_ship->modules[simple_ship->module_count++] = new_plank;
                                                // Consume 1 plank
                                                player->inventory.slots[plank_slot].quantity--;
                                                if (player->inventory.slots[plank_slot].quantity == 0)
                                                    player->inventory.slots[plank_slot].item = ITEM_NONE;
                                                log_info("🔨 Player %u placed plank %u (seq=%u slot=%d) on ship %u (%d planks remain)",
                                                         player->player_id, plank_id, ship_seq, missing_idx, sim_ship->id,
                                                         player->inventory.slots[plank_slot].quantity);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"plank_placed\",\"plank_id\":%u}",
                                                    plank_id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "repair_plank") == 0) {
                            // REPAIR MODULE: raise target_health on the module with the lowest
                            // target_health/max_health ratio across ALL module types.
                            // Consumes 1 ITEM_WOOD from the player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    // Find wood in inventory
                                    int wood_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_WOOD &&
                                            player->inventory.slots[s].quantity > 0) {
                                            wood_slot = s; break;
                                        }
                                    }
                                    if (wood_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_wood\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            // Find module with lowest target_health/max_health ratio
                                            ShipModule* worst = NULL;
                                            float worst_ratio = 2.0f;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                ShipModule* mod = &sim_ship->modules[m];
                                                if (mod->max_health <= 0) continue;
                                                if (mod->target_health >= mod->max_health) continue;
                                                float ratio = (float)mod->target_health / (float)mod->max_health;
                                                if (ratio < worst_ratio) {
                                                    worst_ratio = ratio;
                                                    worst = mod;
                                                }
                                            }
                                            if (!worst) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"all_modules_full_target\"}");
                                            } else {
                                                // Raise target_health by 10% of max_health per wood
                                                int32_t boost = (int32_t)(worst->max_health / 10);
                                                worst->target_health += boost;
                                                if (worst->target_health > worst->max_health)
                                                    worst->target_health = worst->max_health;
                                                // Consume 1 wood
                                                player->inventory.slots[wood_slot].quantity--;
                                                if (player->inventory.slots[wood_slot].quantity == 0)
                                                    player->inventory.slots[wood_slot].item = ITEM_NONE;
                                                log_info("🔧 Player %u wood-repaired module %u (type %u) on ship %u: target_hp now %d/%d",
                                                         player->player_id, worst->id, worst->type_id, sim_ship->id,
                                                         (int)worst->target_health, (int)worst->max_health);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"module_target_raised\","
                                                    "\"moduleId\":%u,\"typeId\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                                                    worst->id, worst->type_id, (int)worst->health,
                                                    (int)worst->target_health, (int)worst->max_health);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "use_hammer") == 0) {
                            // USE HAMMER: apply 20% of target module's max_health as instant repair.
                            // Targets the specific module ID sent by the client (must be on same ship).
                            // Hammer is a reusable tool; not consumed.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else if (!global_sim) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                } else {
                                    // Parse moduleId from payload
                                    int req_module_id = -1;
                                    const char* p_mid = strstr(payload, "\"moduleId\":");
                                    if (p_mid) req_module_id = atoi(p_mid + 11);

                                    struct Ship* sim_ship = NULL;
                                    for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                        if (global_sim->ships[si].id == player->parent_ship_id) {
                                            sim_ship = &global_sim->ships[si]; break;
                                        }
                                    }
                                    if (!sim_ship) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                    } else if (req_module_id < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"missing_module_id\"}");
                                    } else {
                                        ShipModule* target = NULL;
                                        for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                            if (sim_ship->modules[m].id == (uint16_t)req_module_id) {
                                                target = &sim_ship->modules[m]; break;
                                            }
                                        }
                                        if (!target || target->health <= 0) {
                                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"module_not_found\"}");
                                        } else {
                                            // Apply 20% of max_health as instant repair, capped at target_health
                                            int32_t repair = (int32_t)(target->max_health * 20 / 100);
                                            target->health += repair;
                                            if (target->health > (int32_t)target->target_health)
                                                target->health = (int32_t)target->target_health;
                                            if (target->health >= (int32_t)target->max_health)
                                                target->state_bits &= ~MODULE_STATE_DAMAGED;
                                            // For masts: also repair 20% of fibers
                                            if (target->type_id == MODULE_TYPE_MAST) {
                                                float fh    = Q16_TO_FLOAT(target->data.mast.fiber_health);
                                                float fhmax = Q16_TO_FLOAT(target->data.mast.fiber_max_health);
                                                if (fhmax > 0.0f) {
                                                    fh += fhmax * 0.20f;
                                                    if (fh > fhmax) fh = fhmax;
                                                    target->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                                                    target->data.mast.wind_efficiency = Q16_FROM_FLOAT(fh / fhmax);
                                                }
                                            }
                                            log_info("🔨 Player %u hammer-repaired module %u (type %u) on ship %u to %d/%d HP",
                                                     player->player_id, target->id, target->type_id,
                                                     sim_ship->id, (int)target->health, (int)target->max_health);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"hammer_repair_applied\","
                                                "\"moduleId\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                                                target->id, (int)target->health,
                                                (int)target->target_health, (int)target->max_health);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "repair_sail") == 0) {
                            // REPAIR SAIL FIBERS: restore openness (+50, cap 100) and wind_efficiency
                            // (+0.5, cap 1.0) on a specific mast. Consumes 1 ITEM_REPAIR_KIT.
                            // Payload: {"type":"repair_sail","shipId":N,"mastIndex":N}  (0=bow,1=mid,2=stern)
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int kit_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_REPAIR_KIT &&
                                            player->inventory.slots[s].quantity > 0) {
                                            kit_slot = s; break;
                                        }
                                    }
                                    if (kit_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_repair_kits\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        int req_idx = -1;
                                        const char* p_mi = strstr(payload, "\"mastIndex\":");
                                        if (p_mi) req_idx = atoi(p_mi + 12);

                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (req_idx < 0 || req_idx > 2) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"invalid_mast_index\"}");
                                        } else {
                                            uint16_t mast_id = MID(simple->ship_seq, MODULE_OFFSET_MAST((uint8_t)req_idx));
                                            ShipModule* mast_mod = NULL;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                if (sim_ship->modules[m].id   == mast_id &&
                                                    sim_ship->modules[m].type_id == MODULE_TYPE_MAST) {
                                                    mast_mod = &sim_ship->modules[m]; break;
                                                }
                                            }
                                            if (!mast_mod) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"mast_not_present\"}");
                                            } else {
                                                float eff = Q16_TO_FLOAT(mast_mod->data.mast.wind_efficiency);
                                                if (mast_mod->data.mast.fiber_health >= mast_mod->data.mast.fiber_max_health && eff >= 1.0f) {
                                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"sail_intact\"}");
                                                } else {
                                                    // Restore 500 fiber HP per repair kit use
                                                    float fh    = Q16_TO_FLOAT(mast_mod->data.mast.fiber_health);
                                                    float fhmax = Q16_TO_FLOAT(mast_mod->data.mast.fiber_max_health);
                                                    if (fhmax <= 0.0f) fhmax = 15000.0f;
                                                    fh += 500.0f;
                                                    if (fh > fhmax) fh = fhmax;
                                                    mast_mod->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                                                    eff = fh / fhmax;
                                                    mast_mod->data.mast.wind_efficiency = Q16_FROM_FLOAT(eff);
                                                    // Mirror into SimpleShip so rigger NPC sees it too
                                                    ShipModule* sm = find_module_by_id(simple, mast_id);
                                                    if (sm) {
                                                        sm->data.mast.fiber_health    = mast_mod->data.mast.fiber_health;
                                                        sm->data.mast.wind_efficiency = mast_mod->data.mast.wind_efficiency;
                                                    }
                                                    player->inventory.slots[kit_slot].quantity--;
                                                    if (player->inventory.slots[kit_slot].quantity == 0)
                                                        player->inventory.slots[kit_slot].item = ITEM_NONE;
                                                    log_info("🧵 Player %u repaired sail fibers mast %u on ship %u (fiber HP %.0f/%.0f, eff %.2f)",
                                                             player->player_id, mast_id, sim_ship->id, fh, fhmax, eff);
                                                    snprintf(response, sizeof(response),
                                                        "{\"type\":\"message_ack\",\"status\":\"sail_repaired\","
                                                        "\"mastId\":%u,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f,\"windEfficiency\":%.3f}",
                                                        mast_id, fh, fhmax, eff);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_cannon_at") == 0) {
                            // FREE-PLACE CANNON: place a cannon at an arbitrary ship-local position.
                            // Payload: {"type":"place_cannon_at","shipId":N,"localX":F,"localY":F,"rotation":F}
                            // Consumes 1 ITEM_CANNON from the placing player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    // Locate cannon in inventory
                                    int cannon_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_CANNON &&
                                            player->inventory.slots[s].quantity > 0) {
                                            cannon_slot = s; break;
                                        }
                                    }
                                    if (cannon_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_cannon\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        // Find the sim ship (use shipId from payload, fallback to player ship)
                                        uint16_t target_ship_id = player->parent_ship_id;
                                        const char* p_sid = strstr(payload, "\"shipId\":");
                                        if (p_sid) { uint32_t sid = 0; sscanf(p_sid + 9, "%u", &sid); if (sid) target_ship_id = (uint16_t)sid; }

                                        SimpleShip* simple = find_ship(target_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == target_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP ||
                                                   simple->module_count >= MAX_MODULES_PER_SHIP) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                        } else {
                                            // Parse local position and rotation (client px → server units)
                                            float local_x = 0.0f, local_y = 0.0f, rotation = 0.0f;
                                            const char* px = strstr(payload, "\"localX\":");
                                            const char* py = strstr(payload, "\"localY\":");
                                            const char* pr = strstr(payload, "\"rotation\":");
                                            if (px) sscanf(px + 9,  "%f", &local_x);
                                            if (py) sscanf(py + 9,  "%f", &local_y);
                                            if (pr) sscanf(pr + 11, "%f", &rotation);

                                            // Allocate a unique module ID (scan max existing + 1 across both arrays)
                                            uint16_t max_id = 0;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++)
                                                if (sim_ship->modules[m].id > max_id) max_id = sim_ship->modules[m].id;
                                            for (uint8_t m = 0; m < simple->module_count; m++)
                                                if (simple->modules[m].id > max_id) max_id = simple->modules[m].id;
                                            uint16_t new_id = max_id + 1;

                                            // Build the module record once, copy into both arrays
                                            ShipModule nc;
                                            memset(&nc, 0, sizeof(ShipModule));
                                            nc.id          = new_id;
                                            nc.type_id     = MODULE_TYPE_CANNON;
                                            nc.local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x));
                                            nc.local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y));
                                            nc.local_rot   = Q16_FROM_FLOAT(rotation);
                                            nc.state_bits  = MODULE_STATE_ACTIVE;
                                            nc.health      = 8000;
                                            nc.max_health  = 8000;
                                            nc.data.cannon.aim_direction   = Q16_FROM_FLOAT(0.0f);
                                            nc.data.cannon.ammunition      = 10;
                                            nc.data.cannon.reload_time     = CANNON_RELOAD_TIME_MS;
                                            nc.data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS; // start ready to fire

                                            // Add to physics simulation
                                            sim_ship->modules[sim_ship->module_count++] = nc;
                                            // Add to SimpleShip (network broadcast + NPC visibility)
                                            simple->modules[simple->module_count++] = nc;

                                            // Consume 1 cannon from inventory
                                            player->inventory.slots[cannon_slot].quantity--;
                                            if (player->inventory.slots[cannon_slot].quantity == 0)
                                                player->inventory.slots[cannon_slot].item = ITEM_NONE;

                                            // Trigger NPC cannon sector re-dispatch so on-duty gunners
                                            // can immediately adopt the newly placed cannon if it is
                                            // closer to the current aim angle than their current post.
                                            update_npc_cannon_sector(simple, simple->active_aim_angle);

                                            log_info("🔨 Player %u placed cannon %u at (%.1f,%.1f) rot=%.2f on ship %u",
                                                     player->player_id, new_id, local_x, local_y, rotation, sim_ship->id);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"cannon_placed_at\",\"cannon_id\":%u}",
                                                new_id);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_mast_at") == 0) {
                            // FREE-PLACE MAST: place a mast at an arbitrary ship-local position.
                            // Payload: {"type":"place_mast_at","shipId":N,"localX":F,"localY":F}
                            // Consumes 1 ITEM_SAIL from the placing player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int sail_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_SAIL &&
                                            player->inventory.slots[s].quantity > 0) {
                                            sail_slot = s; break;
                                        }
                                    }
                                    if (sail_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_sail\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        uint16_t target_ship_id = player->parent_ship_id;
                                        const char* p_sid = strstr(payload, "\"shipId\":");
                                        if (p_sid) { uint32_t sid = 0; sscanf(p_sid + 9, "%u", &sid); if (sid) target_ship_id = (uint16_t)sid; }

                                        SimpleShip* simple_mast = find_ship(target_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == target_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple_mast) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP ||
                                                   simple_mast->module_count >= MAX_MODULES_PER_SHIP) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                        } else {
                                            float local_x = 0.0f, local_y = 0.0f;
                                            const char* px = strstr(payload, "\"localX\":");
                                            const char* py = strstr(payload, "\"localY\":");
                                            if (px) sscanf(px + 9, "%f", &local_x);
                                            if (py) sscanf(py + 9, "%f", &local_y);

                                            uint16_t max_id = 0;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++)
                                                if (sim_ship->modules[m].id > max_id) max_id = sim_ship->modules[m].id;
                                            for (uint8_t m = 0; m < simple_mast->module_count; m++)
                                                if (simple_mast->modules[m].id > max_id) max_id = simple_mast->modules[m].id;
                                            uint16_t new_id = max_id + 1;

                                            ShipModule nm;
                                            memset(&nm, 0, sizeof(ShipModule));
                                            nm.id          = new_id;
                                            nm.type_id     = MODULE_TYPE_MAST;
                                            nm.local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x));
                                            nm.local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y));
                                            nm.local_rot   = Q16_FROM_FLOAT(0.0f);
                                            nm.state_bits  = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
                                            nm.health      = 15000;
                                            nm.max_health  = 15000;
                                            nm.data.mast.angle             = Q16_FROM_FLOAT(0.0f);
                                            nm.data.mast.openness          = 0;
                                            nm.data.mast.fiber_health      = Q16_FROM_FLOAT(15000.0f);
                                            nm.data.mast.fiber_max_health  = Q16_FROM_FLOAT(15000.0f);
                                            nm.data.mast.wind_efficiency   = Q16_FROM_FLOAT(1.0f);

                                            // Add to physics simulation and to SimpleShip (NPC + network)
                                            sim_ship->modules[sim_ship->module_count++] = nm;
                                            simple_mast->modules[simple_mast->module_count++] = nm;

                                            player->inventory.slots[sail_slot].quantity--;
                                            if (player->inventory.slots[sail_slot].quantity == 0)
                                                player->inventory.slots[sail_slot].item = ITEM_NONE;

                                            log_info("⛵ Player %u placed mast %u at (%.1f,%.1f) on ship %u",
                                                     player->player_id, new_id, local_x, local_y, sim_ship->id);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"mast_placed_at\",\"mast_id\":%u}",
                                                new_id);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_swivel_at") == 0) {
                            // FREE-PLACE SWIVEL: place a swivel gun at an arbitrary ship-local position.
                            // Payload: {"type":"place_swivel_at","shipId":N,"localX":F,"localY":F,"rotation":F}
                            // Consumes 1 ITEM_SWIVEL from the placing player's inventory.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int sw_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_SWIVEL &&
                                            player->inventory.slots[s].quantity > 0) {
                                            sw_slot = s; break;
                                        }
                                    }
                                    if (sw_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_swivel\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        uint16_t target_ship_id = player->parent_ship_id;
                                        const char* p_sid = strstr(payload, "\"shipId\":");
                                        if (p_sid) { uint32_t sid = 0; sscanf(p_sid + 9, "%u", &sid); if (sid) target_ship_id = (uint16_t)sid; }

                                        SimpleShip* sw_simple = find_ship(target_ship_id);
                                        struct Ship* sw_sim = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == target_ship_id) {
                                                sw_sim = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sw_sim || !sw_simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else if (sw_sim->module_count >= MAX_MODULES_PER_SHIP ||
                                                   sw_simple->module_count >= MAX_MODULES_PER_SHIP) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                        } else {
                                            float local_x = 0.0f, local_y = 0.0f, rotation = 0.0f;
                                            const char* px = strstr(payload, "\"localX\":");
                                            const char* py = strstr(payload, "\"localY\":");
                                            const char* pr = strstr(payload, "\"rotation\":");
                                            if (px) sscanf(px + 9,  "%f", &local_x);
                                            if (py) sscanf(py + 9,  "%f", &local_y);
                                            if (pr) sscanf(pr + 11, "%f", &rotation);

                                            // Swivels must be placed on the hull rail (plank band):
                                            // edge distance must be within [0, 2.5] server units = [0, 25] client px.
                                            if (is_outside_deck(target_ship_id, local_x, local_y)) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"outside_deck\"}");
                                            } else {
                                            float _sv_x = CLIENT_TO_SERVER(local_x);
                                            float _sv_y = CLIENT_TO_SERVER(local_y);
                                            float _edge_dist = swivel_dist_to_hull_edge(_sv_x, _sv_y, sw_sim);
                                            if (_edge_dist > 2.5f) {
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"error\",\"message\":\"swivel_must_be_on_rail\",\"edge_dist\":%.2f}",
                                                    _edge_dist * WORLD_SCALE_FACTOR);
                                            } else {

                                            uint16_t max_id = 0;
                                            for (uint8_t m = 0; m < sw_sim->module_count; m++)
                                                if (sw_sim->modules[m].id > max_id) max_id = sw_sim->modules[m].id;
                                            for (uint8_t m = 0; m < sw_simple->module_count; m++)
                                                if (sw_simple->modules[m].id > max_id) max_id = sw_simple->modules[m].id;
                                            uint16_t new_id = max_id + 1;

                                            ShipModule ns;
                                            memset(&ns, 0, sizeof(ShipModule));
                                            ns.id          = new_id;
                                            ns.type_id     = MODULE_TYPE_SWIVEL;
                                            ns.local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_x));
                                            ns.local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(local_y));
                                            ns.local_rot   = Q16_FROM_FLOAT(rotation);
                                            ns.state_bits  = MODULE_STATE_ACTIVE;
                                            ns.health      = 6000;
                                            ns.max_health  = 6000;
                                            ns.data.swivel.aim_direction         = Q16_FROM_FLOAT(0.0f);
                                            ns.data.swivel.desired_aim_direction = Q16_FROM_FLOAT(0.0f);
                                            ns.data.swivel.reload_time           = SWIVEL_RELOAD_TIME_MS;
                                            ns.data.swivel.time_since_fire       = SWIVEL_RELOAD_TIME_MS; /* start ready to fire */
                                            ns.data.swivel.loaded_ammo           = 0; /* default: cannonball */

                                            sw_sim->modules[sw_sim->module_count++]       = ns;
                                            sw_simple->modules[sw_simple->module_count++] = ns;

                                            player->inventory.slots[sw_slot].quantity--;
                                            if (player->inventory.slots[sw_slot].quantity == 0)
                                                player->inventory.slots[sw_slot].item = ITEM_NONE;

                                            log_info("🔫 Player %u placed swivel %u at (%.1f,%.1f) rot=%.2f on ship %u",
                                                     player->player_id, new_id, local_x, local_y, rotation, sw_sim->id);
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"swivel_placed_at\",\"swivel_id\":%u}",
                                                new_id);
                                            } // edge check
                                            } // outside_deck check
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_cannon") == 0) {
                            // PLACE CANNON: re-install a destroyed cannon on the player's ship.
                            // Consumes 1 ITEM_CANNON. Server finds the first missing cannon slot
                            // (IDs base+1..base+6) and recreates it at the correct position.
                            // Layout: cannon_xs[3]={-35,65,-135}; port y=+75 rot=PI, stbd y=-75 rot=0
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int cannon_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_CANNON &&
                                            player->inventory.slots[s].quantity > 0) {
                                            cannon_slot = s; break;
                                        }
                                    }
                                    if (cannon_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_cannon\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint8_t seq = simple->ship_seq;
                                            bool present[6] = {false};
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                uint16_t mid = sim_ship->modules[m].id;
                                                if (MODULE_OFFSET_IS_CANNON(MID_OFFSET(mid)) &&
                                                    MID_BELONGS_TO(mid, seq))
                                                    present[MID_OFFSET(mid) - MODULE_OFFSET_CANNON_PORT_0] = true;
                                            }
                                            int missing_idx = -1;
                                            for (int k = 0; k < 6; k++) {
                                                if (!present[k]) { missing_idx = k; break; }
                                            }
                                            if (missing_idx < 0) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_missing_cannons\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                static const float cannon_xs[3] = { -35.0f, 65.0f, -135.0f };
                                                int i = missing_idx;
                                                float cx  = cannon_xs[i % 3];
                                                float cy  = (i < 3) ? 75.0f : -75.0f;
                                                float rot = (i < 3) ? (float)M_PI : 0.0f;
                                                uint16_t cannon_id = MID(seq, MODULE_OFFSET_CANNON(i));
                                                ShipModule* nc = &sim_ship->modules[sim_ship->module_count];
                                                memset(nc, 0, sizeof(ShipModule));
                                                nc->id          = cannon_id;
                                                nc->type_id     = MODULE_TYPE_CANNON;
                                                nc->local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cx));
                                                nc->local_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(cy));
                                                nc->local_rot   = Q16_FROM_FLOAT(rot);
                                                nc->state_bits  = MODULE_STATE_ACTIVE;
                                                nc->health      = 8000;
                                                nc->max_health  = 8000;
                                                nc->data.cannon.aim_direction   = Q16_FROM_FLOAT(0.0f);
                                                nc->data.cannon.ammunition      = 10;
                                                nc->data.cannon.reload_time     = CANNON_RELOAD_TIME_MS;
                                                nc->data.cannon.time_since_fire = CANNON_RELOAD_TIME_MS; // start ready to fire
                                                sim_ship->module_count++;
                                                player->inventory.slots[cannon_slot].quantity--;
                                                if (player->inventory.slots[cannon_slot].quantity == 0)
                                                    player->inventory.slots[cannon_slot].item = ITEM_NONE;
                                                log_info("🔧 Player %u placed cannon %u on ship %u",
                                                         player->player_id, cannon_id, sim_ship->id);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"cannon_placed\",\"cannon_id\":%u}",
                                                    cannon_id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "place_mast") == 0) {
                            // PLACE MAST: re-install a destroyed mast on the player's ship.
                            // Consumes 1 ITEM_SAIL. First missing mast slot (IDs base+7..base+9).
                            // Layout: mast_xs[3]={165,-35,-235}, y=0, rot=0.
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int sail_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_SAIL &&
                                            player->inventory.slots[s].quantity > 0) {
                                            sail_slot = s; break;
                                        }
                                    }
                                    if (sail_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_sail\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint8_t seq = simple->ship_seq;
                                            // Masts: offsets 0x09..0x0B
                                            bool present[3] = {false};
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                uint16_t mid = sim_ship->modules[m].id;
                                                if (MODULE_OFFSET_IS_MAST(MID_OFFSET(mid)) &&
                                                    MID_BELONGS_TO(mid, seq))
                                                    present[MID_OFFSET(mid) - MODULE_OFFSET_MAST_BOW] = true;
                                            }
                                            // Use the specific mast index sent by the client.
                                            // Fall back to the first missing slot if client doesn't send it.
                                            int requested_idx = -1;
                                            const char* p_mi = strstr(payload, "\"mastIndex\":");
                                            if (p_mi) requested_idx = atoi(p_mi + 12);

                                            int target_idx = -1;
                                            if (requested_idx >= 0 && requested_idx < 3 && !present[requested_idx]) {
                                                // Client specified a valid missing slot — use it directly
                                                target_idx = requested_idx;
                                            } else {
                                                // Fallback: first missing
                                                for (int k = 0; k < 3; k++) {
                                                    if (!present[k]) { target_idx = k; break; }
                                                }
                                            }
                                            int missing_idx = target_idx;
                                            if (missing_idx < 0) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"no_missing_masts\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                static const float mast_xs[3] = { 165.0f, -35.0f, -235.0f };
                                                uint16_t mast_id = MID(seq, MODULE_OFFSET_MAST((uint8_t)missing_idx));
                                                ShipModule* nm = &sim_ship->modules[sim_ship->module_count];
                                                memset(nm, 0, sizeof(ShipModule));
                                                nm->id          = mast_id;
                                                nm->type_id     = MODULE_TYPE_MAST;
                                                nm->local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(mast_xs[missing_idx]));
                                                nm->local_pos.y = Q16_FROM_FLOAT(0.0f);
                                                nm->local_rot   = Q16_FROM_FLOAT(0.0f);
                                                nm->state_bits  = MODULE_STATE_ACTIVE | MODULE_STATE_DEPLOYED;
                                                nm->health      = 15000;
                                                nm->max_health  = 15000;
                                                nm->data.mast.angle           = Q16_FROM_FLOAT(0.0f);
                                                nm->data.mast.openness        = 0;
                                                nm->data.mast.fiber_health     = Q16_FROM_FLOAT(15000.0f);
                                                nm->data.mast.fiber_max_health = Q16_FROM_FLOAT(15000.0f);
                                                nm->data.mast.wind_efficiency = Q16_FROM_FLOAT(1.0f);
                                                sim_ship->module_count++;
                                                // Mirror into SimpleShip so find_module_on_ship()
                                                // (used by NPC riggers) can see the new mast.
                                                if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                                                    simple->modules[simple->module_count++] = *nm;
                                                player->inventory.slots[sail_slot].quantity--;
                                                if (player->inventory.slots[sail_slot].quantity == 0)
                                                    player->inventory.slots[sail_slot].item = ITEM_NONE;
                                                log_info("⛵ Player %u placed mast %u on ship %u",
                                                         player->player_id, mast_id, sim_ship->id);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"mast_placed\",\"mast_id\":%u}",
                                                    mast_id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "replace_helm") == 0) {
                            // REPLACE HELM: re-install the helm if destroyed.
                            // Consumes 1 ITEM_HELM. Helm ID = base+0, pos (-90, 0).
                            if (client->player_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_player\"}");
                            } else {
                                WebSocketPlayer* player = find_player(client->player_id);
                                if (!player || player->parent_ship_id == 0) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                                } else {
                                    int helm_slot = -1;
                                    for (int s = 0; s < INVENTORY_SLOTS; s++) {
                                        if (player->inventory.slots[s].item == ITEM_HELM &&
                                            player->inventory.slots[s].quantity > 0) {
                                            helm_slot = s; break;
                                        }
                                    }
                                    if (helm_slot < 0) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_helm_item\"}");
                                    } else if (!global_sim) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                                    } else {
                                        SimpleShip* simple = find_ship(player->parent_ship_id);
                                        struct Ship* sim_ship = NULL;
                                        for (uint32_t si = 0; si < global_sim->ship_count; si++) {
                                            if (global_sim->ships[si].id == player->parent_ship_id) {
                                                sim_ship = &global_sim->ships[si]; break;
                                            }
                                        }
                                        if (!sim_ship || !simple) {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        } else {
                                            uint8_t seq = simple->ship_seq;
                                            bool helm_present = false;
                                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                                if (sim_ship->modules[m].type_id == MODULE_TYPE_HELM) {
                                                    helm_present = true; break;
                                                }
                                            }
                                            if (helm_present) {
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"helm_intact\"}");
                                            } else if (sim_ship->module_count >= MAX_MODULES_PER_SHIP) {
                                                strcpy(response, "{\"type\":\"error\",\"message\":\"ship_full\"}");
                                            } else {
                                                ShipModule* nh = &sim_ship->modules[sim_ship->module_count];
                                                memset(nh, 0, sizeof(ShipModule));
                                                nh->id          = MID(seq, MODULE_OFFSET_HELM);
                                                nh->type_id     = MODULE_TYPE_HELM;
                                                nh->local_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f));
                                                nh->local_pos.y = Q16_FROM_FLOAT(0.0f);
                                                nh->local_rot   = Q16_FROM_FLOAT(0.0f);
                                                nh->state_bits  = MODULE_STATE_ACTIVE;
                                                nh->health      = Q16_FROM_FLOAT(10000.0f);
                                                nh->max_health  = Q16_FROM_FLOAT(10000.0f);
                                                nh->data.helm.occupied_by    = 0;
                                                nh->data.helm.wheel_rotation = Q16_FROM_FLOAT(0.0f);
                                                sim_ship->module_count++;
                                                // Mirror into SimpleShip so find_module_on_ship()
                                                // (used by NPC helmsmen) can see the new helm.
                                                if (simple && simple->module_count < MAX_MODULES_PER_SHIP)
                                                    simple->modules[simple->module_count++] = *nh;
                                                player->inventory.slots[helm_slot].quantity--;
                                                if (player->inventory.slots[helm_slot].quantity == 0)
                                                    player->inventory.slots[helm_slot].item = ITEM_NONE;
                                                log_info("🔧 Player %u replaced helm %u on ship %u",
                                                         player->player_id, MID(seq, MODULE_OFFSET_HELM), sim_ship->id);
                                                snprintf(response, sizeof(response),
                                                    "{\"type\":\"message_ack\",\"status\":\"helm_placed\",\"helm_id\":%u}",
                                                    nh->id);
                                            }
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "crew_assign") == 0) {
                            // CREW ASSIGN: player sets a WorldNpc's manning task.
                            // {"type":"crew_assign","ship_id":N,"npc_id":N,"task":"Sails|Cannons|Repairs|Combat|Idle"}
                            uint32_t ca_ship = 0, ca_npc = 0;
                            char ca_task[16] = "Idle";
                            char* p;
                            p = strstr(payload, "\"ship_id\":"); if (p) sscanf(p + 10, "%u", &ca_ship);
                            p = strstr(payload, "\"npc_id\":");  if (p) sscanf(p +  9, "%u", &ca_npc);
                            p = strstr(payload, "\"task\":\"");
                            if (p) sscanf(p + 8, "%15[^\"]s", ca_task);
                            if (ca_ship != 0 && ca_npc != 0) {
                                // Company check: player may only command NPCs of their own company.
                                // Neutral players (company 0) cannot command any company-owned NPC.
                                WebSocketPlayer* ca_player = find_player(client->player_id);
                                WorldNpc* ca_npc_ptr = NULL;
                                for (int _ci = 0; _ci < world_npc_count; _ci++) {
                                    if (world_npcs[_ci].active && world_npcs[_ci].id == ca_npc) {
                                        ca_npc_ptr = &world_npcs[_ci]; break;
                                    }
                                }
                                if (ca_player && ca_npc_ptr &&
                                    ca_npc_ptr->company_id != 0 &&
                                    ca_npc_ptr->company_id != ca_player->company_id) {
                                    log_warn("⛔ Player %u (company %u) cannot command NPC %u (company %u)",
                                             ca_player->player_id, ca_player->company_id,
                                             ca_npc_ptr->id, ca_npc_ptr->company_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"company_mismatch\"}");
                                } else {
                                    handle_crew_assign((uint16_t)ca_ship, (uint16_t)ca_npc, ca_task);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"crew_assigned\"}");
                                }
                            } else {
                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"crew_assigned\"}");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "npc_recruit") == 0) {
                            // NPC RECRUIT: player claims a neutral (company 0) NPC into their company.
                            // {"type":"npc_recruit","npcId":N}
                            uint32_t rn_npc_id = 0;
                            { char* rp = strstr(payload, "\"npcId\":"); if (rp) sscanf(rp + 8, "%u", &rn_npc_id); }
                            WebSocketPlayer* rn_player = find_player(client->player_id);
                            if (rn_player && rn_npc_id != 0) {
                                WorldNpc* rn_npc_ptr = NULL;
                                for (int _ni = 0; _ni < world_npc_count; _ni++) {
                                    if (world_npcs[_ni].active && world_npcs[_ni].id == rn_npc_id) {
                                        rn_npc_ptr = &world_npcs[_ni]; break;
                                    }
                                }
                                if (rn_npc_ptr && rn_npc_ptr->company_id == 0) {
                                    rn_npc_ptr->company_id = rn_player->company_id;
                                    log_info("🤝 Player %u recruited NPC %u '%s' (company %u)",
                                             rn_player->player_id, rn_npc_id,
                                             rn_npc_ptr->name, rn_player->company_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"recruited\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"cannot_recruit\"}");
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "npc_move_aboard") == 0) {
                            // NPC MOVE ABOARD: move a recruited NPC to the player's current ship.
                            // {"type":"npc_move_aboard","npcId":N}
                            uint32_t ma_npc_id = 0;
                            { char* mp2 = strstr(payload, "\"npcId\":"); if (mp2) sscanf(mp2 + 8, "%u", &ma_npc_id); }
                            WebSocketPlayer* ma_player = find_player(client->player_id);
                            if (ma_player && ma_npc_id != 0 && ma_player->parent_ship_id != 0) {
                                WorldNpc* ma_npc_ptr = NULL;
                                for (int _ni = 0; _ni < world_npc_count; _ni++) {
                                    if (world_npcs[_ni].active && world_npcs[_ni].id == ma_npc_id) {
                                        ma_npc_ptr = &world_npcs[_ni]; break;
                                    }
                                }
                                SimpleShip* ma_ship = find_ship(ma_player->parent_ship_id);
                                if (ma_npc_ptr && ma_ship &&
                                    ma_npc_ptr->company_id == ma_player->company_id) {
                                    ma_npc_ptr->ship_id        = ma_player->parent_ship_id;
                                    ma_npc_ptr->in_water       = false;
                                    int slot_idx = (int)(ma_npc_ptr->id % 9);
                                    ma_npc_ptr->local_x        = -200.0f + slot_idx * 50.0f;
                                    ma_npc_ptr->local_y        = 0.0f;
                                    ma_npc_ptr->idle_local_x   = ma_npc_ptr->local_x;
                                    ma_npc_ptr->idle_local_y   = ma_npc_ptr->local_y;
                                    ma_npc_ptr->target_local_x = ma_npc_ptr->local_x;
                                    ma_npc_ptr->target_local_y = ma_npc_ptr->local_y;
                                    ma_npc_ptr->state          = WORLD_NPC_STATE_IDLE;
                                    ship_local_to_world(ma_ship,
                                        ma_npc_ptr->local_x, ma_npc_ptr->local_y,
                                        &ma_npc_ptr->x, &ma_npc_ptr->y);
                                    log_info("⚓ NPC %u '%s' moved aboard ship %u for player %u",
                                             ma_npc_id, ma_npc_ptr->name,
                                             ma_player->parent_ship_id, ma_player->player_id);
                                    strcpy(response, "{\"type\":\"message_ack\",\"status\":\"moved_aboard\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"cannot_move_aboard\"}");
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "npc_lock") == 0) {
                            // NPC LOCK: pin or unpin an NPC to their current module.
                            // {"type":"npc_lock","npcId":N,"locked":true/false}
                            uint32_t lk_npc_id = 0;
                            int      lk_locked  = 0;
                            { char* lp = strstr(payload, "\"npcId\":"); if (lp) sscanf(lp + 8, "%u", &lk_npc_id); }
                            { char* lp = strstr(payload, "\"locked\":"); if (lp) { lk_locked = (strncmp(lp + 9, "true", 4) == 0) ? 1 : 0; } }
                            WebSocketPlayer* lk_player = find_player(client->player_id);
                            if (lk_player && lk_npc_id != 0) {
                                WorldNpc* lk_npc = NULL;
                                for (int _ni = 0; _ni < world_npc_count; _ni++) {
                                    if (world_npcs[_ni].active && world_npcs[_ni].id == lk_npc_id) {
                                        lk_npc = &world_npcs[_ni]; break;
                                    }
                                }
                                if (lk_npc && lk_npc->company_id == lk_player->company_id) {
                                    lk_npc->task_locked = (bool)lk_locked;
                                    log_info("%s NPC %u (%s) by player %u",
                                             lk_locked ? "🔒 Locked" : "🔓 Unlocked",
                                             lk_npc_id, lk_npc->name, lk_player->player_id);
                                    strcpy(response, lk_locked
                                        ? "{\"type\":\"message_ack\",\"status\":\"npc_locked\"}"
                                        : "{\"type\":\"message_ack\",\"status\":\"npc_unlocked\"}");
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"cannot_lock_npc\"}");
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "npc_goto_module") == 0) {
                            // NPC GOTO MODULE: direct an NPC to a specific module on their ship.
                            // {"type":"npc_goto_module","npcId":N,"moduleId":M}
                            // Clears task_locked so the NPC can be re-dispatched after arriving.
                            uint32_t gm_npc_id = 0, gm_mod_id = 0;
                            { char* gp = strstr(payload, "\"npcId\":"); if (gp) sscanf(gp + 8, "%u", &gm_npc_id); }
                            { char* gp = strstr(payload, "\"moduleId\":"); if (gp) sscanf(gp + 11, "%u", &gm_mod_id); }
                            WebSocketPlayer* gm_player = find_player(client->player_id);
                            if (gm_player && gm_npc_id != 0 && gm_mod_id != 0) {
                                WorldNpc* gm_npc = NULL;
                                for (int _ni = 0; _ni < world_npc_count; _ni++) {
                                    if (world_npcs[_ni].active && world_npcs[_ni].id == gm_npc_id) {
                                        gm_npc = &world_npcs[_ni]; break;
                                    }
                                }
                                SimpleShip* gm_ship = gm_npc ? find_ship(gm_npc->ship_id) : NULL;
                                ShipModule*  gm_mod  = gm_ship ? find_module_by_id(gm_ship, gm_mod_id) : NULL;
                                if (gm_npc && gm_ship && gm_mod &&
                                    gm_npc->company_id == gm_player->company_id) {
                                    /* ── Occupancy check: single-occupancy modules only ──────────────────── */
                                    /* Cannon, swivel, mast and helm each hold exactly one NPC.              */
                                    /* If another NPC is already assigned there, reject the command.         */
                                    bool gm_occupied = false;
                                    if (gm_mod->type_id == MODULE_TYPE_CANNON ||
                                        gm_mod->type_id == MODULE_TYPE_SWIVEL ||
                                        gm_mod->type_id == MODULE_TYPE_MAST   ||
                                        gm_mod->type_id == MODULE_TYPE_HELM) {
                                        for (int _oi = 0; _oi < world_npc_count && !gm_occupied; _oi++) {
                                            WorldNpc* other = &world_npcs[_oi];
                                            if (!other->active)                      continue;
                                            if (other->id == gm_npc_id)              continue; /* the NPC itself */
                                            if (other->ship_id != gm_ship->ship_id)  continue;
                                            if (other->assigned_weapon_id == gm_mod_id) gm_occupied = true;
                                        }
                                    }
                                    if (gm_occupied) {
                                        snprintf(response, 1024,
                                                 "{\"type\":\"error\",\"message\":\"module_occupied\",\"npcId\":%u,\"moduleId\":%u}",
                                                 gm_npc_id, gm_mod_id);
                                        log_info("🚫 NPC %u cannot go to module %u — already occupied", gm_npc_id, gm_mod_id);
                                    } else {
                                    float mx = SERVER_TO_CLIENT(Q16_TO_FLOAT(gm_mod->local_pos.x));
                                    float my = SERVER_TO_CLIENT(Q16_TO_FLOAT(gm_mod->local_pos.y));
                                    // Dismount from current post before re-dispatching
                                    dismount_npc(gm_npc, gm_ship);
                                    // Clear lock — Move To always unfastens the pin
                                    gm_npc->task_locked = false;
                                    if (gm_mod->type_id == MODULE_TYPE_CANNON ||
                                        gm_mod->type_id == MODULE_TYPE_SWIVEL) {
                                        gm_npc->role        = NPC_ROLE_GUNNER;
                                        gm_npc->wants_cannon = false; /* specific pin, not sector-driven */
                                        dispatch_gunner_to_weapon(gm_npc, gm_ship, gm_mod_id, 0.0f);
                                    } else if (gm_mod->type_id == MODULE_TYPE_MAST) {
                                        gm_npc->role            = NPC_ROLE_RIGGER;
                                        gm_npc->assigned_weapon_id = gm_mod_id;
                                        gm_npc->target_local_x  = mx;
                                        gm_npc->target_local_y  = my + 20.0f;
                                        gm_npc->state           = WORLD_NPC_STATE_MOVING;
                                    } else {
                                        /* Generic walk-to (helm, deck position, etc.) */
                                        gm_npc->role            = NPC_ROLE_NONE;
                                        gm_npc->assigned_weapon_id = gm_mod_id;
                                        gm_npc->target_local_x  = mx;
                                        gm_npc->target_local_y  = my + 20.0f;
                                        gm_npc->state           = WORLD_NPC_STATE_MOVING;
                                    }
                                    log_info("📍 NPC %u (%s) → module %u (type %u) on ship %u",
                                             gm_npc_id, gm_npc->name, gm_mod_id,
                                             gm_mod->type_id, gm_npc->ship_id);
                                    snprintf(response, 1024,
                                             "{\"type\":\"message_ack\",\"status\":\"npc_moved_to_module\",\"npcId\":%u}",
                                             gm_npc_id);
                                    } /* end else (not occupied) */
                                } else {
                                    snprintf(response, 1024,
                                             "{\"type\":\"error\",\"message\":\"cannot_goto_module\",\"npcId\":%u}",
                                             gm_npc_id);
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "npc_move_to_pos") == 0) {
                            // NPC MOVE TO POSITION: walk NPC to world coords or board/walk on a ship.
                            // {"type":"npc_move_to_pos","npcId":N,"worldX":F,"worldY":F,"shipId":S}
                            // shipId=0  -> detach from ship and walk to world position
                            // shipId>0  -> attach to that ship and walk to the clicked local position
                            uint32_t tp_npc_id = 0, tp_ship_id = 0;
                            float tp_wx = 0.0f, tp_wy = 0.0f;
                            { char* p = strstr(payload, "\"npcId\":");  if (p) sscanf(p +  8, "%u", &tp_npc_id); }
                            { char* p = strstr(payload, "\"worldX\":"); if (p) sscanf(p +  9, "%f", &tp_wx); }
                            { char* p = strstr(payload, "\"worldY\":"); if (p) sscanf(p +  9, "%f", &tp_wy); }
                            { char* p = strstr(payload, "\"shipId\":"); if (p) sscanf(p +  9, "%u", &tp_ship_id); }
                            WebSocketPlayer* tp_player = find_player(client->player_id);
                            if (tp_player && tp_npc_id != 0) {
                                WorldNpc* tp_npc = NULL;
                                for (int _ni = 0; _ni < world_npc_count; _ni++) {
                                    if (world_npcs[_ni].active && world_npcs[_ni].id == tp_npc_id) {
                                        tp_npc = &world_npcs[_ni]; break;
                                    }
                                }
                                if (tp_npc && tp_npc->company_id == tp_player->company_id) {
                                    /* Dismount from current post first */
                                    SimpleShip* tp_old_ship = find_ship(tp_npc->ship_id);
                                    dismount_npc(tp_npc, tp_old_ship);
                                    tp_npc->task_locked        = false;
                                    tp_npc->assigned_weapon_id = 0;
                                    tp_npc->role               = NPC_ROLE_NONE;

                                    if (tp_ship_id != 0) {
                                        /* Board or walk on a specific ship */
                                        SimpleShip* tp_ship = find_ship(tp_ship_id);
                                    if (tp_ship) {
                                            /* Convert world click → ship-local coords */
                                            float cos_r = cosf(-tp_ship->rotation);
                                            float sin_r = sinf(-tp_ship->rotation);
                                            float ddx    = tp_wx - tp_ship->x;
                                            float ddy    = tp_wy - tp_ship->y;
                                            float lx     = ddx * cos_r - ddy * sin_r;
                                            float ly     = ddx * sin_r + ddy * cos_r;

                                            if (tp_npc->ship_id == tp_ship_id) {
                                                /* Already on the target ship — just walk to the clicked position */
                                                tp_npc->target_local_x = lx;
                                                tp_npc->target_local_y = ly;
                                                tp_npc->state          = WORLD_NPC_STATE_MOVING;
                                                log_info("\u2693 NPC %u (%s) \u2192 on-deck (%.0f, %.0f)",
                                                         tp_npc_id, tp_npc->name, lx, ly);
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"npc_moving\"}");
                                            } else {
                                                /* Detach from old ship (if any) and swim to the hull */
                                                float wx = tp_npc->x;  /* world pos before detach */
                                                float wy = tp_npc->y;
                                                tp_npc->ship_id          = 0;
                                                tp_npc->in_water         = true;
                                                tp_npc->local_x          = wx;
                                                tp_npc->local_y          = wy;
                                                /* The world-click pos is on the hull — swim straight there */
                                                tp_npc->target_local_x   = tp_wx;
                                                tp_npc->target_local_y   = tp_wy;
                                                /* After boarding, walk to the on-deck destination */
                                                tp_npc->boarding_ship_id = tp_ship_id;
                                                tp_npc->boarding_local_x = lx;
                                                tp_npc->boarding_local_y = ly;
                                                tp_npc->state            = WORLD_NPC_STATE_MOVING;
                                                log_info("\U0001f30a NPC %u (%s) swimming to ship %u @ world (%.0f,%.0f) then deck (%.0f,%.0f)",
                                                         tp_npc_id, tp_npc->name, tp_ship_id, tp_wx, tp_wy, lx, ly);
                                                strcpy(response, "{\"type\":\"message_ack\",\"status\":\"npc_moving\"}");
                                            }
                                        } else {
                                            strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                        }
                                    } else {
                                        /* World walk / disembark */
                                        /* Use current world pos as local origin for path continuity */
                                        tp_npc->local_x          = tp_npc->x;
                                        tp_npc->local_y          = tp_npc->y;
                                        tp_npc->ship_id          = 0;
                                        tp_npc->in_water         = true;
                                        tp_npc->boarding_ship_id = 0;  /* cancel any pending boarding */
                                        tp_npc->target_local_x   = tp_wx;
                                        tp_npc->target_local_y   = tp_wy;
                                        tp_npc->state            = WORLD_NPC_STATE_MOVING;
                                        log_info("\U0001f30a NPC %u (%s) \u2192 world (%.0f, %.0f)",
                                                 tp_npc_id, tp_npc->name, tp_wx, tp_wy);
                                        strcpy(response, "{\"type\":\"message_ack\",\"status\":\"npc_moving\"}");
                                    }
                                } else {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"cannot_move_npc\"}");
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "upgrade_ship") == 0) {
                            // UPGRADE SHIP: spend XP to advance one attribute on the player's ship.
                            // {"type":"upgrade_ship","shipId":N,"attribute":"resistance"}
                            WebSocketPlayer* player = find_player(client->player_id);
                            uint16_t upg_ship_id = 0;
                            char upg_attr[32] = "";
                            char* p2;
                            p2 = strstr(payload, "\"shipId\":");    if (p2) { uint32_t _tmp = 0; sscanf(p2 + 9, "%u", &_tmp); upg_ship_id = (uint16_t)_tmp; }
                            p2 = strstr(payload, "\"attribute\":\""); if (p2) sscanf(p2 + 13, "%31[^\"]s", upg_attr);

                            if (!global_sim || upg_ship_id == 0) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"no_simulation\"}");
                            } else {
                                struct Ship* upg_sim_ship = sim_get_ship(global_sim, (entity_id)upg_ship_id);
                                if (!upg_sim_ship) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"ship_not_found\"}");
                                } else if (upg_sim_ship->company_id != 0 &&
                                           upg_sim_ship->company_id != player->company_id) {
                                    log_warn("⛔ Player %u (company %u) cannot upgrade ship %u (company %u)",
                                             player->player_id, player->company_id,
                                             upg_ship_id, upg_sim_ship->company_id);
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"company_mismatch\"}");
                                } else {
                                    ShipAttribute attr = ship_attr_from_name(upg_attr);
                                    if (attr == SHIP_ATTR_COUNT) {
                                        strcpy(response, "{\"type\":\"error\",\"message\":\"unknown_attribute\"}");
                                    } else {
                                        uint8_t old_level = upg_sim_ship->level_stats.levels[attr];
                                        uint32_t cost     = ship_level_xp_cost(&upg_sim_ship->level_stats, attr);
                                        uint16_t total_pts_before = ship_level_total_points(&upg_sim_ship->level_stats);
                                        bool ok = ship_level_upgrade(&upg_sim_ship->level_stats, attr);
                                        if (!ok) {
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"error\",\"message\":\"upgrade_failed\","
                                                "\"xp\":%u,\"cost\":%u,\"level\":%u,"
                                                "\"attrCap\":%u,\"shipLevel\":%u,\"totalCap\":%u}",
                                                upg_sim_ship->level_stats.xp, cost, old_level,
                                                ship_attr_point_cap(attr),
                                                total_pts_before,
                                                SHIP_LEVEL_TOTAL_POINT_CAP);
                                        } else {
                                            uint8_t new_level = upg_sim_ship->level_stats.levels[attr];
                                            uint16_t ship_lvl = ship_level_total_points(&upg_sim_ship->level_stats);
                                            uint32_t next_cost = (ship_lvl < SHIP_LEVEL_TOTAL_POINT_CAP)
                                                ? SHIP_LEVEL_XP_BASE * (uint32_t)(ship_lvl + 1) : 0u;
                                            log_info("⬆️  Ship %u upgraded %s: L%u → L%u (XP remaining: %u, ship level: %u/%u, next cost: %u)",
                                                     upg_ship_id, upg_attr, old_level, new_level,
                                                     upg_sim_ship->level_stats.xp, ship_lvl,
                                                     SHIP_LEVEL_TOTAL_POINT_CAP, next_cost);
                                            /* Broadcast SHIP_LEVEL_UP to all clients */
                                            char lvl_msg[320];
                                            snprintf(lvl_msg, sizeof(lvl_msg),
                                                "{\"type\":\"SHIP_LEVEL_UP\",\"shipId\":%u,"
                                                "\"attribute\":\"%s\",\"level\":%u,\"xp\":%u,"
                                                "\"shipLevel\":%u,\"totalCap\":%u,\"nextUpgradeCost\":%u}",
                                                upg_ship_id, upg_attr, new_level,
                                                upg_sim_ship->level_stats.xp,
                                                ship_lvl, SHIP_LEVEL_TOTAL_POINT_CAP, next_cost);
                                            uint8_t lvl_frame[512];
                                            size_t lvl_flen = websocket_create_frame(WS_OPCODE_TEXT,
                                                lvl_msg, strlen(lvl_msg), (char*)lvl_frame, sizeof(lvl_frame));
                                            if (lvl_flen > 0) {
                                                for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                                                    struct WebSocketClient* wc = &ws_server.clients[ci];
                                                    if (wc->connected && wc->handshake_complete)
                                                        send(wc->fd, lvl_frame, lvl_flen, 0);
                                                }
                                            }
                                            snprintf(response, sizeof(response),
                                                "{\"type\":\"message_ack\",\"status\":\"upgraded\","
                                                "\"attribute\":\"%s\",\"level\":%u,\"xp\":%u,"
                                                "\"shipLevel\":%u,\"totalCap\":%u,\"nextUpgradeCost\":%u}",
                                                upg_attr, new_level,
                                                upg_sim_ship->level_stats.xp,
                                                ship_lvl, SHIP_LEVEL_TOTAL_POINT_CAP, next_cost);
                                        }
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "upgrade_crew_stat") == 0) {
                            // UPGRADE CREW STAT: spend an earned stat point to level one stat.
                            // {"type":"upgrade_crew_stat","npcId":N,"stat":"health"}
                            // Stats: health | damage | stamina | weight
                            // Cost: 1 stat point (earned per global level-up, no XP deducted).
                            // Stat points available = (npc_level - 1) - total_stats_spent.
                            // No per-stat cap — all 65 points can go into any one stat.
                            WebSocketPlayer* player = find_player(client->player_id);
                            uint32_t uc_npc_id = 0;
                            char uc_stat[32] = "";
                            char* p3;
                            p3 = strstr(payload, "\"npcId\":");  if (p3) sscanf(p3 + 8, "%u", &uc_npc_id);
                            p3 = strstr(payload, "\"stat\":\""); if (p3) sscanf(p3 + 8, "%31[^\"]", uc_stat);

                            WorldNpc* uc_npc = NULL;
                            for (int ni = 0; ni < world_npc_count; ni++) {
                                if (world_npcs[ni].active && world_npcs[ni].id == uc_npc_id) {
                                    uc_npc = &world_npcs[ni]; break;
                                }
                            }
                            if (!uc_npc) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"npc_not_found\"}");
                            } else if (uc_npc->company_id != 0 &&
                                       uc_npc->company_id != player->company_id) {
                                log_warn("⛔ Player %u (company %u) cannot upgrade NPC %u (company %u)",
                                         player->player_id, player->company_id,
                                         uc_npc->id, uc_npc->company_id);
                                strcpy(response, "{\"type\":\"error\",\"message\":\"company_mismatch\"}");
                            } else {
                                uint8_t* stat_ptr = NULL;
                                if      (strcmp(uc_stat, "health")  == 0) stat_ptr = &uc_npc->stat_health;
                                else if (strcmp(uc_stat, "damage")  == 0) stat_ptr = &uc_npc->stat_damage;
                                else if (strcmp(uc_stat, "stamina") == 0) stat_ptr = &uc_npc->stat_stamina;
                                else if (strcmp(uc_stat, "weight")  == 0) stat_ptr = &uc_npc->stat_weight;

                                if (!stat_ptr) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"unknown_stat\"}");
                                } else {
                                    /* Stat points available = levels earned - points already spent */
                                    uint8_t total_spent = (uint8_t)(
                                        uc_npc->stat_health + uc_npc->stat_damage +
                                        uc_npc->stat_stamina + uc_npc->stat_weight);
                                    uint8_t points_earned = (uint8_t)(uc_npc->npc_level - 1);
                                    if (total_spent >= points_earned) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"error\",\"message\":\"no_stat_points\","
                                            "\"npcLevel\":%u,\"pointsEarned\":%u,\"pointsSpent\":%u}",
                                            uc_npc->npc_level, points_earned, total_spent);
                                    } else {
                                        (*stat_ptr)++;
                                        /* Recalculate derived stats */
                                        uint16_t new_max = (uint16_t)(100 + uc_npc->stat_health * 20);
                                        if (new_max > uc_npc->max_health)
                                            uc_npc->health += (new_max - uc_npc->max_health);
                                        uc_npc->max_health = new_max;
                                        uint8_t stat_points_left = (uint8_t)(points_earned - (total_spent + 1));
                                        log_info("👤 NPC %u '%s' upgraded %s → %u (level %u, %u stat points left)",
                                                 uc_npc->id, uc_npc->name, uc_stat, *stat_ptr,
                                                 uc_npc->npc_level, stat_points_left);
                                        /* Broadcast NPC_STAT_UP */
                                        char su_msg[256];
                                        snprintf(su_msg, sizeof(su_msg),
                                            "{\"type\":\"NPC_STAT_UP\",\"npcId\":%u,\"stat\":\"%s\","
                                            "\"level\":%u,\"xp\":%u,\"maxHealth\":%u,\"npcLevel\":%u,"
                                            "\"statHealth\":%u,\"statDamage\":%u,\"statStamina\":%u,\"statWeight\":%u,"
                                            "\"statPoints\":%u}",
                                            uc_npc->id, uc_stat, *stat_ptr, uc_npc->xp,
                                            uc_npc->max_health, uc_npc->npc_level,
                                            uc_npc->stat_health, uc_npc->stat_damage,
                                            uc_npc->stat_stamina, uc_npc->stat_weight,
                                            stat_points_left);
                                        uint8_t su_frame[512];
                                        size_t su_flen = websocket_create_frame(WS_OPCODE_TEXT,
                                            su_msg, strlen(su_msg), (char*)su_frame, sizeof(su_frame));
                                        if (su_flen > 0) {
                                            for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                                                struct WebSocketClient* wc = &ws_server.clients[ci];
                                                if (wc->connected && wc->handshake_complete)
                                                    send(wc->fd, su_frame, su_flen, 0);
                                            }
                                        }
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"message_ack\",\"status\":\"stat_upgraded\","
                                            "\"stat\":\"%s\",\"level\":%u,\"statPoints\":%u}",
                                            uc_stat, *stat_ptr, stat_points_left);
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "upgrade_player_stat") == 0) {
                            // UPGRADE PLAYER STAT: spend an earned stat point on a player stat.
                            // {"type":"upgrade_player_stat","stat":"health"}
                            // Stats: health | damage | stamina | weight
                            // Cost: 1 stat point (earned per level-up).
                            // Stat points available = (player_level - 1) - total_stats_spent.
                            WebSocketPlayer* ups_player = find_player(client->player_id);
                            if (!ups_player) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"player_not_found\"}");
                            } else {
                                char ups_stat[32] = "";
                                char* ups_p = strstr(payload, "\"stat\":\"");
                                if (ups_p) sscanf(ups_p + 8, "%31[^\"]", ups_stat);

                                uint8_t* ups_stat_ptr = NULL;
                                if      (strcmp(ups_stat, "health")  == 0) ups_stat_ptr = &ups_player->stat_health;
                                else if (strcmp(ups_stat, "damage")  == 0) ups_stat_ptr = &ups_player->stat_damage;
                                else if (strcmp(ups_stat, "stamina") == 0) ups_stat_ptr = &ups_player->stat_stamina;
                                else if (strcmp(ups_stat, "weight")  == 0) ups_stat_ptr = &ups_player->stat_weight;

                                if (!ups_stat_ptr) {
                                    strcpy(response, "{\"type\":\"error\",\"message\":\"unknown_stat\"}");
                                } else {
                                    uint8_t ups_total_spent = (uint8_t)(
                                        ups_player->stat_health + ups_player->stat_damage +
                                        ups_player->stat_stamina + ups_player->stat_weight);
                                    uint8_t ups_points_earned = (uint8_t)(ups_player->player_level > 1
                                        ? ups_player->player_level - 1 : 0);
                                    if (ups_total_spent >= ups_points_earned) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"error\",\"message\":\"no_stat_points\","
                                            "\"playerLevel\":%u,\"pointsEarned\":%u,\"pointsSpent\":%u}",
                                            ups_player->player_level, ups_points_earned, ups_total_spent);
                                    } else {
                                        (*ups_stat_ptr)++;
                                        /* Recalculate max HP if health stat upgraded */
                                        if (ups_stat_ptr == &ups_player->stat_health) {
                                            uint16_t new_max = (uint16_t)(100 + ups_player->stat_health * 20);
                                            if (new_max > ups_player->max_health)
                                                ups_player->health += (new_max - ups_player->max_health);
                                            ups_player->max_health = new_max;
                                        }
                                        uint8_t ups_points_left = (uint8_t)(ups_points_earned - (ups_total_spent + 1));
                                        log_info("👤 Player %u upgraded %s → %u (level %u, %u stat points left)",
                                                 ups_player->player_id, ups_stat, *ups_stat_ptr,
                                                 ups_player->player_level, ups_points_left);
                                        /* Broadcast PLAYER_STAT_UP to all clients */
                                        char ups_msg[256];
                                        snprintf(ups_msg, sizeof(ups_msg),
                                            "{\"type\":\"PLAYER_STAT_UP\",\"playerId\":%u,\"stat\":\"%s\","
                                            "\"level\":%u,\"xp\":%u,\"maxHealth\":%u,\"playerLevel\":%u,"
                                            "\"statHealth\":%u,\"statDamage\":%u,\"statStamina\":%u,\"statWeight\":%u,"
                                            "\"statPoints\":%u}",
                                            ups_player->player_id, ups_stat, *ups_stat_ptr,
                                            ups_player->player_xp, ups_player->max_health,
                                            ups_player->player_level,
                                            ups_player->stat_health, ups_player->stat_damage,
                                            ups_player->stat_stamina, ups_player->stat_weight,
                                            ups_points_left);
                                        uint8_t ups_frame[512];
                                        size_t ups_flen = websocket_create_frame(WS_OPCODE_TEXT,
                                            ups_msg, strlen(ups_msg), (char*)ups_frame, sizeof(ups_frame));
                                        if (ups_flen > 0) {
                                            for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                                                struct WebSocketClient* wc = &ws_server.clients[ci];
                                                if (wc->connected && wc->handshake_complete)
                                                    send(wc->fd, ups_frame, ups_flen, 0);
                                            }
                                        }
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"message_ack\",\"status\":\"stat_upgraded\","
                                            "\"stat\":\"%s\",\"level\":%u,\"statPoints\":%u}",
                                            ups_stat, *ups_stat_ptr, ups_points_left);
                                    }
                                }
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "toggle_ladder") == 0) {
                            // TOGGLE LADDER: retract or extend a ladder on the player's current ship.
                            // {"type":"toggle_ladder","moduleId":N}
                            WebSocketPlayer* player = find_player(client->player_id);
                            uint32_t tl_module_id = 0;
                            char *p_tl = strstr(payload, "\"moduleId\":");
                            if (p_tl) tl_module_id = (uint32_t)atoi(p_tl + 11);

                            SimpleShip* tl_ship = NULL;
                            ShipModule* tl_module = NULL;
                            for (int si = 0; si < ship_count && !tl_module; si++) {
                                if (!ships[si].active) continue;
                                ShipModule* fm = find_module_by_id(&ships[si], tl_module_id);
                                if (fm) { tl_ship = &ships[si]; tl_module = fm; }
                            }

                            if (!tl_module || !tl_ship || tl_module->type_id != MODULE_TYPE_LADDER) {
                                strcpy(response, "{\"type\":\"error\",\"message\":\"ladder_not_found\"}");
                            } else if (tl_ship->company_id != 0 &&
                                       player->company_id != 0 &&
                                       player->company_id != tl_ship->company_id) {
                                /* Only block if both have a company and they differ.
                                 * Neutral players (company_id==0) may extend any ladder. */
                                strcpy(response, "{\"type\":\"error\",\"message\":\"company_mismatch\"}");
                            } else if (player->parent_ship_id != tl_ship->ship_id &&
                                       player->parent_ship_id != 0) {
                                /* Player is on a DIFFERENT ship — block, but allow from water */ 
                                strcpy(response, "{\"type\":\"error\",\"message\":\"not_on_ship\"}");
                            } else {
                                bool now_retracted = !(tl_module->state_bits & MODULE_STATE_RETRACTED);
                                if (now_retracted)
                                    tl_module->state_bits |= MODULE_STATE_RETRACTED;
                                else
                                    tl_module->state_bits &= ~(uint16_t)MODULE_STATE_RETRACTED;
                                // Mirror state change into the simulation ship module array
                                {
                                    struct Ship* _ts = find_sim_ship(tl_ship->ship_id);
                                    if (_ts) {
                                        for (uint8_t _m = 0; _m < _ts->module_count; _m++) {
                                            if (_ts->modules[_m].id == tl_module_id) {
                                                if (now_retracted)
                                                    _ts->modules[_m].state_bits |= MODULE_STATE_RETRACTED;
                                                else
                                                    _ts->modules[_m].state_bits &= ~(uint16_t)MODULE_STATE_RETRACTED;
                                                break;
                                            }
                                        }
                                    }
                                }
                                log_info("🪜 Player %u toggled ladder %u → %s",
                                         player->player_id, tl_module_id,
                                         now_retracted ? "RETRACTED" : "EXTENDED");
                                char tl_msg[192];
                                snprintf(tl_msg, sizeof(tl_msg),
                                    "{\"type\":\"ladder_state\",\"ship_id\":%u,\"module_id\":%u,\"retracted\":%s}",
                                    tl_ship->ship_id, tl_module_id,
                                    now_retracted ? "true" : "false");
                                websocket_server_broadcast(tl_msg);
                                snprintf(response, sizeof(response),
                                    "{\"type\":\"message_ack\",\"status\":\"ladder_toggled\",\"retracted\":%s}",
                                    now_retracted ? "true" : "false");
                            }
                            handled = true;

                        } else if (strcmp(msg_type, "command") == 0) {
                            /* Player-typed console command.
                             * {"type":"command","command":"/AddPlayerToCompany pirates"}
                             * Supported commands:
                             *   /AddPlayerToCompany <pirates|navy|neutral>
                             *   /TpPlayerToShip <playername> <ship_id>
                             *   /SpawnEntity <crewmember> [neutral|pirates|navy]
                             */
                            char cmd_str[256] = "";
                            char *p_cmd = strstr(payload, "\"command\":");
                            if (p_cmd) {
                                p_cmd += 10;
                                while (*p_cmd == ' ') p_cmd++;
                                if (*p_cmd == '"') {
                                    p_cmd++;
                                    int ci = 0;
                                    while (*p_cmd && *p_cmd != '"' && ci < 255)
                                        cmd_str[ci++] = *p_cmd++;
                                    cmd_str[ci] = '\0';
                                }
                            }

                            /* Strip leading slash */
                            char *cmd_body = cmd_str;
                            if (cmd_body[0] == '/') cmd_body++;

                            /* Parse command name and first argument */
                            char cmd_name[64] = "";
                            char cmd_arg1[64] = "";
                            {
                                int i = 0;
                                while (cmd_body[i] && cmd_body[i] != ' ' && i < 63)
                                    { cmd_name[i] = cmd_body[i]; i++; }
                                cmd_name[i] = '\0';
                                if (cmd_body[i] == ' ') {
                                    i++;
                                    int j = 0;
                                    while (cmd_body[i] && cmd_body[i] != ' ' && j < 63)
                                        cmd_arg1[j++] = cmd_body[i++];
                                    cmd_arg1[j] = '\0';
                                }
                            }

                            /* Lowercase for case-insensitive matching */
                            for (int i = 0; cmd_name[i]; i++)
                                if (cmd_name[i] >= 'A' && cmd_name[i] <= 'Z')
                                    cmd_name[i] += 32;
                            for (int i = 0; cmd_arg1[i]; i++)
                                if (cmd_arg1[i] >= 'A' && cmd_arg1[i] <= 'Z')
                                    cmd_arg1[i] += 32;

                            if (strcmp(cmd_name, "addplayertocompany") == 0) {
                                uint8_t new_company = 0;
                                bool company_valid = true;
                                if (strcmp(cmd_arg1, "pirates") == 0)       new_company = 1;
                                else if (strcmp(cmd_arg1, "navy") == 0)     new_company = 2;
                                else if (strcmp(cmd_arg1, "neutral") == 0)  new_company = 0;
                                else company_valid = false;

                                if (!company_valid) {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Unknown company '%s'. Use: pirates, navy, neutral\"}",
                                        cmd_arg1);
                                } else {
                                    int res = websocket_server_set_player_company(
                                        client->player_id, new_company);
                                    if (res == 0) {
                                        const char *company_names[] = {"Neutral","Pirates","Navy"};
                                        const char *cname = (new_company < 3)
                                            ? company_names[new_company] : "Unknown";
                                        log_info("🏴 Player %u joined company %u (%s) via command",
                                                 client->player_id, new_company, cname);
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":true,"
                                            "\"text\":\"You joined the %s.\"}",
                                            cname);
                                    } else {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":false,"
                                            "\"text\":\"Failed to update company.\"}");
                                    }
                                }

                            } else if (strcmp(cmd_name, "tpplayertoship") == 0) {
                                /* /TpPlayerToShip <playername> <ship_id>
                                 * Teleports the named player to the deck of the specified ship.
                                 * <playername> is a case-insensitive prefix/exact match.
                                 * <ship_id> is the numeric ship ID. */
                                char cmd_arg2[64] = "";
                                {
                                    /* Re-parse from cmd_body to get both args cleanly */
                                    const char *p = cmd_body;
                                    /* Skip command name */
                                    while (*p && *p != ' ') p++;
                                    while (*p == ' ') p++;
                                    /* arg1 = player name */
                                    int ai = 0;
                                    while (*p && *p != ' ' && ai < 63) cmd_arg1[ai++] = *p++;
                                    cmd_arg1[ai] = '\0';
                                    while (*p == ' ') p++;
                                    /* arg2 = ship id */
                                    ai = 0;
                                    while (*p && *p != ' ' && ai < 63) cmd_arg2[ai++] = *p++;
                                    cmd_arg2[ai] = '\0';
                                }

                                if (cmd_arg1[0] == '\0' || cmd_arg2[0] == '\0') {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Usage: /TpPlayerToShip <playername> <ship_id>\"}");
                                } else {
                                    /* Find target player by name (case-insensitive prefix) */
                                    WebSocketPlayer *tp_player = NULL;
                                    char lower_arg1[64];
                                    for (int i = 0; cmd_arg1[i] && i < 63; i++)
                                        lower_arg1[i] = (cmd_arg1[i] >= 'A' && cmd_arg1[i] <= 'Z')
                                            ? cmd_arg1[i] + 32 : cmd_arg1[i];
                                    lower_arg1[strlen(cmd_arg1)] = '\0';

                                    for (int i = 0; i < WS_MAX_CLIENTS && !tp_player; i++) {
                                        if (!players[i].active) continue;
                                        char lower_name[64];
                                        for (int j = 0; players[i].name[j] && j < 63; j++)
                                            lower_name[j] = (players[i].name[j] >= 'A' && players[i].name[j] <= 'Z')
                                                ? players[i].name[j] + 32 : players[i].name[j];
                                        lower_name[strlen(players[i].name)] = '\0';
                                        if (strstr(lower_name, lower_arg1))
                                            tp_player = &players[i];
                                    }

                                    /* Find target ship by ID */
                                    uint16_t target_ship_id = (uint16_t)atoi(cmd_arg2);
                                    SimpleShip *tp_ship = find_ship(target_ship_id);

                                    if (!tp_player) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":false,"
                                            "\"text\":\"Player '%s' not found.\"}",
                                            cmd_arg1);
                                    } else if (!tp_ship) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":false,"
                                            "\"text\":\"Ship %s not found.\"}",
                                            cmd_arg2);
                                    } else {
                                        /* Place player at the deck centre of the target ship */
                                        float deck_cx = (tp_ship->deck_min_x + tp_ship->deck_max_x) * 0.5f;
                                        float deck_cy = (tp_ship->deck_min_y + tp_ship->deck_max_y) * 0.5f;

                                        /* Dismount from any module first */
                                        if (tp_player->is_mounted) {
                                            tp_player->is_mounted         = false;
                                            tp_player->mounted_module_id  = 0;
                                            tp_player->controlling_ship_id = 0;
                                        }

                                        board_player_on_ship(tp_player, tp_ship, deck_cx, deck_cy);

                                        /* Notify all clients of the new position */
                                        char tp_msg[256];
                                        snprintf(tp_msg, sizeof(tp_msg),
                                            "{\"type\":\"player_teleported\","
                                            "\"player_id\":%u,"
                                            "\"x\":%.1f,\"y\":%.1f,"
                                            "\"parent_ship\":%u,"
                                            "\"local_x\":%.1f,\"local_y\":%.1f}",
                                            tp_player->player_id,
                                            tp_player->x, tp_player->y,
                                            tp_ship->ship_id,
                                            deck_cx, deck_cy);
                                        websocket_server_broadcast(tp_msg);

                                        log_info("🚀 Teleported player %u (%s) to ship %u",
                                                 tp_player->player_id, tp_player->name, tp_ship->ship_id);
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":true,"
                                            "\"text\":\"Teleported %s to ship %u.\"}",
                                            tp_player->name, tp_ship->ship_id);
                                    }
                                }

                            } else if (strcmp(cmd_name, "spawnentity") == 0) {
                                /* /SpawnEntity <entityname> [company]
                                 * Spawns an entity at the issuing player's world position.
                                 * entityname: crewmember
                                 * company:    neutral (default), pirates, navy */
                                char cmd_arg2[64] = "";
                                {
                                    const char *p = cmd_body;
                                    while (*p && *p != ' ') p++;
                                    while (*p == ' ') p++;
                                    int ai = 0;
                                    while (*p && *p != ' ' && ai < 63) cmd_arg1[ai++] = *p++;
                                    cmd_arg1[ai] = '\0';
                                    while (*p == ' ') p++;
                                    ai = 0;
                                    while (*p && *p != ' ' && ai < 63) cmd_arg2[ai++] = *p++;
                                    cmd_arg2[ai] = '\0';
                                }
                                /* Lowercase entity and company args */
                                for (int i = 0; cmd_arg1[i]; i++)
                                    if (cmd_arg1[i] >= 'A' && cmd_arg1[i] <= 'Z') cmd_arg1[i] += 32;
                                for (int i = 0; cmd_arg2[i]; i++)
                                    if (cmd_arg2[i] >= 'A' && cmd_arg2[i] <= 'Z') cmd_arg2[i] += 32;

                                if (cmd_arg1[0] == '\0') {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Usage: /SpawnEntity <entityname> [company]\"}");
                                } else if (strcmp(cmd_arg1, "crewmember") != 0) {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Unknown entity '%s'. Known: crewmember\"}",
                                        cmd_arg1);
                                } else if (world_npc_count >= MAX_WORLD_NPCS) {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Cannot spawn: NPC cap reached.\"}");
                                } else {
                                    /* Resolve company (default neutral) */
                                    uint8_t spawn_company = 0;
                                    if (strcmp(cmd_arg2, "pirates") == 0)      spawn_company = 1;
                                    else if (strcmp(cmd_arg2, "navy") == 0)    spawn_company = 2;

                                    /* Issuing player's world position */
                                    WebSocketPlayer *issuer = find_player(client->player_id);
                                    float sx = issuer ? issuer->x : 0.0f;
                                    float sy = issuer ? issuer->y : 0.0f;

                                    /* Spawn free-standing crewmember at that position */
                                    WorldNpc *npc = &world_npcs[world_npc_count++];
                                    memset(npc, 0, sizeof(WorldNpc));
                                    npc->id              = next_world_npc_id++;
                                    npc->active          = true;
                                    npc->role            = NPC_ROLE_NONE;
                                    npc->ship_id         = 0;
                                    npc->company_id      = spawn_company;
                                    npc->move_speed      = 80.0f;
                                    npc->interact_radius = 40.0f;
                                    npc->state           = WORLD_NPC_STATE_IDLE;
                                    npc->x               = sx + 30.0f;
                                    npc->y               = sy;
                                    /* For ship_id==0 NPCs, tick_world_npcs syncs x/y FROM local_x/y,
                                     * so they must match or the NPC will snap to (0,0) next tick. */
                                    npc->local_x         = npc->x;
                                    npc->local_y         = npc->y;
                                    npc->target_local_x  = npc->x;
                                    npc->target_local_y  = npc->y;
                                    npc->npc_level       = 1;
                                    npc->max_health      = 100;
                                    npc->health          = 100;
                                    strncpy(npc->name,     "Crewmember",         sizeof(npc->name)     - 1);
                                    strncpy(npc->dialogue, "Aye aye, Captain!",  sizeof(npc->dialogue) - 1);
                                    g_npcs_dirty = true;

                                    const char *company_names[] = {"Neutral","Pirates","Navy"};
                                    const char *cname = (spawn_company < 3) ? company_names[spawn_company] : "Unknown";
                                    log_info("👤 Spawned crewmember (id %u, company %s) at (%.0f,%.0f) by player %u",
                                             npc->id, cname, npc->x, npc->y, client->player_id);
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":true,"
                                        "\"text\":\"Spawned crewmember (id %u) [%s] at your location.\"}",
                                        npc->id, cname);
                                }

                            } else if (strcmp(cmd_name, "tpplayerto") == 0) {
                                /* /TpPlayerTo <playername> <x> <y>
                                 * Teleports the named player to world coordinates (x, y).
                                 * Removes them from any ship and places them swimming. */
                                char tp2_name[64] = "";
                                float tp2_x = 0.0f, tp2_y = 0.0f;
                                bool tp2_valid = false;
                                {
                                    const char *p = cmd_body;
                                    while (*p && *p != ' ') p++; // skip cmd name
                                    while (*p == ' ') p++;
                                    // read player name (up to next space)
                                    int ai = 0;
                                    while (*p && *p != ' ' && ai < 63) tp2_name[ai++] = *p++;
                                    tp2_name[ai] = '\0';
                                    while (*p == ' ') p++;
                                    // read x
                                    char xbuf[32] = ""; int xi = 0;
                                    while (*p && *p != ' ' && xi < 31) xbuf[xi++] = *p++;
                                    xbuf[xi] = '\0';
                                    while (*p == ' ') p++;
                                    // read y
                                    char ybuf[32] = ""; int yi = 0;
                                    while (*p && *p != '\0' && yi < 31) ybuf[yi++] = *p++;
                                    ybuf[yi] = '\0';
                                    if (tp2_name[0] && xbuf[0] && ybuf[0]) {
                                        tp2_x = (float)atof(xbuf);
                                        tp2_y = (float)atof(ybuf);
                                        tp2_valid = true;
                                    }
                                }
                                if (!tp2_valid) {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Usage: /TpPlayerTo <playername> <x> <y>\"}");
                                } else {
                                    /* Find player (case-insensitive prefix) */
                                    char tp2_lower[64] = "";
                                    for (int i = 0; tp2_name[i] && i < 63; i++)
                                        tp2_lower[i] = (tp2_name[i] >= 'A' && tp2_name[i] <= 'Z')
                                            ? tp2_name[i] + 32 : tp2_name[i];
                                    tp2_lower[strlen(tp2_name)] = '\0';

                                    WebSocketPlayer *tp2_pl = NULL;
                                    for (int i = 0; i < WS_MAX_CLIENTS && !tp2_pl; i++) {
                                        if (!players[i].active) continue;
                                        char ln[64] = "";
                                        for (int j = 0; players[i].name[j] && j < 63; j++)
                                            ln[j] = (players[i].name[j] >= 'A' && players[i].name[j] <= 'Z')
                                                ? players[i].name[j] + 32 : players[i].name[j];
                                        ln[strlen(players[i].name)] = '\0';
                                        if (strstr(ln, tp2_lower)) tp2_pl = &players[i];
                                    }

                                    if (!tp2_pl) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":false,"
                                            "\"text\":\"Player '%s' not found.\"}",
                                            tp2_name);
                                    } else {
                                        /* Detach from any ship and move to world coords */
                                        if (tp2_pl->is_mounted) {
                                            tp2_pl->is_mounted = false;
                                            tp2_pl->mounted_module_id = 0;
                                            tp2_pl->controlling_ship_id = 0;
                                        }
                                        tp2_pl->parent_ship_id = 0;
                                        tp2_pl->local_x = 0.0f;
                                        tp2_pl->local_y = 0.0f;
                                        tp2_pl->velocity_x = 0.0f;
                                        tp2_pl->velocity_y = 0.0f;
                                        tp2_pl->movement_state = PLAYER_STATE_SWIMMING;
                                        tp2_pl->x = tp2_x;
                                        tp2_pl->y = tp2_y;

                                        /* Update sim position via sim_entity_id */
                                        if (global_sim && tp2_pl->sim_entity_id != 0) {
                                            struct Player *sim_pl = sim_get_player(global_sim, tp2_pl->sim_entity_id);
                                            if (sim_pl) {
                                                sim_pl->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(tp2_x));
                                                sim_pl->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(tp2_y));
                                                sim_pl->velocity.x = 0;
                                                sim_pl->velocity.y = 0;
                                                sim_pl->ship_id = 0;
                                            }
                                        }

                                        char tp2_msg[256];
                                        snprintf(tp2_msg, sizeof(tp2_msg),
                                            "{\"type\":\"player_teleported\","
                                            "\"player_id\":%u,"
                                            "\"x\":%.1f,\"y\":%.1f,"
                                            "\"parent_ship\":0,"
                                            "\"local_x\":0.0,\"local_y\":0.0}",
                                            tp2_pl->player_id, tp2_x, tp2_y);
                                        websocket_server_broadcast(tp2_msg);
                                        save_player_to_file(tp2_pl);

                                        log_info("🚀 Admin teleported player %u (%s) to (%.1f, %.1f)",
                                                 tp2_pl->player_id, tp2_pl->name, tp2_x, tp2_y);
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":true,"
                                            "\"text\":\"Teleported %s to (%.1f, %.1f).\"}",
                                            tp2_pl->name, tp2_x, tp2_y);
                                    }
                                }

                            } else if (strcmp(cmd_name, "killplayer") == 0) {
                                /* /KillPlayer <playername>
                                 * Sets a player's health to 0, triggering the respawn screen on their client. */
                                char kp_name[64] = "";
                                {
                                    const char *p = cmd_body;
                                    while (*p && *p != ' ') p++;
                                    while (*p == ' ') p++;
                                    int ai = 0;
                                    while (*p && *p != '\0' && ai < 63) kp_name[ai++] = *p++;
                                    kp_name[ai] = '\0';
                                }
                                /* Case-insensitive match */
                                char kp_lower[64] = "";
                                for (int i = 0; kp_name[i] && i < 63; i++)
                                    kp_lower[i] = (kp_name[i] >= 'A' && kp_name[i] <= 'Z')
                                        ? kp_name[i] + 32 : kp_name[i];
                                kp_lower[strlen(kp_name)] = '\0';

                                if (kp_name[0] == '\0') {
                                    snprintf(response, sizeof(response),
                                        "{\"type\":\"command_response\","
                                        "\"success\":false,"
                                        "\"text\":\"Usage: /KillPlayer <playername>\"}");
                                } else {
                                    WebSocketPlayer *kp_player = NULL;
                                    for (int i = 0; i < WS_MAX_CLIENTS && !kp_player; i++) {
                                        if (!players[i].active) continue;
                                        char lower_n[64] = "";
                                        for (int j = 0; players[i].name[j] && j < 63; j++)
                                            lower_n[j] = (players[i].name[j] >= 'A' && players[i].name[j] <= 'Z')
                                                ? players[i].name[j] + 32 : players[i].name[j];
                                        lower_n[strlen(players[i].name)] = '\0';
                                        if (strstr(lower_n, kp_lower)) kp_player = &players[i];
                                    }

                                    if (!kp_player) {
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":false,"
                                            "\"text\":\"Player '%s' not found.\"}",
                                            kp_name);
                                    } else {
                                        kp_player->health = 0;
                                        player_die(kp_player);  /* drop tombstone, wipe inv */

                                        /* Broadcast ENTITY_HIT with killed=true so all clients see it
                                         * and the dead player's client opens the respawn screen. */
                                        char hit_msg[256];
                                        snprintf(hit_msg, sizeof(hit_msg),
                                            "{\"type\":\"ENTITY_HIT\",\"entityType\":\"player\","
                                            "\"id\":%u,\"x\":%.1f,\"y\":%.1f,"
                                            "\"damage\":9999,\"health\":0,\"maxHealth\":%u,\"killed\":true}",
                                            kp_player->player_id, kp_player->x, kp_player->y,
                                            (unsigned)kp_player->max_health);
                                        websocket_server_broadcast(hit_msg);

                                        log_info("☠️  Admin killed player %u (%s) via /KillPlayer",
                                                 kp_player->player_id, kp_player->name);
                                        snprintf(response, sizeof(response),
                                            "{\"type\":\"command_response\","
                                            "\"success\":true,"
                                            "\"text\":\"Killed %s.\"}",
                                            kp_player->name);
                                    }
                                }

                            } else {
                                snprintf(response, sizeof(response),
                                    "{\"type\":\"command_response\","
                                    "\"success\":false,"
                                    "\"text\":\"Unknown command: /%s\"}",
                                    cmd_name);
                            }
                            handled = true;

                        } else {
                            ws_server.unknown_messages_received++;
                            ws_server.last_unknown_time = get_time_ms();
                            
                            log_warn("❓ Unknown JSON message type from %s:%u (Player: %u)", 
                                     client->ip_address, client->port, client->player_id);
                            log_warn("❓ Full unknown message: %.*s", (int)payload_len, payload);
                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"processed\"}");
                            handled = true;
                        }
                        
                    } else {
                        // Text command (simple protocol)
                        if (strncmp(payload, "PING", 4) == 0) {
                            strcpy(response, "PONG");
                            handled = true;
                            
                        } else if (strncmp(payload, "JOIN:", 5) == 0) {
                            // Extract player name (with safety limits)
                            char player_name[64] = "Player";  // Default name
                            const char* name_src = payload + 5;
                            size_t max_name_len = payload_len - 5;
                            if (max_name_len > sizeof(player_name) - 1) {
                                max_name_len = sizeof(player_name) - 1;
                            }
                            if (max_name_len > 0) {
                                strncpy(player_name, name_src, max_name_len);
                                player_name[max_name_len] = '\0';
                                // Remove any newlines or control characters
                                for (size_t i = 0; i < sizeof(player_name); i++) {
                                    if (player_name[i] == '\0') break;
                                    if (player_name[i] < 32 || player_name[i] > 126) {
                                        player_name[i] = '\0';
                                        break;
                                    }
                                }
                            }
                            
                            uint32_t player_id = next_player_id++;
                            client->player_id = player_id;
                            
                            // Create player for this client
                            WebSocketPlayer* player = create_player(player_id);
                            if (!player) {
                                log_error("Failed to create player for JOIN command from %s:%u", client->ip_address, client->port);
                                client->player_id = 0; // Reset on failure
                                strcpy(response, "{\"type\":\"handshake_response\",\"status\":\"failed\",\"error\":\"server_full\"}");
                            } else {
                                snprintf(response, sizeof(response),
                                        "{\"type\":\"handshake_response\",\"player_id\":%u,\"player_name\":\"%s\",\"server_time\":%u,\"status\":\"connected\"}",
                                        player_id, player_name, get_time_ms());
                                /* Send handshake_response FIRST so the client's temp handler
                                   processes it (and sets assignedPlayerId) before ISLANDS and
                                   STRUCTURES arrive — which must go through the main handler. */
                                {
                                    char hr_frame[512];
                                    size_t hr_len = websocket_create_frame(
                                        WS_OPCODE_TEXT, response, strlen(response),
                                        hr_frame, sizeof(hr_frame));
                                    if (hr_len > 0 && hr_len < sizeof(hr_frame)) {
                                        send(client->fd, hr_frame, hr_len, 0);
                                        log_info("🤝 Sent handshake_response to player %u", player_id);
                                    }
                                    /* Replace response with a no-op ack so the generic deferred
                                       sender at the bottom of this block doesn't emit a duplicate
                                       or malformed message. */
                                    strcpy(response, "{\"type\":\"ack\"}");
                                }
                                // Send ISLANDS
                                {
                                    static char islands_buf[600000];
                                    int pos = 0;
                                    pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos,
                                                    "{\"type\":\"ISLANDS\",\"islands\":[");
                                    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                                        const IslandDef *isl = &ISLAND_PRESETS[ii];
                                        pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos,
                                                        "%s{\"id\":%d,\"x\":%.1f,\"y\":%.1f,\"preset\":\"%s\"",
                                                        ii ? "," : "",
                                                        isl->id, isl->x, isl->y, isl->preset);
                                        if (isl->vertex_count > 0) {
                                            pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos, ",\"vertices\":[");
                                            for (int vi = 0; vi < isl->vertex_count; vi++) {
                                                pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos,
                                                                "%s{\"x\":%.1f,\"y\":%.1f}",
                                                                vi ? "," : "",
                                                                isl->x + isl->vx[vi], isl->y + isl->vy[vi]);
                                            }
                                            pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos, "]");
                                        }
                                        pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos, ",\"resources\":[");
                                        for (int ri = 0; ri < isl->resource_count; ri++) {
                                            const IslandResource *r = &isl->resources[ri];
                                            pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos,
                                                            "%s{\"ri\":%d,\"ox\":%.1f,\"oy\":%.1f,\"type\":\"%s\",\"size\":%.3f,\"hp\":%d,\"maxHp\":%d}",
                                                            ri ? "," : "",
                                                            ri, r->ox, r->oy, res_type_str(r->type_id), r->size, r->health, r->max_health);
                                        }
                                        pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos, "]}");
                                    }
                                    pos += snprintf(islands_buf + pos, sizeof(islands_buf) - pos, "]}");
                                    static char isl_frame[600000];
                                    size_t isl_frame_len = websocket_create_frame(
                                        WS_OPCODE_TEXT, islands_buf, (size_t)pos,
                                        isl_frame, sizeof(isl_frame));
                                    if (isl_frame_len > 0 && isl_frame_len < sizeof(isl_frame)) {
                                        send_all(client->fd, isl_frame, isl_frame_len);
                                        log_info("🏝️  Sent ISLANDS (%d islands) to player %u (payload=%d bytes)", ISLAND_COUNT, player_id, pos);
                                    } else {
                                        log_error("❌ ISLANDS frame creation failed: payload=%d, frame_len=%zu", pos, isl_frame_len);
                                    }
                                }
                                /* Send current placed structures */
                                {
                                    static char structs_buf[8192];
                                    int spos = 0;
                                    spos += snprintf(structs_buf + spos, sizeof(structs_buf) - spos,
                                                     "{\"type\":\"STRUCTURES\",\"structures\":[");
                                    bool sfirst = true;
                                    for (uint32_t si = 0; si < placed_structure_count; si++) {
                                        if (!placed_structures[si].active) continue;
                                        const char* stype_str =
                                            placed_structures[si].type == STRUCT_WOODEN_FLOOR ? "wooden_floor" :
                                            placed_structures[si].type == STRUCT_WORKBENCH    ? "workbench" :
                                            placed_structures[si].type == STRUCT_WALL         ? "wall" :
                                            placed_structures[si].type == STRUCT_DOOR_FRAME   ? "door_frame" :
                                            placed_structures[si].type == STRUCT_DOOR         ? "door" :
                                            placed_structures[si].type == STRUCT_SHIPYARD     ? "shipyard" : "unknown";
                                        bool is_door_s = (placed_structures[si].type == STRUCT_DOOR);
                                        bool is_sy_s   = (placed_structures[si].type == STRUCT_SHIPYARD);
                                        char sy_extra_s[256] = "";
                                        if (is_sy_s) {
                                            char smj[128] = "[]";
                                            if (placed_structures[si].modules_placed) {
                                                int smp = 0;
                                                smj[smp++] = '[';
                                                const char* smn[6] = {"hull_left","hull_right","deck","mast","cannon_port","cannon_stbd"};
                                                bool smf = true;
                                                for (int b = 0; b < 6; b++) {
                                                    if (placed_structures[si].modules_placed & (1u << b)) {
                                                        if (!smf) smj[smp++] = ',';
                                                        smp += snprintf(smj + smp, (int)sizeof(smj) - smp, "\"%s\"", smn[b]);
                                                        smf = false;
                                                    }
                                                }
                                                smj[smp++] = ']';
                                                smj[smp]   = '\0';
                                            }
                                            const char* sphase = placed_structures[si].construction_phase == CONSTRUCTION_BUILDING ? "building" : "empty";
                                            snprintf(sy_extra_s, sizeof(sy_extra_s),
                                                     ",\"construction_phase\":\"%s\",\"modules_placed\":%s",
                                                     sphase, smj);
                                        }
                                        spos += snprintf(structs_buf + spos, sizeof(structs_buf) - spos,
                                                         "%s{\"id\":%u,\"structure_type\":\"%s\","
                                                         "\"island_id\":%u,\"x\":%.1f,\"y\":%.1f,"
                                                         "\"company_id\":%u,\"hp\":%u,\"max_hp\":%u,\"placer_name\":\"%s\""
                                                         ",\"rotation\":%.2f%s%s}",
                                                         sfirst ? "" : ",",
                                                         placed_structures[si].id,
                                                         stype_str,
                                                         placed_structures[si].island_id,
                                                         placed_structures[si].x,
                                                         placed_structures[si].y,
                                                         (unsigned)placed_structures[si].company_id,
                                                         (unsigned)placed_structures[si].hp,
                                                         (unsigned)placed_structures[si].max_hp,
                                                         placed_structures[si].placer_name,
                                                         placed_structures[si].rotation,
                                                         is_door_s ? (placed_structures[si].open ? ",\"open\":true" : ",\"open\":false") : "",
                                                         sy_extra_s);
                                        sfirst = false;
                                    }
                                    spos += snprintf(structs_buf + spos, sizeof(structs_buf) - spos, "]}");
                                    char sf[8448];
                                    size_t sflen = websocket_create_frame(
                                        WS_OPCODE_TEXT, structs_buf, (size_t)spos, sf, sizeof(sf));
                                    if (sflen > 0 && sflen < sizeof(sf))
                                        send(client->fd, sf, sflen, 0);
                                }
                            }
                            handled = true;
                            
                        } else if (strncmp(payload, "GET_STRUCTURES", 14) == 0) {
                            /* Re-send the full placed-structures list to this client. */
                            {
                                static char gs_buf[8192];
                                int gp = 0;
                                gp += snprintf(gs_buf + gp, sizeof(gs_buf) - gp,
                                               "{\"type\":\"STRUCTURES\",\"structures\":[");
                                bool gfirst = true;
                                for (uint32_t si = 0; si < placed_structure_count; si++) {
                                    if (!placed_structures[si].active) continue;
                                    const char* gs_type =
                                        placed_structures[si].type == STRUCT_WOODEN_FLOOR ? "wooden_floor" :
                                        placed_structures[si].type == STRUCT_WORKBENCH    ? "workbench" :
                                        placed_structures[si].type == STRUCT_WALL         ? "wall" :
                                        placed_structures[si].type == STRUCT_DOOR_FRAME   ? "door_frame" :
                                        placed_structures[si].type == STRUCT_DOOR         ? "door" :
                                        placed_structures[si].type == STRUCT_SHIPYARD     ? "shipyard" : "unknown";
                                    bool gs_is_door = (placed_structures[si].type == STRUCT_DOOR);
                                    bool gs_is_sy   = (placed_structures[si].type == STRUCT_SHIPYARD);
                                    char gs_sy_extra[256] = "";
                                    if (gs_is_sy) {
                                        char gmj[128] = "[]";
                                        if (placed_structures[si].modules_placed) {
                                            int gmp = 0;
                                            gmj[gmp++] = '[';
                                            const char* gmn[6] = {"hull_left","hull_right","deck","mast","cannon_port","cannon_stbd"};
                                            bool gmf = true;
                                            for (int b = 0; b < 6; b++) {
                                                if (placed_structures[si].modules_placed & (1u << b)) {
                                                    if (!gmf) gmj[gmp++] = ',';
                                                    gmp += snprintf(gmj + gmp, (int)sizeof(gmj) - gmp, "\"%s\"", gmn[b]);
                                                    gmf = false;
                                                }
                                            }
                                            gmj[gmp++] = ']';
                                            gmj[gmp]   = '\0';
                                        }
                                        const char* gphase = placed_structures[si].construction_phase == CONSTRUCTION_BUILDING ? "building" : "empty";
                                        snprintf(gs_sy_extra, sizeof(gs_sy_extra),
                                                 ",\"construction_phase\":\"%s\",\"modules_placed\":%s",
                                                 gphase, gmj);
                                    }
                                    gp += snprintf(gs_buf + gp, sizeof(gs_buf) - gp,
                                                   "%s{\"id\":%u,\"structure_type\":\"%s\","
                                                   "\"island_id\":%u,\"x\":%.1f,\"y\":%.1f,"
                                                   "\"company_id\":%u,\"hp\":%u,\"max_hp\":%u,\"placer_name\":\"%s\""
                                                   ",\"rotation\":%.2f%s%s}",
                                                   gfirst ? "" : ",",
                                                   placed_structures[si].id, gs_type,
                                                   placed_structures[si].island_id,
                                                   placed_structures[si].x, placed_structures[si].y,
                                                   (unsigned)placed_structures[si].company_id,
                                                   (unsigned)placed_structures[si].hp,
                                                   (unsigned)placed_structures[si].max_hp,
                                                   placed_structures[si].placer_name,
                                                   placed_structures[si].rotation,
                                                   gs_is_door ? (placed_structures[si].open ? ",\"open\":true" : ",\"open\":false") : "",
                                                   gs_sy_extra);
                                    gfirst = false;
                                }
                                gp += snprintf(gs_buf + gp, sizeof(gs_buf) - gp, "]}");
                                char gf[8448];
                                size_t gflen = websocket_create_frame(
                                    WS_OPCODE_TEXT, gs_buf, (size_t)gp, gf, sizeof(gf));
                                if (gflen > 0 && gflen < sizeof(gf))
                                    send(client->fd, gf, gflen, 0);
                                log_info("📦 Sent STRUCTURES (%u) on GET_STRUCTURES to player %u",
                                         placed_structure_count, client->player_id);
                            }
                            strcpy(response, "{\"type\":\"ack\"}");
                            handled = true;

                        } else if (strncmp(payload, "STATE", 5) == 0) {
                            // Request game state
                            snprintf(response, sizeof(response),
                                    "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":[],\"players\":[{\"id\":1001,\"name\":\"Player\",\"x\":400,\"y\":300}],\"projectiles\":[]}",
                                    get_time_ms() / 33, get_time_ms()); // Approximate tick from time
                            handled = true;
                            
                        } else {
                            // Unknown command
                            strcpy(response, "{\"type\":\"message_ack\",\"status\":\"unknown_command\"}");
                            handled = true;
                        }
                    }
                    
                    /* ── Flush deferred cannon-group broadcast ────────────────────────────
                     * handle_cannon_group_config sets pending_group_broadcast_ship_id
                     * instead of broadcasting immediately, so that two rapid group-config
                     * messages in the same recv cycle (e.g. switching two groups to AIMING
                     * at once) collapse into a single broadcast sent here — after the
                     * response ACK is queued — containing the fully-updated state.
                     * ──────────────────────────────────────────────────────────────────── */
                    if (client->pending_group_broadcast_ship_id != 0) {
                        SimpleShip* bship = find_ship(client->pending_group_broadcast_ship_id);
                        if (bship) broadcast_cannon_group_state(bship, client->pending_group_broadcast_company_id);
                        client->pending_group_broadcast_ship_id    = 0;
                        client->pending_group_broadcast_company_id = 0;
                    }

                    // Send response
                    if (handled) {
                        char frame[2048];  // Increased to safely hold 1024-byte response + frame headers
                        size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, response, strlen(response), frame, sizeof(frame));
                        if (frame_len > 0 && frame_len < sizeof(frame)) {
                            ssize_t sent = send(client->fd, frame, frame_len, 0);
                            if (sent > 0) {
                                ws_server.packets_sent++;
                                // Response sent
                            }
                        } else if (frame_len >= sizeof(frame)) {
                            log_error("Frame buffer overflow prevented! frame_len=%zu, buffer=%zu", 
                                     frame_len, sizeof(frame));
                        }
                    }
                    
                    ws_server.packets_received++;
                    
                } else if (opcode == WS_OPCODE_CLOSE) {
                    // CLOSE frame received
                    if (client->player_id > 0) {
                        // Removing player due to disconnect
                        remove_player(client->player_id);
                        client->player_id = 0;
                    }
                    close(client->fd);
                    client->connected = false;
                    break; /* stop processing frames on a closed connection */
                } else if (opcode == WS_OPCODE_PING) {
                    // PING received - sending PONG
                    // Respond with pong
                    char frame[64];
                    size_t frame_len = websocket_create_frame(WS_OPCODE_PONG, payload, payload_len, frame, sizeof(frame));
                    if (frame_len > 0) {
                        (void)send(client->fd, frame, frame_len, 0);
                        // PONG sent
                    }
                } else if (opcode == WS_OPCODE_PONG) {
                    // PONG received
                } else {
                    log_warn("⚠️ Unknown WebSocket opcode 0x%X from %s:%u (Player: %u)", 
                            opcode, client->ip_address, client->port, client->player_id);
                }
                } /* end while: process all buffered frames */
            }
        } else if (received == 0) {
            // Client disconnected
            // WebSocket client disconnected
            if (client->player_id > 0) {
                remove_player(client->player_id);
                client->player_id = 0;
            }
            close(client->fd);
            client->connected = false;
        } else if (errno != EAGAIN && errno != EWOULDBLOCK) {
            // Error
            log_warn("WebSocket client %s:%u error: %s", client->ip_address, client->port, strerror(errno));
            if (client->player_id > 0) {
                remove_player(client->player_id);
                client->player_id = 0;
            }
            close(client->fd);
            client->connected = false;
        }
    }
    
    // Adaptive game state updates - 20Hz base, 30Hz max
    static uint32_t last_game_state_time = 0;
    static uint32_t last_debug_time = 0;
    static uint32_t current_update_rate = 20; // Start at 20 Hz
    uint32_t current_time = get_time_ms();
    
    // Debug player state every 10 seconds
    if (current_time - last_debug_time > 10000) {
        debug_player_state();
        last_debug_time = current_time;
    }
    
    // Calculate adaptive update interval (milliseconds)
    uint32_t update_interval = 1000 / current_update_rate; // 20Hz = 50ms, 30Hz = 33ms
    
    if (current_time - last_game_state_time > update_interval) {
        // Build ships JSON array with physics properties and modules
        // Each brigantine ship entry: ~2400 bytes (22 modules + levelStats).
        // MAX_SIMPLE_SHIPS=50 → worst case ~120000 bytes. Use static to avoid stack overflow.
        static char ships_json[64000];
        int ships_offset = 0;
        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "[");
        bool first_ship = true;
        
        // levelStats dirty tracking: only serialize when XP or total_points actually changes.
        // Indexed by sim->ships[] loop position (stable across a single tick build).
        static uint32_t last_levelstats_xp[MAX_SHIPS];
        static uint32_t last_levelstats_tp[MAX_SHIPS];  // total_points
        static bool levelstats_initialized = false;
        if (!levelstats_initialized) {
            memset(last_levelstats_xp, 0xFF, sizeof(last_levelstats_xp));
            memset(last_levelstats_tp, 0xFF, sizeof(last_levelstats_tp));
            levelstats_initialized = true;
        }
        
        // Log which ship source we're using
        static uint32_t last_ship_source_log = 0;
        if (current_time - last_ship_source_log > 5000) {
            // log_info("📦 Ship source: sim=%p, sim->ship_count=%d, simple_ship_count=%d",
            //          (void*)sim, sim ? sim->ship_count : 0, ship_count);
            if (ship_count > 0) {
                // log_info("📦 Simple ship[0]: module_count=%d", ships[0].module_count);
            }
            last_ship_source_log = current_time;
        }
        
        // Use actual simulation ships if available
        if (sim && sim->ship_count > 0) {
            for (uint32_t s = 0; s < sim->ship_count; s++) {
                const struct Ship* ship = &sim->ships[s];
                if (!first_ship) {
                    ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, ",");
                }
                
                // Convert ship physics to client units
                float pos_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.x));
                float pos_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.y));
                float rotation = Q16_TO_FLOAT(ship->rotation);
                float vel_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->velocity.x));
                float vel_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->velocity.y));
                float ang_vel = Q16_TO_FLOAT(ship->angular_velocity);
                float rudder_radians = ship->rudder_angle * (3.14159f / 180.0f); // Convert degrees to radians

                // Look up matching SimpleShip for ammo data (O(1) via cache)
                const SimpleShip* simple_ship = find_ship(ship->id);

                char ship_entry[6144];
                /* Ghost ships store hull_health as raw int32 (0–60000).
                 * Normal ships use Q16 encoding (0.0–100.0). */
                float hull_health_pct = (ship->company_id == COMPANY_GHOST)
                    ? (float)ship->hull_health
                    : Q16_TO_FLOAT(ship->hull_health);
                int offset = snprintf(ship_entry, sizeof(ship_entry),
                        "{\"id\":%u,\"seq\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                        "\"rudder_angle\":%.3f,"
                        "\"hullHealth\":%.2f,\"company\":%u,\"shipType\":%u,"
                        "\"ammo\":%u,\"infiniteAmmo\":%s,\"modules\":[",
                        ship->id, simple_ship ? simple_ship->ship_seq : (uint8_t)(ship->id & 0xFF),
                        pos_x, pos_y, rotation, vel_x, vel_y, ang_vel,
                        rudder_radians,
                        hull_health_pct,
                        simple_ship ? simple_ship->company_id : COMPANY_NEUTRAL,
                        simple_ship ? simple_ship->ship_type  : SHIP_TYPE_BRIGANTINE,
                        simple_ship ? simple_ship->cannon_ammo : 0,
                        (simple_ship && simple_ship->infinite_ammo) ? "true" : "false");
                
                // Add modules array
                // Planks (100-109) and deck (200): only send health/ID, client generates positions
                // Gameplay modules (1000+): send full transform
                for (uint8_t m = 0; m < ship->module_count && offset < (int)sizeof(ship_entry) - 200; m++) {
                    const ShipModule* module = &ship->modules[m];
                    
                    if (module->type_id == MODULE_TYPE_PLANK) {
                        // Plank: only health data (client has hard-coded positions from hull)
                        offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                            "%s{\"id\":%u,\"typeId\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                            m > 0 ? "," : "", module->id, module->type_id,
                            (int)module->health, (int)module->target_health, (int)module->max_health);
                    } else if (module->type_id == MODULE_TYPE_DECK) {
                        // Deck: ID, type, health, and fire zone state bits (client generates polygon from hull).
                        // Including health lets the client hide the deck the tick it reaches 0 HP,
                        // even if the server hasn't yet removed it from the sim ship's module list.
                        offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                            "%s{\"id\":%u,\"typeId\":%u,\"health\":%d,\"maxHealth\":%d,\"targetHealth\":%d,\"stateBits\":%u}",
                            m > 0 ? "," : "", module->id, module->type_id,
                            (int)module->health, (int)module->max_health, (int)module->target_health,
                            (unsigned)module->state_bits);
                    } else {
                        // Gameplay modules: full transform data
                        float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                        float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                        float module_rot = Q16_TO_FLOAT(module->local_rot);
                        
                        // Add module-specific data based on type
                        if (module->type_id == MODULE_TYPE_MAST) {
                            // Mast: include openness, sail angle, wind efficiency, fiber HP, and health
                            float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                            float wind_eff   = Q16_TO_FLOAT(module->data.mast.wind_efficiency);
                            float fh         = Q16_TO_FLOAT(module->data.mast.fiber_health);
                            float fhmax      = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f,\"windEfficiency\":%.3f,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f,\"fiberFireIntensity\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.mast.openness, sail_angle, wind_eff,
                                fh, fhmax, (unsigned)module->data.mast.sail_fire_intensity,
                                (int)module->health, (int)module->target_health, (int)module->max_health);
                        } else if (module->type_id == MODULE_TYPE_CANNON) {
                            // Cannon: include aim direction, state, and health
                            float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, aim_direction,
                                (unsigned)module->state_bits,
                                (int)module->health, (int)module->target_health, (int)module->max_health);
                        } else if (module->type_id == MODULE_TYPE_SWIVEL) {
                            // Swivel: include current aim direction, state, and health
                            float aim_dir = Q16_TO_FLOAT(module->data.swivel.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, aim_dir,
                                (unsigned)module->state_bits,
                                (int)module->health, (int)module->target_health, (int)module->max_health);
                        } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                            // Helm: include wheel rotation, occupied status, state, and health
                            float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s,\"state\":%u,\"health\":%d,\"targetHealth\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, wheel_rot,
                                (module->data.helm.occupied_by != 0) ? "true" : "false",
                                (unsigned)module->state_bits,
                                (int)module->health, (int)module->target_health, (int)module->max_health);
                        } else {
                            // Generic module (ladder, etc.): transform + state + health
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"state\":%u,\"health\":%d,\"maxHealth\":%d}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, (unsigned)module->state_bits,
                                (int)module->health, (int)module->max_health);
                        }
                    }
                }
                
                uint32_t cur_xp = ship->level_stats.xp;
                uint32_t cur_tp = (uint32_t)ship_level_total_points(&ship->level_stats);
                bool lvl_dirty = (s >= MAX_SHIPS) ||
                                 (cur_xp != last_levelstats_xp[s]) ||
                                 (cur_tp != last_levelstats_tp[s]);

                if (lvl_dirty) {
                    if (s < MAX_SHIPS) {
                        last_levelstats_xp[s] = cur_xp;
                        last_levelstats_tp[s] = cur_tp;
                    }
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                        "],\"levelStats\":{"
                        "\"weight\":%u,\"resistance\":%u,\"damage\":%u,\"crew\":%u,\"sturdiness\":%u,"
                        "\"xp\":%u,\"maxCrew\":%u,"
                        "\"shipLevel\":%u,\"totalPoints\":%u,\"totalCap\":%u,"
                        "\"nextUpgradeCost\":%u,"
                        "\"attrCaps\":{\"weight\":%u,\"resistance\":%u,\"damage\":%u,\"crew\":%u,\"sturdiness\":%u}"
                        "}}",
                        ship->level_stats.levels[SHIP_ATTR_WEIGHT],
                        ship->level_stats.levels[SHIP_ATTR_RESISTANCE],
                        ship->level_stats.levels[SHIP_ATTR_DAMAGE],
                        ship->level_stats.levels[SHIP_ATTR_CREW],
                        ship->level_stats.levels[SHIP_ATTR_STURDINESS],
                        cur_xp,
                        (unsigned)ship_level_max_crew(&ship->level_stats),
                        cur_tp, cur_tp,
                        SHIP_LEVEL_TOTAL_POINT_CAP,
                        cur_tp < SHIP_LEVEL_TOTAL_POINT_CAP
                            ? SHIP_LEVEL_XP_BASE * (cur_tp + 1u)
                            : 0u,
                        ship_attr_point_cap(SHIP_ATTR_WEIGHT),
                        ship_attr_point_cap(SHIP_ATTR_RESISTANCE),
                        ship_attr_point_cap(SHIP_ATTR_DAMAGE),
                        ship_attr_point_cap(SHIP_ATTR_CREW),
                        ship_attr_point_cap(SHIP_ATTR_STURDINESS));
                } else {
                    // levelStats unchanged — close the modules array and ship object
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset, "]}");
                }
                {
                    int n = snprintf(ships_json + ships_offset, sizeof(ships_json) - (size_t)(ships_offset < (int)sizeof(ships_json) ? ships_offset : (int)sizeof(ships_json)-1), "%s", ship_entry);
                    if (n > 0) ships_offset += n;
                    if (ships_offset >= (int)sizeof(ships_json) - 1) ships_offset = (int)sizeof(ships_json) - 1;
                }
                first_ship = false;
            }
        } else {
            // Fallback to simple ships array (backward compatibility)
            for (int s = 0; s < ship_count; s++) {
                if (ships[s].active) {
                    if (!first_ship) {
                        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, ",");
                        if (ships_offset >= (int)sizeof(ships_json) - 1) ships_offset = (int)sizeof(ships_json) - 1;
                    }
                    
                    // Build ship entry with modules
                    char ship_entry[6144];
                    int offset = snprintf(ship_entry, sizeof(ship_entry),
                            "{\"id\":%u,\"seq\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                            "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"angular_velocity\":%.3f,"
                            "\"rudder_angle\":%.3f,"
                            "\"ammo\":%u,\"infiniteAmmo\":%s,\"modules\":[",
                            ships[s].ship_id, ships[s].ship_seq,
                            ships[s].x, ships[s].y, ships[s].rotation,
                            ships[s].velocity_x, ships[s].velocity_y, ships[s].angular_velocity,
                            0.0f,
                            ships[s].cannon_ammo, ships[s].infinite_ammo ? "true" : "false");
                    
                    // Add modules from simple ships
                    for (int m = 0; m < ships[s].module_count && offset < (int)sizeof(ship_entry) - 200; m++) {
                        const ShipModule* module = &ships[s].modules[m];
                        float module_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.x));
                        float module_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(module->local_pos.y));
                        float module_rot = Q16_TO_FLOAT(module->local_rot);
                        
                        // Add module-specific data based on type
                        if (module->type_id == MODULE_TYPE_MAST) {
                            // Mast: include openness, sail angle, wind efficiency, fiber HP
                            float sail_angle = Q16_TO_FLOAT(module->data.mast.angle);
                            float wind_eff   = Q16_TO_FLOAT(module->data.mast.wind_efficiency);
                            float fh         = Q16_TO_FLOAT(module->data.mast.fiber_health);
                            float fhmax      = Q16_TO_FLOAT(module->data.mast.fiber_max_health);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"openness\":%u,\"sailAngle\":%.3f,\"windEfficiency\":%.3f,\"fiberHealth\":%.0f,\"fiberMaxHealth\":%.0f}",
                                m > 0 ? "," : "", module->id, module->type_id, 
                                module_x, module_y, module_rot, module->data.mast.openness, sail_angle, wind_eff,
                                fh, fhmax);
                        } else if (module->type_id == MODULE_TYPE_CANNON) {
                            // Cannon: include aim direction, state (ammo is ship-level)
                            float aim_direction = Q16_TO_FLOAT(module->data.cannon.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, aim_direction,
                                (unsigned)module->state_bits);
                        } else if (module->type_id == MODULE_TYPE_SWIVEL) {
                            // Swivel: include current aim direction and state
                            float aim_dir = Q16_TO_FLOAT(module->data.swivel.aim_direction);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"aimDir\":%.3f,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, aim_dir,
                                (unsigned)module->state_bits);
                        } else if (module->type_id == MODULE_TYPE_HELM || module->type_id == MODULE_TYPE_STEERING_WHEEL) {
                            // Helm: include wheel rotation, occupied status, state
                            float wheel_rot = Q16_TO_FLOAT(module->data.helm.wheel_rotation);
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"wheelRot\":%.3f,\"occupied\":%s,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, wheel_rot,
                                (module->data.helm.occupied_by != 0) ? "true" : "false",
                                (unsigned)module->state_bits);
                        } else {
                            // Generic module (mast, ladder, etc.): transform + state
                            offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset,
                                "%s{\"id\":%u,\"typeId\":%u,\"x\":%.1f,\"y\":%.1f,\"rotation\":%.2f,\"state\":%u}",
                                m > 0 ? "," : "", module->id, module->type_id,
                                module_x, module_y, module_rot, (unsigned)module->state_bits);
                        }
                    }
                    
                    offset += snprintf(ship_entry + offset, sizeof(ship_entry) - offset, "]}");
                    {
                        int n2 = snprintf(ships_json + ships_offset, sizeof(ships_json) - (size_t)(ships_offset < (int)sizeof(ships_json) ? ships_offset : (int)sizeof(ships_json)-1), "%s", ship_entry);
                        if (n2 > 0) ships_offset += n2;
                        if (ships_offset >= (int)sizeof(ships_json) - 1) ships_offset = (int)sizeof(ships_json) - 1;
                    }
                    first_ship = false;
                }
            }
        }
        ships_offset += snprintf(ships_json + ships_offset, sizeof(ships_json) - ships_offset, "]");
        
        // Build players JSON array with ship relationship data
        // Static: each entry is ~900 bytes; 64 KB handles up to ~70 active players.
        static char players_json[65536];
        int players_offset = 0;
        players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, "[");
        bool first_player = true;
        int active_count = 0;
        
        for (int p = 0; p < WS_MAX_CLIENTS; p++) {
            if (players[p].active) {
                if (!first_player) {
                    players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, ",");
                }

                // Build inventory JSON
                char inv_buf[1024];
                int inv_off = 0;
                inv_off += snprintf(inv_buf + inv_off, sizeof(inv_buf) - inv_off,
                                    ",\"inventory\":{\"slots\":[");
                for (int s = 0; s < INVENTORY_SLOTS; s++) {
                    if (s > 0 && inv_off < (int)sizeof(inv_buf) - 1)
                        inv_buf[inv_off++] = ',';
                    inv_off += snprintf(inv_buf + inv_off, sizeof(inv_buf) - inv_off,
                                        "[%d,%d]",
                                        (int)players[p].inventory.slots[s].item,
                                        (int)players[p].inventory.slots[s].quantity);
                }
                inv_off += snprintf(inv_buf + inv_off, sizeof(inv_buf) - inv_off,
                                    "],\"equip\":{\"helm\":%d,\"torso\":%d,\"legs\":%d,"
                                    "\"feet\":%d,\"hands\":%d,\"shield\":%d},"
                                    "\"activeSlot\":%d}",
                                    (int)players[p].inventory.equipment.helm,
                                    (int)players[p].inventory.equipment.torso,
                                    (int)players[p].inventory.equipment.legs,
                                    (int)players[p].inventory.equipment.feet,
                                    (int)players[p].inventory.equipment.hands,
                                    (int)players[p].inventory.equipment.shield,
                                    (int)players[p].inventory.active_slot);

                char player_entry[3072];
                snprintf(player_entry, sizeof(player_entry),
                        "{\"id\":%u,\"name\":\"%s\",\"world_x\":%.1f,\"world_y\":%.1f,\"rotation\":%.3f,"
                        "\"velocity_x\":%.2f,\"velocity_y\":%.2f,\"is_moving\":%s,"
                        "\"movement_direction_x\":%.2f,\"movement_direction_y\":%.2f,"
                        "\"parent_ship\":%u,\"local_x\":%.1f,\"local_y\":%.1f,\"state\":\"%s\","
                        "\"is_mounted\":%s,\"mounted_module_id\":%u,\"controlling_ship\":%u,"
                        "\"company\":%u,\"health\":%u,\"max_health\":%u,\"on_island\":%u,"
                        "\"player_level\":%u,\"player_xp\":%u,"
                        "\"stat_health\":%u,\"stat_damage\":%u,\"stat_stamina\":%u,\"stat_weight\":%u,"
                        "\"stat_points\":%u%s}",
                        players[p].player_id, players[p].name[0] ? players[p].name : "Player",
                        players[p].x, players[p].y, players[p].rotation,
                        players[p].velocity_x, players[p].velocity_y,
                        players[p].is_moving ? "true" : "false",
                        players[p].movement_direction_x, players[p].movement_direction_y,
                        players[p].parent_ship_id, players[p].local_x, players[p].local_y,
                        get_state_string(players[p].movement_state),
                        players[p].is_mounted ? "true" : "false",
                        players[p].mounted_module_id,
                        players[p].controlling_ship_id,
                        players[p].company_id,
                        players[p].health, players[p].max_health,
                        players[p].on_island_id,
                        (unsigned)players[p].player_level,
                        (unsigned)players[p].player_xp,
                        (unsigned)players[p].stat_health,
                        (unsigned)players[p].stat_damage,
                        (unsigned)players[p].stat_stamina,
                        (unsigned)players[p].stat_weight,
                        (unsigned)((players[p].player_level > 1)
                            ? (players[p].player_level - 1)
                              - (players[p].stat_health + players[p].stat_damage
                                 + players[p].stat_stamina + players[p].stat_weight)
                            : 0),
                        inv_buf);
                players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, "%s", player_entry);
                first_player = false;
                active_count++;
            }
        }
        players_offset += snprintf(players_json + players_offset, sizeof(players_json) - players_offset, "]");
        
        // Build projectiles JSON array
        char projectiles_json[2048];
        int projectiles_offset = 0;
        projectiles_offset += snprintf(projectiles_json + projectiles_offset, sizeof(projectiles_json) - projectiles_offset, "[");
        bool first_projectile = true;
        
        // Debug: Log projectile count
        static uint32_t last_projectile_log = 0;
        if (current_time - last_projectile_log > 2000 && global_sim) {
            // log_info("🎯 Projectile count: %u", global_sim->projectile_count);
            last_projectile_log = current_time;
        }
        
        if (global_sim && global_sim->projectile_count > 0) {
            for (uint16_t p = 0; p < global_sim->projectile_count; p++) {
                struct Projectile* proj = &global_sim->projectiles[p];
                
                if (!first_projectile) {
                    projectiles_offset += snprintf(projectiles_json + projectiles_offset, 
                                                  sizeof(projectiles_json) - projectiles_offset, ",");
                }
                
                float proj_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.x));
                float proj_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.y));
                float proj_vx = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->velocity.x));
                float proj_vy = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->velocity.y));
                
                projectiles_offset += snprintf(projectiles_json + projectiles_offset, 
                                              sizeof(projectiles_json) - projectiles_offset,
                                              "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"vx\":%.1f,\"vy\":%.1f,\"type\":%u,\"owner\":%u}",
                                              proj->id, proj_x, proj_y, proj_vx, proj_vy, proj->type, proj->owner_id);
                first_projectile = false;
            }
        }
        projectiles_offset += snprintf(projectiles_json + projectiles_offset, sizeof(projectiles_json) - projectiles_offset, "]");

        // Build world NPCs JSON array — only rebuilt when g_npcs_dirty is set.
        // tick_world_npcs() marks it dirty every tick; on idle (no NPC tick) we reuse
        // the previous buffer, saving ~32 KB of snprintf work per broadcast.
        static char npcs_json[32768];
        static int  npcs_offset = 2; // starts valid: "[]" written at init
        if (npcs_offset < 2) { npcs_json[0] = '['; npcs_json[1] = ']'; npcs_json[2] = '\0'; }
        if (g_npcs_dirty) {
            npcs_offset = 0;
            npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset, "[");
            bool first_npc = true;
            for (int n = 0; n < world_npc_count; n++) {
                const WorldNpc* npc = &world_npcs[n];
                if (!npc->active) continue;
                if (!first_npc)
                    npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset, ",");
                npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset,
                    "{\"id\":%u,\"name\":\"%s\",\"type\":0,"
                    "\"x\":%.1f,\"y\":%.1f,\"rotation\":%.3f,"
                    "\"ship_id\":%u,\"local_x\":%.1f,\"local_y\":%.1f,"
                    "\"interact_radius\":%.1f,\"state\":%u,\"role\":%u,\"company\":%u,"
                    "\"assigned_weapon_id\":%u,"
                    "\"npc_level\":%u,\"health\":%u,\"max_health\":%u,\"xp\":%u,"
                    "\"stat_health\":%u,\"stat_damage\":%u,\"stat_stamina\":%u,\"stat_weight\":%u,"
                    "\"stat_points\":%u,\"locked\":%d}",
                    npc->id, npc->name,
                    npc->x, npc->y, npc->rotation,
                    npc->ship_id, npc->local_x, npc->local_y,
                    npc->interact_radius, (unsigned)npc->state, (unsigned)npc->role, (unsigned)npc->company_id,
                    npc->assigned_weapon_id,
                    (unsigned)npc->npc_level, (unsigned)npc->health, (unsigned)npc->max_health, npc->xp,
                    (unsigned)npc->stat_health, (unsigned)npc->stat_damage, (unsigned)npc->stat_stamina, (unsigned)npc->stat_weight,
                    (unsigned)((npc->npc_level > 0u ? (uint8_t)(npc->npc_level - 1u) : 0u) -
                        (npc->stat_health + npc->stat_damage + npc->stat_stamina + npc->stat_weight)),
                    (int)npc->task_locked);
                first_npc = false;
            }
            npcs_offset += snprintf(npcs_json + npcs_offset, sizeof(npcs_json) - npcs_offset, "]");
            g_npcs_dirty = false;
        }
        
        // Adaptive tick rate based on activity
        bool has_recent_movement = (current_time - g_last_movement_time) < 2000; // Movement in last 2 seconds
        
        // Determine optimal update rate
        if (active_count == 0) {
            current_update_rate = 5; // 5Hz when no players
        } else if (has_recent_movement && active_count > 1) {
            current_update_rate = 30; // 30Hz during multiplayer action
        } else if (has_recent_movement) {
            current_update_rate = 25; // 25Hz during single player movement
        } else {
            current_update_rate = 20; // 20Hz baseline
        }
        
        // Cap at maximum rate
        if (current_update_rate > 30) current_update_rate = 30;
        
        // ── Assemble GAME_STATE directly — no intermediate copy ────────────────────
        // Builds the JSON by memcpy-ing the already-serialised sub-blobs directly
        // into the output buffer.  Avoids a second full-size snprintf that would
        // scan and copy up to 100 KB purely to concatenate strings.
        static char game_state[131072];
        int gs_off = 0;
        gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off,
                "{\"type\":\"GAME_STATE\",\"tick\":%u,\"timestamp\":%u,\"ships\":",
                current_time / 33, current_time);
        if (gs_off + ships_offset < (int)sizeof(game_state) - 1) {
            memcpy(game_state + gs_off, ships_json, (size_t)ships_offset);
            gs_off += ships_offset;
        }
        gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off, ",\"players\":");
        if (gs_off + players_offset < (int)sizeof(game_state) - 1) {
            memcpy(game_state + gs_off, players_json, (size_t)players_offset);
            gs_off += players_offset;
        }
        gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off, ",\"projectiles\":");
        if (gs_off + projectiles_offset < (int)sizeof(game_state) - 1) {
            memcpy(game_state + gs_off, projectiles_json, (size_t)projectiles_offset);
            gs_off += projectiles_offset;
        }
        gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off, ",\"npcs\":");
        if (gs_off + npcs_offset < (int)sizeof(game_state) - 1) {
            memcpy(game_state + gs_off, npcs_json, (size_t)npcs_offset);
            gs_off += npcs_offset;
        }
        /* ── Tombstones ───────────────────────────────────────────────────── */
        gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off,
                           ",\"tombstones\":[");
        {
            bool first_tomb = true;
            for (int ti = 0; ti < (int)MAX_TOMBSTONES; ti++) {
                if (!tombstones[ti].active) continue;
                uint32_t age = current_time - tombstones[ti].spawn_time_ms;
                uint32_t rem = (age < TOMBSTONE_TTL_MS) ? (TOMBSTONE_TTL_MS - age) : 0u;
                if (!first_tomb && gs_off < (int)sizeof(game_state) - 2)
                    game_state[gs_off++] = ',';
                gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off,
                    "{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"ownerName\":\"%s\",\"remainingMs\":%u}",
                    tombstones[ti].id, tombstones[ti].x, tombstones[ti].y,
                    tombstones[ti].owner_name, rem);
                first_tomb = false;
            }
        }
        if (gs_off < (int)sizeof(game_state) - 1) game_state[gs_off++] = ']';
        /* ── Dropped Items ────────────────────────────────────────────────── */
        gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off,
                           ",\"droppedItems\":[");
        {
            bool first_drop = true;
            for (int di = 0; di < (int)MAX_DROPPED_ITEMS; di++) {
                if (!dropped_items[di].active) continue;
                if (!first_drop && gs_off < (int)sizeof(game_state) - 2)
                    game_state[gs_off++] = ',';
                gs_off += snprintf(game_state + gs_off, (int)sizeof(game_state) - gs_off,
                    "{\"id\":%u,\"itemKind\":%u,\"quantity\":%u,\"x\":%.1f,\"y\":%.1f}",
                    dropped_items[di].id,
                    (unsigned)dropped_items[di].item_kind,
                    (unsigned)dropped_items[di].quantity,
                    dropped_items[di].x, dropped_items[di].y);
                first_drop = false;
            }
        }
        if (gs_off < (int)sizeof(game_state) - 1) game_state[gs_off++] = ']';
        if (gs_off < (int)sizeof(game_state) - 1) {
            game_state[gs_off++] = '}';
            game_state[gs_off]   = '\0';
        }

        // ── Frame once, broadcast to every client ──────────────────────────────
        // strlen + websocket_create_frame computed once outside the loop.
        // All clients receive the identical pre-built frame buffer.
        static char broadcast_frame[131086];
        size_t gs_payload_len = (size_t)gs_off;
        size_t broadcast_frame_len = websocket_create_frame(
            WS_OPCODE_TEXT, game_state, gs_payload_len,
            broadcast_frame, sizeof(broadcast_frame));
        if (broadcast_frame_len > 0) {
            for (int i = 0; i < WS_MAX_CLIENTS; i++) {
                struct WebSocketClient* client = &ws_server.clients[i];
                if (client->connected && client->handshake_complete) {
                    ssize_t sent = send(client->fd, broadcast_frame, broadcast_frame_len, 0);
                    if (sent > 0) ws_server.packets_sent++;
                }
            }
        }
        last_game_state_time = current_time;
    }
    
    // ===== BROADCAST WORLD STATE (WIND, ETC.) =====
    static uint32_t last_world_state_time = 0;
    if (current_time - last_world_state_time >= 5000) { // Every 5 seconds
        char world_state[256];
        float wind_power = global_sim ? global_sim->wind_power : 0.0f;
        float wind_direction = global_sim ? global_sim->wind_direction : 0.0f;
        
        snprintf(world_state, sizeof(world_state),
                "{\"type\":\"WORLD_STATE\",\"windPower\":%.2f,\"windDirection\":%.2f}",
                wind_power, wind_direction);
        
        // Broadcast to all connected clients
        for (int i = 0; i < WS_MAX_CLIENTS; i++) {
            struct WebSocketClient* client = &ws_server.clients[i];
            if (client->connected && client->handshake_complete) {
                char frame[512];
                size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, world_state, strlen(world_state), frame, sizeof(frame));
                if (frame_len > 0) {
                    send(client->fd, frame, frame_len, 0);
                }
            }
        }
        last_world_state_time = current_time;
    }
    
    return 0;
}

/* =========================================================================
 * NPC Public API
 * ========================================================================= */

uint16_t websocket_server_create_npc(uint16_t ship_id, module_id_t module_id, NpcRole role) {
    if (npc_count >= MAX_NPC_AGENTS) {
        log_warn("Cannot create NPC: MAX_NPC_AGENTS (%d) reached", MAX_NPC_AGENTS);
        return 0;
    }
    SimpleShip* ship = find_ship(ship_id);
    if (!ship) {
        log_warn("Cannot create NPC: ship %u not found", ship_id);
        return 0;
    }

    NpcAgent* npc = &npc_agents[npc_count++];
    memset(npc, 0, sizeof(NpcAgent));
    npc->npc_id       = next_npc_id++;
    npc->ship_id      = ship_id;
    npc->module_id    = module_id;
    npc->role         = role;
    npc->active       = true;
    npc->fire_interval = 5.0f;
    npc->fire_cooldown = 2.0f; // Small initial delay before first shot

    // Mark the module as occupied so players cannot mount it
    ShipModule* mod = find_module_on_ship(ship, module_id);
    if (mod) mod->state_bits |= MODULE_STATE_OCCUPIED;

    log_info("🤖 NPC %u created: role=%d ship=%u module=%u",
             npc->npc_id, (int)role, ship_id, module_id);
    return npc->npc_id;
}

void websocket_server_remove_npc(uint16_t npc_id) {
    for (int i = 0; i < npc_count; i++) {
        if (npc_agents[i].npc_id == npc_id) {
            // Release the module
            SimpleShip* ship = find_ship(npc_agents[i].ship_id);
            if (ship) {
                ShipModule* mod = find_module_on_ship(ship, npc_agents[i].module_id);
                if (mod) mod->state_bits &= ~MODULE_STATE_OCCUPIED;
            }
            // Compact the array
            memmove(&npc_agents[i], &npc_agents[i + 1],
                    (npc_count - i - 1) * sizeof(NpcAgent));
            npc_count--;
            log_info("🤖 NPC %u removed", npc_id);
            return;
        }
    }
    log_warn("websocket_server_remove_npc: NPC %u not found", npc_id);
}

void websocket_server_npc_set_target(uint16_t npc_id, uint16_t target_ship_id) {
    for (int i = 0; i < npc_count; i++) {
        if (npc_agents[i].npc_id == npc_id) {
            npc_agents[i].target_ship_id = target_ship_id;
            log_info("🤖 NPC %u: target set to ship %u", npc_id, target_ship_id);
            return;
        }
    }
    log_warn("websocket_server_npc_set_target: NPC %u not found", npc_id);
}

void websocket_server_broadcast(const char* message) {
    if (!ws_server.running || !message) return;
    
    char frame[2048];
    size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, message, strlen(message), frame, sizeof(frame));
    if (frame_len == 0) return;
    
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (ws_server.clients[i].connected && ws_server.clients[i].handshake_complete) {
            ssize_t sent = send(ws_server.clients[i].fd, frame, frame_len, 0);
            if (sent <= 0) {
                log_warn("Failed to send WebSocket broadcast to client %d", i);
            }
        }
    }
}

int websocket_server_get_stats(struct WebSocketStats* stats) {
    if (!stats) return -1;
    
    stats->connected_clients = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (ws_server.clients[i].connected && ws_server.clients[i].handshake_complete) {
            stats->connected_clients++;
        }
    }
    
    stats->packets_sent = ws_server.packets_sent;
    stats->packets_received = ws_server.packets_received;
    stats->input_messages_received = ws_server.input_messages_received;
    stats->unknown_messages_received = ws_server.unknown_messages_received;
    stats->last_input_time = ws_server.last_input_time;
    stats->last_unknown_time = ws_server.last_unknown_time;
    stats->port = ws_server.port;
    
    return 0;
}

// Get WebSocket ships data for admin panel
int websocket_server_get_ships(SimpleShip** out_ships, int* out_count) {
    if (!out_ships || !out_count) return -1;
    *out_ships = ships;
    *out_count = ship_count;
    return 0;
}

// Get WebSocket players data for admin panel
int websocket_server_get_players(WebSocketPlayer** out_players, int* out_count) {
    if (!out_players || !out_count) return -1;
    
    // Count active players
    int active_count = 0;
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active) {
            active_count++;
        }
    }
    
    *out_players = players;
    *out_count = active_count;
    return 0;
}

int websocket_server_set_player_company(uint32_t player_id, uint8_t company_id) {
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].player_id == player_id) {
            players[i].company_id = company_id;
            log_info("🏴 Admin set player %u company → %u", player_id, company_id);

            /* One-way structure promotion: if the new company is non-neutral,
             * upgrade every neutral structure this player placed to that company.
             * Structures already claimed by a non-neutral company are never changed. */
            if (company_id != COMPANY_NEUTRAL) {
                for (uint32_t si = 0; si < placed_structure_count; si++) {
                    if (!placed_structures[si].active) continue;
                    if (placed_structures[si].placer_id != player_id) continue;
                    if (placed_structures[si].company_id != COMPANY_NEUTRAL) continue;
                    placed_structures[si].company_id = company_id;
                    char upd[128];
                    snprintf(upd, sizeof(upd),
                             "{\"type\":\"structure_company_updated\","
                             "\"structure_id\":%u,\"company_id\":%u}",
                             placed_structures[si].id, (unsigned)company_id);
                    websocket_server_broadcast(upd);
                    log_info("🏴 Structure %u promoted to company %u (player %u joined)",
                             placed_structures[si].id, company_id, player_id);
                }
            }
            return 0;
        }
    }
    return -1; // not found
}

// HYBRID: Apply movement state to all active players (called every server tick)
void websocket_server_tick(float dt) {
    uint32_t current_time = get_time_ms();
    
    // ===== SYNC SHIP STATE FROM SIMULATION =====
    // This ensures SimpleShip has current position/rotation for mounted player updates
    sync_simple_ships_from_simulation();

    // ===== BROADCAST HIT EVENTS FROM SIMULATION =====
    if (global_sim && global_sim->hit_event_count > 0) {
        char frame[512];
        for (uint8_t e = 0; e < global_sim->hit_event_count; e++) {
            const struct HitEvent* ev = &global_sim->hit_events[e];
            char msg[256];

            /* ── Phantom Brig hull-only damage rule ──
             * SHIP_TYPE_GHOST cannonballs skip interior module breaches entirely;
             * only plank hits and sink events pass through to clients.
             * This prevents phantoms from stripping modules — they attack the hull. */
            if (ev->is_breach && !ev->is_sink && ev->shooter_ship_id != 0) {
                SimpleShip* shooter = find_ship(ev->shooter_ship_id);
                if (shooter && shooter->ship_type == SHIP_TYPE_GHOST) continue;
            }

            if (ev->is_sink) {
                // Ship hull_health reached 0 — enter sinking state instead of immediate despawn.
                entity_id sunk_id = ev->ship_id;
                SimpleShip* sinking_ship = find_ship(sunk_id);
                /* When hull_health hits 0 the ship enters its dissolve state. */
                if (sinking_ship && !sinking_ship->is_sinking) {
                    sinking_ship->is_sinking    = true;
                    sinking_ship->sink_start_ms = get_time_ms();

                    /* Zero the sim-ship velocity so the ship stops dead */
                    {
                        struct Ship* _ss = find_sim_ship((uint32_t)sunk_id);
                        if (_ss) { _ss->velocity.x = 0; _ss->velocity.y = 0; _ss->angular_velocity = 0; }
                    }

                    /* Dismount all players from the sinking ship */
                    for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                        if (!players[pi].active || players[pi].parent_ship_id != sunk_id) continue;
                        players[pi].is_mounted          = false;
                        players[pi].mounted_module_id   = 0;
                        players[pi].controlling_ship_id = 0;
                        players[pi].movement_state      = PLAYER_STATE_WALKING;
                    }

                    /* Dismount all NPCs from the sinking ship and mark them as in water */
                    for (int ni = 0; ni < world_npc_count; ni++) {
                        if (!world_npcs[ni].active || world_npcs[ni].ship_id != sunk_id) continue;
                        dismount_npc(&world_npcs[ni], sinking_ship);
                        world_npcs[ni].in_water = true;
                        /* Extinguish any burning NPCs that hit the water */
                        world_npcs[ni].fire_timer_ms = 0;
                    }

                    /* Ghost ship survivors: spawn 2-3 unclaimed recruitable sailors */
                    if (sinking_ship->ship_type == SHIP_TYPE_GHOST) {
                        int n_survivors = 2 + (int)(next_world_npc_id % 2); /* 2 or 3 */
                        for (int sv = 0; sv < n_survivors; sv++) {
                            spawn_unclaimed_npc(sinking_ship->x, sinking_ship->y, sv);
                        }
                    }

                    /* Broadcast SHIP_SINKING so clients start the animation immediately */
                    char sink_msg[128];
                    snprintf(sink_msg, sizeof(sink_msg),
                        "{\"type\":\"SHIP_SINKING\",\"shipId\":%u,\"x\":%.1f,\"y\":%.1f}",
                        sunk_id,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    websocket_server_broadcast(sink_msg);
                    log_info("🌊 Ship %u entering sinking state", sunk_id);
                }
                /* Skip building the broadcast msg for this event — no module_id / damage info */
                continue;
            } else if (ev->is_breach) {
                /* Ghost ship planks participate in hull-health tracking for the
                 * damage-fade / mist-dissolve system.  Only block cascade-
                 * destruction of interior modules (deck ID 200, cannons >= 300). */
                {
                    SimpleShip* breach_victim = find_ship(ev->ship_id);
                    if (breach_victim && breach_victim->ship_type == SHIP_TYPE_GHOST
                        && ev->destroyed && ev->module_id >= 200) continue;
                }
                // module_id == 0 means direct hull damage (no specific module was hit).
                // Emit a HULL_HIT so the client can show an explosion at the position.
                if (ev->module_id == 0) {
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"HULL_HIT\",\"shipId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    log_info("📤 Broadcasting HULL_HIT: ship %u damage %.0f at (%.1f, %.1f)",
                        ev->ship_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                } else
                if (ev->destroyed) {
                    // Interior module destroyed through breach: remove from SimpleShip and sim ship, then broadcast MODULE_HIT
                    SimpleShip* simple = find_ship(ev->ship_id);
                    if (simple) {
                        for (int m = 0; m < simple->module_count; m++) {
                            if (simple->modules[m].id == ev->module_id) {
                                memmove(&simple->modules[m], &simple->modules[m + 1],
                                        (simple->module_count - m - 1) * sizeof(ShipModule));
                                simple->module_count--;
                                break;
                            }
                        }
                    }
                    // Also remove from the authoritative sim ship so GAME_STATE stops broadcasting it
                    {
                        struct Ship* sim_ship = find_sim_ship((uint32_t)ev->ship_id);
                        if (sim_ship) {
                            for (uint8_t m = 0; m < sim_ship->module_count; m++) {
                                if (sim_ship->modules[m].id == ev->module_id) {
                                    memmove(&sim_ship->modules[m], &sim_ship->modules[m + 1],
                                            (sim_ship->module_count - m - 1) * sizeof(ShipModule));
                                    sim_ship->module_count--;
                                    break;
                                }
                            }
                        }
                    }

                    // ── Deck destroyed: cascade-destroy all non-mast non-ladder modules ──
                    // Detect by module type on the sim ship rather than legacy ID 200
                    bool deck_destroyed = false;
                    {
                        struct Ship* _ds = find_sim_ship((uint32_t)ev->ship_id);
                        if (_ds) {
                            /* If the destroyed module is no longer in the ship's list that means
                             * it was just removed by the hit path in simulation.c — check by type. */
                            /* Simpler: check if the MID offset == MODULE_OFFSET_DECK (0x16) */
                            deck_destroyed = (MID_OFFSET(ev->module_id) == MODULE_OFFSET_DECK);
                        }
                    }
                    if (deck_destroyed) {
                        log_info("💥 Deck destroyed on ship %u — cascading destruction", ev->ship_id);

                        // Destroy on the sim ship
                        struct Ship* sim_ship = find_sim_ship((uint32_t)ev->ship_id);
                        if (sim_ship) {
                            uint8_t m = 0;
                            while (m < sim_ship->module_count) {
                                ModuleTypeId t = sim_ship->modules[m].type_id;
                                if (t == MODULE_TYPE_MAST || t == MODULE_TYPE_LADDER ||
                                    t == MODULE_TYPE_PLANK || t == MODULE_TYPE_DECK) { m++; continue; }
                                // Fire a MODULE_HIT event for each cascaded module
                                if (global_sim->hit_event_count < MAX_HIT_EVENTS) {
                                    struct HitEvent* ce = &global_sim->hit_events[global_sim->hit_event_count++];
                                    ce->ship_id         = ev->ship_id;
                                    ce->module_id       = sim_ship->modules[m].id;
                                    ce->is_breach       = true;
                                    ce->is_sink         = false;
                                    ce->destroyed       = true;
                                    ce->damage_dealt    = (float)sim_ship->modules[m].health;
                                    ce->hit_x           = ev->hit_x;
                                    ce->hit_y           = ev->hit_y;
                                    ce->shooter_ship_id = ev->shooter_ship_id;
                                }
                                memmove(&sim_ship->modules[m], &sim_ship->modules[m + 1],
                                        (sim_ship->module_count - m - 1) * sizeof(ShipModule));
                                sim_ship->module_count--;
                            }
                        }
                        // Also purge SimpleShip mirror
                        if (simple) {
                            uint8_t m = 0;
                            while (m < simple->module_count) {
                                ModuleTypeId t = simple->modules[m].type_id;
                                if (t == MODULE_TYPE_MAST || t == MODULE_TYPE_LADDER ||
                                    t == MODULE_TYPE_PLANK || t == MODULE_TYPE_DECK) { m++; continue; }
                                memmove(&simple->modules[m], &simple->modules[m + 1],
                                        (simple->module_count - m - 1) * sizeof(ShipModule));
                                simple->module_count--;
                            }
                        }
                        // Dismount any players whose module was just wiped
                        for (int pi = 0; pi < WS_MAX_CLIENTS; pi++) {
                            if (!players[pi].active || players[pi].parent_ship_id != ev->ship_id) continue;
                            if (!players[pi].is_mounted) continue;
                            // Check if their mounted module still exists
                            bool still_there = false;
                            if (simple) {
                                for (int m = 0; m < simple->module_count; m++) {
                                    if ((uint32_t)simple->modules[m].id == players[pi].mounted_module_id) {
                                        still_there = true; break;
                                    }
                                }
                            }
                            if (!still_there) {
                                players[pi].is_mounted          = false;
                                players[pi].mounted_module_id   = 0;
                                players[pi].controlling_ship_id = 0;
                            }
                        }
                    }

                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"MODULE_HIT\",\"shipId\":%u,\"moduleId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    /* Wake up any idle repairers dwelling on this ship */
                    for (int _ni = 0; _ni < world_npc_count; _ni++) {
                        if (world_npcs[_ni].active && world_npcs[_ni].role == NPC_ROLE_REPAIRER &&
                            world_npcs[_ni].ship_id == ev->ship_id)
                            world_npcs[_ni].roam_wait_ms = 0;
                    }
                } else {
                    // Non-fatal interior module hit: just broadcast MODULE_DAMAGED for damage numbers
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"MODULE_DAMAGED\",\"shipId\":%u,\"moduleId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    log_info("📤 Broadcasting MODULE_DAMAGED: ship %u module %u damage %.0f at (%.1f, %.1f)",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    /* Wake up any idle repairers dwelling on this ship */
                    for (int _ni = 0; _ni < world_npc_count; _ni++) {
                        if (world_npcs[_ni].active && world_npcs[_ni].role == NPC_ROLE_REPAIRER &&
                            world_npcs[_ni].ship_id == ev->ship_id)
                            world_npcs[_ni].roam_wait_ms = 0;
                    }
                }
            } else {
                if (ev->destroyed) {
                    // Plank destroyed: remove from SimpleShip and broadcast PLANK_HIT
                    SimpleShip* simple = find_ship(ev->ship_id);
                    if (simple) {
                        for (int m = 0; m < simple->module_count; m++) {
                            if (simple->modules[m].id == ev->module_id) {
                                memmove(&simple->modules[m], &simple->modules[m + 1],
                                        (simple->module_count - m - 1) * sizeof(ShipModule));
                                simple->module_count--;
                                break;
                            }
                        }
                    }
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"PLANK_HIT\",\"shipId\":%u,\"plankId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    log_info("📤 Broadcasting PLANK_HIT: ship %u plank %u destroyed, %.0f dmg at (%.1f, %.1f)",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                } else {
                    // Non-fatal plank hit: just broadcast PLANK_DAMAGED for damage numbers
                    snprintf(msg, sizeof(msg),
                        "{\"type\":\"PLANK_DAMAGED\",\"shipId\":%u,\"plankId\":%u,"
                        "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                    log_info("📤 Broadcasting PLANK_DAMAGED: ship %u plank %u, %.0f dmg at (%.1f, %.1f)",
                        ev->ship_id, ev->module_id, ev->damage_dealt,
                        SERVER_TO_CLIENT(ev->hit_x), SERVER_TO_CLIENT(ev->hit_y));
                }
            }

            /* Award combat XP to NPC gunners on the shooter ship */
            if (ev->shooter_ship_id != 0 && ev->shooter_ship_id != ev->ship_id) {
                uint32_t xp_gain = 10 + (uint32_t)(ev->damage_dealt / 10.0f);
                for (int ni = 0; ni < world_npc_count; ni++) {
                    WorldNpc* gnpc = &world_npcs[ni];
                    if (gnpc->active && gnpc->role == NPC_ROLE_GUNNER &&
                        gnpc->ship_id == ev->shooter_ship_id) {
                        npc_apply_xp(gnpc, xp_gain);
                    }
                }
            }

            size_t frame_len = websocket_create_frame(WS_OPCODE_TEXT, msg, strlen(msg), frame, sizeof(frame));
            if (frame_len > 0) {
                for (int i = 0; i < WS_MAX_CLIENTS; i++) {
                    struct WebSocketClient* client = &ws_server.clients[i];
                    if (client->connected && client->handshake_complete)
                        send(client->fd, frame, frame_len, 0);
                }
            }
        }
        global_sim->hit_event_count = 0;
    }

    // ===== CANNONBALL / GRAPESHOT / LIQUID FLAME / CANISTER SHOT vs ENTITY HIT DETECTION =====
    // Cannonballs (PROJ_TYPE_CANNONBALL) deal base 75 HP damage to NPCs and
    // players.  Grapeshot (PROJ_TYPE_GRAPESHOT) uses a tighter hit radius (20 px)
    // and lower damage (35 HP per pellet). Unmounted entities are knocked back.
    // Liquid flame (PROJ_TYPE_LIQUID_FLAME) deals 0 direct HP damage but sets
    // fire_timer_ms on hit entities (NPCs/players) and nearby wooden modules
    // (planks, decks, masts). Fire burns for 10 seconds dealing DoT.
    if (global_sim) {
        const float ENTITY_HIT_RADIUS    = 40.0f;   // client pixels (cannonball)
        const float ENTITY_BASE_DAMAGE   = 75.0f;
        const float ENTITY_KNOCKBACK     = 40.0f;   // velocity impulse (client px/s)
        /* FIRE_DURATION_MS is a file-scope #define (10000 ms) */

        /* Helper: broadcast a FIRE_EFFECT event */
        #define BROADCAST_FIRE_EFFECT(msg_buf, ...) do { \
            snprintf((msg_buf), sizeof(msg_buf), __VA_ARGS__); \
            char _ff[320]; \
            size_t _ffl = websocket_create_frame(WS_OPCODE_TEXT, (msg_buf), strlen(msg_buf), _ff, sizeof(_ff)); \
            if (_ffl > 0) { \
                for (int _ci = 0; _ci < WS_MAX_CLIENTS; _ci++) { \
                    struct WebSocketClient* _wc = &ws_server.clients[_ci]; \
                    if (_wc->connected && _wc->handshake_complete) send(_wc->fd, _ff, _ffl, 0); \
                } \
            } \
        } while (0)

        uint16_t pi = 0;
        while (pi < global_sim->projectile_count) {
            struct Projectile* proj = &global_sim->projectiles[pi];

            // Only projectile types that harm entities directly
            // (PROJ_TYPE_LIQUID_FLAME removed — flamethrower is now instant hit-scan, no projectiles)
            if (proj->type != PROJ_TYPE_CANNONBALL && proj->type != PROJ_TYPE_GRAPESHOT &&
                proj->type != PROJ_TYPE_CANISTER_SHOT) { pi++; continue; }

            float px = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.x));
            float py = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.y));

            // Damage multiplier from firing ship level stats
            float dmg_mult = 1.0f;
            if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                struct Ship* fship = sim_get_ship(global_sim, (entity_id)proj->firing_ship_id);
                if (fship) dmg_mult = ship_level_damage_mult(&fship->level_stats);
            }
            /* Per-type hit radius and base entity damage */
            float ent_hit_radius, damage;
            bool is_flame = (proj->type == PROJ_TYPE_LIQUID_FLAME);
            if (is_flame) {
                ent_hit_radius = 30.0f;
                damage         = 0.0f; /* fire DoT handled in 100ms tick */
            } else if (proj->type == PROJ_TYPE_GRAPESHOT || proj->type == PROJ_TYPE_CANISTER_SHOT) {
                ent_hit_radius = (proj->type == PROJ_TYPE_CANISTER_SHOT) ? 15.0f : 20.0f;
                damage         = (proj->type == PROJ_TYPE_CANISTER_SHOT) ? 25.0f * dmg_mult : 35.0f * dmg_mult;
            } else {
                ent_hit_radius = ENTITY_HIT_RADIUS;
                damage         = ENTITY_BASE_DAMAGE * dmg_mult;
            }
            float hit_r2  = ent_hit_radius * ent_hit_radius;

            bool proj_consumed = false;

            // ── Check NPCs ──────────────────────────────────────────────────
            // Flame iterates ALL NPCs (pass-through — never consumed).
            // Other types stop at the first hit (proj_consumed).
            for (int ni = 0; ni < world_npc_count && (is_flame || !proj_consumed); ni++) {
                WorldNpc* npc = &world_npcs[ni];
                if (!npc->active) continue;
                // No friendly fire: skip NPCs on the firing ship
                if (proj->firing_ship_id != INVALID_ENTITY_ID &&
                    npc->ship_id == (uint32_t)proj->firing_ship_id) continue;

                float dx = npc->x - px;
                float dy = npc->y - py;
                if (dx * dx + dy * dy > hit_r2) continue;

                if (is_flame) {
                    /* Pass-through: ignite NPC; broadcast only on first ignition */
                    if (npc->fire_timer_ms == 0) {
                        npc->fire_timer_ms = FIRE_DURATION_MS;
                        char hit_msg[256];
                        BROADCAST_FIRE_EFFECT(hit_msg,
                            "{\"type\":\"FIRE_EFFECT\",\"entityType\":\"npc\",\"id\":%u,"
                            "\"x\":%.1f,\"y\":%.1f,\"durationMs\":%u}",
                            npc->id, npc->x, npc->y, FIRE_DURATION_MS);
                    } else {
                        npc->fire_timer_ms = FIRE_DURATION_MS; /* refresh silently */
                    }
                    /* proj_consumed stays false — flame keeps flying */
                } else {
                    uint16_t dmg16 = (damage >= 65535.0f) ? 65535u : (uint16_t)damage;
                    if (npc->health <= dmg16) {
                        npc->health = 0;
                        npc->active = false;
                    } else {
                        npc->health -= dmg16;
                    }
                    bool npc_at_station = (npc->state == WORLD_NPC_STATE_AT_GUN ||
                                           npc->state == WORLD_NPC_STATE_REPAIRING);
                    if (!npc_at_station) {
                        float dist = sqrtf(dx * dx + dy * dy);
                        float kx   = (dist > 0.1f) ? (dx / dist) : 1.0f;
                        float ky   = (dist > 0.1f) ? (dy / dist) : 0.0f;
                        npc->velocity_x += kx * ENTITY_KNOCKBACK;
                        npc->velocity_y += ky * ENTITY_KNOCKBACK;
                    }
                    char hit_msg[256];
                    snprintf(hit_msg, sizeof(hit_msg),
                        "{\"type\":\"ENTITY_HIT\",\"entityType\":\"npc\",\"id\":%u,"
                        "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                        "\"health\":%u,\"maxHealth\":%u,\"killed\":%s}",
                        npc->id, npc->x, npc->y, damage,
                        (unsigned)npc->health, (unsigned)npc->max_health,
                        (!npc->active) ? "true" : "false");
                    char hit_frame[320];
                    size_t hfl = websocket_create_frame(WS_OPCODE_TEXT, hit_msg, strlen(hit_msg),
                                                        hit_frame, sizeof(hit_frame));
                    if (hfl > 0) {
                        for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                            struct WebSocketClient* wc = &ws_server.clients[ci];
                            if (wc->connected && wc->handshake_complete)
                                send(wc->fd, hit_frame, hfl, 0);
                        }
                    }
                    log_info("💣 DESPAWN proj %u — NPC %u hit at (%.1f,%.1f) dmg=%.0f",
                             proj->id, npc->id, npc->x, npc->y, damage);
                    proj_consumed = true;
                }
            }

            // ── Check Players ────────────────────────────────────────────────
            for (int wpi = 0; wpi < WS_MAX_CLIENTS && (is_flame || !proj_consumed); wpi++) {
                WebSocketPlayer* wp = &players[wpi];
                if (!wp->active) continue;
                if (proj->firing_ship_id != INVALID_ENTITY_ID &&
                    wp->parent_ship_id == (uint32_t)proj->firing_ship_id) continue;

                float dx = wp->x - px;
                float dy = wp->y - py;
                if (dx * dx + dy * dy > hit_r2) continue;

                if (is_flame) {
                    if (wp->fire_timer_ms == 0) {
                        wp->fire_timer_ms = FIRE_DURATION_MS;
                        char hit_msg[256];
                        BROADCAST_FIRE_EFFECT(hit_msg,
                            "{\"type\":\"FIRE_EFFECT\",\"entityType\":\"player\",\"id\":%u,"
                            "\"x\":%.1f,\"y\":%.1f,\"durationMs\":%u}",
                            wp->player_id, wp->x, wp->y, FIRE_DURATION_MS);
                    } else {
                        wp->fire_timer_ms = FIRE_DURATION_MS;
                    }
                } else {
                    uint16_t dmg16 = (damage >= 65535.0f) ? 65535u : (uint16_t)damage;
                    if (wp->health <= dmg16) { wp->health = 0; player_die(wp); } else { wp->health -= dmg16; }
                    if (!wp->is_mounted) {
                        float dist = sqrtf(dx * dx + dy * dy);
                        float kx   = (dist > 0.1f) ? (dx / dist) : 1.0f;
                        float ky   = (dist > 0.1f) ? (dy / dist) : 0.0f;
                        if (wp->parent_ship_id != 0) {
                            wp->local_x += kx * ENTITY_KNOCKBACK;
                            wp->local_y += ky * ENTITY_KNOCKBACK;
                            SimpleShip* wp_ship = find_ship(wp->parent_ship_id);
                            if (wp_ship) ship_local_to_world(wp_ship, wp->local_x, wp->local_y,
                                                              &wp->x, &wp->y);
                        } else {
                            wp->x += kx * ENTITY_KNOCKBACK;
                            wp->y += ky * ENTITY_KNOCKBACK;
                            wp->velocity_x += kx * ENTITY_KNOCKBACK * 3.0f;
                            wp->velocity_y += ky * ENTITY_KNOCKBACK * 3.0f;
                            if (wp->sim_entity_id != 0) {
                                for (uint16_t spi = 0; spi < global_sim->player_count; spi++) {
                                    if (global_sim->players[spi].id == wp->sim_entity_id) {
                                        global_sim->players[spi].position.x =
                                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->x));
                                        global_sim->players[spi].position.y =
                                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->y));
                                        global_sim->players[spi].velocity.x =
                                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->velocity_x));
                                        global_sim->players[spi].velocity.y =
                                            Q16_FROM_FLOAT(CLIENT_TO_SERVER(wp->velocity_y));
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    char hit_msg[256];
                    snprintf(hit_msg, sizeof(hit_msg),
                        "{\"type\":\"ENTITY_HIT\",\"entityType\":\"player\",\"id\":%u,"
                        "\"x\":%.1f,\"y\":%.1f,\"damage\":%.0f,"
                        "\"health\":%u,\"maxHealth\":%u}",
                        wp->player_id, wp->x, wp->y, damage,
                        (unsigned)wp->health, (unsigned)wp->max_health);
                    char hit_frame[320];
                    size_t hfl = websocket_create_frame(WS_OPCODE_TEXT, hit_msg, strlen(hit_msg),
                                                        hit_frame, sizeof(hit_frame));
                    if (hfl > 0) {
                        for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                            struct WebSocketClient* wc = &ws_server.clients[ci];
                            if (wc->connected && wc->handshake_complete)
                                send(wc->fd, hit_frame, hfl, 0);
                        }
                    }
                    log_info("💣 DESPAWN proj %u — player %u hit at (%.1f,%.1f) dmg=%.0f",
                             proj->id, wp->player_id, wp->x, wp->y, damage);
                    proj_consumed = true;
                }
            }

            // ── Module fire pass: flame hits ALL modules in range; others stop at first ──
            {
                const float MOD_FIRE_RADIUS = 35.0f;
                const float mfr2 = MOD_FIRE_RADIUS * MOD_FIRE_RADIUS;
                for (int s = 0; s < ship_count && (is_flame || !proj_consumed); s++) {
                    if (!ships[s].active) continue;
                    SimpleShip* fship = &ships[s];
                    if (proj->firing_ship_id != INVALID_ENTITY_ID &&
                        fship->ship_id == (uint32_t)proj->firing_ship_id) continue;
                    float cos_r = cosf(fship->rotation);
                    float sin_r = sinf(fship->rotation);
                    for (int m = 0; m < fship->module_count && (is_flame || !proj_consumed); m++) {
                        ShipModule* mod = &fship->modules[m];
                        ModuleTypeId mt = mod->type_id;
                        if (mt != MODULE_TYPE_PLANK && mt != MODULE_TYPE_DECK &&
                            mt != MODULE_TYPE_MAST) continue;
                        if (mod->state_bits & MODULE_STATE_DESTROYED) continue;
                        float lx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
                        float ly = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
                        float wx = fship->x + (lx * cos_r - ly * sin_r);
                        float wy = fship->y + (lx * sin_r + ly * cos_r);
                        float ddx = wx - px, ddy = wy - py;
                        if (ddx * ddx + ddy * ddy > mfr2) continue;

                        /* Mirror fire_timer to global_sim (O(1) via find_sim_ship cache) */
                        #define SET_MODULE_FIRE(_fship, _mod) do { \
                            (_mod)->fire_timer_ms = FIRE_DURATION_MS; \
                            { \
                                struct Ship* _smf = find_sim_ship((_fship)->ship_id); \
                                if (_smf) { \
                                    for (uint8_t _mi = 0; _mi < _smf->module_count; _mi++) { \
                                        if (_smf->modules[_mi].id == (_mod)->id) { \
                                            _smf->modules[_mi].fire_timer_ms = FIRE_DURATION_MS; \
                                            break; \
                                        } \
                                    } \
                                } \
                            } \
                        } while (0)

                        if (is_flame) {
                            /* Pass-through: ignite all wooden modules in cone range.
                             * Only broadcast FIRE_EFFECT on first ignition. */
                            if (mod->fire_timer_ms == 0) {
                                SET_MODULE_FIRE(fship, mod);
                                char fmsg[256];
                                BROADCAST_FIRE_EFFECT(fmsg,
                                    "{\"type\":\"FIRE_EFFECT\",\"entityType\":\"module\","
                                    "\"shipId\":%u,\"moduleId\":%u,"
                                    "\"x\":%.1f,\"y\":%.1f,\"durationMs\":%u}",
                                    fship->ship_id, mod->id, wx, wy, FIRE_DURATION_MS);
                            } else {
                                SET_MODULE_FIRE(fship, mod); /* refresh silently */
                            }
                            /* no proj_consumed, no break — keep scanning */
                        } else {
                            /* Cannonball/grapeshot/canister: physical impact only — no ignition.
                             * Module HP damage and projectile removal are handled by the sim
                             * layer collision (handle_projectile_collisions). Do NOT consume
                             * the projectile here or the sim will never see it and despawn
                             * logs/damage will silently be skipped. */
                            (void)0;
                        }
                        #undef SET_MODULE_FIRE
                    }
                }
            }

            /* Flame projectiles expire via lifetime — never removed on hit.
             * Non-flame projectiles are removed when consumed by their first hit. */
            if (!is_flame && proj_consumed) {
                memmove(&global_sim->projectiles[pi],
                        &global_sim->projectiles[pi + 1],
                        (global_sim->projectile_count - pi - 1) * sizeof(struct Projectile));
                global_sim->projectile_count--;
            } else {
                pi++;
            }
        }
        #undef BROADCAST_FIRE_EFFECT
    }

    // ===== TICK NPC AGENTS =====
    tick_npc_agents(dt);
    tick_world_npcs(dt);

    // ===== ASSIGN CREW TO WEAPON-GROUP CANNONS + SWIVELS =====
    // Mark swivels needed, expire stale NEEDED flags, then dispatch idle gunners.
    tick_cannon_needed_expiry();
    for (int s = 0; s < ship_count; s++) {
        if (ships[s].active) {
            tick_swivel_crew_demand(&ships[s]);
            assign_weapon_group_crew(&ships[s]);
        }
    }

    // ===== TICK SHIP WEAPON GROUPS (TARGETFIRE auto-aim) =====
    tick_ship_weapon_groups();

    // ===== TICK SINKING SHIPS (velocity=0, despawn after 8s) =====
    tick_sinking_ships();

    // ===== TICK GHOST SHIPS (wander + attack AI) =====
    tick_ghost_ships(dt);

    // ===== ADVANCE CANNON AIM TOWARD DESIRED (turn-speed limit) =====
    // Normal cannons: 60 deg/s.  Ghost ship cannons: 180 deg/s so their swept
    // barrels track the oscillation without visible lag.
    {
        const float CANNON_TURN_SPEED        = 60.0f  * (float)(M_PI / 180.0f); // rad/s
        const float GHOST_CANNON_TURN_SPEED  = 180.0f * (float)(M_PI / 180.0f); // rad/s
        for (int s = 0; s < ship_count; s++) {
            if (!ships[s].active) continue;
            const float max_step = (ships[s].ship_type == SHIP_TYPE_GHOST
                                    ? GHOST_CANNON_TURN_SPEED
                                    : CANNON_TURN_SPEED) * dt;
            for (int m = 0; m < ships[s].module_count; m++) {
                ShipModule* mod = &ships[s].modules[m];
                if (mod->type_id != MODULE_TYPE_CANNON) continue;
                float cur  = Q16_TO_FLOAT(mod->data.cannon.aim_direction);
                float tgt  = Q16_TO_FLOAT(mod->data.cannon.desired_aim_direction);
                float diff = tgt - cur;
                // Normalise diff to -PI..PI
                while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
                if (fabsf(diff) <= max_step) {
                    cur = tgt;
                } else {
                    cur += (diff > 0.0f ? max_step : -max_step);
                }
                mod->data.cannon.aim_direction = Q16_FROM_FLOAT(cur);
                // Mirror aim_direction into sim-ship — O(1) via cache.
                // Try ID match first; fall back to position match (ghost ships
                // use different ID schemes between SimpleShip and sim ship).
                {
                    struct Ship* _ss = find_sim_ship(ships[s].ship_id);
                    if (_ss) {
                        bool mirrored = false;
                        for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                            if (_ss->modules[mi].id == mod->id) {
                                _ss->modules[mi].data.cannon.aim_direction = mod->data.cannon.aim_direction;
                                mirrored = true;
                                break;
                            }
                        }
                        if (!mirrored) {
                            float mx = Q16_TO_FLOAT(mod->local_pos.x);
                            float my = Q16_TO_FLOAT(mod->local_pos.y);
                            for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                                if (_ss->modules[mi].type_id != MODULE_TYPE_CANNON) continue;
                                float sx = Q16_TO_FLOAT(_ss->modules[mi].local_pos.x);
                                float sy = Q16_TO_FLOAT(_ss->modules[mi].local_pos.y);
                                float d2 = (sx - mx)*(sx - mx) + (sy - my)*(sy - my);
                                if (d2 < 0.01f) {
                                    _ss->modules[mi].data.cannon.aim_direction = mod->data.cannon.aim_direction;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ===== ADVANCE SWIVEL AIM TOWARD DESIRED (180°/s — faster than cannon) =====
    {
        const float SWIVEL_TURN_SPEED = 180.0f * (float)(M_PI / 180.0f); // rad/s
        const float max_step = SWIVEL_TURN_SPEED * dt;
        const float SWIVEL_AIM_LIMIT = 45.0f * ((float)M_PI / 180.0f);
        for (int s = 0; s < ship_count; s++) {
            if (!ships[s].active) continue;
            for (int m = 0; m < ships[s].module_count; m++) {
                ShipModule* mod = &ships[s].modules[m];
                if (mod->type_id != MODULE_TYPE_SWIVEL) continue;
                float cur  = Q16_TO_FLOAT(mod->data.swivel.aim_direction);
                float tgt  = Q16_TO_FLOAT(mod->data.swivel.desired_aim_direction);
                /* Re-clamp target in case it drifted somehow */
                if (tgt >  SWIVEL_AIM_LIMIT) tgt =  SWIVEL_AIM_LIMIT;
                if (tgt < -SWIVEL_AIM_LIMIT) tgt = -SWIVEL_AIM_LIMIT;
                float diff = tgt - cur;
                while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
                while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
                cur = (fabsf(diff) <= max_step) ? tgt : cur + (diff > 0.0f ? max_step : -max_step);
                mod->data.swivel.aim_direction = Q16_FROM_FLOAT(cur);
                /* Mirror into global_sim so sim-path snapshots reflect the interpolated angle */
                {
                    struct Ship* _ss = find_sim_ship(ships[s].ship_id);
                    if (_ss) {
                        for (uint8_t mi = 0; mi < _ss->module_count; mi++) {
                            if (_ss->modules[mi].id == mod->id) {
                                _ss->modules[mi].data.swivel.aim_direction = mod->data.swivel.aim_direction;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    int moving_players = 0;
    
    // Count moving players (for adaptive tick rate)
    for (int i = 0; i < WS_MAX_CLIENTS; i++) {
        if (players[i].active && players[i].is_moving) {
            moving_players++;
        }
    }
    
    // ===== SYNC WEBSOCKET PLAYERS TO SIMULATION FOR COLLISION DETECTION =====
    if (global_sim) {
        // Physics constants (scaled to server units via WORLD_SCALE_FACTOR)
        const float SWIM_ACCELERATION = CLIENT_TO_SERVER(160.0f); // Acceleration when swimming (server units/s²)
        const float SWIM_MAX_SPEED = CLIENT_TO_SERVER(30.0f);     // Maximum swimming speed (server units/s)
        const float SWIM_DECELERATION = CLIENT_TO_SERVER(120.0f); // Deceleration when stopping (server units/s²)
        
        const float WALK_MAX_SPEED = CLIENT_TO_SERVER(40.0f);     // Maximum walking speed on deck (server units/s)
        
        for (uint16_t i = 0; i < global_sim->player_count; i++) {
            struct Player* sim_player = &global_sim->players[i];
            
            // Find corresponding WebSocket player by simulation entity ID
            WebSocketPlayer* ws_player = find_player_by_sim_id(sim_player->id);
            if (ws_player && ws_player->active) {
                // Sync ship boarding state to simulation for collision filtering
                if (ws_player->parent_ship_id != 0) {
                    // Player is on a ship - disable ship collision
                    sim_player->ship_id = ws_player->parent_ship_id;
                } else {
                    // Player is swimming - enable ship collision
                    sim_player->ship_id = INVALID_ENTITY_ID;
                }
                
                // Check if player is on a ship
                bool on_ship = (ws_player->parent_ship_id != 0);
                SimpleShip* player_ship = NULL;
                if (on_ship) {
                    // Find the ship
                    for (int s = 0; s < ship_count; s++) {
                        if (ships[s].active && ships[s].ship_id == ws_player->parent_ship_id) {
                            player_ship = &ships[s];
                            break;
                        }
                    }
                }
                
                // Auto-expire stale movement input: if no input received in 500ms, stop the player.
                // This prevents "stuck key" when a keyup event is dropped (focus loss, network blip, etc.).
                // The client sends a heartbeat every ~150ms while moving, so 500ms gives 3× margin.
                {
                    uint32_t now = get_time_ms();
                    if (ws_player->is_moving && (now - ws_player->last_input_time) > 500) {
                        ws_player->is_moving = false;
                        ws_player->movement_direction_x = 0.0f;
                        ws_player->movement_direction_y = 0.0f;
                    }
                }

                // Players who are mounted cannot move - they're locked to the module position
                if (ws_player->is_mounted) {
                    // Mounted players stay at their mount position
                    // Their world position still updates as the ship moves/rotates
                    if (on_ship && player_ship) {
                        ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y,
                                          &ws_player->x, &ws_player->y);
                    }
                    // Skip movement processing
                } else if (ws_player->is_moving) {
                    // Player is actively moving
                    float movement_x = ws_player->movement_direction_x;
                    float movement_y = ws_player->movement_direction_y;
                    float magnitude = sqrtf(movement_x * movement_x + movement_y * movement_y);
                    
                    if (magnitude > 0.01f) {
                        // Normalize movement direction
                        movement_x /= magnitude;
                        movement_y /= magnitude;
                        
                        // ===== SHIPYARD ZONE DETECTION =====
                        // When on a scaffolded dock OR on a scaffolded ship, use unified
                        // ship-local movement so dock↔ship transitions are seamless flag updates.
                        // Both player->local_x/y AND player->x/y are kept in sync at all times.
                        PlacedStructure *_zdock = NULL;
                        SimpleShip      *_zship = NULL;
                        if (ws_player->on_dock_id != 0) {
                            for (int _zdi = 0; _zdi < (int)placed_structure_count; _zdi++) {
                                PlacedStructure *_zd = &placed_structures[_zdi];
                                if (_zd->active && _zd->id == ws_player->on_dock_id &&
                                    _zd->type == STRUCT_SHIPYARD && _zd->scaffolded_ship_id != 0) {
                                    _zdock = _zd;
                                    _zship = find_ship(_zd->scaffolded_ship_id);
                                    break;
                                }
                            }
                        } else if (on_ship && player_ship) {
                            for (int _zdi = 0; _zdi < (int)placed_structure_count; _zdi++) {
                                PlacedStructure *_zd = &placed_structures[_zdi];
                                if (_zd->active && _zd->type == STRUCT_SHIPYARD &&
                                    _zd->scaffolded_ship_id == (uint32_t)ws_player->parent_ship_id) {
                                    _zdock = _zd;
                                    _zship = player_ship;
                                    break;
                                }
                            }
                        }
                        if (_zdock && _zship) {
                            // ===== SHIPYARD ZONE MOVEMENT (ship-local coords) =====
                            // When on the dock side, sync local_x/y from current world pos.
                            if (ws_player->parent_ship_id == 0) {
                                ship_world_to_local(_zship, ws_player->x, ws_player->y,
                                                    &ws_player->local_x, &ws_player->local_y);
                            }
                            float _zwalk = SERVER_TO_CLIENT(WALK_MAX_SPEED);
                            if (ws_player->is_sprinting) _zwalk *= 1.6f;
                            /* Convert world-space input direction to ship-local space */
                            float _zcr =  cosf(_zship->rotation), _zsr = sinf(_zship->rotation);
                            float _zldx =  movement_x * _zcr + movement_y * _zsr;
                            float _zldy = -movement_x * _zsr + movement_y * _zcr;
                            float _znlx = ws_player->local_x + _zldx * _zwalk * dt;
                            float _znly = ws_player->local_y + _zldy * _zwalk * dt;
                            /* Module / NPC collision (only matters on-deck, harmless off it) */
                            resolve_player_module_collisions(_zship,
                                ws_player->is_mounted ? ws_player->mounted_module_id : 0,
                                &_znlx, &_znly);
                            resolve_player_npc_collisions(_zship, &_znlx, &_znly);
                            /* Derive world position */
                            float _znwx, _znwy;
                            ship_local_to_world(_zship, _znlx, _znly, &_znwx, &_znwy);
                            /* Check both surfaces */
                            bool _z_in_deck = !is_outside_deck(_zship->ship_id, _znlx, _znly);
                            float _zd_lx, _zd_ly;
                            dock_world_to_local(_zdock, _znwx, _znwy, &_zd_lx, &_zd_ly);
                            bool _z_on_dock = dock_point_on_surface(_zd_lx, _zd_ly, true);
                            if (_z_in_deck || _z_on_dock) {
                                /* Commit position — both coord systems stay in sync */
                                ws_player->local_x = _znlx;
                                ws_player->local_y = _znly;
                                ws_player->x       = _znwx;
                                ws_player->y       = _znwy;
                                sim_player->position.x     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_znwx));
                                sim_player->position.y     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_znwy));
                                sim_player->relative_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_znlx));
                                sim_player->relative_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_znly));
                                sim_player->velocity.x     = 0;
                                sim_player->velocity.y     = 0;
                                if (_z_in_deck) {
                                    /* On ship deck — flag as on-ship */
                                    if (ws_player->parent_ship_id == 0) {
                                        ws_player->parent_ship_id = _zship->ship_id;
                                        ws_player->on_dock_id     = 0;
                                        ws_player->velocity_x     = 0.0f;
                                        ws_player->velocity_y     = 0.0f;
                                        sim_player->ship_id       = _zship->ship_id;
                                        log_info("⚓ P%u boarded scaffolded ship %u from scaffold",
                                                 ws_player->player_id, _zship->ship_id);
                                    }
                                } else {
                                    /* On scaffold (outside hull) — flag as on-dock */
                                    if (ws_player->parent_ship_id != 0) {
                                        if (ws_player->is_mounted) {
                                            ws_player->is_mounted          = false;
                                            ws_player->mounted_module_id   = 0;
                                            ws_player->controlling_ship_id = 0;
                                        }
                                        ws_player->parent_ship_id = 0;
                                        ws_player->on_dock_id     = _zdock->id;
                                        ws_player->velocity_x     = 0.0f;
                                        ws_player->velocity_y     = 0.0f;
                                        sim_player->ship_id       = INVALID_ENTITY_ID;
                                        log_info("🛖 P%u stepped from scaffolded ship %u onto scaffold",
                                                 ws_player->player_id, _zship->ship_id);
                                    }
                                }
                            } else {
                                /* Left combined surface — fall to water */
                                ws_player->x = _znwx;
                                ws_player->y = _znwy;
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_znwx));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_znwy));
                                if (ws_player->is_mounted) {
                                    ws_player->is_mounted          = false;
                                    ws_player->mounted_module_id   = 0;
                                    ws_player->controlling_ship_id = 0;
                                }
                                ws_player->parent_ship_id  = 0;
                                ws_player->on_dock_id      = 0;
                                ws_player->movement_state  = PLAYER_STATE_SWIMMING;
                                sim_player->ship_id        = INVALID_ENTITY_ID;
                                sim_player->relative_pos.x = 0;
                                sim_player->relative_pos.y = 0;
                                sim_player->velocity.x     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(movement_x * _zwalk));
                                sim_player->velocity.y     = Q16_FROM_FLOAT(CLIENT_TO_SERVER(movement_y * _zwalk));
                                log_info("🌊 P%u left shipyard zone into water", ws_player->player_id);
                            }
                        } else if (on_ship && player_ship) {
                            // ===== ON-SHIP MOVEMENT (LOCAL COORDINATES) =====
                            // Movement is in world space, need to convert to ship-local space
                            float ship_cos = cosf(player_ship->rotation);
                            float ship_sin = sinf(player_ship->rotation);
                            
                            // Rotate movement vector to ship-local coordinates
                            float local_move_x = movement_x * ship_cos + movement_y * ship_sin;
                            float local_move_y = -movement_x * ship_sin + movement_y * ship_cos;
                            
                            // Apply movement in local coordinates (direct velocity, not acceleration)
                            // Note: local_x/y are stored in CLIENT coordinates, so convert speed back to client
                            float walk_speed_client = SERVER_TO_CLIENT(WALK_MAX_SPEED);
                            if (ws_player->is_sprinting) walk_speed_client *= 1.6f;
                            float new_local_x = ws_player->local_x + local_move_x * walk_speed_client * dt;
                            float new_local_y = ws_player->local_y + local_move_y * walk_speed_client * dt;
                            
                            // log_info("🚶 P%u: Move calc | speed=%.2f client/s | dt=%.4f | delta=(%.4f, %.4f) | old_local=(%.2f, %.2f) | new_local=(%.2f, %.2f)",
                            //          ws_player->player_id, walk_speed_client, dt,
                            //          local_move_x * walk_speed_client * dt, local_move_y * walk_speed_client * dt,
                            //          ws_player->local_x, ws_player->local_y,
                            //          new_local_x, new_local_y);
                            
                            // Resolve collisions with ship modules (helm, mast, cannon)
                            resolve_player_module_collisions(player_ship,
                                ws_player->is_mounted ? ws_player->mounted_module_id : 0,
                                &new_local_x, &new_local_y);
                            resolve_player_npc_collisions(player_ship, &new_local_x, &new_local_y);

                            // Check if player would walk off the deck (hull boundary)
                            if (is_outside_deck(player_ship->ship_id, new_local_x, new_local_y)) {
                                // Player walked off the edge - dismount into water
                                log_info("🌊 Player %u walked off the deck of ship %u (tick movement)", 
                                         ws_player->player_id, player_ship->ship_id);
                                
                                // Place player at the exit point (new_local_x/y is just outside the hull)
                                ship_local_to_world(player_ship, new_local_x, new_local_y, 
                                                  &ws_player->x, &ws_player->y);
                                
                                // Sync simulation position to the exit point
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->y));
                                
                                // Dismount player — try dock first
                                {
                                    bool _onto_dock = false;
                                    for (int _dki = 0; _dki < (int)placed_structure_count && !_onto_dock; _dki++) {
                                        PlacedStructure *_dks = &placed_structures[_dki];
                                        if (!_dks->active || _dks->type != STRUCT_SHIPYARD) continue;
                                        if (_dks->scaffolded_ship_id != (uint32_t)player_ship->ship_id) continue;
                                        bool _dkhs = (_dks->construction_phase == CONSTRUCTION_BUILDING);
                                        float _dklx, _dkly;
                                        dock_world_to_local(_dks, ws_player->x, ws_player->y, &_dklx, &_dkly);
                                        if (dock_point_on_surface(_dklx, _dkly, _dkhs)) {
                                            _onto_dock = true;
                                            dismount_player_from_ship(ws_player, "onto_dock");
                                            /* Zero residual ship velocity — dock surface is stationary */
                                            ws_player->velocity_x = 0.0f;
                                            ws_player->velocity_y = 0.0f;
                                            ws_player->on_dock_id = _dks->id;
                                            ws_player->movement_state = PLAYER_STATE_WALKING;
                                            sim_player->ship_id = INVALID_ENTITY_ID;
                                            sim_player->relative_pos.x = 0;
                                            sim_player->relative_pos.y = 0;
                                            sim_player->velocity.x = 0;
                                            sim_player->velocity.y = 0;
                                        }
                                    }
                                    if (!_onto_dock) {
                                        dismount_player_from_ship(ws_player, "walked_off_deck");
                                        // Continue movement in water (set velocity to swim at max speed in movement direction)
                                        ws_player->velocity_x = movement_x * SWIM_MAX_SPEED;
                                        ws_player->velocity_y = movement_y * SWIM_MAX_SPEED;
                                        // Clear simulation ship_id (now swimming)
                                        sim_player->ship_id = INVALID_ENTITY_ID;
                                    }
                                }
                            } else {
                                // Normal movement on deck
                                ws_player->local_x = new_local_x;
                                ws_player->local_y = new_local_y;
                                
                                // Update world position from local position
                                ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y,
                                                  &ws_player->x, &ws_player->y);
                                
                                // Sync to simulation relative_pos
                                sim_player->relative_pos.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->local_x));
                                sim_player->relative_pos.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->local_y));
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(ws_player->y));
                                
                                // log_info("🚶 P%u: Walking on ship %u | local=(%.2f, %.2f) | world=(%.2f, %.2f)",
                                //          sim_player->id, ws_player->parent_ship_id,
                                //          ws_player->local_x, ws_player->local_y,
                                //          ws_player->x, ws_player->y);
                            }
                        } else if (ws_player->on_island_id != 0) {
                            // ===== ISLAND WALKING (WORLD COORDINATES) =====
                            float walk_speed_client = SERVER_TO_CLIENT(WALK_MAX_SPEED);
                            if (ws_player->is_sprinting) walk_speed_client *= 1.6f;
                            float new_x = ws_player->x + movement_x * walk_speed_client * dt;
                            float new_y = ws_player->y + movement_y * walk_speed_client * dt;
                            /* Walk freely on beach + grass. Step off the beach → swim. */
                            const IslandDef *isl_mv = NULL;
                            for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                                if (ISLAND_PRESETS[ii].id == (int)ws_player->on_island_id) {
                                    isl_mv = &ISLAND_PRESETS[ii]; break;
                                }
                            }
                            if (isl_mv) {
                                float dx = new_x - isl_mv->x;
                                float dy = new_y - isl_mv->y;
                                float dist_sq = dx * dx + dy * dy;
                                bool still_inside;
                                if (isl_mv->vertex_count > 0) {
                                    still_inside = island_poly_contains(isl_mv, new_x, new_y);
                                } else {
                                    float angle   = atan2f(dy, dx);
                                    float beach_r = island_boundary_r(isl_mv->beach_radius_px,
                                                                      isl_mv->beach_bumps, angle);
                                    still_inside = (dist_sq <= beach_r * beach_r);
                                }
                                (void)dist_sq;
                                if (!still_inside) {
                                    /* Player walked off the island — transition to swimming */
                                    ws_player->on_island_id = 0;
                                    ws_player->movement_state = PLAYER_STATE_SWIMMING;
                                    log_info("\U0001F30A Player %u walked off island",
                                             ws_player->player_id);
                                    /* Carry the walking velocity into swim so motion feels continuous */
                                    sim_player->velocity.x = Q16_FROM_FLOAT(
                                        CLIENT_TO_SERVER(movement_x * walk_speed_client));
                                    sim_player->velocity.y = Q16_FROM_FLOAT(
                                        CLIENT_TO_SERVER(movement_y * walk_speed_client));
                                }
                            }
                            /* Apply position regardless — if walking off, land at the new spot so
                               next tick the player is already outside and swim takes over */
                            if (ws_player->on_island_id != 0) {
                                /* Resolve collisions with walls and closed doors on this island */
                                {
                                    const float PLAYER_R = 8.0f;
                                    for (uint32_t wi = 0; wi < placed_structure_count; wi++) {
                                        PlacedStructure *ws = &placed_structures[wi];
                                        if (!ws->active) continue;
                                        if (ws->island_id != ws_player->on_island_id) continue;
                                        bool is_wall = (ws->type == STRUCT_WALL);
                                        bool is_door = (ws->type == STRUCT_DOOR && !ws->open);
                                        if (!is_wall && !is_door) continue;
                                        /* OBB collision: rotate player into wall-local space */
                                        float wrad = wall_get_rad(ws->x, ws->y);
                                        float wc  = cosf(-wrad), wsn = sinf(-wrad);
                                        float cpx = new_x - ws->x;
                                        float cpy = new_y - ws->y;
                                        float lx = cpx * wc  - cpy * wsn;
                                        float ly = cpx * wsn + cpy * wc;
                                        float clamp_x = lx < -25.0f ? -25.0f : (lx > 25.0f ? 25.0f : lx);
                                        float clamp_y = ly < -5.0f  ? -5.0f  : (ly > 5.0f  ? 5.0f  : ly);
                                        float dlx = lx - clamp_x, dly = ly - clamp_y;
                                        float dist_sq = dlx*dlx + dly*dly;
                                        if (dist_sq < PLAYER_R * PLAYER_R && dist_sq > 0.0001f) {
                                            float dist = sqrtf(dist_sq);
                                            float pen  = PLAYER_R - dist;
                                            /* Push in local space, rotate back to world space */
                                            float push_lx = (dlx / dist) * pen;
                                            float push_ly = (dly / dist) * pen;
                                            float wc_b = cosf(wrad), wsn_b = sinf(wrad);
                                            new_x += push_lx * wc_b - push_ly * wsn_b;
                                            new_y += push_lx * wsn_b + push_ly * wc_b;
                                        }
                                    }
                                }
                                /* Tree trunk collision — push player out of trunk radius
                                 * Uses alive_wood list: skips depleted trees, O(alive) not O(total). */
                                if (isl_mv) {
                                    const float PLAYER_R = 8.0f;
                                    const float combined_r = PLAYER_R + TREE_TRUNK_R_PX;
                                    for (int ak = 0; ak < isl_mv->alive_wood_count; ak++) {
                                        int ri = isl_mv->alive_wood[ak];
                                        float tx = isl_mv->x + isl_mv->resources[ri].ox;
                                        float ty = isl_mv->y + isl_mv->resources[ri].oy;
                                        float dx = new_x - tx, dy = new_y - ty;
                                        float dist_sq = dx * dx + dy * dy;
                                        if (dist_sq < combined_r * combined_r && dist_sq > 0.0001f) {
                                            float dist = sqrtf(dist_sq);
                                            float pen  = combined_r - dist;
                                            new_x += (dx / dist) * pen;
                                            new_y += (dy / dist) * pen;
                                        }
                                    }
                                }
                                /* Boulder collision — push player out of ellipse body */
                                if (isl_mv) {
                                    const float PLAYER_R = 8.0f;
                                    const float BOULDER_BASE_R = 38.0f;
                                    static const float BSX[5] = { 1.00f, 0.88f, 1.18f, 0.72f, 1.35f };
                                    static const float BSY[5] = { 0.72f, 0.88f, 0.60f, 1.00f, 0.50f };
                                    static const float BSR[5] = { 0.00f, 0.40f, -0.20f, 1.20f, 0.15f };
                                    for (int ri = 0; ri < isl_mv->resource_count; ri++) {
                                        const IslandResource *res = &isl_mv->resources[ri];
                                        if (res->type_id != RES_BOULDER) continue;
                                        if (res->health <= 0) continue;
                                        uint32_t bseed = ((uint32_t)((int)res->ox * 73856093)) ^
                                                         ((uint32_t)((int)res->oy * 19349663));
                                        int bsi = (int)((bseed >> 4) % 5u);
                                        float ax = BOULDER_BASE_R * res->size * BSX[bsi];
                                        float ay = BOULDER_BASE_R * res->size * BSY[bsi];
                                        float theta = BSR[bsi] + ((float)((bseed >> 8) & 0xFFu) / 256.0f) * (2.0f * 3.14159265f);
                                        float cos_t = cosf(theta), sin_t = sinf(theta);
                                        float bx = isl_mv->x + res->ox;
                                        float by = isl_mv->y + res->oy;
                                        float dx = new_x - bx, dy = new_y - by;
                                        float dist_sq = dx*dx + dy*dy;
                                        if (dist_sq < 1e-4f) { dx = PLAYER_R; dy = 0.0f; dist_sq = PLAYER_R*PLAYER_R; }
                                        float dist = sqrtf(dist_sq);
                                        /* Rotate into ellipse local frame */
                                        float dx_l =  dx * cos_t + dy * sin_t;
                                        float dy_l = -dx * sin_t + dy * cos_t;
                                        float unx = dx / dist, uny = dy / dist;
                                        float unx_l =  unx * cos_t + uny * sin_t;
                                        float uny_l = -unx * sin_t + uny * cos_t;
                                        float inv_ax = unx_l / ax, inv_ay = uny_l / ay;
                                        float r_eff = 1.0f / sqrtf(inv_ax*inv_ax + inv_ay*inv_ay);
                                        float min_dist = PLAYER_R + r_eff;
                                        if (dist >= min_dist) continue;
                                        /* Normal in local frame → rotate back to world */
                                        float gx_l = dx_l / (ax*ax), gy_l = dy_l / (ay*ay);
                                        float gn = sqrtf(gx_l*gx_l + gy_l*gy_l);
                                        if (gn < 1e-6f) { gx_l = 1.0f; gn = 1.0f; }
                                        float nx_l = gx_l / gn, ny_l = gy_l / gn;
                                        float nx = nx_l * cos_t - ny_l * sin_t;
                                        float ny = nx_l * sin_t + ny_l * cos_t;
                                        float pen = min_dist - dist;
                                        new_x += nx * pen;
                                        new_y += ny * pen;
                                    }
                                }
                                ws_player->x = new_x;
                                ws_player->y = new_y;
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_y));
                                sim_player->velocity.x = 0;
                                sim_player->velocity.y = 0;
                            } else {
                                /* Transitioned to swimming — write the new_x/new_y so the player
                                   is placed at the water's edge, not stuck inside the beach */
                                ws_player->x = new_x;
                                ws_player->y = new_y;
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_y));
                            }
                        } else if (ws_player->on_dock_id != 0) {
                            // ===== DOCK WALKING (WORLD COORDINATES) =====
                            PlacedStructure *dock_sy = NULL;
                            for (int _di = 0; _di < (int)placed_structure_count; _di++) {
                                if (placed_structures[_di].active &&
                                    placed_structures[_di].id == ws_player->on_dock_id) {
                                    dock_sy = &placed_structures[_di]; break;
                                }
                            }
                            if (!dock_sy || dock_sy->type != STRUCT_SHIPYARD) {
                                ws_player->on_dock_id = 0;
                                ws_player->movement_state = PLAYER_STATE_SWIMMING;
                            } else {
                                float walk_speed_client = SERVER_TO_CLIENT(WALK_MAX_SPEED);
                                if (ws_player->is_sprinting) walk_speed_client *= 1.6f;
                                float new_x = ws_player->x + movement_x * walk_speed_client * dt;
                                float new_y = ws_player->y + movement_y * walk_speed_client * dt;
                                bool _hs = (dock_sy->construction_phase == CONSTRUCTION_BUILDING);
                                float _dlx, _dly;
                                dock_world_to_local(dock_sy, new_x, new_y, &_dlx, &_dly);
                                if (!dock_point_on_surface(_dlx, _dly, _hs)) {
                                    ws_player->on_dock_id = 0;
                                    ws_player->movement_state = PLAYER_STATE_SWIMMING;
                                    sim_player->velocity.x = Q16_FROM_FLOAT(
                                        CLIENT_TO_SERVER(movement_x * walk_speed_client));
                                    sim_player->velocity.y = Q16_FROM_FLOAT(
                                        CLIENT_TO_SERVER(movement_y * walk_speed_client));
                                } else {
                                    dock_apply_player_collision(dock_sy, 8.0f, _hs, &new_x, &new_y);
                                    sim_player->velocity.x = 0;
                                    sim_player->velocity.y = 0;
                                }
                                ws_player->x = new_x;
                                ws_player->y = new_y;
                                sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_x));
                                sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(new_y));
                                /* Board scaffolded ship if player steps onto the deck */
                                if (ws_player->on_dock_id != 0 && _hs &&
                                    dock_sy->scaffolded_ship_id != 0) {
                                    SimpleShip *_ssp = find_ship(dock_sy->scaffolded_ship_id);
                                    if (_ssp) {
                                        float _slx, _sly;
                                        ship_world_to_local(_ssp, ws_player->x, ws_player->y,
                                                            &_slx, &_sly);
                                        if (!is_outside_deck(_ssp->ship_id, _slx, _sly)) {
                                            ws_player->on_dock_id = 0;
                                            board_player_on_ship(ws_player, _ssp, _slx, _sly);
                                            struct Player *_dsp = sim_get_player(
                                                global_sim, ws_player->sim_entity_id);
                                            if (_dsp) _dsp->ship_id = _ssp->ship_id;
                                        }
                                    }
                                }
                            }
                        } else {
                            // ===== SWIMMING MOVEMENT (WORLD COORDINATES) =====
                            // Apply acceleration in movement direction
                            q16_t accel_x = Q16_FROM_FLOAT(movement_x * SWIM_ACCELERATION * dt);
                            q16_t accel_y = Q16_FROM_FLOAT(movement_y * SWIM_ACCELERATION * dt);
                            
                            // log_info("⚡ P%u: Swimming | accel=(%.2f, %.2f) | dir=(%.2f, %.2f) | dt=%.3f",
                            //          sim_player->id,
                            //          Q16_TO_FLOAT(accel_x), Q16_TO_FLOAT(accel_y),
                            //          movement_x, movement_y, dt);
                            
                            sim_player->velocity.x += accel_x;
                            sim_player->velocity.y += accel_y;
                            
                            // Clamp to maximum speed
                            float current_vx = Q16_TO_FLOAT(sim_player->velocity.x);
                            float current_vy = Q16_TO_FLOAT(sim_player->velocity.y);
                            float current_speed = sqrtf(current_vx * current_vx + current_vy * current_vy);
                            
                            if (current_speed > SWIM_MAX_SPEED) {
                                // Scale velocity back to max speed
                                float scale = SWIM_MAX_SPEED / current_speed;
                                // log_info("🚀 P%u: Speed clamped %.2f → %.2f m/s | vel=(%.2f, %.2f) → (%.2f, %.2f)",
                                //          sim_player->id,
                                //          current_speed, SWIM_MAX_SPEED,
                                //          current_vx, current_vy,
                                //          current_vx * scale, current_vy * scale);
                                sim_player->velocity.x = Q16_FROM_FLOAT(current_vx * scale);
                                sim_player->velocity.y = Q16_FROM_FLOAT(current_vy * scale);
                            }
                        }
                    }
                } else {
                    // Player stopped moving - no deceleration needed for on-ship movement
                    // (player position is fixed relative to ship, ship velocity handles world movement)
                    if (!on_ship && ws_player->on_island_id != 0) {
                        /* On island and stopped — zero velocity, no deceleration needed */
                        sim_player->velocity.x = 0;
                        sim_player->velocity.y = 0;
                    } else if (!on_ship && ws_player->on_dock_id != 0) {
                        /* On dock and stopped — zero velocity; keep local_x/y synced
                         * for dock players in the shipyard zone (scaffold on pinned ship). */
                        sim_player->velocity.x = 0;
                        sim_player->velocity.y = 0;
                        for (int _zdi = 0; _zdi < (int)placed_structure_count; _zdi++) {
                            PlacedStructure *_zd = &placed_structures[_zdi];
                            if (_zd->active && _zd->id == ws_player->on_dock_id &&
                                _zd->type == STRUCT_SHIPYARD && _zd->scaffolded_ship_id != 0) {
                                SimpleShip *_zs = find_ship(_zd->scaffolded_ship_id);
                                if (_zs) {
                                    ship_world_to_local(_zs, ws_player->x, ws_player->y,
                                                        &ws_player->local_x, &ws_player->local_y);
                                }
                                break;
                            }
                        }
                    } else if (!on_ship) {
                        // Only apply deceleration for swimming players
                        float current_vx = Q16_TO_FLOAT(sim_player->velocity.x);
                        float current_vy = Q16_TO_FLOAT(sim_player->velocity.y);
                        float current_speed = sqrtf(current_vx * current_vx + current_vy * current_vy);
                        
                        if (current_speed > 0.1f) {
                            // Apply deceleration opposite to velocity direction
                            float decel_amount = SWIM_DECELERATION * dt;
                            
                            if (decel_amount >= current_speed) {
                                // Stop completely
                                // log_info("🛑 P%u: Stopping | speed=%.2f → 0.00 m/s | vel=(%.2f, %.2f) → (0.00, 0.00)",
                                //          sim_player->id, current_speed, current_vx, current_vy);
                                sim_player->velocity.x = 0;
                                sim_player->velocity.y = 0;
                            } else {
                                // Reduce speed
                                float scale = (current_speed - decel_amount) / current_speed;
                                float new_vx = current_vx * scale;
                                float new_vy = current_vy * scale;
                                // log_info("⬇️ P%u: Decelerating | speed=%.2f → %.2f m/s | vel=(%.2f, %.2f) → (%.2f, %.2f)",
                                //          sim_player->id,
                                //          current_speed, current_speed - decel_amount,
                                //          current_vx, current_vy, new_vx, new_vy);
                                sim_player->velocity.x = Q16_FROM_FLOAT(new_vx);
                                sim_player->velocity.y = Q16_FROM_FLOAT(new_vy);
                            }
                        } else if (current_speed > 0.01f) {
                            // Snap to zero for very low speeds
                            // log_info("🛑 P%u: Snap to zero | speed=%.2f m/s (below threshold)",
                            //          sim_player->id, current_speed);
                            sim_player->velocity.x = 0;
                            sim_player->velocity.y = 0;
                        }
                    }
                }
                
                // Copy simulation position BACK to WebSocket player for rendering (scale to client coords)
                // BUT: For players on ships, their world position is calculated from local coords + ship transform
                // So we only copy back position for swimming players
                if (!on_ship) {
                    ws_player->x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->position.x));
                    ws_player->y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->position.y));
                    ws_player->velocity_x = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->velocity.x));
                    ws_player->velocity_y = SERVER_TO_CLIENT(Q16_TO_FLOAT(sim_player->velocity.y));
                    /* Island enter/leave detection (every tick, all non-ship players) */
                    float wx = ws_player->x, wy = ws_player->y;
                    if (ws_player->on_island_id == 0) {
                        /* Entering: broad phase → narrow BEACH boundary (bump-circle or polygon) */
                        for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                            const IslandDef *isl = &ISLAND_PRESETS[ii];
                            float dx = wx - isl->x, dy = wy - isl->y;
                            float dist_sq = dx*dx + dy*dy;
                            bool entering;
                            if (isl->vertex_count > 0) {
                                entering = (dist_sq < isl->poly_bound_r * isl->poly_bound_r)
                                        && island_poly_contains(isl, wx, wy);
                            } else {
                                float broad_r = isl->beach_radius_px + isl->beach_max_bump;
                                if (dist_sq >= broad_r * broad_r) { entering = false; }
                                else {
                                    float angle   = atan2f(dy, dx);
                                    float narrow_r = island_boundary_r(isl->beach_radius_px,
                                                                       isl->beach_bumps, angle);
                                    entering = (dist_sq < narrow_r * narrow_r);
                                }
                            }
                            if (entering) {
                                ws_player->on_island_id = (uint32_t)isl->id;
                                ws_player->movement_state = PLAYER_STATE_WALKING;
                                sim_player->velocity.x = 0;
                                sim_player->velocity.y = 0;
                                log_info("\U0001F3DD\uFE0F Player %u stepped onto island %d",
                                         ws_player->player_id, isl->id);
                                break;
                            }
                        }
                    } else {
                        /* Leaving: fallback exit when outside BEACH boundary + 10px hysteresis.
                           Primary exit is handled inline in the movement block above. */
                        const IslandDef *isl = NULL;
                        for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                            if ((uint32_t)ISLAND_PRESETS[ii].id == ws_player->on_island_id) {
                                isl = &ISLAND_PRESETS[ii]; break;
                            }
                        }
                        if (isl) {
                            float dx = wx - isl->x, dy = wy - isl->y;
                            float dist_sq = dx*dx + dy*dy;
                            /* Broad phase: skip narrow test if clearly still inside */
                            bool still_on;
                            if (isl->vertex_count > 0) {
                                still_on = island_poly_contains(isl, wx, wy);
                            } else {
                                still_on = true;
                                float inner_r = isl->beach_radius_px - isl->beach_max_bump;
                                if (dist_sq > inner_r * inner_r) {
                                    float angle   = atan2f(dy, dx);
                                    float narrow_r = island_boundary_r(isl->beach_radius_px,
                                                                       isl->beach_bumps, angle)
                                                     + 10.0f; /* 10px hysteresis */
                                    still_on = (dist_sq <= narrow_r * narrow_r);
                                }
                            }
                            if (!still_on) {
                                    ws_player->on_island_id = 0;
                                    ws_player->movement_state = PLAYER_STATE_SWIMMING;
                                    log_info("\U0001F30A Player %u left island", ws_player->player_id);
                            }
                        }
                    }
                    /* ── Dock enter/exit detection (non-ship players) ─────────────── */
                    if (ws_player->on_dock_id == 0) {
                        /* Try to step onto a dock surface (through stair gaps) */
                        if (ws_player->on_island_id == 0) {
                            for (int _di = 0; _di < (int)placed_structure_count; _di++) {
                                PlacedStructure *_dk = &placed_structures[_di];
                                if (!_dk->active || _dk->type != STRUCT_SHIPYARD) continue;
                                float _dlx, _dly;
                                dock_world_to_local(_dk, wx, wy, &_dlx, &_dly);
                                bool _hs = (_dk->construction_phase == CONSTRUCTION_BUILDING);
                                if (dock_point_on_surface(_dlx, _dly, _hs)) {
                                    ws_player->on_dock_id = _dk->id;
                                    ws_player->movement_state = PLAYER_STATE_WALKING;
                                    sim_player->velocity.x = 0;
                                    sim_player->velocity.y = 0;
                                    log_info("🛖 Player %u stepped onto dock %u",
                                             ws_player->player_id, _dk->id);
                                    break;
                                }
                            }
                        }
                        /* OBB pushout: keep swimming players outside dock walls */
                        if (ws_player->on_dock_id == 0 && ws_player->on_island_id == 0) {
                            for (int _di = 0; _di < (int)placed_structure_count; _di++) {
                                PlacedStructure *_dk = &placed_structures[_di];
                                if (!_dk->active || _dk->type != STRUCT_SHIPYARD) continue;
                                bool _hs = (_dk->construction_phase == CONSTRUCTION_BUILDING);
                                float _ox = ws_player->x, _oy = ws_player->y;
                                float _nx = _ox, _ny = _oy;
                                dock_apply_player_collision(_dk, 8.0f, _hs, &_nx, &_ny);
                                float _pdx = _nx - _ox, _pdy = _ny - _oy;
                                float _pmag2 = _pdx * _pdx + _pdy * _pdy;
                                if (_pmag2 > 0.0001f) {
                                    ws_player->x = _nx; ws_player->y = _ny;
                                    sim_player->position.x = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_nx));
                                    sim_player->position.y = Q16_FROM_FLOAT(CLIENT_TO_SERVER(_ny));
                                    float _pmag = sqrtf(_pmag2);
                                    float _pnx = _pdx / _pmag, _pny = _pdy / _pmag;
                                    float _vx = Q16_TO_FLOAT(sim_player->velocity.x);
                                    float _vy = Q16_TO_FLOAT(sim_player->velocity.y);
                                    float _dot = _vx * _pnx + _vy * _pny;
                                    if (_dot < 0.0f) {
                                        sim_player->velocity.x = Q16_FROM_FLOAT(_vx - _dot * _pnx);
                                        sim_player->velocity.y = Q16_FROM_FLOAT(_vy - _dot * _pny);
                                    }
                                }
                            }
                        }
                    } else {
                        /* On dock — verify still on surface each tick */
                        PlacedStructure *_dk = NULL;
                        for (int _di = 0; _di < (int)placed_structure_count; _di++) {
                            if (placed_structures[_di].active &&
                                placed_structures[_di].id == ws_player->on_dock_id) {
                                _dk = &placed_structures[_di]; break;
                            }
                        }
                        if (!_dk || _dk->type != STRUCT_SHIPYARD) {
                            ws_player->on_dock_id = 0;
                            ws_player->movement_state = PLAYER_STATE_SWIMMING;
                        } else {
                            float _dlx, _dly;
                            dock_world_to_local(_dk, wx, wy, &_dlx, &_dly);
                            bool _hs = (_dk->construction_phase == CONSTRUCTION_BUILDING);
                            if (!dock_point_on_surface(_dlx, _dly, _hs)) {
                                uint32_t _did = ws_player->on_dock_id;
                                ws_player->on_dock_id = 0;
                                ws_player->movement_state = PLAYER_STATE_SWIMMING;
                                log_info("🌊 Player %u left dock %u", ws_player->player_id, _did);
                            }
                        }
                    }
                } else {
                    // For on-ship players, recalculate world position from local coords
                    // (ship might have moved/rotated since last tick)
                    if (player_ship) {
                        ship_local_to_world(player_ship, ws_player->local_x, ws_player->local_y,
                                          &ws_player->x, &ws_player->y);
                    }
                    // On-ship players have zero velocity (movement is relative to ship)
                    ws_player->velocity_x = 0.0f;
                    ws_player->velocity_y = 0.0f;
                }
            }
        }
    }
    
    // ===== GRADUALLY ADJUST SHIP SAILS TO DESIRED OPENNESS =====
    // Rate: 10% per 0.2 seconds = 50% per second
    const float SAIL_ADJUST_RATE = 50.0f; // percent per second
    static uint32_t last_sail_update = 0;
    
    // Update sails at fixed intervals (200ms = 0.2s for 10% change)
    if (current_time - last_sail_update >= 200) {
        float time_delta = (current_time - last_sail_update) / 1000.0f; // Convert to seconds
        float max_change = SAIL_ADJUST_RATE * time_delta; // How much we can change this update
        
        // Update simulation ships (the ones we broadcast to clients)
        if (global_sim && global_sim->ship_count > 0) {
            for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                struct Ship* ship = &global_sim->ships[s];
                uint8_t desired = ship->desired_sail_openness;
                
                // For each mast on the ship, gradually adjust to desired openness
                // — only masts that have a rigger physically stationed there respond.
                for (uint8_t m = 0; m < ship->module_count; m++) {
                    if (ship->modules[m].type_id == MODULE_TYPE_MAST &&
                        is_mast_manned(ship->id, ship->modules[m].id)) {
                        uint8_t current = ship->modules[m].data.mast.openness;
                        
                        if (current != desired) {
                            float diff = (float)desired - (float)current;
                            float change = diff;
                            
                            // Clamp change to max rate (10% per 0.2s)
                            if (change > max_change) change = max_change;
                            if (change < -max_change) change = -max_change;
                            
                            uint8_t new_openness = (uint8_t)((float)current + change);
                            
                            // Clamp to valid range
                            if (new_openness > 100) new_openness = 100;
                            
                            ship->modules[m].data.mast.openness = new_openness;
                            
                            // Log only when there's a visible change
                            // if (new_openness != current) {
                            //     log_info("⛵ Ship %u Mast %u: %u%% → %u%% (target: %u%%)",
                            //            ship->id, ship->modules[m].id,
                            //            current, new_openness, desired);
                            // }
                        }
                    }
                }
            }
        }
        
        last_sail_update = current_time;
    }
    
    // ===== GRADUALLY ADJUST RUDDER ANGLE TO TARGET =====
    // Rate: 5 degrees per 0.2 seconds = 25 degrees per second
    const float RUDDER_ADJUST_RATE = 25.0f; // degrees per second
    static uint32_t last_rudder_update = 0;
    
    if (current_time - last_rudder_update >= 200) {
        float time_delta = (current_time - last_rudder_update) / 1000.0f;
        float max_rudder_change = RUDDER_ADJUST_RATE * time_delta; // 5 degrees per 0.2s
        
        if (global_sim && global_sim->ship_count > 0) {
            for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                struct Ship* ship = &global_sim->ships[s];
                
                // Gradually move rudder to target angle
                if (ship->rudder_angle != ship->target_rudder_angle) {
                    float diff = ship->target_rudder_angle - ship->rudder_angle;
                    float change = diff;
                    
                    // Clamp change to max rate
                    if (change > max_rudder_change) change = max_rudder_change;
                    if (change < -max_rudder_change) change = -max_rudder_change;
                    
                    ship->rudder_angle += change;
                    
                    // Clamp to valid range
                    if (ship->rudder_angle > 50.0f) ship->rudder_angle = 50.0f;
                    if (ship->rudder_angle < -50.0f) ship->rudder_angle = -50.0f;
                }
            }
        }
        
        last_rudder_update = current_time;
    }
    
    // ===== UPDATE CANNON AND SWIVEL RELOAD TIMERS =====
    // Track time since last fire for each cannon/swivel
    static uint32_t last_cannon_update = 0;
    static uint32_t last_dot_update = 0;
    
    if (current_time - last_cannon_update >= 100) { // Update every 100ms
        uint32_t time_elapsed = current_time - last_cannon_update;
        
        if (global_sim && global_sim->ship_count > 0) {
            for (uint32_t s = 0; s < global_sim->ship_count; s++) {
                struct Ship* ship = &global_sim->ships[s];
                
                for (uint8_t m = 0; m < ship->module_count; m++) {
                    if (ship->modules[m].type_id == MODULE_TYPE_CANNON) {
                        ShipModule* cannon = &ship->modules[m];
                        
                        // Increment time since fire (capped at reload time)
                        if (cannon->data.cannon.time_since_fire < cannon->data.cannon.reload_time) {
                            cannon->data.cannon.time_since_fire += time_elapsed;
                            
                            // Clamp to reload time
                            if (cannon->data.cannon.time_since_fire > cannon->data.cannon.reload_time) {
                                cannon->data.cannon.time_since_fire = cannon->data.cannon.reload_time;
                            }
                        }
                    }
                }
            }
        }

        /* Swivel reload — tick ships[] (SimpleShip); handle_swivel_fire checks this array */
        for (int s = 0; s < ship_count; s++) {
            if (!ships[s].active) continue;
            for (int m = 0; m < ships[s].module_count; m++) {
                if (ships[s].modules[m].type_id != MODULE_TYPE_SWIVEL) continue;
                ShipModule* sw = &ships[s].modules[m];
                if (sw->data.swivel.time_since_fire < sw->data.swivel.reload_time) {
                    sw->data.swivel.time_since_fire += time_elapsed;
                    if (sw->data.swivel.time_since_fire > sw->data.swivel.reload_time)
                        sw->data.swivel.time_since_fire = sw->data.swivel.reload_time;
                }
            }
        }
        
        last_cannon_update = current_time;

        /* ===== FLAME WAVE UPDATE (every 100ms) ===== */
        update_flame_waves(time_elapsed);

        /* ===== FIRE DOT TICK (every 500ms, 5x damage per tick = same DPS, fewer broadcasts) ===== */
        if (current_time - last_dot_update >= 500) {
        uint32_t dot_elapsed = current_time - last_dot_update;
        last_dot_update = current_time;
        /* NPCs on fire: 5 base HP + 1.25% max_health per 500ms tick */
        for (int ni = 0; ni < world_npc_count; ni++) {
            WorldNpc* npc = &world_npcs[ni];
            if (!npc->active || npc->fire_timer_ms == 0) continue;
            /* Water extinguishes fire — NPC overboard */
            if (npc->in_water) {
                npc->fire_timer_ms = 0;
                char fx[192];
                snprintf(fx, sizeof(fx),
                    "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"npc\",\"id\":%u}",
                    npc->id);
                broadcast_json_all(fx);
                continue;
            }
            uint16_t npc_fire_dmg = 5u + (uint16_t)(npc->max_health / 80u);
            if (npc->health > npc_fire_dmg) npc->health -= npc_fire_dmg; else npc->health = 0;
            if (npc->health == 0) {
                npc->active = false;
                npc->fire_timer_ms = 0;
                char death_msg[192];
                snprintf(death_msg, sizeof(death_msg),
                    "{\"type\":\"ENTITY_HIT\",\"entityType\":\"npc\",\"id\":%u,"
                    "\"x\":%.1f,\"y\":%.1f,\"damage\":%u,"
                    "\"health\":0,\"maxHealth\":%u,\"killed\":true}",
                    npc->id, npc->x, npc->y, (unsigned)npc_fire_dmg, (unsigned)npc->max_health);
                char death_frame[256];
                size_t dfl = websocket_create_frame(WS_OPCODE_TEXT, death_msg, strlen(death_msg), death_frame, sizeof(death_frame));
                if (dfl > 0) {
                    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                        struct WebSocketClient* wc = &ws_server.clients[ci];
                        if (wc->connected && wc->handshake_complete) send(wc->fd, death_frame, dfl, 0);
                    }
                }
                continue;
            }
            if (npc->fire_timer_ms > dot_elapsed) {
                npc->fire_timer_ms -= dot_elapsed;
            } else {
                npc->fire_timer_ms = 0;
                /* Broadcast FIRE_EXTINGUISHED for NPC */
                char fx[192];
                snprintf(fx, sizeof(fx),
                    "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"npc\",\"id\":%u}",
                    npc->id);
                char fxf[256];
                size_t fxfl = websocket_create_frame(WS_OPCODE_TEXT, fx, strlen(fx), fxf, sizeof(fxf));
                if (fxfl > 0) {
                    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                        struct WebSocketClient* wc = &ws_server.clients[ci];
                        if (wc->connected && wc->handshake_complete) send(wc->fd, fxf, fxfl, 0);
                    }
                }
            }
        }

        /* Players on fire: 5 base HP + 1.25% max_health per 500ms tick */
        for (int wpi = 0; wpi < WS_MAX_CLIENTS; wpi++) {
            WebSocketPlayer* wp = &players[wpi];
            if (!wp->active || wp->fire_timer_ms == 0) continue;
            /* Water extinguishes fire — player swimming */
            if (wp->movement_state == PLAYER_STATE_SWIMMING) {
                wp->fire_timer_ms = 0;
                char fx[192];
                snprintf(fx, sizeof(fx),
                    "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"player\",\"id\":%u}",
                    wp->player_id);
                broadcast_json_all(fx);
                continue;
            }
            uint16_t pl_fire_dmg = 5u + (uint16_t)(wp->max_health / 80u);
            if (wp->health > pl_fire_dmg) { wp->health -= pl_fire_dmg; } else { wp->health = 0; player_die(wp); }
            if (wp->fire_timer_ms > dot_elapsed) {
                wp->fire_timer_ms -= dot_elapsed;
            } else {
                wp->fire_timer_ms = 0;
                char fx[192];
                snprintf(fx, sizeof(fx),
                    "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"player\",\"id\":%u}",
                    wp->player_id);
                char fxf[256];
                size_t fxfl = websocket_create_frame(WS_OPCODE_TEXT, fx, strlen(fx), fxf, sizeof(fxf));
                if (fxfl > 0) {
                    for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                        struct WebSocketClient* wc = &ws_server.clients[ci];
                        if (wc->connected && wc->handshake_complete) send(wc->fd, fxf, fxfl, 0);
                    }
                }
            }
        }

        /* Wooden modules on fire: 50 HP per tick (~500 HP/s, 5000 HP over 10 s) */
        for (int s = 0; s < ship_count; s++) {
            if (!ships[s].active) continue;
            SimpleShip* fship = &ships[s];
            float cos_r = cosf(fship->rotation);
            float sin_r = sinf(fship->rotation);
            for (int m = 0; m < fship->module_count; m++) {
                ShipModule* mod = &fship->modules[m];
                if (mod->fire_timer_ms == 0) continue;
                /* Stop DOT ticking on already-destroyed modules and extinguish
                   their fire — prevents repeated "destroyed" log spam. */
                if (mod->state_bits & MODULE_STATE_DESTROYED) {
                    mod->fire_timer_ms = 0;
                    continue;
                }
                ModuleTypeId mt = mod->type_id;
                if (mt != MODULE_TYPE_PLANK && mt != MODULE_TYPE_DECK && mt != MODULE_TYPE_MAST) continue;

                /* ── Mast/sail fiber fire: intensity-based system ── */
                if (mt == MODULE_TYPE_MAST) {
                    uint8_t intensity = mod->data.mast.sail_fire_intensity;
                    uint8_t openness  = mod->data.mast.openness;
                    if (intensity == 0) {
                        mod->fire_timer_ms = 0;
                        continue;
                    }
                    if (openness == 0) {
                        /* Furled sails douse the flames: -15 per 500ms tick (~3.3 s to fully extinguish) */
                        int ni = (int)intensity - 15;
                        if (ni <= 0) {
                            mod->data.mast.sail_fire_intensity = 0;
                            mod->fire_timer_ms = 0;
                            /* Sync global_sim */
                            {
                                struct Ship* _fss = find_sim_ship(fship->ship_id);
                                if (_fss) {
                                    for (uint8_t gm = 0; gm < _fss->module_count; gm++) {
                                        if (_fss->modules[gm].id == mod->id) {
                                            _fss->modules[gm].data.mast.sail_fire_intensity = 0;
                                            _fss->modules[gm].fire_timer_ms = 0;
                                            break;
                                        }
                                    }
                                }
                            }
                            {
                                float mx2 = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
                                float my2 = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
                                float mwx = fship->x + (mx2 * cos_r - my2 * sin_r);
                                float mwy = fship->y + (mx2 * sin_r + my2 * cos_r);
                                char fx[256];
                                snprintf(fx, sizeof(fx),
                                    "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"module\","
                                    "\"shipId\":%u,\"moduleId\":%u,\"x\":%.1f,\"y\":%.1f}",
                                    fship->ship_id, mod->id, mwx, mwy);
                                broadcast_json_all(fx);
                            }
                            continue;
                        }
                        mod->data.mast.sail_fire_intensity = (uint8_t)ni;
                    } else {
                        /* Open sails: intensity creeps up naturally while burning (+2 per 500ms) */
                        int ni = (int)intensity + 2;
                        if (ni > 100) ni = 100;
                        mod->data.mast.sail_fire_intensity = (uint8_t)ni;
                        mod->fire_timer_ms = FIRE_DURATION_MS; /* keep the flame alive */
                    }
                    /* Fiber damage: base DOT scaled by current intensity (0-100%) */
                    float fh    = Q16_TO_FLOAT(mod->data.mast.fiber_health);
                    float fhmax = Q16_TO_FLOAT(mod->data.mast.fiber_max_health);
                    float fiber_dot = (37.5f + fhmax * 0.00625f)
                                    * ((float)mod->data.mast.sail_fire_intensity / 100.0f);
                    fh -= fiber_dot;
                    if (fh < 0.0f) fh = 0.0f;
                    mod->data.mast.fiber_health    = Q16_FROM_FLOAT(fh);
                    mod->data.mast.wind_efficiency = (fhmax > 0.0f)
                        ? Q16_FROM_FLOAT(fh / fhmax) : 0;
                    /* Sync global_sim mast data */
                    {
                        struct Ship* _fss = find_sim_ship(fship->ship_id);
                        if (_fss) {
                            for (uint8_t gm = 0; gm < _fss->module_count; gm++) {
                                if (_fss->modules[gm].id == mod->id) {
                                    _fss->modules[gm].data.mast.fiber_health       = mod->data.mast.fiber_health;
                                    _fss->modules[gm].data.mast.wind_efficiency    = mod->data.mast.wind_efficiency;
                                    _fss->modules[gm].data.mast.sail_fire_intensity = mod->data.mast.sail_fire_intensity;
                                    _fss->modules[gm].fire_timer_ms                = mod->fire_timer_ms;
                                    break;
                                }
                            }
                        }
                    }
                    /* Broadcast per-tick sail fiber fire update */
                    {
                        float mx2 = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
                        float my2 = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
                        float mwx = fship->x + (mx2 * cos_r - my2 * sin_r);
                        float mwy = fship->y + (mx2 * sin_r + my2 * cos_r);
                        char dmsg[256];
                        snprintf(dmsg, sizeof(dmsg),
                            "{\"type\":\"SAIL_FIBER_FIRE\",\"shipId\":%u,\"moduleId\":%u,"
                            "\"intensity\":%u,\"fiberHealth\":%.0f,\"windEff\":%.3f,"
                            "\"x\":%.1f,\"y\":%.1f}",
                            fship->ship_id, mod->id,
                            (unsigned)mod->data.mast.sail_fire_intensity,
                            fh, Q16_TO_FLOAT(mod->data.mast.wind_efficiency),
                            mwx, mwy);
                        broadcast_json_all(dmsg);
                    }
                    /* Tick the fire timer normally */
                    if (mod->fire_timer_ms > dot_elapsed) {
                        mod->fire_timer_ms -= dot_elapsed;
                    } else {
                        /* Timer expired without fresh flame contact — extinguish */
                        mod->fire_timer_ms = 0;
                        mod->data.mast.sail_fire_intensity = 0;
                        {
                            struct Ship* _fss = find_sim_ship(fship->ship_id);
                            if (_fss) {
                                for (uint8_t gm = 0; gm < _fss->module_count; gm++) {
                                    if (_fss->modules[gm].id == mod->id) {
                                        _fss->modules[gm].data.mast.sail_fire_intensity = 0;
                                        _fss->modules[gm].fire_timer_ms = 0;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    continue; /* skip generic plank/deck path below */
                }

                /* Apply 7.5 base + 0.125% of max_health per 100ms tick.
                 * mod->health is a raw integer (not Q16-scaled), so compute
                 * DOT as a plain integer too — do NOT use Q16_FROM_FLOAT here. */
                q16_t fire_dot = (q16_t)(37.5f + (float)mod->max_health * 0.00625f);
                /* Deck: scale damage by the number of burning zones (1 – 3×). */
                if (mt == MODULE_TYPE_DECK) {
                    uint8_t zones = (uint8_t)(((mod->state_bits >> 11) & 1u)
                                           + ((mod->state_bits >> 12) & 1u)
                                           + ((mod->state_bits >> 13) & 1u));
                    if (zones > 1) fire_dot = (q16_t)(fire_dot * zones);
                }
                module_apply_damage(mod, fire_dot);

                /* Sync updated health/state back to global_sim Ship module so that
                 * GAME_STATE (which reads from sim->ships[]) broadcasts the correct value.
                 * SimpleShip and Ship are separate structs; fire DOT only writes to SimpleShip. */
                {
                    struct Ship* _fss = find_sim_ship(fship->ship_id);
                    if (_fss) {
                        for (uint8_t gm = 0; gm < _fss->module_count; gm++) {
                            if (_fss->modules[gm].id == mod->id) {
                                _fss->modules[gm].health     = mod->health;
                                _fss->modules[gm].state_bits = mod->state_bits;
                                break;
                            }
                        }
                    }
                }

                /* Broadcast damage tick so client sees health decreasing. */
                {
                    float lx2 = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
                    float ly2 = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
                    float wx2 = fship->x + (lx2 * cos_r - ly2 * sin_r);
                    float wy2 = fship->y + (lx2 * sin_r + ly2 * cos_r);
                    char dmsg[256];
                    bool destroyed_now = (mod->state_bits & MODULE_STATE_DESTROYED) != 0;
                    uint32_t mod_id_saved = mod->id; /* save before potential memmove */
                    if (destroyed_now) {
                        /* Module burnt out — remove from ship and broadcast destruction */
                        if (mt == MODULE_TYPE_PLANK || mt == MODULE_TYPE_DECK) {
                            /* Remove plank/deck from SimpleShip (same as cannon projectile path) */
                            for (int rm = 0; rm < fship->module_count; rm++) {
                                if (fship->modules[rm].id == mod_id_saved) {
                                    memmove(&fship->modules[rm], &fship->modules[rm + 1],
                                            (fship->module_count - rm - 1) * sizeof(ShipModule));
                                    fship->module_count--;
                                    mod = NULL; /* pointer now stale */
                                    break;
                                }
                            }
                            snprintf(dmsg, sizeof(dmsg),
                                "{\"type\":\"PLANK_HIT\",\"shipId\":%u,\"plankId\":%u,"
                                "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                                fship->ship_id, mod_id_saved, (float)fire_dot, wx2, wy2);
                        } else {
                            snprintf(dmsg, sizeof(dmsg),
                                "{\"type\":\"MODULE_HIT\",\"shipId\":%u,\"moduleId\":%u,"
                                "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                                fship->ship_id, mod_id_saved, (float)fire_dot, wx2, wy2);
                        }
                    } else {
                        if (mt == MODULE_TYPE_PLANK || mt == MODULE_TYPE_DECK) {
                            snprintf(dmsg, sizeof(dmsg),
                                "{\"type\":\"PLANK_DAMAGED\",\"shipId\":%u,\"plankId\":%u,"
                                "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                                fship->ship_id, mod->id, (float)fire_dot, wx2, wy2);
                        } else {
                            snprintf(dmsg, sizeof(dmsg),
                                "{\"type\":\"MODULE_DAMAGED\",\"shipId\":%u,\"moduleId\":%u,"
                                "\"damage\":%.0f,\"x\":%.1f,\"y\":%.1f}",
                                fship->ship_id, mod->id, (float)fire_dot, wx2, wy2);
                        }
                    }
                    broadcast_json_all(dmsg);
                    /* Destroyed modules get their fire timer cleared and we skip to next */
                    if (!mod || (mod->state_bits & MODULE_STATE_DESTROYED)) {
                        if (mod) mod->fire_timer_ms = 0;
                        continue;
                    }
                }

                /* Tick module fire timer */
                bool extinguished = false;
                if (mod->fire_timer_ms > dot_elapsed) {
                    mod->fire_timer_ms -= dot_elapsed;
                } else {
                    mod->fire_timer_ms = 0;
                    extinguished = true;
                }
                if (extinguished) {
                    /* Clear deck zone bits that accumulated during this burn */
                    if (mt == MODULE_TYPE_DECK) {
                        mod->state_bits &= (uint16_t)~((1u<<11)|(1u<<12)|(1u<<13));
                    }
                    float lx = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.x));
                    float ly = SERVER_TO_CLIENT(Q16_TO_FLOAT(mod->local_pos.y));
                    float wx = fship->x + (lx * cos_r - ly * sin_r);
                    float wy = fship->y + (lx * sin_r + ly * cos_r);
                    char fx[256];
                    snprintf(fx, sizeof(fx),
                        "{\"type\":\"FIRE_EXTINGUISHED\",\"entityType\":\"module\","
                        "\"shipId\":%u,\"moduleId\":%u,\"x\":%.1f,\"y\":%.1f}",
                        fship->ship_id, mod->id, wx, wy);
                    char fxf[320];
                    size_t fxfl = websocket_create_frame(WS_OPCODE_TEXT, fx, strlen(fx), fxf, sizeof(fxf));
                    if (fxfl > 0) {
                        for (int ci = 0; ci < WS_MAX_CLIENTS; ci++) {
                            struct WebSocketClient* wc = &ws_server.clients[ci];
                            if (wc->connected && wc->handshake_complete) send(wc->fd, fxf, fxfl, 0);
                        }
                    }
                }
            }
        }
        } /* end FIRE DOT TICK 500ms */
    }

    /* ===== TOMBSTONE EXPIRY TICK (every 10 s) ================================
       Walk active tombstones and despawn any that have exceeded TOMBSTONE_TTL_MS.  */
    {
        static uint32_t last_tombstone_tick = 0;
        if (current_time - last_tombstone_tick >= 10000u) {
            last_tombstone_tick = current_time;
            for (int ti = 0; ti < (int)MAX_TOMBSTONES; ti++) {
                if (!tombstones[ti].active) continue;
                uint32_t age = current_time - tombstones[ti].spawn_time_ms;
                if (age >= TOMBSTONE_TTL_MS) {
                    tombstones[ti].active = false;
                    char dm[128];
                    snprintf(dm, sizeof(dm),
                        "{\"type\":\"tombstone_despawned\",\"id\":%u}", tombstones[ti].id);
                    websocket_server_broadcast(dm);
                    log_info("⚰️  Tombstone %u expired (15-min TTL)", tombstones[ti].id);
                }
            }
        }
    }

    /* ===== DROPPED ITEM EXPIRY TICK (every 30 s) =============================
       Walk active dropped items and despawn any older than DROPPED_ITEM_TTL_MS. */
    {
        static uint32_t last_drop_tick = 0;
        if (current_time - last_drop_tick >= 30000u) {
            last_drop_tick = current_time;
            for (int di = 0; di < (int)MAX_DROPPED_ITEMS; di++) {
                if (!dropped_items[di].active) continue;
                uint32_t age = current_time - dropped_items[di].spawn_time_ms;
                if (age >= DROPPED_ITEM_TTL_MS) {
                    dropped_items[di].active = false;
                    log_info("📦  Dropped item %u expired (5-min TTL)", dropped_items[di].id);
                }
            }
        }
    }

    // ===== APPLY WIND-BASED SHIP MOVEMENT =====
    static uint32_t last_movement_log = 0;
    if (global_sim && global_sim->ship_count > 0) {
        for (uint32_t s = 0; s < global_sim->ship_count; s++) {
            struct Ship* ship = &global_sim->ships[s];
            
            // Calculate average sail openness and fiber efficiency across all masts
            float total_openness = 0.0f;
            float total_wind_eff = 0.0f;
            int mast_count = 0;
            for (uint8_t m = 0; m < ship->module_count; m++) {
                if (ship->modules[m].type_id == MODULE_TYPE_MAST) {
                    total_openness += ship->modules[m].data.mast.openness;
                    total_wind_eff += Q16_TO_FLOAT(ship->modules[m].data.mast.wind_efficiency);
                    mast_count++;
                }
            }
            float avg_sail_openness = (mast_count > 0) ? (total_openness / mast_count) : 0.0f;
            // avg_wind_efficiency: 1.0 = pristine fibers, 0.0 = fully destroyed
            float avg_wind_efficiency = (mast_count > 0) ? (total_wind_eff / mast_count) : 1.0f;
            
            // Calculate forward force from wind and sails:
            // wind_power * sail_openness% * fiber_efficiency
            const float BASE_WIND_SPEED = 75.0f; // meters per second at full wind, full sails (3x sail force increase)
            float wind_force_factor = (global_sim->wind_power * avg_sail_openness / 100.0f) * avg_wind_efficiency;
            float target_speed = BASE_WIND_SPEED * wind_force_factor;
            
            // Get current ship speed (magnitude of velocity)
            float vx = Q16_TO_FLOAT(ship->velocity.x);
            float vy = Q16_TO_FLOAT(ship->velocity.y);
            float current_speed = sqrtf(vx * vx + vy * vy);
            
            // Apply forward force in ship's facing direction
            float ship_rot = Q16_TO_FLOAT(ship->rotation);
            float target_vx = cosf(ship_rot) * target_speed;
            float target_vy = sinf(ship_rot) * target_speed;
            
            // Debug logging every 2 seconds
            if (current_time - last_movement_log > 2000 && avg_sail_openness > 0) {
                log_info("⛵ Ship %u: masts=%d, avg_openness=%.1f%%, wind_eff=%.2f, wind=%.2f, target_speed=%.2f m/s, current_speed=%.2f m/s, pos=(%.1f,%.1f)",
                         ship->id, mast_count, avg_sail_openness, avg_wind_efficiency, global_sim->wind_power, target_speed, current_speed,
                         SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.x)), SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.y)));
                last_movement_log = current_time;
            }
            
            // Smoothly accelerate toward target velocity
            // Using exponential smoothing: vel += (target - vel) * blend_factor
            // Higher blend factor = faster acceleration (1.0 = instant, 0.0 = no change)
            const float WIND_ACCEL_RATE = 2.0f; // How many seconds to reach 63% of target speed
            float blend_factor = 1.0f - expf(-dt / WIND_ACCEL_RATE);
            
            vx += (target_vx - vx) * blend_factor;
            vy += (target_vy - vy) * blend_factor;

            /* ===== REVERSE THRUST (S key) =====
             * When the helmsman holds S, override the wind target with a slow
             * backward velocity — 15% of BASE_WIND_SPEED in the stern direction.
             * Uses a faster blend (0.8s) so the ship brakes and reverses quickly. */
            {
                SimpleShip* ws_ship = find_ship(ship->id);
                if (ws_ship && ws_ship->reverse_thrust) {
                    const float REVERSE_SPEED    = BASE_WIND_SPEED * 0.0375f;
                    const float REVERSE_ACCEL    = 0.8f; /* time-constant in seconds */
                    float rev_blen = 1.0f - expf(-dt / REVERSE_ACCEL);
                    float rev_vx = -cosf(ship_rot) * REVERSE_SPEED;
                    float rev_vy = -sinf(ship_rot) * REVERSE_SPEED;
                    vx += (rev_vx - vx) * rev_blen;
                    vy += (rev_vy - vy) * rev_blen;
                }
            }

            ship->velocity.x = Q16_FROM_FLOAT(vx);
            ship->velocity.y = Q16_FROM_FLOAT(vy);
            
            // Recalculate current speed after velocity update (for turning calculation)
            current_speed = sqrtf(vx * vx + vy * vy);
            
            // ===== APPLY RUDDER-BASED TURNING =====
            // Turning effectiveness depends on ship speed
            float speed_factor = current_speed / BASE_WIND_SPEED; // 0 = stopped, 1 = full speed
            if (speed_factor < 0.01f) {
                // Ship is stopped - can still turn slowly in place
                speed_factor = 0.05f; // Minimum turning ability when stopped
            }
            
            // Convert rudder angle to turning rate
            // Max rudder (50°) at full speed = max turn rate
            const float MAX_TURN_RATE = 2.0f; // radians per second at full speed
            float rudder_factor = ship->rudder_angle / 50.0f; // -1 to +1
            float turn_rate = rudder_factor * MAX_TURN_RATE * speed_factor;
            
            // Set angular velocity — sim_step / update_ship_physics will integrate
            // rotation and position each tick.  Do NOT integrate here; doing so
            // would double-count every tick (websocket block + sim_step both advance
            // position/rotation by v*dt, shipping the ship 2× the intended distance).
            ship->angular_velocity = Q16_FROM_FLOAT(turn_rate);
        }
    }

    /* Push non-scaffolded ships out of dock U-walls.
     * Must run HERE — after the rudder/wind block sets angular_velocity —
     * so the dock constraint is the last thing to write angular_velocity
     * before sim_step integrates it into position. */
    handle_ship_dock_collisions();

    // Tick processing complete
}