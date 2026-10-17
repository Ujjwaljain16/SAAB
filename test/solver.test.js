// Solver behaviour against a fake Groq API (global fetch is stubbed; Gemini/Grok are not configured).
// Tests run in order and the last ones exhaust the daily quota on purpose (module state is per-process).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-solver-test-'));
process.env.SAAB_DATA_DIR = dataDir;
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROK_API_KEY', 'XAI_API_KEY']) process.env[k] = '';
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_MODEL = 'm1';
process.env.GROQ_MODELS = 'm1';
process.env.API_SPACING_MS = '0';

const solver = await import('../solver.js');

let calls = 0;
let nextResponse = () => ({ status: 200, body: { choices: [{ message: { content: '' } }] } });
globalThis.fetch = async () => {
  calls += 1;
  const { status, body, headers } = nextResponse();
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers || {}) } });
};

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const ok = (content) => () => ({ status: 200, body: { choices: [{ message: { content } }] } });
const rateLimited = (message) => () => ({ status: 429, body: { error: { message } } });
const cacheFile = (key) => path.join(dataDir, '.solver-cache', `${key}.json`);

const GOOD_JAVA = 'public class Solution { public int add(int a, int b) { return a + b; } }';
const MCQ = { title: 'Q', body: 'Pick one', options: [{ index: 0, label: 'A', text: 'x' }, { index: 1, label: 'B', text: 'y' }, { index: 2, label: 'C', text: 'z' }] };

test('coding answer is NOT cached until the judge confirms; verified answers are reused on attempt 1 only', async () => {
  nextResponse = ok(GOOD_JAVA);
  const first = await solver.solve('Add two numbers', '', 'Java', { attempt: 1 });
  assert.equal(first.ok, true);
  assert.ok(first.cacheKey);
  assert.equal(fs.existsSync(cacheFile(first.cacheKey)), false, 'unverified code must not be on disk');

  solver.commitSolution(first.cacheKey, { code: first.code, language: 'Java' });
  assert.equal(fs.existsSync(cacheFile(first.cacheKey)), true);

  const before = calls;
  const hit = await solver.solve('Add two numbers', '', 'Java', { attempt: 1 });
  assert.equal(hit.code, GOOD_JAVA);
  assert.equal(calls, before, 'attempt 1 is served from the verified cache with no API call');

  const retry = await solver.solve('Add two numbers', '', 'Java', { attempt: 2 });
  assert.equal(retry.ok, true);
  assert.equal(calls, before + 1, 'a retry must ask the model again, not replay the cached (failed) answer');

  solver.evictSolution(first.cacheKey);
  assert.equal(fs.existsSync(cacheFile(first.cacheKey)), false);
});

test('truncated model output is rejected after bounded retries', async () => {
  nextResponse = ok('public class Solution { public int add(int a, int b) { return');
  const before = calls;
  const res = await solver.solve('Add numbers truncated', '', 'Java', { attempt: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.type, 'incomplete_generation');
  assert.ok(calls - before <= 4, `unbounded retries: ${calls - before}`);
});

test('MCQ: valid answer is returned but not cached; invalid index is refused instead of guessed', async () => {
  nextResponse = ok(JSON.stringify({ bestOptionIndex: 1, reasoning: 'because' }));
  const good = await solver.solveMCQ(MCQ);
  assert.equal(good.bestOptionIndex, 1);
  assert.equal(fs.existsSync(cacheFile(good.cacheKey)), false);

  nextResponse = ok(JSON.stringify({ bestOptionIndex: 9, reasoning: 'out of range' }));
  const bad = await solver.solveMCQ({ ...MCQ, title: 'Q2' });
  assert.equal(bad.failed, true);
  assert.equal(bad.bestOptionIndex, null);
});

test('MCQ: an option the judge already rejected is never chosen again', async () => {
  const content = { ...MCQ, title: 'Q3' };
  const key = solver.makeMCQCacheKey(content);
  solver.recordWrongMCQOption(key, 1);
  assert.deepEqual(solver.getWrongMCQOptions(key), [1]);

  nextResponse = ok(JSON.stringify({ bestOptionIndex: 1, reasoning: 'same wrong answer' }));
  const res = await solver.solveMCQ(content);
  assert.equal(res.failed, true, 'repeating a rejected option must be treated as no answer');

  nextResponse = ok(JSON.stringify({ bestOptionIndex: 2, reasoning: 'different' }));
  assert.equal((await solver.solveMCQ(content)).bestOptionIndex, 2);
});

test('image-based MCQ is never sent to a text-only model (Groq cannot see the image)', async () => {
  nextResponse = ok(JSON.stringify({ bestOptionIndex: 0, reasoning: 'blind guess' }));
  const before = calls;
  const res = await solver.solveMCQ({ ...MCQ, title: 'Image Q', body: '', screenshotBase64: 'aGVsbG8=' });
  assert.equal(res.failed, true, 'must not answer an image question without vision');
  assert.equal(calls, before, 'no request may be sent to Groq for an image question');
});

test('per-MINUTE 429 pauses but never marks a provider out of quota', async () => {
  nextResponse = rateLimited('Rate limit reached for model m1 in organization org on tokens per minute (TPM). Please try again in 2s.');
  const res = await solver.solveMCQ({ ...MCQ, title: 'Q4' });
  assert.equal(res.failed, true);
  assert.equal(res.fatal, false);
  assert.equal(solver.allProvidersExhausted(), false);
  // The provider's "try again in 2s" now pauses the whole lane so parallel workers don't keep hammering it.
  const cooldown = solver.getLaneCooldownMs('groq');
  assert.ok(cooldown > 0 && cooldown <= 2500, `expected a ~2s lane cooldown, got ${cooldown}ms`);
});

test('per-DAY 429 marks the provider dead: run is told to stop and no further calls are made', async () => {
  nextResponse = rateLimited('Rate limit reached for model m1 on tokens per day (TPD): Limit 100000, Used 100000. Please try again in 3h.');
  const res = await solver.solveMCQ({ ...MCQ, title: 'Q5' });
  assert.equal(res.failed, true);
  assert.equal(res.fatal, true);
  assert.equal(solver.allProvidersExhausted(), true);

  const before = calls;
  const again = await solver.solveMCQ({ ...MCQ, title: 'Q6' });
  assert.equal(again.failed, true);
  assert.equal(again.fatal, true);
  assert.equal(calls, before, 'no API spam once the daily quota is gone');
});
