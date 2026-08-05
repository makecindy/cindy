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
 */

import { createHash } from 'node:crypto';

import { getEmbeddingModel, isKnownEmbeddingModel, listEmbeddingModels } from './catalog.js';
import { LruCache } from './lruCache.js';
import {
  EmbeddingError,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingClientOptions,
  type EmbeddingLogger,
  type EmbeddingModelMeta,
} from './types.js';

const DEFAULT_CACHE_SIZE = 1000;
// 重试间隔 (ms): 1s / 5s / 15s. 共最多 4 次尝试 (initial + 3 retries)。
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

interface OpenAiEmbeddingsResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface OpenAiErrorResponse {
  error?: { message?: string; type?: string; code?: string };
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
    for (let i = 0; i < req.texts.length; i++) {
      const key = cacheKey(req.model, req.texts[i]);
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

    const apiResponse = await this.callWithRetry(apiKey, req.model, missTexts);

    // 3. 写回结果 + 缓存
    if (apiResponse.data.length !== missTexts.length) {
      throw new EmbeddingError(
        `XD Gateway returned ${apiResponse.data.length} embeddings, expected ${missTexts.length}`,
        'SERVER_ERROR',
      );
    }
    // OpenAI spec: data 顺序应与 input 一致, 但用 .index 显式定位更稳。
    const byIndex = new Map(apiResponse.data.map((d) => [d.index, d.embedding]));
    for (let j = 0; j < missTexts.length; j++) {
      const vec = byIndex.get(j) ?? apiResponse.data[j]?.embedding;
      if (!vec) {
        throw new EmbeddingError(
          `XD Gateway response missing embedding for input index ${j}`,
          'SERVER_ERROR',
        );
      }
      const targetIdx = missIdx[j];
      result[targetIdx] = vec;
      this.cache.set(cacheKey(req.model, missTexts[j]), vec);
    }

    return {
      embeddings: result,
      modelUsed: apiResponse.model || req.model,
      tokensUsed: apiResponse.usage?.prompt_tokens ?? apiResponse.usage?.total_tokens ?? 0,
      cacheHits,
    };
  }

  /**
   * 带重试的 POST /v1/embeddings。重试条件:
   *   - 5xx / 429 / NETWORK_ERROR → 退避后重试 (最多 RETRY_DELAYS_MS.length 次)
   *   - 401/403 (AUTH_FAILED) / 400 (INVALID_MODEL) → 立即抛
   */
  private async callWithRetry(
    apiKey: string,
    model: string,
    inputs: string[],
  ): Promise<OpenAiEmbeddingsResponse> {
    let attempt = 0;
    // initial + retries
    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    let lastErr: EmbeddingError | null = null;

    while (attempt < maxAttempts) {
      try {
        return await this.callOnce(apiKey, model, inputs);
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
   */
  private async callOnce(
    apiKey: string,
    model: string,
    inputs: string[],
  ): Promise<OpenAiEmbeddingsResponse> {
    const url = `${this.resolveBaseUrl()}/v1/embeddings`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: inputs }),
      });
    } catch (err) {
      // DNS / socket reset / fetch abort 都走这里
      throw new EmbeddingError(
        `network error: ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
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

    return (await res.json()) as OpenAiEmbeddingsResponse;
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

function cacheKey(model: string, text: string): string {
  // sha256(model + '\0' + text); 用 NUL 分隔避免 'a' + 'bc' / 'ab' + 'c' 碰撞
  const h = createHash('sha256');
  h.update(model);
  h.update('\x00');
  h.update(text);
  return h.digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 模型相关的小工具直接 re-export, 方便 consumer 共用同一份 catalog 查询。
export { getEmbeddingModel } from './catalog.js';
