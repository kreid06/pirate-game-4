/**
 * Example: Using ship_definitions.h on the server
 * 
 * This shows how to create a brigantine ship physics body
 * using the shared ship definitions.
 */

#include <stdio.h>
#include "ship_definitions.h"

// Example: Create a ship physics body
void create_brigantine_ship(float x, float y, float rotation) {
    // Generate hull polygon (49 points)
    Vec2 hull[49];
    int point_count = generate_brigantine_hull(hull);
    
    printf("Created brigantine hull with %d points\n", point_count);
    printf("Position: (%.1f, %.1f), Rotation: %.2f rad\n", x, y, rotation);
    printf("Mass: %.1f kg, Max Speed: %.1f m/s\n", 
           BRIGANTINE_MASS, BRIGANTINE_MAX_SPEED);
    
    // Example: Print first few hull points
    printf("\nFirst 5 hull points (ship-local coordinates):\n");
    for (int i = 0; i < 5; i++) {
        printf("  Point %d: (%.2f, %.2f)\n", i, hull[i].x, hull[i].y);
    }
    
    // TODO: Create physics body with your physics engine
    // For example, with Chipmunk2D:
    /*
    cpBody *body = cpBodyNew(BRIGANTINE_MASS, BRIGANTINE_MOMENT_OF_INERTIA);
    cpBodySetPosition(body, cpv(x, y));
    cpBodySetAngle(body, rotation);
    
    cpShape *shape = cpPolyShapeNew(body, point_count, (cpVect*)hull, 
                                    cpTransformIdentity, 0.0);
    cpShapeSetFriction(shape, 0.5);
    
    cpSpaceAddBody(space, body);
    cpSpaceAddShape(space, shape);
    */
    
    // Apply physics properties
    printf("\nPhysics properties:\n");
    printf("  Water drag: %.2f\n", BRIGANTINE_WATER_DRAG);
    printf("  Angular drag: %.2f\n", BRIGANTINE_ANGULAR_DRAG);
    printf("  Turn rate: %.2f rad/s\n", BRIGANTINE_TURN_RATE);
    
    // Helm position for player control
    printf("\nHelm position: (%.1f, %.1f)\n", 
           BRIGANTINE_HELM_POSITION.x, BRIGANTINE_HELM_POSITION.y);
}

int main() {
    printf("=== Brigantine Ship Definition Example ===\n\n");
    
    // Create a ship at position (600, 400) facing right (0 radians)
    create_brigantine_ship(600.0f, 400.0f, 0.0f);
    
    return 0;
}
