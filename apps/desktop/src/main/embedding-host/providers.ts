/**
 * EmbeddingProvider 接口 + module-level 注册表。
 *
 * Provider 是 consumer (chat/document/memory/skill/...) 把"job 行 → 实际待嵌文本"的
 * 解码逻辑外置出来的接口 — embedding-host 不知道 chat message 长什么样, 也不知道
 * document chunk 怎么分; 它只知道"我有这一批 jobs, 帮我把每条的 text 拿来"。
 *
 * 注册时机: consumer 在自己的 startXxxHost() / lifecycle ready 钩子里调
 * EmbeddingService.registerProvider({source, getTextsForJobs})。重复 source 的
 * 注册按 last-write-wins 覆盖, 但本 Phase 1.1 既无业务 consumer 也无 unregister API,
 * 实际上 register 一次即终生。
 */

export interface EmbeddingJobForProvider {
  /** embedding_jobs.rowid — Worker 用它做后续 UPDATE / INSERT 关联 */
  rowid: number;
  /** consumer 定义的实体 id (e.g. message.id / document.id) */
  sourceId: string;
  /** 同一 source_id 的分片序号; 非分片场景固定 0 */
  chunkIndex: number;
}

export interface EmbeddingProvider {
  /**
   * source 标识 (e.g. 'chat' / 'document'); Worker 按 embedding_jobs.source
   * 分组后调对应 Provider。
   */
  source: string;
  /**
   * 一批 jobs → 一批文本。返回数组必须与 jobs 同长, 按 rowid 对齐。
   *
   * text === null → 该 job 在 consumer 视角"已无需嵌入" (如 message 被 rewind / doc 被删),
   *                  Worker 会直接把对应 job 标 done, 不调 embedding API。
   *
   * Provider 自己负责性能与 SQL 批量读 — getTextsForJobs 在 Worker tick 中调,
   * 不要阻塞超过几秒。失败抛错时 Worker 把这批 jobs 当作可重试错误处理。
   */
  getTextsForJobs(
    jobs: EmbeddingJobForProvider[],
  ): Promise<Array<{ rowid: number; text: string | null }>>;
}

const providers = new Map<string, EmbeddingProvider>();
const suspendedSources = new Set<string>();

export function registerProvider(provider: EmbeddingProvider): void {
  providers.set(provider.source, provider);
}

export function getProvider(source: string): EmbeddingProvider | undefined {
  return providers.get(source);
}

export function listProviderSources(): string[] {
  return Array.from(providers.keys());
}

/** Pause queued work for a consumer source without unregistering its provider. */
export function setProviderSuspended(source: string, suspended: boolean): void {
  if (suspended) suspendedSources.add(source);
  else suspendedSources.delete(source);
}

export function isProviderSuspended(source: string): boolean {
  return suspendedSources.has(source);
}

export function listSuspendedProviderSources(): string[] {
  return Array.from(suspendedSources);
}

/** dev / 测试用 — 清空注册表。 */
export function clearProviders(): void {
  providers.clear();
  suspendedSources.clear();
}
