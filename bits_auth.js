// bits_auth.js — Dedicated Google OAuth login for Coursera / BITS Pilani
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BITS_URLS, COURSERA_TIMEOUTS } from './bits_config.js';
import { ensureCourseraLoggedIn } from './bits_crawler.js';

export async function loginBits() {
  const userDataDir = process.env.BITS_PROFILE_DIR
    ? path.resolve(process.env.BITS_PROFILE_DIR)
    : path.join(process.cwd(), 'temp_chrome_profile_bits');

  fs.mkdirSync(userDataDir, { recursive: true });

  console.log('\n============================================================');
  console.log('🎓 BITS Pilani / Coursera — Google SSO Authenticator');
  console.log(`Profile directory: ${userDataDir}`);
  console.log('============================================================\n');

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    viewport: { width: 1280, height: 800 }
  });

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    console.log(`Navigating to BITS Degree Home: ${BITS_URLS.DEGREE_HOME}`);
    await page.goto(BITS_URLS.DEGREE_HOME, {
      waitUntil: 'domcontentloaded',
      timeout: COURSERA_TIMEOUTS.PAGE_LOAD
    }).catch(() => {});

    await ensureCourseraLoggedIn(page);

    // Save session storage state atomically
    const sessionFile = 'session_bits.json';
    await ctx.storageState({ path: `${sessionFile}.tmp` }).catch(() => {});
    if (fs.existsSync(`${sessionFile}.tmp`)) {
      fs.renameSync(`${sessionFile}.tmp`, sessionFile);
      console.log(`Session state saved to ${sessionFile}`);
    }

    console.log('\n============================================================');
    console.log('🎉 BITS Pilani Coursera login complete & verified!');
    console.log('============================================================\n');
  } finally {
    await ctx.close().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loginBits().catch((err) => {
    console.error('[BITS Auth Error]:', err.message);
    process.exit(1);
  });
}
