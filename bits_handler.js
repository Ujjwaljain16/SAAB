// bits_handler.js — Solves and submits Coursera BITS Pilani assignments and exams

import { COURSERA_SEL, COURSERA_TIMEOUTS } from './bits_config.js';
import { solveMCQ, solverStats, makeMCQCacheKey, recordWrongMCQOption, commitSolution } from './solver.js';
import fs from 'fs';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Human-realistic timing: simulate reading/thinking before answering each question (3-8s)
const HUMAN_DELAY = () => DELAY(3000 + Math.floor(Math.random() * 5000));

// ---------- Run-state persistence (skip re-submitting already-passed quizzes) ----------
const RUN_STATE_PATH = 'bits-run-state.json';
function loadRunState() {
  try { return fs.existsSync(RUN_STATE_PATH) ? JSON.parse(fs.readFileSync(RUN_STATE_PATH, 'utf8')) : {}; } catch { return {}; }
}
function saveRunState(state) {
  try { fs.writeFileSync(RUN_STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
}
const _runState = loadRunState();
export function getRunState() { return _runState; }
export function markQuizPassed(url, data = {}) {
  const key = url.replace(/\/attempt\/?$/, '').replace(/\?.*$/, '');
  _runState[key] = { status: 'pass', solvedAt: new Date().toISOString(), ...data };
  saveRunState(_runState);
}
export function isQuizAlreadyPassed(url) {
  const key = url.replace(/\/attempt\/?$/, '').replace(/\?.*$/, '');
  return _runState[key]?.status === 'pass';
}

// ---------- Webhook notification (Discord or Telegram via env vars) ----------
async function sendNotification(message) {
  const discordUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  const tgToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const tgChat = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (discordUrl) {
    try { await fetch(discordUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }) }); } catch {}
  }
  if (tgToken && tgChat) {
    try { await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tgChat, text: message, parse_mode: 'Markdown' }) }); } catch {}
  }
}


/**
 * Solves a single Coursera assignment/exam/quiz attempt
 * @param {import('playwright').Page} page
 * @param {string} assignmentUrl
 * @param {Object} options
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{ status: 'pass' | 'fail' | 'dry-run' | 'skipped', reason?: string, details?: any }>}
 */
export async function solveAndSubmitCourseraAssignment(page, assignmentUrl, options = { dryRun: false }) {
  console.log(`\n============================================================`);
  console.log(`[BITS Handler] Processing Assignment: ${assignmentUrl}`);
  console.log(`[BITS Handler] Mode: ${options.dryRun ? 'DRY-RUN (Preview Only)' : 'SUBMIT (Live Solving)'}`);
  console.log(`============================================================`);

  // Safety Guard: Refuse to open Staff Graded or Peer Reviewed assignments
  if (/staff[-_ ]graded|peer[-_ ]graded|peer[-_ ]review/i.test(assignmentUrl)) {
    console.log(`[BITS Handler] 🚫 Safety Barrier: Staff/Peer graded assignment detected in URL.`);
    console.log(`[BITS Handler] Refusing to navigate or open "${assignmentUrl}". Skipping entirely.`);
    return { status: 'skipped', reason: 'Staff/Peer graded assignment (manual evaluation only)' };
  }

  // Run-state Guard: Skip if already passed in a previous run (prevent burning attempts)
  if (!options.dryRun && isQuizAlreadyPassed(assignmentUrl)) {
    console.log(`[BITS Handler] ✅ Already passed in a previous run — skipping re-submission.`);
    return { status: 'skipped', reason: 'Already passed in previous run (run-state cache)' };
  }

  // Prepare navigation URL
  let targetUrl = assignmentUrl;
  if (targetUrl.includes('/assignment-submission/') && !targetUrl.includes('/attempt')) {
    targetUrl = targetUrl.replace(/\/+$/, '') + '/attempt';
  }

  console.log(`[BITS Handler] Navigating to: ${targetUrl}`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
    await page.waitForLoadState('networkidle').catch(() => {});
    await DELAY(2500);
  } catch (navErr) {
    console.log(`[BITS Handler] Navigation retry for ${targetUrl}: ${navErr.message}`);
    await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    await DELAY(2000);
  }

  // ---- SESSION GUARD: Detect redirect to Coursera login / Google SSO ----
  const landedUrl = page.url();
  const isLoginRedirect = landedUrl.includes('accounts.google.com') ||
                          landedUrl.includes('accounts.coursera.org') ||
                          landedUrl.includes('coursera.org/?authMode=login') ||
                          landedUrl.includes('/login');
  if (isLoginRedirect) {
    console.error(`[BITS Handler] 🔐 Session expired! Landed on login page: ${landedUrl}`);
    console.log(`[BITS Handler] Attempting re-auth and retry...`);
    // Attempt to re-auth by going to degree home (triggers ensureCourseraLoggedIn)
    const { ensureCourseraLoggedIn } = await import('./bits_crawler.js');
    await page.goto('https://www.coursera.org', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await ensureCourseraLoggedIn(page).catch(() => {});
    // Retry once
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await DELAY(2500);
    const retryUrl = page.url();
    if (retryUrl.includes('accounts.') || retryUrl.includes('/login')) {
      await sendNotification(`🔐 *BITS Bot* — Session expired on "${assignmentUrl}". Re-auth failed. Manual login required.`);
      return { status: 'fail', reason: 'Session expired — re-auth failed' };
    }
    console.log(`[BITS Handler] ✓ Re-auth successful, continuing on: ${retryUrl}`);
  }

  // Fast Initial Check: Is this assignment locked / not live yet / unavailable?
  const initialLock = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const isLockedPattern = /this item will be available|will be available\s+[A-Za-z]+|not available yet|locked until|locked assignment/i;
    if (!isLockedPattern.test(text)) return null;

    const match = text.match(/This item will be available[^\.\n]+/i) ||
                  text.match(/will be available[^\.\n]+/i) ||
                  text.match(/locked until[^\.\n]+/i) ||
                  text.match(/not available yet[^\.\n]+/i);
    return match ? match[0].trim() : 'Assignment not available yet (future date)';
  });

  if (initialLock) {
    console.log(`\n[BITS Handler] 🔒 Assignment is not live yet: "${initialLock}"`);
    return {
      status: 'skipped',
      reason: `Not live yet (${initialLock})`,
      isFutureLocked: true,
      availableDate: initialLock
    };
  }


  // Helper to detect and dismiss Coursera Honor Code / Academic Guidelines modal dialogs
  async function dismissHonorCodeModal() {
    const dialogSelectors = 'div[role="dialog"]:visible, div[aria-modal="true"]:visible, .cds-Dialog-dialog:visible';
    for (let attempt = 0; attempt < 3; attempt++) {
      const dialog = page.locator(dialogSelectors).first();
      const isVisible = await dialog.isVisible({ timeout: 1500 }).catch(() => false);
      if (!isVisible) break;

      console.log(`[BITS Handler] Modal dialog detected on page.`);

      // 1. If there's an unchecked agreement checkbox inside the modal, check it
      const modalCheckbox = dialog.locator('input[type="checkbox"]').first();
      if (await modalCheckbox.isVisible({ timeout: 600 }).catch(() => false)) {
        const isChecked = await modalCheckbox.isChecked().catch(() => true);
        if (!isChecked) {
          console.log(`[BITS Handler] Checking dialog agreement checkbox...`);
          await modalCheckbox.check({ force: true }).catch(() => {});
          await DELAY(400);
        }
      }

      // 2. Click the confirmation / continue / start button in the modal
      const modalBtnSelectors = [
        'button[data-testid="continue-button"]',
        'button[data-action="acknowledge-guidelines"]',
        'button:has-text("Continue")',
        'button:has-text("Start assignment")',
        'button:has-text("Start attempt")',
        'button:has-text("Start quiz")',
        'button:has-text("Start")',
        'button:has-text("I understand")',
        'button:has-text("I agree")',
        'button:has-text("Accept")',
        COURSERA_SEL.honorCodeModalContinueBtn,
        COURSERA_SEL.guidelinesAckBtn
      ].join(', ');

      const confirmBtn = dialog.locator(modalBtnSelectors).first();
      if (await confirmBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
        const txt = (await confirmBtn.innerText().catch(() => '')).trim();
        console.log(`[BITS Handler] Clicking dialog action button: "${txt}"...`);
        await confirmBtn.click({ force: true }).catch(() => {});
        await DELAY(2000);
        await page.waitForLoadState('networkidle').catch(() => {});
      } else {
        break;
      }
    }
  }

  // Check for Honor Code modal immediately upon page entry
  await dismissHonorCodeModal();

  // 1. Check if questions are already present or if we need to enter from Cover Page
  console.log(`[BITS Handler] Checking page state (Cover page vs Attempt view)...`);
  await page.waitForSelector([
    COURSERA_SEL.questionContainer,
    COURSERA_SEL.coverContainer,
    'button[data-testid="CoverPageActionButton"]',
    'button[data-e2e="CoverPageActionButton"]',
    'button[aria-label="Start assignment"]',
    'button[aria-label="Resume assignment"]'
  ].join(', '), { timeout: 12000 }).catch(() => {});

  await dismissHonorCodeModal();

  let hasQuestionsOnPage = await page.evaluate((sel) => {
    return document.querySelectorAll(sel.questionContainer).length > 0 ||
           document.querySelectorAll(sel.optionContainer).length > 0;
  }, COURSERA_SEL);

  // If questions are NOT yet present, find and click the Cover Page action button
  if (!hasQuestionsOnPage) {
    // Strictly search inside the Cover Page container first
    const coverContainer = page.locator('[data-testid="rc-CoverPageContainer"], [data-testid="assignment-cover-redesign"], .rc-CoverPageContainer').first();
    const isCoverVisible = await coverContainer.isVisible({ timeout: 4000 }).catch(() => false);

    let launchBtn = null;

    if (isCoverVisible) {
      console.log(`[BITS Handler] Assignment Cover Page container detected.`);

      // ---- ATTEMPT COUNT + CURRENT SCORE extraction ----
      const coverMeta = await coverContainer.evaluate((el) => {
        const text = el.innerText || '';
        // Attempt counter patterns: "2 of 3 attempts", "Attempt 2 of 3", "X/Y attempts"
        const attemptMatch = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*attempt/i) ||
                             text.match(/attempt\s*(\d+)\s*(?:of|\/)\s*(\d+)/i);
        const attemptsUsed = attemptMatch ? parseInt(attemptMatch[1], 10) : null;
        const attemptsTotal = attemptMatch ? parseInt(attemptMatch[2], 10) : null;

        // Grade detection: look for actual student grade, NEVER match the passing requirement threshold "80% or higher to pass"
        const gradeMatch = text.match(/(?:your\s+)?grade[:\s]*(\d+(?:\.\d+)?)\s*%(?!\s*(?:or higher|to pass))/i) ||
                           text.match(/grade[:\s]*(\d+(?:\.\d+)?)(?!\s*(?:or higher|to pass|\s*points?))/i) ||
                           text.match(/(\d+(?:\.\d+)?)\s*\/\s*100/i);
        const currentGrade = gradeMatch ? Math.round(parseFloat(gradeMatch[1])) : null;
        return { attemptsUsed, attemptsTotal, currentGrade, rawText: text.slice(0, 400) };
      }).catch(() => ({ attemptsUsed: null, attemptsTotal: null, currentGrade: null }));

      const { attemptsUsed, attemptsTotal, currentGrade } = coverMeta;
      const attemptsRemaining = (attemptsTotal != null && attemptsUsed != null) ? attemptsTotal - attemptsUsed : null;

      if (attemptsUsed !== null) {
        console.log(`[BITS Handler] 📊 Attempts: ${attemptsUsed}/${attemptsTotal} used (${attemptsRemaining} remaining)`);
      }
      if (currentGrade !== null) {
        console.log(`[BITS Handler] 📊 Current grade on record: ${currentGrade}%`);
      }

      // If already passing (>= 80%) and not in dry-run, skip re-submission
      if (!options.dryRun && currentGrade !== null && currentGrade >= 80) {
        console.log(`[BITS Handler] ✅ Already passing with ${currentGrade}% — no re-submission needed.`);
        markQuizPassed(assignmentUrl, { grade: currentGrade });
        return { status: 'skipped', reason: `Already passing (${currentGrade}% >= 80%)`, grade: currentGrade };
      }

      // If 0 attempts remain, stop immediately
      if (!options.dryRun && attemptsRemaining !== null && attemptsRemaining <= 0) {
        console.log(`[BITS Handler] ⛔ No attempts remaining (${attemptsUsed}/${attemptsTotal}). Cannot re-attempt.`);
        await sendNotification(`⛔ *BITS Bot* — No attempts remaining for assignment. Manual review required.\nURL: ${assignmentUrl}`);
        return { status: 'skipped', reason: `No attempts remaining (${attemptsUsed}/${attemptsTotal})` };
      }

      // Last attempt warning
      if (!options.dryRun && attemptsRemaining === 1) {
        console.warn(`[BITS Handler] ⚠️ WARNING: This is the LAST attempt! (${attemptsUsed}/${attemptsTotal} used). Proceeding with elevated caution.`);
        await sendNotification(`⚠️ *BITS Bot* — LAST ATTEMPT on assignment!\nAttempts: ${attemptsUsed}/${attemptsTotal}\nURL: ${assignmentUrl}`);
      }

      // Strictly target the primary action button INSIDE the cover container
      const coverBtn = coverContainer.locator([
        'button[data-testid="CoverPageActionButton"]:visible',
        'button[data-e2e="CoverPageActionButton"]:visible',
        'a[data-testid="CoverPageActionButton"]:visible',
        'a[data-e2e="CoverPageActionButton"]:visible',
        'button[aria-label="Start assignment"]:visible',
        'button[aria-label="Resume assignment"]:visible',
        'button[aria-label*="Try again"]:visible',
        'button[aria-label*="Retake"]:visible',
        'button:has-text("Start assignment"):visible',
        'button:has-text("Resume assignment"):visible',
        'button:has-text("Try again"):visible',
        'button:has-text("Retake"):visible',
        'button:has-text("Retake assignment"):visible',
        'button:has-text("Start"):visible',
        'button:has-text("Resume"):visible',
        'a:has-text("Try again"):visible',
        'a:has-text("Retake"):visible',
        'a:has-text("Retake assignment"):visible',
        'a:has-text("Start assignment"):visible',
        'a:has-text("Resume assignment"):visible'
      ].join(', ')).first();

      if (await coverBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        launchBtn = coverBtn;
      }
    }

    // Fallback: only if no cover container was matched, check inside <main> for action buttons (NEVER in nav or header!)
    if (!launchBtn) {
      const mainBtn = page.locator([
        'main button[data-testid="CoverPageActionButton"]:visible',
        'main button[data-e2e="CoverPageActionButton"]:visible',
        'main a[data-testid="CoverPageActionButton"]:visible',
        'main a[data-e2e="CoverPageActionButton"]:visible',
        'main button[aria-label="Start assignment"]:visible',
        'main button[aria-label="Resume assignment"]:visible',
        'main button[aria-label*="Try again"]:visible',
        'main button[aria-label*="Retake"]:visible',
        'main button:has-text("Start assignment"):visible',
        'main button:has-text("Resume assignment"):visible',
        'main button:has-text("Try again"):visible',
        'main button:has-text("Retake"):visible',
        'main button:has-text("Retake assignment"):visible',
        'main a:has-text("Try again"):visible',
        'main a:has-text("Retake"):visible',
        'main a:has-text("Retake assignment"):visible'
      ].join(', ')).first();

      if (await mainBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        launchBtn = mainBtn;
      }
    }

    if (launchBtn) {
      const btnText = (await launchBtn.innerText().catch(() => '')).trim();
      const isDisabled = (await launchBtn.getAttribute('aria-disabled').catch(() => 'false')) === 'true' ||
                         (await launchBtn.getAttribute('disabled').catch(() => null)) !== null;

      if (isDisabled) {
        console.log(`[BITS Handler] ⚠️ Cover action button "${btnText}" is disabled. (0 attempts or locked).`);
        return { status: 'skipped', reason: 'Assignment start button is disabled', isFutureLocked: true };
      }

      console.log(`[BITS Handler] Launch/action element detected: "${btnText}"`);
      console.log(`[BITS Handler] Launching assignment attempt...`);

      await launchBtn.scrollIntoViewIfNeeded().catch(() => {});
      await launchBtn.click({ timeout: 5000 }).catch(async (e) => {
        console.log(`[BITS Handler] Standard click failed (${e.message}), trying force click...`);
        await launchBtn.click({ force: true }).catch(() => {});
      });

      await DELAY(2500);
      await page.waitForLoadState('networkidle').catch(() => {});

      // After clicking "Start assignment", Coursera may display a confirmation/honor modal dialog
      await dismissHonorCodeModal();
    } else {
      console.log(`[BITS Handler] No visible launch button detected inside assignment container.`);
    }
  }

  // 2. Wait for question containers to mount in Tunnel Vision view
  console.log(`[BITS Handler] Scanning for questions in Tunnel Vision view...`);
  await page.waitForSelector(COURSERA_SEL.questionContainer, { timeout: 15000 }).catch(() => {});

  hasQuestionsOnPage = await page.evaluate((sel) => {
    return document.querySelectorAll(sel.questionContainer).length > 0 ||
           document.querySelectorAll(sel.optionContainer).length > 0;
  }, COURSERA_SEL);

  if (!hasQuestionsOnPage) {
    // If modal appeared late or questions haven't finished rendering, try dismissing modal again
    await dismissHonorCodeModal();
    await DELAY(2500);
    hasQuestionsOnPage = await page.evaluate((sel) => {
      return document.querySelectorAll(sel.questionContainer).length > 0 ||
             document.querySelectorAll(sel.optionContainer).length > 0;
    }, COURSERA_SEL);
  }

  if (!hasQuestionsOnPage) {
    // Inspect the page to determine WHY there are no questions:
    const pageState = await page.evaluate((sel) => {
      const mainOrCover = document.querySelector(sel.coverContainer) || document.querySelector('main') || document.body;
      const text = (mainOrCover?.innerText || '').toLowerCase();
      const hasLockIcon = (document.querySelector(sel.coverContainer) || document.querySelector('main'))?.querySelector(sel.lockIcon) != null;
      
      const isStaffGraded = text.includes('staff graded') || text.includes('peer graded') || text.includes('submit your work') || text.includes('my submission');
      const isLocked = hasLockIcon ||
                       text.includes('locked until') ||
                       text.includes('locked assignment') ||
                       text.includes('prerequisites required') ||
                       text.includes('will be available') ||
                       text.includes('this item will be available') ||
                       text.includes('not available yet');

      const dateMatch = (mainOrCover?.innerText || '').match(/This item will be available[^\.\n]+/i) ||
                        (mainOrCover?.innerText || '').match(/will be available[^\.\n]+/i);
      const availableDate = dateMatch ? dateMatch[0].trim() : null;

      return { isStaffGraded, isLocked, availableDate };
    }, COURSERA_SEL);

    if (pageState.isStaffGraded) {
      console.log(`[BITS Handler] ℹ️ Assignment is Staff Graded or Peer Reviewed (non-MCQ). Skipping automated MCQ solving.`);
      return { status: 'skipped', reason: 'Staff/Peer graded assignment (non-MCQ)' };
    }

    if (pageState.isLocked) {
      console.log(`[BITS Handler] ⚠️ Assignment is locked or prerequisites are required. Skipping.`);
      return {
        status: 'skipped',
        reason: pageState.availableDate ? `Not live yet (${pageState.availableDate})` : 'Assignment is locked',
        isFutureLocked: true,
        availableDate: pageState.availableDate
      };
    }
  }

  const questionsData = await page.evaluate((sel) => {
    // Helper to extract clean text
    const cleanText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();

    // Find all question containers
    let containers = Array.from(document.querySelectorAll(sel.questionContainer));
    
    // Fallback: find parent containers of options if no part-Submission container was matched
    if (containers.length === 0) {
      const options = Array.from(document.querySelectorAll(sel.optionContainer));
      const parentSet = new Set();
      for (const opt of options) {
        const p = opt.closest('fieldset') || opt.closest('[role="group"]') || opt.parentElement?.parentElement;
        if (p) parentSet.add(p);
      }
      containers = Array.from(parentSet);
    }

    const scraped = [];

    for (let idx = 0; idx < containers.length; idx++) {
      const c = containers[idx];

      // Points badge
      const pointsEl = c.querySelector(sel.pointsBadge);
      const points = cleanText(pointsEl);

      // Question Prompt
      const legendEl = c.querySelector(sel.legend) || c.querySelector('[id$="-legend"]');
      const cmlEl = (legendEl || c).querySelector(sel.cmlViewer) || legendEl;
      let promptText = cleanText(cmlEl);
      if (!promptText && legendEl) promptText = cleanText(legendEl);

      // Options
      const optionEls = Array.from(c.querySelectorAll(sel.optionContainer));
      const optionsList = [];

      for (let oIdx = 0; oIdx < optionEls.length; oIdx++) {
        const optEl = optionEls[oIdx];
        const inputEl = optEl.querySelector(sel.optionInput);
        const labelEl = optEl.querySelector(sel.optionLabel) || optEl.querySelector('label');
        const optText = cleanText(labelEl);

        optionsList.push({
          index: oIdx,
          inputId: inputEl?.id || '',
          name: inputEl?.getAttribute('name') || '',
          value: inputEl?.getAttribute('value') || String(oIdx),
          type: inputEl?.getAttribute('type') || 'radio',
          text: optText,
          checked: inputEl?.checked || false
        });
      }

      scraped.push({
        index: idx + 1,
        title: `Question ${idx + 1}`,
        points,
        prompt: promptText,
        isMultiSelect: optionsList.some(o => o.type === 'checkbox'),
        options: optionsList
      });
    }

    return scraped;
  }, COURSERA_SEL);

  if (!questionsData || questionsData.length === 0) {
    const isLockedNow = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return /this item will be available|will be available|not available yet|locked until/i.test(text);
    });
    console.log(`[BITS Handler] ⚠️ No questions could be extracted from page.${isLockedNow ? ' (Page indicates future availability/lock)' : ''}`);
    return {
      status: 'skipped',
      reason: isLockedNow ? 'Assignment not available yet' : 'No questions detected on attempt page',
      isFutureLocked: Boolean(isLockedNow)
    };
  }

  console.log(`[BITS Handler] Extracted ${questionsData.length} questions. Solving with AI...`);

  const answersLog = [];

  // 5. Solve each question
  for (const q of questionsData) {
    console.log(`\n  [Q${q.index}] "${q.prompt.slice(0, 80)}${q.prompt.length > 80 ? '...' : ''}" (${q.points || 'N/A'})`);
    console.log(`    Options count: ${q.options.length} (Type: ${q.isMultiSelect ? 'Multi-select' : 'Single-choice'})`);

    // ---- Pre-existing selection check ----
    const alreadyAnswered = q.options.some(o => o.checked);
    if (alreadyAnswered) {
      const preAnswered = q.options.filter(o => o.checked).map(o => `${String.fromCharCode(65 + o.index)}: "${o.text}"`).join(' | ');
      console.log(`    ℹ️ Q${q.index} has draft selection: ${preAnswered} — AI will re-evaluate and verify.`);
    }

    // ---- Screenshot fallback: use vision if prompt text is too short/empty ----
    let screenshotBase64 = null;
    if (q.prompt.length < 20 || q.prompt.replace(/\s/g, '').length < 8) {
      console.log(`    📷 Prompt text too short/empty ("${q.prompt}") — capturing screenshot for visual AI solving.`);
      try {
        // Try to locate the specific question container by index and screenshot just that region
        const containerHandle = await page.locator(COURSERA_SEL.questionContainer).nth(q.index - 1).elementHandle().catch(() => null);
        if (containerHandle) {
          const buf = await containerHandle.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
          if (buf) screenshotBase64 = buf.toString('base64');
        }
        if (!screenshotBase64) {
          // Full-page fallback
          const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => null);
          if (buf) screenshotBase64 = buf.toString('base64');
        }
      } catch (ssErr) {
        console.log(`    ⚠️ Screenshot capture failed: ${ssErr.message}`);
      }
    }

    const problemContent = {
      title: q.title,
      body: q.prompt || 'See screenshot',
      isMultiSelect: q.isMultiSelect,
      options: q.options.map((o) => ({
        index: o.index,
        label: String.fromCharCode(65 + o.index), // A, B, C, D...
        text: o.text
      })),
      ...(screenshotBase64 ? { screenshotBase64, screenshotMime: 'image/jpeg' } : {})
    };

    // ---- Human timing: simulate reading question before answering ----
    if (!options.dryRun) await HUMAN_DELAY();

    let chosenIndices = [];
    let reasoning = '';
    let solutionCacheKey = null;

    // Tier 1: Check Verified Answer Key (PDF / Document)
    let keyMatch = null;
    if (options.answerStore) {
      keyMatch = options.answerStore.matchQuestion({
        prompt: q.prompt,
        options: problemContent.options,
        isMultiSelect: q.isMultiSelect
      });
    }

    if (keyMatch && keyMatch.selectedIndices?.length > 0) {
      chosenIndices = keyMatch.selectedIndices;
      reasoning = keyMatch.reasoning;
      console.log(`    ⭐ [VERIFIED KEY] Match from "${keyMatch.source}": ${chosenIndices.map(i => `${String.fromCharCode(65 + i)}: "${q.options[i]?.text}"`).join(' | ')}`);
    } else {
      // Tier 2 & 3: Multi-Provider AI Solver (Gemini -> Groq -> Grok)
      for (let solveAttempt = 1; solveAttempt <= 3; solveAttempt++) {
        try {
          const solution = await solveMCQ(problemContent);
          reasoning = solution.reasoning || '';
          solutionCacheKey = solution.cacheKey || null;

          if (Array.isArray(solution.selectedIndices) && solution.selectedIndices.length > 0) {
            chosenIndices = solution.selectedIndices;
            break;
          } else if (typeof solution.bestOptionIndex === 'number') {
            chosenIndices = [solution.bestOptionIndex];
            break;
          } else if (solution.failed) {
            console.warn(`    ⚠️ AI solver failed for Q${q.index} (attempt ${solveAttempt}/3): ${solution.reasoning || 'No answer returned'}`);
            if (solveAttempt < 3) {
              console.log(`    ⏳ Waiting 2.5s before retrying Q${q.index}...`);
              await DELAY(2500);
            }
          }
        } catch (err) {
          console.log(`    ⚠️ Solver error on Q${q.index} (attempt ${solveAttempt}/3): ${err.message}`);
          if (solveAttempt < 3) await DELAY(2500);
        }
      }
    }

    console.log(`    💡 Selected Option(s): ${chosenIndices.map(i => `${String.fromCharCode(65 + i)}: "${q.options[i]?.text}"`).join(' | ') || 'NONE'}`);
    if (reasoning) console.log(`    🧠 Reasoning: ${reasoning.slice(0, 100)}...`);

    answersLog.push({
      questionIndex: q.index,
      prompt: q.prompt,
      chosenOptions: chosenIndices.map(i => q.options[i]?.text),
      chosenIndices,
      reasoning,
      cacheKey: solutionCacheKey,
      verifiedSource: keyMatch?.source || null
    });

    // ReAct Enforce & Observe Loop: Ensure chosen options are checked AND stale non-chosen options are unchecked
    if (!options.dryRun && chosenIndices.length > 0) {
      for (const opt of q.options) {
        const shouldBeChecked = chosenIndices.includes(opt.index);

        // Action: Apply synthetic event click/check
        await page.evaluate(({ inputId, name, value, shouldBeChecked }) => {
          let input = null;
          if (inputId) input = document.getElementById(inputId);
          if (!input && name && value) input = document.querySelector(`input[name="${name}"][value="${value}"]`);

          if (input && input.checked !== shouldBeChecked) {
            input.click();
            input.checked = shouldBeChecked;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const label = input.closest('label') || input.parentElement;
            if (label) label.click();
          }
        }, { inputId: opt.inputId, name: opt.name, value: opt.value, shouldBeChecked });

        // Observe: Read settled DOM state after 300ms settle
        await DELAY(300);
        const actualChecked = await page.evaluate(({ inputId, name, value }) => {
          let input = null;
          if (inputId) input = document.getElementById(inputId);
          if (!input && name && value) input = document.querySelector(`input[name="${name}"][value="${value}"]`);
          return input ? input.checked : null;
        }, { inputId: opt.inputId, name: opt.name, value: opt.value });

        // Reflect & Self-Correct: If DOM does not match shouldBeChecked, enforce via Playwright native CDP locator
        if (actualChecked !== null && actualChecked !== shouldBeChecked) {
          console.log(`    🔁 ReAct Self-Correction on Q${q.index} opt${opt.index} (expected: ${shouldBeChecked}, actual: ${actualChecked})...`);
          let loc = null;
          if (opt.inputId) loc = page.locator(`id=${opt.inputId}`).first();
          else if (opt.name && opt.value) loc = page.locator(`input[name="${opt.name}"][value="${opt.value}"]`).first();

          if (loc && await loc.isVisible().catch(() => false)) {
            if (shouldBeChecked) {
              await loc.check({ force: true }).catch(() => {});
            } else {
              await loc.uncheck({ force: true }).catch(() => {});
            }
          }
          await DELAY(200);
        }
      }
    }
  }

  // 6. Pre-Submission DOM Audit & Targeted Recovery
  console.log(`\n[BITS Handler] 🔍 Auditing question answer status in DOM before submission...`);
  const getDomAudit = async () => {
    return await page.evaluate((sel) => {
      const containers = Array.from(document.querySelectorAll(sel.questionContainer));
      const unanswered = [];
      for (let i = 0; i < containers.length; i++) {
        const c = containers[i];
        const checked = c.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked');
        if (checked.length === 0) {
          unanswered.push(i + 1);
        }
      }
      return {
        total: containers.length,
        answered: containers.length - unanswered.length,
        unanswered
      };
    }, COURSERA_SEL);
  };

  let audit = await getDomAudit();

  // If there are unanswered questions, enter an agentic recovery loop!
  if (!options.dryRun && audit.unanswered.length > 0) {
    console.warn(`\n[BITS Handler] ⚠️ DOM Audit detected ${audit.unanswered.length} unanswered question(s): [Q${audit.unanswered.join(', Q')}]`);
    console.log(`[BITS Handler] 🔄 Starting targeted re-solve & re-click for unanswered questions...`);

    for (const qNum of audit.unanswered) {
      const q = questionsData.find(item => item.index === qNum);
      if (!q) continue;

      console.log(`\n  ▶ [Targeted Re-Solve Q${qNum}] "${q.prompt.slice(0, 70)}..."`);
      const problemContent = {
        title: q.title,
        body: q.prompt,
        isMultiSelect: q.isMultiSelect,
        options: q.options.map((o) => ({
          index: o.index,
          label: String.fromCharCode(65 + o.index),
          text: o.text
        }))
      };

      // Tier 1 in recovery: check Answer Key first
      let retryKeyMatch = null;
      if (options.answerStore) {
        retryKeyMatch = options.answerStore.matchQuestion({
          prompt: q.prompt,
          options: problemContent.options,
          isMultiSelect: q.isMultiSelect
        });
      }

      let retryPicks = retryKeyMatch?.selectedIndices || [];

      if (retryPicks.length === 0) {
        for (let retryAttempt = 1; retryAttempt <= 3; retryAttempt++) {
          console.log(`    Attempt ${retryAttempt}/3 to solve Q${qNum}...`);
          await DELAY(2000);
          try {
            const solution = await solveMCQ(problemContent);
            if (Array.isArray(solution.selectedIndices) && solution.selectedIndices.length > 0) {
              retryPicks = solution.selectedIndices;
            } else if (typeof solution.bestOptionIndex === 'number') {
              retryPicks = [solution.bestOptionIndex];
            }
            if (retryPicks.length > 0) break;
          } catch (retryErr) {
            console.warn(`    ⚠️ Re-solve error on Q${qNum}: ${retryErr.message}`);
          }
        }
      }

      if (retryPicks.length > 0) {
        console.log(`    💡 Recovered Answer for Q${qNum}: ${retryPicks.map(i => `${String.fromCharCode(65 + i)}: "${q.options[i]?.text}"`).join(' | ')}`);
        // ReAct injection for recovered question
        for (const opt of q.options) {
          const shouldBeChecked = retryPicks.includes(opt.index);
          await page.evaluate(({ inputId, name, value, shouldBeChecked }) => {
            let input = null;
            if (inputId) input = document.getElementById(inputId);
            if (!input && name && value) input = document.querySelector(`input[name="${name}"][value="${value}"]`);
            if (input && input.checked !== shouldBeChecked) {
              input.click();
              input.checked = shouldBeChecked;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
              const label = input.closest('label') || input.parentElement;
              if (label) label.click();
            }
          }, { inputId: opt.inputId, name: opt.name, value: opt.value, shouldBeChecked });
          await DELAY(200);
        }
      }
    }

    // Re-audit after targeted retry
    audit = await getDomAudit();
  }

  // 7. CRITICAL PRE-SUBMISSION SAFETY GATE
  if (!options.dryRun && audit.unanswered.length > 0) {
    console.error(`\n============================================================`);
    console.error(`🚨 [BITS Handler] CRITICAL SAFETY BLOCK: INCOMPLETE QUIZ!`);
    console.error(`   ${audit.unanswered.length} of ${audit.total} questions remain UNANSWERED: [Q${audit.unanswered.join(', Q')}].`);
    console.error(`   ABORTING SUBMISSION TO PROTECT YOUR GRADE.`);
    console.error(`   Honor Code will NOT be signed.`);
    console.error(`   Submit button will NOT be clicked.`);
    console.error(`============================================================\n`);

    // Click Save draft if available so already answered questions are saved
    const saveDraftBtn = page.locator(COURSERA_SEL.saveDraftButton).first();
    if (await saveDraftBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[BITS Handler] Saving draft to preserve answered questions...`);
      await saveDraftBtn.click().catch(() => {});
      await DELAY(1500);
    }

    return {
      status: 'fail',
      reason: `Refused to submit: Incomplete quiz (${audit.unanswered.length} questions unanswered: Q${audit.unanswered.join(', Q')})`,
      unanswered: audit.unanswered
    };
  }

  if (audit.total > 0) {
    console.log(`[BITS Handler] ✓ Pre-submission audit passed! All ${audit.total} questions are answered in DOM.`);
  }

  // 8. Dry-run preview vs Live Submission
  if (options.dryRun) {
    console.log(`\n============================================================`);
    console.log(`[BITS Handler] ↺ DRY-RUN PREVIEW SUMMARY (${questionsData.length} questions)`);
    console.log(`============================================================`);
    for (const ans of answersLog) {
      const picks = ans.chosenOptions && ans.chosenOptions.length > 0 ? ans.chosenOptions.join(' | ') : 'NO ANSWER';
      const flag = ans.skippedAI ? 'HUMAN PRE-ANSWERED' : (ans.chosenIndices?.length > 0 ? 'AI SOLVED' : 'FAILED');
      console.log(`  Q${ans.questionIndex}: [${flag}] ${picks}`);
    }
    console.log(`============================================================\n`);
    return {
      status: 'dry-run',
      questionsSolved: questionsData.length,
      answers: answersLog
    };
  }

  // 9. Check Honor Code Agreement
  console.log(`\n[BITS Handler] Checking Coursera Honor Code agreement...`);
  const agreed = await page.evaluate((sel) => {
    const checkbox = document.querySelector(sel.honorCodeCheckbox);
    if (checkbox) {
      if (!checkbox.checked) {
        checkbox.click();
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
    return false;
  }, COURSERA_SEL);

  if (agreed) {
    console.log(`[BITS Handler] ✓ Honor Code agreement checked.`);
  } else {
    console.log(`[BITS Handler] ℹ️ Honor code checkbox not found or not required.`);
  }

  // 10. Submission
  console.log(`\n[BITS Handler] Submitting assignment...`);
  const submitBtn = page.locator(COURSERA_SEL.submitButton).first();
  await submitBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  // Wait for button to be enabled (aria-disabled="false" and disabled attribute removed)
  for (let attempt = 0; attempt < 10; attempt++) {
    const isDisabled = await submitBtn.evaluate((btn) => btn.disabled || btn.getAttribute('aria-disabled') === 'true').catch(() => true);
    if (!isDisabled) break;
    await DELAY(500);
  }

  await submitBtn.click({ force: true }).catch(() => {});
  await DELAY(2000);

  // Check if any confirmation dialog appeared and click confirm
  const confirmBtn = page.locator('button:has-text("Submit"), button:has-text("Yes, submit")').last();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click().catch(() => {});
    await DELAY(1500);
  }

  // 11. Wait for grading progress or submission confirmation & Grade Verification Loop
  console.log(`[BITS Handler] Waiting for grading & result screen...`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(4000);

  // Poll for score / review results up to 15 seconds
  let postSubmitData = null;
  for (let poll = 0; poll < 5; poll++) {
    postSubmitData = await page.evaluate(() => {
      const text = document.body?.innerText || '';

      // Match percentage or points: e.g. "Grade: 80%", "Your grade: 100%", "8 / 10 points", "Grade: 92.5%"
      const gradeMatch = text.match(/(?:your\s+)?grade[:\s]*(\d+(?:\.\d+)?)\s*%(?!\s*(?:or higher|to pass))/i) ||
                         text.match(/grade[:\s]*(\d+(?:\.\d+)?)(?!\s*(?:or higher|to pass|\s*points?))/i) ||
                         text.match(/(\d+(?:\.\d+)?)\s*\/\s*100/i) ||
                         text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*(?:points|pts)/i);
      let gradePercent = null;
      if (gradeMatch) {
        if (gradeMatch[2]) {
          const earned = parseFloat(gradeMatch[1]);
          const total = parseFloat(gradeMatch[2]);
          if (total > 0) gradePercent = Math.round((earned / total) * 100);
        } else {
          gradePercent = Math.round(parseFloat(gradeMatch[1]));
        }
      }

      const isPassed = /passed|congratulations/i.test(text) && !/did not pass|try again/i.test(text);

      // Scrape question review cards if review is visible
      const wrongQuestionIndices = [];
      const questionCards = Array.from(document.querySelectorAll('div[data-testid^="part-Submission_"], div[role="region"], fieldset, .rc-FormPart'));
      for (let i = 0; i < questionCards.length; i++) {
        const card = questionCards[i];
        const cardText = (card.innerText || '').toLowerCase();
        const cardHtml = card.innerHTML || '';
        const isWrong = cardText.includes('incorrect') ||
                        cardText.includes('0 / 1 point') ||
                        cardText.includes('0/1 point') ||
                        cardText.includes('0 of 1 point') ||
                        cardHtml.includes('aria-label="Incorrect"');
        if (isWrong) {
          wrongQuestionIndices.push(i + 1);
        }
      }

      return { gradePercent, isPassed, wrongQuestionIndices };
    }).catch(() => null);

    if (postSubmitData && (postSubmitData.gradePercent !== null || postSubmitData.wrongQuestionIndices.length > 0)) {
      break;
    }
    await DELAY(2500);
  }

  const finalGrade = postSubmitData?.gradePercent ?? null;
  const isPassingGrade = finalGrade !== null ? finalGrade >= 80 : (postSubmitData?.isPassed ?? true);

  console.log(`\n============================================================`);
  console.log(`[BITS Handler] 📊 Post-Submission Verification:`);
  console.log(`   Grade: ${finalGrade !== null ? finalGrade + '%' : 'Pending / Not displayed directly'}`);
  console.log(`   Status: ${isPassingGrade ? '✅ PASSED (>= 80%)' : '⚠️ BELOW PASSING THRESHOLD (< 80%)'}`);
  if (postSubmitData?.wrongQuestionIndices?.length > 0) {
    console.log(`   Wrong Question(s): [Q${postSubmitData.wrongQuestionIndices.join(', Q')}]`);
  }
  console.log(`============================================================\n`);

  // Wire into question-level feedback loop: record wrong options to avoid repeat errors on retries
  if (postSubmitData?.wrongQuestionIndices?.length > 0) {
    console.log(`[BITS Handler] 🔄 Recording rejected options in cache for future attempts...`);
    for (const wrongQNum of postSubmitData.wrongQuestionIndices) {
      const recordedAns = answersLog.find(a => a.questionIndex === wrongQNum);
      if (recordedAns && recordedAns.cacheKey && Array.isArray(recordedAns.chosenIndices)) {
        for (const idx of recordedAns.chosenIndices) {
          recordWrongMCQOption(recordedAns.cacheKey, idx);
          console.log(`   ❌ Q${wrongQNum}: Recorded wrong option index ${idx} for cache key.`);
        }
      }
    }
  }

  if (isPassingGrade) {
    markQuizPassed(assignmentUrl, { grade: finalGrade, questionsSolved: audit.total });
    await sendNotification(`🎓 *BITS Coursera* — Assignment Passed! 🎉\n• URL: ${assignmentUrl}\n• Grade: ${finalGrade !== null ? finalGrade + '%' : 'Passed'}\n• Questions: ${audit.total}`);
    return {
      status: 'pass',
      grade: finalGrade,
      questionsSolved: questionsData.length,
      answers: answersLog
    };
  } else {
    await sendNotification(`⚠️ *BITS Coursera* — Score below 80% threshold.\n• URL: ${assignmentUrl}\n• Grade: ${finalGrade}%\n• Wrong Questions: Q${postSubmitData?.wrongQuestionIndices?.join(', Q') || 'N/A'}`);

    const retriesLeft = typeof options.retriesLeft === 'number' ? options.retriesLeft : 2;

    // Check if review page shows cooldown or wait timer
    const cooldownInfo = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const match = text.match(/(?:try again in|re-attempt in|available in)\s*([^\.\n]+)/i);
      return match ? match[0] : null;
    }).catch(() => null);

    if (cooldownInfo) {
      console.log(`[BITS Handler] ⏳ Retake on cooldown: "${cooldownInfo}". Cannot retake immediately.`);
      await sendNotification(`⏳ *BITS Coursera* — Retake cooldown active: ${cooldownInfo}`);
    } else if (retriesLeft > 0 && !options.dryRun) {
      console.log(`\n============================================================`);
      console.log(`🔄 [BITS Handler] AGENTIC RETAKE LOOP: Score ${finalGrade}% is below passing (80%).`);
      console.log(`   Initiating automated retake attempt (${retriesLeft} retries remaining)...`);
      console.log(`   Wrong question(s) recorded in cache: [Q${postSubmitData?.wrongQuestionIndices?.join(', Q') || 'N/A'}]`);
      console.log(`============================================================\n`);
      await DELAY(3000);
      return await solveAndSubmitCourseraAssignment(page, assignmentUrl, {
        ...options,
        retriesLeft: retriesLeft - 1
      });
    }

    return {
      status: 'fail',
      grade: finalGrade,
      reason: `Grade ${finalGrade}% is below the 80% passing threshold`,
      wrongQuestions: postSubmitData?.wrongQuestionIndices || [],
      questionsSolved: questionsData.length,
      answers: answersLog
    };
  }
}

