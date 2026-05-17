/**
 * wasm-bridge.c — JavaScript ↔ C glue layer for Emscripten
 * 
 * Exposes C functions to JavaScript with serialization/deserialization
 * of complex types (Vec2, Mat3, etc.).
 */

#include <emscripten.h>
#include "pirate_math.h"

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
