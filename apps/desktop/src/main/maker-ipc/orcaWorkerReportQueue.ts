import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { rebuildQueuedOrcaWorkerMessage } from './orcaInterAgentDispatcher.js';
import { isOrcaCollaborationMessage } from './orcaQueueNote.js';
import type { WorkerReportWithdrawalStanding } from './orcaTeamService.js';
import {
  createSessionQueueControlService,
  type SessionQueueControlDeps,
} from './sessionQueueControl.js';

/**
 * Worker 管理「自己发给 Lead、还排在 Lead 队列里没被读到」的回报：查看、改写、撤回、合并。
 *
 * 与 Lead 管理自己发给 Worker 的排队消息对称，但可见范围更窄：Worker 只看得到、也只动得了
 * 自己发的条目，Lead 队列里用户与其他 Worker 的消息只给总数，不给正文（2026-11-10 产品决策）。
 * 调用方身份由 orca_worker_bridge 的 resolveWorkerLink 核实后传入，这里不再信任模型参数。
 *
 * 契约见 docs/dev-rules/orca-team-architecture.md「消息派发与 auto-bridge」第 12 条。
 */

export type WorkerReportQueueFailureCode =
  | 'QUEUED_MESSAGE_NOT_FOUND'
  | 'NOT_YOUR_MESSAGE'
  | 'MESSAGE_CONSUMING'
  | 'LAST_REPORT'
  | 'QUEUE_CHANGED'
  | 'INVALID_ARGS'
  | 'INTERNAL';

/** 核实过的 Worker 身份（来自持久化的 worker link）。 */
export interface WorkerReportQueueIdentity {
  workerId: string;
  workerSessionId: string;
  leadSessionId: string;
}

export interface WorkerQueuedReport {
  queuedMessageId: string;
  /** Lead 整个等待队列里的下标（0 = 下一条），用于判断自己的几条回报是否相邻。 */
  position: number;
  content: string;
  /** true = 正在投递，不能再改写 / 撤回。 */
  consuming: boolean;
}

export interface WorkerReportQueueStatus {
  leadIsWorking: boolean;
  /** 现在发给 Lead 的新消息会不会排队。 */
  willQueue: boolean;
  queuePaused: boolean;
  /** Lead 队列里全部等待中的消息数，含 Worker 看不到正文的条目。 */
  queuedCount: number;
  reports: WorkerQueuedReport[];
}

export type WorkerReportQueueFailure = {
  ok: false;
  errorCode: WorkerReportQueueFailureCode;
  message: string;
  /** 合并失败时附最新队列，供 Worker 重新判断。 */
  status?: WorkerReportQueueStatus;
};

export type WorkerReportQueueControlResult =
  | { ok: true; queuedMessageId: string }
  | WorkerReportQueueFailure;

export type WorkerReportQueueMergeResult =
  | { ok: true; queuedMessageId: string; status: WorkerReportQueueStatus }
  | WorkerReportQueueFailure;

export interface OrcaWorkerReportQueueDeps
  extends Pick<SessionQueueControlDeps, 'replaceQueuedMessage' | 'removeQueuedMessage'> {
  getSessionQueueSnapshot(sessionId: string): Promise<{
    pendingQueue: AgentInputQueuedMessage[];
    consumingClientIds: string[];
    isWorking: boolean;
    willQueue: boolean;
    queuePaused: boolean;
  }>;
  ensureQueueRestored(sessionId: string): Promise<boolean>;
  mergeQueuedMessages(
    sessionId: string,
    clientIds: readonly string[],
    buildReplacement: (
      targets: readonly AgentInputQueuedMessage[],
    ) => AgentInputQueuedMessage | null,
  ): boolean;
  /** Worker 当前的 role，用于重建回报前缀；查不到返回 undefined。 */
  resolveWorkerRole(workerId: string): Promise<string | undefined>;
  /** 撤回这条回报后，Worker 当前这次派活还剩不剩回报；见 OrcaTeamService 的同名方法。 */
  reportWithdrawalStanding(
    workerSessionId: string,
    queuedMessageId: string,
  ): WorkerReportWithdrawalStanding;
  /** 合并保留下来的回报接替被合并掉的、属于当前派活的回报。 */
  adoptQueuedReport(workerSessionId: string, queuedMessageId: string): void;
  log: { info: (message: string, meta?: Record<string, unknown>) => void };
}

export interface OrcaWorkerReportQueue {
  list(identity: WorkerReportQueueIdentity): Promise<WorkerReportQueueStatus>;
  update(
    params: WorkerReportQueueIdentity & { queuedMessageId: string; message: string },
  ): Promise<WorkerReportQueueControlResult>;
  cancel(
    params: WorkerReportQueueIdentity & { queuedMessageId: string },
  ): Promise<WorkerReportQueueControlResult>;
  merge(
    params: WorkerReportQueueIdentity & { queuedMessageIds: string[]; message: string },
  ): Promise<WorkerReportQueueMergeResult>;
}

export function createOrcaWorkerReportQueue(deps: OrcaWorkerReportQueueDeps): OrcaWorkerReportQueue {
  // 只用改写与撤回：定位、consuming 拒绝与竞态复核沿用公共事务边界。Worker 不能调序，
  // 转插话在发送时用 delivery=steer 选择，因此这两项不接宿主能力。
  const queueControl = createSessionQueueControlService({
    getSnapshot: deps.getSessionQueueSnapshot,
    replaceQueuedMessage: deps.replaceQueuedMessage,
    removeQueuedMessage: deps.removeQueuedMessage,
    steerQueuedMessage: async () => ({ kind: 'gone' }),
    moveQueuedMessage: () => null,
  });
  // 同一个 Worker 的写操作串行执行：并行撤回两条时，各自都会把对方当成「还有一条留着」。
  const mutationTails = new Map<string, Promise<unknown>>();

  function serialized<T>(workerSessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = mutationTails.get(workerSessionId) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.catch(() => undefined);
    mutationTails.set(workerSessionId, tail);
    void tail.then(() => {
      if (mutationTails.get(workerSessionId) === tail) mutationTails.delete(workerSessionId);
    });
    return current;
  }

  /**
   * 老快照没有 senderSessionId：无法证明是这个 Worker 发的，一律不开放。失败轮的续跑／重发
   * 副本沿用了原回报的来源，但那是 Lead 自己的恢复输入，不算 Worker 的回报。
   */
  function isOwnReport(item: AgentInputQueuedMessage, identity: WorkerReportQueueIdentity): boolean {
    return (
      isOrcaCollaborationMessage(item) && item.origin.senderSessionId === identity.workerSessionId
    );
  }

  function authorizeOwnReport(identity: WorkerReportQueueIdentity, queuedMessageId: string) {
    return (item: AgentInputQueuedMessage): { ok: true } | { ok: false; message: string } =>
      isOwnReport(item, identity)
        ? { ok: true }
        : {
            ok: false,
            message: `queued message ${queuedMessageId} was not sent by this worker`,
          };
  }

  function mapFailure(failure: {
    ok: false;
    errorCode: string;
    message: string;
  }): WorkerReportQueueFailure {
    return {
      ok: false,
      errorCode:
        failure.errorCode === 'NOT_AUTHORIZED'
          ? 'NOT_YOUR_MESSAGE'
          : (failure.errorCode as WorkerReportQueueFailureCode),
      message: failure.message,
    };
  }

  async function list(identity: WorkerReportQueueIdentity): Promise<WorkerReportQueueStatus> {
    const snapshot = await deps.getSessionQueueSnapshot(identity.leadSessionId);
    return {
      leadIsWorking: snapshot.isWorking,
      willQueue: snapshot.willQueue,
      queuePaused: snapshot.queuePaused,
      queuedCount: snapshot.pendingQueue.length,
      reports: snapshot.pendingQueue.flatMap((item, index) =>
        isOwnReport(item, identity) && isOrcaCollaborationMessage(item)
          ? [
              {
                queuedMessageId: item.clientId,
                position: index,
                content: item.origin.displayText ?? item.text,
                consuming: snapshot.consumingClientIds.includes(item.clientId),
              },
            ]
          : [],
      ),
    };
  }

  return {
    list,

    update(params) {
      return serialized(params.workerSessionId, async () => {
        const role = await deps.resolveWorkerRole(params.workerId);
        const controlled = await queueControl.update({
          sessionId: params.leadSessionId,
          queuedMessageId: params.queuedMessageId,
          message: params.message,
          authorize: authorizeOwnReport(params, params.queuedMessageId),
          rebuild: (entry, message) =>
            rebuildQueuedOrcaWorkerMessage(entry, message, params.workerId, role),
        });
        if (!controlled.ok) return mapFailure(controlled);
        deps.log.info('orca worker updated queued report', {
          workerId: params.workerId,
          leadSessionId: params.leadSessionId,
          queuedMessageId: params.queuedMessageId,
        });
        return { ok: true, queuedMessageId: params.queuedMessageId };
      });
    },

    cancel(params) {
      return serialized(params.workerSessionId, async () => {
        const status = await list(params);
        const isQueuedReport = status.reports.some(
          (report) => report.queuedMessageId === params.queuedMessageId,
        );
        // 回报被接收（含入队）时已经结清「这次派活欠 Lead 一份回报」，撤回后不会再自动补报。
        // 所以这次派活唯一的回报不能撤；没有派活在跑时无账可查，至少要留一条回报在队列里。
        const standing = isQueuedReport
          ? deps.reportWithdrawalStanding(params.workerSessionId, params.queuedMessageId)
          : null;
        if (standing === 'last' || (standing === 'untracked' && status.reports.length === 1)) {
          return {
            ok: false,
            errorCode: 'LAST_REPORT',
            message:
              'this is the only report of yours the Lead will receive; rewrite it with update_queued_report instead of withdrawing it',
          };
        }
        // coordinator.remove 负责结清该条排队时登记的 accepted 回调。
        const controlled = await queueControl.cancel({
          sessionId: params.leadSessionId,
          queuedMessageId: params.queuedMessageId,
          authorize: authorizeOwnReport(params, params.queuedMessageId),
        });
        if (!controlled.ok) return mapFailure(controlled);
        deps.log.info('orca worker cancelled queued report', {
          workerId: params.workerId,
          leadSessionId: params.leadSessionId,
          queuedMessageId: params.queuedMessageId,
        });
        return { ok: true, queuedMessageId: params.queuedMessageId };
      });
    },

    merge(params) {
      return serialized(params.workerSessionId, async () => {
        if (
          params.queuedMessageIds.length < 2 ||
          new Set(params.queuedMessageIds).size !== params.queuedMessageIds.length ||
          params.message.trim().length === 0
        ) {
          return {
            ok: false,
            errorCode: 'INVALID_ARGS',
            message:
              'queued_message_ids must contain at least two unique ids and message must not be empty',
          };
        }
        if (!(await deps.ensureQueueRestored(params.leadSessionId))) {
          return {
            ok: false,
            errorCode: 'INTERNAL',
            message: 'lead queue could not be restored; no messages were changed',
          };
        }
        // 重建所需的异步读取必须在同步临界区之前完成。
        const role = await deps.resolveWorkerRole(params.workerId);
        // 被合并掉的回报会经丢弃钩子销账；其中若有属于当前派活的，保留下来的那条要接替它的
        // 账，否则合并后的回报会被当成更早派活的而放行撤回，Lead 就收不到本次结果。
        // 必须在合并前判断：销账发生在合并之内。
        const carriesCurrentAssignment = params.queuedMessageIds.some((id) => {
          const standing = deps.reportWithdrawalStanding(params.workerSessionId, id);
          return standing === 'covered' || standing === 'last';
        });
        const merged = deps.mergeQueuedMessages(
          params.leadSessionId,
          params.queuedMessageIds,
          (targets) => {
            if (targets.some((item) => !isOwnReport(item, params))) return null;
            const survivor = targets[0]!;
            const mergedFiles = [
              ...(survivor.files ?? []),
              ...targets.slice(1).flatMap((item) => item.files ?? []),
            ];
            return rebuildQueuedOrcaWorkerMessage(
              mergedFiles.length > 0 ? { ...survivor, files: mergedFiles } : survivor,
              params.message,
              params.workerId,
              role,
            );
          },
        );
        const status = await list(params);
        if (!merged) {
          return {
            ok: false,
            errorCode: 'QUEUE_CHANGED',
            message:
              'no reports were changed: they must all be yours, still waiting, listed in queue order and next to each other in the Lead queue (consecutive positions); re-check the latest queue, or rewrite one with update_queued_report and withdraw the others',
            status,
          };
        }
        if (carriesCurrentAssignment) {
          deps.adoptQueuedReport(params.workerSessionId, params.queuedMessageIds[0]!);
        }
        deps.log.info('orca worker merged queued reports', {
          workerId: params.workerId,
          leadSessionId: params.leadSessionId,
          survivorQueuedMessageId: params.queuedMessageIds[0],
          mergedCount: params.queuedMessageIds.length,
        });
        return { ok: true, queuedMessageId: params.queuedMessageIds[0]!, status };
      });
    },
  };
}
