cmake_minimum_required(VERSION 3.16)
project(pirate-sim C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Source files for the shared library
set(PIRATE_SIM_SOURCES
  sim/math.c
  # Phase 2: collision detection
  # sim/collision.c
  # Phase 3: physics engine
  # sim/physics.c
  # sim/ship.c
  # sim/world.c
)

# When building with Emscripten, link math library is not needed
if(NOT EMSCRIPTEN)
  link_libraries(m)
endif()

# Create static library for server linking
add_library(pirate-sim STATIC ${PIRATE_SIM_SOURCES})
target_include_directories(pirate-sim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

# Export library for parent CMakeLists.txt
set(PIRATE_SIM_LIBRARY pirate-sim PARENT_SCOPE)
set(PIRATE_SIM_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/include PARENT_SCOPE)

# When building with Emscripten, create WASM module
if(EMSCRIPTEN)
  add_executable(pirate-sim.wasm ${PIRATE_SIM_SOURCES}
    wasm-bridge.c  # JS ↔ C glue layer
  )
  target_include_directories(pirate-sim.wasm PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

  # Emscripten linker flags
  set_target_properties(pirate-sim.wasm PROPERTIES SUFFIX ".js")
  target_link_options(pirate-sim.wasm PRIVATE
    -sWASM=1
    -sWASM_BIGINT
    -sEXPORTED_FUNCTIONS=['_vec2_length','_vec2_normalize','_vec2_distance','_vec2_rotate','_circle_overlaps_circle']
    -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap']
    --no-entry
  )
endif()

# ──────────────────────────────────────────────────────────────────────────
# Testing (optional, for validation)
# ──────────────────────────────────────────────────────────────────────────

if(BUILD_TESTING)
  enable_testing()
  
  add_executable(test-math tests/test_math.c sim/math.c)
  target_include_directories(test-math PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  if(NOT EMSCRIPTEN)
    target_link_libraries(test-math m)
  endif()
  add_test(NAME math COMMAND test-math)
endif()
