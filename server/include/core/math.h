#ifndef CORE_MATH_H
#define CORE_MATH_H

#include <stdint.h>
#include <stdbool.h>

// Q16.16 Fixed-point math for determinism
typedef int32_t q16_t;
typedef int64_t q32_t;

// Constants
#define Q16_ONE (1 << 16)
#define Q16_HALF (Q16_ONE / 2)
#define Q16_MAX INT32_MAX
#define Q16_MIN INT32_MIN

// Conversion macros
#define Q16_FROM_INT(i) ((q16_t)((i) << 16))
#define Q16_FROM_FLOAT(f) ((q16_t)((f) * Q16_ONE))
#define Q16_TO_INT(q) ((int32_t)((q) >> 16))
#define Q16_TO_FLOAT(q) ((float)(q) / Q16_ONE)

// 2D Vector in fixed-point
typedef struct {
    q16_t x, y;
} Vec2Q16;

// Basic arithmetic with saturation
static inline q16_t q16_add_sat(q16_t a, q16_t b) {
    q32_t result = (q32_t)a + (q32_t)b;
    if (result > Q16_MAX) return Q16_MAX;
    if (result < Q16_MIN) return Q16_MIN;
    return (q16_t)result;
}

static inline q16_t q16_sub_sat(q16_t a, q16_t b) {
    q32_t result = (q32_t)a - (q32_t)b;
    if (result > Q16_MAX) return Q16_MAX;
    if (result < Q16_MIN) return Q16_MIN;
    return (q16_t)result;
}

static inline q16_t q16_mul(q16_t a, q16_t b) {
    q32_t result = (q32_t)a * (q32_t)b;
    return (q16_t)(result >> 16);
}

static inline q16_t q16_div(q16_t a, q16_t b) {
    if (b == 0) return (a >= 0) ? Q16_MAX : Q16_MIN;
    q32_t result = ((q32_t)a << 16) / b;
    if (result > Q16_MAX) return Q16_MAX;
    if (result < Q16_MIN) return Q16_MIN;
    return (q16_t)result;
}

// Vector operations
Vec2Q16 vec2_add(Vec2Q16 a, Vec2Q16 b);
Vec2Q16 vec2_sub(Vec2Q16 a, Vec2Q16 b);
Vec2Q16 vec2_mul_scalar(Vec2Q16 v, q16_t s);
q16_t vec2_dot(Vec2Q16 a, Vec2Q16 b);
q16_t vec2_cross(Vec2Q16 a, Vec2Q16 b);
q16_t vec2_length_sq(Vec2Q16 v);
q16_t vec2_length(Vec2Q16 v);
Vec2Q16 vec2_normalize(Vec2Q16 v);
Vec2Q16 vec2_rotate(Vec2Q16 v, q16_t angle);

// Trigonometry (using lookup tables)
q16_t q16_sin(q16_t angle);
q16_t q16_cos(q16_t angle);
q16_t q16_atan2(q16_t y, q16_t x);

// Constants
extern const Vec2Q16 VEC2_ZERO;
extern const Vec2Q16 VEC2_UNIT_X;
extern const Vec2Q16 VEC2_UNIT_Y;

// Initialize math tables (call once at startup)
void math_init(void);

#endif /* CORE_MATH_H */