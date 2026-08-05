/**
 * Embedding 模型 catalog — 硬编码的可用 model 元信息。
 *
 * XD Gateway /v1/embeddings 当前支持的模型以**本表为准**(不在这里记数量与快照日期:
 * 每次增删都要同步改一处无关的数字, 漏改就成了误导维护者的过期描述)。
 * 价格 / dim / maxTokens 均来自 provider 官方文档对齐 XD Gateway。
 *
 * `dim` 的语义是**不显式请求维度时上游返回的默认维度** —— client.ts 只发
 * `{ model, input }`, 不发各家的维度参数 (OpenAI `dimensions` / Voyage
 * `output_dimension` / Gemini `output_dimensionality`), 所以这里必须填各家的
 * **默认值**, 不能填"该模型支持的最大维度"。填错的后果不是报错而是静默不一致:
 * 调方按本表建向量表 / 预分配缓冲, 实际收到的长度却不同。
 *
 * 新增模型:
 *   1. 同步追加 types.ts EmbeddingModelId 联合
 *   2. 本表追加一行
 *   3. (可选) Worker / Provider 端的 default model 选择不在本包内, consumer 自决
 */

import type { EmbeddingModelId, EmbeddingModelMeta } from './types.js';

const CATALOG: ReadonlyArray<EmbeddingModelMeta> = [
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    dim: 1536,
    maxTokens: 8192,
    pricePerMTokens: 0.02,
  },
  {
    id: 'text-embedding-3-large',
    provider: 'openai',
    dim: 3072,
    maxTokens: 8192,
    pricePerMTokens: 0.13,
  },
  {
    id: 'gemini-embedding-2-preview',
    provider: 'google',
    // 默认维度 3072 (2026-08-04 双向实测: Google OpenAI 兼容层直连、以及 XD 网关
    // 不带 dimensions 时, 都返 3072)。本行原写 768 —— 那是 Google 文档里的**推荐**
    // 维度之一 (128–3072 可选, 推荐 768/1536/3072), 不是默认值。
    dim: 3072,
    // 8192 = gemini-embedding-2 的输入上限; 原写的 2048 是上一代 gemini-embedding-001 的。
    maxTokens: 8192,
    pricePerMTokens: 0,
    preview: true,
    notes: 'preview 阶段, 不建议作为 production default',
  },
  {
    id: 'voyage/voyage-4',
    provider: 'voyage',
    dim: 1024,
    maxTokens: 32000,
    pricePerMTokens: 0.06,
    notes: 'chat 场景首选 (32K context, 中等价格)',
  },
  {
    id: 'voyage/voyage-4-large',
    provider: 'voyage',
    // 1024 = voyage-4 家族的默认维度 (2026-08-04 网关实测确认; 官方文档亦为
    // output_dimension 支持 2048 / 1024(default) / 512 / 256)。本行原写 2048 ——
    // 那是该型号支持的最大维度, 只有显式请求维度才拿得到。
    dim: 1024,
    maxTokens: 32000,
    pricePerMTokens: 0.12,
  },
  {
    id: 'voyage/voyage-code-3',
    provider: 'voyage',
    dim: 1024,
    maxTokens: 32000,
    pricePerMTokens: 0.18,
    notes: '代码语义优化',
  },
  {
    id: 'voyage/voyage-context-3',
    provider: 'voyage',
    dim: 1024,
    maxTokens: 120000,
    pricePerMTokens: 0.18,
    notes: '长上下文 (120K)',
  },
  {
    id: 'voyage/voyage-context-4',
    provider: 'voyage',
    // 同 voyage-4 家族:默认 1024,可显式请求 2048 / 512 / 256。
    dim: 1024,
    // 单个 chunk 的上限。整批另有约束(网关侧 120K 总量 / 至多 1000 个文档),
    // 不在本字段语义内 —— 本字段是"单条 input 最大 token 数"(见 types.ts)。
    // 注:上一行 voyage-context-3 的 120000 填的是整批上限,与本字段语义不符,
    // 属存量不一致,未随本次改动一并纠正(它当前无消费方)。
    maxTokens: 32000,
    pricePerMTokens: 0.12,
    notes:
      '上下文化检索:同一文档的多个 chunk 互为上下文,检索质量优于逐块独立嵌入。' +
      '网关经同一 OpenAI 形态端点支持,索引侧把 input 传成二维数组(每个内层数组 = ' +
      '一个文档的 chunk 序列),查询侧传一维。两侧客户端都已接通:索引侧走 ' +
      'EmbeddingClient.embedDocuments()(不走缓存,见其头注),查询侧走 embed()。',
  },
];

const MAP: ReadonlyMap<string, EmbeddingModelMeta> = new Map(
  CATALOG.map((m) => [m.id, m]),
);

/** 列出所有可用模型 (新对象数组, 调方修改不污染内部 cache)。 */
export function listEmbeddingModels(): EmbeddingModelMeta[] {
  return CATALOG.map((m) => ({ ...m }));
}

/** 按 id 查模型元信息; 未知 id → undefined (调方按需校验)。 */
export function getEmbeddingModel(id: string): EmbeddingModelMeta | undefined {
  return MAP.get(id);
}

/** 类型保护: 字符串是否是已知 EmbeddingModelId。 */
export function isKnownEmbeddingModel(id: string): id is EmbeddingModelId {
  return MAP.has(id);
}
