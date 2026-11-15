import { richAnswerText, splitRichAnswer } from '@cindy/maker-shared/rich-answer';
import { markdownTextPreview, streamingMarkdownPreviewText } from '../../shared/markdownPreviewText.js';

export const AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH = 280;
// Bound repeated Main-process projection even when Markdown hides the source.
// Final replies still normalize their full original text independently.
const ACTIVITY_SOURCE_MAX_LENGTH = 4_096;

type ActivityTextStreamMode = 'pending' | 'plain' | 'structured' | 'structured-extracted';

export interface ActivityTextStreamState {
  mode: ActivityTextStreamMode;
  rawChunks: string[];
  rawPreview: string;
  rawPreviewHasPendingWhitespace: boolean;
  rawPreviewHasPendingNewline: boolean;
  rawPreviewPendingLink: boolean;
  jsonClosingStack: Array<'}' | ']'>;
  jsonInString: boolean;
  jsonEscapePending: boolean;
  displayText: string;
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
    rawPreviewHasPendingNewline: false,
    rawPreviewPendingLink: false,
    jsonClosingStack: [],
    jsonInString: false,
    jsonEscapePending: false,
    displayText: '',
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
  const previousPreview = state.rawPreview;
  const previousNewline = state.rawPreviewHasPendingNewline;
  appendRawPreview(state, chunk, metrics);
  const destinationOnly = state.rawPreviewPendingLink && !/[\s\\()[\]<>`"']/.test(chunk);
  const previewChanged = (state.rawPreview !== previousPreview || state.rawPreviewHasPendingNewline !== previousNewline)
    && !destinationOnly;

  if (state.mode === 'plain') {
    return rawPreviewText(state, previewChanged);
  }

  if (state.mode === 'structured-extracted') {
    if (firstNonWhitespaceIndex(chunk, metrics) < 0) {
      return state.displayText;
    }
    switchToPlain(state);
    return rawPreviewText(state);
  }

  if (state.mode === 'pending') {
    appendRetainedRawChunk(state, chunk);
    const firstContentIndex = firstNonWhitespaceIndex(chunk, metrics);
    if (firstContentIndex < 0) return rawPreviewText(state, previewChanged);

    const firstContent = chunk[firstContentIndex];
    if (firstContent !== '{' && firstContent !== '[') {
      switchToPlain(state);
      return rawPreviewText(state, previewChanged);
    }

    state.mode = 'structured';
    state.jsonClosingStack.push(firstContent === '{' ? '}' : ']');
    if (!scanStructuredChunk(state, chunk, firstContentIndex + 1, metrics)) {
      return rawPreviewText(state, previewChanged);
    }
  } else {
    appendRetainedRawChunk(state, chunk);
    if (!scanStructuredChunk(state, chunk, 0, metrics)) {
      return rawPreviewText(state, previewChanged);
    }
  }

  if (state.jsonClosingStack.length > 0) return rawPreviewText(state, previewChanged);

  const rawText = state.rawChunks.join('');
  if (metrics) metrics.jsonParseCodeUnits += rawText.length;
  try {
    const parsed = JSON.parse(rawText.trim()) as unknown;
    const extracted = extractTextFromStructuredContent(parsed);
    if (extracted) {
      state.mode = 'structured-extracted';
      if (metrics) metrics.normalizationCodeUnits += extracted.length;
      state.displayText = normalizePlainActivityText(richAnswerText(extracted));
      releaseStructuredParserState(state);
      return state.displayText;
    }
  } catch {
    // Once the outer object/array has closed, a parse failure cannot be repaired
    // by appending another delta. Keep showing the existing raw-text fallback.
  }

  switchToPlain(state);
  return rawPreviewText(state, previewChanged);
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
  return normalizePlainActivityText(richAnswerText(extractActivityDisplayText(text)));
}

/** New hosts send display text; only unmarked legacy summaries need recovery. */
export function normalizeRemoteActivityText(text: string, summaryFormat?: 'plain-text'): string {
  if (summaryFormat === 'plain-text') return boundActivityText(text);
  // Old hosts flattened both the opening newline and any prose/fence boundary.
  // Check a reconstructed opening with the shared parser so quoted code remains code.
  const collapsedRich = /(^|\s)(`{3,}|~{3,})cindy-ui[ \t]+\{\s*"(?:version|seq|op)"\s*:/g;
  for (const match of text.matchAll(collapsedRich)) {
    const start = match.index! + match[1].length;
    const prefix = text.slice(0, start);
    const boundary = prefix && !prefix.endsWith('\n') ? '\n' : '';
    const key = prefix.length + boundary.length;
    const candidate = prefix + boundary + match[2] + 'cindy-ui\n';
    if (splitRichAnswer(candidate).some(part => part.kind === 'rich' && part.key === key)) {
      return normalizeActivityText(prefix);
    }
  }
  return normalizeActivityText(text);
}

function appendRawPreview(
  state: ActivityTextStreamState,
  chunk: string,
  metrics?: ActivityTextStreamMetrics,
): void {
  if (state.displayText.length >= AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH && !state.rawPreviewPendingLink) return;
  if (state.rawPreview.length >= ACTIVITY_SOURCE_MAX_LENGTH) return;

  for (let index = 0; index < chunk.length; index += 1) {
    if (metrics) metrics.normalizationCodeUnits += 1;
    const codeUnit = chunk[index] ?? '';
    if (/\s/.test(codeUnit)) {
      if (state.rawPreview) {
        state.rawPreviewHasPendingWhitespace = true;
        if (codeUnit === '\n' || codeUnit === '\r') state.rawPreviewHasPendingNewline = true;
      }
      continue;
    }

    if (state.rawPreviewHasPendingWhitespace) {
      // Keep fence/operation boundaries until rich content has been projected to text.
      // Visible text and protocol source have separate budgets.
      state.rawPreview += state.rawPreviewHasPendingNewline ? '\n' : ' ';
      state.rawPreviewHasPendingWhitespace = false;
      state.rawPreviewHasPendingNewline = false;
      if (state.rawPreview.length >= ACTIVITY_SOURCE_MAX_LENGTH) return;
    }

    state.rawPreview += codeUnit;
    if (state.rawPreview.length >= ACTIVITY_SOURCE_MAX_LENGTH) return;
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
  releaseStructuredParserState(state);
}

function releaseStructuredParserState(state: ActivityTextStreamState): void {
  state.rawChunks = [];
  state.jsonClosingStack = [];
  state.jsonInString = false;
  state.jsonEscapePending = false;
}

function rawPreviewText(state: ActivityTextStreamState, changed = true): string {
  if (!changed) return state.displayText;
  // A fence header may itself arrive in several deltas. Do not leave that
  // temporary header as the last visible activity when the rich block is empty.
  // A standalone newline commits an operation even before another non-space
  // character flushes the accumulator's pending whitespace.
  let source = state.rawPreview + (state.rawPreviewHasPendingNewline ? '\n' : '');
  const tail = source.match(/(^|\n)(`+|~+)([^\n]*)$/);
  if (tail && 'cindy-ui'.startsWith(tail[3].trim())) {
    const start = tail.index! + tail[1].length;
    const opening = tail[2][0].repeat(Math.max(3, tail[2].length)) + 'cindy-ui\n';
    // Let the shared fence parser distinguish a new opening from an ordinary
    // closing fence or an example nested inside a larger code fence.
    const candidate = source.slice(0, start) + opening;
    // A bare fence after prose is ambiguous (it may close an inline example).
    // Wait for a language prefix before hiding it; an answer-start fence is safe.
    if ((tail[3].trim() || start === 0)
      && splitRichAnswer(candidate).some(part => part.kind === 'rich' && part.key === start)) {
      source = source.slice(0, start);
    }
  }
  const readable = richAnswerText(source);
  const projection = /[*_`~<>!#|&\n\r]|\](?:\(|\[)|^\s*(?:[-+] |\d+[.)] )/.test(readable)
    ? streamingMarkdownPreviewText(readable)
    : { text: readable, pendingLink: false };
  state.rawPreviewPendingLink = projection.pendingLink;
  state.displayText = boundActivityText(projection.text);
  return state.displayText;
}

function normalizePlainActivityText(text: string): string {
  // Keep the hot path for plain bounded streaming prefixes cheap; formatted
  // answers use the same projection as notifications and the session list.
  const plain = /[*_`~<>!#|&\n\r]|\](?:\(|\[)|^\s*(?:[-+] |\d+[.)] )/.test(text) ? markdownTextPreview(text) : text;
  return boundActivityText(plain);
}

function boundActivityText(text: string): string {
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
