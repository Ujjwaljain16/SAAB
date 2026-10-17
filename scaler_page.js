// scaler_page.js — reading/classifying Scaler pages and problem text (no run orchestration).
import { SEL } from './config.js';
import { normalizeScalerUrl, canonicalProblemUrl } from './scaler_url.js';

export function previewCode(code, maxLines = 18) {
  const lines = (code || '').split(/\r?\n/);
  if (lines.length <= maxLines) {
    return code;
  }
  return `${lines.slice(0, maxLines).join('\n')}\n... [truncated ${lines.length - maxLines} lines]`;
}

export function classifyFailureFeedback(text) {
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

export function normalizeProblemTitle(title) {
  return title.replace(/\s*-\s*Problem.*$/i, '').trim();
}

export function resolveTargetLanguage(subject) {
  if (/programming using js/i.test(subject)) {
    return 'JavaScript';
  }
  return 'Java';
}

export function normalizeLanguageName(value) {
  const v = (value || '').toLowerCase();
  if (v.includes('javascript')) return 'javascript';
  if (/(^|\b)java(\b|$)/.test(v)) return 'java';
  return '';
}

export async function getCurrentSelectedLanguage(page) {
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

export async function getCurrentSelectedLanguageLabel(page) {
  return page.evaluate((inputSelector) => {
    const input = document.querySelector(inputSelector);
    if (!input) return '';
    const selectRoot = input.closest('[class*="select"]') || input.parentElement;
    return (selectRoot?.innerText || '').replace(/\s+/g, ' ').trim();
  }, SEL.problemLanguageInput).catch(() => '');
}

export async function selectProblemLanguage(page, targetLanguage) {
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

export async function extractProblemContent(page) {
  const title = normalizeProblemTitle(await page.title());

  // The real statement lives in `.cr-p-statement` on every problem type (MCQ, coding, lab, confirmed on real captures). Use it when it
  // is there: it is exactly the problem text, with none of the page chrome around it.
  const statement = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cr-p-statement'))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
      .join('\n\n')
  ).catch(() => '');
  if (statement.length >= 30) {
    return { title, body: statement.replace(/\n{3,}/g, '\n\n').slice(0, 12000) };
  }

  // Fallback for a page without that element: take the whole page text, starting at "Problem Description" if it exists. The end
  // markers are only searched AFTER the start. They used to be searched from the very top, and a lab page (no "Problem Description")
  // was cut at "Refer Friends" in the navigation bar, leaving the AI with the 15 characters "HomeSST Goodies" instead of the task.
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

  const searchFrom = start === -1 ? Math.min(400, Math.floor(body.length / 4)) : 0;
  let cutAt = body.length;
  for (const marker of endMarkers) {
    const match = marker.exec(body.slice(searchFrom));
    if (match && typeof match.index === 'number') {
      cutAt = Math.min(cutAt, searchFrom + match.index);
    }
  }

  body = body.slice(0, cutAt).trim();
  body = body.replace(/\n{3,}/g, '\n\n').slice(0, 12000);

  return { title, body };
}

export function extractTestCases(body) {
  if (!body) return '';
  const match = body.match(/(?:sample|example)\s*(?:input|test\s*case)s?[\s\S]*$/i);
  return match ? match[0].slice(0, 4000) : '';
}

export async function extractEditorStarterCode(page) {
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

// Only `/assignment/problems/<id>` is a question. The same page also links `/<id>/submissions` and `/<id>/help-requests`
// (per row, plus icon links); those are NOT questions and used to be "solved" as if they were, re-solving solved work.
const PROBLEM_PATH_SOURCE = String.raw`/assignment/problems/[^/?#]+/?$`;

export function isProblemHref(href) {
  try {
    return new RegExp(PROBLEM_PATH_SOURCE).test(new URL(href, 'https://www.scaler.com').pathname);
  } catch {
    return false;
  }
}

export async function collectAssignmentProblems(page) {
  const rawRows = await page.$$eval('tr.table__row', (rows, patternSource) => {
    const isProblem = (href) => {
      try {
        return new RegExp(patternSource).test(new URL(href, location.origin).pathname);
      } catch {
        return false;
      }
    };

    return rows
      .map((row) => {
        const links = Array.from(row.querySelectorAll('a[href*="/assignment/problems/"]'))
          .filter((a) => isProblem(a.getAttribute('href') || ''));
        if (links.length === 0) return null;

        const nameLink = links.find((a) => a.classList.contains('me-cr-problem-list__name')) || links[0];
        const solveLink = links.find((a) => a.classList.contains('me-cr-problem-actions__btn'));
        const targetLink = solveLink || nameLink;

        const title = (nameLink.textContent || row.querySelector('td')?.textContent || '').trim();
        const statusText = (row.innerText || '').trim().replace(/\s+/g, ' ');
        const isSolved = /\bsolved\b|100\s*\/\s*100/i.test(statusText) && !/\bunsolved\b/i.test(statusText);

        return {
          title: title || 'Problem',
          solveUrl: targetLink.getAttribute('href') || '',
          statusText,
          isSolved,
        };
      })
      .filter(Boolean);
  }, PROBLEM_PATH_SOURCE);
  // Solved if ANY signal says so: the Status word OR a full score like 50.0/50.
  return rawRows.map((r) => ({ ...r, isSolved: r.isSolved || looksSolved(r.statusText) }));
}

export async function collectQuestionTabs(page) {
  return page.$$eval('a.cr-p-navigation-dock-item[href*="/assignment/problems/"], a[href*="/assignment/problems/"]', (tabs, patternSource) => {
    const isProblem = (href) => {
      try {
        return new RegExp(patternSource).test(new URL(href, location.origin).pathname);
      } catch {
        return false;
      }
    };

    return tabs
      .map((tab) => {
        const href = tab.getAttribute('href') || '';
        if (!isProblem(href)) return null;

        const text = (tab.textContent || '').trim().replace(/\s+/g, ' ');
        const isSolved = tab.classList.contains('cr-p-navigation-dock-item--success') ||
                         tab.classList.contains('me-cr-p-nav-dock-item--success') ||
                         tab.querySelector('svg[class*="success"], i[class*="check"], [class*="status-tag--success"]') != null;

        return {
          title: text || `Question ${href.split('?')[0].split('/').pop()}`,
          solveUrl: href,
          isSolved,
        };
      })
      .filter(Boolean);
  }, PROBLEM_PATH_SOURCE);
}

/**
 * Is this table-row/status text "done"? ANY signal counts, because wrongly re-solving a solved problem is far worse than skipping one:
 * the words Solved/Completed/Accepted, or a full score such as "50.0/50". "Unsolved" always wins.
 */
export function looksSolved(statusText) {
  const text = String(statusText || '');
  if (/\bunsolved\b|\bnot\s+solved\b/i.test(text)) return false;
  if (/\b(solved|completed|accepted)\b/i.test(text)) return true;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g)) {
    const got = Number(m[1]);
    const max = Number(m[2]);
    if (max > 0 && got === max) return true;
  }
  return false;
}

/**
 * Combine the problems table and the question dock into one list keyed by canonical URL.
 * Only real question links are kept, and if EITHER source says a problem is solved it is solved
 * (previously the first source won and the other one's "solved" flag was thrown away).
 */
export function mergeProblems(tableProblems, tabProblems) {
  const merged = new Map();
  for (const p of [...(tableProblems || []), ...(tabProblems || [])]) {
    if (!p?.solveUrl || !isProblemHref(p.solveUrl)) continue;
    const canon = canonicalProblemUrl(p.solveUrl);
    if (!canon) continue;

    const existing = merged.get(canon);
    if (existing) {
      if (p.isSolved) existing.isSolved = true;
      continue;
    }
    merged.set(canon, { ...p, solveUrl: canon });
  }
  return Array.from(merged.values());
}

export async function getProblemSolveState(page, { wait = true } = {}) {
  if (wait) {
    await page.waitForSelector('.cr-p-heading [class*="status-tag"], [class*="status-tag"]', { timeout: 4000 }).catch(() => {});
  }
  return page.evaluate(() => {
    // Look at every status tag, not just the first: a "Mandatory" tag usually comes before the Solved/Unsolved one.
    const tags = Array.from(document.querySelectorAll('.cr-p-heading [class*="status"], [class*="status-tag"]'));
    const texts = tags.map((t) => (t.textContent || '').trim().toLowerCase());

    if (texts.some((t) => t.includes('unsolved'))) return 'unsolved';
    const solved =
      texts.some((t) => /\bsolved\b/.test(t)) ||
      tags.some((t) => /status-tag(-2)?--success/.test(String(t.className))) ||
      document.querySelector('.cr-p-heading .cr-icon-correct') != null;
    if (solved) return 'solved';
    if (texts.some((t) => t.includes('attempted'))) return 'attempted';
    return 'unsolved';
  }).catch(() => 'unknown');
}

/**
 * Safety net used right before every AI call or submit: reads the solved state twice (the status badge renders late in React,
 * and the problem may have been solved meanwhile by another worker, a previous slow verdict, or the user). Solved on EITHER read wins.
 */
export async function isSolvedNow(page, { wait = false, settleMs = 600 } = {}) {
  if ((await getProblemSolveState(page, { wait })) === 'solved') return true;
  await page.waitForTimeout(settleMs).catch(() => {});
  return (await getProblemSolveState(page, { wait: false })) === 'solved';
}

export function buildProblemsUrl(assignmentUrl) {
  const norm = normalizeScalerUrl(assignmentUrl);
  const url = new URL(norm);
  url.pathname = url.pathname.replace(/\/assignment\/?$/i, '/assignment/problems');
  if (!url.searchParams.has('navref')) {
    url.searchParams.set('navref', 'cl_tt_nv');
  }
  return url.toString();
}

export function isLoginUrl(url) {
  return /\/(login|sign_in)\b/i.test(url || '');
}

export async function detectProblemType(page, { timeoutMs = 20000 } = {}) {
  // Wait for the problem controls to mount. Only SPECIFIC markers count; a loose text match on "launch"/"vs code" anywhere in the
  // page (the statement, a nav link) used to end this wait too early or classify the page wrongly. Pages can take 7s+ to render
  // when several load at once, so wait generously: the wait ends the moment a marker appears, so fast pages are not slowed down.
  await page.waitForFunction((sel) => {
    const q = (s) => document.querySelector(s) != null;
    const idButton = Array.from(document.querySelectorAll('button, a')).some((b) => /^open\s*(in\s*)?(the\s*)?(ide|vs\s*code)$/i.test((b.innerText || '').trim()));
    return q('.cr-multiple-choice-container, .cr-multiple-choice') || q('.monaco-editor') || q(sel.launch) || q(sel.ide) ||
      q('iframe[src*="maxwell"]') || idButton;
  }, { launch: SEL.labLaunchBtn, ide: SEL.ideContainer }, { timeout: timeoutMs }).catch(() => {});

  // MCQ: the real marker only (a stray checkbox elsewhere on a coding/lab page must not make it an MCQ).
  const isMcq = (await page.locator('.cr-multiple-choice, .cr-multiple-choice-container').count()) > 0;
  if (isMcq) return 'mcq';

  // Maxwell terminal lab: very specific markers (the Launch Lab button element, or the maxwell iframe). Checked BEFORE the IDE
  // because a lab's statement can mention "VS Code"; it was once misclassified as a VS Code problem because of that.
  const isLab = await page.evaluate((launchSel) => {
    if (document.querySelector('iframe[src*="maxwell"], iframe[allow*="clipboard-read"]')) return true;
    if (document.querySelector(launchSel)) return true;
    return Array.from(document.querySelectorAll('button, a')).some((b) => /^launch\s*lab$/i.test((b.innerText || '').trim()));
  }, SEL.labLaunchBtn).catch(() => false);
  if (isLab) return 'lab';

  // VS Code IDE problem: the IDE container, or a short button/link that IS the "Open IDE" / "Open in VS Code" action.
  // Never a text match inside bigger containers (innerText of a div includes everything nested in it).
  const isVSCode = await page.evaluate((ideSel) => {
    if (document.querySelector(ideSel)) return true;
    return Array.from(document.querySelectorAll('button, a')).some((b) => {
      const t = (b.innerText || '').trim();
      return t.length > 0 && t.length <= 40 && /^(open\s*(in\s*)?(the\s*)?(ide|vs\s*code)|vs\s*code)$/i.test(t);
    });
  }, SEL.ideContainer).catch(() => false);
  if (isVSCode) return 'vscode';

  // "Coding" needs POSITIVE evidence: a code editor. Defaulting to coding when nothing was recognised made slow-loading MCQ pages
  // get "solved" as code (3 wasted AI attempts and a failure). Nothing recognised yet means "not loaded": the caller reloads once.
  const hasEditor = (await page.locator('.monaco-editor').count()) > 0;
  return hasEditor ? 'coding' : 'unknown';
}
