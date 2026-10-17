// Fixtures copied from REAL Scaler page captures (class names exactly as served; text/ids anonymised).
// Captured pages: a problems table (homework section), an UNSOLVED MCQ, an ATTEMPTED coding problem, and a SOLVED lab.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from './helpers/browser.js';
import { SEL } from '../config.js';
import { slurpMCQContext } from '../mcq_handler.js';
import { collectAssignmentProblems, detectProblemType, getProblemSolveState, isProblemHref, looksSolved } from '../scaler_page.js';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function pageWith(html, title = 'Problem | Scaler Academy') {
  const page = await browser.newPage();
  await page.route('https://www.scaler.com/**', (r) => r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>` }));
  await page.goto('https://www.scaler.com/p');
  return page;
}

const heading = (title, tags) => `<div class="cr-p-heading space-between"><div class="cr-p-heading__text">${title}
  <span class="status-tag-2 status-tag-2--warning status-tag-2--default">Mandatory</span> ${tags} Export</div></div>`;

// ---- Problems table: the real status vocabulary and score formats -------------------------------------------------------------------
const ROW = (n, title, scoreAndStatus) => `<tr class="table__row">
  <td><a class="me-cr-classroom-url me-cr-problem-list__name" href="/academy/mentee-dashboard/class/9/assignment/problems/${n}?navref=cl_tt_lst_nm">${title}</a></td>
  <td>Medium</td><td>${scoreAndStatus}</td>
  <td><a class="me-cr-classroom-url primary link" href="/academy/mentee-dashboard/class/9/assignment/problems/${n}/submissions?navref=cl_tt_lst_sbs">2 submissions</a></td>
  <td><a class="me-cr-classroom-url me-cr-problem-actions__icons" href="/academy/mentee-dashboard/class/9/assignment/problems/${n}/help-requests?navref=cl_tt_lst_hr"></a>
      <a class="me-cr-classroom-url me-cr-problem-actions__btn" href="/academy/mentee-dashboard/class/9/assignment/problems/${n}?navref=cl_tt_lst_sl">Solve</a></td><td>77</td></tr>`;

test('real status vocabulary: Solved wins over a partial score; Attempted and Unsolved are pending', async () => {
  const page = await pageWith(`<table>
    <tr class="table__row"><th>Name of the Problem</th><th>Type</th><th>Difficulty</th><th>Score</th><th>Status</th><th>Submissions</th><th>Actions</th><th>Solved By</th></tr>
    ${ROW(1, 'Q1. Number of islands', '300.0/ 300 Solved')}
    ${ROW(2, 'Q2. Cycle in Directed Graph', '0.0/ 200 Attempted')}
    ${ROW(3, 'Q3. First Depth First Search', '150.0/ 300 Solved')}
    ${ROW(4, 'Q4. Brand new', '0.0/ 100 Unsolved')}
  </table>`);
  const problems = await collectAssignmentProblems(page);
  await page.close();

  assert.deepEqual(problems.map((p) => p.title), ['Q1. Number of islands', 'Q2. Cycle in Directed Graph', 'Q3. First Depth First Search', 'Q4. Brand new']);
  assert.deepEqual(problems.map((p) => p.isSolved), [true, false, true, false],
    'row 3 is Solved despite 150/300; the Attempted and Unsolved rows must stay pending');

  assert.equal(looksSolved('Q3 Medium 150.0/ 300 Solved 8 submissions Solve 67'), true);
  assert.equal(looksSolved('Q2 Easy 0.0/ 200 Attempted 1 submissions Solve 72'), false);
});

test('"Additional Problems" (homework) are out of scope by default: their links are never treated as questions', async () => {
  assert.equal(isProblemHref('/academy/mentee-dashboard/class/511770/homework/problems/4702?navref=cl_tt_lst_sl'), false);
  assert.equal(isProblemHref('/academy/mentee-dashboard/class/511770/assignment/problems/4702?navref=cl_tt_lst_sl'), true);

  const page = await pageWith(`<table><tr class="table__row"><td>
    <a class="me-cr-problem-list__name" href="/academy/mentee-dashboard/class/511770/homework/problems/4702?navref=cl_tt_lst_nm">Q1. Number of islands</a>
    <a class="me-cr-problem-actions__btn" href="/academy/mentee-dashboard/class/511770/homework/problems/4702?navref=cl_tt_lst_sl">Solve</a></td><td>0/300 Unsolved</td></tr></table>`);
  assert.deepEqual(await collectAssignmentProblems(page), [], 'a homework table yields nothing to solve');
  await page.close();
});

// ---- Unsolved MCQ ----------------------------------------------------------------------------------------------------------------------
const MCQ_HTML = `${heading('Q5. Closures - 3', '<span class="status-tag-2 status-tag-2--attention status-tag-2--small">Unsolved</span>')}
  <div class="html-content__container cr-p-statement">What is a closure in JavaScript?</div>
  <div class="cr-multiple-choice-container">
    <div class="cr-multiple-choice-container__heading">Choose the correct answer from below : <span class="cr-multiple-choice-container__hint-chip">2 Attempts left</span></div>
    <div class="cr-multiple-choice-container__choices">
      ${['A function that has access to its parent scope', 'A function that does not have access to its parent scope', 'An object that maintains the state of a variable', 'An object that holds a function and its corresponding environment'].map((t) =>
        `<div class="cr-multiple-choice"><label class="sr-radio-button cr-multiple-choice__radio"><input type="radio" name="a"><span class="sr-radio-button__text cr-multiple-choice__label">${t}</span></label></div>`).join('')}
    </div>
    <div class="row align-c space-between"><div class="row flex-ac justify-end">
      <button class="tappable disabled ce-btn btn btn-primary cr-judge-action cr-judge-action--submit cr-multiple-choice-container__submit">Submit</button></div></div>
  </div>`;

test('real unsolved MCQ page: unsolved, detected as mcq, options and attempts parsed, submit button found', async () => {
  const page = await pageWith(MCQ_HTML, 'Closures - 3 - Problem | Scaler Academy');
  assert.equal(await getProblemSolveState(page, { wait: false }), 'unsolved');
  assert.equal(await detectProblemType(page), 'mcq');

  const content = await slurpMCQContext(page);
  assert.equal(content.title, 'Closures - 3');
  assert.equal(content.body, 'What is a closure in JavaScript?');
  assert.equal(content.options.length, 4);
  assert.equal(content.options[3].text, 'An object that holds a function and its corresponding environment');
  assert.equal(content.attemptsLeft, 2, 'the "2 Attempts left" chip is read');

  const submit = page.locator('button.cr-multiple-choice-container__submit, button.cr-judge-action--submit').first();
  assert.equal((await submit.innerText()).trim(), 'Submit');
  assert.ok((await submit.getAttribute('class')).includes('disabled'));
  await page.close();
});

test('attemptsLeft is null when the page does not say, and 0 when none remain', async () => {
  const none = await pageWith(MCQ_HTML.replace(/<span class="cr-multiple-choice-container__hint-chip">.*?<\/span>/, ''));
  assert.equal((await slurpMCQContext(none)).attemptsLeft, null);
  await none.close();

  const zero = await pageWith(MCQ_HTML.replace('2 Attempts left', '0 Attempts left'));
  assert.equal((await slurpMCQContext(zero)).attemptsLeft, 0);
  await zero.close();
});

// ---- Attempted coding problem ----------------------------------------------------------------------------------------------------------
const CODING_HTML = `${heading('Q2. Cycle in Directed Graph', '<span class="status-tag-2 status-tag-2--warning status-tag-2--small">Attempted</span>')}
  <div class="html-content__container cr-p-statement">Problem Description Given a directed graph...</div>
  <div class="monaco-editor"><textarea class="inputarea monaco-mouse-cursor-text"></textarea></div>
  <input id="react-select-2-input" type="text">
  <a class="tappable disabled cr-expected-output__run-btn btn btn-small btn-primary bold cr-expected-output__disabled-btn">Run</a>
  <button class="tappable ce-btn btn btn-inverted btn-small btn-primary bold m-r-10">Test</button>
  <a id="test_with_custom_input" class="tappable btn btn-inverted btn-small btn-primary bold m-r-10">Test with custom input</a>
  <button class="tappable ce-btn btn btn-primary cr-judge-action cr-judge-action--submit btn btn-primary btn-small btn-long">Submit</button>`;

test('real attempted coding page: pending (not solved), detected as coding, and the Submit button (not Test) is selected', async () => {
  const page = await pageWith(CODING_HTML, 'Cycle in Directed Graph - Problem | Scaler Academy');
  assert.equal(await getProblemSolveState(page, { wait: false }), 'attempted');
  assert.equal(await detectProblemType(page), 'coding');

  const submit = page.locator(SEL.submitBtn).first();
  assert.equal((await submit.innerText()).trim(), 'Submit', 'must not pick the Test button');
  assert.ok((await page.locator(SEL.problemLanguageInput).count()) > 0, 'language picker input is found');
  await page.close();
});

// ---- Solved lab --------------------------------------------------------------------------------------------------------------------------
const LAB_HTML = `${heading('Q2. Using chown', '<span class="status-tag-2 status-tag-2--success status-tag-2--small">Solved</span>')}
  <div class="cr-infra-mage-judge"><div class="LaunchButton-module_container__CP50v"><a class="Tappable-module_root__N7ll5 LaunchButton-module_btn__o1LoJ">Launch Lab</a></div></div>
  <div class="cr-infra-mage-judge__test-case-container"><div class="StageTestCases-module_container__8VzxM">
    <div class="Tabs-module_header__P6Obr tabs__header"><div class="Tabs-module_tab__-IMuw Tabs-module_active__5BbQJ">Solve Task 1</div><div class="Tabs-module_tab__-IMuw Tabs-module_disabled__7msDv">Solve Task 2</div></div>
    <div class="StageTestCases-module_testCasesContainer__ePRAS">Click on "Submit" button to see the output here...</div></div></div>
  <div class="cr-infra-mage-judge__code-actions">
    <div class="StageResetWarningModal-module_container__1y-Cj" style="display:none"><div class="StageResetWarningModal-module_buttonContainer__bymNP">
      <a class="Tappable-module_root__N7ll5 StageResetWarningModal-module_cancelButton__-y0Yi">Cancel</a>
      <a class="Tappable-module_root__N7ll5 StageResetWarningModal-module_proceedButton__-erRt">Run Task</a></div></div>
    <a class="Tappable-module_root__N7ll5 Tappable-module_disabled__XhpfV Submit-module_btn__tpMzw btn btn-primary btn-small btn-long">Run Task</a>
  </div>`;

test('real lab page: detected as lab, solved state read, the REAL Run Task button is chosen (not the hidden modal link before it)', async () => {
  const page = await pageWith(LAB_HTML, 'Using chown - Problem | Scaler Academy');
  assert.equal(await detectProblemType(page), 'lab');
  assert.equal(await getProblemSolveState(page, { wait: false }), 'solved');

  const run = page.locator(SEL.labSubmitBtn).first();
  assert.ok(await run.isVisible(), 'the visible Run Task button must be what gets clicked');
  assert.ok((await run.getAttribute('class')).includes('Submit-module_btn'));

  // The old text-based selector would have matched the hidden modal link first (it precedes the real button in the DOM).
  const naive = page.locator('a:has-text("Run Task")').first();
  assert.equal(await naive.isVisible(), false, 'documents the trap: the first text match is the hidden modal link');

  assert.ok((await page.locator(SEL.labTestCases).first().innerText()).includes('Click on "Submit"'));
  await page.close();
});

test('MCQ verdict state ignores free text: a title with "solved" in it neither passes nor fails a submission by itself', async () => {
  const { readMcqState } = await import('../mcq_handler.js');
  const wrong = await pageWith(MCQ_HTML.replace('Q5. Closures - 3', 'Q5. Never gets solved').replace('Unsolved', 'Attempted').replace('2 Attempts left', '1 Attempts left'));
  const s = await readMcqState(wrong);
  assert.equal(s.solved, false, 'title words must not count as Solved');
  assert.equal(s.attempted, true);
  assert.equal(s.attemptsLeft, 1);
  await wrong.close();

  const right = await pageWith(MCQ_HTML.replace('status-tag-2--attention status-tag-2--small">Unsolved', 'status-tag-2--success status-tag-2--small">Solved'));
  assert.equal((await readMcqState(right)).solved, true);
  await right.close();
});

// ---- Page-type detection must not be fooled by words in the problem statement -------------------------------------------------------
test('a lab whose statement mentions "VS Code" is still a lab (regression: Q3 was classified as vscode live)', async () => {
  const withMention = LAB_HTML.replace('<div class="cr-infra-mage-judge">', '<div class="html-content__container cr-p-statement">Tip: you may also use VS Code locally, then use the lab terminal.</div><div class="cr-infra-mage-judge">');
  const page = await pageWith(withMention);
  assert.equal(await detectProblemType(page), 'lab');
  await page.close();
});

test('VS Code detection needs a real IDE container or an actual "Open IDE" button, never just the words', async () => {
  const mention = await pageWith(`${heading('Q1', '<span class="status-tag-2">Unsolved</span>')}
    <div class="html-content__container cr-p-statement">Edit the file in VS Code and run the tests.</div>
    <div class="monaco-editor"></div>`);
  assert.equal(await detectProblemType(mention), 'coding', 'words alone must not make it an IDE problem');
  await mention.close();

  const open = await pageWith(`${heading('Q2', '<span class="status-tag-2">Unsolved</span>')}<a class="btn">Open IDE</a>`);
  assert.equal(await detectProblemType(open), 'vscode');
  await open.close();

  const openVs = await pageWith(`${heading('Q3', '<span class="status-tag-2">Unsolved</span>')}<button>Open in VS Code</button>`);
  assert.equal(await detectProblemType(openVs), 'vscode');
  await openVs.close();

  const container = await pageWith(`${heading('Q4', '<span class="status-tag-2">Unsolved</span>')}<div id="vscode-ide"></div>`);
  assert.equal(await detectProblemType(container), 'vscode');
  await container.close();
});

test('a stray checkbox on a coding page does not make it an MCQ', async () => {
  const page = await pageWith(`${CODING_HTML}<label><input type="checkbox"> Dark mode</label>`);
  assert.equal(await detectProblemType(page), 'coding');
  await page.close();
});

// ---- What the AI is actually given as "the problem" -----------------------------------------------------------------------------------
import { extractProblemContent } from '../scaler_page.js';

const NAV = '<div><a>Home</a><a>SST Goodies</a><div>Refer Friends to SST</div><div>Join Discord Community</div><div>Learn AND Practice</div></div>';
const FOOTER = '<footer>All subjects and classes</footer>';

test('lab: the AI receives the real task statement, not the navigation bar (regression: it got "HomeSST Goodies")', async () => {
  const statement = 'In this assignment, you will practice basic Linux commands. For each task, store your answer in a file named answer.txt using the echo command. Note: use password user@123! for sudo.';
  const page = await pageWith(`${NAV}${heading('Q1. Basic Linux Commands - 1', '<span class="status-tag-2 status-tag-2--attention">Unsolved</span>')}
    <div class="html-content__container cr-p-statement">${statement}</div><div class="html-content__container cr-p-statement"></div>${LAB_HTML}${FOOTER}`, 'Basic Linux Commands - 1 - Problem | Scaler Academy');
  const got = await extractProblemContent(page);
  await page.close();

  assert.equal(got.title, 'Basic Linux Commands - 1');
  assert.equal(got.body, statement, 'exactly the statement element, nothing from the page chrome');
  assert.ok(!/goodies|refer friends/i.test(got.body));
});

test('extractor fallback: without a statement element, a "Refer Friends" in the top navigation must not truncate the text', async () => {
  const page = await pageWith(`${NAV}<main>Task: create /home/user/a.txt containing the word hello, then print it. Use the terminal on the right.</main>${FOOTER}`);
  const got = await extractProblemContent(page);
  await page.close();

  assert.ok(got.body.includes('create /home/user/a.txt'), `body was: ${JSON.stringify(got.body)}`);
  assert.ok(got.body.length > 40, 'not the 15-character nav stub');
});

test('extractor fallback still starts at "Problem Description" when the page has one', async () => {
  const page = await pageWith(`${NAV}<main>Problem Description Given an array, return its sum. Expected Output 3</main>`);
  const got = await extractProblemContent(page);
  await page.close();
  assert.ok(got.body.startsWith('Problem Description'));
  assert.ok(!/expected output/i.test(got.body), 'still cut at the end marker');
});

// ---- A slow-rendering page must never be mistaken for a coding problem ------------------------------------------------------------------
test('a page whose MCQ renders late is waited for and detected as mcq (regression: it was "solved" as code and failed)', async () => {
  const page = await pageWith(`<div id="root">loading...</div>
    <script>setTimeout(() => { document.getElementById('root').innerHTML = ${JSON.stringify(MCQ_HTML)}; }, 900);</script>`);
  assert.equal(await detectProblemType(page, { timeoutMs: 5000 }), 'mcq');
  await page.close();
});

test('nothing recognisable yet is "unknown", never a guess of "coding"', async () => {
  const page = await pageWith('<div>still loading, nothing to see</div>');
  assert.equal(await detectProblemType(page, { timeoutMs: 400 }), 'unknown');
  await page.close();
});

test('"coding" requires a real code editor on the page', async () => {
  const page = await pageWith(CODING_HTML);
  assert.equal(await detectProblemType(page, { timeoutMs: 2000 }), 'coding');
  await page.close();
});
