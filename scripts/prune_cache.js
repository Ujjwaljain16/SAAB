#!/usr/bin/env node
/**
 * scripts/prune_cache.js
 * Maintenance utility to prune stale, corrupt, or legacy solver-cache entries.
 * 
 * Usage:
 *   node scripts/prune_cache.js          # Prune corrupt or stale entries (> 30 days old)
 *   node scripts/prune_cache.js --all    # Clear entire cache
 *   node scripts/prune_cache.js --days=7 # Prune entries older than 7 days
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export function pruneCache(options = {}) {
  const clearAll = options.all ?? process.argv.includes('--all');
  const daysArg = process.argv.find(a => a.startsWith('--days='))?.split('=')[1];
  const maxDays = options.maxDays ?? (daysArg ? parseInt(daysArg, 10) : 30);
  const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Check possible cache locations: dataPath('.solver-cache') or cwd/.solver-cache
  const candidateDirs = [
    process.env.SAAB_DATA_DIR ? path.join(process.env.SAAB_DATA_DIR, '.solver-cache') : null,
    path.join(process.cwd(), '.solver-cache')
  ].filter(Boolean);

  let totalScanned = 0;
  let totalPruned = 0;
  let bytesFreed = 0;

  for (const cacheDir of candidateDirs) {
    if (!fs.existsSync(cacheDir)) continue;

    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      totalScanned++;
      const fullPath = path.join(cacheDir, file);

      try {
        const stats = fs.statSync(fullPath);

        if (clearAll) {
          bytesFreed += stats.size;
          fs.rmSync(fullPath, { force: true });
          totalPruned++;
          continue;
        }

        // Check if unparseable / corrupt
        let data = null;
        try {
          data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        } catch {
          // Corrupt JSON
          bytesFreed += stats.size;
          fs.rmSync(fullPath, { force: true });
          totalPruned++;
          continue;
        }

        // Check schema validity: must have code, bestOptionIndex, commands, or indices
        const hasValidPayload =
          (typeof data?.code === 'string' && data.code.length > 0) ||
          (typeof data?.bestOptionIndex === 'number') ||
          (Array.isArray(data?.commands) && data.commands.length > 0) ||
          (Array.isArray(data?.indices));

        if (!hasValidPayload) {
          bytesFreed += stats.size;
          fs.rmSync(fullPath, { force: true });
          totalPruned++;
          continue;
        }

        // Check age expiration
        const fileAge = now - stats.mtimeMs;
        if (fileAge > maxAgeMs) {
          bytesFreed += stats.size;
          fs.rmSync(fullPath, { force: true });
          totalPruned++;
          continue;
        }
      } catch (err) {
        console.warn(`[Cache Prune] Error processing ${file}: ${err.message}`);
      }
    }
  }

  const kbFreed = Math.round(bytesFreed / 1024);
  console.log(`[Cache Prune] Complete. Scanned: ${totalScanned}, Pruned: ${totalPruned}, Freed: ${kbFreed} KB.`);
  return { scanned: totalScanned, pruned: totalPruned, bytesFreed };
}

if (isDirectRun) {
  pruneCache();
}
