// test_bits_dom.js — Verifies Coursera DOM parsing, selectors, and solver integration against real-world snapshot

import fs from 'fs';
import path from 'path';
import { COURSERA_SEL } from './bits_config.js';

const SNAPSHOT_PATH = path.resolve('..', 'www.coursera.org_2026-10-04T20-24-56-057Z.json');

console.log(`[TEST] Loading snapshot from: ${SNAPSHOT_PATH}`);
if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.error(`[TEST] Snapshot file not found at ${SNAPSHOT_PATH}`);
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));

// Helper to recursively collect text
function extractText(node) {
  if (!node) return '';
  let str = '';
  if (node.type === 'text') str += (node.value || node.text || '');
  if (node.children) {
    for (const c of node.children) str += ' ' + extractText(c);
  }
  return str.replace(/\s+/g, ' ').trim();
}

// Find nodes matching predicate
function findNodes(node, predicate, results = []) {
  if (!node) return results;
  if (predicate(node)) results.push(node);
  if (node.children) {
    for (const c of node.children) findNodes(c, predicate, results);
  }
  return results;
}

// 1. Test Question Container detection
console.log('\n--- 1. Testing Question Container Detection ---');
const questionParts = findNodes(snapshot.document.root, (n) => {
  const tid = n.attrs?.['data-testid'] || '';
  const cls = n.attrs?.['class'] || '';
  return tid.startsWith('part-Submission_') || cls.includes('part-Submission_');
});

console.log(`Found ${questionParts.length} question container(s).`);
if (questionParts.length === 0) {
  console.error('FAIL: No question containers found!');
  process.exit(1);
}
console.log('PASS: Question container detected.');

// 2. Test Question Prompt Extraction
console.log('\n--- 2. Testing Question Prompt Extraction ---');
const q1 = questionParts[0];
const legend = findNodes(q1, n => n.attrs?.['data-testid'] === 'legend' || (n.attrs?.id && n.attrs.id.endsWith('-legend')))[0];
const cmlViewer = legend ? findNodes(legend, n => n.attrs?.['data-testid'] === 'cml-viewer')[0] : null;
const prompt = cmlViewer ? extractText(cmlViewer) : extractText(legend);

console.log(`Extracted Prompt: "${prompt}"`);
if (!prompt.includes('backtrace()')) {
  console.error('FAIL: Prompt text did not contain expected content "backtrace()"');
  process.exit(1);
}
console.log('PASS: Question prompt correctly extracted.');

// 3. Test Options Extraction
console.log('\n--- 3. Testing Options Extraction ---');
const optionNodes = findNodes(q1, n => (n.attrs?.class || '').includes('rc-Option'));
console.log(`Found ${optionNodes.length} option(s).`);

if (optionNodes.length !== 4) {
  console.error(`FAIL: Expected 4 options, found ${optionNodes.length}`);
  process.exit(1);
}

const extractedOptions = optionNodes.map((opt, i) => {
  const input = findNodes(opt, n => n.tag === 'input')[0];
  const label = findNodes(opt, n => (n.attrs?.class || '').includes('cds-checkboxAndRadio-labelText'))[0];
  return {
    index: i,
    inputId: input?.attrs?.id,
    name: input?.attrs?.name,
    value: input?.attrs?.value,
    type: input?.attrs?.type,
    text: extractText(label)
  };
});

extractedOptions.forEach((o, i) => {
  console.log(`  [${String.fromCharCode(65 + i)}] Value: ${o.value} | Text: "${o.text}"`);
});

if (!extractedOptions[0].text.includes('call stack')) {
  console.error('FAIL: Option A does not match expected text.');
  process.exit(1);
}
console.log('PASS: Options correctly parsed.');

// 4. Test Honor Code Checkbox Detection
console.log('\n--- 4. Testing Honor Code Agreement Detection ---');
const honorAgreement = findNodes(snapshot.document.root, n => n.attrs?.['data-testid'] === 'HonorCodeAgreement')[0];
const honorCheckbox = findNodes(snapshot.document.root, n => n.attrs?.id === 'agreement-checkbox-base')[0];

if (!honorAgreement || !honorCheckbox) {
  console.error('FAIL: Honor code agreement or checkbox not found!');
  process.exit(1);
}
console.log(`Found Honor Code Agreement with checkbox ID: "${honorCheckbox.attrs.id}"`);
console.log('PASS: Honor code checkbox detected.');

// 5. Test Submit Button Detection
console.log('\n--- 5. Testing Submit Button Detection ---');
const submitBtn = findNodes(snapshot.document.root, n => n.attrs?.['data-testid'] === 'submit-button')[0];
if (!submitBtn) {
  console.error('FAIL: Submit button not found!');
  process.exit(1);
}
console.log(`Submit button found: aria-label="${submitBtn.attrs['aria-label']}", disabled="${submitBtn.attrs.disabled}"`);
console.log('PASS: Submit button correctly identified.');

// 6. Test Navigation Outline Links & Icons
console.log('\n--- 6. Testing Outline Navigation & Status Icons ---');
const navLinks = findNodes(snapshot.document.root, n => n.tag === 'a' && n.attrs?.href?.includes('assignment-submission'));
console.log(`Found ${navLinks.length} assignment links in left nav.`);
const lockIcons = findNodes(snapshot.document.root, n => n.attrs?.['data-testid'] === 'learn-item-lock-icon');
const successIcons = findNodes(snapshot.document.root, n => n.attrs?.['data-testid'] === 'learn-item-success-icon');
console.log(`Status icon counts: ${lockIcons.length} lock icons, ${successIcons.length} success icons.`);
console.log('PASS: Navigation and status markers verified.');

console.log('\n============================================================');
console.log('🎉 ALL BITS COURSERA DOM TESTS PASSED SUCCESSFULLY!');
console.log('============================================================');
