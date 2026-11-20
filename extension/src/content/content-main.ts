/**
 * content-main.ts
 * Main entry point for content script running inside learning platform tabs.
 */

import './styles.css';
import { adapterRegistry } from '../adapters/adapter-registry';
import { sessionManager } from '../core/session-manager';
import { InPageUi } from './in-page-ui';
import { ExtensionMessage } from '../types';

console.log('[SAAB Assistant] Content script active on:', window.location.href);

const inPageUi = new InPageUi();

function checkAndMountUi(): void {
  const adapter = adapterRegistry.detectCurrentPlatform();
  if (adapter && adapter.isSupportedPage()) {
    inPageUi.init();
  }
}

// Initial check
checkAndMountUi();

// MutationObserver for Single-Page Apps (Coursera and Scaler client-side routing)
let debounceTimer: any = null;
const observer = new MutationObserver(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    checkAndMountUi();
  }, 1000);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Runtime messaging from Popup or Background
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'GET_PLATFORM_STATUS') {
    const status = adapterRegistry.getStatus();
    sendResponse(status);
    return true;
  }

  if (message.type === 'START_ANALYSIS') {
    sessionManager
      .runAnalysis(message.forceAi, message.mode || 'autofill', (analyses, stats) => {
        inPageUi.updateData(analyses, stats);
      })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async response
  }

  if (message.type === 'AUTO_FILL_ALL') {
    const success = sessionManager.autoFillAll(message.submitAfterFill || false);
    sendResponse({ success });
    return true;
  }

  if (message.type === 'SUBMIT_ASSESSMENT') {
    const success = sessionManager.submitNow();
    sendResponse({ success });
    return true;
  }

  if (message.type === 'HIGHLIGHT_OPTION') {
    const success = sessionManager.highlightOption(message.questionId, message.optionIndices);
    sendResponse({ success });
    return true;
  }
});
