import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const REQUIRED_DEPS = [
  'express',
  'playwright',
  'dotenv',
  '@google/generative-ai',
  'fs-extra',
  'pdf-parse'
];

function checkAndInstallDeps() {
  const missing = REQUIRED_DEPS.filter((dep) => {
    const depPath = path.join(rootDir, 'node_modules', ...dep.split('/'));
    return !fs.existsSync(depPath);
  });

  if (missing.length > 0 || !fs.existsSync(path.join(rootDir, 'node_modules'))) {
    console.log('\n============================================================');
    console.log('🚀 SAAB Mission Control — Student Academic Assistant & Auto-Bootstrapper');
    console.log(`Missing dependencies detected (${missing.join(', ')}).`);
    console.log('Running npm install automatically...');
    console.log('============================================================\n');
    try {
      execSync('npm install', { stdio: 'inherit', cwd: rootDir });
      console.log('\n[Bootstrap] ✅ All dependencies installed successfully.\n');
    } catch (err) {
      console.error('\n[Bootstrap] ❌ Failed to run npm install automatically:', err.message);
      process.exit(1);
    }
  } else {
    // All dependencies present
  }
}

function ensureEnv() {
  const envPath = path.join(rootDir, '.env');
  const envExamplePath = path.join(rootDir, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    try {
      fs.copyFileSync(envExamplePath, envPath);
      console.log('[Bootstrap] ✅ Initialized .env configuration from .env.example.');
    } catch (err) {
      console.warn('[Bootstrap] ⚠️ Could not copy .env.example:', err.message);
    }
  }
}

async function ensurePlaywrightBrowsers() {
  try {
    const { chromium } = await import('playwright');
    try {
      chromium.executablePath();
    } catch {
      console.log('\n[Bootstrap] Playwright Chromium browser not detected. Installing...');
      execSync('npx playwright install chromium', { stdio: 'inherit', cwd: rootDir });
      console.log('[Bootstrap] ✅ Chromium browser ready for automation.\n');
    }
  } catch {
    // If playwright cannot be dynamically imported yet, skip
  }
}

async function main() {
  ensureEnv();
  checkAndInstallDeps();
  await ensurePlaywrightBrowsers();
}

main().catch((err) => {
  console.error('[Bootstrap] Error during pre-flight setup:', err);
  process.exit(1);
});
