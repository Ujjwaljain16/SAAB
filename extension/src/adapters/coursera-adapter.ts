/**
 * coursera-adapter.ts
 * Adapter for BITS Pilani BSc and general Coursera quizzes and exams.
 */

import { PlatformAdapter, PlatformMetadata } from './platform-interface';
import { ExtractedQuestion, ExtractedOption, PlatformType } from '../types';

export class CourseraAdapter implements PlatformAdapter {
  readonly platform: PlatformType = 'coursera';
  readonly name = 'BITS Pilani / Coursera';

  isMatchingUrl(url: string): boolean {
    return url.includes('coursera.org');
  }

  isSupportedPage(): boolean {
    if (typeof document === 'undefined') return false;
    const hasQuestions =
      document.querySelectorAll('div[data-testid^="part-Submission_"], div[class*="part-Submission_"]').length > 0 ||
      document.querySelectorAll('.rc-Option').length > 0;
    const isQuizUrl =
      window.location.href.includes('/exam/') ||
      window.location.href.includes('/quiz/') ||
      window.location.href.includes('/assignment-submission/') ||
      window.location.href.includes('/team/');
    return hasQuestions || isQuizUrl;
  }

  extractQuestions(): ExtractedQuestion[] {
    if (typeof document === 'undefined') return [];

    const containers = Array.from(
      document.querySelectorAll('div[data-testid^="part-Submission_"], div[class*="part-Submission_"]')
    );

    // Fallback: If containers not found with data-testid, group by .rc-Option parents
    if (containers.length === 0) {
      const options = Array.from(document.querySelectorAll('.rc-Option'));
      if (options.length === 0) return [];

      const parentSet = new Set<Element>();
      options.forEach((opt) => {
        const parent = opt.closest('fieldset, form, div[role="radiogroup"], div[role="group"]');
        if (parent) parentSet.add(parent);
      });

      return Array.from(parentSet).map((parent, idx) =>
        this.parseQuestionContainer(parent, `c_fallback_${idx + 1}`, idx + 1)
      );
    }

    return containers.map((c, idx) => this.parseQuestionContainer(c, c.id || `c_part_${idx + 1}`, idx + 1));
  }

  private parseQuestionContainer(c: Element, id: string, number: number): ExtractedQuestion {
    // 1. Points
    const pointsEl = c.querySelector('[data-testid="part-points"]');
    const points = pointsEl?.textContent?.trim() || '';

    // 2. Prompt extraction
    const legendEl = c.querySelector('[data-testid="legend"], div[id$="-legend"]');
    const cmlEl = (legendEl || c).querySelector('[data-testid="cml-viewer"], .rc-CML') || legendEl;

    let rawPrompt = (cmlEl || legendEl)?.textContent?.trim() || '';
    if (!rawPrompt) {
      const heading = c.querySelector('h1, h2, h3, h4, [role="heading"], legend');
      rawPrompt = heading?.textContent?.trim() || '';
    }

    // Clean up prompt prefix (e.g. "1. Question 1" -> "Question 1")
    const cleanPrompt = rawPrompt.replace(/^\d+[\.\)]\s*/, '').trim();

    // 3. Options extraction
    const optionEls = Array.from(c.querySelectorAll('.rc-Option'));
    let isMultiSelect = false;

    const options: ExtractedOption[] = optionEls.map((optEl, i) => {
      const inputEl = optEl.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
      if (inputEl?.type === 'checkbox') {
        isMultiSelect = true;
      }

      const labelEl = optEl.querySelector('.cds-checkboxAndRadio-labelText, [data-testid="cml-viewer"], label');
      const text = labelEl?.textContent?.trim() || optEl.textContent?.trim() || `Option ${i + 1}`;

      return {
        id: `${id}_opt_${i}`,
        index: i,
        text,
        isSelected: inputEl?.checked || false
      };
    });

    return {
      id,
      number,
      prompt: cleanPrompt,
      options,
      isMultiSelect,
      questionType: isMultiSelect ? 'multiple_choice' : 'single_choice',
      points
    };
  }

  highlightOption(questionId: string, optionIndices: number[]): boolean {
    if (typeof document === 'undefined') return false;

    // Remove previous highlights for this question
    const prevHighlights = document.querySelectorAll(`[data-saab-highlight="${questionId}"]`);
    prevHighlights.forEach((el) => {
      el.removeAttribute('data-saab-highlight');
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.backgroundColor = '';
      const badge = el.querySelector('.saab-suggested-badge');
      badge?.remove();
    });

    // Locate question container
    let container = document.getElementById(questionId) as HTMLElement | null;
    if (!container) {
      const parts = Array.from(
        document.querySelectorAll('div[data-testid^="part-Submission_"], div[class*="part-Submission_"]')
      );
      container = (parts.find((p) => p.id === questionId) as HTMLElement | null) || null;
    }

    if (!container) return false;

    const optionEls = Array.from(container.querySelectorAll('.rc-Option'));
    let anyHighlighted = false;

    for (const idx of optionIndices) {
      const targetOpt = optionEls[idx] as HTMLElement;
      if (targetOpt) {
        targetOpt.setAttribute('data-saab-highlight', questionId);
        targetOpt.style.outline = '2px solid #8b5cf6';
        targetOpt.style.outlineOffset = '2px';
        targetOpt.style.backgroundColor = 'rgba(139, 92, 246, 0.08)';
        targetOpt.style.borderRadius = '6px';
        targetOpt.style.transition = 'all 0.2s ease-in-out';

        // Add non-intrusive suggested badge
        if (!targetOpt.querySelector('.saab-suggested-badge')) {
          const badge = document.createElement('span');
          badge.className = 'saab-suggested-badge';
          badge.textContent = '✨ Suggested Answer';
          badge.style.display = 'inline-block';
          badge.style.marginLeft = '8px';
          badge.style.padding = '2px 8px';
          badge.style.fontSize = '11px';
          badge.style.fontWeight = '600';
          badge.style.color = '#8b5cf6';
          badge.style.background = 'rgba(139, 92, 246, 0.15)';
          badge.style.borderRadius = '12px';
          targetOpt.appendChild(badge);
        }

        anyHighlighted = true;
      }
    }

    return anyHighlighted;
  }

  selectOptions(questionId: string, optionIndices: number[]): boolean {
    if (typeof document === 'undefined') return false;

    let container = document.getElementById(questionId) as HTMLElement | null;
    if (!container) {
      const parts = Array.from(
        document.querySelectorAll('div[data-testid^="part-Submission_"], div[class*="part-Submission_"]')
      );
      container = (parts.find((p) => p.id === questionId) as HTMLElement | null) || null;
    }
    if (!container) return false;

    const optionEls = Array.from(container.querySelectorAll('.rc-Option'));
    let anySelected = false;

    optionEls.forEach((optEl, i) => {
      const inputEl = optEl.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
      const shouldBeChecked = optionIndices.includes(i);

      if (inputEl) {
        if (inputEl.checked !== shouldBeChecked) {
          inputEl.click();
          inputEl.checked = shouldBeChecked;
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          const label = inputEl.closest('label') || optEl;
          if (label && label !== inputEl) (label as HTMLElement).click();
        }
      } else {
        if (shouldBeChecked) {
          (optEl as HTMLElement).click();
        }
      }

      if (shouldBeChecked) {
        this.highlightOption(questionId, [i]);
        const badge = optEl.querySelector('.saab-suggested-badge');
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
    if (typeof document === 'undefined') return false;
    const checkbox = document.querySelector(
      '#agreement-checkbox-base, [data-testid="agreement-checkbox"] input, [data-testid="agreement-standalone-checkbox"] input'
    ) as HTMLInputElement | null;

    if (checkbox) {
      if (!checkbox.checked) {
        checkbox.click();
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
    return false;
  }

  submitAssessment(): boolean {
    if (typeof document === 'undefined') return false;
    const submitBtn = document.querySelector('button[data-testid="submit-button"]') as HTMLButtonElement | null;
    if (submitBtn) {
      if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') {
        console.warn('[CourseraAdapter] Submit button is currently disabled.');
        return false;
      }
      submitBtn.click();

      setTimeout(() => {
        const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
          /submit|yes,\s*submit|confirm/i.test(b.textContent || '')
        );
        if (confirmBtn && confirmBtn !== submitBtn) {
          confirmBtn.click();
        }
      }, 500);

      return true;
    }
    return false;
  }

  getPageMetadata(): PlatformMetadata {
    return {
      title: document.title || 'Coursera Quiz',
      activity: 'Graded Assessment',
      url: window.location.href
    };
  }
}
