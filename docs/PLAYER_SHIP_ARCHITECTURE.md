# Player-Ship Architecture Specification

## Core Concept
**Players and Ships are completely independent entities:**
- **Ships**: Physics-simulated vessels that move through the world
- **Players**: Characters that can walk on ships, jump between ships, and swim in water

## Entity Hierarchy

```
World
├── Ships (Physics Objects)
│   ├── Hull (Collision Shape)
│   ├── Position/Rotation/Velocity
│   ├── Deck Surface (Walkable Area)
│   └── Cannons/Equipment
│
└── Players (Character Controllers)
    ├── World Position (absolute)
    ├── Parent Ship (if standing on one)
    ├── Local Position (relative to ship)
    └── Movement State (walking/swimming/falling)
```

## Key Systems

### 1. Player Movement States

| State | Description | Parent Ship |
|-------|-------------|-------------|
| **WALKING** | Standing on ship deck | Yes |
| **SWIMMING** | In water | No |
| **FALLING** | Airborne (jumped off ship) | No |
| **BOARDING** | Transitioning between ships | Changing |

### 2. Coordinate Systems

#### World Coordinates
- Absolute position in game world
- Used for physics simulation
- Ships move in world space

#### Ship-Local Coordinates
- Position relative to ship origin
- Rotates with ship
- Used for player walking on deck

#### Conversion
```c
// Player world position = Ship world position + rotated local position
Vec2 player_world = ship_position + rotate(player_local, ship_rotation);

// Player local position = inverse rotated offset
Vec2 player_local = rotate_inverse(player_world - ship_position, ship_rotation);
```

## Ship Entity

### Ship Structure
```c
typedef struct Ship {
    uint32_t ship_id;
    
    // Physics State
    float x, y;                    // World position (center of mass)
    float rotation;                // Radians (direction ship faces)
    float velocity_x, velocity_y;  // World velocity
    float angular_velocity;        // Rotation speed
    
    // Ship Properties
    float mass;
    float length;                  // Dimensions
    float width;
    
    // Deck Areas (walkable zones for players)
    DeckArea* deck_areas;
    int deck_area_count;
    
    // Equipment
    Cannon* cannons;
    int cannon_count;
    
    // Players on this ship
    uint32_t* player_ids;
    int player_count;
    
    // AI/Control
    ShipController controller;     // AI or player-controlled
} Ship;
```

### Ship Movement
Ships move independently based on:
- **Wind**: Affects sails (if implemented)
- **Momentum**: Ships have mass and inertia
- **Steering**: Rudder control affects rotation
- **Water Drag**: Friction/resistance

```c
void update_ship_physics(Ship* ship, float dt) {
    // Apply drag
    ship->velocity_x *= 0.98f;
    ship->velocity_y *= 0.98f;
    ship->angular_velocity *= 0.95f;
    
    // Apply steering input (if player-controlled)
    if (ship->controller.type == PLAYER_CONTROLLED) {
        ship->angular_velocity += ship->controller.rudder_input * TURN_RATE;
        
        // Sails affect forward thrust
        float thrust = ship->controller.sail_position * SHIP_THRUST;
        ship->velocity_x += cos(ship->rotation) * thrust;
        ship->velocity_y += sin(ship->rotation) * thrust;
    }
    
    // Update position
    ship->x += ship->velocity_x * dt;
    ship->y += ship->velocity_y * dt;
    ship->rotation += ship->angular_velocity * dt;
}
```

## Player Entity

### Player Structure
```c
typedef struct Player {
    uint32_t player_id;
    
    // World State
    float world_x, world_y;        // Absolute world position
    float rotation;                // Direction player faces (for mouse aiming)
    
    // Ship Relationship
    uint32_t parent_ship_id;       // 0 if in water/falling
    float local_x, local_y;        // Position relative to ship
    
    // Movement State
    PlayerMovementState state;     // WALKING, SWIMMING, FALLING, BOARDING
    float velocity_x, velocity_y;  // Relative velocity (for walking on deck)
    
    // Input
    float movement_input_x;        // WASD normalized
    float movement_input_y;
    float aim_rotation;            // Where player aims (from mouse)
    
} Player;
```

### Player Movement States

#### WALKING (on ship)
```c
void update_player_walking(Player* player, Ship* ship, float dt) {
    // Player movement is relative to ship
    float local_speed = PLAYER_WALK_SPEED; // 3 m/s
    
    // Apply movement input in local ship space
    player->local_x += player->movement_input_x * local_speed * dt;
    player->local_y += player->movement_input_y * local_speed * dt;
    
    // Clamp to deck boundaries
    clamp_to_deck(player, ship);
    
    // Convert to world position (ship position + rotated local offset)
    Vec2 local_rotated = rotate_vector(
        (Vec2){player->local_x, player->local_y},
        ship->rotation
    );
    
    player->world_x = ship->x + local_rotated.x;
    player->world_y = ship->y + local_rotated.y;
    
    // Inherit ship velocity for physics
    player->velocity_x = ship->velocity_x;
    player->velocity_y = ship->velocity_y;
}
```

#### SWIMMING (in water)
```c
void update_player_swimming(Player* player, float dt) {
    const float SWIM_SPEED = 1.5f; // Half walking speed
    const float WATER_DRAG = 0.9f;
    
    // Direct world-space movement
    player->velocity_x += player->movement_input_x * SWIM_SPEED * dt;
    player->velocity_y += player->movement_input_y * SWIM_SPEED * dt;
    
    // Water drag
    player->velocity_x *= WATER_DRAG;
    player->velocity_y *= WATER_DRAG;
    
    // Update world position
    player->world_x += player->velocity_x * dt;
    player->world_y += player->velocity_y * dt;
    
    player->parent_ship_id = 0; // Not on a ship
}
```

#### BOARDING (jumping to another ship)
```c
void check_boarding(Player* player, Ship* ships, int ship_count) {
    // If player is in water or falling
    if (player->state != WALKING) {
        // Check if player is touching any ship deck
        for (int i = 0; i < ship_count; i++) {
            if (point_in_deck_area(player->world_x, player->world_y, &ships[i])) {
                // Player is now on this ship
                player->parent_ship_id = ships[i].ship_id;
                player->state = WALKING;
                
                // Convert world position to local ship coordinates
                Vec2 offset = {
                    player->world_x - ships[i].x,
                    player->world_y - ships[i].y
                };
                Vec2 local = rotate_vector_inverse(offset, ships[i].rotation);
                player->local_x = local.x;
                player->local_y = local.y;
                
                log_info("Player %u boarded ship %u", player->player_id, ships[i].ship_id);
                break;
            }
        }
    }
}
```

## Control Scheme

### Ship Controls (if player is captain)
```json
{
  "type": "ship_control",
  "ship_id": 1234,
  "rudder": 0.5,      // -1 to 1 (turn rate)
  "sails": 0.8        // 0 to 1 (speed)
}
```

### Player Movement (always)
```json
{
  "type": "player_input",
  "timestamp": 1763680733614,
  "rotation": 2.356,         // Where player aims (mouse)
  "movement": {
    "x": 0.707,             // WASD input (walking direction)
    "y": -0.707
  },
  "actions": 1              // Jump, fire cannon, etc.
}
```

## Network Protocol

### Game State Update
```json
{
  "type": "GAME_STATE",
  "tick": 3721,
  "ships": [
    {
      "id": 1,
      "x": 500.0,
      "y": 300.0,
      "rotation": 1.57,
      "velocity_x": 2.5,
      "velocity_y": 0.0,
      "angular_velocity": 0.1
    }
  ],
  "players": [
    {
      "id": 1000,
      "name": "Player",
      "world_x": 505.0,        // Absolute position
      "world_y": 302.0,
      "rotation": 0.785,       // Aim direction
      "parent_ship": 1,        // On ship ID 1
      "local_x": 5.0,          // Relative to ship
      "local_y": 2.0,
      "state": "WALKING"
    },
    {
      "id": 1001,
      "name": "Enemy",
      "world_x": 520.0,
      "world_y": 305.0,
      "rotation": -1.57,
      "parent_ship": 1,        // Also on ship ID 1
      "local_x": 20.0,
      "local_y": 5.0,
      "state": "WALKING"
    }
  ],
  "projectiles": []
}
```

## Gameplay Mechanics

### 1. Ship-to-Ship Combat
- Players on different ships shoot cannons at each other
- Ships can collide and cause damage
- Boarding is possible when ships are close

### 2. Crew Cooperation
- Multiple players on same ship
- One player steers (captain)
- Others fire cannons, repair, fight boarders

### 3. Boarding Actions
- **Jump**: Player leaves ship (enters FALLING state)
- **Land on Deck**: Automatically enters WALKING state on new ship
- **Miss**: Falls in water (enters SWIMMING state)

### 4. Physics Interactions
- **Ship Rotation**: Player position rotates with ship
- **Ship Movement**: Player inherits ship velocity
- **Relative Movement**: Player walks independently on moving ship

## Implementation Phases

### Phase 1: Static Ships ✓
- Ships exist as static platforms
- Players can walk on deck
- Local/world coordinate conversion

### Phase 2: Moving Ships
- Ships have velocity
- Players inherit ship motion
- Coordinate system updates per tick

### Phase 3: Ship Controls
- Rudder/sail input
- Ship physics simulation
- Captain role

### Phase 4: Boarding
- Jump action
- Collision detection with ship decks
- State transitions (walking → falling → swimming → walking)

### Phase 5: Multi-Ship Combat
- Multiple ships in world
- Ship-ship collisions
- Players on different ships

## Server Architecture

### Entity Management
```c
typedef struct GameWorld {
    Ship ships[MAX_SHIPS];
    int ship_count;
    
    Player players[MAX_PLAYERS];
    int player_count;
    
    Projectile projectiles[MAX_PROJECTILES];
    int projectile_count;
} GameWorld;
```

### Update Loop (30 Hz)
```c
void world_update(GameWorld* world, float dt) {
    // 1. Update ships (physics)
    for (int i = 0; i < world->ship_count; i++) {
        update_ship_physics(&world->ships[i], dt);
    }
    
    // 2. Update players (movement relative to ships)
    for (int i = 0; i < world->player_count; i++) {
        Player* player = &world->players[i];
        
        if (player->parent_ship_id != 0) {
            Ship* ship = find_ship(world, player->parent_ship_id);
            update_player_walking(player, ship, dt);
        } else {
            update_player_swimming(player, dt);
        }
        
        // Check for boarding
        check_boarding(player, world->ships, world->ship_count);
    }
    
    // 3. Update projectiles
    for (int i = 0; i < world->projectile_count; i++) {
        update_projectile(&world->projectiles[i], dt);
    }
    
    // 4. Check collisions
    check_ship_collisions(world);
    check_projectile_hits(world);
}
```

## Client-Side Prediction

### Predict Ship Movement
```javascript
// Client predicts ship position
ship.x += ship.velocity_x * dt;
ship.y += ship.velocity_y * dt;
ship.rotation += ship.angular_velocity * dt;
```

### Predict Player on Ship
```javascript
// Player walks on ship
player.local_x += input.x * WALK_SPEED * dt;
player.local_y += input.y * WALK_SPEED * dt;

// Convert to world position
const rotated = rotateVector(
    {x: player.local_x, y: player.local_y},
    ship.rotation
);
player.world_x = ship.x + rotated.x;
player.world_y = ship.y + rotated.y;
```

### Reconciliation
- Server sends authoritative ship positions
- Server sends authoritative player positions (world + local)
- Client corrects prediction errors smoothly

## Questions to Resolve

1. **Ship Ownership**: Can one player control a ship? Multiple players?
2. **Deck Areas**: Simple rectangle or complex polygon collision?
3. **Jump Mechanics**: Can players jump between moving ships?
4. **Swimming Speed**: How fast in water? Can players drown?
5. **Ship Types**: Different ship sizes/speeds?
6. **Cannon Controls**: Player aims cannons manually or auto-aim?

---

**Status**: 🚧 Architecture Design Phase  
**Next Step**: Implement Ship entity and coordinate conversion system  
**Priority**: Define Ship structure and basic physics before player integration
