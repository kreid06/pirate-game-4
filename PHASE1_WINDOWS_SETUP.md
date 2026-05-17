# Phase 1 Setup — Windows Installation Guide

This guide walks you through installing all prerequisites for Phase 1 (WASM development).

## Prerequisites Checklist

- [ ] Node.js 18+ (LTS recommended)
- [ ] npm (comes with Node.js)
- [ ] CMake 3.16+
- [ ] Emscripten SDK
- [ ] GCC/MinGW or MSVC (for running C tests locally)

## Step 1: Install Node.js

1. Go to https://nodejs.org/
2. Download **LTS version** (18+ or higher)
3. Run installer, check all default options
4. Verify installation:
   ```powershell
   node --version    # v18.x.x or higher
   npm --version     # 9.x.x or higher
   ```

## Step 2: Install CMake

1. Go to https://cmake.org/download/
2. Download **Windows x64 Installer**
3. Run installer
4. **Important**: Check "Add CMake to system PATH"
5. Verify installation:
   ```powershell
   cmake --version   # cmake version 3.16+
   ```

## Step 3: Install Emscripten SDK

### Option A: Using Git (Recommended)

```powershell
# Open PowerShell as Administrator

# Navigate to C: drive root
cd C:\

# Clone Emscripten repo
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk

# Install latest Emscripten
.\emsdk install latest
.\emsdk activate latest

# Initialize environment
.\emsdk_env.bat
```

### Option B: Direct Download

1. Go to https://github.com/emscripten-core/emsdk/releases
2. Download `emsdk-windows-x64.zip`
3. Extract to `C:\emsdk`
4. Open PowerShell as Administrator:
   ```powershell
   cd C:\emsdk
   .\emsdk install latest
   .\emsdk activate latest
   ```

### Option C: Using Node Package Manager

```powershell
npm install -g emscripten
```

### Verify Emscripten

```powershell
emcc --version    # emcc (Emscripten gcc/clang-like replacement) X.X.X
```

## Step 4: Add Emscripten to PATH (If Needed)

If `emcc --version` doesn't work after installation:

1. **Windows Settings → Environment Variables**
2. Click "Environment Variables" at bottom
3. Under "User variables", click "New"
   - Variable name: `EMSDK`
   - Variable value: `C:\emsdk`
4. Edit "Path" and add:
   - `C:\emsdk`
   - `C:\emsdk\node\16.20.0_64bit\bin` (adjust version as needed)
5. Click OK, restart PowerShell

## Step 5: Install GCC (Optional, for Local C Tests)

You can skip this if you only care about WASM. For running C unit tests locally:

### Option A: MinGW

1. Go to https://www.mingw-w64.org/
2. Download installer
3. Choose:
   - Architecture: x86_64
   - Threads: posix
4. Install to `C:\mingw64` (or similar)
5. Add to PATH: `C:\mingw64\bin`

### Option B: Use Visual Studio Build Tools

Visual Studio Community comes with MSVC which includes a C compiler:

1. Install Visual Studio Community (free)
2. Include "C++ build tools"
3. Verify:
   ```powershell
   cl.exe    # Microsoft Visual C++ compiler
   ```

## Verify Everything

Run the setup script:

```powershell
cd C:\Users\kevin\Documents\Projects\pirate-game-4
.\setup-phase1-windows.bat
```

You should see all ✅ checks passing.

## Next: Install Project Dependencies

```powershell
npm install
```

This installs TypeScript, Vite, and other client dependencies.

## Ready for Phase 1!

Once everything is verified, follow the tasks in `SHARED_ROADMAP.md` Phase 1:

1. Build WASM module
2. Run C unit tests
3. Test TypeScript bridge
4. Integrate with Vite

## Troubleshooting

### `emcc` command not found

**Solution**: Activate Emscripten in your current PowerShell session:
```powershell
cd C:\emsdk
.\emsdk_env.ps1
# Now try: emcc --version
```

To make it permanent, add the activation to your PowerShell profile:
```powershell
# Open PowerShell profile
notepad $PROFILE

# Add these lines:
$Emsdk = "C:\emsdk"
$env:EMSDK = $Emsdk
$env:PATH = "$Emsdk;$Emsdk\node\16.20.0_64bit\bin;$env:PATH"
```

### `cmake` command not found

**Solution**: Reinstall CMake and make sure "Add to PATH" is checked during installation, then restart PowerShell.

### `node` or `npm` command not found

**Solution**: Reinstall Node.js from nodejs.org, restart PowerShell, verify with `node --version`.

### WASM build fails with "linker error"

**Solution**: Try clearing the build directory and rebuilding:
```powershell
cd shared
Remove-Item build-wasm -Recurse -Force
mkdir build-wasm
cd build-wasm
emconfigure cmake -DCMAKE_BUILD_TYPE=Release ..
emmake make pirate-sim.wasm
```

### C tests fail to compile

**Solution**: If you don't have GCC installed, skip local C tests. The WASM build includes the same code, so it's already being tested.

## References

- Node.js: https://nodejs.org/
- CMake: https://cmake.org/
- Emscripten: https://emscripten.org/
- MinGW: https://www.mingw-w64.org/

---

Once setup is complete, come back to the main roadmap and continue with Phase 1 tasks!
