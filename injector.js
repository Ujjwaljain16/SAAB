import { SEL } from './config.js';

async function setMonacoValue(page, code) {
  return page.evaluate((src) => {
    try {
      const monaco = window.monaco;
      if (!monaco?.editor?.getModels) return false;

      const models = monaco.editor.getModels();
      if (!models || models.length === 0) return false;

      models[0].setValue(src);
      return true;
    } catch {
      return false;
    }
  }, code).catch(() => false);
}

async function pasteIntoEditor(page, code) {
  await page.evaluate((src) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', src);
    const editor = document.querySelector('.monaco-editor textarea');
    if (editor) {
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    }
  }, code);
  await new Promise(r => setTimeout(r, 200));
}

function sanitizeFeedback(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function extractFocusedFeedback(bodyText) {
  const text = bodyText || '';
  const patterns = [
    /Compilation\s+Error[\s\S]{0,1800}/i,
    /Runtime\s+Error[\s\S]{0,1800}/i,
    /Wrong\s+Answer[\s\S]{0,1800}/i,
    /Error![\s\S]{0,1800}/i,
    /Main\.java:[\s\S]{0,1800}/i,
    /Final\s+Verdict[\s\S]{0,800}/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[0]) {
      return sanitizeFeedback(match[0]);
    }
  }

  const testOutputMatch = text.match(/Test\s+Output\s*[:\-]?[\s\S]*$/i);
  return sanitizeFeedback(testOutputMatch ? testOutputMatch[0] : text);
}

async function waitForVerdict(page, timeoutMs = 55000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.evaluate(() => {
      const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const lower = bodyText.toLowerCase();

      const finalVerdictMatch = bodyText.match(/Final\s+Verdict\s*[:\-]?\s*([^\n]+)/i);
      const finalVerdict = finalVerdictMatch ? (finalVerdictMatch[1] || '').trim() : '';

      const failureSignals = [
        'wrong answer',
        'failed',
        'compilation error',
        'compile error',
        'runtime error',
        'time limit exceeded',
        'memory limit exceeded',
        'syntax error',
        'exception'
      ];

      const hasFailureSignal = failureSignals.some((s) => lower.includes(s));
      const hasCorrectVerdict = /correct\s+answer/i.test(finalVerdict);
      const hasAccepted = lower.includes('all test cases passed') || lower.includes('accepted');

      const feedbackText = bodyText;

      return {
        hasFailureSignal,
        hasCorrectVerdict,
        hasAccepted,
        finalVerdict,
        feedbackText
      };
    });

    if (snapshot.hasCorrectVerdict || snapshot.hasAccepted) {
      return {
        status: 'pass',
        verdict: snapshot.finalVerdict || 'Correct Answer',
        feedback: extractFocusedFeedback(snapshot.feedbackText)
      };
    }

    if (snapshot.hasFailureSignal || (snapshot.finalVerdict && !/correct\s+answer/i.test(snapshot.finalVerdict))) {
      return {
        status: 'fail',
        verdict: snapshot.finalVerdict || 'Failed',
        feedback: extractFocusedFeedback(snapshot.feedbackText)
      };
    }

    await page.waitForTimeout(800);
  }

  const fallbackText = await page.locator('body').innerText().catch(() => '');
  return {
    status: 'timeout',
    verdict: 'Timeout waiting for verdict',
    feedback: extractFocusedFeedback(fallbackText)
  };
}

export async function injectAndSubmit(page, code) {
  if (!code) {
    console.log("No code provided to inject.");
    return { status: 'fail', verdict: 'No code generated', feedback: 'Solver returned empty code.' };
  }

  // Wait for editor DOM + Monaco JS API to be ready
  await page.waitForSelector(SEL.editorContainer, { timeout: 10000 });
  await page.waitForFunction(
    () => window.monaco?.editor?.getModels?.()?.length > 0,
    { timeout: 10000 }
  ).catch(() => {});
  await page.click(SEL.editorContainer);
  await page.waitForTimeout(300);

  let directSet = await setMonacoValue(page, code);

  // Verify Monaco content after injection
  if (directSet) {
    const actual = await page.evaluate(() => {
      const models = window.monaco?.editor?.getModels?.();
      return models?.[0]?.getValue?.() || '';
    }).catch(() => '');
    if (actual.trim() !== code.trim()) {
      console.warn('  Monaco setValue verification failed — content mismatch, falling back to keyboard.');
      directSet = false;
    }
  }

  if (!directSet) {
    // Fallback only if Monaco internals are unavailable.
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+A`);
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    await pasteIntoEditor(page, code);
    await page.keyboard.press(`${modifier}+V`);
    await page.waitForTimeout(1000);
  } else {
    await page.waitForTimeout(250);
  }

  // Dismiss optional helper modal if it appears.
  await page.locator('a:has-text("No! I clicked by mistake")').first().click().catch(() => {});

  // Guard submit button — check it exists before clicking
  const submitLocator = page.locator(SEL.submitBtn).first();
  const btnVisible = await submitLocator.isVisible().catch(() => false);
  if (!btnVisible) {
    return {
      status: 'fail',
      verdict: 'Submit button not found',
      feedback: 'Submit button not visible — session may have expired or wrong page loaded.'
    };
  }
  await submitLocator.click();

  const verdict = await waitForVerdict(page);
  if (verdict.status === 'timeout') {
    console.log("Timed out waiting for submit result.");
  }

  return verdict;
}
