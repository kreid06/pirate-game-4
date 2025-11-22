/**
 * Ship Definitions - Shared between Client and Server
 * 
 * This file defines the standard ship hulls and their physics properties.
 * The client uses these definitions to render ships, and the server uses
 * them to create physics bodies.
 */

#ifndef SHIP_DEFINITIONS_H
#define SHIP_DEFINITIONS_H

#include <math.h>

/**
 * Ship hull control points (in ship-local coordinates)
 * Origin is at center of mass
 */
typedef struct {
    float x;
    float y;
} Vec2;

typedef struct {
    Vec2 bow;
    Vec2 bow_tip;
    Vec2 bow_bottom;
    Vec2 stern_bottom;
    Vec2 stern_tip;
    Vec2 stern;
} BrigantineHullPoints;

/**
 * Brigantine hull control points
 * These define the shape of the ship using quadratic Bezier curves
 */
static const BrigantineHullPoints BRIGANTINE_HULL = {
    .bow          = { .x = 190.0f,  .y = 90.0f },
    .bow_tip      = { .x = 415.0f,  .y = 0.0f },
    .bow_bottom   = { .x = 190.0f,  .y = -90.0f },
    .stern_bottom = { .x = -260.0f, .y = -90.0f },
    .stern_tip    = { .x = -345.0f, .y = 0.0f },
    .stern        = { .x = -260.0f, .y = 90.0f }
};

/**
 * Quadratic Bezier curve interpolation
 * B(t) = (1-t)²*P0 + 2(1-t)t*P1 + t²*P2
 * where t ∈ [0, 1]
 */
static inline Vec2 quadratic_bezier_point(Vec2 p0, Vec2 p1, Vec2 p2, float t) {
    float one_minus_t = 1.0f - t;
    Vec2 result;
    result.x = one_minus_t * one_minus_t * p0.x + 
               2.0f * one_minus_t * t * p1.x + 
               t * t * p2.x;
    result.y = one_minus_t * one_minus_t * p0.y + 
               2.0f * one_minus_t * t * p1.y + 
               t * t * p2.y;
    return result;
}

/**
 * Linear interpolation between two points
 */
static inline Vec2 lerp_point(Vec2 p0, Vec2 p1, float t) {
    Vec2 result;
    result.x = p0.x + t * (p1.x - p0.x);
    result.y = p0.y + t * (p1.y - p0.y);
    return result;
}

/**
 * Generate brigantine hull polygon
 * 
 * @param hull_points Output array (must have space for 49 points)
 * @return Number of points generated (should be 49)
 */
static inline int generate_brigantine_hull(Vec2 *hull_points) {
    const BrigantineHullPoints *p = &BRIGANTINE_HULL;
    int idx = 0;
    
    // Curved bow section: bow -> bow_tip -> bow_bottom (13 points)
    for (int i = 0; i <= 12; i++) {
        float t = (float)i / 12.0f;
        hull_points[idx++] = quadratic_bezier_point(p->bow, p->bow_tip, p->bow_bottom, t);
    }
    
    // Straight starboard side: bow_bottom -> stern_bottom (12 points, skip first)
    for (int i = 1; i <= 12; i++) {
        float t = (float)i / 12.0f;
        hull_points[idx++] = lerp_point(p->bow_bottom, p->stern_bottom, t);
    }
    
    // Curved stern section: stern_bottom -> stern_tip -> stern (12 points, skip first)
    for (int i = 1; i <= 12; i++) {
        float t = (float)i / 12.0f;
        hull_points[idx++] = quadratic_bezier_point(p->stern_bottom, p->stern_tip, p->stern, t);
    }
    
    // Straight port side: stern -> bow (11 points, skip first and last to avoid duplication)
    for (int i = 1; i < 12; i++) {
        float t = (float)i / 12.0f;
        hull_points[idx++] = lerp_point(p->stern, p->bow, t);
    }
    
    return idx; // Should be 49
}

/**
 * Brigantine physics properties
 */
#define BRIGANTINE_MASS 5000.0f
#define BRIGANTINE_MOMENT_OF_INERTIA 500000.0f
#define BRIGANTINE_MAX_SPEED 30.0f
#define BRIGANTINE_TURN_RATE 0.5f
#define BRIGANTINE_WATER_DRAG 0.98f
#define BRIGANTINE_ANGULAR_DRAG 0.95f

/**
 * Brigantine dimensions
 */
#define BRIGANTINE_LENGTH 760.0f  // stern_tip to bow_tip
#define BRIGANTINE_BEAM 180.0f    // Width at widest point

/**
 * Brigantine module IDs
 */
#define BRIGANTINE_DECK_ID 200
#define BRIGANTINE_HELM_ID 1000
#define BRIGANTINE_PLANK_START_ID 100

/**
 * Helm position (ship-local coordinates)
 */
static const Vec2 BRIGANTINE_HELM_POSITION = { .x = -90.0f, .y = 0.0f };

#endif // SHIP_DEFINITIONS_H
