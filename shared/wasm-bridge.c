/**
 * wasm-bridge.c — JavaScript ↔ C glue layer for Emscripten
 *
 * Exposes C functions to JavaScript with flat (scalar) ABI so that JS can
 * call them without dealing with C struct layouts.  Complex return values
 * are written to caller-allocated output pointers.
 *
 * Memory layout conventions:
 *   Vec2  → two consecutive floats  (8 bytes)
 *   CollisionManifold → int hit, float nx, float ny, float depth, float cx, float cy  (24 bytes)
 */

#include <emscripten.h>
#include "pirate_math.h"
#include "pirate_fixed.h"
#include "collision.h"
#include "ship_physics.h"

/* ──────────────────────────────────────────────────────────────────────────
   Vector 2D Bridge
   ────────────────────────────────────────────────────────────────────────── */

/**
 * JS call: Module.ccall('vec2_length', 'number', ['number', 'number'], [x, y])
 */
EMSCRIPTEN_KEEPALIVE
float vec2_length_wasm(float x, float y) {
  Vec2 v = vec2(x, y);
  return vec2_length(v);
}

/**
 * JS call: Module.ccall('vec2_normalize', 'number', ['number', 'number', 'number'],
 *                       [x, y, result_ptr])
 * Returns normalized x as float, writes y to result_ptr + 0
 */
EMSCRIPTEN_KEEPALIVE
void vec2_normalize_wasm(float x, float y, float* out_x, float* out_y) {
  Vec2 v = vec2(x, y);
  Vec2 n = vec2_normalize(v);
  *out_x = n.x;
  *out_y = n.y;
}

/**
 * JS call: Module.ccall('vec2_rotate', 'number', [...], [x, y, radians, out_ptr])
 */
EMSCRIPTEN_KEEPALIVE
void vec2_rotate_wasm(float x, float y, float radians, float* out_x, float* out_y) {
  Vec2 v = vec2(x, y);
  Vec2 rotated = vec2_rotate(v, radians);
  *out_x = rotated.x;
  *out_y = rotated.y;
}

/**
 * JS call: Module.ccall('vec2_distance', 'number', 
 *                       ['number', 'number', 'number', 'number'],
 *                       [x1, y1, x2, y2])
 */
EMSCRIPTEN_KEEPALIVE
float vec2_distance_wasm(float x1, float y1, float x2, float y2) {
  Vec2 a = vec2(x1, y1);
  Vec2 b = vec2(x2, y2);
  return vec2_distance(a, b);
}

/* ──────────────────────────────────────────────────────────────────────────
   Circle Bridge
   ────────────────────────────────────────────────────────────────────────── */

/**
 * JS call: Module.ccall('circle_overlaps_circle', 'number',
 *                       ['number', 'number', 'number', 'number', 'number', 'number'],
 *                       [cx1, cy1, r1, cx2, cy2, r2])
 */
EMSCRIPTEN_KEEPALIVE
int circle_overlaps_circle_wasm(float cx1, float cy1, float r1,
                                 float cx2, float cy2, float r2) {
  Circle a = {vec2(cx1, cy1), r1};
  Circle b = {vec2(cx2, cy2), r2};
  return circle_overlaps_circle(a, b);
}

/* ──────────────────────────────────────────────────────────────────────────
   Utilities
   ────────────────────────────────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
float deg_to_rad_wasm(float degrees) {
  return deg_to_rad(degrees);
}

EMSCRIPTEN_KEEPALIVE
float rad_to_deg_wasm(float radians) {
  return rad_to_deg(radians);
}

/* ──────────────────────────────────────────────────────────────────────────
   Collision bridge
   ──────────────────────────────────────────────────────────────────────────
   All manifold results are written to a 24-byte output buffer:
     [0]  int   hit          (as float 0.0 or 1.0 for JS compatibility)
     [4]  float normal_x
     [8]  float normal_y
     [12] float depth
     [16] float contact_x
     [20] float contact_y
   ────────────────────────────────────────────────────────────────────────── */

static void write_manifold(float *out, const CollisionManifold *m) {
  out[0] = (float)m->hit;
  out[1] = m->normal.x;
  out[2] = m->normal.y;
  out[3] = m->depth;
  out[4] = m->contact.x;
  out[5] = m->contact.y;
}

/**
 * circle_vs_circle_wasm(cx1,cy1,r1, cx2,cy2,r2, out_ptr)
 * out_ptr: 6 floats (24 bytes) allocated by caller.
 */
EMSCRIPTEN_KEEPALIVE
void circle_vs_circle_wasm(float cx1, float cy1, float r1,
                             float cx2, float cy2, float r2,
                             float *out) {
  Circle a = {vec2(cx1, cy1), r1};
  Circle b = {vec2(cx2, cy2), r2};
  CollisionManifold m = collide_circle_circle(a, b);
  write_manifold(out, &m);
}

/**
 * aabb_vs_circle_wasm(min_x,min_y,max_x,max_y, cx,cy,r, out_ptr)
 */
EMSCRIPTEN_KEEPALIVE
void aabb_vs_circle_wasm(float min_x, float min_y, float max_x, float max_y,
                          float cx, float cy, float r,
                          float *out) {
  AABB   box = {{min_x, min_y}, {max_x, max_y}};
  Circle c   = {vec2(cx, cy), r};
  CollisionManifold m = collide_aabb_circle(box, c);
  write_manifold(out, &m);
}

/**
 * poly_vs_circle_wasm(verts_ptr, vert_count, cx, cy, r, out_ptr)
 * verts_ptr: vert_count * 8 bytes (pairs of floats).
 * out_ptr:   6 floats (24 bytes).
 */
EMSCRIPTEN_KEEPALIVE
void poly_vs_circle_wasm(const float *verts, int count,
                          float cx, float cy, float r,
                          float *out) {
  Polygon poly;
  int n = count < PIRATE_MAX_POLY_VERTS ? count : PIRATE_MAX_POLY_VERTS;
  for (int i = 0; i < n; i++) {
    poly.verts[i].x = verts[i * 2];
    poly.verts[i].y = verts[i * 2 + 1];
  }
  poly.count = n;
  Circle c = {vec2(cx, cy), r};
  CollisionManifold m = collide_poly_circle(&poly, c);
  write_manifold(out, &m);
}

/**
 * poly_vs_poly_wasm(verts_a, count_a, verts_b, count_b, out_ptr)
 */
EMSCRIPTEN_KEEPALIVE
void poly_vs_poly_wasm(const float *verts_a, int count_a,
                        const float *verts_b, int count_b,
                        float *out) {
  Polygon a, b;
  int na = count_a < PIRATE_MAX_POLY_VERTS ? count_a : PIRATE_MAX_POLY_VERTS;
  int nb = count_b < PIRATE_MAX_POLY_VERTS ? count_b : PIRATE_MAX_POLY_VERTS;
  for (int i = 0; i < na; i++) { a.verts[i].x = verts_a[i*2]; a.verts[i].y = verts_a[i*2+1]; }
  for (int i = 0; i < nb; i++) { b.verts[i].x = verts_b[i*2]; b.verts[i].y = verts_b[i*2+1]; }
  a.count = na; b.count = nb;
  CollisionManifold m = collide_poly_poly(&a, &b);
  write_manifold(out, &m);
}

/* ──────────────────────────────────────────────────────────────────────────
   Ship physics bridge
   ──────────────────────────────────────────────────────────────────────────
   ShipState layout in memory (caller's Float32Array, 7 floats = 28 bytes):
     [0] pos_x  [1] pos_y  [2] vel_x  [3] vel_y
     [4] rotation  [5] angular_velocity  [6] sail_openness  [7] rudder_angle
   ShipInput: two int8 values packed into one int32.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * ship_step_wasm(state_ptr, sail_delta, rudder_delta, dt)
 * state_ptr: 8 floats (32 bytes), modified in-place.
 */
EMSCRIPTEN_KEEPALIVE
void ship_step_wasm(float *s, int sail_delta, int rudder_delta, float dt) {
  ShipState state;
  state.position.x       = s[0];
  state.position.y       = s[1];
  state.velocity.x       = s[2];
  state.velocity.y       = s[3];
  state.rotation         = s[4];
  state.angular_velocity = s[5];
  state.sail_openness    = s[6];
  state.rudder_angle     = s[7];

  ShipInput input = {(int8_t)sail_delta, (int8_t)rudder_delta};
  ship_physics_step(&state, &input, &SHIP_CONFIG_BRIGANTINE, dt);

  s[0] = state.position.x;
  s[1] = state.position.y;
  s[2] = state.velocity.x;
  s[3] = state.velocity.y;
  s[4] = state.rotation;
  s[5] = state.angular_velocity;
  s[6] = state.sail_openness;
  s[7] = state.rudder_angle;
}

/**
 * player_step_wasm(state_ptr, move_x, move_y, sprinting, dt)
 * state_ptr: 5 floats (20 bytes): pos_x, pos_y, vel_x, vel_y, rotation.
 */
EMSCRIPTEN_KEEPALIVE
void player_step_wasm(float *s, float move_x, float move_y, int sprinting, float dt) {
  PlayerPhysState p;
  p.position.x = s[0]; p.position.y = s[1];
  p.velocity.x = s[2]; p.velocity.y = s[3];
  p.rotation   = s[4];
  p.radius     = 0.0f;
  p.carrier_id = 0;

  player_physics_step(&p, vec2(move_x, move_y), sprinting, &PLAYER_MOVE_DEFAULT, dt);

  s[0] = p.position.x; s[1] = p.position.y;
  s[2] = p.velocity.x; s[3] = p.velocity.y;
  s[4] = p.rotation;
}

/**
 * projectile_step_wasm(state_ptr, dt) → 1 if still alive, 0 if expired.
 * state_ptr: 5 floats (20 bytes): pos_x, pos_y, vel_x, vel_y, lifetime.
 */
EMSCRIPTEN_KEEPALIVE
int projectile_step_wasm(float *s, float dt) {
  ProjectileState p;
  p.position.x = s[0]; p.position.y = s[1];
  p.velocity.x = s[2]; p.velocity.y = s[3];
  p.lifetime   = s[4];
  p.active     = 1;
  p.shooter_id = 0;

  int alive = projectile_physics_step(&p, dt);

  s[0] = p.position.x; s[1] = p.position.y;
  s[2] = p.velocity.x; s[3] = p.velocity.y;
  s[4] = p.lifetime;
  return alive;
}
