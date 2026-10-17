// A configured daily request budget is enforced BEFORE any request is sent, and survives into the next process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-budget-test-'));
process.env.SAAB_DATA_DIR = dataDir;
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROK_API_KEY', 'XAI_API_KEY']) process.env[k] = '';
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_MODEL = 'm1';
process.env.GROQ_MODELS = 'm1';
process.env.API_SPACING_MS = '0';
process.env.GROQ_RPD = '2';

const solver = await import('../solver.js');

let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bestOptionIndex: 0, reasoning: 'ok' }) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const mcq = (n) => ({ title: `Budget Q${n}`, body: 'pick', options: [{ index: 0, label: 'A', text: 'x' }, { index: 1, label: 'B', text: 'y' }] });

test('requests stop at the configured daily budget and none are sent beyond it', async () => {
  assert.equal((await solver.solveMCQ(mcq(1))).bestOptionIndex, 0);
  assert.equal((await solver.solveMCQ(mcq(2))).bestOptionIndex, 0);
  assert.equal(calls, 2);

  const third = await solver.solveMCQ(mcq(3));
  assert.equal(third.failed, true, 'budget spent: no answer, nothing guessed');
  assert.equal(third.fatal, true, 'the run is told to stop: nothing is left to try today');
  assert.equal(calls, 2, 'the 3rd request must never reach the API (that is what would have been the 429)');
  assert.equal(solver.allProvidersExhausted(), true);
});

test('usage is persisted (without any API key) and reported', () => {
  const report = solver.getQuotaReport().find((r) => r.name === 'groq');
  assert.equal(report.used, 2);
  assert.equal(report.rpd, 2);
  assert.equal(report.exhausted, true);

  const file = path.join(dataDir, '.quota', 'groq.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(saved.used, 2);
  assert.ok(!JSON.stringify(saved).includes('test-key'), 'secrets are never written to the quota file');
});
