import { describe, it, expect } from 'vitest';
import { normalizeText, computeSimilarity, matchQuestion } from '../src/core/answer-matcher';
import { ExtractedQuestion, ReferenceAnswer } from '../src/types';

describe('answer-matcher core engine', () => {
  describe('normalizeText', () => {
    it('strips html tags, markdown checkboxes, and option numbering', () => {
      const raw = '<p>[x] 1. What does the <b>backtrace()</b> function do?</p>';
      expect(normalizeText(raw)).toBe('what does the backtrace function do');
    });

    it('collapses excessive whitespace and strips punctuation', () => {
      const raw = '  TCP / IP    Stack:    Reliable... Transport!  ';
      expect(normalizeText(raw)).toBe('tcp ip stack reliable transport');
    });
  });

  describe('diceCoefficient & computeSimilarity', () => {
    it('returns 1.0 for identical strings', () => {
      expect(computeSimilarity('Shared Memory', 'Shared Memory')).toBe(1.0);
    });

    it('returns high similarity for minor punctuation or casing variations', () => {
      const sim = computeSimilarity(
        'UDP is connectionless and does not guarantee delivery.',
        'UDP is connectionless, and does not guarantee delivery'
      );
      expect(sim).toBeGreaterThan(0.9);
    });

    it('returns low score for completely unrelated questions', () => {
      const sim = computeSimilarity(
        'What is a relational database index?',
        'How does TLS 1.3 handshake exchange session tickets?'
      );
      expect(sim).toBeLessThan(0.3);
    });
  });

  describe('matchQuestion against reference knowledge base', () => {
    const references: ReferenceAnswer[] = [
      {
        id: 'ref1',
        platform: 'coursera',
        prompt: 'What does the backtrace() function do in the program?',
        correctAnswers: ['Prints the call stack of functions'],
        source: 'MD-Week-7-8.pdf'
      },
      {
        id: 'ref2',
        platform: 'coursera',
        prompt: 'Which of the following are scalable distributed storage architectures?',
        correctAnswers: ['Data Lake', 'Lakehouse architecture'],
        source: 'MD-Week-9-10.json'
      }
    ];

    it('matches an exact prompt and maps to the correct option index', () => {
      const liveQ: ExtractedQuestion = {
        id: 'q1',
        prompt: 'What does the backtrace() function do in the program?',
        options: [
          { id: 'opt0', index: 0, text: 'Terminates memory allocation' },
          { id: 'opt1', index: 1, text: 'Prints the call stack of functions' },
          { id: 'opt2', index: 2, text: 'Resets the CPU cache' }
        ],
        isMultiSelect: false,
        questionType: 'single_choice'
      };

      const match = matchQuestion(liveQ, references);
      expect(match).not.toBeNull();
      expect(match?.matched).toBe(true);
      expect(match?.selectedIndices).toEqual([1]);
      expect(match?.confidence).toBeGreaterThanOrEqual(0.95);
      expect(match?.matchType).toBe('exact');
    });

    it('handles scrambled multi-select options accurately', () => {
      const liveQ: ExtractedQuestion = {
        id: 'q2',
        prompt: 'Which of the following are scalable distributed storage architectures?',
        options: [
          { id: 'opt0', index: 0, text: 'Local FAT32 partition' },
          { id: 'opt1', index: 1, text: 'Lakehouse architecture' }, // verified answer 2
          { id: 'opt2', index: 2, text: 'Data Lake' }, // verified answer 1
          { id: 'opt3', index: 3, text: 'Single floppy disk' }
        ],
        isMultiSelect: true,
        questionType: 'multiple_choice'
      };

      const match = matchQuestion(liveQ, references);
      expect(match).not.toBeNull();
      expect(match?.matched).toBe(true);
      // Both option indices 1 and 2 must be identified regardless of scrambled order
      expect(match?.selectedIndices).toContain(1);
      expect(match?.selectedIndices).toContain(2);
      expect(match?.selectedIndices.length).toBe(2);
    });

    it('falls back to option match if prompt has minor rephrasing', () => {
      const liveQ: ExtractedQuestion = {
        id: 'q3',
        prompt: 'In our C/C++ program execution, what is the role of backtrace()?',
        options: [
          { id: 'opt0', index: 0, text: 'Prints the call stack of functions' },
          { id: 'opt1', index: 1, text: 'Allocates heap memory' }
        ],
        isMultiSelect: false,
        questionType: 'single_choice'
      };

      const match = matchQuestion(liveQ, references);
      expect(match).not.toBeNull();
      expect(match?.matched).toBe(true);
      expect(match?.selectedIndices).toEqual([0]);
    });
  });
});
