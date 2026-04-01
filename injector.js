import { SEL } from './config.js';

function sanitizeFeedback(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
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

      const testOutputMatch = bodyText.match(/Test\s+Output\s*[:\-]?[\s\S]*$/i);
      const feedbackText = testOutputMatch ? testOutputMatch[0] : bodyText;

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
        feedback: sanitizeFeedback(snapshot.feedbackText)
      };
    }

    if (snapshot.hasFailureSignal || (snapshot.finalVerdict && !/correct\s+answer/i.test(snapshot.finalVerdict))) {
      return {
        status: 'fail',
        verdict: snapshot.finalVerdict || 'Failed',
        feedback: sanitizeFeedback(snapshot.feedbackText)
      };
    }

    await page.waitForTimeout(800);
  }

  const fallbackText = await page.locator('body').innerText().catch(() => '');
  return {
    status: 'timeout',
    verdict: 'Timeout waiting for verdict',
    feedback: sanitizeFeedback(fallbackText)
  };
}

export async function injectAndSubmit(page, code) {
  if (!code) {
    console.log("No code provided to inject.");
    return { status: 'fail', verdict: 'No code generated', feedback: 'Solver returned empty code.' };
  }

  // Wait for editor to be ready
  await page.waitForSelector(SEL.editorContainer, { timeout: 10000 });
  await page.click(SEL.editorContainer);
  await page.waitForTimeout(300);

  // Select all existing content and replace
  // Depending on OS, might need Meta+A on Mac, Control+A on Windows
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+A`);
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace'); // Ensure it is cleared
  await page.waitForTimeout(100);

  // Use clipboard to paste (most reliable for Monaco)
  // To use clipboard API safely in headless pages, we grant permissions or evaluate
  await page.evaluate(async (src) => {
    // If navigator.clipboard is unavailable or restricted, fallback to older execCommand or direct text assignment if possible
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(src);
      } else {
        // Fallback for non-https contexts where clipboard API might be disabled
        const textArea = document.createElement("textarea");
        textArea.value = src;
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
    } catch (err) {
      console.warn("Clipboard API failed locally, fallback input may be required.", err);
    }
  }, code);
  
  await page.keyboard.press(`${modifier}+V`);
  await page.waitForTimeout(1000); // Give it a second to syntax parse

  // Dismiss optional helper modal if it appears.
  await page.locator('a:has-text("No! I clicked by mistake")').first().click().catch(() => {});

  // Submit
  await page.click(SEL.submitBtn);

  const verdict = await waitForVerdict(page);
  if (verdict.status === 'timeout') {
    console.log("Timed out waiting for submit result.");
  }

  return verdict;
}
