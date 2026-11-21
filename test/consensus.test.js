import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saab-consensus-test-'));
process.env.SAAB_DATA_DIR = dataDir;
process.env.API_SPACING_MS = '0';

const solver = await import('../solver.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const SAMPLE_MCQ = {
  title: 'Consensus Architecture Test',
  body: 'Which data structure provides O(1) average lookup time?',
  options: [
    { index: 0, label: 'A', text: 'Binary Search Tree' },
    { index: 1, label: 'B', text: 'Hash Table' },
    { index: 2, label: 'C', text: 'Linked List' },
    { index: 3, label: 'D', text: 'Array' }
  ]
};

test('getProviderTelemetry returns structured metrics and circuit breaker statuses', () => {
  const telemetry = solver.getProviderTelemetry();
  assert.ok(telemetry);
  assert.ok(typeof telemetry.timestamp === 'number');
  assert.ok(telemetry.stats);
  assert.ok(Array.isArray(telemetry.quotas));
  assert.ok(telemetry.providers);
  assert.ok(telemetry.providers.gemini);
  assert.ok(telemetry.providers.groq);
  assert.ok(telemetry.providers.grok);
  assert.equal(typeof telemetry.providers.groq.circuit, 'string');
});

test('solveMCQWithConsensus returns cached verified solution with 1.0 agreement rate', async () => {
  const cacheKey = solver.makeMCQCacheKey(SAMPLE_MCQ);
  solver.commitSolution(cacheKey, { bestOptionIndex: 1, reasoning: 'Hash Table provides O(1) average lookup.' });

  const result = await solver.solveMCQWithConsensus(SAMPLE_MCQ);
  assert.equal(result.bestOptionIndex, 1);
  assert.equal(result.consensus, true);
  assert.equal(result.agreementRate, 1.0);
  assert.ok(result.reasoning.includes('Hash Table'));
});

test('image-based MCQ bypasses Groq consensus and routes safely to vision model', async () => {
  const imageMCQ = {
    ...SAMPLE_MCQ,
    title: 'Image Multimodal Question',
    screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };

  // With no Gemini keys set in test environment, this should refuse without guessing
  const res = await solver.solveMCQWithConsensus(imageMCQ);
  assert.ok(res.failed);
  assert.equal(res.bestOptionIndex, null);
});
