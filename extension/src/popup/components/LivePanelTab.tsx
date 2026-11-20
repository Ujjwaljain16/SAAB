import React, { useState } from 'react';
import { QuestionAnalysis, AutomationMode } from '../../types';
import { sendToActiveTab } from '../../services/messaging';

interface LivePanelTabProps {
  analyses: QuestionAnalysis[];
  isAnalyzing: boolean;
  onHighlight: (questionId: string, optionIndices: number[]) => void;
  onStartAnalysis: (mode: AutomationMode, forceAi?: boolean) => void;
}

export const LivePanelTab: React.FC<LivePanelTabProps> = ({
  analyses,
  isAnalyzing,
  onHighlight,
  onStartAnalysis
}) => {
  const [filter, setFilter] = useState<'all' | 'matched' | 'ai' | 'unresolved'>('all');
  const [autoFillSuccess, setAutoFillSuccess] = useState(false);

  const handleAutoFillAll = async (submitAfter: boolean = false) => {
    await sendToActiveTab({ type: 'AUTO_FILL_ALL', submitAfterFill: submitAfter });
    setAutoFillSuccess(true);
    setTimeout(() => setAutoFillSuccess(false), 2500);
  };

  const filtered = analyses.filter((a) => {
    if (filter === 'matched') return a.status === 'matched';
    if (filter === 'ai') return a.status === 'ai_suggested';
    if (filter === 'unresolved') return a.status === 'unresolved' || a.status === 'error';
    return true;
  });

  if (analyses.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 10px' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>🎯</div>
        <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '6px' }}>
          No Active Analysis
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Run auto-solve on your active quiz tab to automatically select answers and solve the assessment.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '280px', margin: '0 auto' }}>
          <button
            className="btn-primary"
            style={{ padding: '8px 16px' }}
            disabled={isAnalyzing}
            onClick={() => onStartAnalysis('autofill')}
          >
            {isAnalyzing ? 'Analyzing...' : '⚡ Auto-Solve & Fill All'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Auto-Fill Action Bar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <button
          className="btn-primary"
          style={{ flex: 2, padding: '7px 0', fontSize: '12px', background: 'linear-gradient(135deg, #7c3aed, #4f46e5)' }}
          onClick={() => handleAutoFillAll(false)}
        >
          {autoFillSuccess ? '✓ Options Selected in Page!' : '⚡ Auto-Select All in Page'}
        </button>
        <button
          className="btn-primary"
          style={{ flex: 1.2, padding: '7px 0', fontSize: '12px', background: 'linear-gradient(135deg, #059669, #10b981)' }}
          onClick={() => {
            if (confirm('Submit this assessment live?')) {
              handleAutoFillAll(true);
            }
          }}
        >
          🚀 Submit Live
        </button>
      </div>
      {/* Filter Chips */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', overflowX: 'auto' }}>
        {(['all', 'matched', 'ai', 'unresolved'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '4px 10px',
              borderRadius: '12px',
              fontSize: '11px',
              fontWeight: '600',
              border: 'none',
              cursor: 'pointer',
              background: filter === f ? 'rgba(139, 92, 246, 0.25)' : 'rgba(255, 255, 255, 0.05)',
              color: filter === f ? '#c4b5fd' : 'var(--text-muted)'
            }}
          >
            {f === 'all' && `All (${analyses.length})`}
            {f === 'matched' && `Verified (${analyses.filter((a) => a.status === 'matched').length})`}
            {f === 'ai' && `AI (${analyses.filter((a) => a.status === 'ai_suggested').length})`}
            {f === 'unresolved' && `Unresolved (${analyses.filter((a) => a.status === 'unresolved').length})`}
          </button>
        ))}
      </div>

      {/* Cards List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {filtered.map((item, idx) => {
          const isMatched = item.status === 'matched' && item.referenceMatch;
          const isAi = item.status === 'ai_suggested' && item.aiAnalysis;

          let badgeText = 'Unresolved';
          let badgeClass = 'danger';
          let answerTexts: string[] = [];
          let explanation = item.error || 'No matching key found in repository and AI key not set.';
          let indicesToHighlight: number[] = [];

          if (isMatched) {
            badgeText = `✓ ${(item.referenceMatch!.confidence * 100).toFixed(0)}% Key Match`;
            badgeClass = 'success';
            indicesToHighlight = item.referenceMatch!.selectedIndices;
            answerTexts = indicesToHighlight.map(
              (i) => item.question.options[i]?.text || `Option ${i + 1}`
            );
            explanation = item.referenceMatch!.reasoning;
          } else if (isAi) {
            badgeText = `✨ ${(item.aiAnalysis!.confidence * 100).toFixed(0)}% AI Suggestion`;
            badgeClass = 'purple';
            indicesToHighlight = item.aiAnalysis!.suggestedIndices;
            answerTexts = item.aiAnalysis!.suggestedAnswers;
            explanation = item.aiAnalysis!.explanation;
          }

          return (
            <div key={item.question.id || idx} className="glass-card" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontWeight: '700', fontSize: '13px' }}>
                  Question {item.question.number || idx + 1}
                  {item.question.isMultiSelect && (
                    <span style={{ fontSize: '10px', color: 'var(--accent-amber)', marginLeft: '6px' }}>
                      [Multi-Select]
                    </span>
                  )}
                </span>
                <span className={`status-pill ${badgeClass}`}>{badgeText}</span>
              </div>

              {/* Prompt */}
              <div style={{ fontSize: '12px', color: '#e2e8f0', marginBottom: '8px', lineHeight: '1.4' }}>
                {item.question.prompt}
              </div>

              {/* Suggested Answer Box */}
              {answerTexts.length > 0 && (
                <div
                  style={{
                    background: 'rgba(15, 23, 42, 0.7)',
                    border: '1px solid rgba(139, 92, 246, 0.25)',
                    borderRadius: '6px',
                    padding: '8px',
                    marginBottom: '8px'
                  }}
                >
                  <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: '700', textTransform: 'uppercase' }}>
                    Suggested Answer:
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#f8fafc', marginTop: '2px' }}>
                    {answerTexts.join('  •  ')}
                  </div>
                </div>
              )}

              {/* Explanation */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4', marginBottom: '8px' }}>
                {explanation}
              </div>

              {/* Highlight Action */}
              {indicesToHighlight.length > 0 && (
                <button
                  className="btn-secondary"
                  style={{ fontSize: '11px', width: '100%', padding: '5px 0' }}
                  onClick={() => onHighlight(item.question.id, indicesToHighlight)}
                >
                  🎯 Highlight in Learning Platform
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
