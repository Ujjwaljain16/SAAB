import 'dotenv/config';

export async function loginToScaler(page) {
  if (!process.env.SCALER_EMAIL || !process.env.SCALER_PASS) {
    throw new Error('Missing SCALER_EMAIL or SCALER_PASS in .env file');
  }

  await page.goto('https://www.scaler.com/login', { waitUntil: 'domcontentloaded' });

  await page.fill('#user_email, input[name="user[email]"], input[placeholder*="Email"]', process.env.SCALER_EMAIL);
  await page.fill('#user_password, input[name="user[password]"], input[type="password"]', process.env.SCALER_PASS);

  const submitButton = page.locator('button[type="submit"], button:has-text("LOGIN"), button:has-text("Login")').first();
  await submitButton.waitFor({ state: 'visible', timeout: 10000 });
  await submitButton.click();

  await page.waitForURL(/.*dashboard.*/, { timeout: 30000 });
  await page.goto('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/', { waitUntil: 'networkidle' });
}