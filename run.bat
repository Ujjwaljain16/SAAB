@echo off
setlocal enabledelayedexpansion

title SAAB Mission Control — Turnkey Launcher

echo ============================================================
echo   SAAB — Autonomous Academic Solver & Mission Control
echo ============================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js (v18+) from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo [1/4] Node.js environment detected:
node -v

:: 2. Check & Install Dependencies
if not exist "node_modules\" (
    echo [2/4] Installing project dependencies (first run only)...
    call npm install
) else (
    echo [2/4] Dependencies already installed.
)

:: 3. Setup .env file
if not exist ".env" (
    echo [3/4] Initializing local .env configuration from .env.example...
    copy ".env.example" ".env" >nul
) else (
    echo [3/4] Local .env configuration ready.
)

:: 4. Check Playwright Chromium
echo [4/4] Ensuring Chromium browser is installed for automation...
call npx playwright install chromium

echo.
echo ============================================================
echo   Launching Mission Control Dashboard...
echo   Dashboard URL: http://localhost:3000
echo ============================================================
echo.

:: Open browser automatically after 1.5 seconds in background
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start the Web Server
node ui_server.js

pause
