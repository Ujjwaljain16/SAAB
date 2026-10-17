import { solveTerminalLab, commitSolution, evictSolution } from './solver.js';
import { sanitizeLabCommands, extractSudoPassword, sudoPrimeCommand } from './lab_guard.js';
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

        // 1. Purge floating widgets and make this tab the foreground one: labs run one at a time, and a background tab
        // may never start the container.
        await purgeBotWidgets(page);
        await page.bringToFront().catch(() => {});

        let maxwellFrame = null;
        for (let launchRound = 1; launchRound <= 2 && !maxwellFrame; launchRound++) {
        if (launchRound > 1) {
            console.log('[Lab Solver] The terminal never started; reloading the page and launching once more...');
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForTimeout(T(3000));
        }
        // 2. Launch the lab and VERIFY it started. This used to be fire-and-forget (click errors swallowed, nothing checked), and
        // getByText('Launch Lab').first() can match plain text in the problem statement instead of the real button.
        const launchPredicate = () =>
            document.querySelector('iframe[src*="maxwell"]') != null ||
            /Launching the Lab/i.test(document.body.innerText) ||
            document.querySelector('[class*="LaunchButton-module_btn"]') == null;
        const launchStarted = () => page.evaluate(launchPredicate).catch(() => false);

        let launchBtn = page.locator(SEL.labLaunchBtn).first();
        if ((await launchBtn.count()) === 0) launchBtn = page.getByText('Launch Lab', { exact: true }).first();
        if ((await launchBtn.count()) > 0 && !(await launchStarted())) {
            // The button exists in the DOM before its click handler is attached: a click right after the page appears does nothing
            // (seen live: the first lab was clicked 1s after detection and never launched; a lab clicked minutes later worked).
            await page.waitForLoadState('networkidle', { timeout: Math.max(1, T(8000)) }).catch(() => {});
            await page.waitForTimeout(T(1500));
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`[Lab Solver] Clicking Launch Lab button (attempt ${attempt}/3)...`);
                try {
                    await launchBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                    await launchBtn.click({ timeout: 5000, force: attempt > 1 });
                } catch (err) {
                    console.log(`[Lab Solver] Launch click failed: ${String(err.message).split('\n')[0].slice(0, 140)}`);
                }
                await page.waitForTimeout(T(1500));
                const started = await page.waitForFunction(launchPredicate, null, { timeout: Math.max(1, T(10000)) }).then(() => true).catch(() => false);
                if (started) {
                    console.log('[Lab Solver] Launch confirmed.');
                    break;
                }
                console.log('[Lab Solver] The lab did not start after that click; trying again...');
            }
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
        const waitStartedAt = Date.now();
        for (let i = 0; i < (opts.frameWaitAttempts ?? 120); i++) {
            await page.waitForTimeout(T(1000));

            // "Only 1 lab session(s) is allowed at a time ... [End Previous Lab] [Cancel]" can appear at ANY moment after the launch click,
            // not only right after it (seen live: it rendered late and the old single early check missed it, so the terminal never started
            // and we waited the full 2 minutes). Check on every poll. Only "End Previous Lab" is ever clicked, never "Cancel".
            const endPrevious = page.getByText('End Previous Lab').first();
            if (await endPrevious.isVisible().catch(() => false)) {
                console.log('[Lab Solver] Another lab session is running; ending it so this one can start...');
                await endPrevious.click({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(T(2000));
                continue;
            }

            maxwellFrame = page.frames().find(f => f.url().includes('maxwell'));
            const isLaunching = await page.evaluate(() => document.body.innerText.includes('Launching the Lab')).catch(() => false);
            if (maxwellFrame && !isLaunching) {
                console.log(`[Lab Solver] Maxwell container ready in ${Math.round((Date.now() - waitStartedAt) / 1000)}s! Frame URL: ${maxwellFrame.url()}`);
                break;
            }
        }

        }

        if (!maxwellFrame) {
            return {
                status: 'fail',
                verdict: 'Terminal container timeout (Maxwell frame not ready)'
            };
        }

        // 5-8. Up to MAX tries (default 3): ask the AI for commands, type them, press Run Task / Submit, WAIT for the judge's result, and
        // on a failure retry with the judge's own feedback (the container keeps its state, so a retry sends corrective commands).
        const maxTries = opts.maxTries ?? 3;
        const ranCommands = [];
        let feedback = '';
        let lastVerdict = { status: 'fail', verdict: 'Lab did not run' };

        for (let attempt = 1; attempt <= maxTries; attempt++) {
            console.log(`[Lab Solver] Requesting terminal commands from the AI (try ${attempt}/${maxTries})...`);
            const labResult = await solveTerminalLab(problemTitle, problemStatement, attempt === 1 ? {} : { feedback, previousCommands: ranCommands });
            if (attempt === 1) trace.cacheKey = labResult.cacheKey;

            const { commands, rejected } = sanitizeLabCommands(labResult.commands);
            for (const r of rejected) {
                console.log(`[Lab Solver] Refused unsafe/invalid command (${r.reason}): ${r.command}`);
            }
            if (rejected.length > 0) {
                return { status: 'fail', verdict: 'Refused unsafe/invalid AI-generated commands' };
            }
            if (commands.length === 0) {
                // No (more) commands: on a retry that means the AI had nothing to add, so report the judge's last verdict instead.
                if (attempt > 1) return lastVerdict;
                return { status: 'fail', verdict: 'AI generated empty command list' };
            }

            console.log(`[Lab Solver] Generated ${commands.length} commands. Reasoning: ${labResult.reasoning || ''}`);
            ranCommands.push(...commands);
            // Everything typed so far, in order: replaying it on a fresh container is what a cached solution has to do.
            trace.solution = { commands: ranCommands.slice(), reasoning: labResult.reasoning };

            // Labs that say "Use password X if required for sudo access": the model is never trusted with the password. It is read from
            // the statement here, used to cache the sudo credential up front, and used again if a sudo prompt still shows up.
            const sudoPassword = extractSudoPassword(problemStatement);
            const needsSudo = sudoPassword && commands.some((c) => /\bsudo\b/.test(c));
            await typeCommands(page, maxwellFrame, commands, T, needsSudo ? { sudoPassword } : {});
            await page.waitForTimeout(T(2500));

            console.log('[Lab Solver] Submitting and waiting for the judge...');
            lastVerdict = await submitAndAwaitVerdict(page, T, opts);
            if (lastVerdict.status === 'pass' || lastVerdict.stop) return lastVerdict;

            feedback = lastVerdict.feedback || lastVerdict.verdict;
            console.log(`[Lab Solver] ✗ Try ${attempt}/${maxTries} did not solve it: ${String(feedback).slice(0, 200)}`);
        }

        return lastVerdict;

    } catch (err) {
        return { status: 'fail', verdict: `Lab execution error: ${err.message}` };
    }
}

/** Focus the xterm inside the Maxwell iframe and type each command, pausing longer for slow ones. */
async function typeCommands(page, maxwellFrame, commands, T, { sudoPassword = '' } = {}) {
    console.log('[Lab Solver] Focusing Maxwell terminal...');
    const terminal = maxwellFrame.locator('.xterm, textarea.xterm-helper-textarea, canvas.xterm-text-layer').first();
    await terminal.click({ force: true }).catch(() => {});
    await page.waitForTimeout(T(800));

    if (sudoPassword) {
        console.log('  > (caching the sudo credential with the password given in the problem)');
        await maxwellFrame.locator('textarea.xterm-helper-textarea').first().focus().catch(() => {});
        await page.keyboard.type(sudoPrimeCommand(sudoPassword), { delay: 30 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(T(1200));
    }

    console.log(`[Lab Solver] Executing ${commands.length} bash commands...`);
    for (const cmd of commands) {
        console.log(`  > ${cmd}`);
        await maxwellFrame.locator('textarea.xterm-helper-textarea').first().focus().catch(() => {});
        // A Playwright Frame has no .keyboard (that threw "Cannot read properties of undefined (reading 'type')" on every lab).
        // The xterm textarea inside the iframe is focused above, so the page-level keyboard types into it.
        await page.keyboard.type(cmd, { delay: 30 });
        await page.keyboard.press('Enter');
        // Wait for the command to finish: 700ms per command, longer for installs and the like.
        const isSlowCmd = /apt|apt-get|yum|dnf|pip|npm|wget|curl|git clone|make|docker|systemctl/i.test(cmd);
        await page.waitForTimeout(T(isSlowCmd ? 3500 : 700));

        // Safety net: if sudo still stopped at a password prompt (credential cache disabled, or a different user), answer it.
        // Anything typed while a command waits for a password is swallowed by it, so this must come before the next command.
        if (sudoPassword && /\bsudo\b/.test(cmd)) {
            for (let i = 0; i < 3 && (await sudoPromptVisible(maxwellFrame)); i++) {
                console.log('  > (sudo asked for a password; answering it)');
                await page.keyboard.type(sudoPassword, { delay: 30 });
                await page.keyboard.press('Enter');
                await page.waitForTimeout(T(1000));
            }
        }
    }
}

/** True when the last visible lines of the xterm are a sudo password prompt (only readable with xterm's DOM renderer). */
async function sudoPromptVisible(maxwellFrame) {
    const text = await maxwellFrame
        .evaluate(() => (document.querySelector('.xterm-rows')?.innerText || '').trimEnd().split('\n').slice(-2).join('\n'))
        .catch(() => '');
    return /\[sudo\] password for [^\n]*:\s*$|^password:\s*$/im.test(text);
}

/**
 * Press Run Task / Submit ONCE, then wait for the judge to actually produce a result. The old version waited a fixed 4s and, if it
 * saw neither "solved" nor one guessed failure phrase, clicked again (up to 10 times), which could re-run a task that was still
 * being judged. A result here is: the Solved tag appears, or the test-case panel changes to something that is not the "click Submit
 * to see the output" placeholder, is not a "running" message, and stays unchanged for a few seconds.
 *
 * @returns {{status:'pass'|'fail', verdict:string, feedback?:string, stop?:boolean}}
 */
async function submitAndAwaitVerdict(page, T, opts = {}) {
    const isSolved = async () => (await getProblemSolveState(page, { wait: false })) === 'solved';
    const readPanel = () => page.evaluate((sel) => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim(), SEL.labTestCases).catch(() => '');
    const PLACEHOLDER = /click on\s+["']?submit["']?\s+button to see the output/i;
    const RUNNING = /running|evaluating|executing|checking|processing|loading|please wait|in progress/i;
    // The judge itself failing ("Something went wrong, please try again by clicking on submit") says nothing about the answer.
    const JUDGE_HICCUP = /something went wrong|try again by clicking|please try again/i;
    let pressesLeft = opts.maxRepresses ?? 2;

    // opts.forceSubmit is a test-only switch (see main.js --e2e-submit-lab): press the button even though the lab is already solved.
    if (!opts.forceSubmit && (await isSolved())) {
        console.log('[Lab Solver] ✓ Lab is already SOLVED!');
        return { status: 'pass', verdict: 'Correct Answer' };
    }

    let submitBtn = page.locator(SEL.labSubmitBtn).first();
    if ((await submitBtn.count()) === 0) submitBtn = page.locator(SEL.labSubmitFallback).first();
    if (!(await submitBtn.isVisible().catch(() => false))) {
        return { status: 'fail', verdict: 'Submit button not found', feedback: 'The Run Task / Submit button is not visible on the page.' };
    }

    for (let r = 0; r < 5; r++) {
        const isDisabled = await submitBtn.evaluate((el) => /disabled/i.test(el.className) || el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);
        if (!isDisabled) break;
        await page.waitForTimeout(T(1000));
    }

    let before = await readPanel();
    let clickedAt = Date.now();
    let deadline = 0;

    /** Press Run Task once. Returns a final result when the press must stop everything, else null. */
    const press = async () => {
        console.log('[Lab Solver] Clicking the submission button...');
        clickedAt = Date.now();
        await submitBtn.click({ force: true });
        await page.waitForTimeout(T(1500));

        // Scaler: "Running a completed task will reset progress for all the next tasks." Never confirm that; cancel and stop.
        const resetCancel = page.locator(SEL.labResetCancelBtn).first();
        if (await resetCancel.isVisible().catch(() => false)) {
            console.log('[Lab Solver] Scaler warns this would reset completed tasks. Cancelling to protect existing progress.');
            await resetCancel.click({ force: true }).catch(() => {});
            return { status: 'fail', stop: true, verdict: 'Stopped: running again would reset already-completed tasks' };
        }

        // Any other plain confirmation dialog.
        const proceedModal = page.locator(SEL.labProceedBtn).first();
        if (await proceedModal.isVisible().catch(() => false)) {
            console.log('[Lab Solver] Confirming Proceed modal...');
            await proceedModal.click({ force: true });
        }
        deadline = Date.now() + T(opts.evalTimeoutMs ?? 90000);
        return null;
    };

    const stopped = await press();
    if (stopped) return stopped;
    let last = null;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
        if (await isSolved()) {
            console.log('[Lab Solver] ✓ Lab is SOLVED!');
            return { status: 'pass', verdict: 'Correct Answer' };
        }

        const text = await readPanel();
        if (text !== last) {
            last = text;
            lastChangeAt = Date.now();
        }

        // The judge failed on its side: wait a moment and press again (the answer is untouched), a couple of times at most.
        if (pressesLeft > 0 && text && JUDGE_HICCUP.test(text) && Date.now() - clickedAt >= T(2000)) {
            pressesLeft -= 1;
            console.log('[Lab Solver] The judge reported an internal error (not a wrong answer); pressing Run Task again...');
            await page.waitForTimeout(T(4000));
            before = await readPanel();
            const stoppedAgain = await press();
            if (stoppedAgain) return stoppedAgain;
            last = null;
            lastChangeAt = Date.now();
            continue;
        }

        // The click never started a run (the panel still says "Click on Submit to see the output"): press again, a couple of times at most.
        if (pressesLeft > 0 && PLACEHOLDER.test(text) && Date.now() - clickedAt >= T(25000)) {
            pressesLeft -= 1;
            console.log('[Lab Solver] The judge never started; pressing Run Task again...');
            before = await readPanel();
            const stoppedAgain = await press();
            if (stoppedAgain) return stoppedAgain;
            last = null;
            lastChangeAt = Date.now();
            continue;
        }

        // A result is normally a CHANGE of the panel. But a retry can fail with exactly the same message as the previous try, which
        // changes nothing visible; after a generous grace period an unchanged, settled, non-placeholder panel counts as the answer too.
        const unchangedButSettled = text === before && Date.now() - clickedAt >= T(12000);
        const isResult = text && (text !== before || unchangedButSettled) && !PLACEHOLDER.test(text) && !RUNNING.test(text);
        if (isResult && Date.now() - lastChangeAt >= T(3000)) {
            return { status: 'fail', verdict: 'Wrong Answer', feedback: text.slice(0, 600) };
        }
        await page.waitForTimeout(T(1000));
    }

    return { status: 'fail', verdict: 'Evaluation timeout', feedback: last ? last.slice(0, 600) : 'The judge produced no result in time.' };
}
