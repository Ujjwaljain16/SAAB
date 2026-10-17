import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProblemHref,
  buildProblemsUrl,
  resolveTargetLanguage,
  normalizeLanguageName,
  classifyFailureFeedback,
  extractTestCases,
  isLoginUrl
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
