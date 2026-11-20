/**
 * gemini.ts
 * Client-side BYOK (Bring Your Own Key) Gemini service.
 * Makes direct requests to the Google Generative Language API without a backend.
 */

import { ExtractedQuestion, AiAnalysisResult } from '../types';

export const SUPPORTED_MODELS = [
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (Recommended - High Quota & Fast)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (SOTA Agents & Software Engineering)' },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen (Flagship 1M Context & Multimodal)' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite (High Limits Fallback)' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Deprecated / Auto-reroutes)' }
];

export async function testGeminiApiKey(
  apiKey: string,
  modelName: string = 'gemini-3.5-flash-lite'
): Promise<{ success: boolean; message: string }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    return { success: false, message: 'API key cannot be empty.' };
  }

  const modelsToTest = Array.from(new Set([modelName, 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-hydrogen']));

  let lastError = '';
  for (let i = 0; i < modelsToTest.length; i++) {
    const currentModel = modelsToTest[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${cleanKey}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Respond with the single word "OK" to verify API connection.' }]
            }
          ],
          generationConfig: {
            maxOutputTokens: 10,
            temperature: 0.1
          }
        })
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const fallbackNote = currentModel !== modelName ? ` (tested via ${currentModel} as ${modelName} was busy)` : '';
        return { success: true, message: `Gemini API key verified successfully!${fallbackNote}` };
      }

      const errData = await res.json().catch(() => ({}));
      const rawMsg = errData?.error?.message || `HTTP ${res.status} ${res.statusText}`;

      if (res.status === 400 || res.status === 403) {
        return { success: false, message: 'Invalid API key or insufficient permissions for Generative Language API.' };
      }

      // If high demand (503) or rate limit (429), try next model candidate if available
      if ((res.status === 503 || res.status === 429 || rawMsg.toLowerCase().includes('demand')) && i < modelsToTest.length - 1) {
        lastError = rawMsg;
        continue;
      }

      if (res.status === 429) {
        return { success: false, message: 'Gemini quota or rate limit exceeded for this key. Try again in a minute.' };
      }

      return { success: false, message: `Verification failed: ${rawMsg}` };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (i < modelsToTest.length - 1) continue;
        return { success: false, message: 'Connection timed out while verifying API key.' };
      }
      if (i < modelsToTest.length - 1) continue;
      return { success: false, message: `Network error: ${err.message || 'Could not connect to Google API.'}` };
    }
  }

  return { success: false, message: `Verification failed: ${lastError || 'Service temporarily unavailable.'}` };
}

/**
 * Solves or analyzes a question using the user's Gemini API key.
 * Automatically fails over to stable fallback models if the primary model experiences high demand or rate limits.
 */
export async function analyzeQuestionWithGemini(
  question: ExtractedQuestion,
  apiKey: string,
  modelName: string = 'gemini-3.5-flash-lite'
): Promise<AiAnalysisResult> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('Gemini API key is not configured. Please add your key in the extension settings.');
  }

  const optionsList = question.options
    .map((o) => `[Option ${o.index}]: ${o.text}`)
    .join('\n');

  const promptText = `You are an academic expert assistant for computer science and engineering coursework.
Analyze the following university quiz question and determine the verified correct option(s).

QUESTION:
${question.prompt}

OPTIONS:
${optionsList}

QUESTION TYPE: ${question.isMultiSelect ? 'Multiple Correct (Check all that apply)' : 'Single Correct'}

TASK:
1. Identify the exact correct option index or indices (0-indexed).
2. Explain the conceptual justification clearly and concisely.

Return ONLY a valid JSON object matching this schema:
{
  "selectedIndices": [0],
  "confidence": 0.95,
  "explanation": "Brief explanation of why this answer is correct."
}
Do NOT wrap your response in markdown code blocks or additional text. Return strictly raw JSON.`;

  // Priority pool of fallback models: user's model first, followed by active SOTA 2026 models
  const candidateModels = Array.from(
    new Set([
      modelName,
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-4-hydrogen',
      'gemini-3.1-flash-lite'
    ])
  );

  let lastError: Error | null = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const activeModel = candidateModels[mIdx];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${cleanKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: promptText }]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson?.error?.message || `HTTP ${res.status}`;

        // Unrecoverable authentication error — stop immediately
        if (res.status === 400 || res.status === 403) {
          throw new Error(`Gemini authentication error: ${msg}`);
        }

        const isTransient =
          res.status === 503 ||
          res.status === 429 ||
          res.status === 500 ||
          msg.toLowerCase().includes('demand') ||
          msg.toLowerCase().includes('exhausted') ||
          msg.toLowerCase().includes('overloaded');

        if (isTransient && mIdx < candidateModels.length - 1) {
          console.warn(`[Gemini BYOK] Model "${activeModel}" had transient error (${msg}). Failing over to "${candidateModels[mIdx + 1]}"...`);
          lastError = new Error(`Gemini request failed on ${activeModel}: ${msg}`);
          continue;
        }

        if (res.status === 429) {
          throw new Error('Gemini API quota exceeded. Please wait a moment or check your Google AI Studio plan.');
        }
        throw new Error(`Gemini request failed: ${msg}`);
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

      let parsed: any = null;
      try {
        const firstBrace = rawText.indexOf('{');
        const lastBrace = rawText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          parsed = JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
        } else {
          parsed = JSON.parse(rawText);
        }
      } catch (parseErr) {
        throw new Error(`Failed to parse AI response JSON: ${rawText.slice(0, 100)}...`);
      }

      const rawIndices = Array.isArray(parsed?.selectedIndices)
        ? parsed.selectedIndices
        : [parsed?.selectedOption ?? parsed?.bestOptionIndex ?? 0];

      const validIndices = rawIndices
        .map(Number)
        .filter((idx: number) => !isNaN(idx) && idx >= 0 && idx < question.options.length);

      const finalIndices = question.isMultiSelect ? validIndices : [validIndices[0] ?? 0];
      const answers = finalIndices.map((i: number) => question.options[i]?.text || '');

      return {
        suggestedIndices: finalIndices,
        suggestedAnswers: answers,
        explanation: parsed?.explanation || 'Identified via conceptual analysis.',
        confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.90,
        model: activeModel,
        timestamp: Date.now()
      };
    } catch (err: any) {
      clearTimeout(timeoutId);

      // If it was an auth error or unrecoverable error, rethrow
      if (err.message && err.message.includes('authentication error')) {
        throw err;
      }

      if (err.name === 'AbortError') {
        if (mIdx < candidateModels.length - 1) {
          console.warn(`[Gemini BYOK] Model "${activeModel}" timed out. Failing over to "${candidateModels[mIdx + 1]}"...`);
          lastError = new Error(`Gemini analysis timed out on ${activeModel}.`);
          continue;
        }
        throw new Error('Gemini analysis timed out after multiple attempts.');
      }

      // If we have more models in the fallback pool, try the next one
      if (mIdx < candidateModels.length - 1) {
        console.warn(`[Gemini BYOK] Model "${activeModel}" failed (${err.message}). Failing over to "${candidateModels[mIdx + 1]}"...`);
        lastError = err;
        continue;
      }

      throw lastError || err;
    }
  }

  throw lastError || new Error('All Gemini candidate models failed to respond.');
}
