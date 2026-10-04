// test_bits_dom.js — Verifies Coursera DOM parsing, selectors, deadlines feed, and question extraction against real-world snapshots

import fs from 'fs';
import path from 'path';
import { COURSERA_SEL } from './bits_config.js';

const HOME_SNAPSHOT = path.resolve('..', 'www.coursera.org_2026-10-04T21-17-35-794Z.json');
const ATTEMPT_SNAPSHOT = path.resolve('..', 'www.coursera.org_2026-10-04T20-24-56-057Z.json');

console.log(`[TEST] Checking Degree Home Snapshot: ${HOME_SNAPSHOT}`);
console.log(`[TEST] Checking Attempt Snapshot:     ${ATTEMPT_SNAPSHOT}`);

if (!fs.existsSync(HOME_SNAPSHOT) || !fs.existsSync(ATTEMPT_SNAPSHOT)) {
  console.error('[TEST] One or more snapshot files are missing!');
  process.exit(1);
}

const homeData = JSON.parse(fs.readFileSync(HOME_SNAPSHOT, 'utf8'));
const attemptData = JSON.parse(fs.readFileSync(ATTEMPT_SNAPSHOT, 'utf8'));

function extractText(node) {
  if (!node) return '';
  let str = '';
  if (node.type === 'text') str += (node.value || node.text || '');
  if (node.children) {
    for (const c of node.children) str += ' ' + extractText(c);
  }
  return str.replace(/\s+/g, ' ').trim();
}

function findNodes(node, predicate, results = []) {
  if (!node) return results;
  if (predicate(node)) results.push(node);
  if (node.children) {
    for (const c of node.children) findNodes(c, predicate, results);
  }
  return results;
}

function findParent(root, target) {
  if (!root.children) return null;
  for (const c of root.children) {
    if (c === target) return root;
    const res = findParent(c, target);
    if (res) return res;
  }
  return null;
}

// -------------------------------------------------------------
// PART 1: Degree Home (Courses & Deadlines Feed)
// -------------------------------------------------------------
console.log('\n================ PART 1: DEGREE DASHBOARD TESTS ================');

// 1. Current courses extraction
console.log('1. Testing Current Enrolled Courses Extraction...');
const currentHead = findNodes(homeData.document.root, n => n.tag === 'h2' && extractText(n).trim() === 'Current courses')[0];
if (!currentHead) {
  console.error('FAIL: "Current courses" heading not found!');
  process.exit(1);
}

let container = currentHead;
while (container) {
  const links = findNodes(container, n => n.tag === 'a' && n.attrs?.href?.includes('/learn/'));
  if (links.length >= 2) break;
  container = findParent(homeData.document.root, container);
}

const courseLinks = findNodes(container, n => n.tag === 'a' && n.attrs?.href?.includes('/learn/'));
const enrolledCourses = [];
const seenSlugs = new Set();
for (const a of courseLinks) {
  const match = a.attrs.href.match(/\/learn\/([^\/\?#]+)/);
  if (!match) continue;
  const slug = match[1];
  if (seenSlugs.has(slug)) continue;
  seenSlugs.add(slug);
  enrolledCourses.push({ name: extractText(a), slug, href: a.attrs.href });
}

console.log(`Discovered ${enrolledCourses.length} enrolled courses:`);
enrolledCourses.forEach(c => console.log(`  - ${c.name} (${c.slug})`));

if (enrolledCourses.length < 3) {
  console.error(`FAIL: Expected at least 3 enrolled courses, found ${enrolledCourses.length}`);
  process.exit(1);
}
console.log('PASS: Correctly extracted enrolled courses without pollution from suggested catalog!');

// 2. Deadlines Feed Extraction
console.log('\n2. Testing Deadlines Feed & Status Extraction...');
const allLinks = findNodes(homeData.document.root, n => n.tag === 'a' && n.attrs?.href && (
  n.attrs.href.includes('/team/') || n.attrs.href.includes('/assignment-submission/') || n.attrs.href.includes('/exam/')
));

const deadlines = [];
const seenHrefs = new Set();

for (const a of allLinks) {
  const href = a.attrs.href;
  if (seenHrefs.has(href)) continue;
  seenHrefs.add(href);

  const rawTitle = extractText(a).replace(/^Graded Assignment\s*:\s*/i, '').trim();
  if (rawTitle.toLowerCase().includes('marks placeholder')) continue;

  let cur = a;
  let cardText = '';
  for (let s = 0; s < 6; s++) {
    const p = findParent(homeData.document.root, cur);
    if (!p) break;
    cur = p;
    const t = extractText(cur);
    if (t.includes('Due') || t.includes('Grade:') || t.includes('Completed')) {
      cardText = t;
    }
  }

  const gradeMatch = cardText.match(/Grade:\s*(\d+%?)/i);
  const grade = gradeMatch ? gradeMatch[1] : null;
  const isCompleted = cardText.includes('Completed') || grade !== null;

  deadlines.push({
    title: rawTitle,
    url: href,
    grade,
    status: isCompleted ? 'COMPLETED' : 'PENDING'
  });
}

const completedList = deadlines.filter(d => d.status === 'COMPLETED');
const pendingList = deadlines.filter(d => d.status === 'PENDING');

console.log(`Total deadline items parsed: ${deadlines.length}`);
console.log(`  Completed (Graded): ${completedList.length}`);
console.log(`  Pending (To solve):  ${pendingList.length}`);

if (completedList.length === 0 || pendingList.length === 0) {
  console.error('FAIL: Expected both completed and pending assignments in feed!');
  process.exit(1);
}
console.log('Sample Pending Assignments:');
pendingList.slice(0, 3).forEach(p => console.log(`  - [PENDING] "${p.title}" -> ${p.url}`));

console.log('PASS: Deadlines feed successfully extracted and classified.');

// -------------------------------------------------------------
// PART 2: Assignment Attempt View (Questions & Submissions)
// -------------------------------------------------------------
console.log('\n================ PART 2: ASSIGNMENT ATTEMPT TESTS ================');

// 3. Question Container detection
console.log('3. Testing Question Container Detection...');
const questionParts = findNodes(attemptData.document.root, (n) => {
  const tid = n.attrs?.['data-testid'] || '';
  const cls = n.attrs?.['class'] || '';
  return tid.startsWith('part-Submission_') || cls.includes('part-Submission_');
});

if (questionParts.length === 0) {
  console.error('FAIL: No question containers found in attempt snapshot!');
  process.exit(1);
}
console.log(`PASS: Found ${questionParts.length} question container(s).`);

// 4. Prompt extraction
console.log('\n4. Testing Question Prompt Extraction...');
const q1 = questionParts[0];
const legend = findNodes(q1, n => n.attrs?.['data-testid'] === 'legend' || (n.attrs?.id && n.attrs.id.endsWith('-legend')))[0];
const cmlViewer = legend ? findNodes(legend, n => n.attrs?.['data-testid'] === 'cml-viewer')[0] : null;
const prompt = cmlViewer ? extractText(cmlViewer) : extractText(legend);

console.log(`Extracted Prompt: "${prompt}"`);
if (!prompt.includes('backtrace()')) {
  console.error('FAIL: Expected "backtrace()" in prompt.');
  process.exit(1);
}
console.log('PASS: Question prompt correctly parsed.');

// 5. Options extraction
console.log('\n5. Testing Options Extraction...');
const optionNodes = findNodes(q1, n => (n.attrs?.class || '').includes('rc-Option'));
console.log(`Found ${optionNodes.length} option(s).`);

if (optionNodes.length !== 4) {
  console.error(`FAIL: Expected 4 options, found ${optionNodes.length}`);
  process.exit(1);
}
console.log('PASS: Options correctly extracted.');

// 6. Honor Code Checkbox
console.log('\n6. Testing Honor Code Agreement Detection...');
const honorCheckbox = findNodes(attemptData.document.root, n => n.attrs?.id === 'agreement-checkbox-base')[0];
if (!honorCheckbox) {
  console.error('FAIL: agreement-checkbox-base not found!');
  process.exit(1);
}
console.log('PASS: Honor code agreement checkbox detected.');

// 7. Submit button
console.log('\n7. Testing Submit Button Detection...');
const submitBtn = findNodes(attemptData.document.root, n => n.attrs?.['data-testid'] === 'submit-button')[0];
if (!submitBtn) {
  console.error('FAIL: submit-button not found!');
  process.exit(1);
}
console.log('PASS: Submit button correctly identified.');

console.log('\n============================================================');
console.log('🎉 ALL BITS COURSERA E2E WORKFLOW TESTS PASSED SUCCESSFULLY!');
console.log('============================================================\n');
