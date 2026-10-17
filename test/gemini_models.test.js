// Gemini MODEL pool: free-tier quota is per model, so one key serves several models in priority order and spills over when one is spent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-models-test-'));
process.env.SAAB_DATA_DIR = dataDir;
for (const k of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY', 'GEMINI_RPM', 'GEMINI_RPD']) process.env[k] = '';
process.env.GEMINI_API_KEYS = 'only-key';
delete process.env.GEMINI_MODEL;
process.env.GEMINI_MODELS = 'gemini-big,gemma-text,gemini-small';
// gemini-big may only be used twice a day; the others are effectively unlimited.
process.env.GEMINI_LIMITS = 'gemini-big=100/2,gemma-text=100/0,gemini-small=100/0';
process.env.API_SPACING_MS = '0';

const solver = await import('../solver.js');

const calls = []; // { model, hadJsonMime }
let behaviour = () => 'ok';
globalThis.fetch = async (url, init) => {
  const model = String(url).match(/models\/([^:/]+):generateContent/)?.[1] || 'unknown';
  const body = JSON.parse(init.body);
  calls.push({ model, hadJsonMime: body.generationConfig?.responseMimeType === 'application/json' });
  if (behaviour(model) === 'daily') {
    return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }), { status: 429 });
  }
  return new Response(JSON.stringify({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify({ bestOptionIndex: 1, reasoning: 'r' }) }] } }] }), { status: 200 });
};

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const mcq = (n, extra = {}) => ({ title: `Model Q${n}`, body: n % 2 ? 'pick one' : '', options: [{ index: 0, label: 'A', text: 'x' }, { index: 1, label: 'B', text: 'y' }], ...extra });
const modelsUsed = () => calls.map((c) => c.model);

test('the first listed model is preferred, then the pool spills to the next one when its daily budget is spent', async () => {
  assert.equal((await solver.solveMCQ(mcq(1))).bestOptionIndex, 1);
  assert.equal((await solver.solveMCQ(mcq(3))).bestOptionIndex, 1);
  assert.deepEqual(modelsUsed(), ['gemini-big', 'gemini-big'], 'priority model first');

  assert.equal((await solver.solveMCQ(mcq(5))).bestOptionIndex, 1);
  assert.equal(modelsUsed()[2], 'gemma-text', 'gemini-big hit its daily budget of 2, so the next model takes over');

  const big = solver.getQuotaReport().find((r) => r.name === 'gemini:0');
  assert.equal(big.exhausted, true);
  assert.equal(big.used, 2);
});

test('Gemma never receives JSON mode (it answers 500 to it); Gemini models do', async () => {
  const gemma = calls.find((c) => c.model === 'gemma-text');
  assert.equal(gemma.hadJsonMime, false);
  assert.equal(calls.find((c) => c.model === 'gemini-big').hadJsonMime, true);
});

test('image questions only go to vision-capable (Gemini) models, never to Gemma', async () => {
  const before = calls.length;
  const res = await solver.solveMCQ(mcq(7, { screenshotBase64: 'aGVsbG8=', body: '' }));
  assert.equal(res.bestOptionIndex, 1);
  assert.deepEqual(modelsUsed().slice(before), ['gemini-small'], 'skipped both the spent gemini-big and the text-only gemma-text');
});

test('when the only vision model runs out, image questions fail cleanly instead of being sent to Gemma', async () => {
  behaviour = (model) => (model === 'gemini-small' ? 'daily' : 'ok');
  const before = calls.length;
  const res = await solver.solveMCQ(mcq(9, { screenshotBase64: 'aGVsbG8=', body: '' }));

  assert.equal(res.failed, true);
  assert.ok(!modelsUsed().slice(before).includes('gemma-text'), 'a text-only model must never see an image question');
  assert.equal(solver.allProvidersExhausted(), false, 'text questions can still be served by gemma-text');

  // And a text question still works through the surviving model.
  assert.equal((await solver.solveMCQ(mcq(11))).bestOptionIndex, 1);
  assert.equal(modelsUsed().at(-1), 'gemma-text');
});
