import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRunState, makeRunState, markClassComplete, markProblemComplete } from '../run_state.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saab-state-')), 'run-state.json');

test('missing, empty and corrupt checkpoint files all load as an empty state', () => {
  const file = tmpFile();
  assert.deepEqual(loadRunState(file).completedProblems, []);

  fs.writeFileSync(file, '');
  assert.deepEqual(loadRunState(file).completedProblems, []);

  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadRunState(file).completedClasses, []);

  fs.writeFileSync(file, JSON.stringify({ completedClasses: 'nope', completedProblems: [1, null, 'https://www.scaler.com/p/1'] }));
  const loaded = loadRunState(file);
  assert.deepEqual(loaded.completedClasses, []);
  assert.deepEqual(loaded.completedProblems, ['https://www.scaler.com/p/1'], 'non-string entries are dropped');
});

test('marking progress persists atomically and canonicalises problem URLs', () => {
  const file = tmpFile();
  const state = makeRunState(file);

  markProblemComplete(state, '/academy/mentee-dashboard/class/1/assignment/problems/9?navref=cl_tt_lst_sl');
  markProblemComplete(state, 'https://scaler.com/academy/mentee-dashboard/class/1/assignment/problems/9/');
  markClassComplete(state, 'https://www.scaler.com/academy/mentee-dashboard/class/1');

  assert.equal(state.completedProblems.size, 1, 'the same problem via different URL spellings is one entry');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file left behind');

  const reloaded = makeRunState(file);
  assert.equal(reloaded.completedProblems.size, 1);
  assert.ok(reloaded.completedClasses.has('https://www.scaler.com/academy/mentee-dashboard/class/1'));
});

test('saving into a missing directory warns instead of crashing the run', () => {
  const state = makeRunState(path.join(os.tmpdir(), 'saab-does-not-exist-xyz', 'run-state.json'));
  assert.doesNotThrow(() => markClassComplete(state, 'https://www.scaler.com/c'));
});
