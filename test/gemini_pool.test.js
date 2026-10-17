// Gemini key pooling against a fake Gemini REST API (the SDK calls global fetch). Covers: load spreading across keys,
// a key that hits its DAILY quota being retired (and remembered), and a per-MINUTE 429 pausing without retiring the key.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-pool-test-'));
process.env.SAAB_DATA_DIR = dataDir;
for (const k of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY']) process.env[k] = '';
process.env.GEMINI_API_KEYS = 'key-A,key-B';
process.env.GEMINI_MODEL = 'test-model';
process.env.GEMINI_RPM = '30';
process.env.API_SPACING_MS = '0';

const solver = await import('../solver.js');

const seen = [];
let behaviour = () => 'ok';

globalThis.fetch = async (url, init) => {
  const key = new Headers(init?.headers).get('x-goog-api-key') || String(url).match(/key=([^&]+)/)?.[1] || 'unknown';
  seen.push(key);
  const mode = behaviour(key);
  if (mode === 'daily') {
    return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
  }
  if (mode === 'minute') {
    return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. Please retry in 1s.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } });
  }
  return json(200, { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify({ bestOptionIndex: 1, reasoning: 'r' }) }] } }] });
};
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const mcq = (n) => ({ title: `Pool Q${n}`, body: 'pick', options: [{ index: 0, label: 'A', text: 'x' }, { index: 1, label: 'B', text: 'y' }] });
const count = (k) => seen.filter((s) => s === k).length;

test('concurrent work is spread across the pooled keys instead of always hitting key 1', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => solver.solveMCQ(mcq(i))));
  assert.ok(results.every((r) => r.bestOptionIndex === 1));
  assert.ok(count('key-A') > 0 && count('key-B') > 0, `unbalanced: A=${count('key-A')} B=${count('key-B')}`);
  assert.ok(Math.abs(count('key-A') - count('key-B')) <= 2, `A=${count('key-A')} B=${count('key-B')}`);
});

test('a per-MINUTE 429 pauses that key but never retires it', async () => {
  let fired = false;
  behaviour = (key) => (key === 'key-A' && !fired ? ((fired = true), 'minute') : 'ok');
  const res = await solver.solveMCQ(mcq(100));
  assert.equal(res.bestOptionIndex, 1);
  assert.equal(solver.allProvidersExhausted(), false);
  const keyA = solver.getQuotaReport().find((r) => r.name === 'gemini:0');
  assert.equal(keyA.exhausted, false, 'a per-minute limit must not mark a key out of quota');
  assert.ok(keyA.effectiveRpm < 30, 'the allowed rate on that key is reduced after a 429');
});

test('a key that hits its DAILY quota is retired, remembered on disk, and traffic moves to the other key', async () => {
  behaviour = (key) => (key === 'key-A' ? 'daily' : 'ok');
  // A first batch is spread over both keys, so key A is certain to be tried, answers 429 (daily) and gets retired.
  const first = await Promise.all(Array.from({ length: 6 }, (_, i) => solver.solveMCQ(mcq(200 + i))));
  assert.ok(first.every((r) => r.bestOptionIndex === 1), 'every answer still arrives via the healthy key');
  assert.ok(solver.getQuotaReport().find((r) => r.name === 'gemini:0').exhausted, 'key A is retired after its daily-quota 429');

  const before = count('key-A');
  await Promise.all(Array.from({ length: 4 }, (_, i) => solver.solveMCQ(mcq(300 + i))));
  assert.equal(count('key-A'), before, 'a retired key receives no further requests');

  const persisted = fs.readdirSync(path.join(dataDir, '.quota')).map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, '.quota', f), 'utf-8')));
  assert.ok(persisted.some((p) => p.exhausted === true), 'daily exhaustion is saved so the next run today skips the key');
  assert.ok(!JSON.stringify(persisted).includes('key-A'), 'API keys are never written to the quota files');
  assert.equal(solver.allProvidersExhausted(), false);
});

test('when every key is out of daily quota the run is told to stop', async () => {
  behaviour = () => 'daily';
  const res = await solver.solveMCQ(mcq(400));
  assert.equal(res.failed, true);
  assert.equal(res.fatal, true);
  assert.equal(solver.allProvidersExhausted(), true);
});
