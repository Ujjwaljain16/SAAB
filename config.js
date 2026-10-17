// config.js — update these if Scaler changes their DOM
export const SEL = {
  // Curriculum / Dashboard page
  subjectItem:    'a[href*="/core-curriculum/m/"][href*="/classes"], a[href*="/classes"], .module-name', 
  classRow:       '.session-row, div[class*="session-row"], .curriculum-item, tr:has-text("Assignment")', 
  assignmentCount:'.assignment-count, .assignment-badge, div:has-text("%"):not(:has-text("Attendance"))', 
  classLink:      'a.session-link, a[href*="/session/"], a:has-text("View"), a:has-text("Solve")', 
  classTitleLink: 'a.me-cr-classroom-url[data-cy="classroom-link"], a[href*="/academy/mentee-dashboard/class/"]:not([href*="/assignment"]):not([href*="/homework"])',
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
  editorInput:    '.monaco-editor textarea',

  // Buttons
  submitBtn:      'button.cr-judge-action--submit, button:has-text("Submit"), a:has-text("Submit")',
  testBtn:        'button.cr-judge-action--test, button:has-text("Test with custom input")',

  // Result
  resultPass:     '.test-result:has-text("Passed")',
  resultFail:     '.test-result:has-text("Failed")',

  // Scaler uses CSS-modules, so class names carry a build hash (e.g. Submit-module_btn__tpMzw) that changes
  // on every deploy. Match the stable prefix with [class*=...] instead of the full hashed name.
  botWidgets:     '[class*="SolveBot"], [class*="Companion-module_root"]',
  ideContainer:   '#vscode-ide, [class*="EditorLayout-module_container"], .code-editor-layer',
  labLaunchBtn:   '[class*="LaunchButton-module_btn"]',
  // Real lab page: the Run Task button is `a.Tappable-module_root.Submit-module_btn...`. A HIDDEN "Run Task" link inside
  // StageResetWarningModal comes BEFORE it in the DOM, so a text-based selector must never be the primary one (.first() would
  // grab the hidden modal link). Text selectors are only a fallback and explicitly exclude the modal.
  labSubmitBtn:   'a[class*="Submit-module_btn"], button[class*="Submit-module_btn"]',
  labSubmitFallback: 'button:has-text("Run Task"), a:has-text("Run Task"):not([class*="StageResetWarningModal"]), button:has-text("Submit")',
  // Scaler warns "Running a completed task will reset progress for all the next tasks". We Cancel it, never confirm it.
  labResetCancelBtn: 'a[class*="StageResetWarningModal-module_cancelButton"]',
  labProceedBtn:  'a:has-text("Proceed"):not([class*="StageResetWarningModal"]), button:has-text("Proceed")',
  labTestCases:   '[class*="TestCases-module_container"], [class*="TestCase"]',
};

// Target Subjects: If specified in .env, filter to those; otherwise SAAB auto-discovers all subjects in the current term!
export const TARGET_SUBJECTS = process.env.TARGET_SUBJECTS
  ? process.env.TARGET_SUBJECTS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
