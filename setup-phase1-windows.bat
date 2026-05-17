@echo off
REM setup-phase1-windows.bat — Install prerequisites for Phase 1 WASM development
REM 
REM This script checks for and installs:
REM   - Node.js (npm)
REM   - Emscripten SDK
REM   - CMake
REM   - MinGW GCC (optional)

setlocal enabledelayedexpansion

echo =========================================
echo Pirate Game Phase 1 Setup - Windows
echo =========================================
echo.

REM Check Node.js
echo Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ❌ Node.js not found
  echo.
  echo Install from: https://nodejs.org/
  echo (Recommended: LTS version)
  echo.
  echo Then run this script again.
  pause
  exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js found: %NODE_VERSION%
echo.

REM Check npm
echo Checking npm...
npm --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ❌ npm not found
  echo Please install Node.js first
  pause
  exit /b 1
)
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo ✅ npm found: %NPM_VERSION%
echo.

REM Check CMake
echo Checking CMake...
cmake --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ❌ CMake not found
  echo.
  echo Install from: https://cmake.org/download/
  echo (Add to PATH during installation)
  echo.
  echo Then run this script again.
  pause
  exit /b 1
)
for /f "tokens=3" %%i in ('cmake --version') do (
  set CMAKE_VERSION=%%i
  goto :cmake_done
)
:cmake_done
echo ✅ CMake found: %CMAKE_VERSION%
echo.

REM Check Emscripten
echo Checking Emscripten...
emcc --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ❌ Emscripten not found
  echo.
  echo Install from: https://emscripten.org/docs/getting_started/downloads.html
  echo.
  echo Quick setup (PowerShell):
  echo   cd C:\
  echo   git clone https://github.com/emscripten-core/emsdk.git
  echo   cd emsdk
  echo   .\emsdk install latest
  echo   .\emsdk activate latest
  echo.
  echo Then add to your PATH:
  echo   C:\emsdk
  echo   C:\emsdk\node\16.20.0_64bit\bin
  echo.
  echo Then run this script again.
  pause
  exit /b 1
)
for /f "tokens=*" %%i in ('emcc --version') do (
  set EMCC_VERSION=%%i
  goto :emcc_done
)
:emcc_done
echo ✅ Emscripten found: %EMCC_VERSION%
echo.

REM Check GCC (optional, for testing C code)
echo Checking GCC (optional)...
gcc --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ⚠️  GCC not found (optional, only needed for running C tests locally)
  echo.
  echo Install MinGW from: https://www.mingw-w64.org/
  echo Or use MSVC that comes with Visual Studio.
  echo.
) else (
  for /f "tokens=3" %%i in ('gcc --version') do (
    set GCC_VERSION=%%i
    goto :gcc_done
  )
  :gcc_done
  echo ✅ GCC found: %GCC_VERSION%
)
echo.

echo =========================================
echo ✅ All prerequisites found!
echo =========================================
echo.
echo Next steps:
echo.
echo 1. Install Node.js project dependencies:
echo    npm install
echo.
echo 2. Build WASM module:
echo    cd shared
echo    mkdir build-wasm
echo    cd build-wasm
echo    emconfigure cmake -DCMAKE_BUILD_TYPE=Release ..
echo    emmake make pirate-sim.wasm
echo.
echo 3. Copy artifacts to client:
echo    copy pirate-sim.js ..\..\..\client\public\wasm\
echo    copy pirate-sim.wasm ..\..\..\client\public\wasm\
echo.
echo 4. Run tests:
echo    cd ..\..
echo    mkdir build
echo    cd build
echo    cmake -DBUILD_TESTING=ON ..
echo    make
echo    ctest --output-on-failure
echo.
echo Happy coding!
pause
