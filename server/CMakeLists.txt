cmake_minimum_required(VERSION 3.16)
project(pirate-server C)

# C11 standard with warnings as errors
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra")
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

# Source files organized by module (only files that actually exist)
set(CORE_SOURCES
    src/core/math.c
    src/core/rng.c
    src/core/hash.c
    src/core/input_validation.c
    src/core/memory_pool.c
    src/core/rewind_buffer.c
    src/core/server_stats.c
)

set(SIM_SOURCES
    src/sim/simulation.c
    src/sim/module_types.c
)

set(NET_SOURCES
    src/net/network.c
    src/net/protocol.c
    src/net/reliability.c
    src/net/snapshot.c
    src/net/websocket_server.c
    src/net/websocket_protocol.c
)

set(AOI_SOURCES
    src/aoi/grid.c
)

set(UTIL_SOURCES
    src/util/time.c
    src/util/log.c
)

set(ADMIN_SOURCES
    src/admin/admin_server.c
    src/admin/admin_api.c
)

# Main executable
add_executable(pirate-server
    src/main.c
    src/server.c
    ${CORE_SOURCES}
    ${SIM_SOURCES}
    ${NET_SOURCES}
    ${AOI_SOURCES}
    ${UTIL_SOURCES}
    ${ADMIN_SOURCES}
)

# System libraries
find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)
target_link_libraries(pirate-server 
    Threads::Threads 
    m 
    OpenSSL::SSL 
    OpenSSL::Crypto
)

# Optional: xxHash for fast hashing (fallback to simple hash if not available)
find_path(XXHASH_INCLUDE_DIR xxhash.h)
find_library(XXHASH_LIBRARY xxhash)
if(XXHASH_INCLUDE_DIR AND XXHASH_LIBRARY)
    target_include_directories(pirate-server PRIVATE ${XXHASH_INCLUDE_DIR})
    target_link_libraries(pirate-server ${XXHASH_LIBRARY})
    target_compile_definitions(pirate-server PRIVATE HAVE_XXHASH=1)
endif()

# Test executables
add_executable(test-determinism 
    tests/test_determinism.c 
    ${CORE_SOURCES} 
    ${SIM_SOURCES} 
    ${UTIL_SOURCES}
)
target_link_libraries(test-determinism m)

add_executable(test-protocol 
    tests/test_protocol.c 
    src/net/protocol.c
    ${UTIL_SOURCES}
)
target_link_libraries(test-protocol m)

# Note: bot-client disabled due to complex dependencies on network/simulation modules
# It can be built separately if needed for load testing

# Enable testing
enable_testing()
add_test(NAME determinism COMMAND test-determinism)
add_test(NAME protocol COMMAND test-protocol)

# Install targets
install(TARGETS pirate-server DESTINATION bin)
install(FILES config/server.conf DESTINATION etc/pirate-server)