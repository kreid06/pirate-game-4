/**
 * ship_physics.h — Pure float physics for ships, players and projectiles.
 *
 * This is the WASM-facing physics API.  All state is passed by value (no
 * global state, no heap allocation).  The server validates against the
 * identical algorithms expressed in Q16.16 in sim/simulation.c.
 *
 * Coordinate convention:
 *   +X = East, +Y = South (matches client canvas convention).
 *   Angles are in radians, counter-clockwise positive.
 *
 * Integration: semi-implicit Euler (velocity Verlet for rotations).
 */

#ifndef PIRATE_SHIP_PHYSICS_H
#define PIRATE_SHIP_PHYSICS_H

#include "pirate_math.h"
#include "collision.h"
#include <stdint.h>

/* ──────────────────────────────────────────────────────────────────────────
   Physics configuration (per ship class)
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    float mass;               /* kg */
    float moment_of_inertia;  /* kg·m² */
    float max_speed;          /* m/s – velocity cap */
    float max_turn_rate;      /* rad/s – angular velocity cap */
    float water_drag;         /* linear drag per second [0,1] */
    float angular_drag;       /* angular drag per second [0,1] */
    float sail_force;         /* maximum sail thrust (N) */
    float rudder_torque;      /* maximum rudder torque (N·m) */
} ShipPhysicsConfig;

/* Brigantine defaults (matches server ship_init.c values) */
extern const ShipPhysicsConfig SHIP_CONFIG_BRIGANTINE;

/* ──────────────────────────────────────────────────────────────────────────
   Ship state  (pure data, no pointers)
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    Vec2    position;         /* world position (px) */
    Vec2    velocity;         /* world velocity (px/s) */
    float   rotation;         /* heading (radians) */
    float   angular_velocity; /* rad/s */
    float   sail_openness;    /* [0,1] – 1 = full sail */
    float   rudder_angle;     /* radians, [-π/4, π/4] */
} ShipState;

/* ──────────────────────────────────────────────────────────────────────────
   Player state
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    Vec2    position;
    Vec2    velocity;
    float   rotation;       /* facing direction */
    float   radius;
    uint32_t carrier_id;    /* 0 = not on a ship */
} PlayerPhysState;

/* Player movement config */
typedef struct {
    float walk_speed;     /* px/s */
    float sprint_speed;   /* px/s */
    float friction;       /* deceleration factor per second */
} PlayerMoveConfig;

extern const PlayerMoveConfig PLAYER_MOVE_DEFAULT;

/* ──────────────────────────────────────────────────────────────────────────
   Projectile state
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    Vec2    position;
    Vec2    velocity;
    float   lifetime;    /* seconds remaining */
    uint32_t shooter_id;
    uint8_t  active;     /* 0 = can be recycled */
} ProjectileState;

#define PROJECTILE_MAX_LIFETIME 6.0f
#define PROJECTILE_GRAVITY      600.0f  /* px/s² downward (Y+) */

/* ──────────────────────────────────────────────────────────────────────────
   Ship input (one frame)
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    int8_t  sail_delta;     /* -1 = furl, 0 = hold, +1 = unfurl */
    int8_t  rudder_delta;   /* -1 = left, 0 = hold, +1 = right */
} ShipInput;

/* ──────────────────────────────────────────────────────────────────────────
   Simulation functions
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Advance ship physics by dt seconds.
 * @param state   Input/output ship state.
 * @param input   Player control input this tick.
 * @param config  Ship class parameters.
 * @param dt      Delta-time in seconds (typically 1/30).
 */
void ship_physics_step(ShipState *state, const ShipInput *input,
                       const ShipPhysicsConfig *config, float dt);

/**
 * Advance player physics by dt seconds.
 * @param player  Input/output player state.
 * @param move    Movement direction (pre-normalised, world space).
 * @param sprinting  Non-zero if sprint is active.
 * @param config  Movement configuration.
 * @param dt      Delta-time in seconds.
 */
void player_physics_step(PlayerPhysState *player, Vec2 move, int sprinting,
                          const PlayerMoveConfig *config, float dt);

/**
 * Advance projectile physics by dt seconds (gravity + lifetime decay).
 * @return  Non-zero if the projectile is still alive.
 */
int projectile_physics_step(ProjectileState *proj, float dt);

/**
 * Spawn a cannonball from a cannon.
 * @param out        Output projectile state.
 * @param ship       Firing ship state.
 * @param local_pos  Cannon position in ship-local coords.
 * @param muzzle_speed  Speed in px/s.
 * @param shooter_id  Entity ID of the shooter.
 */
void projectile_spawn_cannon(ProjectileState *out, const ShipState *ship,
                              Vec2 local_pos, float muzzle_speed,
                              uint32_t shooter_id);

/**
 * Check collision between projectile and a polygon (e.g. ship hull).
 * Returns a CollisionManifold (hit=0 means no collision).
 */
CollisionManifold projectile_check_poly(const ProjectileState *proj, float radius,
                                         const Polygon *hull);

#endif /* PIRATE_SHIP_PHYSICS_H */
