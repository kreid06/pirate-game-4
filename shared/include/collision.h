/**
 * collision.h — 2D collision detection for the shared physics library.
 *
 * Pure C, no heap allocation.  Works with the float Vec2 API from
 * pirate_math.h.  Exposed to JavaScript via wasm-bridge.c.
 *
 * Shapes supported:
 *   AABB   — axis-aligned bounding box
 *   Circle — bounding circle (from pirate_math.h)
 *   Polygon — convex polygon, up to PIRATE_MAX_POLY_VERTS vertices
 *
 * All functions are stateless and allocation-free (stack only).
 */

#ifndef PIRATE_COLLISION_H
#define PIRATE_COLLISION_H

#include "pirate_math.h"
#include <stdint.h>

/* ──────────────────────────────────────────────────────────────────────────
   Limits
   ────────────────────────────────────────────────────────────────────────── */

#define PIRATE_MAX_POLY_VERTS 32

/* ──────────────────────────────────────────────────────────────────────────
   AABB
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    Vec2 min;   /* top-left  / lower-left  */
    Vec2 max;   /* bottom-right / upper-right */
} AABB;

static inline AABB aabb(float x, float y, float w, float h) {
    return (AABB){{x, y}, {x + w, y + h}};
}

static inline AABB aabb_centered(Vec2 center, float half_w, float half_h) {
    return (AABB){
        {center.x - half_w, center.y - half_h},
        {center.x + half_w, center.y + half_h}
    };
}

/* Overlap tests */
static inline int aabb_overlaps_aabb(AABB a, AABB b) {
    return (a.min.x < b.max.x && a.max.x > b.min.x &&
            a.min.y < b.max.y && a.max.y > b.min.y);
}

static inline int aabb_contains_point(AABB a, Vec2 p) {
    return (p.x >= a.min.x && p.x <= a.max.x &&
            p.y >= a.min.y && p.y <= a.max.y);
}

/* Expand AABB to include a point */
static inline AABB aabb_expand(AABB a, Vec2 p) {
    AABB r;
    r.min.x = p.x < a.min.x ? p.x : a.min.x;
    r.min.y = p.y < a.min.y ? p.y : a.min.y;
    r.max.x = p.x > a.max.x ? p.x : a.max.x;
    r.max.y = p.y > a.max.y ? p.y : a.max.y;
    return r;
}

/* Merge two AABBs */
static inline AABB aabb_merge(AABB a, AABB b) {
    a = aabb_expand(a, b.min);
    a = aabb_expand(a, b.max);
    return a;
}

/* ──────────────────────────────────────────────────────────────────────────
   Convex Polygon
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    Vec2    verts[PIRATE_MAX_POLY_VERTS];
    int     count;
} Polygon;

/* Build polygon; returns 0 on error (too many verts). */
int polygon_init(Polygon *out, const Vec2 *verts, int count);

/* AABB of a polygon */
AABB polygon_aabb(const Polygon *poly);

/* Translate polygon by offset */
void polygon_translate(Polygon *poly, Vec2 offset);

/* Rotate polygon around a centre */
void polygon_rotate_around(Polygon *poly, Vec2 centre, float radians);

/* ──────────────────────────────────────────────────────────────────────────
   Collision manifold
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    int     hit;            /* non-zero if collision occurred */
    Vec2    normal;         /* collision normal pointing from B into A */
    float   depth;          /* penetration depth (overlap distance) */
    Vec2    contact;        /* approximate contact point */
} CollisionManifold;

static inline CollisionManifold manifold_none(void) {
    return (CollisionManifold){0, {0,0}, 0.0f, {0,0}};
}

/* ──────────────────────────────────────────────────────────────────────────
   Collision tests
   ────────────────────────────────────────────────────────────────────────── */

/* Circle vs Circle — wraps pirate_math circle_overlaps_circle with manifold */
CollisionManifold collide_circle_circle(Circle a, Circle b);

/* AABB vs AABB — with manifold */
CollisionManifold collide_aabb_aabb(AABB a, AABB b);

/* AABB vs Circle */
CollisionManifold collide_aabb_circle(AABB a, Circle c);

/* Polygon vs Circle — SAT-based */
CollisionManifold collide_poly_circle(const Polygon *poly, Circle c);

/* Polygon vs Polygon — SAT-based */
CollisionManifold collide_poly_poly(const Polygon *a, const Polygon *b);

/* ──────────────────────────────────────────────────────────────────────────
   Raycast
   ────────────────────────────────────────────────────────────────────────── */

typedef struct {
    int    hit;
    float  t;       /* parametric distance along ray [0, max_t] */
    Vec2   point;
    Vec2   normal;
} RayHit;

/**
 * Cast a ray from origin in direction dir.
 * @param max_t  Maximum distance (in world units).
 */
RayHit raycast_aabb(Vec2 origin, Vec2 dir, float max_t, AABB box);
RayHit raycast_circle(Vec2 origin, Vec2 dir, float max_t, Circle c);
RayHit raycast_poly(Vec2 origin, Vec2 dir, float max_t, const Polygon *poly);

#endif /* PIRATE_COLLISION_H */
