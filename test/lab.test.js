// Drives the real lab_handler against a mock page with a "maxwell" iframe terminal.
// Regression: typing used `maxwellFrame.keyboard` (undefined on a Playwright Frame), so EVERY lab died with
// "Cannot read properties of undefined (reading 'type')" right after the first command was announced.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from './helpers/browser.js';

// Isolate every file the solver/cache writes, and make sure no real AI provider can be called.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-lab-test-'));
process.env.SAAB_DATA_DIR = dataDir;
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROK_API_KEY', 'XAI_API_KEY']) process.env[k] = '';
// A fake Groq answers lab prompts (see the fetch stub below); no real provider is ever contacted.
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_MODEL = 'm1';
process.env.GROQ_MODELS = 'm1';
process.env.API_SPACING_MS = '0';

const { solveAndSubmitLab } = await import('../lab_handler.js');
const { commitSolution, makeLabCacheKey } = await import('../solver.js');

const FAST = { timeScale: 0.01, frameWaitAttempts: 3 };

// Fake AI: only a RETRY prompt (one that carries the judge's feedback) gets commands; a first-attempt prompt gets none.
const aiPrompts = [];
globalThis.fetch = async (url, init) => {
  const prompt = JSON.parse(init.body).messages[0].content;
  aiPrompts.push(prompt);
  const commands = /This is a RETRY/.test(prompt) ? ['touch /tmp/a'] : [];
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ commands, reasoning: 'fake' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const TERMINAL_HTML = `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
<script>
  window.typed = [];
  document.querySelector('textarea').addEventListener('keydown', (e) => window.typed.push(e.key));
</script>`;

function mainHtml({ onSubmit }) {
  return `<div class="cr-p-heading" id="h">Lab question</div>
<div class="TestCases-module_container__abc" id="tc"></div>
<iframe src="https://abc.maxwell.test/term"></iframe>
<button class="Submit-module_btn__zzz" id="submit">Submit</button>
<script>document.getElementById('submit').onclick = () => { ${onSubmit} };</script>`;
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => {
  await browser?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function labPage(onSubmit) {
  const page = await browser.newPage();
  await page.route('https://scaler.test/**', (r) => r.fulfill({ contentType: 'text/html', body: mainHtml({ onSubmit }) }));
  await page.route('https://abc.maxwell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: TERMINAL_HTML }));
  await page.goto('https://scaler.test/lab');
  return page;
}

function seed(title, statement, commands) {
  const key = makeLabCacheKey(title, statement);
  commitSolution(key, { commands, reasoning: 'seeded for test' });
  return key;
}

const cacheFile = (key) => path.join(dataDir, '.solver-cache', `${key}.json`);

async function typedInTerminal(page) {
  const frame = page.frames().find((f) => f.url().includes('maxwell'));
  const keys = await frame.evaluate(() => window.typed);
  return keys.map((k) => (k === 'Enter' ? '\n' : k)).join('');
}

test('types every command into the iframe terminal, submits, and passes when Scaler shows Solved', async () => {
  const commands = ['mkdir -p sst_lab', 'touch sst_lab/a.txt'];
  const key = seed('Lab pass', 'make a dir and a file', commands);
  const page = await labPage(`document.getElementById('h').innerHTML = 'Lab question <span class="status-tag-2 status-tag-2--success">Solved</span>';`);

  const result = await solveAndSubmitLab(page, 'Lab pass', 'make a dir and a file', FAST);

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(await typedInTerminal(page), `${commands.join('\n')}\n`);
  assert.ok(fs.existsSync(cacheFile(key)), 'a judged pass keeps the solution cached');
  await page.close();
});

test('a failing judge verdict reports fail and evicts the cached solution', async () => {
  const key = seed('Lab fail', 'do something', ['echo hi']);
  const page = await labPage(`document.getElementById('tc').textContent = 'Wrong Answer: expected file';`);

  const result = await solveAndSubmitLab(page, 'Lab fail', 'do something', FAST);

  assert.equal(result.status, 'fail');
  assert.match(result.verdict, /Wrong Answer/);
  assert.equal(fs.existsSync(cacheFile(key)), false, 'a failed solution must never be replayed from cache');
  await page.close();
});

test('unsafe AI commands are refused before anything is typed', async () => {
  seed('Lab unsafe', 'anything', ['echo ok', 'rm -rf /']);
  const page = await labPage(`document.getElementById('h').innerHTML = 'Lab question <span class="status-tag-2 status-tag-2--success">Solved</span>';`);

  const result = await solveAndSubmitLab(page, 'Lab unsafe', 'anything', FAST);

  assert.equal(result.status, 'fail');
  assert.match(result.verdict, /unsafe/i);
  assert.equal(await typedInTerminal(page), '', 'nothing may reach the terminal');
  await page.close();
});

test('no AI answer and no cache fails cleanly instead of crashing', async () => {
  const page = await labPage(`document.getElementById('h').innerHTML = 'Lab question <span class="status-tag-2 status-tag-2--success">Solved</span>';`);
  const result = await solveAndSubmitLab(page, 'Lab nothing', 'never seen before', FAST);
  assert.equal(result.status, 'fail');
  assert.match(result.verdict, /empty command list/i);
  await page.close();
});

// ---- Real lab markup (copied from a live capture): the hidden reset-warning modal comes BEFORE the real Run Task button ----
const realLabHtml = (onRun) => `
  <div class="cr-p-heading" id="h">Q2. Using chown <span class="status-tag-2 status-tag-2--warning">Mandatory</span> <span id="tag"><span class="status-tag-2 status-tag-2--attention">Unsolved</span></span></div>
  <div class="cr-infra-mage-judge"><div class="LaunchButton-module_container__CP50v"><a class="Tappable-module_root__N7ll5 LaunchButton-module_btn__o1LoJ">Launch Lab</a></div></div>
  <iframe src="https://abc.maxwell.test/term"></iframe>
  <div class="cr-infra-mage-judge__test-case-container"><div class="StageTestCases-module_container__8VzxM"><div class="StageTestCases-module_testCasesContainer__ePRAS" id="tc">Click on "Submit" button to see the output here...</div></div></div>
  <div class="cr-infra-mage-judge__code-actions">
    <div class="StageResetWarningModal-module_container__1y-Cj" id="modal" style="display:none"><div class="StageResetWarningModal-module_buttonContainer__bymNP">
      <a class="Tappable-module_root__N7ll5 StageResetWarningModal-module_cancelButton__-y0Yi" id="cancel">Cancel</a>
      <a class="Tappable-module_root__N7ll5 StageResetWarningModal-module_proceedButton__-erRt" id="proceed">Run Task</a></div></div>
    <a class="Tappable-module_root__N7ll5 Submit-module_btn__tpMzw btn btn-primary btn-small btn-long" id="run">Run Task</a>
  </div>
  <script>
    window.__cancelled = false; window.__confirmed = false;
    document.getElementById('cancel').onclick = () => { window.__cancelled = true; document.getElementById('modal').style.display = 'none'; };
    document.getElementById('proceed').onclick = () => { window.__confirmed = true; };
    document.getElementById('run').onclick = () => { ${onRun} };
  </script>`;

async function realLabPage(onRun) {
  const page = await browser.newPage();
  await page.route('https://scaler.test/**', (r) => r.fulfill({ contentType: 'text/html', body: realLabHtml(onRun) }));
  await page.route('https://abc.maxwell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: TERMINAL_HTML }));
  await page.goto('https://scaler.test/lab');
  return page;
}

test('real lab DOM: clicks the visible Run Task button (not the hidden modal link that precedes it) and passes on the Solved tag', async () => {
  seed('Real lab pass', 'chown a file', ['touch f.txt']);
  const page = await realLabPage(`document.getElementById('tag').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>';`);

  const result = await solveAndSubmitLab(page, 'Real lab pass', 'chown a file', FAST);

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(await page.evaluate(() => window.__confirmed), false, 'the modal link must not be what got clicked');
  await page.close();
});

test('the "running a completed task resets later tasks" warning is CANCELLED, never confirmed, and the lab stops', async () => {
  seed('Real lab reset', 'chown a file', ['touch f.txt']);
  const page = await realLabPage(`document.getElementById('modal').style.display = 'block';`);

  const result = await solveAndSubmitLab(page, 'Real lab reset', 'chown a file', FAST);

  assert.equal(result.status, 'fail');
  assert.match(result.verdict, /reset/i);
  assert.equal(await page.evaluate(() => window.__cancelled), true, 'Cancel was clicked');
  assert.equal(await page.evaluate(() => window.__confirmed), false, 'the reset was NOT confirmed');
  await page.close();
});

test('a lab title containing the word "solved" does not count as a solved lab', async () => {
  seed('Real lab title', 'chown a file', ['touch f.txt']);
  const page = await realLabPage('/* the judge says nothing */');
  await page.evaluate(() => { document.getElementById('h').firstChild.textContent = 'Q2. Never gets solved '; });

  const result = await solveAndSubmitLab(page, 'Real lab title', 'chown a file', FAST);

  assert.notEqual(result.status, 'pass', 'title words are not a Solved status');
  await page.close();
});

// ---- Submit once, then WAIT for the judge; retry with the judge's feedback ---------------------------------------------------------
const runsOf = (page) => page.evaluate(() => window.__runs || 0);
const COUNT = 'window.__runs = (window.__runs || 0) + 1;';

test('a failed try is retried with the judge\'s own feedback and the extra commands are typed into the same terminal', async () => {
  const key = seed('Lab retry', 'make /tmp/a exist', ['echo first']);
  aiPrompts.length = 0;
  const page = await realLabPage(`${COUNT}
    if (window.__runs === 1) document.getElementById('tc').textContent = 'Test case failed: expected /tmp/a to exist';
    if (window.__runs === 2) document.getElementById('tag').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>';`);

  const result = await solveAndSubmitLab(page, 'Lab retry', 'make /tmp/a exist', { ...FAST, maxTries: 3 });

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(await runsOf(page), 2, 'submitted once per try, never blindly in between');
  assert.equal(await typedInTerminal(page), 'echo first\ntouch /tmp/a\n', 'first the cached commands, then the corrective ones');

  const retryPrompt = aiPrompts.at(-1);
  assert.match(retryPrompt, /This is a RETRY/);
  assert.match(retryPrompt, /expected \/tmp\/a to exist/, 'the judge\'s feedback reaches the AI');
  assert.match(retryPrompt, /echo first/, 'and so does what was already run');

  const saved = JSON.parse(fs.readFileSync(cacheFile(key), 'utf-8'));
  assert.deepEqual(saved.commands, ['echo first', 'touch /tmp/a'], 'the verified solution replays everything that was needed');
  await page.close();
});

test('a slow judge is waited for: the button is pressed once, not again while grading is still running', async () => {
  seed('Lab slow', 'x', ['echo hi']);
  const page = await realLabPage(`${COUNT}
    document.getElementById('tc').textContent = 'Running tests...';
    setTimeout(() => { document.getElementById('tc').textContent = 'Test Case Failed: output differs'; }, 250);`);

  const result = await solveAndSubmitLab(page, 'Lab slow', 'x', { ...FAST, maxTries: 1 });

  assert.equal(result.status, 'fail');
  assert.match(result.feedback, /output differs/, 'the final result is reported, not the transient "Running" text');
  assert.equal(await runsOf(page), 1);
  await page.close();
});

test('an unexpected failure wording is still recognised as a result (no guessed phrase needed) and does not trigger re-clicks', async () => {
  seed('Lab wording', 'x', ['echo hi']);
  const page = await realLabPage(`${COUNT} document.getElementById('tc').textContent = 'Oops: file /tmp/x is missing (code 7)';`);

  const result = await solveAndSubmitLab(page, 'Lab wording', 'x', { ...FAST, maxTries: 1 });

  assert.equal(result.status, 'fail');
  assert.match(result.feedback, /code 7/);
  assert.equal(await runsOf(page), 1, 'the old loop would have clicked up to 10 times here');
  await page.close();
});

test('if the judge never answers the lab times out after ONE click', async () => {
  seed('Lab silent', 'x', ['echo hi']);
  const page = await realLabPage(`${COUNT} /* the judge says nothing */`);

  const result = await solveAndSubmitLab(page, 'Lab silent', 'x', { ...FAST, maxTries: 1 });

  assert.equal(result.status, 'fail');
  assert.equal(result.verdict, 'Evaluation timeout');
  assert.equal(await runsOf(page), 1);
  await page.close();
});

test('the "Only 1 lab session is allowed" prompt is answered even when it appears LATE (regression: the lab waited 2 minutes for a terminal that could not start)', async () => {
  seed('Lab late prompt', 'x', ['echo hi']);
  const page = await browser.newPage();
  await page.route('https://scaler.test/**', (r) => r.fulfill({ contentType: 'text/html', body: `
    <div class="cr-p-heading" id="h">Q2. Using chown <span id="tag"><span class="status-tag-2 status-tag-2--attention">Unsolved</span></span></div>
    <div class="cr-infra-mage-judge" id="stage"><div class="LaunchButton-module_container__CP50v"><a id="launch" class="Tappable-module_root__N7ll5 LaunchButton-module_btn__o1LoJ">Launch Lab</a></div></div>
    <div class="StageTestCases-module_container__8VzxM"><div class="StageTestCases-module_testCasesContainer__ePRAS" id="tc">Click on "Submit" button to see the output here...</div></div>
    <a class="Tappable-module_root__N7ll5 Submit-module_btn__tpMzw" id="run">Run Task</a>
    <script>
      window.__ended = false;
      document.getElementById('launch').onclick = () => {
        document.getElementById('stage').innerHTML = '';
        // the prompt shows up well after the launch click, i.e. AFTER the handler's one-off early check
        setTimeout(() => {
          document.getElementById('stage').innerHTML = '<div>Only 1 lab session(s) is allowed at a time</div><a id="endprev">End Previous Lab</a><a id="cancel">Cancel</a>';
          document.getElementById('endprev').onclick = () => {
            window.__ended = true;
            document.getElementById('stage').innerHTML = '<iframe src="https://abc.maxwell.test/term"></iframe>';
          };
        }, 400);
      };
      document.getElementById('run').onclick = () => { document.getElementById('tag').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>'; };
    </script>` }));
  await page.route('https://abc.maxwell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: TERMINAL_HTML }));
  await page.goto('https://scaler.test/lab');

  const result = await solveAndSubmitLab(page, 'Lab late prompt', 'x', { timeScale: 0.01, frameWaitAttempts: 200 });

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(await page.evaluate(() => window.__ended), true, 'End Previous Lab was clicked when it appeared');
  await page.close();
});

// ---- sudo: the lab statement hands out the password; the agent must use it ------------------------------------------------------------
const SUDO_STATEMENT = 'Change the owner of /opt/app to user.\nUse password user@123! if required for sudo access';
const SUDO_PRIME = `echo 'user@123!' | sudo -S -p '' -v`;

test('a lab that gives a sudo password: the credential is cached first, with the password from the statement (not from the AI)', async () => {
  seed('Lab sudo', SUDO_STATEMENT, ['sudo chown -R user /opt/app', 'ls -l /opt']);
  const page = await realLabPage(`document.getElementById('tag').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>';`);

  const result = await solveAndSubmitLab(page, 'Lab sudo', SUDO_STATEMENT, FAST);

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(await typedInTerminal(page), `${SUDO_PRIME}\nsudo chown -R user /opt/app\nls -l /opt\n`);
  await page.close();
});

test('no sudo in the commands: nothing about passwords is typed', async () => {
  seed('Lab no sudo', SUDO_STATEMENT, ['touch /tmp/x']);
  const page = await realLabPage(`document.getElementById('tag').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>';`);

  await solveAndSubmitLab(page, 'Lab no sudo', SUDO_STATEMENT, FAST);

  assert.equal(await typedInTerminal(page), 'touch /tmp/x\n');
  await page.close();
});

test('if sudo still stops at a [sudo] password prompt, it is answered before the next command is typed', async () => {
  seed('Lab sudo prompt', SUDO_STATEMENT, ['sudo chown -R user /opt/app', 'ls -l /opt']);
  const page = await browser.newPage();
  await page.route('https://scaler.test/**', (r) => r.fulfill({ contentType: 'text/html', body: realLabHtml(`document.getElementById('tag').innerHTML = '<span class="status-tag-2 status-tag-2--success">Solved</span>';`) }));
  // A terminal that behaves like a sudo with no credential cache: the real command (not the priming one) asks for a password.
  await page.route('https://abc.maxwell.test/**', (r) => r.fulfill({ contentType: 'text/html', body: `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea><div class="xterm-rows"><div id="row"></div></div></div>
<script>
  window.typed = []; let line = '';
  document.querySelector('textarea').addEventListener('keydown', (e) => {
    window.typed.push(e.key);
    if (e.key.length === 1) { line += e.key; return; }
    if (e.key === 'Enter') {
      if (line.startsWith('sudo chown')) document.getElementById('row').textContent = '[sudo] password for user:';
      else if (line === 'user@123!') document.getElementById('row').textContent = '';
      line = '';
    }
  });
</script>` }));
  await page.goto('https://scaler.test/lab');

  const result = await solveAndSubmitLab(page, 'Lab sudo prompt', SUDO_STATEMENT, FAST);

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(await typedInTerminal(page), `${SUDO_PRIME}\nsudo chown -R user /opt/app\nuser@123!\nls -l /opt\n`);
  await page.close();
});
