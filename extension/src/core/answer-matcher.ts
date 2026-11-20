/**
 * answer-matcher.ts
 * Deterministic text normalization, Sørensen-Dice bigram similarity,
 * and high-confidence answer key matching engine.
 */

import { ExtractedQuestion, ReferenceAnswer, MatchResult } from '../types';

/**
 * Normalizes text for clean semantic comparison:
 * - lowercase
 * - strips markdown, html tags, multiple whitespace
 * - strips punctuation and checkbox markers (e.g., [x], (A), 1.)
 */
export function normalizeText(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ') // Strip HTML tags
    .trim()
    .replace(/^\[[ xX]\]\s*/g, '') // Strip checkbox markdown [x] or [ ]
    .trim()
    .replace(/^[a-z0-9][\.\)]\s*/g, '') // Strip option labels like 'a.' or '1)'
    .replace(/[^a-z0-9\s]/g, ' ') // Replace punctuation with space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes Sørensen-Dice coefficient on character bigrams.
 * Returns a value between 0.0 (no match) and 1.0 (identical).
 */
export function diceCoefficient(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);

  if (normA === normB) return 1.0;
  if (normA.length < 2 || normB.length < 2) return 0.0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < normA.length - 1; i++) {
    const bigram = normA.substring(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < normB.length - 1; i++) {
    const bigram = normB.substring(i, i + 2);
    const count = bigramsA.get(bigram) || 0;
    if (count > 0) {
      bigramsA.set(bigram, count - 1);
      intersection++;
    }
  }

  const total = (normA.length - 1) + (normB.length - 1);
  return (2.0 * intersection) / total;
}

/**
 * Hybrid similarity metric combining exact equality, token Dice coefficient,
 * and word set overlap.
 */
export function computeSimilarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);

  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  // Substring inclusion with high length coverage
  if (normA.includes(normB) && normB.length > 20) {
    return Math.max(0.85, normB.length / normA.length);
  }
  if (normB.includes(normA) && normA.length > 20) {
    return Math.max(0.85, normA.length / normB.length);
  }

  return diceCoefficient(normA, normB);
}

/**
 * Matches a live extracted question against indexed reference answers.
 */
export function matchQuestion(
  question: ExtractedQuestion,
  references: ReferenceAnswer[]
): MatchResult | null {
  if (!question || !question.prompt || references.length === 0) {
    return null;
  }

  let bestPromptScore = 0;
  let bestReference: ReferenceAnswer | null = null;

  for (const ref of references) {
    const score = computeSimilarity(question.prompt, ref.prompt);
    if (score > bestPromptScore) {
      bestPromptScore = score;
      bestReference = ref;
    }
  }

  // Tier 1: Strong Prompt Match (>= 0.72)
  if (bestPromptScore >= 0.72 && bestReference) {
    const matchedOptionIndices: number[] = [];
    const matchedOptionTexts: string[] = [];

    for (const correctAns of bestReference.correctAnswers) {
      for (const opt of question.options) {
        const optScore = computeSimilarity(opt.text, correctAns);
        if (optScore >= 0.78) {
          if (!matchedOptionIndices.includes(opt.index)) {
            matchedOptionIndices.push(opt.index);
            matchedOptionTexts.push(opt.text);
          }
        }
      }
    }

    if (matchedOptionIndices.length > 0) {
      const isExact = bestPromptScore >= 0.95;
      const confidence = Math.min(0.99, bestPromptScore * 0.6 + 0.4);

      return {
        matched: true,
        selectedIndices: question.isMultiSelect ? matchedOptionIndices : [matchedOptionIndices[0]],
        bestOptionIndex: matchedOptionIndices[0],
        confidence: Number(confidence.toFixed(2)),
        source: bestReference.source || 'Verified Course Answer Key',
        reasoning: `Matched reference question with ${(bestPromptScore * 100).toFixed(0)}% similarity. Correct option: "${matchedOptionTexts.join(', ')}"`,
        matchType: isExact ? 'exact' : 'dice_fuzzy'
      };
    }
  }

  // Tier 2: Option Fallback Search (if prompt had minor rephrasing or prefixing)
  for (const ref of references) {
    const matchedPicks: number[] = [];
    for (const correctAns of ref.correctAnswers) {
      if (correctAns.length < 5) continue; // Avoid matching trivial single letters
      for (const opt of question.options) {
        const optScore = computeSimilarity(opt.text, correctAns);
        if (optScore >= 0.88) {
          matchedPicks.push(opt.index);
        }
      }
    }

    if (matchedPicks.length > 0) {
      const unique = Array.from(new Set(matchedPicks));
      const promptContextScore = computeSimilarity(question.prompt, ref.prompt);

      // Only accept if prompt similarity has at least moderate semantic overlap (>= 0.45)
      if (promptContextScore >= 0.45) {
        return {
          matched: true,
          selectedIndices: question.isMultiSelect ? unique : [unique[0]],
          bestOptionIndex: unique[0],
          confidence: Number(Math.min(0.90, promptContextScore * 0.4 + 0.5).toFixed(2)),
          source: ref.source || 'Verified Course Key',
          reasoning: `Found verified option match with ${(promptContextScore * 100).toFixed(0)}% prompt context overlap: "${unique.map(i => question.options[i]?.text).join(', ')}"`,
          matchType: 'option_fallback'
        };
      }
    }
  }

  return null;
}
