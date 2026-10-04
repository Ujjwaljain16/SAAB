// bits_main.js — Main orchestrator for BITS Pilani Coursera degree automation

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { BITS_URLS } from './bits_config.js';
import { discoverDegreeCourses, crawlCourseOutline } from './bits_crawler.js';
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
      console.log(`[BITS] Direct assignment mode requested.`);
      const result = await solveAndSubmitCourseraAssignment(page, ASSIGNMENT_ARG, { dryRun: DRY_RUN });
      runLog.push({ url: ASSIGNMENT_ARG, result });
      if (result.status === 'pass') metrics.solved++;
      else if (result.status === 'dry-run') metrics.dryRun++;
      else if (result.status === 'skipped') metrics.skipped++;
      else metrics.failed++;
      return;
    }

    // 2. Discover Courses
    let targetCourses = [];
    if (COURSE_ARG) {
      if (COURSE_ARG.startsWith('http')) {
        targetCourses = [{ name: 'Target Course', url: COURSE_ARG, slug: COURSE_ARG.split('/')[4] || 'course' }];
      } else {
        const allCourses = await discoverDegreeCourses(page, BITS_URLS.DEGREE_HOME);
        targetCourses = allCourses.filter(
          (c) => c.slug.toLowerCase().includes(COURSE_ARG.toLowerCase()) || c.name.toLowerCase().includes(COURSE_ARG.toLowerCase())
        );
      }
    } else {
      targetCourses = await discoverDegreeCourses(page, BITS_URLS.DEGREE_HOME);
    }

    if (targetCourses.length === 0) {
      console.log(`[BITS] No matching courses found to process.`);
      return;
    }

    console.log(`\n[BITS] Ready to process ${targetCourses.length} course(s).`);

    // 3. Process each course
    for (const course of targetCourses) {
      if (globalHaltRun) break;
      metrics.coursesSeen++;

      console.log(`\n============================================================`);
      console.log(`📘 Course [${metrics.coursesSeen}/${targetCourses.length}]: ${course.name}`);
      console.log(`============================================================`);

      const outline = await crawlCourseOutline(page, course.url);
      metrics.assignmentsSeen += outline.allItems.length;

      if (outline.pending.length === 0) {
        console.log(`[BITS] No pending assignments in this course. (Locked: ${outline.locked.length}, Completed: ${outline.completed.length})`);
        continue;
      }

      console.log(`[BITS] Starting execution for ${outline.pending.length} pending assignment(s)...`);

      for (const assignment of outline.pending) {
        if (globalHaltRun) break;

        console.log(`\n▶ [BITS] Starting: "${assignment.title}"`);
        try {
          const res = await solveAndSubmitCourseraAssignment(page, assignment.url, { dryRun: DRY_RUN });
          runLog.push({ title: assignment.title, url: assignment.url, ...res });

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
