import 'dotenv/config';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Automatically logs in to Scaler using Google SSO or standard credentials.
 * Handles:
 * 1. Pre-authenticated state check (redirect directly if session is active).
 * 2. Automated Google SSO button detection and clicking (popup or in-tab).
 * 3. Automated Google Account Chooser selection matching SCALER_EMAIL.
 * 4. Automated Google credential entry if prompt appears (email / password).
 * 5. Instant post-auth redirect to Scaler Core Curriculum without hanging timeouts.
 */
export async function loginToScaler(page) {
  const email = (process.env.SCALER_EMAIL || '').trim();
  const pass = (process.env.SCALER_PASS || '').trim();
  const targetDashboard = 'https://www.scaler.com/academy/mentee-dashboard/core-curriculum/';

  console.log('Navigating to Scaler login check...');

  // 1. Fast check: Maybe we are already authenticated or session is active
  try {
    await page.goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const currentUrl = page.url();
    if (!currentUrl.includes('/login') && !currentUrl.includes('/sign_in')) {
      const isDashboard = await page.waitForSelector('.dropdown__title, .me-cc-header__main, a[href*="/classes"]', { timeout: 5000 }).catch(() => null);
      if (isDashboard) {
        console.log('Already authenticated! Scaler Core Curriculum ready.');
        return;
      }
    }
  } catch (err) {
    // If timeout or redirected, fall through to login page
  }

  console.log('Navigating to Scaler login page...');
  await page.goto('https://www.scaler.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // If already redirected past login
  if (!page.url().includes('/login') && !page.url().includes('/sign_in')) {
    console.log('Redirected to authenticated area. Navigating to curriculum...');
    await page.goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return;
  }

  // Google SSO Selectors on Scaler login
  const googleBtnSelectors = [
    'button:has-text("Google")',
    'a:has-text("Google")',
    'div[role="button"]:has-text("Google")',
    '[data-cy="google-login"]',
    'a[href*="google"]',
    'button[class*="google"]',
    '.google-btn',
    '#google-signin-btn',
    'button:has-text("Sign in with Google")',
    'button:has-text("Continue with Google")',
    'a:has-text("Sign in with Google")',
    'a:has-text("Continue with Google")'
  ];

  let googleBtn = null;
  for (const selector of googleBtnSelectors) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) {
      googleBtn = loc;
      console.log(`Found Google SSO button with selector: ${selector}`);
      break;
    }
  }

  // Also check if inside an iframe (e.g. Google GSI button iframe)
  if (!googleBtn) {
    for (const frame of page.frames()) {
      if (frame.url().includes('accounts.google.com/gsi')) {
        const frameBtn = frame.locator('div[role="button"], #container, div[aria-labelledby*="button-label"]').first();
        if (await frameBtn.isVisible().catch(() => false)) {
          googleBtn = frameBtn;
          console.log('Found Google SSO button inside Google GSI iframe.');
          break;
        }
      }
    }
  }

  if (googleBtn) {
    console.log('Initiating Google SSO flow...');

    // Set up popup listener in case Google auth opens in a separate window
    const popupPromise = page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null);

    await googleBtn.click().catch(async () => {
      console.log('Direct click failed, attempting javascript dispatch click...');
      await googleBtn.dispatchEvent('click').catch(() => {});
    });

    const popup = await popupPromise;
    const authPage = popup || page;

    if (popup) {
      console.log('Detected Google SSO popup window.');
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
    }

    // Handle Google authentication on authPage
    await handleGoogleAuth(authPage, email, pass);

    // If popup was used, wait for it to close
    if (popup && !popup.isClosed()) {
      console.log('Waiting for Google SSO popup to finish and close...');
      await popup.waitForEvent('close', { timeout: 30000 }).catch(() => {});
    }
  } else if (email && pass) {
    // Fallback: standard Scaler email/password form
    console.log('Google SSO button not found. Attempting standard email/password form...');
    await page.fill('#user_email, input[name="user[email]"], input[placeholder*="Email"]', email).catch(() => {});
    await page.fill('#user_password, input[name="user[password]"], input[type="password"]', pass).catch(() => {});

    const submitButton = page.locator('button[type="submit"], button:has-text("LOGIN"), button:has-text("Login")').first();
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click();
    }
  } else {
    console.log('\n[AUTH NOTICE] No automatic login method succeeded and credentials missing.');
    console.log('Please log in manually in the opened Chrome browser window...\n');
  }

  // Monitor redirect to Scaler dashboard
  console.log('Verifying Scaler authentication...');
  const maxWait = Date.now() + 45000;
  while (Date.now() < maxWait) {
    const url = page.url();
    if (url.includes('/academy') || url.includes('/dashboard') || (url.includes('scaler.com') && !url.includes('/login') && !url.includes('/sign_in'))) {
      break;
    }
    await DELAY(1000);
  }

  // Navigate directly to core curriculum
  console.log('Navigating directly to Core Curriculum dashboard...');
  await page.goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const isLoaded = await page.waitForSelector('.dropdown__title, .me-cc-header__main, a[href*="/classes"]', { timeout: 15000 }).catch(() => null);
  if (isLoaded) {
    console.log('Successfully reached Scaler Curriculum dashboard!');
  } else {
    console.log('Reached dashboard URL, waiting for curriculum content mount...');
  }
}

/**
 * Handles Google SSO screens:
 * - Account chooser (selects account matching email)
 * - Email input
 * - Password input
 * - App consent / permission prompt
 * - 2FA prompt notice
 */
async function handleGoogleAuth(page, email, pass) {
  const startTime = Date.now();
  const maxAuthTime = 60000; // 60s max for Google flow

  while (Date.now() - startTime < maxAuthTime) {
    if (page.isClosed()) break;
    const url = page.url();

    // If redirected back to Scaler or out of Google
    if (url.includes('scaler.com') && !url.includes('accounts.google.com')) {
      console.log('Google Auth completed: returned to Scaler domain.');
      break;
    }

    if (url.includes('accounts.google.com')) {
      // 1. Account Chooser check (multiple Google profiles)
      if (email) {
        const accountSelector = `[data-identifier*="${email}"], [data-email*="${email}"], [aria-label*="${email}"], div[role="link"]:has-text("${email}"), div:has-text("${email}")`;
        const accountTile = page.locator(accountSelector).first();
        if (await accountTile.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log(`Found remembered Google account for: ${email}. Selecting account...`);
          await accountTile.click().catch(() => {});
          await DELAY(2000);
          continue;
        }
      }

      // 2. Email input check
      const emailInput = page.locator('input[type="email"], #identifierId').first();
      if (await emailInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        if (email) {
          console.log(`Filling Google email: ${email}...`);
          await emailInput.fill(email).catch(() => {});
          const nextBtn = page.locator('#identifierNext, button:has-text("Next")').first();
          if (await nextBtn.isVisible().catch(() => false)) {
            await nextBtn.click().catch(() => {});
            await DELAY(2000);
            continue;
          }
        }
      }

      // 3. Password input check
      const passInput = page.locator('input[type="password"]:visible, input[name="Passwd"]:visible, input[name="password"]:visible').first();
      if (await passInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        if (pass) {
          console.log('Filling Google password...');
          await passInput.fill(pass).catch(() => {});
          const passNextBtn = page.locator('#passwordNext, button:has-text("Next")').first();
          if (await passNextBtn.isVisible().catch(() => false)) {
            await passNextBtn.click().catch(() => {});
            await DELAY(2000);
            continue;
          }
        }
      }

      // 4. Consent / Allow / Continue check
      const continueBtn = page.locator('#submit_approve_access, button:has-text("Continue"), button:has-text("Allow"), button:has-text("Accept")').first();
      if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('Accepting Google OAuth consent prompt...');
        await continueBtn.click().catch(() => {});
        await DELAY(2000);
        continue;
      }

      // 5. 2FA notification
      const has2FA = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('2-step verification') || text.includes('check your phone') || text.includes('google authenticator') || text.includes('tap yes');
      }).catch(() => false);

      if (has2FA) {
        console.log('[AUTH NOTICE] Google 2-Step Verification detected. Please approve prompt on your device...');
        await DELAY(5000);
        continue;
      }
    }

    await DELAY(1000);
  }
}