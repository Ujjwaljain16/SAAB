// bits_main.js — Main orchestrator for BITS Pilani Coursera degree automation

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { BITS_URLS } from './bits_config.js';
import { discoverDegreeDashboard, crawlCourseOutline, ensureCourseraLoggedIn } from './bits_crawler.js';
import { solveAndSubmitCourseraAssignment } from './bits_handler.js';
import { solverStats } from './solver.js';
import { answerStore } from './answer_indexer.js';

let globalHaltRun = false;
let globalHaltReason = '';

process.on('SIGINT', () => {
  console.log('\n[SIGINT] Interrupt received. Halting gracefully...');
  globalHaltRun = true;
  globalHaltReason = 'Manually interrupted (SIGINT)';
});

process.on('SIGTERM', () => {
  console.log('\n[SIGTERM] Terminate received. Halting gracefully...');
  globalHaltRun = true;
  globalHaltReason = 'Terminated (SIGTERM)';
});

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBits(options = {}) {
  const DRY_RUN = options.dryRun ?? (process.argv.includes('--dry-run') && !process.argv.includes('--submit'));
  const COURSE_ARG = options.course ?? (process.argv.find((a) => a.startsWith('--course='))?.split('=')[1] || '');
  const ASSIGNMENT_ARG = options.assignment ?? (process.argv.find((a) => a.startsWith('--assignment='))?.split('=')[1] || '');
  const LIMIT_ARG = parseInt(options.limit ?? (process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0'), 10);
  const ANSWERS_ARG = options.answers ?? (process.argv.find((a) => a.startsWith('--answers='))?.split('=')[1] || process.env.BITS_ANSWERS_PATH || '');

  console.log(`\n============================================================`);
  console.log(`🎓 BITS Pilani BSc Computer Science — Coursera Auto-Solver`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (Preview Only)' : 'SUBMIT (Live)'}`);
  if (COURSE_ARG) console.log(`Course filter: "${COURSE_ARG}"`);
  if (ASSIGNMENT_ARG) console.log(`Direct assignment: "${ASSIGNMENT_ARG}"`);
  if (LIMIT_ARG > 0) console.log(`Limit: ${LIMIT_ARG} assignment(s)`);
  if (ANSWERS_ARG) console.log(`Answer key: "${ANSWERS_ARG}"`);
  console.log(`============================================================\n`);

  // Load Answer Key if provided or present in answers/ directory
  if (ANSWERS_ARG) {
    await answerStore.loadFile(ANSWERS_ARG);
  }
  await answerStore.loadDirectory('answers');

  const userDataDir = process.env.BITS_PROFILE_DIR
    ? path.resolve(process.env.BITS_PROFILE_DIR)
    : path.join(process.cwd(), 'temp_chrome_profile_bits');

  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[BITS] 🌐 Launching visible Chrome browser window (headed mode)...`);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [
      '--start-maximized',
      '--window-position=50,50',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    viewport: null
  });

  // Optimize traffic by blocking analytics/ads
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (/google-analytics|googletagmanager|mixpanel|datadoghq|hotjar|sentry\.io|clarity\.ms|segment\.io|amplitude\.com|fullstory|doubleclick/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.bringToFront().catch(() => {});
  const runLog = [];
  const metrics = {
    startedAt: Date.now(),
    coursesSeen: 0,
    assignmentsSeen: 0,
    solved: 0,
    dryRun: 0,
    skipped: 0,
    failed: 0
  };

  try {
    // 1. Direct Assignment Mode
    if (ASSIGNMENT_ARG) {
      console.log(`[BITS] Direct assignment mode requested: ${ASSIGNMENT_ARG}`);
      const result = await solveAndSubmitCourseraAssignment(page, ASSIGNMENT_ARG, { dryRun: DRY_RUN, answerStore });
      runLog.push({ url: ASSIGNMENT_ARG, result });
      if (result.status === 'pass') metrics.solved++;
      else if (result.status === 'dry-run') metrics.dryRun++;
      else if (result.status === 'skipped') metrics.skipped++;
      else metrics.failed++;
      return;
    }

    // 2. Discover Degree Dashboard & Deadlines
    console.log(`[BITS] Scanning degree home dashboard for current courses & deadline feed...`);
    const dashboard = await discoverDegreeDashboard(page, BITS_URLS.DEGREE_HOME);
    metrics.coursesSeen = dashboard.courses.length;

    let targetDeadlines = dashboard.pending;

    // Filter by course if specified
    if (COURSE_ARG) {
      targetDeadlines = targetDeadlines.filter((item) =>
        item.course.toLowerCase().includes(COURSE_ARG.toLowerCase()) ||
        item.url.toLowerCase().includes(COURSE_ARG.toLowerCase())
      );
      console.log(`[BITS] Filtered to ${targetDeadlines.length} assignment(s) matching course "${COURSE_ARG}".`);
    }

    if (LIMIT_ARG > 0 && targetDeadlines.length > LIMIT_ARG) {
      targetDeadlines = targetDeadlines.slice(0, LIMIT_ARG);
      console.log(`[BITS] Limiting to ${targetDeadlines.length} assignment(s) (--limit=${LIMIT_ARG}).`);
    }

    // 3. Process Pending Assignments from Deadlines Feed
    if (targetDeadlines.length > 0) {
      console.log(`\n============================================================`);
      console.log(`📅 Processing ${targetDeadlines.length} Upcoming Deadline Assignment(s)`);
      console.log(`============================================================`);

      for (let i = 0; i < targetDeadlines.length; i++) {
        if (globalHaltRun) break;
        const assignment = targetDeadlines[i];
        metrics.assignmentsSeen++;

        console.log(`\n▶ [BITS ${i + 1}/${targetDeadlines.length}] "${assignment.title}"`);
        console.log(`   Course: ${assignment.course} | Due: ${assignment.due}`);
        console.log(`   URL:    ${assignment.url}`);

        try {
          const res = await solveAndSubmitCourseraAssignment(page, assignment.url, { dryRun: DRY_RUN, answerStore });
          runLog.push({ title: assignment.title, course: assignment.course, url: assignment.url, ...res });

          if (res.status === 'pass') metrics.solved++;
          else if (res.status === 'dry-run') metrics.dryRun++;
          else if (res.status === 'skipped') metrics.skipped++;
          else metrics.failed++;

          const mark = res.status === 'pass' ? '✓' : (res.status === 'dry-run' ? '↺' : '⚠️');
          console.log(`  ${mark} Finished: "${assignment.title}" [${res.status}]`);

          // Early-halt boundary: If this quiz is not live yet / locked for a future date,
          // ALL subsequent quizzes in the chronological feed are also future/not live. Break immediately!
          if (res.isFutureLocked) {
            console.log(`\n============================================================`);
            console.log(`🛑 [BITS] Halting scan at first unavailable/future quiz:`);
            console.log(`   Assignment: "${assignment.title}"`);
            console.log(`   Course:     ${assignment.course}`);
            console.log(`   Status:     ${res.reason || 'Not live yet / unavailable'}`);
            console.log(`   Remaining deadlines in queue are future-locked. Halting run.`);
            console.log(`============================================================\n`);
            break;
          }
        } catch (err) {
          console.error(`  ✗ Error solving "${assignment.title}":`, err.message);
          metrics.failed++;
          runLog.push({ title: assignment.title, url: assignment.url, status: 'fail', error: err.message });
        }

        await DELAY(2000);
      }
    } else {
      console.log(`\n============================================================`);
      console.log(`🎉 [BITS] All current deadline assignments are 100% completed and passed!`);
      console.log(`   No pending deadline quizzes remaining on dashboard.`);
      console.log(`============================================================\n`);
    }

    // 4. Course module outlines are ONLY crawled if explicitly requested via --all-modules
    const CRAWL_MODULES = process.argv.includes('--all-modules') || process.argv.includes('--crawl-course');
    if (CRAWL_MODULES && targetDeadlines.length === 0 && dashboard.courses.length > 0) {
      console.log(`\n[BITS] Checking course module outlines for internal practice assignments/quizzes...`);
      let coursesToCrawl = dashboard.courses;
      if (COURSE_ARG) {
        coursesToCrawl = coursesToCrawl.filter((c) =>
          c.name.toLowerCase().includes(COURSE_ARG.toLowerCase()) ||
          c.slug.toLowerCase().includes(COURSE_ARG.toLowerCase())
        );
      }

      for (const course of coursesToCrawl) {
        if (globalHaltRun) break;

        console.log(`\n============================================================`);
        console.log(`📘 Checking Course: ${course.name}`);
        console.log(`============================================================`);

        const outline = await crawlCourseOutline(page, course.url);
        metrics.assignmentsSeen += outline.allItems.length;

        if (outline.pending.length === 0) {
          console.log(`[BITS] No pending internal assignments in ${course.name}.`);
          continue;
        }

        for (const item of outline.pending) {
          if (globalHaltRun) break;

          console.log(`\n▶ [BITS Module Item] Starting: "${item.title}"`);
          try {
            const res = await solveAndSubmitCourseraAssignment(page, item.url, { dryRun: DRY_RUN });
            runLog.push({ title: item.title, course: course.name, url: item.url, ...res });

            if (res.status === 'pass') metrics.solved++;
            else if (res.status === 'dry-run') metrics.dryRun++;
            else if (res.status === 'skipped') metrics.skipped++;
            else metrics.failed++;

            if (res.isFutureLocked) {
              console.log(`[BITS] Course module quiz is not live yet: "${item.title}". Halting module scan.`);
              break;
            }
          } catch (err) {
            console.error(`  ✗ Error solving "${item.title}":`, err.message);
            metrics.failed++;
            runLog.push({ title: item.title, url: item.url, status: 'fail', error: err.message });
          }

          await DELAY(2000);
        }
      }
    }
  } finally {
    const elapsedSec = Math.round((Date.now() - metrics.startedAt) / 1000);
    console.log(`\n============================================================`);
    console.log(`🎓 BITS Coursera Run Summary`);
    console.log(`============================================================`);
    console.log(`Courses seen:       ${metrics.coursesSeen}`);
    console.log(`Assignments seen:   ${metrics.assignmentsSeen}`);
    console.log(`Solved / Passed:    ${metrics.solved}`);
    console.log(`Dry-run previewed:  ${metrics.dryRun}`);
    console.log(`Skipped (locked):   ${metrics.skipped}`);
    console.log(`Failed:             ${metrics.failed}`);
    console.log(`Elapsed time:       ${elapsedSec}s`);
    console.log(`AI Provider stats:  Gemini ${solverStats.geminiRequests}, Groq ${solverStats.groqRequests}, Grok ${solverStats.grokRequests}`);
    console.log(`Cache hits / misses: ${solverStats.cacheHits} / ${solverStats.cacheMisses}`);
    console.log(`============================================================\n`);

    try {
      fs.writeFileSync('bits-run-log.json', JSON.stringify(runLog, null, 2));
      console.log('Run log saved to bits-run-log.json');
    } catch {}

    await ctx.close().catch(() => {});
  }
}

// Allow direct CLI invocation: `node bits_main.js`
if (process.argv[1] && process.argv[1].endsWith('bits_main.js')) {
  runBits().catch(console.error);
}
