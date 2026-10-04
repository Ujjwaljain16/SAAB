// bits_crawler.js — Discovery & crawler for Coursera BITS Pilani assignments

import { BITS_URLS, COURSERA_SEL, COURSERA_TIMEOUTS } from './bits_config.js';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Discovers enrolled courses from the BITS degree home page
 * @param {import('playwright').Page} page
 * @param {string} degreeUrl
 * @returns {Promise<Array<{ name: string, url: string, slug: string }>>}
 */
export async function discoverDegreeCourses(page, degreeUrl = BITS_URLS.DEGREE_HOME) {
  console.log(`[BITS Crawler] Navigating to Degree Home: ${degreeUrl}`);
  await page.goto(degreeUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(2000);

  const courses = await page.evaluate((sel) => {
    const links = Array.from(document.querySelectorAll('a[href*="/learn/"]'));
    const map = new Map();

    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const fullUrl = href.startsWith('http') ? href : `https://www.coursera.org${href}`;
      const match = fullUrl.match(/https:\/\/www\.coursera\.org\/learn\/([^\/\?#]+)/i);
      if (!match) continue;

      const slug = match[1];
      const name = (a.innerText || a.getAttribute('aria-label') || slug).replace(/\s+/g, ' ').trim();
      
      // Clean base url to course welcome page
      const welcomeUrl = `https://www.coursera.org/learn/${slug}/home/welcome`;
      if (!map.has(slug) && name.length > 2) {
        map.set(slug, {
          name,
          url: welcomeUrl,
          slug
        });
      }
    }

    return Array.from(map.values());
  }, COURSERA_SEL);

  console.log(`[BITS Crawler] Discovered ${courses.length} courses on BITS Degree Home.`);
  for (const c of courses) {
    console.log(`  - ${c.name} (${c.slug})`);
  }

  return courses;
}

/**
 * Crawls a course outline to discover all assignments, exams, and quizzes with status (PENDING, LOCKED, COMPLETED)
 * @param {import('playwright').Page} page
 * @param {string} courseUrl
 * @returns {Promise<{ courseUrl: string, courseTitle: string, allItems: Array<any>, pending: Array<any>, locked: Array<any>, completed: Array<any> }>}
 */
export async function crawlCourseOutline(page, courseUrl) {
  console.log(`\n[BITS Crawler] Crawling Course Outline: ${courseUrl}`);
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(2000);

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
  console.log(`[BITS Crawler] Found ${count} module accordions. Ensuring all are expanded...`);

  for (let i = 0; i < count; i++) {
    const acc = accordions.nth(i);
    const expanded = await acc.getAttribute('aria-expanded').catch(() => 'true');
    if (expanded === 'false') {
      await acc.click().catch(() => {});
      await DELAY(200);
    }
  }

  // Wait briefly for all items to render
  await DELAY(1000);

  // Extract all outline items and determine assignment status
  const outline = await page.evaluate((sel) => {
    const titleEl = document.querySelector('h1, [data-testid="course-title"], header');
    const courseTitle = (titleEl?.innerText || document.title || '').replace(/\s+/g, ' ').trim();

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

      // Title & metadata
      const text = (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      
      // Determine type
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
