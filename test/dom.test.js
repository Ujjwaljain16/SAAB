// DOM tests against HTML shaped like the real Scaler problems page (structure captured read-only from a live account,
// names/ids are placeholders). They exist because the dock scan once treated "submissions" and "help-requests" links as questions.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from './helpers/browser.js';
import { collectAssignmentProblems, collectQuestionTabs, getProblemSolveState } from '../scaler_page.js';

const BASE = '/academy/mentee-dashboard/class/570714/assignment/problems';

function row(id, title, { solved }) {
  return `
  <tr class="table__row">
    <td><a class="me-cr-classroom-url me-cr-problem-list__name" href="${BASE}/${id}?navref=cl_tt_lst_nm">${title}</a></td>
    <td>Easy</td>
    <td>${solved ? '50.0/50' : '0/50'}</td>
    <td>${solved ? 'Solved' : 'Unsolved'}</td>
    <td><a class="me-cr-classroom-url primary link" href="${BASE}/${id}/submissions?navref=cl_tt_lst_sbs">${solved ? 2 : 0} submissions</a></td>
    <td>
      <a class="me-cr-classroom-url me-cr-problem-actions__icons" href="${BASE}/${id}/help-requests?navref=cl_tt_lst_hr"></a>
      <a class="me-cr-classroom-url me-cr-problem-actions__btn" href="${BASE}/${id}?navref=cl_tt_lst_sl">Solve</a>
    </td>
    <td>65</td>
  </tr>`;
}

const TABLE_HTML = `
<a class="cr-p-navigation-dock-item" href="/academy/mentee-dashboard/class/570714/assignment/instructions?navref=cl_tt_nv"></a>
<a class="cr-p-navigation-dock-item cr-p-navigation-dock-item--active" href="${BASE}?navref=cl_tt_nv">All</a>
<a class="cr-p-navigation-dock-item me-cr-p-nav-dock-item cr-p-navigation-dock-item--success" href="${BASE}/315185?navref=cl_tt_nv">Q 1</a>
<a class="cr-p-navigation-dock-item me-cr-p-nav-dock-item" href="${BASE}/315186?navref=cl_tt_nv">Q 2</a>
<table>
  <tr class="table__row"><th>Name of the Problem</th><th>Type</th><th>Difficulty</th><th>Score</th><th>Status</th><th>Submissions</th><th>Actions</th><th>Solved By</th></tr>
  ${row(315185, 'Q1. Purpose of Docker', { solved: true })}
  ${row(315186, 'Q2. Docker Object Management', { solved: false })}
</table>`;

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function pageWith(html) {
  const page = await browser.newPage();
  await page.route('https://www.scaler.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${html}</body></html>` }));
  await page.goto('https://www.scaler.com/page');
  return page;
}

test('collectAssignmentProblems returns only real questions, with correct titles and solved flags', async () => {
  const page = await pageWith(TABLE_HTML);
  const problems = await collectAssignmentProblems(page);
  await page.close();

  assert.equal(problems.length, 2, 'header row and extra links must not produce problems');
  assert.deepEqual(problems.map((p) => p.title), ['Q1. Purpose of Docker', 'Q2. Docker Object Management']);
  assert.deepEqual(problems.map((p) => p.isSolved), [true, false]);
  for (const p of problems) {
    assert.match(p.solveUrl, /\/assignment\/problems\/\d+\?navref=cl_tt_lst_sl$/, 'targets the Solve button link');
    assert.ok(!/submissions|help-requests/.test(p.solveUrl));
  }
});

test('collectQuestionTabs ignores submissions / help-requests / instructions / All links', async () => {
  const page = await pageWith(TABLE_HTML);
  const tabs = await collectQuestionTabs(page);
  await page.close();

  assert.ok(tabs.length > 0);
  for (const t of tabs) {
    assert.ok(!/submissions|help-requests|instructions/.test(t.solveUrl), `junk link leaked: ${t.solveUrl}`);
    assert.ok(!/help-requests|submissions/i.test(t.title), `junk title leaked: ${t.title}`);
  }
  const q1 = tabs.find((t) => t.solveUrl.includes('/315185'));
  assert.equal(q1.isSolved, true, 'dock --success class marks solved');
  assert.equal(tabs.find((t) => t.solveUrl.includes('/315186')).isSolved, false);
});

test('getProblemSolveState reads every status tag, not just the first (Mandatory tag comes first)', async () => {
  const solved = await pageWith(`<div class="cr-p-heading">Q1 <span class="status-tag-2 status-tag-2--warning">Mandatory</span> <span class="status-tag-2 status-tag-2--success">Solved</span></div>`);
  assert.equal(await getProblemSolveState(solved), 'solved');
  await solved.close();

  const unsolved = await pageWith(`<div class="cr-p-heading">Q2 <span class="status-tag-2 status-tag-2--warning">Mandatory</span> <span class="status-tag-2 status-tag-2--default">Unsolved</span></div>`);
  assert.equal(await getProblemSolveState(unsolved), 'unsolved');
  await unsolved.close();

  const attempted = await pageWith(`<div class="cr-p-heading">Q3 <span class="status-tag-2">Attempted</span></div>`);
  assert.equal(await getProblemSolveState(attempted), 'attempted');
  await attempted.close();

  const bare = await pageWith('<div class="cr-p-heading">Q4</div>');
  assert.equal(await getProblemSolveState(bare), 'unsolved');
  await bare.close();
});
