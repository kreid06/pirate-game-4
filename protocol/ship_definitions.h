/**
 * ship_definitions.h — C99 header generated from ship_definitions.json.
 * DO NOT EDIT — run `python3 protocol/codegen.py` to regenerate.
 *
 * Source of truth: protocol/ship_definitions.json
 */
#ifndef SHIP_DEFINITIONS_H
#define SHIP_DEFINITIONS_H

#include <math.h>

typedef struct { float x; float y; } Vec2;

/* ── Bezier / lerp helpers (hand-written, not generated) ─────────────────── */

static inline Vec2 _quadratic_bezier(Vec2 p0, Vec2 p1, Vec2 p2, float t) {
    float u = 1.0f - t;
    return (Vec2){
        u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
        u*u*p0.y + 2*u*t*p1.y + t*t*p2.y
    };
}

static inline Vec2 _lerp(Vec2 p0, Vec2 p1, float t) {
    return (Vec2){ p0.x + t*(p1.x-p0.x), p0.y + t*(p1.y-p0.y) };
}

/* ── Brigantine hull control points ─── */
typedef struct {
    Vec2 bow;
    Vec2 bow_tip;
    Vec2 bow_bottom;
    Vec2 stern_bottom;
    Vec2 stern_tip;
    Vec2 stern;
} BrigantineHullPoints;

static const BrigantineHullPoints BRIGANTINE_HULL = {
    .bow = { 190.0f, 90.0f },
    .bow_tip = { 415.0f, 0.0f },
    .bow_bottom = { 190.0f, -90.0f },
    .stern_bottom = { -260.0f, -90.0f },
    .stern_tip = { -345.0f, 0.0f },
    .stern = { -260.0f, 90.0f },
};

static inline int generate_brigantine_hull(Vec2 *out) {
    const BrigantineHullPoints *p = &BRIGANTINE_HULL;
    int i = 0;
    for (int j = 0; j <= 12; j++)
        out[i++] = _quadratic_bezier(p->bow, p->bow_tip, p->bow_bottom, (float)j/12.0f);
    for (int j = 1; j <= 12; j++)
        out[i++] = _lerp(p->bow_bottom, p->stern_bottom, (float)j/12.0f);
    for (int j = 1; j <= 12; j++)
        out[i++] = _quadratic_bezier(p->stern_bottom, p->stern_tip, p->stern, (float)j/12.0f);
    for (int j = 1; j <= 10; j++)
        out[i++] = _lerp(p->stern, p->bow, (float)j/11.0f);
    return i; /* expected: 49 */
}

/* ── Brigantine physics / dimensions ─── */
#define BRIGANTINE_MASS 5000.0f
#define BRIGANTINE_MOMENT_OF_INERTIA 500000.0f
#define BRIGANTINE_MAX_SPEED 30.0f
#define BRIGANTINE_TURN_RATE 0.5f
#define BRIGANTINE_WATER_DRAG 0.98f
#define BRIGANTINE_ANGULAR_DRAG 0.95f

#define BRIGANTINE_LENGTH 760.0f
#define BRIGANTINE_BEAM 180.0f

/* ── Brigantine module IDs ─── */
#define BRIGANTINE_DECK_ID 200
#define BRIGANTINE_HELM_ID 1000
static const Vec2 BRIGANTINE_HELM_POSITION = { -90.0f, 0.0f };
#define BRIGANTINE_PLANK_SEGMENTS_START_ID 100
#define BRIGANTINE_PLANK_SEGMENTS_COUNT 48

#endif /* SHIP_DEFINITIONS_H */
