// code_utils.js — pure helpers for cleaning/validating LLM output (no I/O, unit-tested)

export function stripMarkdownFences(text) {
  const raw = (text || '').trim();
  if (!raw) return '';

  const fenced = raw.match(/^```[\w-]*\n([\s\S]*)```\s*$/m);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  return raw
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * Robust JSON extractor that finds the largest bracket-balanced block.
 */
export function extractJsonBlock(text) {
  const raw = stripMarkdownFences(text);
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Fallback: try to find a { ... } block
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const slice = raw.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch (e2) {
        // Last resort: remove common AI errors
        const cleaned = slice
          .replace(/\\n/g, ' ')
          .replace(/\\"/g, '"')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
          .trim();
          try { return JSON.parse(cleaned); } catch(e3) { throw e; }
      }
    }
    throw e;
  }
}

export function hasBalancedBrackets(code) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closing = new Set(Object.values(pairs));
  const stack = [];

  for (const ch of code) {
    if (pairs[ch]) {
      stack.push(pairs[ch]);
      continue;
    }

    if (closing.has(ch)) {
      if (stack.pop() !== ch) return false;
    }
  }

  return stack.length === 0;
}

export function looksTruncated(code) {
  const trimmed = (code || '').trim();
  if (!trimmed) return true;

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : '';

  if (!/[;})\]]$/.test(trimmed)) return true;
  if (/\.[A-Za-z_][A-Za-z0-9_]*$/.test(lastLine)) return true;
  if (/\b(return|if|for|while|switch|case|class|public|private|protected)\s*$/.test(lastLine)) return true;

  return false;
}

export function extractLikelyCode(rawText) {
  // Strip DeepSeek <think> blocks first
  const noThink = (rawText || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const cleaned = stripMarkdownFences(noThink);
  if (!cleaned) return '';

  // If model prepends explanations, trim from first code-looking token.
  const markers = [
    'module.exports',
    'class ',
    'public class',
    'function ',
    'const ',
    'let ',
    'var '
  ];

  const lower = cleaned.toLowerCase();
  let first = -1;
  for (const marker of markers) {
    const idx = lower.indexOf(marker.toLowerCase());
    if (idx !== -1 && (first === -1 || idx < first)) {
      first = idx;
    }
  }

  if (first > 0) {
    return cleaned.slice(first).trim();
  }

  return cleaned;
}

export function stripCodeComments(code, language) {
  if (!/java/i.test(language || '')) return code || '';
  const src = code || '';
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  while (i < src.length) {
    const ch = src[i];
    const next = i + 1 < src.length ? src[i + 1] : '';

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      i += 1;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '/' && next === '/') {
        inLine = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
    }

    if (ch === '\\' && (inSingle || inDouble || inBacktick)) {
      out += ch;
      if (next) {
        out += next;
        i += 2;
        continue;
      }
    }

    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
    } else if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
    }

    out += ch;
    i += 1;
  }

  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

