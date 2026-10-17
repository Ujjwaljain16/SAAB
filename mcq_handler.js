import { purgeBotWidgets } from './page_utils.js';
import { getProblemSolveState } from './scaler_page.js';

/**
 * mcq_handler.js
 * Handles MCQ scraping and answer injection for Scaler assignments.
 * Supports text-based and image-based (screenshot) MCQ questions.
 */

/**
 * Slurp all context needed to solve an MCQ:
 * - title, body text, options
 * - screenshot (base64) if body is empty/very short (image-based question)
 */
export async function slurpMCQContext(page) {
    const title = await page.title();

    // Try the most specific selector first, then broaden
    const body = await page.evaluate(() => {
        const selectors = [
            '.cr-p-statement',
            '.cr-multiple-choice-container__heading',
            '.cr-p-statement-content',
            '[class*="statement"]',
            '[class*="description"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const text = el.innerText?.trim() || '';
                if (text.length > 5) return text;
            }
        }
        return '';
    });

    const options = await page.evaluate(() => {
        const opts = document.querySelectorAll('.cr-multiple-choice');
        return Array.from(opts).map((el, i) => {
            const labelEl = el.querySelector('.cr-multiple-choice__label, label, .cr-multiple-choice__text');
            return {
                index: i,
                label: `Option ${i + 1}`,
                text: labelEl ? labelEl.innerText.trim() : (el.innerText?.trim() || '')
            };
        });
    });

    // If body is empty or very short, the question is likely image-based.
    // Capture a screenshot of the problem statement area for Gemini Vision.
    let screenshotBase64 = null;
    const bodyIsEmpty = body.trim().length < 20;

    if (bodyIsEmpty) {
        try {
            // Try to screenshot just the problem content area
            const statementEl = page.locator([
                '.cr-p-statement',
                '.cr-multiple-choice-container__heading',
                '.cr-p-statement-content',
                '[class*="statement"]',
                '[class*="description"]',
                '.cr-problem-content',
                '#problemdescription'
            ].join(', ')).first();

            const exists = await statementEl.count() > 0;

            if (exists) {
                const buf = await statementEl.screenshot({ type: 'png' }).catch(() => null);
                if (buf) {
                    screenshotBase64 = buf.toString('base64');
                    console.log('    [MCQ] Image-based question detected — captured element screenshot.');
                }
            }

            // Fallback: screenshot entire problem panel
            if (!screenshotBase64) {
                const panelEl = page.locator('.cr-problem-panel, .cr-p-panel, .problem-wrapper, main').first();
                const panelBuf = await panelEl.screenshot({ type: 'png' }).catch(() => null);
                if (panelBuf) {
                    screenshotBase64 = panelBuf.toString('base64');
                    console.log('    [MCQ] Captured full problem panel screenshot for image MCQ.');
                }
            }
        } catch (e) {
            console.log('    [MCQ] Screenshot capture failed:', e.message?.slice(0, 80));
        }
    }

    // Real MCQ pages show "Choose the correct answer from below : 2 Attempts left" (.cr-multiple-choice-container__hint-chip).
    // A wrong answer burns an attempt, so the caller must know how many are left. null = the page does not say.
    const attemptsLeft = await page.evaluate(() => {
        const el = document.querySelector('.cr-multiple-choice-container__hint-chip, .cr-multiple-choice-container__heading');
        const m = (el?.innerText || '').match(/(\d+)\s*attempts?\s*left/i);
        return m ? Number(m[1]) : null;
    }).catch(() => null);

    return {
        attemptsLeft,
        title: title.replace(/\s*-\s*Problem.*$/i, '').trim(),
        body,
        options,
        screenshotBase64,   // null if text-based question
        isImageBased: bodyIsEmpty && !!screenshotBase64
    };
}

/**
 * Snapshot of everything that can say how an MCQ submission went. Compared before and after the click.
 */
export async function readMcqState(page) {
    // solved/attempted come ONLY from the status-tag elements (Solved / Attempted / Unsolved). Never from free heading text: a question
    // titled "Never gets solved" would otherwise be read as solved and a wrong answer would be cached as correct.
    const state = await getProblemSolveState(page, { wait: false });
    const rest = await page.evaluate(() => {
        const chip = document.querySelector('.cr-multiple-choice-container__hint-chip, .cr-multiple-choice-container__heading')?.innerText || '';
        const m = chip.match(/(\d+)\s*attempts?\s*left/i);
        return {
            attemptsLeft: m ? Number(m[1]) : null,
            green: document.querySelector('[style*="background-color: rgb(82, 196, 26)"], .cr-multiple-choice--correct') != null,
            danger: document.querySelector('.status-tag-2--danger, .status-tag-2--red') != null
        };
    }).catch(() => ({ attemptsLeft: null, green: false, danger: false }));
    return { solved: state === 'solved', attempted: state === 'attempted', ...rest };
}

/**
 * Inject and submit an MCQ answer.
 * @param {import('playwright').Page} page
 * @param {number} bestOptionIndex - 0-based index of the correct option
 */
export async function injectMCQAnswer(page, bestOptionIndex) {
    try {
        // 1. Purge the floating SolveBot widget from DOM so it cannot intercept clicks
        await purgeBotWidgets(page);

        // 2. Click the exact option
        const clicked = await page.evaluate((idx) => {
            const choices = document.querySelectorAll('.cr-multiple-choice');
            if (choices[idx]) {
                const label = choices[idx].querySelector('label, .cr-multiple-choice__radio') || choices[idx];
                label.click();
                return true;
            }
            return false;
        }, bestOptionIndex).catch(() => false);

        if (!clicked) {
            const labelLoc = page.locator('.cr-multiple-choice label, .cr-multiple-choice').nth(bestOptionIndex);
            await labelLoc.click({ force: true, timeout: 5000 }).catch(() => {});
        }

        // 3. Ensure submit button is enabled (re-click option if needed)
        let isEnabled = false;
        for (let retry = 0; retry < 4; retry++) {
            isEnabled = await page.waitForFunction(() => {
                const btn = document.querySelector(
                    'button.cr-multiple-choice-container__submit, button.cr-judge-action--submit'
                );
                return btn && !btn.classList.contains('disabled') && !btn.disabled;
            }, { timeout: 3500 }).then(() => true).catch(() => false);

            if (isEnabled) break;

            // Re-click option if button stayed disabled
            await page.evaluate((idx) => {
                const choices = document.querySelectorAll('.cr-multiple-choice');
                if (choices[idx]) {
                    const label = choices[idx].querySelector('label, .cr-multiple-choice__radio') || choices[idx];
                    label.click();
                }
            }, bestOptionIndex).catch(() => {});
            await page.waitForTimeout(600);
        }

        const before = await readMcqState(page);

        // 4. Click Submit — use evaluate to force-remove disabled class if needed
        await page.evaluate(() => {
            const btn = document.querySelector(
                'button.cr-multiple-choice-container__submit, button.cr-judge-action--submit'
            ) || Array.from(document.querySelectorAll('button')).find(b =>
                (b.innerText || '').trim().match(/^submit$/i)
            );
            if (btn) {
                btn.classList.remove('disabled');
                btn.removeAttribute('disabled');
                btn.click();
            }
        }).catch(() => {});

        await page.waitForTimeout(1200);

        // 5. Handle Proceed confirmation modal
        const proceedBtn = page.locator('a:has-text("Proceed"), button:has-text("Proceed")').first();
        if (await proceedBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await proceedBtn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(800);
        }

        // 6. Poll for a verdict. The verdict is decided by what CHANGED since before the click, never by a badge that was already
        // there: after a wrong first try (or on a question that was already "Attempted") the Attempted badge is on the page from the
        // start, so reading it as "wrong answer" would report a verdict before the new submission was even judged.
        const start = Date.now();
        while (Date.now() - start < 10000) {
            const now = await readMcqState(page);

            if (now.solved || now.green) {
                return { status: 'pass', verdict: 'Correct' };
            }

            const attemptsDropped = now.attemptsLeft != null && before.attemptsLeft != null && now.attemptsLeft < before.attemptsLeft;
            const becameAttempted = now.attempted && !before.attempted;
            if (now.danger || attemptsDropped || becameAttempted) {
                return { status: 'fail', verdict: 'Incorrect' };
            }

            await page.waitForTimeout(300);
        }

        return { status: 'fail', verdict: 'Submit timeout (no verdict detected)' };
    } catch (err) {
        return { status: 'fail', verdict: `Injection error: ${err.message}` };
    }
}
