import React from 'react';
import { PlatformStatus } from '../../types';

interface HeaderProps {
  activeTab: 'dashboard' | 'live' | 'references' | 'settings';
  setActiveTab: (tab: 'dashboard' | 'live' | 'references' | 'settings') => void;
  status: PlatformStatus | null;
  hasApiKey: boolean;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab, status, hasApiKey }) => {
  return (
    <>
      <header className="header">
        <div className="brand">
          <div className="brand-logo">S</div>
          <div className="brand-text">
            <h1>SAAB Assistant</h1>
            <span>Academic Workflow & AI Engine</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {status && status.platform !== 'unknown' ? (
            <span className="status-pill success">
              ● {status.platform === 'coursera' ? 'BITS Pilani' : 'Scaler'}
            </span>
          ) : (
            <span className="status-pill danger">● Inactive Tab</span>
          )}

          {hasApiKey ? (
            <span className="status-pill purple" title="Gemini BYOK Connected">
              AI Ready
            </span>
          ) : (
            <span className="status-pill warning" title="Gemini API Key Missing">
              No Key
            </span>
          )}
        </div>
      </header>

      <nav className="nav-tabs">
        <button
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`}
          onClick={() => setActiveTab('live')}
        >
          Live Assist
        </button>
        <button
          className={`tab-btn ${activeTab === 'references' ? 'active' : ''}`}
          onClick={() => setActiveTab('references')}
        >
          Answers Bank
        </button>
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </nav>
    </>
  );
};
