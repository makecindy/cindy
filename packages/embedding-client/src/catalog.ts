/**
 * Embedding 模型 catalog — 硬编码的可用 model 元信息。
 *
 * XD Gateway /v1/embeddings 当前支持的 7 个模型 (2026-05-24)。
 * 价格 / dim / maxTokens 均来自 provider 官方文档对齐 XD Gateway。
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
    // Google gemini-embedding-2-preview, dim 默认 768 (可通过 output_dim 调整, 当前 catalog 走默认值)
    dim: 768,
    maxTokens: 2048,
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
    dim: 2048,
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
