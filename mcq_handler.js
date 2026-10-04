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

    return {
        title: title.replace(/\s*-\s*Problem.*$/i, '').trim(),
        body,
        options,
        screenshotBase64,   // null if text-based question
        isImageBased: bodyIsEmpty && !!screenshotBase64
    };
}

/**
 * Inject and submit an MCQ answer.
 * @param {import('playwright').Page} page
 * @param {number} bestOptionIndex - 0-based index of the correct option
 */
export async function injectMCQAnswer(page, bestOptionIndex) {
    try {
        // 1. Purge the floating SolveBot widget from DOM so it cannot intercept clicks
        await page.evaluate(() => {
            document.querySelectorAll(
                '.SolveBotWidget-module_container__Sttx-, .Companion-module_root__ZGYyu, ' +
                '.SolveBotWidget-module_botImage__orvhM, [class*="SolveBot"]'
            ).forEach(b => b.remove());
        }).catch(() => {});

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

        // 6. Poll for verdict on problem heading or option highlight
        const start = Date.now();
        while (Date.now() - start < 10000) {
            const outcome = await page.evaluate(() => {
                const heading = document.querySelector('.cr-p-heading__text, .cr-p-heading')?.innerText || '';
                const hasSolvedBadge =
                    heading.includes('Solved') ||
                    document.querySelector('.status-tag-2--success, .status-tag-2--green') != null;
                const hasGreenOption =
                    document.querySelector('[style*="background-color: rgb(82, 196, 26)"], [style*="background-color: green"], .cr-multiple-choice--correct') != null;

                if (hasSolvedBadge || hasGreenOption) return 'pass';

                const hasAttempted = heading.includes('Attempted');
                const hasDanger = document.querySelector('.status-tag-2--danger, .status-tag-2--red') != null;
                if (hasAttempted || hasDanger) return 'fail';

                return null;
            }).catch(() => null);

            if (outcome) {
                return {
                    status: outcome,
                    verdict: outcome === 'pass' ? 'Correct' : 'Incorrect'
                };
            }
            await page.waitForTimeout(300);
        }

        return { status: 'fail', verdict: 'Submit timeout (no verdict detected)' };
    } catch (err) {
        return { status: 'fail', verdict: `Injection error: ${err.message}` };
    }
}
