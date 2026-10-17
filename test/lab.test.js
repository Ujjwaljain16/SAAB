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
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY']) process.env[k] = '';
process.env.API_SPACING_MS = '0';

const { solveAndSubmitLab } = await import('../lab_handler.js');
const { commitSolution, makeLabCacheKey } = await import('../solver.js');

const FAST = { timeScale: 0.01, frameWaitAttempts: 3 };
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
  const page = await labPage(`document.getElementById('h').textContent = 'Lab question Solved';`);

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
  const page = await labPage(`document.getElementById('h').textContent = 'Lab question Solved';`);

  const result = await solveAndSubmitLab(page, 'Lab unsafe', 'anything', FAST);

  assert.equal(result.status, 'fail');
  assert.match(result.verdict, /unsafe/i);
  assert.equal(await typedInTerminal(page), '', 'nothing may reach the terminal');
  await page.close();
});

test('no AI answer and no cache fails cleanly instead of crashing', async () => {
  const page = await labPage(`document.getElementById('h').textContent = 'Lab question Solved';`);
  const result = await solveAndSubmitLab(page, 'Lab nothing', 'never seen before', FAST);
  assert.equal(result.status, 'fail');
  assert.match(result.verdict, /empty command list/i);
  await page.close();
});
