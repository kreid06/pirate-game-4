# Protocol Folder Analysis

## Current Usage

### Server ✅ USES Protocol Folder
- **File**: `server/src/net/websocket_server.c`
- **Includes**: `#include "../../protocol/ship_definitions.h"`
- **Purpose**: Uses brigantine hull polygon generation and physics constants directly from C header

### Client ❌ DUPLICATES Protocol Data
- **File**: `client/src/common/ShipDefinitions.ts`
- **Contains**: Duplicate TypeScript version of protocol constants
- **Issue**: Constants exist in two places - can drift out of sync

## Protocol Folder Contents

```
protocol/
├── ship_definitions.h        # C header (SERVER USES THIS)
├── ship_definitions.json     # JSON format (UNUSED)
├── SHIP_DEFINITIONS.md       # Documentation
├── README.md                 # Original readme
├── README_NEW.md            # Updated readme
├── examples/
│   ├── protocol_implementation.ts
│   └── protocol_implementation_websocket.ts
├── schemas/
│   └── messages.json
├── test_protocol.js
├── websocket_test.html
└── example_ship_usage.c
```

## Recommendation: Sync Protocol Data

### Problem
Client has hardcoded TypeScript constants that duplicate `protocol/ship_definitions.h`:

**Server (protocol/ship_definitions.h):**
```c
#define BRIGANTINE_MASS 5000.0f
#define BRIGANTINE_MOMENT_OF_INERTIA 500000.0f
// ...
```

**Client (client/src/common/ShipDefinitions.ts):**
```typescript
export const BRIGANTINE_MASS = 5000.0;
export const BRIGANTINE_MOMENT_OF_INERTIA = 500000.0;
// ...
```

If server changes values, client won't know unless manually updated.

### Solution Options

#### Option 1: Use JSON as Source of Truth (Recommended)
Make `protocol/ship_definitions.json` the canonical source:

1. **Server**: Add build step to generate `.h` from JSON
   ```bash
   # In server/Makefile
   protocol/ship_definitions.h: protocol/ship_definitions.json
       node scripts/generate_protocol_header.js
   ```

2. **Client**: Import JSON directly or generate TypeScript
   ```typescript
   import shipDefs from '../../protocol/ship_definitions.json';
   ```

#### Option 2: Build-time Copy
Copy protocol files during build:

**client/package.json:**
```json
{
  "scripts": {
    "prebuild": "node scripts/sync-protocol.js",
    "dev": "npm run sync-protocol && vite",
    "sync-protocol": "cp ../protocol/ship_definitions.json src/assets/"
  }
}
```

#### Option 3: Shared NPM Package
Publish protocol as separate package both can import:

```bash
# Create protocol package
cd protocol
npm init -y
npm publish --scope=@pirate-game

# In client & server
npm install @pirate-game/protocol
```

#### Option 4: Git Submodule
Make protocol a separate repo, include as submodule:

```bash
# Create protocol repo
git init protocol-repo
git remote add origin git@github.com:user/pirate-protocol.git

# Include in both projects
git submodule add git@github.com:user/pirate-protocol.git protocol
```

## Immediate Action Items

1. ✅ **Keep current setup for now** - It works
2. ⚠️ **Document sync requirement** - When changing protocol, update both:
   - `protocol/ship_definitions.h`
   - `client/src/common/ShipDefinitions.ts`
3. 🔄 **Future improvement** - Implement Option 1 (JSON source of truth)

## Protocol Files Currently Unused

These files in `protocol/` are not actively used:

- ❌ `ship_definitions.json` - Not imported anywhere
- ❌ `test_protocol.js` - Standalone test
- ❌ `websocket_test.html` - Standalone test
- ❌ `examples/*` - Reference implementations only
- ❌ `schemas/messages.json` - Not imported

**Recommendation**: These are documentation/reference. Keep for now.

## Deployment Impact

When deploying:

### Client Deployment
- ✅ Can deploy `client/` folder independently
- ⚠️ Must ensure constants match server version
- 💡 Check `ShipDefinitions.ts` matches server protocol version

### Server Deployment  
- ✅ Can deploy `server/` folder independently
- ✅ Includes `protocol/ship_definitions.h` via relative path
- ⚠️ Must copy `protocol/` folder with server if not in same repo

### Protocol Changes
- 🔴 **Breaking change** if physics constants modified
- Must deploy server first (backward compatible)
- Then deploy client with new constants
- Test thoroughly before deploying both

## Sync Checklist

When modifying brigantine physics:

- [ ] Update `protocol/ship_definitions.h` (C constants)
- [ ] Update `protocol/ship_definitions.json` (JSON data)
- [ ] Update `client/src/common/ShipDefinitions.ts` (TypeScript)
- [ ] Update `protocol/SHIP_DEFINITIONS.md` (Documentation)
- [ ] Test server build compiles
- [ ] Test client build compiles
- [ ] Test runtime with both connected
- [ ] Commit all changes together
