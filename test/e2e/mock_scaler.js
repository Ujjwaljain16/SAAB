// Mock Scaler site for end-to-end tests. Loaded by main.js through SAAB_TEST_ROUTES; every www.scaler.com request is
// answered from here and everything else is blocked, so nothing ever reaches the real site.
//
// Problems on the mock class (all MCQ):
//   1  table says SOLVED                                     -> must never even be opened
//   2  genuinely unsolved (seeded answer is right)           -> solved on the first try
//   3  table says Unsolved, but the problem PAGE says Solved -> must be opened, noticed and left alone
//   5  table says Unsolved, but the DOCK says solved         -> must never be opened (table/dock disagreement)
//   6  right answer is option 2 -> needs 3 tries (0, 1 wrong; 2 right)
//   7  right answer is option 1 -> needs 2 tries (0 wrong; 1 right)
//   8  right answer is option 3 -> never reached in 3 tries (0, 1, 2 wrong): must be given up on, and left alone on re-runs
// A wrong answer leaves the page "Attempted" and lowers the "N Attempts left" chip, like the real page does.
// Plus the junk links Scaler really renders per row (/submissions, /help-requests).
import fs from 'node:fs';

const BASE = '/academy/mentee-dashboard/class/100/assignment/problems';
const START_ATTEMPTS = 3;

export const PROBLEMS = {
  1: { title: 'Q1. Already solved in table', tableStatus: 'Solved', score: '50.0/50', pageSolved: true },
  2: { title: 'Q2. Genuinely unsolved', tableStatus: 'Unsolved', score: '0/50', pageSolved: false, correct: 1 },
  3: { title: 'Q3. Solved but table is stale', tableStatus: 'Unsolved', score: '0/50', pageSolved: true },
  5: { title: 'Q5. Solved per dock only', tableStatus: 'Unsolved', score: '0/50', pageSolved: false, dockSolved: true },
  6: { title: 'Q6. Needs three tries', tableStatus: 'Unsolved', score: '0/50', pageSolved: false, correct: 2 },
  7: { title: 'Q7. Needs two tries', tableStatus: 'Unsolved', score: '0/50', pageSolved: false, correct: 1 },
  8: { title: 'Q8. Never gets solved', tableStatus: 'Unsolved', score: '0/50', pageSolved: false, correct: 3 }
};

// Server-side state of this mock process: id -> { attempts, solved }
const state = {};

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
         <a class="me-cr-classroom-url p" data-cy="classroom-link" href="${origin}/100/assignment">1 / 7</a>
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

const TAG = {
  solved: '<span class="status-tag-2 status-tag-2--success status-tag-2--small">Solved</span>',
  attempted: '<span class="status-tag-2 status-tag-2--warning status-tag-2--small">Attempted</span>',
  unsolved: '<span class="status-tag-2 status-tag-2--attention status-tag-2--small">Unsolved</span>'
};

export function problemHtml(id, st = state[id] || {}) {
  const p = PROBLEMS[id];
  const solved = p.pageSolved || st.solved;
  const attempts = st.attempts || 0;
  const tag = solved ? TAG.solved : attempts > 0 ? TAG.attempted : TAG.unsolved;
  return page(`
    <div class="cr-p-heading" id="heading">${p.title} <span class="status-tag-2 status-tag-2--warning status-tag-2--default">Mandatory</span> <span id="state">${tag}</span></div>
    <div class="cr-p-statement">Which statement about question ${id} is correct? Choose exactly one option.</div>
    <div class="cr-multiple-choice-container">
      <div class="cr-multiple-choice-container__heading">Choose the correct answer from below : <span class="cr-multiple-choice-container__hint-chip" id="chip">${START_ATTEMPTS - attempts} Attempts left</span></div>
      ${['Alpha option', 'Beta option', 'Gamma option', 'Delta option'].map((t, i) =>
        `<div class="cr-multiple-choice"><label class="cr-multiple-choice__radio"><input type="radio" name="o" value="${i}"><span class="cr-multiple-choice__label">${t}</span></label></div>`).join('')}
      <button class="tappable disabled ce-btn btn btn-primary cr-judge-action cr-judge-action--submit cr-multiple-choice-container__submit" id="submit">Submit</button>
    </div>
    <script>
      const TAGS = ${JSON.stringify(TAG)};
      document.querySelectorAll('input[name=o]').forEach((el) => el.addEventListener('change', () => { document.getElementById('submit').classList.remove('disabled'); }));
      document.getElementById('submit').addEventListener('click', async () => {
        const chosen = document.querySelector('input[name=o]:checked')?.value;
        const res = await fetch('/__submit/${id}?choice=' + chosen, { method: 'POST' });
        const { correct, attemptsLeft } = await res.json();
        document.getElementById('state').innerHTML = correct ? TAGS.solved : TAGS.attempted;
        document.getElementById('chip').textContent = attemptsLeft + ' Attempts left';
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
    if (submit) {
      const id = submit[1];
      const choice = Number(url.searchParams.get('choice'));
      const st = (state[id] = state[id] || { attempts: 0, solved: false });
      const correct = !st.solved && choice === PROBLEMS[id]?.correct;
      if (correct) st.solved = true; else st.attempts += 1;
      log(`submit ${id}`);
      log(`choice ${id} ${choice}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ correct, attemptsLeft: Math.max(0, START_ATTEMPTS - st.attempts) }) });
    }

    const prob = p.match(new RegExp(`^${BASE}/(\\d+)$`));
    if (prob && PROBLEMS[prob[1]]) { log(`visit ${prob[1]}`); return send(problemHtml(prob[1])); }

    log(`other ${p}`);
    return route.fulfill({ status: 404, contentType: 'text/html', body: page('not found') });
  });
}
