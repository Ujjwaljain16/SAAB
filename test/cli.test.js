// What a first-time user sees. Runs the real main.js with an empty environment (dotenv never overrides variables that are
// already set, so the developer's own .env cannot leak in and hide a problem).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLANK_KEYS = { GEMINI_API_KEY: '', GEMINI_API_KEYS: '', GROQ_API_KEY: '', GROK_API_KEY: '', XAI_API_KEY: '' };

function run(args, env = {}, timeout = 60000) {
  const res = spawnSync(process.execPath, ['main.js', ...args], {
    cwd: repo,
    env: { ...process.env, ...BLANK_KEYS, SAAB_PROFILE_DIR: path.join(repo, 'definitely-not-a-profile-dir'), ...env },
    encoding: 'utf-8',
    timeout
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

test('no API key: a plain instruction, not a stack trace, and a non-zero exit', () => {
  const { code, out } = run(['--dry-run']);
  assert.equal(code, 1);
  assert.match(out, /No AI provider API key found/);
  assert.match(out, /\.env/, 'tells the user which file to create');
  assert.match(out, /GEMINI_API_KEY/);
  assert.ok(!/\bat assertProviderConfigured\b|node:internal/.test(out), `a stack trace leaked:\n${out}`);
});

test('keys set but never logged in: tells the user to run npm run auth', () => {
  const { code, out } = run(['--dry-run'], { GEMINI_API_KEY: 'placeholder' });
  assert.equal(code, 1);
  assert.match(out, /npm run auth/);
});

test('a mistyped argument is refused (exit 2) instead of silently running everything live', () => {
  const { code, out } = run([':mcq'], { GEMINI_API_KEY: 'placeholder' }, 30000);
  assert.equal(code, 2);
  assert.match(out, /Unknown argument\(s\): :mcq/);
  assert.match(out, /npm run start:mcq/);
});

test('live mode shows a clear warning banner before doing anything; a dry run does not', () => {
  const live = run([], { GEMINI_API_KEY: 'placeholder' }, 60000);
  assert.match(live.out, /LIVE MODE: SAAB will SUBMIT answers/);
  assert.match(live.out, /dry-run:mcq/, 'points at the safe way to start');

  const dry = run(['--dry-run'], { GEMINI_API_KEY: 'placeholder' });
  assert.ok(!/LIVE MODE/.test(dry.out));
});
