import { solveTerminalLab, commitSolution, evictSolution } from './solver.js';
import { sanitizeLabCommands } from './lab_guard.js';
import { SEL } from './config.js';
import { purgeBotWidgets } from './page_utils.js';
import { getProblemSolveState } from './scaler_page.js';

/**
 * Robust handler to automate DevOps Maxwell Container Labs on Scaler
 */
export async function solveAndSubmitLab(page, problemTitle, problemStatement, opts = {}) {
    const trace = {};
    const result = await runLab(page, problemTitle, problemStatement, trace, opts);

    // Only a judge-confirmed solution may be reused later; a failed one must never be replayed from cache.
    if (trace.cacheKey) {
        if (result.status === 'pass') commitSolution(trace.cacheKey, trace.solution);
        else evictSolution(trace.cacheKey);
    }
    return result;
}

async function runLab(page, problemTitle, problemStatement, trace, opts = {}) {
    // opts.timeScale shrinks the fixed waits (tests use ~0.05); opts.frameWaitAttempts bounds the container wait.
    const T = (ms) => Math.round(ms * (opts.timeScale ?? 1));
    try {
        console.log(`\n[Lab Solver] Starting automation for: ${problemTitle}`);

        // 1. Purge SolveBot widget & floating distractions
        await purgeBotWidgets(page);

        // 2. Click "Launch Lab" if present
        const launchLocator = page.getByText('Launch Lab').first();
        if (await launchLocator.isVisible({ timeout: 4000 }).catch(() => false)) {
            console.log('[Lab Solver] Clicking Launch Lab button...');
            await launchLocator.click().catch(() => {});
            await page.waitForTimeout(T(2000));
        }

        // 3. Handle "End Previous Lab" or "Save and Open New Workspace" modal
        const endPrevBtn = page.getByText('End Previous Lab').first();
        if (await endPrevBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[Lab Solver] Ending previous lab session...');
            await endPrevBtn.click().catch(() => {});
            await page.waitForTimeout(T(3000));
        }

        // 4. Wait for Maxwell terminal iframe to initialize and spinner to clear
        console.log('[Lab Solver] Waiting for Maxwell container terminal to initialize...');
        let maxwellFrame = null;
        for (let i = 0; i < (opts.frameWaitAttempts ?? 40); i++) {
            await page.waitForTimeout(T(3000));
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
        trace.cacheKey = labResult.cacheKey;
        const { commands, rejected } = sanitizeLabCommands(labResult.commands);
        trace.solution = { commands, reasoning: labResult.reasoning };
        for (const r of rejected) {
            console.log(`[Lab Solver] Refused unsafe/invalid command (${r.reason}): ${r.command}`);
        }
        if (rejected.length > 0) {
            return { status: 'fail', verdict: 'Refused unsafe/invalid AI-generated commands' };
        }
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
        await page.waitForTimeout(T(800));

        // 7. Type commands line by line — use maxwellFrame.keyboard so input goes to the iframe's xterm, not the main page
        console.log(`[Lab Solver] Executing ${commands.length} bash commands...`);
        for (const cmd of commands) {
            console.log(`  > ${cmd}`);
            // Type char-by-char via the frame's keyboard context
            await maxwellFrame.locator('textarea.xterm-helper-textarea').first().focus().catch(() => {});
            // A Playwright Frame has no .keyboard (that threw "Cannot read properties of undefined (reading 'type')" on every lab).
            // The xterm textarea inside the iframe is focused above, so the page-level keyboard types into it.
            await page.keyboard.type(cmd, { delay: 30 });
            await page.keyboard.press('Enter');
            // Wait for command to finish — simple heuristic: 600ms per command, more for installs
            const isSlowCmd = /apt|apt-get|yum|dnf|pip|npm|wget|curl|git clone|make|docker|systemctl/i.test(cmd);
            await page.waitForTimeout(T(isSlowCmd ? 3500 : 700));
        }

        await page.waitForTimeout(T(2500));

        // 8. Multi-Task Execution & Submission Loop
        console.log('[Lab Solver] Starting task execution and submission loop...');
        for (let taskLoop = 1; taskLoop <= 10; taskLoop++) {
            const currentStatus = { isSolved: (await getProblemSolveState(page, { wait: false })) === 'solved' };

            if (currentStatus.isSolved) {
                console.log('[Lab Solver] ✓ Lab is fully SOLVED!');
                return { status: 'pass', verdict: 'Correct Answer' };
            }

            let submitBtn = page.locator(SEL.labSubmitBtn).first();
            if ((await submitBtn.count()) === 0) submitBtn = page.locator(SEL.labSubmitFallback).first();
            if (!(await submitBtn.isVisible().catch(() => false))) {
                console.log('[Lab Solver] Submit button not visible on loop', taskLoop);
                break;
            }

            // Wait if button is disabled
            for (let r = 0; r < 5; r++) {
                const isDisabled = await submitBtn.evaluate(el => /disabled/i.test(el.className) || el.disabled || el.getAttribute('aria-disabled') === 'true');
                if (!isDisabled) break;
                await page.waitForTimeout(T(1000));
            }

            console.log(`[Lab Solver] Clicking submission button (Task iteration ${taskLoop})...`);
            await submitBtn.click({ force: true });

            await page.waitForTimeout(T(1500));

            // Scaler: "Running a completed task will reset progress for all the next tasks." Never confirm that; cancel and stop.
            const resetCancel = page.locator(SEL.labResetCancelBtn).first();
            if (await resetCancel.isVisible().catch(() => false)) {
                console.log('[Lab Solver] Scaler warns this would reset completed tasks. Cancelling to protect existing progress.');
                await resetCancel.click({ force: true }).catch(() => {});
                return { status: 'fail', verdict: 'Stopped: running again would reset already-completed tasks' };
            }

            // Any other plain confirmation dialog.
            const proceedModal = page.locator(SEL.labProceedBtn).first();
            if (await proceedModal.isVisible().catch(() => false)) {
                console.log('[Lab Solver] Confirming Proceed modal...');
                await proceedModal.click({ force: true });
            }

            // Wait for evaluation
            await page.waitForTimeout(T(4000));
            const evalState = await page.evaluate((testCaseSel) => {
                const testCases = document.querySelector(testCaseSel)?.innerText || '';
                const hasFailed = /Wrong Answer|Test Case Failed/i.test(testCases);
                return { hasFailed, testCases: testCases.slice(0, 200) };
            }, SEL.labTestCases);
            evalState.isSolved = (await getProblemSolveState(page, { wait: false })) === 'solved';

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
