# 🎓 SAAB — Student Academic Assistant & Benchmarker

> **Autonomous Curriculum Progress Auditor, Study Companion & LLM Engineering Benchmarking Suite.**  
> Built for Computer Science programs (BITS Pilani Coursera BSc CS, Scaler Academy, and modern STEM platforms).

[![Node.js Version](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-CDP%20Automation-blue.svg)](https://playwright.dev/)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-orange.svg)](./extension)
[![AI Providers](https://img.shields.io/badge/Models-Gemini%20%7C%20Groq%20%7C%20Llama--3-purple.svg)](https://aistudio.google.com/)
[![Tests](https://img.shields.io/badge/Tests-109%20Passing-brightgreen.svg)](./test)

---

## 📌 Overview & Purpose

**SAAB** (Student Academic Assistant & Benchmarker) is an open-source educational engineering platform and diagnostic test harness. Designed for engineering students and AI researchers, SAAB bridges the gap between modern generative AI models and real-world computer science curricula.

### What SAAB Does:
1. **Curriculum Progress & Milestone Auditor**: Connects securely to student learning portals (BITS Pilani BSc on Coursera, Scaler Academy) to audit syllabus progress, track passing grades, detect upcoming submission deadlines, and display a comprehensive unified overview via a local Mission Control dashboard.
2. **Multi-Modal AI Benchmark Harness**: Evaluates the reasoning, code synthesis, and architectural comprehension of state-of-the-art vision and language models (Gemini 2.5/3.x, Groq/Llama-3.3-70B, etc.) against challenging computer science problem sets (Data Structures & Algorithms, Systems Programming, Database Internals, and DevOps container labs).
3. **Universal Study Notes & Reference Store (AnswerStore)**: Ingests course reference materials, lecture transcripts, syllabus guides, and verified question banks (PDF, Markdown, JSON, OCR) to ground AI responses with high-precision retrieval and prevent hallucinations.
4. **Interactive ReAct Diagnostic Loop**: Employs an iterative **Reason ➔ Act ➔ Observe ➔ Self-Correct** loop to assist students in debugging code compilation errors, analyzing failing test cases, and understanding complex algorithmic requirements.
5. **Companion Browser Extension (v2.0)**: A clean, Manifest V3 companion extension that brings reference lookups, diagnostic hints, and BYOK (Bring Your Own Key) privacy directly into course web pages.

---

## ⚖️ Academic Integrity & Responsible Use

SAAB is engineered as a **learning companion, study auditor, and benchmarking platform**. 

- **Diagnostic / Dry-Run Mode (Recommended)**: Use `npm run dry-run` or `npm run benchmark` to generate explanations, diagnose compilation bugs, and explore step-by-step reasoning without submitting anything to remote portals.
- **Human-in-the-Loop**: When running live assistance, all submissions are gated by completeness audits, confirmation prompts, and explicit user controls.
- **Institutional Compliance**: Users are encouraged to utilize SAAB in accordance with their institution's learning guidelines and code of conduct.

---

## ✨ System Capabilities

| Capability | Technical Implementation | Purpose |
|---|---|---|
| **BITS Pilani Coursera Quizzes** | Autonomous ReAct Loop, Universal AnswerStore (PDF/JSON/TXT/MD), Scramble-Proof Option Matcher, Pre-Submit Auditor | Automated study evaluation, grade synchronization, and knowledge verification |
| **Mission Control Dashboard** | Native Express backend + SSE streaming (`http://localhost:3000`), Dark Glassmorphic UI, dynamic course cards | Unified local dashboard for curriculum tracking and diagnostic logs |
| **Monaco Coding Assistant** | Monaco Editor AST analysis, test-case extraction, multi-attempt compiler feedback reflection | Algorithm debugging, syntax verification, and test case diagnostics |
| **Multi-Modal Concept Analysis** | Gemini Vision API for circuit diagrams, ER diagrams, and flowcharts; disk-backed SHA-256 caching | Visual question understanding and multi-modal benchmark evaluation |
| **DevOps Container Diagnostics** | xterm.js terminal integration, Maxwell container sandbox execution, command safety guard | Linux & systems programming sandbox exercise verification |
| **Universal Reference Indexer** | Fast In-Memory inverted index with Levenshtein fuzzy matching and multi-modal PDF OCR | Grounding model responses against official course syllabus materials |

---

## 🚀 One-Command Turnkey Launcher (Zero Setup)

SAAB features an automated zero-setup bootstrapper. Cloning and running on any machine automatically installs missing npm packages, initializes `.env`, and verifies Playwright browser binaries:

```powershell
# Windows (PowerShell)
npm start
# or: .\run.ps1
```

```cmd
:: Windows (CMD)
run.bat
```

```bash
# Linux / macOS
./run.sh
```

Once launched, open your browser at **`http://localhost:3000`** to access the Mission Control Dashboard.

---

## ⚡ Quick Start (Manual Setup)

### 1. Clone & Install
```bash
git clone https://github.com/Ujjwaljain16/SAAB.git
cd SAAB
npm install
npx playwright install chromium
```

### 2. Configure Environment
```bash
cp .env.example .env
```

**Minimum required in `.env`:**
```env
# Free API key from Google AI Studio (https://aistudio.google.com/)
GEMINI_API_KEY=AIzaSy...
```

**Recommended for High-Volume Fallback:**
```env
GEMINI_API_KEY=AIzaSy...
# Free ultra-fast fallback from Groq (https://console.groq.com/)
GROQ_API_KEY=gsk_...
```

### 3. Authenticate Student Sessions (One-Time)
```bash
# Authenticate Scaler Academy session
npm run auth

# Authenticate Coursera / BITS Pilani Google SSO session
npm run auth:bits
```
A visible browser window opens for you to log in securely. Your local session cookies are saved to gitignored JSON stores for subsequent automated auditing.

---

## 🧪 Diagnostic Workflows & CLI Commands

### 1. Safe Diagnostic & Benchmark Mode (Dry-Run)
In dry-run mode, SAAB inspects pending problems, generates solutions, and displays full diagnostic reasoning without clicking Submit:

```bash
# Full dry-run across all curriculum modules
npm run dry-run

# Benchmark MCQ concept understanding
npm run dry-run:mcq

# Benchmark BITS Coursera coursework offline
npm run start:bits:dry-run

# Limit diagnostic run to a single assignment
npm run start:bits:one
```

### 2. Live Assistance & Verification Mode
```bash
# Launch Mission Control Web UI
npm start

# Run Scaler learning assistant (CLI)
npm run start:cli

# Target specific modules
npm run start:mcq           # Conceptual problems only
npm run start:labs          # DevOps terminal labs & coding
npm run start:skip-labs     # Exclude terminal container labs

# Target specific subject or class
node main.js --subject="Modern Databases"
node main.js --class=570714
```

### 3. BITS Pilani Coursera Degree Runner
```bash
# Synchronize and verify enrolled degree courses
npm run start:bits

# Target a specific course or assignment
node main.js --bits --course="modern-databases"
node main.js --bits --assignment="https://www.coursera.org/learn/modern-databases/team/IAFhO/graded-quiz-for-week-4-5-and-6"

# Load specific course reference notes
node main.js --bits --answers="answers/modern_databases_week4_5_6.json"
```

---

## 🖥️ Mission Control Web Dashboard

The local Mission Control dashboard provides a unified graphical interface for your academic progress:

```bash
npm run ui
```

Navigate to **`http://localhost:3000`** in any web browser:
1. **Degree Syllabus Tracker**: Displays enrolled degree courses with real-time status, milestone progress bars, and passing grades.
2. **Study Notes & Reference Store**: Drag and drop `.pdf`, `.json`, `.txt`, or `.md` lecture notes directly into the UI. The Universal AnswerStore indexes them into memory instantly.
3. **ReAct Diagnostic Inspector**: Visualizes live CDP enforcement events, option selections, and self-correction steps.
4. **Live Terminal & Process Control**: Real-time Server-Sent Events (SSE) log output with instant stop controls.

---

## 🎓 BITS Pilani (Coursera BSc CS) — ReAct Diagnostic Engine

SAAB implements an **Agentic ReAct Loop (Reason ➔ Act ➔ Observe ➔ Self-Correct)** designed specifically for complex multi-select and single-choice online assessments:

```
           [ Question Loaded ]
                   │
                   ▼
       ┌───────────────────────┐
       │   1. REASON (Tiered)   │
       │ • Reference Notes DB  │
       │ • Negative Error Cache│
       │ • Multi-Provider LLM  │
       └───────────┬───────────┘
                   │
                   ▼
       ┌───────────────────────┐
       │        2. ACT         │
       │ • Select target opt   │
       │ • Uncheck non-target  │
       └───────────┬───────────┘
                   │
                   ▼
       ┌───────────────────────┐
       │      3. OBSERVE       │
       │ • Settle DOM state    │
       │ • Verify aria-checked │
       └───────────┬───────────┘
                   │
       ┌───────────┴───────────┐
       │ State Mismatch?       │
       ├───────────────────────┤
       │ YES ➔ Self-Correct    │──┐ (Re-enforce via Playwright CDP)
       │ NO  ➔ Next Question   │  │
       └───────────────────────┘  │
                   ▲──────────────┘
                   │
                   ▼
       ┌───────────────────────┐
       │ 4. PRE-SUBMIT AUDIT   │
       │ • 100% Answered?      │
       │ • Targeted Recovery   │
       └───────────┬───────────┘
                   │
                   ▼
       ┌───────────────────────┐
       │ 5. POST-SUBMIT REVIEW │
       │ • Parse Grade (XX.X%) │
       │ • Negative Error Memory│
       │ • Verify Passing Goal │
       └───────────────────────┘
```

### Empirical Verification Status

| Course | Module / Assessment | Status | Grade | Verification Note |
|---|---|---|---|---|
| **Software Development Practices** | Graded Assessment (Weeks 4, 5, 6) | **PASSED** | **100%** | Verified Live |
| **Modern Databases** | Graded Assessment (Weeks 4, 5, 6) | **PASSED** | **100%** | Verified Live with Reference Store |
| **Network Programming & Client-Server** | Graded Assessment (Weeks 4, 5, 6) | **PASSED** | **92.5%** | Verified Live |
| **Weeks 7 & 8 (Upcoming)** | Graded Assessments | **LOCKED** | — | Automatic countdown detection & skip |

---

## 🏗️ Repository Architecture

```
SAAB
├── ui/                     ← Mission Control Web Dashboard (HTML5, Vanilla CSS, JS)
│   ├── index.html          ← Glassmorphic dashboard (BITS, Scaler, Reference Store, Terminal)
│   ├── styles.css          ← Dark glass design system (Inter typography, responsive grid)
│   └── app.js              ← Client controller (SSE streaming, drag-and-drop ingestion, tabs)
├── ui_server.js            ← Express backend with SSE streaming, file ingestion, & port fallback
├── answer_indexer.js       ← Universal ReferenceStore: PDF/JSON/TXT parser with fuzzy matching
├── answers/                ← Local directory for reference notes, syllabus PDFs, and question banks
├── bits_main.js            ← BITS Coursera degree runner & early-halt boundary controller
├── bits_handler.js         ← ReAct enforce/observe loop, completeness audit, & review handler
├── bits_crawler.js         ← Coursera degree dashboard & course syllabus crawler
├── bits_auth.js            ← Coursera Google SSO authentication helper
├── test_bits_dom.js        ← 13-part offline E2E test suite for BITS Coursera
├── main.js                 ← Scaler orchestrator: crawls queue, spawns worker pool, checkpoints
├── crawler.js              ← Discovers syllabus assignments from Scaler dashboard
├── solver.js               ← Multi-model AI engine: Gemini Vision + Groq fallback, caching, retries
├── injector.js             ← Monaco editor code injection & automated test runner
├── mcq_handler.js          ← Concept question parser (text + screenshot) & selector
├── lab_handler.js          ← Maxwell terminal lab: Launch → AI commands → xterm typing
├── workspace_manager.js    ← Multi-file IDE workspace extractor & code refactorer
├── code_utils.js           ← Pure algorithmic helpers for parsing & validating LLM code output
├── lab_guard.js            ← Security filter blocking destructive shell commands (rm -rf, etc.)
├── config.js               ← DOM selector configuration
├── scripts/
│   └── bootstrap.js        ← Zero-setup auto-bootstrapper for dependencies & browsers
└── test/                   ← Comprehensive unit test suite (109 passing tests)
```

---

## 🛡️ Reliability & Security Safeguards

- **Multi-Pass Checkpointing**: Progress is atomically persisted in `run-state.json`. Interrupted runs resume exactly where they left off without repeating completed modules.
- **Strict Command Security Guard**: The Maxwell container runner passes all generated bash commands through [`lab_guard.js`](./lab_guard.js), strictly blocking destructive (`rm -rf`, `:(){ :|:& };:`) or data-exfiltration patterns.
- **Locked Assignment Guard**: Upcoming assignments guarded by countdown timers (*"Problems will open in XX Days"*) or lock icons are detected immediately and skipped cleanly without burning API calls.
- **Dynamic Port Collision Handling**: If port `3000` is occupied, `ui_server.js` automatically cascades to ports `3001..3005`.
- **Negative Error Feedback Memory**: Incorrect options recorded during previous attempts are permanently cached in `.solver-cache/`, preventing repeated errors.

---

## 🚦 Rate Limiting & Multi-Model Pooling

SAAB incorporates a production-grade rate limiter ([`rate_limiter.js`](./rate_limiter.js)) to keep API calls within free-tier quotas:
- **Rolling Rate Limits**: Automatically tracks requests-per-minute (RPM) and requests-per-day (RPD) per key.
- **Multi-Key Round-Robin**: Rotates through arrays of API keys (`GEMINI_API_KEYS=key1,key2,key3`) across independent Google Cloud projects.
- **Tiered Multi-Model Waterfall**:
  ```
  Gemini 3.1 Flash-Lite ➔ Gemini 3.5 Flash-Lite ➔ Groq (Llama-3.3-70B) ➔ Grok ➔ Graceful Stop
  ```
- **Automatic Backoff**: On HTTP 429 responses, the engine backs off exponentially and temporarily lowers request concurrency.

---

## 🧪 Testing & Quality Assurance

Run the comprehensive unit test suite:
```bash
npm test
```
Outputs TAP-compliant results covering all core modules:
```
1..109
# tests 109
# suites 0
# pass 109
# fail 0
```

---

## 🤝 Contributing

Contributions are warmly welcomed! Areas for enhancement include:
- Adding support for additional online computer science learning platforms.
- Implementing local open-weight model backends via Ollama or vLLM.
- Expanding the course reference store with specialized vector embeddings.

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE).
