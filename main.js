import 'dotenv/config';
import { chromium } from 'playwright';
import { getQueue } from './crawler.js';
import { solve, solverStats, looksTruncated, solveMCQ, solveWorkspace } from './solver.js';
import { injectAndSubmit } from './injector.js';
import { slurpWorkspaceContext, injectWorkspaceContext, waitForWorkspaceReady } from './workspace_manager.js';
import { slurpMCQContext, injectMCQAnswer } from './mcq_handler.js';
import { solveAndSubmitLab } from './lab_handler.js';
import { SEL } from './config.js';
import { normalizeScalerUrl } from './scaler_url.js';
import { loginToScaler } from './scaler_login.js';
import fs from 'fs';
import path from 'path';

let globalHaltRun = false;
let globalHaltReason = '';

process.on('SIGINT', () => {
  console.log('\n[SIGINT] Received interrupt signal. Halting gracefully after current operations to save state...');
  globalHaltRun = true;
  globalHaltReason = 'Manually interrupted (SIGINT)';
});

process.on('SIGTERM', () => {
  console.log('\n[SIGTERM] Received termination signal. Halting gracefully after current operations to save state...');
  globalHaltRun = true;
  globalHaltReason = 'Terminated (SIGTERM)';
});

const DELAY = (ms) => new Promise(r => setTimeout(r, ms));
const DRY_RUN = process.argv.includes('--dry-run') && !process.argv.includes('--submit');
const CLASS_FILTER = process.argv.find(a => a.startsWith('--class='))?.split('=')[1] || '';
const SUBJECT_FILTER = process.argv.find(a => a.startsWith('--subject='))?.split('=')[1] || '';
const SKIP_LABS = process.argv.includes('--skip-labs') || process.env.SKIP_LABS === 'true';
const ONLY_MCQ = process.argv.includes('--only-mcq') || process.env.ONLY_MCQ === 'true';
const ONLY_LABS = process.argv.includes('--only-labs') || process.env.ONLY_LABS === 'true';
const RUN_STATE_PATH = path.join(process.cwd(), 'run-state.json');
const SOLVE_CONCURRENCY = Math.max(1, Number(process.env.SOLVE_CONCURRENCY || 4));

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
  console.log(`Completed entries: ${totalDone}/${log.length}`);
}

function loadRunState() {
  try {
    if (!fs.existsSync(RUN_STATE_PATH)) {
      return { version: 1, completedClasses: [], completedProblems: [] };
    }

    const raw = fs.readFileSync(RUN_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      completedClasses: Array.isArray(parsed.completedClasses) ? parsed.completedClasses : [],
      completedProblems: Array.isArray(parsed.completedProblems) ? parsed.completedProblems : []
    };
  } catch {
    return { version: 1, completedClasses: [], completedProblems: [] };
  }
}

function saveRunState(state) {
  try {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      completedClasses: state.completedClasses,
      completedProblems: state.completedProblems
    };
    const tmp = RUN_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, RUN_STATE_PATH);
  } catch {}
}

function makeRunState() {
  const stored = loadRunState();
  return {
    completedClasses: new Set(stored.completedClasses),
    completedProblems: new Set(stored.completedProblems)
  };
}

function persistRunState(runState) {
  saveRunState({
    completedClasses: Array.from(runState.completedClasses),
    completedProblems: Array.from(runState.completedProblems)
  });
}

function markClassComplete(runState, classUrl) {
  runState.completedClasses.add(classUrl);
  persistRunState(runState);
}

function markProblemComplete(runState, problemKey) {
  runState.completedProblems.add(problemKey);
  persistRunState(runState);
}

function previewCode(code, maxLines = 18) {
  const lines = (code || '').split(/\r?\n/);
  if (lines.length <= maxLines) {
    return code;
  }
  return `${lines.slice(0, maxLines).join('\n')}\n... [truncated ${lines.length - maxLines} lines]`;
}

function classifyFailureFeedback(text) {
  const value = (text || '').toLowerCase();

  if (value.includes('incompatible types') || value.includes('cannot find symbol') || value.includes('method ') || value.includes('signature')) {
    return 'Compilation/signature mismatch. Preserve the starter method names, parameter types, and return types exactly.';
  }
  if (value.includes('wrong answer') || value.includes('expected') || value.includes('actual')) {
    return 'Wrong answer. Keep the same scaffold and fix only the logic difference shown in feedback.';
  }
  if (value.includes('runtime error') || value.includes('exception') || value.includes('nullpointer') || value.includes('indexoutofbounds')) {
    return 'Runtime error. Add safety checks and handle edge cases without changing required signatures.';
  }
  if (value.includes('time limit exceeded') || value.includes('tle')) {
    return 'Time limit issue. Optimize the current approach without changing the required API.';
  }

  return 'Use the feedback to improve the current attempt while preserving the starter scaffold and required method names.';
}

function normalizeProblemTitle(title) {
  return title.replace(/\s*-\s*Problem.*$/i, '').trim();
}

function resolveTargetLanguage(subject) {
  if (/programming using js/i.test(subject)) {
    return 'JavaScript';
  }
  return 'Java';
}

function normalizeLanguageName(value) {
  const v = (value || '').toLowerCase();
  if (v.includes('javascript')) return 'javascript';
  if (/(^|\b)java(\b|$)/.test(v)) return 'java';
  return '';
}

async function getCurrentSelectedLanguage(page) {
  return page.evaluate((inputSelector) => {
    const input = document.querySelector(inputSelector);
    if (!input) return '';

    const selectRoot = input.closest('[class*="select"]') || input.parentElement;
    const text = (selectRoot?.innerText || '').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();

    if (lower.includes('javascript')) return 'javascript';
    if (/(^|\b)java(\b|$)/.test(lower)) return 'java';
    return '';
  }, SEL.problemLanguageInput).catch(() => '');
}

async function getCurrentSelectedLanguageLabel(page) {
  return page.evaluate((inputSelector) => {
    const input = document.querySelector(inputSelector);
    if (!input) return '';
    const selectRoot = input.closest('[class*="select"]') || input.parentElement;
    return (selectRoot?.innerText || '').replace(/\s+/g, ' ').trim();
  }, SEL.problemLanguageInput).catch(() => '');
}

async function selectProblemLanguage(page, targetLanguage) {
  const languageInput = page.locator(SEL.problemLanguageInput).first();
  if ((await languageInput.count()) === 0) {
    return false;
  }

  const target = normalizeLanguageName(targetLanguage);
  if (!target) return false;

  const current = await getCurrentSelectedLanguage(page);
  if (current === target) {
    return true;
  }

  const desired = /java/i.test(targetLanguage) ? 'Java Array' : targetLanguage;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await languageInput.click({ force: true }).catch(() => {});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.type(desired, { delay: 15 }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    if (/java/i.test(targetLanguage)) {
      await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(300);
    const updated = await getCurrentSelectedLanguage(page);
    if (updated === target) {
      return true;
    }
  }

  return (await getCurrentSelectedLanguage(page)) === target;
}

async function extractProblemContent(page) {
  const title = normalizeProblemTitle(await page.title());
  const rawBody = await page.locator('body').innerText().catch(() => '');

  let body = rawBody || '';
  const start = body.search(/problem\s+description/i);
  if (start !== -1) {
    body = body.slice(start);
  }

  const endMarkers = [
    /expected\s+output/i,
    /test\s+output/i,
    /enter\s+input\s+here/i,
    /all\s+subjects\s+and\s+classes/i,
    /refer\s+friends/i
  ];

  let cutAt = body.length;
  for (const marker of endMarkers) {
    const match = marker.exec(body);
    if (match && typeof match.index === 'number') {
      cutAt = Math.min(cutAt, match.index);
    }
  }

  body = body.slice(0, cutAt).trim();
  body = body.replace(/\n{3,}/g, '\n\n').slice(0, 12000);

  return { title, body };
}

function extractTestCases(body) {
  if (!body) return '';
  const match = body.match(/(?:sample|example)\s*(?:input|test\s*case)s?[\s\S]*$/i);
  return match ? match[0].slice(0, 4000) : '';
}

async function extractEditorStarterCode(page) {
  const monacoValue = await page.evaluate(() => {
    if (window.monaco?.editor?.getModels) {
      const models = window.monaco.editor.getModels();
      if (models && models.length > 0) {
        return models[0].getValue() || '';
      }
    }
    return '';
  }).catch(() => '');

  if (monacoValue && monacoValue.trim()) {
    return monacoValue;
  }

  const textareaValue = await page.locator(SEL.editorInput).first().inputValue().catch(() => '');
  return textareaValue || '';
}

async function collectAssignmentProblems(page) {
  return page.$$eval('tr.table__row', (rows) =>
    rows
      .map((row) => {
        const nameLink = row.querySelector('a.me-cr-classroom-url.me-cr-problem-list__name[href*="/assignment/problems/"]');
        const solveLink = row.querySelector('a.me-cr-classroom-url.me-cr-problem-actions__btn[href*="/assignment/problems/"]');

        if (!nameLink || !solveLink) {
          return null;
        }

        const title = (nameLink.textContent || '').trim();
        const statusText = (row.innerText || '').trim().replace(/\s+/g, ' ');

        return {
          title,
          solveUrl: solveLink.getAttribute('href') || '',
          statusText,
        };
      })
      .filter(Boolean)
  );
}

async function collectQuestionTabs(page) {
  return page.$$eval('a.cr-p-navigation-dock-item.me-cr-p-nav-dock-item[href*="/assignment/problems/"]', (tabs) =>
    tabs
      .map((tab) => {
        const text = (tab.textContent || '').trim().replace(/\s+/g, ' ');
        const href = tab.getAttribute('href') || '';

        if (!href || !/^Q\s*\d+/i.test(text)) {
          return null;
        }

        return {
          title: text,
          solveUrl: href,
        };
      })
      .filter(Boolean)
  );
}

async function getProblemSolveState(page) {
  return page.evaluate(() => {
    const headingEl = document.querySelector('.cr-p-heading .status-tag-2, .cr-p-heading [class*="status"]');
    if (headingEl) {
      const text = (headingEl.textContent || '').trim().toLowerCase();
      if (text.includes('solved') && !text.includes('unsolved')) return 'solved';
      if (text.includes('unsolved')) return 'unsolved';
      if (text.includes('attempted')) return 'attempted';
    }
    const hasSolvedBadge = document.querySelector('.cr-p-heading .status-tag-2--success') != null;
    if (hasSolvedBadge) return 'solved';
    return 'unsolved';
  }).catch(() => 'unknown');
}

function buildProblemsUrl(assignmentUrl) {
  const url = new URL(assignmentUrl);
  url.pathname = url.pathname.replace(/\/assignment\/?$/i, '/assignment/problems');
  if (!url.searchParams.has('navref')) {
    url.searchParams.set('navref', 'cl_tt_nv');
  }
  return url.toString();
}

async function safeGoto(page, url, options = {}) {
  const opts = {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
    ...options
  };
  try {
    return await page.goto(url, opts);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.message?.includes('Timeout') || err.message?.includes('timeout')) {
      console.log(`Navigation to ${url.slice(0, 60)} timed out. Retrying with commit...`);
      return await page.goto(url, { ...opts, waitUntil: 'commit', timeout: 45000 });
    }
    throw err;
  }
}

function isLoginUrl(url) {
  return /\/(login|sign_in)\b/i.test(url || '');
}

async function ensureLoggedIn(page, ctx, reason = 'session check') {
  if (!isLoginUrl(page.url())) {
    return;
  }
  console.log(`Session expired (${reason}). Re-authenticating...`);
  await loginToScaler(page);
  await ctx.storageState({ path: 'session.json' }).catch(() => {});
}

async function detectProblemType(page) {
  // Wait briefly for React problem controls to mount
  await page.waitForFunction(() => {
    const isMcq = document.querySelectorAll('.cr-multiple-choice, input[type="radio"], input[type="checkbox"]').length > 0;
    const hasMonaco = document.querySelector('.monaco-editor') != null;
    const btns = Array.from(document.querySelectorAll('button, a'));
    const hasLauncher = btns.some(b => (b.innerText || '').match(/open ide|launch lab|launch|vs\s*code/i));
    return isMcq || hasMonaco || hasLauncher;
  }, { timeout: 5000 }).catch(() => {});

  const isMcq = (await page.locator('.cr-multiple-choice, input[type="radio"], input[type="checkbox"]').count()) > 0;
  if (isMcq) return 'mcq';

  // Check for VS Code IDE (open IDE button without Maxwell/terminal markers)
  const isVSCode = await page.evaluate(() => {
    if (document.querySelector('#vscode-ide, .EditorLayout-module_container__Uxq1a, .code-editor-layer')) return true;
    const btns = Array.from(document.querySelectorAll('button, a, span, div'));
    return btns.some(b => (b.innerText || '').trim().match(/^open\s*ide$|vs\s*code/i));
  }).catch(() => false);
  if (isVSCode) return 'vscode';

  // Check for Maxwell terminal labs (Launch Lab button or maxwell iframe)
  const isLab = await page.evaluate(() => {
    if (document.querySelector('iframe[src*="maxwell"], iframe[allow*="clipboard-read"]')) return true;
    if (document.querySelector('.LaunchButton-module_btn__o1LoJ')) return true;
    const btns = Array.from(document.querySelectorAll('button, a, span, div'));
    return btns.some(b => (b.innerText || '').trim().match(/^launch\s*(lab)?$/i));
  }).catch(() => false);
  if (isLab) return 'lab';

  return 'coding';
}

async function run() {
  const runState = makeRunState();
  const metrics = createRunMetrics();
  const userDataDir = path.join(process.cwd(), 'temp_chrome_profile');
  const profileName = 'Profile 3';

  if (!fs.existsSync(userDataDir)) {
    console.error("temp_chrome_profile not found. Please run 'npm run auth' first.");
    process.exit(1);
  }

  console.log(`Launching Chrome with high-speed Page Pool (${SOLVE_CONCURRENCY} workers)... Mode: ${DRY_RUN ? 'dry-run' : 'submit'}${ONLY_MCQ ? ' [ONLY-MCQ]' : ''}${SKIP_LABS ? ' [SKIP-LABS]' : ''}`);

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

  const log = [];

  try {
    const mainPage = ctx.pages()[0] || await ctx.newPage();

    console.log('Checking session on curriculum dashboard...');
    await safeGoto(mainPage, normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'));
    await ensureLoggedIn(mainPage, ctx, 'initial dashboard open');

    const queue = await getQueue(mainPage);
    let filteredQueue = queue.filter(({ classUrl }) => !runState.completedClasses.has(classUrl));
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

      metrics.classesSeen += 1;
      console.log(`\n============================================================`);
      console.log(`Processing class: ${classUrl}\nPending: ${pending}\nSubject: ${subject}`);
      console.log(`============================================================`);

      await safeGoto(mainPage, classUrl);
      await ensureLoggedIn(mainPage, ctx, 'class navigation');

      const assignmentTab = mainPage.locator(SEL.assignmentTab).first();
      await assignmentTab.waitFor({ state: 'visible', timeout: 10000 }).catch(() => console.log("Failed to find 'Assignment' tab."));

      let assignmentUrl = normalizeScalerUrl(`${classUrl}/assignment?navref=cl_tb_br`);
      const assignmentHref = await assignmentTab.getAttribute('href').catch(() => null);
      if (assignmentHref) {
        assignmentUrl = normalizeScalerUrl(assignmentHref.startsWith('http') ? assignmentHref : `https://www.scaler.com${assignmentHref}`);
      } else {
        await assignmentTab.click().catch(() => {});
      }

      const problemsUrl = buildProblemsUrl(assignmentUrl);
      await safeGoto(mainPage, problemsUrl);
      await ensureLoggedIn(mainPage, ctx, 'assignment problems navigation');
      await mainPage.waitForSelector('tr.table__row a[href*="/assignment/problems/"], a.cr-p-navigation-dock-item[href*="/assignment/problems/"]', { timeout: 12000 }).catch(() => {});

      const tableProblems = await collectAssignmentProblems(mainPage);
      const questionTabs = await collectQuestionTabs(mainPage);
      const problems = tableProblems.length > 0 ? tableProblems : questionTabs;

      if (problems.length === 0) {
        console.log('No assignment problems found on this page.');
        continue;
      }

      console.log(`Found ${problems.length} assignment problem(s). Initiating Page Pool workers...`);

      // Filter unsolved
      const pendingProblems = problems.filter((p) => {
        const fullUrl = p.solveUrl.startsWith('http') ? p.solveUrl : `https://www.scaler.com${p.solveUrl}`;
        return !runState.completedProblems.has(fullUrl);
      });

      if (pendingProblems.length === 0) {
        console.log('All problems in this class are already completed from checkpoint.');
        markClassComplete(runState, classUrl);
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

      async function runWorker(page, workerId) {
        while (!globalHaltRun) {
          let problem;
          if (problemQueueIndex >= pendingProblems.length) {
            break;
          }
          problem = pendingProblems[problemQueueIndex++];

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

          const solveState = await getProblemSolveState(page);
          if (solveState === 'solved') {
            console.log(`  [Worker ${workerId}] Already solved on Scaler: ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            markProblemComplete(runState, solveUrl);
            continue;
          }

          const targetLanguage = resolveTargetLanguage(subject);
          const type = await detectProblemType(page);
          console.log(`  [Worker ${workerId}] Detected problem type: ${type} for ${problem.title}`);

          if (ONLY_MCQ && type !== 'mcq') {
            console.log(`  [Worker ${workerId}] ⏭️ Skipping non-MCQ problem (--only-mcq active): ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            continue;
          }

          if (ONLY_LABS && type !== 'lab' && type !== 'launcher' && type !== 'vscode') {
            console.log(`  [Worker ${workerId}] ⏭️ Skipping non-lab problem (--only-labs active): ${problem.title}`);
            log.push({ title: problem.title, result: 'skipped' });
            continue;
          }

          let problemContent = await extractProblemContent(page);

          if (type === 'lab' || type === 'launcher') {
            if (SKIP_LABS || ONLY_MCQ) {
              console.log(`  [Worker ${workerId}] ⏭️ Skipping terminal lab (${SKIP_LABS ? '--skip-labs' : '--only-mcq'} active): ${problem.title}`);
              log.push({ title: problem.title, result: 'skipped' });
              continue;
            }

            const release = await workspaceMutex.acquire();
            try {
              console.log(`  [Worker ${workerId}] Executing Maxwell container lab: ${problem.title}...`);
              if (DRY_RUN) {
                metrics.problemsDryRun += 1;
                log.push({ title: problem.title, result: 'dry-run' });
                console.log(`  [Worker ${workerId}] ↺ DRY-RUN Lab: ${problem.title}`);
                continue;
              }

              metrics.solveAttempts += 1;
              metrics.submitAttempts += 1;

              const labResult = await solveAndSubmitLab(
                page,
                problem.title,
                `${problemContent.title}\n\n${problemContent.body}`
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
              continue;
            }

            if (DRY_RUN) {
              metrics.problemsDryRun += 1;
              log.push({ title: problem.title, result: 'dry-run' });
              console.log(`  [Worker ${workerId}] ↺ DRY-RUN VS Code IDE: ${problem.title}`);
              continue;
            }

            const release = await workspaceMutex.acquire();
            try {
              console.log(`  [Worker ${workerId}] Solving VS Code IDE problem: ${problem.title}...`);
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

              await injectWorkspaceContext(page, wsResult.fileMap);
              metrics.submitAttempts += 1;

              // Click Run/Submit if available
              const submitBtn = page.locator(SEL.submitBtn).first();
              if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await submitBtn.click().catch(() => {});
                const verdict = await page.waitForFunction(() => {
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
              continue;
            }
            problemContent = await slurpMCQContext(page);
            console.log(`  [Worker ${workerId}] Solving MCQ: ${problem.title}`);
            const mcqResult = await solveMCQ(problemContent);

            if (DRY_RUN) {
              metrics.problemsDryRun += 1;
              log.push({ title: problem.title, result: 'dry-run' });
              console.log(`  [Worker ${workerId}] ↺ DRY-RUN MCQ Option: ${mcqResult.bestOptionIndex + 1}`);
              continue;
            }

            metrics.submitAttempts += 1;
            const mcqInjectResult = await injectMCQAnswer(page, mcqResult.bestOptionIndex || 0);
            log.push({ title: problem.title, result: mcqInjectResult.status });

            if (mcqInjectResult.status === 'pass') {
              metrics.problemsSolved += 1;
              console.log(`  [Worker ${workerId}] ✓ MCQ Passed: ${problem.title}`);
              markProblemComplete(runState, solveUrl);
            } else {
              metrics.problemsFailed += 1;
              classAllPassed = false;
              console.log(`  [Worker ${workerId}] ✗ MCQ ${mcqInjectResult.verdict}: ${problem.title}`);
            }
            continue;
          }

          // Coding problem
          await selectProblemLanguage(page, targetLanguage);
          const selectedLanguageLabel = await getCurrentSelectedLanguageLabel(page);
          const starterCode = await extractEditorStarterCode(page);

          let result = 'fail';
          let failureFeedback = '';

          for (let attempt = 1; attempt <= 3; attempt++) {
            if (globalHaltRun) break;

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

            metrics.submitAttempts += 1;
            const submitResult = await injectAndSubmit(page, code);
            result = submitResult.status;

            if (result === 'pass') {
              metrics.problemsSolved += 1;
              console.log(`  [Worker ${workerId}] ✓ Passed! Verdict: ${submitResult.verdict}`);
              break;
            }

            failureFeedback = submitResult.feedback || submitResult.verdict || 'Submission failed.';
            console.log(`  [Worker ${workerId}] Attempt ${attempt} failed: ${failureFeedback.slice(0, 160)}...`);
            await DELAY(500);
          }

          if (!['pass', 'dry-run'].includes(result)) {
            metrics.problemsFailed += 1;
            classAllPassed = false;
          }

          log.push({ title: problem.title, result });
          const mark = result === 'pass' ? '✓' : (result === 'dry-run' ? '↺' : '✗');
          console.log(`  [Worker ${workerId}] ${mark} ${problem.title}`);

          if (result === 'pass') {
            markProblemComplete(runState, solveUrl);
          }
        }
      }

      // Execute all workers concurrently
      const workers = workerPages.map((workerPage, i) => runWorker(workerPage, i));
      await Promise.all(workers);

      // Close extra worker pages to release memory, keeping mainPage
      for (let i = 1; i < workerPages.length; i++) {
        await workerPages[i].close().catch(() => {});
      }

      if (!DRY_RUN && classAllPassed && pendingProblems.length > 0 && !globalHaltRun) {
        console.log(`✓ All problems passed for class: ${classUrl}. Marking class complete!`);
        markClassComplete(runState, classUrl);
      } else if (DRY_RUN && classAllPassed && pendingProblems.length > 0) {
        console.log(`↺ Dry-run preview completed for class: ${classUrl}`);
      }
    }
  } finally {
    try {
      fs.writeFileSync('run-log.json', JSON.stringify(log, null, 2));
    } catch {}

    if (globalHaltRun) {
      console.log(`\nStopped: ${globalHaltReason}`);
    }

    printRunSummary(metrics, log);
    console.log(`\nDone. ${log.filter(l => l.result === 'pass').length}/${log.length} passed. Run log saved to run-log.json.`);
    await ctx.close().catch(() => {});
  }
}

run().catch(console.error);
