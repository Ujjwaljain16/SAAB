// config.js — update these if Scaler changes their DOM
// Provide fallback selectors given in original architecture
export const SEL = {
  // Curriculum / Dashboard page
  subjectItem:    'a[href*="/classes"], .module-name', // links to specific subject modules
  classRow:       '.session-row, div[class*="session-row"], .curriculum-item, tr:has-text("Assignment")', 
  assignmentCount:'.assignment-count, .assignment-badge, div:has-text("%"):not(:has-text("Attendance"))', 
  classLink:      'a.session-link, a[href*="/session/"], a:has-text("View"), a:has-text("Solve")', 
  classTitleLink: 'a.me-cr-classroom-url[data-cy="classroom-link"]',
  classAssignmentLink: 'a.me-cr-classroom-url[data-cy="classroom-link"][href*="/assignment"]',

  // Inside a class
  assignmentTab:  'a#classroom-assignment, a[href*="/assignment"]',
  assignmentProblemRow: 'tr.table__row',
  assignmentProblemLink: 'a.me-cr-classroom-url.me-cr-problem-actions__btn[href*="/assignment/problems/"]',
  problemTitle:   'h1#question, body',
  problemBody:    '#problemdescription, body',
  problemLanguageInput: 'input#react-select-2-input, input[id^="react-select-"][id$="-input"]',
  problemEditor:  '.monaco-editor',

  // Monaco editor
  editorContainer:'.monaco-editor',
  editorInput:    '.monaco-editor textarea',  // real input target

  // Buttons
  submitBtn:      'button.tappable.ce-btn.btn.btn-primary.cr-judge-action.cr-judge-action--submit.btn.btn-primary.btn-small.btn-long',
  testBtn:        'button.tappable.ce-btn.btn.btn-inverted.btn-small.btn-primary.bold.m-r-10',

  // Result
  resultPass:     '.test-result:has-text("Passed")',
  resultFail:     '.test-result:has-text("Failed")',
};

// Target Subjects (partial names or regex allowed)
export const TARGET_SUBJECTS = [
  "Data Structure", 
  "Low Level Design", 
  "Programming using JS"
];
