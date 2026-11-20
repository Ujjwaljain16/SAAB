#!/bin/bash
set -e

echo "============================================================"
echo "  SAAB — Autonomous Academic Solver & Mission Control"
echo "============================================================"
echo ""

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo "Please install Node.js from https://nodejs.org"
    exit 1
fi

echo "[1/4] Node.js detected: $(node -v)"

# 2. Check Dependencies
if [ ! -d "node_modules" ]; then
    echo "[2/4] Installing dependencies..."
    npm install
else
    echo "[2/4] Dependencies already installed."
fi

# 3. Setup .env
if [ ! -f ".env" ]; then
    echo "[3/4] Copying .env.example to .env..."
    cp .env.example .env
else
    echo "[3/4] .env configuration present."
fi

# 4. Install Playwright Chromium
echo "[4/4] Ensuring Chromium browser is installed..."
npx playwright install chromium

echo ""
echo "============================================================"
echo "  Launching Mission Control Dashboard..."
echo "  Dashboard URL: http://localhost:3000"
echo "============================================================"
echo ""

# Open browser if supported
if which xdg-open > /dev/null; then
    (sleep 2 && xdg-open http://localhost:3000) &
elif which open > /dev/null; then
    (sleep 2 && open http://localhost:3000) &
fi

node ui_server.js
