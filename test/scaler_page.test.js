import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProblemHref,
  buildProblemsUrl,
  resolveTargetLanguage,
  normalizeLanguageName,
  classifyFailureFeedback,
  extractTestCases,
  isLoginUrl,
  looksSolved,
  mergeProblems
} from '../scaler_page.js';

test('isProblemHref accepts only real question links (regression: help-requests / submissions were solved as questions)', () => {
  const base = '/academy/mentee-dashboard/class/570714/assignment/problems';
  assert.equal(isProblemHref(`${base}/315185?navref=cl_tt_lst_nm`), true);
  assert.equal(isProblemHref(`${base}/315185?navref=cl_tt_lst_sl`), true);
  assert.equal(isProblemHref(`${base}/315185/`), true);
  assert.equal(isProblemHref(`https://www.scaler.com${base}/315185`), true);

  assert.equal(isProblemHref(`${base}/315185/submissions?navref=cl_tt_lst_sbs`), false);
  assert.equal(isProblemHref(`${base}/315185/help-requests?navref=cl_tt_lst_hr`), false);
  assert.equal(isProblemHref(`${base}?navref=cl_tt_nv`), false);
  assert.equal(isProblemHref(`${base}/`), false);
  assert.equal(isProblemHref('/academy/mentee-dashboard/class/570714/assignment/instructions?navref=cl_tt_nv'), false);
  assert.equal(isProblemHref(''), false);
  assert.equal(isProblemHref(undefined), false);
});

test('buildProblemsUrl turns an assignment URL into its problems list', () => {
  const url = buildProblemsUrl('/academy/mentee-dashboard/class/1/assignment');
  assert.equal(url, 'https://www.scaler.com/academy/mentee-dashboard/class/1/assignment/problems?navref=cl_tt_nv');
});

test('resolveTargetLanguage / normalizeLanguageName', () => {
  assert.equal(resolveTargetLanguage('SST Programming using JS'), 'JavaScript');
  assert.equal(resolveTargetLanguage('SST DevOps & Cloud'), 'Java');
  assert.equal(normalizeLanguageName('JavaScript (Node)'), 'javascript');
  assert.equal(normalizeLanguageName('Java Array'), 'java');
  assert.equal(normalizeLanguageName('Python'), '');
});

test('classifyFailureFeedback gives targeted retry hints', () => {
  assert.match(classifyFailureFeedback('error: cannot find symbol'), /signature/i);
  assert.match(classifyFailureFeedback('Wrong Answer: expected 3 actual 4'), /wrong answer/i);
  assert.match(classifyFailureFeedback('Exception in thread main NullPointerException'), /runtime/i);
  assert.match(classifyFailureFeedback('Time Limit Exceeded'), /time limit/i);
  assert.match(classifyFailureFeedback(''), /feedback/i);
});

test('extractTestCases pulls the sample section', () => {
  const body = 'Problem\nSample Input 1\n3 4\nSample Output 1\n7';
  assert.ok(extractTestCases(body).startsWith('Sample Input 1'));
  assert.equal(extractTestCases('no samples here'), '');
});

test('isLoginUrl', () => {
  assert.equal(isLoginUrl('https://www.scaler.com/users/sign_in/'), true);
  assert.equal(isLoginUrl('https://www.scaler.com/academy/x'), false);
});

test('looksSolved: any positive signal counts, "unsolved" always wins', () => {
  assert.equal(looksSolved('Q1 Easy 50.0/50 Solved 2 submissions Solve 65'), true);
  assert.equal(looksSolved('Q1 Easy Completed Solve'), true);
  assert.equal(looksSolved('Q1 Accepted'), true);
  assert.equal(looksSolved('Q1 Easy 50.0/50 Solve 65'), true, 'a full score alone means done');
  assert.equal(looksSolved('Q1 Easy 10/10 Solve'), true);

  assert.equal(looksSolved('Q1 Easy 0/50 Unsolved 0 submissions Solve 65'), false);
  assert.equal(looksSolved('Q1 Easy 25/50 Attempted Solve'), false, 'partial credit is not solved');
  assert.equal(looksSolved('Q1 Not solved yet 50/50'), false, '"not solved" overrides');
  assert.equal(looksSolved('Q1 Unsolved 50/50'), false);
  assert.equal(looksSolved(''), false);
  assert.equal(looksSolved(undefined), false);
});

test('mergeProblems: if EITHER the table or the dock says solved, it is solved (regression: first source used to win)', () => {
  const base = 'https://www.scaler.com/academy/mentee-dashboard/class/1/assignment/problems';
  const table = [
    { title: 'Q1. Alpha', solveUrl: `${base}/11?navref=cl_tt_lst_sl`, isSolved: false },
    { title: 'Q2. Beta', solveUrl: `${base}/12?navref=cl_tt_lst_sl`, isSolved: true }
  ];
  const dock = [
    { title: 'Q 1', solveUrl: `${base}/11?navref=cl_tt_nv`, isSolved: true },
    { title: 'Q 2', solveUrl: `${base}/12?navref=cl_tt_nv`, isSolved: false },
    { title: 'Q 3', solveUrl: `${base}/13?navref=cl_tt_nv`, isSolved: false },
    { title: '2 submissions', solveUrl: `${base}/13/submissions?navref=x`, isSolved: false },
    { title: 'Question help-requests', solveUrl: `${base}/13/help-requests?navref=x`, isSolved: false }
  ];

  const merged = mergeProblems(table, dock);
  assert.equal(merged.length, 3, 'one entry per real question; submissions/help-requests dropped');

  const byId = (id) => merged.find((p) => p.solveUrl.endsWith(`/${id}`));
  assert.equal(byId(11).isSolved, true, 'dock says solved, table says unsolved -> solved');
  assert.equal(byId(11).title, 'Q1. Alpha', 'the table title is kept');
  assert.equal(byId(12).isSolved, true, 'table says solved, dock says unsolved -> solved');
  assert.equal(byId(13).isSolved, false);
  assert.ok(merged.every((p) => !p.solveUrl.includes('?')), 'URLs are canonical');
});

test('mergeProblems tolerates empty and malformed input', () => {
  assert.deepEqual(mergeProblems(undefined, null), []);
  assert.deepEqual(mergeProblems([{ title: 'x' }, null, { solveUrl: '' }], []), []);
});
