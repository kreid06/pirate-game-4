/**
 * pirate_math.h — Shared math library for physics engine
 *
 * Pure C, zero dependencies. Used by both server and client (via WASM).
 * All functions are deterministic and reproducible across platforms.
 *
 * Float-precision API. For Q16.16 fixed-point (server determinism), see
 * pirate_fixed.h.
 */

#ifndef PIRATE_MATH_H
#define PIRATE_MATH_H

#include <stdint.h>
#include <math.h>

/* ──────────────────────────────────────────────────────────────────────────
   Vector 2D
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
  float x, y;
} Vec2;

/* Constructors */
static inline Vec2 vec2(float x, float y) {
  return (Vec2){x, y};
}

static inline Vec2 vec2_zero(void) {
  return (Vec2){0.0f, 0.0f};
}

/* Arithmetic */
static inline Vec2 vec2_add(Vec2 a, Vec2 b) {
  return (Vec2){a.x + b.x, a.y + b.y};
}

static inline Vec2 vec2_sub(Vec2 a, Vec2 b) {
  return (Vec2){a.x - b.x, a.y - b.y};
}

static inline Vec2 vec2_mul(Vec2 a, float s) {
  return (Vec2){a.x * s, a.y * s};
}

static inline Vec2 vec2_div(Vec2 a, float s) {
  return (Vec2){a.x / s, a.y / s};
}

/* Geometry */
static inline float vec2_dot(Vec2 a, Vec2 b) {
  return a.x * b.x + a.y * b.y;
}

static inline float vec2_cross(Vec2 a, Vec2 b) {
  return a.x * b.y - a.y * b.x;
}

static inline float vec2_length_sq(Vec2 a) {
  return a.x * a.x + a.y * a.y;
}

float vec2_length(Vec2 a);

Vec2 vec2_normalize(Vec2 a);

static inline Vec2 vec2_perpendicular(Vec2 a) {
  return (Vec2){-a.y, a.x};
}

/* Utilities */
static inline float vec2_distance_sq(Vec2 a, Vec2 b) {
  Vec2 diff = vec2_sub(a, b);
  return vec2_length_sq(diff);
}

float vec2_distance(Vec2 a, Vec2 b);

/* Rotation */
Vec2 vec2_rotate(Vec2 a, float radians);

/* ──────────────────────────────────────────────────────────────────────────
   Matrix 3x3 (for 2D transforms)
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
  float m[9]; /* Row-major: [m00, m01, m02, m10, m11, m12, m20, m21, m22] */
} Mat3;

/* Constructors */
Mat3 mat3_identity(void);
Mat3 mat3_translation(float tx, float ty);
Mat3 mat3_rotation(float radians);
Mat3 mat3_scale(float sx, float sy);

/* Operations */
Mat3 mat3_multiply(Mat3 a, Mat3 b);
Vec2 mat3_transform(Mat3 m, Vec2 v);

Mat3 mat3_inverse(Mat3 m);
float mat3_determinant(Mat3 m);

/* ──────────────────────────────────────────────────────────────────────────
   Utilities
   ────────────────────────────────────────────────────────────────────────── */

#define PIRATE_PI  3.14159265359f
#define PIRATE_TWO_PI (2.0f * PIRATE_PI)

float deg_to_rad(float degrees);
float rad_to_deg(float radians);

/* Clamping */
float clamp(float x, float min_val, float max_val);
float lerp(float a, float b, float t);

/* Bounding circles */
typedef struct {
  Vec2 center;
  float radius;
} Circle;

int circle_overlaps_circle(Circle a, Circle b);
float circle_distance_to_point(Circle c, Vec2 p);

#endif /* PIRATE_MATH_H */
