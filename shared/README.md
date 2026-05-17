# Pirate Game — Shared C Code Library

Single-source-of-truth physics and math library for client and server.

## Overview

This directory contains pure C code that is:
- **Compiled for server** → Static library (`libpirate-sim.a`) linked to C server
- **Compiled for client** → WebAssembly (`pirate-sim.wasm`) via Emscripten

This ensures **deterministic gameplay**: server and client produce identical physics results.

## Structure

```
shared/
├── include/              Public API headers
│   ├── pirate_math.h     Vector2, Matrix3, circles
│   ├── collision.h       (Phase 2) Collision detection
│   ├── physics.h         (Phase 3) Main physics engine
│   └── ...
│
├── sim/                  Implementation
│   ├── math.c            Math operations
│   ├── collision.c       (Phase 2) Collision algorithms
│   ├── physics.c         (Phase 3) Physics simulation
│   └── ...
│
├── protocol/             Shared asset definitions (JSON)
│   └── ... (see /protocol for details)
│
├── tests/                Unit tests
│   ├── test_math.c       Math validation
│   └── ...
│
├── wasm-bridge.c         JavaScript ↔ C glue layer
├── CMakeLists.txt        Build configuration
└── README.md             This file
```

## Building

### For Server (Static Library)

```bash
cd shared
mkdir build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make
# Produces: libpirate-sim.a
```

### For Client (WebAssembly)

```bash
# Prerequisites: Install Emscripten (https://emscripten.org/)
source ~/emsdk/emsdk_env.sh

cd shared
mkdir build-wasm
cd build-wasm
emconfigure cmake -DCMAKE_BUILD_TYPE=Release ..
emmake make pirate-sim.wasm
# Produces: pirate-sim.js, pirate-sim.wasm
```

### Run Tests

```bash
cd shared
mkdir build
cd build
cmake -DBUILD_TESTING=ON ..
make
ctest
```

## Using in Your Code

### Server (C)

```c
#include "pirate_math.h"

Vec2 a = vec2(3.0f, 4.0f);
float len = vec2_length(a); // 5.0
```

### Client (TypeScript)

```typescript
import { wasmBridge } from './wasm/WasmBridge';

await wasmBridge.initialize('/wasm/pirate-sim.js');

const len = wasmBridge.vec2Length(3, 4); // 5
const [nx, ny] = wasmBridge.vec2Normalize(3, 4); // [0.6, 0.8]
```

## Features by Phase

| Feature | Phase | Status | Server | Client (WASM) |
|---------|-------|--------|--------|---------------|
| Vec2 math | 1 | ✅ | ✓ | ✓ |
| Matrix3 math | 1 | ✅ | ✓ | ✓ |
| Circle collision | 1 | ✅ | ✓ | ✓ |
| Polygon SAT collision | 2 | ⏳ | ✓ | ✓ |
| Physics simulation | 3 | ⏳ | ✓ | ✓ |
| Ship dynamics | 3 | ⏳ | ✓ | ✓ |
| Projectile logic | 3 | ⏳ | ✓ | ✓ |

See [`SHARED_ROADMAP.md`](../SHARED_ROADMAP.md) for detailed phase information.

## Design Principles

1. **Determinism First**
   - All algorithms use IEEE 754 floats
   - No platform-specific code
   - Reproducible across architectures

2. **Zero Dependencies**
   - Only `<math.h>` and `<stdint.h>`
   - No heap allocation (stack-based buffers)
   - No external libraries

3. **Performance**
   - Inline small functions
   - Minimize pointer dereferences
   - Cache-friendly memory layout

4. **Safety**
   - Bounds checking where needed
   - No undefined behavior (validated with Clang, GCC, MSVC)
   - Valgrind/ASAN clean

## Adding New Functions

1. **Add header declaration** in `include/*.h`
2. **Add implementation** in `sim/*.c`
3. **Add tests** in `tests/test_*.c`
4. **For WASM**: Add wrapper in `wasm-bridge.c` + TypeScript in `client/src/wasm/*.ts`

Example:

```c
// include/myfeature.h
Vec2 myfunction_calculate(Vec2 input);

// sim/myfeature.c
Vec2 myfunction_calculate(Vec2 input) {
  return vec2_add(input, vec2(1, 1));
}

// wasm-bridge.c
EMSCRIPTEN_KEEPALIVE
void myfunction_calculate_wasm(float x, float y, float* out_x, float* out_y) {
  Vec2 result = myfunction_calculate(vec2(x, y));
  *out_x = result.x;
  *out_y = result.y;
}

// client/src/wasm/MyFeatureBridge.ts
myFunctionCalculate(x: number, y: number): [number, number] {
  const ptr = this.module._malloc(8);
  this.module.ccall('myfunction_calculate_wasm', null,
    ['number', 'number', 'number', 'number'],
    [x, y, ptr, ptr + 4]);
  // ... read results, free, return
}
```

## Performance Notes

- **WASM overhead**: ~1-5 µs per function call
- **Module size**: ~50-100 KB (gzipped)
- **Load time**: <500ms on typical connections
- **Expected speedup vs TypeScript**: 5-15x for math-heavy code

## Troubleshooting

### WASM Module Not Loading

```
Module is not defined
```

Make sure `pirate-sim.js` is loaded first. Check:
- File exists in `client/public/wasm/`
- Path in `WasmBridge.initialize()` is correct
- Browser console for script errors

### Compilation Errors

```
undefined reference to 'math_function'
```

Ensure you've:
1. Declared the function in a header in `include/`
2. Implemented it in a `.c` file in `sim/`
3. Built the library (run `make`)

### Determinism Issues

If client and server results diverge:
1. Check floating-point operations are identical
2. Verify no platform-specific code
3. Run test suite on both platforms
4. Enable floating-point exceptions in debugger

## Versioning

Semantic versioning for `/shared/`:
- **MAJOR**: Breaking changes to public API
- **MINOR**: New functions, backward compatible
- **PATCH**: Bug fixes, optimizations

Version is defined in `CMakeLists.txt`:

```cmake
project(pirate-sim C)
set(PIRATE_SIM_VERSION 0.1.0)
```

## Contributing

- All code must pass `make test`
- Run Valgrind on changes: `valgrind --leak-check=full ./test_math`
- Document new public functions
- Keep determinism as top priority

## References

- [Emscripten documentation](https://emscripten.org/docs/)
- [IEEE 754 floating point](https://en.wikipedia.org/wiki/IEEE_754)
- [Client-side prediction guide](../docs/client-side-prediction.md)
- [Physics documentation](../docs/PLAYER_SHIP_ARCHITECTURE.md)

---

**Status**: 🚧 Phase 1 scaffolded, ready for development

For roadmap, see [`SHARED_ROADMAP.md`](../SHARED_ROADMAP.md)
