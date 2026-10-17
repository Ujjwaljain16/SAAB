// Shared helper: launch a headless browser for DOM tests (system Chrome if present, else Playwright's Chromium).
import { chromium } from 'playwright';

export async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}
