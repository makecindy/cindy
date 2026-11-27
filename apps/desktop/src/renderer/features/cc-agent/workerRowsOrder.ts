import type { AttentionKind } from '@/lib/sessionAttentionStore';
import type { OrcaWorkerStatus } from '../../../shared/orca-worker-status';

/**
 * Worker 列表「多行」布局的排序层级(数字越小越靠前)：
 *   0 = 有问题(出错)或正在等用户回答；
 *   1 = 进行中；
 *   2 = 停止中(空闲 / 完成 / 已关闭提醒的出错)。
 * 「有问题 / 等回答」与列表上显示的 ERR 徽章、蓝点同源(resolveWorkerListAttention)：
 * 本机 Worker 的任务错误被关闭后不再置顶，远程 Worker 的运行态 error 已由该判定折入。
 * 「完成未读」只是绿点提醒，不提层级。
 */
export function workerRowsTier(
  status: OrcaWorkerStatus,
  attentionKind: AttentionKind | undefined,
): 0 | 1 | 2 {
  if (attentionKind === 'error' || attentionKind === 'awaiting') return 0;
  if (status === 'running') return 1;
  return 2;
}

interface SortableWorker {
  status: OrcaWorkerStatus;
  lastTriggeredAt?: number;
}

/**
 * 按层级排序，同层最后触发时间越晚越靠前；时间相同或都读不到时保持传入顺序。
 * 不改动传入数组。
 */
export function sortWorkersForRows<T extends SortableWorker>(
  workers: readonly T[],
  attentionOf: (worker: T) => AttentionKind | undefined,
): T[] {
  return workers
    .map((worker, index) => ({
      worker,
      index,
      tier: workerRowsTier(worker.status, attentionOf(worker)),
      at: worker.lastTriggeredAt ?? 0,
    }))
    .sort((a, b) => a.tier - b.tier || b.at - a.at || a.index - b.index)
    .map((entry) => entry.worker);
}
