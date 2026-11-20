/**
 * storage.ts
 * Type-safe Chrome Storage abstraction with unit-test fallback.
 */

import { UserSettings } from '../types';

export const DEFAULT_SETTINGS: UserSettings = {
  geminiApiKey: '',
  geminiModel: 'gemini-3.5-flash-lite',
  autoAnalyze: true,
  showConfidence: true,
  autoHighlightInPage: true,
  enabledPlatforms: {
    coursera: true,
    scaler: true
  }
};

const SETTINGS_KEY = 'saab_user_settings';

// In-memory fallback for test environments or non-chrome environments
let memorySettings: UserSettings = { ...DEFAULT_SETTINGS };

export async function getSettings(): Promise<UserSettings> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get([SETTINGS_KEY]);
      if (data[SETTINGS_KEY]) {
        return { ...DEFAULT_SETTINGS, ...data[SETTINGS_KEY] };
      }
    }
  } catch (err) {
    console.warn('[Storage] Fallback to in-memory store:', err);
  }
  return { ...memorySettings };
}

export async function saveSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getSettings();
  const updated: UserSettings = {
    ...current,
    ...partial,
    enabledPlatforms: {
      ...current.enabledPlatforms,
      ...(partial.enabledPlatforms || {})
    }
  };

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: updated });
    }
  } catch (err) {
    console.warn('[Storage] Fallback to in-memory store:', err);
  }

  memorySettings = { ...updated };
  return updated;
}

export async function clearSettings(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove([SETTINGS_KEY]);
    }
  } catch (err) {
    console.warn('[Storage] Clear fallback:', err);
  }
  memorySettings = { ...DEFAULT_SETTINGS };
}
