# SAAB — what's left to make it production-ready

Status snapshot after the hardening pass (commits `acfa0bd` … `6195912` on `main`).
Scope: the **Scaler** agent only. The BITS/Coursera code (`bits_*.js`, `test_bits_dom.js`) was deliberately left untouched and is out of scope here (see [§10](#10-bits--coursera-out-of-scope)).

Legend — **Priority**: P0 = do before trusting it unattended, P1 = next, P2 = polish. **Effort**: S ≈ under 1h, M ≈ half a day, L ≈ a day or more.

---

## 0. Where we actually are

### Verified against the real site (live, read-only / dry-run)
| Area | Result |
|---|---|
| Google SSO login on a fresh profile | Works end to end (email → password → `SetSID` hop → Scaler session-limit page → dashboard → session saved) |
| Session reuse | Saved session accepted by `main.js` without re-login |
| Term + subject discovery | SEM 5 (Term 1), 3 subjects found |
| Class scan | 58 classes scanned, queue built (0 pending), clean exit code 0 in ~31 s |

### Covered only by unit tests / lint (never run live)
17 unit tests (`npm test`) + ESLint clean (`npm run lint`):
`code_utils` (fence/JSON/truncation/comment helpers), `lab_guard`, `scaler_url` + `parseProgressCount`, login URL helpers.

### NOT verified at all (no live run, no automated test)
- Problem-type detection on real problem pages (`detectProblemType`)
- MCQ solve + submit, verdict detection, cache commit/evict on real verdicts
- Coding solve → inject → submit → verdict → retry loop
- Maxwell terminal labs, VS Code IDE problems
- Worker pool behaviour with 4 parallel pages, checkpoint/resume, re-login mid-run
- All provider error paths (429 / 5xx / quota / bad JSON) — never exercised with a stubbed API

> Nothing was pending on the account, so the solve paths could not be exercised live. **This is the biggest risk in the project: ~70% of the logic is untested end to end.**

### Known rough edge
Chrome shows a native **"Sign in to Chrome?"** dialog after a Workspace Google login. Harmless to the run, but it needs one manual click and Playwright can't dismiss native UI. (See §6.)

---

## 1. P0 — Prove the solve paths work

### 1.1 Offline mock-Scaler end-to-end test — **P0 / L**
Build a mock site served through Playwright routes and run the *real* `main.js` against it. The hooks already exist: `SAAB_DATA_DIR`, `SAAB_HEADLESS`, `SAAB_BROWSER_CHANNEL`, `SAAB_PROFILE_DIR`, `SAAB_TEST_ROUTES` (module exporting `setup(ctx)`).
- [ ] Fixtures: dashboard, subject/classes page, problems table, MCQ page (text + image), coding page with fake Monaco, lab page with a `maxwell` iframe + fake xterm, VS Code page
- [ ] Scenarios: all-pass, MCQ wrong → evict + remember wrong option, provider 429 → fallback, truncated code, session expiry mid-run, one worker throws, `--max-submissions` cap, Ctrl+C mid-run then resume from `run-state.json`
- [ ] Assert on outputs: `run-state.json`, `run-log.json`, `runs/`, cache contents, exit code
- [ ] Stub AI by overriding `globalThis.fetch` (Groq/Grok) and pre-seeding the cache (Gemini)
- **Done when:** `npm run test:e2e` runs headless in CI with no network and no real keys.

### 1.2 Live validation ladder (when real assignments exist) — **P0 / S**
1. `npm run dry-run:mcq` → read the log + `debug/` snapshots
2. `node main.js --only-mcq --max-submissions=3`
3. Same for coding, then labs, then VS Code
4. Full run only after each tier is boring
- [ ] Record the first successful run's `runs/*.json` as a baseline fixture

### 1.3 DOM fixture tests for the page-reading functions — **P0 / M**
Real saved HTML from `debug/` → `page.setContent()` → assert. Targets: `detectProblemType`, `getProblemSolveState`, `collectAssignmentProblems`, `collectQuestionTabs`, `extractProblemContent`, `slurpMCQContext`, `injectMCQAnswer`, `injectAndSubmit`, `purgeBotWidgets`, `snapshotPage` (cap + never throws).
- [ ] Add a tiny script `npm run capture-fixture -- <url>` to save sanitized HTML for tests (strip names/emails/tokens)

### 1.4 Review `workspace_manager.js` (VS Code IDE path) — **P0 / M**
This file was **never reviewed** in this pass (an earlier note calling its fallback a "stub" was a guess — the stub check actually lives in `solver.js`). It holds the shared `workspaceMutex`, so a hang there blocks every other worker.
- [ ] Read it fully; add a hard timeout around the whole IDE solve
- [ ] Release the mutex in a `finally` with a deadline
- [ ] Delimit problem text as untrusted in its prompt (the other prompts already do)

---

## 2. P0/P1 — Correctness bugs and gaps already identified

| # | Issue | Why it matters | Pri | Effort |
|---|---|---|---|---|
| 2.1 | **Image-based MCQ falls back to Groq with text only.** `solveMCQ` sends `"[Question is in the attached image]"` to Groq, which cannot see the image → the model guesses and we submit. | Wrong submissions on image questions | P0 | S — skip Groq/Grok when `screenshotBase64` is set; fail instead |
| 2.2 | **Multi-select MCQs.** `detectProblemType` treats checkboxes as MCQ, but the solver returns a single `bestOptionIndex` and `injectMCQAnswer` clicks one option. | Always wrong on multi-answer questions | P0 | M — ask for `selectedIndices[]`, click all, handle "select all that apply" |
| 2.3 | **No per-problem timeout.** A hung page stalls its worker forever. | Unattended runs can freeze | P0 | M — `Promise.race` + close/recreate the page |
| 2.4 | **Concurrent re-login.** `ensureLoggedIn` can run on 4 workers at once, each opening its own login (and eating Scaler's 3-session slots). | Session-limit page, wasted logins | P0 | M — single shared re-auth promise; other workers wait then reload |
| 2.5 | **Coding retries only see verdict text**, not the failing test case input/expected/actual. | Weak retry quality | P1 | M — scrape the test-output panel into `failureFeedback` |
| 2.6 | **`timeout` verdict is treated as a failure** and the next attempt submits different code. | Burns attempts on a slow judge | P1 | S — re-poll the same submission once before retrying |
| 2.7 | **MCQ has no in-run retry.** A confirmed-wrong option is remembered for the *next* run only. | Needs a second run to fix | P1 | M — after "Incorrect", re-ask with exclusions and resubmit (needs one live check of the page's behaviour after a wrong submit) |
| 2.8 | **Lab uses fixed sleeps** (700 ms / 3.5 s per command) and checks `heading.includes('Solved')`. | Flaky; slow commands race | P1 | M — wait for the shell prompt to return + read exit status; real "solved" signal |
| 2.9 | **Lab guard is a denylist.** A false positive aborts the whole lab; a clever command could slip through. | Safety vs. usability tradeoff | P1 | M — allowlist of command families per lab, or dry-print + confirm mode |
| 2.10 | **`extractJsonBlock` last-resort cleanup** (`\\n` → space, strip control chars) can mangle valid JSON containing code. | Corrupt lab/workspace payloads | P2 | S — remove, or try `jsonrepair` only after strict parse fails |
| 2.11 | **Gemini safety-blocked / empty responses** are retried as "server errors". | Wasted calls | P2 | S — detect `finishReason`/blockReason, treat as non-retryable |

---

## 3. P1 — Discovery, term selection, hard-coded values

**Term selection is not implemented.** The agent works on whatever term the dashboard shows by default; the term text is only used for the console banner and cache key.
- [ ] `--term="SEM 5"` / `TARGET_TERM` — open the term dropdown and pick it (needs the dropdown HTML; the new `no-subjects-found` snapshot will capture it) — **P1 / M**

Hard-coded values to move into config:
| Value | Where | Fix |
|---|---|---|
| Dashboard URL | `crawler.js`, `main.js`, `scaler_login.js` | single `SCALER_URLS` constant in `config.js` |
| `Profile 3` | `auth.js`, `main.js` | drop `--profile-directory` entirely (plain `--user-data-dir`) or make it env-driven; it currently creates a nested profile |
| `temp_chrome_profile` | `auth.js`, `main.js` | `SAAB_PROFILE_DIR` already honoured by `main.js`; make `auth.js` honour it too |
| Language by subject (`/programming using js/i` → JS, else Java) | `scaler_page.js` | `LANGUAGE_MAP` in config / `.env` |
| `"Java Array"` typed into the language picker | `selectProblemLanguage` | read the option list, match by label |
| Default model `gemini-3-flash-preview` | `solver.js` | validate at startup; log the model actually used |

Discovery blind spots found in the live scan:
- Subjects **659** and **681** render *no assignment progress links* on their classes page, so the crawler can only see assignments for subject 440. `10 / 11` on subject 659 and `31 / 32` on subject 440 mean one class each is unfinished but invisible to the crawler. — **P1 / M** (inspect those classes; they may hold quizzes/homework rather than assignments)
- `homeworkText` is scraped but never used.
- An empty queue is never cached, so every run re-scans all 58 classes (~31 s). Cache empty results with a short TTL.
- `run-state.json` is never reset: `--recheck/--force` only bypass the curriculum cache, not the checkpoint. Add `--reset-state` and a `completedAt` timestamp so stale checkpoints expire.

---

## 4. P1 — Reliability and resilience

- [ ] **Provider circuit breaker** — after N consecutive failures skip a provider for a cool-down instead of paying a timeout on every call — S/M
- [ ] **Consolidate the three provider retry blocks** (Gemini / Groq / Grok) into one `callProvider()` with shared backoff + jitter + Retry-After — M
- [ ] **Migrate `@google/generative-ai` → `@google/genai`** (the old SDK is deprecated) — M
- [ ] **Browser crash recovery** — detect a closed context/page and recreate it; checkpoint after every problem (already done) so a restart resumes — M
- [ ] **Navigation retry policy** — `safeGoto` retries 3×; add jitter and a per-class budget — S
- [ ] **Human-like pacing / account safety** — 4 parallel pages hammering one account is the most likely thing to get noticed. Default `SOLVE_CONCURRENCY` to 1–2, add randomized delays, keep the 3-session limit in mind — S
- [ ] **Make dry-run the default**: today live-submit is the default and `--dry-run` opts out. Invert it so `--submit` is required (breaking change, but the safest default) — S
- [ ] **Graceful quota handling** — when every provider is exhausted, stop cleanly with a clear "resume tomorrow" message and keep the checkpoint — S

---

## 5. P1 — Observability

- [ ] Structured logging (pino or similar): levels, a per-run `runId`, timestamps, one JSON line per event; keep a pretty console formatter for humans — M
- [ ] Richer `run-log.json`: problem URL, detected type, attempts, provider/model used, cache hit/miss, verdict, duration, token usage — M
- [ ] Cost/usage report at the end of a run (requests + approximate tokens per provider) — S
- [ ] Notifications on finish/failure/stop (Telegram/Discord/webhook; opt-in) — S/M
- [ ] `debug/` retention: auto-prune snapshots older than N days — S
- [ ] Redact personal data in snapshots by default (they contain page content from the account) — S

---

## 6. P1/P2 — Auth and browser

- [ ] **Session-slot hygiene.** Scaler allows 3 logins; every profile deletion leaks one. Document it, print the slot count on the limit page, and make `npm run auth` refuse to create a new session when a valid one exists (add `--force-login`) — S
- [ ] **"Sign in to Chrome?" dialog.** Try launch flags to suppress the sign-in intercept (needs experimenting; unknown flags are ignored by Chrome, so it is safe to test) or document the one-click workaround — S
- [ ] **`SCALER_PASS` is the *Google* password.** Rename/clarify in `.env.example` and README; recommend leaving it blank and typing it once — S
- [ ] **Credentials at rest.** `.env` is plaintext, `session.json` + `temp_chrome_profile/` hold live cookies. Warn if they sit in a cloud-synced folder; optionally use the OS keychain — M
- [ ] Re-auth during a run should reuse `loginToScaler`'s navigation trace + snapshot (it does) — add a test with a mock Google page — M
- [ ] Support `SAAB_BROWSER_CHANNEL` fallbacks (Edge / bundled Chromium) when Chrome isn't installed — S

---

## 7. P2 — Code quality and architecture

- [ ] **`main.js` `run()` is ~500 lines.** Split into `discover()` → `processClass()` → `solveProblem()` strategy objects (`mcq`, `coding`, `lab`, `vscode`), each returning `{status, verdict, feedback}` — L
- [ ] Remove the unused `fs-extra` dependency; pin Playwright (`~1.59`) instead of `^`; add `"engines": {"node": ">=20"}` — S
- [ ] Add `.editorconfig` + `.gitattributes` (`* text=auto eol=lf`): git currently warns LF→CRLF on every file and several files are CRLF — S
- [ ] Add JSDoc types (or migrate to TypeScript with `checkJs`) for the shared shapes: `ProblemContent`, `SolveResult`, `RunState`, `LabResult` — M
- [ ] Replace `process.argv.find(...)` flag parsing with one `cli.js` parser (also gives `--help` and validation errors) — M
- [ ] Remove duplicated `isLoginUrl` (exists in both `scaler_page.js` and `scaler_login.js`) — S
- [ ] Delete leftover commented/dead branches after the above — S
- [ ] Add a `LICENSE`, `CONTRIBUTING.md`, and a short `ARCHITECTURE.md` with a sequence diagram of one problem's lifecycle — S

---

## 8. P2 — Testing and CI

Current: 17 unit tests, 4 files. Gaps and additions:
- [ ] **`run_state.js` has no tests** (load corrupt/missing file, atomic write, canonicalisation, dedupe) — S
- [ ] **Solver provider tests with stubbed `fetch`**: good code, truncated ×4, daily-quota → fatal, 429 with Retry-After, JSON mode parse failure, signature-mismatch repair, MCQ out-of-range / excluded option, verified-only cache semantics (commit/evict, attempt-1-only hit) — M
- [ ] `snapshotPage` cap and "never throws" tests — S
- [ ] `scaler_page.js` pure helpers (`classifyFailureFeedback`, `buildProblemsUrl`, `resolveTargetLanguage`, `normalizeLanguageName`, `extractTestCases`) — S
- [ ] GitHub Actions: `npm ci` → `npm run lint` → `npm test`; second job installs Playwright browsers and runs DOM + e2e tests — M
- [ ] Coverage report (`node --test --experimental-test-coverage`) with a floor (start at 60%) — S
- [ ] Pre-commit hook (lint + unit tests) — S

---

## 9. P2 — Data, cache and housekeeping

- [ ] **Prune the 144 stale `.solver-cache/` files.** Their key versions (`v3`, `MCQ_V1`, old lab keys) are no longer read. Add `npm run cache:prune` (delete entries not matching current versions / older than N days) — S
- [ ] Cache entries should record `promptVersion`, `model`, `verifiedAt` so a prompt change can invalidate selectively — S
- [ ] Cache TTL / manual `--clear-cache` flag — S
- [ ] `curriculum-cache.json` and `run-state.json` are in the repo folder; move default `SAAB_DATA_DIR` to a `data/` subfolder so the repo root stays clean (`data/` is already gitignored) — S
- [ ] Rotate run-log history in `runs/` (keep last 30) — S

---

## 10. BITS / Coursera (out of scope)

Not reviewed beyond the initial read and not modified: `bits_main.js`, `bits_crawler.js`, `bits_handler.js`, `bits_config.js`, `test_bits_dom.js` (excluded from ESLint for now).
Known issues from the first read, for whenever it is revisited:
- Submits without reading the grade (always reports `pass` after a fixed delay)
- Multi-select questions are treated as single-answer
- It automatically ticks the Coursera Honor Code box and clicks the academic-integrity "I understand" prompt. That is a false attestation on the user's behalf and a real policy risk (account/credential consequences). **Recommendation: remove those two auto-clicks before any further BITS work.**
- Registers its own SIGINT/SIGTERM handlers on import (now lazily imported, but still duplicated logic)

---

## 11. Suggested order of work

| Milestone | Contents | Exit criteria |
|---|---|---|
| **M1 — Trustworthy** (≈2–3 days) | 1.1 mock e2e, 1.3 DOM fixtures, 1.4 workspace review, 2.1 image-MCQ guard, 2.3 per-problem timeout, 2.4 shared re-auth, §8 run_state + solver stub tests | `npm run test:e2e` green in CI; no known path submits a guessed answer |
| **M2 — Correct** (≈2 days) | 2.2 multi-select, 2.5–2.8 retry/lab quality, §3 term selection + blind spots, default-to-dry-run | First real live run of every problem type succeeds under `--max-submissions` |
| **M3 — Operable** (≈2 days) | §5 logging + richer run log + notifications, §4 circuit breaker + provider consolidation + SDK migration, §6 session-slot hygiene | A failed unattended run can be diagnosed from files alone |
| **M4 — Maintainable** (≈1–2 days) | §7 refactor, §9 cache/data cleanup, docs (README rewrite, ARCHITECTURE, LICENSE), CI polish | New contributor can run, test and extend it from the README |

---

## 12. Definition of "production-ready" for this project

- [ ] Every solve path (MCQ, coding, lab, VS Code) has been run live at least once and has an automated offline test
- [ ] No code path can submit a guessed or unverified answer
- [ ] A hung page, crashed browser, expired session, or exhausted API quota never hangs or corrupts state — the run stops cleanly and resumes from the checkpoint
- [ ] Secrets and live cookies never leave the machine or the ignored files; snapshots are redacted
- [ ] Safe defaults: dry-run unless `--submit`, bounded concurrency, hard submission cap
- [ ] One command (`npm test && npm run lint`) gates every change in CI
- [ ] A failed run is diagnosable from `runs/`, structured logs and `debug/` without re-running it

---

*Nothing here is committed yet — this file is a plan. Generated after the hardening pass; update the status tables as items land.*
