import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMarkdownFences,
  extractJsonBlock,
  hasBalancedBrackets,
  looksTruncated,
  extractLikelyCode,
  stripCodeComments
} from '../code_utils.js';

test('stripMarkdownFences removes a surrounding fence and language tag', () => {
  assert.equal(stripMarkdownFences('```java\nint x = 1;\n```'), 'int x = 1;');
  assert.equal(stripMarkdownFences('plain'), 'plain');
  assert.equal(stripMarkdownFences(''), '');
});

test('extractJsonBlock parses raw, fenced and chatty JSON', () => {
  assert.deepEqual(extractJsonBlock('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonBlock('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJsonBlock('Sure! Here you go: {"a":3} hope it helps'), { a: 3 });
  assert.throws(() => extractJsonBlock('no json here'));
});

test('hasBalancedBrackets', () => {
  assert.equal(hasBalancedBrackets('class A { void f(int[] a) { } }'), true);
  assert.equal(hasBalancedBrackets('class A { void f( { }'), false);
  assert.equal(hasBalancedBrackets('}'), false);
});

test('looksTruncated flags cut-off code and accepts complete code', () => {
  assert.equal(looksTruncated(''), true);
  assert.equal(looksTruncated('public int f() { return a.'), true);
  assert.equal(looksTruncated('public int f() { return'), true);
  assert.equal(looksTruncated('public int f() { return 1; }'), false);
});

test('extractLikelyCode drops <think> blocks and leading prose', () => {
  const raw = '<think>hmm</think>Here is the code:\npublic class Solution { }';
  assert.equal(extractLikelyCode(raw), 'public class Solution { }');
});

test('stripCodeComments (Java) removes comments but keeps string contents', () => {
  const src = 'int a = 1; // trailing\n/* block */ String s = "// not a comment";\n';
  const out = stripCodeComments(src, 'Java');
  assert.ok(!out.includes('trailing'));
  assert.ok(!out.includes('block'));
  assert.ok(out.includes('"// not a comment"'));
});

test('stripCodeComments strips C-style comments for JavaScript too, but not other languages', () => {
  assert.equal(stripCodeComments('const a = 1; // drop\n', 'JavaScript'), 'const a = 1;');
  const py = 'x = 1  # keep\n';
  assert.equal(stripCodeComments(py, 'Python'), py);
});
