import type { Maker, Session } from '@cindy/maker-core';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { createSessionSnapshot } from '@cindy/runtime-db/sessionSnapshot';
import type { SchedulerQueueDeps } from './schedulePromptRunner.js';
import type { SchedulerQueuedPreparation } from './schedulerQueuedPreparation.js';
export interface SchedulerEnqueueInput {
 targetSessionId: string; message: string; persistedContent: string; inheritTargetPlanMode?: boolean; clientId: string;
 meta: NonNullable<Awaited<ReturnType<Maker['getSessionMeta']>>>;
 dbRow: NonNullable<Awaited<ReturnType<ReturnType<typeof createSessionSnapshot>['getSessionRowSnapshot']>>>;
 onAccepted: Parameters<SchedulerQueueDeps['enqueuePrompt']>[0]['onAccepted'];
 onAcceptedRollback: Parameters<SchedulerQueueDeps['enqueuePrompt']>[0]['onAcceptedRollback'];
 origin: Parameters<SchedulerQueueDeps['enqueuePrompt']>[0]['origin'];
}
export function createSchedulerQueueBridge(host: {
 maker: Pick<Maker, 'getSession' | 'getSessionMeta'>;
 inputCoordinator: Pick<AgentInputCoordinator, 'shouldQueueNewTurn' | 'ensureQueueRestored' | 'isQueueRestored' | 'hasQueuedItemWhere' | 'isQueuePaused' | 'remove'>;
 getSessionRowSnapshot: ReturnType<typeof createSessionSnapshot>['getSessionRowSnapshot'];
 isDispatchBoundaryBusy(id: string, session: Session | undefined): boolean;
 createId(): string;
 schedulerQueuedPromptDiscardWatchers: Map<string, () => void>;
 schedulerQueuedPromptPreparations: Map<string, SchedulerQueuedPreparation>;
 enqueueSendToSessionMessage(input: SchedulerEnqueueInput): Promise<void>;
}): Required<Pick<SchedulerQueueDeps, 'isSessionBusy' | 'ensureQueueRestored' | 'hasQueuedPrompt' | 'enqueuePrompt' | 'removeQueuedPrompt' | 'isPromptTracked'>> {
 const { maker, inputCoordinator, getSessionRowSnapshot, isDispatchBoundaryBusy, createId, schedulerQueuedPromptDiscardWatchers, schedulerQueuedPromptPreparations, enqueueSendToSessionMessage } = host;
 return {
    isSessionBusy: (sessionId) => {
      // 两个视角取并集:coordinator 队列/锁/凭证切换视角(shouldQueueNewTurn,
      // 含 dispatch-boundary busy)∪ turn 活动视角(tracker + live session 自报,
      // maker-core 修复后含自动续跑 turn)。任一认为忙即入队,不再让 runner 盲发。
      const sess = maker.getSession(sessionId);
      return (
        inputCoordinator.shouldQueueNewTurn(sessionId) ||
        isDispatchBoundaryBusy(sessionId, sess)
      );
    },
    ensureQueueRestored: async (sessionId) => {
      await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
      return inputCoordinator.isQueueRestored(sessionId);
    },
    hasQueuedPrompt: (sessionId, scheduleId) =>
      inputCoordinator.hasQueuedItemWhere(
        sessionId,
        (item) => item.origin?.kind === 'scheduler' && item.origin.scheduleId === scheduleId,
        { includeRecovery: true },
      ),
    enqueuePrompt: async (req) => {
      const [meta, dbRow] = await Promise.all([
        maker.getSessionMeta(req.sessionId).catch(() => null),
        getSessionRowSnapshot(req.sessionId),
      ]);
      if (!meta || !dbRow) {
        throw new Error(`scheduler enqueue: session ${req.sessionId} not found`);
      }
      if (dbRow.status === 'archived' || dbRow.status === 'deleted') {
        throw new Error(`scheduler enqueue: session ${req.sessionId} is ${dbRow.status}`);
      }
      // 去重必须在崩溃恢复快照读回**之后**做:重启后快照未恢复时内存队列是空的,
      // 只查内存会漏掉快照里的同任务心跳,恢复完成后两条都派发(PR #972 review P1)。
      // ensureQueueRestored 读快照失败时内部吞错并保持未恢复态(等下次入口重试),
      // 所以必须再以 isQueueRestored 确认:未恢复就不入队,返回 retry 让 runner
      // 顺延本次 fire —— 恢复成功前持久化去重无从谈起,宁可晚一轮不留双份。
      await inputCoordinator.ensureQueueRestored(req.sessionId).catch(() => undefined);
      if (!inputCoordinator.isQueueRestored(req.sessionId)) {
        return { retry: true as const };
      }
      // 暂停中的队列(用户 Stop / 崩溃恢复出用户草稿的恢复暂停)不入队:暂停队列
      // 永不 drain、只有用户显式操作解除,塞进去的心跳 accepted 永远不来,run 会
      // 永久挂 running(review P1/P2)。返回 retry 让 runner 顺延,90s 轮询直到
      // 用户恢复/清空队列后再正常排队或直发。
      if (inputCoordinator.isQueuePaused(req.sessionId)) {
        return { retry: true as const };
      }
      if (
        inputCoordinator.hasQueuedItemWhere(
          req.sessionId,
          (item) =>
            item.origin?.kind === 'scheduler' && item.origin.scheduleId === req.origin.scheduleId,
          { includeRecovery: true },
        )
      ) {
        return { duplicate: true as const };
      }
      const clientId = createId();
      if (req.onDiscarded) {
        schedulerQueuedPromptDiscardWatchers.set(clientId, req.onDiscarded);
      }
      if (req.onPreparing) {
        schedulerQueuedPromptPreparations.set(clientId, {
          onPreparing: req.onPreparing,
          onPreparationFailed: req.onPreparationFailed,
        });
      }
      try {
        await enqueueSendToSessionMessage({
          targetSessionId: req.sessionId,
          message: req.text,
          persistedContent: req.persistedContent,
          inheritTargetPlanMode: req.inheritTargetPlanMode,
          clientId,
          meta,
          dbRow,
          onAccepted: req.onAccepted,
          onAcceptedRollback: req.onAcceptedRollback,
          origin: req.origin,
        });
      } catch (err) {
        schedulerQueuedPromptDiscardWatchers.delete(clientId);
        schedulerQueuedPromptPreparations.delete(clientId);
        throw err;
      }
      return { clientId };
    },
    removeQueuedPrompt: (sessionId, clientId) => {
      // remove 只作用于 pending 行;已进入派发(activeTurn)的项 no-op —— 调用方
      // (runner abort 路径)对此已有兜底(转 session.abort)。
      inputCoordinator.remove(sessionId, clientId);
    },
    // 存活探测刻意**不含** recovery:项转入 active-turn recovery 后,Retry 走
    // "克隆已受理 turn"路径,不会再触发 onAcceptedQueuedMessage,排队方注册的
    // 回调永远等不到 —— 视为不存活,让 runner 的 run 以失败收口而非永久挂起。
    isPromptTracked: (sessionId, clientId) =>
      inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId),
  };
}
