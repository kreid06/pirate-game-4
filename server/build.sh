#!/bin/bash

# Simple build script for environments without CMake
# Usage: ./build.sh [debug|release|test]

set -e

BUILD_TYPE=${1:-debug}
BUILD_DIR="build_${BUILD_TYPE}"
SRC_DIR="src"
INCLUDE_DIR="include"
TEST_DIR="tests"

# Compiler and flags
CC=${CC:-gcc}
CFLAGS_COMMON="-Wall -Wextra -Werror -std=c11 -I${INCLUDE_DIR} -I${SRC_DIR}"

case "$BUILD_TYPE" in
    debug)
        CFLAGS="${CFLAGS_COMMON} -g -O0 -DDEBUG -fsanitize=address -fsanitize=undefined"
        LDFLAGS="-fsanitize=address -fsanitize=undefined -lm -lpthread"
        ;;
    release)
        CFLAGS="${CFLAGS_COMMON} -O3 -DNDEBUG -march=native -fno-fast-math -ffp-contract=off"
        LDFLAGS="-lm -lpthread"
        ;;
    test)
        CFLAGS="${CFLAGS_COMMON} -g -O1 -DTEST"
        LDFLAGS="-lm"
        ;;
    *)
        echo "Usage: $0 [debug|release|test]"
        exit 1
        ;;
esac

echo "Building pirate-server ($BUILD_TYPE mode)"
echo "CC: $CC"
echo "CFLAGS: $CFLAGS"

# Create build directory
mkdir -p "$BUILD_DIR"

# Source files (when they exist)
CORE_SOURCES="
    src/core/math.c
    src/core/rng.c
    src/core/hash.c
"

SIM_SOURCES="
    src/sim/simulation.c
"

NET_SOURCES="
    src/net/protocol.c
    src/net/network_simple.c
"

AOI_SOURCES="
    src/aoi/grid.c
"

ADMIN_SOURCES="
    src/admin/admin_server.c
    src/admin/admin_api.c
"

UTIL_SOURCES="
    src/util/time.c
    src/util/log.c
"

# Check which source files exist
EXISTING_SOURCES=""
for src in $CORE_SOURCES $SIM_SOURCES $NET_SOURCES $AOI_SOURCES $ADMIN_SOURCES $UTIL_SOURCES src/core/server.c src/main.c; do
    if [[ -f "$src" ]]; then
        EXISTING_SOURCES="$EXISTING_SOURCES $src"
    else
        echo "Warning: $src not found, skipping..."
    fi
done

# Build main server (if we have enough sources)
if [[ -f "src/main.c" && -f "src/core/server.c" ]]; then
    echo "Building pirate-server..."
    $CC $CFLAGS $EXISTING_SOURCES -o "$BUILD_DIR/pirate-server" $LDFLAGS
    echo "✓ Built $BUILD_DIR/pirate-server"
else
    echo "⚠ Missing main.c or core/server.c, skipping main binary"
fi

# Build tests if in test mode
if [[ "$BUILD_TYPE" == "test" ]]; then
    echo "Building tests..."
    
    # Test determinism
    if [[ -f "$TEST_DIR/test_determinism.c" && -f "src/core/math.c" && -f "src/core/rng.c" ]]; then
        $CC $CFLAGS "$TEST_DIR/test_determinism.c" -o "$BUILD_DIR/test-determinism" $LDFLAGS
        echo "✓ Built $BUILD_DIR/test-determinism"
    fi
    
    # Test protocol  
    if [[ -f "$TEST_DIR/test_protocol.c" && -f "src/net/protocol.c" ]]; then
        $CC $CFLAGS "$TEST_DIR/test_protocol.c" -o "$BUILD_DIR/test-protocol" $LDFLAGS
        echo "✓ Built $BUILD_DIR/test-protocol"
    fi
    
    # Test simulation integration
    if [[ -f "$TEST_DIR/test_simulation.c" ]]; then
        $CC $CFLAGS "$TEST_DIR/test_simulation.c" -o "$BUILD_DIR/test-simulation" $LDFLAGS
        echo "✓ Built $BUILD_DIR/test-simulation"
    fi
    
    # Bot client
    if [[ -f "$TEST_DIR/bot_client.c" && -f "src/net/protocol.c" ]]; then
        $CC $CFLAGS "$TEST_DIR/bot_client.c" src/net/protocol.c -o "$BUILD_DIR/bot-client" $LDFLAGS
        echo "✓ Built $BUILD_DIR/bot-client"  
    fi
fi

echo ""
echo "Build completed successfully!"
echo "Binaries in: $BUILD_DIR/"
echo ""
echo "Next steps:"
echo "  Run tests:    ./$BUILD_DIR/test-determinism"  
echo "  Run sim test: ./$BUILD_DIR/test-simulation"
echo "  Start server: ./$BUILD_DIR/pirate-server"
echo "  Bot test:     ./$BUILD_DIR/bot-client 10 60"