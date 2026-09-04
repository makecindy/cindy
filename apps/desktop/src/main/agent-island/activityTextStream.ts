export const AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH = 280;

type ActivityTextStreamMode = 'pending' | 'plain' | 'structured' | 'structured-extracted';

export interface ActivityTextStreamState {
  mode: ActivityTextStreamMode;
  rawChunks: string[];
  rawPreview: string;
  rawPreviewHasPendingWhitespace: boolean;
  jsonClosingStack: Array<'}' | ']'>;
  jsonInString: boolean;
  jsonEscapePending: boolean;
  structuredDisplayText: string;
}

/** Deterministic work counters used by the performance regression test. */
export interface ActivityTextStreamMetrics {
  classificationCodeUnits: number;
  normalizationCodeUnits: number;
  jsonSyntaxCodeUnits: number;
  jsonParseCodeUnits: number;
}

export function createActivityTextStreamState(): ActivityTextStreamState {
  return {
    mode: 'pending',
    rawChunks: [],
    rawPreview: '',
    rawPreviewHasPendingWhitespace: false,
    jsonClosingStack: [],
    jsonInString: false,
    jsonEscapePending: false,
    structuredDisplayText: '',
  };
}

export function cloneActivityTextStreamState(
  state: ActivityTextStreamState,
): ActivityTextStreamState {
  return {
    ...state,
    rawChunks: [...state.rawChunks],
    jsonClosingStack: [...state.jsonClosingStack],
  };
}

export function appendActivityTextStream(
  state: ActivityTextStreamState,
  chunk: string,
  metrics?: ActivityTextStreamMetrics,
): string {
  appendRawPreview(state, chunk, metrics);

  if (state.mode === 'plain') {
    return rawPreviewText(state);
  }

  if (state.mode === 'structured-extracted') {
    if (firstNonWhitespaceIndex(chunk, metrics) < 0) {
      return state.structuredDisplayText;
    }
    switchToPlain(state);
    return rawPreviewText(state);
  }

  if (state.mode === 'pending') {
    appendRetainedRawChunk(state, chunk);
    const firstContentIndex = firstNonWhitespaceIndex(chunk, metrics);
    if (firstContentIndex < 0) return rawPreviewText(state);

    const firstContent = chunk[firstContentIndex];
    if (firstContent !== '{' && firstContent !== '[') {
      switchToPlain(state);
      return rawPreviewText(state);
    }

    state.mode = 'structured';
    state.jsonClosingStack.push(firstContent === '{' ? '}' : ']');
    if (!scanStructuredChunk(state, chunk, firstContentIndex + 1, metrics)) {
      return rawPreviewText(state);
    }
  } else {
    appendRetainedRawChunk(state, chunk);
    if (!scanStructuredChunk(state, chunk, 0, metrics)) {
      return rawPreviewText(state);
    }
  }

  if (state.jsonClosingStack.length > 0) return rawPreviewText(state);

  const rawText = state.rawChunks.join('');
  if (metrics) metrics.jsonParseCodeUnits += rawText.length;
  try {
    const parsed = JSON.parse(rawText.trim()) as unknown;
    const extracted = extractTextFromStructuredContent(parsed);
    if (extracted) {
      state.mode = 'structured-extracted';
      if (metrics) metrics.normalizationCodeUnits += extracted.length;
      state.structuredDisplayText = normalizePlainActivityText(extracted);
      releaseStructuredParserState(state);
      return state.structuredDisplayText;
    }
  } catch {
    // Once the outer object/array has closed, a parse failure cannot be repaired
    // by appending another delta. Keep showing the existing raw-text fallback.
  }

  switchToPlain(state);
  return rawPreviewText(state);
}

function appendRetainedRawChunk(state: ActivityTextStreamState, chunk: string): void {
  if (!chunk) return;
  state.rawChunks.push(chunk);

  // Keep older chunks geometrically larger than newer ones. This preserves the
  // exact JSON input and ordering while preventing one retained string object
  // per tiny delta when a structured stream stays incomplete for a long time.
  while (state.rawChunks.length >= 2) {
    const newest = state.rawChunks.at(-1) ?? '';
    const previous = state.rawChunks.at(-2) ?? '';
    if (previous.length > newest.length * 2) return;
    state.rawChunks.pop();
    state.rawChunks.pop();
    state.rawChunks.push(previous + newest);
  }
}

export function normalizeActivityText(text: string): string {
  return normalizePlainActivityText(extractActivityDisplayText(text));
}

function appendRawPreview(
  state: ActivityTextStreamState,
  chunk: string,
  metrics?: ActivityTextStreamMetrics,
): void {
  if (state.rawPreview.length >= AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH) return;

  for (let index = 0; index < chunk.length; index += 1) {
    if (metrics) metrics.normalizationCodeUnits += 1;
    const codeUnit = chunk[index] ?? '';
    if (/\s/.test(codeUnit)) {
      if (state.rawPreview) state.rawPreviewHasPendingWhitespace = true;
      continue;
    }

    if (state.rawPreviewHasPendingWhitespace) {
      state.rawPreview += ' ';
      state.rawPreviewHasPendingWhitespace = false;
      if (state.rawPreview.length >= AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH) return;
    }

    state.rawPreview += codeUnit;
    if (state.rawPreview.length >= AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH) return;
  }
}

function firstNonWhitespaceIndex(value: string, metrics?: ActivityTextStreamMetrics): number {
  for (let index = 0; index < value.length; index += 1) {
    if (metrics) metrics.classificationCodeUnits += 1;
    if (!/\s/.test(value[index] ?? '')) return index;
  }
  return -1;
}

function scanStructuredChunk(
  state: ActivityTextStreamState,
  chunk: string,
  startIndex: number,
  metrics?: ActivityTextStreamMetrics,
): boolean {
  for (let index = startIndex; index < chunk.length; index += 1) {
    if (metrics) metrics.jsonSyntaxCodeUnits += 1;
    const codeUnit = chunk[index] ?? '';

    if (state.jsonClosingStack.length === 0) {
      if (!/\s/.test(codeUnit)) {
        switchToPlain(state);
        return false;
      }
      continue;
    }

    if (state.jsonInString) {
      if (state.jsonEscapePending) {
        state.jsonEscapePending = false;
      } else if (codeUnit === '\\') {
        state.jsonEscapePending = true;
      } else if (codeUnit === '"') {
        state.jsonInString = false;
      }
      continue;
    }

    if (codeUnit === '"') {
      state.jsonInString = true;
      continue;
    }
    if (codeUnit === '{') {
      state.jsonClosingStack.push('}');
      continue;
    }
    if (codeUnit === '[') {
      state.jsonClosingStack.push(']');
      continue;
    }
    if (codeUnit !== '}' && codeUnit !== ']') continue;

    if (state.jsonClosingStack.at(-1) !== codeUnit) {
      switchToPlain(state);
      return false;
    }
    state.jsonClosingStack.pop();
  }
  return true;
}

function switchToPlain(state: ActivityTextStreamState): void {
  state.mode = 'plain';
  state.structuredDisplayText = '';
  releaseStructuredParserState(state);
}

function releaseStructuredParserState(state: ActivityTextStreamState): void {
  state.rawChunks = [];
  state.jsonClosingStack = [];
  state.jsonInString = false;
  state.jsonEscapePending = false;
}

function rawPreviewText(state: ActivityTextStreamState): string {
  return state.rawPreview.trim();
}

function normalizePlainActivityText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH)
    .trim();
}

function extractActivityDisplayText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return rawText;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return extractTextFromStructuredContent(parsed) ?? rawText;
  } catch {
    return rawText;
  }
}

function extractTextFromStructuredContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;

  if (Array.isArray(value)) {
    const parts = value
      .map(extractTextFromStructuredContent)
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' ') : null;
  }

  const record = asRecord(value);
  if (!record) return null;

  for (const key of ['text', 'message', 'prompt']) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }

  const content = record.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  return extractTextFromStructuredContent(content);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
