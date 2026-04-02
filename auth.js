import { chromium } from 'playwright';
import 'dotenv/config';
import { loginToScaler } from './scaler_login.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

export async function login() {
  const userDataDir = path.join(process.cwd(), 'temp_chrome_profile');
  const profileName = 'Profile 3';

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      `--profile-directory=${profileName}`,
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  try {
    const page = ctx.pages()[0] || await ctx.newPage();

    console.log('Navigating to Scaler login...');
    await loginToScaler(page);

    // Save session atomically — write to tmp then rename
    await ctx.storageState({ path: 'session.json.tmp' });
    fs.renameSync('session.json.tmp', 'session.json');
    console.log('Successfully logged in. Session saved to session.json.');
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  login().catch((err) => { console.error(err); process.exit(1); });
}
