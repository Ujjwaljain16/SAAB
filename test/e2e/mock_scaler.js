// Mock Scaler site for end-to-end tests. Loaded by main.js through SAAB_TEST_ROUTES; every www.scaler.com request is
// answered from here and everything else is blocked, so nothing ever reaches the real site.
//
// Problems on the mock class (all MCQ):
//   1  table says SOLVED                                  -> must never even be opened
//   2  genuinely unsolved                                 -> the ONLY one that may be solved/submitted
//   3  table says Unsolved, but the problem PAGE says Solved -> must be opened, noticed and left alone
//   5  table says Unsolved, but the DOCK says solved      -> must never be opened (table/dock disagreement)
// Plus the junk links Scaler really renders per row (/submissions, /help-requests).
import fs from 'node:fs';

const BASE = '/academy/mentee-dashboard/class/100/assignment/problems';

export const PROBLEMS = {
  1: { title: 'Q1. Already solved in table', tableStatus: 'Solved', score: '50.0/50', pageSolved: true },
  2: { title: 'Q2. Genuinely unsolved', tableStatus: 'Unsolved', score: '0/50', pageSolved: false },
  3: { title: 'Q3. Solved but table is stale', tableStatus: 'Unsolved', score: '0/50', pageSolved: true },
  5: { title: 'Q5. Solved per dock only', tableStatus: 'Unsolved', score: '0/50', pageSolved: false, dockSolved: true }
};

const page = (body, title = 'Mock') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function dashboardHtml() {
  return page(`<div class="dropdown__title">SEM MOCK (Term 1)</div>
    <a href="/academy/mentee-dashboard/core-curriculum/m/1/classes">SUBJECT - 1 Mock DevOps</a>`);
}

function classesHtml() {
  // Structure copied from a real capture of the classes page: every class has THREE anchors with data-cy="classroom-link"
  // (titled link, the "x / y" assignment-progress link, and an empty overlay link). Classes without an assignment (labs) have no
  // progress link at all, and the page also carries non-class cards such as "View Details" / "Start Contest".
  const origin = 'https://www.scaler.com/academy/mentee-dashboard/class';
  return page(`
    <div><a class="me-cr-classroom-url t" data-cy="classroom-link" href="${origin}/100">Mock Class A</a>
         <a class="me-cr-classroom-url p" data-cy="classroom-link" href="${origin}/100/assignment">1 / 4</a>
         <a class="me-cr-classroom-url" data-cy="classroom-link" href="${origin}/100"></a></div>
    <div><a class="me-cr-classroom-url t" data-cy="classroom-link" href="${origin}/101">Mock Lab 1</a>
         <a class="me-cr-classroom-url" data-cy="classroom-link" href="${origin}/101"></a></div>
    <div><a class="me-cr-classroom-url t" data-cy="classroom-link" href="${origin}/102">Finished Class</a>
         <a class="me-cr-classroom-url p" data-cy="classroom-link" href="${origin}/102/assignment">7 / 7</a>
         <a class="me-cr-classroom-url" data-cy="classroom-link" href="${origin}/102"></a></div>
    <div><a class="me-cr-classroom-url" data-cy="classroom-link" href="${origin}/103">Start Contest</a></div>`);
}

function tableHtml() {
  const rows = Object.entries(PROBLEMS).map(([id, p]) => `
    <tr class="table__row">
      <td><a class="me-cr-classroom-url me-cr-problem-list__name" href="${BASE}/${id}?navref=cl_tt_lst_nm">${p.title}</a></td>
      <td>Easy</td><td>${p.score}</td><td>${p.tableStatus}</td>
      <td><a class="me-cr-classroom-url primary link" href="${BASE}/${id}/submissions?navref=cl_tt_lst_sbs">0 submissions</a></td>
      <td><a class="me-cr-classroom-url me-cr-problem-actions__icons" href="${BASE}/${id}/help-requests?navref=cl_tt_lst_hr"></a>
          <a class="me-cr-classroom-url me-cr-problem-actions__btn" href="${BASE}/${id}?navref=cl_tt_lst_sl">Solve</a></td>
    </tr>`).join('');
  const dock = Object.entries(PROBLEMS).map(([id, p]) =>
    `<a class="cr-p-navigation-dock-item me-cr-p-nav-dock-item${p.dockSolved ? ' cr-p-navigation-dock-item--success' : ''}" href="${BASE}/${id}?navref=cl_tt_nv">Q ${id}</a>`).join('');
  return page(`${dock}<table><tr class="table__row"><th>Name</th><th>Status</th></tr>${rows}</table>`);
}

export function problemHtml(id) {
  const p = PROBLEMS[id];
  const tag = p.pageSolved
    ? '<span class="status-tag-2 status-tag-2--success">Solved</span>'
    : '<span class="status-tag-2">Unsolved</span>';
  return page(`
    <div class="cr-p-heading" id="heading">${p.title} <span class="status-tag-2 status-tag-2--warning">Mandatory</span> <span id="state">${tag}</span></div>
    <div class="cr-p-statement">Which statement about question ${id} is correct? Choose exactly one option.</div>
    ${['Alpha option', 'Beta option', 'Gamma option', 'Delta option'].map((t, i) =>
      `<div class="cr-multiple-choice"><label class="cr-multiple-choice__label"><input type="radio" name="o" value="${i}"> ${t}</label></div>`).join('')}
    <button class="cr-multiple-choice-container__submit" id="submit" disabled>Submit</button>
    <script>
      document.querySelectorAll('input[name=o]').forEach((el) => el.addEventListener('change', () => { document.getElementById('submit').disabled = false; }));
      document.getElementById('submit').addEventListener('click', () => {
        fetch('/__submit/${id}', { method: 'POST' });
        document.getElementById('state').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>';
      });
    </script>`, `${p.title} - Problem`);
}

export async function setup(ctx) {
  const log = (line) => { if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, `${line}\n`); };

  // Later registrations win, so: block everything first, then answer scaler.com.
  await ctx.route('**/*', (route) => route.abort());
  await ctx.route(/^https:\/\/(www\.)?scaler\.com\//, (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/\/+$/, '');
    const send = (body) => route.fulfill({ status: 200, contentType: 'text/html', body });

    if (p === '/academy/mentee-dashboard/core-curriculum') return send(dashboardHtml());
    if (p === '/academy/mentee-dashboard/core-curriculum/m/1/classes') return send(classesHtml());
    if (p === BASE) return send(tableHtml());

    const submit = p.match(/^\/__submit\/(\d+)$/);
    if (submit) { log(`submit ${submit[1]}`); return route.fulfill({ status: 200, body: 'ok' }); }

    const prob = p.match(new RegExp(`^${BASE}/(\\d+)$`));
    if (prob && PROBLEMS[prob[1]]) { log(`visit ${prob[1]}`); return send(problemHtml(prob[1])); }

    log(`other ${p}`);
    return route.fulfill({ status: 404, contentType: 'text/html', body: page('not found') });
  });
}
