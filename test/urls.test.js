import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScalerUrl, canonicalProblemUrl } from '../scaler_url.js';
import { parseProgressCount } from '../crawler.js';

test('normalizeScalerUrl adds host and www', () => {
  assert.equal(normalizeScalerUrl('/academy/x'), 'https://www.scaler.com/academy/x');
  assert.equal(normalizeScalerUrl('https://scaler.com/a'), 'https://www.scaler.com/a');
  assert.equal(normalizeScalerUrl(''), '');
  assert.equal(normalizeScalerUrl(null), '');
});

test('canonicalProblemUrl drops query, hash and trailing slashes', () => {
  assert.equal(
    canonicalProblemUrl('/academy/mentee-dashboard/class/1/assignment/problems/9/?navref=x#top'),
    'https://www.scaler.com/academy/mentee-dashboard/class/1/assignment/problems/9'
  );
  assert.equal(
    canonicalProblemUrl('https://scaler.com/p/1'),
    canonicalProblemUrl('https://www.scaler.com/p/1/')
  );
});

test('parseProgressCount', () => {
  assert.deepEqual(parseProgressCount('Assignment 2 / 7'), { completed: 2, total: 7 });
  assert.equal(parseProgressCount('no numbers'), null);
  assert.equal(parseProgressCount(''), null);
});
