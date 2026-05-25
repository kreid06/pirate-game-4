/**
 * ship_physics.c — Pure float physics implementation.
 */

#include "ship_physics.h"
#include <math.h>
#include <string.h>

/* ──────────────────────────────────────────────────────────────────────────
   Default configurations
   ────────────────────────────────────────────────────────────────────────── */

const ShipPhysicsConfig SHIP_CONFIG_BRIGANTINE = {
    .mass               = 50000.0f,
    .moment_of_inertia  = 500000.0f,
    .max_speed          = 450.0f,
    .max_turn_rate      = 0.5f,
    .water_drag         = 0.98f,
    .angular_drag       = 0.92f,
    .sail_force         = 18000.0f,
    .rudder_torque      = 12000.0f,
};

const PlayerMoveConfig PLAYER_MOVE_DEFAULT = {
    .walk_speed   = 120.0f,
    .sprint_speed = 200.0f,
    .friction     = 0.85f,
};

/* ──────────────────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────────────────── */

static float clampf(float x, float mn, float mx) {
    return x < mn ? mn : (x > mx ? mx : x);
}

/* ──────────────────────────────────────────────────────────────────────────
   Ship physics step
   ────────────────────────────────────────────────────────────────────────── */

void ship_physics_step(ShipState *state, const ShipInput *input,
                       const ShipPhysicsConfig *cfg, float dt) {
    /* --- Sail control --- */
    if (input->sail_delta > 0)
        state->sail_openness = clampf(state->sail_openness + 0.5f * dt, 0.0f, 1.0f);
    else if (input->sail_delta < 0)
        state->sail_openness = clampf(state->sail_openness - 0.5f * dt, 0.0f, 1.0f);

    /* --- Rudder control --- */
    const float RUDDER_SPEED = 1.2f; /* rad/s */
    const float RUDDER_MAX   = 0.7854f; /* π/4 */
    if (input->rudder_delta > 0)
        state->rudder_angle = clampf(state->rudder_angle + RUDDER_SPEED * dt,
                                     -RUDDER_MAX, RUDDER_MAX);
    else if (input->rudder_delta < 0)
        state->rudder_angle = clampf(state->rudder_angle - RUDDER_SPEED * dt,
                                     -RUDDER_MAX, RUDDER_MAX);
    else
        state->rudder_angle *= 0.9f; /* auto-centre */

    /* --- Thrust force (along ship heading) --- */
    float thrust = cfg->sail_force * state->sail_openness;
    Vec2 heading = vec2(cosf(state->rotation), sinf(state->rotation));
    Vec2 force   = vec2_mul(heading, thrust);

    /* --- Apply linear force → acceleration → velocity --- */
    Vec2 accel = vec2_div(force, cfg->mass);
    state->velocity = vec2_add(state->velocity, vec2_mul(accel, dt));

    /* --- Rudder torque (scales with speed) --- */
    float speed = vec2_length(state->velocity);
    float torque = cfg->rudder_torque * state->rudder_angle *
                   clampf(speed / cfg->max_speed, 0.0f, 1.0f);
    float ang_accel = torque / cfg->moment_of_inertia;
    state->angular_velocity += ang_accel * dt;

    /* --- Drag --- */
    float drag_factor = powf(cfg->water_drag,   dt);
    float adrag_factor = powf(cfg->angular_drag, dt);
    state->velocity         = vec2_mul(state->velocity, drag_factor);
    state->angular_velocity *= adrag_factor;

    /* --- Speed cap --- */
    float spd = vec2_length(state->velocity);
    if (spd > cfg->max_speed)
        state->velocity = vec2_mul(vec2_normalize(state->velocity), cfg->max_speed);

    /* --- Angular velocity cap --- */
    state->angular_velocity = clampf(state->angular_velocity,
                                     -cfg->max_turn_rate, cfg->max_turn_rate);

    /* --- Integrate position & rotation --- */
    state->position = vec2_add(state->position, vec2_mul(state->velocity, dt));
    state->rotation += state->angular_velocity * dt;

    /* --- Wrap rotation to [-π, π] --- */
    while (state->rotation >  PIRATE_PI) state->rotation -= PIRATE_TWO_PI;
    while (state->rotation < -PIRATE_PI) state->rotation += PIRATE_TWO_PI;
}

/* ──────────────────────────────────────────────────────────────────────────
   Player physics step
   ────────────────────────────────────────────────────────────────────────── */

void player_physics_step(PlayerPhysState *player, Vec2 move, int sprinting,
                          const PlayerMoveConfig *cfg, float dt) {
    float target_speed = sprinting ? cfg->sprint_speed : cfg->walk_speed;

    float len = vec2_length(move);
    if (len > 1e-6f) {
        Vec2 dir    = vec2_div(move, len);
        Vec2 target = vec2_mul(dir, target_speed);
        /* Lerp toward target velocity */
        player->velocity.x += (target.x - player->velocity.x) * (1.0f - cfg->friction);
        player->velocity.y += (target.y - player->velocity.y) * (1.0f - cfg->friction);
    } else {
        /* Friction deceleration */
        player->velocity = vec2_mul(player->velocity, powf(cfg->friction, dt * 60.0f));
    }

    player->position = vec2_add(player->position, vec2_mul(player->velocity, dt));
}

/* ──────────────────────────────────────────────────────────────────────────
   Projectile physics step
   ────────────────────────────────────────────────────────────────────────── */

int projectile_physics_step(ProjectileState *proj, float dt) {
    if (!proj->active) return 0;

    proj->lifetime -= dt;
    if (proj->lifetime <= 0.0f) {
        proj->active = 0;
        return 0;
    }

    /* Gravity */
    proj->velocity.y += PROJECTILE_GRAVITY * dt;

    /* Integrate */
    proj->position = vec2_add(proj->position, vec2_mul(proj->velocity, dt));
    return 1;
}

/* ──────────────────────────────────────────────────────────────────────────
   Projectile spawn
   ────────────────────────────────────────────────────────────────────────── */

void projectile_spawn_cannon(ProjectileState *out, const ShipState *ship,
                              Vec2 local_pos, float muzzle_speed,
                              uint32_t shooter_id) {
    /* Transform local_pos to world space */
    Vec2 world_pos = vec2_add(ship->position, vec2_rotate(local_pos, ship->rotation));

    /* Muzzle direction: perpendicular to ship (cannons fire sideways) */
    /* NOTE: caller should pass local_pos.x as sign for port/starboard */
    Vec2 fire_dir = vec2_rotate(vec2(0.0f, 1.0f), ship->rotation);
    if (local_pos.x < 0.0f) fire_dir = vec2_mul(fire_dir, -1.0f);

    memset(out, 0, sizeof(*out));
    out->position   = world_pos;
    out->velocity   = vec2_add(ship->velocity,
                               vec2_mul(fire_dir, muzzle_speed));
    out->lifetime   = PROJECTILE_MAX_LIFETIME;
    out->shooter_id = shooter_id;
    out->active     = 1;
}

/* ──────────────────────────────────────────────────────────────────────────
   Projectile vs polygon collision
   ────────────────────────────────────────────────────────────────────────── */

CollisionManifold projectile_check_poly(const ProjectileState *proj, float radius,
                                         const Polygon *hull) {
    Circle c = {proj->position, radius};
    return collide_poly_circle(hull, c);
}
