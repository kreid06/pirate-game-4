cmake_minimum_required(VERSION 3.16)
project(pirate-sim C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ──────────────────────────────────────────────────────────────────────────
# Source files for the shared library
# ──────────────────────────────────────────────────────────────────────────

set(PIRATE_SIM_SOURCES
  sim/math.c         # Float Vec2 / Mat3 math (Phase 1)
  sim/fixed.c        # Q16.16 fixed-point math (Phase 1 – both APIs)
  sim/collision.c    # 2D collision detection / SAT (Phase 2)
  sim/ship_physics.c # Ship / player / projectile physics (Phase 3)
)

# ──────────────────────────────────────────────────────────────────────────
# Math library (not needed with Emscripten)
# ──────────────────────────────────────────────────────────────────────────

if(NOT EMSCRIPTEN)
  link_libraries(m)
endif()

# ──────────────────────────────────────────────────────────────────────────
# Static library (server linking)
# ──────────────────────────────────────────────────────────────────────────

add_library(pirate-sim STATIC ${PIRATE_SIM_SOURCES})
target_include_directories(pirate-sim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

# Export for parent CMakeLists.txt
set(PIRATE_SIM_LIBRARY    pirate-sim                              PARENT_SCOPE)
set(PIRATE_SIM_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/include   PARENT_SCOPE)

# ──────────────────────────────────────────────────────────────────────────
# WASM module (Emscripten only)
# ──────────────────────────────────────────────────────────────────────────

if(EMSCRIPTEN)
  add_executable(pirate-sim.wasm
    ${PIRATE_SIM_SOURCES}
    wasm-bridge.c
  )
  target_include_directories(pirate-sim.wasm PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

  # Output pirate-sim.js + pirate-sim.wasm
  set_target_properties(pirate-sim.wasm PROPERTIES SUFFIX ".js")

  set(EXPORTED_FUNCTIONS
    "_vec2_length_wasm"
    "_vec2_normalize_wasm"
    "_vec2_rotate_wasm"
    "_vec2_distance_wasm"
    "_circle_overlaps_circle_wasm"
    "_deg_to_rad_wasm"
    "_rad_to_deg_wasm"
    # Phase 2 — collision
    "_circle_vs_circle_wasm"
    "_aabb_vs_circle_wasm"
    "_poly_vs_circle_wasm"
    "_poly_vs_poly_wasm"
    # Phase 3 — physics
    "_ship_step_wasm"
    "_player_step_wasm"
    "_projectile_step_wasm"
    # Memory
    "_malloc"
    "_free"
  )

  # Join list into bracket-quoted JS array string
  string(REPLACE ";" "," EXPORTED_FN_STR "${EXPORTED_FUNCTIONS}")

  target_link_options(pirate-sim.wasm PRIVATE
    -sWASM=1
    -sWASM_BIGINT
    "-sEXPORTED_FUNCTIONS=[${EXPORTED_FN_STR}]"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPF32','HEAP32']"
    -sALLOW_MEMORY_GROWTH=1
    --no-entry
  )
endif()

# ──────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────

if(BUILD_TESTING)
  enable_testing()

  add_executable(test-math tests/test_math.c sim/math.c)
  target_include_directories(test-math PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  if(NOT EMSCRIPTEN)
    target_link_libraries(test-math m)
  endif()
  add_test(NAME math COMMAND test-math)

  add_executable(test-fixed tests/test_fixed.c sim/fixed.c sim/math.c)
  target_include_directories(test-fixed PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  if(NOT EMSCRIPTEN)
    target_link_libraries(test-fixed m)
  endif()
  add_test(NAME fixed COMMAND test-fixed)

  add_executable(test-collision tests/test_collision.c sim/collision.c sim/math.c)
  target_include_directories(test-collision PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  if(NOT EMSCRIPTEN)
    target_link_libraries(test-collision m)
  endif()
  add_test(NAME collision COMMAND test-collision)
endif()

