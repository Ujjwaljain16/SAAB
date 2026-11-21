/**
 * workspace_manager.js
 * Hardened implementation: extracts Monaco editor files from VS Code IDE problems
 * (works on both main page and iframes — handles the VS Code web embed pattern)
 * 
 * Reliability guarantees:
 * - Strict timeout envelopes on every operation so the shared workspaceMutex is never held indefinitely
 * - Guard against closed page or detached frames
 * - Multi-tier fallbacks: Monaco API → DOM view-lines → Editor Textarea → Clipboard
 */

/**
 * Executes a promise with an explicit timeout.
 * Rejects with a descriptive Error if the timeout fires before resolution.
 */
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[Workspace] Timeout after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns all page frames including the main page as a "frame-like" object.
 * Returns empty array if page is closed.
 */
function getSearchTargets(page) {
  if (!page || page.isClosed()) return [];
  try {
    return [page, ...page.frames().filter(f => !f.isDetached())];
  } catch {
    return [];
  }
}

/**
 * Wait for Monaco IDE to become ready in any frame.
 * Upper-bounded to prevent indefinite blocking of parallel workers.
 */
export async function waitForWorkspaceReady(page, timeoutMs = 45000) {
  if (!page || page.isClosed()) {
    console.warn('[Workspace] Cannot wait for IDE: page is closed.');
    return;
  }

  console.log('[Workspace] Waiting for VS Code / Monaco IDE to initialize...');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      console.warn('[Workspace] Page closed while waiting for Monaco IDE.');
      return;
    }

    const targets = getSearchTargets(page);
    for (const target of targets) {
      try {
        const ready = await target.evaluate(() => {
          const models = window.monaco?.editor?.getModels?.();
          return Array.isArray(models) && models.length > 0;
        }).catch(() => false);

        if (ready) {
          const loc = target === page ? 'main page' : (target.url?.() || '').slice(0, 60);
          console.log(`[Workspace] ✓ Monaco IDE ready (${loc}).`);
          return;
        }
      } catch {}
    }

    // Check for VS Code loading spinner
    const stillLoading = await page.evaluate(() =>
      !!document.querySelector('.monaco-loading, .loading-container, [class*="Loading"]')
    ).catch(() => false);

    const pauseMs = stillLoading ? 2000 : 1200;
    await page.waitForTimeout(pauseMs).catch(() => {});
  }

  console.warn(`[Workspace] Warning: Monaco IDE not detected within ${timeoutMs}ms — proceeding with fallback extraction.`);
}

/**
 * Internal worker for slurping files.
 */
async function _slurpWorkspaceContext(page) {
  if (!page || page.isClosed()) return {};

  console.log('[Workspace] Extracting workspace files from Monaco editor...');

  for (const target of getSearchTargets(page)) {
    try {
      const files = await target.evaluate(() => {
        if (!window.monaco?.editor?.getModels) return null;
        const models = window.monaco.editor.getModels();
        if (!models || models.length === 0) return null;

        const result = {};
        for (const model of models) {
          const uriStr = model.uri?.path || model.uri?.toString?.() || '';
          const parts = uriStr.split('/');
          const filename = parts.filter(Boolean).pop() || `file_${Object.keys(result).length + 1}`;
          const content = model.getValue?.() || '';
          if (content.trim()) {
            result[filename] = content;
          }
        }
        return Object.keys(result).length > 0 ? result : null;
      }).catch(() => null);

      if (files) {
        const names = Object.keys(files);
        console.log(`[Workspace] ✓ Extracted ${names.length} file(s) via Monaco API: ${names.join(', ')}`);
        return files;
      }
    } catch {}
  }

  // Fallback 1: Read visible view-lines from DOM
  console.log('[Workspace] Monaco API unavailable — falling back to DOM view-line extraction...');
  for (const target of getSearchTargets(page)) {
    try {
      const text = await target.evaluate(() => {
        const lines = document.querySelectorAll('.view-line');
        if (lines.length < 3) return '';
        return Array.from(lines).map(l => l.innerText || l.textContent || '').join('\n');
      }).catch(() => '');

      if (text.trim().length > 50) {
        const title = await page.title().catch(() => 'Solution');
        const guessedLang = /javascript|js/i.test(title) ? 'Solution.js' : 'Solution.java';
        console.log(`[Workspace] DOM fallback extracted ~${text.length} chars as ${guessedLang}`);
        return { [guessedLang]: text };
      }
    } catch {}
  }

  // Fallback 2: Read from Monaco textarea input value
  for (const target of getSearchTargets(page)) {
    try {
      const text = await target.locator('.monaco-editor textarea').first().inputValue().catch(() => '');
      if (text.trim().length > 50) {
        console.log('[Workspace] Textarea fallback extracted editor content.');
        return { 'Solution.java': text };
      }
    } catch {}
  }

  console.log('[Workspace] ✗ Could not extract workspace content from any source.');
  return {};
}

/**
 * Extract all source files from the Monaco editor (any frame) with timeout envelope.
 * Returns { filename: content, ... }
 */
export async function slurpWorkspaceContext(page, timeoutMs = 25000) {
  try {
    return await withTimeout(_slurpWorkspaceContext(page), timeoutMs, 'slurpWorkspaceContext');
  } catch (err) {
    console.error(`[Workspace] Error slurping files: ${err.message}`);
    return {};
  }
}

/**
 * Internal worker for injecting modified files.
 */
async function _injectWorkspaceContext(page, fileMap) {
  if (!page || page.isClosed()) return;
  if (!fileMap || Object.keys(fileMap).length === 0) {
    console.log('[Workspace] No files to inject — skipping.');
    return;
  }

  const entries = Object.entries(fileMap);
  console.log(`[Workspace] Injecting ${entries.length} file(s): ${entries.map(([k]) => k).join(', ')}`);

  for (const target of getSearchTargets(page)) {
    try {
      const injected = await target.evaluate((files) => {
        if (!window.monaco?.editor?.getModels) return 0;
        const models = window.monaco.editor.getModels();
        if (!models || models.length === 0) return 0;

        let count = 0;

        // Single model: inject primary file regardless of filename
        if (models.length === 1) {
          const content = Object.values(files)[0];
          if (content) {
            models[0].setValue(content);
            count++;
          }
          return count;
        }

        // Multi-model: match by filename
        for (const model of models) {
          const uriStr = model.uri?.path || model.uri?.toString?.() || '';
          const filename = uriStr.split('/').filter(Boolean).pop() || '';
          const content = files[filename];
          if (content) {
            model.setValue(content);
            count++;
          }
        }

        // If no filename matched, inject primary into first model
        if (count === 0) {
          const content = Object.values(files)[0];
          if (content) {
            models[0].setValue(content);
            count++;
          }
        }

        return count;
      }, fileMap).catch(() => 0);

      if (injected > 0) {
        console.log(`[Workspace] ✓ Monaco API injection succeeded (${injected} model(s) updated).`);
        return;
      }
    } catch {}
  }

  // Clipboard paste fallback
  console.log('[Workspace] Monaco API injection fallback — trying clipboard paste...');
  const primaryCode = Object.values(fileMap)[0] || '';
  if (!primaryCode) return;

  try {
    await page.click('.monaco-editor').catch(() => {});
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+A`).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});

    await page.evaluate((src) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', src);
      const editor = document.querySelector('.monaco-editor textarea');
      if (editor) {
        editor.focus();
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }, primaryCode);

    await page.waitForTimeout(400).catch(() => {});
    console.log('[Workspace] Clipboard fallback injection done.');
  } catch (e) {
    console.log('[Workspace] ✗ All injection methods failed:', e.message?.slice(0, 100));
  }
}

/**
 * Inject modified files back into Monaco editor with timeout envelope.
 */
export async function injectWorkspaceContext(page, fileMap, timeoutMs = 30000) {
  try {
    await withTimeout(_injectWorkspaceContext(page, fileMap), timeoutMs, 'injectWorkspaceContext');
  } catch (err) {
    console.error(`[Workspace] Error injecting files: ${err.message}`);
  }
}
