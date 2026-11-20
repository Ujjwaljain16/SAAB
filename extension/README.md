# SAAB — Academic Workflow Assistant (Chrome Extension v2.0.0)

A multi-platform Chrome Extension built with **Manifest V3**, **TypeScript**, and **React** that assists students on **BITS Pilani (Coursera)** and **Scaler Academy** using a Bring-Your-Own-Key (BYOK) Gemini AI engine and a verified course reference database.

---

## 🚀 Key Features

* **Zero Backend & Zero Cost ($0):** Runs 100% locally in your browser. No servers, no Node.js installations for users, no databases, and no cloud hosting bills.
* **Zero Credential Collection:** Runs inside your existing authenticated Chrome session. It never collects, asks for, or stores your Google or Scaler passwords, session tokens, or cookies.
* **Dual-Platform Adapters:**
  * **BITS Pilani BSc (Coursera):** Auto-detects quizzes, exams, and assignments across enrolled courses. Handles single-choice radio buttons, multi-select checkboxes, and scrambled option ordering.
  * **Scaler Academy:** Auto-detects problem statements, attempt counters, and MCQ options.
* **Verified Course Knowledge Base (70+ Questions):**
  * Bundled with verified answer keys for **Modern Databases**, **Software Development Practices (SDP)**, and **Network Programming (NPCSP)**.
  * Deterministic **Sørensen-Dice token similarity matching** resolves questions and scrambled options in sub-millisecond time.
* **Gemini BYOK (Bring Your Own Key):**
  * Connect your free Gemini API key from Google AI Studio.
  * Supports **Gemini 2.5 Flash** (recommended), Gemini 1.5 Flash, and Gemini 2.5 Pro.
  * Generates high-yield conceptual explanations for unanswered or newly assigned questions.
* **Dual Automation & Assistance Modes:**
  * **⚡ Auto-Solve & Fill All Answers:** Actively iterates through the live page, finds the correct radio buttons and checkboxes, clicks them, dispatches synthetic React `change`/`input` events, and checks the Coursera Honor Code agreement checkbox automatically.
  * **🚀 Full Auto: Solve & Submit (Live):** Completely solves the assessment, selects every answer, checks the honor code, and clicks **Submit assignment** with confirmation handling.
  * **🔍 Preview Mode (Assist Only):** For students who prefer reviewing recommendations before applying changes.

---

## 📦 How to Install in Google Chrome

1. **Download / Build the Extension:**
   * Build the project:
     ```bash
     npm run build:extension
     ```
   * Or extract the pre-built `saab-extension-v2.0.0.zip` file.
2. **Open Chrome Extensions:**
   * Navigate to `chrome://extensions/` in your Chrome address bar.
3. **Enable Developer Mode:**
   * Toggle the **"Developer mode"** switch in the top right corner.
4. **Load Unpacked Extension:**
   * Click **"Load unpacked"**.
   * Select the `extension/dist` folder inside this repository.
5. **Pin the Extension:**
   * Click the Extensions puzzle icon in Chrome's toolbar and pin **SAAB Assistant**.

---

## ⚙️ Initial Configuration (Gemini API Key)

1. Open the SAAB extension popup.
2. Go to the **Settings** tab.
3. Paste your free Gemini API key (obtainable at [Google AI Studio](https://aistudio.google.com/app/apikey)).
4. Click **"Test API Key Connection"** to verify connectivity with Google's servers.
5. Select your preferred model (default: `Gemini 2.5 Flash`).

---

## 🎯 Usage Guide

### 1. BITS Pilani (Coursera)
1. Open your Coursera course assignment, quiz, or exam attempt page (e.g. `https://www.coursera.org/learn/.../exam/...`).
2. Notice the sleek floating **SAAB Assistant** widget in the bottom-right corner of the page.
3. Click **"⚡ Analyze Visible Questions"** in either the in-page widget or the extension popup.
4. The extension instantly:
   * Cross-references questions against verified course answer keys.
   * Invokes Gemini for new/unmatched questions.
   * Renders explanations, confidence scores, and suggested choices.
   * Highlights the suggested option with a subtle purple indicator and a `✨ Suggested Answer` badge.
5. Review each answer carefully and click **Submit** on Coursera when satisfied.

### 2. Scaler Academy
1. Open any Scaler problem or MCQ homework page (`https://www.scaler.com/p/...`).
2. Click the SAAB popup or floating widget.
3. Click **"Analyze Visible Questions"**.
4. The matching option will be highlighted on the page with full conceptual justification.

---

## 🔒 Security & Privacy Architecture

* **No Centralized Storage:** Your Gemini API key is stored exclusively in Chrome's private local extension storage (`chrome.storage.local`).
* **Direct Communication:** AI requests are transmitted directly from your browser to Google Generative Language API endpoints via TLS 1.3 (`https://generativelanguage.googleapis.com`). No intermediary servers exist.
* **No Telemetry / Analytics:** Zero tracking scripts, analytics, or logging telemetry are included in the bundle.
* **No DOM Hijacking:** The extension only adds visual style attributes (`outline`, `background-color`, and badge) without modifying assessment input values or form submit handlers.

---

## 🛠️ Development & Testing

```bash
# Run all unit tests (25 tests covering matcher, adapters, storage, gemini)
npm run test:extension

# Build production unpacked extension into extension/dist/
npm run build:extension

# Create a zip archive for Chrome Web Store distribution
npm run package:extension
```
