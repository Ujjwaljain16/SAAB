import 'dotenv/config';
import { chromium } from 'playwright';
import { getQueue } from './crawler.js';
import { solve } from './solver.js';
import { injectAndSubmit } from './injector.js';
import { SEL } from './config.js';
import { normalizeScalerUrl } from './scaler_url.js';
import { loginToScaler } from './scaler_login.js';
import fs from 'fs';
import path from 'path';

const DELAY = (ms) => new Promise(r => setTimeout(r, ms));

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

async function selectProblemLanguage(page, targetLanguage) {
  const languageInput = page.locator(SEL.problemLanguageInput).first();

  if ((await languageInput.count()) === 0) {
    return false;
  }

  const target = normalizeLanguageName(targetLanguage);
  if (!target) return false;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const current = await getCurrentSelectedLanguage(page);
    if (current === target) {
      return true;
    }

    await languageInput.click({ force: true }).catch(() => {});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.type(targetLanguage, { delay: 35 }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
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

function hasBalancedBrackets(code) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closing = new Set(Object.values(pairs));
  const stack = [];

  for (const ch of code || '') {
    if (pairs[ch]) {
      stack.push(pairs[ch]);
      continue;
    }
    if (closing.has(ch)) {
      if (stack.pop() !== ch) return false;
    }
  }

  return stack.length === 0;
}

function looksTruncated(code) {
  const trimmed = (code || '').trim();
  if (!trimmed) return true;
  if (!hasBalancedBrackets(trimmed)) return true;
  if (!/[;})\]]$/.test(trimmed)) return true;

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : '';
  if (/\.[A-Za-z_][A-Za-z0-9_]*$/.test(lastLine)) return true;

  return false;
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
  const userDataDir = path.join(process.cwd(), 'temp_chrome_profile');
  const profileName = 'Profile 3';

  if (!fs.existsSync(userDataDir)) {
    console.error("temp_chrome_profile not found. Please run 'npm run auth' first.");
    process.exit(1);
  }

  console.log('Launching Chrome with saved Scaler session...');

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
  const page = ctx.pages()[0] || await ctx.newPage();

  // Quick check if we are actually logged in on the curriculum page
  await page.goto(normalizeScalerUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'), { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page, ctx, 'initial dashboard open');

  const queue = await getQueue(page);
  if (queue.length === 0) {
    console.log("No pending questions found. Exiting.");
    await ctx.close();
    return;
  }

  const log = [];
  let haltRun = false;
  let haltReason = '';

  for (const { classUrl, pending, subject } of queue) {
    console.log(`Navigating to class: ${classUrl} \nPending: ${pending}`);
    await page.goto(classUrl);
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

    for (const problem of problems) {
      const solveUrl = problem.solveUrl.startsWith('http') ? problem.solveUrl : `https://www.scaler.com${problem.solveUrl}`;
      console.log(`\n  Solving: ${problem.title}`);
      await page.goto(normalizeScalerUrl(solveUrl), { waitUntil: 'domcontentloaded' });
      await ensureLoggedIn(page, ctx, 'problem page navigation');
      await page.waitForTimeout(2500);

      const solveState = await getProblemSolveState(page);
      if (solveState === 'solved') {
        console.log(`    Already solved. Skipping.`);
        log.push({ title: problem.title, result: 'skipped' });
        await page.goto(normalizeScalerUrl(problemsUrl), { waitUntil: 'domcontentloaded' });
        await ensureLoggedIn(page, ctx, 'return to assignment problems');
        await page.waitForTimeout(1200);
        continue;
      }

      const targetLanguage = resolveTargetLanguage(subject);
      const languageSet = await selectProblemLanguage(page, targetLanguage);
      if (!languageSet) {
        console.log(`    Warning: could not confirm language switch to ${targetLanguage}.`);
      }

      const problemContent = await extractProblemContent(page);

      console.log(`    Language: ${targetLanguage}`);

      let result = 'fail';
      let failureFeedback = '';
      // Retry loop as per architecture
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`    Attempt ${attempt}...`);
        const starterCode = await extractEditorStarterCode(page);
        const solveResult = await solve(`${problemContent.title}\n\n${problemContent.body}`, '', targetLanguage, {
          starterCode,
          previousFeedback: failureFeedback,
          attempt
        });

        if (!solveResult?.ok) {
          if (solveResult?.type === 'rate_limit') {
            const waitSec = Number(solveResult.retryAfterSeconds || 5);

            if (solveResult.fatal) {
              result = 'quota_exhausted';
              haltRun = true;
              haltReason = `Gemini daily quota exhausted. Retry after reset. ${solveResult.message || ''}`;
              console.log(`    Quota exhausted for the day. Stopping run.`);
              break;
            }

            console.log(`    Gemini rate-limited. Waiting ${waitSec}s before retry...`);
            await DELAY((waitSec + 1) * 1000);
            attempt -= 1;
            continue;
          }

          console.log(`    Solver failed: ${solveResult?.message || 'Unknown solver error'}`);
          break;
        }

        const code = solveResult.code;

        if (looksTruncated(code)) {
          failureFeedback = 'Generated code appears truncated/incomplete. Regenerate full compilable code preserving starter scaffold.';
          console.log('    Generated code appears incomplete locally, retrying without submit...');
          await DELAY(1200);
          continue;
        }

        const submitResult = await injectAndSubmit(page, code);
        result = submitResult.status;
        
        if (result === 'pass') {
          console.log(`    Test Passed! Verdict: ${submitResult.verdict}`);
          break;
        }

        failureFeedback = submitResult.feedback || submitResult.verdict || 'Submission failed.';
        
        console.log(`    Attempt ${attempt} ${result}. Feedback: ${failureFeedback.slice(0, 180)}...`);
        await DELAY(2000);
      }

      log.push({ title: problem.title, result });
      console.log(`  ${result === 'pass' ? '✓' : '✗'} ${problem.title}`);

      if (haltRun) {
        break;
      }

      await DELAY(2000); // human-like pause between questions

      await page.goto(normalizeScalerUrl(problemsUrl), { waitUntil: 'domcontentloaded' });
      await ensureLoggedIn(page, ctx, 'post-problem return');
      await page.waitForTimeout(1500);
    }

    if (haltRun) {
      break;
    }
  }

  fs.writeFileSync('run-log.json', JSON.stringify(log, null, 2));
  if (haltRun) {
    console.log(`\nStopped early: ${haltReason}`);
  }
  console.log(`\nDone. ${log.filter(l => l.result==='pass').length}/${log.length} passed. Run log saved to run-log.json.`);
  await ctx.close();
}

run().catch(console.error);
