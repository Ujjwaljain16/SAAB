// bits_crawler.js — Discovery & crawler for Coursera BITS Pilani assignments

import { BITS_URLS, COURSERA_SEL, COURSERA_TIMEOUTS } from './bits_config.js';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks if the browser session is authenticated on Coursera. If not, waits for the user to log in.
 * @param {import('playwright').Page} page
 */
export async function ensureCourseraLoggedIn(page) {
  const currentUrl = page.url();
  const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('authMode=login');
  const hasLoginForm = await page.locator(COURSERA_SEL.loginRedirect).first().isVisible().catch(() => false);

  if (isLoginPage || hasLoginForm) {
    console.log('\n============================================================');
    console.log('🔑 COURSERA LOGIN REQUIRED');
    console.log('Please log into your Coursera account in the opened Chrome window.');
    console.log('The script will automatically continue once login is detected...');
    console.log('============================================================\n');

    // Wait until login completes (profile icon appears or navigation away from login)
    await page.waitForFunction((sel) => {
      const profile = document.querySelector(sel.userProfile);
      const isStillLogin = window.location.href.includes('/login') || window.location.href.includes('authMode=login');
      return profile != null || !isStillLogin;
    }, COURSERA_SEL, { timeout: 180000 }).catch(() => {});

    await page.waitForLoadState('networkidle').catch(() => {});
    await DELAY(2000);
    console.log('✓ Coursera login confirmed!');
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
    const assignmentLinks = Array.from(document.querySelectorAll('a[href*="/team/"], a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]'));
    const seenHrefs = new Set();

    for (const a of assignmentLinks) {
      const href = a.getAttribute('href') || '';
      const fullUrl = href.startsWith('http') ? href : `https://www.coursera.org${href}`;
      if (seenHrefs.has(fullUrl)) continue;
      seenHrefs.add(fullUrl);

      const rawTitle = cleanText(a).replace(/^Graded Assignment\s*:\s*/i, '').trim();
      if (!rawTitle || rawTitle.toLowerCase().includes('marks placeholder')) continue;

      // Walk up to find card context (due date, course name, grade)
      let cur = a;
      let cardText = '';
      for (let s = 0; s < 6; s++) {
        if (!cur.parentElement) break;
        cur = cur.parentElement;
        const t = cleanText(cur);
        if (t.includes('Due') || t.includes('Grade:') || t.includes('Completed')) {
          cardText = t;
        }
      }

      // Detect grade / completion
      const gradeMatch = cardText.match(/Grade:\s*(\d+%?)/i);
      const grade = gradeMatch ? gradeMatch[1] : null;
      const isCompleted = cardText.includes('Completed') || grade !== null;

      // Detect course name
      let courseName = '';
      for (const c of courses) {
        if (cardText.includes(c.name) || fullUrl.includes(c.slug)) {
          courseName = c.name;
          break;
        }
      }
      if (!courseName) {
        if (cardText.includes('Modern Databases')) courseName = 'Modern Databases';
        else if (cardText.includes('Network Programming')) courseName = 'Network Programming and Client-Server Programming';
        else if (cardText.includes('Software Development Practices')) courseName = 'Software Development Practices';
      }

      // Detect due date
      const dueMatch = cardText.match(/Due\s+at\s+([^\.]+)/i);
      const due = dueMatch ? dueMatch[1].trim() : 'Upcoming';

      deadlines.push({
        title: rawTitle,
        course: courseName || 'General',
        url: fullUrl,
        due,
        grade,
        status: isCompleted ? 'COMPLETED' : 'PENDING'
      });
    }

    return { courses, deadlines };
  }, COURSERA_SEL);

  const pending = dashboardData.deadlines.filter((d) => d.status === 'PENDING');
  const completed = dashboardData.deadlines.filter((d) => d.status === 'COMPLETED');

  console.log(`\n[BITS Crawler] Enrolled Courses Found: ${dashboardData.courses.length}`);
  dashboardData.courses.forEach((c) => console.log(`  - ${c.name} (${c.slug})`));

  console.log(`\n[BITS Crawler] Deadlines Feed: ${dashboardData.deadlines.length} total assignment(s) found.`);
  console.log(`  ⏳ Pending:   ${pending.length}`);
  console.log(`  ✓ Completed: ${completed.length}`);

  if (pending.length > 0) {
    console.log('\n[BITS Crawler] Upcoming Pending Assignments:');
    pending.forEach((p, idx) => {
      console.log(`  [${idx + 1}] "${p.title}" (${p.course}) — Due: ${p.due}`);
    });
  }

  return {
    courses: dashboardData.courses,
    deadlines: dashboardData.deadlines,
    pending,
    completed
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
