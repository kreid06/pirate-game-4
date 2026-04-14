#include "sim/simulation.h"
#include "sim/module_types.h"
#include "sim/ship_level.h"
#include "sim/island.h"
#include "net/protocol.h"
#include "core/hash.h"
#include "core/math.h"
#include "util/log.h"
#include <string.h>
#include <assert.h>
#include <math.h>

// Include hash function implementation
extern uint64_t hash_sim_state(const struct Sim* sim);

/* ══════════════════════════════════════════════════════════════════════════
 *  Contact cache — warm-starting helpers
 * ══════════════════════════════════════════════════════════════════════════ */

static inline uint32_t contact_key(entity_id a, entity_id b) {
    entity_id lo = a < b ? a : b;
    entity_id hi = a < b ? b : a;
    return ((uint32_t)lo << 16) | (uint32_t)hi;
}

/* Look up a pair; returns NULL if not cached. */
struct ContactEntry* contact_cache_find(struct ContactCache* cc, entity_id a, entity_id b) {
    uint32_t k = contact_key(a, b);
    uint32_t idx = k & (CONTACT_CACHE_SIZE - 1);
    for (uint32_t probe = 0; probe < CONTACT_CACHE_SIZE; probe++) {
        uint32_t i = (idx + probe) & (CONTACT_CACHE_SIZE - 1);
        if (cc->entries[i].key == k) return &cc->entries[i];
        if (cc->entries[i].key == 0) return NULL;  /* empty → miss */
    }
    return NULL;
}

/* Insert or update a pair's entry; returns the slot (never NULL). */
struct ContactEntry* contact_cache_upsert(struct ContactCache* cc, entity_id a, entity_id b) {
    uint32_t k = contact_key(a, b);
    uint32_t idx = k & (CONTACT_CACHE_SIZE - 1);
    struct ContactEntry* first_empty = NULL;
    for (uint32_t probe = 0; probe < CONTACT_CACHE_SIZE; probe++) {
        uint32_t i = (idx + probe) & (CONTACT_CACHE_SIZE - 1);
        if (cc->entries[i].key == k) return &cc->entries[i];  /* existing */
        if (cc->entries[i].key == 0) {
            if (!first_empty) first_empty = &cc->entries[i];
            break;
        }
    }
    if (first_empty) {
        memset(first_empty, 0, sizeof(*first_empty));
        first_empty->key = k;
        return first_empty;
    }
    /* Table full — evict oldest entry at initial slot */
    struct ContactEntry* victim = &cc->entries[idx];
    memset(victim, 0, sizeof(*victim));
    victim->key = k;
    return victim;
}

/* Age out stale entries after all collision handlers have run this tick. */
void contact_cache_age(struct ContactCache* cc, uint32_t current_tick) {
    for (uint32_t i = 0; i < CONTACT_CACHE_SIZE; i++) {
        if (cc->entries[i].key != 0 &&
            current_tick - cc->entries[i].last_tick > MAX_CONTACT_AGE) {
            cc->entries[i].key = 0;  /* mark empty */
        }
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 *  CCD — Continuous Collision Detection helpers
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Swept circle vs. static line segment: given a circle of radius r moving
 * from A to B, find the earliest time-of-impact t ∈ [0,1] with the segment
 * P0-P1.  Returns false if no hit.
 *
 * Used for fast-moving entities (projectiles, ships at high speed) against
 * polygon edges to prevent tunnelling.                                     */

static bool ccd_swept_circle_segment(
    float ax, float ay, float bx, float by, float radius,
    float p0x, float p0y, float p1x, float p1y,
    float* out_t, float* out_nx, float* out_ny)
{
    /* Direction of motion */
    float dx = bx - ax, dy = by - ay;
    float move_len_sq = dx * dx + dy * dy;
    if (move_len_sq < 1e-12f) return false;  /* stationary */

    /* Edge vector and outward normal (left-hand normal for CCW winding) */
    float ex = p1x - p0x, ey = p1y - p0y;
    float edge_len = sqrtf(ex * ex + ey * ey);
    if (edge_len < 1e-6f) return false;
    float enx = -ey / edge_len, eny = ex / edge_len;  /* edge normal */

    /* Signed distance of start/end from the infinite edge line */
    float d0 = (ax - p0x) * enx + (ay - p0y) * eny;
    float d1 = (bx - p0x) * enx + (by - p0y) * eny;

    /* We want d == ±radius (circle surface touches the line).
     * Solve d0 + t*(d1-d0) = ±radius for the face closest to approach. */
    float dd = d1 - d0;
    if (fabsf(dd) < 1e-10f) return false;  /* parallel motion */

    /* Pick the face we're approaching */
    float target_d = (d0 > 0) ? radius : -radius;
    float t = (target_d - d0) / dd;
    if (t < 0.0f || t > 1.0f) return false;  /* out of sweep range */

    /* Contact point on the edge line at time t */
    float cx = ax + dx * t;
    float cy = ay + dy * t;

    /* Project onto edge to check we're within segment bounds */
    float proj = ((cx - p0x) * ex + (cy - p0y) * ey) / (edge_len * edge_len);
    if (proj < 0.0f || proj > 1.0f) {
        /* Missed the segment — check endpoint capsule collisions.
         * Swept circle vs point: |A + t*D - P|² = r² */
        float best_t = 2.0f;
        float best_nx = 0, best_ny = 0;
        for (int ep = 0; ep < 2; ep++) {
            float ppx = ep == 0 ? p0x : p1x;
            float ppy = ep == 0 ? p0y : p1y;
            float ox = ax - ppx, oy = ay - ppy;
            float a_coef = move_len_sq;
            float b_coef = 2.0f * (ox * dx + oy * dy);
            float c_coef = ox * ox + oy * oy - radius * radius;
            float disc = b_coef * b_coef - 4.0f * a_coef * c_coef;
            if (disc < 0.0f) continue;
            float sq = sqrtf(disc);
            float t_ep = (-b_coef - sq) / (2.0f * a_coef);
            if (t_ep >= 0.0f && t_ep <= 1.0f && t_ep < best_t) {
                best_t = t_ep;
                float hx = ax + dx * t_ep - ppx;
                float hy = ay + dy * t_ep - ppy;
                float hl = sqrtf(hx * hx + hy * hy);
                if (hl > 1e-6f) { best_nx = hx / hl; best_ny = hy / hl; }
            }
        }
        if (best_t <= 1.0f) {
            *out_t = best_t; *out_nx = best_nx; *out_ny = best_ny;
            return true;
        }
        return false;
    }

    /* Hit the edge face */
    *out_t = t;
    *out_nx = (d0 > 0) ? enx : -enx;
    *out_ny = (d0 > 0) ? eny : -eny;
    return true;
}

/* Swept circle vs. convex polygon (world-space vertices).
 * Tests against every edge; returns the earliest t ∈ [0,1].
 * out_nx/ny is the collision normal pointing away from the polygon. */
static bool ccd_swept_circle_polygon(
    float ax, float ay, float bx, float by, float radius,
    const float* vx, const float* vy, int n_verts,
    float* out_t, float* out_nx, float* out_ny)
{
    float best_t = 2.0f;
    float best_nx = 0, best_ny = 0;
    for (int i = 0; i < n_verts; i++) {
        int j = (i + 1) % n_verts;
        float t, nx, ny;
        if (ccd_swept_circle_segment(ax, ay, bx, by, radius,
                                     vx[i], vy[i], vx[j], vy[j],
                                     &t, &nx, &ny)) {
            if (t < best_t) { best_t = t; best_nx = nx; best_ny = ny; }
        }
    }
    if (best_t <= 1.0f) {
        *out_t = best_t; *out_nx = best_nx; *out_ny = best_ny;
        return true;
    }
    return false;
}

/* Swept circle vs. circle (two moving entities).
 * Relative motion: A moves from (ax,ay) to (bx,by), B is static at (sx,sy).
 * Caller should pre-subtract B's motion from A's to handle both moving. */
static bool ccd_swept_circle_circle(
    float ax, float ay, float bx, float by, float ra,
    float sx, float sy, float rb,
    float* out_t, float* out_nx, float* out_ny)
{
    float R = ra + rb;
    float ox = ax - sx, oy = ay - sy;
    float dx = bx - ax, dy = by - ay;
    float a = dx * dx + dy * dy;
    if (a < 1e-12f) return false;
    float b = 2.0f * (ox * dx + oy * dy);
    float c = ox * ox + oy * oy - R * R;
    if (c < 0.0f) { /* already overlapping — t=0 */
        float len = sqrtf(ox * ox + oy * oy);
        if (len < 1e-6f) { *out_t = 0; *out_nx = 1; *out_ny = 0; return true; }
        *out_t = 0; *out_nx = ox / len; *out_ny = oy / len; return true;
    }
    float disc = b * b - 4.0f * a * c;
    if (disc < 0.0f) return false;
    float sq = sqrtf(disc);
    float t = (-b - sq) / (2.0f * a);
    if (t < 0.0f || t > 1.0f) return false;
    float hx = ox + dx * t, hy = oy + dy * t;
    float hl = sqrtf(hx * hx + hy * hy);
    if (hl < 1e-6f) { *out_t = t; *out_nx = 1; *out_ny = 0; return true; }
    *out_t = t; *out_nx = hx / hl; *out_ny = hy / hl;
    return true;
}

// Forward declarations
static void update_ship_physics(struct Ship* ship, q16_t dt);
static void update_player_physics(struct Player* player, struct Sim* sim, q16_t dt);
static void update_projectile_physics(struct Projectile* projectile, q16_t dt);
static void handle_ship_collisions(struct Sim* sim);
static void handle_player_player_collisions(struct Sim* sim);
static entity_id allocate_entity_id(struct Sim* sim);
static Vec2Q16 transform_hull_vertex(Vec2Q16 local_vertex, Vec2Q16 position, q16_t rotation);

/**
 * Allocate a new unique entity ID
 */
static entity_id allocate_entity_id(struct Sim* sim) {
    (void)sim; // Mark as intentionally unused
    static entity_id next_id = 1;
    
    // Simple sequential allocation
    // TODO: Add recycling for production use
    entity_id id = next_id++;
    
    // Avoid overflow (entity_id is uint16_t)
    if (next_id == 0) next_id = 1;
    
    return id;
}

int sim_init(struct Sim* sim, const struct SimConfig* config) {
    if (!sim || !config) {
        log_error("Invalid simulation or config parameters");
        return -1;
    }
    
    // Clear all state
    memset(sim, 0, sizeof(struct Sim));
    
    // Initialize RNG with seed
    rng_seed(&sim->rng, config->random_seed);
    
    // Set physics constants
    sim->water_friction = config->water_friction;
    sim->air_friction = config->air_friction;
    sim->buoyancy_factor = config->buoyancy_factor;
    
    // Initialize global wind (default moderate wind)
    sim->wind_power = 0.5f;      // 50% wind power
    sim->wind_direction = 0.0f;  // East direction (for future use)
    
    // Initialize entity counts
    sim->ship_count = 0;
    sim->player_count = 0;
    sim->projectile_count = 0;
    
    // Initialize spatial hash
    memset(sim->spatial_hash, 0, sizeof(sim->spatial_hash));
    
    log_info("Simulation initialized with seed %u", config->random_seed);
    return 0;
}

void sim_cleanup(struct Sim* sim) {
    if (!sim) return;
    
    log_info("📋 Starting simulation cleanup...");
    
    // Log final simulation state
    log_info("Final simulation state:");
    log_info("  Tick: %u", sim->tick);
    log_info("  Ships: %u", sim->ship_count);
    log_info("  Players: %u", sim->player_count);  
    log_info("  Projectiles: %u", sim->projectile_count);
    
    // Reset all counts and state
    memset(sim, 0, sizeof(struct Sim));
    
    log_info("✅ Simulation cleanup complete");
}

void sim_step(struct Sim* sim, q16_t dt) {
    if (!sim) return;

    // Clear hit events from the previous tick before any subsystem runs
    sim->hit_event_count = 0;
    
    // Increment simulation tick
    sim->tick++;
    sim->time_ms += Q16_TO_INT(dt);
    
    // Update all subsystems in deterministic order
    sim_update_ships(sim, dt);
    sim_update_players(sim, dt);
    sim_update_projectiles(sim, dt);
    
    // Handle collisions
    sim_handle_collisions(sim);
    
    // Update spatial acceleration structures
    sim_update_spatial_hash(sim);
}

void sim_update_ships(struct Sim* sim, q16_t dt) {
    // Sort ships by ID to ensure deterministic order
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        for (uint16_t j = i + 1; j < sim->ship_count; j++) {
            if (sim->ships[i].id > sim->ships[j].id) {
                struct Ship temp = sim->ships[i];
                sim->ships[i] = sim->ships[j];
                sim->ships[j] = temp;
            }
        }
    }

    float dt_secs = Q16_TO_FLOAT(dt);

    // Update each ship's physics and sinking
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        struct Ship* ship = &sim->ships[i];
        update_ship_physics(ship, dt);

        /* Shallow-water drag — extra friction when ship hull centre is in
         * the shallow-water ring around any island.  Applied AFTER the base
         * friction inside update_ship_physics so it multiplies on top.     */
        {
            float ship_cx = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.x));
            float ship_cy = SERVER_TO_CLIENT(Q16_TO_FLOAT(ship->position.y));
            for (int ii = 0; ii < ISLAND_COUNT; ii++) {
                if (island_in_shallow_water(&ISLAND_PRESETS[ii], ship_cx, ship_cy)) {
                    const q16_t shallow_drag = Q16_FROM_FLOAT(0.90f);
                    ship->velocity = vec2_mul_scalar(ship->velocity, shallow_drag);
                    ship->angular_velocity = q16_mul(ship->angular_velocity, shallow_drag);
                    break;
                }
            }
        }

        // Update per-module state (reload timers, etc.)
        for (uint8_t m = 0; m < ship->module_count; m++) {
            module_update(&ship->modules[m], dt);
        }

        // ---- Sinking / water mechanic ----
        // Ships scaffolded in a shipyard are immune to plank-drain sinking
        if (ship->flags & SHIP_FLAG_SCAFFOLDED) {
            // Keep hull_health at 100 while scaffolded
            ship->hull_health = Q16_FROM_INT(100);
            continue;  // skip entire drain/heal block for this ship
        }
        // Count remaining planks and detect leaks (< 30% HP).
        // Leaking planks do NOT self-damage — they stay at their current HP but
        // contribute to the hull drain rate at half the missing-plank rate.
        int planks_remaining = 0;
        int planks_leaking = 0;

        for (uint8_t m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_PLANK) continue;
            if (mod->health <= 0) continue; // already destroyed elsewhere

            bool is_leaking = (mod->health < mod->max_health * 30 / 100);

            if (is_leaking) {
                planks_leaking++;
            }
            planks_remaining++;

            // Passive healing at 2.5%/s — only while repair has been initiated
            if ((mod->state_bits & MODULE_STATE_REPAIRING) &&
                mod->health < (int32_t)mod->max_health) {
                float heal = (float)mod->max_health * 0.025f * dt_secs;
                mod->health += (int32_t)heal;
                if (mod->health >= (int32_t)mod->max_health) {
                    mod->health = (int32_t)mod->max_health;
                    mod->state_bits &= (uint16_t)~MODULE_STATE_REPAIRING;
                }
            }
        }

        // Passive healing for deck at same 2.5%/s rate
        for (uint8_t m = 0; m < ship->module_count; m++) {
            ShipModule* mod = &ship->modules[m];
            if (mod->type_id != MODULE_TYPE_DECK) continue;
            if (mod->health <= 0 || mod->health >= (int32_t)mod->max_health) continue;
            if (!(mod->state_bits & MODULE_STATE_REPAIRING)) continue;
            float heal = (float)mod->max_health * 0.025f * dt_secs;
            mod->health += (int32_t)heal;
            if (mod->health >= (int32_t)mod->max_health) {
                mod->health = (int32_t)mod->max_health;
                mod->state_bits &= (uint16_t)~MODULE_STATE_REPAIRING;
                mod->state_bits &= (uint16_t)~MODULE_STATE_DAMAGED;
            }
        }

        int missing = (int)ship->initial_plank_count - planks_remaining;

        /* Ghost ships store hull_health as a raw int32 (0–60000), not Q16-encoded.
         * Heal 100/s while alive; do nothing once already at 0 (dead). */
        if (ship->company_id == 99) {
            if (ship->hull_health > 0) {
                int32_t healed = ship->hull_health + (int32_t)(100.0f * dt_secs);
                ship->hull_health = (healed > 60000) ? 60000 : healed;
            }
            /* Skip the normal plank-drain logic entirely for ghost ships. */
        } else if (missing == 0 && planks_leaking == 0) {
            // Full integrity: crew bails water — hull_health rises at 1 HP/s (capped at 100)
            float health = Q16_TO_FLOAT(ship->hull_health) + 1.0f * dt_secs;
            if (health > 100.0f) health = 100.0f;
            ship->hull_health = Q16_FROM_FLOAT(health);
        } else {
            // Hull is compromised — compute drain rate
            float drain_rate = 0.0f;

            // Missing planks: exponential drain (1/1.2) * 2^(missing-1)
            if (missing > 0) {
                int shift = missing - 1;
                if (shift > 15) shift = 15;
                drain_rate += (1.0f / 1.2f) * (float)(1 << shift);
            }

            // Each leaking plank contributes half the single-missing-plank base rate
            drain_rate += 0.5f * (1.0f / 1.2f) * (float)planks_leaking;

            float drain = drain_rate * ship_level_sturdiness_mult(&ship->level_stats) * dt_secs;
            float health = Q16_TO_FLOAT(ship->hull_health) - drain;
            if (health <= 0.0f) {
                health = 0.0f;
                // Fire SHIP_SINK event (once, when health first hits 0)
                if (ship->hull_health > 0 && sim->hit_event_count < MAX_HIT_EVENTS) {
                    struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                    ev->ship_id   = ship->id;
                    ev->module_id = 0;
                    ev->is_breach = false;
                    ev->is_sink   = true;
                    ev->hit_x     = Q16_TO_FLOAT(ship->position.x);
                    ev->hit_y     = Q16_TO_FLOAT(ship->position.y);
                }
            }
            ship->hull_health = Q16_FROM_FLOAT(health);
        }
    }
}

void sim_update_players(struct Sim* sim, q16_t dt) {
    // Sort players by ID for deterministic order
    for (uint16_t i = 0; i < sim->player_count; i++) {
        for (uint16_t j = i + 1; j < sim->player_count; j++) {
            if (sim->players[i].id > sim->players[j].id) {
                struct Player temp = sim->players[i];
                sim->players[i] = sim->players[j];
                sim->players[j] = temp;
            }
        }
    }
    
    // Periodic player position log disabled — too noisy
    static uint32_t pos_log_count = 0; (void)(pos_log_count++);
    if (false && pos_log_count > 0 && sim->player_count > 0) {
        log_info("📍 Player positions:");
        for (uint16_t i = 0; i < sim->player_count; i++) {
            struct Player* p = &sim->players[i];
            log_info("  P%u: pos(%.2f, %.2f) vel(%.2f, %.2f) radius=%.2f ship_id=%u",
                p->id,
                Q16_TO_FLOAT(p->position.x), Q16_TO_FLOAT(p->position.y),
                Q16_TO_FLOAT(p->velocity.x), Q16_TO_FLOAT(p->velocity.y),
                Q16_TO_FLOAT(p->radius),
                p->ship_id);
        }
    }
    
    // Update each player's physics
    for (uint16_t i = 0; i < sim->player_count; i++) {
        update_player_physics(&sim->players[i], sim, dt);
    }
}

void sim_update_projectiles(struct Sim* sim, q16_t dt) {
    // Sort projectiles by ID for deterministic order
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        for (uint16_t j = i + 1; j < sim->projectile_count; j++) {
            if (sim->projectiles[i].id > sim->projectiles[j].id) {
                struct Projectile temp = sim->projectiles[i];
                sim->projectiles[i] = sim->projectiles[j];
                sim->projectiles[j] = temp;
            }
        }
    }
    
    // Update each projectile's physics and check lifetime
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        struct Projectile* proj = &sim->projectiles[i];
        
        // Rate-based lifetime: 1ms/ms at sea, 2ms/ms over land
        uint32_t dt_ms = (uint32_t)(Q16_TO_FLOAT(dt) * 1000.0f);
        {
            float px_cli = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.x));
            float py_cli = SERVER_TO_CLIENT(Q16_TO_FLOAT(proj->position.y));
            bool over_land = false;
            for (int ii = 0; ii < ISLAND_COUNT && !over_land; ii++) {
                const IslandDef *isl = &ISLAND_PRESETS[ii];
                float dx = px_cli - isl->x, dy = py_cli - isl->y;
                float dist_sq = dx * dx + dy * dy;
                if (isl->vertex_count > 0) {
                    over_land = (dist_sq < isl->poly_bound_r * isl->poly_bound_r)
                             && island_poly_contains(isl, px_cli, py_cli);
                } else {
                    float broad_r = isl->beach_radius_px + isl->beach_max_bump;
                    if (dist_sq < broad_r * broad_r) {
                        float angle = atan2f(dy, dx);
                        float r = island_boundary_r(isl->beach_radius_px, isl->beach_bumps, angle);
                        over_land = (dist_sq < r * r);
                    }
                }
            }
            proj->effective_age_ms += over_land ? dt_ms * 2 : dt_ms;
        }
        uint32_t max_lifetime = (proj->lifetime > 0)
            ? (uint32_t)(Q16_TO_FLOAT(proj->lifetime) * 1000.0f)
            : 4000;
        if (proj->effective_age_ms > max_lifetime) {
            // Remove expired projectile
            log_info("⏱️  Projectile %u expired after %ums effective age (max=%ums) at (%.1f, %.1f)",
                     proj->id, proj->effective_age_ms, max_lifetime,
                     Q16_TO_FLOAT(proj->position.x), Q16_TO_FLOAT(proj->position.y));
            memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                   (sim->projectile_count - i - 1) * sizeof(struct Projectile));
            sim->projectile_count--;
            i--; // Adjust index after removal
            continue;
        }
        
        update_projectile_physics(proj, dt);
    }
}

static void handle_island_collisions(struct Sim *sim) {
    for (int ii = 0; ii < ISLAND_COUNT; ii++) {
        const IslandDef *isl = &ISLAND_PRESETS[ii];

        if (isl->vertex_count > 0) {
            /* ── Polygon island ─────────────────────────────────────────────
             * Vertices are in client-pixel offsets from (isl->x, isl->y).
             * Convert ship hull vertices to client pixels for the polygon
             * test, then convert the resulting push depth back to server
             * units.                                                         */
            float island_cx     = CLIENT_TO_SERVER(isl->x);
            float island_cy     = CLIENT_TO_SERVER(isl->y);
            float poly_broad_sv = CLIENT_TO_SERVER(isl->poly_bound_r);

            for (uint16_t si = 0; si < sim->ship_count; si++) {
                struct Ship *ship = &sim->ships[si];
                float sx  = Q16_TO_FLOAT(ship->position.x);
                float sy  = Q16_TO_FLOAT(ship->position.y);
                float cdx = sx - island_cx, cdy = sy - island_cy;
                float ship_r     = Q16_TO_FLOAT(ship->bounding_radius);
                float broad_min  = poly_broad_sv + ship_r;
                if (cdx*cdx + cdy*cdy >= broad_min*broad_min) continue;

                float max_pen = 0.0f, push_nx = 0.0f, push_ny = 0.0f;
                float cp_wx = 0.0f, cp_wy = 0.0f; /* contact point world (server units) */
                bool  hit     = false;

                for (uint8_t vi = 0; vi < ship->hull_vertex_count; vi++) {
                    Vec2Q16 wv = transform_hull_vertex(ship->hull_vertices[vi],
                                                       ship->position,
                                                       ship->rotation);
                    float wx_cli = SERVER_TO_CLIENT(Q16_TO_FLOAT(wv.x));
                    float wy_cli = SERVER_TO_CLIENT(Q16_TO_FLOAT(wv.y));
                    if (!island_poly_contains(isl, wx_cli, wy_cli)) continue;

                    float nx, ny, depth_cli;
                    if (!island_poly_pushout(isl, wx_cli, wy_cli, &nx, &ny, &depth_cli)) continue;
                    float depth_sv = CLIENT_TO_SERVER(depth_cli);
                    if (depth_sv > max_pen) {
                        max_pen  = depth_sv;
                        push_nx  = nx;
                        push_ny  = ny;
                        cp_wx    = Q16_TO_FLOAT(wv.x);
                        cp_wy    = Q16_TO_FLOAT(wv.y);
                        hit      = true;
                    }
                }
                if (!hit) continue;

                ship->position.x += Q16_FROM_FLOAT(push_nx * max_pen);
                ship->position.y += Q16_FROM_FLOAT(push_ny * max_pen);

                /* Rigid-body impulse with lever arm (island = infinite mass) */
                float vx    = Q16_TO_FLOAT(ship->velocity.x);
                float vy    = Q16_TO_FLOAT(ship->velocity.y);
                float omega = Q16_TO_FLOAT(ship->angular_velocity);
                float rx    = cp_wx - Q16_TO_FLOAT(ship->position.x);
                float ry    = cp_wy - Q16_TO_FLOAT(ship->position.y);
                float vc_x  = vx + omega * (-ry);
                float vc_y  = vy + omega * ( rx);
                float vc_n  = vc_x * push_nx + vc_y * push_ny;
                if (vc_n < 0.0f) {
                    const float restitution = 0.15f;
                    const float isl_friction = 0.75f;
                    float mass_f    = Q16_TO_FLOAT(ship->mass);
                    float inertia_f = Q16_TO_FLOAT(ship->moment_inertia);
                    float inv_m = (mass_f    > 0.0f) ? 1.0f / mass_f    : 0.0f;
                    float inv_I = (inertia_f > 0.0f) ? 1.0f / inertia_f : 0.0f;

                    /* Normal impulse */
                    float rxn   = rx * push_ny - ry * push_nx;
                    float denom = inv_m + rxn * rxn * inv_I;
                    if (denom > 1e-10f) {
                        float Jn = -(1.0f + restitution) * vc_n / denom;
                        if (Jn < 0.0f) Jn = 0.0f;
                        vx    += Jn * push_nx * inv_m;
                        vy    += Jn * push_ny * inv_m;
                        omega += rxn * Jn * inv_I;

                        /* Friction impulse (Coulomb) */
                        float vc_x2 = vx + omega * (-ry);
                        float vc_y2 = vy + omega * ( rx);
                        float vc_n2 = vc_x2 * push_nx + vc_y2 * push_ny;
                        float vt_x  = vc_x2 - vc_n2 * push_nx;
                        float vt_y  = vc_y2 - vc_n2 * push_ny;
                        float vt_len = sqrtf(vt_x * vt_x + vt_y * vt_y);
                        if (vt_len > 0.001f) {
                            float tx = vt_x / vt_len, ty = vt_y / vt_len;
                            float rxt    = rx * ty - ry * tx;
                            float denom_t = inv_m + rxt * rxt * inv_I;
                            if (denom_t > 1e-10f) {
                                float Jf = -vt_len / denom_t;
                                float Jf_max = isl_friction * Jn;
                                if (Jf < -Jf_max) Jf = -Jf_max;
                                if (Jf >  Jf_max) Jf =  Jf_max;
                                vx    += Jf * tx * inv_m;
                                vy    += Jf * ty * inv_m;
                                omega += rxt * Jf * inv_I;
                            }
                        }
                    }
                    ship->velocity.x = Q16_FROM_FLOAT(vx);
                    ship->velocity.y = Q16_FROM_FLOAT(vy);
                    ship->angular_velocity = Q16_FROM_FLOAT(omega);
                }
            }
            continue;  /* done with this polygon island */
        }

        /* ── Bump-circle island ─────────────────────────────────────────────── */
        float island_cx = CLIENT_TO_SERVER(isl->x);
        float island_cy = CLIENT_TO_SERVER(isl->y);
        /* Broad-phase radius: island beach + max bump, per-ship bounding radius added below */
        float broad_r = CLIENT_TO_SERVER(isl->beach_radius_px + isl->beach_max_bump);

        for (uint16_t si = 0; si < sim->ship_count; si++) {
            struct Ship *ship = &sim->ships[si];
            float sx = Q16_TO_FLOAT(ship->position.x);
            float sy = Q16_TO_FLOAT(ship->position.y);
            float cdx = sx - island_cx;
            float cdy = sy - island_cy;
            float dist_sq = cdx * cdx + cdy * cdy;

            /* ── Broad phase: same bounding_radius as ship-ship ─────────── */
            float ship_r = Q16_TO_FLOAT(ship->bounding_radius);
            float broad_min = broad_r + ship_r;
            if (dist_sq >= broad_min * broad_min || dist_sq < 0.0001f) continue;

            /* ── Narrow phase: test each hull vertex against the island ──── *
             * Mirrors ship-ship: transform_hull_vertex() brings each vertex  *
             * into world space using the ship's actual rotation, then we      *
             * compare it against the bumpy island boundary at that angle.     */
            float max_penetration = 0.0f;
            float push_nx = 0.0f, push_ny = 0.0f;
            float cp_wx = 0.0f, cp_wy = 0.0f; /* contact point world (server units) */
            bool  hit = false;

            for (uint8_t vi = 0; vi < ship->hull_vertex_count; vi++) {
                Vec2Q16 wv = transform_hull_vertex(ship->hull_vertices[vi],
                                                   ship->position,
                                                   ship->rotation);
                float wx = Q16_TO_FLOAT(wv.x);
                float wy = Q16_TO_FLOAT(wv.y);

                float vdx = wx - island_cx;
                float vdy = wy - island_cy;
                float vdist = sqrtf(vdx * vdx + vdy * vdy);
                if (vdist < 0.0001f) continue;

                float angle    = atan2f(vdy, vdx);
                float island_r = CLIENT_TO_SERVER(
                    island_boundary_r(isl->beach_radius_px, isl->beach_bumps, angle));

                /* positive penetration → vertex is inside the island */
                float penetration = island_r - vdist;
                if (penetration > 0.0f && penetration > max_penetration) {
                    max_penetration = penetration;
                    /* push direction: outward from island at this vertex */
                    push_nx = vdx / vdist;
                    push_ny = vdy / vdist;
                    cp_wx   = wx;
                    cp_wy   = wy;
                    hit = true;
                }
            }

            if (!hit) continue;

            /* Push ship so the deepest vertex exits the island boundary */
            ship->position.x += Q16_FROM_FLOAT(push_nx * max_penetration);
            ship->position.y += Q16_FROM_FLOAT(push_ny * max_penetration);

            /* Rigid-body impulse with lever arm (island = infinite mass) */
            float vx    = Q16_TO_FLOAT(ship->velocity.x);
            float vy    = Q16_TO_FLOAT(ship->velocity.y);
            float omega = Q16_TO_FLOAT(ship->angular_velocity);
            float rx    = cp_wx - Q16_TO_FLOAT(ship->position.x);
            float ry    = cp_wy - Q16_TO_FLOAT(ship->position.y);
            float vc_x  = vx + omega * (-ry);
            float vc_y  = vy + omega * ( rx);
            float vc_n  = vc_x * push_nx + vc_y * push_ny;
            if (vc_n < 0.0f) {
                const float restitution = 0.15f;
                const float isl_friction = 0.75f;
                float mass_f    = Q16_TO_FLOAT(ship->mass);
                float inertia_f = Q16_TO_FLOAT(ship->moment_inertia);
                float inv_m = (mass_f    > 0.0f) ? 1.0f / mass_f    : 0.0f;
                float inv_I = (inertia_f > 0.0f) ? 1.0f / inertia_f : 0.0f;

                /* Normal impulse */
                float rxn   = rx * push_ny - ry * push_nx;
                float denom = inv_m + rxn * rxn * inv_I;
                if (denom > 1e-10f) {
                    float Jn = -(1.0f + restitution) * vc_n / denom;
                    if (Jn < 0.0f) Jn = 0.0f;
                    vx    += Jn * push_nx * inv_m;
                    vy    += Jn * push_ny * inv_m;
                    omega += rxn * Jn * inv_I;

                    /* Friction impulse (Coulomb) */
                    float vc_x2 = vx + omega * (-ry);
                    float vc_y2 = vy + omega * ( rx);
                    float vc_n2 = vc_x2 * push_nx + vc_y2 * push_ny;
                    float vt_x  = vc_x2 - vc_n2 * push_nx;
                    float vt_y  = vc_y2 - vc_n2 * push_ny;
                    float vt_len = sqrtf(vt_x * vt_x + vt_y * vt_y);
                    if (vt_len > 0.001f) {
                        float tx = vt_x / vt_len, ty = vt_y / vt_len;
                        float rxt    = rx * ty - ry * tx;
                        float denom_t = inv_m + rxt * rxt * inv_I;
                        if (denom_t > 1e-10f) {
                            float Jf = -vt_len / denom_t;
                            float Jf_max = isl_friction * Jn;
                            if (Jf < -Jf_max) Jf = -Jf_max;
                            if (Jf >  Jf_max) Jf =  Jf_max;
                            vx    += Jf * tx * inv_m;
                            vy    += Jf * ty * inv_m;
                            omega += rxt * Jf * inv_I;
                        }
                    }
                }
                ship->velocity.x = Q16_FROM_FLOAT(vx);
                ship->velocity.y = Q16_FROM_FLOAT(vy);
                ship->angular_velocity = Q16_FROM_FLOAT(omega);
            }
        }
    }
}

void sim_handle_collisions(struct Sim* sim) {
    /* ── CCD pre-pass: prevent tunnelling for fast-moving entities ──────
     *
     * For every ship moving faster than CCD_SPEED_THRESHOLD (server units/tick),
     * sweep its bounding circle forward along this tick's displacement and test
     * against every other ship's hull polygon.  If a time-of-impact t ∈ [0,1)
     * is found, rewind the ship to position(t) and reflect velocity.
     *
     * Same logic is applied to swimming players vs ship hulls.
     *
     * This runs BEFORE the discrete collision handlers so the discrete phase
     * sees the already-rewound positions and can fine-tune with SAT + impulse. */
    {
        /* Speed threshold: only bother with CCD if the entity moves more than
         * half its bounding radius this tick — below that, discrete is fine. */
        static const float CCD_MIN_DISP_SQ = 0.5f * 0.5f;  /* server units² */

        /* ── Ship vs Ship CCD ── */
        for (uint16_t i = 0; i < sim->ship_count; i++) {
            struct Ship* s = &sim->ships[i];
            float dt_f = Q16_TO_FLOAT(FIXED_DT_Q16);
            float s_vx = Q16_TO_FLOAT(s->velocity.x);
            float s_vy = Q16_TO_FLOAT(s->velocity.y);
            float disp_x = s_vx * dt_f, disp_y = s_vy * dt_f;
            if (disp_x * disp_x + disp_y * disp_y < CCD_MIN_DISP_SQ) continue;

            float sx = Q16_TO_FLOAT(s->position.x);
            float sy = Q16_TO_FLOAT(s->position.y);
            float sr = Q16_TO_FLOAT(s->bounding_radius);
            /* Sweep end-point = current pos (already integrated by update_ship_physics).
             * Start = pos - displacement. */
            float ax = sx - disp_x, ay = sy - disp_y;

            for (uint16_t j = 0; j < sim->ship_count; j++) {
                if (i == j) continue;
                struct Ship* other = &sim->ships[j];

                /* Quick bounding-circle distance check for the sweep */
                float or2 = Q16_TO_FLOAT(other->bounding_radius);
                float odx = Q16_TO_FLOAT(other->position.x) - (ax + sx) * 0.5f;
                float ody = Q16_TO_FLOAT(other->position.y) - (ay + sy) * 0.5f;
                float sweep_r = sr + or2 + sqrtf(disp_x*disp_x + disp_y*disp_y) * 0.5f;
                if (odx*odx + ody*ody > sweep_r*sweep_r) continue;

                /* Build other ship's world-space hull */
                float hvx[64], hvy[64];
                int nv = (int)other->hull_vertex_count;
                for (int vi = 0; vi < nv; vi++) {
                    Vec2Q16 wv = transform_hull_vertex(other->hull_vertices[vi],
                                                       other->position, other->rotation);
                    hvx[vi] = Q16_TO_FLOAT(wv.x);
                    hvy[vi] = Q16_TO_FLOAT(wv.y);
                }

                float t, cnx, cny;
                if (ccd_swept_circle_polygon(ax, ay, sx, sy, sr, hvx, hvy, nv,
                                             &t, &cnx, &cny)) {
                    /* Rewind to time-of-impact + small epsilon */
                    float safe_t = fmaxf(t - 0.01f, 0.0f);
                    float new_x = ax + disp_x * safe_t;
                    float new_y = ay + disp_y * safe_t;
                    s->position.x = Q16_FROM_FLOAT(new_x);
                    s->position.y = Q16_FROM_FLOAT(new_y);

                    /* Reflect velocity along collision normal (e = 0.3) */
                    float vn = s_vx * cnx + s_vy * cny;
                    if (vn < 0.0f) {
                        s->velocity.x = Q16_FROM_FLOAT(s_vx - 1.3f * vn * cnx);
                        s->velocity.y = Q16_FROM_FLOAT(s_vy - 1.3f * vn * cny);
                    }
                    break;  /* one CCD hit per ship per tick is enough */
                }
            }
        }

        /* ── Player vs Ship hull CCD (swimming players only) ── */
        for (uint16_t pi = 0; pi < sim->player_count; pi++) {
            struct Player* p = &sim->players[pi];
            if (p->ship_id != INVALID_ENTITY_ID) continue;  /* on a ship — skip */

            float dt_f = Q16_TO_FLOAT(FIXED_DT_Q16);
            float pvx = Q16_TO_FLOAT(p->velocity.x);
            float pvy = Q16_TO_FLOAT(p->velocity.y);
            float dx = pvx * dt_f, dy = pvy * dt_f;
            if (dx*dx + dy*dy < CCD_MIN_DISP_SQ) continue;

            float px = Q16_TO_FLOAT(p->position.x);
            float py = Q16_TO_FLOAT(p->position.y);
            float pr = Q16_TO_FLOAT(p->radius);
            float pax = px - dx, pay = py - dy;

            for (uint16_t si = 0; si < sim->ship_count; si++) {
                struct Ship* ship = &sim->ships[si];
                float br = Q16_TO_FLOAT(ship->bounding_radius);
                float sdx = Q16_TO_FLOAT(ship->position.x) - (pax + px) * 0.5f;
                float sdy = Q16_TO_FLOAT(ship->position.y) - (pay + py) * 0.5f;
                float sweep_r = pr + br + sqrtf(dx*dx + dy*dy) * 0.5f;
                if (sdx*sdx + sdy*sdy > sweep_r*sweep_r) continue;

                float hvx[64], hvy[64];
                int nv = (int)ship->hull_vertex_count;
                for (int vi = 0; vi < nv; vi++) {
                    Vec2Q16 wv = transform_hull_vertex(ship->hull_vertices[vi],
                                                       ship->position, ship->rotation);
                    hvx[vi] = Q16_TO_FLOAT(wv.x);
                    hvy[vi] = Q16_TO_FLOAT(wv.y);
                }

                float t, cnx, cny;
                if (ccd_swept_circle_polygon(pax, pay, px, py, pr, hvx, hvy, nv,
                                             &t, &cnx, &cny)) {
                    float safe_t = fmaxf(t - 0.01f, 0.0f);
                    p->position.x = Q16_FROM_FLOAT(pax + dx * safe_t);
                    p->position.y = Q16_FROM_FLOAT(pay + dy * safe_t);
                    float vn = pvx * cnx + pvy * cny;
                    if (vn < 0.0f) {
                        p->velocity.x = Q16_FROM_FLOAT(pvx - 1.15f * vn * cnx);
                        p->velocity.y = Q16_FROM_FLOAT(pvy - 1.15f * vn * cny);
                    }
                    break;
                }
            }
        }
    }

    // Handle ship-to-ship collisions
    handle_ship_collisions(sim);
    
    // Handle ship-to-island collisions
    handle_island_collisions(sim);
    
    // Handle player-to-player collisions
    handle_player_player_collisions(sim);
    
    // Handle projectile collisions with ships and players
    handle_projectile_collisions(sim);
    
    // Handle player-ship collisions (boarding, falling off)
    handle_player_ship_collisions(sim);

    /* Age out stale contact cache entries that weren't touched this tick */
    contact_cache_age(&sim->contact_cache, sim->tick);
}

// Entity creation functions
entity_id sim_create_ship(struct Sim* sim, Vec2Q16 position, q16_t rotation, uint8_t modules_placed) {
    if (!sim || sim->ship_count >= MAX_SHIPS) {
        return INVALID_ENTITY_ID;
    }
    
    entity_id id = allocate_entity_id(sim);
    if (id == INVALID_ENTITY_ID) return id;
    
    struct Ship* ship = &sim->ships[sim->ship_count];
    memset(ship, 0, sizeof(struct Ship));
    
    ship->id = id;
    ship->position = position;
    ship->rotation = rotation;
    ship->velocity = VEC2_ZERO;
    ship->angular_velocity = 0;
    ship->mass = Q16_FROM_FLOAT(1000.0f); // 1000 kg default
    ship->moment_inertia = Q16_FROM_FLOAT(50000.0f); // kg⋅m²
    ship->bounding_radius = Q16_FROM_FLOAT(10.0f); // 10m radius
    ship->hull_health = Q16_FROM_INT(100);
    ship->desired_sail_openness = 0;  // Sails start closed
    ship->rudder_angle = 0.0f;        // Rudder centered
    ship->target_rudder_angle = 0.0f; // No input

    ship_level_init(&ship->level_stats);
    
    // Create brigantine hull with curved bow/stern sections (47 vertices)
    // Matches client-side createCurvedShipHull() from ShipUtils.ts
    // Hull points (in client pixels): bow(190,90), bowTip(415,0), bowBottom(190,-90),
    //                                  sternBottom(-260,-90), sternTip(-345,0), stern(-260,90)
    // Scaled down by WORLD_SCALE_FACTOR for server Q16 stability
    ship->hull_vertex_count = 47;
    int idx = 0;
    
    // Curved bow section (port side: bow -> bowTip -> bowBottom) - 13 points
    for (int i = 0; i <= 12; i++) {
        float t = (float)i / 12.0f;
        // Quadratic bezier: P(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
        float x = (1-t)*(1-t)*190.0f + 2*(1-t)*t*415.0f + t*t*190.0f;
        float y = (1-t)*(1-t)*90.0f + 2*(1-t)*t*0.0f + t*t*(-90.0f);
        // Minimal expansion for bow curve (1.02x) to match side thickness
        x *= 1.02f;
        y *= 1.1f;  // Keep Y expansion for width consistency
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Straight starboard side (bowBottom -> sternBottom) - 12 points
    for (int i = 1; i <= 12; i++) {
        float t = (float)i / 12.0f;
        float x = 190.0f + t * (-260.0f - 190.0f);
        float y = -90.0f + t * (-90.0f - (-90.0f));
        // Only expand Y (width) for straight sides, keep X (length) unchanged
        // x *= 1.0f;  // No X expansion
        y *= 1.1f;  // Width expansion
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Curved stern section (sternBottom -> sternTip -> stern) - 12 points
    for (int i = 1; i <= 12; i++) {
        float t = (float)i / 12.0f;
        float x = (1-t)*(1-t)*(-260.0f) + 2*(1-t)*t*(-345.0f) + t*t*(-260.0f);
        float y = (1-t)*(1-t)*(-90.0f) + 2*(1-t)*t*0.0f + t*t*90.0f;
        // Minimal expansion for stern curve (1.02x) to match side thickness
        x *= 1.02f;
        y *= 1.1f;  // Keep Y expansion for width consistency
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Straight port side (stern -> bow) - 11 points (excluding last to avoid duplication)
    for (int i = 1; i < 12; i++) {
        float t = (float)i / 12.0f;
        float x = -260.0f + t * (190.0f - (-260.0f));
        float y = 90.0f + t * (90.0f - 90.0f);
        // Only expand Y (width) for straight sides, keep X (length) unchanged
        // x *= 1.0f;  // No X expansion
        y *= 1.1f;  // Width expansion
        ship->hull_vertices[idx++] = (Vec2Q16){
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(x)), 
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(y))
        };
    }
    
    // Calculate bounding radius from actual hull extent
    // Hull base extends from -345 to 415 in x (client), -90 to 90 in y (client)
    // After scaling: bow/stern 1.02x X, all 1.1x Y → max ~423 x, 99 y
    // Max distance from center is sqrt(423^2 + 99^2) ≈ 434.5 client units = 43.45 server units
    ship->bounding_radius = Q16_FROM_FLOAT(CLIENT_TO_SERVER(435.0f)); // Conservative bounding radius
    
    // Initialize BROADSIDE loadout modules
    // Matches BrigantineLoadouts.BROADSIDE from BrigantineTestBuilder.ts
    // Module IDs are based on ship entity ID so two ships have distinct IDs
    // (ship 1 → 1000-1010, ship 2 → 2000-2010, etc.)
    ship->module_count = 0;
    
    /* Bare skeleton — hull polygon only, no modules at all.
     * initial_plank_count stays 0 so the drain formula sees missing=0. */
    if (modules_placed == 0) {
        ship->initial_plank_count = 0;
        log_info("⚓ Created skeleton ship %u with 0 modules (bare hull)", id);
        sim->ship_count++;
        return id;
    }

    uint16_t module_id = (uint16_t)(ship->id * 1000);
    
    // Helm
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_HELM,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-90.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    
    // Port side cannons (3) — local_rot = -PI/2 (barrel faces port/left)
    if (modules_placed & MODULE_CANNON_PORT) {
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-35.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(75.0f))},
        Q16_FROM_FLOAT(3.1415927f) // -PI/2: port barrel faces left
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(65.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(75.0f))},
        Q16_FROM_FLOAT(3.1415927f)
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-135.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(75.0f))},
        Q16_FROM_FLOAT(3.1415927f)
    );
    } else { module_id += 3; }
    
    // Starboard side cannons (3) — local_rot = PI/2 (barrel faces starboard/right)
    if (modules_placed & MODULE_CANNON_STBD) {
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-35.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(-75.0f))},
        Q16_FROM_FLOAT(0.0f) // PI/2: starboard barrel faces right
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(65.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(-75.0f))},
        Q16_FROM_FLOAT(0.0f)
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_CANNON,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-135.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(-75.0f))},
        Q16_FROM_FLOAT(0.0f)
    );
    } else { module_id += 3; }
    
    // Three masts (front, middle, back)
    if (modules_placed & MODULE_MAST) {
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_MAST,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(165.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_MAST,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-35.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_MAST,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-235.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    } else { module_id += 3; }
    
    // Add ladder at specified position (-305, 0 in client coords)
    ship->modules[ship->module_count++] = module_create(
        module_id++, MODULE_TYPE_LADDER,
        (Vec2Q16){Q16_FROM_FLOAT(CLIENT_TO_SERVER(-305.0f)), Q16_FROM_FLOAT(CLIENT_TO_SERVER(0.0f))},
        0
    );
    
    // Initialize 10 hull planks with positions matching client hull geometry.
    // Positions are the segment midpoints derived from createCompleteHullSegments()
    // in modules.ts using HULL_POINTS. Order: bow_port, bow_starboard,
    // 3x starboard_side, stern_starboard, stern_port, 3x port_side.
    // All values in client-space coords (divided by WORLD_SCALE_FACTOR to get server units).
    static const float plank_cx[10] = {
         246.25f,  246.25f,   // bow_port, bow_starboard
         115.0f,  -35.0f, -185.0f,  // starboard_side [0-2]
        -281.25f, -281.25f,  // stern_starboard, stern_port
        -185.0f,  -35.0f,   115.0f   // port_side [0-2]
    };
    static const float plank_cy[10] = {
         45.0f,  -45.0f,
        -90.0f,  -90.0f,  -90.0f,
        -45.0f,   45.0f,
         90.0f,   90.0f,   90.0f
    };
    for (int i = 0; i < 10; i++) {
        Vec2Q16 pos = {
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(plank_cx[i])),
            Q16_FROM_FLOAT(CLIENT_TO_SERVER(plank_cy[i]))
        };
        ShipModule plank = module_create(100 + i, MODULE_TYPE_PLANK, pos, 0);
        ship->modules[ship->module_count++] = plank;
    }
    ship->initial_plank_count = 10;
    
    // Deck module (ID 200) - position not used, client generates from hull polygon
    ship->modules[ship->module_count++] = module_create(
        200, MODULE_TYPE_DECK,
        (Vec2Q16){0, 0},
        0
    );
    
    log_info("⚓ Created brigantine ship %u with BROADSIDE loadout: %u modules (6 cannons, 3 masts, 1 helm, 1 ladder, 10 planks, 1 deck)",
             id, ship->module_count);
    
    sim->ship_count++;
    
    log_debug("Created ship %u at (%.2f, %.2f)", id, 
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y));
    
    return id;
}

entity_id sim_create_player(struct Sim* sim, Vec2Q16 position, entity_id ship_id) {
    if (!sim || sim->player_count >= MAX_PLAYERS) {
        return INVALID_ENTITY_ID;
    }
    
    entity_id id = allocate_entity_id(sim);
    if (id == INVALID_ENTITY_ID) return id;
    
    struct Player* player = &sim->players[sim->player_count];
    memset(player, 0, sizeof(struct Player));
    
    player->id = id;
    player->ship_id = ship_id;
    player->position = position;
    player->velocity = VEC2_ZERO;
    player->radius = Q16_FROM_FLOAT(CLIENT_TO_SERVER(8.0f)); // 8 client pixels = 0.8 server units
    player->health = 100;
    
    if (ship_id == 0) {
        player->flags |= PLAYER_FLAG_IN_WATER;
    }
    
    sim->player_count++;
    
    log_debug("Created player %u at (%.2f, %.2f), ship %u", id,
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y), ship_id);
    
    return id;
}

entity_id sim_create_projectile(struct Sim* sim, Vec2Q16 position, Vec2Q16 velocity, entity_id shooter_id, uint8_t proj_type) {
    if (!sim || sim->projectile_count >= MAX_PROJECTILES) {
        return INVALID_ENTITY_ID;
    }
    
    entity_id id = allocate_entity_id(sim);
    if (id == INVALID_ENTITY_ID) return id;
    
    struct Projectile* proj = &sim->projectiles[sim->projectile_count];
    memset(proj, 0, sizeof(struct Projectile));
    
    proj->id = id;
    proj->owner_id = shooter_id;
    proj->position = position;
    proj->prev_position = position;  // initialise; will be set by physics update each tick
    proj->velocity = velocity;
    proj->damage = 3000; // 3000 base damage (x weapon_damage multiplier 1.0)
    proj->lifetime = Q16_FROM_INT(10); // 10 second lifetime
    proj->spawn_time = sim->time_ms;
    proj->type = proj_type;
    
    sim->projectile_count++;
    
    log_debug("Created projectile %u at (%.2f, %.2f), vel (%.2f, %.2f)", id,
              Q16_TO_FLOAT(position.x), Q16_TO_FLOAT(position.y),
              Q16_TO_FLOAT(velocity.x), Q16_TO_FLOAT(velocity.y));
    
    return id;
}

// Entity lookup functions
struct Ship* sim_get_ship(struct Sim* sim, entity_id id) {
    if (!sim) return NULL;
    
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id == id) {
            return &sim->ships[i];
        }
    }
    return NULL;
}

struct Player* sim_get_player(struct Sim* sim, entity_id id) {
    if (!sim) return NULL;
    
    for (uint16_t i = 0; i < sim->player_count; i++) {
        if (sim->players[i].id == id) {
            return &sim->players[i];
        }
    }
    return NULL;
}

struct Projectile* sim_get_projectile(struct Sim* sim, entity_id id) {
    if (!sim) return NULL;
    
    for (uint16_t i = 0; i < sim->projectile_count; i++) {
        if (sim->projectiles[i].id == id) {
            return &sim->projectiles[i];
        }
    }
    return NULL;
}

void sim_process_input(struct Sim* sim, const struct InputCmd* cmd) {
    if (!sim || !cmd) return;
    
    struct Player* player = sim_get_player(sim, cmd->player_id);
    if (!player) return;
    
    // Convert Q0.15 input to Q16.16
    q16_t thrust = (q16_t)(cmd->thrust << 1);
    q16_t turn = (q16_t)(cmd->turn << 1);
    
    // Apply input to player's ship if they're on one
    if (player->ship_id != 0) {
        struct Ship* ship = sim_get_ship(sim, player->ship_id);
        if (ship) {
            /* ── Thrust force (clamped to MAX_THRUST_FORCE) ───────────────
             * F = thrust_scalar * forward_unit * 5000 N
             * Clamped so multiple inputs or exploits can't exceed the cap. */
            static const float MAX_THRUST_FORCE = 5000.0f;  /* Newtons         */
            static const float MAX_TURN_TORQUE  = 10000.0f; /* Newton⋅metres   */

            Vec2Q16 forward = {q16_cos(ship->rotation), q16_sin(ship->rotation)};
            Vec2Q16 thrust_force = vec2_mul_scalar(forward,
                                      q16_mul(thrust, Q16_FROM_FLOAT(MAX_THRUST_FORCE)));
            ship->net_force = vec2_add(ship->net_force, thrust_force);

            /* Clamp accumulated force magnitude so it never exceeds cap */
            {
                float fx = Q16_TO_FLOAT(ship->net_force.x);
                float fy = Q16_TO_FLOAT(ship->net_force.y);
                float fmag = sqrtf(fx * fx + fy * fy);
                if (fmag > MAX_THRUST_FORCE) {
                    float scale = MAX_THRUST_FORCE / fmag;
                    ship->net_force.x = Q16_FROM_FLOAT(fx * scale);
                    ship->net_force.y = Q16_FROM_FLOAT(fy * scale);
                }
            }

            /* ── Turn torque (clamped to MAX_TURN_TORQUE) ────────────────
             * τ = turn_scalar * 10000 N⋅m */
            q16_t torque = q16_mul(turn, Q16_FROM_FLOAT(MAX_TURN_TORQUE));
            ship->net_torque = q16_add_sat(ship->net_torque, torque);

            /* Clamp accumulated torque */
            {
                float t_val = Q16_TO_FLOAT(ship->net_torque);
                if (t_val >  MAX_TURN_TORQUE) ship->net_torque = Q16_FROM_FLOAT(MAX_TURN_TORQUE);
                if (t_val < -MAX_TURN_TORQUE) ship->net_torque = Q16_FROM_FLOAT(-MAX_TURN_TORQUE);
            }
        }
    }
    
    // Handle action buttons
    if (cmd->actions & PLAYER_ACTION_FIRE_CANNON) {
        // Fire cannon if player has one equipped
        struct Player* player = sim_get_player(sim, cmd->player_id);
        if (player && player->ship_id != INVALID_ENTITY_ID) {
            // Find the ship the player is on
            struct Ship* ship = sim_get_ship(sim, player->ship_id);
            if (ship) {
                // Create cannonball projectile
                Vec2Q16 cannon_pos = {
                    ship->position.x + q16_mul(Q16_FROM_INT(30), q16_cos(ship->rotation)),
                    ship->position.y + q16_mul(Q16_FROM_INT(30), q16_sin(ship->rotation))
                };
                Vec2Q16 cannon_velocity = {
                    ship->velocity.x + q16_mul(Q16_FROM_INT(200), q16_cos(ship->rotation)),
                    ship->velocity.y + q16_mul(Q16_FROM_INT(200), q16_sin(ship->rotation))
                };
                entity_id projectile = sim_create_projectile(sim, cannon_pos, cannon_velocity, player->id, PROJ_TYPE_CANNONBALL);
                log_info("🔥 Player %u fired cannon from ship %u (projectile %u)", 
                        player->id, ship->id, projectile);
            }
        }
    }
    
    if (cmd->actions & PLAYER_ACTION_JUMP) {
        // Handle player jump
        struct Player* player = sim_get_player(sim, cmd->player_id);
        if (player) {
            // Add vertical velocity for jump
            player->velocity.y = q16_add_sat(player->velocity.y, Q16_FROM_INT(5)); // 5 m/s upward
            
            // If jumping from a ship, leave the ship
            if (player->ship_id != INVALID_ENTITY_ID) {
                log_info("🦘 Player %u jumped off ship %u", player->id, player->ship_id);
                player->ship_id = INVALID_ENTITY_ID;
            } else {
                log_info("🦘 Player %u jumped", player->id);
            }
        }
    }
}

// Physics implementation
static void update_ship_physics(struct Ship* ship, q16_t dt) {
    if (!ship) return;

    /* ── Integrate accumulated forces ──────────────────────────────────────
     * All per-tick forces (thrust, sail, currents, etc.) were added to
     * net_force / net_torque during input processing and sail updates.
     * We integrate them here once and then reset for next tick.
     *
     *   a = F / m          →  v += a * dt
     *   α = τ / I          →  ω += α * dt                                */
    Vec2Q16 lin_accel = vec2_mul_scalar(ship->net_force, q16_div(Q16_ONE, ship->mass));
    ship->velocity    = vec2_add(ship->velocity, vec2_mul_scalar(lin_accel, dt));

    q16_t ang_accel       = q16_div(ship->net_torque, ship->moment_inertia);
    ship->angular_velocity = q16_add_sat(ship->angular_velocity, q16_mul(ang_accel, dt));

    /* Reset — collisions (impulse-based) write velocity directly and are
     * processed after physics, so they don't need to go through here. */
    ship->net_force  = VEC2_ZERO;
    ship->net_torque = 0;

    /* ── Hydrodynamic drag (linear + quadratic) ─────────────────────────────
     *
     * drag_factor = 1 − (c_lin + c_quad · |v|)
     *
     * Linear term (c_lin): low-speed hull friction — dominates at rest.
     * Quadratic term (c_quad · |v|): wave-making resistance — dominates at
     * speed and naturally caps velocity without a hard clamp.
     *
     * At equilibrium, thrust_accel * dt = |v| * (c_lin + c_quad * |v|),
     * yielding a natural top speed that can't be exceeded.  With the
     * values below and max thrust 5000 N / mass 1000 kg:
     *   top speed ≈ 3.2 server units/s  (≈ 32 client px/s)
     *   top ω     ≈ 0.45 rad/s
     *
     * Sails, currents, or other forces that push harder will raise the
     * equilibrium, but drag always wins eventually.                       */
    {
        static const float C_LIN_V  = 0.02f;   /* 2 % base linear drag     */
        static const float C_QUAD_V = 0.008f;   /* quadratic drag coeff     */
        static const float C_LIN_W  = 0.03f;   /* angular linear drag      */
        static const float C_QUAD_W = 0.06f;    /* angular quadratic coeff  */
        static const float MIN_DRAG = 0.60f;    /* safety floor             */

        float spd = Q16_TO_FLOAT(vec2_length(ship->velocity));
        float drag_v = 1.0f - (C_LIN_V + C_QUAD_V * spd);
        if (drag_v < MIN_DRAG) drag_v = MIN_DRAG;
        ship->velocity = vec2_mul_scalar(ship->velocity, Q16_FROM_FLOAT(drag_v));

        float w = Q16_TO_FLOAT(ship->angular_velocity);
        float abs_w = w < 0 ? -w : w;
        float drag_w = 1.0f - (C_LIN_W + C_QUAD_W * abs_w);
        if (drag_w < MIN_DRAG) drag_w = MIN_DRAG;
        ship->angular_velocity = q16_mul(ship->angular_velocity, Q16_FROM_FLOAT(drag_w));
    }

    /* ── Integrate state ───────────────────────────────────────────────── */
    Vec2Q16 displacement = vec2_mul_scalar(ship->velocity, dt);
    ship->position = vec2_add(ship->position, displacement);

    ship->rotation = q16_add_sat(ship->rotation, q16_mul(ship->angular_velocity, dt));
    
    // Normalize rotation to [0, 2π]
    q16_t two_pi = Q16_FROM_FLOAT(6.28318530718f);
    while (ship->rotation < 0) {
        ship->rotation = q16_add_sat(ship->rotation, two_pi);
    }
    while (ship->rotation >= two_pi) {
        ship->rotation = q16_sub_sat(ship->rotation, two_pi);
    }
}

static void update_player_physics(struct Player* player, struct Sim* sim, q16_t dt) {
    if (!player || !sim) return;
    
    // If player is on a ship, update position relative to ship
    if (player->ship_id != 0) {
        struct Ship* ship = sim_get_ship(sim, player->ship_id);
        if (ship) {
            // For now, just keep player at ship center
            player->position = ship->position;
            player->velocity = ship->velocity;
            player->flags &= ~PLAYER_FLAG_IN_WATER;
        }
    } else {
        // Player in water - swimming physics
        player->flags |= PLAYER_FLAG_IN_WATER;

        /* Water drag — same 0.95/tick as ships.  This causes players to
         * decelerate naturally when no input is applied rather than sliding
         * forever at constant speed.  The websocket server accumulates swim
         * acceleration into velocity; drag here opposes it each tick. */
        const q16_t SWIM_DRAG = Q16_FROM_FLOAT(0.95f);
        player->velocity.x = q16_mul(player->velocity.x, SWIM_DRAG);
        player->velocity.y = q16_mul(player->velocity.y, SWIM_DRAG);

        // Integrate position
        Vec2Q16 displacement = vec2_mul_scalar(player->velocity, dt);
        player->position = vec2_add(player->position, displacement);
    }
}

static void update_projectile_physics(struct Projectile* projectile, q16_t dt) {
    if (!projectile) return;
    
    // Save position before integrating — used for swept hull-edge intersection
    projectile->prev_position = projectile->position;
    
    // Integrate position (straight-line travel — no gravity in top-down view)
    Vec2Q16 displacement = vec2_mul_scalar(projectile->velocity, dt);
    projectile->position = vec2_add(projectile->position, displacement);
}

// Helper: Transform hull vertex from local to world space
static Vec2Q16 transform_hull_vertex(Vec2Q16 local_vertex, Vec2Q16 position, q16_t rotation) {
    // Rotate: [cos -sin] [x]
    //         [sin  cos] [y]
    q16_t cos_r = q16_cos(rotation);
    q16_t sin_r = q16_sin(rotation);
    
    q16_t rotated_x = q16_sub_sat(q16_mul(local_vertex.x, cos_r), q16_mul(local_vertex.y, sin_r));
    q16_t rotated_y = q16_add_sat(q16_mul(local_vertex.x, sin_r), q16_mul(local_vertex.y, cos_r));
    
    return (Vec2Q16){
        q16_add_sat(position.x, rotated_x),
        q16_add_sat(position.y, rotated_y)
    };
}

// Helper: Get edge normal for SAT
static Vec2Q16 get_edge_normal(Vec2Q16 v1, Vec2Q16 v2) {
    Vec2Q16 edge = vec2_sub(v2, v1);
    // Perpendicular: (-y, x)
    Vec2Q16 normal = {-edge.y, edge.x};
    return vec2_normalize(normal);
}

// Helper: Project polygon onto axis and return min/max
static void project_polygon_onto_axis(const struct Ship* ship, Vec2Q16 axis, q16_t* out_min, q16_t* out_max) {
    q16_t min_proj = Q16_MAX;
    q16_t max_proj = Q16_MIN;
    
    for (uint8_t i = 0; i < ship->hull_vertex_count; i++) {
        Vec2Q16 world_vertex = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
        q16_t projection = vec2_dot(world_vertex, axis);
        
        if (projection < min_proj) min_proj = projection;
        if (projection > max_proj) max_proj = projection;
    }
    
    *out_min = min_proj;
    *out_max = max_proj;
}

// SAT polygon-polygon collision detection
static bool check_polygon_collision(const struct Ship* ship1, const struct Ship* ship2, 
                                    Vec2Q16* out_normal, q16_t* out_depth) {
    q16_t min_overlap = Q16_MAX;
    Vec2Q16 min_axis = VEC2_ZERO;
    
    // Test all edge normals from both ships
    for (int ship_idx = 0; ship_idx < 2; ship_idx++) {
        const struct Ship* ship = (ship_idx == 0) ? ship1 : ship2;
        
        for (uint8_t i = 0; i < ship->hull_vertex_count; i++) {
            uint8_t next_i = (i + 1) % ship->hull_vertex_count;
            
            Vec2Q16 v1 = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
            Vec2Q16 v2 = transform_hull_vertex(ship->hull_vertices[next_i], ship->position, ship->rotation);
            
            Vec2Q16 axis = get_edge_normal(v1, v2);
            if (vec2_length_sq(axis) < Q16_FROM_FLOAT(0.0001f)) continue; // Skip degenerate edges
            
            // Project both polygons onto this axis
            q16_t min1, max1, min2, max2;
            project_polygon_onto_axis(ship1, axis, &min1, &max1);
            project_polygon_onto_axis(ship2, axis, &min2, &max2);
            
            // Check for separation
            if (max1 < min2 || max2 < min1) {
                return false; // Separating axis found - no collision
            }
            
            // Calculate overlap
            q16_t overlap = (max1 < max2) ? q16_sub_sat(max1, min2) : q16_sub_sat(max2, min1);
            
            if (overlap < min_overlap) {
                min_overlap = overlap;
                min_axis = axis;
            }
        }
    }
    
    // No separating axis found - collision detected
    if (out_normal) {
        // Ensure normal points from ship1 to ship2
        Vec2Q16 center_diff = vec2_sub(ship2->position, ship1->position);
        if (vec2_dot(min_axis, center_diff) < 0) {
            min_axis = (Vec2Q16){-min_axis.x, -min_axis.y};  // Negate the vector
        }
        *out_normal = min_axis;
    }
    if (out_depth) *out_depth = min_overlap;
    
    return true;
}

/* Forward declaration */
static bool point_in_polygon(Vec2Q16 point, const struct Ship* ship);

/* Ship-ship multipoint rigid-body collision response.
 *
 * Contact manifold: all vertices of each ship that lie inside the other ship's
 * hull polygon (found via the existing point_in_polygon ray-cast test).  If no
 * penetrating vertices are found we fall back to a single contact point at the
 * midpoint of the two support extremes along the SAT normal.
 *
 * Per contact point c_i, for two dynamic bodies (both finite mass/inertia):
 *
 *   r1_i = c_i − p1,   r2_i = c_i − p2          (lever arms)
 *   vc_i  = (v1 + ω1×r1_i) − (v2 + ω2×r2_i)    (relative velocity)
 *   vn    = vc_i · n
 *   r1xn  = r1_i × n,  r2xn = r2_i × n           (2-D scalar cross)
 *   denom = 1/m1 + 1/m2 + r1xn²/I + r2xn²/I
 *   J_i   = −(1+e)·vn / denom                    [only if vn < 0]
 *
 * Impulses are accumulated across all contact points using pre-impulse
 * velocities (simultaneous application), then written back once.
 *
 * All arithmetic in float using server-unit space to avoid Q16 overflow of the
 * large mass/inertia values (mass=1000 kg, I=SHIP_INERTIA server_unit²·kg). */
#define SHIP_RESTITUTION  0.3f
/* Moment of inertia in server-unit²·kg.  Tunable: larger = less spin on hit. */
#define SHIP_INERTIA      8000.0f
/* Baumgarte position-correction factor [0,1].  Applied as a velocity bias that
 * drives remaining penetration to zero over ~1/β ticks without teleporting.
 * 0.4 → ~60% of residual error corrected each tick; feels smooth but firm. */
#define SHIP_BAUMGARTE    0.4f
/* Minimum penetration ignored by the Baumgarte bias (server units, ~0.5 px).
 * Prevents micro-jitter when hulls are in near-resting light contact. */
#define SHIP_SLOP         0.05f

static void handle_ship_collisions(struct Sim* sim) {
    if (!sim || sim->ship_count < 2) return;

    for (uint16_t i = 0; i < sim->ship_count; i++) {
        for (uint16_t j = i + 1; j < sim->ship_count; j++) {
            struct Ship *ship1 = &sim->ships[i];
            struct Ship *ship2 = &sim->ships[j];

            /* ── Broad phase: bounding circles ── */
            Vec2Q16 diff = vec2_sub(ship2->position, ship1->position);
            q16_t dist_sq = vec2_length_sq(diff);
            q16_t combined_r = q16_add_sat(ship1->bounding_radius, ship2->bounding_radius);
            if (dist_sq >= q16_mul(combined_r, combined_r)) continue;

            /* ── Narrow phase: SAT polygon-polygon ── */
            Vec2Q16 collision_normal;
            q16_t overlap_depth;
            if (!check_polygon_collision(ship1, ship2, &collision_normal, &overlap_depth)) continue;

            /* ── Positional separation: Baumgarte-style ──────────────────────────
             * Instead of teleporting the full penetration away in one tick, apply
             * a fraction β of the error that exceeds SLOP.  The velocity bias below
             * drives out residual error over subsequent ticks.  This prevents the
             * harsh pop of full-correction while still converging quickly. */
            {
                float pen     = Q16_TO_FLOAT(overlap_depth);
                float corr    = SHIP_BAUMGARTE * fmaxf(pen - SHIP_SLOP, 0.0f) * 0.5f;
                Vec2Q16 sep   = vec2_mul_scalar(collision_normal, Q16_FROM_FLOAT(corr));
                ship1->position = vec2_sub(ship1->position, sep);
                ship2->position = vec2_add(ship2->position, sep);
            }

            /* ── Build contact manifold ── */
            /* After separation the hulls are just touching; penetrating vertices
             * are found in the pre-separation positions.  The positions have
             * already been updated, but the SAT depth is small so the manifold
             * is still valid.  Use world-space point_in_polygon. */
            float cpx[94], cpy[94];  /* max 47+47 contact points */
            int n_contacts = 0;

            /* Vertices of ship2 inside ship1 */
            for (uint8_t vi = 0; vi < ship2->hull_vertex_count; vi++) {
                Vec2Q16 wv = transform_hull_vertex(ship2->hull_vertices[vi],
                                                   ship2->position, ship2->rotation);
                if (point_in_polygon(wv, ship1)) {
                    cpx[n_contacts] = Q16_TO_FLOAT(wv.x);
                    cpy[n_contacts] = Q16_TO_FLOAT(wv.y);
                    n_contacts++;
                }
            }
            /* Vertices of ship1 inside ship2 */
            for (uint8_t vi = 0; vi < ship1->hull_vertex_count; vi++) {
                Vec2Q16 wv = transform_hull_vertex(ship1->hull_vertices[vi],
                                                   ship1->position, ship1->rotation);
                if (point_in_polygon(wv, ship2)) {
                    cpx[n_contacts] = Q16_TO_FLOAT(wv.x);
                    cpy[n_contacts] = Q16_TO_FLOAT(wv.y);
                    n_contacts++;
                }
            }

            /* Fallback: no penetrating vertices found — use support-edge midpoint */
            if (n_contacts == 0) {
                float nx = Q16_TO_FLOAT(collision_normal.x);
                float ny = Q16_TO_FLOAT(collision_normal.y);
                /* Support vertex of ship1 along +n */
                float best1 = -1e30f, sx1 = 0, sy1 = 0;
                for (uint8_t vi = 0; vi < ship1->hull_vertex_count; vi++) {
                    Vec2Q16 wv = transform_hull_vertex(ship1->hull_vertices[vi],
                                                       ship1->position, ship1->rotation);
                    float p = Q16_TO_FLOAT(wv.x)*nx + Q16_TO_FLOAT(wv.y)*ny;
                    if (p > best1) { best1=p; sx1=Q16_TO_FLOAT(wv.x); sy1=Q16_TO_FLOAT(wv.y); }
                }
                /* Support vertex of ship2 along -n */
                float best2 = 1e30f, sx2 = 0, sy2 = 0;
                for (uint8_t vi = 0; vi < ship2->hull_vertex_count; vi++) {
                    Vec2Q16 wv = transform_hull_vertex(ship2->hull_vertices[vi],
                                                       ship2->position, ship2->rotation);
                    float p = Q16_TO_FLOAT(wv.x)*nx + Q16_TO_FLOAT(wv.y)*ny;
                    if (p < best2) { best2=p; sx2=Q16_TO_FLOAT(wv.x); sy2=Q16_TO_FLOAT(wv.y); }
                }
                cpx[0] = (sx1 + sx2) * 0.5f;
                cpy[0] = (sy1 + sy2) * 0.5f;
                n_contacts = 1;
            }

            /* ── Multipoint impulse with warm starting ── */
            float nx = Q16_TO_FLOAT(collision_normal.x);
            float ny = Q16_TO_FLOAT(collision_normal.y);
            float p1x = Q16_TO_FLOAT(ship1->position.x), p1y = Q16_TO_FLOAT(ship1->position.y);
            float p2x = Q16_TO_FLOAT(ship2->position.x), p2y = Q16_TO_FLOAT(ship2->position.y);
            float v1x = Q16_TO_FLOAT(ship1->velocity.x),  v1y = Q16_TO_FLOAT(ship1->velocity.y);
            float v2x = Q16_TO_FLOAT(ship2->velocity.x),  v2y = Q16_TO_FLOAT(ship2->velocity.y);
            float w1  = Q16_TO_FLOAT(ship1->angular_velocity);
            float w2  = Q16_TO_FLOAT(ship2->angular_velocity);
            float m1  = Q16_TO_FLOAT(ship1->mass), m2 = Q16_TO_FLOAT(ship2->mass);
            float I   = SHIP_INERTIA;

            /* Limit manifold to MAX_CONTACT_POINTS for cache coherence */
            if (n_contacts > MAX_CONTACT_POINTS) n_contacts = MAX_CONTACT_POINTS;

            /* Look up warm-start data from previous tick */
            struct ContactEntry* ce = contact_cache_find(&sim->contact_cache, ship1->id, ship2->id);

            float dv1x = 0, dv1y = 0, dw1 = 0;
            float dv2x = 0, dv2y = 0, dw2 = 0;

            /* Warm start: apply cached impulse from last tick as initial guess.
             * This lets the solver start near the correct answer instead of
             * building up from zero, dramatically reducing jitter at rest. */
            if (ce && ce->n_contacts > 0) {
                for (int ci = 0; ci < n_contacts && ci < (int)ce->n_contacts; ci++) {
                    float Jw = ce->P_n[ci] * 0.8f;  /* 80% of last tick's impulse */
                    if (Jw <= 0.0f) continue;
                    float r1x = cpx[ci] - p1x, r1y = cpy[ci] - p1y;
                    float r2x = cpx[ci] - p2x, r2y = cpy[ci] - p2y;
                    float r1xn = r1x*ny - r1y*nx;
                    float r2xn = r2x*ny - r2y*nx;
                    dv1x += Jw*nx/m1;   dv1y += Jw*ny/m1;   dw1 += Jw*r1xn/I;
                    dv2x -= Jw*nx/m2;   dv2y -= Jw*ny/m2;   dw2 -= Jw*r2xn/I;
                }
                /* Apply warm-start to working velocities */
                v1x += dv1x; v1y += dv1y; w1 += dw1;
                v2x += dv2x; v2y += dv2y; w2 += dw2;
            }

            /* Accumulated impulse per contact this tick (for cache storage) */
            float P_n_acc[MAX_CONTACT_POINTS];
            memset(P_n_acc, 0, sizeof(P_n_acc));

            /* Reset deltas for the iterative solve (warm-start already applied) */
            dv1x = 0; dv1y = 0; dw1 = 0;
            dv2x = 0; dv2y = 0; dw2 = 0;

            for (int ci = 0; ci < n_contacts; ci++) {
                float r1x = cpx[ci] - p1x, r1y = cpy[ci] - p1y;
                float r2x = cpx[ci] - p2x, r2y = cpy[ci] - p2y;
                /* Velocity at contact point (includes warm-start) */
                float vc1x = v1x + w1*(-r1y),  vc1y = v1y + w1*r1x;
                float vc2x = v2x + w2*(-r2y),  vc2y = v2y + w2*r2x;
                float vrel_n = (vc1x - vc2x)*nx + (vc1y - vc2y)*ny;
                if (vrel_n >= 0.0f) continue;  /* separating at this point */
                float r1xn = r1x*ny - r1y*nx;
                float r2xn = r2x*ny - r2y*nx;
                float denom = 1.0f/m1 + 1.0f/m2 + (r1xn*r1xn + r2xn*r2xn)/I;
                if (denom < 1e-10f) continue;
                float dt_f  = Q16_TO_FLOAT(FIXED_DT_Q16);
                float pen_f = Q16_TO_FLOAT(overlap_depth);
                float bias  = (SHIP_BAUMGARTE / dt_f) * fmaxf(pen_f - SHIP_SLOP, 0.0f);
                float J = (-(1.0f + SHIP_RESTITUTION) * vrel_n + bias) / denom;
                if (J < 0.0f) J = 0.0f;  /* normal impulse can only push */
                P_n_acc[ci] = J;
                dv1x += J*nx/m1;   dv1y += J*ny/m1;   dw1 += J*r1xn/I;
                dv2x -= J*nx/m2;   dv2y -= J*ny/m2;   dw2 -= J*r2xn/I;
            }

            ship1->velocity.x = Q16_FROM_FLOAT(v1x + dv1x);
            ship1->velocity.y = Q16_FROM_FLOAT(v1y + dv1y);
            ship2->velocity.x = Q16_FROM_FLOAT(v2x + dv2x);
            ship2->velocity.y = Q16_FROM_FLOAT(v2y + dv2y);
            ship1->angular_velocity = Q16_FROM_FLOAT(w1 + dw1);
            ship2->angular_velocity = Q16_FROM_FLOAT(w2 + dw2);

            /* Store this tick's impulse into the contact cache */
            {
                struct ContactEntry* ce_w = contact_cache_upsert(&sim->contact_cache, ship1->id, ship2->id);
                ce_w->last_tick = sim->tick;
                ce_w->n_contacts = (uint8_t)n_contacts;
                for (int ci = 0; ci < n_contacts; ci++) {
                    ce_w->P_n[ci] = P_n_acc[ci];
                    ce_w->cx[ci]  = cpx[ci];
                    ce_w->cy[ci]  = cpy[ci];
                }
            }

            log_info("⚓ Ship hull collision: %u <-> %u (overlap: %.2f, contacts: %d, warm: %s)",
                     ship1->id, ship2->id, Q16_TO_FLOAT(overlap_depth), n_contacts,
                     ce ? "yes" : "no");
        }
    }
}

uint64_t sim_state_hash(const struct Sim* sim) {
    return hash_sim_state(sim);
}

void sim_serialize_state(const struct Sim* sim, uint8_t* buffer, size_t* buffer_size) {
    if (!sim || !buffer || !buffer_size) return;
    
    // Simple binary serialization (for replay storage)
    size_t required_size = sizeof(struct Sim);
    if (*buffer_size < required_size) {
        *buffer_size = required_size;
        return;
    }
    
    memcpy(buffer, sim, sizeof(struct Sim));
    *buffer_size = sizeof(struct Sim);
}

int sim_deserialize_state(struct Sim* sim, const uint8_t* buffer, size_t buffer_size) {
    if (!sim || !buffer || buffer_size < sizeof(struct Sim)) {
        return -1;
    }
    
    memcpy(sim, buffer, sizeof(struct Sim));
    return 0;
}

// Network integration functions
entity_id simulation_create_player_entity(struct Sim* sim, const char* player_name) {
    if (!sim || !player_name) return INVALID_ENTITY_ID;
    
    // Find the first available ship (should be the brigantine spawned at server start)
    entity_id ship_id = INVALID_ENTITY_ID;
    if (sim->ship_count > 0) {
        ship_id = sim->ships[0].id;  // Use the first ship (the brigantine)
    } else {
        log_error("No ships available! Cannot spawn player %s", player_name);
        return INVALID_ENTITY_ID;
    }
    
    // Spawn player on the existing ship at a default position on deck
    Vec2Q16 spawn_pos = sim->ships[0].position;
    entity_id player_id = sim_create_player(sim, spawn_pos, ship_id);
    if (player_id == INVALID_ENTITY_ID) {
        return INVALID_ENTITY_ID;
    }
    
    log_info("Created player entity %u (%s) on brigantine ship %u", player_id, player_name, ship_id);
    
    return player_id;
}

bool simulation_has_entity(const struct Sim* sim, entity_id entity_id) {
    if (!sim || entity_id == INVALID_ENTITY_ID) return false;
    
    // Check if entity exists in any of our arrays
    for (uint32_t i = 0; i < sim->player_count; i++) {
        if (sim->players[i].id == entity_id) return true;
    }
    
    for (uint32_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id == entity_id) return true;
    }
    
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        if (sim->projectiles[i].id == entity_id) return true;
    }
    
    return false;
}

// Spatial hash and collision detection functions
void sim_update_spatial_hash(struct Sim* sim) {
    // Clear the spatial hash
    memset(sim->spatial_hash, 0, sizeof(sim->spatial_hash));
    
    // Add all ships to spatial hash
    for (uint16_t i = 0; i < sim->ship_count; i++) {
        struct Ship* ship = &sim->ships[i];
        spatial_hash_add_ship(sim, ship);
    }
    
    // Add all players to spatial hash
    for (uint16_t i = 0; i < sim->player_count; i++) {
        struct Player* player = &sim->players[i];
        spatial_hash_add_player(sim, player);
    }
    
    // Add all projectiles to spatial hash
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        struct Projectile* projectile = &sim->projectiles[i];
        spatial_hash_add_projectile(sim, projectile);
    }
}

void spatial_hash_add_ship(struct Sim* sim, struct Ship* ship) {
    // Simple spatial hash: divide world into 1024x1024 unit cells
    int32_t cell_x = Q16_TO_INT(ship->position.x) / 1024;
    int32_t cell_y = Q16_TO_INT(ship->position.y) / 1024;
    
    // Clamp to hash bounds
    if (cell_x < 0) cell_x = 0;
    if (cell_y < 0) cell_y = 0;
    if (cell_x >= SPATIAL_HASH_SIZE) cell_x = SPATIAL_HASH_SIZE - 1;
    if (cell_y >= SPATIAL_HASH_SIZE) cell_y = SPATIAL_HASH_SIZE - 1;
    
    uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
    struct SpatialCell* cell = &sim->spatial_hash[hash_index];
    
    // Add ship to cell (if room)
    if (cell->ship_count < MAX_ENTITIES_PER_CELL) {
        cell->ships[cell->ship_count++] = ship;
    }
}

void spatial_hash_add_player(struct Sim* sim, struct Player* player) {
    int32_t cell_x = Q16_TO_INT(player->position.x) / 1024;
    int32_t cell_y = Q16_TO_INT(player->position.y) / 1024;
    
    if (cell_x < 0) cell_x = 0;
    if (cell_y < 0) cell_y = 0;
    if (cell_x >= SPATIAL_HASH_SIZE) cell_x = SPATIAL_HASH_SIZE - 1;
    if (cell_y >= SPATIAL_HASH_SIZE) cell_y = SPATIAL_HASH_SIZE - 1;
    
    uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
    struct SpatialCell* cell = &sim->spatial_hash[hash_index];
    
    if (cell->player_count < MAX_ENTITIES_PER_CELL) {
        cell->players[cell->player_count++] = player;
    }
}

void spatial_hash_add_projectile(struct Sim* sim, struct Projectile* projectile) {
    int32_t cell_x = Q16_TO_INT(projectile->position.x) / 1024;
    int32_t cell_y = Q16_TO_INT(projectile->position.y) / 1024;
    
    if (cell_x < 0) cell_x = 0;
    if (cell_y < 0) cell_y = 0;
    if (cell_x >= SPATIAL_HASH_SIZE) cell_x = SPATIAL_HASH_SIZE - 1;
    if (cell_y >= SPATIAL_HASH_SIZE) cell_y = SPATIAL_HASH_SIZE - 1;
    
    uint32_t hash_index __attribute__((unused)) = cell_y * SPATIAL_HASH_SIZE + cell_x;
    struct SpatialCell* cell = &sim->spatial_hash[hash_index];
    
    if (cell->projectile_count < MAX_ENTITIES_PER_CELL) {
        cell->projectiles[cell->projectile_count++] = projectile;
    }
}

// Enhanced collision detection functions
// Map a hull vertex index (0..hull_vertex_count-1) to a plank index (0-9).
// Hull layout for brigantine (47 vertices):
//   0-12  : bow curve  (0-6 = bow_port plank 0, 7-12 = bow_stbd plank 1)
//   13-24 : stbd straight side split into 3 sections (planks 2,3,4)
//   25-36 : stern curve (25-30 = stern_stbd plank 5, 31-36 = stern_port plank 6)
//   37-47 : port straight side split into 3 sections (planks 7,8,9)
static int hull_vertex_to_plank_index(int v) {
    if (v <= 6)  return 0; // bow_port
    if (v <= 12) return 1; // bow_stbd
    if (v <= 16) return 2; // stbd_front
    if (v <= 20) return 3; // stbd_mid
    if (v <= 24) return 4; // stbd_rear
    if (v <= 30) return 5; // stern_stbd
    if (v <= 36) return 6; // stern_port
    if (v <= 39) return 7; // port_rear
    if (v <= 43) return 8; // port_mid
    return 9;              // port_front
}

// Find the simulation module index that a breaching cannonball hits.
// Uses original hit radius - projectiles must actually be inside the hull to hit modules.
// lx/ly are in ship-local server units.
// Returns -1 if no module is close enough.
static int find_module_hit(const struct Ship* ship, float lx, float ly) {
    for (int m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->type_id != MODULE_TYPE_CANNON &&
            mod->type_id != MODULE_TYPE_MAST   &&
            mod->type_id != MODULE_TYPE_HELM)   continue;
        if (mod->state_bits & MODULE_STATE_DESTROYED) continue;

        // Use original tight hit radius - projectile must be truly inside
        float radius;
        switch (mod->type_id) {
            case MODULE_TYPE_CANNON: radius = CLIENT_TO_SERVER(15.0f); break; // Reduced from 28
            case MODULE_TYPE_MAST:   radius = CLIENT_TO_SERVER(25.0f); break; // Reduced from 38
            case MODULE_TYPE_HELM:   radius = CLIENT_TO_SERVER(15.0f); break; // Reduced from 28
            default:                 radius = 0.0f;                    break;
        }
        float mx = Q16_TO_FLOAT(mod->local_pos.x);
        float my = Q16_TO_FLOAT(mod->local_pos.y);
        
        // Circle collision check with tight radius
        float dx = mx - lx, dy = my - ly;
        if (dx*dx + dy*dy < radius*radius)
            return m;
    }
    return -1;
}

// Ray-casting point-in-polygon test (works for convex or concave polygons).
// Vertices are in server units (Q16 float values).
static bool point_in_hull(float px, float py, const Vec2Q16* verts, int n) {
    bool inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        float xi = Q16_TO_FLOAT(verts[i].x), yi = Q16_TO_FLOAT(verts[i].y);
        float xj = Q16_TO_FLOAT(verts[j].x), yj = Q16_TO_FLOAT(verts[j].y);
        if (((yi > py) != (yj > py)) &&
            (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}

/*
 * Bar shot hit zones (client-px, matching sail geometry in modules.ts):
 *   SAIL_HALF_WIDTH = 40  (sailWidth=80, half = 40) — outer edge of sail cloth
 *   MAST_POLE_RADIUS = 15 — solid mast centre; structural HP damage
 *
 * A shot inside SAIL_HALF_WIDTH hits the fibers.
 * A shot also inside MAST_POLE_RADIUS additionally damages the mast structure.
 */
#define BAR_SHOT_SAIL_RADIUS   CLIENT_TO_SERVER(40.0f)
#define BAR_SHOT_MAST_RADIUS   CLIENT_TO_SERVER(15.0f)

/* Return value: index into ship->modules[], or -1 for no hit.
 * *out_center_hit  is set to true only when the bar overlaps the mast pole. */
static int find_mast_hit(const struct Ship* ship, float lx, float ly,
                         uint16_t skip_module_id, bool* out_center_hit) {
    for (int m = 0; m < ship->module_count; m++) {
        const ShipModule* mod = &ship->modules[m];
        if (mod->id == skip_module_id) continue;  // still inside radius of last-hit mast
        if (mod->type_id != MODULE_TYPE_MAST) continue;
        if (mod->state_bits & MODULE_STATE_DESTROYED) continue;

        float mx = Q16_TO_FLOAT(mod->local_pos.x);
        float my = Q16_TO_FLOAT(mod->local_pos.y);
        float dx = mx - lx, dy = my - ly;
        float dist_sq = dx*dx + dy*dy;

        if (dist_sq < BAR_SHOT_SAIL_RADIUS * BAR_SHOT_SAIL_RADIUS) {
            *out_center_hit = (dist_sq < BAR_SHOT_MAST_RADIUS * BAR_SHOT_MAST_RADIUS);
            return m;
        }
    }
    return -1;
}

/*
 * Swept hull-crossing detection.
 *
 * Tests the line segment [prev → cur] (both in ship-local server units)
 * against every edge of the hull polygon.  Returns the index of the first
 * edge the segment crosses, or -1 if there is no crossing.
 *
 * We use parametric line-line intersection:
 *   P(t) = prev + t*(cur-prev),   t in [0,1]
 *   Q(u) = v0  + u*(v1-v0),       u in [0,1]
 * Solving P(t)==Q(u) gives the crossing parameters.
 *
 * The edge index maps to a hull vertex pair (v, v+1 mod n), which maps to
 * a plank via hull_vertex_to_plank_index(v).
 */
static int swept_hull_edge_crossing(
        float px0, float py0,   // previous position (local)
        float px1, float py1,   // current  position (local)
        const Vec2Q16* verts, int n)
{
    float rx = px1 - px0;
    float ry = py1 - py0;

    int   best_edge = -1;
    float best_t    = 2.0f; // sentinel > 1

    for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        float sx = Q16_TO_FLOAT(verts[j].x) - Q16_TO_FLOAT(verts[i].x);
        float sy = Q16_TO_FLOAT(verts[j].y) - Q16_TO_FLOAT(verts[i].y);
        float qx = Q16_TO_FLOAT(verts[i].x) - px0;
        float qy = Q16_TO_FLOAT(verts[i].y) - py0;

        float denom = rx * sy - ry * sx;
        if (fabsf(denom) < 1e-9f) continue;  // parallel

        float t = (qx * sy - qy * sx) / denom;
        float u = (qx * ry - qy * rx) / denom;

        if (t >= 0.0f && t <= 1.0f && u >= 0.0f && u <= 1.0f) {
            if (t < best_t) {
                best_t    = t;
                best_edge = i;
            }
        }
    }
    return best_edge;
}

/*
 * Backward ray from an inside point along the approach direction.
 *
 * Used when swept_hull_edge_crossing returns -1 (both prev and cur are
 * inside the hull, e.g. shallow-angle approach where prev_position was
 * already inside).  Fires a ray from (px, py) in the REVERSE of (rdx,rdy)
 * and returns the first hull edge hit — which is the edge the ball entered
 * through.  Returns -1 only if (rdx,rdy) is zero.
 */
static int entry_edge_by_reverse_ray(
        float px, float py,     // current local position (inside hull)
        float rdx, float rdy,   // approach direction (world-space velocity local-rotated)
        const Vec2Q16* verts, int n)
{
    // Reverse the ray direction so it shoots back toward where the ball came from
    float rx = -rdx;
    float ry = -rdy;

    float len = sqrtf(rx*rx + ry*ry);
    if (len < 1e-9f) return -1;
    // Normalise then scale to a length guaranteed to reach any hull edge
    // (hull fits in ~200 server units, so 500 is more than enough)
    rx = rx / len * 500.0f;
    ry = ry / len * 500.0f;

    int   best_edge = -1;
    float best_t    = 1e30f;

    for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        float sx = Q16_TO_FLOAT(verts[j].x) - Q16_TO_FLOAT(verts[i].x);
        float sy = Q16_TO_FLOAT(verts[j].y) - Q16_TO_FLOAT(verts[i].y);
        float qx = Q16_TO_FLOAT(verts[i].x) - px;
        float qy = Q16_TO_FLOAT(verts[i].y) - py;

        float denom = rx * sy - ry * sx;
        if (fabsf(denom) < 1e-9f) continue;

        float t = (qx * sy - qy * sx) / denom;
        float u = (qx * ry - qy * rx) / denom;

        // t > 0 means forward along the reversed ray (i.e. behind ball's travel)
        // u in [0,1] means intersection is on the hull edge
        if (t > 0.0f && u >= 0.0f && u <= 1.0f) {
            if (t < best_t) {
                best_t    = t;
                best_edge = i;
            }
        }
    }
    return best_edge;
}

void handle_projectile_collisions(struct Sim* sim) {
    // NOTE: hit_event_count is NOT reset here — sim_update_ships may have already
    // queued SHIP_SINK events this tick. The count is reset at the start of the
    // next tick by the caller (websocket_server.c drains events after sim_step).

    uint32_t i = 0;
    while (i < sim->projectile_count) {
        struct Projectile* proj = &sim->projectiles[i];
        bool removed = false;

        /* Liquid flame flies through hull/planks/modules — fire effects are applied
         * in the websocket_server entity-scan loop each tick.  Skip all geometric
         * collision for this projectile type and let it expire via lifetime. */
        if (proj->type == PROJ_TYPE_LIQUID_FLAME) { i++; continue; }

        // ---- Broad-phase: iterate all ships (small count, skip spatial hash) ----
        for (uint16_t s = 0; s < sim->ship_count && !removed; s++) {
            struct Ship* ship = &sim->ships[s];
            
            // Skip own ship (check both owner_id and firing_ship_id)
            if (ship->id == proj->owner_id || ship->id == proj->firing_ship_id) {
                continue;
            }
            
            // Skip friendly-fire (same company, both non-neutral)
            if (proj->firing_company != 0 && proj->firing_company == ship->company_id) continue;

            // Broad-phase bounding radius
            float dx = Q16_TO_FLOAT(ship->position.x) - Q16_TO_FLOAT(proj->position.x);
            float dy = Q16_TO_FLOAT(ship->position.y) - Q16_TO_FLOAT(proj->position.y);
            float dist_sq = dx*dx + dy*dy;
            float brad = Q16_TO_FLOAT(ship->bounding_radius);
            if (dist_sq <= brad * brad) {
                log_info("🔍 Proj %u within bounding radius of ship %u (dist=%.2f brad=%.2f)",
                         proj->id, ship->id, sqrtf(dist_sq), brad);
            }
            if (dist_sq > brad * brad) {
                // Ball is outside bounding circle.
                // If it was marked as inside this ship, it passed through without hitting a
                // module (e.g. it skipped past every interior module).  Absorb it now and
                // apply generic hull damage so the cannonball never disappears silently.
                if (proj->inside_ship_id == ship->id) {
                    log_info("⚠️  Projectile %u exited bounding circle of ship %u without hitting a module — applying hull damage",
                             proj->id, ship->id);
                    proj->inside_ship_id = 0;
                    // Apply hull damage
                    float raw_dmg = Q16_TO_FLOAT(proj->damage) * ship_level_resistance_mult(&ship->level_stats);
                    int32_t hull_hp = ship->hull_health - (int32_t)raw_dmg;
                    if (hull_hp < 0) hull_hp = 0;
                    if (sim->hit_event_count < MAX_HIT_EVENTS) {
                        struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                        ev->ship_id         = ship->id;
                        ev->module_id       = 0; // no module — hull direct
                        ev->is_breach       = true;
                        ev->is_sink         = (ship->hull_health > 0 && hull_hp == 0);
                        ev->destroyed       = false;
                        ev->damage_dealt    = (float)(ship->hull_health - hull_hp);
                        ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                        ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                        ev->shooter_ship_id = proj->firing_ship_id;
                    }
                    ship->hull_health = hull_hp;
                    if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                        struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                        if (attacker) attacker->level_stats.xp += 5u;
                    }
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                }
                continue;
            }

            // ---- Narrow-phase: transform projectile into ship-local coords ----
            float rot = Q16_TO_FLOAT(ship->rotation);
            float rel_x = Q16_TO_FLOAT(proj->position.x) - Q16_TO_FLOAT(ship->position.x);
            float rel_y = Q16_TO_FLOAT(proj->position.y) - Q16_TO_FLOAT(ship->position.y);
            float lx = rel_x * cosf(-rot) - rel_y * sinf(-rot);
            float ly = rel_x * sinf(-rot) + rel_y * cosf(-rot);

            // ---- BAR SHOT: bypass hull entirely, slices through mast/sail modules ----
            if (proj->type == PROJ_TYPE_BAR_SHOT) {
                bool center_hit = false;
                int hit_m = find_mast_hit(ship, lx, ly, (uint16_t)proj->last_hit_module_id, &center_hit);
                if (hit_m >= 0) {
                    ShipModule* hit_mod = &ship->modules[hit_m];
                    uint16_t mod_id = hit_mod->id;

                    float damage_dealt = 0.0f;
                    bool mast_destroyed = false;

                    if (center_hit) {
                        // ── Mast pole hit: full structural damage ──
                        float dmg_before = (float)hit_mod->health;
                        q16_t effective_damage = Q16_FROM_FLOAT(
                            Q16_TO_FLOAT(proj->damage)
                            * ship_level_resistance_mult(&ship->level_stats)
                        );
                        module_apply_damage(hit_mod, effective_damage);
                        damage_dealt = dmg_before - (float)hit_mod->health;
                        if (damage_dealt < 0) damage_dealt = 0;

                        mast_destroyed = (hit_mod->health <= 0);
                        if (mast_destroyed) {
                            log_info("⛵💥 Bar shot %u destroyed mast %u (pole hit) on ship %u",
                                     proj->id, mod_id, ship->id);
                            memmove(&ship->modules[hit_m], &ship->modules[hit_m + 1],
                                    (ship->module_count - hit_m - 1) * sizeof(ShipModule));
                            ship->module_count--;
                        } else {
                            log_info("⛵💥 Bar shot %u hit mast pole %u on ship %u — %d HP remaining",
                                     proj->id, mod_id, ship->id, (int)hit_mod->health);
                        }
                    } else {
                        // ── Sail fiber hit: damage fiber_health, derive wind_efficiency from HP ratio ──
                        // NOTE: fiber_health is stored as a proper Q16 float (Q16_FROM_FLOAT(15000.0)).
                        // proj->damage is stored as a plain integer in q16_t (e.g. 3000 raw ≠ Q16 for 3000.0).
                        // Using Q16_TO_FLOAT(proj->damage) gives ~0.046, not 3000 — so bypass Q16 here.
                        float fh = Q16_TO_FLOAT(hit_mod->data.mast.fiber_health);
                        float fhmax = Q16_TO_FLOAT(hit_mod->data.mast.fiber_max_health);
                        if (fhmax <= 0.0f) fhmax = 15000.0f;

                        float fiber_dmg = (float)proj->damage
                                          * ship_level_resistance_mult(&ship->level_stats);
                        fh -= fiber_dmg;
                        if (fh < 0.0f) fh = 0.0f;
                        hit_mod->data.mast.fiber_health = Q16_FROM_FLOAT(fh);

                        // wind_efficiency tracks fiber HP ratio (0.0 at destroyed, 1.0 at full)
                        float new_eff = fh / fhmax;
                        hit_mod->data.mast.wind_efficiency = Q16_FROM_FLOAT(new_eff);

                        damage_dealt = fiber_dmg;
                        log_info("⛵🧵 Bar shot %u shredded sail fiber %u on ship %u (fiber HP %.0f/%.0f, eff %.2f)",
                                 proj->id, mod_id, ship->id, fh, fhmax, new_eff);
                    }

                    if (sim->hit_event_count < MAX_HIT_EVENTS) {
                        struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                        ev->ship_id         = ship->id;
                        ev->module_id       = mod_id;
                        ev->is_breach       = true;
                        ev->is_sink         = false;
                        ev->destroyed       = mast_destroyed;
                        ev->damage_dealt    = damage_dealt;
                        ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                        ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                        ev->shooter_ship_id = proj->firing_ship_id;
                    }

                    if (center_hit && proj->firing_ship_id != INVALID_ENTITY_ID) {
                        struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                        if (attacker)
                            attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                    }

                    if (center_hit) {
                        // Bar shot hit the mast pole directly — stop it here.
                        log_info("💣 DESPAWN proj %u — bar shot hit mast pole (mod %u) on ship %u pos=(%.2f,%.2f)",
                                 proj->id, mod_id, ship->id,
                                 Q16_TO_FLOAT(proj->position.x), Q16_TO_FLOAT(proj->position.y));
                        memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                                (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                        sim->projectile_count--;
                        removed = true;
                    } else {
                        // Sail fiber hit — record which mast was just hit so it's skipped next
                        // tick while still in range; projectile keeps flying.
                        proj->last_hit_module_id = mod_id;
                    }
                    break;
                }
                // Bar shot outside all mast radii: clear the skip lock
                if (proj->last_hit_module_id != 0) proj->last_hit_module_id = 0;
                // Bar shot misses: keep flying (no hull interaction)
                continue;
            }

            // Point-in-polygon test
            bool inside_hull = point_in_hull(lx, ly, ship->hull_vertices, ship->hull_vertex_count);

            // If ball was marked as breaching this ship but has now exited the hull, clear it
            if (proj->inside_ship_id == ship->id && !inside_hull) {
                proj->inside_ship_id = 0;
                proj->ticks_inside = 0;
                if (proj->last_hit_module_id == 200) proj->last_hit_module_id = 0; // clear deck hit flag
                log_info("🚪 Projectile %u exited hull of ship %u", proj->id, ship->id);
                continue;
            }

            if (!inside_hull) continue;

            // ---- Ball is inside the hull polygon ----

            // Log whether this is a first-time entry or already inside.
            // NOTE: inside_ship_id is set HERE on first entry so the already-inside
            // block runs immediately this tick.  Previously it was only set in the
            // entry-plank else-branch, which meant the entry-plank code ran first
            // and absorbed the ball before the interior-module check ever could.
            if (proj->inside_ship_id != ship->id) {
                log_info("🎯 Projectile %u entering hull of ship %u for first time (lx=%.1f, ly=%.1f)", 
                         proj->id, ship->id, lx, ly);
                proj->inside_ship_id = ship->id; // mark as inside NOW
                proj->ticks_inside = 0;
            } else {
                log_info("🔄 Projectile %u already inside ship %u hull (lx=%.1f, ly=%.1f)", 
                         proj->id, ship->id, lx, ly);
            }

            if (proj->inside_ship_id == ship->id) {
                // ── On the VERY FIRST TICK inside (ticks_inside==0 set during entry above),
                // check the entry plank.  This replaces the old separate "entry plank" code path
                // below the continue, which was unreachable after the inside_ship_id fix.
                if (proj->ticks_inside == 0 && ship->company_id != 99) {
                    // Determine the entry edge using the swept-segment approach, then map to a plank
                    float prev_rel_x = Q16_TO_FLOAT(proj->prev_position.x) - Q16_TO_FLOAT(ship->position.x);
                    float prev_rel_y = Q16_TO_FLOAT(proj->prev_position.y) - Q16_TO_FLOAT(ship->position.y);
                    float prev_lx = prev_rel_x * cosf(-rot) - prev_rel_y * sinf(-rot);
                    float prev_ly = prev_rel_x * sinf(-rot) + prev_rel_y * cosf(-rot);
                    float vlx = Q16_TO_FLOAT(proj->velocity.x) * cosf(-rot)
                              - Q16_TO_FLOAT(proj->velocity.y) * sinf(-rot);
                    float vly = Q16_TO_FLOAT(proj->velocity.x) * sinf(-rot)
                              + Q16_TO_FLOAT(proj->velocity.y) * cosf(-rot);

                    int crossed_edge = swept_hull_edge_crossing(
                        prev_lx, prev_ly, lx, ly,
                        ship->hull_vertices, ship->hull_vertex_count);
                    if (crossed_edge < 0) {
                        crossed_edge = entry_edge_by_reverse_ray(
                            lx, ly, vlx, vly,
                            ship->hull_vertices, ship->hull_vertex_count);
                        if (crossed_edge >= 0)
                            log_info("🎯 Proj %u reverse-ray entry edge %d on ship %u",
                                     proj->id, crossed_edge, ship->id);
                    }
                    int plank_idx;
                    if (crossed_edge >= 0) {
                        plank_idx = hull_vertex_to_plank_index(crossed_edge);
                        log_info("🎯 Proj %u crossed hull edge %d → plank %d on ship %u",
                                 proj->id, crossed_edge, plank_idx, ship->id);
                    } else {
                        int nearest_v = 0;
                        float nearest_d2 = 1e30f;
                        for (int v = 0; v < ship->hull_vertex_count; v++) {
                            float vx2 = Q16_TO_FLOAT(ship->hull_vertices[v].x) - lx;
                            float vy2 = Q16_TO_FLOAT(ship->hull_vertices[v].y) - ly;
                            float d2 = vx2*vx2 + vy2*vy2;
                            if (d2 < nearest_d2) { nearest_d2 = d2; nearest_v = v; }
                        }
                        plank_idx = hull_vertex_to_plank_index(nearest_v);
                        log_info("🎯 Proj %u zero-vel fallback → plank %d on ship %u",
                                 proj->id, plank_idx, ship->id);
                    }

                    uint16_t plank_module_id = (uint16_t)(100 + plank_idx);
                    int hit_plank_idx = -1;
                    for (uint8_t m = 0; m < ship->module_count; m++) {
                        if (ship->modules[m].id == plank_module_id) { hit_plank_idx = m; break; }
                    }

                    if (hit_plank_idx >= 0 && !(ship->modules[hit_plank_idx].state_bits & MODULE_STATE_DESTROYED)) {
                        ShipModule* hit_plank = &ship->modules[hit_plank_idx];
                        float plank_hp_before = (float)hit_plank->health;
                        q16_t effective_damage = Q16_FROM_FLOAT(
                            Q16_TO_FLOAT(proj->damage)
                            * ship_level_resistance_mult(&ship->level_stats));
                        module_apply_damage(hit_plank, effective_damage);
                        float plank_damage_dealt = plank_hp_before - (float)hit_plank->health;
                        if (plank_damage_dealt < 0) plank_damage_dealt = 0;

                        if (hit_plank->health <= 0) {
                            log_info("🎯 Proj %u destroyed plank %u on ship %u",
                                     proj->id, plank_module_id, ship->id);
                            if (sim->hit_event_count < MAX_HIT_EVENTS) {
                                struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                                ev->ship_id = ship->id; ev->module_id = plank_module_id;
                                ev->is_breach = false; ev->is_sink = false; ev->destroyed = true;
                                ev->damage_dealt = plank_damage_dealt;
                                ev->hit_x = Q16_TO_FLOAT(proj->position.x);
                                ev->hit_y = Q16_TO_FLOAT(proj->position.y);
                                ev->shooter_ship_id = proj->firing_ship_id;
                            }
                            if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                                struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                                if (attacker)
                                    attacker->level_stats.xp += 10u + (uint32_t)(plank_damage_dealt / 100.0f);
                            }
                            memmove(&ship->modules[hit_plank_idx], &ship->modules[hit_plank_idx + 1],
                                    (ship->module_count - hit_plank_idx - 1) * sizeof(ShipModule));
                            ship->module_count--;
                        } else {
                            log_info("🎯 Proj %u hit plank %u on ship %u — %d HP remaining",
                                     proj->id, plank_module_id, ship->id, (int)hit_plank->health);
                            if (sim->hit_event_count < MAX_HIT_EVENTS) {
                                struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                                ev->ship_id = ship->id; ev->module_id = plank_module_id;
                                ev->is_breach = false; ev->is_sink = false; ev->destroyed = false;
                                ev->damage_dealt = plank_damage_dealt;
                                ev->hit_x = Q16_TO_FLOAT(proj->position.x);
                                ev->hit_y = Q16_TO_FLOAT(proj->position.y);
                                ev->shooter_ship_id = proj->firing_ship_id;
                            }
                            if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                                struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                                if (attacker)
                                    attacker->level_stats.xp += 10u + (uint32_t)(plank_damage_dealt / 100.0f);
                            }
                        }
                        // Absorbed by plank regardless of HP
                        log_info("💣 DESPAWN proj %u — absorbed by plank %u on ship %u",
                                 proj->id, plank_module_id, ship->id);
                        memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                                (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                        sim->projectile_count--;
                        removed = true;
                    } else {
                        // Plank already gone — ball passes freely through the breach
                        log_info("🕳️  Proj %u passed through breach at plank %u on ship %u — traveling inside",
                                 proj->id, plank_module_id, ship->id);
                        // inside_ship_id already set; ticks_inside stays 0; continue to interior checks below
                    }
                }

                // Ghost ship with no planks: absorb on entry
                if (!removed && ship->company_id == 99 && proj->ticks_inside == 0) {
                    int32_t old_hull_hp = ship->hull_health;
                    int32_t hp = ship->hull_health - (int32_t)proj->damage;
                    if (hp < 0) hp = 0;
                    if (sim->hit_event_count < MAX_HIT_EVENTS) {
                        struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                        ev->ship_id = ship->id; ev->module_id = 0;
                        ev->is_breach = false;
                        ev->is_sink = (ship->hull_health > 0 && hp == 0);
                        ev->destroyed = false;
                        ev->damage_dealt = (float)proj->damage;
                        ev->hit_x = Q16_TO_FLOAT(proj->position.x);
                        ev->hit_y = Q16_TO_FLOAT(proj->position.y);
                        ev->shooter_ship_id = proj->firing_ship_id;
                    }
                    ship->hull_health = hp;
                    if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                        struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                        if (attacker) attacker->level_stats.xp += 20u;
                    }
                    log_info("💣 DESPAWN proj %u — ghost ship %u direct hull hit, HP %d->%d pos=(%.2f,%.2f)",
                             proj->id, ship->id, old_hull_hp, hp,
                             Q16_TO_FLOAT(proj->position.x), Q16_TO_FLOAT(proj->position.y));
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                }

                if (removed) { continue; }

                // ---- Deck pass-through: damage deck once per hull entry (priority) ----
                // Deck ID is always 200; use last_hit_module_id==200 to fire only once per pass.
                if (proj->last_hit_module_id != 200) {
                    for (uint8_t m = 0; m < ship->module_count; m++) {
                        ShipModule* deck = &ship->modules[m];
                        if (deck->type_id != MODULE_TYPE_DECK) continue;
                        if (deck->health <= 0) break;

                        proj->last_hit_module_id = 200; // mark deck as hit for this pass

                        float dmg_before = (float)deck->health;
                        q16_t eff_dmg = Q16_FROM_FLOAT(
                            Q16_TO_FLOAT(proj->damage)
                            * ship_level_resistance_mult(&ship->level_stats));
                        module_apply_damage(deck, eff_dmg);
                        float deck_dmg = dmg_before - (float)deck->health;
                        if (deck_dmg < 0) deck_dmg = 0;

                        log_info("🪵 Projectile %u grazed deck on ship %u (%.0f HP remaining) — passing through",
                                 proj->id, ship->id, (float)deck->health);

                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id         = ship->id;
                            ev->module_id       = deck->id;
                            ev->is_breach       = true;
                            ev->is_sink         = false;
                            ev->destroyed       = (deck->health <= 0);
                            ev->damage_dealt    = deck_dmg;
                            ev->hit_x           = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y           = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id = proj->firing_ship_id;
                        }
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(deck_dmg / 100.0f);
                        }
                        break;
                    }
                }

                // Ball already breached this hull — check for interior module hits at current position
                /* Ghost ships have no planks; absorb any projectile that managed to get inside
                 * (shouldn't happen after entry-point intercept, but belt-and-suspenders). */
                if (ship->company_id == 99) {
                    log_info("👻 Projectile %u absorbed by ghost ship %u at (%.1f, %.1f)",
                             proj->id, ship->id, lx, ly);
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                }

                int hit_m = find_module_hit(ship, lx, ly);
                if (!removed && hit_m >= 0) {
                    ShipModule* hit_mod = &ship->modules[hit_m];
                    uint16_t mod_id = hit_mod->id;
                    
                    log_info("🎯 Interior module check: projectile %u at (%.1f, %.1f) hit module %u (type %d)",
                             proj->id, lx, ly, mod_id, hit_mod->type_id);

                    float dmg_before = (float)hit_mod->health;
                    q16_t effective_damage = Q16_FROM_FLOAT(
                        Q16_TO_FLOAT(proj->damage)
                        * ship_level_resistance_mult(&ship->level_stats)
                    );
                    module_apply_damage(hit_mod, effective_damage);
                    float damage_dealt = dmg_before - (float)hit_mod->health;
                    if (damage_dealt < 0) damage_dealt = 0;

                    if (hit_mod->health <= 0) {
                        // Module destroyed — emit event and remove it
                        log_info("💥 Projectile %u (inside hull) destroyed module %u on ship %u",
                                 proj->id, mod_id, ship->id);

                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id          = ship->id;
                            ev->module_id        = mod_id;
                            ev->is_breach        = true;
                            ev->is_sink          = false;
                            ev->destroyed        = true;
                            ev->damage_dealt     = damage_dealt;
                            ev->hit_x            = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y            = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id  = proj->firing_ship_id;
                        }

                        /* Award XP to the attacker ship */
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                        }

                        memmove(&ship->modules[hit_m], &ship->modules[hit_m + 1],
                                (ship->module_count - hit_m - 1) * sizeof(ShipModule));
                        ship->module_count--;
                    } else {
                        log_info("💥 Projectile %u hit module %u on ship %u — %d HP remaining",
                                 proj->id, mod_id, ship->id, (int)hit_mod->health);

                        // Non-fatal hit — still emit event for damage numbers
                        if (sim->hit_event_count < MAX_HIT_EVENTS) {
                            struct HitEvent* ev = &sim->hit_events[sim->hit_event_count++];
                            ev->ship_id          = ship->id;
                            ev->module_id        = mod_id;
                            ev->is_breach        = true;
                            ev->is_sink          = false;
                            ev->destroyed        = false;
                            ev->damage_dealt     = damage_dealt;
                            ev->hit_x            = Q16_TO_FLOAT(proj->position.x);
                            ev->hit_y            = Q16_TO_FLOAT(proj->position.y);
                            ev->shooter_ship_id  = proj->firing_ship_id;
                        }

                        /* Award XP to the attacker ship */
                        if (proj->firing_ship_id != INVALID_ENTITY_ID) {
                            struct Ship* attacker = sim_get_ship(sim, (entity_id)proj->firing_ship_id);
                            if (attacker)
                                attacker->level_stats.xp += 10u + (uint32_t)(damage_dealt / 100.0f);
                        }
                    }

                    // Projectile absorbed regardless of whether module was destroyed
                    memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                            (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                    sim->projectile_count--;
                    removed = true;
                }
                // No module hit this tick — ball keeps traveling inside the hull.
                // It will either hit an interior module next tick, or exit through the far
                // hull wall (detected by !inside_hull above, which clears inside_ship_id and
                // lets the ball continue flying).  The bounding-circle exit handler (above the
                // narrow-phase) is the safety net if the ball somehow escapes without exiting
                // the polygon cleanly.
                if (!removed) proj->ticks_inside++;
                continue; // still traveling inside — skip remaining ship code
            }

        }

        // ---- Player collision (unchanged) ----
        for (uint16_t j = 0; j < sim->player_count && !removed; j++) {
            struct Player* player = &sim->players[j];
            if (player->id == proj->owner_id) continue;
            if (player->ship_id == proj->owner_id) continue;

            float dx = Q16_TO_FLOAT(player->position.x) - Q16_TO_FLOAT(proj->position.x);
            float dy = Q16_TO_FLOAT(player->position.y) - Q16_TO_FLOAT(proj->position.y);
            float dist_sq = dx*dx + dy*dy;
            const float player_r = CLIENT_TO_SERVER(16.0f);
            if (dist_sq < player_r * player_r) {
                player->health = player->health > Q16_TO_INT(proj->damage) ?
                                 player->health - Q16_TO_INT(proj->damage) : 0;
                log_info("💀 Projectile %u hit player %u for %d damage (health: %d) at (%.1f, %.1f)",
                         proj->id, player->id, Q16_TO_INT(proj->damage), player->health,
                         Q16_TO_FLOAT(proj->position.x), Q16_TO_FLOAT(proj->position.y));

                memmove(&sim->projectiles[i], &sim->projectiles[i + 1],
                        (sim->projectile_count - i - 1) * sizeof(struct Projectile));
                sim->projectile_count--;
                removed = true;
            }
        }

        if (!removed) i++;
    }
}

/**
 * Handle player-to-player collisions — hybrid Baumgarte impulse solver.
 *
 * Uses float arithmetic throughout to avoid Q16 fixed-point overflow.
 * Impulse is applied only to the normal (separating) component so tangential
 * (sliding) velocity is preserved — players slide past each other naturally.
 *
 * Position correction is spread over multiple frames (Baumgarte) so there
 * are no jarring teleports when players overlap slightly.
 */
static void handle_player_player_collisions(struct Sim* sim) {
    if (sim->player_count < 2) return;

    /* Tune these constants to feel right in-game:
     *   RESTITUTION — bounciness on impact (0 = sticky, 1 = fully elastic)
     *   BAUMGARTE   — fraction of positional error corrected per frame
     *   SLOP_SU     — ignored penetration (prevents vibration from float error)
     *   INV_DT      — 1 / timestep (30 Hz → 30) */
    static const float RESTITUTION = 0.25f;
    static const float BAUMGARTE   = 0.4f;
    static const float SLOP_SU     = 0.02f;
    static const float INV_DT      = 30.0f;

    for (uint16_t i = 0; i < sim->player_count; i++) {
        for (uint16_t j = i + 1; j < sim->player_count; j++) {
            struct Player* p1 = &sim->players[i];
            struct Player* p2 = &sim->players[j];

            float dx = Q16_TO_FLOAT(p2->position.x) - Q16_TO_FLOAT(p1->position.x);
            float dy = Q16_TO_FLOAT(p2->position.y) - Q16_TO_FLOAT(p1->position.y);
            float dist_sq = dx * dx + dy * dy;

            float r1       = Q16_TO_FLOAT(p1->radius);
            float r2       = Q16_TO_FLOAT(p2->radius);
            float min_dist = r1 + r2;

            if (dist_sq >= min_dist * min_dist) continue;   /* no overlap — skip */

            float dist = sqrtf(dist_sq);

            /* Degenerate: perfectly stacked — nudge apart and skip impulse */
            if (dist < 0.001f) {
                p1->position.x -= Q16_FROM_FLOAT(0.05f);
                p2->position.x += Q16_FROM_FLOAT(0.05f);
                continue;
            }

            /* Collision normal pointing from p1 toward p2 */
            float nx  = dx / dist;
            float ny  = dy / dist;
            float pen = min_dist - dist;    /* penetration depth (> 0 when overlapping) */

            /* ── Baumgarte positional correction ──
             * Move each player β/2 * max(pen − slop, 0) along the normal.
             * Spreading the correction prevents teleport artifacts while the
             * velocity impulse below prevents re-penetration next frame. */
            float corr = BAUMGARTE * fmaxf(pen - SLOP_SU, 0.0f) * 0.5f;
            p1->position.x = Q16_FROM_FLOAT(Q16_TO_FLOAT(p1->position.x) - corr * nx);
            p1->position.y = Q16_FROM_FLOAT(Q16_TO_FLOAT(p1->position.y) - corr * ny);
            p2->position.x = Q16_FROM_FLOAT(Q16_TO_FLOAT(p2->position.x) + corr * nx);
            p2->position.y = Q16_FROM_FLOAT(Q16_TO_FLOAT(p2->position.y) + corr * ny);

            /* ── Velocity impulse with warm starting ──
             * Relative velocity of p2 w.r.t. p1 along the collision normal. */
            float v1x = Q16_TO_FLOAT(p1->velocity.x);
            float v1y = Q16_TO_FLOAT(p1->velocity.y);
            float v2x = Q16_TO_FLOAT(p2->velocity.x);
            float v2y = Q16_TO_FLOAT(p2->velocity.y);

            /* Look up warm-start from previous tick */
            struct ContactEntry* pp_ce = contact_cache_find(&sim->contact_cache, p1->id, p2->id);
            float P_n_warm = 0.0f;
            if (pp_ce && pp_ce->n_contacts > 0) {
                P_n_warm = pp_ce->P_n[0] * 0.8f;   /* 80% of last tick */
                if (P_n_warm > 0.0f) {
                    /* Apply warm-start: push apart along normal */
                    v1x -= P_n_warm * 0.5f * nx;
                    v1y -= P_n_warm * 0.5f * ny;
                    v2x += P_n_warm * 0.5f * nx;
                    v2y += P_n_warm * 0.5f * ny;
                }
            }

            float vn  = (v2x - v1x) * nx + (v2y - v1y) * ny;

            float J = 0.0f;
            /* Only resolve if players are approaching */
            if (vn < 0.0f) {
                /* Baumgarte velocity bias — adds a small "push apart" velocity
                 * proportional to remaining penetration to resist re-penetration. */
                float bias = BAUMGARTE * INV_DT * fmaxf(pen - SLOP_SU, 0.0f);

                /* Equal-mass impulse: J = (-(1+e)*vn + bias) / (1/m1 + 1/m2)
                 * With unit masses denominator = 2, so multiply by 0.5. */
                J = (-(1.0f + RESTITUTION) * vn + bias) * 0.5f;
                if (J < 0.0f) J = 0.0f;

                /* Apply impulse strictly along the normal — tangential (sliding)
                 * velocity is left intact so players don't lose lateral momentum. */
                p1->velocity.x = Q16_FROM_FLOAT(v1x - J * nx);
                p1->velocity.y = Q16_FROM_FLOAT(v1y - J * ny);
                p2->velocity.x = Q16_FROM_FLOAT(v2x + J * nx);
                p2->velocity.y = Q16_FROM_FLOAT(v2y + J * ny);
            }

            /* Store into contact cache for next tick's warm start */
            {
                struct ContactEntry* pp_ce_w = contact_cache_upsert(&sim->contact_cache, p1->id, p2->id);
                pp_ce_w->last_tick = sim->tick;
                pp_ce_w->n_contacts = 1;
                pp_ce_w->P_n[0] = J;
            }
        }
    }
}

// Helper: Check if point is inside polygon using ray casting
static bool point_in_polygon(Vec2Q16 point, const struct Ship* ship) {
    bool inside = false;
    
    for (uint8_t i = 0, j = ship->hull_vertex_count - 1; i < ship->hull_vertex_count; j = i++) {
        // Transform hull vertices to world space
        Vec2Q16 vi = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
        Vec2Q16 vj = transform_hull_vertex(ship->hull_vertices[j], ship->position, ship->rotation);
        
        // Ray casting algorithm
        if (((vi.y > point.y) != (vj.y > point.y)) &&
            (point.x < q16_add_sat(vi.x, q16_mul(q16_div(q16_sub_sat(vj.x, vi.x), 
                                                          q16_sub_sat(vj.y, vi.y)),
                                                  q16_sub_sat(point.y, vi.y))))) {
            inside = !inside;
        }
    }
    
    return inside;
}

// Helper: Find closest point on ship hull edge to player
static Vec2Q16 closest_point_on_hull(Vec2Q16 player_pos, const struct Ship* ship, q16_t* out_distance, Vec2Q16* out_edge_normal) {
    Vec2Q16 closest = player_pos;
    Vec2Q16 edge_normal = {0, 0};
    q16_t min_dist_sq = Q16_MAX;
    
    for (uint8_t i = 0; i < ship->hull_vertex_count; i++) {
        uint8_t next_i = (i + 1) % ship->hull_vertex_count;
        
        Vec2Q16 v1 = transform_hull_vertex(ship->hull_vertices[i], ship->position, ship->rotation);
        Vec2Q16 v2 = transform_hull_vertex(ship->hull_vertices[next_i], ship->position, ship->rotation);
        
        // Find closest point on line segment v1-v2 to player_pos
        Vec2Q16 edge = vec2_sub(v2, v1);
        Vec2Q16 to_player = vec2_sub(player_pos, v1);
        
        q16_t edge_length_sq = vec2_length_sq(edge);
        if (edge_length_sq < Q16_FROM_FLOAT(0.0001f)) continue; // Skip degenerate edges
        
        // Project player onto edge: t = dot(to_player, edge) / |edge|^2
        q16_t t = q16_div(vec2_dot(to_player, edge), edge_length_sq);
        
        // Clamp t to [0, 1] to stay on segment
        if (t < 0) t = 0;
        if (t > Q16_ONE) t = Q16_ONE;
        
        // Closest point on edge
        Vec2Q16 point_on_edge = {
            q16_add_sat(v1.x, q16_mul(edge.x, t)),
            q16_add_sat(v1.y, q16_mul(edge.y, t))
        };
        
        q16_t dist_sq = vec2_length_sq(vec2_sub(player_pos, point_on_edge));
        
        if (dist_sq < min_dist_sq) {
            min_dist_sq = dist_sq;
            closest = point_on_edge;
            
            // Calculate edge normal (perpendicular to edge, pointing outward)
            // For CCW winding, normal = (-edge.y, edge.x) points outward (right side)
            q16_t edge_length = vec2_length(edge);
            if (edge_length > Q16_FROM_FLOAT(0.01f)) {
                edge_normal.x = -q16_div(edge.y, edge_length);
                edge_normal.y = q16_div(edge.x, edge_length);
                
                // Ensure normal points away from ship center
                Vec2Q16 edge_center = {
                    (v1.x >> 1) + (v2.x >> 1),
                    (v1.y >> 1) + (v2.y >> 1)
                };
                Vec2Q16 to_center = vec2_sub(ship->position, edge_center);
                if (vec2_dot(edge_normal, to_center) > 0) {
                    // Normal pointing inward, flip it
                    edge_normal.x = -edge_normal.x;
                    edge_normal.y = -edge_normal.y;
                }
            }
        }
    }
    
    if (out_distance) {
        *out_distance = vec2_length(vec2_sub(player_pos, closest));
    }
    
    if (out_edge_normal) {
        *out_edge_normal = edge_normal;
    }
    
    return closest;
}

void handle_player_ship_collisions(struct Sim* sim) {
    // Debug log periodically (disabled — too noisy)
    static uint32_t debug_count = 0;
    bool should_log = false; (void)(debug_count++);
    
    // First, check for swimming player collisions with ship hulls
    for (uint16_t i = 0; i < sim->player_count; i++) {
        struct Player* player = &sim->players[i];
        
        // Only check collision for swimming players (not on a ship)
        if (player->ship_id != INVALID_ENTITY_ID) continue;
        
        // Check collision with all ships
        for (uint16_t s = 0; s < sim->ship_count; s++) {
            struct Ship* ship = &sim->ships[s];
            
            // Quick broad-phase check using bounding radius
            Vec2Q16 diff = vec2_sub(player->position, ship->position);
            q16_t dist_sq = vec2_length_sq(diff);
            q16_t check_radius = q16_add_sat(ship->bounding_radius, player->radius);
            q16_t check_radius_sq = q16_mul(check_radius, check_radius);
            
            if (should_log) {
                log_info("🔍 Collision check P%u vs S%u: dist=%.2f, check_radius=%.2f, hull_verts=%u",
                    player->id, ship->id, 
                    Q16_TO_FLOAT(vec2_length(diff)), 
                    Q16_TO_FLOAT(check_radius),
                    ship->hull_vertex_count);
            }
            
            if (dist_sq > check_radius_sq) continue; // Too far away
            
            // Check if player is inside ship hull polygon
            bool inside = point_in_polygon(player->position, ship);
            
            if (inside) {
                // Player is colliding with ship hull - push them out
                q16_t penetration_depth;
                Vec2Q16 edge_normal;
                Vec2Q16 closest_hull_point = closest_point_on_hull(player->position, ship, &penetration_depth, &edge_normal);

                // Use edge normal for collision response
                Vec2Q16 normal = edge_normal;
                q16_t normal_length = vec2_length(normal);
                if (normal_length < Q16_FROM_FLOAT(0.01f)) {
                    Vec2Q16 separation = vec2_sub(player->position, closest_hull_point);
                    q16_t sep_length = vec2_length(separation);
                    if (sep_length > Q16_FROM_FLOAT(0.01f)) {
                        normal = vec2_normalize(separation);
                    } else {
                        normal = vec2_normalize(vec2_sub(player->position, ship->position));
                    }
                }

                /* ── Baumgarte positional correction ──
                 * Compute signed penetration along the outward edge normal and
                 * spread the correction over a couple of frames (β = 0.5) to
                 * avoid jarring teleports.  The velocity impulse below prevents
                 * re-penetration on the next frame. */
                {
                    float pnx = Q16_TO_FLOAT(normal.x), pny = Q16_TO_FLOAT(normal.y);
                    float ppx = Q16_TO_FLOAT(player->position.x);
                    float ppy = Q16_TO_FLOAT(player->position.y);
                    float hpx = Q16_TO_FLOAT(closest_hull_point.x);
                    float hpy = Q16_TO_FLOAT(closest_hull_point.y);
                    /* Signed distance of player centre along outward normal from
                     * the hull edge (negative → player is inside the hull). */
                    float d_n    = (ppx - hpx) * pnx + (ppy - hpy) * pny;
                    float pen_ps = Q16_TO_FLOAT(player->radius) - d_n; /* > 0 when penetrating */
                    static const float PSHIP_BETA = 0.5f;
                    float corr_ps = PSHIP_BETA * fmaxf(pen_ps, 0.0f);
                    player->position.x = Q16_FROM_FLOAT(ppx + corr_ps * pnx);
                    player->position.y = Q16_FROM_FLOAT(ppy + corr_ps * pny);
                }

                /* ── Dynamic collision response (float to avoid Q16 overflow) ──
                 *
                 * Treat the ship as having infinite mass (no impulse back to ship).
                 * Velocity response relative to the ship surface at the contact point:
                 *
                 *   v_surf = v_ship + ω × r   (surface velocity at contact, 2-D)
                 *   v_rel  = v_player − v_surf (player velocity relative to surface)
                 *   v_n    = v_rel · n          (normal component)
                 *
                 * If v_n < 0 (player approaching the hull):
                 *   J      = −(1 + e) * v_n    (impulse magnitude, static hull = ÷1)
                 *   Apply normal impulse and then kinetic friction on the tangential
                 *   relative sliding velocity.
                 *
                 * After impulse, add back the ship surface velocity so the player
                 * feels the hull "carry" them when the ship is moving or spinning. */
                float nx  = Q16_TO_FLOAT(normal.x);
                float ny  = Q16_TO_FLOAT(normal.y);
                float pvx = Q16_TO_FLOAT(player->velocity.x);
                float pvy = Q16_TO_FLOAT(player->velocity.y);

                /* Ship surface velocity at the contact point */
                float svx = Q16_TO_FLOAT(ship->velocity.x);
                float svy = Q16_TO_FLOAT(ship->velocity.y);
                float omega = Q16_TO_FLOAT(ship->angular_velocity);
                float rx  = Q16_TO_FLOAT(closest_hull_point.x) - Q16_TO_FLOAT(ship->position.x);
                float ry  = Q16_TO_FLOAT(closest_hull_point.y) - Q16_TO_FLOAT(ship->position.y);
                float surf_vx = svx + omega * (-ry);
                float surf_vy = svy + omega * (rx);

                /* Relative velocity of player vs. ship surface */
                float rel_vx = pvx - surf_vx;
                float rel_vy = pvy - surf_vy;
                float vn = rel_vx * nx + rel_vy * ny;

                if (vn < 0.0f) {
                    /* Low restitution — player sticks against the hull rather
                     * than rocketing away; increase for a bouncier feel. */
                    static const float RESTITUTION  = 0.15f;
                    /* Low kinetic friction — player slides smoothly along hull;
                     * increase (max ~1.0) to make them stick/slow down more. */
                    static const float FRICTION      = 0.12f;
                    /* Baumgarte velocity bias — computed from the pre-impulse
                     * penetration to push the player away from the hull surface. */
                    float pnx2 = Q16_TO_FLOAT(normal.x), pny2 = Q16_TO_FLOAT(normal.y);
                    float d_n2 = (Q16_TO_FLOAT(player->position.x) - Q16_TO_FLOAT(closest_hull_point.x)) * pnx2
                               + (Q16_TO_FLOAT(player->position.y) - Q16_TO_FLOAT(closest_hull_point.y)) * pny2;
                    float pen_vb = Q16_TO_FLOAT(player->radius) - d_n2;
                    float bias_ps = (0.4f * 30.0f) * fmaxf(pen_vb - 0.01f, 0.0f);

                    float J = -(1.0f + RESTITUTION) * vn + bias_ps;

                    /* Normal impulse (in relative space) */
                    float new_pvx = pvx + J * nx;
                    float new_pvy = pvy + J * ny;

                    /* Kinetic friction opposes relative sliding along the edge */
                    float rel_tx = rel_vx - vn * nx;
                    float rel_ty = rel_vy - vn * ny;
                    float rel_t_len = sqrtf(rel_tx * rel_tx + rel_ty * rel_ty);
                    if (rel_t_len > 0.001f) {
                        float ft = fminf(FRICTION * J, rel_t_len);
                        new_pvx -= ft * (rel_tx / rel_t_len);
                        new_pvy -= ft * (rel_ty / rel_t_len);
                    }

                    player->velocity.x = Q16_FROM_FLOAT(new_pvx);
                    player->velocity.y = Q16_FROM_FLOAT(new_pvy);
                }

                /* Rate-limited collision log — uncomment for debugging:
                static uint32_t pship_log_count = 0;
                if (pship_log_count++ % 60 == 0)
                    log_info("🚫 Player %u hit ship %u hull (surf_v=%.2f,%.2f omega=%.3f)",
                             player->id, ship->id, surf_vx, surf_vy, omega);
                */
            }
        }
    }
}

int simulation_process_player_input(struct Sim* sim, entity_id player_id, const struct CmdPacket* cmd) {
    if (!sim || !cmd || player_id == INVALID_ENTITY_ID) return -1;
    
    // Find the player
    struct Player* player = sim_get_player(sim, player_id);
    if (!player) {
        log_warn("Player %u not found for input processing", player_id);
        return -1;
    }
    
    // Convert network command to input command and process
    struct InputCmd input_cmd = {0};
    input_cmd.player_id = player_id;
    input_cmd.sequence = cmd->seq;
    input_cmd.client_time = cmd->client_time;
    input_cmd.thrust = cmd->thrust;
    input_cmd.turn = cmd->turn;
    input_cmd.actions = cmd->actions;
    input_cmd.dt_ms = cmd->dt_ms;
    
    sim_process_input(sim, &input_cmd);
    
    return 0;
}

// Missing entity management function
bool sim_destroy_entity(struct Sim* sim, entity_id id) {
    if (!sim || id == INVALID_ENTITY_ID) return false;
    
    // Remove from ships
    for (uint32_t i = 0; i < sim->ship_count; i++) {
        if (sim->ships[i].id == id) {
            // Move last ship to this position
            if (i + 1 < sim->ship_count) {
                sim->ships[i] = sim->ships[sim->ship_count - 1];
            }
            sim->ship_count--;
            return true;
        }
    }
    
    // Remove from players
    for (uint32_t i = 0; i < sim->player_count; i++) {
        if (sim->players[i].id == id) {
            // Move last player to this position
            if (i + 1 < sim->player_count) {
                sim->players[i] = sim->players[sim->player_count - 1];
            }
            sim->player_count--;
            return true;
        }
    }
    
    // Remove from projectiles
    for (uint32_t i = 0; i < sim->projectile_count; i++) {
        if (sim->projectiles[i].id == id) {
            // Move last projectile to this position
            if (i + 1 < sim->projectile_count) {
                sim->projectiles[i] = sim->projectiles[sim->projectile_count - 1];
            }
            sim->projectile_count--;
            return true;
        }
    }
    
    return false; // Entity not found
}