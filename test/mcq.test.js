// Drives the real injectMCQAnswer against mock pages that use Scaler's MCQ class names (copied from live captures).
// Regression: friends' runs showed many "Submit timeout (no verdict detected)": a question with 0 attempts left (submit can never work),
// and verdicts that only appear after a reload, were both reported as a failed submission.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from './helpers/browser.js';
import { injectMCQAnswer } from '../mcq_handler.js';

const FAST = { timeScale: 0.05, verdictTimeoutMs: 700 };
const ATTEMPTED = '<span class="status-tag-2 status-tag-2--warning">Attempted</span>';
const SOLVED = '<span class="status-tag-2 status-tag-2--success">Solved</span>';
const UNSOLVED = '<span class="status-tag-2 status-tag-2--attention">Unsolved</span>';

function mcqHtml({ attempts = 2, tag = UNSOLVED, radioAttrs = '', onSubmit = '' }) {
  return `
  <div class="cr-p-heading">Q1. Pick one <span id="tag">${tag}</span></div>
  <div class="cr-multiple-choice-container">
    <div class="cr-multiple-choice-container__hint-chip" id="chip">${attempts} Attempts left</div>
    <div class="cr-multiple-choice"><label><input type="radio" name="a" ${radioAttrs}> Alpha</label></div>
    <div class="cr-multiple-choice"><label><input type="radio" name="a" ${radioAttrs}> Beta</label></div>
    <button class="cr-judge-action cr-judge-action--submit cr-multiple-choice-container__submit disabled" id="submit">Submit</button>
  </div>
  <script>
    window.__submits = 0;
    const submit = document.getElementById('submit');
    document.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => submit.classList.remove('disabled')));
    submit.addEventListener('click', () => { if (submit.classList.contains('disabled')) return; window.__submits++; ${onSubmit} });
  </script>`;
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

/** `pages` is one html string per load of the page: the first load, then each reload. */
async function mcqPage(...pages) {
  const page = await browser.newPage();
  let loads = 0;
  await page.route('https://scaler.test/**', (r) => r.fulfill({ contentType: 'text/html', body: pages[Math.min(loads++, pages.length - 1)] }));
  await page.goto('https://scaler.test/mcq');
  return page;
}
const submits = (page) => page.evaluate(() => window.__submits || 0);

test('a correct answer is reported as a pass when the Solved tag appears', async () => {
  const page = await mcqPage(mcqHtml({ onSubmit: `document.getElementById('tag').innerHTML = '${SOLVED}';` }));
  const res = await injectMCQAnswer(page, 1, FAST);
  assert.equal(res.status, 'pass');
  assert.equal(await submits(page), 1);
  await page.close();
});

test('a wrong answer is recognised by the attempts counter dropping', async () => {
  const page = await mcqPage(mcqHtml({ attempts: 2, onSubmit: `document.getElementById('chip').textContent = '1 Attempts left';` }));
  const res = await injectMCQAnswer(page, 0, FAST);
  assert.deepEqual([res.status, res.verdict], ['fail', 'Incorrect']);
  await page.close();
});

test('0 attempts left: nothing is clicked or submitted, and the result says so instead of timing out', async () => {
  const page = await mcqPage(mcqHtml({ attempts: 0, tag: ATTEMPTED }));
  const res = await injectMCQAnswer(page, 0, FAST);
  assert.equal(res.exhausted, true);
  assert.equal(res.unconfirmed, true);
  assert.match(res.verdict, /No attempts left/);
  assert.equal(await submits(page), 0);
  await page.close();
});

test('a verdict that only shows after a reload is still found (instead of "Submit timeout")', async () => {
  // The first load is the question; the submit repaints nothing; after a reload the page shows the burned attempt.
  const page = await mcqPage(mcqHtml({ attempts: 2 }), mcqHtml({ attempts: 1, tag: ATTEMPTED }));
  const res = await injectMCQAnswer(page, 0, FAST);
  assert.deepEqual([res.status, res.verdict], ['fail', 'Incorrect']);
  await page.close();
});

test('and a correct answer that only shows after a reload is a pass', async () => {
  const page = await mcqPage(mcqHtml({ attempts: 2 }), mcqHtml({ attempts: 1, tag: SOLVED }));
  const res = await injectMCQAnswer(page, 1, FAST);
  assert.equal(res.status, 'pass');
  await page.close();
});

test('nothing changes even after a reload: an unconfirmed result, which the caller must not treat as a wrong option', async () => {
  const page = await mcqPage(mcqHtml({ attempts: 2 }));
  const res = await injectMCQAnswer(page, 0, FAST);
  assert.equal(res.status, 'fail');
  assert.match(res.verdict, /Submit timeout/);
  assert.equal(res.unconfirmed, true);
  await page.close();
});

test('if the option click does not register, nothing is submitted', async () => {
  const page = await mcqPage(mcqHtml({ attempts: 2, radioAttrs: 'onclick="event.preventDefault()"' }));
  const res = await injectMCQAnswer(page, 0, FAST);
  assert.equal(res.status, 'fail');
  assert.match(res.verdict, /did not register/);
  assert.equal(res.unconfirmed, true);
  assert.equal(await submits(page), 0);
  await page.close();
});
