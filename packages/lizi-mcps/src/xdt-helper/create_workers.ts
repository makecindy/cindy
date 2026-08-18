/**
 * xdt-helper/create_workers.ts —— 确定性批量创建 Orca workers。
 *
 * 批次在一次 MCP 调用内顺序执行，因而能准确汇总逐项终态，并在首次命中
 * hard limit 后停止调用 host，避免同批剩余项继续产生无效重试。
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
  '本工具按 workers 顺序创建并返回真实逐项终态；首次命中 WORKER_LIMIT_HARD_EXCEEDED 后立即停止，剩余项标记 skipped，不再调用 host。',
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
  limit: WorkerLimitSnapshot | undefined;
}): string {
  const notCreatedCount = params.failureCount + params.skippedCount;
  const base = `本批请求创建 ${params.requestCount} 个 Worker，实际创建成功 ${params.successCount} 个，创建失败 ${params.failureCount} 个，未尝试 ${params.skippedCount} 个，共 ${notCreatedCount} 个未创建`;
  if (params.stopReason === 'WORKER_LIMIT_HARD_EXCEEDED' && params.limit) {
    return `${base}；当前 hard limit 为 ${params.limit.workerHardLimit}，已占用 ${params.limit.occupiedSlots} 个槽位。可在协同设置中提高 hard limit、复用已有 Worker，或归档不再需要的 Worker 后分批执行剩余任务。`;
  }
  if (params.stopReason === 'HOST_NOT_READY') {
    return `${base}；${BRAND_NAME} 主进程协同服务尚未就绪，请等待服务就绪后只重试未创建项。`;
  }
  return `${base}。请按逐项结果核对每个 Worker 的真实终态。`;
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

      for (let index = 0; index < workers.length; index += 1) {
        const worker = workers[index]!;
        attemptedCount += 1;
        const result = await deps.createWorker({
          leadSessionId: ctx.sessionId,
          role: worker.role,
          agent: worker.agent,
          model: worker.model,
          providerId: worker.provider_id,
          effort: worker.effort,
          fast: worker.fast,
          label: worker.label,
          initialTask: worker.initial_task,
        });
        limit = result.limit ?? limit;

        if (result.ok) {
          successCount += 1;
          results.push({
            ...baseResult(worker),
            status: 'created',
            worker_id: result.workerId,
            worker_session_id: result.workerSessionId,
            ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
            ...(result.dispatchOutcome ? { dispatch_outcome: result.dispatchOutcome } : {}),
            ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
            ...(result.softLimitExceeded ? { warning: 'WORKER_LIMIT_SOFT_EXCEEDED' as const } : {}),
          });
          continue;
        }

        results.push({
          ...baseResult(worker),
          status: 'failed',
          error_code: result.errorCode,
          hint: result.message,
        });
        if (
          result.errorCode !== 'WORKER_LIMIT_HARD_EXCEEDED'
          && result.errorCode !== 'HOST_NOT_READY'
        ) continue;

        stopReason = result.errorCode;
        const skipped = workers.slice(index + 1);
        skippedCount = skipped.length;
        for (const pending of skipped) {
          results.push({
            ...baseResult(pending),
            status: 'skipped',
            error_code: result.errorCode,
            hint: result.errorCode === 'WORKER_LIMIT_HARD_EXCEEDED'
              ? '同批已达到 Worker hard limit，未再调用 host 创建。'
              : `${BRAND_NAME} 主进程协同服务尚未就绪，未再调用 host 创建。`,
          });
        }
        break;
      }

      const failureCount = attemptedCount - successCount;
      const notCreatedCount = failureCount + skippedCount;
      const userReport = buildUserReport({
        requestCount: workers.length,
        successCount,
        failureCount,
        skippedCount,
        stopReason,
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
        suggestions: stopReason === 'WORKER_LIMIT_HARD_EXCEEDED'
          ? hardLimitSuggestions()
          : stopReason === 'HOST_NOT_READY'
            ? hostNotReadySuggestions()
            : [],
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
