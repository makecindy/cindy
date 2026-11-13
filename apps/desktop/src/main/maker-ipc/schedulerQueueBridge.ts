import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { SessionRowSnapshot } from '../localDb/sessionDispatchSnapshot.js';
import type { SchedulerQueuedPreparation } from './schedulerQueuedPreparation.js';

export interface SchedulerQueuedPromptRequest {
  sessionId: string;
  /** Routine dispatch preserves the teammate's current planning preference. */
  inheritTargetPlanMode?: boolean;
  /** 发给 agent 的正文(可含静默运行隐藏协议后缀)。 */
  text: string;
  /** 落库与队列气泡展示的用户原始 prompt(不含隐藏协议)。 */
  persistedContent: string;
  origin: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId?: string };
  /** Runs under the send lock before the live session is captured or a user row is written. */
  onPreparing?: () => Promise<void>;
  /** Reject the queued run if preparation fails before dispatch. */
  onPreparationFailed?: (error: unknown) => void;
  /** 排队项被 drain 派发、turn 已被会话接受时回调(等价直发路径的 send onAccepted)。 */
  onAccepted: (queuedPermissions?: { permissionMode?: string; planMode?: boolean }) => void | Promise<void>;
  /** 派发已 accept 但最终未成为运行 turn(取消/回滚)时回调。 */
  onAcceptedRollback?: () => void | Promise<void>;
  /** 排队项未派发即被丢弃(用户删除队列行 / stop 清队列 / 会话清理)时回调。 */
  onDiscarded?: () => void;
}

/**
 * enqueuePrompt 的结果:成功入队;或命中同任务既有排队/待重试项(去重);
 * 或崩溃恢复快照尚未成功读回(retry —— 恢复完成前不能做持久化去重,调用方
 * 顺延本次 fire 稍后再试,防止恢复后与快照里的同任务项双份派发)。
 */
export type SchedulerEnqueueResult = { clientId: string } | { duplicate: true } | { retry: true };

export interface SchedulerQueueBridge {
  ensureQueueRestored(sessionId: string): Promise<boolean>;
  isSessionBusy(sessionId: string): boolean;
  hasQueuedPrompt(sessionId: string, scheduleId: string): boolean;
  enqueuePrompt(req: SchedulerQueuedPromptRequest): Promise<SchedulerEnqueueResult>;
  removeQueuedPrompt(sessionId: string, clientId: string): void;
  /** 排队项(含派发中 / 可重试 recovery)是否仍被 coordinator 跟踪 —— runner 派发等待的存活探测。 */
  isPromptTracked(sessionId: string, clientId: string): boolean;
}

interface SchedulerQueueBridgeDeps<Meta> {
  coordinator: Pick<AgentInputCoordinator, 'ensureQueueRestored' | 'isQueueRestored' | 'isQueuePaused' | 'hasQueuedItemWhere' | 'remove'>;
  isSessionBusy(sessionId: string): boolean;
  getSessionMeta(sessionId: string): Promise<Meta | null>;
  getSessionRowSnapshot(sessionId: string): Promise<SessionRowSnapshot | null>;
  createId(): string;
  discardWatchers: Map<string, () => void>;
  preparations: Map<string, SchedulerQueuedPreparation>;
  enqueue(req: {
    targetSessionId: string; message: string; persistedContent: string; clientId: string;
    inheritTargetPlanMode?: boolean; meta: NonNullable<Meta>; dbRow: SessionRowSnapshot;
    onAccepted: SchedulerQueuedPromptRequest['onAccepted'];
    onAcceptedRollback?: SchedulerQueuedPromptRequest['onAcceptedRollback'];
    origin: SchedulerQueuedPromptRequest['origin'];
  }): Promise<void>;
}

/** Restore-before-dedup and pause semantics shared by Desktop and the Node host. */
export function createSchedulerQueueBridge<Meta>(deps: SchedulerQueueBridgeDeps<Meta>): SchedulerQueueBridge {
  const inputCoordinator = deps.coordinator;
  const schedulerQueuedPromptDiscardWatchers = deps.discardWatchers;
  const schedulerQueuedPromptPreparations = deps.preparations;
  return {
    isSessionBusy: deps.isSessionBusy,
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
        deps.getSessionMeta(req.sessionId).catch(() => null),
        deps.getSessionRowSnapshot(req.sessionId),
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
      const clientId = deps.createId();
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
        await deps.enqueue({
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
