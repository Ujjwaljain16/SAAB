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

const SUBMIT_SEL = 'button.cr-multiple-choice-container__submit, button.cr-judge-action--submit';

/** true / false when the option's radio or checkbox says so; null when the markup has no input to ask. */
async function optionSelected(page, idx) {
    return page.evaluate((i) => {
        const input = document.querySelectorAll('.cr-multiple-choice')[i]?.querySelector('input[type="radio"], input[type="checkbox"]');
        return input ? input.checked : null;
    }, idx).catch(() => null);
}

/** What changed since `before` says how the submission went. Never read a badge that was already there. */
function judgeMcqChange(before, now) {
    if (now.solved || now.green) return { status: 'pass', verdict: 'Correct' };
    const attemptsDropped = now.attemptsLeft != null && before.attemptsLeft != null && now.attemptsLeft < before.attemptsLeft;
    const becameAttempted = now.attempted && !before.attempted;
    if (now.danger || attemptsDropped || becameAttempted) return { status: 'fail', verdict: 'Incorrect' };
    return null;
}

/**
 * Inject and submit an MCQ answer.
 * Returned `verdict` is 'Correct', 'Incorrect' (a confirmed wrong answer), or a reason nothing was confirmed: in that last case
 * `unconfirmed` is true and the caller must NOT treat the option as wrong.
 * @param {import('playwright').Page} page
 * @param {number} bestOptionIndex - 0-based index of the correct option
 * @param {{ verdictTimeoutMs?: number, timeScale?: number }} [opts]
 */
export async function injectMCQAnswer(page, bestOptionIndex, opts = {}) {
    const T = (ms) => Math.round(ms * (opts.timeScale ?? 1));
    try {
        // 1. Purge the floating SolveBot widget from DOM so it cannot intercept clicks
        await purgeBotWidgets(page);

        // 2. A question with no attempts left cannot be answered: clicking Submit does nothing and would only time out.
        const initial = await readMcqState(page);
        if (!initial.solved && initial.attemptsLeft === 0) {
            return { status: 'fail', verdict: 'No attempts left on this question', unconfirmed: true, exhausted: true };
        }

        // 3. Select the option with a real click (React ignores some synthetic ones) and confirm it took, re-clicking only while it has not.
        const option = page.locator('.cr-multiple-choice').nth(bestOptionIndex);
        const selectOption = async () => {
            await option.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            // The container is wider than its radio: click the label (or radio) itself, which is what a person's click lands on.
            const target = option.locator('label, .cr-multiple-choice__radio').first();
            const clickTarget = (await target.count()) > 0 ? target : option;
            const real = await clickTarget.click({ timeout: 3000 }).then(() => true).catch(() => false);
            if (!real) {
                await page.evaluate((idx) => {
                    const choice = document.querySelectorAll('.cr-multiple-choice')[idx];
                    (choice?.querySelector('label, .cr-multiple-choice__radio') || choice)?.click();
                }, bestOptionIndex).catch(() => {});
            }
        };
        const submitEnabled = () => page.waitForFunction((sel) => {
            const btn = document.querySelector(sel);
            return btn && !btn.classList.contains('disabled') && !btn.disabled;
        }, SUBMIT_SEL, { timeout: Math.max(1, T(3500)) }).then(() => true).catch(() => false);

        let enabled = false;
        for (let retry = 0; retry < 4 && !enabled; retry++) {
            if ((await optionSelected(page, bestOptionIndex)) !== true) await selectOption();
            enabled = await submitEnabled();
        }
        if ((await optionSelected(page, bestOptionIndex)) === false) {
            return { status: 'fail', verdict: 'Option click did not register (nothing submitted)', unconfirmed: true };
        }

        const before = await readMcqState(page);

        // 4. Submit: a real click when the button is enabled, a forced one only as the last resort.
        const submitBtn = page.locator(SUBMIT_SEL).first();
        // Scaler's Submit is a "tappable" button: it reacts to real mouse/touch events and ignores a synthetic element.click(), which
        // is why the old script-only click timed out with the page unchanged ("2 Attempts left", still Unsolved).
        let realSubmit = await submitBtn.click({ timeout: 4000, force: !enabled }).then(() => true).catch(() => false);
        if (!realSubmit) {
            await submitBtn.evaluate((el) => el.classList.remove('disabled')).catch(() => {});
            realSubmit = await submitBtn.click({ timeout: 3000, force: true }).then(() => true).catch(() => false);
        }
        if (!realSubmit) {
            await page.evaluate((sel) => {
                const btn = document.querySelector(sel) || Array.from(document.querySelectorAll('button')).find((b) => /^submit$/i.test((b.innerText || '').trim()));
                if (btn) {
                    btn.classList.remove('disabled');
                    btn.removeAttribute('disabled');
                    btn.click();
                }
            }, SUBMIT_SEL).catch(() => {});
        }

        await page.waitForTimeout(T(1200));

        // 5. Handle Proceed confirmation modal
        const proceedBtn = page.locator('a:has-text("Proceed"), button:has-text("Proceed")').first();
        if (await proceedBtn.isVisible({ timeout: Math.max(1, T(2000)) }).catch(() => false)) {
            await proceedBtn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(T(800));
        }

        // 6. Poll for a verdict (see judgeMcqChange). Under load (4 pages at once) Scaler can take well over 10 s to answer.
        const deadline = Date.now() + (opts.verdictTimeoutMs ?? 20000);
        while (Date.now() < deadline) {
            const verdict = judgeMcqChange(before, await readMcqState(page));
            if (verdict) return verdict;
            await page.waitForTimeout(T(300));
        }

        // 7. Nothing repainted. The submission may still have been judged (the counter or the Solved tag only updates on load), so
        // reload and compare once more before giving up.
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForSelector('.status-tag-2, .cr-multiple-choice-container__hint-chip', { timeout: Math.max(1, T(15000)) }).catch(() => {});
        await page.waitForTimeout(T(800));
        const afterReload = judgeMcqChange(before, await readMcqState(page));
        if (afterReload) return afterReload;

        return { status: 'fail', verdict: 'Submit timeout (no verdict detected)', unconfirmed: true };
    } catch (err) {
        return { status: 'fail', verdict: `Injection error: ${err.message}`, unconfirmed: true };
    }
}
