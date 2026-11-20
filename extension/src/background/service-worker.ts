/**
 * service-worker.ts
 * Background service worker for SAAB extension.
 */

import { testGeminiApiKey } from '../services/gemini';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../services/storage';
import { referenceEngine } from '../core/reference-engine';

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[SAAB Service Worker] Installed. Reason:', details.reason);
  const current = await getSettings();
  if (!current.geminiModel) {
    await saveSettings(DEFAULT_SETTINGS);
  }
  await referenceEngine.init();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'TEST_GEMINI_KEY') {
    testGeminiApiKey(message.apiKey, message.model || 'gemini-3.5-flash-lite')
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, message: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.type === 'GET_SETTINGS') {
    getSettings().then((s) => sendResponse(s));
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    saveSettings(message.settings).then((s) => sendResponse(s));
    return true;
  }

  if (message.type === 'GET_ALL_REFERENCES') {
    referenceEngine.init().then(() => {
      sendResponse(referenceEngine.getAll());
    });
    return true;
  }
});
