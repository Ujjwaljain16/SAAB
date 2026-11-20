import React from 'react';
import { PlatformStatus, SessionStats, AutomationMode } from '../../types';

interface DashboardTabProps {
  status: PlatformStatus | null;
  stats: SessionStats;
  isAnalyzing: boolean;
  onStartAnalysis: (mode: AutomationMode, forceAi?: boolean) => void;
  onSwitchToLive: () => void;
  hasApiKey: boolean;
}

export const DashboardTab: React.FC<DashboardTabProps> = ({
  status,
  stats,
  isAnalyzing,
  onStartAnalysis,
  onSwitchToLive,
  hasApiKey
}) => {
  const isSupported = status && status.platform !== 'unknown';

  return (
    <div>
      {/* Platform & Page Status */}
      <div className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Active Learning Platform
            </div>
            <div style={{ fontSize: '15px', fontWeight: '700', marginTop: '2px', color: '#fff' }}>
              {status?.platform === 'coursera'
                ? 'BITS Pilani BSc — Coursera'
                : status?.platform === 'scaler'
                ? 'Scaler Academy'
                : 'No Supported Platform Active'}
            </div>
          </div>
          {isSupported ? (
            <span className="status-pill success">Detected</span>
          ) : (
            <span className="status-pill warning">Waiting for Page</span>
          )}
        </div>

        {isSupported ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              📄 {status.pageTitle || 'Assessment Tab'}
            </div>
            <div style={{ marginTop: '4px', display: 'flex', gap: '12px' }}>
              <span>🎯 <strong>{status.detectedQuestionsCount}</strong> Question(s) Found</span>
              <span>⚡ Activity: {status.currentActivity || 'Quiz Session'}</span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Please switch to a Coursera BITS Pilani quiz tab or Scaler Academy problem page to begin.
          </div>
        )}
      </div>

      {/* Main Automation Action Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
        <button
          className="btn-primary"
          disabled={!isSupported || isAnalyzing}
          onClick={() => onStartAnalysis('autofill')}
          style={{ background: 'linear-gradient(135deg, #7c3aed, #4f46e5)' }}
        >
          {isAnalyzing ? (
            <span>⏳ Auto-Solving & Filling In Page...</span>
          ) : (
            <span>⚡ Auto-Solve & Fill All Answers</span>
          )}
        </button>

        <button
          className="btn-primary"
          disabled={!isSupported || isAnalyzing}
          onClick={() => {
            if (confirm('Run FULL AUTO: Solve all questions, check honor code, and submit live?')) {
              onStartAnalysis('autosubmit');
            }
          }}
          style={{ background: 'linear-gradient(135deg, #059669, #10b981)', boxShadow: '0 4px 14px rgba(16, 185, 129, 0.25)' }}
        >
          🚀 Full Auto: Solve & Submit (Live)
        </button>

        <button
          className="btn-secondary"
          disabled={!isSupported || isAnalyzing}
          onClick={() => onStartAnalysis('assist')}
          style={{ padding: '6px 0', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}
        >
          🔍 Preview Suggestions Only (No Auto-Clicks)
        </button>
      </div>

      {/* Session Progress Stats */}
      {stats.totalQuestions > 0 && (
        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontWeight: '600', fontSize: '13px' }}>Session Verification Summary</span>
            <button
              className="btn-secondary"
              style={{ fontSize: '11px', padding: '3px 8px' }}
              onClick={onSwitchToLive}
            >
              View Details →
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', textAlign: 'center' }}>
            <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '8px', borderRadius: '6px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
              <div style={{ fontSize: '16px', fontWeight: '700', color: 'var(--accent-emerald)' }}>
                {stats.referenceMatches}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Verified Keys</div>
            </div>

            <div style={{ background: 'rgba(99, 102, 241, 0.1)', padding: '8px', borderRadius: '6px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
              <div style={{ fontSize: '16px', fontWeight: '700', color: '#a5b4fc' }}>
                {stats.aiSuggestions}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>AI Suggested</div>
            </div>

            <div style={{ background: 'rgba(148, 163, 184, 0.1)', padding: '8px', borderRadius: '6px', border: '1px solid rgba(148, 163, 184, 0.2)' }}>
              <div style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-dim)' }}>
                {stats.unresolved}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Unresolved</div>
            </div>
          </div>
        </div>
      )}

      {/* Key Warning if not configured */}
      {!hasApiKey && (
        <div className="glass-card" style={{ borderColor: 'rgba(245, 158, 11, 0.3)', background: 'rgba(245, 158, 11, 0.05)' }}>
          <div style={{ color: 'var(--accent-amber)', fontWeight: '600', fontSize: '12px', marginBottom: '4px' }}>
            ⚠️ Gemini API Key Not Configured
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            You can still use verified answer keys from the course knowledge base. To get instant AI explanations and fallback solving for new questions, add your free Gemini key in Settings.
          </div>
        </div>
      )}

      {/* Academic Integrity & Safety Guard */}
      <div style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'center', marginTop: '12px', lineHeight: '1.4' }}>
        🛡️ <strong>Zero-Surprise Safety Guarantee:</strong> SAAB assists with explanations and non-intrusive option highlights. It never clicks submit or alters assessment submissions.
      </div>
    </div>
  );
};
