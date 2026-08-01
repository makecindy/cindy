/**
 * EmbeddingService — embedding-host 对外的公开 API。
 *
 * 单例由 index.ts 的 startEmbeddingHost() 创建并通过 getEmbeddingService() 暴露。
 * 所有 consumer (chat / document / memory / ...) 通过这一个对象交互:
 *
 *   - registerProvider(provider)        : 声明"我能解 source=X 的 job → text"
 *   - registerVecTable(spec)            : 声明"我会用 vec_table=Y 存这个 source 的向量"
 *   - enqueueJobs({source, items})      : 把待嵌任务入队 (Worker 异步消费)
 *   - embedSync(texts, {modelId})       : 查询 path: 不入队直接嵌 (e.g. query embedding)
 *   - searchVectors({vecTable, qEmb, K}): vec0 KNN; 返 [{rowid, distance}, ...]
 *   - getStatus()                       : dev / 监控用
 *
 * 严格分层:
 *   - 本类只编排, 不持有 SQLite / EmbeddingClient 的具体实现 — 通过 deps 注入
 *   - Worker 长生命周期细节 (tick / 重试) 全在 EmbeddingWorker, 本类不操心
 */

import type { EmbedResponse, EmbeddingClient, EmbeddingModelId } from '@cindy/embedding-client';

import type { createLogger } from '../logger';
import type { DbClient } from '../localDb/client/DbClient';
import {
  isProviderModelRouteDisabled,
  isProviderRouteSuspended,
} from '../utility-model/oneShotCandidates';
import { EmbeddingWorker } from './EmbeddingWorker';
import { VecTableRegistry, type VecTableSpec } from './VecTableRegistry';
import {
  listProviderSources,
  registerProvider as registerProviderImpl,
  type EmbeddingProvider,
} from './providers';

export interface EnqueueJobsArgs {
  source: string;
  items: Array<{
    sourceId: string;
    chunkIndex?: number;
    modelId: EmbeddingModelId;
    vecTable: string;
  }>;
}

export interface EnqueueJobsResult {
  /** 真正新插入的行数。 */
  inserted: number;
  /** 因 UNIQUE 冲突未插入的行数 (= consumer 重复 enqueue 同一 chunk)。 */
  skipped: number;
}

export interface SearchVectorsArgs {
  vecTable: string;
  queryEmbedding: number[];
  topK: number;
}

export interface SearchVectorsHit {
  rowid: number;
  distance: number;
}

export interface EmbeddingHostStatus {
  totalJobs: number;
  pendingCount: number;
  runningCount: number;
  doneCount: number;
  failedCount: number;
  bySource: Record<string, { pending: number; done: number; failed: number }>;
  lastTickAt: number | null;
  workerRunning: boolean;
  sqliteVecAvailable: boolean;
  registeredProviders: string[];
  registeredVecTables: string[];
}

export interface EmbeddingServiceDeps {
  getDbClient: () => DbClient;
  getClient: () => EmbeddingClient;
  isVecAvailable: () => boolean;
  log: ReturnType<typeof createLogger>;
}

export class EmbeddingService {
  private readonly registry: VecTableRegistry;
  private readonly worker: EmbeddingWorker;

  constructor(private readonly deps: EmbeddingServiceDeps) {
    this.registry = new VecTableRegistry(deps.getDbClient, deps.log);
    this.worker = new EmbeddingWorker({
      getDbClient: deps.getDbClient,
      getClient: deps.getClient,
      isVecAvailable: deps.isVecAvailable,
      // 停用轴:embedding 批经 XD 网关计费,用户停用 XD 时停批(job 保持
      // pending,恢复后续跑;PR #744 review 第十六轮)。
      // 无 modelId = tick 级供应商全停短路;带 modelId = 批派发前的逐模型判定
      // (voyage/voyage-4 等可被单独停用,PR #744 review 第十九轮)。
      isRouteSuspended: (modelId) =>
        modelId ? isProviderModelRouteDisabled('xd', modelId) : isProviderRouteSuspended('xd'),
      log: deps.log,
    });
  }

  // ── lifecycle (host 调) ───────────────────────────────────────────────

  start(): void {
    this.registry.preload();
    this.worker.start();
  }

  async stop(): Promise<void> {
    await this.worker.stop();
  }

  // ── registration API (consumer 调) ────────────────────────────────────

  registerProvider(provider: EmbeddingProvider): void {
    registerProviderImpl(provider);
    this.deps.log.info(
      JSON.stringify({
        event: 'embeddingHost.providerRegistered',
        source: provider.source,
      }),
    );
  }

  registerVecTable(spec: VecTableSpec): void {
    this.registry.registerVecTable(spec);
  }

  // ── enqueue / sync embed (consumer 调) ────────────────────────────────

  async enqueueJobs(args: EnqueueJobsArgs): Promise<EnqueueJobsResult> {
    if (args.items.length === 0) return { inserted: 0, skipped: 0 };
    const now = Date.now();
    const result = await this.deps.getDbClient().tx('embedding.enqueue', {
      source: args.source,
      now,
      items: args.items,
    });
    this.deps.log.info(
      JSON.stringify({
        event: 'embeddingHost.enqueueJobs',
        source: args.source,
        total: args.items.length,
        inserted: result.inserted,
        skipped: result.skipped,
      }),
    );
    return result;
  }

  /**
   * 同步 embed — 不入队, 不写 vec 表; 调方拿 embeddings 自处置。
   * 典型用途: query embedding (用户搜索时即时嵌一段 query, 再去 searchVectors)。
   */
  async embedSync(texts: string[], opts: { modelId: EmbeddingModelId }): Promise<EmbedResponse> {
    // 停用轴(PR #744 review 第十七轮):查询向量与后台批同为经 XD 网关的新付费
    // 调用,供应商停用时同样不发 —— 抛错交给消费方既有降级路径(语义搜索回落
    // 关键词检索)。
    if (isProviderModelRouteDisabled('xd', opts.modelId)) {
      throw new Error('embedding provider or model disabled in settings');
    }
    return this.deps.getClient().embed({ texts, model: opts.modelId });
  }

  // ── KNN 查询 (consumer 调) ────────────────────────────────────────────

  async searchVectors(args: SearchVectorsArgs): Promise<SearchVectorsHit[]> {
    if (!this.deps.isVecAvailable()) {
      throw new Error('sqlite-vec extension not loaded; searchVectors unavailable');
    }
    const meta = this.registry.getVecTableMeta(args.vecTable);
    if (!meta) {
      throw new Error(
        `vec_table '${args.vecTable}' not registered (call registerVecTable first)`,
      );
    }
    if (args.queryEmbedding.length !== meta.dim) {
      throw new Error(
        `query embedding dim ${args.queryEmbedding.length} != registered dim ${meta.dim} for ${args.vecTable}`,
      );
    }
    // identifier 验证 (防御性)
    if (!/^[A-Za-z0-9_]+$/.test(args.vecTable)) {
      throw new Error(`invalid vec_table identifier: ${args.vecTable}`);
    }
    if (!Number.isInteger(args.topK) || args.topK <= 0) {
      throw new Error(`topK must be a positive integer, got ${args.topK}`);
    }
    const f32 = Float32Array.from(args.queryEmbedding);
    // sqlite-vec KNN: WHERE embedding MATCH ? ORDER BY distance LIMIT N
    const rows = await this.deps.getDbClient().query<{ rowid: bigint | number; distance: number }>(
        `SELECT rowid, distance
           FROM "${args.vecTable}"
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?`,
      [f32, args.topK],
    );
    return rows.map((r) => ({
      rowid: typeof r.rowid === 'bigint' ? Number(r.rowid) : r.rowid,
      distance: r.distance,
    }));
  }

  // ── 状态 (dev / IPC 用) ───────────────────────────────────────────────

  async getStatus(): Promise<EmbeddingHostStatus> {
    const counts = await this.deps.getDbClient().query<{ status: string; count: number }>(
        `SELECT status, COUNT(*) as count FROM embedding_jobs GROUP BY status`,
    );
    let pending = 0,
      running = 0,
      done = 0,
      failed = 0;
    for (const c of counts) {
      if (c.status === 'pending') pending = c.count;
      else if (c.status === 'running') running = c.count;
      else if (c.status === 'done') done = c.count;
      else if (c.status === 'failed') failed = c.count;
    }
    const bySourceRows = await this.deps.getDbClient().query<{
      source: string;
      status: string;
      count: number;
    }>(
        `SELECT source, status, COUNT(*) as count FROM embedding_jobs GROUP BY source, status`,
    );
    const bySource: EmbeddingHostStatus['bySource'] = {};
    for (const r of bySourceRows) {
      if (!bySource[r.source]) bySource[r.source] = { pending: 0, done: 0, failed: 0 };
      if (r.status === 'pending') bySource[r.source].pending = r.count;
      else if (r.status === 'done') bySource[r.source].done = r.count;
      else if (r.status === 'failed') bySource[r.source].failed = r.count;
      // running 计入哪儿: 不细分, 状态总览的 runningCount 已覆盖
    }
    const w = this.worker.getStatus();
    return {
      totalJobs: pending + running + done + failed,
      pendingCount: pending,
      runningCount: running,
      doneCount: done,
      failedCount: failed,
      bySource,
      lastTickAt: w.lastTickAt,
      workerRunning: w.running,
      sqliteVecAvailable: this.deps.isVecAvailable(),
      registeredProviders: listProviderSources(),
      registeredVecTables: this.registry.list().map((s) => s.vecTable),
    };
  }
}
