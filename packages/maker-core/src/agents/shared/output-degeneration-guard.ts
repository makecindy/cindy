/**
 * 流式正文退化检测器。
 *
 * 长度本身不是异常。只有一个足够长的滑动窗口同时满足“字符 n-gram 多样性很低”与
 * “前后半窗高度相似”，并在相隔的检查点重复确认，才判定为低熵重复。检测器只保存
 * 有界正文窗口，不做 IO、不匹配语言或意图关键词；调用方负责决定启用范围与中断方式。
 */

const DEFAULT_MINIMUM_CHARACTERS = 16_384;
const DEFAULT_ANALYSIS_WINDOW_CHARACTERS = 8_192;
const DEFAULT_CHECK_INTERVAL_CHARACTERS = 2_048;
const DEFAULT_NGRAM_SIZE = 5;
const DEFAULT_MAX_UNIQUE_NGRAM_RATIO = 0.08;
const DEFAULT_MIN_HALF_SIMILARITY = 0.92;
const DEFAULT_REQUIRED_CONFIRMATIONS = 2;

export interface OutputDegenerationGuardOptions {
  /** 开始检查前，当前 assistant message 至少需要输出多少个归一化字符。 */
  minimumCharacters?: number;
  /** 每次判定只观察末尾多少个归一化字符。 */
  analysisWindowCharacters?: number;
  /** 两次高置信确认之间至少相隔多少个归一化字符。 */
  checkIntervalCharacters?: number;
  /** 字符 n-gram 大小；字符级统计同时覆盖中文、英文和代码。 */
  ngramSize?: number;
  /** 窗口内 unique n-gram / 总 n-gram 的最大比例。 */
  maxUniqueNgramRatio?: number;
  /** 前后半窗 n-gram 集合的最小 Jaccard 相似度。 */
  minHalfSimilarity?: number;
  /** 连续多少个检查点命中后才返回 hard。 */
  requiredConfirmations?: number;
}

export type OutputDegenerationVerdict =
  | { kind: 'ok' }
  | {
      kind: 'hard';
      reason: 'low-entropy-repetition';
      observedCharacters: number;
      analysisWindowCharacters: number;
      uniqueNgramRatio: number;
      halfSimilarity: number;
      confirmations: number;
    };

interface OutputDegenerationMetrics {
  uniqueNgramRatio: number;
  halfSimilarity: number;
}

export class OutputDegenerationGuard {
  readonly minimumCharacters: number;
  readonly analysisWindowCharacters: number;
  readonly checkIntervalCharacters: number;
  readonly ngramSize: number;
  readonly maxUniqueNgramRatio: number;
  readonly minHalfSimilarity: number;
  readonly requiredConfirmations: number;

  private chunks: string[] = [];
  private observedCharacters = 0;
  private nextCheckAt: number;
  private consecutiveConfirmations = 0;
  private lastNormalizedCharacterWasWhitespace = false;
  private triggered = false;

  constructor(options: OutputDegenerationGuardOptions = {}) {
    this.minimumCharacters = positiveInteger(
      options.minimumCharacters,
      DEFAULT_MINIMUM_CHARACTERS,
    );
    this.analysisWindowCharacters = positiveInteger(
      options.analysisWindowCharacters,
      DEFAULT_ANALYSIS_WINDOW_CHARACTERS,
    );
    this.checkIntervalCharacters = positiveInteger(
      options.checkIntervalCharacters,
      DEFAULT_CHECK_INTERVAL_CHARACTERS,
    );
    this.ngramSize = positiveInteger(options.ngramSize, DEFAULT_NGRAM_SIZE);
    this.maxUniqueNgramRatio = boundedRatio(
      options.maxUniqueNgramRatio,
      DEFAULT_MAX_UNIQUE_NGRAM_RATIO,
    );
    this.minHalfSimilarity = boundedRatio(
      options.minHalfSimilarity,
      DEFAULT_MIN_HALF_SIMILARITY,
    );
    this.requiredConfirmations = positiveInteger(
      options.requiredConfirmations,
      DEFAULT_REQUIRED_CONFIRMATIONS,
    );
    this.nextCheckAt = this.minimumCharacters;
  }

  /** 每条 assistant message 的 start 边界调用，禁止跨消息累计。 */
  resetMessage(): void {
    this.chunks = [];
    this.observedCharacters = 0;
    this.nextCheckAt = this.minimumCharacters;
    this.consecutiveConfirmations = 0;
    this.lastNormalizedCharacterWasWhitespace = false;
    this.triggered = false;
  }

  onTextDelta(delta: string): OutputDegenerationVerdict {
    if (this.triggered || delta.length === 0) return { kind: 'ok' };

    const normalized = this.normalizeDelta(delta);
    if (normalized.length === 0) return { kind: 'ok' };

    let offset = 0;
    while (offset < normalized.length) {
      const charactersUntilCheck = this.nextCheckAt - this.observedCharacters;
      const nextOffset = Math.min(normalized.length, offset + charactersUntilCheck);
      this.chunks.push(normalized.slice(offset, nextOffset));
      this.observedCharacters += nextOffset - offset;
      offset = nextOffset;

      if (this.observedCharacters < this.nextCheckAt) continue;
      this.nextCheckAt += this.checkIntervalCharacters;

      const verdict = this.evaluateCheckpoint();
      if (verdict.kind === 'hard') return verdict;
    }

    return { kind: 'ok' };
  }

  private evaluateCheckpoint(): OutputDegenerationVerdict {
    const window = this.compactWindow();
    if (window.length < this.analysisWindowCharacters) return { kind: 'ok' };
    const metrics = outputDegenerationMetrics(window, this.ngramSize);
    const suspicious =
      metrics.uniqueNgramRatio <= this.maxUniqueNgramRatio
      && metrics.halfSimilarity >= this.minHalfSimilarity;
    if (!suspicious) {
      this.consecutiveConfirmations = 0;
      return { kind: 'ok' };
    }

    this.consecutiveConfirmations += 1;
    if (this.consecutiveConfirmations < this.requiredConfirmations) return { kind: 'ok' };

    this.triggered = true;
    return {
      kind: 'hard',
      reason: 'low-entropy-repetition',
      observedCharacters: this.observedCharacters,
      analysisWindowCharacters: window.length,
      uniqueNgramRatio: metrics.uniqueNgramRatio,
      halfSimilarity: metrics.halfSimilarity,
      confirmations: this.consecutiveConfirmations,
    };
  }

  private normalizeDelta(delta: string): string {
    let normalized = delta.toLowerCase().replace(/\s+/gu, ' ');
    if (this.lastNormalizedCharacterWasWhitespace && normalized.startsWith(' ')) {
      normalized = normalized.slice(1);
    }
    this.lastNormalizedCharacterWasWhitespace = /\s$/u.test(delta);
    return normalized;
  }

  /** 仅在间隔检查点合并 chunk，避免每个 token delta 都复制整个滑动窗口。 */
  private compactWindow(): string {
    const joined = this.chunks.join('');
    const window = joined.slice(-this.analysisWindowCharacters);
    this.chunks = [window];
    return window;
  }
}

function outputDegenerationMetrics(text: string, ngramSize: number): OutputDegenerationMetrics {
  const all = ngramsOf(text, ngramSize);
  const totalNgrams = Math.max(1, text.length - ngramSize + 1);
  const midpoint = Math.floor(text.length / 2);
  const firstHalf = ngramsOf(text.slice(0, midpoint), ngramSize);
  const secondHalf = ngramsOf(text.slice(midpoint), ngramSize);

  let intersection = 0;
  for (const gram of firstHalf) {
    if (secondHalf.has(gram)) intersection += 1;
  }
  const union = firstHalf.size + secondHalf.size - intersection;
  return {
    uniqueNgramRatio: all.size / totalNgrams,
    halfSimilarity: union === 0 ? 0 : intersection / union,
  };
}

function ngramsOf(text: string, size: number): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index <= text.length - size; index += 1) {
    grams.add(text.slice(index, index + size));
  }
  return grams;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function boundedRatio(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}
