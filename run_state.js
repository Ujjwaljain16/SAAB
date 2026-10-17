// run_state.js — crash-safe checkpoint of which classes/problems are already done.
import fs from 'fs';
import { canonicalProblemUrl } from './scaler_url.js';

function emptyState() {
  return { version: 1, completedClasses: [], completedProblems: [] };
}

/** Read the checkpoint file; a missing, empty or corrupt file yields an empty state instead of throwing. */
export function loadRunState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      version: 1,
      completedClasses: Array.isArray(parsed?.completedClasses) ? parsed.completedClasses.filter((c) => typeof c === 'string') : [],
      completedProblems: Array.isArray(parsed?.completedProblems) ? parsed.completedProblems.filter((p) => typeof p === 'string') : []
    };
  } catch {
    return emptyState();
  }
}

/** Atomically write the checkpoint (tmp file + rename) so a crash mid-write can't corrupt it. */
export function saveRunState(filePath, state) {
  try {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      completedClasses: state.completedClasses,
      completedProblems: state.completedProblems
    };
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.warn(`  [run-state] Could not save checkpoint: ${err.message}`);
    return false;
  }
}

export function makeRunState(filePath) {
  const stored = loadRunState(filePath);
  const completedProblems = new Set();
  for (const p of stored.completedProblems) {
    const canon = canonicalProblemUrl(p);
    if (canon) completedProblems.add(canon);
  }
  return {
    filePath,
    completedClasses: new Set(stored.completedClasses),
    completedProblems
  };
}

export function persistRunState(runState) {
  return saveRunState(runState.filePath, {
    completedClasses: Array.from(runState.completedClasses),
    completedProblems: Array.from(runState.completedProblems)
  });
}

export function markClassComplete(runState, classUrl) {
  runState.completedClasses.add(classUrl);
  persistRunState(runState);
}

export function markProblemComplete(runState, problemKey) {
  const canon = canonicalProblemUrl(problemKey);
  if (canon) {
    runState.completedProblems.add(canon);
    persistRunState(runState);
  }
}
