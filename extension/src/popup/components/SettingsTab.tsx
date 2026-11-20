import React, { useState, useEffect } from 'react';
import { UserSettings } from '../../types';
import { getSettings, saveSettings, clearSettings, DEFAULT_SETTINGS } from '../../services/storage';
import { testGeminiApiKey, SUPPORTED_MODELS } from '../../services/gemini';

interface SettingsTabProps {
  onSettingsChanged: () => void;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({ onSettingsChanged }) => {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<{ testing: boolean; message?: string; success?: boolean }>({
    testing: false
  });
  const [savedBanner, setSavedBanner] = useState(false);

  useEffect(() => {
    getSettings().then((s) => setSettings(s));
  }, []);

  const handleSave = async (updated: Partial<UserSettings>) => {
    const newSettings = await saveSettings(updated);
    setSettings(newSettings);
    onSettingsChanged();
    setSavedBanner(true);
    setTimeout(() => setSavedBanner(false), 2000);
  };

  const handleTestKey = async () => {
    if (!settings.geminiApiKey) {
      setTestStatus({ testing: false, success: false, message: 'Please enter an API key first.' });
      return;
    }

    setTestStatus({ testing: true });
    const res = await testGeminiApiKey(settings.geminiApiKey, settings.geminiModel);
    setTestStatus({ testing: false, success: res.success, message: res.message });
  };

  const handleClear = async () => {
    if (confirm('Clear all saved extension settings and API keys?')) {
      await clearSettings();
      setSettings(DEFAULT_SETTINGS);
      onSettingsChanged();
    }
  };

  return (
    <div>
      {savedBanner && (
        <div style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'var(--accent-emerald)', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: '600', marginBottom: '12px' }}>
          ✓ Settings saved successfully.
        </div>
      )}

      {/* Gemini BYOK Section */}
      <div className="glass-card">
        <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '6px', color: '#fff' }}>
          🔑 Gemini API Configuration (BYOK)
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: '1.4' }}>
          Get a free API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-purple)' }}>Google AI Studio</a>. Your key is stored locally in your browser and never sent to any third-party server.
        </div>

        <div className="input-group">
          <label className="input-label">Gemini API Key</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type={showKey ? 'text' : 'password'}
              className="text-input"
              placeholder="AIzaSy..."
              value={settings.geminiApiKey}
              onChange={(e) => handleSave({ geminiApiKey: e.target.value })}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowKey(!showKey)}
              style={{ padding: '0 10px' }}
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div className="input-group">
          <label className="input-label">Model Selection</label>
          <select
            className="select-input"
            value={SUPPORTED_MODELS.some((m) => m.id === settings.geminiModel) ? settings.geminiModel : 'custom'}
            onChange={(e) => {
              if (e.target.value !== 'custom') {
                handleSave({ geminiModel: e.target.value });
              }
            }}
          >
            {SUPPORTED_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option value="custom">-- Custom Model ID --</option>
          </select>
          {(!SUPPORTED_MODELS.some((m) => m.id === settings.geminiModel) || settings.geminiModel.startsWith('custom:')) && (
            <input
              type="text"
              className="text-input"
              style={{ marginTop: '6px' }}
              placeholder="e.g. gemini-4-hydrogen"
              value={settings.geminiModel}
              onChange={(e) => handleSave({ geminiModel: e.target.value.trim() })}
            />
          )}
        </div>

        <button
          className="btn-secondary"
          style={{ width: '100%', padding: '8px 0', marginTop: '4px' }}
          disabled={testStatus.testing || !settings.geminiApiKey}
          onClick={handleTestKey}
        >
          {testStatus.testing ? 'Testing connection with Google API...' : '⚡ Test API Key Connection'}
        </button>

        {testStatus.message && (
          <div
            style={{
              marginTop: '10px',
              padding: '8px',
              borderRadius: '6px',
              fontSize: '11px',
              background: testStatus.success ? 'rgba(16, 185, 129, 0.1)' : 'rgba(244, 63, 94, 0.1)',
              color: testStatus.success ? 'var(--accent-emerald)' : 'var(--accent-rose)',
              border: `1px solid ${testStatus.success ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)'}`
            }}
          >
            {testStatus.success ? '✓' : '⚠️'} {testStatus.message}
          </div>
        )}
      </div>

      {/* Preferences Section */}
      <div className="glass-card">
        <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '10px', color: '#fff' }}>
          ⚙️ Assistance Preferences
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={settings.autoHighlightInPage}
              onChange={(e) => handleSave({ autoHighlightInPage: e.target.checked })}
            />
            <span>Auto-highlight suggested options in quiz page</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={settings.showConfidence}
              onChange={(e) => handleSave({ showConfidence: e.target.checked })}
            />
            <span>Display match confidence percentages</span>
          </label>
        </div>
      </div>

      {/* Security & Data Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
        <button
          className="btn-secondary"
          style={{ color: 'var(--accent-rose)', borderColor: 'rgba(244, 63, 94, 0.3)' }}
          onClick={handleClear}
        >
          Reset All Data
        </button>
        <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>v2.0.0 (Production MV3)</span>
      </div>
    </div>
  );
};
