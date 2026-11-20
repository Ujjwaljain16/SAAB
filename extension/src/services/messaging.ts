/**
 * messaging.ts
 * Type-safe messaging helpers for communication between popup, content scripts, and service worker.
 */

import { ExtensionMessage } from '../types';

export async function sendToActiveTab<T = any>(message: ExtensionMessage): Promise<T | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs) return null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;

    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn('[Messaging] Could not send message to active tab:', err);
    return null;
  }
}

export async function sendToBackground<T = any>(message: ExtensionMessage): Promise<T | null> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.warn('[Messaging] Could not send message to background:', err);
    return null;
  }
}
