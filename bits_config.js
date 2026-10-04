// bits_config.js — Verified CSS selectors and constants for Coursera BITS degree automation

export const BITS_URLS = {
  DEGREE_HOME: 'https://www.coursera.org/degrees/bachelor-of-science-computer-science-bits/home',
  BASE: 'https://www.coursera.org'
};

export const COURSERA_SEL = {
  // Authentication & Profile
  userProfile: '[data-e2e="header-profile"], [data-testid="user-avatar"], [aria-label*="User dropdown menu"]',
  loginRedirect: 'form[action*="login"], input[type="password"], button:has-text("Log In")',

  // Degree Dashboard: Current Courses & Deadlines
  currentCoursesHeading: 'h2:has-text("Current courses")',
  inProgressTab: 'button[role="tab"]:has-text("In Progress")',
  summaryTab: 'button[role="tab"]:has-text("Summary")',
  assignmentLink: 'a[href*="/team/"], a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]',
  dateHeading: 'h3, button:has-text("Oct"), button:has-text("Nov"), button:has-text("Sep")',
  gradeBadge: ':has-text("Grade:"), :has-text("%")',

  // Course Outline (Inside Course)
  drawerToggle: 'button[data-testid="drawer-toggle-button"], button[aria-label*="course outline"]',
  leftNav: 'nav[data-testid="left-nav"], [data-testid="left-nav"]',
  accordionHeader: 'button.cds-AccordionHeader-button',
  moduleHeading: '[data-testid="module-number-heading"], .cds-AccordionHeader-button',
  navItemLink: 'a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]',
  successIcon: '[data-testid="learn-item-success-icon"]',
  lockIcon: '[data-testid="learn-item-lock-icon"]',

  // Cover Page / Team Launch Page
  coverContainer: '[data-testid="rc-CoverPageContainer"], [data-testid="assignment-cover-redesign"], .rc-CoverPageContainer',
  coverActionButton: 'button[data-testid="CoverPageActionButton"], button[aria-label*="Resume assignment"], button[aria-label*="Start assignment"], a:has-text("Start"), a:has-text("Resume"), a:has-text("Go to assignment"), button:has-text("Start"), button:has-text("Resume"), button:has-text("Go to assignment")',
  
  // Tunnel Vision (Exam / Assignment Attempt)
  tunnelContainer: '[data-testid="assignment-view-tunnel-vision"], [data-testid="tunnel-vision-content"]',
  tunnelBackBtn: 'button[data-testid="tunnel-vision-back-button"]',
  guidelinesAckBtn: 'button[data-action="acknowledge-guidelines"], button:has-text("I understand")',
  
  // Questions
  questionContainer: 'div[data-testid^="part-Submission_"], div[class*="part-Submission_"]',
  legend: '[data-testid="legend"], div[id$="-legend"]',
  cmlViewer: '[data-testid="cml-viewer"], .rc-CML',
  pointsBadge: '[data-testid="part-points"]',
  
  // Options (Radio / Checkbox)
  optionContainer: '.rc-Option',
  optionInput: 'input[type="radio"], input[type="checkbox"]',
  optionLabel: '.cds-checkboxAndRadio-labelText',

  // Honor Code & Submission
  honorCodeContainer: '[data-testid="HonorCodeAgreement"], [data-testid="agreement-standalone-checkbox"]',
  honorCodeCheckbox: '#agreement-checkbox-base, [data-testid="agreement-checkbox"] input, [data-testid="agreement-standalone-checkbox"] input',
  submitButton: 'button[data-testid="submit-button"]',
  saveDraftButton: 'button[data-testid="save-draft-button"]',
  gradingScreen: '[data-testid="grading-in-progress-screen"]'
};

export const COURSERA_TIMEOUTS = {
  PAGE_LOAD: 60000,
  ELEMENT_WAIT: 10000,
  SUBMISSION_WAIT: 30000
};
