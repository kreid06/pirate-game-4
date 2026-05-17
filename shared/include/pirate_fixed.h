/**
 * pirate_fixed.h — Q16.16 fixed-point math for the shared physics library.
 *
 * Provides deterministic integer-based math that exactly mirrors the server's
 * authoritative simulation.  Names use the `q16_` and `vecq_` prefixes to
 * avoid symbol conflicts when the server also links libpirate-sim.
 *
 * Usage (server or shared physics step):
 *   #include "pirate_fixed.h"
 *   vecq_t pos = { Q16_FROM_FLOAT(100.f), Q16_FROM_FLOAT(200.f) };
 *   vecq_t dir = vecq_normalize(pos);
 *
 * Usage (convert to float for WASM / rendering):
 *   Vec2 fpos = vecq_to_vec2(pos);
 *
 * Must call pirate_fixed_init() once before using q16_sin / q16_cos.
 */

#ifndef PIRATE_FIXED_H
#define PIRATE_FIXED_H

#include <stdint.h>
#include <stdbool.h>
#include "pirate_math.h"   /* Vec2, PIRATE_PI */

/* ──────────────────────────────────────────────────────────────────────────
   Q16.16 scalar
   ────────────────────────────────────────────────────────────────────────── */

typedef int32_t  q16_t;
typedef int64_t  q32_t;   /* used for intermediate 64-bit products */

#define Q16_ONE   (1 << 16)
#define Q16_HALF  (Q16_ONE / 2)
#define Q16_MAX   INT32_MAX
#define Q16_MIN   INT32_MIN

/* Conversion */
#define Q16_FROM_INT(i)   ((q16_t)((i) << 16))
#define Q16_FROM_FLOAT(f) ((q16_t)((f) * Q16_ONE))
#define Q16_TO_INT(q)     ((int32_t)((q) >> 16))
#define Q16_TO_FLOAT(q)   ((float)(q) / (float)Q16_ONE)

/* Arithmetic with saturation */
static inline q16_t q16_add(q16_t a, q16_t b) {
    q32_t r = (q32_t)a + (q32_t)b;
    if (r > Q16_MAX) return Q16_MAX;
    if (r < Q16_MIN) return Q16_MIN;
    return (q16_t)r;
}

static inline q16_t q16_sub(q16_t a, q16_t b) {
    q32_t r = (q32_t)a - (q32_t)b;
    if (r > Q16_MAX) return Q16_MAX;
    if (r < Q16_MIN) return Q16_MIN;
    return (q16_t)r;
}

static inline q16_t q16_mul(q16_t a, q16_t b) {
    return (q16_t)(((q32_t)a * (q32_t)b) >> 16);
}

static inline q16_t q16_div(q16_t a, q16_t b) {
    if (b == 0) return (a >= 0) ? Q16_MAX : Q16_MIN;
    q32_t r = ((q32_t)a << 16) / b;
    if (r > Q16_MAX) return Q16_MAX;
    if (r < Q16_MIN) return Q16_MIN;
    return (q16_t)r;
}

static inline q16_t q16_abs(q16_t a) {
    return a < 0 ? -a : a;
}

/* ──────────────────────────────────────────────────────────────────────────
   Q16.16 2D vector  (distinct from server's Vec2Q16 — same layout, safe cast)
   ────────────────────────────────────────────────────────────────────────── */

typedef struct { q16_t x, y; } vecq_t;

static inline vecq_t vecq(q16_t x, q16_t y) {
    return (vecq_t){x, y};
}

static inline vecq_t vecq_zero(void) {
    return (vecq_t){0, 0};
}

static inline vecq_t vecq_from_float(float x, float y) {
    return (vecq_t){Q16_FROM_FLOAT(x), Q16_FROM_FLOAT(y)};
}

static inline Vec2 vecq_to_vec2(vecq_t v) {
    return (Vec2){Q16_TO_FLOAT(v.x), Q16_TO_FLOAT(v.y)};
}

static inline vecq_t vec2_to_vecq(Vec2 v) {
    return (vecq_t){Q16_FROM_FLOAT(v.x), Q16_FROM_FLOAT(v.y)};
}

/* Arithmetic */
static inline vecq_t vecq_add(vecq_t a, vecq_t b) {
    return (vecq_t){q16_add(a.x, b.x), q16_add(a.y, b.y)};
}

static inline vecq_t vecq_sub(vecq_t a, vecq_t b) {
    return (vecq_t){q16_sub(a.x, b.x), q16_sub(a.y, b.y)};
}

static inline vecq_t vecq_scale(vecq_t v, q16_t s) {
    return (vecq_t){q16_mul(v.x, s), q16_mul(v.y, s)};
}

static inline q16_t vecq_dot(vecq_t a, vecq_t b) {
    return q16_add(q16_mul(a.x, b.x), q16_mul(a.y, b.y));
}

static inline q16_t vecq_cross(vecq_t a, vecq_t b) {
    return q16_sub(q16_mul(a.x, b.y), q16_mul(a.y, b.x));
}

static inline q16_t vecq_length_sq(vecq_t v) {
    return vecq_dot(v, v);
}

/* Non-inline implementations — in fixed.c */
q16_t   vecq_length(vecq_t v);
vecq_t  vecq_normalize(vecq_t v);
vecq_t  vecq_rotate(vecq_t v, q16_t angle_q16);

/* ──────────────────────────────────────────────────────────────────────────
   Trigonometry — lookup-table based for determinism
   ────────────────────────────────────────────────────────────────────────── */

/* Initialize sin/cos lookup tables.  Must be called once before q16_sin/cos. */
void pirate_fixed_init(void);

/**
 * angle_q16: angle in radians as Q16.16.
 * Full circle = Q16_FROM_FLOAT(PIRATE_TWO_PI).
 */
q16_t q16_sin(q16_t angle_q16);
q16_t q16_cos(q16_t angle_q16);
q16_t q16_atan2(q16_t y, q16_t x);

/* Convenience: radians as float → q16_t */
static inline q16_t q16_sin_f(float rad) { return q16_sin(Q16_FROM_FLOAT(rad)); }
static inline q16_t q16_cos_f(float rad) { return q16_cos(Q16_FROM_FLOAT(rad)); }

/* ──────────────────────────────────────────────────────────────────────────
   Angle helpers
   ────────────────────────────────────────────────────────────────────────── */

/* Wrap angle into [-π, π] in Q16 */
q16_t q16_angle_wrap(q16_t angle_q16);

/* World scale: 1 server unit = 10 client pixels */
#define PIRATE_WORLD_SCALE       10
#define PIRATE_CLIENT_TO_SERVER(x)  ((x) / PIRATE_WORLD_SCALE)
#define PIRATE_SERVER_TO_CLIENT(x)  ((x) * PIRATE_WORLD_SCALE)

/* Q16 equivalents */
#define PIRATE_CLIENT_TO_Q16(x)  Q16_FROM_FLOAT((x) / (float)PIRATE_WORLD_SCALE)
#define PIRATE_SERVER_Q16_TO_FLOAT(q) (Q16_TO_FLOAT(q) * PIRATE_WORLD_SCALE)

#endif /* PIRATE_FIXED_H */
