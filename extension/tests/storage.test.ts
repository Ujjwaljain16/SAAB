import { describe, it, expect, beforeEach } from 'vitest';
import { getSettings, saveSettings, clearSettings, DEFAULT_SETTINGS } from '../src/services/storage';

describe('storage service', () => {
  beforeEach(async () => {
    await clearSettings();
  });

  it('returns default settings when uninitialized', async () => {
    const settings = await getSettings();
    expect(settings.geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);
    expect(settings.geminiApiKey).toBe('');
    expect(settings.autoHighlightInPage).toBe(true);
  });

  it('saves partial updates without corrupting other settings', async () => {
    await saveSettings({ geminiApiKey: 'AIzaSyTestKey123' });
    let settings = await getSettings();
    expect(settings.geminiApiKey).toBe('AIzaSyTestKey123');
    expect(settings.geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);

    await saveSettings({ geminiModel: 'gemini-2.5-pro' });
    settings = await getSettings();
    expect(settings.geminiApiKey).toBe('AIzaSyTestKey123');
    expect(settings.geminiModel).toBe('gemini-2.5-pro');
  });

  it('resets to defaults when clearSettings is invoked', async () => {
    await saveSettings({ geminiApiKey: 'secret-key' });
    await clearSettings();
    const settings = await getSettings();
    expect(settings.geminiApiKey).toBe('');
  });
});
