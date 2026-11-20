import { describe, it, expect, beforeEach } from 'vitest';
import { CourseraAdapter } from '../src/adapters/coursera-adapter';
import { ScalerAdapter } from '../src/adapters/scaler-adapter';
import { adapterRegistry } from '../src/adapters/adapter-registry';

describe('platform adapters', () => {
  describe('CourseraAdapter', () => {
    const adapter = new CourseraAdapter();

    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('identifies coursera URLs correctly', () => {
      expect(adapter.isMatchingUrl('https://www.coursera.org/learn/modern-databases/exam/abc')).toBe(true);
      expect(adapter.isMatchingUrl('https://www.scaler.com/problems/find-duplicate')).toBe(false);
    });

    it('extracts Coursera assessment question and options from DOM', () => {
      document.body.innerHTML = `
        <div data-testid="part-Submission_part1" id="part-Submission_part1">
          <div data-testid="part-points">1 / 1 point</div>
          <div data-testid="legend">
            <div data-testid="cml-viewer" class="rc-CML">What is a transaction deadlock in DBMS?</div>
          </div>
          <div class="rc-Option">
            <label class="cds-checkboxAndRadio-labelText">
              <input type="radio" name="q1" value="0" /> A cycle of waiting for locks between transactions
            </label>
          </div>
          <div class="rc-Option">
            <label class="cds-checkboxAndRadio-labelText">
              <input type="radio" name="q1" value="1" /> Excessive memory usage during query planning
            </label>
          </div>
        </div>
      `;

      const questions = adapter.extractQuestions();
      expect(questions.length).toBe(1);
      expect(questions[0].prompt).toBe('What is a transaction deadlock in DBMS?');
      expect(questions[0].options.length).toBe(2);
      expect(questions[0].options[0].text).toContain('A cycle of waiting for locks between transactions');
      expect(questions[0].isMultiSelect).toBe(false);
      expect(questions[0].points).toBe('1 / 1 point');
    });

    it('detects checkbox inputs as multi-select', () => {
      document.body.innerHTML = `
        <div data-testid="part-Submission_part2" id="part-Submission_part2">
          <div data-testid="legend"><div class="rc-CML">Select all valid ACID properties:</div></div>
          <div class="rc-Option"><label><input type="checkbox" /> Atomicity</label></div>
          <div class="rc-Option"><label><input type="checkbox" /> Consistency</label></div>
          <div class="rc-Option"><label><input type="checkbox" /> Speed</label></div>
        </div>
      `;

      const questions = adapter.extractQuestions();
      expect(questions[0].isMultiSelect).toBe(true);
      expect(questions[0].questionType).toBe('multiple_choice');
    });

    it('applies non-destructive highlight and badge to suggested options', () => {
      document.body.innerHTML = `
        <div data-testid="part-Submission_part1" id="part-Submission_part1">
          <div class="rc-Option"><label><input type="radio" /> Alpha</label></div>
          <div class="rc-Option"><label><input type="radio" /> Beta</label></div>
        </div>
      `;

      const highlighted = adapter.highlightOption('part-Submission_part1', [1]);
      expect(highlighted).toBe(true);

      const targetOpt = document.querySelectorAll('.rc-Option')[1] as HTMLElement;
      expect(targetOpt.getAttribute('data-saab-highlight')).toBe('part-Submission_part1');
      expect(targetOpt.querySelector('.saab-suggested-badge')).not.toBeNull();
    });

    it('selects options and clicks input elements in the DOM', () => {
      document.body.innerHTML = `
        <div data-testid="part-Submission_part1" id="part-Submission_part1">
          <div class="rc-Option"><label><input type="radio" name="opt" /> Alpha</label></div>
          <div class="rc-Option"><label><input type="radio" name="opt" /> Beta</label></div>
        </div>
      `;

      const selected = adapter.selectOptions('part-Submission_part1', [1]);
      expect(selected).toBe(true);

      const input = document.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement;
      expect(input.checked).toBe(true);
    });

    it('checks Coursera honor code agreement checkbox', () => {
      document.body.innerHTML = `
        <div data-testid="HonorCodeAgreement">
          <input type="checkbox" id="agreement-checkbox-base" />
        </div>
      `;

      const agreed = adapter.agreeHonorCode();
      expect(agreed).toBe(true);
      const checkbox = document.getElementById('agreement-checkbox-base') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });

    it('clicks Coursera submit button when enabled', () => {
      document.body.innerHTML = `
        <button data-testid="submit-button">Submit assignment</button>
      `;

      let clicked = false;
      document.querySelector('button')!.addEventListener('click', () => {
        clicked = true;
      });

      const submitted = adapter.submitAssessment();
      expect(submitted).toBe(true);
      expect(clicked).toBe(true);
    });
  });

  describe('ScalerAdapter', () => {
    const adapter = new ScalerAdapter();

    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('identifies Scaler URLs correctly', () => {
      expect(adapter.isMatchingUrl('https://www.scaler.com/academy/mentee-dashboard/class/123')).toBe(true);
      expect(adapter.isMatchingUrl('https://www.coursera.org')).toBe(false);
    });

    it('extracts Scaler problem statement and MCQ options', () => {
      document.body.innerHTML = `
        <div class="cr-p-statement">
          What is the average time complexity of searching in a balanced Binary Search Tree?
        </div>
        <div class="cr-multiple-choice-container__hint-chip">2 Attempts Left</div>
        <div class="cr-multiple-choice">
          <div class="cr-multiple-choice__label">O(N)</div>
        </div>
        <div class="cr-multiple-choice">
          <div class="cr-multiple-choice__label">O(log N)</div>
        </div>
        <div class="cr-multiple-choice">
          <div class="cr-multiple-choice__label">O(1)</div>
        </div>
      `;

      const questions = adapter.extractQuestions();
      expect(questions.length).toBe(1);
      expect(questions[0].prompt).toContain('What is the average time complexity');
      expect(questions[0].options.length).toBe(3);
      expect(questions[0].options[1].text).toBe('O(log N)');
      expect(questions[0].points).toBe('2 Attempts Left');
    });

    it('highlights suggested option on Scaler DOM non-destructively', () => {
      document.body.innerHTML = `
        <div class="cr-multiple-choice"><div class="cr-multiple-choice__label">Option A</div></div>
        <div class="cr-multiple-choice"><div class="cr-multiple-choice__label">Option B</div></div>
      `;

      const success = adapter.highlightOption('scaler_active_mcq', [0]);
      expect(success).toBe(true);

      const target = document.querySelectorAll('.cr-multiple-choice')[0] as HTMLElement;
      expect(target.getAttribute('data-saab-highlight')).toBe('scaler');
      expect(target.querySelector('.saab-suggested-badge')).not.toBeNull();
    });
  });

  describe('AdapterRegistry', () => {
    it('resolves correct adapter by URL', () => {
      const coursera = adapterRegistry.getAdapterForUrl('https://www.coursera.org/learn/bits');
      expect(coursera?.platform).toBe('coursera');

      const scaler = adapterRegistry.getAdapterForUrl('https://www.scaler.com/problems/test');
      expect(scaler?.platform).toBe('scaler');

      const unknown = adapterRegistry.getAdapterForUrl('https://google.com');
      expect(unknown).toBeNull();
    });
  });
});
