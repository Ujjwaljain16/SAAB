/**
 * scaler-adapter.ts
 * Adapter for Scaler Academy MCQs, assignments, and problem statements.
 */

import { PlatformAdapter, PlatformMetadata } from './platform-interface';
import { ExtractedQuestion, ExtractedOption, PlatformType } from '../types';

export class ScalerAdapter implements PlatformAdapter {
  readonly platform: PlatformType = 'scaler';
  readonly name = 'Scaler Academy';

  isMatchingUrl(url: string): boolean {
    return url.includes('scaler.com');
  }

  isSupportedPage(): boolean {
    if (typeof document === 'undefined') return false;
    const hasMCQ = document.querySelectorAll('.cr-multiple-choice').length > 0;
    const hasStatement = document.querySelectorAll('.cr-p-statement, .cr-multiple-choice-container').length > 0;
    const isProblemUrl = window.location.href.includes('/problems/') || window.location.href.includes('/p/');
    return hasMCQ || hasStatement || isProblemUrl;
  }

  extractQuestions(): ExtractedQuestion[] {
    if (typeof document === 'undefined') return [];

    // Scaler problems typically present 1 active question per page view
    const statementSelectors = [
      '.cr-p-statement',
      '.cr-multiple-choice-container__heading',
      '.cr-p-statement-content',
      '[class*="statement"]',
      '[class*="description"]'
    ];

    let prompt = '';
    for (const sel of statementSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent?.trim() || '';
        if (text.length > 5) {
          prompt = text;
          break;
        }
      }
    }

    // Extract title / heading if available
    const headingEl = document.querySelector('.cr-p-heading, .cr-p-heading__text');
    const title = headingEl?.textContent?.trim() || '';
    if (!prompt && title) {
      prompt = title;
    }

    const optEls = Array.from(document.querySelectorAll('.cr-multiple-choice'));
    if (optEls.length === 0 && !prompt) return [];

    let isMultiSelect = false;
    const options: ExtractedOption[] = optEls.map((el, i) => {
      const inputEl = el.querySelector('input[type="checkbox"], input[type="radio"]') as HTMLInputElement | null;
      if (inputEl?.type === 'checkbox') {
        isMultiSelect = true;
      }

      const labelEl = el.querySelector('.cr-multiple-choice__label, label, .cr-multiple-choice__text');
      const text = labelEl ? labelEl.textContent?.trim() || '' : el.textContent?.trim() || `Option ${i + 1}`;

      return {
        id: `scaler_opt_${i}`,
        index: i,
        text,
        isSelected: inputEl?.checked || false
      };
    });

    const attemptsChip = document.querySelector('.cr-multiple-choice-container__hint-chip');
    const points = attemptsChip?.textContent?.trim() || '';

    const question: ExtractedQuestion = {
      id: 'scaler_active_mcq',
      number: 1,
      prompt: prompt || title || 'Scaler MCQ Assessment Question',
      options,
      isMultiSelect,
      questionType: isMultiSelect ? 'multiple_choice' : 'single_choice',
      points
    };

    return [question];
  }

  highlightOption(_questionId: string, optionIndices: number[]): boolean {
    if (typeof document === 'undefined') return false;

    // Clear existing highlights
    const prev = document.querySelectorAll('[data-saab-highlight="scaler"]');
    prev.forEach((el) => {
      el.removeAttribute('data-saab-highlight');
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.backgroundColor = '';
      const badge = el.querySelector('.saab-suggested-badge');
      badge?.remove();
    });

    const optEls = Array.from(document.querySelectorAll('.cr-multiple-choice'));
    let anyHighlighted = false;

    for (const idx of optionIndices) {
      const target = optEls[idx] as HTMLElement;
      if (target) {
        target.setAttribute('data-saab-highlight', 'scaler');
        target.style.outline = '2px solid #8b5cf6';
        target.style.outlineOffset = '2px';
        target.style.backgroundColor = 'rgba(139, 92, 246, 0.08)';
        target.style.borderRadius = '6px';
        target.style.transition = 'all 0.2s ease-in-out';

        if (!target.querySelector('.saab-suggested-badge')) {
          const badge = document.createElement('span');
          badge.className = 'saab-suggested-badge';
          badge.textContent = '✨ Suggested Answer';
          badge.style.display = 'inline-block';
          badge.style.marginLeft = '10px';
          badge.style.padding = '2px 8px';
          badge.style.fontSize = '11px';
          badge.style.fontWeight = '600';
          badge.style.color = '#8b5cf6';
          badge.style.background = 'rgba(139, 92, 246, 0.15)';
          badge.style.borderRadius = '12px';
          target.appendChild(badge);
        }

        anyHighlighted = true;
      }
    }

    return anyHighlighted;
  }

  selectOptions(_questionId: string, optionIndices: number[]): boolean {
    if (typeof document === 'undefined') return false;

    const optEls = Array.from(document.querySelectorAll('.cr-multiple-choice'));
    let anySelected = false;

    optEls.forEach((el, i) => {
      const inputEl = el.querySelector('input[type="checkbox"], input[type="radio"]') as HTMLInputElement | null;
      const shouldBeChecked = optionIndices.includes(i);

      if (inputEl) {
        if (inputEl.checked !== shouldBeChecked) {
          inputEl.click();
          inputEl.checked = shouldBeChecked;
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          const label = inputEl.closest('label') || el;
          if (label && label !== inputEl) (label as HTMLElement).click();
        }
      } else {
        if (shouldBeChecked) {
          (el as HTMLElement).click();
        }
      }

      if (shouldBeChecked) {
        this.highlightOption('scaler_active_mcq', [i]);
        const badge = el.querySelector('.saab-suggested-badge');
        if (badge) {
          badge.textContent = '✅ Auto-Selected';
          (badge as HTMLElement).style.background = 'rgba(16, 185, 129, 0.2)';
          (badge as HTMLElement).style.color = '#34d399';
        }
        anySelected = true;
      }
    });

    return anySelected;
  }

  agreeHonorCode(): boolean {
    // Scaler does not require a separate honor code checkbox
    return true;
  }

  submitAssessment(): boolean {
    if (typeof document === 'undefined') return false;
    const submitBtn = document.querySelector(
      '.cr-judge-action--submit, button[class*="submit"], .cr-multiple-choice-container__submit-btn'
    ) as HTMLButtonElement | null;

    if (submitBtn) {
      if (submitBtn.disabled) return false;
      submitBtn.click();
      return true;
    }
    return false;
  }

  getPageMetadata(): PlatformMetadata {
    const heading = document.querySelector('.cr-p-heading, .cr-p-heading__text');
    return {
      title: heading?.textContent?.trim() || document.title || 'Scaler Problem',
      activity: 'MCQ Practice / Assignment',
      url: window.location.href
    };
  }
}
