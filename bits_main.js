// bits_main.js — Main orchestrator for BITS Pilani Coursera degree automation

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { BITS_URLS } from './bits_config.js';
import { discoverDegreeDashboard, crawlCourseOutline, ensureCourseraLoggedIn } from './bits_crawler.js';
import { solveAndSubmitCourseraAssignment } from './bits_handler.js';
import { solverStats } from './solver.js';

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

  console.log(`\n============================================================`);
  console.log(`🎓 BITS Pilani BSc Computer Science — Coursera Auto-Solver`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (Preview Only)' : 'SUBMIT (Live)'}`);
  if (COURSE_ARG) console.log(`Course filter: "${COURSE_ARG}"`);
  if (ASSIGNMENT_ARG) console.log(`Direct assignment: "${ASSIGNMENT_ARG}"`);
  console.log(`============================================================\n`);

  const userDataDir = path.join(process.cwd(), 'temp_chrome_profile');
  const profileName = 'Profile 3';

  if (!fs.existsSync(userDataDir)) {
    console.error("temp_chrome_profile not found. Please ensure Chrome profile directory exists.");
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [
      `--profile-directory=${profileName}`,
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    viewport: { width: 1280, height: 800 }
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
      const result = await solveAndSubmitCourseraAssignment(page, ASSIGNMENT_ARG, { dryRun: DRY_RUN });
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
          const res = await solveAndSubmitCourseraAssignment(page, assignment.url, { dryRun: DRY_RUN });
          runLog.push({ title: assignment.title, course: assignment.course, url: assignment.url, ...res });

          if (res.status === 'pass') metrics.solved++;
          else if (res.status === 'dry-run') metrics.dryRun++;
          else if (res.status === 'skipped') metrics.skipped++;
          else metrics.failed++;

          const mark = res.status === 'pass' ? '✓' : (res.status === 'dry-run' ? '↺' : '⚠️');
          console.log(`  ${mark} Finished: "${assignment.title}" [${res.status}]`);
        } catch (err) {
          console.error(`  ✗ Error solving "${assignment.title}":`, err.message);
          metrics.failed++;
          runLog.push({ title: assignment.title, url: assignment.url, status: 'fail', error: err.message });
        }

        await DELAY(2000);
      }
    } else {
      console.log(`[BITS] No pending deadline assignments found on dashboard.`);
    }

    // 4. If no pending deadline assignments or if specific course requested, crawl course modules
    if (targetDeadlines.length === 0 && dashboard.courses.length > 0) {
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
