/**
 * pirate_math.c — Math implementation
 */

#include "pirate_math.h"

/* ──────────────────────────────────────────────────────────────────────────
   Vec2 Implementation
   ────────────────────────────────────────────────────────────────────────── */

float vec2_length(Vec2 a) {
  return sqrtf(vec2_length_sq(a));
}

Vec2 vec2_normalize(Vec2 a) {
  float len = vec2_length(a);
  if (len < 1e-6f) return vec2_zero();
  return vec2_div(a, len);
}

float vec2_distance(Vec2 a, Vec2 b) {
  return vec2_length(vec2_sub(a, b));
}

Vec2 vec2_rotate(Vec2 a, float radians) {
  float c = cosf(radians);
  float s = sinf(radians);
  return vec2(a.x * c - a.y * s, a.x * s + a.y * c);
}

/* ──────────────────────────────────────────────────────────────────────────
   Mat3 Implementation
   ────────────────────────────────────────────────────────────────────────── */

Mat3 mat3_identity(void) {
  Mat3 m = {0};
  m.m[0] = 1.0f;
  m.m[4] = 1.0f;
  m.m[8] = 1.0f;
  return m;
}

Mat3 mat3_translation(float tx, float ty) {
  Mat3 m = mat3_identity();
  m.m[2] = tx;
  m.m[5] = ty;
  return m;
}

Mat3 mat3_rotation(float radians) {
  float c = cosf(radians);
  float s = sinf(radians);
  Mat3 m = {0};
  m.m[0] = c;  m.m[1] = -s; m.m[2] = 0.0f;
  m.m[3] = s;  m.m[4] = c;  m.m[5] = 0.0f;
  m.m[6] = 0.0f; m.m[7] = 0.0f; m.m[8] = 1.0f;
  return m;
}

Mat3 mat3_scale(float sx, float sy) {
  Mat3 m = mat3_identity();
  m.m[0] = sx;
  m.m[4] = sy;
  return m;
}

Mat3 mat3_multiply(Mat3 a, Mat3 b) {
  Mat3 result = {0};
  for (int row = 0; row < 3; row++) {
    for (int col = 0; col < 3; col++) {
      float sum = 0.0f;
      for (int k = 0; k < 3; k++) {
        sum += a.m[row * 3 + k] * b.m[k * 3 + col];
      }
      result.m[row * 3 + col] = sum;
    }
  }
  return result;
}

Vec2 mat3_transform(Mat3 m, Vec2 v) {
  float x = m.m[0] * v.x + m.m[1] * v.y + m.m[2];
  float y = m.m[3] * v.x + m.m[4] * v.y + m.m[5];
  float w = m.m[6] * v.x + m.m[7] * v.y + m.m[8];
  if (fabsf(w) > 1e-6f) {
    x /= w;
    y /= w;
  }
  return vec2(x, y);
}

float mat3_determinant(Mat3 m) {
  return m.m[0] * (m.m[4] * m.m[8] - m.m[5] * m.m[7]) -
         m.m[1] * (m.m[3] * m.m[8] - m.m[5] * m.m[6]) +
         m.m[2] * (m.m[3] * m.m[7] - m.m[4] * m.m[6]);
}

Mat3 mat3_inverse(Mat3 m) {
  float det = mat3_determinant(m);
  if (fabsf(det) < 1e-6f) return mat3_identity();

  Mat3 result = {0};
  result.m[0] = (m.m[4] * m.m[8] - m.m[5] * m.m[7]) / det;
  result.m[1] = (m.m[2] * m.m[7] - m.m[1] * m.m[8]) / det;
  result.m[2] = (m.m[1] * m.m[5] - m.m[2] * m.m[4]) / det;

  result.m[3] = (m.m[5] * m.m[6] - m.m[3] * m.m[8]) / det;
  result.m[4] = (m.m[0] * m.m[8] - m.m[2] * m.m[6]) / det;
  result.m[5] = (m.m[2] * m.m[3] - m.m[0] * m.m[5]) / det;

  result.m[6] = (m.m[3] * m.m[7] - m.m[4] * m.m[6]) / det;
  result.m[7] = (m.m[1] * m.m[6] - m.m[0] * m.m[7]) / det;
  result.m[8] = (m.m[0] * m.m[4] - m.m[1] * m.m[3]) / det;

  return result;
}

/* ──────────────────────────────────────────────────────────────────────────
   Utilities
   ────────────────────────────────────────────────────────────────────────── */

float deg_to_rad(float degrees) {
  return degrees * PI / 180.0f;
}

float rad_to_deg(float radians) {
  return radians * 180.0f / PI;
}

float clamp(float x, float min_val, float max_val) {
  if (x < min_val) return min_val;
  if (x > max_val) return max_val;
  return x;
}

float lerp(float a, float b, float t) {
  return a + (b - a) * clamp(t, 0.0f, 1.0f);
}

int circle_overlaps_circle(Circle a, Circle b) {
  float dist_sq = vec2_distance_sq(a.center, b.center);
  float min_dist = a.radius + b.radius;
  return dist_sq < min_dist * min_dist;
}

float circle_distance_to_point(Circle c, Vec2 p) {
  return vec2_distance(c.center, p) - c.radius;
}
