import 'dotenv/config';
import { snapshotPage } from './page_utils.js';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCALER_ORIGIN = 'https://www.scaler.com';
const DASHBOARD_URL = `${SCALER_ORIGIN}/academy/mentee-dashboard/core-curriculum/`;
// Scaler's /login is just the marketing site with a login modal; the "Google" button there is an
// image-only link to this OAuth start URL, so we can go straight to it.
const GOOGLE_OAUTH_START_URL = `${SCALER_ORIGIN}/users/auth/google_oauth2/`;
const DASHBOARD_READY_SELECTOR = '.dropdown__title, .me-cc-header__main, a[href*="/classes"]';

export function isLoginUrl(url) {
  return /\/(login|sign_in)\b/i.test(url || '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Google sign-in pages, including regional domains such as accounts.google.co.in (the SetSID hop). Compares the HOST only. */
export function isGoogleUrl(url) {
  return /(^|\.)google\.[a-z.]+$/.test(hostOf(url));
}

/** A scaler.com page. Compares the HOST only, so Google URLs that merely mention scaler.com in a redirect parameter don't count. */
export function isScalerUrl(url) {
  const host = hostOf(url);
  return host === 'scaler.com' || host.endsWith('.scaler.com');
}

/** CSS selector matching the Google account-chooser tile for exactly this email (quotes/backslashes escaped). */
export function buildAccountSelector(email) {
  const safeEmail = String(email).replace(/["\\]/g, '\\$&');
  return `[data-identifier="${safeEmail}" i], [data-email="${safeEmail}" i]`;
}

async function isDashboardReady(page, timeout = 8000) {
  const url = page.url();
  if (isLoginUrl(url) || isGoogleUrl(url) || !isScalerUrl(url) || !url.includes('/mentee-dashboard')) return false;
  const ready = await page.waitForSelector(DASHBOARD_READY_SELECTOR, { timeout }).catch(() => null);
  return Boolean(ready) && !isLoginUrl(page.url());
}

async function gotoDashboard(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

/** Fallback if the OAuth start URL can't be opened directly: open the login modal and click Google. */
async function startGoogleViaModal(page) {
  await page.goto(`${SCALER_ORIGIN}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const googleLink = page.locator('a[href*="google_oauth2"]').first();
  if (!(await googleLink.isVisible().catch(() => false))) {
    await page.locator('a.auth-trigger:visible').first().click().catch(() => {});
    await googleLink.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  }
  if (!(await googleLink.isVisible().catch(() => false))) return false;
  await googleLink.click().catch(() => {});
  return true;
}

/**
 * Sign in to Scaler through Google SSO and confirm the dashboard actually loaded.
 * Resolves only when the user is really logged in; throws otherwise (callers must not save a session on failure).
 *
 * @param {import('playwright').Page} page
 * @param {{ interactiveWaitMs?: number }} [opts] how long to wait for a human to finish login (2FA, consent, captcha)
 */
export async function loginToScaler(page, { interactiveWaitMs = 180000 } = {}) {
  // Trace every top-level navigation (query strings stripped, they can carry tokens) so a failed login is diagnosable.
  const onNav = (frame) => {
    if (frame === page.mainFrame()) console.log(`  [nav] ${redactUrl(frame.url())}`);
  };
  page.on('framenavigated', onNav);
  try {
    await loginInner(page, interactiveWaitMs);
  } catch (err) {
    const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400)).catch(() => '');
    if (text) console.log(`  [page text] ${text}`);
    await snapshotPage(page, 'login-failed', err.message);
    throw err;
  } finally {
    page.off('framenavigated', onNav);
  }
}

function redactUrl(url) {
  return String(url).split('?')[0].split('#')[0];
}

async function loginInner(page, interactiveWaitMs) {
  const email = (process.env.SCALER_EMAIL || '').trim();
  const pass = (process.env.SCALER_PASS || '').trim();

  console.log('Checking for an existing Scaler session...');
  try {
    await gotoDashboard(page);
    if (await isDashboardReady(page, 5000)) {
      console.log('Already authenticated! Scaler Core Curriculum ready.');
      return;
    }
  } catch {
    // fall through to a real login
  }

  console.log('Not signed in. Starting Google sign-in...');
  // Scaler may answer the OAuth start URL with a page that redirects to Google a moment later, so wait for Google explicitly
  // instead of assuming we are "back on Scaler" the instant goto() resolves.
  // "Started" means we reached Google, OR Google already had a session and Scaler bounced us straight into the dashboard
  // (or its session-limit page). Both are fine; only a dead end (sign_in / 404) should trigger the modal fallback.
  const AUTH_STEP = /mentee-dashboard|session-management/;
  const reachedAuthStep = () =>
    page.waitForURL((u) => isGoogleUrl(u.href) || AUTH_STEP.test(u.pathname), { timeout: 15000 }).then(() => true).catch(() => false);
  let started = false;
  try {
    await page.goto(GOOGLE_OAUTH_START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    started = isGoogleUrl(page.url()) || AUTH_STEP.test(page.url()) || (await reachedAuthStep());
  } catch {
    started = false;
  }
  if (!started) {
    console.log(`Direct OAuth URL did not reach Google (ended on ${page.url()}). Trying the login modal...`);
    started = (await startGoogleViaModal(page)) && (await reachedAuthStep());
  }
  if (!started) {
    console.log('\n[AUTH NOTICE] Could not start Google sign-in automatically.');
    console.log('Please sign in manually in the opened browser window...\n');
  }

  await handleGoogleAuth(page, email, pass, interactiveWaitMs);

  // Wait for the session to land back on Scaler (covers slow redirects and manual steps).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && (isGoogleUrl(page.url()) || !isScalerUrl(page.url()) || page.url().includes('/users/auth'))) {
    await DELAY(1000);
  }

  console.log('Verifying Scaler authentication...');
  await gotoDashboard(page).catch(() => {});
  if (!(await isDashboardReady(page, 20000))) {
    throw new Error(
      `Login did not complete (ended on ${page.url()}). Nothing was saved.\n` +
      'If Google sign-in finished but you landed on sign_in, the Google account used probably is not the one linked to your Scaler account ' +
      '(check SCALER_EMAIL), or Scaler rejected the login. Run "npm run auth" again and finish signing in manually in the window.'
    );
  }
  console.log('Successfully reached Scaler Curriculum dashboard!');
}

/**
 * Scaler's "Session limit reached" page (max 3 logins). Default: show the sessions and let the human log one out,
 * then click Proceed for them once it is enabled. Opt-in SCALER_AUTO_LOGOUT_OLDEST=true logs out the last (oldest) row itself,
 * which can sign out a real device of yours, so it is never done unless you ask for it.
 */
async function handleSessionLimit(page, notice) {
  if (!notice.printed) {
    notice.printed = true;
    // The sessions are not always a <table>; fall back to the page text between "Session Details" and the Proceed button.
    const rows = await page.evaluate(() => {
      const fromTable = Array.from(document.querySelectorAll('table tr, [role="row"]'))
        .map((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (fromTable.length > 0) return fromTable;
      const text = document.body?.innerText || '';
      const start = text.indexOf('Session Details');
      return (start >= 0 ? text.slice(start, start + 800) : text.slice(0, 600))
        .split('\n').map((l) => l.trim()).filter(Boolean);
    }).catch(() => []);
    console.log('\n[AUTH NOTICE] Scaler session limit reached (max 3 active logins). Current sessions:');
    for (const row of rows) console.log(`   ${row}`);

    if (process.env.SCALER_AUTO_LOGOUT_OLDEST === 'true') {
      const logoutLinks = page.locator('a:has-text("Logout Session"), button:has-text("Logout Session")');
      const count = await logoutLinks.count().catch(() => 0);
      if (count > 0) {
        console.log('SCALER_AUTO_LOGOUT_OLDEST=true: logging out the oldest (last) session...');
        await logoutLinks.nth(count - 1).click().catch(() => {});
        await DELAY(1500);
      }
    } else {
      console.log('Click "Logout Session" on an old row in the browser window (SAAB will click Proceed for you).');
      console.log('Or set SCALER_AUTO_LOGOUT_OLDEST=true in .env to let SAAB log out the oldest one automatically.\n');
    }
  }

  const proceed = page.locator('a:has-text("Proceed"), button:has-text("Proceed")').first();
  if ((await proceed.isVisible().catch(() => false)) && (await proceed.isEnabled().catch(() => false))) {
    await proceed.click().catch(() => {});
  }
}

/**
 * Drives Google's screens until we are back on scaler.com (or time runs out):
 * account chooser, email, password, 2-step verification (waits for you), consent (waits for you).
 */
function notifyOnce(progress, key, message) {
  if (progress.notices.has(key)) return;
  progress.notices.add(key);
  console.log(message);
}

export async function handleGoogleAuth(page, email, pass, maxMs, isDone = null) {
  const startTime = Date.now();
  let sawGoogle = false;
  const sessionNotice = { printed: false };
  const progress = { passwordSubmits: 0, passwordSubmittedAt: 0, emailSubmits: 0, chooserClicks: 0, notices: new Set() };

  while (Date.now() - startTime < maxMs) {
    if (page.isClosed()) {
      if (sawGoogle) {
        console.log('Google Auth completed: auth window closed.');
        return;
      }
      break;
    }
    const url = page.url();
    if (isGoogleUrl(url)) sawGoogle = true;

    if (isDone && (await isDone(url, page))) {
      console.log('Google Auth completed: returned to destination.');
      return;
    }

    // Done only when we are on a real Scaler page again: not a login page, and not mid-OAuth (/users/auth/..., callbacks).
    const onScalerPage = isScalerUrl(url) && !isLoginUrl(url) && !url.includes('/users/');
    if (!isDone && onScalerPage && (sawGoogle || url.includes('/mentee-dashboard'))) {
      console.log('Google Auth completed: returned to Scaler.');
      return;
    }

    // Scaler allows only 3 active logins; past that it shows a "Session limit reached" page that needs a session logged out.
    if (isScalerUrl(url) && url.includes('/session-management')) {
      await handleSessionLimit(page, sessionNotice);
      await DELAY(2000);
      continue;
    }

    // Bounced back to Scaler's sign-in page after Google: the login was rejected, don't wait out the clock.
    if (sawGoogle && isScalerUrl(url) && isLoginUrl(url)) {
      console.log('[AUTH NOTICE] Scaler sent us back to its sign-in page after Google sign-in: the login was not accepted.');
      return;
    }

    if (isGoogleUrl(url)) {
      const passInput = page.locator('input[type="password"]:visible, input[name="Passwd"]:visible, input[name="password"]:visible').first();
      const emailInput = page.locator('input[type="email"]:visible, #identifierId:visible').first();
      const passVisible = await passInput.isVisible({ timeout: 800 }).catch(() => false);
      const emailVisible = !passVisible && (await emailInput.isVisible({ timeout: 800 }).catch(() => false));

      // 1. Password step. Submit the configured password at most once (a wrong one must not be retried: lockouts);
      //    otherwise leave the page completely alone so the human can type.
      if (passVisible) {
        if (pass && progress.passwordSubmits < 1) {
          progress.passwordSubmits += 1;
          progress.passwordSubmittedAt = Date.now();
          console.log('Filling Google password...');
          await passInput.fill(pass).catch(() => {});
          const passNextBtn = page.locator('#passwordNext, button:has-text("Next")').first();
          if (await passNextBtn.isVisible().catch(() => false)) await passNextBtn.click().catch(() => {});
          await DELAY(2500);
        } else {
          // Right after we submitted it, the page is just transitioning: only ask the human if it is still here after 10s (wrong password).
          const justSubmitted = progress.passwordSubmittedAt && Date.now() - progress.passwordSubmittedAt < 10000;
          if (!justSubmitted) {
            notifyOnce(progress, 'password', '[AUTH NOTICE] Type your Google password in the browser window and press Next...');
          }
          await DELAY(1500);
        }
        continue;
      }

      // 2. Email step (same rule: a couple of automatic tries, then it is yours).
      if (emailVisible) {
        if (email && progress.emailSubmits < 2) {
          progress.emailSubmits += 1;
          console.log(`Filling Google email: ${email}...`);
          await emailInput.fill(email).catch(() => {});
          const nextBtn = page.locator('#identifierNext, button:has-text("Next")').first();
          if (await nextBtn.isVisible().catch(() => false)) await nextBtn.click().catch(() => {});
          await DELAY(2500);
        } else {
          notifyOnce(progress, 'email', '[AUTH NOTICE] Enter your Google email in the browser window and press Next...');
          await DELAY(1500);
        }
        continue;
      }

      // 3. Account chooser: ONLY when no input is on screen. (Google also shows your email as a small chip on the password
      //    page; clicking that every second used to steal focus from the password field.) Capped at a few clicks.
      if (email && progress.chooserClicks < 3) {
        const accountTile = page.locator(buildAccountSelector(email)).first();
        if (await accountTile.isVisible({ timeout: 1000 }).catch(() => false)) {
          progress.chooserClicks += 1;
          console.log(`Found remembered Google account for: ${email}. Selecting account...`);
          await accountTile.click().catch(() => {});
          await DELAY(2000);
          continue;
        }
      }

      // 4. Consent: never auto-grant OAuth permissions; a human reads and approves it.
      const consentBtn = page.locator('#submit_approve_access, button:has-text("Allow"), button:has-text("Accept")').first();
      if (await consentBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('[AUTH NOTICE] Google is asking for OAuth consent. Review it and click Allow yourself in the browser window...');
        await DELAY(3000);
        continue;
      }

      // 5. 2-step verification / captcha / "this browser is not secure": a human has to do it.
      const needsHuman = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('2-step verification') || text.includes('check your phone') || text.includes('google authenticator') ||
          text.includes('tap yes') || text.includes('verify it') || text.includes('not secure') || text.includes('captcha');
      }).catch(() => false);
      if (needsHuman) {
        console.log('[AUTH NOTICE] Google needs you to finish a verification step in the browser window...');
        await DELAY(5000);
        continue;
      }
    }

    await DELAY(1000);
  }

  console.log('[AUTH NOTICE] Timed out waiting for Google sign-in to finish.');
}
