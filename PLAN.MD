Let me study your screenshots carefully before architecting this.

Looking at image 1: **Scaler** platform — Monaco editor, Q1-Q8 sidebar, Submit button, JavaScript (ES6) selector.

Looking at image 2: Course curriculum with class list, assignment completion percentages (0/5, 0/3), subjects on left sidebar.

Let me design the complete system:Now I have everything I need. Let me build the complete plan + architecture diagram.Now the complete file-by-file implementation plan:

---

## Complete implementation plan

### Stack (free, laptop-friendly)

| Tool | Why |
|---|---|
| Node.js 20+ | runtime |
| Playwright | browser automation (lighter than Puppeteer for Scaler) |
| `@anthropic-ai/sdk` | Claude API |
| `dotenv` | store API key safely |
| `winston` | logging per question |

---

### Project structure

```
scaler-agent/
├── .env                  ← API key + your email/password
├── config.js             ← selectors for Scaler DOM
├── auth.js               ← login + save session
├── crawler.js            ← find all classes with pending assignments
├── solver.js             ← call Claude API
├── injector.js           ← paste code into Monaco, click Submit
├── main.js               ← orchestrator loop
└── logs/                 ← per-run logs
```

---

### Step 1 — `auth.js` (login once, reuse cookies)

```js
// auth.js
import { chromium } from 'playwright';

export async function login() {
  const browser = await chromium.launch({ headless: false }); // visible first time
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('https://www.scaler.com/login');
  await page.fill('input[type="email"]', process.env.SCALER_EMAIL);
  await page.fill('input[type="password"]', process.env.SCALER_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 60000 });

  // Save session — never need to log in again
  await ctx.storageState({ path: 'session.json' });
  await browser.close();
  console.log('Session saved.');
}
```

Run this once: `node -e "import('./auth.js').then(m => m.login())"`. After that every run loads `session.json` — no login, no OTP.

---

### Step 2 — `config.js` (all DOM selectors in one place)

Based on your screenshots, Scaler's DOM uses these selectors:

```js
// config.js — update these if Scaler changes their DOM
export const SEL = {
  // Curriculum page
  subjectItem:    '.module-name',           // left sidebar subjects
  classRow:       '.session-row',           // each class row
  assignmentCount:'.assignment-count',      // "2/8" badge
  classLink:      'a.session-link',         // click to open class

  // Inside a class
  assignmentTab:  'button:has-text("Assignment")',
  questionSidebar:'.question-sidebar .question-item',
  questionTitle:  '.problem-title',
  questionBody:   '.problem-description',
  testCaseBlock:  '.test-case',
  langDropdown:   '.language-selector',

  // Monaco editor
  editorContainer:'.monaco-editor',
  editorInput:    '.monaco-editor textarea',  // real input target

  // Buttons
  submitBtn:      'button:has-text("Submit")',
  testBtn:        'button:has-text("Test")',

  // Result
  resultPass:     '.test-result:has-text("Passed")',
  resultFail:     '.test-result:has-text("Failed")',
};
```

---

### Step 3 — `crawler.js` (find all pending work)

```js
// crawler.js
import { SEL } from './config.js';

export async function getQueue(page) {
  await page.goto('https://www.scaler.com/academy/mentee-dashboard/');
  await page.waitForSelector(SEL.classRow);

  const queue = []; // { classUrl, questionCount }

  const rows = await page.$$(SEL.classRow);
  for (const row of rows) {
    const countEl = await row.$(SEL.assignmentCount);
    if (!countEl) continue;

    const text = await countEl.innerText(); // e.g. "0/5" or "2/8"
    const [done, total] = text.split('/').map(Number);
    if (done >= total) continue; // already complete

    const link = await row.$eval(SEL.classLink, el => el.href);
    queue.push({ classUrl: link, pending: total - done });
  }

  console.log(`Found ${queue.length} classes with pending assignments`);
  return queue;
}
```

---

### Step 4 — `solver.js` (the AI brain)

```js
// solver.js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from .env

export async function solve(questionText, testCases, language) {
  const prompt = `
You are solving a coding assignment. Output ONLY the code, no explanation, no markdown fences.

Language: ${language}
Question:
${questionText}

Test Cases:
${testCases}

Rules:
- Match whitespace/output exactly as shown in test cases
- Do not use console.log wrappers unless the question asks for it
- Return only the raw code to paste into the editor
`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  let code = msg.content[0].text.trim();
  // Strip any accidental markdown fences
  code = code.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  return code;
}
```

---

### Step 5 — `injector.js` (paste into Monaco and submit)

Monaco is tricky — you can't just `.fill()` on it. The correct approach:

```js
// injector.js
import { SEL } from './config.js';

export async function injectAndSubmit(page, code) {
  // Wait for editor to be ready
  await page.waitForSelector(SEL.editorContainer);
  await page.click(SEL.editorContainer);
  await page.waitForTimeout(300);

  // Select all existing content and replace
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(100);

  // Use clipboard to paste (most reliable for Monaco)
  await page.evaluate(async (src) => {
    await navigator.clipboard.writeText(src);
  }, code);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(500);

  // Submit
  await page.click(SEL.submitBtn);

  // Wait for result (up to 15 seconds)
  try {
    await page.waitForSelector(`${SEL.resultPass}, ${SEL.resultFail}`, { timeout: 15000 });
    const passed = await page.$(SEL.resultPass);
    return passed ? 'pass' : 'fail';
  } catch {
    return 'timeout';
  }
}
```

---

### Step 6 — `main.js` (the orchestrator)

```js
// main.js
import 'dotenv/config';
import { chromium } from 'playwright';
import { getQueue } from './crawler.js';
import { solve } from './solver.js';
import { injectAndSubmit } from './injector.js';
import { SEL } from './config.js';
import fs from 'fs';

const DELAY = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({ headless: true }); // headless = fast
  const ctx = await browser.newContext({ storageState: 'session.json' });
  const page = await ctx.newPage();

  const queue = await getQueue(page);
  const log = [];

  for (const { classUrl } of queue) {
    await page.goto(classUrl);
    await page.click(SEL.assignmentTab);
    await page.waitForSelector(SEL.questionSidebar);

    const questions = await page.$$(SEL.questionSidebar);

    for (let i = 0; i < questions.length; i++) {
      await questions[i].click();
      await DELAY(800); // let editor mount

      const title = await page.$eval(SEL.questionTitle, el => el.innerText).catch(() => `Q${i+1}`);
      const body  = await page.$eval(SEL.questionBody, el => el.innerText).catch(() => '');
      const tests = await page.$$eval(SEL.testCaseBlock, els => els.map(e => e.innerText).join('\n')).catch(() => '');
      const lang  = await page.$eval(SEL.langDropdown, el => el.innerText).catch(() => 'JavaScript');

      console.log(`  Solving: ${title}`);

      let result = 'fail';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const code = await solve(body, tests, lang);
        result = await injectAndSubmit(page, code);
        if (result === 'pass') break;
        console.log(`    attempt ${attempt} failed, retrying...`);
        await DELAY(1000);
      }

      log.push({ title, result });
      console.log(`  ${result === 'pass' ? '✓' : '✗'} ${title}`);
      await DELAY(1500); // human-like pause between questions
    }
  }

  fs.writeFileSync('run-log.json', JSON.stringify(log, null, 2));
  console.log(`\nDone. ${log.filter(l => l.result==='pass').length}/${log.length} passed.`);
  await browser.close();
}

run().catch(console.error);
```

---

### `.env` file

```
ANTHROPIC_API_KEY=sk-ant-...
SCALER_EMAIL=your@email.com
SCALER_PASS=yourpassword
```

---

### How to run

```bash
# One time setup
npm init -y
npm install playwright @anthropic-ai/sdk dotenv
npx playwright install chromium   # downloads ~100MB chromium binary

# Login once (opens browser window, you verify it works)
node auth.js

# Run the agent (fully headless after this)
node main.js
```

---

### Key things you need to verify first

Before running on all assignments, do this manually once:

1. Open DevTools on a Scaler assignment page
2. Right-click the question text → Inspect → copy the actual CSS class
3. Right-click the Monaco editor → Inspect → confirm it's `.monaco-editor`
4. Right-click the Submit button → Inspect → confirm button text is exactly "Submit"
5. Update `config.js` with the real selectors

The selectors I gave are based on typical Scaler DOM patterns from your screenshots — but they might be slightly different. Spend 10 minutes confirming these and the whole thing runs first try.

Want me to write the DOM-inspection script that auto-discovers all selectors for you, or generate the full ready-to-run code as a downloadable file?