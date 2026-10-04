import 'dotenv/config';

export async function loginToScaler(page) {
  console.log('Navigating to Scaler login page...');
  await page.goto('https://www.scaler.com/login', { waitUntil: 'domcontentloaded' });

  if (process.env.SCALER_EMAIL && process.env.SCALER_PASS) {
    console.log('Auto-filling Scaler credentials from .env...');
    await page.fill('#user_email, input[name="user[email]"], input[placeholder*="Email"]', process.env.SCALER_EMAIL).catch(() => {});
    await page.fill('#user_password, input[name="user[password]"], input[type="password"]', process.env.SCALER_PASS).catch(() => {});

    const submitButton = page.locator('button[type="submit"], button:has-text("LOGIN"), button:has-text("Login")').first();
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click();
    }
  } else {
    console.log('\n[AUTH NOTICE] No SCALER_EMAIL/SCALER_PASS found in .env.');
    console.log('Please log in manually (Google Auth / Email) in the opened Chrome browser window...\n');
  }

  console.log('Waiting for login completion (redirect to dashboard)...');
  await page.waitForURL(/.*(dashboard|academy|classes).*/, { timeout: 180000 });
  await page.goto('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/', { waitUntil: 'domcontentloaded' });
  console.log('Successfully reached Scaler Curriculum dashboard!');
}