# Brigantine Test Tools

Standalone testing tools for building and testing brigantine ship loadouts without needing a server connection.

## Files

### `BrigantineTestBuilder.ts`
Core builder class for creating custom brigantine loadouts.

**Features:**
- Programmatic ship building API
- Predefined loadout templates
- Module placement and configuration
- Export/import loadout configurations
- Statistics and validation

**Predefined Loadouts:**
- **Minimal** - Basic brigantine with only essential components
- **Combat** - Balanced with 4 cannons and crew positions
- **Artillery** - Maximum firepower with 8 cannons
- **Transport** - Crew-focused with multiple seats and ladders
- **Speed** - Lightweight for racing/speed

### `BrigantineLoadoutTester.ts`
Interactive visual tester for loadouts.

**Features:**
- Real-time visualization of loadouts
- Cycle through predefined configurations
- Module statistics display
- Camera controls (zoom, pan)
- No server connection required

## Usage

### Running the Tester

1. **Start development server:**
   ```bash
   cd client
   npm run dev
   ```

2. **Open the tester:**
   Navigate to `http://localhost:5173/brigantine-tester.html`

3. **Controls:**
   - **Arrow Keys** - Previous/Next loadout
   - **Mouse Wheel** - Zoom in/out
   - **Mouse Drag** - Pan camera
   - **R** - Reset camera to center

### Using the Builder Programmatically

```typescript
import { BrigantineTestBuilder, BrigantineLoadouts } from './test/BrigantineTestBuilder.js';

// Create a new builder
const builder = new BrigantineTestBuilder();

// Start with a predefined loadout
builder.loadLoadout(BrigantineLoadouts.COMBAT);

// Add custom modules
builder
  .addCannon(Vec2.from(100, -70), -Math.PI / 2)
  .addSeat(Vec2.from(50, 0))
  .addLadder(Vec2.from(150, 60), Math.PI / 2);

// Build the ship
const ship = builder.build(Vec2.from(0, 0), 0);

// Get statistics
const stats = builder.getStats();
console.log(`Total modules: ${stats.total}`);
console.log(`Cannons: ${stats.byType.get('cannon')}`);

// Export loadout
const loadout = builder.exportLoadout('Custom Combat', 'Heavy starboard bias');
console.log(JSON.stringify(loadout, null, 2));
```

### Creating Custom Loadouts

```typescript
import { BrigantineLoadout } from './test/BrigantineTestBuilder.js';

const customLoadout: BrigantineLoadout = {
  name: 'Boarding Party',
  description: 'Close-range combat with multiple ladders',
  modules: [
    { kind: 'helm', position: { x: -90, y: 0 } },
    
    // Boarding equipment
    { kind: 'ladder', position: { x: 150, y: -60 }, rotation: -Math.PI / 2 },
    { kind: 'ladder', position: { x: 150, y: 60 }, rotation: Math.PI / 2 },
    { kind: 'ladder', position: { x: -150, y: -60 }, rotation: -Math.PI / 2 },
    { kind: 'ladder', position: { x: -150, y: 60 }, rotation: Math.PI / 2 },
    
    // Crew positions
    { kind: 'seat', position: { x: 50, y: 0 } },
    { kind: 'seat', position: { x: 0, y: -40 } },
    { kind: 'seat', position: { x: 0, y: 40 } },
    
    // Light armament
    { kind: 'cannon', position: { x: 100, y: 0 }, rotation: 0 }
  ]
};

// Use the loadout
builder.loadLoadout(customLoadout);
```

### Testing Physics Validation

```typescript
import { validateBrigantinePhysics } from '../common/ShipDefinitions.js';

const ship = builder.build();

// Validate physics match specification
if (validateBrigantinePhysics(ship)) {
  console.log('✅ Ship physics validated');
} else {
  console.warn('⚠️ Ship physics mismatch');
}
```

## Loadout Templates

### Minimal Loadout
```
Modules: Helm only
Purpose: Testing basic ship mechanics
```

### Combat Loadout (Default)
```
Modules:
  - 1 Helm
  - 4 Cannons (2 per side)
  - 3 Seats

Purpose: Balanced combat configuration
```

### Artillery Loadout
```
Modules:
  - 1 Helm
  - 8 Cannons (4 per side)

Purpose: Maximum firepower
Note: Reduced crew space
```

### Transport Loadout
```
Modules:
  - 1 Helm
  - 7 Seats
  - 2 Boarding Ladders
  - 1 Cannon (defensive)

Purpose: Crew transport and boarding operations
```

### Speed Loadout
```
Modules:
  - 1 Helm
  - 1 Seat
  - 2 Masts (if implemented)

Purpose: Speed trials and racing
Note: Minimal weight for maximum speed
```

## Module Types

| Type | Description | Typical Count |
|------|-------------|---------------|
| `helm` | Steering control | 1 (required) |
| `cannon` | Offensive weapon | 0-8 |
| `seat` | Crew position | 0-10 |
| `ladder` | Boarding equipment | 0-4 |
| `mast` | Speed enhancement | 0-3 |
| `deck` | Ship floor (auto) | 1 (automatic) |
| `plank` | Hull segments (auto) | 48 (automatic) |

## Development

### Adding New Loadouts

1. Edit `BrigantineTestBuilder.ts`
2. Add new static loadout to `BrigantineLoadouts` class:

```typescript
static MY_LOADOUT: BrigantineLoadout = {
  name: 'My Custom Loadout',
  description: 'Description here',
  modules: [
    // Module configurations
  ]
};
```

3. Add to `getAll()` method:
```typescript
static getAll(): BrigantineLoadout[] {
  return [
    this.MINIMAL,
    this.COMBAT,
    this.ARTILLERY,
    this.TRANSPORT,
    this.SPEED,
    this.MY_LOADOUT  // <-- Add here
  ];
}
```

### Module Coordinate System

All module positions use **ship-local coordinates**:
- Origin (0, 0) is at ship center
- X-axis: Forward (+) / Aft (-)
- Y-axis: Port (+) / Starboard (-)
- Rotation: Radians (0 = forward, Math.PI/2 = port)

**Ship Dimensions:**
- Length: 760 units (-345 to 415)
- Beam: 180 units (-90 to 90)

**Typical Module Positions:**
```
Helm: (-90, 0) - Aft center
Bow Cannon: (180, 0) - Forward center
Port Cannon: (50, 60) - Mid-ship port
Starboard Cannon: (50, -60) - Mid-ship starboard
```

## Troubleshooting

**Modules not appearing:**
- Check module coordinates are within ship bounds
- Verify module kind is valid
- Ensure deck and planks are present (automatic)

**Ship rendering incorrectly:**
- Clear browser cache
- Check console for errors
- Verify hull generation in `ShipUtils.ts`

**Performance issues:**
- Reduce cannon count (each cannon adds rendering cost)
- Lower zoom level
- Check browser performance tab

## See Also

- `docs/BRIGANTINE_SPECIFICATION.md` - Complete ship specification
- `client/src/common/ShipDefinitions.ts` - Physics constants
- `client/src/sim/modules.ts` - Module system documentation
- `client/src/sim/ShipUtils.ts` - Ship creation utilities
