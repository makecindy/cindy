import type { MobileVoiceDictionaryLearningRequest } from '@cindy/maker-shared/device-link-contract';

export const MOBILE_VOICE_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS = 15 * 1000;

const MOBILE_VOICE_DICTIONARY_LEARNING_CONTEXT_CHARS = 600;

export type MobileVoiceDictionaryLearningTracker = {
  captureRefinedInsertion(input: {
    draft: string;
    rawTranscriptText: string;
    refinedText: string;
    start: number;
    end: number;
    uiLanguage?: string;
    sourceLanguage?: string;
  }): void;
  inspectDraft(nextDraft: string): void;
  flush(): void;
  dispose(): void;
};

type Timer = ReturnType<typeof setTimeout>;

type Watch = {
  baselineDraft: string;
  rawTranscriptText: string;
  baselineText: string;
  start: number;
  end: number;
  uiLanguage?: string;
  sourceLanguage?: string;
  pendingRequest?: MobileVoiceDictionaryLearningRequest;
  pendingTimer?: Timer;
};

type TrackerOptions = {
  submit: (request: MobileVoiceDictionaryLearningRequest) => void | Promise<unknown>;
  timeoutMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => Timer;
  clearTimeoutFn?: (timer: Timer) => void;
};

export function createMobileVoiceDictionaryLearningTracker(
  options: TrackerOptions,
): MobileVoiceDictionaryLearningTracker {
  const timeoutMs = options.timeoutMs ?? MOBILE_VOICE_DICTIONARY_LEARNING_TRACK_TIMEOUT_MS;
  // 回退包一层箭头,把返回类型钉成 Timer(=ReturnType<typeof setTimeout>):裸 setTimeout
  // 在 @types/node + DOM 双 lib 下重载返回退化为 number | Timeout,直接 ?? 会污染 pendingTimer
  // 的类型。运行时行为不变。
  const setTimeoutFn: (callback: () => void, ms: number) => Timer =
    options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let watch: Watch | null = null;

  const clearTimer = (): void => {
    if (!watch?.pendingTimer) return;
    clearTimeoutFn(watch.pendingTimer);
    watch.pendingTimer = undefined;
  };

  const flush = (): void => {
    if (!watch?.pendingRequest) return;
    const request = watch.pendingRequest;
    clearTimer();
    watch = null;
    void Promise.resolve(options.submit(request)).catch(() => undefined);
  };

  return {
    captureRefinedInsertion(input) {
      const baselineText = normalizeText(input.refinedText);
      const rawTranscriptText = normalizeText(input.rawTranscriptText);
      if (!baselineText || !rawTranscriptText) return;
      if (
        input.start < 0
        || input.end < input.start
        || input.end > input.draft.length
        || input.draft.slice(input.start, input.end) !== baselineText
      ) {
        return;
      }
      clearTimer();
      watch = {
        baselineDraft: input.draft,
        rawTranscriptText,
        baselineText,
        start: input.start,
        end: input.end,
        uiLanguage: normalizeOptionalText(input.uiLanguage),
        sourceLanguage: normalizeOptionalText(input.sourceLanguage),
      };
    },

    inspectDraft(nextDraft) {
      if (!watch) return;
      const current = readCurrentInsertedText(watch, nextDraft);
      if (current.kind === 'invalid') {
        clearTimer();
        watch = null;
        return;
      }
      if (current.kind === 'unchanged') {
        clearTimer();
        watch.pendingRequest = undefined;
        return;
      }
      clearTimer();
      watch.pendingRequest = {
        source: 'mobile',
        rawTranscriptText: watch.rawTranscriptText,
        beforeText: watch.baselineText,
        afterText: current.afterText,
        context: {
          uiLanguage: watch.uiLanguage,
          sourceLanguage: watch.sourceLanguage,
          selectionBefore: takeTail(current.selectionBefore, MOBILE_VOICE_DICTIONARY_LEARNING_CONTEXT_CHARS),
          selectionAfter: takeHead(current.selectionAfter, MOBILE_VOICE_DICTIONARY_LEARNING_CONTEXT_CHARS),
        },
      };
      watch.pendingTimer = setTimeoutFn(flush, timeoutMs);
    },

    flush,

    dispose() {
      clearTimer();
      watch = null;
    },
  };
}

function readCurrentInsertedText(
  watch: Watch,
  draft: string,
): (
  | { kind: 'changed'; afterText: string; selectionBefore: string; selectionAfter: string }
  | { kind: 'unchanged' }
  | { kind: 'invalid' }
) {
  const prefix = watch.baselineDraft.slice(0, watch.start);
  const suffix = watch.baselineDraft.slice(watch.end);
  if (!draft.startsWith(prefix)) return { kind: 'invalid' };
  if (suffix && !draft.endsWith(suffix)) return { kind: 'invalid' };
  const suffixStart = suffix ? draft.length - suffix.length : draft.length;
  if (suffixStart < prefix.length) return { kind: 'invalid' };
  const afterText = normalizeText(draft.slice(prefix.length, suffixStart));
  if (!afterText) return { kind: 'invalid' };
  if (afterText === watch.baselineText) return { kind: 'unchanged' };
  return {
    kind: 'changed',
    afterText,
    selectionBefore: draft.slice(0, prefix.length),
    selectionAfter: draft.slice(suffixStart),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function takeTail(value: string, max: number): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(-max);
}

function takeHead(value: string, max: number): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}
