/** Display-only translation. Never write this response into agent history. */
export interface ThinkingTranslationRequest {
  sessionId: string;
  text: string;
  locale: 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
}

export type ThinkingTranslationResult =
  | { text: string; error?: never }
  | { text?: never; error: 'unavailable' | 'failed' | 'busy' | 'stale' };

export const THINKING_TRANSLATION_MAX_LENGTH = 16_000;

/** Narrow inline tokenizer for compact model reasoning text. */
export type ThinkingTextToken =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'code'; value: string };

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function findStrongClose(value: string, contentStart: number): number {
  let cursor = contentStart;
  while (cursor < value.length - 1) {
    const close = value.indexOf('**', cursor);
    if (close < 0) return -1;
    const previous = value[close - 1];
    const after = value[close + 2];
    if (
      close > contentStart
      && !isEscaped(value, close)
      && previous !== '*'
      && !/\s/.test(previous)
      && after !== '*'
    ) return close;
    cursor = close + 2;
  }
  return -1;
}

function findCodeClose(value: string, contentStart: number, runLength: number): number {
  const delimiter = '`'.repeat(runLength);
  let cursor = contentStart;
  while (cursor < value.length) {
    const close = value.indexOf(delimiter, cursor);
    if (close < 0) return -1;
    if (!isEscaped(value, close) && value[close - 1] !== '`' && value[close + runLength] !== '`') {
      return close;
    }
    cursor = close + runLength;
  }
  return -1;
}

function normalizeCodeSpan(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, ' ');
  if (
    singleLine.length >= 2
    && singleLine.startsWith(' ')
    && singleLine.endsWith(' ')
    && /\S/.test(singleLine)
  ) return singleLine.slice(1, -1);
  return singleLine;
}

/** Parse only paired strong markers and matching backtick runs. */
export function tokenizeThinkingText(value: string): ThinkingTextToken[] {
  const tokens: ThinkingTextToken[] = [];
  let plainStart = 0;
  let cursor = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) tokens.push({ kind: 'text', value: value.slice(plainStart, end) });
  };

  while (cursor < value.length) {
    if (value[cursor] === '`' && !isEscaped(value, cursor)) {
      let runLength = 1;
      while (value[cursor + runLength] === '`') runLength++;
      const contentStart = cursor + runLength;
      const close = findCodeClose(value, contentStart, runLength);
      if (close >= 0) {
        flushPlain(cursor);
        tokens.push({ kind: 'code', value: normalizeCodeSpan(value.slice(contentStart, close)) });
        cursor = close + runLength;
        plainStart = cursor;
        continue;
      }
      cursor += runLength;
      continue;
    }

    if (
      value.startsWith('**', cursor)
      && !isEscaped(value, cursor)
      && value[cursor - 1] !== '*'
      && value[cursor + 2] !== '*'
      && value[cursor + 2] !== undefined
      && !/\s/.test(value[cursor + 2])
    ) {
      const contentStart = cursor + 2;
      const close = findStrongClose(value, contentStart);
      if (close >= 0) {
        flushPlain(cursor);
        tokens.push({ kind: 'strong', value: value.slice(contentStart, close) });
        cursor = close + 2;
        plainStart = cursor;
        continue;
      }
      cursor += 2;
      continue;
    }
    cursor++;
  }

  flushPlain(value.length);
  return tokens;
}
