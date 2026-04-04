import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.solver-cache');
const PROMPT_VERSION = 'v3';
const GROK_API_KEY = (process.env.GROK_API_KEY || process.env.XAI_API_KEY || '').trim();
if (GROK_API_KEY && GROK_API_KEY.startsWith('gsk_')) {
  console.warn('WARNING: GROK_API_KEY looks like a Groq key (gsk_ prefix). Set GROQ_API_KEY instead.');
}
const GROK_MODEL = (process.env.GROK_MODEL || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const GROQ_MODELS = ((process.env.GROQ_MODELS || '').trim() || 'llama-3.3-70b-versatile,qwen/qwen3-32b')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_OUTPUT_TOKENS = Math.max(4096, Number(process.env.MAX_OUTPUT_TOKENS || 4096));

export const solverStats = {
  cacheHits: 0,
  cacheMisses: 0,
  geminiRequests: 0,
  grokRequests: 0,
  groqRequests: 0,
  rateLimits: 0,
  serverErrors: 0,
  providerFailures: 0
};

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

if (CLIENTS.length === 0 && !GROK_API_KEY && !GROQ_API_KEY) {
  console.error('FATAL: No AI provider API key found. Set GEMINI_API_KEY, GROQ_API_KEY, or GROK_API_KEY in .env');
  process.exit(1);
}

function stripMarkdownFences(text) {
  const raw = (text || '').trim();
  if (!raw) return '';

  const fenced = raw.match(/^```[\w-]*\n([\s\S]*)```\s*$/m);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  return raw
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * Robust JSON extractor that finds the largest bracket-balanced block.
 */
function extractJsonBlock(text) {
  const raw = stripMarkdownFences(text);
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Fallback: try to find a { ... } block
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const slice = raw.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch (e2) {
        // Last resort: remove common AI errors
        const cleaned = slice
          .replace(/\\n/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
          .trim();
          try { return JSON.parse(cleaned); } catch(e3) { throw e; }
      }
    }
    throw e;
  }
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

export function looksTruncated(code) {
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

function extractLikelyCode(rawText) {
  // Strip DeepSeek <think> blocks first
  const noThink = (rawText || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const cleaned = stripMarkdownFences(noThink);
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

function extractJavaMethodSignatures(code) {
  const src = code || '';
  const signatures = [];
  const regex = /public\s+(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = regex.exec(src)) !== null) {
    const full = `public ${m[0].replace(/^\s*public\s+/, '').trim()}`;
    if (!full.includes(' class ') && !full.includes(' interface ')) {
      signatures.push(full.replace(/\s+/g, ' ').trim());
    }
  }
  return signatures.slice(0, 6);
}

function extractMethodNameFromSignature(signature) {
  const m = String(signature || '').match(/\b([A-Za-z_]\w*)\s*\(/);
  return m ? m[1] : '';
}

function extractRequiredMethodNames(starterCode, language) {
  if (/java/i.test(language)) {
    return extractJavaMethodSignatures(starterCode)
      .map(extractMethodNameFromSignature)
      .filter(Boolean);
  }

  if (/javascript/i.test(language)) {
    const names = new Set();
    if (/\bsolve\s*:\s*function\s*\(/i.test(starterCode) || /\bsolve\s*\(/i.test(starterCode)) {
      names.add('solve');
    }
    const fnRegex = /\bfunction\s+([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = fnRegex.exec(starterCode)) !== null) {
      names.add(m[1]);
    }
    return Array.from(names).slice(0, 8);
  }

  return [];
}

function preservesRequiredMethodNames(code, requiredNames) {
  if (!requiredNames || requiredNames.length === 0) return true;
  const src = code || '';
  return requiredNames.every((name) => new RegExp(`\\b${name}\\s*\\(`).test(src) || new RegExp(`\\b${name}\\s*:`).test(src));
}

function extractJavaPublicMethodNames(code) {
  const src = code || '';
  const names = [];
  const regex = /public\s+(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = regex.exec(src)) !== null) {
    const name = m[1];
    if (name && name !== 'main') {
      names.push(name);
    }
  }
  return names;
}

function repairJavaMethodName(code, requiredMethodNames) {
  const src = code || '';
  if (!src || !Array.isArray(requiredMethodNames) || requiredMethodNames.length !== 1) {
    return src;
  }

  const required = requiredMethodNames[0];
  if (!required) return src;
  if (new RegExp(`\\b${required}\\s*\\(`).test(src)) {
    return src;
  }

  const methodRegex = /public\s+(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/g;
  const matches = Array.from(src.matchAll(methodRegex));
  if (matches.length !== 1) {
    return src;
  }

  const foundName = matches[0][1];
  if (!foundName || foundName === 'main') {
    return src;
  }

  const nameStart = matches[0].index + matches[0][0].lastIndexOf(foundName);
  const nameEnd = nameStart + foundName.length;
  return `${src.slice(0, nameStart)}${required}${src.slice(nameEnd)}`;
}

function validateGeneratedCode(code, language, requiredMethodNames) {
  const candidate = /java/i.test(language) ? repairJavaMethodName(code, requiredMethodNames) : code;

  if (!isLikelyCompleteCode(candidate, language)) {
    return { ok: false, reason: 'incomplete', code: candidate };
  }

  if (!preservesRequiredMethodNames(candidate, requiredMethodNames)) {
    const missing = (requiredMethodNames || []).filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(candidate));
    const found = /java/i.test(language) ? extractJavaPublicMethodNames(candidate) : [];
    return {
      ok: false,
      reason: 'signature_mismatch',
      details: `missing: ${missing.join(', ') || 'unknown'}; found public methods: ${found.join(', ') || 'none'}`,
      code: candidate
    };
  }

  return { ok: true, reason: '', code: candidate };
}

function classifyFailureMode(text) {
  const value = (text || '').toLowerCase();

  if (value.includes('incompatible types') || value.includes('cannot find symbol') || value.includes('method ') || value.includes('signature')) {
    return 'signature';
  }

  if (value.includes('wrong answer') || value.includes('expected') || value.includes('actual')) {
    return 'wrong_answer';
  }

  if (value.includes('runtime error') || value.includes('exception') || value.includes('nullpointer') || value.includes('indexoutofbounds')) {
    return 'runtime';
  }

  if (value.includes('time limit exceeded') || value.includes('tle')) {
    return 'time_limit';
  }

  if (value.includes('truncated') || value.includes('incomplete')) {
    return 'truncated';
  }

  return 'generic';
}

function buildRetryPrompt(basePrompt, failureFeedback, attemptNumber, language, selectedLanguageLabel, requiredMethodNames, starterSignatures) {
  const failureMode = classifyFailureMode(failureFeedback);
  const modeInstructions = {
    signature: [
      'Your previous answer changed the starter API.',
      'Preserve every required method name, parameter type, return type, and class name exactly.',
      'Do not change arrays into ArrayList unless the starter already uses ArrayList.',
      'Fix only the minimal code needed to satisfy the signature.'
    ],
    wrong_answer: [
      'Your previous answer compiled but produced the wrong result.',
      'Keep the same scaffold and fix only the logic/edge-case mistake.',
      'Do not rename any method or class.'
    ],
    runtime: [
      'Your previous answer failed at runtime.',
      'Add null/empty/overflow/index safety checks and handle edge cases.',
      'Do not change the required API.'
    ],
    time_limit: [
      'Your previous answer was too slow.',
      'Optimize the current algorithm while preserving the starter scaffold.',
      'Prefer the lowest-complexity correct solution.'
    ],
    truncated: [
      'Your previous answer was truncated or incomplete.',
      'Return the full solution from first line to last line.',
      'Keep the code compact and complete.'
    ],
    generic: [
      'Use the previous feedback to improve the solution.',
      'Preserve the starter scaffold and required method names exactly.'
    ]
  };

  const runtimeHint = selectedLanguageLabel ? `Selected Runtime Label: ${selectedLanguageLabel}` : '';
  const signatureHint = starterSignatures.length ? `Mandatory Java Signatures:\n- ${starterSignatures.join('\n- ')}` : '';
  const methodHint = requiredMethodNames.length ? `Mandatory Method Names:\n- ${requiredMethodNames.join('\n- ')}` : '';

  return `${basePrompt}\n\nRetry Attempt: ${attemptNumber}\nFailure Mode: ${failureMode}\n${runtimeHint ? `${runtimeHint}\n` : ''}Previous Failure Feedback:\n${failureFeedback || '[No previous feedback]'}\n\nRetry Rules:\n- Do not output comments.\n- Output only raw code.\n- Preserve the starter template and required names exactly.\n- ${modeInstructions[failureMode].join('\n- ')}\n${methodHint ? `\n${methodHint}` : ''}${signatureHint ? `\n${signatureHint}` : ''}`;
}

function stripCodeComments(code, language) {
  if (!/java/i.test(language || '')) return code || '';
  const src = code || '';
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  while (i < src.length) {
    const ch = src[i];
    const next = i + 1 < src.length ? src[i + 1] : '';

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      i += 1;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '/' && next === '/') {
        inLine = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
    }

    if (ch === '\\' && (inSingle || inDouble || inBacktick)) {
      out += ch;
      if (next) {
        out += next;
        i += 2;
        continue;
      }
    }

    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
    } else if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
    }

    out += ch;
    i += 1;
  }

  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function isRetryableServerError(error) {
  const status = Number(error?.status || 0);
  if (status >= 500 && status < 600) return true;
  const msg = String(error?.message || '');
  return /high demand|temporar|service unavailable|timeout/i.test(msg);
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
        max_tokens: MAX_OUTPUT_TOKENS
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

async function generateWithGroq(promptText, modelName = GROQ_MODEL, maxTokens = MAX_OUTPUT_TOKENS, responseFormat = null) {
  if (!GROQ_API_KEY) {
    return { ok: false, type: 'provider_unavailable', message: 'Groq key not configured' };
  }

  const payload = {
    model: modelName,
    messages: [{ role: 'user', content: promptText }],
    temperature: 0.6, // Recommended for reasoning models
    max_tokens: maxTokens,
  };

  // Enable reasoning-specific features for supported models
  const isReasoningModel = modelName.includes('gpt-oss') || modelName.includes('qwen');
  
  if (isReasoningModel) {
    payload.reasoning_format = "parsed"; // Separates <think> into its own field
    if (modelName.includes('gpt-oss')) {
      payload.reasoning_effort = "high";
    } else if (modelName.includes('qwen')) {
      payload.reasoning_effort = "default";
    }
  }

  if (responseFormat === "application/json") {
    payload.response_format = { type: "json_object" };
    // JSON mode on reasoning models requires parsed or hidden
    if (isReasoningModel) {
        payload.reasoning_format = "parsed"; 
    }
  }

  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
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

  const content = data?.choices?.[0]?.message?.content || "";
  const reasoning = data?.choices?.[0]?.message?.reasoning || "";
  const text = reasoning ? `<think>${reasoning}</think>${content}` : content;

  return { ok: true, text };
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// NOTE: clear .solver-cache/ after this change — normalized keys differ from old ones
function makeCacheKey(questionText, language, starterCode) {
  const normQ = (questionText || '').trim().replace(/\s+/g, ' ');
  const normS = (starterCode || '').trim().replace(/\s+/g, ' ');
  const normL = (language || '').trim().toLowerCase();
  const payload = `${PROMPT_VERSION}\n${normL}\n${normQ}\n${normS}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// In-memory cache loaded once at startup
const CACHE_MEMORY = new Map();
function loadAllCache() {
  if (!fs.existsSync(CACHE_DIR)) return;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.code) CACHE_MEMORY.set(file.replace('.json', ''), parsed.code);
    } catch {}
  }
}
loadAllCache();

function readCache(cacheKey) {
  return CACHE_MEMORY.get(cacheKey) || null;
}

function writeCache(cacheKey, code, language) {
  CACHE_MEMORY.set(cacheKey, code);
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
  const starterCodeForPrompt = stripCodeComments(starterCode, language).slice(0, 9000);
  const previousFeedback = (options.previousFeedback || '').slice(0, 6000);
  const compactFeedback = stripCodeComments(previousFeedback, language).slice(0, 2500);
  const selectedLanguageLabel = (options.selectedLanguageLabel || '').slice(0, 120);
  const starterSignatures = /java/i.test(language) ? extractJavaMethodSignatures(starterCodeForPrompt) : [];
  const requiredMethodNames = extractRequiredMethodNames(starterCodeForPrompt, language);
  const solveAttempt = options.attempt || 1;

  const prompt = `
You are an expert coder solving a programming assignment on an online judge.
Output ONLY raw code with no explanation and no markdown fences.
Your code must be COMPLETE and compilable.

Language: ${language}
Selected Runtime Label: ${selectedLanguageLabel || '[Unknown]'}
Attempt: ${solveAttempt}

Question:
${compactQuestion}

Test Cases:
${compactTests}

Current Editor Starter Code (must preserve expected structure/signatures):
${starterCodeForPrompt || '[No starter code captured]'}

Previous Attempt Feedback (compile/runtime/wrong answer):
${compactFeedback || '[No previous feedback]'}

Rules:
- Return ONLY the final code to paste in editor.
- Do not wrap output in markdown or backticks.
- Do not include any comments in the code.
- ABSOLUTE OUTPUT CONTRACT: output must not contain //, /*, or */.
- Follow the existing starter code format and required function/class names exactly.
- DO NOT rename any required function/method/class name from starter code.
- If starter code provides a class/function scaffold, keep that scaffold and fill only required logic.
- For Java: never invent a different public class name than scaffold expects.
- For Java: keep method names, parameter types, and return types EXACTLY as in starter code.
- Do not replace arrays with ArrayList unless starter code already uses ArrayList.
- Use previous feedback to fix errors from prior attempt.
- Provide an optimized implementation appropriate for input constraints.
${requiredMethodNames.length ? `\nMandatory Method Names (must appear unchanged):\n- ${requiredMethodNames.join('\n- ')}` : ''}
${starterSignatures.length ? `\nMandatory Java Signatures:\n- ${starterSignatures.join('\n- ')}` : ''}
`;

  const cacheKey = makeCacheKey(compactQuestion, language, starterCode);
  const cachedCode = readCache(cacheKey);
  if (cachedCode) {
    solverStats.cacheHits += 1;
    return { ok: true, code: cachedCode };
  }

  solverStats.cacheMisses += 1;

  let bestCandidate = '';
  let minRetrySeconds = Number.MAX_SAFE_INTEGER;
  let exhaustedGeminiKeys = 0;
  let exhaustedGrok = false;
  const exhaustedGroqModels = new Set();
  let sawRateLimit = false;

  let previousFailureFeedback = compactFeedback;
  for (let modelAttempt = 1; modelAttempt <= 4; modelAttempt++) {
    const attemptPrompt = modelAttempt === 1
      ? prompt
      : buildRetryPrompt(prompt, previousFailureFeedback, modelAttempt, language, selectedLanguageLabel, requiredMethodNames, starterSignatures);

    for (let i = 0; i < CLIENTS.length; i++) {
      const model = CLIENTS[i].getGenerativeModel({ model: "gemini-2.5-flash" });
      let result;

      try {
        solverStats.geminiRequests += 1;
        result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: attemptPrompt }] }],
          generationConfig: {
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            temperature: 0.2
          }
        });
      } catch (error) {
        if (error?.status === 429) {
          solverStats.rateLimits += 1;
          sawRateLimit = true;
          const retrySec = parseRetryDelaySeconds(error);
          minRetrySeconds = Math.min(minRetrySeconds, retrySec);

          if (isDailyQuotaExceeded(error)) {
            exhaustedGeminiKeys += 1;
            continue;
          }

          continue;
        }

        if (isRetryableServerError(error)) {
          solverStats.serverErrors += 1;
          sawRateLimit = true;
          minRetrySeconds = Math.min(minRetrySeconds, 10);
          continue;
        }

        console.error(`Error asking Gemini key ${i + 1} to solve:`, error?.message);
        solverStats.providerFailures += 1;
        continue;
      }

      const code = stripCodeComments(extractLikelyCode(result.response.text() || ''), language);

      if (code.length > bestCandidate.length) {
        bestCandidate = code;
      }

      const validation = validateGeneratedCode(code, language, requiredMethodNames);
      if (validation.ok) {
        writeCache(cacheKey, validation.code, language);
        return { ok: true, code: validation.code };
      }

      previousFailureFeedback = validation.reason === 'signature_mismatch'
        ? `Output did not preserve required starter method names/signatures. ${validation.details || ''}`
        : 'Output appears incomplete or truncated.';
    }

    if (GROQ_API_KEY) {
      for (const groqModel of GROQ_MODELS) {
        if (exhaustedGroqModels.has(groqModel)) {
          continue;
        }

        solverStats.groqRequests += 1;
        const groqResult = await generateWithGroq(attemptPrompt, groqModel);
        if (groqResult.ok) {
          const code = stripCodeComments(extractLikelyCode(groqResult.text || ''), language);
          if (code.length > bestCandidate.length) {
            bestCandidate = code;
          }

          const validation = validateGeneratedCode(code, language, requiredMethodNames);
          if (validation.ok) {
            writeCache(cacheKey, validation.code, language);
            return { ok: true, code: validation.code };
          }
          previousFailureFeedback = validation.reason === 'signature_mismatch'
            ? `Output did not preserve required starter method names/signatures. ${validation.details || ''}`
            : 'Output appears incomplete or truncated.';
        } else if (groqResult.type === 'rate_limit') {
          solverStats.rateLimits += 1;
          sawRateLimit = true;
          minRetrySeconds = Math.min(minRetrySeconds, Number(groqResult.retryAfterSeconds || 5));
          if (groqResult.fatal) {
            exhaustedGroqModels.add(groqModel);
          }
        } else if (groqResult.type !== 'provider_unavailable') {
          solverStats.providerFailures += 1;
          console.warn(`  Groq model ${groqModel} error: ${groqResult.message}`);
        }
      }
    }

    if (GROK_API_KEY && !exhaustedGrok) {
      solverStats.grokRequests += 1;
      const grokResult = await generateWithGrok(attemptPrompt);
      if (grokResult.ok) {
        const code = stripCodeComments(extractLikelyCode(grokResult.text || ''), language);
        if (code.length > bestCandidate.length) {
          bestCandidate = code;
        }

        const validation = validateGeneratedCode(code, language, requiredMethodNames);
        if (validation.ok) {
          writeCache(cacheKey, validation.code, language);
          return { ok: true, code: validation.code };
        }
        previousFailureFeedback = validation.reason === 'signature_mismatch'
          ? `Output did not preserve required starter method names/signatures. ${validation.details || ''}`
          : 'Output appears incomplete or truncated.';
      } else if (grokResult.type === 'rate_limit') {
        solverStats.rateLimits += 1;
        sawRateLimit = true;
        minRetrySeconds = Math.min(minRetrySeconds, Number(grokResult.retryAfterSeconds || 5));
        if (grokResult.fatal) {
          exhaustedGrok = true;
        }
      } else if (grokResult.type !== 'provider_unavailable') {
        solverStats.providerFailures += 1;
        console.warn(`  Grok error: ${grokResult.message}`);
      }
    }

    const reasonLabel = classifyFailureMode(previousFailureFeedback) === 'signature'
      ? 'signature mismatch with starter'
      : 'incomplete/truncated output';
    console.log(`Generated code rejected (${reasonLabel}) on attempt ${modelAttempt}, retrying...`);
  }

  const repairedBest = /java/i.test(language) ? repairJavaMethodName(bestCandidate, requiredMethodNames) : bestCandidate;
  if (isSafeBestEffort(repairedBest, language) && preservesRequiredMethodNames(repairedBest, requiredMethodNames)) {
    console.log('Using best-effort generated code from model.');
    writeCache(cacheKey, repairedBest, language);
    return { ok: true, code: repairedBest };
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

export async function solveMCQ(problemContent) {
  const prompt = `
Solve the following multiple-choice question.

TITLE: ${problemContent.title}
BODY: ${problemContent.body}

OPTIONS:
${problemContent.options.map(o => `[${o.index}] ${o.label}: ${o.text}`).join('\n')}

Based on the prompt and options above, you MUST return a valid JSON object. Do not return markdown blocks, only raw JSON.
Example output:
{
  "bestOptionIndex": 2,
  "reasoning": "Because option C correctly describes..."
}`;

  if (CLIENTS.length > 0 && problemContent.images && problemContent.images.length > 0) {
    // Has images, use Gemini vision (not fully implemented with images yet, but route to Gemini)
    // For now we just pass text to Gemini
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      return extractJsonBlock(text);
    } catch (e) {
      console.log('Gemini vision MCQ failed', e.message);
    }
  }

  // Fallback to groq if available
  if (GROQ_API_KEY) {
    try {
      const gResult = await generateWithGroq(prompt, GROQ_MODEL, 2048, "application/json");
      if (gResult.ok) {
        return extractJsonBlock(gResult.text);
      }
    } catch(e) {
      console.log('Groq JSON fallback failed', e);
    }
  }

  return { bestOptionIndex: 0, reasoning: 'Fallback default.' };
}

export async function solveWorkspace(problemContent, workspaceMap) {
  const prompt = `
You are an expert backend LLD developer. Modify the files in this workspace to solve the given problem.

PROBLEM TITLE: ${problemContent.title}
PROBLEM BODY: ${problemContent.body}

CURRENT WORKSPACE FILES:
${Object.entries(workspaceMap).map(([file, content]) => `--- ${file} ---\n${content}\n--------------------`).join('\n\n')}

Analyze all requirements. You MUST return exactly ONE valid JSON object with the following schema:
{
  "reasoning": "brief explanation",
  "fileMap": {
     "NameOfFileToModify.java": "complete new content of file with ALL modifications applied"
  }
}
Do not return any conversational text, explanations, or citations before or after the JSON.
Your entire response must be a single parseable JSON object. 
Ensure every modified file contains the full compilation unit (including package, imports, and class declarations).
Keep non-modified files UNCHANGED (do not include them in fileMap).
`;

  if (CLIENTS.length > 0) {
    const modelName = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
    let attempts = 0;
    while (attempts < 2) {
      try {
        const model = CLIENTS[0].getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json" } });
        solverStats.geminiRequests++;
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        return extractJsonBlock(text);
      } catch(e) {
        attempts++;
        const errMsg = e.message || String(e);
        console.log(`    Gemini Workspace attempt ${attempts} failed: ${errMsg.slice(0, 100)}...`);
        
        if (errMsg.includes('429') || errMsg.includes('quota')) {
          console.log(`    Gemini rate limited. Shifting to Groq fallback...`);
          break; // Exit Gemini loop to hit Groq block below
        }
        if (attempts >= 2) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (GROQ_API_KEY) {
    try {
      console.log('    Attempting Groq fallback (Llama-3.3-70B)...');
      // Llama-3.3-70b doesn't use the specialized reasoning_format params
      const gResult = await generateWithGroq(prompt, "llama-3.3-70b-versatile", 6000, "application/json"); 
      solverStats.groqRequests++;
      if (gResult.ok) {
        return extractJsonBlock(gResult.text);
      } else {
        console.log(`    Groq fallback failed: ${gResult.message || 'unknown error'}`);
      }
    } catch(e) {
      console.log('    Groq Workspace solver failed', e.message || e);
    }
  }

  return { reasoning: 'failed', fileMap: {} };
}
