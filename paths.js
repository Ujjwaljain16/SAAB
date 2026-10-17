// paths.js — where SAAB keeps its mutable files (caches, checkpoints, logs, debug snapshots).
// Defaults to the current directory; set SAAB_DATA_DIR to relocate everything (the test-suite does this
// so tests can never touch your real caches or run-state).
import path from 'path';

export const DATA_DIR = process.env.SAAB_DATA_DIR ? path.resolve(process.env.SAAB_DATA_DIR) : process.cwd();

export function dataPath(...segments) {
  return path.join(DATA_DIR, ...segments);
}

/** Read a numeric env var; unlike `Number(x) || default` this honours an explicit 0. */
export function envNumber(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
