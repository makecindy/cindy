import type { TextModelClient } from './DictationRefiner';
import { takeRefinementContextHead, takeRefinementContextTail } from './refinementContext';
import type { DictationRefinementContext, RefinementResult } from './types';

export const DEFAULT_DICTATION_REWRITER_PROMPT_VERSION = 'dictation-rewrite.zh.v1';

export const DEFAULT_DICTATION_REWRITER_SYSTEM_PROMPT: string = `
你是 Cindy 的语音改写助手。用户选中了一段原文 selectedText，并口述了一条改写指令 instruction（例如翻译、润色、精简、扩写、调整语气或整理成列表）。

请严格按 instruction 改写 selectedText，只输出改写后的正文。保留原文中未被要求修改的关键事实与专有名词；参考 context 中的前后文和用户词典保持术语与格式连贯。

不要解释改写过程、不要附加寒暄或说明，不要用多余引号包裹。若 instruction 为空或明显与改写无关，原样返回 selectedText。

只返回 JSON：{"text":"改写后的文字"}。
`.trim();

export const MAX_VOICE_REWRITE_SELECTED_TEXT_CHARS = 8_000;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_SURROUNDING_CONTEXT_CHARS = 800;
const MAX_DICTIONARY_CHARS = 4_000;

type DictationRewriterOptions = {
  client: TextModelClient;
  model: string;
  contextProvider: () => DictationRefinementContext;
  systemPrompt?: string;
  promptVersion?: string;
};

type RewriteResponse = {
  text: string;
};

/**
 * Explicit "selected text + voice rewrite" processor.
 *
 * Completely separate from {@link DictationRefiner}:
 * - Never alters default dictation cleanup or its 3x divergence guard.
 * - Treats the spoken transcript as an editing instruction applied to
 *   `context.selectedText` (translation, expansion, summarization, tone shift).
 * - Intended to run through the desktop auxiliary model chain (`requestUtilityText`),
 *   never through managed `voice-server` `/refine` (whose system prompt hash is whitelisted).
 */
export class DictationRewriter {
  private readonly client: TextModelClient;
  private readonly model: string;
  private readonly contextProvider: () => DictationRefinementContext;
  private readonly systemPrompt: string;
  private readonly promptVersion: string;

  constructor(options: DictationRewriterOptions) {
    this.client = options.client;
    this.model = options.model;
    this.contextProvider = options.contextProvider;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_DICTATION_REWRITER_SYSTEM_PROMPT;
    this.promptVersion = options.promptVersion ?? DEFAULT_DICTATION_REWRITER_PROMPT_VERSION;
  }

  async refine(input: {
    text: string;
    runId: string;
    segmentIds: string[];
    onPartial?: (text: string) => void;
  }): Promise<RefinementResult> {
    const startedAt = Date.now();
    const instruction = input.text.trim().slice(0, MAX_INSTRUCTION_CHARS);
    if (!instruction) {
      return {
        accepted: false,
        sourceSegmentIds: input.segmentIds,
        basedOnText: input.text,
        rejectionReason: 'empty_instruction',
        elapsedMs: 0,
      };
    }

    const rawContext = this.contextProvider();
    const selectedText = rawContext.selectedText ?? '';
    if (selectedText.length > MAX_VOICE_REWRITE_SELECTED_TEXT_CHARS) {
      return {
        accepted: false,
        sourceSegmentIds: input.segmentIds,
        basedOnText: input.text,
        rejectionReason: 'selection_too_long',
        elapsedMs: 0,
      };
    }
    if (!selectedText.trim()) {
      return {
        accepted: false,
        sourceSegmentIds: input.segmentIds,
        basedOnText: input.text,
        rejectionReason: 'missing_selected_text',
        elapsedMs: 0,
      };
    }

    const compactContext: Record<string, unknown> = {};
    if (rawContext.sourceLanguage) compactContext.sourceLanguage = rawContext.sourceLanguage;
    if (rawContext.uiLanguage) compactContext.uiLanguage = rawContext.uiLanguage;
    if (rawContext.selectionBefore) {
      compactContext.selectionBefore = takeRefinementContextTail(
        rawContext.selectionBefore,
        MAX_SURROUNDING_CONTEXT_CHARS,
      );
    }
    if (rawContext.selectionAfter) {
      compactContext.selectionAfter = takeRefinementContextHead(
        rawContext.selectionAfter,
        MAX_SURROUNDING_CONTEXT_CHARS,
      );
    }
    if (rawContext.userDictionary && rawContext.userDictionary.trim()) {
      compactContext.userDictionary = rawContext.userDictionary.slice(0, MAX_DICTIONARY_CHARS);
    }

    try {
      const response = await this.client.requestJson<RewriteResponse>({
        model: this.model,
        system: this.systemPrompt,
        user: {
          promptVersion: this.promptVersion,
          selectedText,
          instruction,
          context: compactContext,
        },
        schemaName: 'dictation_rewrite',
        onTextSnapshot: input.onPartial,
      });
      const rewritten = typeof response?.text === 'string' ? response.text.trim() : '';
      if (!rewritten) {
        return {
          accepted: false,
          sourceSegmentIds: input.segmentIds,
          basedOnText: input.text,
          rejectionReason: 'empty_rewrite',
          elapsedMs: Date.now() - startedAt,
        };
      }
      return {
        accepted: true,
        sourceSegmentIds: input.segmentIds,
        basedOnText: input.text,
        refinedText: rewritten,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        accepted: false,
        sourceSegmentIds: input.segmentIds,
        basedOnText: input.text,
        rejectionReason: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      };
    }
  }
}
