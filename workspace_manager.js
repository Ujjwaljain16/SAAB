/**
 * workspace_manager.js
 * Real implementation: extracts Monaco editor files from VS Code IDE problems
 * (works on both main page and iframes — handles the VS Code web embed pattern)
 */

/**
 * Returns all page frames including the main page as a "frame-like" object.
 * We try main page first, then all child frames sorted by Monaco model count.
 */
function getSearchTargets(page) {
  return [page, ...page.frames()];
}

/**
 * Wait for Monaco IDE to become ready in any frame.
 */
export async function waitForWorkspaceReady(page, timeoutMs = 90000) {
  console.log('[Workspace] Waiting for VS Code / Monaco IDE to initialize...');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const target of getSearchTargets(page)) {
      try {
        const ready = await target.evaluate(() => {
          const models = window.monaco?.editor?.getModels?.();
          return Array.isArray(models) && models.length > 0;
        }).catch(() => false);

        if (ready) {
          console.log(`[Workspace] Monaco IDE ready (${target === page ? 'main page' : target.url().slice(0, 60)}).`);
          return;
        }
      } catch {}
    }

    // Also check for VS Code loading spinner being gone
    const stillLoading = await page.evaluate(() =>
      !!document.querySelector('.monaco-loading, .loading-container, [class*="Loading"]')
    ).catch(() => false);

    if (!stillLoading) {
      await page.waitForTimeout(1500);
    } else {
      await page.waitForTimeout(2500);
    }
  }

  console.log('[Workspace] WARNING: Monaco IDE not detected within timeout — proceeding anyway.');
}

/**
 * Extract all source files from the Monaco editor (any frame).
 * Returns { filename: content, ... }
 */
export async function slurpWorkspaceContext(page) {
  console.log('[Workspace] Extracting workspace files from Monaco editor...');

  for (const target of getSearchTargets(page)) {
    try {
      const files = await target.evaluate(() => {
        if (!window.monaco?.editor?.getModels) return null;
        const models = window.monaco.editor.getModels();
        if (!models || models.length === 0) return null;

        const result = {};
        for (const model of models) {
          // Reconstruct filename from URI
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
        console.log(`[Workspace] ✓ Extracted ${names.length} file(s): ${names.join(', ')}`);
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
        // Guess filename from page title
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
 * Inject modified files back into the Monaco editor models.
 * Matches files by filename — if only one model exists, injects primary file regardless of name.
 */
export async function injectWorkspaceContext(page, fileMap) {
  if (!fileMap || Object.keys(fileMap).length === 0) {
    console.log('[Workspace] No files to inject — skipping.');
    return;
  }

  const entries = Object.entries(fileMap);
  console.log(`[Workspace] Injecting ${entries.length} file(s): ${entries.map(([k]) => k).join(', ')}`);

  for (const target of getSearchTargets(page)) {
    try {
      const injected = await target.evaluate((fileMap) => {
        if (!window.monaco?.editor?.getModels) return 0;
        const models = window.monaco.editor.getModels();
        if (!models || models.length === 0) return 0;

        let count = 0;

        // If only one model, always inject the primary (first) file content
        if (models.length === 1) {
          const content = Object.values(fileMap)[0];
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
          const content = fileMap[filename];
          if (content) {
            model.setValue(content);
            count++;
          }
        }

        // If nothing matched by name, inject primary into first model as best-effort
        if (count === 0) {
          const content = Object.values(fileMap)[0];
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
  console.log('[Workspace] Monaco injection failed — trying clipboard paste fallback...');
  const primaryCode = Object.values(fileMap)[0] || '';
  if (!primaryCode) return;

  try {
    // Try main page Monaco editor
    await page.click('.monaco-editor').catch(() => {});
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+A`);
    await page.keyboard.press('Backspace');

    // ClipboardEvent paste
    await page.evaluate((src) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', src);
      const editor = document.querySelector('.monaco-editor textarea');
      if (editor) {
        editor.focus();
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }, primaryCode);

    await page.waitForTimeout(400);
    console.log('[Workspace] Clipboard fallback injection done.');
  } catch (e) {
    console.log('[Workspace] ✗ All injection methods failed:', e.message?.slice(0, 100));
  }
}
