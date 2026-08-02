/**
 * Maker Memory 类型层 — 跟 storage / fts / store / mcp-server 各层共享的形状契约。
 *
 * 设计取舍:
 *  - 4 类分片照搬 Claude Code auto-memory 规范 (user / feedback / project / reference),
 *    Lizi 已经熟。前缀决定文件名: <type>_<slug>.md。
 *  - frontmatter 用 yaml (gray-matter 解析), 字段尽量少 — title/description/type/updatedAt 四个,
 *    保持人手改 .md 时的可读性。
 *  - WriteOptions.name 是 filename slug ([a-z0-9_-]{1,64}), 不是显示文本; title 才是显示文本。
 *    分清楚避免 LLM 用中文当文件名。
 *  - WriteResult.warning 是软警告 (size 超软上限), 调用方按 prompt 引导 consolidate;
 *    硬错误 (schema / 撞名 / 路径非法) 走 throw MemoryError。
 */

/**
 * Curated 类型:LLM 可写(memory_write 工具)+ 进 MEMORY.md 索引 + 进 system prompt。
 */
export const CURATED_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
/**
 * 全部 storage 允许的类型 = curated + `digest`。
 *
 * `digest` 是**系统内部类型**(当前:pi 压缩上下文时把被丢弃内容的摘要沉淀进来)。它:
 *  - 可写入 store、进 FTS —— `memory_search` 能按需检索;
 *  - **排除出 MEMORY.md 索引**(rebuildIndex 只列 CURATED_MEMORY_TYPES),故**不自动注入
 *    system prompt**、不撑大上下文、不污染 curated 记忆;
 *  - **不暴露给 LLM 的 memory_write 工具**(该工具自带 4 类 curated enum,与此处解耦)。
 * 改动前请读 docs/dev-rules/pi-remaining-work.md「压缩即记忆」与 pi-harness.md。
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'digest'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);
}

/**
 * 分片 .md 文件 frontmatter (yaml). 字段尽量少, 保留人工可读 + LLM 易写。
 *
 *  ---
 *  title: 用户偏好
 *  description: 一行 hook, 用作 MEMORY.md 索引行
 *  type: user
 *  updatedAt: 2026-05-10T12:34:56.000Z
 *  ---
 */
export interface MemoryFrontmatter {
  /** 显示标题, 可中英文 */
  title: string;
  /** 一行 hook, 直接拼进 MEMORY.md 索引 */
  description: string;
  /** 4 类之一 */
  type: MemoryType;
  /** ISO 8601 string */
  updatedAt: string;
}

/** 解析后的内存记录 (storage.list / read 返回) */
export interface MemoryRecord {
  /** 含扩展名, e.g. 'feedback_response_style.md' */
  filename: string;
  /** 去掉 <type>_ 前缀和 .md 后缀, e.g. 'response_style' */
  slug: string;
  frontmatter: MemoryFrontmatter;
  /** body 不含 frontmatter, 已 trim */
  body: string;
  /** 文件大小 (bytes), 用作 size warning 判断 */
  sizeBytes: number;
}

export type WriteMode = 'create' | 'update' | 'append';

export interface WriteOptions {
  type: MemoryType;
  /** filename slug, 必须 [a-z0-9_-]{1,64} */
  name: string;
  /** 显示标题, 1..maxTitleLen 字符 */
  title: string;
  /** 一行 hook, 1..maxDescriptionLen 字符, 不含换行 */
  description: string;
  /** 主体 (markdown), 1..hardShardBytes 字节 */
  body: string;
  /** 'create' 撞名拒绝; 'update' 覆盖; 'append' 追加。默认 'create' */
  mode?: WriteMode;
}

export type WriteWarning = 'shard-size-exceeded' | 'index-size-exceeded';

/** 软警告的数值明细: 让调用方判断超了多少, 而不是盲目瘦身 (见 #891) */
export interface WriteWarningDetail {
  kind: WriteWarning;
  /** 超限对象当前字节数 (分片 body 或 MEMORY.md 索引) */
  sizeBytes: number;
  /** 软上限 (默认分片 2048 / 索引 4096) */
  softLimitBytes: number;
  /** 分片硬上限 (默认 8192, 超过将被 reject); 索引警告无硬上限, 不带此字段 */
  hardLimitBytes?: number;
}

export interface WriteResult {
  ok: true;
  /** 写入后文件相对 storage dir 的名字 (e.g. 'feedback_xxx.md') */
  filename: string;
  /** 软警告: 调用方按 prompt 引导 consolidate */
  warning?: WriteWarning;
  /** 软警告数值明细, 与 warning 同生同灭 */
  warningDetail?: WriteWarningDetail;
}

export interface MemoryConfig {
  /** 单分片 body 软上限 (返 warning), 默认 2048 */
  maxShardBytes: number;
  /** 单分片 body 硬上限 (reject), 默认 8192 */
  hardShardBytes: number;
  /** MEMORY.md 索引软上限 (返 warning), 默认 4096 */
  maxIndexBytes: number;
  /** description 长度上限, 默认 200 */
  maxDescriptionLen: number;
  /** title 长度上限, 默认 100 */
  maxTitleLen: number;
  /** slug 最大长度, 默认 64 */
  maxSlugLen: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxShardBytes: 2048,
  hardShardBytes: 8192,
  maxIndexBytes: 4096,
  maxDescriptionLen: 200,
  maxTitleLen: 100,
  maxSlugLen: 64,
};

export type MemoryErrorCode =
  | 'invalid-type'
  | 'invalid-slug'
  | 'invalid-frontmatter'
  | 'invalid-filename'
  | 'shard-too-large'
  | 'description-too-long'
  | 'title-too-long'
  | 'description-has-newline'
  | 'already-exists'
  | 'not-found'
  | 'path-traversal'
  | 'io-error';

export class MemoryError extends Error {
  constructor(
    public readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(`memory:${code} ${message}`);
    this.name = 'MemoryError';
  }
}

/** FTS 检索命中 */
export interface SearchHit {
  filename: string;
  type: MemoryType;
  title: string;
  /** FTS5 snippet() 高亮片段 */
  snippet: string;
  /** bm25 score, 越小越相关 */
  score: number;
}

export interface SearchOptions {
  /** 限定类目 */
  type?: MemoryType;
  /** 默认 10 */
  limit?: number;
}
