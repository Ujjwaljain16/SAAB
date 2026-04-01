import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.solver-cache');
const PROMPT_VERSION = 'v3';
const GROK_API_KEY = (process.env.GROK_API_KEY || process.env.XAI_API_KEY || '').trim();
const GROK_MODEL = (process.env.GROK_MODEL || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const GROQ_MODELS = ((process.env.GROQ_MODELS || '').trim() || 'llama-3.3-70b-versatile,qwen/qwen3-32b')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

function getApiKeys() {
  const keys = [];
  const single = (process.env.GEMINI_API_KEY || '').trim();
  if (single) keys.push(single);

  const poolRaw = (process.env.GEMINI_API_KEYS || '').trim();
  if (poolRaw) {
    const pool = poolRaw
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    keys.push(...pool);
  }

  return Array.from(new Set(keys));
}

const API_KEYS = getApiKeys();
const CLIENTS = API_KEYS.map((k) => new GoogleGenerativeAI(k));

function stripMarkdownFences(text) {
  const raw = (text || '').trim();
  if (!raw) return '';

  const fenced = raw.match(/```[\w-]*\n([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  return raw
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

function hasBalancedBrackets(code) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closing = new Set(Object.values(pairs));
  const stack = [];

  for (const ch of code) {
    if (pairs[ch]) {
      stack.push(pairs[ch]);
      continue;
    }

    if (closing.has(ch)) {
      if (stack.pop() !== ch) return false;
    }
  }

  return stack.length === 0;
}

function looksTruncated(code) {
  const trimmed = (code || '').trim();
  if (!trimmed) return true;

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : '';

  if (!/[;})\]]$/.test(trimmed)) return true;
  if (/\.[A-Za-z_][A-Za-z0-9_]*$/.test(lastLine)) return true;
  if (/\b(return|if|for|while|switch|case|class|public|private|protected)\s*$/.test(lastLine)) return true;

  return false;
}

function isLikelyCompleteCode(code, language) {
  if (!code || code.length < 20) return false;
  if (!hasBalancedBrackets(code)) return false;
  if (looksTruncated(code)) return false;

  if (/java/i.test(language)) {
    if (!/}\s*$/.test(code)) return false;
    return /(class\s+\w+|\b(public|private|protected)\s+\w+\s+\w+\s*\()/i.test(code);
  }

  if (/javascript/i.test(language)) {
    return /(module\.exports|function\s*\(|=>|class\s+\w+)/i.test(code);
  }

  return true;
}

function isSafeBestEffort(code, language) {
  if (!code || code.length < 80) return false;
  if (!hasBalancedBrackets(code)) return false;
  if (looksTruncated(code)) return false;
  return isLikelyCompleteCode(code, language);
}

function extractLikelyCode(text) {
  const cleaned = stripMarkdownFences(text || '');
  if (!cleaned) return '';

  // If model prepends explanations, trim from first code-looking token.
  const markers = [
    'module.exports',
    'class ',
    'public class',
    'function ',
    'const ',
    'let ',
    'var '
  ];

  const lower = cleaned.toLowerCase();
  let first = -1;
  for (const marker of markers) {
    const idx = lower.indexOf(marker.toLowerCase());
    if (idx !== -1 && (first === -1 || idx < first)) {
      first = idx;
    }
  }

  if (first > 0) {
    return cleaned.slice(first).trim();
  }

  return cleaned;
}

function parseRetryDelaySeconds(error) {
  const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
  const retryInfo = details.find((d) => String(d?.['@type'] || '').includes('RetryInfo'));
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay === 'string') {
    const m = retryDelay.match(/([\d.]+)s/i);
    if (m) return Math.max(1, Math.ceil(Number(m[1])));
  }

  const msg = String(error?.message || '');
  const m = msg.match(/Please retry in\s*([\d.]+)s/i);
  if (m) return Math.max(1, Math.ceil(Number(m[1])));

  return 5;
}

function isDailyQuotaExceeded(error) {
  const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
  const quota = details.find((d) => String(d?.['@type'] || '').includes('QuotaFailure'));
  const violations = Array.isArray(quota?.violations) ? quota.violations : [];

  if (violations.some((v) => /perday/i.test(String(v?.quotaId || '')))) {
    return true;
  }

  const msg = String(error?.message || '');
  return /perday|daily|free_tier_requests/i.test(msg);
}

function isDailyQuotaMessage(message) {
  return /perday|daily|quota|free_tier_requests|limit reached/i.test(String(message || ''));
}

function parseRetryDelayFromText(text, fallback = 5) {
  const m = String(text || '').match(/([\d.]+)\s*s/i);
  if (m) return Math.max(1, Math.ceil(Number(m[1])));
  return fallback;
}

async function generateWithGrok(promptText) {
  if (!GROK_API_KEY) {
    return { ok: false, type: 'provider_unavailable', message: 'Grok key not configured' };
  }

  if (!GROK_MODEL) {
    return { ok: false, type: 'provider_unavailable', message: 'Grok model not configured' };
  }

  let res;
  try {
    res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.2,
        max_tokens: 4096
      })
    });
  } catch (error) {
    return {
      ok: false,
      type: 'solver_error',
      message: String(error?.message || 'Grok request failed')
    };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const retryHeader = Number(res.headers.get('retry-after') || 0);
    const errMsg = String(data?.error?.message || data?.message || `Grok HTTP ${res.status}`);
    const retryAfterSeconds = retryHeader > 0 ? retryHeader : parseRetryDelayFromText(errMsg, 5);

    if (res.status === 429) {
      return {
        ok: false,
        type: 'rate_limit',
        retryAfterSeconds,
        fatal: isDailyQuotaMessage(errMsg),
        message: errMsg
      };
    }

    return {
      ok: false,
      type: 'solver_error',
      message: errMsg
    };
  }

  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      : '';

  return { ok: true, text };
}

async function generateWithGroq(promptText, modelName = GROQ_MODEL) {
  if (!GROQ_API_KEY) {
    return { ok: false, type: 'provider_unavailable', message: 'Groq key not configured' };
  }

  if (!modelName) {
    return { ok: false, type: 'provider_unavailable', message: 'Groq model not configured' };
  }

  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.2,
        max_tokens: 4096
      })
    });
  } catch (error) {
    return {
      ok: false,
      type: 'solver_error',
      message: String(error?.message || 'Groq request failed')
    };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const retryHeader = Number(res.headers.get('retry-after') || 0);
    const errMsg = String(data?.error?.message || data?.message || `Groq HTTP ${res.status}`);
    const retryAfterSeconds = retryHeader > 0 ? retryHeader : parseRetryDelayFromText(errMsg, 5);

    if (res.status === 429) {
      return {
        ok: false,
        type: 'rate_limit',
        retryAfterSeconds,
        fatal: isDailyQuotaMessage(errMsg),
        message: errMsg
      };
    }

    return {
      ok: false,
      type: 'solver_error',
      message: errMsg
    };
  }

  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      : '';

  return { ok: true, text };
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function makeCacheKey(questionText, language, starterCode) {
  const payload = `${PROMPT_VERSION}\n${language}\n${questionText || ''}\n${starterCode || ''}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function readCache(cacheKey) {
  try {
    ensureCacheDir();
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (!fs.existsSync(cachePath)) return null;

    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const code = typeof parsed?.code === 'string' ? parsed.code : '';
    if (!code) return null;
    return code;
  } catch {
    return null;
  }
}

function writeCache(cacheKey, code, language) {
  try {
    ensureCacheDir();
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    fs.writeFileSync(cachePath, JSON.stringify({ code, language, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    // ignore cache write errors
  }
}

export async function solve(questionText, testCases, language, options = {}) {
  if (CLIENTS.length === 0 && !GROK_API_KEY && !GROQ_API_KEY) {
    return {
      ok: false,
      type: 'solver_error',
      message: 'Missing GEMINI_API_KEY/GEMINI_API_KEYS and GROK_API_KEY/XAI_API_KEY and GROQ_API_KEY in environment.'
    };
  }

  const compactQuestion = (questionText || '').slice(0, 14000);
  const compactTests = (testCases || '').slice(0, 4000);
  const starterCode = (options.starterCode || '').slice(0, 12000);
  const previousFeedback = (options.previousFeedback || '').slice(0, 6000);
  const solveAttempt = options.attempt || 1;

  const prompt = `
You are an expert coder solving a programming assignment on an online judge.
Output ONLY raw code with no explanation and no markdown fences.
Your code must be COMPLETE and compilable.

Language: ${language}
Attempt: ${solveAttempt}

Question:
${compactQuestion}

Test Cases:
${compactTests}

Current Editor Starter Code (must preserve expected structure/signatures):
${starterCode || '[No starter code captured]'}

Previous Attempt Feedback (compile/runtime/wrong answer):
${previousFeedback || '[No previous feedback]'}

Rules:
- Return ONLY the final code to paste in editor.
- Do not wrap output in markdown or backticks.
- Do not include any comments in the code.
- Follow the existing starter code format and required function/class names exactly.
- If starter code provides a class/function scaffold, keep that scaffold and fill only required logic.
- For Java: never invent a different public class name than scaffold expects.
- Use previous feedback to fix errors from prior attempt.
- Provide an optimized implementation appropriate for input constraints.
`;

  const cacheKey = makeCacheKey(compactQuestion, language, starterCode);
  const cachedCode = readCache(cacheKey);
  if (cachedCode) {
    return { ok: true, code: cachedCode };
  }

  let bestCandidate = '';
  let minRetrySeconds = Number.MAX_SAFE_INTEGER;
  let exhaustedGeminiKeys = 0;
  let exhaustedGrok = false;
  const exhaustedGroqModels = new Set();
  let sawRateLimit = false;

  for (let modelAttempt = 1; modelAttempt <= 4; modelAttempt++) {
    const attemptPrompt = modelAttempt === 1
      ? prompt
      : `${prompt}\n\nIMPORTANT RETRY RULES:\n- Your previous answer was incomplete/truncated.\n- Regenerate the FULL code from the first line to the last line.\n- Keep it short and without comments.\n- Ensure the code ends cleanly with closing braces.\n- Output only final optimized code.`;

    for (let i = 0; i < CLIENTS.length; i++) {
      const model = CLIENTS[i].getGenerativeModel({ model: "gemini-2.5-flash" });
      let result;

      try {
        result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: attemptPrompt }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            temperature: 0.2
          }
        });
      } catch (error) {
        if (error?.status === 429) {
          sawRateLimit = true;
          const retrySec = parseRetryDelaySeconds(error);
          minRetrySeconds = Math.min(minRetrySeconds, retrySec);

          if (isDailyQuotaExceeded(error)) {
            exhaustedGeminiKeys += 1;
            continue;
          }

          continue;
        }

        console.error("Error asking Gemini to solve:", error);
        return {
          ok: false,
          type: 'solver_error',
          message: String(error?.message || 'Gemini request failed')
        };
      }

      const code = extractLikelyCode(result.response.text() || '');

      if (code.length > bestCandidate.length) {
        bestCandidate = code;
      }

      if (isLikelyCompleteCode(code, language)) {
        writeCache(cacheKey, code, language);
        return { ok: true, code };
      }
    }

    if (GROK_API_KEY && !exhaustedGrok) {
      const grokResult = await generateWithGrok(attemptPrompt);
      if (grokResult.ok) {
        const code = extractLikelyCode(grokResult.text || '');
        if (code.length > bestCandidate.length) {
          bestCandidate = code;
        }

        if (isLikelyCompleteCode(code, language)) {
          writeCache(cacheKey, code, language);
          return { ok: true, code };
        }
      } else if (grokResult.type === 'rate_limit') {
        sawRateLimit = true;
        minRetrySeconds = Math.min(minRetrySeconds, Number(grokResult.retryAfterSeconds || 5));
        if (grokResult.fatal) {
          exhaustedGrok = true;
        }
      } else if (grokResult.type !== 'provider_unavailable') {
        return grokResult;
      }
    }

    if (GROQ_API_KEY) {
      for (const groqModel of GROQ_MODELS) {
        if (exhaustedGroqModels.has(groqModel)) {
          continue;
        }

        const groqResult = await generateWithGroq(attemptPrompt, groqModel);
        if (groqResult.ok) {
          const code = extractLikelyCode(groqResult.text || '');
          if (code.length > bestCandidate.length) {
            bestCandidate = code;
          }

          if (isLikelyCompleteCode(code, language)) {
            writeCache(cacheKey, code, language);
            return { ok: true, code };
          }
        } else if (groqResult.type === 'rate_limit') {
          sawRateLimit = true;
          minRetrySeconds = Math.min(minRetrySeconds, Number(groqResult.retryAfterSeconds || 5));
          if (groqResult.fatal) {
            exhaustedGroqModels.add(groqModel);
          }
        } else if (groqResult.type !== 'provider_unavailable') {
          return groqResult;
        }
      }
    }

    if (GROK_API_KEY && !exhaustedGrok) {
      const grokResult = await generateWithGrok(attemptPrompt);
      if (grokResult.ok) {
        const code = extractLikelyCode(grokResult.text || '');
        if (code.length > bestCandidate.length) {
          bestCandidate = code;
        }

        if (isLikelyCompleteCode(code, language)) {
          writeCache(cacheKey, code, language);
          return { ok: true, code };
        }
      } else if (grokResult.type === 'rate_limit') {
        sawRateLimit = true;
        minRetrySeconds = Math.min(minRetrySeconds, Number(grokResult.retryAfterSeconds || 5));
        if (grokResult.fatal) {
          exhaustedGrok = true;
        }
      } else if (grokResult.type !== 'provider_unavailable') {
        return grokResult;
      }
    }

    console.log(`Generated code looked incomplete (attempt ${modelAttempt}), retrying...`);
  }

  if (isSafeBestEffort(bestCandidate, language)) {
    console.log('Using best-effort generated code from model.');
    writeCache(cacheKey, bestCandidate, language);
    return { ok: true, code: bestCandidate };
  }

  const geminiAllExhausted = CLIENTS.length > 0 ? exhaustedGeminiKeys >= CLIENTS.length : true;
  const grokAllExhausted = GROK_API_KEY ? exhaustedGrok : true;
  const groqAllExhausted = GROQ_API_KEY ? GROQ_MODELS.every((m) => exhaustedGroqModels.has(m)) : true;

  if (geminiAllExhausted && grokAllExhausted && groqAllExhausted) {
    return {
      ok: false,
      type: 'rate_limit',
      retryAfterSeconds: Number.isFinite(minRetrySeconds) ? minRetrySeconds : 30,
      fatal: true,
      message: 'All configured Gemini/Grok/Groq providers exhausted daily quota.'
    };
  }

  if (sawRateLimit && Number.isFinite(minRetrySeconds)) {
    return {
      ok: false,
      type: 'rate_limit',
      retryAfterSeconds: minRetrySeconds,
      fatal: false,
      message: 'Gemini rate-limited. Retry after backoff.'
    };
  }

  return {
    ok: false,
    type: 'incomplete_generation',
    message: 'Model output remained incomplete across retries.'
  };
}
