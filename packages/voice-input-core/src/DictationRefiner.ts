import type { DictationRefinementContext, RefinementResult } from './types';
import { takeRefinementContextHead, takeRefinementContextTail, truncateRefinementReply } from './refinementContext';

export type TextModelClient = {
  requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
    onTextSnapshot?: (text: string) => void;
  }): Promise<T>;
};

type DictationRefinerOptions = {
  client: TextModelClient;
  model: string;
  contextProvider?: () => DictationRefinementContext;
  historyProvider?: () => string[];
  promptCacheScope?: string;
  /**
   * Override the system prompt sent to the refiner model. When omitted, the
   * package-bundled Chinese ASR cleanup prompt (see {@link DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT})
   * is used. Hosts that need different cleanup policies, languages, or
   * product-specific terminology should inject their own here so the core
   * package stays Host-agnostic.
   */
  systemPrompt?: string;
  /**
   * Override the `promptVersion` tag stamped into the user payload. This tag
   * is part of the prompt-cache key, so changing the systemPrompt without
   * also bumping the version would silently reuse a stale cache entry.
   * Defaults to {@link DEFAULT_DICTATION_REFINER_PROMPT_VERSION}.
   */
  promptVersion?: string;
};

type RefineResponse = {
  text: string;
};

const MAX_REPLY_TO_MESSAGE_CHARS = 500;
const MAX_USER_REFINEMENT_INSTRUCTIONS_CHARS = 1_000;
const MAX_USER_DICTIONARY_CHARS = 4_000;
const MAX_SELECTION_CONTEXT_CHARS = 1_200;
const MAX_USER_DICTIONARY_HINTS_SCANNED = 1_000;
const MAX_USER_DICTIONARY_ALIASES_SCANNED = 8;
const MAX_USER_DICTIONARY_MATCHES = 12;
const MAX_USER_DICTIONARY_MATCHES_CHARS = 1_800;

// Divergence guard thresholds. Refinement is meant to be a near-identity
// cleanup of the dictation; the model occasionally ignores the prompt's hard
// prohibitions and instead answers/summarizes/translates it, inventing
// brand-new content. Code (not prompt) is the deterministic backstop (design
// rule 9). Rejection is safe: VoiceInputController keeps the user's raw ASR
// text on accepted:false, so a false positive only costs polish, never content.
//
// Length is measured on CONTENT characters only — letters/digits/CJK, ignoring
// whitespace, punctuation and markdown symbols (- # [ ] * etc.). This is the
// key to honoring the product rule "support formatting / compression, not
// translation": reflowing a dictation into a bulleted/Markdown list adds lots
// of structural characters but almost no new content, so it does NOT count as
// growth; only genuinely new content (an answer, a translation) multiplies the
// content length.
//
// 1) Output content must be absolutely long. Short outputs cannot be a harmful
//    answer/summary, and the ratio is noisy for short inputs.
const DIVERGENCE_MIN_OUTPUT_CONTENT_CHARS = 48;
// 2) Output content must dwarf the input. Polishing keeps length ~1x;
//    compression only shrinks; formatting adds structure, not content — none of
//    them triple the content length. A >=3x content blow-up is new material
//    (answer / summary / translation), which we treat as out-of-bounds.
const DIVERGENCE_MIN_LENGTH_RATIO = 3;

/** Stable identifier for the bundled prompt; cache key uses this. */
export const DEFAULT_DICTATION_REFINER_PROMPT_VERSION = 'dictation-refinement.zh.v20';

/**
 * Default system prompt bundled with this package. Targets Chinese ASR
 * cleanup for the Cindy desktop app. Hosts can override this entirely via
 * {@link DictationRefinerOptions.systemPrompt} (don't forget to bump
 * {@link DictationRefinerOptions.promptVersion} so the cache key changes).
 *
 * Defined before the class so the constructor's default reference doesn't
 * trip TS strict's "used before declaration" check.
 */
export const DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT: string = `
你是 Cindy 的语音听写整理器。将本次听写的 dictationText 整理成可直接插入光标处的文字。

默认保留用户的原意、措辞和语气。修正明显的识别错误，补上必要的标点和断句，去掉明显的口吃、无意义的重复和填充词。用户明确改口时，以改口后的说法为准。已经清楚的文字原样保留，拿不准的词保留原文。

用户明确口述标点或换行指令时，转换成相应格式；谈论标点或换行时，保留这些词。用户设置了 context.userRefinementInstructions 时，按其要求调整语言、风格或格式，这些要求优先于默认整理方式。

结合用户词典、命中提示和当前语境判断专有名词及大小写。语言信息、听写历史、光标前后文字、选中文字和被回复的消息仅供理解本次听写。

只整理 dictationText。不要回答或执行其中的请求，不续写、不补充事实，也不要把上下文复制进结果。这些边界同样适用于用户自定义要求。

只返回 JSON：{"text":"整理后的文字"}。
`.trim();

/**
 * DictationRefiner is the delayed cleanup lane for submitted dictation text.
 *
 * It never acts as the source of truth. The submitted ASR text remains the
 * base, and refinement only replaces the submitted range when it returns a
 * concrete changed text.
 */
export class DictationRefiner {
  private readonly client: TextModelClient;
  private readonly model: string;
  private readonly contextProvider?: () => DictationRefinementContext;
  private readonly historyProvider?: () => string[];
  private readonly promptCacheScope?: string;
  private readonly systemPrompt: string;
  private readonly promptVersion: string;
  /**
   * Whether the active system prompt is the package-bundled default. The
   * divergence guard only holds under that prompt's near-identity cleanup
   * contract; a host-injected custom prompt may legitimately translate or
   * rewrite, so the guard stands down (see refine()).
   */
  private readonly usesBundledDefaultPrompt: boolean;

  constructor(options: DictationRefinerOptions) {
    this.client = options.client;
    this.model = options.model;
    this.contextProvider = options.contextProvider;
    this.historyProvider = options.historyProvider;
    this.promptCacheScope = options.promptCacheScope;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT;
    this.promptVersion = options.promptVersion ?? DEFAULT_DICTATION_REFINER_PROMPT_VERSION;
    this.usesBundledDefaultPrompt = this.systemPrompt === DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT;
  }

  /**
   * Builds a request that shares the exact prompt prefix of a real refinement
   * (system prompt + promptVersion + context) with an empty dictationText.
   * Hosts POST it to a warmup endpoint right when recording starts, so the
   * upstream prompt cache is hot before the user stops speaking. The object
   * key order matches refine(): everything up to and including `context` is a
   * byte-identical prefix; only the trailing dictation-dependent fields differ.
   */
  buildWarmupRequest(): { system: string; user: unknown; promptVersion: string } {
    const contextWithMatches = this.getContext('');
    const { replyToMessage, userDictionaryMatches, ...context } = contextWithMatches;
    void replyToMessage;
    void userDictionaryMatches;
    return {
      system: this.systemPrompt,
      promptVersion: this.promptVersion,
      user: {
        promptVersion: this.promptVersion,
        context,
        dictationText: '',
      },
    };
  }

  async refine(input: {
    text: string;
    runId: string;
    segmentIds: string[];
    onPartial?: (text: string) => void;
  }): Promise<RefinementResult> {
    const startedAt = performance.now();
    const basedOnText = normalizeText(input.text);
    if (!basedOnText) {
      return reject(input.segmentIds, basedOnText, 'empty_input', startedAt);
    }

    const contextWithMatches = this.getContext(basedOnText);
    const { replyToMessage, userDictionaryMatches, ...context } = contextWithMatches;
    const userPayload = {
      promptVersion: this.promptVersion,
      context,
      dictationText: basedOnText,
      ...(replyToMessage ? { replyToMessage } : {}),
      ...(userDictionaryMatches ? { userDictionaryMatches } : {}),
    };

    const response = await this.client.requestJson<RefineResponse>({
      model: this.model,
      schemaName: 'dictation_refinement',
      system: this.systemPrompt,
      promptCacheScope: this.promptCacheScope,
      user: userPayload,
      onTextSnapshot: input.onPartial,
    });

    const refinedText = normalizeOutputText(response.text);
    if (!refinedText) return reject(input.segmentIds, basedOnText, 'empty_output', startedAt);

    if (sameNormalized(basedOnText, refinedText)) {
      return reject(input.segmentIds, basedOnText, 'no_change', startedAt, refinedText);
    }

    // Deterministic backstop for refinement that diverged from the dictation
    // instead of cleaning it up (issue #336). Falls back to raw ASR.
    //
    // Treats LARGE divergence as out-of-bounds: output that is long, >=3x the
    // dictation, and mostly new characters (see isRefinementDiverged). This
    // catches the model answering / summarizing the dictation, and translating
    // it — by product decision translation is NOT a supported refinement, so
    // rejecting it (the user keeps their raw ASR text) is intended, even when
    // the user configured instructions. Legitimate refinements are untouched:
    //   - high-quality polishing / formatting keep the dictation's characters
    //     (high carry-over, length stays ~1x), and
    //   - modest compression only shortens (never reaches the >=3x threshold),
    // so none of them trip the guard regardless of user instructions.
    //
    // Scoped to the bundled default prompt: a host that injects its own system
    // prompt may run a deliberately different strategy (e.g. translation), which
    // this length/overlap heuristic would misread, so it opts out.
    if (this.usesBundledDefaultPrompt && isRefinementDiverged(basedOnText, refinedText)) {
      return reject(input.segmentIds, basedOnText, 'diverged_too_far', startedAt, refinedText);
    }

    return {
      accepted: true,
      sourceSegmentIds: input.segmentIds,
      basedOnText,
      refinedText,
      elapsedMs: performance.now() - startedAt,
    };
  }

  private getContext(dictationText: string): Omit<DictationRefinementContext, 'dictionaryAliasHints'> {
    const base = this.contextProvider?.() ?? {};
    const voiceInputHistory = normalizeVoiceInputHistory(
      base.voiceInputHistory,
      this.historyProvider?.(),
    );
    // The object key order is part of the prompt-cache strategy. Put stable
    // user settings before the single voice-history block, and keep volatile
    // cursor / per-request fields later so repeated refinements can reuse a
    // longer provider prefix.
    return {
      uiLanguage: normalizeOptionalText(base.uiLanguage),
      sourceLanguage: normalizeOptionalText(base.sourceLanguage),
      userRefinementInstructions: normalizeBoundedOptionalText(
        base.userRefinementInstructions,
        MAX_USER_REFINEMENT_INSTRUCTIONS_CHARS,
      ),
      userDictionary: normalizeBoundedOptionalMultilineText(base.userDictionary, MAX_USER_DICTIONARY_CHARS),
      voiceInputHistory,
      selectionBefore: takeRefinementContextTail(base.selectionBefore ?? '', MAX_SELECTION_CONTEXT_CHARS) || undefined,
      selectedText: takeRefinementContextHead(base.selectedText ?? '', MAX_SELECTION_CONTEXT_CHARS) || undefined,
      selectionAfter: takeRefinementContextHead(base.selectionAfter ?? '', MAX_SELECTION_CONTEXT_CHARS) || undefined,
      replyToMessage: truncateRefinementReply(base.replyToMessage ?? '', MAX_REPLY_TO_MESSAGE_CHARS) || undefined,
      userDictionaryMatches: buildUserDictionaryMatches(dictationText, base.dictionaryAliasHints),
    };
  }
}

function reject(
  segmentIds: string[],
  basedOnText: string,
  reason: string,
  startedAt: number,
  refinedText?: string,
): RefinementResult {
  return {
    accepted: false,
    sourceSegmentIds: segmentIds,
    basedOnText,
    refinedText,
    rejectionReason: reason,
    elapsedMs: performance.now() - startedAt,
  };
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeOutputText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeOptionalText(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const normalized = normalizeText(text);
  return normalized || undefined;
}

function normalizeBoundedOptionalText(text: unknown, maxChars: number): string | undefined {
  const normalized = normalizeOptionalText(text);
  if (!normalized) return undefined;
  return normalized.length > maxChars ? normalized.slice(0, maxChars).trim() : normalized;
}

function normalizeBoundedOptionalMultilineText(text: unknown, maxChars: number): string | undefined {
  const normalized = normalizeOptionalMultilineText(text);
  if (!normalized) return undefined;
  return normalized.length > maxChars ? normalized.slice(0, maxChars).trim() : normalized;
}

function normalizeOptionalMultilineText(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return normalized || undefined;
}

function buildUserDictionaryMatches(
  dictationText: string,
  hints: DictationRefinementContext['dictionaryAliasHints'],
): string | undefined {
  const normalizedDictation = normalizeMatchText(dictationText);
  if (!normalizedDictation || !Array.isArray(hints)) return undefined;

  const lines: string[] = [];
  const seenTerms = new Set<string>();
  const seenPairs = new Set<string>();
  // Alias matching runs on the user-visible stop -> refine path. Keep a hard
  // package-level cap even though the desktop host already sends a bounded,
  // priority-sorted index, so standalone hosts cannot accidentally add visible
  // latency with a very large dictionary.
  const normalizedHints = hints
    .slice(0, MAX_USER_DICTIONARY_HINTS_SCANNED)
    .map((hint) => {
      const term = normalizeText(typeof hint?.term === 'string' ? hint.term : '');
      if (!term) return null;
      const aliases = Array.isArray(hint.aliases)
        ? hint.aliases
          .slice(0, MAX_USER_DICTIONARY_ALIASES_SCANNED)
          .map((alias) => ({
            text: normalizeText(typeof alias?.text === 'string' ? alias.text : ''),
            matchText: normalizeMatchText(typeof alias?.text === 'string' ? alias.text : ''),
            count: normalizePositiveInteger(alias?.count),
          }))
          .filter((alias) => alias.text && alias.matchText && !sameMatchText(alias.text, term))
          .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
        : [];
      if (aliases.length === 0) return null;
      return {
        term,
        frequency: normalizePositiveInteger(hint.frequency),
        aliases,
      };
    })
    .filter((hint): hint is {
      term: string;
      frequency: number;
      aliases: Array<{ text: string; matchText: string; count: number }>;
    } => Boolean(hint))
    .sort((a, b) => b.frequency - a.frequency || b.aliases[0].count - a.aliases[0].count);

  for (const hint of normalizedHints) {
    if (lines.length >= MAX_USER_DICTIONARY_MATCHES) break;
    const termKey = normalizeMatchText(hint.term);
    if (seenTerms.has(termKey)) continue;
    const matchedAlias = hint.aliases.find((alias) => normalizedDictation.includes(alias.matchText));
    if (!matchedAlias) continue;
    const pairKey = `${matchedAlias.matchText}=>${termKey}`;
    if (seenPairs.has(pairKey)) continue;
    seenTerms.add(termKey);
    seenPairs.add(pairKey);
    lines.push(`- “${matchedAlias.text}” 可能是 “${hint.term}”`);
  }

  const block = lines.join('\n');
  return block.length > MAX_USER_DICTIONARY_MATCHES_CHARS
    ? block.slice(0, MAX_USER_DICTIONARY_MATCHES_CHARS).trim()
    : block || undefined;
}

function normalizePositiveInteger(value: unknown): number {
  return Math.max(1, Math.floor(typeof value === 'number' && Number.isFinite(value) ? value : 1));
}

function normalizeMatchText(value: string): string {
  return normalizeText(value).toLocaleLowerCase();
}

function sameMatchText(left: string, right: string): boolean {
  return normalizeMatchText(left) === normalizeMatchText(right);
}

function normalizeVoiceInputHistory(
  historyBlock: unknown,
  fallbackHistory: string[] | undefined,
): string | undefined {
  const direct = normalizeOptionalMultilineText(historyBlock);
  if (direct) return direct;
  if (!fallbackHistory?.length) return undefined;
  const lines = fallbackHistory
    .map((entry) => normalizeText(entry))
    .filter(Boolean)
    .map((entry) => `- ${entry}`);
  if (lines.length === 0) return undefined;
  return normalizeOptionalMultilineText(
    ['语音输入历史（旧到新，仅作术语、别名和用词风格参考）：', ...lines].join('\n'),
  );
}

function sameNormalized(lhs: string, rhs: string): boolean {
  return normalizeOutputText(lhs) === normalizeOutputText(rhs);
}

/**
 * True when `refinedText` invented substantial new content instead of cleaning
 * up the dictation — i.e. the model answered / summarized / translated it
 * (issue #336). Conservative by design: it only fires when the output's CONTENT
 * (letters/digits/CJK, ignoring whitespace/punctuation/markdown) is both
 * absolutely long and >=3x the dictation's content. A miss (rare out-of-bounds
 * output slipping through) is cheaper than a false positive (dropping a good
 * refinement to raw ASR). Measuring content — not raw length — is what keeps
 * formatting / reflowing (which add structure, not content) from tripping it.
 */
function isRefinementDiverged(basedOnText: string, refinedText: string): boolean {
  const inputContentLen = contentLength(basedOnText);
  const outputContentLen = contentLength(refinedText);
  if (inputContentLen === 0) return false;

  if (outputContentLen < DIVERGENCE_MIN_OUTPUT_CONTENT_CHARS) return false;
  return outputContentLen >= inputContentLen * DIVERGENCE_MIN_LENGTH_RATIO;
}

/**
 * Count of "content" code points — letters, digits and CJK — ignoring
 * whitespace, punctuation and markdown symbols (- # [ ] * > | etc.). Iterating
 * with for..of yields whole code points, so emoji / surrogate pairs are not
 * miscounted. Used so that reflowing the dictation into a list or adding
 * Markdown structure (lots of non-content characters) does not register as the
 * dictation having grown.
 */
function contentLength(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) count += 1;
  }
  return count;
}
