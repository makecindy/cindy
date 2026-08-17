/**
 * xdt-helper/create_workers.ts —— 确定性批量创建 Orca workers。
 *
 * 批次优先读取 host 的只读名额快照，再按剩余名额切分可创建前缀与超限后缀；
 * 旧 host 没有快照 dep 时回退首项探测，可创建前缀始终受并发上限约束。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { okPayload, errorPayload } from './_payload.js';
import {
  createWorkerSpecSchema,
  toWorkerLimitPayload,
  type CreateWorkerDeps,
  type CreateWorkerSpec,
  type WorkerLimitSnapshot,
} from './create_worker.js';

const workersSchema = z
  .array(createWorkerSpecSchema)
  .min(2)
  .max(32)
  .superRefine((workers, ctx) => {
    const labels = new Set<string>();
    workers.forEach((worker, index) => {
      const canonical = worker.label.toLowerCase();
      if (labels.has(canonical)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'label'],
          message: `duplicate label in batch: ${worker.label}`,
        });
      }
      labels.add(canonical);
    });
  });

const DESCRIPTION = [
  '在当前 workflow 内批量创建 2-32 个 Orca worker session。',
  '用户一次要求创建多个 Worker 时必须使用本工具，不要并行或连续多次调用 create_worker。',
  '本工具优先根据只读名额快照切分可创建前缀与超限后缀；旧 host 无快照时先探测首项，再在可创建前缀内有界并发并按请求顺序返回真实逐项终态；超限后缀标记 skipped，不调用 host。',
  '结果包含 request_count / attempted_count / success_count / failure_count / skipped_count / not_created_count、hard limit 快照、确定生成的 user_report，以及每个 label 对应的 worker/session 或失败原因。success/failure/skipped 是互斥分区。',
  '工具返回后必须向用户逐字转告 user_report 并补充逐项结果；达到 hard limit 时同时转告 suggestions 中的调整设置、复用 Worker 或分批执行方案。',
  'create_workers 建的是持久、UI 可见的 Orca workers，不是一次性 subagent。',
].join('\n');

interface CreatedWorkerResult {
  label: string;
  role: string;
  agent: CreateWorkerSpec['agent'];
  status: 'created';
  worker_id: string;
  worker_session_id: string;
  dispatched?: boolean;
  dispatch_outcome?: unknown;
  queued_message_id?: string;
  warning?: 'WORKER_LIMIT_SOFT_EXCEEDED';
}

interface FailedWorkerResult {
  label: string;
  role: string;
  agent: CreateWorkerSpec['agent'];
  status: 'failed' | 'skipped';
  error_code: string;
  hint: string;
}

type BatchWorkerResult = CreatedWorkerResult | FailedWorkerResult;
type BatchStopReason = 'WORKER_LIMIT_HARD_EXCEEDED' | 'HOST_NOT_READY';

// 并发度上限取 4——实测每个并发 agent 进程峰值约 320MB，4 并发共约 1.3GB、
// 每会话仅劣化 15% 并拿到 3.3× 墙钟改善；8 并发内存翻倍到 2.5GB 而吞吐只再涨 1.8×，
// 性价比不划算。workers 上限是 32，不设限最坏情况 10GB+。
const MAX_CONCURRENT_WORKER_CREATIONS = 4;

function baseResult(worker: CreateWorkerSpec) {
  return {
    label: worker.label,
    role: worker.role,
    agent: worker.agent,
  };
}

function hardLimitSuggestions(): string[] {
  return [
    '在协同设置中提高 Worker hard limit 后，只重试未创建项。',
    '复用已有 Worker，通过 send_to_worker 继续派发任务。',
    '归档不再需要的 Worker 释放名额，或把剩余任务分批执行。',
  ];
}

function hostNotReadySuggestions(): string[] {
  return [`等待 ${BRAND_NAME} 主进程协同服务就绪后，只重试未创建项。`];
}

function buildUserReport(params: {
  requestCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  stopReason: BatchStopReason | undefined;
  /** 批次里存在按名额切掉/失败的项；可与 hostNotReady 同时成立，两者原因不同。 */
  capacityLimited: boolean;
  /** 批次里存在主进程未就绪的项。 */
  hostNotReady: boolean;
  limit: WorkerLimitSnapshot | undefined;
}): string {
  const notCreatedCount = params.failureCount + params.skippedCount;
  const base = `本批请求创建 ${params.requestCount} 个 Worker，实际创建成功 ${params.successCount} 个，创建失败 ${params.failureCount} 个，未尝试 ${params.skippedCount} 个，共 ${notCreatedCount} 个未创建`;
  const capacityTail = params.limit
    ? `当前 hard limit 为 ${params.limit.workerHardLimit}，已占用 ${params.limit.occupiedSlots} 个槽位。可在协同设置中提高 hard limit、复用已有 Worker，或归档不再需要的 Worker 后分批执行剩余任务。`
    : '';
  const hostTail = `${BRAND_NAME} 主进程协同服务尚未就绪，请等待服务就绪后只重试未创建项。`;
  // 两类原因可以同时成立，且**两边都要写进 user_report**：工具描述要求 Lead 逐字转告
  // 这个字段，漏掉哪一条，用户就会只被引导去调名额或只被引导去等服务。
  const tails: string[] = [];
  if (params.capacityLimited && capacityTail) tails.push(capacityTail);
  if (params.hostNotReady) tails.push(hostTail);
  if (tails.length === 0) return `${base}。请按逐项结果核对每个 Worker 的真实终态。`;
  // 批次级停止原因对应的那条排在前面，另一条紧随其后。
  if (params.stopReason === 'HOST_NOT_READY') tails.reverse();
  return `${base}；${tails.join('另有一部分是因为：')}`;
}

function workerCreateParams(leadSessionId: string, worker: CreateWorkerSpec) {
  return {
    leadSessionId,
    role: worker.role,
    agent: worker.agent,
    model: worker.model,
    effort: worker.effort,
    fast: worker.fast,
    label: worker.label,
    initialTask: worker.initial_task,
  };
}

function failureFromThrownError(worker: CreateWorkerSpec, error: unknown): FailedWorkerResult {
  const errorCode = error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : 'INTERNAL';
  return {
    ...baseResult(worker),
    status: 'failed',
    error_code: errorCode,
    hint: error instanceof Error ? error.message : String(error),
  };
}

function resultFromCreateWorker(
  worker: CreateWorkerSpec,
  result: Awaited<ReturnType<CreateWorkerDeps['createWorker']>>,
): BatchWorkerResult {
  if (!result.ok) {
    return {
      ...baseResult(worker),
      status: 'failed',
      error_code: result.errorCode,
      hint: result.message,
    };
  }
  return {
    ...baseResult(worker),
    status: 'created',
    worker_id: result.workerId,
    worker_session_id: result.workerSessionId,
    ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
    ...(result.dispatchOutcome ? { dispatch_outcome: result.dispatchOutcome } : {}),
    ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
    ...(result.softLimitExceeded ? { warning: 'WORKER_LIMIT_SOFT_EXCEEDED' as const } : {}),
  };
}

function moreRecentLimit(
  current: WorkerLimitSnapshot | undefined,
  candidate: WorkerLimitSnapshot | undefined,
): WorkerLimitSnapshot | undefined {
  if (!candidate) return current;
  if (!current || candidate.occupiedSlots >= current.occupiedSlots) return candidate;
  return current;
}

function isWorkerLimitSnapshot(value: unknown): value is WorkerLimitSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<WorkerLimitSnapshot>;
  const { workerHardLimit, occupiedSlots, remainingSlots } = snapshot;
  if (!Number.isFinite(workerHardLimit)
    || !Number.isFinite(occupiedSlots)
    || !Number.isFinite(remainingSlots)) {
    return false;
  }
  // 只认自洽的快照：负 remainingSlots 会把整批误判成 hard-limit skipped，虚高值又会
  // 放行本该跳过的后缀，两种都比「回退首项探测」更糟。判据直接对齐 host 的算法
  // （`remainingSlots = max(0, hardLimit - occupied)`），而不是写成
  // `occupied + remaining <= hardLimit` —— 后者会把「用户把 hard limit 调到低于当前
  // Worker 数」这种合法状态（如 3/5/0）误判成非法，于是白白回退去探测首项、多建一个。
  return workerHardLimit! >= 0
    && occupiedSlots! >= 0
    && remainingSlots! === Math.max(0, workerHardLimit! - occupiedSlots!);
}

export function registerCreateWorkersTool(
  registry: XdtHelperToolRegistry,
  deps: CreateWorkerDeps,
): void {
  registry.register({
    name: 'create_workers',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      workers: workersSchema.describe('按期望创建顺序排列的 Worker 定义；label 在本批内忽略大小写唯一'),
    },
    handler: async ({ workers }) => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      }
      if (ctx.vendorOptions?.orcaRole === 'worker') {
        return errorPayload(
          'WORKER_CANNOT_NEST',
          'create_workers 是 Orca Lead 批量创建 worker session 的入口，不是 subagent 入口；Worker session 不能嵌套创建 Orca Worker。',
        );
      }

      const results: BatchWorkerResult[] = [];
      let attemptedCount = 0;
      let successCount = 0;
      let skippedCount = 0;
      let limit: WorkerLimitSnapshot | undefined;
      let stopReason: BatchStopReason | undefined;
      const indexedResults: Array<BatchWorkerResult | undefined> = Array.from({
        length: workers.length,
      });
      let hostNotReadyIndex: number | undefined;
      let hardLimitIndex: number | undefined;
      let nextIndex = 1;
      let usedReadOnlySnapshot = false;

      const stopIndex = () => Math.min(
        hostNotReadyIndex ?? Number.POSITIVE_INFINITY,
        hardLimitIndex ?? Number.POSITIVE_INFINITY,
      );

      const invoke = async (index: number): Promise<void> => {
        const worker = workers[index]!;
        attemptedCount += 1;
        try {
          const result = await deps.createWorker(workerCreateParams(ctx.sessionId!, worker));
          limit = moreRecentLimit(limit, result.limit);
          indexedResults[index] = resultFromCreateWorker(worker, result);
          if (!result.ok && result.errorCode === 'HOST_NOT_READY') {
            hostNotReadyIndex = Math.min(hostNotReadyIndex ?? index, index);
          } else if (!result.ok && result.errorCode === 'WORKER_LIMIT_HARD_EXCEEDED') {
            hardLimitIndex = Math.min(hardLimitIndex ?? index, index);
          }
        } catch (error) {
          const failed = failureFromThrownError(worker, error);
          indexedResults[index] = failed;
          if (failed.error_code === 'HOST_NOT_READY') {
            hostNotReadyIndex = Math.min(hostNotReadyIndex ?? index, index);
          } else if (failed.error_code === 'WORKER_LIMIT_HARD_EXCEEDED') {
            hardLimitIndex = Math.min(hardLimitIndex ?? index, index);
          }
        }
      };

      let eligibleEnd = workers.length;
      if (deps.getWorkerLimitSnapshot) {
        try {
          const snapshot = await deps.getWorkerLimitSnapshot(ctx.sessionId!);
          if (!isWorkerLimitSnapshot(snapshot)) {
            throw new Error('invalid worker limit snapshot');
          }
          limit = snapshot;
          usedReadOnlySnapshot = true;
        } catch {
          // 只读快照不可用时回退首项探测，不能让容量查询故障阻断创建。
        }
      }

      if (usedReadOnlySnapshot) {
        nextIndex = 0;
        const remainingSlots = Math.max(0, Math.floor(limit!.remainingSlots));
        // 已知取舍：前缀按快照一次切死，不做动态回填。前缀内某项因 DUPLICATE_LABEL /
        // NO_PROVIDER_FOR_AGENT 这类「还没占到 reservation 就失败」的原因挂掉时，那个
        // 名额不会补给后缀，后缀仍按超限 skipped。宁可少建也不多建：回填要在并发里
        // 重新判定名额归属，而 hard limit 的最终裁决在 main 侧原子 reservation，
        // 工具侧再算一次只会引入两套判据。用户按逐项结果重试即可拿到那个名额。
        eligibleEnd = Math.min(workers.length, remainingSlots);
        if (eligibleEnd < workers.length) {
          // 这是只读快照判定出的虚拟 hard-limit 边界，不对应任何失败项。
          hardLimitIndex = eligibleEnd - 1;
        }
      } else {
        // 没有独立的只读名额查询时，首项既是兼容性探测，也是实际创建；
        // 一旦拿到 limit，后续调用才按剩余槽位切前缀，保证超限后缀不会触碰 host。
        await invoke(0);
        if (indexedResults[0]?.status === 'failed' && hostNotReadyIndex === 0) {
          stopReason = 'HOST_NOT_READY';
        } else if (hardLimitIndex === 0) {
          stopReason = 'WORKER_LIMIT_HARD_EXCEEDED';
        }

        if (stopReason === undefined && limit) {
          const remainingSlots = Number.isFinite(limit.remainingSlots)
            ? Math.max(0, Math.floor(limit.remainingSlots))
            : workers.length;
          eligibleEnd = Math.min(workers.length, 1 + remainingSlots);
          if (eligibleEnd < workers.length) {
            hardLimitIndex = eligibleEnd - 1;
          }
        }
      }

      // 两种名额路径都进入同一个有界并发池；host 一旦返回硬限或未就绪，
      // 调度器停止发起尚未入飞的后续调用，已入飞的调用仍结算真实终态。
      const runNext = async (): Promise<void> => {
        while (nextIndex < eligibleEnd) {
          const index = nextIndex;
          nextIndex += 1;
          if (index > stopIndex()) return;
          await invoke(index);
        }
      };
      if (stopReason === undefined && nextIndex < eligibleEnd) {
        const workerCount = Math.min(
          MAX_CONCURRENT_WORKER_CREATIONS,
          eligibleEnd - nextIndex,
        );
        await Promise.all(Array.from({ length: workerCount }, () => runNext()));
      }

      // 停止原因取「请求顺序里更早的那个」，不能让在途的后发失败盖掉先发的边界：
      // 并发下 index=2 先报 hard limit、index=5 后报 HOST_NOT_READY 时若取后者，
      // 调度器早已按 index=2 停发的 3/4 两项既没结果也不满足 skip 条件，会被误报成
      // INTERNAL；容量快照与 suggestions 也会跟着丢。
      const earliestStop = stopIndex();
      if (Number.isFinite(earliestStop)) {
        stopReason = earliestStop === hostNotReadyIndex
          ? 'HOST_NOT_READY'
          : 'WORKER_LIMIT_HARD_EXCEEDED';
      }

      // 在途调用全部结算后重取一次只读快照。并发下每个成功结果带回的 limit 是它拿到
      // reservation 那一刻的占用，其中可能包含之后又被释放的预留（bootstrap、持久化或
      // 派发前失败）；沿用其中的最大值会把容量报成比实际更满，进而误导 Lead 去建议用户
      // 提高上限或归档 Worker。收尾快照是只读的，失败就沿用在途结果，不影响已建好的 Worker。
      // 只要回调存在就重取，不看批前那次成没成功：批前失败可能只是一次瞬时错误，随后
      // 创建全程正常，这时沿用在途最大值同样会把容量报得比实际更满。重取是只读的、
      // 已包在 try/catch 里，最坏不过多一次失败读。
      if (deps.getWorkerLimitSnapshot) {
        try {
          const settled = await deps.getWorkerLimitSnapshot(ctx.sessionId!);
          if (isWorkerLimitSnapshot(settled)) limit = settled;
        } catch {
          // 收尾刷新失败不改变任何已结算的终态。
        }
      }

      // 每项的 skip 原因按区间判定，不共用一个批次级原因：容量后缀是调用 host 之前就由
      // 快照切定的分区，不该被前缀里的 HOST_NOT_READY 改写成「主进程未就绪」——否则用户
      // 等主进程恢复后重试这些项，仍会因为名额不够再失败一次，而且拿不到提限/归档建议。
      const skipReasonAt = (index: number): BatchStopReason | undefined => {
        if (index >= eligibleEnd) return 'WORKER_LIMIT_HARD_EXCEEDED';
        // 前缀内两个边界都可能命中；取请求顺序里更早的那个，不能给某个原因固定优先级，
        // 否则「index=1 撞名额、index=3 撞主进程」时 index>=4 会被标成主进程未就绪，
        // 与批次级 stop_reason 自相矛盾，还会引导用户去等服务而不是释放名额。
        const hostHit = hostNotReadyIndex !== undefined && index > hostNotReadyIndex;
        const limitHit = hardLimitIndex !== undefined && index > hardLimitIndex;
        if (hostHit && limitHit) {
          return hostNotReadyIndex! < hardLimitIndex!
            ? 'HOST_NOT_READY'
            : 'WORKER_LIMIT_HARD_EXCEEDED';
        }
        if (hostHit) return 'HOST_NOT_READY';
        if (limitHit) return 'WORKER_LIMIT_HARD_EXCEEDED';
        return undefined;
      };
      for (let index = 0; index < workers.length; index += 1) {
        if (indexedResults[index]) continue;
        const worker = workers[index]!;
        const skipReason = skipReasonAt(index);
        if (!skipReason) {
          // 理论上只有首项 host 异常且 promise 没有写入结果才会到这里；保守保留
          // 可观察终态，避免批次汇总出现空洞。
          indexedResults[index] = failureFromThrownError(
            worker,
            new Error('worker creation did not settle'),
          );
          continue;
        }
        indexedResults[index] = {
          ...baseResult(worker),
          status: 'skipped',
          error_code: skipReason,
          hint: skipReason === 'WORKER_LIMIT_HARD_EXCEEDED'
            ? '同批已达到 Worker hard limit，未再调用 host 创建。'
            : `${BRAND_NAME} 主进程协同服务尚未就绪，未再调用 host 创建。`,
        };
      }
      // 判据取自**全部逐项终态**，不只是 skip：并发下较晚的在途项可能真失败在
      // HOST_NOT_READY 上，而批次级 stop_reason 取的是更早的名额边界；只看 skip 会
      // 把「主进程未就绪」整条从 user_report 与 suggestions 里漏掉。
      const hasErrorCode = (code: BatchStopReason) => indexedResults.some((result) => (
        result !== undefined && 'error_code' in result && result.error_code === code
      ));
      const capacityLimited = hasErrorCode('WORKER_LIMIT_HARD_EXCEEDED')
        || stopReason === 'WORKER_LIMIT_HARD_EXCEEDED';
      const hostNotReady = hasErrorCode('HOST_NOT_READY')
        || stopReason === 'HOST_NOT_READY';

      results.push(...indexedResults as BatchWorkerResult[]);
      successCount = results.filter((result) => result.status === 'created').length;
      const failureCount = results.filter((result) => result.status === 'failed').length;
      skippedCount = results.filter((result) => result.status === 'skipped').length;
      const notCreatedCount = failureCount + skippedCount;
      const userReport = buildUserReport({
        requestCount: workers.length,
        successCount,
        failureCount,
        skippedCount,
        stopReason,
        capacityLimited,
        hostNotReady,
        limit,
      });
      const payload = {
        request_count: workers.length,
        attempted_count: attemptedCount,
        success_count: successCount,
        failure_count: failureCount,
        skipped_count: skippedCount,
        not_created_count: notCreatedCount,
        stopped_early: stopReason !== undefined,
        ...(stopReason ? { stop_reason: stopReason } : {}),
        ...(limit ? { limit: toWorkerLimitPayload(limit) } : {}),
        user_report: userReport,
        results,
        // 建议按「批次里实际用到的 skip 原因」取并集，不跟着单值 stop_reason 走：
        // 主进程未就绪与容量超限可以同时存在，只给前者会让用户以为等一等就能重试成功。
        suggestions: [
          ...(capacityLimited ? hardLimitSuggestions() : []),
          ...(hostNotReady ? hostNotReadySuggestions() : []),
        ],
      };
      if (stopReason === 'HOST_NOT_READY') {
        return errorPayload(
          'HOST_NOT_READY',
          `${BRAND_NAME} 主进程协同服务尚未就绪。`,
          payload,
        );
      }
      return okPayload(payload);
    },
  });
}
