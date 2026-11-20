import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testGeminiApiKey, analyzeQuestionWithGemini } from '../src/services/gemini';
import { ExtractedQuestion } from '../src/types';

describe('gemini service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('testGeminiApiKey', () => {
    it('rejects empty API keys immediately', async () => {
      const res = await testGeminiApiKey('   ');
      expect(res.success).toBe(false);
      expect(res.message).toContain('API key cannot be empty');
    });

    it('returns success when API responds with 200 OK', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'OK' }] } }]
        })
      } as any);

      const res = await testGeminiApiKey('AIzaSyValidKey');
      expect(res.success).toBe(true);
      expect(res.message).toContain('verified successfully');
    });

    it('handles HTTP 429 rate limit errors gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Resource has been exhausted' } })
      } as any);

      const res = await testGeminiApiKey('AIzaSyKey');
      expect(res.success).toBe(false);
      expect(res.message).toContain('quota or rate limit exceeded');
    });

    it('handles HTTP 403 invalid key errors gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'API_KEY_INVALID' } })
      } as any);

      const res = await testGeminiApiKey('AIzaSyBadKey');
      expect(res.success).toBe(false);
      expect(res.message).toContain('Invalid API key');
    });
  });

  describe('analyzeQuestionWithGemini', () => {
    const question: ExtractedQuestion = {
      id: 'q_test_1',
      prompt: 'Which network protocol guarantees ordered packet delivery?',
      options: [
        { id: 'o0', index: 0, text: 'UDP' },
        { id: 'o1', index: 1, text: 'TCP' },
        { id: 'o2', index: 2, text: 'IP' }
      ],
      isMultiSelect: false,
      questionType: 'single_choice'
    };

    it('throws if API key is missing', async () => {
      await expect(analyzeQuestionWithGemini(question, '')).rejects.toThrow('Gemini API key is not configured');
    });

    it('parses valid AI JSON and maps selected indices', async () => {
      const aiResponseJson = JSON.stringify({
        selectedIndices: [1],
        confidence: 0.98,
        explanation: 'TCP uses sequence numbers and ACKs to guarantee reliable, ordered delivery.'
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: aiResponseJson }] } }]
        })
      } as any);

      const result = await analyzeQuestionWithGemini(question, 'AIzaSyTestKey');
      expect(result.suggestedIndices).toEqual([1]);
      expect(result.suggestedAnswers).toEqual(['TCP']);
      expect(result.confidence).toBe(0.98);
      expect(result.explanation).toContain('TCP uses sequence numbers');
    });

    it('automatically falls back to next model when primary model hits high demand (503)', async () => {
      const fallbackAiResponseJson = JSON.stringify({
        selectedIndices: [1],
        confidence: 0.99,
        explanation: 'TCP guarantees ordered delivery through sequence numbers.'
      });

      // First call (gemini-2.5-flash) returns 503 high demand
      // Second call (gemini-3.5-flash-lite) succeeds
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({
            error: { message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.' }
          })
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: fallbackAiResponseJson }] } }]
          })
        } as any);

      const result = await analyzeQuestionWithGemini(question, 'AIzaSyTestKey', 'gemini-2.5-flash');
      expect(result.suggestedIndices).toEqual([1]);
      expect(result.suggestedAnswers).toEqual(['TCP']);
      expect(result.model).toBe('gemini-3.5-flash-lite');
      expect(result.confidence).toBe(0.99);
    });
  });
});
