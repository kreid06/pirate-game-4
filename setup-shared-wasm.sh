#!/bin/bash
# setup-shared-wasm.sh — Quick start guide for WASM builds
# 
# Usage:
#   ./setup-shared-wasm.sh          # Setup and build WASM
#   ./setup-shared-wasm.sh test     # Run tests
#   ./setup-shared-wasm.sh clean    # Clean build files

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SHARED_DIR="$SCRIPT_DIR/shared"
CLIENT_WASM_DIR="$SCRIPT_DIR/client/public/wasm"

function check_emscripten() {
  if ! command -v emcc &> /dev/null; then
    echo "❌ Emscripten not found!"
    echo ""
    echo "Install from: https://emscripten.org/docs/getting_started/downloads.html"
    echo ""
    echo "Then activate it:"
    echo "  source ~/emsdk/emsdk_env.sh"
    exit 1
  fi
  echo "✅ Emscripten found: $(emcc --version | head -1)"
}

function build_wasm() {
  echo ""
  echo "🔨 Building WASM module..."
  cd "$SHARED_DIR"
  
  # Clean old build
  rm -rf build-wasm
  mkdir -p build-wasm
  cd build-wasm
  
  # Configure with Emscripten
  emconfigure cmake -DCMAKE_BUILD_TYPE=Release ..
  emmake make pirate-sim.wasm
  
  # Check output
  if [ ! -f "pirate-sim.js" ] || [ ! -f "pirate-sim.wasm" ]; then
    echo "❌ WASM build failed!"
    exit 1
  fi
  
  echo "✅ WASM module built"
  
  # Copy to client
  echo ""
  echo "📦 Copying artifacts to client..."
  mkdir -p "$CLIENT_WASM_DIR"
  cp pirate-sim.js "$CLIENT_WASM_DIR/"
  cp pirate-sim.wasm "$CLIENT_WASM_DIR/"
  echo "✅ Artifacts copied to $CLIENT_WASM_DIR"
}

function build_server_lib() {
  echo ""
  echo "🔨 Building server static library..."
  cd "$SHARED_DIR"
  
  rm -rf build
  mkdir -p build
  cd build
  
  cmake -DCMAKE_BUILD_TYPE=Release ..
  make
  
  if [ ! -f "libpirate-sim.a" ]; then
    echo "❌ Server lib build failed!"
    exit 1
  fi
  
  echo "✅ Server library built: libpirate-sim.a"
}

function run_tests() {
  echo ""
  echo "🧪 Running tests..."
  cd "$SHARED_DIR"
  
  rm -rf build
  mkdir -p build
  cd build
  
  cmake -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=Release ..
  make
  ctest --output-on-failure
  
  echo "✅ All tests passed!"
}

function clean() {
  echo "🧹 Cleaning build artifacts..."
  cd "$SHARED_DIR"
  rm -rf build build-wasm
  echo "✅ Cleaned"
}

function main() {
  check_emscripten
  
  case "${1:-all}" in
    wasm)
      build_wasm
      ;;
    server)
      build_server_lib
      ;;
    test)
      run_tests
      ;;
    clean)
      clean
      ;;
    all|*)
      build_wasm
      build_server_lib
      run_tests
      ;;
  esac
  
  echo ""
  echo "🎉 Done!"
}

main "$@"
