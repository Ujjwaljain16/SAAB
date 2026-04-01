import 'dotenv/config';

export async function loginToScaler(page) {
  await page.goto('https://www.scaler.com/login', { waitUntil: 'domcontentloaded' });

  if (process.env.SCALER_EMAIL) {
    await page.fill('input[type="email"]', process.env.SCALER_EMAIL);
  }

  if (process.env.SCALER_PASS) {
    await page.fill('input[type="password"]', process.env.SCALER_PASS);
  }

  const submitButton = page.locator('button[type="submit"], button:has-text("LOGIN"), button:has-text("Login")').first();
  await submitButton.click().catch(() => {});

  await page.waitForURL(/.*dashboard.*/, { timeout: 120000 });
  await page.goto('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/', { waitUntil: 'networkidle' });
}