import 'dotenv/config';
import { chromium } from 'playwright';
import { getQueue, parseProgressCount } from './crawler.js';
import {
  solve, solverStats, looksTruncated, solveMCQ, solveWorkspace,
  commitSolution, evictSolution, recordWrongMCQOption, assertProviderConfigured, allProvidersExhausted, getQuotaReport,
  getWrongMCQOptions, makeMCQCacheKey
} from './solver.js';
import { injectAndSubmit } from './injector.js';
import { slurpWorkspaceContext, injectWorkspaceContext, waitForWorkspaceReady } from './workspace_manager.js';
import { slurpMCQContext, injectMCQAnswer } from './mcq_handler.js';
import { solveAndSubmitLab } from './lab_handler.js';
import { SEL } from './config.js';
import { snapshotPage } from './page_utils.js';
import { dataPath } from './paths.js';
import { makeRunState, markClassComplete, markProblemComplete } from './run_state.js';
import {
  previewCode, classifyFailureFeedback, resolveTargetLanguage, selectProblemLanguage,
  getCurrentSelectedLanguageLabel, extractProblemContent, extractTestCases, extractEditorStarterCode,
  collectAssignmentProblems, collectQuestionTabs, mergeProblems, isSolvedNow, buildProblemsUrl, isLoginUrl, detectProblemType
} from './scaler_page.js';
import { pathToFileURL } from 'url';
import { normalizeScalerUrl, canonicalProblemUrl } from './scaler_url.js';
import { loginToScaler } from './scaler_login.js';
import fs from 'fs';
import path from 'path';

let globalHaltRun = false;
let globalHaltReason = '';

let signalCount = 0;
function handleStopSignal(name, reason) {
  signalCount += 1;
  if (signalCount > 1) {
    console.log(`\n[${name}] Second signal received. Forcing exit.`);
    process.exit(130);
  }
  console.log(`\n[${name}] Halting gracefully after current operations to save state... (send again to force quit)`);
  globalHaltRun = true;
  globalHaltReason = reason;
}

process.on('SIGINT', () => handleStopSignal('SIGINT', 'Manually interrupted (SIGINT)'));
process.on('SIGTERM', () => handleStopSignal('SIGTERM', 'Terminated (SIGTERM)'));

const DELAY = (ms) => new Promise(r => setTimeout(r, ms));

// Refuse unknown CLI arguments: a typo like `npm run start :mcq` used to be ignored and silently ran EVERYTHING in live-submit mode.
const KNOWN_FLAGS = ['--log-time', '--dry-run', '--submit', '--skip-labs', '--only-mcq', '--only-labs', '--bits', '--recheck', '--force', '--refresh-curriculum', '--live'];
const KNOWN_PREFIXES = ['--class=', '--subject=', '--max-submissions=', '--course=', '--assignment=', '--e2e-class=', '--e2e-submit-lab='];
const unknownArgs = process.argv.slice(2).filter((a) => !KNOWN_FLAGS.includes(a) && !KNOWN_PREFIXES.some((p) => a.startsWith(p)));
if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(' ')}`);
  console.error(`Known flags: ${KNOWN_FLAGS.join(' ')} ${KNOWN_PREFIXES.map((p) => `${p}<value>`).join(' ')}`);
  console.error('For MCQ-only use: npm run start:mcq   (no space before the colon)');
  process.exit(2);
}
const DRY_RUN = process.argv.includes('--dry-run') && !process.argv.includes('--submit');
const CLASS_FILTER = process.argv.find(a => a.startsWith('--class='))?.split('=')[1] || '';
const SUBJECT_FILTER = process.argv.find(a => a.startsWith('--subject='))?.split('=')[1] || '';
const SKIP_LABS = process.argv.includes('--skip-labs') || process.env.SKIP_LABS === 'true';
const ONLY_MCQ = process.argv.includes('--only-mcq') || process.env.ONLY_MCQ === 'true';
const ONLY_LABS = process.argv.includes('--only-labs') || process.env.ONLY_LABS === 'true';
const IS_BITS = process.argv.includes('--bits') || process.env.BITS === 'true';
const RUN_STATE_PATH = dataPath('run-state.json');
// TEST ONLY: --e2e-class=<id> runs the whole pipeline on ONE class even if it is fully solved (discovery, solved-skips and the
// checkpoint are bypassed; progress goes to run-state.e2e.json, never your real checkpoint). Never use it for real work.
const E2E_CLASS = process.argv.find(a => a.startsWith('--e2e-class='))?.split('=')[1] || '';
// Prefix every log line with seconds since start, to find where a run lags.
const LOG_TIME = process.argv.includes('--log-time') || process.env.SAAB_LOG_TIME === 'true';
if (LOG_TIME) {
  const t0 = Date.now();
  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...args);
  }
}
// TEST ONLY, needs --e2e-class: press Run Task on ONE already-solved lab whose title contains this text, to exercise the submit path.
// Scaler warns that running a completed task resets later tasks; the agent cancels that warning and stops (never confirms it).
const E2E_SUBMIT_LAB = E2E_CLASS ? (process.argv.find(a => a.startsWith('--e2e-submit-lab='))?.split('=').slice(1).join('=') || '') : '';
const labOptionsFor = (title) =>
  E2E_SUBMIT_LAB && String(title).toLowerCase().includes(E2E_SUBMIT_LAB.toLowerCase()) ? { forceSubmit: true } : {};
const solvedGuard = (page, opts) => (E2E_CLASS ? Promise.resolve(false) : isSolvedNow(page, opts));

const SOLVE_CONCURRENCY = Math.max(1, Number(process.env.SOLVE_CONCURRENCY) || 4);
// Safety valve: stop after this many submissions in one run (0 = unlimited). Workers may overshoot by SOLVE_CONCURRENCY - 1.
// Tries per MCQ (each wrong answer is excluded from the next try); after that the question is left alone.
const MAX_MCQ_TRIES = Math.max(1, Number(process.env.MCQ_MAX_TRIES) || 3);
const MAX_SUBMISSIONS = Math.max(0, Number(process.argv.find(a => a.startsWith('--max-submissions='))?.split('=')[1] ?? process.env.MAX_SUBMISSIONS) || 0);

class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
    }).then(() => () => this.release());
  }

  isLocked() {
    return this._locked;
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

const workspaceMutex = new AsyncMutex();

function createRunMetrics() {
  return {
    startedAt: Date.now(),
    classesSeen: 0,
    classesSkipped: 0,
    problemsRead: 0,
    problemsSolved: 0,
    problemsDryRun: 0,
    problemsFailed: 0,
    problemsSkipped: 0,
    solveAttempts: 0,
    submitAttempts: 0
  };
}

function printRunSummary(metrics, log) {
  const elapsedMs = Date.now() - metrics.startedAt;
  const elapsedSec = Math.round(elapsedMs / 1000);
  const totalDone = log.filter((entry) => entry.result === 'pass' || entry.result === 'dry-run').length;

  console.log('\n=== Run Summary ===');
  console.log(`Classes seen: ${metrics.classesSeen}`);
  console.log(`Classes skipped from checkpoint: ${metrics.classesSkipped}`);
  console.log(`Problems read: ${metrics.problemsRead}`);
  console.log(`Solved: ${metrics.problemsSolved}`);
  console.log(`Dry-run previewed: ${metrics.problemsDryRun}`);
  console.log(`Failed: ${metrics.problemsFailed}`);
  console.log(`Skipped: ${metrics.problemsSkipped}`);
  console.log(`Solve attempts: ${metrics.solveAttempts}`);
  console.log(`Submit attempts: ${metrics.submitAttempts}`);
  console.log(`Elapsed: ${elapsedSec}s`);
  console.log(`Provider requests: Gemini ${solverStats.geminiRequests}, Groq ${solverStats.groqRequests}, Grok ${solverStats.grokRequests}`);
  console.log(`Cache hits: ${solverStats.cacheHits}, misses: ${solverStats.cacheMisses}`);
  console.log(`Provider rate limits: ${solverStats.rateLimits}, server errors: ${solverStats.serverErrors}`);
  console.log(`Provider failures: ${solverStats.providerFailures}`);
  for (const q of getQuotaReport()) {
    const rate = Number.isFinite(q.effectiveRpm) ? `${q.effectiveRpm}/min` : 'unlimited';
    console.log(`Quota ${q.name}: ${q.used} request(s) today${q.rpd ? ` of ${q.rpd}` : ''}, rate ${rate}${q.exhausted ? ' [OUT OF QUOTA TODAY]' : ''}`);
  }
  console.log(`Completed entries: ${totalDone}/${log.length}`);
}

async function safeGoto(page, url, options = {}) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const opts = {
      waitUntil: attempt === 1 ? 'domcontentloaded' : 'commit',
      timeout: attempt === 1 ? 45000 : 60000,
      ...options
    };
    try {
      if (page.url() === url) {
        return;
      }
      return await page.goto(url, opts);
    } catch (err) {
      const isAbort = /ERR_ABORTED|net::ERR_|aborted/i.test(err.message || '');
      const isTimeout = err.name === 'TimeoutError' || /timeout/i.test(err.message || '');
      if (attempt < maxRetries && (isAbort || isTimeout)) {
        console.log(`  [safeGoto] Navigation to ${url.slice(0, 65)} failed (${isAbort ? 'ERR_ABORTED' : 'timeout'}). Retrying (attempt ${attempt + 1}/${maxRetries})...`);
        await DELAY(1500 * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function ensureLoggedIn(page, ctx, reason = 'session check') {
  if (!isLoginUrl(page.url())) {
    return;
  }
  console.log(`Session expired (${reason}). Re-authenticating...`);
  await loginToScaler(page);
  await ctx.storageState({ path: dataPath('session.json') }).catch(() => {});
}

async function run() {
  if (IS_BITS) {
    const { runBits } = await import('./bits_main.js');
    return runBits();
  }

  assertProviderConfigured();

  const runState = makeRunState(RUN_STATE_PATH);
  if (E2E_CLASS) {
    console.warn(`\n!!! TEST MODE (--e2e-class=${E2E_CLASS}): solved-skips are DISABLED for this one class. Progress goes to run-state.e2e.json. Do not use this for real work. !!!\n`);
    runState.filePath = dataPath('run-state.e2e.json');
    runState.completedProblems.clear();
    runState.completedClasses.clear();
  }
  const metrics = createRunMetrics();
  const userDataDir = process.env.SAAB_PROFILE_DIR
    ? path.resolve(process.env.SAAB_PROFILE_DIR)
    : path.join(process.cwd(), 'temp_chrome_profile');
  // SAAB_HEADLESS / SAAB_BROWSER_CHANNEL exist so the test-suite can drive this file against a mock site.
  const browserChannel = process.env.SAAB_BROWSER_CHANNEL === undefined ? 'chrome' : process.env.SAAB_BROWSER_CHANNEL;
  const profileName = 'Profile 3';

  if (!fs.existsSync(userDataDir)) {
    console.error("temp_chrome_profile not found. Please run 'npm run auth' first.");
    process.exit(1);
  }

  console.log(`Launching Chrome with high-speed Page Pool (${SOLVE_CONCURRENCY} workers)... Mode: ${DRY_RUN ? 'dry-run' : 'submit'}${ONLY_MCQ ? ' [ONLY-MCQ]' : ''}${SKIP_LABS ? ' [SKIP-LABS]' : ''}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.SAAB_HEADLESS === 'true',
    ...(browserChannel ? { channel: browserChannel } : {}),
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
    viewport: { width: 1280, height: 720 }
  });

  // High-speed route optimization: block tracking, analytics, ads, and heavy media
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (/google-analytics|googletagmanager|mixpanel|datadoghq|hotjar|sentry\.io|clarity\.ms|segment\.io|amplitude\.com|fullstory|facebook\.net|doubleclick/i.test(url)) {
      return route.abort();
    }
    if (['media'].includes(req.resourceType()) || /\.(mp4|webm|avi|mov|mp3|wav|ogg)(\?.*)?$/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  // Test-only hook: a module exporting `setup(ctx)` that registers mock routes on the browser context.
  if (process.env.SAAB_TEST_ROUTES) {
    const hook = await import(pathToFileURL(path.resolve(process.env.SAAB_TEST_ROUTES)).href);
    await hook.setup(ctx);
  }

  const log = [];

  try {
    let mainPage = ctx.pages()[0] || await ctx.newPage();

    console.log('Checking session on curriculum dashboard...');
    await safeGoto(mainPage, normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
    await ensureLoggedIn(mainPage, ctx, 'initial dashboard open');

    const queue = E2E_CLASS
      ? [{ classUrl: normalizeScalerUrl(`/academy/mentee-dashboard/class/${E2E_CLASS}`), pending: 'Assignment 0/0', subject: process.env.E2E_SUBJECT || 'SST DevOps & Cloud' }]
      : await getQueue(mainPage);
    let filteredQueue = queue;
    if (SUBJECT_FILTER) {
      filteredQueue = filteredQueue.filter(({ subject }) => (subject || '').toLowerCase().includes(SUBJECT_FILTER.toLowerCase()));
      console.log(`--subject filter active: "${SUBJECT_FILTER}", ${filteredQueue.length} class(es) matched.`);
    }
    if (CLASS_FILTER) {
      filteredQueue = filteredQueue.filter(({ classUrl }) => classUrl.includes(CLASS_FILTER));
      console.log(`--class filter active: "${CLASS_FILTER}", ${filteredQueue.length} class(es) matched.`);
    }

    if (queue.length === 0) {
      console.log("No pending questions found. Exiting.");
      await ctx.close();
      return;
    }

    if (filteredQueue.length !== queue.length) {
      console.log(`Skipping ${queue.length - filteredQueue.length} already completed classes from checkpoint.`);
      metrics.classesSkipped = queue.length - filteredQueue.length;
    }

    for (const { classUrl, pending, subject } of filteredQueue) {
      if (globalHaltRun) break;

      if (mainPage.isClosed()) {
        try {
          mainPage = await ctx.newPage();
        } catch {
          globalHaltRun = true;
          globalHaltReason = 'The browser window was closed';
          break;
        }
      }

      metrics.classesSeen += 1;
      console.log(`\n============================================================`);
      console.log(`Processing class: ${classUrl}\nPending: ${pending}\nSubject: ${subject}`);
      console.log(`============================================================`);

      try {
        let problemsUrl = normalizeScalerUrl(`${classUrl}/assignment/problems?navref=cl_tb_br`);
        await safeGoto(mainPage, problemsUrl);
        await ensureLoggedIn(mainPage, ctx, 'assignment problems navigation');

        const hasDirectProblems = await mainPage.waitForSelector('tr.table__row a[href*="/assignment/problems/"], a.cr-p-navigation-dock-item[href*="/assignment/problems/"]', { timeout: 8000 }).catch(() => null);
        if (!hasDirectProblems && !mainPage.url().includes('/assignment/problems')) {
          console.log(`  Falling back to tab navigation for class ${classUrl}...`);
          await safeGoto(mainPage, classUrl);
          await ensureLoggedIn(mainPage, ctx, 'class navigation');

          const assignmentTab = mainPage.locator(SEL.assignmentTab).first();
          await assignmentTab.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
          const assignmentHref = await assignmentTab.getAttribute('href').catch(() => null);
          if (assignmentHref) {
            problemsUrl = buildProblemsUrl(normalizeScalerUrl(assignmentHref.startsWith('http') ? assignmentHref : `https://www.scaler.com${assignmentHref}`));
            await safeGoto(mainPage, problemsUrl);
          } else {
            await assignmentTab.click().catch(() => {});
            await DELAY(1500);
          }
          await ensureLoggedIn(mainPage, ctx, 'assignment problems navigation');
        }

        await mainPage.waitForSelector('tr.table__row a[href*="/assignment/problems/"], a.cr-p-navigation-dock-item[href*="/assignment/problems/"]', { timeout: 12000 }).catch(() => {});

        // The question dock renders before the problems table. Reading too early gave dock-only data (titles like "Q 1") and lost
        // the table's solved flags, so wait for the table itself (short, because some layouts only have the dock).
        await mainPage.waitForSelector('tr.table__row a.me-cr-problem-list__name, tr.table__row a.me-cr-problem-actions__btn', { timeout: 6000 }).catch(() => {});
        const tableProblems = await collectAssignmentProblems(mainPage);
        const questionTabs = await collectQuestionTabs(mainPage);
        // Only real question links; if the table OR the dock says a problem is solved, it is solved and never touched.
        const problems = mergeProblems(tableProblems, questionTabs);
        for (const p of problems) {
          if (p.isSolved && !E2E_CLASS) runState.completedProblems.add(p.solveUrl);
        }

        if (problems.length === 0) {
          console.log('No assignment problems found on this page.');
          await snapshotPage(mainPage, 'no-problems-found', classUrl);
          continue;
        }

      console.log(`Found ${problems.length} assignment problem(s). Initiating Page Pool workers...`);

      // Filter unsolved
      const pendingProblems = problems.filter((p) => !runState.completedProblems.has(canonicalProblemUrl(p.solveUrl)));

      if (pendingProblems.length === 0) {
        console.log('All extracted problems in this class are already completed from checkpoint.');
        const progress = parseProgressCount(pending);
        if (!progress || progress.completed >= progress.total || problems.length >= progress.total) {
          markClassComplete(runState, classUrl);
        } else {
          console.log(`Class has ${pending} on dashboard, but extracted table had 0 pending. Retaining class for recheck.`);
        }
        continue;
      }

      console.log(`Pending problems to solve: ${pendingProblems.length}/${problems.length}`);

      // Spawn Page Pool
      const poolSize = Math.min(SOLVE_CONCURRENCY, pendingProblems.length);
      const workerPages = [];
      workerPages.push(mainPage); // Main page serves as worker 0
      for (let i = 1; i < poolSize; i++) {
        workerPages.push(await ctx.newPage());
      }

      let problemQueueIndex = 0;
      let classAllPassed = true;
      // Labs / IDE problems need the single shared container slot and take 30-40s each. A worker that finds the slot busy defers
      // the problem instead of sitting idle, keeps doing other problems, and comes back to it when the slot is free.
      const deferredLabs = [];
      let inFlight = 0;
      // A worker that took a deferred lab spends several seconds navigating before it actually locks the slot; count it as taken so a
      // second worker does not grab another deferred lab in that window and end up blocked on the mutex.
      let labsReserved = 0;

      async function runWorker(initialPage, workerId) {
        let page = initialPage;
        let pageRecoveries = 0;
        while (!globalHaltRun) {
          if (allProvidersExhausted()) {
            globalHaltRun = true;
            globalHaltReason = 'All AI providers are out of daily quota. Add GROQ_API_KEY (free) or more GEMINI_API_KEYS, or resume tomorrow - progress is checkpointed.';
            break;
          }
          if (MAX_SUBMISSIONS && metrics.submitAttempts >= MAX_SUBMISSIONS) {
            globalHaltRun = true;
            globalHaltReason = `Reached submission cap (${MAX_SUBMISSIONS})`;
            break;
          }
          let problem;
          let tookDeferred = false;
          if (deferredLabs.length > 0 && !workspaceMutex.isLocked() && labsReserved === 0) {
            // The lab/IDE slot is the bottleneck (one container at a time, 30-60s each): the moment it is free, refill it from the
            // deferred labs instead of letting it sit idle until every other problem has been handed out.
            problem = deferredLabs.shift();
            tookDeferred = true;
            labsReserved += 1;
          } else if (problemQueueIndex < pendingProblems.length) {
            problem = pendingProblems[problemQueueIndex++];
          } else if (deferredLabs.length > 0 || inFlight > 0) {
            // Nothing free to do right now, but another worker may still defer a lab or be about to finish one: wait, don't leave early.
            await DELAY(500);
            continue;
          } else {
            break;
          }
          inFlight += 1;

          try {

          const solveUrl = problem.solveUrl.startsWith('http') ? problem.solveUrl : `https://www.scaler.com${problem.solveUrl}`;
          if (runState.completedProblems.has(solveUrl)) {
            console.log(`  [Worker ${workerId}] Checkpoint hit: ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            metrics.problemsSkipped += 1;
            continue;
          }

          console.log(`\n  [Worker ${workerId}] Navigating to: ${problem.title}`);
          metrics.problemsRead += 1;

          await safeGoto(page, normalizeScalerUrl(solveUrl));
          await ensureLoggedIn(page, ctx, `worker ${workerId} problem page`);

          if (await solvedGuard(page, { wait: true })) {
            console.log(`  [Worker ${workerId}] Already solved on Scaler: ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            markProblemComplete(runState, solveUrl);
            continue;
          }

          const targetLanguage = resolveTargetLanguage(subject);
          let type = await detectProblemType(page);
          if (type === 'unknown') {
            // Nothing recognisable has rendered (a slow page). Reload once and look again; never guess a problem type.
            console.log(`  [Worker ${workerId}] Page not recognised yet; reloading once: ${problem.title}`);
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await ensureLoggedIn(page, ctx, `worker ${workerId} reload`);
            type = await detectProblemType(page);
          }
          if (type === 'unknown') {
            console.log(`  [Worker ${workerId}] ✗ Could not recognise the problem type; skipping (no AI calls made): ${problem.title}`);
            await snapshotPage(page, 'unrecognized-problem-type', problem.title);
            metrics.problemsFailed += 1;
            classAllPassed = false;
            log.push({ title: problem.title, result: 'fail' });
            continue;
          }
          console.log(`  [Worker ${workerId}] Detected problem type: ${type} for ${problem.title}`);
          if (type === 'coding' && (await page.locator(SEL.problemEditor).count()) === 0) {
            await snapshotPage(page, 'unrecognized-problem-type', problem.title);
          }

          if (ONLY_MCQ && type !== 'mcq') {
            console.log(`  [Worker ${workerId}] ⏭️ Skipping non-MCQ problem (--only-mcq active): ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            classAllPassed = false;
            continue;
          }

          if (ONLY_LABS && type !== 'lab' && type !== 'vscode') {
            console.log(`  [Worker ${workerId}] ⏭️ Skipping non-lab problem (--only-labs active): ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            classAllPassed = false;
            continue;
          }

          let problemContent = await extractProblemContent(page);

          if (type === 'lab') {
            if (SKIP_LABS || ONLY_MCQ) {
              console.log(`  [Worker ${workerId}] ⏭️ Skipping terminal lab (${SKIP_LABS ? '--skip-labs' : '--only-mcq'} active): ${problem.title}`);
              log.push({ title: problem.title, result: 'skipped' });
              classAllPassed = false;
              continue;
            }

            if (workspaceMutex.isLocked() && !problem.deferred) {
              problem.deferred = true;
              deferredLabs.push(problem);
              console.log(`  [Worker ${workerId}] Lab/IDE slot is busy; moving on and coming back to: ${problem.title}`);
              continue;
            }
            const release = await workspaceMutex.acquire();
            try {
              console.log(`  [Worker ${workerId}] Executing Maxwell container lab: ${problem.title}...`);
              // Waiting for the shared lab slot can take minutes: re-check before touching a container.
              if (await solvedGuard(page)) {
                console.log(`  [Worker ${workerId}] Already solved (found while waiting for the lab slot): ${problem.title}`);
                log.push({ title: problem.title, result: 'skipped' });
                markProblemComplete(runState, solveUrl);
                continue;
              }
              if (DRY_RUN) {
                metrics.problemsDryRun += 1;
                log.push({ title: problem.title, result: 'dry-run' });
                console.log(`  [Worker ${workerId}] ↺ DRY-RUN Lab: ${problem.title}`);
                continue;
              }

              metrics.solveAttempts += 1;
              metrics.submitAttempts += 1;

              const labOptions = labOptionsFor(problem.title);
              if (labOptions.forceSubmit) {
                console.warn(`  [Worker ${workerId}] !!! TEST MODE: Run Task WILL be pressed on this already-solved lab: ${problem.title} !!!`);
              }
              const labResult = await solveAndSubmitLab(
                page,
                problem.title,
                `${problemContent.title}\n\n${problemContent.body}`,
                labOptions
              );

              log.push({ title: problem.title, result: labResult.status });

              if (labResult.status === 'pass') {
                metrics.problemsSolved += 1;
                console.log(`  [Worker ${workerId}] ✓ Lab Passed: ${problem.title}`);
                markProblemComplete(runState, solveUrl);
              } else {
                metrics.problemsFailed += 1;
                classAllPassed = false;
                console.log(`  [Worker ${workerId}] ✗ Lab ${labResult.verdict}: ${problem.title}`);
                await snapshotPage(page, 'lab-fail', `${problem.title} :: ${labResult.verdict}`);
              }
            } finally {
              release();
            }
            continue;
          }

          if (type === 'vscode') {
            if (SKIP_LABS || ONLY_MCQ) {
              console.log(`  [Worker ${workerId}] ⏭️ Skipping VS Code IDE problem (${SKIP_LABS ? '--skip-labs' : '--only-mcq'} active): ${problem.title}`);
              log.push({ title: problem.title, result: 'skipped' });
              classAllPassed = false;
              continue;
            }

            if (DRY_RUN) {
              metrics.problemsDryRun += 1;
              log.push({ title: problem.title, result: 'dry-run' });
              console.log(`  [Worker ${workerId}] ↺ DRY-RUN VS Code IDE: ${problem.title}`);
              continue;
            }

            if (workspaceMutex.isLocked() && !problem.deferred) {
              problem.deferred = true;
              deferredLabs.push(problem);
              console.log(`  [Worker ${workerId}] Lab/IDE slot is busy; moving on and coming back to: ${problem.title}`);
              continue;
            }
            const release = await workspaceMutex.acquire();
            try {
              console.log(`  [Worker ${workerId}] Solving VS Code IDE problem: ${problem.title}...`);
              if (await solvedGuard(page)) {
                console.log(`  [Worker ${workerId}] Already solved (found while waiting for the IDE slot): ${problem.title}`);
                log.push({ title: problem.title, result: 'skipped' });
                markProblemComplete(runState, solveUrl);
                continue;
              }
              metrics.solveAttempts += 1;

              // Open the IDE if it hasn't loaded yet
              const openBtn = page.locator('button:has-text("Open IDE"), a:has-text("Open IDE"), button:has-text("VS Code")').first();
              if (await openBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await openBtn.click().catch(() => {});
                await page.waitForTimeout(3000);
              }

              await waitForWorkspaceReady(page);
              const workspaceFiles = await slurpWorkspaceContext(page);

              if (Object.keys(workspaceFiles).length === 0) {
                console.log(`  [Worker ${workerId}] ✗ Could not extract VS Code workspace files.`);
                metrics.problemsFailed += 1;
                classAllPassed = false;
                log.push({ title: problem.title, result: 'fail' });
                continue;
              }

              const wsResult = await solveWorkspace(problemContent, workspaceFiles);
              if (!wsResult?.fileMap || Object.keys(wsResult.fileMap).length === 0) {
                console.log(`  [Worker ${workerId}] ✗ AI returned empty fileMap for: ${problem.title}`);
                metrics.problemsFailed += 1;
                classAllPassed = false;
                log.push({ title: problem.title, result: 'fail' });
                continue;
              }

              if (await solvedGuard(page)) {
                console.log(`  [Worker ${workerId}] Became solved while the AI was working; not submitting: ${problem.title}`);
                log.push({ title: problem.title, result: 'skipped' });
                markProblemComplete(runState, solveUrl);
                continue;
              }
              await injectWorkspaceContext(page, wsResult.fileMap);
              metrics.submitAttempts += 1;

              // Click Run/Submit if available
              const submitBtn = page.locator(SEL.submitBtn).first();
              if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await submitBtn.click().catch(() => {});
                await page.waitForFunction(() => {
                  const t = (document.body.innerText || '').toLowerCase();
                  return t.includes('correct answer') || t.includes('all test cases passed') || t.includes('wrong answer') || t.includes('failed');
                }, { timeout: 40000 }).then(() => true).catch(() => false);

                const bodyText = await page.locator('body').innerText().catch(() => '');
                const passed = /correct answer|all test cases passed/i.test(bodyText);

                if (passed) {
                  metrics.problemsSolved += 1;
                  console.log(`  [Worker ${workerId}] ✓ VS Code IDE Passed: ${problem.title}`);
                  markProblemComplete(runState, solveUrl);
                  log.push({ title: problem.title, result: 'pass' });
                } else {
                  metrics.problemsFailed += 1;
                  classAllPassed = false;
                  console.log(`  [Worker ${workerId}] ✗ VS Code IDE Failed: ${problem.title}`);
                  log.push({ title: problem.title, result: 'fail' });
                }
              } else {
                console.log(`  [Worker ${workerId}] ✗ No submit button found for VS Code problem.`);
                metrics.problemsFailed += 1;
                classAllPassed = false;
                log.push({ title: problem.title, result: 'fail' });
              }
            } finally {
              release();
            }
            continue;
          }

          if (type === 'mcq') {
            if (ONLY_LABS) {
              console.log(`  [Worker ${workerId}] ⏭️ Skipping MCQ (--only-labs active): ${problem.title}`);
              log.push({ title: problem.title, result: 'skipped' });
              classAllPassed = false;
              continue;
            }
            // Up to MAX_MCQ_TRIES tries per question (default 3). Each wrong answer is remembered and excluded from the next try; after
            // the last try (or if earlier runs already burned that many) the question is left alone.
            let mcqFinished = false;
            for (let mcqTry = 1; mcqTry <= MAX_MCQ_TRIES && !mcqFinished && !globalHaltRun; mcqTry++) {
              if (mcqTry > 1) {
                // After a wrong answer the page can be left in an odd state: reload for a clean question and a fresh solved check.
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                await ensureLoggedIn(page, ctx, `worker ${workerId} mcq retry`);
                if (await solvedGuard(page, { wait: true })) {
                  console.log(`  [Worker ${workerId}] Already solved; stopping retries: ${problem.title}`);
                  log.push({ title: problem.title, result: 'skipped' });
                  markProblemComplete(runState, solveUrl);
                  break;
                }
              }

              problemContent = await slurpMCQContext(page);
              const triedWrong = getWrongMCQOptions(makeMCQCacheKey(problemContent));
              if (triedWrong.length >= MAX_MCQ_TRIES) {
                console.log(`  [Worker ${workerId}] Already tried ${triedWrong.length} wrong answers (limit ${MAX_MCQ_TRIES}); leaving it: ${problem.title}`);
                log.push({ title: problem.title, result: 'skipped' });
                classAllPassed = false;
                break;
              }

              const attemptsNote = problemContent.attemptsLeft == null ? '' : `, ${problemContent.attemptsLeft} attempt(s) left on page`;
              console.log(`  [Worker ${workerId}] Solving MCQ (try ${mcqTry}/${MAX_MCQ_TRIES}${attemptsNote}): ${problem.title}`);
              const mcqResult = await solveMCQ(problemContent);

              if (mcqResult.failed) {
                if (mcqResult.fatal) {
                  globalHaltRun = true;
                  globalHaltReason = 'All AI providers are out of daily quota. Add GROQ_API_KEY (free) or more GEMINI_API_KEYS, or resume tomorrow - progress is checkpointed.';
                }
                metrics.problemsFailed += 1;
                classAllPassed = false;
                log.push({ title: problem.title, result: 'fail' });
                console.log(`  [Worker ${workerId}] ✗ MCQ not answered (no valid AI answer, nothing submitted): ${problem.title}`);
                break;
              }

              if (DRY_RUN) {
                metrics.problemsDryRun += 1;
                log.push({ title: problem.title, result: 'dry-run' });
                console.log(`  [Worker ${workerId}] ↺ DRY-RUN MCQ Option: ${mcqResult.bestOptionIndex + 1}`);
                break;
              }

              // The AI call takes time; make sure the problem is still unsolved right before clicking anything.
              if (await solvedGuard(page)) {
                console.log(`  [Worker ${workerId}] Became solved while the AI was working; not submitting: ${problem.title}`);
                log.push({ title: problem.title, result: 'skipped' });
                markProblemComplete(runState, solveUrl);
                break;
              }

              metrics.submitAttempts += 1;
              const mcqInjectResult = await injectMCQAnswer(page, mcqResult.bestOptionIndex);

              if (mcqInjectResult.status === 'pass') {
                metrics.problemsSolved += 1;
                log.push({ title: problem.title, result: 'pass' });
                console.log(`  [Worker ${workerId}] ✓ MCQ Passed (try ${mcqTry}): ${problem.title}`);
                commitSolution(mcqResult.cacheKey, { bestOptionIndex: mcqResult.bestOptionIndex, reasoning: mcqResult.reasoning });
                markProblemComplete(runState, solveUrl);
                break;
              }

              evictSolution(mcqResult.cacheKey);
              console.log(`  [Worker ${workerId}] ✗ MCQ ${mcqInjectResult.verdict} (try ${mcqTry}/${MAX_MCQ_TRIES}): ${problem.title}`);

              const confirmedWrong = mcqInjectResult.verdict === 'Incorrect';
              if (confirmedWrong) {
                recordWrongMCQOption(mcqResult.cacheKey, mcqResult.bestOptionIndex);
              }

              // Only a confirmed wrong answer earns another try; a timeout / unknown verdict must not keep clicking blindly.
              if (!confirmedWrong || mcqTry === MAX_MCQ_TRIES) {
                metrics.problemsFailed += 1;
                classAllPassed = false;
                log.push({ title: problem.title, result: 'fail' });
                await snapshotPage(page, 'mcq-fail', `${problem.title} :: ${mcqInjectResult.verdict}`);
                mcqFinished = true;
              }
            }
            continue;
          }

          // Coding problem
          await selectProblemLanguage(page, targetLanguage);
          const selectedLanguageLabel = await getCurrentSelectedLanguageLabel(page);
          const starterCode = await extractEditorStarterCode(page);

          let result = 'fail';
          let failureFeedback = '';
          let alreadySolved = false;

          for (let attempt = 1; attempt <= 3; attempt++) {
            if (globalHaltRun) break;

            // A slow judge verdict (or another worker / the user) may already have solved it: never submit onto a solved problem.
            if (attempt > 1 && (await solvedGuard(page))) {
              alreadySolved = true;
              break;
            }

            metrics.solveAttempts += 1;
            console.log(`  [Worker ${workerId}] Solving coding (attempt ${attempt}): ${problem.title}`);

            const solveResult = await solve(
              `${problemContent.title}\n\n${problemContent.body}`,
              extractTestCases(problemContent.body),
              targetLanguage,
              {
                starterCode,
                selectedLanguageLabel,
                previousFeedback: classifyFailureFeedback(failureFeedback),
                attempt
              }
            );

            if (!solveResult?.ok) {
              if (solveResult?.type === 'rate_limit') {
                const waitSec = Number(solveResult.retryAfterSeconds || 5);
                if (solveResult.fatal) {
                  classAllPassed = false;
                  globalHaltRun = true;
                  globalHaltReason = `Provider quota exhausted. ${solveResult.message || ''}`;
                  console.log(`  [Worker ${workerId}] Quota exhausted. Halting run.`);
                  break;
                }
                console.log(`  [Worker ${workerId}] Rate limited. Waiting ${waitSec}s...`);
                await DELAY((waitSec + 1) * 1000);
              }
              failureFeedback = solveResult?.message || 'Solver failed.';
              continue;
            }

            const code = solveResult.code;
            if (!code || looksTruncated(code)) {
              failureFeedback = 'Generated code appears truncated. Regenerate full compilable code preserving starter scaffold.';
              console.log(`  [Worker ${workerId}] Code truncated, retrying without submit...`);
              continue;
            }

            if (DRY_RUN) {
              result = 'dry-run';
              metrics.problemsDryRun += 1;
              console.log(`  [Worker ${workerId}] Dry-run preview:\n${previewCode(code)}\n`);
              break;
            }

            if (await solvedGuard(page)) {
              alreadySolved = true;
              break;
            }

            metrics.submitAttempts += 1;
            const submitResult = await injectAndSubmit(page, code);
            result = submitResult.status;

            if (result === 'pass') {
              metrics.problemsSolved += 1;
              console.log(`  [Worker ${workerId}] ✓ Passed! Verdict: ${submitResult.verdict}`);
              commitSolution(solveResult.cacheKey, { code, language: targetLanguage });
              break;
            }

            evictSolution(solveResult.cacheKey);
            failureFeedback = submitResult.feedback || submitResult.verdict || 'Submission failed.';
            console.log(`  [Worker ${workerId}] Attempt ${attempt} failed: ${failureFeedback.slice(0, 160)}...`);
            await DELAY(500);
          }

          if (alreadySolved) {
            console.log(`  [Worker ${workerId}] Already solved on Scaler; stopped without submitting: ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            metrics.problemsSkipped += 1;
            markProblemComplete(runState, solveUrl);
            continue;
          }

          if (!['pass', 'dry-run'].includes(result)) {
            metrics.problemsFailed += 1;
            classAllPassed = false;
            await snapshotPage(page, 'coding-fail', `${problem.title} :: ${failureFeedback.slice(0, 300)}`);
          }

          log.push({ title: problem.title, result });
          const mark = result === 'pass' ? '✓' : (result === 'dry-run' ? '↺' : '✗');
          console.log(`  [Worker ${workerId}] ${mark} ${problem.title}`);

          if (result === 'pass') {
            markProblemComplete(runState, solveUrl);
          }
          } catch (err) {
            const pageDied = page.isClosed();
            if (pageDied && problem && !problem.requeued) {
              // The browser page died under us (not the problem's fault): give the problem one more chance on a fresh page.
              problem.requeued = true;
              pendingProblems.push(problem);
              console.warn(`  [Worker ${workerId}] Page closed while on "${problem.title}"; re-queued once.`);
            } else {
              metrics.problemsFailed += 1;
              classAllPassed = false;
              log.push({ title: problem?.title || 'unknown', result: 'fail' });
              console.error(`  [Worker ${workerId}] ✗ Unexpected error on "${problem?.title}": ${err.message}`);
              await snapshotPage(page, 'worker-error', `${problem?.title} :: ${err.message}`);
            }

            if (pageDied) {
              if (pageRecoveries >= 2) {
                console.error(`  [Worker ${workerId}] Its page keeps closing. Stopping this worker.`);
                break;
              }
              pageRecoveries += 1;
              try {
                page = await ctx.newPage();
                workerPages[workerId] = page;
                console.log(`  [Worker ${workerId}] Opened a fresh page (recovery ${pageRecoveries}/2).`);
              } catch (openErr) {
                console.error(`  [Worker ${workerId}] Cannot open a new page (${openErr.message}). Stopping this worker.`);
                break;
              }
            }
          } finally {
            inFlight -= 1;
            if (tookDeferred) labsReserved -= 1;
          }
        }
      }

      // Execute all workers concurrently
      const workers = workerPages.map((workerPage, i) => runWorker(workerPage, i));
      await Promise.all(workers);
      if (!workerPages[0].isClosed()) mainPage = workerPages[0];

      // Close extra worker pages to release memory, keeping mainPage
      for (let i = 1; i < workerPages.length; i++) {
        await workerPages[i].close().catch(() => {});
      }

        const progress = parseProgressCount(pending);
        const curriculumFullyDone = !progress || progress.completed >= progress.total;

        if (!DRY_RUN && classAllPassed && pendingProblems.length > 0 && !globalHaltRun && curriculumFullyDone) {
          console.log(`✓ All problems passed for class: ${classUrl}. Marking class complete!`);
          markClassComplete(runState, classUrl);
        } else if (DRY_RUN && classAllPassed && pendingProblems.length > 0) {
          console.log(`↺ Dry-run preview completed for class: ${classUrl}`);
        } else if (classAllPassed && !curriculumFullyDone) {
          console.log(`Class ${classUrl} passed current batch, but curriculum indicates ${pending}. Class remains open.`);
        }
      } catch (classErr) {
        console.error(`  ⚠️ Error processing class ${classUrl}:`, classErr.message);
        metrics.classesSkipped += 1;
      }
    }
  } finally {
    try {
      const logJson = JSON.stringify(log, null, 2);
      fs.writeFileSync(dataPath('run-log.json'), logJson);
      // Keep a per-run history so earlier runs aren't lost when the next one overwrites run-log.json.
      fs.mkdirSync(dataPath('runs'), { recursive: true });
      fs.writeFileSync(dataPath('runs', `run-${new Date(metrics.startedAt).toISOString().replace(/[:.]/g, '-')}.json`), logJson);
    } catch {}

    if (globalHaltRun) {
      console.log(`\nStopped: ${globalHaltReason}`);
    }

    printRunSummary(metrics, log);
    console.log(`\nDone. ${log.filter(l => l.result === 'pass').length}/${log.length} passed. Run log saved to run-log.json.`);
    await ctx.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
