import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { answerStore } from './answer_indexer.js';
import { getProviderTelemetry } from './solver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.UI_PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'ui')));

// Connected SSE clients for real-time log streaming
const sseClients = new Set();
const LOG_BUFFER_MAX = 300;
const logBuffer = [];
const reactStepsBuffer = [];

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function recordLog(stream, text) {
  logBuffer.push({ stream, text, time: Date.now() });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  broadcastEvent('log', { stream, text });
}

function recordReactStep(data) {
  reactStepsBuffer.push(data);
  if (reactStepsBuffer.length > 50) reactStepsBuffer.shift();
  broadcastEvent('react_step', data);
}

let activeProcess = null;

// Ensure answers directory exists
const ANSWERS_DIR = path.join(__dirname, 'answers');
if (!fs.existsSync(ANSWERS_DIR)) {
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
}

// In-memory AnswerStore cache management
let answersInitPromise = null;
function ensureAnswerStoreLoaded(forceReload = false) {
  if (forceReload || !answersInitPromise) {
    answersInitPromise = (async () => {
      if (forceReload) {
        answerStore.entries = [];
      }
      await answerStore.loadDirectory(ANSWERS_DIR);
    })().catch((err) => {
      console.error(`[Answer Store] Directory load failed: ${err.message}`);
    });
  }
  return answersInitPromise;
}

// Pre-warm the answer store in the background on boot
ensureAnswerStoreLoaded();

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

// 1. Get system status, courses, passed quizzes, and current runner state
app.get('/api/status', (req, res) => {
  let runState = {};
  const runStatePath = path.join(__dirname, 'bits-run-state.json');
  if (fs.existsSync(runStatePath)) {
    try {
      runState = JSON.parse(fs.readFileSync(runStatePath, 'utf8'));
    } catch {
      runState = {};
    }
  }

  let runLog = [];
  const runLogPath = path.join(__dirname, 'bits-run-log.json');
  if (fs.existsSync(runLogPath)) {
    try {
      runLog = JSON.parse(fs.readFileSync(runLogPath, 'utf8'));
    } catch {
      runLog = [];
    }
  }

  let liveCache = null;
  const cachePath = path.join(__dirname, 'curriculum-cache-bits.json');
  if (fs.existsSync(cachePath)) {
    try {
      liveCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      liveCache = null;
    }
  }

  let answerFiles = [];
  if (fs.existsSync(ANSWERS_DIR)) {
    answerFiles = fs.readdirSync(ANSWERS_DIR).filter((f) => !f.startsWith('.'));
  }

  // Known standard course metadata dictionary for clean display titles
  const KNOWN_COURSE_NAMES = {
    'modern-databases': 'Modern Databases',
    'network-programming-client-server-programming': 'Network Programming and Client-Server Programming',
    'network-programming': 'Network Programming and Client-Server Programming',
    'software-development-practices-bits': 'Software Development Practices',
    'software-development-practices': 'Software Development Practices'
  };

  // Helper to format course name from slug
  const formatCourseName = (slug) => {
    if (KNOWN_COURSE_NAMES[slug]) return KNOWN_COURSE_NAMES[slug];
    const matchingKey = Object.keys(KNOWN_COURSE_NAMES).find((k) => slug.includes(k) || k.includes(slug));
    if (matchingKey) return KNOWN_COURSE_NAMES[matchingKey];
    return slug
      .replace(/-bits$/i, '')
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  // Helper to parse a human-readable quiz title from URL
  const formatQuizTitle = (url) => {
    if (!url) return 'Graded Quiz';
    const match = url.match(/(graded-quiz-for-[^/?#]+)/i) || url.match(/\/team\/[^/]+\/([^/?#]+)/i);
    if (match) {
      return match[1]
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    return 'Graded Assessment';
  };

  // Extract all distinct course slugs from live cache, runState, and runLog
  const courseSlugSet = new Set();

  if (liveCache && Array.isArray(liveCache.courses)) {
    liveCache.courses.forEach((c) => {
      if (c.slug) courseSlugSet.add(c.slug);
    });
  }

  Object.keys(runState).forEach((url) => {
    const m = url.match(/\/learn\/([^/?#]+)/);
    if (m) courseSlugSet.add(m[1]);
  });

  runLog.forEach((item) => {
    if (item.url) {
      const m = item.url.match(/\/learn\/([^/?#]+)/);
      if (m) courseSlugSet.add(m[1]);
    }
  });

  // Ensure primary default enrolled BITS degree courses are present
  if (courseSlugSet.size === 0) {
    courseSlugSet.add('modern-databases');
    courseSlugSet.add('network-programming-client-server-programming');
    courseSlugSet.add('software-development-practices-bits');
  }

  // Build real live course cards
  const enrolledCourses = [];

  for (const slug of courseSlugSet) {
    // Find all runState entries for this course
    const courseEntries = Object.entries(runState).filter(([url]) => url.includes(slug));

    // Sort by latest solved or highest week
    courseEntries.sort(([urlA, dataA], [urlB, dataB]) => {
      // Prioritize week number
      const getWeek = (u) => {
        const m = u.match(/week-?(\d+)/i);
        return m ? parseInt(m[1], 10) : 0;
      };
      const wDiff = getWeek(urlB) - getWeek(urlA);
      if (wDiff !== 0) return wDiff;
      const tA = dataA.solvedAt ? new Date(dataA.solvedAt).getTime() : 0;
      const tB = dataB.solvedAt ? new Date(dataB.solvedAt).getTime() : 0;
      return tB - tA;
    });

    const latestSolved = courseEntries[0];
    let courseName = formatCourseName(slug);
    if (liveCache && Array.isArray(liveCache.courses)) {
      const cObj = liveCache.courses.find((c) => c.slug === slug);
      if (cObj && cObj.name) courseName = cObj.name;
    }

    let currentQuiz = 'Graded Assessment';
    let quizUrl = '';
    let status = 'pending';
    let grade = null;
    let questionsSolved = null;

    if (latestSolved) {
      quizUrl = latestSolved[0];
      status = latestSolved[1].status || 'pass';
      grade = latestSolved[1].grade !== undefined ? latestSolved[1].grade : 100;
      questionsSolved = latestSolved[1].questionsSolved || 10;
      currentQuiz = formatQuizTitle(quizUrl);
    } else {
      // Check live cache deadlines for pending assignments
      if (liveCache && Array.isArray(liveCache.deadlines)) {
        const dObj = liveCache.deadlines.find((d) => d.url && d.url.includes(slug));
        if (dObj) {
          currentQuiz = dObj.title || 'Upcoming Graded Assessment';
          quizUrl = dObj.url || '';
          status = dObj.status || 'pending';
          grade = dObj.grade || null;
        }
      }
    }

    enrolledCourses.push({
      id: slug,
      name: courseName,
      slug,
      currentQuiz,
      url: quizUrl,
      status,
      grade,
      questionsSolved,
      totalQuizzesAttempted: courseEntries.length
    });
  }

  // Order courses logically
  enrolledCourses.sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    isRunning: Boolean(activeProcess),
    courses: enrolledCourses,
    runState,
    liveCache: liveCache ? { syncedAt: liveCache.syncedAt, count: liveCache.courses?.length } : null,
    answerFilesCount: answerFiles.length,
    answerFiles
  });
});

// 1.1 Trigger live sync from authenticated Coursera degree account
app.post('/api/sync-courses', async (req, res) => {
  try {
    broadcastEvent('log', { stream: 'stdout', text: '[Degree Sync] Initiating real-time scan of Coursera Degree Dashboard...\n' });
    const { syncLiveDegreeStatus } = await import('./sync_degree_status.js');
    const syncResult = await syncLiveDegreeStatus({ headless: true });
    broadcastEvent('log', { stream: 'stdout', text: `[Degree Sync] ✓ Successfully refreshed ${syncResult.courses.length} enrolled courses and ${syncResult.deadlines.length} deadlines.\n` });
    res.json({ success: true, ...syncResult });
  } catch (err) {
    broadcastEvent('log', { stream: 'stderr', text: `[Degree Sync] Sync failed: ${err.message}\n` });
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
});

// 1.2 Interactive Google SSO Authenticator for Coursera / BITS Pilani
app.post('/api/auth/bits', async (req, res) => {
  try {
    broadcastEvent('log', { stream: 'stdout', text: '[BITS Auth] Opening visible Chrome browser for Coursera / BITS Google login...\n' });
    const { loginBits } = await import('./bits_auth.js');
    // Run in background so request returns immediately and user can complete login in Chrome
    loginBits()
      .then(() => {
        broadcastEvent('log', { stream: 'stdout', text: '[BITS Auth] ✓ Coursera login completed and session saved!\n' });
      })
      .catch((err) => {
        broadcastEvent('log', { stream: 'stderr', text: `[BITS Auth] Login error: ${err.message}\n` });
      });
    res.json({ success: true, message: 'Chrome window opened for Coursera login. Please sign in and close when finished.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.3 Interactive Authenticator for Scaler
app.post('/api/auth/scaler', async (req, res) => {
  try {
    broadcastEvent('log', { stream: 'stdout', text: '[Scaler Auth] Opening visible Chrome browser for Scaler login...\n' });
    const { login } = await import('./auth.js');
    login()
      .then(() => {
        broadcastEvent('log', { stream: 'stdout', text: '[Scaler Auth] ✓ Scaler login completed and session saved!\n' });
      })
      .catch((err) => {
        broadcastEvent('log', { stream: 'stderr', text: `[Scaler Auth] Login error: ${err.message}\n` });
      });
    res.json({ success: true, message: 'Chrome window opened for Scaler login. Please sign in and close when finished.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get detailed parsed questions from the AnswerStore (cached in-memory)
app.get('/api/answers', async (req, res) => {
  try {
    if (req.query.reload === 'true') {
      await ensureAnswerStoreLoaded(true);
    } else {
      await ensureAnswerStoreLoaded(false);
    }
    res.json({
      totalQuestions: answerStore.entries.length,
      entries: answerStore.entries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Upload answer key file (PDF, JSON, TXT, MD) via binary stream with ?filename=...
app.post('/api/upload', (req, res) => {
  const rawFileName = req.query.filename || `answers_${Date.now()}.txt`;
  // Sanitize filename to prevent directory traversal
  const safeFileName = path.basename(rawFileName).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const targetPath = path.join(ANSWERS_DIR, safeFileName);

  const writeStream = fs.createWriteStream(targetPath);

  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    try {
      await ensureAnswerStoreLoaded(false);
      await answerStore.loadFile(targetPath);
      const fileEntries = answerStore.entries.filter((e) => e.source === safeFileName);
      broadcastEvent('answer_uploaded', {
        filename: safeFileName,
        questionsCount: fileEntries.length,
        totalQuestions: answerStore.entries.length
      });
      res.json({
        success: true,
        filename: safeFileName,
        questionsParsed: fileEntries.length,
        entries: fileEntries
      });
    } catch (err) {
      res.status(500).json({ error: `Saved file, but parsing failed: ${err.message}` });
    }
  });

  writeStream.on('error', (err) => {
    res.status(500).json({ error: `File write failed: ${err.message}` });
  });
});

// Helper to update .env on disk safely
function updateEnvFile(updates) {
  const envPath = path.join(__dirname, '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else if (fs.existsSync(path.join(__dirname, '.env.example'))) {
    content = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  }

  let lines = content.split('\n');
  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || val === null || val === '') continue;
    let found = false;
    lines = lines.map((line) => {
      if (line.trim().startsWith(`${key}=`)) {
        found = true;
        return `${key}=${val}`;
      }
      return line;
    });
    if (!found) {
      lines.push(`${key}=${val}`);
    }
    process.env[key] = val;
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

// 4. Get current user settings (masked credentials)
app.get('/api/settings', (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const maskedKey = geminiKey ? `${geminiKey.slice(0, 6)}...${geminiKey.slice(-4)}` : '';

  res.json({
    hasGeminiKey: Boolean(geminiKey),
    geminiKeyMasked: maskedKey,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    bitsEmail: process.env.BITS_EMAIL || '',
    hasBitsPass: Boolean(process.env.BITS_PASS),
    scalerEmail: process.env.SCALER_EMAIL || '',
    hasScalerPass: Boolean(process.env.SCALER_PASS)
  });
});

// 5. Update user credentials & API keys
app.post('/api/settings', (req, res) => {
  try {
    const { geminiApiKey, geminiModel, bitsEmail, bitsPassword, scalerEmail, scalerPassword } = req.body || {};
    const updates = {};

    if (geminiApiKey) {
      updates.GEMINI_API_KEYS = geminiApiKey.trim();
      updates.GEMINI_API_KEY = geminiApiKey.trim();
    }
    if (geminiModel) updates.GEMINI_MODEL = geminiModel.trim();
    if (bitsEmail) updates.BITS_EMAIL = bitsEmail.trim();
    if (bitsPassword) updates.BITS_PASS = bitsPassword.trim();
    if (scalerEmail) updates.SCALER_EMAIL = scalerEmail.trim();
    if (scalerPassword) updates.SCALER_PASS = scalerPassword.trim();

    updateEnvFile(updates);
    res.json({ success: true, message: 'Settings saved to local environment successfully.' });
  } catch (err) {
    res.status(500).json({ error: `Failed to save settings: ${err.message}` });
  }
});

// 6. Test Gemini API Key connectivity
app.post('/api/test-key', async (req, res) => {
  const apiKey = (req.body?.apiKey || process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').trim();
  const modelName = (req.body?.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();

  if (!apiKey) {
    return res.status(400).json({ success: false, message: 'API key is required to test connectivity.' });
  }

  const modelsToTry = Array.from(new Set([modelName, 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen']));
  let lastError = null;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const firstKey = apiKey.split(',')[0].trim();
    const genAI = new GoogleGenerativeAI(firstKey);

    for (const m of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({ model: m });
        await model.generateContent('Ping');
        const fallbackNote = m !== modelName ? ` (tested via fallback ${m} as ${modelName} was experiencing high demand)` : '';
        return res.json({ success: true, message: `Connected successfully to Google Gemini (${m})!${fallbackNote}` });
      } catch (mErr) {
        lastError = mErr;
        // Continue to fallback if high demand / overloaded
        if (mErr.message?.toLowerCase().includes('demand') || mErr.message?.includes('503') || mErr.message?.includes('429')) {
          continue;
        }
        break;
      }
    }
    res.json({ success: false, message: `Connection failed: ${lastError?.message || 'Could not reach Gemini.'}` });
  } catch (err) {
    res.json({ success: false, message: `Connection failed: ${err.message}` });
  }
});

// 7. Trigger auto-solver execution (BITS Coursera or Scaler Academy)
app.post('/api/run', (req, res) => {
  if (activeProcess) {
    return res.status(409).json({ error: 'A run is already in progress. Stop it first or wait for completion.' });
  }

  const {
    platform = 'bits',
    mode = 'submit',
    course = '',
    limit = 0,
    answersPath = '',
    scalerScope = 'all',
    scalerClass = '',
    scalerSubject = '',
    apiKey = ''
  } = req.body || {};

  const args = ['main.js'];

  if (platform === 'bits') {
    args.push('--bits');
    if (mode === 'submit') args.push('--submit');
    else args.push('--dry-run');

    if (course) args.push(`--course=${course}`);
    if (limit > 0) args.push(`--limit=${limit}`);
    if (answersPath) args.push(`--answers=${answersPath}`);
  } else {
    // Scaler Academy
    if (mode === 'submit') args.push('--submit');
    else args.push('--dry-run');

    if (scalerScope === 'only-mcq') args.push('--only-mcq');
    else if (scalerScope === 'only-labs') args.push('--only-labs');
    else if (scalerScope === 'skip-labs') args.push('--skip-labs');

    if (scalerClass) args.push(`--class=${scalerClass}`);
    if (scalerSubject) args.push(`--subject=${scalerSubject}`);
  }

  logBuffer.length = 0;
  reactStepsBuffer.length = 0;
  broadcastEvent('run_start', { platform, mode, course, limit, args });

  const procEnv = { ...process.env, FORCE_COLOR: '1' };
  if (apiKey) {
    procEnv.GEMINI_API_KEYS = apiKey.trim();
    procEnv.GEMINI_API_KEY = apiKey.trim();
  }

  activeProcess = spawn('node', args, {
    cwd: __dirname,
    shell: true,
    windowsHide: false,
    env: procEnv
  });

  activeProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    recordLog('stdout', text);

    // Parse ReAct events from logs
    if (text.includes('ReAct Self-Correction') || text.includes('ReAct Retry Sweep') || text.includes('Global ReAct Sweep')) {
      recordReactStep({ type: 'self_correct', line: text.trim() });
    } else if (text.includes('VERIFIED KEY')) {
      recordReactStep({ type: 'ground_truth', line: text.trim() });
    } else if (text.includes('Pre-submission audit passed')) {
      recordReactStep({ type: 'audit_pass', line: text.trim() });
    }
  });

  activeProcess.stderr.on('data', (chunk) => {
    recordLog('stderr', chunk.toString());
  });

  activeProcess.on('close', (code) => {
    broadcastEvent('run_end', { code });
    activeProcess = null;
  });

  res.json({ success: true, message: 'Academic assistant task initiated.', args });
});

// 5. Terminate running process
app.post('/api/stop', (req, res) => {
  if (!activeProcess) {
    return res.json({ message: 'No active process is running.' });
  }

  try {
    // Windows tree kill
    spawn('taskkill', ['/pid', activeProcess.pid.toString(), '/f', '/t']);
    activeProcess = null;
    broadcastEvent('run_end', { code: -1, killed: true });
    res.json({ success: true, message: 'Process stopped.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. SSE Stream Endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send initial ping
  res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

  // Send initial telemetry snapshot
  try {
    res.write(`event: telemetry\ndata: ${JSON.stringify(getProviderTelemetry())}\n\n`);
  } catch {}

  // Replay buffered logs so refreshing the browser tab mid-flight restores complete terminal history!
  for (const item of logBuffer) {
    res.write(`event: log\ndata: ${JSON.stringify(item)}\n\n`);
  }

  // Replay buffered ReAct steps
  for (const step of reactStepsBuffer) {
    res.write(`event: react_step\ndata: ${JSON.stringify(step)}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// 7. System & AI Telemetry
app.get('/api/telemetry', (req, res) => {
  try {
    res.json({ ok: true, telemetry: getProviderTelemetry() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 8. Run History Listing
app.get('/api/runs', (req, res) => {
  try {
    const runsDir = path.join(__dirname, 'runs');
    if (!fs.existsSync(runsDir)) {
      return res.json({ ok: true, runs: [] });
    }
    const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'));
    const runs = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(runsDir, f), 'utf8');
        const parsed = JSON.parse(content);
        runs.push({
          runId: parsed.runId || f.replace('.json', ''),
          startedAt: parsed.startedAt || null,
          finishedAt: parsed.finishedAt || null,
          mode: parsed.mode || 'dry-run',
          metrics: parsed.metrics || {},
          entryCount: Array.isArray(parsed.entries) ? parsed.entries.length : 0
        });
      } catch {}
    }
    runs.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
    res.json({ ok: true, runs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 9. Run Record Detail & Replay Inspector
app.get('/api/runs/:runId', (req, res) => {
  const { runId } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    return res.status(400).json({ ok: false, error: 'Invalid runId format' });
  }
  const filePath = path.join(__dirname, 'runs', `${runId}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'Run record not found' });
  }
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({ ok: true, run: record });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 10. Live Viewport Screenshot Stream
app.get('/api/screenshot/latest', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const debugDir = path.join(__dirname, 'debug');
  const latestPath = path.join(debugDir, 'latest.png');

  if (fs.existsSync(latestPath)) {
    res.setHeader('Content-Type', 'image/png');
    return fs.createReadStream(latestPath).pipe(res);
  }

  if (fs.existsSync(debugDir)) {
    const pngs = fs.readdirSync(debugDir).filter((f) => f.endsWith('.png')).map((f) => ({
      name: f,
      time: fs.statSync(path.join(debugDir, f)).mtimeMs
    })).sort((a, b) => b.time - a.time);

    if (pngs.length > 0) {
      res.setHeader('Content-Type', 'image/png');
      return fs.createReadStream(path.join(debugDir, pngs[0].name)).pipe(res);
    }
  }

  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
    <rect width="800" height="450" fill="#0f172a" rx="8"/>
    <rect x="20" y="20" width="760" height="410" fill="none" stroke="#1e293b" stroke-width="2" stroke-dasharray="6,6" rx="6"/>
    <circle cx="400" cy="200" r="32" fill="#1e293b"/>
    <polygon points="392,188 414,200 392,212" fill="#64748b"/>
    <text x="50%" y="260" text-anchor="middle" fill="#94a3b8" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="16" font-weight="600">Headless Browser Stream Idle</text>
    <text x="50%" y="285" text-anchor="middle" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="13">Live Playwright viewports will mirror here when automation starts</text>
  </svg>`);
});

// Periodic SSE Telemetry and Screenshot Dispatcher
let lastScreenshotMtime = 0;
setInterval(() => {
  if (sseClients.size === 0) return;
  try {
    broadcastEvent('telemetry', getProviderTelemetry());
  } catch {}

  const latestPng = path.join(__dirname, 'debug', 'latest.png');
  if (fs.existsSync(latestPng)) {
    try {
      const mtime = fs.statSync(latestPng).mtimeMs;
      if (mtime > lastScreenshotMtime) {
        lastScreenshotMtime = mtime;
        broadcastEvent('screenshot', { timestamp: mtime, url: `/api/screenshot/latest?t=${mtime}` });
      }
    } catch {}
  }
}, 3000);

// Fallback HTML route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'index.html'));
});

// Start Server with automatic port fallback if port is already occupied
function startServer(portToUse, remainingAttempts = 5) {
  server.listen(portToUse, () => {
    console.log(`\n============================================================`);
    console.log(`🚀 Mission Control Dashboard is live!`);
    console.log(`📡 URL: http://localhost:${portToUse}`);
    console.log(`============================================================\n`);
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.UI_PORT && remainingAttempts > 0) {
      const nextPort = Number(portToUse) + 1;
      console.warn(`⚠️ Port ${portToUse} is already in use. Retrying on port ${nextPort}...`);
      startServer(nextPort, remainingAttempts - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${portToUse} is already in use by another running instance of Mission Control.`);
      console.error(`👉 You can directly open the existing dashboard at: http://localhost:${portToUse}`);
      console.error(`💡 To kill the lingering process and restart, run in PowerShell:`);
      console.error(`   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${portToUse}).OwningProcess -Force\n`);
      process.exit(1);
    } else {
      console.error(`Server error:`, err);
      process.exit(1);
    }
  });
}

startServer(PORT);
