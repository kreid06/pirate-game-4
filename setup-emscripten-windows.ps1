# setup-emscripten-windows.ps1 — Automated Emscripten setup for Windows
# 
# Usage (as Administrator):
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
#   .\setup-emscripten-windows.ps1

param(
  [switch]$InstallAll,
  [switch]$SkipNodeCheck,
  [string]$EmsdkPath = "C:\emsdk"
)

$ErrorActionPreference = "Stop"

function Write-Status {
  param([string]$Message, [string]$Status = "info")
  $colors = @{
    "info"    = "Cyan"
    "success" = "Green"
    "error"   = "Red"
    "warning" = "Yellow"
  }
  Write-Host "[$status] $Message" -ForegroundColor $colors[$status]
}

function Test-CommandExists {
  param([string]$Command)
  try {
    $result = & $Command --version 2>&1
    return $true
  }
  catch {
    return $false
  }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Emscripten Setup for Windows" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Check Node.js
Write-Host "Checking prerequisites..." -ForegroundColor Cyan
if (-not (Test-CommandExists "node")) {
  Write-Status "Node.js not found" "error"
  Write-Host "`nInstall Node.js from: https://nodejs.org/ (LTS)" -ForegroundColor Yellow
  Write-Host "Then run this script again.`n"
  exit 1
}
Write-Status "Node.js: $(node --version)" "success"

if (-not (Test-CommandExists "npm")) {
  Write-Status "npm not found" "error"
  exit 1
}
Write-Status "npm: $(npm --version)" "success"

if (-not (Test-CommandExists "cmake")) {
  Write-Status "CMake not found" "error"
  Write-Host "`nInstall CMake from: https://cmake.org/download/" -ForegroundColor Yellow
  Write-Host "Make sure to add CMake to PATH during installation.`n"
  exit 1
}
Write-Status "CMake: $(cmake --version | Select-Object -First 1)" "success"

Write-Host "`nSetting up Emscripten..." -ForegroundColor Cyan

# Check if emsdk already exists
if (Test-Path $EmsdkPath) {
  Write-Status "Found existing Emscripten at $EmsdkPath" "warning"
  $continue = Read-Host "Reinstall? (y/n)"
  if ($continue -ne "y") {
    Write-Status "Skipping installation" "info"
    $activateScript = Join-Path $EmsdkPath "emsdk_env.ps1"
    if (Test-Path $activateScript) {
      Write-Status "To activate Emscripten, run: & `"$activateScript`"" "info"
    }
    exit 0
  }
  Remove-Item $EmsdkPath -Recurse -Force
}

# Clone emsdk
Write-Status "Cloning Emscripten SDK from GitHub..." "info"
$drive = $EmsdkPath.Split("\")[0]
if (-not (Test-Path $drive)) {
  Write-Status "Drive $drive not found" "error"
  exit 1
}

Push-Location $drive\
try {
  git clone https://github.com/emscripten-core/emsdk.git
  if ($LASTEXITCODE -ne 0) {
    Write-Status "Git clone failed. Is Git installed?" "error"
    exit 1
  }
}
finally {
  Pop-Location
}

# Install and activate
Write-Status "Installing Emscripten (this may take several minutes)..." "info"
Push-Location $EmsdkPath
try {
  & .\emsdk install latest
  if ($LASTEXITCODE -ne 0) {
    Write-Status "Installation failed" "error"
    exit 1
  }
  
  & .\emsdk activate latest
  if ($LASTEXITCODE -ne 0) {
    Write-Status "Activation failed" "error"
    exit 1
  }
}
finally {
  Pop-Location
}

# Activate in current session
Write-Status "Activating Emscripten in current session..." "info"
$activateScript = Join-Path $EmsdkPath "emsdk_env.ps1"
if (Test-Path $activateScript) {
  & $activateScript
}

# Verify
Write-Host "`nVerifying installation..." -ForegroundColor Cyan
if (Test-CommandExists "emcc") {
  Write-Status "Emscripten: $(emcc --version | Select-Object -First 1)" "success"
}
else {
  Write-Status "emcc still not found in PATH" "warning"
  Write-Host "`nTo use Emscripten in this session, run:" -ForegroundColor Yellow
  Write-Host "  & `"$activateScript`"`n" -ForegroundColor Yellow
  Write-Host "To make it permanent, add these lines to your PowerShell profile:" -ForegroundColor Yellow
  Write-Host "  `$env:EMSDK = `"$EmsdkPath`"" -ForegroundColor Gray
  Write-Host "  & `"$activateScript`"`n" -ForegroundColor Gray
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Install project dependencies:"
Write-Host "   npm install`n"
Write-Host "2. Follow Phase 1 tasks in SHARED_ROADMAP.md`n"
