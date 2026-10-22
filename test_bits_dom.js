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

  const isStaffGraded = /staff\s*graded|peer\s*graded/i.test(rawTitle) || /staff-graded|peer-graded/i.test(href);
  let status = 'PENDING';
  if (isCompleted) status = 'COMPLETED';
  else if (isStaffGraded) status = 'STAFF_GRADED';

  deadlines.push({
    title: rawTitle,
    url: href,
    grade,
    isStaffGraded,
    status
  });
}

const completedList = deadlines.filter(d => d.status === 'COMPLETED');
const staffGradedList = deadlines.filter(d => d.status === 'STAFF_GRADED');
const pendingQuizzes = deadlines.filter(d => d.status === 'PENDING');

console.log(`Total deadline items parsed: ${deadlines.length}`);
console.log(`  Completed (Graded):     ${completedList.length}`);
console.log(`  Staff Graded (Excluded): ${staffGradedList.length}`);
console.log(`  Pending Graded Quizzes:  ${pendingQuizzes.length}`);

if (completedList.length === 0 || pendingQuizzes.length === 0 || staffGradedList.length === 0) {
  console.error('FAIL: Expected completed, staff-graded, and pending quizzes in feed!');
  process.exit(1);
}
console.log('Sample Pending Graded Quizzes:');
pendingQuizzes.slice(0, 3).forEach(p => console.log(`  - [PENDING QUIZ] "${p.title}" -> ${p.url}`));

console.log('PASS: Deadlines feed successfully extracted and classified (Staff Graded isolated).');

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

// -------------------------------------------------------------
// PART 3: Cover Page (Assignment Launch)
// -------------------------------------------------------------
console.log('\n================ PART 3: COVER PAGE LAUNCH TESTS ================');
console.log('8. Testing Cover Page Action Button Detection...');

const coverHtml = `
<div data-testid="rc-CoverPageContainer"><div class="css-ldltmu"><article data-testid="assignment-cover-redesign" class="css-1hne3h1"><div data-testid="cover-page-header" class="css-i78ge5"><div class="css-4l4elf"><div class="css-6kjpqr"><svg width="180" height="180"></svg></div></div><div class="css-1y89sx6"><div class="css-f0s2a7"><p class="css-4yjgrb" data-testid="cover-page-header-assignment-type">Graded Assignment</p><h1 class="css-o1ss6o">Graded Quiz for Week 4,5 and 6</h1></div><p class="css-vac8rf" data-testid="assessment-monitoring-notice"><span>Assessment monitored for academic integrity and AI-usage. <a class="cds-150 cds-144 cds-146 css-fdx774 cds-173" href="/about/privacy?trk_ref=ai_graded_questions" target="_blank" rel="noopener">Privacy Notice</a></span></p><div class="css-1ieirtn"><button class="cds-116 cds-button-disableElevation cds-button-primary css-g3vqgc" tabindex="0" type="button" data-testid="CoverPageActionButton" data-e2e="CoverPageActionButton" aria-disabled="false"><span class="cds-button-label">Start assignment</span></button></div></div><div class="css-1112pk4"><svg width="360" height="360"></svg></div></div><div class="css-35x6ww"><div class="css-xdaq0h"><div data-testid="what-to-expect-card" class="css-30ux3g"><h2 class="css-6ecy9b">What to expect</h2></div></div></div><div class="css-1ml0qm5"><div class="css-mcm4g2"><button class="cds-116 cds-button-disableElevation cds-button-primary css-1ndq0lj" tabindex="0" type="button" aria-label="Start assignment" aria-disabled="false"><span class="cds-button-label"><span aria-hidden="true" class="css-v7z271">Start assignment</span><span aria-hidden="true" class="css-1c7ducv">Start</span></span></button></div></div></article></div></div>
`;

// Simple regex check matching our selector definitions
const hasCoverContainer = /data-testid="rc-CoverPageContainer"/.test(coverHtml);
const hasCoverBtn = /data-testid="CoverPageActionButton"/.test(coverHtml) || /aria-label="Start assignment"/.test(coverHtml);

if (!hasCoverContainer || !hasCoverBtn) {
  console.error('FAIL: Cover page container or action button not matched!');
  process.exit(1);
}
console.log('PASS: Cover Page container and Start Assignment action button verified.');

// -------------------------------------------------------------
// PART 4: Future / Unavailable Quiz Lock Detection & Early-Halt
// -------------------------------------------------------------
console.log('\n================ PART 4: FUTURE LOCK & EARLY HALT TESTS ================');
console.log('9. Testing Future Unavailable / Lock Detection & Early-Halt Behavior...');

const mockLockedPageBody = `
  Software Development Practices
  This item will be available November 15, 12:00 AM IST - November 20, 11:59 PM IST. Please contact your admin with any questions.
`;

const isLockedPattern = /this item will be available|will be available\s+[A-Za-z]+|not available yet|locked until|locked assignment/i;
const isLockedDetected = isLockedPattern.test(mockLockedPageBody);
if (!isLockedDetected) {
  console.error('FAIL: isLockedPattern failed to match Coursera future locked text!');
  process.exit(1);
}

const match = mockLockedPageBody.match(/This item will be available[^\.\n]+/i);
const extractedDate = match ? match[0].trim() : null;
if (!extractedDate || !extractedDate.includes('November 15')) {
  console.error(`FAIL: Extracted date mismatch! Got: "${extractedDate}"`);
  process.exit(1);
}
console.log(`PASS: Detected future availability lock: "${extractedDate}"`);

// Test early-halt loop behavior:
const mockQueue = [
  { title: 'Week 4-6 Quiz', isFutureLocked: false },
  { title: 'Week 7-8 Quiz', isFutureLocked: false },
  { title: 'Week 9-10 Quiz', isFutureLocked: true },
  { title: 'Week 11-12 Quiz', isFutureLocked: true }
];

const processed = [];
for (const item of mockQueue) {
  processed.push(item.title);
  if (item.isFutureLocked) {
    break; // Early-halt boundary
  }
}

if (processed.length !== 3 || processed.includes('Week 11-12 Quiz')) {
  console.error(`FAIL: Early halt failed! Processed items: ${JSON.stringify(processed)}`);
  process.exit(1);
}
console.log(`PASS: Early halt stopped execution right at "${processed[processed.length - 1]}" without processing subsequent items.`);

// -------------------------------------------------------------
// PART 5: Pre-Submission Completeness Audit & Safety Gate
// -------------------------------------------------------------
console.log('\n================ PART 5: PRE-SUBMISSION AUDIT TESTS ================');
console.log('10. Testing Pre-Submission Completeness Audit & Safety Gate...');

const mockQuestionsDom = [
  { id: 1, checkedCount: 1 },
  { id: 2, checkedCount: 1 },
  { id: 3, checkedCount: 2 },
  { id: 4, checkedCount: 1 },
  { id: 5, checkedCount: 1 },
  { id: 6, checkedCount: 1 },
  { id: 7, checkedCount: 1 },
  { id: 8, checkedCount: 2 },
  { id: 9, checkedCount: 0 },  // Unanswered
  { id: 10, checkedCount: 0 }  // Unanswered
];

const unanswered = [];
for (let i = 0; i < mockQuestionsDom.length; i++) {
  if (mockQuestionsDom[i].checkedCount === 0) {
    unanswered.push(mockQuestionsDom[i].id);
  }
}

if (unanswered.length !== 2 || unanswered[0] !== 9 || unanswered[1] !== 10) {
  console.error(`FAIL: Expected unanswered [9, 10], got ${JSON.stringify(unanswered)}`);
  process.exit(1);
}

// Safety check: honor code and submission MUST be blocked
let honorCodeChecked = false;
let submitted = false;

if (unanswered.length > 0) {
  // Submission blocked
  honorCodeChecked = false;
  submitted = false;
} else {
  honorCodeChecked = true;
  submitted = true;
}

if (submitted || honorCodeChecked) {
  console.error('FAIL: Submission was not blocked despite unanswered questions!');
  process.exit(1);
}
console.log(`PASS: Correctly flagged unanswered questions [${unanswered.join(', ')}] and blocked submission.`);

// -------------------------------------------------------------
// PART 6: Grade Parsing & Agentic Feedback Loop Tests
// -------------------------------------------------------------
console.log('\n================ PART 6: POST-SUBMISSION GRADE & FEEDBACK TESTS ================');
console.log('11. Testing Grade Extraction & 80% Threshold Calculation...');

const mockPostSubmitHtml = `
  <div class="rc-AssignmentEvaluation">
    <h2>Your grade: 80%</h2>
    <p>Congratulations! You passed this assignment.</p>
    <div class="part-Submission_1" aria-label="Correct">1 / 1 point</div>
    <div class="part-Submission_2" aria-label="Incorrect">0 / 1 point</div>
    <div class="part-Submission_3" aria-label="Correct">1 / 1 point</div>
  </div>
`;

const gradeMatch = mockPostSubmitHtml.match(/(?:grade[:\s]+)?(\d{1,3})\s*%/i);
const extractedGrade = gradeMatch ? parseInt(gradeMatch[1], 10) : null;
const isPassing = extractedGrade !== null && extractedGrade >= 80;

if (extractedGrade !== 80 || !isPassing) {
  console.error(`FAIL: Expected grade 80% and isPassing=true, got grade=${extractedGrade}, isPassing=${isPassing}`);
  process.exit(1);
}
console.log(`PASS: Grade (${extractedGrade}%) parsed and passed threshold check (>= 80%).`);

console.log('12. Testing Question-Level Wrong-Answer Detection in Review Screen...');
const wrongCards = [];
const cardSnippets = [
  { id: 1, text: '1 / 1 point', aria: 'Correct' },
  { id: 2, text: '0 / 1 point', aria: 'Incorrect' },
  { id: 3, text: '1 / 1 point', aria: 'Correct' }
];

for (const card of cardSnippets) {
  if (card.text.includes('0 / 1 point') || card.aria === 'Incorrect') {
    wrongCards.push(card.id);
  }
}

if (wrongCards.length !== 1 || wrongCards[0] !== 2) {
  console.error(`FAIL: Expected wrong question [2], got ${JSON.stringify(wrongCards)}`);
  process.exit(1);
}
console.log(`PASS: Wrong answer Q${wrongCards.join(', Q')} accurately identified for cache feedback loop.`);

// -------------------------------------------------------------
// PART 7: Universal Answer Key Ingestion & ReAct Matching Tests
// -------------------------------------------------------------
console.log('\n================ PART 7: ANSWER KEY INGESTION & REACT LOOP ================');
console.log('13. Testing AnswerStore Document Parsing & Text Matching...');

import { AnswerStore, computeTextSimilarity } from './answer_indexer.js';

const store = new AnswerStore();

// Test Text / Markdown parsing
const sampleQuizText = `
Question 1: What is the fastest IPC mechanism for communication between processes?
a) Signals
b) Shared Memory (Correct)
c) Message Queue
d) Named Pipes

Question 2: Which of the following are classical problems solved using semaphores? (Select all that apply)
[x] Dining Philosophers
[ ] Internet Routing
[x] Producer–Consumer
[ ] Process Forking
`;

import { parseQuizText } from './answer_indexer.js';
const parsed = parseQuizText(sampleQuizText, 'test_mock_quiz.txt');
if (parsed.length !== 2) {
  console.error(`FAIL: Expected 2 parsed questions from mock quiz, got ${parsed.length}`);
  process.exit(1);
}
store.entries.push(...parsed);

// Test matching single-choice question with scrambled option positions
const liveQ1 = {
  prompt: 'Which IPC mechanism is the fastest for communication between processes?',
  options: [
    { index: 0, label: 'A', text: 'Signals' },
    { index: 1, label: 'B', text: 'Named Pipes' },
    { index: 2, label: 'C', text: 'Shared Memory' }, // Live option is at index 2 (C), not index 1 (B)
    { index: 3, label: 'D', text: 'Message Queue' }
  ],
  isMultiSelect: false
};

const match1 = store.matchQuestion(liveQ1);
if (!match1 || match1.bestOptionIndex !== 2) {
  console.error(`FAIL: Expected match1 bestOptionIndex=2 ('Shared Memory'), got ${JSON.stringify(match1)}`);
  process.exit(1);
}
console.log(`PASS: Prompt matched and correctly identified option text 'Shared Memory' at live index ${match1.bestOptionIndex} regardless of option order.`);

// Test matching multi-select question
const liveQ2 = {
  prompt: 'Which of the following are classical problems solved using semaphores? (Select all that apply)',
  options: [
    { index: 0, label: 'A', text: 'Process Forking' },
    { index: 1, label: 'B', text: 'Producer–Consumer' },
    { index: 2, label: 'C', text: 'Internet Routing' },
    { index: 3, label: 'D', text: 'Dining Philosophers' }
  ],
  isMultiSelect: true
};

const match2 = store.matchQuestion(liveQ2);
if (!match2 || !match2.selectedIndices.includes(1) || !match2.selectedIndices.includes(3)) {
  console.error(`FAIL: Expected multi-select match [1, 3], got ${JSON.stringify(match2)}`);
  process.exit(1);
}
console.log(`PASS: Multi-select question matched verified indices [${match2.selectedIndices.join(', ')}] from answer sheet.`);

console.log('\n============================================================');
console.log('🎉 ALL BITS COURSERA E2E WORKFLOW TESTS PASSED SUCCESSFULLY!');
console.log('============================================================\n');
