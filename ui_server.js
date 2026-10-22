import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { AnswerStore } from './answer_indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.UI_PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'ui')));

// Connected SSE clients for real-time log streaming
const sseClients = new Set();

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

let activeProcess = null;

// Ensure answers directory exists
const ANSWERS_DIR = path.join(__dirname, 'answers');
if (!fs.existsSync(ANSWERS_DIR)) {
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
}

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

  let answerFiles = [];
  if (fs.existsSync(ANSWERS_DIR)) {
    answerFiles = fs.readdirSync(ANSWERS_DIR).filter((f) => !f.startsWith('.'));
  }

  // Pre-configured BITS enrolled course list
  const enrolledCourses = [
    {
      id: 'modern-databases',
      name: 'Modern Databases',
      slug: 'modern-databases',
      currentQuiz: 'Graded Quiz for Week 4,5 and 6',
      url: 'https://www.coursera.org/learn/modern-databases/team/IAFhO/graded-quiz-for-week-4-5-and-6',
      status: runState['https://www.coursera.org/learn/modern-databases/team/IAFhO/graded-quiz-for-week-4-5-and-6']?.status || 'pending',
      grade: runState['https://www.coursera.org/learn/modern-databases/team/IAFhO/graded-quiz-for-week-4-5-and-6']?.grade ?? null
    },
    {
      id: 'network-programming',
      name: 'Network Programming and Client-Server Programming',
      slug: 'network-programming-client-server-programming',
      currentQuiz: 'Graded Quiz for Week 4,5 and 6',
      url: 'https://www.coursera.org/learn/network-programming-client-server-programming/team/RDBiY/graded-quiz-for-week-4-5-and-6',
      status: runState['https://www.coursera.org/learn/network-programming-client-server-programming/team/RDBiY/graded-quiz-for-week-4-5-and-6']?.status || 'pending',
      grade: runState['https://www.coursera.org/learn/network-programming-client-server-programming/team/RDBiY/graded-quiz-for-week-4-5-and-6']?.grade ?? null
    },
    {
      id: 'software-dev',
      name: 'Software Development Practices',
      slug: 'software-development-practices-bits',
      currentQuiz: 'Graded Quiz for Week 4,5 and 6',
      url: 'https://www.coursera.org/learn/software-development-practices-bits/team/R4a7I/graded-quiz-for-week-4-5-and-6',
      status: 'pass',
      grade: 100
    }
  ];

  res.json({
    isRunning: Boolean(activeProcess),
    courses: enrolledCourses,
    runState,
    answerFilesCount: answerFiles.length,
    answerFiles
  });
});

// 2. Get detailed parsed questions from the AnswerStore
app.get('/api/answers', async (req, res) => {
  try {
    const store = new AnswerStore();
    await store.loadDirectory(ANSWERS_DIR);
    res.json({
      totalQuestions: store.entries.length,
      entries: store.entries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Upload answer key file (PDF, JSON, TXT, MD) via binary stream with ?filename=...
app.post('/api/upload', (req, res) => {
  const rawFileName = req.query.filename || `answers_${Date.now()}.txt`;
  // Sanitize filename to prevent directory traversal
  const safeFileName = path.basename(rawFileName).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const targetPath = path.join(ANSWERS_DIR, safeFileName);

  const writeStream = fs.createWriteStream(targetPath);

  req.pipe(writeStream);

  writeStream.on('finish', async () => {
    try {
      const store = new AnswerStore();
      await store.loadFile(targetPath);
      broadcastEvent('answer_uploaded', {
        filename: safeFileName,
        questionsCount: store.entries.length
      });
      res.json({
        success: true,
        filename: safeFileName,
        questionsParsed: store.entries.length,
        entries: store.entries
      });
    } catch (err) {
      res.status(500).json({ error: `Saved file, but parsing failed: ${err.message}` });
    }
  });

  writeStream.on('error', (err) => {
    res.status(500).json({ error: `File write failed: ${err.message}` });
  });
});

// 4. Trigger auto-solver execution
app.post('/api/run', (req, res) => {
  if (activeProcess) {
    return res.status(409).json({ error: 'A run is already in progress. Stop it first or wait for completion.' });
  }

  const { mode = 'submit', course = '', limit = 0, answersPath = '' } = req.body || {};

  const args = ['main.js', '--bits'];
  if (mode === 'submit') args.push('--submit');
  else args.push('--dry-run');

  if (course) args.push(`--course=${course}`);
  if (limit > 0) args.push(`--limit=${limit}`);
  if (answersPath) args.push(`--answers=${answersPath}`);

  broadcastEvent('run_start', { mode, course, limit, args });

  activeProcess = spawn('node', args, {
    cwd: __dirname,
    shell: true,
    windowsHide: false,
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  activeProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    broadcastEvent('log', { stream: 'stdout', text });

    // Parse ReAct events from logs
    if (text.includes('ReAct Self-Correction')) {
      broadcastEvent('react_step', { type: 'self_correct', line: text.trim() });
    } else if (text.includes('VERIFIED KEY')) {
      broadcastEvent('react_step', { type: 'ground_truth', line: text.trim() });
    } else if (text.includes('Pre-submission audit passed')) {
      broadcastEvent('react_step', { type: 'audit_pass', line: text.trim() });
    }
  });

  activeProcess.stderr.on('data', (chunk) => {
    broadcastEvent('log', { stream: 'stderr', text: chunk.toString() });
  });

  activeProcess.on('close', (code) => {
    broadcastEvent('run_end', { code });
    activeProcess = null;
  });

  res.json({ success: true, message: 'Auto-solver initiated.', args });
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

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Fallback HTML route
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'index.html'));
});

// Start Server
server.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 Mission Control Dashboard is live!`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`============================================================\n`);
});
