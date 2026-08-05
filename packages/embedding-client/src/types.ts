/**
 * embedding-client 类型定义。
 *
 * 设计原则:
 *   - 完全 OpenAI /v1/embeddings 兼容 (XD Gateway 此 endpoint 透传)
 *   - dim / 价格等模型元信息硬编码在 catalog.ts; 调方按 id 查
 *   - 不强制 default model: EmbedRequest 必传 modelId, 让 consumer 自己声明
 */

/** Catalog 中支持的所有 model id 字面量联合。新增模型时同步 catalog.ts。 */
export type EmbeddingModelId =
  | 'text-embedding-3-small'
  | 'text-embedding-3-large'
  | 'gemini-embedding-2-preview'
  | 'voyage/voyage-4'
  | 'voyage/voyage-4-large'
  | 'voyage/voyage-code-3'
  | 'voyage/voyage-context-3';

/** 模型元信息 — 给 consumer 决策"用哪个 model"提供数据 */
export interface EmbeddingModelMeta {
  id: EmbeddingModelId;
  /** Provider 大类: openai / google / voyage. 仅作 UI 分组用,不影响 wire 协议。 */
  provider: 'openai' | 'google' | 'voyage';
  /** 输出向量维度 (固定值, vec 表建表时必须严格匹配)。 */
  dim: number;
  /** 单条 input 最大 token 数 (超出 → 调方需自行分块)。 */
  maxTokens: number;
  /** 每百万 input token 的美元价格 (USD/MT)。 */
  pricePerMTokens: number;
  /** 是否 preview/不稳定。registerProvider 时建议避开 default。 */
  preview?: boolean;
  /** 人读用途备注 (UI 选择面板可显示)。 */
  notes?: string;
}

export interface EmbeddingClientOptions {
  /**
   * 必填；OpenAI-compatible embeddings base URL，由上层宿主显式注入，不再提供
   * 生产默认值。函数形态 = 每次请求现取(宿主 endpoint 运行期可变,如登录后由
   * 服务端下发网关地址)。
   */
  baseUrl: string | (() => string);
  /** 动态读 API key (避免写死, 切账号生效)。返 undefined / 空字符串 = 未登录。 */
  getApiKey: () => string | undefined | null;
  /** 可注入用于单元测试; 缺省走全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** sha256 内存缓存条数, 默认 1000 (LRU)。设 0 = 关闭缓存。 */
  cacheSize?: number;
  /** 结构化日志钩子, 缺省静默。 */
  logger?: EmbeddingLogger;
}

export interface EmbeddingLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

export interface EmbedRequest {
  /** 待嵌入文本数组 (调方负责按 model.maxTokens 预分块, client 不切)。 */
  texts: string[];
  /** 必传。EmbedRequest 不预设 default,让 consumer 显式声明使用的模型。 */
  model: EmbeddingModelId;
}

export interface EmbedResponse {
  /**
   * 与 texts 等长的二维数组, dim 随 model 变。
   * 缓存命中的位次也会回填到对应 index, 调方拿到的语义跟"全跑了一遍"一致。
   */
  embeddings: number[][];
  /** 实际生效的 model id (XD Gateway 返的 `model` 字段, 用于审计)。 */
  modelUsed: string;
  /**
   * 本次调用 XD Gateway 消耗的 input token 数 (缓存命中部分不计)。
   * 缓存全命中时 tokensUsed = 0。
   */
  tokensUsed: number;
  /** 本次调用中走 LRU 缓存命中的 texts 数量。 */
  cacheHits: number;
}

/**
 * embedding 操作的错误类型, 统一 code 便于 Worker 按 code 决定重试策略。
 *
 * code 语义:
 *   - AUTH_FAILED   : 没拿到 api key, 或 XD Gateway 返 401/403。不重试。
 *   - RATE_LIMITED  : 429。Worker 走 backoff 重试。
 *   - INVALID_MODEL : 调方传了 catalog 里没有的 model id (本地校验), 或 XD Gateway 返 400。不重试。
 *   - NETWORK_ERROR : fetch 抛错 (DNS/socket reset/timeout)。Worker 走 backoff 重试。
 *   - SERVER_ERROR  : 5xx。Worker 走 backoff 重试。
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'AUTH_FAILED'
      | 'RATE_LIMITED'
      | 'INVALID_MODEL'
      | 'NETWORK_ERROR'
      | 'SERVER_ERROR',
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}
