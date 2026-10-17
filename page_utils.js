// page_utils.js — small Playwright helpers shared by the Scaler handlers.
import fs from 'fs';
import path from 'path';
import { SEL } from './config.js';
import { dataPath, envNumber } from './paths.js';

const SNAPSHOT_DIR = dataPath('debug');
const MAX_SNAPSHOTS_PER_RUN = Math.max(0, envNumber('MAX_SNAPSHOTS', 30));
let snapshotCount = 0;

/** Remove Scaler's floating SolveBot/companion widgets so they can't intercept clicks. */
export async function purgeBotWidgets(page) {
  await page.evaluate((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  }, SEL.botWidgets).catch(() => {});
}

function safeLabel(label) {
  return String(label || 'snapshot').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'snapshot';
}

/**
 * Save a screenshot + HTML + URL when something unexpected happens, so a Scaler layout change can be
 * diagnosed from files instead of by re-running. Never throws, capped per run (MAX_SNAPSHOTS, 0 disables).
 * The files can contain page content from your account: `debug/` is gitignored, don't share it blindly.
 * @returns {Promise<string|null>} the file prefix written, or null.
 */
export async function snapshotPage(page, label, note = '') {
  if (snapshotCount >= MAX_SNAPSHOTS_PER_RUN || !page || page.isClosed?.()) return null;
  snapshotCount += 1;

  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = path.join(SNAPSHOT_DIR, `${stamp}-${safeLabel(label)}`);

    await page.screenshot({ path: `${prefix}.png`, fullPage: false, timeout: 5000 }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync(`${prefix}.html`, html);
    fs.writeFileSync(`${prefix}.txt`, `${page.url()}\n${note}\n`);
    console.log(`  [debug] Snapshot saved: ${path.relative(process.cwd(), prefix)}.*`);
    return prefix;
  } catch {
    return null;
  }
}
