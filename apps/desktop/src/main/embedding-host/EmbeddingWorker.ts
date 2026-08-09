/**
 * EmbeddingWorker — main 进程长生命周期的串行 embedding 处理器。
 *
 * 周期 5s, 单 tick 一次。每次 tick:
 *   1. SELECT 32 条 status='pending' AND scheduled_at <= now (按 scheduled_at ASC)
 *   2. 按 source 分组 → 查 Provider; 没有 Provider 的整组跳过 (warn 日志, 不动 status)
 *   3. provider.getTextsForJobs(jobs) 拿到 text 数组; text === null 的 job 直接批量 UPDATE done
 *   4. 剩下有 text 的按 model_id 再分组, 同组一次 client.embed()
 *   5. 成功 → 一个事务内: INSERT INTO {vec_table}(rowid, embedding) + UPDATE jobs.status='done'
 *   6. 失败 → attempts++, last_error, scheduled_at += 退避; attempts >= MAX → status='failed'
 *
 * 重要约束 (better-sqlite3 同步事务 vs async embed):
 *   embed() 是 async, 不能在 db.transaction 内 await; 所以流程是
 *     await embed → 拿到 embeddings → 同步事务批量 INSERT+UPDATE。
 *
 * 重试退避由 worker 侧 embedding.recordFailures tx 统一计算;
 *   attempts >= tx 内部上限时不再 schedule, 走 status='failed'。
 *
 * 不做:
 *   - 不并发 (单 worker 串行, 简单可预期; 真到瓶颈再说)
 *   - 不持久 lock (单进程, locked_at 字段留作 future use)
 *   - 不做 dim 校验 (consumer 自己保证 vec_table 的 dim 匹配 model.dim)
 */

import type { EmbeddingClient } from '@cindy/embedding-client';
import { EmbeddingError } from '@cindy/embedding-client';

import type { createLogger } from '../logger';
import type { DbClient } from '../localDb/client/DbClient';
import {
  getProvider,
  isProviderSuspended,
  listSuspendedProviderSources,
  type EmbeddingJobForProvider,
} from './providers';

const TICK_INTERVAL_MS = 5_000;
const BATCH_SIZE = 32;

interface JobRow {
  rowid: number;
  source: string;
  source_id: string;
  chunk_index: number;
  model_id: string;
  vec_table: string;
  attempts: number;
}

export interface EmbeddingWorkerOptions {
  getDbClient: () => DbClient;
  getClient: () => EmbeddingClient;
  /** sqlite-vec 加载失败 → 返回 false; Worker 不打 tick, 仅 warn 一次 */
  isVecAvailable: () => boolean;
  /**
   * 停用轴(PR #744 review 第十六轮):embedding 批是经 XD 网关的自主付费调用,
   * 用户停用该供应商时 worker 必须停批(job 保持 pending,恢复启用后自然续跑)。
   * host 注入(= 查 model-disable override 的供应商级停用);缺席 = 不查。
   */
  isRouteSuspended?: (modelId?: string) => boolean;
  log: ReturnType<typeof createLogger>;
}

export interface EmbeddingWorkerStatus {
  running: boolean;
  lastTickAt: number | null;
  lastTickProcessed: number | null;
}

export class EmbeddingWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastTickAt: number | null = null;
  private lastTickProcessed: number | null = null;
  private vecWarned = false;
  private suspendedWarned = false;
  // 关闭 / 切账号时由 stop() 置 true。in-flight tick 在每个 await 点之后检查它,
  // 一旦为 true 就立刻放弃后续写库直接返回 —— 那批 job 保持 status='pending',
  // 下次启动自动续跑 (零丢失)。目的是退出时让 worker 立即让出 SQLite 写连接,
  // 不再阻塞 clean-exit-snapshot 的 db.backup (退出慢 / 快照被超时腰斩的根因)。
  private aborted = false;
  // tickSafe 用 Promise.race([tick(), abortPromise]) 等赛跑: stop() 调 abortResolve
  // 让 race 立即结束, tickSafe 不再等 tick 内部 await (典型 1-3s 的 getTextsForJobs
  // / embed) 自然返回。tick 内部已 fire 的 await 仍会跑完, 但走到检查点会 return,
  // 检查点已守住"不写库"这条线, 安全。worker 一生只 stop 一次, deferred 一次性。
  private abortResolve: (() => void) | null = null;
  private readonly abortPromise: Promise<void>;

  constructor(private readonly opts: EmbeddingWorkerOptions) {
    this.abortPromise = new Promise<void>((resolve) => {
      this.abortResolve = resolve;
    });
  }

  start(): void {
    if (this.timer) return;
    this.opts.log.info(JSON.stringify({ event: 'embeddingWorker.start' }));
    // 启动后立刻 tick 一次 (don't wait the first 5s)
    void this.tickSafe();
    this.timer = setInterval(() => void this.tickSafe(), TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  // abort 语义: 立即让出 SQLite, 不等当前 tick 跑完。置 aborted=true 后, in-flight
  // tick 在它的 await 检查点会放弃后续写库直接返回 (那批 job 保持 pending, 下次续跑;
  // better-sqlite3 写事务是同步原子的, 不会被切断)。这样 db.backup 无锁争用、秒级完成。
  // 保留 async 签名: 调用方 (EmbeddingService.stop) 仍 await 它, 契约不变。
  async stop(): Promise<void> {
    this.aborted = true;
    this.abortResolve?.();
    this.abortResolve = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.log.info(JSON.stringify({ event: 'embeddingWorker.stop' }));
  }

  getStatus(): EmbeddingWorkerStatus {
    return {
      running: this.timer !== null,
      lastTickAt: this.lastTickAt,
      lastTickProcessed: this.lastTickProcessed,
    };
  }

  /**
   * Tick 包装 — 单 in-flight 守卫 + 顶层 catch (任何错都不要溢出到 timer 让进程崩)。
   * Promise.race(tick, abortPromise): stop() 触发后 race 立刻 resolve, tickSafe 不再
   * 等 tick 内部 await (getTextsForJobs / embed 等典型 1-3s 网络/读盘) 自然返回。
   * tick 内部已 fire 的 await 会被丢弃 (不再有引用), 走到检查点 return, 不会写库。
   */
  private async tickSafe(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await Promise.race([this.tick(), this.abortPromise]);
    } catch (err) {
      this.opts.log.error(
        JSON.stringify({
          event: 'embeddingWorker.tick.fatal',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      this.inFlight = false;
    }
  }

  private async tick(): Promise<void> {
    if (!this.opts.isVecAvailable()) {
      if (!this.vecWarned) {
        this.opts.log.warn(
          JSON.stringify({
            event: 'embeddingWorker.tick.skip.vecUnavailable',
            reason: 'sqlite-vec extension not loaded; worker will sit idle',
          }),
        );
        this.vecWarned = true;
      }
      this.lastTickAt = Date.now();
      this.lastTickProcessed = 0;
      return;
    }
    if (this.opts.isRouteSuspended?.()) {
      // 供应商被用户停用:本轮不取批不下单,job 全部保持 pending;恢复启用后
      // 下一个 tick 自然续跑。warn 一次防刷屏。
      if (!this.suspendedWarned) {
        this.opts.log.warn(
          JSON.stringify({
            event: 'embeddingWorker.tick.skip.providerSuspended',
            reason: 'embedding provider disabled in settings; jobs stay pending',
          }),
        );
        this.suspendedWarned = true;
      }
      this.lastTickAt = Date.now();
      this.lastTickProcessed = 0;
      return;
    }
    this.suspendedWarned = false;

    const now = Date.now();
    const suspendedSources = listSuspendedProviderSources();
    const sourceFilter =
      suspendedSources.length === 0
        ? ''
        : ` AND source NOT IN (${suspendedSources.map(() => '?').join(',')})`;

    // 1. 取一批 pending job。暂停的 consumer source 在 SQL 层排除,避免它的旧 job
    // 占满 LIMIT 后饿死仍可用的插件 source。
    const jobs = await this.opts.getDbClient().query<JobRow>(
      `SELECT rowid, source, source_id, chunk_index, model_id, vec_table, attempts
           FROM embedding_jobs
          WHERE status = 'pending' AND scheduled_at <= ?${sourceFilter}
          ORDER BY scheduled_at ASC
          LIMIT ?`,
      [now, ...suspendedSources, BATCH_SIZE],
    );

    this.lastTickAt = now;
    this.lastTickProcessed = jobs.length;

    if (jobs.length === 0) {
      this.opts.log.debug?.(
        JSON.stringify({ event: 'embeddingWorker.tick', processed: 0 }),
      );
      return;
    }

    this.opts.log.info(
      JSON.stringify({ event: 'embeddingWorker.tick.begin', processed: jobs.length }),
    );

    // 2. 按 source 分组
    const bySource = groupBy(jobs, (j) => j.source);

    let doneCount = 0;
    let failCount = 0;

    for (const [source, sourceJobs] of bySource.entries()) {
      // 退出检查点: stop() 已触发就立即收手, 不再碰 DB (让出锁给 db.backup)。
      if (this.aborted) return;
      // query 后 availability 可能变化;动态 gate 防止快照里的旧 source 继续下单。
      if (isProviderSuspended(source)) continue;
      const provider = getProvider(source);
      if (!provider) {
        // 没注册的 Provider 不动 status, 让用户 / 后续注册路径自然处理
        this.opts.log.warn(
          JSON.stringify({
            event: 'embeddingWorker.tick.skip.noProvider',
            source,
            count: sourceJobs.length,
          }),
        );
        continue;
      }

      // 3. 拿文本
      let texts: Array<{ rowid: number; text: string | null }>;
      try {
        const arg: EmbeddingJobForProvider[] = sourceJobs.map((j) => ({
          rowid: j.rowid,
          sourceId: j.source_id,
          chunkIndex: j.chunk_index,
        }));
        texts = await provider.getTextsForJobs(arg);
      } catch (err) {
        if (isProviderSuspended(source)) continue;
        // Provider 抛错: 整批走可重试错误 (与 embedding API 失败同语义)
        this.opts.log.error(
          JSON.stringify({
            event: 'embeddingWorker.provider.failed',
            source,
            error: err instanceof Error ? err.message : String(err),
            jobCount: sourceJobs.length,
          }),
        );
        const fc = await this.recordFailureBatch(
          sourceJobs,
          err instanceof Error ? err.message : String(err),
        );
        failCount += fc;
        continue;
      }
      // 退出检查点: getTextsForJobs 的 await 期间可能已触发 stop(), 写库前再确认。
      if (this.aborted) return;
      if (isProviderSuspended(source)) continue;
      const textByRowid = new Map(texts.map((t) => [t.rowid, t.text]));

      // 3a. text === null 的 job 直接 done (不调 API)
      const noTextJobs = sourceJobs.filter((j) => (textByRowid.get(j.rowid) ?? null) === null);
      if (noTextJobs.length > 0) {
        await this.markDoneNoVector(noTextJobs);
        doneCount += noTextJobs.length;
        if (this.aborted) return;
        if (isProviderSuspended(source)) continue;
      }

      const liveJobs = sourceJobs.filter((j) => (textByRowid.get(j.rowid) ?? null) !== null);
      if (liveJobs.length === 0) continue;

      // 4. 按 model_id 分组调 embed
      const byModel = groupBy(liveJobs, (j) => j.model_id);
      for (const [modelId, modelJobs] of byModel.entries()) {
        // 逐模型停用(PR #744 review 第十九轮):该 embedding 模型被点名停用时本组
        // 不下单,job 保持 pending,恢复启用后续跑。
        if (this.opts.isRouteSuspended?.(modelId as string)) {
          this.opts.log.warn(
            JSON.stringify({
              event: 'embeddingWorker.tick.skip.modelDisabled',
              modelId,
              count: modelJobs.length,
            }),
          );
          continue;
        }
        const inputs = modelJobs.map((j) => textByRowid.get(j.rowid) as string);
        try {
          const res = await this.opts.getClient().embed({ texts: inputs, model: modelId as never });
          if (res.embeddings.length !== modelJobs.length) {
            throw new Error(
              `embedding count mismatch: got ${res.embeddings.length}, want ${modelJobs.length}`,
            );
          }
          // 退出检查点: embed() 网络往返期间可能已触发 stop(), 绝不在 abort 后再开
          // 写事务 (这是保证 db.backup 无争用的关键)。该批 job 保持 pending, 下次续跑。
          if (this.aborted) return;
          if (isProviderSuspended(source)) break;
          // 5. 同步事务: INSERT vec + UPDATE jobs
          await this.commitEmbeddings(modelJobs, res.embeddings);
          doneCount += modelJobs.length;
          this.opts.log.info(
            JSON.stringify({
              event: 'embeddingWorker.batch.ok',
              source,
              modelId,
              count: modelJobs.length,
              tokensUsed: res.tokensUsed,
              cacheHits: res.cacheHits,
            }),
          );
        } catch (err) {
          // availability 可能在网络往返期间丢失;保留 pending,不要把它记成失败重试。
          if (isProviderSuspended(source)) break;
          const code = err instanceof EmbeddingError ? err.code : 'UNKNOWN';
          const msg = err instanceof Error ? err.message : String(err);
          this.opts.log.error(
            JSON.stringify({
              event: 'embeddingWorker.batch.failed',
              source,
              modelId,
              code,
              error: msg,
              count: modelJobs.length,
            }),
          );
          // AUTH_FAILED / INVALID_MODEL 在 client 内已经判断为不可重试 — 但 worker 这层
          // 不分代码, 一律走 backoff + attempts 计数, MAX_ATTEMPTS 后 → 'failed'。
          // 这样 INVALID_MODEL 不会立刻冲 5 次烧 token, 因为 client 抛错前没打 API。
          const fc = await this.recordFailureBatch(modelJobs, `[${code}] ${msg}`);
          failCount += fc;
        }
      }
    }

    this.opts.log.info(
      JSON.stringify({
        event: 'embeddingWorker.tick.end',
        processed: jobs.length,
        doneCount,
        failCount,
      }),
    );
  }

  /**
   * 把一批 job 标 done (跳过实际嵌入). 同事务内只 UPDATE 状态, 不写 vec 表。
   */
  private async markDoneNoVector(jobs: JobRow[]): Promise<void> {
    await this.opts.getDbClient().tx('embedding.markDone', {
      rowids: jobs.map((job) => job.rowid),
    });
  }

  /**
   * 一批 (相同 vec_table 不强制, 按 job 自身的 vec_table 写) 嵌入完成 → 同事务:
   *   1. INSERT INTO {vec_table}(rowid, embedding) — better-sqlite3 直接绑 Float32Array,
   *      sqlite-vec vec0 列接受 4 byte/element BLOB 自动解释为 float32 (asg017/sqlite-vec docs)
   *   2. UPDATE embedding_jobs.status='done'
   *
   * vec_table 是 consumer 在 registerVecTable 时声明的, 这里直接拼到 SQL 字符串中 —
   * SQL identifier 不能用 ? 参数化。安全前提: vec_table 来自 consumer 受信代码, 不接 user input。
   */
  private async commitEmbeddings(jobs: JobRow[], embeddings: number[][]): Promise<void> {
    const items = jobs.map((job, index) => ({
      rowid: job.rowid,
      vecTable: job.vec_table,
      embedding: Float32Array.from(embeddings[index]),
    }));
    await this.opts.getDbClient().tx(
      'embedding.commit',
      { items },
      items.map((item) => item.embedding.buffer),
    );
  }

  /**
   * 一批 job 失败处理: attempts++ + last_error + scheduled_at += 退避;
   * attempts >= MAX → status='failed' 终态。
   * 返回失败数量 (>= MAX 进 'failed' 终态的部分)。
   */
  private async recordFailureBatch(jobs: JobRow[], errMsg: string): Promise<number> {
    const now = Date.now();
    const result = await this.opts.getDbClient().tx('embedding.recordFailures', {
      jobs: jobs.map((job) => ({ rowid: job.rowid, attempts: job.attempts })),
      errMsg: truncate(errMsg, 2000),
      now,
    });
    return result.failCount;
  }
}

function groupBy<T, K>(items: T[], keyFn: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of items) {
    const k = keyFn(x);
    const arr = out.get(k);
    if (arr) arr.push(x);
    else out.set(k, [x]);
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
