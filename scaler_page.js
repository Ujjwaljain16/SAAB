// scaler_page.js — reading/classifying Scaler pages and problem text (no run orchestration).
import { SEL } from './config.js';
import { normalizeScalerUrl } from './scaler_url.js';

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

export async function collectAssignmentProblems(page) {
  return page.$$eval('tr.table__row', (rows) =>
    rows
      .map((row) => {
        const nameLink = row.querySelector('a[href*="/assignment/problems/"]');
        const solveLink = row.querySelector('a.me-cr-classroom-url.me-cr-problem-actions__btn[href*="/assignment/problems/"]');
        const targetLink = solveLink || nameLink;

        if (!targetLink) {
          return null;
        }

        const title = (nameLink?.textContent || row.querySelector('td')?.textContent || '').trim();
        const statusText = (row.innerText || '').trim().replace(/\s+/g, ' ');
        const isSolved = /solved|100\s*\/\s*100/i.test(statusText) && !/unsolved/i.test(statusText);

        return {
          title: title || 'Problem',
          solveUrl: targetLink.getAttribute('href') || '',
          statusText,
          isSolved,
        };
      })
      .filter(Boolean)
  );
}

export async function collectQuestionTabs(page) {
  return page.$$eval('a.cr-p-navigation-dock-item[href*="/assignment/problems/"], a[href*="/assignment/problems/"]', (tabs) =>
    tabs
      .map((tab) => {
        const href = tab.getAttribute('href') || '';
        if (!href.includes('/assignment/problems/')) {
          return null;
        }
        const text = (tab.textContent || '').trim().replace(/\s+/g, ' ');
        const isSolved = tab.classList.contains('cr-p-navigation-dock-item--success') ||
                         tab.classList.contains('me-cr-p-nav-dock-item--success') ||
                         tab.querySelector('svg[class*="success"], i[class*="check"], [class*="status-tag--success"]') != null;

        return {
          title: text || `Question ${href.split('/').pop()}`,
          solveUrl: href,
          isSolved,
        };
      })
      .filter(Boolean)
  );
}

export async function getProblemSolveState(page) {
  await page.waitForSelector('.cr-p-heading .status-tag-2, .cr-p-heading [class*="status"], [class*="status-tag"]', { timeout: 2500 }).catch(() => {});
  return page.evaluate(() => {
    const headingEl = document.querySelector('.cr-p-heading .status-tag-2, .cr-p-heading [class*="status"], [class*="status-tag"]');
    if (headingEl) {
      const text = (headingEl.textContent || '').trim().toLowerCase();
      if (text.includes('solved') && !text.includes('unsolved')) return 'solved';
      if (text.includes('unsolved')) return 'unsolved';
      if (text.includes('attempted')) return 'attempted';
    }
    const hasSolvedBadge = document.querySelector('.cr-p-heading .status-tag-2--success, .status-tag--success, [class*="status-tag--success"]') != null;
    if (hasSolvedBadge) return 'solved';
    return 'unsolved';
  }).catch(() => 'unknown');
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

export async function detectProblemType(page) {
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
  const isVSCode = await page.evaluate((ideSel) => {
    if (document.querySelector(ideSel)) return true;
    const btns = Array.from(document.querySelectorAll('button, a, span, div'));
    return btns.some(b => (b.innerText || '').trim().match(/^open\s*ide$|vs\s*code/i));
  }, SEL.ideContainer).catch(() => false);
  if (isVSCode) return 'vscode';

  // Check for Maxwell terminal labs (Launch Lab button or maxwell iframe)
  const isLab = await page.evaluate((launchSel) => {
    if (document.querySelector('iframe[src*="maxwell"], iframe[allow*="clipboard-read"]')) return true;
    if (document.querySelector(launchSel)) return true;
    const btns = Array.from(document.querySelectorAll('button, a, span, div'));
    return btns.some(b => (b.innerText || '').trim().match(/^launch\s*(lab)?$/i));
  }, SEL.labLaunchBtn).catch(() => false);
  if (isLab) return 'lab';

  return 'coding';
}
