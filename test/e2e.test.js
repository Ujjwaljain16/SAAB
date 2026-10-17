// End-to-end: the REAL main.js driving a headless browser against test/e2e/mock_scaler.js, with a local fake Groq API.
// Proves, through the whole pipeline (crawler -> merge -> worker -> AI -> submit -> verdict -> retry):
//   * already-solved questions are never opened, solved or submitted
//   * a wrong MCQ answer is retried with the rejected options excluded, up to 3 tries, then left alone (also on re-runs)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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

// The solver cache is seeded with the answer for Q2 (so no AI call is needed there).
process.env.SAAB_DATA_DIR = dataDir;
const { slurpMCQContext } = await import('../mcq_handler.js');
const { commitSolution, makeMCQCacheKey } = await import('../solver.js');
const { problemHtml } = await import('./e2e/mock_scaler.js');

// Fake Groq: answers the lowest option index that the prompt does not list as already rejected, and records what it was asked.
const aiRequests = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const prompt = JSON.parse(body).messages[0].content;
    const title = prompt.match(/TITLE: (.*)/)?.[1]?.trim();
    const excluded = (prompt.match(/do NOT choose them: ([\d, ]+)\./)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    const pick = [0, 1, 2, 3].find((i) => !excluded.includes(i));
    aiRequests.push({ title, excluded });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bestOptionIndex: pick, reasoning: 'fake' }) } }] }));
  });
});
let aiPort;

let browserChannel = '';
before(async () => {
  await new Promise((resolve) => fakeAi.listen(0, '127.0.0.1', resolve));
  aiPort = fakeAi.address().port;

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
after(async () => {
  await new Promise((resolve) => fakeAi.close(resolve));
  fs.rmSync(work, { recursive: true, force: true });
});

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
        GROQ_API_KEY: 'unused-test-key', GROQ_MODEL: 'm1', GROQ_MODELS: 'm1',
        GROQ_BASE_URL: `http://127.0.0.1:${aiPort}/openai/v1/chat/completions`
      }
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill(), 240000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
  });
}

const events = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf-8').split('\n').filter(Boolean) : []);
const submitsOf = (id, seen) => seen.filter((e) => e === `submit ${id}`).length;
const choicesOf = (id, seen) => seen.filter((e) => e.startsWith(`choice ${id} `)).map((e) => Number(e.split(' ')[2]));

test('solved questions are never touched; wrong MCQ answers get up to 3 tries with rejected options excluded', async () => {
  const { code, out } = await runAgent(['--only-mcq']);
  const seen = events();
  const ctx = `\n--- events: ${seen.join(' | ')}\n--- output tail:\n${out.slice(-3000)}`;

  assert.equal(code, 0, `agent exited ${code}${ctx}`);

  // Already-solved questions (table, page, dock) are never submitted; table- and dock-solved ones are never even opened.
  for (const id of [1, 3, 5]) assert.equal(submitsOf(id, seen), 0, `Q${id} was already solved and must not be submitted${ctx}`);
  const visits = seen.filter((e) => e.startsWith('visit'));
  assert.ok(!visits.includes('visit 1'), 'a table-solved problem must not be opened');
  assert.ok(!visits.includes('visit 5'), 'a dock-solved problem must not be opened (table/dock disagreement)');
  assert.ok(visits.includes('visit 3'), 'a page-solved problem is opened once, noticed and left alone');

  // Q2: seeded answer was right -> exactly one submission, no AI call.
  assert.deepEqual(choicesOf(2, seen), [1], ctx);
  assert.ok(!aiRequests.some((r) => r.title?.startsWith('Q2')), 'Q2 came from the verified cache, no AI call');

  // Q7 needs 2 tries, Q6 needs 3, Q8 is never right: each stops at its limit.
  assert.deepEqual(choicesOf(7, seen), [0, 1], `Q7${ctx}`);
  assert.deepEqual(choicesOf(6, seen), [0, 1, 2], `Q6${ctx}`);
  assert.deepEqual(choicesOf(8, seen), [0, 1, 2], `Q8 must stop after 3 tries${ctx}`);

  // Each retry told the AI which options were already rejected.
  const askedFor = (n) => aiRequests.filter((r) => r.title?.startsWith(`Q${n}`)).map((r) => r.excluded);
  assert.deepEqual(askedFor(6), [[], [0], [0, 1]]);
  assert.deepEqual(askedFor(7), [[], [0]]);
  assert.deepEqual(askedFor(8), [[], [0], [0, 1]]);

  assert.ok(!seen.some((e) => e.startsWith('other')), `unexpected pages requested: ${seen.filter((e) => e.startsWith('other')).join(', ')}`);

  // Solved ones are checkpointed; the one that never got solved is not.
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'run-state.json'), 'utf-8'));
  const done = (id) => state.completedProblems.some((u) => u.endsWith(`/problems/${id}`));
  for (const id of [1, 2, 3, 5, 6, 7]) assert.ok(done(id), `Q${id} should be checkpointed`);
  assert.equal(done(8), false, 'Q8 was never solved and must not be marked done');
});

test('a re-run submits nothing: solved ones are checkpointed and Q8 already used up its 3 tries', async () => {
  fs.writeFileSync(mockLog, '');
  const aiBefore = aiRequests.length;
  const { code, out } = await runAgent(['--only-mcq']);
  const seen = events();

  assert.equal(code, 0, out.slice(-2000));
  assert.deepEqual(seen.filter((e) => e.startsWith('submit')), [], `a second run must not submit anything: ${seen.join(' | ')}`);
  assert.equal(aiRequests.length, aiBefore, 'and must not even ask the AI again');
  assert.match(out, /Already tried 3 wrong answers/, 'Q8 is reported as given up on');
});
