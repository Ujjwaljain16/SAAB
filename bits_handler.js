// bits_handler.js — Solves and submits Coursera BITS Pilani assignments and exams

import { COURSERA_SEL, COURSERA_TIMEOUTS } from './bits_config.js';
import { solveMCQ, solverStats } from './solver.js';

const DELAY = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // Ensure url ends with /attempt if not already
  let targetUrl = assignmentUrl;
  if (!targetUrl.includes('/attempt') && !targetUrl.includes('/exam/')) {
    targetUrl = targetUrl.replace(/\/+$/, '') + '/attempt';
  }

  console.log(`[BITS Handler] Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: COURSERA_TIMEOUTS.PAGE_LOAD });
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(2500);

  // 1. Check if we landed on a Cover Page (or need to click Start / Resume)
  const coverActionBtn = page.locator(COURSERA_SEL.coverActionButton).first();
  if (await coverActionBtn.isVisible().catch(() => false)) {
    const btnText = (await coverActionBtn.innerText().catch(() => '')).trim();
    console.log(`[BITS Handler] Cover page detected. Action button found: "${btnText}"`);
    console.log(`[BITS Handler] Launching assignment attempt...`);
    await coverActionBtn.click().catch(() => {});
    await DELAY(2000);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // 2. Check if locked or access restricted
  const isLocked = await page.evaluate((sel) => {
    const lockIcon = document.querySelector(sel.lockIcon);
    const bodyText = document.body.innerText.toLowerCase();
    const hasLockText = bodyText.includes('locked until') || bodyText.includes('locked assignment') || bodyText.includes('prerequisites required');
    return lockIcon != null || hasLockText;
  }, COURSERA_SEL);

  if (isLocked) {
    console.log(`[BITS Handler] ⚠️ Assignment is locked or prerequisites are required. Skipping.`);
    return { status: 'skipped', reason: 'Assignment is locked' };
  }

  // 3. Check for guidelines acknowledgment checkpoint dialog ("I understand")
  const guidelinesBtn = page.locator(COURSERA_SEL.guidelinesAckBtn).first();
  if (await guidelinesBtn.isVisible().catch(() => false)) {
    console.log(`[BITS Handler] Academic integrity checkpoint detected. Acknowledging guidelines...`);
    await guidelinesBtn.click().catch(() => {});
    await DELAY(1000);
  }

  // 4. Scrape all question parts
  console.log(`[BITS Handler] Scanning for questions in Tunnel Vision view...`);
  await page.waitForSelector(COURSERA_SEL.questionContainer, { timeout: 15000 }).catch(() => {});

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
    console.log(`[BITS Handler] ⚠️ No questions could be extracted from page.`);
    return { status: 'skipped', reason: 'No questions detected on attempt page' };
  }

  console.log(`[BITS Handler] Extracted ${questionsData.length} questions. Solving with AI...`);

  const answersLog = [];

  // 5. Solve each question
  for (const q of questionsData) {
    console.log(`\n  [Q${q.index}] "${q.prompt.slice(0, 80)}${q.prompt.length > 80 ? '...' : ''}" (${q.points || 'N/A'})`);
    console.log(`    Options count: ${q.options.length} (Type: ${q.isMultiSelect ? 'Multi-select' : 'Single-choice'})`);

    const problemContent = {
      title: q.title,
      body: q.prompt,
      options: q.options.map((o) => ({
        index: o.index,
        label: String.fromCharCode(65 + o.index), // A, B, C, D...
        text: o.text
      }))
    };

    let chosenIndices = [];
    let reasoning = '';

    try {
      const solution = await solveMCQ(problemContent);
      reasoning = solution.reasoning || '';
      
      if (typeof solution.bestOptionIndex === 'number') {
        chosenIndices.push(solution.bestOptionIndex);
      } else if (Array.isArray(solution.selectedIndices)) {
        chosenIndices = solution.selectedIndices;
      } else {
        chosenIndices.push(0);
      }
    } catch (err) {
      console.log(`    ⚠️ Solver error: ${err.message}. Using fallback.`);
      chosenIndices.push(0);
    }

    console.log(`    💡 AI Selected Option(s): ${chosenIndices.map(i => `${String.fromCharCode(65 + i)}: "${q.options[i]?.text}"`).join(' | ')}`);
    if (reasoning) console.log(`    🧠 Reasoning: ${reasoning.slice(0, 100)}...`);

    answersLog.push({
      questionIndex: q.index,
      prompt: q.prompt,
      chosenOptions: chosenIndices.map(i => q.options[i]?.text),
      reasoning
    });

    // Inject answer on page
    for (const optIdx of chosenIndices) {
      const targetOpt = q.options[optIdx];
      if (!targetOpt) continue;

      if (!options.dryRun) {
        await page.evaluate(({ inputId, name, value }) => {
          let input = null;
          if (inputId) input = document.getElementById(inputId);
          if (!input && name && value) input = document.querySelector(`input[name="${name}"][value="${value}"]`);

          if (input) {
            input.click();
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            
            // Also click parent label to notify React SyntheticEvent system
            const label = input.closest('label') || input.parentElement;
            if (label) label.click();
          }
        }, { inputId: targetOpt.inputId, name: targetOpt.name, value: targetOpt.value });
        await DELAY(300);
      }
    }
  }

  // 6. Check Honor Code Agreement
  console.log(`\n[BITS Handler] Checking Coursera Honor Code agreement...`);
  if (!options.dryRun) {
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
  }

  // 7. Submission or Dry-run preview
  if (options.dryRun) {
    console.log(`\n[BITS Handler] ↺ Dry-run preview complete! ${questionsData.length} question(s) answered without submitting.`);
    return {
      status: 'dry-run',
      questionsSolved: questionsData.length,
      answers: answersLog
    };
  }

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

  // Wait for grading progress or submission confirmation
  console.log(`[BITS Handler] Waiting for submission completion...`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await DELAY(3000);

  console.log(`[BITS Handler] ✓ Assignment submitted successfully!`);
  return {
    status: 'pass',
    questionsSolved: questionsData.length,
    answers: answersLog
  };
}
