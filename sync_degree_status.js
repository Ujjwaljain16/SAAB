// sync_degree_status.js — Fast live fetcher for BITS Pilani Degree Courses & Deadlines
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BITS_URLS } from './bits_config.js';
import { discoverDegreeDashboard } from './bits_crawler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function syncLiveDegreeStatus(options = {}) {
  const headless = options.headless ?? true;
  const profileDir = process.env.BITS_PROFILE_DIR
    ? path.resolve(process.env.BITS_PROFILE_DIR)
    : path.join(__dirname, 'temp_chrome_profile_bits');

  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`[Degree Sync] Launching browser to scan live degree dashboard (headless: ${headless})...`);

  const launchOptions = {
    headless,
    channel: 'chrome',
    args: [
      '--start-maximized',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    viewport: { width: 1280, height: 800 }
  };

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (err) {
    if (err.message && err.message.includes('ProcessSingleton')) {
      console.warn('[Degree Sync] Cleaning up stale Chrome locks...');
      if (process.platform === 'win32') {
        try {
          const { execSync } = await import('child_process');
          execSync(
            `powershell -Command "Get-CimInstance Win32_Process -Filter \\"name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*temp_chrome_profile_bits*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
            { stdio: 'ignore' }
          );
        } catch {}
      }
      ctx = await chromium.launchPersistentContext(profileDir, launchOptions);
    } else {
      throw err;
    }
  }

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    // Block heavy tracking/ads
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (/google-analytics|mixpanel|sentry|datadoghq|hotjar|clarity|doubleclick/i.test(url)) {
        return route.abort();
      }
      return route.continue();
    });

    console.log(`[Degree Sync] Navigating to ${BITS_URLS.DEGREE_HOME}...`);
    const dashboard = await discoverDegreeDashboard(page, BITS_URLS.DEGREE_HOME);

    const cacheFile = path.join(__dirname, 'curriculum-cache-bits.json');
    const result = {
      syncedAt: new Date().toISOString(),
      courses: dashboard.courses || [],
      deadlines: dashboard.deadlines || [],
      pending: dashboard.pending || [],
      completed: dashboard.completed || []
    };

    if (result.courses.length === 0) {
      console.warn(`[Degree Sync] ⚠️ 0 courses detected. If this is a fresh clone, run "npm run auth:bits" once (or click "Login Coursera" in the UI) to complete Google sign-in in a visible Chrome browser.`);
    }

    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[Degree Sync] ✓ Successfully synced ${result.courses.length} enrolled courses and ${result.deadlines.length} deadlines.`);
    await ctx.close().catch(() => {});
    return result;
  } catch (err) {
    await ctx.close().catch(() => {});
    throw err;
  }
}

// If executed directly from command line: node sync_degree_status.js
if (process.argv[1] && process.argv[1].endsWith('sync_degree_status.js')) {
  syncLiveDegreeStatus({ headless: !process.argv.includes('--headed') })
    .then((res) => {
      console.log('Sync complete:', res.courses.map((c) => c.name));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Sync failed:', err.message);
      process.exit(1);
    });
}
