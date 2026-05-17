/**
 * fixed.c — Q16.16 fixed-point math implementation (shared library).
 *
 * Adapted from server/src/core/math.c but uses the pirate_fixed.h API
 * (vecq_t / vecq_* naming) so it can be linked alongside the server's own
 * core/math.c without duplicate-symbol errors.
 *
 * pirate_fixed_init() must be called once at startup before q16_sin / q16_cos.
 */

#define _USE_MATH_DEFINES
#include "pirate_fixed.h"
#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ──────────────────────────────────────────────────────────────────────────
   Lookup tables for deterministic trigonometry
   ────────────────────────────────────────────────────────────────────────── */

#define TRIG_TABLE_SIZE 1024

static q16_t pf_sin_table[TRIG_TABLE_SIZE];
static q16_t pf_cos_table[TRIG_TABLE_SIZE];
static bool  pf_tables_init = false;

void pirate_fixed_init(void) {
    if (pf_tables_init) return;
    for (int i = 0; i < TRIG_TABLE_SIZE; i++) {
        double a = (double)i * 2.0 * M_PI / TRIG_TABLE_SIZE;
        pf_sin_table[i] = Q16_FROM_FLOAT(sin(a));
        pf_cos_table[i] = Q16_FROM_FLOAT(cos(a));
    }
    pf_tables_init = true;
}

/* Map Q16 angle (radians) to table index. */
static int angle_to_index(q16_t angle_q16) {
    /* Normalise to [0, 2π) using integer wrap. */
    const q16_t TWO_PI_Q16 = Q16_FROM_FLOAT((float)(2.0 * M_PI));
    while (angle_q16 <  0)            angle_q16 = q16_add(angle_q16, TWO_PI_Q16);
    while (angle_q16 >= TWO_PI_Q16)   angle_q16 = q16_sub(angle_q16, TWO_PI_Q16);
    int idx = (int)(((q32_t)angle_q16 * TRIG_TABLE_SIZE) / TWO_PI_Q16);
    if (idx < 0)                   idx = 0;
    if (idx >= TRIG_TABLE_SIZE)    idx = TRIG_TABLE_SIZE - 1;
    return idx;
}

q16_t q16_sin(q16_t angle_q16) {
    if (!pf_tables_init) pirate_fixed_init();
    return pf_sin_table[angle_to_index(angle_q16)];
}

q16_t q16_cos(q16_t angle_q16) {
    if (!pf_tables_init) pirate_fixed_init();
    return pf_cos_table[angle_to_index(angle_q16)];
}

q16_t q16_atan2(q16_t y, q16_t x) {
    if (x == 0 && y == 0) return 0;
    /* Uses platform atan2f — acceptable for non-authoritative callers.
       For bit-perfect determinism on the server, CORDIC would be used. */
    return Q16_FROM_FLOAT(atan2f(Q16_TO_FLOAT(y), Q16_TO_FLOAT(x)));
}

q16_t q16_angle_wrap(q16_t angle_q16) {
    const q16_t PI_Q16     = Q16_FROM_FLOAT((float)M_PI);
    const q16_t TWO_PI_Q16 = PI_Q16 * 2;
    while (angle_q16 >  PI_Q16)    angle_q16 = q16_sub(angle_q16, TWO_PI_Q16);
    while (angle_q16 < -PI_Q16)    angle_q16 = q16_add(angle_q16, TWO_PI_Q16);
    return angle_q16;
}

/* ──────────────────────────────────────────────────────────────────────────
   vecq_t operations
   ────────────────────────────────────────────────────────────────────────── */

q16_t vecq_length(vecq_t v) {
    q16_t len_sq = vecq_length_sq(v);
    if (len_sq <= 0) return 0;
    /* Newton-Raphson Q16 sqrt. Converges to Q16(sqrt(len_sq_float)).
       Starting point: use len_sq itself — it is always a valid upper bound
       because sqrt(x) <= x for all Q16 x >= Q16(1), and equals x at x=0/1. */
    q16_t x = (len_sq > 65536) ? (len_sq >> 1) : len_sq;
    for (int i = 0; i < 24; i++) {
        if (x == 0) break;
        q16_t nx = (q16_t)(((q32_t)x + q16_div(len_sq, x)) >> 1);
        if (nx == x) break;           /* fully converged */
        if (nx > x) { x = nx; continue; } /* rose — keep iterating from above */
        x = nx;
    }
    return x;
}

vecq_t vecq_normalize(vecq_t v) {
    q16_t len = vecq_length(v);
    if (len == 0) return vecq_zero();
    return (vecq_t){q16_div(v.x, len), q16_div(v.y, len)};
}

vecq_t vecq_rotate(vecq_t v, q16_t angle_q16) {
    q16_t c = q16_cos(angle_q16);
    q16_t s = q16_sin(angle_q16);
    return (vecq_t){
        q16_sub(q16_mul(v.x, c), q16_mul(v.y, s)),
        q16_add(q16_mul(v.x, s), q16_mul(v.y, c))
    };
}
