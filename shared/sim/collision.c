/**
 * collision.c — 2D collision detection implementation.
 *
 * All algorithms are deterministic and allocation-free.
 * Uses only stack memory; max polygon: PIRATE_MAX_POLY_VERTS vertices.
 */

#include "collision.h"
#include <string.h>
#include <float.h>

/* ──────────────────────────────────────────────────────────────────────────
   Polygon helpers
   ────────────────────────────────────────────────────────────────────────── */

int polygon_init(Polygon *out, const Vec2 *verts, int count) {
    if (!out || !verts || count < 3 || count > PIRATE_MAX_POLY_VERTS) return 0;
    memcpy(out->verts, verts, (size_t)count * sizeof(Vec2));
    out->count = count;
    return 1;
}

AABB polygon_aabb(const Polygon *poly) {
    AABB box = {poly->verts[0], poly->verts[0]};
    for (int i = 1; i < poly->count; i++) {
        box = aabb_expand(box, poly->verts[i]);
    }
    return box;
}

void polygon_translate(Polygon *poly, Vec2 offset) {
    for (int i = 0; i < poly->count; i++) {
        poly->verts[i] = vec2_add(poly->verts[i], offset);
    }
}

void polygon_rotate_around(Polygon *poly, Vec2 centre, float radians) {
    for (int i = 0; i < poly->count; i++) {
        Vec2 local = vec2_sub(poly->verts[i], centre);
        local = vec2_rotate(local, radians);
        poly->verts[i] = vec2_add(local, centre);
    }
}

/* ──────────────────────────────────────────────────────────────────────────
   SAT helper — project polygon onto axis, return [min,max] interval
   ────────────────────────────────────────────────────────────────────────── */

static void sat_project(const Polygon *poly, Vec2 axis, float *out_min, float *out_max) {
    float mn =  FLT_MAX;
    float mx = -FLT_MAX;
    for (int i = 0; i < poly->count; i++) {
        float p = vec2_dot(poly->verts[i], axis);
        if (p < mn) mn = p;
        if (p > mx) mx = p;
    }
    *out_min = mn;
    *out_max = mx;
}

/* Returns overlap on axis (positive = overlap, negative = gap). */
static float sat_overlap(float min_a, float max_a, float min_b, float max_b) {
    float ov1 = max_a - min_b;
    float ov2 = max_b - min_a;
    return ov1 < ov2 ? ov1 : ov2;
}

/* ──────────────────────────────────────────────────────────────────────────
   Circle vs Circle
   ────────────────────────────────────────────────────────────────────────── */

CollisionManifold collide_circle_circle(Circle a, Circle b) {
    Vec2 delta = vec2_sub(b.center, a.center);
    float dist_sq = vec2_length_sq(delta);
    float min_dist = a.radius + b.radius;

    if (dist_sq >= min_dist * min_dist) return manifold_none();

    float dist = vec2_length(delta);
    CollisionManifold m;
    m.hit = 1;
    m.depth = min_dist - dist;
    if (dist < 1e-6f) {
        m.normal  = vec2(0.0f, 1.0f);
        m.contact = a.center;
    } else {
        m.normal  = vec2_div(delta, dist);
        m.contact = vec2_add(a.center, vec2_mul(m.normal, a.radius));
    }
    return m;
}

/* ──────────────────────────────────────────────────────────────────────────
   AABB vs AABB
   ────────────────────────────────────────────────────────────────────────── */

CollisionManifold collide_aabb_aabb(AABB a, AABB b) {
    if (!aabb_overlaps_aabb(a, b)) return manifold_none();

    float ox = (a.max.x < b.max.x ? a.max.x : b.max.x) -
               (a.min.x > b.min.x ? a.min.x : b.min.x);
    float oy = (a.max.y < b.max.y ? a.max.y : b.max.y) -
               (a.min.y > b.min.y ? a.min.y : b.min.y);

    CollisionManifold m;
    m.hit   = 1;
    m.depth = ox < oy ? ox : oy;
    if (ox < oy) {
        float ca = (a.min.x + a.max.x) * 0.5f;
        float cb = (b.min.x + b.max.x) * 0.5f;
        m.normal  = vec2(ca < cb ? -1.0f : 1.0f, 0.0f);
        m.contact = vec2((a.max.x < b.max.x ? a.max.x : b.max.x) - ox * 0.5f,
                         (a.min.y + a.max.y + b.min.y + b.max.y) * 0.25f);
    } else {
        float ca = (a.min.y + a.max.y) * 0.5f;
        float cb = (b.min.y + b.max.y) * 0.5f;
        m.normal  = vec2(0.0f, ca < cb ? -1.0f : 1.0f);
        m.contact = vec2((a.min.x + a.max.x + b.min.x + b.max.x) * 0.25f,
                         (a.max.y < b.max.y ? a.max.y : b.max.y) - oy * 0.5f);
    }
    return m;
}

/* ──────────────────────────────────────────────────────────────────────────
   AABB vs Circle
   ────────────────────────────────────────────────────────────────────────── */

CollisionManifold collide_aabb_circle(AABB a, Circle c) {
    /* Closest point on AABB to circle centre */
    float cx = c.center.x;
    float cy = c.center.y;
    float clampx = cx < a.min.x ? a.min.x : (cx > a.max.x ? a.max.x : cx);
    float clampy = cy < a.min.y ? a.min.y : (cy > a.max.y ? a.max.y : cy);

    float dx = cx - clampx;
    float dy = cy - clampy;
    float dist_sq = dx * dx + dy * dy;

    if (dist_sq >= c.radius * c.radius) return manifold_none();

    float dist = vec2_length(vec2(dx, dy));
    CollisionManifold m;
    m.hit   = 1;
    m.depth = c.radius - dist;
    if (dist < 1e-6f) {
        m.normal  = vec2(0.0f, 1.0f);
        m.contact = vec2(clampx, clampy);
    } else {
        m.normal  = vec2(dx / dist, dy / dist);
        m.contact = vec2(clampx, clampy);
    }
    return m;
}

/* ──────────────────────────────────────────────────────────────────────────
   Polygon vs Circle  (SAT)
   ────────────────────────────────────────────────────────────────────────── */

CollisionManifold collide_poly_circle(const Polygon *poly, Circle c) {
    float min_overlap = FLT_MAX;
    Vec2  best_normal = {0, 0};

    /* Test each polygon edge normal */
    for (int i = 0; i < poly->count; i++) {
        Vec2 a = poly->verts[i];
        Vec2 b = poly->verts[(i + 1) % poly->count];
        Vec2 edge   = vec2_sub(b, a);
        Vec2 normal = vec2_normalize(vec2_perpendicular(edge));

        float poly_min, poly_max;
        sat_project(poly, normal, &poly_min, &poly_max);
        float circle_proj = vec2_dot(c.center, normal);
        float c_min = circle_proj - c.radius;
        float c_max = circle_proj + c.radius;

        float overlap = sat_overlap(poly_min, poly_max, c_min, c_max);
        if (overlap <= 0.0f) return manifold_none(); /* separating axis found */

        if (overlap < min_overlap) {
            min_overlap = overlap;
            best_normal = normal;
        }
    }

    /* Also test axis from polygon centre to circle centre */
    {
        Vec2 poly_centre = {0, 0};
        for (int i = 0; i < poly->count; i++) {
            poly_centre = vec2_add(poly_centre, poly->verts[i]);
        }
        poly_centre = vec2_div(poly_centre, (float)poly->count);

        Vec2 axis = vec2_normalize(vec2_sub(c.center, poly_centre));
        float poly_min, poly_max;
        sat_project(poly, axis, &poly_min, &poly_max);
        float cp = vec2_dot(c.center, axis);
        float c_min = cp - c.radius;
        float c_max = cp + c.radius;
        float overlap = sat_overlap(poly_min, poly_max, c_min, c_max);
        if (overlap <= 0.0f) return manifold_none();
        if (overlap < min_overlap) {
            min_overlap = overlap;
            best_normal = axis;
        }
    }

    /* Ensure normal points from polygon toward circle */
    {
        Vec2 poly_centre = {0, 0};
        for (int i = 0; i < poly->count; i++)
            poly_centre = vec2_add(poly_centre, poly->verts[i]);
        poly_centre = vec2_div(poly_centre, (float)poly->count);

        Vec2 to_circle = vec2_sub(c.center, poly_centre);
        if (vec2_dot(to_circle, best_normal) < 0.0f)
            best_normal = vec2_mul(best_normal, -1.0f);
    }

    CollisionManifold m;
    m.hit     = 1;
    m.depth   = min_overlap;
    m.normal  = best_normal;
    m.contact = vec2_sub(c.center, vec2_mul(best_normal, c.radius));
    return m;
}

/* ──────────────────────────────────────────────────────────────────────────
   Polygon vs Polygon  (SAT)
   ────────────────────────────────────────────────────────────────────────── */

/* Test all edge normals of poly_a as candidate separating axes. */
static int sat_axes_test(const Polygon *poly_a, const Polygon *poly_b,
                          float *best_depth, Vec2 *best_normal) {
    for (int i = 0; i < poly_a->count; i++) {
        Vec2 a   = poly_a->verts[i];
        Vec2 b   = poly_a->verts[(i + 1) % poly_a->count];
        Vec2 n   = vec2_normalize(vec2_perpendicular(vec2_sub(b, a)));

        float min_a, max_a, min_b, max_b;
        sat_project(poly_a, n, &min_a, &max_a);
        sat_project(poly_b, n, &min_b, &max_b);

        float overlap = sat_overlap(min_a, max_a, min_b, max_b);
        if (overlap <= 0.0f) return 0; /* separating axis */

        if (overlap < *best_depth) {
            *best_depth  = overlap;
            *best_normal = n;
        }
    }
    return 1;
}

CollisionManifold collide_poly_poly(const Polygon *a, const Polygon *b) {
    float best_depth  = FLT_MAX;
    Vec2  best_normal = {0, 0};

    if (!sat_axes_test(a, b, &best_depth, &best_normal)) return manifold_none();
    if (!sat_axes_test(b, a, &best_depth, &best_normal)) return manifold_none();

    /* Ensure normal points from A toward B */
    Vec2 centre_a = {0, 0}, centre_b = {0, 0};
    for (int i = 0; i < a->count; i++) centre_a = vec2_add(centre_a, a->verts[i]);
    for (int i = 0; i < b->count; i++) centre_b = vec2_add(centre_b, b->verts[i]);
    centre_a = vec2_div(centre_a, (float)a->count);
    centre_b = vec2_div(centre_b, (float)b->count);

    if (vec2_dot(vec2_sub(centre_b, centre_a), best_normal) < 0.0f)
        best_normal = vec2_mul(best_normal, -1.0f);

    /* Approximate contact point: midpoint of overlap region on normal axis */
    float proj_a_min, proj_a_max;
    sat_project(a, best_normal, &proj_a_min, &proj_a_max);
    float contact_t = proj_a_max - best_depth * 0.5f;
    Vec2 contact = vec2_mul(best_normal, contact_t);

    CollisionManifold m;
    m.hit     = 1;
    m.depth   = best_depth;
    m.normal  = best_normal;
    m.contact = contact;
    return m;
}

/* ──────────────────────────────────────────────────────────────────────────
   Raycast helpers
   ────────────────────────────────────────────────────────────────────────── */

RayHit raycast_aabb(Vec2 origin, Vec2 dir, float max_t, AABB box) {
    RayHit r = {0, 0.0f, {0,0}, {0,0}};
    float t_min = 0.0f, t_max = max_t;

    for (int axis = 0; axis < 2; axis++) {
        float d  = (axis == 0) ? dir.x  : dir.y;
        float o  = (axis == 0) ? origin.x : origin.y;
        float mn = (axis == 0) ? box.min.x : box.min.y;
        float mx = (axis == 0) ? box.max.x : box.max.y;

        if (d == 0.0f) {
            if (o < mn || o > mx) return r; /* parallel and outside */
            continue;
        }
        float inv = 1.0f / d;
        float t0 = (mn - o) * inv;
        float t1 = (mx - o) * inv;
        if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
        if (t0 > t_min) t_min = t0;
        if (t1 < t_max) t_max = t1;
        if (t_min > t_max) return r;
    }

    r.hit   = 1;
    r.t     = t_min;
    r.point = vec2_add(origin, vec2_mul(dir, t_min));

    /* Normal: face the ray hit */
    Vec2 centre = {(box.min.x + box.max.x) * 0.5f, (box.min.y + box.max.y) * 0.5f};
    Vec2 to_hit = vec2_sub(r.point, centre);
    float ax = to_hit.x < 0 ? -to_hit.x : to_hit.x;
    float ay = to_hit.y < 0 ? -to_hit.y : to_hit.y;
    if (ax > ay) r.normal = vec2(to_hit.x > 0 ? 1.0f : -1.0f, 0.0f);
    else         r.normal = vec2(0.0f, to_hit.y > 0 ? 1.0f : -1.0f);
    return r;
}

RayHit raycast_circle(Vec2 origin, Vec2 dir, float max_t, Circle c) {
    RayHit r = {0, 0.0f, {0,0}, {0,0}};
    Vec2 oc = vec2_sub(origin, c.center);
    float a = vec2_dot(dir, dir);
    float b = 2.0f * vec2_dot(oc, dir);
    float cval = vec2_dot(oc, oc) - c.radius * c.radius;
    float disc = b * b - 4.0f * a * cval;
    if (disc < 0.0f) return r;
    float sqrt_disc = vec2_length(vec2(disc, 0.0f)); /* sqrtf equivalent */
    /* Use standard sqrt via math.h */
    {
        extern float sqrtf(float);
        sqrt_disc = sqrtf(disc);
    }
    float t = (-b - sqrt_disc) / (2.0f * a);
    if (t < 0.0f) t = (-b + sqrt_disc) / (2.0f * a);
    if (t < 0.0f || t > max_t) return r;
    r.hit   = 1;
    r.t     = t;
    r.point = vec2_add(origin, vec2_mul(dir, t));
    r.normal = vec2_normalize(vec2_sub(r.point, c.center));
    return r;
}

RayHit raycast_poly(Vec2 origin, Vec2 dir, float max_t, const Polygon *poly) {
    RayHit best = {0, max_t + 1.0f, {0,0}, {0,0}};
    int hit = 0;

    for (int i = 0; i < poly->count; i++) {
        Vec2 p0 = poly->verts[i];
        Vec2 p1 = poly->verts[(i + 1) % poly->count];
        Vec2 edge = vec2_sub(p1, p0);
        Vec2 normal = vec2_perpendicular(edge);  /* points outward (CCW polygon) */

        float denom = vec2_dot(dir, normal);
        if (denom == 0.0f) continue; /* ray parallel to edge */

        float t = vec2_dot(vec2_sub(p0, origin), normal) / denom;
        if (t < 0.0f || t > max_t || t >= best.t) continue;

        /* Check if hit point lies within the edge segment */
        Vec2 hit_pt = vec2_add(origin, vec2_mul(dir, t));
        Vec2 edge_n = vec2_normalize(edge);
        float proj = vec2_dot(vec2_sub(hit_pt, p0), edge_n);
        float elen = vec2_length(edge);
        if (proj < 0.0f || proj > elen) continue;

        best.hit    = 1;
        best.t      = t;
        best.point  = hit_pt;
        best.normal = vec2_normalize(normal);
        hit = 1;
    }

    if (!hit) best.hit = 0;
    return best;
}
