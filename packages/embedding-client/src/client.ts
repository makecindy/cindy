/**
 * EmbeddingClient — OpenAI /v1/embeddings 兼容客户端 (XD Gateway)。
 *
 * 设计:
 *   - 零运行依赖, 仅用全局 fetch (Node 18+ / Electron 28+)
 *   - 同步语义: 调方传 N 条 → 一次 HTTP 请求 (拆批/速率控制由上层 Worker 决定, 不在本层做)
 *   - 重试: 5xx / 429 / network 走指数退避 (1s / 5s / 15s, 最多 3 次)
 *   - 缓存: 进程内 LRU, key = sha256(model + '\0' + text); 命中位次回填 embeddings
 *   - 错误: 统一 EmbeddingError + code, 让 Worker 按 code 决定是否计 attempts
 *
 * 不做:
 *   - 拆批 (调方自负 model.maxTokens)
 *   - 持久化缓存 (Phase 1.1 范围外)
 *   - 自动 model fallback (consumer 业务决策)
 *
 * 两条嵌入路径:
 *   - `embed()`      : 一批独立文本 → 一批向量。走 LRU 缓存。
 *   - `embedDocuments()`: 上下文化(voyage-context-*)索引侧 —— 按文档分组,同文档
 *     chunk 互为上下文。**不走缓存**:一个 chunk 的向量取决于它所在文档,单 chunk
 *     级 key 表达不了这个依赖,缓存了就会在"同一段文字出现在另一个文档里"时给错。
 *   两条路径共用同一个 endpoint 与同一套响应解析(见 ContextualizedResponse)。
 */

import { createHash } from 'node:crypto';

import { getEmbeddingModel, isKnownEmbeddingModel, listEmbeddingModels } from './catalog.js';
import { LruCache } from './lruCache.js';
import {
  EmbeddingError,
  type EmbedDocumentsRequest,
  type EmbedDocumentsResponse,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingClientOptions,
  type EmbeddingInputType,
  type EmbeddingLogger,
  type EmbeddingModelMeta,
} from './types.js';

/**
 * 中立 inputType → 各家 wire 值。null = 该家不支持,不发这个字段。
 *
 * 值域是**互斥**的(2026-08-04 经 XD 网关实测,见 apps/desktop 的
 * ipc/dev/embedding.ts 透传探测):
 *   - voyage 传大写 → 500 VoyageException;
 *   - google(经 Vertex)传小写 → 400 Invalid value at 'task_type';
 *   - openai 两种都回 200 但无任何效果(参数不存在,被静默忽略)。
 * 所以这里必须按 provider 翻译,不能原样透传 —— 透传等于让一半模型确定性报错。
 */
const INPUT_TYPE_WIRE: Record<
  EmbeddingModelMeta['provider'],
  Record<EmbeddingInputType, string> | null
> = {
  voyage: { query: 'query', document: 'document' },
  google: { query: 'RETRIEVAL_QUERY', document: 'RETRIEVAL_DOCUMENT' },
  openai: null,
};

const DEFAULT_CACHE_SIZE = 1000;
// 重试间隔 (ms): 1s / 5s / 15s. 共最多 4 次尝试 (initial + 3 retries)。
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

interface OpenAiEmbeddingsResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * 网关 /v1/embeddings 的两种响应形态(2026-08-04 自 live gateway LiteLLM 实抓)。
 *
 *   A. 一层 flat —— 普通型号:`data: [{ object:'embedding', index, embedding }]`
 *   B. 两层嵌套 —— voyage-context-*:
 *      `data: [{ object:'list', index, data: [{ object:'embedding', index, embedding }] }]`
 *      外层一项 = 一个文档,内层 = 该文档的 per-chunk 向量。
 *
 * **形态由型号决定,不由请求决定**:voyage-context-* 的查询侧请求虽然发的是一维
 * `input`,回来的**仍然是**两层(每个 input 成为一个单 chunk 文档)。所以扁平路径
 * (`embed()`)也必须能吃嵌套响应 —— 只按 `data[].embedding` 解析会对这些型号
 * 直接失败。两条路径因此共用 `parseGroupedEmbeddings`。
 */
interface ContextualizedResponse {
  data: Array<
    | { object?: 'embedding'; embedding: number[]; index?: number }
    | { object?: 'list'; data: Array<{ embedding: number[]; index?: number }>; index?: number }
  >;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * 按响应项自报的 `index` 把它们放回确定的位次;`index` 缺省时退回数组序。
 *
 * 为什么不是"排个序就完事"(PR #1707 review):排序只保证顺序单调,不保证位次是**一个
 * 双射**。上游回重复 index(如请求 2 项、响应 index 为 0/1/1)时,排序后条数可能刚好
 * 对得上,于是所有条数校验都通过,而某一项的向量被另一项静默顶掉 —— 交付出去的是
 * 错误位置的向量,不报任何错。越界 index 同理:多出来的项如果不导致缺位,就完全不会
 * 被发现。所以这里要求 **项数相等 + 无重复 + 无越界**,三条齐了位次才必然填满。
 *
 * `what` 只用于报错定位(document / chunk / embedding)。
 */
function orderedByIndex<T>(
  items: readonly T[],
  indexOf: (item: T, arrayOrder: number) => number,
  expected: number,
  what: string,
): T[] {
  if (items.length !== expected) {
    throw new EmbeddingError(
      `contextualized response: got ${items.length} ${what} entries, expected ${expected}`,
      'SERVER_ERROR',
    );
  }
  const slots = new Array<T | undefined>(expected);
  items.forEach((item, arrayOrder) => {
    const idx = indexOf(item, arrayOrder);
    if (!Number.isInteger(idx) || idx < 0 || idx >= expected) {
      throw new EmbeddingError(
        `contextualized response: ${what} index ${String(idx)} out of range (expected 0..${expected - 1})`,
        'SERVER_ERROR',
      );
    }
    if (slots[idx] !== undefined) {
      throw new EmbeddingError(
        `contextualized response: duplicate ${what} index ${idx}`,
        'SERVER_ERROR',
      );
    }
    slots[idx] = item;
  });
  // 项数相等 + 无重复 + 无越界 ⇒ 每个位次都被填过,无需再判空。
  return slots as T[];
}

/**
 * 把响应解析成按文档分组的向量。两种形态都吃(见 ContextualizedResponse 注释),
 * 形状不认识时抛 SERVER_ERROR 而不是给出半个结果。
 *
 * `groupSizes` 是**期望**的分组:扁平路径传全 1(每个 input 一个单 chunk 文档),
 * 上下文化索引侧传各文档真实 chunk 数。它同时充当条数校验 —— 上游少给 / 多给、
 * 或 index 重复 / 越界,都在这里失败,不会让调方拿到错位的向量。
 */
function parseGroupedEmbeddings(
  body: ContextualizedResponse,
  groupSizes: readonly number[],
): number[][][] {
  const items = body.data ?? [];
  const nested = items.length > 0 && Array.isArray((items[0] as { data?: unknown }).data);
  if (nested) {
    // 嵌套形态:一项一个文档。外层与内层都要求 index 构成双射(见 orderedByIndex)。
    const docs = orderedByIndex(
      items as Array<{ index?: number; data: Array<{ embedding: number[]; index?: number }> }>,
      (item, arrayOrder) => item.index ?? arrayOrder,
      groupSizes.length,
      'document',
    );
    return docs.map((doc, docIndex) => {
      const chunks = orderedByIndex(
        doc.data ?? [],
        (entry, arrayOrder) => entry.index ?? arrayOrder,
        groupSizes[docIndex],
        `document ${docIndex} chunk`,
      );
      return chunks.map((entry) => entry.embedding);
    });
  }
  // 扁平形态:所有 chunk 按全局顺序摊平,按 groupSizes 重新切回文档。
  // 形状判定要走在位次解析之前 —— 条数刚好对上的坏形态应当报"形状不认识",
  // 而不是报一个会把人带偏的条数/位次错误。
  const raw = items as Array<{ embedding?: number[]; index?: number }>;
  if (raw.some((item) => !Array.isArray(item.embedding))) {
    throw new EmbeddingError(
      'contextualized response: unrecognized data shape (neither flat embeddings nor per-document groups)',
      'SERVER_ERROR',
    );
  }
  const total = groupSizes.reduce((sum, n) => sum + n, 0);
  const flat = orderedByIndex(
    raw,
    (item, arrayOrder) => item.index ?? arrayOrder,
    total,
    'embedding',
  ).map((item) => item.embedding as number[]);
  const out: number[][][] = [];
  let cursor = 0;
  for (const size of groupSizes) {
    out.push(flat.slice(cursor, cursor + size) as number[][]);
    cursor += size;
  }
  return out;
}

interface OpenAiErrorResponse {
  error?: { message?: string; type?: string; code?: string };
}

/**
 * 校验**批内每一条**向量的长度都一致, 且(显式请求了维度时)等于请求值。
 *
 * 两件事分开说:
 *
 * 1. 只看首条不够(PR #1707 review 第四轮):首条对、后面某条错时检查会通过, 整批被
 *    缓存并交付, 上层(cindySlot)又按首条填 `dim` —— 调方拿到一批"声称同维度"其实
 *    不等长的向量, 写进索引后相似度失去意义, 而且哪一步都没有报错。
 *
 * 2. **没显式传 dimensions 时也必须校验**(同 review 第五轮):那是文档示例和绝大多数
 *    调用走的路径, 之前直接 return 等于整条默认路径零校验。这里的判据是"全批与首条
 *    一致"而不是"等于 catalog 的 `dim`":catalog 的 `dim` 记的是**上游当前的默认值**,
 *    上游改默认时拿它硬判会把本来正常的响应全判失败;而"批内不等长"无论默认值是多少
 *    都一定是坏数据。
 *
 * 上游对不支持的维度行为不统一(可能 400, 也可能静默回默认长度), 这里是最后一道
 * 能看见长度的地方。
 *
 * `mode` 只影响报错里的位置描述:扁平路径每组恒为 1 条(组下标 = 文本下标),报
 * "group 3 index 0" 只会让调方困惑。
 */
function assertBatchDimensions(
  grouped: readonly number[][][],
  model: string,
  dimensions: number | undefined,
  mode: 'flat' | 'grouped',
): void {
  // 缺省时以首条为基准 —— 校验的是"整批自洽",不是"符合某个记在客户端里的常量"。
  let expected = dimensions;
  for (let d = 0; d < grouped.length; d++) {
    const group = grouped[d];
    for (let c = 0; c < group.length; c++) {
      const got = group[c]?.length;
      if (got === undefined) continue;
      if (expected === undefined) {
        expected = got;
        continue;
      }
      if (got !== expected) {
        // 位置信息带上:一批 32 条里第 17 条错,没有下标就只能靠猜。
        const at = mode === 'flat' ? `index ${d}` : `group ${d} index ${c}`;
        const why =
          dimensions === undefined
            ? `model '${model}' returned mixed vector lengths (${expected} then ${got})`
            : `requested dimensions=${dimensions} but model '${model}' returned ${got}`;
        throw new EmbeddingError(`${why} at ${at}`, 'INVALID_MODEL');
      }
    }
  }
}

export class EmbeddingClient {
  private readonly resolveBaseUrl: () => string;
  private readonly getApiKey: () => string | undefined | null;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: LruCache<string, number[]>;
  private readonly log: EmbeddingLogger;

  constructor(opts: EmbeddingClientOptions) {
    // baseUrl 支持函数形态:宿主的网关 endpoint 可能在运行期变化(如登录后由
    // 服务端下发),每次请求现取,避免构造期快照钉死旧地址。
    const normalize = (raw: string): string => {
      let baseUrl = raw;
      while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
      return baseUrl;
    };
    const rawBaseUrl = opts.baseUrl;
    this.resolveBaseUrl =
      typeof rawBaseUrl === 'function' ? () => normalize(rawBaseUrl()) : () => normalize(rawBaseUrl);
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.cache = new LruCache<string, number[]>(opts.cacheSize ?? DEFAULT_CACHE_SIZE);
    this.log = opts.logger ?? {};
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('EmbeddingClient: global fetch not available; pass fetchImpl');
    }
  }

  /** 列出 catalog 中所有可用模型, 调方做 UI 选择 / 校验。 */
  listModels(): EmbeddingModelMeta[] {
    return listEmbeddingModels();
  }

  /**
   * 嵌入一批文本。返 embeddings 与 texts 一一对应; 缓存命中位次直接回填。
   * texts 为空数组 → 直接返空结果, 不打网络。
   */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (!isKnownEmbeddingModel(req.model)) {
      throw new EmbeddingError(
        `unknown embedding model '${req.model}'`,
        'INVALID_MODEL',
      );
    }
    if (req.texts.length === 0) {
      return { embeddings: [], modelUsed: req.model, tokensUsed: 0, cacheHits: 0 };
    }

    // 1. 查缓存, 拆出 miss index
    const result: number[][] = new Array(req.texts.length);
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    let cacheHits = 0;
    // inputType / dimensions 必须计入 key:同一段文本在 query 档与 document 档下是
    // 两个不同的向量(上游加了不同前缀), 维度不同更是长度都不一样。漏计 = 后到的
    // 请求静默拿到前一档的向量, 而且因为形状看起来正常, 排查时毫无线索。
    const variant = cacheVariant(req.inputType, req.dimensions);
    for (let i = 0; i < req.texts.length; i++) {
      const key = cacheKey(req.model, req.texts[i], variant);
      const cached = this.cache.get(key);
      if (cached) {
        result[i] = cached;
        cacheHits++;
      } else {
        missIdx.push(i);
        missTexts.push(req.texts[i]);
      }
    }

    // 全命中 — 不打网络
    if (missTexts.length === 0) {
      return { embeddings: result, modelUsed: req.model, tokensUsed: 0, cacheHits };
    }

    // 2. 调 XD Gateway
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new EmbeddingError(
        'no API key available (user not logged in or safeStorage failure)',
        'AUTH_FAILED',
      );
    }

    const apiResponse = await this.callWithRetry(apiKey, req.model, missTexts, req);

    // 3. 写回结果 + 缓存
    //
    // 一维 input 也可能拿到两层嵌套响应 —— voyage-context-* 的形态由**型号**决定,
    // 与请求是几维无关(每个 input 成为一个单 chunk 文档)。所以统一走
    // parseGroupedEmbeddings:期望分组为"N 个文档各 1 chunk",再摊平回一维。
    // 条数校验也在那里做(少给/多给都失败,不会错位交付)。
    const grouped = parseGroupedEmbeddings(
      apiResponse as unknown as ContextualizedResponse,
      missTexts.map(() => 1),
    );
    // 维度自检:显式请求了维度就必须兑现。上游对"不支持的维度"行为不统一(可能
    // 400, 也可能静默回默认长度), 静默那条最危险 —— 调方按请求值建索引 / 预分配,
    // 拿到的却是另一个长度, 而报错点会漂到很远的地方。
    //
    // **必须在写缓存之前判**(PR #1707 review):先写后判会让本次抛错、缓存里却留下
    // 那批错长度的向量 —— 下一次同参请求全命中缓存直接 return, 绕过这里的自检把
    // 非法向量当成功交付出去。判在前面 = 非法响应一条都不入缓存。
    assertBatchDimensions(grouped, req.model, req.dimensions, 'flat');

    for (let j = 0; j < missTexts.length; j++) {
      const vec = grouped[j]?.[0];
      if (!vec) {
        throw new EmbeddingError(
          `XD Gateway response missing embedding for input index ${j}`,
          'SERVER_ERROR',
        );
      }
      const targetIdx = missIdx[j];
      result[targetIdx] = vec;
      this.cache.set(cacheKey(req.model, missTexts[j], variant), vec);
    }

    return {
      embeddings: result,
      modelUsed: apiResponse.model || req.model,
      tokensUsed: apiResponse.usage?.prompt_tokens ?? apiResponse.usage?.total_tokens ?? 0,
      cacheHits,
    };
  }

  /**
   * 上下文化嵌入 (voyage-context-* 索引侧):按文档分组嵌入,同文档 chunk 互为上下文。
   *
   * wire 形态与 `embed()` 同一个端点,差别只在 `input` 是二维数组。
   *
   * **不走缓存**:一个 chunk 的向量取决于它所在文档,单 chunk 级 key 无法表达这个
   * 依赖 —— 缓存了就会在"同一段文字出现在另一个文档里"时给出错误的向量。
   */
  async embedDocuments(req: EmbedDocumentsRequest): Promise<EmbedDocumentsResponse> {
    if (!isKnownEmbeddingModel(req.model)) {
      throw new EmbeddingError(`unknown embedding model '${req.model}'`, 'INVALID_MODEL');
    }
    if (req.documents.length === 0) {
      return { embeddings: [], modelUsed: req.model, tokensUsed: 0 };
    }
    if (req.documents.some((doc) => doc.length === 0)) {
      throw new EmbeddingError('documents 不能包含空的 chunk 序列', 'INVALID_MODEL');
    }
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new EmbeddingError(
        'no API key available (user not logged in or safeStorage failure)',
        'AUTH_FAILED',
      );
    }
    const groupSizes = req.documents.map((doc) => doc.length);
    const body = await this.callWithRetry(apiKey, req.model, req.documents, req);
    const embeddings = parseGroupedEmbeddings(
      body as unknown as ContextualizedResponse,
      groupSizes,
    );
    assertBatchDimensions(embeddings, req.model, req.dimensions, 'grouped');
    return {
      embeddings,
      modelUsed: body.model || req.model,
      tokensUsed: body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0,
    };
  }

  /**
   * 带重试的 POST /v1/embeddings。重试条件:
   *   - 5xx / 429 / NETWORK_ERROR → 退避后重试 (最多 RETRY_DELAYS_MS.length 次)
   *   - 401/403 (AUTH_FAILED) / 400 (INVALID_MODEL) / TIMEOUT → 立即抛
   *
   * `opts.timeoutMs` 是**整条链**(含所有重试与退避睡眠)的预算, 不是单次 HTTP 的:
   * 每次尝试只拿剩余额度, 退避前先看剩余额度够不够, 不够就直接抛 TIMEOUT 而不是
   * 白睡一觉。否则 n 次重试会把调方看到的最坏等待放大成 n 倍预算。
   */
  private async callWithRetry(
    apiKey: string,
    model: string,
    // string[][] = 上下文化的按文档分组输入(见 embedDocuments);wire 上原样发。
    inputs: string[] | string[][],
    opts: Pick<EmbedRequest, 'inputType' | 'dimensions' | 'timeoutMs'>,
  ): Promise<OpenAiEmbeddingsResponse> {
    let attempt = 0;
    // initial + retries
    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    let lastErr: EmbeddingError | null = null;
    const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : null;

    while (attempt < maxAttempts) {
      try {
        let remaining: number | undefined;
        if (deadline !== null) {
          remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new EmbeddingError(
              `embed: timed out after ${opts.timeoutMs}ms (budget exhausted before attempt ${attempt + 1})`,
              'TIMEOUT',
            );
          }
        }
        return await this.callOnce(apiKey, model, inputs, opts, remaining);
      } catch (err) {
        if (!(err instanceof EmbeddingError)) {
          // 防御性: 任何非 EmbeddingError 都视作 SERVER_ERROR 走重试
          lastErr = new EmbeddingError(
            err instanceof Error ? err.message : String(err),
            'SERVER_ERROR',
          );
        } else {
          lastErr = err;
        }
        const retriable =
          lastErr.code === 'NETWORK_ERROR' ||
          lastErr.code === 'RATE_LIMITED' ||
          lastErr.code === 'SERVER_ERROR';
        if (!retriable || attempt >= maxAttempts - 1) {
          throw lastErr;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        // 退避前先看预算:睡完必然过期就别睡了,把原始失败原因换成 TIMEOUT 抛出去
        // (调方等的是"最多 timeoutMs",不是"最多 timeoutMs + 所有退避时间")。
        if (deadline !== null && Date.now() + delay >= deadline) {
          throw new EmbeddingError(
            `embed: timed out after ${opts.timeoutMs}ms (last failure: ${lastErr.code})`,
            'TIMEOUT',
          );
        }
        this.log.warn?.(
          `[embedding-client] attempt ${attempt + 1}/${maxAttempts} failed (${lastErr.code}); retry in ${delay}ms`,
        );
        await sleep(delay);
        attempt++;
      }
    }
    // unreachable; throw 早已发生
    throw lastErr ?? new EmbeddingError('embed: exhausted retries', 'SERVER_ERROR');
  }

  /**
   * 单次 HTTP 调用, 不重试。
   * fetch 抛错 → NETWORK_ERROR; 非 2xx → 按 status 映射 code。
   *
   * `budgetMs` = 本次尝试可用的剩余时间(由 callWithRetry 从整体预算里切出来)。
   * 用自建 AbortController 而不是 `AbortSignal.timeout()`:定时器要能在正常返回后
   * 立刻 clear 掉, 不让它空转到超时点(每次调用留一个活定时器会拖住事件循环退出)。
   * 计时覆盖到读完 body 为止 —— 响应头很快、body 迟迟不来也算超时。
   */
  private async callOnce(
    apiKey: string,
    model: string,
    inputs: string[] | string[][],
    opts: Pick<EmbedRequest, 'inputType' | 'dimensions'>,
    budgetMs?: number,
  ): Promise<OpenAiEmbeddingsResponse> {
    const url = `${this.resolveBaseUrl()}/v1/embeddings`;
    // inputType 按 provider 翻成该家的 wire 值(不支持的家不发这个字段);
    // dimensions 统一用 OpenAI 的名字 —— 三家经网关都认它, Voyage 自己的
    // output_dimension 只对 voyage 生效。
    const provider = getEmbeddingModel(model)?.provider;
    const wireInputType =
      opts.inputType && provider ? INPUT_TYPE_WIRE[provider]?.[opts.inputType] : undefined;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (budgetMs !== undefined) {
      const c = new AbortController();
      controller = c;
      timer = setTimeout(() => c.abort(), Math.max(1, budgetMs));
    }
    // abort 之后 fetch 抛的是 AbortError,与真正的网络故障混在一起 —— 但两者的
    // 重试语义相反(网络错该重试、超时不该),所以靠 signal.aborted 而不是错误
    // 消息来区分。
    //
    // 前提:fetchImpl 必须尊重 AbortSignal(真 fetch / undici 的契约)。无视
    // signal 的替身若最终正常返回,这里不会把它判成超时 —— 预算只能约束"愿意被
    // 中断"的实现,注入自定义 fetchImpl 时需自行保证这一点。
    const timedOut = (): boolean => controller?.signal.aborted === true;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: inputs,
            ...(wireInputType ? { input_type: wireInputType } : {}),
            ...(opts.dimensions !== undefined ? { dimensions: opts.dimensions } : {}),
          }),
          ...(controller !== null ? { signal: controller.signal } : {}),
        });
      } catch (err) {
        if (timedOut()) {
          throw new EmbeddingError(`request aborted after ${budgetMs}ms budget`, 'TIMEOUT');
        }
        // DNS / socket reset 走这里
        throw new EmbeddingError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
          'NETWORK_ERROR',
        );
      }

      if (!res.ok) {
        // 读错误响应体时也可能撞上预算(网关先回了 400 的头,body 却挂住或断流)。
        // 这里若把 AbortError 一并吞成空串,下面就会按 HTTP 状态抛 INVALID_MODEL /
        // AUTH_FAILED,而外层看到的是 EmbeddingError 也不会再改判 —— 一次实打实
        // 耗尽预算的请求就被报成"你该改参数",与结构化错误契约矛盾
        // (PR #1707 review)。所以吞之前先看 signal。
        const text = await res.text().catch(() => {
          if (timedOut()) {
            throw new EmbeddingError(`request aborted after ${budgetMs}ms budget`, 'TIMEOUT');
          }
          return '';
        });
        let parsedMsg = '';
        try {
          const parsed = JSON.parse(text) as OpenAiErrorResponse;
          parsedMsg = parsed.error?.message ?? '';
        } catch {
          /* not JSON */
        }
        const code = mapStatusToCode(res.status);
        throw new EmbeddingError(
          `XD Gateway /v1/embeddings ${res.status}: ${parsedMsg || text || res.statusText}`,
          code,
          res.status,
          text,
        );
      }

      // body 读到一半被 abort → json() 抛错, 由下面的 catch 归成 TIMEOUT。
      // 抢在定时器前读完就照常返回:手里已经是一份合法响应, 不为了"时间刚好到了"
      // 把它丢掉再让调方失败。
      return (await res.json()) as OpenAiEmbeddingsResponse;
    } catch (err) {
      // json() / text() 在 abort 后抛的也要归到 TIMEOUT,别伪装成解析失败。
      if (timedOut() && !(err instanceof EmbeddingError)) {
        throw new EmbeddingError(`request aborted after ${budgetMs}ms budget`, 'TIMEOUT');
      }
      throw err;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

function mapStatusToCode(status: number): EmbeddingError['code'] {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 400 || status === 404 || status === 422) return 'INVALID_MODEL';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  // 其它 4xx 视作 INVALID 不重试
  return 'INVALID_MODEL';
}

/**
 * 请求变体标识 —— 同一 (model, text) 在不同 inputType / dimensions 下是不同的向量,
 * 必须进 cache key。空串 = 两者都缺省(与加入本参数之前的 key 语义一致)。
 */
function cacheVariant(inputType: string | undefined, dimensions: number | undefined): string {
  if (inputType === undefined && dimensions === undefined) return '';
  return `${inputType ?? ''}:${dimensions ?? ''}`;
}

function cacheKey(model: string, text: string, variant: string): string {
  // sha256(model + '\0' + variant + '\0' + text); 用 NUL 分隔避免
  // 'a' + 'bc' / 'ab' + 'c' 碰撞
  const h = createHash('sha256');
  h.update(model);
  h.update('\x00');
  h.update(variant);
  h.update('\x00');
  h.update(text);
  return h.digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 模型相关的小工具直接 re-export, 方便 consumer 共用同一份 catalog 查询。
export { getEmbeddingModel } from './catalog.js';
