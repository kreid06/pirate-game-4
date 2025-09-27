#define _USE_MATH_DEFINES
#include "core/math.h"
#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Constants
const Vec2Q16 VEC2_ZERO = {0, 0};
const Vec2Q16 VEC2_UNIT_X = {Q16_ONE, 0};
const Vec2Q16 VEC2_UNIT_Y = {0, Q16_ONE};

// Lookup tables for trigonometry (1024 entries for 0-2π)
#define TRIG_TABLE_SIZE 1024
static q16_t sin_table[TRIG_TABLE_SIZE];
static q16_t cos_table[TRIG_TABLE_SIZE];
static bool tables_initialized = false;

void math_init(void) {
    if (tables_initialized) return;
    
    // Pre-compute sin/cos lookup tables for deterministic trig
    for (int i = 0; i < TRIG_TABLE_SIZE; i++) {
        double angle = (double)i * 2.0 * M_PI / TRIG_TABLE_SIZE;
        sin_table[i] = Q16_FROM_FLOAT(sin(angle));
        cos_table[i] = Q16_FROM_FLOAT(cos(angle));
    }
    
    tables_initialized = true;
}

// Vector operations
Vec2Q16 vec2_add(Vec2Q16 a, Vec2Q16 b) {
    Vec2Q16 result = {
        q16_add_sat(a.x, b.x),
        q16_add_sat(a.y, b.y)
    };
    return result;
}

Vec2Q16 vec2_sub(Vec2Q16 a, Vec2Q16 b) {
    Vec2Q16 result = {
        q16_sub_sat(a.x, b.x),
        q16_sub_sat(a.y, b.y)  
    };
    return result;
}

Vec2Q16 vec2_mul_scalar(Vec2Q16 v, q16_t s) {
    Vec2Q16 result = {
        q16_mul(v.x, s),
        q16_mul(v.y, s)
    };
    return result;
}

q16_t vec2_dot(Vec2Q16 a, Vec2Q16 b) {
    q16_t x_prod = q16_mul(a.x, b.x);
    q16_t y_prod = q16_mul(a.y, b.y);
    return q16_add_sat(x_prod, y_prod);
}

q16_t vec2_cross(Vec2Q16 a, Vec2Q16 b) {
    q16_t term1 = q16_mul(a.x, b.y);
    q16_t term2 = q16_mul(a.y, b.x);
    return q16_sub_sat(term1, term2);
}

q16_t vec2_length_sq(Vec2Q16 v) {
    return vec2_dot(v, v);
}

q16_t vec2_length(Vec2Q16 v) {
    q16_t len_sq = vec2_length_sq(v);
    if (len_sq == 0) return 0;
    
    // Integer square root using Newton's method
    q16_t x = len_sq >> 1; // Initial guess
    for (int i = 0; i < 8; i++) {
        if (x == 0) break;
        q16_t new_x = (x + q16_div(len_sq, x)) >> 1;
        if (new_x >= x) break;
        x = new_x;
    }
    return x;
}

Vec2Q16 vec2_normalize(Vec2Q16 v) {
    q16_t len = vec2_length(v);
    if (len == 0) return VEC2_ZERO;
    
    Vec2Q16 result = {
        q16_div(v.x, len),
        q16_div(v.y, len)
    };
    return result;
}

Vec2Q16 vec2_rotate(Vec2Q16 v, q16_t angle) {
    q16_t cos_a = q16_cos(angle);
    q16_t sin_a = q16_sin(angle);
    
    Vec2Q16 result = {
        q16_sub_sat(q16_mul(v.x, cos_a), q16_mul(v.y, sin_a)),
        q16_add_sat(q16_mul(v.x, sin_a), q16_mul(v.y, cos_a))
    };
    return result;
}

// Trigonometry using lookup tables
q16_t q16_sin(q16_t angle) {
    if (!tables_initialized) {
        math_init();
    }
    
    // Normalize angle to [0, 2π) range
    // Since we're using fixed-point, we need to handle this carefully
    while (angle < 0) {
        angle = q16_add_sat(angle, Q16_FROM_FLOAT(2.0f * M_PI));
    }
    while (angle >= Q16_FROM_FLOAT(2.0f * M_PI)) {
        angle = q16_sub_sat(angle, Q16_FROM_FLOAT(2.0f * M_PI));
    }
    
    // Convert to table index
    q32_t index_q32 = ((q32_t)angle * TRIG_TABLE_SIZE) / Q16_FROM_FLOAT(2.0f * M_PI);
    int index = (int)(index_q32 >> 16);
    
    // Clamp to valid range
    if (index >= TRIG_TABLE_SIZE) index = TRIG_TABLE_SIZE - 1;
    if (index < 0) index = 0;
    
    return sin_table[index];
}

q16_t q16_cos(q16_t angle) {
    if (!tables_initialized) {
        math_init();
    }
    
    // Normalize angle to [0, 2π) range
    while (angle < 0) {
        angle = q16_add_sat(angle, Q16_FROM_FLOAT(2.0f * M_PI));
    }
    while (angle >= Q16_FROM_FLOAT(2.0f * M_PI)) {
        angle = q16_sub_sat(angle, Q16_FROM_FLOAT(2.0f * M_PI));
    }
    
    // Convert to table index
    q32_t index_q32 = ((q32_t)angle * TRIG_TABLE_SIZE) / Q16_FROM_FLOAT(2.0f * M_PI);
    int index = (int)(index_q32 >> 16);
    
    // Clamp to valid range  
    if (index >= TRIG_TABLE_SIZE) index = TRIG_TABLE_SIZE - 1;
    if (index < 0) index = 0;
    
    return cos_table[index];
}

q16_t q16_atan2(q16_t y, q16_t x) {
    if (x == 0 && y == 0) return 0;
    
    // Use floating-point atan2 and convert back
    // This is not perfectly deterministic across platforms, but good enough for now
    // A fully deterministic version would use CORDIC algorithm
    float y_f = Q16_TO_FLOAT(y);
    float x_f = Q16_TO_FLOAT(x);
    float result_f = atan2f(y_f, x_f);
    
    return Q16_FROM_FLOAT(result_f);
}