// bits_crawler.js — Discovery & crawler for Coursera BITS Pilani assignments

import { BITS_URLS, COURSERA_SEL, COURSERA_TIMEOUTS } from './bits_config.js';
import { isGoogleUrl, handleGoogleAuth } from './scaler_login.js';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks if the browser session is authenticated on Coursera. If not, drives Google OAuth login.
 * @param {import('playwright').Page} page
 */
export async function ensureCourseraLoggedIn(page) {
  const email = (process.env.BITS_EMAIL || process.env.COURSERA_EMAIL || '').trim();
  const pass = (process.env.BITS_PASS || process.env.COURSERA_PASS || '').trim();

  const isProfile = await page.locator(COURSERA_SEL.userProfile).first().isVisible().catch(() => false);
  const currentUrl = page.url();
  const onDegreeHome = currentUrl.includes('/degrees/bachelor-of-science-computer-science-bits/home');
  const hasCoursesHead = await page.locator(COURSERA_SEL.currentCoursesHeading).first().isVisible().catch(() => false);

  if (isProfile || (onDegreeHome && hasCoursesHead)) {
    return;
  }

  console.log('\n============================================================');
  console.log('🔑 COURSERA GOOGLE OAUTH LOGIN');
  console.log('Initiating Google sign-in for Coursera...');
  console.log('============================================================\n');

  // 1. Locate Google Sign-In button, navigating to auth modal if needed
  const googleBtnSel = 'button[data-track-component="continue_with_google_auth_btn"], button:has-text("Continue with Google"), a:has-text("Continue with Google"), button[data-e2e="google"]';
  let googleBtn = page.locator(googleBtnSel).first();
  let hasGoogleBtn = await googleBtn.isVisible().catch(() => false);

  if (!hasGoogleBtn) {
    const loginBtn = page.locator('button[data-e2e="header-login-button"], a[data-e2e="header-login-button"], button:has-text("Log In"), a:has-text("Log In")').first();
    if (await loginBtn.isVisible().catch(() => false)) {
      console.log('[BITS Auth] Clicking "Log In" button...');
      await loginBtn.click().catch(() => {});
      await DELAY(2000);
    }
    hasGoogleBtn = await googleBtn.isVisible().catch(() => false);
  }

  if (!hasGoogleBtn) {
    console.log('[BITS Auth] Opening Coursera login modal at https://www.coursera.org/?authMode=login...');
    await page.goto('https://www.coursera.org/?authMode=login', { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD }).catch(() => {});
    await googleBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  }

  // 2. Click "Continue with Google" and catch the OAuth popup window
  console.log('[BITS Auth] Clicking "Continue with Google"...');
  let popup = null;
  try {
    const [popupPage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }),
      googleBtn.click()
    ]);
    popup = popupPage;
    console.log('[BITS Auth] OAuth popup window opened.');
  } catch {
    console.log('[BITS Auth] No popup event detected; proceeding in current window if navigated.');
  }

  // 3. Drive Google OAuth flow inside the target window (popup or main page)
  const authTarget = popup || page;
  console.log('[BITS Auth] Running Google SSO authentication...');
  await handleGoogleAuth(authTarget, email, pass, 180000, async (url, p) => {
    if (p.isClosed()) return true;
    if (url.includes('coursera.org/api/thirdpartyauth') || (!isGoogleUrl(url) && url.includes('coursera.org'))) {
      return true;
    }
    return false;
  });

  if (popup && !popup.isClosed()) {
    console.log('[BITS Auth] Waiting for OAuth popup to close...');
    await popup.waitForEvent('close', { timeout: 10000 }).catch(() => {});
  }

  // 4. Navigate and verify on Degree Dashboard
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(2000);

  console.log('[BITS Auth] Verifying login on Degree Dashboard...');
  await page.goto(BITS_URLS.DEGREE_HOME, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(2500);

  const verifiedProfile = await page.locator(COURSERA_SEL.userProfile).first().isVisible().catch(() => false);
  const verifiedHome = page.url().includes('/degrees/bachelor-of-science-computer-science-bits/home');
  const verifiedCourses = await page.locator(COURSERA_SEL.currentCoursesHeading).first().isVisible().catch(() => false);

  if (verifiedProfile || verifiedHome || verifiedCourses) {
    console.log('✓ Coursera login confirmed!');
  } else {
    console.warn(`⚠️ Warning: Login verification on degree dashboard could not be confirmed automatically. Current URL: ${page.url()}`);
  }
}

/**
 * Discovers current enrolled courses and upcoming deadline assignments from the BITS degree dashboard
 * @param {import('playwright').Page} page
 * @param {string} degreeUrl
 * @returns {Promise<{ courses: Array<any>, deadlines: Array<any>, pending: Array<any>, completed: Array<any> }>}
 */
export async function discoverDegreeDashboard(page, degreeUrl = BITS_URLS.DEGREE_HOME) {
  console.log(`[BITS Crawler] Navigating to Degree Dashboard: ${degreeUrl}`);
  await page.goto(degreeUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(2500);

  // Check login
  await ensureCourseraLoggedIn(page);

  // Ensure "In Progress" tab is active if present
  const inProgressTab = page.locator(COURSERA_SEL.inProgressTab).first();
  if (await inProgressTab.isVisible().catch(() => false)) {
    const isSelected = await inProgressTab.getAttribute('aria-selected').catch(() => 'true');
    if (isSelected === 'false') {
      console.log('[BITS Crawler] Activating "In Progress" deadlines tab...');
      await inProgressTab.click().catch(() => {});
      await DELAY(1000);
    }
  }

  // Scrape dashboard DOM
  const dashboardData = await page.evaluate((sel) => {
    const cleanText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

    // 1. Extract Current Enrolled Courses (under "Current courses" heading)
    const courses = [];
    const headings = Array.from(document.querySelectorAll('h2, h3'));
    const currentCoursesHead = headings.find((h) => cleanText(h) === 'Current courses');

    if (currentCoursesHead) {
      let container = currentCoursesHead.parentElement;
      while (container && container !== document.body) {
        const links = Array.from(container.querySelectorAll('a[href*="/learn/"]'));
        if (links.length >= 2) {
          const seen = new Set();
          for (const a of links) {
            const href = a.getAttribute('href') || '';
            const match = href.match(/\/learn\/([^\/\?#]+)/);
            if (!match) continue;
            const slug = match[1];
            if (seen.has(slug)) continue;
            seen.add(slug);

            const name = cleanText(a);
            if (name && name.length > 2 && !name.toLowerCase().includes('view all')) {
              courses.push({
                name,
                slug,
                url: href.startsWith('http') ? href : `https://www.coursera.org${href}`
              });
            }
          }
          break;
        }
        container = container.parentElement;
      }
    }

    // 2. Extract Deadlines Queue from the Dashboard
    const deadlines = [];

    // Scan any recent grades summary widget to track past verified scores
    const recentGradesMap = new Map();
    const recentGradeCards = Array.from(document.querySelectorAll('[data-e2e="recent-grades-card"], #recentGradesItemsContainer'));
    for (const rCard of recentGradeCards) {
      const rLinks = Array.from(rCard.querySelectorAll('a[href*="/team/"], a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]'));
      for (const rl of rLinks) {
        const rHref = (rl.getAttribute('href') || '').replace(/^https?:\/\/[^\/]+/, '');
        let rParent = rl.parentElement;
        while (rParent && rParent !== rCard && !cleanText(rParent).includes('Grade:')) {
          rParent = rParent.parentElement;
        }
        const rText = rParent ? cleanText(rParent) : '';
        const m = rText.match(/Grade:\s*(\d+(?:\.\d+)?)\s*%?/i);
        if (m) {
          recentGradesMap.set(rHref, parseFloat(m[1]));
        }
      }
    }

    // Extract deadline assignments strictly from the timeline/calendar list (exclude the recent-grades summary card)
    const assignmentLinks = Array.from(document.querySelectorAll('a[href*="/team/"], a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]'))
      .filter((a) => !a.closest('[data-e2e="recent-grades-card"]') && !a.closest('#recentGradesItemsContainer'));

    const seenHrefs = new Set();

    for (const a of assignmentLinks) {
      const href = a.getAttribute('href') || '';
      const fullUrl = href.startsWith('http') ? href : `https://www.coursera.org${href}`;
      const pathOnly = href.replace(/^https?:\/\/[^\/]+/, '');
      if (seenHrefs.has(fullUrl)) continue;
      seenHrefs.add(fullUrl);

      const rawTitle = cleanText(a).replace(/^Graded Assignment\s*:\s*/i, '').trim();
      if (!rawTitle || rawTitle.toLowerCase().includes('marks placeholder')) continue;

      // Walk up to find the single assignment card container (never bleed into parent multi-card accordion panels)
      let cur = a;
      let cardEl = a;
      while (cur && cur.parentElement && cur.parentElement !== document.body) {
        const parent = cur.parentElement;
        const innerAssignmentLinks = parent.querySelectorAll('a[href*="/team/"], a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]');
        if (innerAssignmentLinks.length > 1) {
          break; // Stop before ascending to multi-item accordion panel
        }
        cardEl = parent;
        cur = parent;
      }
      const cardText = cleanText(cardEl);

      // Detect grade: check card text first, fallback to recentGradesMap
      const gradeMatch = cardText.match(/Grade:\s*(\d+(?:\.\d+)?)\s*%?/i);
      const gradeNum = gradeMatch ? parseFloat(gradeMatch[1]) : (recentGradesMap.get(pathOnly) ?? null);
      const gradeStr = gradeNum !== null ? `${gradeNum}%` : null;

      // Passing threshold is 80%: a grade < 80% is a failed attempt and MUST be retaken!
      const isPassed = gradeNum !== null && gradeNum >= 80;
      const hasFailingGrade = gradeNum !== null && gradeNum < 80;
      const isCompleted = isPassed || (cardText.includes('Completed') && !hasFailingGrade);

      // Detect if Staff Graded or Peer Graded (manual evaluation — never auto-solve)
      const isStaffGraded = /staff\s*graded|peer\s*graded|peer\s*review/i.test(rawTitle) ||
                            /staff\s*graded|peer\s*graded|peer\s*review/i.test(cardText) ||
                            /staff[-_]graded|peer[-_]graded/i.test(fullUrl);

      // Detect if locked or future
      const isLocked = /\blocked\b|available on|will be available|available\s+[A-Za-z]+|unlocks\b|prerequisite/i.test(cardText);

      let status = 'PENDING';
      if (isCompleted) {
        status = 'COMPLETED';
      } else if (isStaffGraded) {
        status = 'STAFF_GRADED'; // Skipped entirely: manual evaluation only
      } else if (isLocked) {
        status = 'LOCKED';
      }

      // Detect course name: prioritize exact slug in fullUrl
      let courseName = '';
      for (const c of courses) {
        if (c.slug && fullUrl.includes(c.slug)) {
          courseName = c.name;
          break;
        }
      }
      if (!courseName) {
        for (const c of courses) {
          if (c.name && cardText.includes(c.name)) {
            courseName = c.name;
            break;
          }
        }
      }
      if (!courseName) {
        if (fullUrl.includes('modern-databases') || cardText.includes('Modern Databases')) courseName = 'Modern Databases';
        else if (fullUrl.includes('network-programming') || cardText.includes('Network Programming')) courseName = 'Network Programming and Client-Server Programming';
        else if (fullUrl.includes('software-development') || cardText.includes('Software Development Practices')) courseName = 'Software Development Practices';
      }

      // Detect due date cleanly without capturing adjacent card text
      const dueMatch = cardText.match(/Due\s+(?:at\s+)?([A-Za-z0-9\s,:]+?(?:AM|PM)(?:\s+[A-Z]{2,4})?)/i) ||
                       cardText.match(/Due\s+(?:at\s+)?([A-Za-z]{3}\s+\d{1,2}(?:,\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i);
      const due = dueMatch ? dueMatch[1].trim() : 'Upcoming';

      deadlines.push({
        title: rawTitle,
        course: courseName || 'General',
        url: fullUrl,
        due,
        grade: gradeStr,
        gradeNum,
        isStaffGraded,
        isLocked,
        status
      });
    }

    return { courses, deadlines };
  }, COURSERA_SEL);

  // Filter pending: ONLY available auto-gradable quizzes/assignments (NO staff-graded, NO locked, NO completed)
  const pending = dashboardData.deadlines.filter((d) => d.status === 'PENDING');
  const completed = dashboardData.deadlines.filter((d) => d.status === 'COMPLETED');
  const staffGraded = dashboardData.deadlines.filter((d) => d.status === 'STAFF_GRADED');
  const locked = dashboardData.deadlines.filter((d) => d.status === 'LOCKED');

  console.log(`\n[BITS Crawler] Enrolled Courses Found: ${dashboardData.courses.length}`);
  dashboardData.courses.forEach((c) => console.log(`  - ${c.name} (${c.slug})`));

  console.log(`\n[BITS Crawler] Deadlines Feed Breakdown: ${dashboardData.deadlines.length} total assignment(s) found.`);
  console.log(`  ⏳ Pending Graded Quizzes: ${pending.length} (Active to solve)`);
  console.log(`  ✓ Completed / Passed:     ${completed.length}`);
  console.log(`  🚫 Staff / Peer Graded:    ${staffGraded.length} (Skipped — manual evaluation)`);
  if (locked.length > 0) console.log(`  🔒 Locked / Future:       ${locked.length}`);

  if (pending.length > 0) {
    console.log('\n[BITS Crawler] Available Pending Graded Quizzes:');
    pending.forEach((p, idx) => {
      const retakeTag = p.grade ? ` [Retake Needed: Current Grade ${p.grade} < 80%]` : '';
      console.log(`  [${idx + 1}] "${p.title}" (${p.course})${retakeTag} — Due: ${p.due}`);
    });
  }

  return {
    courses: dashboardData.courses,
    deadlines: dashboardData.deadlines,
    pending,
    completed,
    staffGraded,
    locked
  };
}

/**
 * Crawls a course outline to discover all internal assignments, exams, and quizzes with status (PENDING, LOCKED, COMPLETED)
 * @param {import('playwright').Page} page
 * @param {string} courseUrl
 * @returns {Promise<{ courseUrl: string, courseTitle: string, allItems: Array<any>, pending: Array<any>, locked: Array<any>, completed: Array<any> }>}
 */
export async function crawlCourseOutline(page, courseUrl) {
  console.log(`\n[BITS Crawler] Crawling Course Outline: ${courseUrl}`);
  try {
    await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
    await page.waitForLoadState('networkidle').catch(() => {});
    await DELAY(2000);
  } catch (err) {
    console.log(`[BITS Crawler] Navigation warning for ${courseUrl}: ${err.message}. Retrying with commit...`);
    await page.goto(courseUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    await DELAY(2000);
  }

  // If left-nav is not visible or drawer is collapsed, try opening drawer
  const drawerBtn = page.locator(COURSERA_SEL.drawerToggle).first();
  if (await drawerBtn.isVisible().catch(() => false)) {
    const isExpanded = await drawerBtn.getAttribute('aria-expanded').catch(() => 'false');
    if (isExpanded === 'false') {
      console.log('[BITS Crawler] Expanding course outline drawer...');
      await drawerBtn.click().catch(() => {});
      await DELAY(1000);
    }
  }

  // Expand all collapsed accordion modules so all sub-items are present in DOM
  const accordions = page.locator(COURSERA_SEL.accordionHeader);
  const count = await accordions.count();
  if (count > 0) {
    console.log(`[BITS Crawler] Found ${count} module accordions. Ensuring all are expanded...`);
    for (let i = 0; i < count; i++) {
      const acc = accordions.nth(i);
      const expanded = await acc.getAttribute('aria-expanded').catch(() => 'true');
      if (expanded === 'false') {
        await acc.click().catch(() => {});
        await DELAY(150);
      }
    }
    await DELAY(1000);
  }

  // Extract all outline items and determine assignment status
  const outline = await page.evaluate((sel) => {
    const cleanText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const titleEl = document.querySelector('h1, [data-testid="course-title"], header');
    const courseTitle = cleanText(titleEl) || document.title || '';

    const links = Array.from(document.querySelectorAll(sel.navItemLink));
    const items = [];
    const seenHrefs = new Set();

    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const fullUrl = href.startsWith('http') ? href : `https://www.coursera.org${href}`;
      if (seenHrefs.has(fullUrl)) continue;
      seenHrefs.add(fullUrl);

      // Check status icons inside this element or its parent
      const parentContainer = a.closest('li') || a.parentElement;
      const hasSuccess = parentContainer?.querySelector(sel.successIcon) != null || a.querySelector(sel.successIcon) != null;
      const hasLock = parentContainer?.querySelector(sel.lockIcon) != null || a.querySelector(sel.lockIcon) != null;

      let status = 'PENDING';
      if (hasSuccess) {
        status = 'COMPLETED';
      } else if (hasLock) {
        status = 'LOCKED';
      }

      const text = cleanText(a);
      let type = 'assignment';
      if (fullUrl.includes('/exam/')) type = 'exam';
      else if (fullUrl.includes('/quiz/')) type = 'quiz';
      else if (fullUrl.includes('assignment-submission')) type = 'assignment-submission';

      items.push({
        title: text,
        url: fullUrl,
        type,
        status
      });
    }

    return { courseTitle, items };
  }, COURSERA_SEL);

  const pending = outline.items.filter((i) => i.status === 'PENDING');
  const locked = outline.items.filter((i) => i.status === 'LOCKED');
  const completed = outline.items.filter((i) => i.status === 'COMPLETED');

  console.log(`[BITS Crawler] Course: "${outline.courseTitle}"`);
  console.log(`  Total Assignments: ${outline.items.length}`);
  console.log(`  ⏳ Pending:   ${pending.length}`);
  console.log(`  🔒 Locked:    ${locked.length}`);
  console.log(`  ✓ Completed: ${completed.length}`);

  return {
    courseUrl,
    courseTitle: outline.courseTitle,
    allItems: outline.items,
    pending,
    locked,
    completed
  };
}
