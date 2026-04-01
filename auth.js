import { chromium } from 'playwright';
import 'dotenv/config';
import { loginToScaler } from './scaler_login.js';
import path from 'path';

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
  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('Navigating to Scaler login...');
  await loginToScaler(page);

  // Save session — never need to log in again
  await ctx.storageState({ path: 'session.json' });
  await ctx.close();
  console.log('Successfully logged in. Session saved to session.json.');
}

import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  login().catch(console.error);
}
