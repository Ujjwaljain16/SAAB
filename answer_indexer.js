// answer_indexer.js — High-precision PDF, JSON, and text quiz answer key ingestion and matching engine

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import 'dotenv/config';

/**
 * Normalizes text for robust semantic comparison (strips punctuation, trims, lowercases)
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes Dice token similarity coefficient between two strings (0.0 to 1.0)
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function computeTextSimilarity(a, b) {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;
  if (normA.includes(normB) || normB.includes(normA)) return 0.95;

  const tokensA = new Set(normA.split(' ').filter((w) => w.length > 2));
  const tokensB = new Set(normB.split(' ').filter((w) => w.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  return (2 * intersection) / (tokensA.size + tokensB.size);
}

/**
 * Parses raw text into question-answer pairs
 * @param {string} rawText
 * @param {string} sourceName
 * @returns {Array<{ prompt: string, options?: Array<string>, correctAnswers: Array<string>, source: string }>}
 */
export function parseQuizText(rawText, sourceName = 'document') {
  if (!rawText || typeof rawText !== 'string') return [];
  const items = [];

  // Split by Question markers: "Question 1", "Q1.", "1.", "1)", etc.
  const blocks = rawText.split(/(?:\r?\n)+(?=(?:Question\s*\d+|Q\s*\d+[.:)]|\d+[.)]\s+[A-Z]))/i);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length < 15) continue;

    // Extract prompt: usually the first sentence or lines before options
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let prompt = lines[0].replace(/^(?:Question\s*\d+[:.)]*|Q\s*\d+[:.)]*|\d+[.)]*)\s*/i, '').trim();

    // If first line was just "Question 1", prompt is the second line
    if (prompt.length < 5 && lines.length > 1) {
      prompt = lines[1];
    }

    const correctAnswers = [];

    // Look for explicit "Answer:" or "Correct:" lines
    const answerMatch = trimmed.match(/(?:Correct\s*Answer|Answer|Ans)\s*[:\s-]*([^\r\n]+)/i);
    if (answerMatch) {
      const ansLine = answerMatch[1].trim();
      correctAnswers.push(ansLine);
    }

    // Look for options marked with [x], (x), (Correct), ✓, *, etc.
    for (const line of lines) {
      if (/\([xX✓*]\)|\[[xX✓*]\]|(?:\(Correct\)|\[Correct\]|\bcorrect\b)/i.test(line)) {
        const cleanOption = line
          .replace(/^(?:\(|\[)?(?:[xX✓*]|Correct)(?:\)|\])?\s*/i, '')
          .replace(/^(?:\(|\[)?[A-Za-z0-9][.)\]\s-]+/, '')
          .replace(/\s*(?:\((?:Correct|x|X|✓|\*)\)|\[(?:Correct|x|X|✓|\*)\]|[✓*])\s*$/i, '')
          .trim();
        if (cleanOption) correctAnswers.push(cleanOption);
      }
    }

    if (prompt && (correctAnswers.length > 0 || answerMatch)) {
      items.push({
        prompt,
        correctAnswers: Array.from(new Set(correctAnswers)),
        source: sourceName
      });
    }
  }

  return items;
}

/**
 * Ingestion store for answer keys
 */
export class AnswerStore {
  constructor() {
    /** @type {Array<{ prompt: string, correctAnswers: Array<string>, source: string }>} */
    this.entries = [];
  }

  /**
   * Loads answers from a file (PDF, JSON, or TXT)
   * @param {string} filePath
   */
  async loadFile(filePath) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      console.warn(`[Answer Store] File not found: ${absPath}`);
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    const fileName = path.basename(absPath);

    if (ext === '.json') {
      try {
        const content = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        const newItems = [];
        if (Array.isArray(content)) {
          for (const item of content) {
            const prompt = item.prompt || item.question || item.title || '';
            const answers = Array.isArray(item.answer)
              ? item.answer
              : Array.isArray(item.correctAnswers)
              ? item.correctAnswers
              : [item.answer || item.correct || ''];
            if (prompt) {
              newItems.push({
                prompt,
                correctAnswers: answers.filter(Boolean).map(String),
                source: fileName
              });
            }
          }
        } else if (typeof content === 'object') {
          for (const [q, a] of Object.entries(content)) {
            newItems.push({
              prompt: q,
              correctAnswers: Array.isArray(a) ? a.map(String) : [String(a)],
              source: fileName
            });
          }
        }
        this.entries = this.entries.filter((e) => e.source !== fileName);
        this.entries.push(...newItems);
        console.log(`[Answer Store] Loaded ${newItems.length} question(s) from JSON: ${fileName}`);
      } catch (err) {
        console.error(`[Answer Store] Failed to parse JSON answer key: ${err.message}`);
      }
    } else if (ext === '.pdf') {
      try {
        const dataBuffer = fs.readFileSync(absPath);
        let rawText = '';

        try {
          const pdfParseModule = await import('pdf-parse');
          if (typeof pdfParseModule.default === 'function') {
            const res = await pdfParseModule.default(dataBuffer);
            rawText = res.text || '';
          } else if (pdfParseModule.PDFParse) {
            const uint8 = new Uint8Array(dataBuffer);
            const parser = new pdfParseModule.PDFParse(uint8);
            await parser.load();
            const res = await parser.getText();
            rawText = res?.text || (typeof res === 'string' ? res : '');
          } else if (typeof pdfParseModule === 'function') {
            const res = await pdfParseModule(dataBuffer);
            rawText = res.text || '';
          }
        } catch (pdfErr) {
          console.warn(`[Answer Store] Local PDF text extraction skipped for ${fileName}: ${pdfErr.message}`);
        }

        let parsedItems = parseQuizText(rawText, fileName);

        // Fallback: If 0 questions parsed (raster / screenshot PDF without text stream), use Gemini Multimodal OCR
        if (parsedItems.length === 0) {
          parsedItems = await this.extractWithGeminiVision(absPath, dataBuffer, fileName, 'application/pdf');
        }

        this.entries = this.entries.filter((e) => e.source !== fileName);
        this.entries.push(...parsedItems);
        console.log(`[Answer Store] Indexed ${parsedItems.length} answer-key question(s) from PDF: ${fileName}`);
      } catch (err) {
        console.error(`[Answer Store] Failed to read PDF ${fileName}: ${err.message}`);
      }
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      // Direct image / screenshot ingestion via Gemini Vision
      try {
        const dataBuffer = fs.readFileSync(absPath);
        const mimeType = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
        const parsedItems = await this.extractWithGeminiVision(absPath, dataBuffer, fileName, mimeType);
        this.entries = this.entries.filter((e) => e.source !== fileName);
        this.entries.push(...parsedItems);
        console.log(`[Answer Store] Indexed ${parsedItems.length} answer-key question(s) from Image: ${fileName}`);
      } catch (err) {
        console.error(`[Answer Store] Failed to read image ${fileName}: ${err.message}`);
      }
    } else {
      // Plain text or markdown
      try {
        const rawText = fs.readFileSync(absPath, 'utf8');
        const parsedItems = parseQuizText(rawText, fileName);
        this.entries = this.entries.filter((e) => e.source !== fileName);
        this.entries.push(...parsedItems);
        console.log(`[Answer Store] Extracted ${parsedItems.length} answer-key question(s) from TXT: ${fileName}`);
      } catch (err) {
        console.error(`[Answer Store] Failed to read text file ${fileName}: ${err.message}`);
      }
    }
  }

  /**
   * Multimodal Gemini OCR fallback for screenshot / image PDFs and image files
   * Caches results to disk (.solver-cache/pdf-ocr) by SHA256 hash.
   * @param {string} absPath
   * @param {Buffer} dataBuffer
   * @param {string} fileName
   * @param {string} [mimeType='application/pdf']
   * @returns {Promise<Array<{ prompt: string, correctAnswers: Array<string>, source: string }>>}
   */
  async extractWithGeminiVision(absPath, dataBuffer, fileName, mimeType = 'application/pdf') {
    const CACHE_DIR = path.resolve('.solver-cache', 'pdf-ocr');
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const fileHash = crypto.createHash('sha256').update(dataBuffer).digest('hex').slice(0, 16);
    const cacheFile = path.join(CACHE_DIR, `${fileHash}.json`);

    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (Array.isArray(cached) && cached.length > 0) {
          console.log(`[Answer Store] (OCR Cache Hit) Loaded ${cached.length} question(s) for ${fileName}`);
          return cached.map((item) => ({
            prompt: String(item.prompt || '').trim(),
            correctAnswers: Array.isArray(item.correctAnswers)
              ? item.correctAnswers.map(String)
              : [String(item.correctAnswers || '')].filter(Boolean),
            source: fileName
          }));
        }
      } catch {
        // Corrupt cache file, re-query
      }
    }

    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    const keys = rawKeys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (keys.length === 0) {
      console.warn(`[Answer Store] File "${fileName}" has no text stream and GEMINI_API_KEY is not set for OCR fallback.`);
      return [];
    }

    console.log(`[Answer Store] Running Gemini Multimodal extraction on "${fileName}"...`);

    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    for (const key of keys) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: modelName });

        const promptText =
          'Extract all quiz questions with their correct marked answers from this document. ' +
          'Return ONLY a valid JSON array of objects with keys: ' +
          '"prompt" (exact question text as a string) and "correctAnswers" (array of strings containing the exact text of correct/selected options). ' +
          'Format: [ { "prompt": "...", "correctAnswers": ["..."] } ] ' +
          'Do NOT wrap output in markdown fences or commentary.';

        const response = await model.generateContent([
          {
            inlineData: {
              data: dataBuffer.toString('base64'),
              mimeType
            }
          },
          promptText
        ]);

        let text = response.response.text().trim();
        let parsed = null;
        try {
          const firstBrace = text.indexOf('{');
          const firstBracket = text.indexOf('[');
          let startIdx = -1;
          let endIdx = -1;
          if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
            startIdx = firstBracket;
            endIdx = text.lastIndexOf(']');
          } else if (firstBrace !== -1) {
            startIdx = firstBrace;
            endIdx = text.lastIndexOf('}');
          }
          if (startIdx !== -1 && endIdx > startIdx) {
            parsed = JSON.parse(text.slice(startIdx, endIdx + 1));
          }
        } catch {
          parsed = null;
        }

        const rawList = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.questions) ? parsed.questions : (Array.isArray(parsed?.entries) ? parsed.entries : []));

        if (rawList.length > 0) {
          const items = rawList
            .map((item) => ({
              prompt: String(item.prompt || item.question || '').trim(),
              correctAnswers: Array.isArray(item.correctAnswers)
                ? item.correctAnswers.map(String)
                : (Array.isArray(item.answers) ? item.answers.map(String) : [String(item.correctAnswer || item.answer || '')].filter(Boolean)),
              source: fileName
            }))
            .filter((item) => item.prompt.length > 3 || item.correctAnswers.length > 0);

          try {
            fs.writeFileSync(cacheFile, JSON.stringify(items, null, 2), 'utf8');
          } catch (err) {
            console.warn(`[Answer Store] Failed to save OCR cache: ${err.message}`);
          }

          console.log(`[Answer Store] Gemini OCR extracted ${items.length} question(s) from "${fileName}"`);
          return items;
        }
      } catch (err) {
        console.warn(`[Answer Store] Gemini OCR attempt failed for ${fileName}: ${err.message}`);
      }
    }

    return [];
  }

  /**
   * Auto-scans an answers directory if present
   * @param {string} dirPath
   */
  async loadDirectory(dirPath = 'answers') {
    const absDir = path.resolve(dirPath);
    if (!fs.existsSync(absDir)) return;
    const files = fs.readdirSync(absDir);
    for (const file of files) {
      const full = path.join(absDir, file);
      if (fs.statSync(full).isFile() && /\.(pdf|json|txt|md|png|jpg|jpeg|webp)$/i.test(file)) {
        await this.loadFile(full);
      }
    }
  }

  /**
   * Matches live question against ingested answer store
   * @param {Object} liveQuestion
   * @param {string} liveQuestion.prompt
   * @param {Array<{ index: number, label: string, text: string }>} liveQuestion.options
   * @param {boolean} [liveQuestion.isMultiSelect=false]
   * @returns {{ matched: boolean, selectedIndices?: Array<number>, confidence?: number, source?: string, reasoning?: string } | null}
   */
  matchQuestion(liveQuestion) {
    if (this.entries.length === 0 || !liveQuestion?.prompt) return null;

    let bestScore = 0;
    let bestEntry = null;

    for (const entry of this.entries) {
      const sim = computeTextSimilarity(liveQuestion.prompt, entry.prompt);
      if (sim > bestScore) {
        bestScore = sim;
        bestEntry = entry;
      }
    }

    // Fallback: If prompt match was low, check if any entry has a correct answer matching live options directly
    if (bestScore < 0.72 || !bestEntry) {
      for (const entry of this.entries) {
        const optionMatches = [];
        for (const rawAns of entry.correctAnswers) {
          for (const opt of liveQuestion.options) {
            const optSim = computeTextSimilarity(opt.text, rawAns);
            if (optSim >= 0.82) {
              optionMatches.push(opt.index);
            }
          }
        }
        if (optionMatches.length > 0) {
          const uniquePicks = Array.from(new Set(optionMatches));
          const finalPicks = liveQuestion.isMultiSelect ? uniquePicks : [uniquePicks[0]];
          return {
            matched: true,
            selectedIndices: finalPicks,
            bestOptionIndex: finalPicks[0],
            confidence: 0.95,
            source: entry.source,
            reasoning: `Verified option match from key "${entry.source}": ${finalPicks.map(i => liveQuestion.options[i]?.text).join(', ')}`
          };
        }
      }
      return null;
    }

    const matchedIndices = [];

    // Match each correct answer against Coursera's live options
    for (const rawAns of bestEntry.correctAnswers) {
      // 1. If rawAns is a letter like "B" or "Option C"
      const letterMatch = rawAns.trim().match(/^[A-Da-d]$/) || rawAns.trim().match(/^option\s+([A-Da-d])$/i);
      if (letterMatch) {
        const targetIdx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
        if (targetIdx >= 0 && targetIdx < liveQuestion.options.length) {
          matchedIndices.push(targetIdx);
          continue;
        }
      }

      // 2. Otherwise match by option text similarity
      let bestOptIdx = -1;
      let bestOptScore = 0;

      for (const opt of liveQuestion.options) {
        const optSim = computeTextSimilarity(opt.text, rawAns);
        if (optSim > bestOptScore) {
          bestOptScore = optSim;
          bestOptIdx = opt.index;
        }
      }

      if (bestOptScore >= 0.70 && bestOptIdx >= 0) {
        matchedIndices.push(bestOptIdx);
      }
    }

    const uniquePicks = Array.from(new Set(matchedIndices));
    if (uniquePicks.length === 0) return null;

    const finalPicks = liveQuestion.isMultiSelect ? uniquePicks : [uniquePicks[0]];

    return {
      matched: true,
      selectedIndices: finalPicks,
      bestOptionIndex: finalPicks[0],
      confidence: 1.0,
      source: bestEntry.source,
      reasoning: `Verified match from answer key "${bestEntry.source}" (Prompt match: ${Math.round(bestScore * 100)}%)`
    };
  }
}

// Global singleton instance
export const answerStore = new AnswerStore();
