cmake_minimum_required(VERSION 3.16)
project(pirate-server C)

# C11 standard with warnings as errors
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra -Werror")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fno-fast-math -ffp-contract=off")

# Build type configurations
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -g -O0 -DDEBUG")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=address -fsanitize=undefined")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fsanitize=address -fsanitize=undefined")
elseif(CMAKE_BUILD_TYPE STREQUAL "Release")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3 -DNDEBUG -march=native")
else()
    set(CMAKE_BUILD_TYPE "RelWithDebInfo")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -g -O2")
endif()

# Include directories
include_directories(include)
include_directories(src)

# Source files organized by module
set(CORE_SOURCES
    src/core/math.c
    src/core/rng.c
    src/core/hash.c
)

set(SIM_SOURCES
    src/sim/simulation.c
    src/sim/physics.c
    src/sim/collision.c
    src/sim/ships.c
)

set(NET_SOURCES
    src/net/socket.c
    src/net/protocol.c
    src/net/reliability.c
    src/net/manager.c
)

set(AOI_SOURCES
    src/aoi/grid.c
    src/aoi/subscription.c
    src/aoi/priority.c
)

set(LAGCOMP_SOURCES
    src/lagcomp/rewind.c
    src/lagcomp/validation.c
)

set(ANTICHEAT_SOURCES
    src/anticheat/envelope.c
    src/anticheat/ratelimit.c
    src/anticheat/anomaly.c
)

set(METRICS_SOURCES
    src/metrics/collector.c
    src/metrics/histogram.c
    src/metrics/export.c
)

set(REPLAY_SOURCES
    src/replay/recorder.c
    src/replay/player.c
    src/replay/diff.c
)

set(UTIL_SOURCES
    src/util/ringbuf.c
    src/util/pool.c
    src/util/arena.c
    src/util/time.c
    src/util/log.c
)

# Main executable
add_executable(pirate-server
    src/main.c
    src/server.c
    ${CORE_SOURCES}
    ${SIM_SOURCES}
    ${NET_SOURCES}
    ${AOI_SOURCES}
    ${LAGCOMP_SOURCES}
    ${ANTICHEAT_SOURCES}
    ${METRICS_SOURCES}
    ${REPLAY_SOURCES}
    ${UTIL_SOURCES}
)

# System libraries
find_package(Threads REQUIRED)
target_link_libraries(pirate-server Threads::Threads m)

# Optional: xxHash for fast hashing (fallback to simple hash if not available)
find_path(XXHASH_INCLUDE_DIR xxhash.h)
find_library(XXHASH_LIBRARY xxhash)
if(XXHASH_INCLUDE_DIR AND XXHASH_LIBRARY)
    target_include_directories(pirate-server PRIVATE ${XXHASH_INCLUDE_DIR})
    target_link_libraries(pirate-server ${XXHASH_LIBRARY})
    target_compile_definitions(pirate-server PRIVATE HAVE_XXHASH=1)
endif()

# Test executables
add_executable(test-determinism tests/test_determinism.c ${CORE_SOURCES} ${SIM_SOURCES} ${UTIL_SOURCES})
target_link_libraries(test-determinism m)

add_executable(test-protocol tests/test_protocol.c ${NET_SOURCES} ${UTIL_SOURCES})
target_link_libraries(test-protocol m)

add_executable(bot-client tests/bot_client.c ${NET_SOURCES} ${UTIL_SOURCES})
target_link_libraries(bot-client Threads::Threads m)

# Enable testing
enable_testing()
add_test(NAME determinism COMMAND test-determinism)
add_test(NAME protocol COMMAND test-protocol)

# Install targets
install(TARGETS pirate-server DESTINATION bin)
install(FILES config/server.conf DESTINATION etc/pirate-server)