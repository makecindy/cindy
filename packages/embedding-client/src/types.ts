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
  | 'voyage/voyage-context-3'
  | 'voyage/voyage-context-4';

/**
 * 检索用途档 —— 非对称检索里"这段文字是被检索的内容,还是用来检索的提问"。
 *
 * 各家的 wire 值域**互斥**(2026-08-04 网关实测),所以这里定义的是与家族无关的
 * 中立值,由 client 按 model 的 provider 翻译:
 *   - voyage : 小写 'query' / 'document'(传大写 → 500)
 *   - google : Vertex 大写枚举 'RETRIEVAL_QUERY' / 'RETRIEVAL_DOCUMENT'(传小写 → 400)
 *   - openai : 不发 —— OpenAI 的 /v1/embeddings 没有这个参数, 任何值都被静默忽略
 *              (实测两种写法都回 200 且无效果), 发了只是多一个无意义字段。
 */
export type EmbeddingInputType = 'query' | 'document';

/** 模型元信息 — 给 consumer 决策"用哪个 model"提供数据 */
export interface EmbeddingModelMeta {
  id: EmbeddingModelId;
  /**
   * Provider 大类: openai / google / voyage。除 UI 分组外还有 wire 语义 ——
   * `inputType` 的值域按它翻译(见 EmbeddingInputType)。
   */
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
  /**
   * 检索用途档 (可选)。缺省 = 不发该参数 = 上游不加任何检索前缀。
   *
   * **建索引与查索引必须用同一套约定**:两侧都不传, 或者一侧 'document' / 另一侧
   * 'query'。一侧传一侧不传会让向量落在不同的语义偏置上, 召回明显变差 —— 而且
   * 不会报任何错。
   */
  inputType?: EmbeddingInputType;
  /**
   * 期望输出维度 (可选)。缺省 = 上游默认 (见 catalog 的 `dim`)。
   *
   * 传了就一定要校验回来的长度 —— 该模型不支持某个维度时上游的行为不统一
   * (可能报错, 也可能静默给默认值)。wire 上统一发 OpenAI 的 `dimensions` 名字:
   * 2026-08-04 实测三家 (openai / voyage / google) 经网关都认它, 而 Voyage 自己的
   * `output_dimension` 只对 voyage 生效, 对另两家被吞。
   */
  dimensions?: number;
  /**
   * 整次调用的时间预算 (毫秒, 可选)。缺省 = 不设限 (由 fetch 自己的默认行为决定)。
   *
   * 覆盖**含重试的整条链**而不是单次 HTTP:预算耗尽即 abort 在途请求并抛
   * `TIMEOUT`, 不会被"每次重试各给一份超时"放大成数倍等待。调方有并发额度或在
   * 等用户时必须传 —— 网关连上后不返数据的情况下, 没有这个预算就是无限期挂起。
   */
  timeoutMs?: number;
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
 * 上下文化嵌入请求 (voyage-context-* 的索引侧形态)。
 *
 * 与 `EmbedRequest` 的本质区别:同一文档内的 chunk **互为上下文**,所以一个 chunk
 * 的向量取决于它所在的文档 —— 同一段文字放进不同文档会得到不同向量。这条决定了
 * 两件事:
 *   1. 输入必须按文档分组 (wire 上是二维 `input`),不能摊平成一批独立文本;
 *   2. 单 chunk 级的缓存**不适用**(缓存 key 无法只由文本决定),因此本路径不走缓存。
 */
export interface EmbedDocumentsRequest {
  /** 每个内层数组 = 一个文档的 chunk 序列 (顺序有意义, 上游按此建立上下文)。 */
  documents: string[][];
  /** 必传;应当是支持上下文化的型号 (voyage-context-*)。 */
  model: EmbeddingModelId;
  /**
   * 索引侧一般传 'document'。查询侧不要用本方法 —— 查询是单条无上下文的文本,
   * 走 `embed()` 传 `inputType: 'query'` 即可 (与索引侧向量可比)。
   */
  inputType?: EmbeddingInputType;
  dimensions?: number;
  /** 同 `EmbedRequest.timeoutMs`:含重试的整体时间预算。 */
  timeoutMs?: number;
}

export interface EmbedDocumentsResponse {
  /** 与 documents 同形:[文档][chunk][维度]。 */
  embeddings: number[][][];
  modelUsed: string;
  tokensUsed: number;
}

/**
 * embedding 操作的错误类型, 统一 code 便于 Worker 按 code 决定重试策略。
 *
 * code 语义:
 *   - AUTH_FAILED   : 没拿到 api key, 或 XD Gateway 返 401/403。不重试。
 *   - RATE_LIMITED  : 429。Worker 走 backoff 重试。
 *   - INVALID_MODEL : 调方传了 catalog 里没有的 model id (本地校验), 或 XD Gateway 返 400。不重试。
 *   - NETWORK_ERROR : fetch 抛错 (DNS/socket reset)。Worker 走 backoff 重试。
 *   - SERVER_ERROR  : 5xx。Worker 走 backoff 重试。
 *   - TIMEOUT       : 调方给的 timeoutMs 预算耗尽 (在途请求已 abort)。**不重试** ——
 *                     预算是整条链的, 已经过期, 再试一次只会立刻又超时。
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'AUTH_FAILED'
      | 'RATE_LIMITED'
      | 'INVALID_MODEL'
      | 'NETWORK_ERROR'
      | 'SERVER_ERROR'
      | 'TIMEOUT',
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}
