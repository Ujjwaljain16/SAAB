/**
 * in-page-ui.ts
 * Clean, non-intrusive floating assistance HUD injected into learning platform pages.
 */

import { QuestionAnalysis, SessionStats } from '../types';
import { sessionManager } from '../core/session-manager';
import { adapterRegistry } from '../adapters/adapter-registry';

export class InPageUi {
  private rootEl: HTMLElement | null = null;
  private isMinimized: boolean = false;
  private analyses: QuestionAnalysis[] = [];
  private stats: SessionStats = {
    totalQuestions: 0,
    referenceMatches: 0,
    aiSuggestions: 0,
    unresolved: 0
  };

  init(): void {
    if (document.getElementById('saab-root')) return;

    this.rootEl = document.createElement('div');
    this.rootEl.id = 'saab-root';
    document.body.appendChild(this.rootEl);
    this.render();
  }

  updateData(analyses: QuestionAnalysis[], stats: SessionStats): void {
    this.analyses = analyses;
    this.stats = stats;
    this.render();
  }

  private render(): void {
    if (!this.rootEl) return;

    const status = adapterRegistry.getStatus();
    const platformLabel = status.platform === 'coursera' ? 'BITS Pilani' : status.platform === 'scaler' ? 'Scaler' : 'SAAB';

    if (this.isMinimized) {
      this.rootEl.innerHTML = `
        <div class="saab-widget minimized" id="saab-toggle-btn">
          <div class="saab-header" style="border: none; border-radius: 24px; padding: 8px 14px;">
            <div class="saab-title">
              <span>✨</span>
              <span>${platformLabel}</span>
              <span class="saab-badge">${this.stats.referenceMatches > 0 ? this.stats.referenceMatches + ' Verified' : (this.analyses.length || status.detectedQuestionsCount) + ' Qs'}</span>
            </div>
          </div>
        </div>
      `;
      this.rootEl.querySelector('#saab-toggle-btn')?.addEventListener('click', () => {
        this.isMinimized = false;
        this.render();
      });
      return;
    }

    let cardsHtml = '';
    if (this.analyses.length === 0) {
      cardsHtml = `
        <div style="text-align: center; color: #94a3b8; font-size: 12px; padding: 16px 0;">
          ${status.detectedQuestionsCount > 0 ? `Detected ${status.detectedQuestionsCount} questions on page.` : 'Navigate to a quiz or assessment to start.'}
        </div>
      `;
    } else {
      cardsHtml = this.analyses
        .map((item, idx) => {
          let badge = '<span class="saab-pill saab-pill-unresolved">Unresolved</span>';
          let answerText = 'No suggestion available';
          let explanation = item.error || 'Check prompt or configure Gemini API key.';

          if (item.status === 'matched' && item.referenceMatch) {
            badge = `<span class="saab-pill saab-pill-verified">✓ ${(item.referenceMatch.confidence * 100).toFixed(0)}% Reference Match</span>`;
            const pickedTexts = item.referenceMatch.selectedIndices
              .map((i) => item.question.options[i]?.text)
              .filter(Boolean);
            answerText = pickedTexts.join(' | ') || `Option ${item.referenceMatch.bestOptionIndex! + 1}`;
            explanation = item.referenceMatch.reasoning;
          } else if (item.status === 'ai_suggested' && item.aiAnalysis) {
            badge = `<span class="saab-pill saab-pill-ai">✨ AI Analysis (${(item.aiAnalysis.confidence * 100).toFixed(0)}%)</span>`;
            answerText = item.aiAnalysis.suggestedAnswers.join(' | ');
            explanation = item.aiAnalysis.explanation;
          } else if (item.status === 'analyzing') {
            badge = '<span class="saab-pill saab-pill-ai">Analyzing...</span>';
            answerText = 'Reading question and options...';
            explanation = 'Searching answer keys and reasoning...';
          }

          return `
            <div class="saab-card" data-q-id="${item.question.id}">
              <div class="saab-card-header">
                <span style="font-weight: 600; color: #f8fafc;">Q${item.question.number || idx + 1}</span>
                ${badge}
              </div>
              <div style="color: #cbd5e1; font-size: 11px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${this.escapeHtml(item.question.prompt)}
              </div>
              <div class="saab-answer-text">👉 ${this.escapeHtml(answerText)}</div>
              <div class="saab-explanation">${this.escapeHtml(explanation)}</div>
              <button class="saab-highlight-btn" data-q-id="${item.question.id}" style="margin-top: 6px; background: transparent; border: 1px solid rgba(139, 92, 246, 0.4); color: #c4b5fd; font-size: 10px; border-radius: 4px; padding: 2px 6px; cursor: pointer;">
                Highlight in Page
              </button>
            </div>
          `;
        })
        .join('');
    }

    this.rootEl.innerHTML = `
      <div class="saab-widget">
        <div class="saab-header" id="saab-header-bar">
          <div class="saab-title">
            <span style="font-size: 16px;">✨</span>
            <span>SAAB Assistant</span>
            <span class="saab-badge">${platformLabel}</span>
          </div>
          <button id="saab-min-btn" style="background: none; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 0 4px;">−</button>
        </div>
        <div class="saab-body">
          <div style="display: flex; gap: 6px; margin-bottom: 8px;">
            <button class="saab-btn" id="saab-autofill-btn" style="flex: 2; background: linear-gradient(135deg, #7c3aed, #4f46e5);">
              ⚡ Auto-Solve & Fill All
            </button>
            <button class="saab-btn" id="saab-submit-btn" style="flex: 1.2; background: linear-gradient(135deg, #059669, #10b981);">
              🚀 Submit
            </button>
          </div>
          <button class="saab-btn" id="saab-analyze-btn" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); font-size: 11px; padding: 5px;">
            ${this.analyses.length > 0 ? '🔄 Refresh Analysis' : '🔍 Preview Analysis Only'}
          </button>
          <div style="margin-top: 10px;">
            ${cardsHtml}
          </div>
        </div>
      </div>
    `;

    // Event listeners
    this.rootEl.querySelector('#saab-min-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isMinimized = true;
      this.render();
    });

    this.rootEl.querySelector('#saab-autofill-btn')?.addEventListener('click', async () => {
      const btn = this.rootEl?.querySelector('#saab-autofill-btn') as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Auto-Filling Answers...';
      }

      try {
        await sessionManager.runAnalysis(false, 'autofill', (updated, stats) => {
          this.updateData(updated, stats);
        });
        if (btn) btn.textContent = '✓ All Answers Selected!';
      } catch (err: any) {
        alert('Auto-Fill error: ' + (err.message || 'Unknown error'));
        if (btn) btn.textContent = '⚡ Auto-Solve & Fill All';
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    this.rootEl.querySelector('#saab-submit-btn')?.addEventListener('click', () => {
      if (confirm('Submit this assessment now? Make sure all answers are selected.')) {
        const success = sessionManager.submitNow();
        if (!success) {
          alert('Submit could not be completed. Check if all questions are filled.');
        }
      }
    });

    this.rootEl.querySelector('#saab-analyze-btn')?.addEventListener('click', async () => {
      const btn = this.rootEl?.querySelector('#saab-analyze-btn') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;

      try {
        await sessionManager.runAnalysis(false, 'assist', (updated, stats) => {
          this.updateData(updated, stats);
        });
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    this.rootEl.querySelectorAll('.saab-highlight-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const qId = (e.currentTarget as HTMLElement).getAttribute('data-q-id');
        if (!qId) return;
        const targetAnalysis = this.analyses.find((a) => a.question.id === qId);
        if (!targetAnalysis) return;

        const indices =
          targetAnalysis.referenceMatch?.selectedIndices ||
          targetAnalysis.aiAnalysis?.suggestedIndices ||
          [];
        if (indices.length > 0) {
          sessionManager.highlightOption(qId, indices);
        }
      });
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
