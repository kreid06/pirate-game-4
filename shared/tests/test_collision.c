/**
 * test_collision.c — Unit tests for the shared collision module
 *
 * Compile & run:
 *   gcc -I../include test_collision.c ../sim/collision.c ../sim/math.c -lm -o test_collision
 *   ./test_collision
 */

#include <stdio.h>
#include <assert.h>
#include <math.h>
#include "collision.h"

#define EPSILON 1e-4f
#define ASSERT_FLOAT_NEAR(a, b) assert(fabsf((a) - (b)) < EPSILON)

/* ── Circle vs Circle ──────────────────────────────────────────────────── */

void test_circle_vs_circle(void) {
    printf("Testing circle vs circle...\n");

    Circle a = {vec2(0, 0), 5.0f};
    Circle b = {vec2(8, 0), 5.0f};  /* Overlap = 2 */
    CollisionManifold m = collide_circle_circle(a, b);
    assert(m.hit);
    ASSERT_FLOAT_NEAR(m.depth, 2.0f);
    ASSERT_FLOAT_NEAR(m.normal.x, 1.0f);
    ASSERT_FLOAT_NEAR(m.normal.y, 0.0f);

    Circle c = {vec2(20, 0), 5.0f}; /* No overlap */
    m = collide_circle_circle(a, c);
    assert(!m.hit);

    printf("  ✓ circle vs circle\n");
}

/* ── AABB vs AABB ──────────────────────────────────────────────────────── */

void test_aabb_vs_aabb(void) {
    printf("Testing AABB vs AABB...\n");

    AABB a = {{0, 0}, {10, 10}};
    AABB b = {{8, 0}, {18, 10}};  /* 2-unit X overlap */
    CollisionManifold m = collide_aabb_aabb(a, b);
    assert(m.hit);
    ASSERT_FLOAT_NEAR(m.depth, 2.0f);

    AABB c = {{20, 0}, {30, 10}};
    m = collide_aabb_aabb(a, c);
    assert(!m.hit);

    printf("  ✓ AABB vs AABB\n");
}

/* ── AABB vs Circle ────────────────────────────────────────────────────── */

void test_aabb_vs_circle(void) {
    printf("Testing AABB vs Circle...\n");

    AABB box = {{0, 0}, {10, 10}};
    Circle c  = {vec2(12, 5), 4.0f};  /* 2-unit X overlap */
    CollisionManifold m = collide_aabb_circle(box, c);
    assert(m.hit);
    ASSERT_FLOAT_NEAR(m.depth, 2.0f);

    Circle far = {vec2(30, 5), 4.0f};
    m = collide_aabb_circle(box, far);
    assert(!m.hit);

    printf("  ✓ AABB vs Circle\n");
}

/* ── Polygon vs Circle ─────────────────────────────────────────────────── */

void test_poly_vs_circle(void) {
    printf("Testing Polygon vs Circle (SAT)...\n");

    /* Unit square polygon */
    Vec2 verts[4] = {{-5,-5},{5,-5},{5,5},{-5,5}};
    Polygon poly;
    assert(polygon_init(&poly, verts, 4));

    Circle inside = {vec2(0, 0), 2.0f};
    CollisionManifold m = collide_poly_circle(&poly, inside);
    assert(m.hit);

    Circle outside = {vec2(20, 0), 2.0f};
    m = collide_poly_circle(&poly, outside);
    assert(!m.hit);

    printf("  ✓ Polygon vs Circle\n");
}

/* ── Polygon vs Polygon ────────────────────────────────────────────────── */

void test_poly_vs_poly(void) {
    printf("Testing Polygon vs Polygon (SAT)...\n");

    Vec2 verts_a[4] = {{0,0},{10,0},{10,10},{0,10}};
    Vec2 verts_b[4] = {{8,0},{18,0},{18,10},{8,10}};
    Polygon a, b;
    assert(polygon_init(&a, verts_a, 4));
    assert(polygon_init(&b, verts_b, 4));

    CollisionManifold m = collide_poly_poly(&a, &b);
    assert(m.hit);
    ASSERT_FLOAT_NEAR(m.depth, 2.0f);

    Vec2 verts_c[4] = {{20,0},{30,0},{30,10},{20,10}};
    Polygon c;
    assert(polygon_init(&c, verts_c, 4));
    m = collide_poly_poly(&a, &c);
    assert(!m.hit);

    printf("  ✓ Polygon vs Polygon\n");
}

/* ── Raycast ───────────────────────────────────────────────────────────── */

void test_raycast(void) {
    printf("Testing raycast...\n");

    AABB box = {{5, -5}, {15, 5}};
    RayHit hit = raycast_aabb(vec2(0, 0), vec2(1, 0), 100.0f, box);
    assert(hit.hit);
    ASSERT_FLOAT_NEAR(hit.t, 5.0f);

    /* Miss */
    hit = raycast_aabb(vec2(0, 20), vec2(1, 0), 100.0f, box);
    assert(!hit.hit);

    printf("  ✓ raycast\n");
}

int main(void) {
    printf("=== collision tests ===\n");
    test_circle_vs_circle();
    test_aabb_vs_aabb();
    test_aabb_vs_circle();
    test_poly_vs_circle();
    test_poly_vs_poly();
    test_raycast();
    printf("All collision tests passed!\n");
    return 0;
}
