import 'dotenv/config';
import { chromium } from 'playwright';

/**
 * DOM Discovery Script for Scaler
 * Run this. It will open a browser.
 * Navigate manually to an assignment page with a Monaco editor.
 * The script will periodically try to auto-discover the selectors and print them.
 */
async function discover() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Please log into Scaler (if not already) and navigate to an active coding assignment page.');
  
  await page.goto('https://www.scaler.com/login');

  console.log('Waiting for you to navigate... (Checking every 5 seconds)');

  // Loop to check the DOM for known patterns
  setInterval(async () => {
    try {
      const isQuestionPage = await page.evaluate(() => {
        // Simple heuristic: if monaco is on the page, we are probably in an assignment
        return document.querySelectorAll('.monaco-editor').length > 0;
      });

      if (isQuestionPage) {
        console.log('\n--- Discovered Selectors ---');
        const selectors = await page.evaluate(() => {
          const findSelector = (query) => {
            const el = document.querySelector(query);
            return el ? query : null;
          };

          const guessButton = (text) => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => b.innerText.includes(text));
            if (btn) {
              if (btn.className) return 'button.' + btn.className.split(' ').join('.');
              return `button:has-text("${text}")`;
            }
            return null;
          };

          return {
            editorContainer: findSelector('.monaco-editor') || 'Try: .monaco-editor',
            submitBtn: guessButton('Submit') || guessButton('Run') || 'Try: button:has-text("Submit")',
            testBtn: guessButton('Test') || guessButton('Custom Input') || 'Try: button:has-text("Test")',
            questionTitle: findSelector('.problem-title') || findSelector('h1') || 'Try: .problem-title',
            questionBody: findSelector('.problem-description') || findSelector('.markdown-body') || 'Try: .problem-description',
            langDropdown: findSelector('.language-selector') || 'Try checking dropdown classes'
          };
        });
        
        console.log(JSON.stringify(selectors, null, 2));
        console.log('Update your config.js to use the selectors found above.');
        console.log('----------------------------\n');
      }
    } catch (e) {
      // Ignore context destroyed errors when navigating
    }
  }, 5000);
}

discover().catch(console.error);
