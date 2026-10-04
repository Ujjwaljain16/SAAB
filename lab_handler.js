import { solveTerminalLab } from './solver.js';

/**
 * Robust handler to automate DevOps Maxwell Container Labs on Scaler
 */
export async function solveAndSubmitLab(page, problemTitle, problemStatement) {
    try {
        console.log(`\n[Lab Solver] Starting automation for: ${problemTitle}`);

        // 1. Purge SolveBot widget & floating distractions
        await page.evaluate(() => {
            document.querySelectorAll('.SolveBotWidget-module_container__Sttx-, .Companion-module_root__ZGYyu, [class*="SolveBot"]').forEach(e => e.remove());
        }).catch(() => {});

        // 2. Click "Launch Lab" if present
        const launchLocator = page.getByText('Launch Lab').first();
        if (await launchLocator.isVisible({ timeout: 4000 }).catch(() => false)) {
            console.log('[Lab Solver] Clicking Launch Lab button...');
            await launchLocator.click().catch(() => {});
            await page.waitForTimeout(2000);
        }

        // 3. Handle "End Previous Lab" or "Save and Open New Workspace" modal
        const endPrevBtn = page.getByText('End Previous Lab').first();
        if (await endPrevBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[Lab Solver] Ending previous lab session...');
            await endPrevBtn.click().catch(() => {});
            await page.waitForTimeout(3000);
        }

        // 4. Wait for Maxwell terminal iframe to initialize and spinner to clear
        console.log('[Lab Solver] Waiting for Maxwell container terminal to initialize...');
        let maxwellFrame = null;
        for (let i = 0; i < 40; i++) {
            await page.waitForTimeout(3000);
            maxwellFrame = page.frames().find(f => f.url().includes('maxwell'));
            const isLaunching = await page.evaluate(() => document.body.innerText.includes('Launching the Lab')).catch(() => false);
            if (maxwellFrame && !isLaunching) {
                console.log(`[Lab Solver] Maxwell container ready in ${(i + 1) * 3}s! Frame URL: ${maxwellFrame.url()}`);
                break;
            }
        }

        if (!maxwellFrame) {
            return {
                status: 'fail',
                verdict: 'Terminal container timeout (Maxwell frame not ready)'
            };
        }

        // 5. Query Gemini AI for exact Linux commands
        console.log('[Lab Solver] Requesting terminal commands from Gemini AI...');
        const labResult = await solveTerminalLab(problemTitle, problemStatement);
        const commands = labResult.commands || [];
        console.log(`[Lab Solver] Generated ${commands.length} commands. Reasoning: ${labResult.reasoning || ''}`);

        if (commands.length === 0) {
            return {
                status: 'fail',
                verdict: 'AI generated empty command list'
            };
        }

        // 6. Focus terminal in Maxwell iframe
        console.log('[Lab Solver] Focusing Maxwell terminal...');
        const terminal = maxwellFrame.locator('.xterm, textarea.xterm-helper-textarea, canvas.xterm-text-layer').first();
        await terminal.click({ force: true }).catch(() => {});
        await page.waitForTimeout(800);

        // 7. Type commands line by line — use maxwellFrame.keyboard so input goes to the iframe's xterm, not the main page
        console.log(`[Lab Solver] Executing ${commands.length} bash commands...`);
        for (const cmd of commands) {
            console.log(`  > ${cmd}`);
            // Type char-by-char via the frame's keyboard context
            await maxwellFrame.locator('textarea.xterm-helper-textarea').first().focus().catch(() => {});
            await maxwellFrame.keyboard.type(cmd, { delay: 30 });
            await maxwellFrame.keyboard.press('Enter');
            // Wait for command to finish — simple heuristic: 600ms per command, more for installs
            const isSlowCmd = /apt|apt-get|yum|dnf|pip|npm|wget|curl|git clone|make|docker|systemctl/i.test(cmd);
            await page.waitForTimeout(isSlowCmd ? 3500 : 700);
        }

        await page.waitForTimeout(2500);

        // 8. Multi-Task Execution & Submission Loop
        console.log('[Lab Solver] Starting task execution and submission loop...');
        for (let taskLoop = 1; taskLoop <= 10; taskLoop++) {
            const currentStatus = await page.evaluate(() => {
                const heading = document.querySelector('.cr-p-heading')?.innerText || '';
                return { isSolved: heading.includes('Solved') };
            });

            if (currentStatus.isSolved) {
                console.log('[Lab Solver] ✓ Lab is fully SOLVED!');
                return { status: 'pass', verdict: 'Correct Answer' };
            }

            const submitBtn = page.locator('a.Submit-module_btn__tpMzw, button.Submit-module_btn__tpMzw, button:has-text("Run Task"), a:has-text("Run Task"), button:has-text("Submit")').first();
            if (!(await submitBtn.isVisible().catch(() => false))) {
                console.log('[Lab Solver] Submit button not visible on loop', taskLoop);
                break;
            }

            // Wait if button is disabled
            for (let r = 0; r < 5; r++) {
                const isDisabled = await submitBtn.evaluate(el => el.classList.contains('Tappable-module_disabled__XhpfV') || el.disabled);
                if (!isDisabled) break;
                await page.waitForTimeout(1000);
            }

            console.log(`[Lab Solver] Clicking submission button (Task iteration ${taskLoop})...`);
            await submitBtn.click({ force: true });

            // Handle any Proceed modal or StageResetWarning modal
            await page.waitForTimeout(1500);
            const proceedModal = page.locator('a.StageResetWarningModal-module_proceedButton__-erRt, a:has-text("Proceed"), button:has-text("Proceed")').first();
            if (await proceedModal.isVisible().catch(() => false)) {
                console.log('[Lab Solver] Confirming Proceed modal...');
                await proceedModal.click({ force: true });
            }

            // Wait for evaluation
            await page.waitForTimeout(4000);
            const evalState = await page.evaluate(() => {
                const heading = document.querySelector('.cr-p-heading')?.innerText || '';
                const testCases = document.querySelector('.TestCases-module_container__3P-4y, [class*="TestCase"]')?.innerText || '';
                const hasFailed = /Wrong Answer|Test Case Failed/i.test(testCases);
                return { isSolved: heading.includes('Solved'), hasFailed, testCases: testCases.slice(0, 200) };
            });

            if (evalState.isSolved) {
                console.log('[Lab Solver] ✓ Lab is fully SOLVED!');
                return { status: 'pass', verdict: 'Correct Answer' };
            }

            if (evalState.hasFailed) {
                console.log('[Lab Solver] ✗ Test case failed with feedback:', evalState.testCases);
                return { status: 'fail', verdict: 'Wrong Answer', feedback: evalState.testCases };
            }
        }

        return { status: 'fail', verdict: 'Evaluation timeout' };

    } catch (err) {
        return { status: 'fail', verdict: `Lab execution error: ${err.message}` };
    }
}
