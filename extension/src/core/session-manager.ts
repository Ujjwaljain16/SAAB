/**
 * session-manager.ts
 * Coordinates question extraction, reference matching, and Gemini fallback.
 */

import { adapterRegistry } from '../adapters/adapter-registry';
import { referenceEngine } from './reference-engine';
import { matchQuestion } from './answer-matcher';
import { analyzeQuestionWithGemini } from '../services/gemini';
import { getSettings } from '../services/storage';
import { QuestionAnalysis, SessionStats, AutomationMode } from '../types';

class SessionManager {
  private activeAnalyses: QuestionAnalysis[] = [];
  private isRunning: boolean = false;

  getAnalyses(): QuestionAnalysis[] {
    return this.activeAnalyses;
  }

  getStats(): SessionStats {
    let referenceMatches = 0;
    let aiSuggestions = 0;
    let unresolved = 0;

    for (const a of this.activeAnalyses) {
      if (a.status === 'matched') referenceMatches++;
      else if (a.status === 'ai_suggested') aiSuggestions++;
      else unresolved++;
    }

    return {
      totalQuestions: this.activeAnalyses.length,
      referenceMatches,
      aiSuggestions,
      unresolved
    };
  }

  async runAnalysis(
    forceAi: boolean = false,
    mode: AutomationMode = 'autofill',
    onProgress?: (analyses: QuestionAnalysis[], stats: SessionStats) => void
  ): Promise<{ analyses: QuestionAnalysis[]; stats: SessionStats }> {
    if (this.isRunning) {
      return { analyses: this.activeAnalyses, stats: this.getStats() };
    }

    this.isRunning = true;

    try {
      const adapter = adapterRegistry.detectCurrentPlatform();
      if (!adapter) {
        throw new Error('Current page is not a supported platform (Coursera or Scaler).');
      }

      await referenceEngine.init();
      const settings = await getSettings();

      const questions = adapter.extractQuestions();
      if (questions.length === 0) {
        this.activeAnalyses = [];
        this.isRunning = false;
        const stats = this.getStats();
        onProgress?.(this.activeAnalyses, stats);
        return { analyses: [], stats };
      }

      this.activeAnalyses = questions.map((q) => ({
        question: q,
        referenceMatch: null,
        aiAnalysis: null,
        status: 'pending'
      }));

      onProgress?.(this.activeAnalyses, this.getStats());

      const references = referenceEngine.getAll();

      for (let i = 0; i < this.activeAnalyses.length; i++) {
        const item = this.activeAnalyses[i];
        item.status = 'analyzing';
        onProgress?.(this.activeAnalyses, this.getStats());

        let chosenIndices: number[] = [];

        // 1. Try Reference Matching
        const refMatch = matchQuestion(item.question, references);

        if (refMatch && refMatch.confidence >= 0.75 && !forceAi) {
          item.referenceMatch = refMatch;
          item.status = 'matched';
          chosenIndices = refMatch.selectedIndices;
        } else {
          // 2. Fallback to Gemini AI if API key is provided
          if (settings.geminiApiKey) {
            try {
              const aiResult = await analyzeQuestionWithGemini(
                item.question,
                settings.geminiApiKey,
                settings.geminiModel
              );
              item.aiAnalysis = aiResult;
              item.status = 'ai_suggested';
              chosenIndices = aiResult.suggestedIndices;
            } catch (aiErr: any) {
              console.warn(`[SessionManager] Gemini analysis failed for Q${i + 1}:`, aiErr);
              item.error = aiErr.message || 'AI request failed.';
              item.status = refMatch ? 'matched' : 'unresolved';
              item.referenceMatch = refMatch;
              if (refMatch) chosenIndices = refMatch.selectedIndices;
            }
          } else {
            if (refMatch) {
              item.referenceMatch = refMatch;
              item.status = 'matched';
              chosenIndices = refMatch.selectedIndices;
            } else {
              item.status = 'unresolved';
            }
          }
        }

        // AUTOMATION: If mode is 'autofill' or 'autosubmit', actively select/click the options in the live DOM!
        if (chosenIndices.length > 0) {
          if (mode === 'autofill' || mode === 'autosubmit') {
            adapter.selectOptions(item.question.id, chosenIndices);
          } else if (settings.autoHighlightInPage) {
            adapter.highlightOption(item.question.id, chosenIndices);
          }
        }

        onProgress?.(this.activeAnalyses, this.getStats());
      }

      // AUTOMATION POST-RUN: Check Honor code & Submit if requested
      if (mode === 'autofill' || mode === 'autosubmit') {
        adapter.agreeHonorCode();
      }

      if (mode === 'autosubmit') {
        const stats = this.getStats();
        // Safety guard: only auto-submit if at least 80% of questions were resolved
        if (stats.unresolved === 0 || (stats.referenceMatches + stats.aiSuggestions) / stats.totalQuestions >= 0.8) {
          console.log('[SessionManager] Auto-submitting assessment...');
          adapter.submitAssessment();
        }
      }

      return { analyses: this.activeAnalyses, stats: this.getStats() };
    } finally {
      this.isRunning = false;
    }
  }

  autoFillAll(submitAfter: boolean = false): boolean {
    const adapter = adapterRegistry.detectCurrentPlatform();
    if (!adapter) return false;

    let anyFilled = false;
    for (const item of this.activeAnalyses) {
      const picks = item.referenceMatch?.selectedIndices || item.aiAnalysis?.suggestedIndices;
      if (picks && picks.length > 0) {
        adapter.selectOptions(item.question.id, picks);
        anyFilled = true;
      }
    }

    adapter.agreeHonorCode();

    if (submitAfter) {
      adapter.submitAssessment();
    }

    return anyFilled;
  }

  submitNow(): boolean {
    const adapter = adapterRegistry.detectCurrentPlatform();
    if (!adapter) return false;
    adapter.agreeHonorCode();
    return adapter.submitAssessment();
  }

  highlightOption(questionId: string, optionIndices: number[]): boolean {
    const adapter = adapterRegistry.detectCurrentPlatform();
    if (!adapter) return false;
    return adapter.highlightOption(questionId, optionIndices);
  }
}

export const sessionManager = new SessionManager();
