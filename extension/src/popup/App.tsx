import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { DashboardTab } from './components/DashboardTab';
import { LivePanelTab } from './components/LivePanelTab';
import { ReferenceTab } from './components/ReferenceTab';
import { SettingsTab } from './components/SettingsTab';
import { PlatformStatus, QuestionAnalysis, SessionStats, AutomationMode } from '../types';
import { sendToActiveTab } from '../services/messaging';
import { getSettings } from '../services/storage';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'live' | 'references' | 'settings'>('dashboard');
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [analyses, setAnalyses] = useState<QuestionAnalysis[]>([]);
  const [stats, setStats] = useState<SessionStats>({
    totalQuestions: 0,
    referenceMatches: 0,
    aiSuggestions: 0,
    unresolved: 0
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const refreshState = async () => {
    // 1. Check Settings
    const settings = await getSettings();
    setHasApiKey(Boolean(settings.geminiApiKey?.trim()));

    // 2. Query Active Tab Platform Status
    const tabStatus = await sendToActiveTab<PlatformStatus>({ type: 'GET_PLATFORM_STATUS' });
    if (tabStatus) {
      setStatus(tabStatus);
    }
  };

  useEffect(() => {
    refreshState();
  }, []);

  const handleStartAnalysis = async (mode: AutomationMode = 'autofill', forceAi: boolean = false) => {
    setIsAnalyzing(true);
    try {
      const res = await sendToActiveTab<{ analyses: QuestionAnalysis[]; stats: SessionStats }>({
        type: 'START_ANALYSIS',
        mode,
        forceAi
      });

      if (res && res.analyses) {
        setAnalyses(res.analyses);
        setStats(res.stats);
        setActiveTab('live');
      }
    } catch (err) {
      console.error('[Popup] Analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleHighlight = async (questionId: string, optionIndices: number[]) => {
    await sendToActiveTab({
      type: 'HIGHLIGHT_OPTION',
      questionId,
      optionIndices
    });
  };

  return (
    <div className="popup-container">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        status={status}
        hasApiKey={hasApiKey}
      />

      <main className="content-body">
        {activeTab === 'dashboard' && (
          <DashboardTab
            status={status}
            stats={stats}
            isAnalyzing={isAnalyzing}
            onStartAnalysis={handleStartAnalysis}
            onSwitchToLive={() => setActiveTab('live')}
            hasApiKey={hasApiKey}
          />
        )}

        {activeTab === 'live' && (
          <LivePanelTab
            analyses={analyses}
            isAnalyzing={isAnalyzing}
            onHighlight={handleHighlight}
            onStartAnalysis={handleStartAnalysis}
          />
        )}

        {activeTab === 'references' && <ReferenceTab />}

        {activeTab === 'settings' && (
          <SettingsTab onSettingsChanged={refreshState} />
        )}
      </main>
    </div>
  );
};
