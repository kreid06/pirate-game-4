/**
 * test_math.c — Unit tests for pirate_math module
 * 
 * Compile & run:
 *   gcc -I../include test_math.c ../sim/math.c -lm -o test_math
 *   ./test_math
 */

#include <stdio.h>
#include <assert.h>
#include <math.h>
#include "pirate_math.h"

#define PI PIRATE_PI  /* convenience alias for tests */

#define EPSILON 1e-5f
#define ASSERT_FLOAT_NEAR(a, b) assert(fabsf((a) - (b)) < EPSILON)
#define ASSERT_VEC2_NEAR(v, ex, ey) \
  ASSERT_FLOAT_NEAR((v).x, (ex)); \
  ASSERT_FLOAT_NEAR((v).y, (ey))

void test_vec2_basic(void) {
  printf("Testing Vec2 basic operations...\n");
  
  Vec2 a = vec2(3.0f, 4.0f);
  Vec2 b = vec2(1.0f, 2.0f);
  
  // Length
  ASSERT_FLOAT_NEAR(vec2_length(a), 5.0f);
  ASSERT_FLOAT_NEAR(vec2_length_sq(a), 25.0f);
  
  // Add/Sub
  Vec2 sum = vec2_add(a, b);
  ASSERT_VEC2_NEAR(sum, 4.0f, 6.0f);
  
  Vec2 diff = vec2_sub(a, b);
  ASSERT_VEC2_NEAR(diff, 2.0f, 2.0f);
  
  // Multiply/Divide
  Vec2 scaled = vec2_mul(a, 2.0f);
  ASSERT_VEC2_NEAR(scaled, 6.0f, 8.0f);
  
  Vec2 divided = vec2_div(scaled, 2.0f);
  ASSERT_VEC2_NEAR(divided, 3.0f, 4.0f);
  
  printf("  ✓ Vec2 basic operations\n");
}

void test_vec2_normalize(void) {
  printf("Testing Vec2 normalize...\n");
  
  Vec2 a = vec2(3.0f, 4.0f);
  Vec2 n = vec2_normalize(a);
  
  ASSERT_FLOAT_NEAR(n.x, 0.6f);
  ASSERT_FLOAT_NEAR(n.y, 0.8f);
  ASSERT_FLOAT_NEAR(vec2_length(n), 1.0f);
  
  // Zero vector
  Vec2 zero = vec2_normalize(vec2_zero());
  ASSERT_VEC2_NEAR(zero, 0.0f, 0.0f);
  
  printf("  ✓ Vec2 normalize\n");
}

void test_vec2_dot_cross(void) {
  printf("Testing Vec2 dot/cross product...\n");
  
  Vec2 a = vec2(1.0f, 0.0f);
  Vec2 b = vec2(0.0f, 1.0f);
  Vec2 c = vec2(1.0f, 1.0f);
  
  // Dot product
  ASSERT_FLOAT_NEAR(vec2_dot(a, b), 0.0f);  // Perpendicular
  ASSERT_FLOAT_NEAR(vec2_dot(a, a), 1.0f);  // Self
  ASSERT_FLOAT_NEAR(vec2_dot(a, c), 1.0f);
  
  // Cross product
  ASSERT_FLOAT_NEAR(vec2_cross(a, b), 1.0f);  // a × b
  ASSERT_FLOAT_NEAR(vec2_cross(b, a), -1.0f); // b × a
  ASSERT_FLOAT_NEAR(vec2_cross(a, a), 0.0f);  // Self
  
  printf("  ✓ Vec2 dot/cross product\n");
}

void test_vec2_rotate(void) {
  printf("Testing Vec2 rotate...\n");
  
  Vec2 a = vec2(1.0f, 0.0f);
  
  // 90 degrees = π/2 radians
  Vec2 rot90 = vec2_rotate(a, PI / 2.0f);
  ASSERT_FLOAT_NEAR(rot90.x, 0.0f);
  ASSERT_FLOAT_NEAR(rot90.y, 1.0f);
  
  // 180 degrees
  Vec2 rot180 = vec2_rotate(a, PI);
  ASSERT_FLOAT_NEAR(rot180.x, -1.0f);
  ASSERT_FLOAT_NEAR(rot180.y, 0.0f);
  
  printf("  ✓ Vec2 rotate\n");
}

void test_vec2_distance(void) {
  printf("Testing Vec2 distance...\n");
  
  Vec2 a = vec2(0.0f, 0.0f);
  Vec2 b = vec2(3.0f, 4.0f);
  
  ASSERT_FLOAT_NEAR(vec2_distance(a, b), 5.0f);
  ASSERT_FLOAT_NEAR(vec2_distance_sq(a, b), 25.0f);
  ASSERT_FLOAT_NEAR(vec2_distance(b, a), 5.0f);  // Symmetric
  
  printf("  ✓ Vec2 distance\n");
}

void test_circle_collision(void) {
  printf("Testing circle collision...\n");
  
  Circle a = {vec2(0.0f, 0.0f), 1.0f};
  Circle b = {vec2(1.5f, 0.0f), 1.0f};
  Circle c = {vec2(5.0f, 0.0f), 1.0f};
  
  // Overlapping
  assert(circle_overlaps_circle(a, b));
  
  // Not overlapping
  assert(!circle_overlaps_circle(a, c));
  
  // Self
  assert(circle_overlaps_circle(a, a));
  
  printf("  ✓ Circle collision\n");
}

void test_mat3_identity(void) {
  printf("Testing Mat3 identity...\n");
  
  Mat3 m = mat3_identity();
  Vec2 v = vec2(3.0f, 4.0f);
  Vec2 result = mat3_transform(m, v);
  
  ASSERT_VEC2_NEAR(result, 3.0f, 4.0f);
  
  printf("  ✓ Mat3 identity\n");
}

void test_mat3_translation(void) {
  printf("Testing Mat3 translation...\n");
  
  Mat3 m = mat3_translation(2.0f, 3.0f);
  Vec2 v = vec2(1.0f, 1.0f);
  Vec2 result = mat3_transform(m, v);
  
  ASSERT_VEC2_NEAR(result, 3.0f, 4.0f);
  
  printf("  ✓ Mat3 translation\n");
}

void test_mat3_rotation(void) {
  printf("Testing Mat3 rotation...\n");
  
  Mat3 m = mat3_rotation(PI / 2.0f);
  Vec2 v = vec2(1.0f, 0.0f);
  Vec2 result = mat3_transform(m, v);
  
  ASSERT_FLOAT_NEAR(result.x, 0.0f);
  ASSERT_FLOAT_NEAR(result.y, 1.0f);
  
  printf("  ✓ Mat3 rotation\n");
}

void test_utilities(void) {
  printf("Testing utilities...\n");
  
  ASSERT_FLOAT_NEAR(deg_to_rad(180.0f), PI);
  ASSERT_FLOAT_NEAR(rad_to_deg(PI), 180.0f);
  
  ASSERT_FLOAT_NEAR(clamp(5.0f, 0.0f, 10.0f), 5.0f);
  ASSERT_FLOAT_NEAR(clamp(-1.0f, 0.0f, 10.0f), 0.0f);
  ASSERT_FLOAT_NEAR(clamp(15.0f, 0.0f, 10.0f), 10.0f);
  
  ASSERT_FLOAT_NEAR(lerp(0.0f, 10.0f, 0.5f), 5.0f);
  
  printf("  ✓ Utilities\n");
}

int main(void) {
  printf("=== Pirate Math Test Suite ===\n\n");
  
  test_vec2_basic();
  test_vec2_normalize();
  test_vec2_dot_cross();
  test_vec2_rotate();
  test_vec2_distance();
  test_circle_collision();
  test_mat3_identity();
  test_mat3_translation();
  test_mat3_rotation();
  test_utilities();
  
  printf("\n✅ All tests passed!\n");
  return 0;
}
