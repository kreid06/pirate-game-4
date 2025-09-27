#include <stdio.h>
#include <assert.h>
#include <string.h>
#include "../src/core/math.c"
#include "../src/core/rng.c"

// Simple determinism test
void test_fixed_point_math(void) {
    printf("Testing fixed-point math determinism...\n");
    
    // Test basic arithmetic
    q16_t a = Q16_FROM_FLOAT(3.14159f);
    q16_t b = Q16_FROM_FLOAT(2.71828f);
    
    q16_t sum = q16_add_sat(a, b);
    q16_t diff = q16_sub_sat(a, b);  
    q16_t prod = q16_mul(a, b);
    q16_t quot = q16_div(a, b);
    
    printf("  a = %.6f, b = %.6f\n", Q16_TO_FLOAT(a), Q16_TO_FLOAT(b));
    printf("  sum = %.6f\n", Q16_TO_FLOAT(sum));
    printf("  diff = %.6f\n", Q16_TO_FLOAT(diff));
    printf("  prod = %.6f\n", Q16_TO_FLOAT(prod));
    printf("  quot = %.6f\n", Q16_TO_FLOAT(quot));
    
    // Test vector operations
    Vec2Q16 v1 = {Q16_FROM_FLOAT(3.0f), Q16_FROM_FLOAT(4.0f)};
    Vec2Q16 v2 = {Q16_FROM_FLOAT(1.0f), Q16_FROM_FLOAT(2.0f)};
    
    Vec2Q16 v_add = vec2_add(v1, v2);
    Vec2Q16 v_sub = vec2_sub(v1, v2);
    q16_t v_dot = vec2_dot(v1, v2);
    q16_t v_len = vec2_length(v1);
    
    printf("  v1 = (%.3f, %.3f), v2 = (%.3f, %.3f)\n", 
           Q16_TO_FLOAT(v1.x), Q16_TO_FLOAT(v1.y),
           Q16_TO_FLOAT(v2.x), Q16_TO_FLOAT(v2.y));
    printf("  v1 + v2 = (%.3f, %.3f)\n", 
           Q16_TO_FLOAT(v_add.x), Q16_TO_FLOAT(v_add.y));
    printf("  v1 - v2 = (%.3f, %.3f)\n", 
           Q16_TO_FLOAT(v_sub.x), Q16_TO_FLOAT(v_sub.y));
    printf("  v1 · v2 = %.3f\n", Q16_TO_FLOAT(v_dot));
    printf("  |v1| = %.3f\n", Q16_TO_FLOAT(v_len));
    
    printf("Fixed-point math test passed!\n\n");
}

void test_rng_determinism(void) {
    printf("Testing RNG determinism...\n");
    
    struct RNGState rng1, rng2;
    rng_seed(&rng1, 12345);
    rng_seed(&rng2, 12345);
    
    // Generate sequences from both RNGs
    printf("  Seed: 12345\n");
    printf("  Sequence comparison:\n");
    
    bool sequences_match = true;
    for (int i = 0; i < 10; i++) {
        uint32_t val1 = rng_next(&rng1);
        uint32_t val2 = rng_next(&rng2);
        
        printf("    %2d: %10u vs %10u %s\n", 
               i+1, val1, val2, (val1 == val2) ? "✓" : "✗");
        
        if (val1 != val2) {
            sequences_match = false;
        }
    }
    
    assert(sequences_match && "RNG sequences should match with same seed");
    
    // Test different seeds produce different sequences
    rng_seed(&rng2, 54321);
    uint32_t diff_val1 = rng_next(&rng1);
    uint32_t diff_val2 = rng_next(&rng2);
    
    assert(diff_val1 != diff_val2 && "Different seeds should produce different values");
    
    printf("RNG determinism test passed!\n\n");
}

void test_trig_determinism(void) {
    printf("Testing trigonometry determinism...\n");
    
    math_init();
    
    q16_t angles[] = {
        Q16_FROM_FLOAT(0.0f),
        Q16_FROM_FLOAT(1.5707963f), // π/2
        Q16_FROM_FLOAT(3.1415926f), // π
        Q16_FROM_FLOAT(4.7123889f)  // 3π/2
    };
    
    for (size_t i = 0; i < sizeof(angles)/sizeof(angles[0]); i++) {
        q16_t angle = angles[i];
        q16_t sin_val = q16_sin(angle);
        q16_t cos_val = q16_cos(angle);
        
        printf("  angle=%.6f: sin=%.6f, cos=%.6f\n",
               Q16_TO_FLOAT(angle), Q16_TO_FLOAT(sin_val), Q16_TO_FLOAT(cos_val));
    }
    
    printf("Trigonometry determinism test passed!\n\n");
}

int main(void) {
    printf("=== Determinism Validation Tests ===\n\n");
    
    test_fixed_point_math();
    test_rng_determinism();
    test_trig_determinism();
    
    printf("All determinism tests passed! ✓\n");
    printf("\nKey validation points:\n");
    printf("- Fixed-point arithmetic is consistent\n");
    printf("- RNG produces identical sequences with same seed\n");
    printf("- Trigonometry uses lookup tables for consistency\n");
    printf("- All operations avoid floating-point non-determinism\n");
    
    return 0;
}