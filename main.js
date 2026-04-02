import 'dotenv/config';
import { chromium } from 'playwright';
import { getQueue } from './crawler.js';
import { solve, solverStats, looksTruncated } from './solver.js';
import { injectAndSubmit } from './injector.js';
import { SEL } from './config.js';
import { normalizeScalerUrl } from './scaler_url.js';
import { loginToScaler } from './scaler_login.js';
import fs from 'fs';
import path from 'path';

const DELAY = (ms) => new Promise(r => setTimeout(r, ms));
const DRY_RUN = process.argv.includes('--dry-run') && !process.argv.includes('--submit');
const CLASS_FILTER = process.argv.find(a => a.startsWith('--class='))?.split('=')[1] || '';
const RUN_STATE_PATH = path.join(process.cwd(), 'run-state.json');
const SOLVE_CONCURRENCY = Math.max(1, Number(process.env.SOLVE_CONCURRENCY || 4));

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
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    completedClasses: state.completedClasses,
    completedProblems: state.completedProblems
  };

  fs.writeFileSync(RUN_STATE_PATH, JSON.stringify(payload, null, 2));
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

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
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
    const text = (selectRoot?.innerText || '').replace(/\s+/g, ' ').trim();
    return text;
  }, SEL.problemLanguageInput).catch(() => '');
}

async function selectProblemLanguage(page, targetLanguage) {
  const languageInput = page.locator(SEL.problemLanguageInput).first();

  if ((await languageInput.count()) === 0) {
    return false;
  }

  const target = normalizeLanguageName(targetLanguage);
  if (!target) return false;

  const desired = /java/i.test(targetLanguage) ? 'Java Array' : targetLanguage;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const current = await getCurrentSelectedLanguage(page);
    if (current === target) {
      return true;
    }

    await languageInput.click({ force: true }).catch(() => {});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.type(desired, { delay: 30 }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    if (/java/i.test(targetLanguage)) {
      // One extra Enter helps pick first Java variant option when dropdown has multiple Java runtimes.
      await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(900);
  }

  return (await getCurrentSelectedLanguage(page)) === target;
}

async function extractProblemContent(page) {
  const title = normalizeProblemTitle(await page.title());
  const rawBody = await page.locator('body').innerText();

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

  return {
    title,
    body,
  };
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
        const value = models[0].getValue();
        return value || '';
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
  const state = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('span,div,p,strong'))
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean);

    const hasUnsolved = candidates.some((t) => /^unsolved$/i.test(t));
    const hasSolved = candidates.some((t) => /^solved$/i.test(t));

    if (hasUnsolved) return 'unsolved';
    if (hasSolved) return 'solved';
    return 'unknown';
  }).catch(() => 'unknown');

  return state;
}

function buildProblemsUrl(assignmentUrl) {
  const url = new URL(assignmentUrl);
  url.pathname = url.pathname.replace(/\/assignment\/?$/i, '/assignment/problems');

  if (!url.searchParams.has('navref')) {
    url.searchParams.set('navref', 'cl_tt_nv');
  }

  return url.toString();
}

function isLoginUrl(url) {
  return /\/login\b/i.test(url || '');
}

async function ensureLoggedIn(page, ctx, reason = 'session check') {
  if (!isLoginUrl(page.url())) {
    return;
  }

  console.log(`Session expired (${reason}). Re-authenticating...`);
  await loginToScaler(page);
  await ctx.storageState({ path: 'session.json' }).catch(() => {});
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

  console.log(`Launching Chrome with saved Scaler session... Mode: ${DRY_RUN ? 'dry-run' : 'submit'}`);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome', 
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
  const log = [];
  try {
  const page = ctx.pages()[0] || await ctx.newPage();

  // Quick check if we are actually logged in on the curriculum page
  await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'), { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page, ctx, 'initial dashboard open');

  const queue = await getQueue(page);
  let filteredQueue = queue.filter(({ classUrl }) => !runState.completedClasses.has(classUrl));
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


  let haltRun = false;
  let haltReason = '';

  for (const { classUrl, pending, subject } of filteredQueue) {
    metrics.classesSeen += 1;
    console.log(`Navigating to class: ${classUrl} \nPending: ${pending}`);
    await page.goto(classUrl, { waitUntil: 'domcontentloaded' });
    await ensureLoggedIn(page, ctx, 'class navigation');
    
    // Switch to the assignment page using the real tab link Scaler renders.
    const assignmentTab = page.locator(SEL.assignmentTab).first();
    await assignmentTab.waitFor({ state: 'visible', timeout: 15000 }).catch(() => console.log("Failed to find 'Assignment' tab."));

    let assignmentUrl = normalizeScalerUrl(`${classUrl}/assignment?navref=cl_tb_br`);
    const assignmentHref = await assignmentTab.getAttribute('href').catch(() => null);
    if (assignmentHref) {
      assignmentUrl = normalizeScalerUrl(assignmentHref.startsWith('http') ? assignmentHref : `https://www.scaler.com${assignmentHref}`);
    } else {
      await assignmentTab.click().catch(() => {});
    }

    const problemsUrl = buildProblemsUrl(assignmentUrl);
    await page.goto(problemsUrl, { waitUntil: 'domcontentloaded' });
    await ensureLoggedIn(page, ctx, 'assignment problems navigation');
    await page.waitForSelector('tr.table__row a.me-cr-classroom-url.me-cr-problem-actions__btn[href*="/assignment/problems/"]', { timeout: 15000 }).catch(() => console.log('Problem rows not ready yet.'));

    const questionTabs = await collectQuestionTabs(page);
    const problems = questionTabs.length > 0 ? questionTabs : await collectAssignmentProblems(page);

    if (problems.length === 0) {
      console.log('No assignment problems found on this page.');
      continue;
    }

    const problemJobs = [];
    for (const problem of problems) {
      const solveUrl = problem.solveUrl.startsWith('http') ? problem.solveUrl : `https://www.scaler.com${problem.solveUrl}`;
      if (runState.completedProblems.has(solveUrl)) {
        console.log(`    Already completed from checkpoint: ${problem.title}`);
        log.push({ title: problem.title, result: 'skipped' });
        metrics.problemsSkipped += 1;
        continue;
      }

      console.log(`\n  Reading: ${problem.title}`);
      metrics.problemsRead += 1;
      await page.goto(normalizeScalerUrl(solveUrl), { waitUntil: 'domcontentloaded' });
      await ensureLoggedIn(page, ctx, 'problem page navigation');
      await page.waitForLoadState('networkidle').catch(() => {});

      const solveState = await getProblemSolveState(page);
      if (solveState === 'solved') {
        console.log(`    Already solved. Skipping.`);
        log.push({ title: problem.title, result: 'skipped' });
        markProblemComplete(runState, solveUrl);
        await page.goto(normalizeScalerUrl(problemsUrl), { waitUntil: 'domcontentloaded' });
        await ensureLoggedIn(page, ctx, 'return to assignment problems');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        continue;
      }

      const targetLanguage = resolveTargetLanguage(subject);
      const languageSet = await selectProblemLanguage(page, targetLanguage);
      if (!languageSet) {
        console.log(`    Warning: could not confirm language switch to ${targetLanguage}.`);
      }
      const selectedLanguageLabel = await getCurrentSelectedLanguageLabel(page);
      const problemContent = await extractProblemContent(page);
      const starterCode = await extractEditorStarterCode(page);

      problemJobs.push({
        title: problem.title,
        solveUrl,
        classUrl,
        subject,
        targetLanguage,
        selectedLanguageLabel,
        problemContent,
        starterCode
      });

      await page.goto(normalizeScalerUrl(problemsUrl), { waitUntil: 'domcontentloaded' });
      await ensureLoggedIn(page, ctx, 'post-problem return');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    const solvedJobs = await mapWithConcurrency(problemJobs, SOLVE_CONCURRENCY, async (job) => {
      console.log(`    Solving in batch: ${job.title}`);
      const solveResult = await solve(`${job.problemContent.title}\n\n${job.problemContent.body}`, extractTestCases(job.problemContent.body), job.targetLanguage, {
        starterCode: job.starterCode,
        selectedLanguageLabel: job.selectedLanguageLabel,
        previousFeedback: classifyFailureFeedback(''),
        attempt: 1
      });

      return { ...job, solveResult };
    });

    let classCompleted = true;
    for (const job of solvedJobs) {
      if (!job || haltRun) {
        break;
      }

      const { title, solveUrl, targetLanguage, selectedLanguageLabel, solveResult } = job;
      console.log(`\n  Solving: ${title}`);
      metrics.solveAttempts += 1;

      if (!solveResult?.ok) {
        if (solveResult?.type === 'rate_limit') {
          const waitSec = Number(solveResult.retryAfterSeconds || 5);
          if (solveResult.fatal) {
            classCompleted = false;
            haltRun = true;
            haltReason = `Provider quota exhausted. Retry after reset. ${solveResult.message || ''}`;
            console.log(`    Quota exhausted for the day. Stopping run.`);
            break;
          }

          console.log(`    Provider rate-limited. Waiting ${waitSec}s before continue...`);
          await DELAY((waitSec + 1) * 1000);
        }

        log.push({ title, result: 'fail' });
        classCompleted = false;
        continue;
      }

      let result = 'fail';
      let failureFeedback = '';

      await page.goto(normalizeScalerUrl(solveUrl), { waitUntil: 'domcontentloaded' });
      await ensureLoggedIn(page, ctx, 'problem page navigation');
      await page.waitForLoadState('networkidle').catch(() => {});

      const languageSet = await selectProblemLanguage(page, targetLanguage);
      if (!languageSet) {
        console.log(`    Warning: could not confirm language switch to ${targetLanguage}.`);
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        const code = attempt === 1
          ? solveResult.code
          : (await solve(`${job.problemContent.title}\n\n${job.problemContent.body}`, '', targetLanguage, {
              starterCode: job.starterCode,
              selectedLanguageLabel,
              previousFeedback: classifyFailureFeedback(failureFeedback),
              attempt
            })).code;

        if (!code || looksTruncated(code)) {
          failureFeedback = 'Generated code appears truncated/incomplete. Regenerate full compilable code preserving starter scaffold.';
          console.log('    Generated code appears incomplete locally, retrying without submit...');
          classCompleted = false;
          await DELAY(900);
          continue;
        }

        if (DRY_RUN) {
          result = 'dry-run';
          metrics.problemsDryRun += 1;
          console.log(`    Dry run code preview:\n${previewCode(code)}\n`);
          break;
        }

        metrics.submitAttempts += 1;
        const submitResult = await injectAndSubmit(page, code);
        result = submitResult.status;

        if (result === 'pass') {
          metrics.problemsSolved += 1;
          console.log(`    Test Passed! Verdict: ${submitResult.verdict}`);
          break;
        }

        failureFeedback = submitResult.feedback || submitResult.verdict || 'Submission failed.';
        console.log(`    Attempt ${attempt} ${result}. Feedback: ${failureFeedback.slice(0, 180)}...`);
        classCompleted = false;
        await DELAY(1500);
      }

      if (!['pass', 'dry-run'].includes(result)) {
        metrics.problemsFailed += 1;
      }

      log.push({ title, result });
      const statusMark = result === 'pass' ? '✓' : (result === 'dry-run' ? '↺' : '✗');
      console.log(`  ${statusMark} ${title}`);

      if (result === 'pass') {
        markProblemComplete(runState, solveUrl);
      }

      if (haltRun) {
        break;
      }
    }

    if (classCompleted && problemJobs.length > 0) {
      markClassComplete(runState, classUrl);
    }

    if (haltRun) {
      break;
    }
  }

  } finally {
    try { fs.writeFileSync('run-log.json', JSON.stringify(log, null, 2)); } catch {}
    if (haltRun) {
      console.log(`\nStopped early: ${haltReason}`);
    }
    printRunSummary(metrics, log);
    console.log(`\nDone. ${log.filter(l => l.result==='pass').length}/${log.length} passed. Run log saved to run-log.json.`);
    await ctx.close().catch(() => {});
  }
}

run().catch(console.error);
