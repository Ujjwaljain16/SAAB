// End-to-end: the REAL main.js driving a headless browser against test/e2e/mock_scaler.js.
// Proves the "never solve an already-solved question" rule through the whole pipeline: crawler -> merge -> worker -> submit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchBrowser } from './helpers/browser.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-e2e-'));
const dataDir = path.join(work, 'data');
const profileDir = path.join(work, 'profile');
const mockLog = path.join(work, 'mock.log');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

// The solver cache is seeded with the answer for Q2, so no AI provider is ever contacted.
process.env.SAAB_DATA_DIR = dataDir;
const { slurpMCQContext } = await import('../mcq_handler.js');
const { commitSolution, makeMCQCacheKey } = await import('../solver.js');
const { problemHtml, PROBLEMS } = await import('./e2e/mock_scaler.js');

let browserChannel = '';
before(async () => {
  try {
    const probe = await chromium.launch({ channel: 'chrome', headless: true });
    await probe.close();
    browserChannel = 'chrome';
  } catch {
    browserChannel = ''; // Playwright's bundled Chromium
  }

  // Render the mock Q2 page exactly like the agent will see it, and seed the cache with the answer for it.
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.route('https://www.scaler.com/**', (r) => r.fulfill({ contentType: 'text/html', body: problemHtml(2) }));
  await page.goto('https://www.scaler.com/q2');
  const content = await slurpMCQContext(page);
  commitSolution(makeMCQCacheKey(content), { bestOptionIndex: 1, reasoning: 'seeded for e2e' });
  await browser.close();
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

function runAgent(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['main.js', ...args], {
      cwd: repo,
      env: {
        ...process.env,
        SAAB_DATA_DIR: dataDir,
        SAAB_PROFILE_DIR: profileDir,
        SAAB_HEADLESS: 'true',
        SAAB_BROWSER_CHANNEL: browserChannel,
        SAAB_TEST_ROUTES: path.join(repo, 'test', 'e2e', 'mock_scaler.js'),
        MOCK_LOG: mockLog,
        SOLVE_CONCURRENCY: '2',
        API_SPACING_MS: '0',
        // dotenv never overrides variables that are already set, so the real .env keys cannot leak into the test.
        GEMINI_API_KEY: '', GEMINI_API_KEYS: '', GROK_API_KEY: '', XAI_API_KEY: '',
        GROQ_API_KEY: 'unused-test-key', GROQ_MODEL: 'm1', GROQ_MODELS: 'm1'
      }
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill(), 150000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
  });
}

const events = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf-8').split('\n').filter(Boolean) : []);

test('already-solved questions are never opened, solved or submitted; only the genuinely unsolved one is', async () => {
  const { code, out } = await runAgent(['--only-mcq']);
  const seen = events();

  assert.equal(code, 0, `agent exited ${code}\n${out.slice(-2500)}`);

  // Q2 (the only unsolved question) was solved and submitted exactly once.
  assert.deepEqual(seen.filter((e) => e.startsWith('submit')), ['submit 2'], `submissions: ${seen.join(' | ')}\n${out.slice(-2500)}`);

  // Q1 (table: solved) and Q5 (dock: solved) were never even navigated to; Q3 (page: solved) was opened once, then left alone.
  const visits = seen.filter((e) => e.startsWith('visit')).sort();
  assert.ok(!visits.includes('visit 1'), 'a table-solved problem must not be opened');
  assert.ok(!visits.includes('visit 5'), 'a dock-solved problem must not be opened (table/dock disagreement)');
  assert.ok(visits.includes('visit 2') && visits.includes('visit 3'), `visits: ${visits.join(', ')}`);

  // Junk links (/submissions, /help-requests) were never treated as questions.
  assert.ok(!seen.some((e) => e.startsWith('other')), `unexpected pages requested: ${seen.filter((e) => e.startsWith('other')).join(', ')}`);

  // Everything solved is checkpointed, so a re-run does nothing.
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'run-state.json'), 'utf-8'));
  for (const id of Object.keys(PROBLEMS)) {
    assert.ok(state.completedProblems.some((u) => u.endsWith(`/problems/${id}`)), `Q${id} should be checkpointed as done`);
  }
});

test('running again submits nothing at all', async () => {
  fs.writeFileSync(mockLog, '');
  const { code, out } = await runAgent(['--only-mcq']);
  assert.equal(code, 0, out.slice(-2000));
  assert.deepEqual(events().filter((e) => e.startsWith('submit')), [], 'a second run must not submit anything');
});
