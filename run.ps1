# SAAB Mission Control — PowerShell Launcher
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  SAAB — Autonomous Academic Solver & Mission Control" -ForegroundColor Cyan
Write-Host "============================================================`n"

# 1. Check Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not installed!" -ForegroundColor Red
    Write-Host "Please download and install Node.js from https://nodejs.org"
    Read-Host "Press Enter to exit"
    exit 1
}

$nodeVer = node -v
Write-Host "[1/4] Node.js environment detected: $nodeVer" -ForegroundColor Green

# 2. Check Dependencies
if (-not (Test-Path "node_modules")) {
    Write-Host "[2/4] Installing project dependencies (first run only)..." -ForegroundColor Yellow
    npm install
} else {
    Write-Host "[2/4] Dependencies already installed." -ForegroundColor Green
}

# 3. Setup .env
if (-not (Test-Path ".env")) {
    Write-Host "[3/4] Initializing local .env from .env.example..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
} else {
    Write-Host "[3/4] Local .env configuration ready." -ForegroundColor Green
}

# 4. Playwright Chromium
Write-Host "[4/4] Ensuring Chromium browser is installed..." -ForegroundColor Yellow
npx playwright install chromium

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "  Launching Mission Control Dashboard..." -ForegroundColor Cyan
Write-Host "  Dashboard URL: http://localhost:3000" -ForegroundColor Green
Write-Host "============================================================`n" -ForegroundColor Cyan

# Open default browser
Start-Process "http://localhost:3000"

# Start the web server
node ui_server.js
