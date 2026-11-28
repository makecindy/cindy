export type AsrDictionaryHintEntry = {
  text: string;
  source?: 'manual' | 'automatic';
  frequency?: number;
  updatedAt?: number;
};

export type AsrRecognitionHintsInput = {
  dictionaryEntries?: readonly AsrDictionaryHintEntry[];
  /**
   * Recent voice-input transcript snippets. Pass in newest-first order when
   * `recentHistoryOrder` is `'newest-first'`, or oldest-first (default, matching
   * refinement history storage) and the builder will reverse it so the freshest
   * turns are kept first.
   */
  recentHistory?: readonly string[];
  recentHistoryOrder?: 'oldest-first' | 'newest-first';
};

export type AsrRecognitionHints = {
  /** Prioritized, deduplicated dictionary hotwords (manual first, then frequency/recency). */
  hotwords: string[];
  /** Newest-first recent voice input snippets, sanitized and bounded. */
  recentContext: string[];
};

const MAX_HOTWORDS_IN_HINTS = 80;
const MAX_HOTWORD_CHARS = 50;
const MAX_RECENT_CONTEXT_ITEMS = 4;
const MAX_RECENT_CONTEXT_ITEM_CHARS = 120;
const MAX_RECENT_CONTEXT_TOTAL_CHARS = 320;

// Provider-specific conservative limits well within upstream protocol budgets.
const VOLCENGINE_MAX_HOTWORDS = 50;
const VOLCENGINE_MAX_HOTWORD_CHARS = 600;
const VOLCENGINE_MAX_CONTEXT_ITEMS = 4;
const VOLCENGINE_MAX_CONTEXT_CHARS = 300;

const QWEN_MAX_HOTWORDS = 50;
const QWEN_MAX_HOTWORD_CHARS = 500;
const QWEN_MAX_CONTEXT_ITEMS = 3;
const QWEN_MAX_TOTAL_CHARS = 800;

const OPENAI_MAX_HOTWORDS = 40;
const OPENAI_MAX_TOTAL_CHARS = 600;

const ELEVENLABS_MAX_KEYTERMS = 50;
const ELEVENLABS_MAX_KEYTERMS_TOTAL_CHARS = 800;
const ELEVENLABS_MAX_SINGLE_KEYTERM_CHARS = 50;

/**
 * Projects personal dictionary entries and recent voice-input history into a
 * compact, sanitized, deduplicated hints structure shared across all ASR
 * providers on desktop and mobile.
 */
export function buildAsrRecognitionHints(input: AsrRecognitionHintsInput): AsrRecognitionHints {
  const hotwords = selectPriorityHotwords(input.dictionaryEntries ?? []);
  const rawHistory = input.recentHistory ?? [];
  const orderedHistory = input.recentHistoryOrder === 'newest-first'
    ? [...rawHistory]
    : [...rawHistory].reverse();
  const recentContext = selectRecentContext(orderedHistory);
  return { hotwords, recentContext };
}

export function hasAsrRecognitionHints(hints: AsrRecognitionHints | undefined): boolean {
  return Boolean(hints && (hints.hotwords.length > 0 || hints.recentContext.length > 0));
}

/**
 * Stable fingerprint of ASR hints so warm realtime WebSocket sessions can
 * detect when dictionary hotwords or recent context changed and send an
 * updated `session.update`.
 */
export function asrRecognitionHintsFingerprint(hints: AsrRecognitionHints | undefined): string {
  if (!hasAsrRecognitionHints(hints)) return '';
  return JSON.stringify({
    h: hints!.hotwords,
    c: hints!.recentContext,
  });
}

/**
 * Formats Volcengine Seed-ASR 2.0 SAUC `request.corpus.context` JSON string.
 * Returns `undefined` when no hotwords or recent context are available so
 * callers omit `request.corpus` entirely.
 */
export function buildVolcengineSaucCorpusContext(
  hints: AsrRecognitionHints | undefined,
): string | undefined {
  if (!hints) return undefined;
  const hotwords: Array<{ word: string }> = [];
  let hotwordChars = 0;
  for (const term of hints.hotwords) {
    if (hotwords.length >= VOLCENGINE_MAX_HOTWORDS) break;
    if (hotwordChars + term.length > VOLCENGINE_MAX_HOTWORD_CHARS) continue;
    hotwords.push({ word: term });
    hotwordChars += term.length;
  }

  const contextData: Array<{ text: string }> = [];
  let contextChars = 0;
  for (const item of hints.recentContext) {
    if (contextData.length >= VOLCENGINE_MAX_CONTEXT_ITEMS) break;
    const remaining = VOLCENGINE_MAX_CONTEXT_CHARS - contextChars;
    if (remaining < 8) break;
    const bounded = item.length > remaining ? item.slice(0, remaining).trim() : item;
    if (!bounded) continue;
    contextData.push({ text: bounded });
    contextChars += bounded.length;
  }

  if (hotwords.length === 0 && contextData.length === 0) return undefined;
  return JSON.stringify({
    ...(hotwords.length > 0 ? { hotwords } : {}),
    ...(contextData.length > 0
      ? {
          context_type: 'dialog_ctx',
          context_data: contextData,
        }
      : {}),
  });
}

/**
 * Formats Qwen3-ASR `session.input_audio_transcription.corpus.text`.
 * Returns `undefined` when empty so callers omit `corpus` entirely.
 */
export function buildQwenAsrCorpusText(
  hints: AsrRecognitionHints | undefined,
): string | undefined {
  if (!hints) return undefined;
  const selectedHotwords: string[] = [];
  let hotwordChars = 0;
  for (const term of hints.hotwords) {
    if (selectedHotwords.length >= QWEN_MAX_HOTWORDS) break;
    const nextChars = hotwordChars + (selectedHotwords.length > 0 ? 2 : 0) + term.length;
    if (nextChars > QWEN_MAX_HOTWORD_CHARS) continue;
    selectedHotwords.push(term);
    hotwordChars = nextChars;
  }

  const parts: string[] = [];
  if (selectedHotwords.length > 0) {
    parts.push(selectedHotwords.join(', '));
  }
  const currentChars = parts.join('\n').length;
  const contextBudget = QWEN_MAX_TOTAL_CHARS - currentChars - (parts.length > 0 ? 1 : 0);
  if (contextBudget >= 16 && hints.recentContext.length > 0) {
    const contextSnippets: string[] = [];
    let used = 0;
    for (const item of hints.recentContext.slice(0, QWEN_MAX_CONTEXT_ITEMS)) {
      const separator = contextSnippets.length > 0 ? ' ' : '';
      const remaining = contextBudget - used - separator.length;
      if (remaining < 8) break;
      const bounded = item.length > remaining ? item.slice(0, remaining).trim() : item;
      if (!bounded) continue;
      contextSnippets.push(bounded);
      used += separator.length + bounded.length;
    }
    if (contextSnippets.length > 0) {
      parts.push(contextSnippets.join(' '));
    }
  }

  const text = parts.join('\n').trim();
  return text || undefined;
}

/**
 * Formats a concise transcription prompt for OpenAI Realtime transcription
 * (`session.audio.input.transcription.prompt`) and OpenAI Whisper / LiteLLM
 * batch `/v1/audio/transcriptions` (`prompt`).
 * Returns `undefined` when empty so callers omit `prompt` entirely.
 */
export function buildOpenAiTranscriptionPrompt(
  hints: AsrRecognitionHints | undefined,
): string | undefined {
  if (!hints) return undefined;
  const selectedHotwords: string[] = [];
  let hotwordChars = 0;
  const maxHotwordBudget = Math.floor(OPENAI_MAX_TOTAL_CHARS * 0.65);
  for (const term of hints.hotwords) {
    if (selectedHotwords.length >= OPENAI_MAX_HOTWORDS) break;
    const nextChars = hotwordChars + (selectedHotwords.length > 0 ? 2 : 0) + term.length;
    if (nextChars > maxHotwordBudget) continue;
    selectedHotwords.push(term);
    hotwordChars = nextChars;
  }

  const parts: string[] = [];
  if (selectedHotwords.length > 0) {
    parts.push(selectedHotwords.join(', '));
  }
  const usedBeforeContext = parts.join(' ').length;
  const remainingBudget = OPENAI_MAX_TOTAL_CHARS - usedBeforeContext - (parts.length > 0 ? 2 : 0);
  if (remainingBudget >= 16 && hints.recentContext.length > 0) {
    const snippets: string[] = [];
    let used = 0;
    for (const item of hints.recentContext) {
      const sep = snippets.length > 0 ? ' ' : '';
      const left = remainingBudget - used - sep.length;
      if (left < 8) break;
      const bounded = item.length > left ? item.slice(0, left).trim() : item;
      if (!bounded) continue;
      snippets.push(bounded);
      used += sep.length + bounded.length;
    }
    if (snippets.length > 0) {
      parts.push(snippets.join(' '));
    }
  }

  const prompt = parts.join('. ').trim();
  if (!prompt) return undefined;
  return prompt.length > OPENAI_MAX_TOTAL_CHARS
    ? prompt.slice(0, OPENAI_MAX_TOTAL_CHARS).trim()
    : prompt;
}

/**
 * Selects bounded keyterms for ElevenLabs Scribe v2 Realtime (`keyterms` query
 * params). Uses personal dictionary terms only (never full history sentences),
 * staying strictly inside ElevenLabs' <=100 terms / <=1,000 chars / <=50 chars
 * per term contract.
 */
export function buildElevenLabsScribeKeyterms(
  hints: AsrRecognitionHints | undefined,
): string[] {
  if (!hints || hints.hotwords.length === 0) return [];
  const keyterms: string[] = [];
  let totalChars = 0;
  for (const term of hints.hotwords) {
    if (keyterms.length >= ELEVENLABS_MAX_KEYTERMS) break;
    if (term.length > ELEVENLABS_MAX_SINGLE_KEYTERM_CHARS) continue;
    if (totalChars + term.length > ELEVENLABS_MAX_KEYTERMS_TOTAL_CHARS) continue;
    keyterms.push(term);
    totalChars += term.length;
  }
  return keyterms;
}

function selectPriorityHotwords(entries: readonly AsrDictionaryHintEntry[]): string[] {
  const ranked = [...entries].sort((a, b) => {
    const aManual = a.source === 'automatic' ? 0 : 1;
    const bManual = b.source === 'automatic' ? 0 : 1;
    if (aManual !== bManual) return bManual - aManual;
    const freqDiff = normalizeNonNegative(b.frequency) - normalizeNonNegative(a.frequency);
    if (freqDiff !== 0) return freqDiff;
    return normalizeNonNegative(b.updatedAt) - normalizeNonNegative(a.updatedAt);
  });

  const seen = new Set<string>();
  const hotwords: string[] = [];
  for (const entry of ranked) {
    if (hotwords.length >= MAX_HOTWORDS_IN_HINTS) break;
    const cleaned = sanitizeHintText(entry.text);
    if (!cleaned || cleaned.length > MAX_HOTWORD_CHARS) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hotwords.push(cleaned);
  }
  return hotwords;
}

function selectRecentContext(orderedNewestFirst: readonly string[]): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  let totalChars = 0;
  for (const raw of orderedNewestFirst) {
    if (items.length >= MAX_RECENT_CONTEXT_ITEMS) break;
    const cleaned = sanitizeHintText(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const remaining = MAX_RECENT_CONTEXT_TOTAL_CHARS - totalChars;
    if (remaining < 8) break;
    const limit = Math.min(MAX_RECENT_CONTEXT_ITEM_CHARS, remaining);
    const bounded = cleaned.length > limit ? cleaned.slice(0, limit).trim() : cleaned;
    if (!bounded) continue;
    items.push(bounded);
    totalChars += bounded.length;
  }
  return items;
}

function sanitizeHintText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
