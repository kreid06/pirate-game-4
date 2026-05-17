/**
 * test_fixed.c — Unit tests for pirate_fixed Q16.16 module
 *
 * Compile & run:
 *   gcc -I../include test_fixed.c ../sim/fixed.c ../sim/math.c -lm -o test_fixed
 *   ./test_fixed
 */

#include <stdio.h>
#include <assert.h>
#include <math.h>
#include "pirate_fixed.h"

#define EPSILON_FLOAT 1e-3f
#define ASSERT_Q16_NEAR_F(q, expected_f) \
    assert(fabsf(Q16_TO_FLOAT(q) - (expected_f)) < EPSILON_FLOAT)
#define ASSERT_VECQ_NEAR(v, ex, ey) \
    ASSERT_Q16_NEAR_F((v).x, (ex)); \
    ASSERT_Q16_NEAR_F((v).y, (ey))

void test_q16_arithmetic(void) {
    printf("Testing Q16 arithmetic...\n");

    q16_t a = Q16_FROM_FLOAT(3.0f);
    q16_t b = Q16_FROM_FLOAT(4.0f);

    ASSERT_Q16_NEAR_F(q16_add(a, b), 7.0f);
    ASSERT_Q16_NEAR_F(q16_sub(a, b), -1.0f);
    ASSERT_Q16_NEAR_F(q16_mul(a, b), 12.0f);
    ASSERT_Q16_NEAR_F(q16_div(a, b), 0.75f);

    printf("  ✓ Q16 arithmetic\n");
}

void test_vecq_ops(void) {
    printf("Testing vecq_t operations...\n");

    pirate_fixed_init();

    vecq_t v = { Q16_FROM_FLOAT(3.0f), Q16_FROM_FLOAT(4.0f) };

    /* Length */
    q16_t len = vecq_length(v);
    ASSERT_Q16_NEAR_F(len, 5.0f);

    /* Normalize */
    vecq_t n = vecq_normalize(v);
    ASSERT_VECQ_NEAR(n, 0.6f, 0.8f);

    /* Rotate by 0 → unchanged (exact) */
    vecq_t r0 = vecq_rotate((vecq_t){Q16_FROM_FLOAT(1.0f), 0}, 0);
    ASSERT_Q16_NEAR_F(r0.x, 1.0f);
    ASSERT_Q16_NEAR_F(r0.y, 0.0f);

    /* Rotate by π/2: length must be preserved; values within trig-table precision (~0.03) */
    q16_t angle_90 = Q16_FROM_FLOAT(3.14159f / 2.0f);
    vecq_t r = vecq_rotate((vecq_t){Q16_FROM_FLOAT(1.0f), 0}, angle_90);
    float len_r = Q16_TO_FLOAT(vecq_length(r));
    assert(fabsf(len_r - 1.0f) < 5e-3f);          /* length preserved */
    assert(Q16_TO_FLOAT(r.y) > 0.95f);             /* Y close to +1 */
    assert(fabsf(Q16_TO_FLOAT(r.x)) < 0.05f);      /* X close to 0 */

    printf("  ✓ vecq_t operations\n");
}

void test_trig(void) {
    printf("Testing Q16 trig...\n");
    pirate_fixed_init();

    ASSERT_Q16_NEAR_F(q16_sin(Q16_FROM_FLOAT(0.0f)), 0.0f);
    ASSERT_Q16_NEAR_F(q16_cos(Q16_FROM_FLOAT(0.0f)), 1.0f);
    ASSERT_Q16_NEAR_F(q16_sin_f(3.14159f / 2.0f), 1.0f);
    ASSERT_Q16_NEAR_F(q16_cos_f(3.14159f), -1.0f);

    printf("  ✓ Q16 trig\n");
}

void test_conversion(void) {
    printf("Testing float<→vecq_t conversion...\n");

    Vec2  fv = {3.5f, -2.5f};
    vecq_t qv = vec2_to_vecq(fv);
    Vec2  back = vecq_to_vec2(qv);

    assert(fabsf(back.x - fv.x) < 1e-4f);
    assert(fabsf(back.y - fv.y) < 1e-4f);

    printf("  ✓ float<→vecq_t conversion\n");
}

int main(void) {
    printf("=== pirate_fixed tests ===\n");
    test_q16_arithmetic();
    test_vecq_ops();
    test_trig();
    test_conversion();
    printf("All tests passed!\n");
    return 0;
}
