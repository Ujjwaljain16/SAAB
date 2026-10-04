// bits_config.js — Verified CSS selectors and constants for Coursera BITS degree automation

export const BITS_URLS = {
  DEGREE_HOME: 'https://www.coursera.org/degrees/bachelor-of-science-computer-science-bits/home',
  BASE: 'https://www.coursera.org'
};

export const COURSERA_SEL = {
  // Navigation & Degree Outline
  drawerToggle: 'button[data-testid="drawer-toggle-button"], button[aria-label*="course outline"]',
  leftNav: 'nav[data-testid="left-nav"], [data-testid="left-nav"]',
  accordionHeader: 'button.cds-AccordionHeader-button',
  moduleHeading: '[data-testid="module-number-heading"], .cds-AccordionHeader-button',
  
  // Nav Items & Status Icons
  navItemLink: 'a[href*="/assignment-submission/"], a[href*="/exam/"], a[href*="/quiz/"]',
  successIcon: '[data-testid="learn-item-success-icon"]',
  lockIcon: '[data-testid="learn-item-lock-icon"]',

  // Degree Dashboard Course Cards
  courseCard: 'a[href*="/learn/"], [data-testid="course-card"] a, .cds-ProductCard-container a',

  // Cover Page
  coverContainer: '[data-testid="rc-CoverPageContainer"], [data-testid="assignment-cover-redesign"]',
  coverActionButton: 'button[data-testid="CoverPageActionButton"], button[aria-label*="Resume assignment"], button[aria-label*="Start assignment"]',
  
  // Tunnel Vision (Exam / Assignment Attempt)
  tunnelContainer: '[data-testid="assignment-view-tunnel-vision"], [data-testid="tunnel-vision-content"]',
  tunnelBackBtn: 'button[data-testid="tunnel-vision-back-button"]',
  guidelinesAckBtn: 'button[data-action="acknowledge-guidelines"]',
  
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
