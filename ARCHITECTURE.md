# SAAB System Architecture & Technical Specification

> **SAAB (Scalable Academic Automation & Benchmarking Engine)**  
> Production-grade, fault-tolerant browser automation platform engineered for high-concurrency curriculum assessment, LLM code generation benchmarking, and multi-portal academic evaluation.

---

## 1. Executive Architecture Summary

SAAB is an autonomous distributed agent engine designed to ingest academic curricula, orchestrate browser interaction across complex single-page web applications (Monaco/Ace editors, xterm.js pseudoterminals, multi-step MCQ engines), dispatch LLM reasoning workflows through a fault-tolerant multi-provider cascade, and reliably persist execution state with transactional safety.

```
                           +---------------------------+
                           |     CLI / Entrypoints     |
                           |  (main.js / bits_main.js) |
                           +-------------+-------------+
                                         |
               +-------------------------+-------------------------+
               |                                                   |
               v                                                   v
     +-------------------+                               +-------------------+
     |  Scaler Pipeline  |                               |   BITS Pipeline   |
     | (Curriculum/Code) |                               | (Coursera Degree) |
     +---------+---------+                               +---------+---------+
               |                                                   |
               +-------------------------+-------------------------+
                                         |
                                         v
                         +-------------------------------+
                         |   Playwright Browser Pool     |
                         |  (Page Worker Concurrency)    |
                         +---------------+---------------+
                                         |
               +-------------------------+-------------------------+
               |                         |                         |
               v                         v                         v
     +-------------------+     +-------------------+     +-------------------+
     |   Monaco Editor   |     |    MCQ Engine     |     |   Maxwell xterm   |
     |  (Code Solution)  |     | (Single/Multi/Img)|     |  (Terminal Labs)  |
     +---------+---------+     +---------+---------+     +---------+---------+
               |                         |                         |
               +-------------------------+-------------------------+
                                         |
                                         v
                         +-------------------------------+
                         |      AI Provider Cascade      |
                         |  Gemini -> Groq -> Grok       |
                         |  QuotaLimiter + CircuitBreaker|
                         +---------------+---------------+
                                         |
                                         v
                         +-------------------------------+
                         |   Two-Tier Solution Cache     |
                         | Memory Map + Atomic FS Disk   |
                         +-------------------------------+
```

---

## 2. System Topology & Directory Layout

```
SAAB/
├── main.js                     # Scaler Academy primary orchestrator & concurrency pool
├── bits_main.js                # BITS Pilani Coursera degree primary orchestrator
├── crawler.js                  # Scaler curriculum graph & class queue crawler
├── bits_crawler.js             # Coursera degree dashboard & deadline queue crawler
├── bits_handler.js             # Coursera quiz DOM interaction, answer parser & submitter
├── solver.js                   # Unified LLM inference engine, ReAct loops & prompt templates
├── rate_limiter.js             # Sliding-window QuotaLimiter (RPM/RPD) & CircuitBreaker
├── injector.js                 # Ace/Monaco synthetic code injection & event dispatcher
├── workspace_manager.js        # In-browser VS Code / Monaco IDE workspace automation
├── mcq_handler.js              # MCQ scraping, normalization, vision routing & injection
├── lab_handler.js              # Maxwell xterm.js interactive pseudoterminal automation
├── answer_store.js             # External answer sheet ingestion & fuzzy text matching
├── answer_indexer.js           # Document parser & indexer for external course solutions
├── run_state.js                # Checkpoint manager with idempotent completion tracking
├── page_utils.js               # Resilient DOM interactions, element waiters & screenshotting
├── paths.js                    # Cross-platform deterministic path resolver
├── scripts/
│   └── prune_cache.js          # Cache maintenance, TTL expiration & corrupted entry pruning
├── test/                       # Comprehensive TAP unit, integration, and E2E test suites
└── runs/                       # Run correlation envelopes indexed by runId
```

---

## 3. Concurrency Model: Playwright Page Pool

SAAB uses a high-throughput browser pooling model over a persistent Playwright `BrowserContext`, separating session state from page lifecycle to prevent memory leaks and browser bloat.

### Worker Pool Architecture

```
                       +-----------------------------+
                       | Persistent Browser Context  |
                       | (Chrome Profile + Cookies)  |
                       +--------------+--------------+
                                      |
         +----------------------------+----------------------------+
         |                            |                            |
         v                            v                            v
+------------------+         +------------------+         +------------------+
| Worker 1 (Page)  |         | Worker 2 (Page)  |         | Worker 3 (Page)  |
| Class A, Prob 1  |         | Class A, Prob 2  |         | Class B, Prob 1  |
+------------------+         +------------------+         +------------------+
         |                            |                            |
         +----------------------------+----------------------------+
                                      |
                                      v
                       +-----------------------------+
                       |   AsyncMutex Synchronization|
                       |  (Single-Instance Terminal) |
                       +-----------------------------+
```

1. **Persistent Context Isolation:**
   Chrome user profiles (`temp_chrome_profile` / `temp_chrome_profile_bits`) are retained across invocations, preserving authentication tokens and preventing repeated OAuth/SSO login flows.
2. **Network Traffic Pruning:**
   All browser instances register route interceptors dropping high-overhead analytics, logging beacons, and trackers (`google-analytics`, `mixpanel`, `datadog`, `sentry.io`, `hotjar`, `clarity.ms`). This reduces memory consumption by ~40% and eliminates telemetry interference.
3. **Dynamic Page Provisioning:**
   Each worker in the pool claims a question from the synchronized curriculum queue. When a problem finishes (pass/skip/fail), the worker page is either reset or recycled to prevent unbounded DOM memory expansion.
4. **Mutex-Guarded Singletons:**
   Certain interactive targets—specifically containerized VS Code workspace environments and Maxwell terminal sessions—cannot run concurrently on the same user session without session collision. SAAB uses an `AsyncMutex` pattern to serialize workspace execution while allowing non-conflicting MCQ and code evaluation to proceed in parallel.

---

## 4. Multi-Tier AI Provider Cascade & Fault Tolerance

The inference engine in `solver.js` implements a resilient three-tier fallback architecture:

```
                  +--------------------------------+
                  |       Solve Request Entry      |
                  +---------------+----------------+
                                  |
                                  v
                  +--------------------------------+
                  | Tier 1: Gemini 2.5 Flash / Pro |
                  |       (@google/genai SDK)      |
                  +---------------+----------------+
                                  | (429 Quota Exhausted / Circuit Open)
                                  v
                  +--------------------------------+
                  | Tier 2: Groq (Llama 3.3 70B)   |
                  |     (High-Throughput Text)     |
                  +---------------+----------------+
                                  | (Rate Limit / Failure)
                                  v
                  +--------------------------------+
                  | Tier 3: Grok (xAI grok-2/beta) |
                  |     (Final Fallback Tier)      |
                  +---------------+----------------+
```

### Dual-Layer Rate Limiting & Health Circuit

Every provider is wrapped by two distinct defense layers:

```
[Inference Call] 
       │
       ▼
┌──────────────────────────────────────────────┐
│ Layer 1: Proactive Sliding-Window Quota      │
│ - RPM Window (60-second rolling token buck.) │ ──> Over RPM? Sleep until window clears
│ - RPD Budget (Daily quota threshold)         │ ──> Over RPD? Mark dead, trigger fallback
└──────────────────────┬───────────────────────┘
                       │ Passes Quota
                       ▼
┌──────────────────────────────────────────────┐
│ Layer 2: Reactive Circuit Breaker            │
│ State: CLOSED                                │ ──> Allow execution
│ State: OPEN (3 consecutive 5xx/net errors)   │ ──> Block calls, trip cooldown (60s)
│ State: HALF_OPEN (1 test probe after cool)   │ ──> 1 success resets to CLOSED
└──────────────────────┬───────────────────────┘
                       │ Breaker Closed
                       ▼
          [Upstream Provider API Call]
```

- **Proactive Layer (`QuotaLimiter`):** Maintains timestamped queues of API invocations. Enforces RPM ceilings with jittered delays and tracks hard RPD boundaries. If a provider hits a daily limit, it is disabled for the remainder of the execution run.
- **Reactive Layer (`CircuitBreaker`):** Detects consecutive 5xx server errors, socket timeouts, or provider crashes. After 3 failures, it trips to `OPEN`, immediately diverting requests to the next tier without wasting network roundtrips. After a 60-second cooldown, it enters `HALF_OPEN` to test provider recovery with a single probe.

### Multimodal Vision Safety Gate

For image-based questions (MCQs containing problem diagrams, circuit schematics, or architecture trees):
- Text-only providers (such as Groq Llama 3.3) are **strictly disqualified**.
- The task is routed exclusively to Gemini Vision with base64 payload extraction.
- If Gemini is exhausted or offline, the solver refuses to guess blindly, returning a controlled skip to protect score integrity.

---

## 5. The ReAct Adaptive Self-Correction Feedback Loops

SAAB uses the Reasoning + Action (ReAct) pattern to iteratively converge on correct solutions rather than relying on one-shot generation.

### 5.1 Algorithmic Coding Problem Loop

```
           +---------------------------------------------+
           | 1. Scrape problem statement, constraints,   |
           |    starter code, and test cases             |
           +----------------------+----------------------+
                                  |
                                  v
           +---------------------------------------------+
           | 2. Check solution cache for identical hash  |
           +----------------------+----------------------+
                                  | (Miss)
                                  v
+--------> +---------------------------------------------+
|          | 3. Dispatch structured prompt to AI         |
|          |    (<problem_title>, <problem_body>)        |
|          +----------------------+----------------------+
|                                 |
|                                 v
|          +---------------------------------------------+
|          | 4. Inject synthetic code into Monaco/Ace    |
|          |    and trigger "Run Code" execution         |
|          +----------------------+----------------------+
|                                 |
|                                 v
|          +---------------------------------------------+
|          | 5. Scrape judge output and verdict          |
|          +----------------------+----------------------+
|                                 |
|                  +--------------+--------------+
|                  |                             |
|          (Compilation/Test Failure)         (Accepted)
|                  |                             |
|                  v                             v
|          +----------------------+    +-------------------------+
|          | 6. Classify feedback |    | 7. Commit to Cache      |
|          |    (TLE, WA, Syntax) |    |    (Hash -> Verified)   |
|          +----------------------+    +-------------------------+
|                  |                                 |
+------------------+                                 v
    (Retry with error trace &              +---------------------+
     previous code context)                | 8. Submit to Portal |
                                           +---------------------+
```

- **Prompt Delimitation:** All problem descriptions and starter snippets are encapsulated in explicit XML tags (`<problem_title>`, `<problem_body>`, `<starter_code>`) to prevent prompt injection from malicious test case descriptions.
- **Heuristic Feedback Classification:** Compiler traces, stack traces, and judge outputs are parsed into actionable feedback directives (e.g., *Time Limit Exceeded -> optimize algorithmic complexity from $O(N^2)$ to $O(N \log N)$*, *Memory Limit Exceeded -> eliminate large temporary allocations*).
- **Bounded Attempts:** The loop is capped at 3-4 attempts. If the solution cannot converge, the runner bails cleanly without hanging.

### 5.2 MCQ Elimination & Review Loop

- **Negative Feedback Cache:** When an MCQ submission receives a negative verdict from the judge, the failing option is recorded in `.solver-cache/` under `wrongMCQOptions`. Subsequent attempts explicitly prune that choice from the candidate set.
- **Review Screen Crystallization:** On Coursera/BITS review screens, post-submission feedback cards are scraped. Correctly answered questions (`1 / 1 point` or `Correct`) are instantly committed to `.solver-cache/`, while failed options are added to the negative set for subsequent retries.

---

## 6. Two-Tier Caching Architecture & Idempotency

### Cache Architecture

```
   [Solve Request]
          │
          ▼
┌──────────────────────────────────────┐
│ Tier 1: In-Memory Map Cache          │ ──(Hit: 0.1ms)──> Return Cached Solution
└──────────────────┬───────────────────┘
                   │ Miss
                   ▼
┌──────────────────────────────────────┐
│ Tier 2: Filesystem Cache Disk Store  │
│ Path: .solver-cache/<sha256>.json    │ ──(Hit: 1-2ms)──> Hydrate Tier 1 & Return
└──────────────────┬───────────────────┘
                   │ Miss
                   ▼
        [Execute AI Generation]
                   │
                   ▼
┌──────────────────────────────────────┐
│ Atomic Write:                        │
│ 1. Write payload to tmp file         │
│ 2. fs.renameSync(tmp, finalPath)     │
└──────────────────────────────────────┘
```

1. **Content-Addressable Hashing:**
   Cache keys are generated using normalized problem titles, canonical code signatures, and question option permutations. Minor whitespace variations in problem statements do not cause cache misses.
2. **Crash-Safe Atomic Writes:**
   All disk mutations write first to a temporary file in the `.solver-cache/` staging directory before atomically replacing the target cache file via `fs.renameSync()`. If the process receives `SIGINT` or power is interrupted midway through a write, the cache is never corrupted.
3. **Cache Maintenance (`npm run cache:prune`):**
   A dedicated maintenance script audits the cache against a JSON schema, evicts entries older than a configured TTL (default: 30 days), and cleans zero-byte or malformed files.

---

## 7. Cross-Platform Portal Abstraction

| Subsystem Component | Scaler Academy Architecture (`main.js`) | BITS Pilani Coursera Architecture (`bits_main.js`) |
| :--- | :--- | :--- |
| **Authentication** | Headless SSO / Google OAuth session persistence | Persistent headed Chrome context + Duo/SSO authentication |
| **Curriculum Discovery** | Crawls syllabus tree: Batch -> Class -> Assignments | Scrapes Degree Dashboard home & deadline feed widgets |
| **Problem Types** | Algorithmic Coding, Complex MCQs, Maxwell Terminal Labs | Graded Quizzes, Multi-Select Checkboxes, Math/Code MCQs |
| **Code Execution** | Ace/Monaco editor injection + backend Docker judge | N/A (Coursera assessment quizzes and code snippets) |
| **Agreement Policy** | SST Platform Honor Code Modal | Coursera Assessment Agreement / Honor Code checkbox |
| **Future Lock Detection** | Milestone date locking on upcoming class modules | Parses `"This item will be available <Date>"` strings |
| **Execution Default** | Dry-run preview mode (requires `--submit` to commit) | Dry-run preview mode (requires `--submit` to commit) |

---

## 8. Observability & Distributed Tracing

### Structured Logging & Correlation IDs

Every execution run generates a globally unique identifier:
- Scaler Runs: `run_<timestamp>_<hex>`
- BITS Coursera Runs: `bits_<timestamp>_<base36>`

```json
{
  "runId": "run_1732213500000_a3f89c",
  "startedAt": "2026-11-21T18:25:00.000Z",
  "finishedAt": "2026-11-21T18:27:15.000Z",
  "mode": "dry-run",
  "metrics": {
    "runId": "run_1732213500000_a3f89c",
    "classesSeen": 4,
    "classesSkipped": 2,
    "problemsRead": 12,
    "problemsSolved": 10,
    "problemsFailed": 0,
    "problemsSkipped": 2
  },
  "entries": [
    {
      "runId": "run_1732213500000_a3f89c",
      "timestamp": "2026-11-21T18:25:12.450Z",
      "title": "Reverse Linked List",
      "result": "pass"
    }
  ]
}
```

1. **Per-Run Audit Envelopes:**
   Each run commits a complete audit record to `runs/${runId}.json`, capturing invocation arguments, elapsed duration, operational mode (`dry-run` vs `submit`), solver provider statistics, and detailed item-by-item logs.
2. **Visual Snapshot Diagnostics:**
   When an assertion fails, an unexpected modal blocks the viewport, or a judge returns an unrecognized verdict, `snapshotPage()` writes full-page screenshots and DOM dumps to `debug_screenshots/` tagged with timestamp and problem title for post-mortem analysis.

---

## 9. Production Realism, Scalability Limits & Tradeoffs

1. **Browser Memory Leaks:**
   Chromium instances running long-lived Single Page Applications (SPAs) like Coursera or Scaler inevitably leak memory in DOM event listeners. **Mitigation:** Worker pages are destroyed and recreated every 20-30 problems, and context recycling is triggered automatically when OS RSS memory surpasses 1.5 GB.
2. **DOM Selector Drift:**
   Course portals frequently update React class names and DOM structures. **Mitigation:** SAAB relies on resilient semantic locators (e.g., `aria-label`, data attributes, role definitions, and structured text proximity) rather than fragile CSS class selectors.
3. **Strict Dry-Run Default:**
   To prevent accidental graded submissions or unintended account modifications, SAAB requires explicit flags (`--submit` or `--live`) to trigger live submit clicks. By default, solutions are generated, validated, and cached in dry-run mode.
