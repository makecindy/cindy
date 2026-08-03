import type { Effort } from '@/lib/userPreferences.types';

export type ApplyRuntimeEffort = (sessionId: string, effort: Effort) => Promise<unknown>;

export function isSessionScopeCurrent(
  sourceSessionId: string | undefined,
  currentSessionId: string | undefined,
): boolean {
  return sourceSessionId === currentSessionId;
}

/**
 * 本地 session 设置按用户操作顺序提交 SQLite / Renderer；runtime 投影不阻塞提交链。
 *
 * 每个 session 独立一条 lane，避免 A 会话的慢 IPC 阻塞 B。runtime 调用允许并发：旧调用
 * 晚完成时会重放当前 revision 的目标 effort，修复 Claude Code runtime 的迟到覆盖。
 */
export interface EffortChangeCoordinator {
  enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  getCommittedEffort(sessionId: string): Effort | undefined;
  setCommittedEffort(sessionId: string, effort: Effort): void;
  adoptExternalEffort(sessionId: string, effort: Effort, applyRuntime: ApplyRuntimeEffort): void;
  publishRuntimeEffort(sessionId: string, effort: Effort, applyRuntime: ApplyRuntimeEffort): void;
  suppressRuntimeEffort(sessionId: string): void;
  /** runtime 同步失败：用户选择已持久化，但引擎实际档位未追上。 */
  isRuntimeDirty(sessionId: string): boolean;
  /** 等待排队中的持久化和所有 runtime 投影都稳定下来。 */
  awaitRuntimeSettled(sessionId: string): Promise<void>;
}

export interface EffortChangePipeline {
  persist(sessionId: string, effort: Effort): Promise<unknown>;
  applyRuntime: ApplyRuntimeEffort;
  onCommitted(sessionId: string, effort: Effort): void;
}

interface RuntimeTarget {
  effort: Effort;
  applyRuntime: ApplyRuntimeEffort;
}

interface SessionLane {
  commitTail: Promise<void>;
  committedEffort?: Effort;
  runtimeRevision: number;
  latestRuntimeTarget?: RuntimeTarget;
  runtimeDirty: boolean;
  runtimeAttempts: Set<Promise<void>>;
}

function createSessionLane(): SessionLane {
  return {
    commitTail: Promise.resolve(),
    runtimeRevision: 0,
    runtimeDirty: false,
    runtimeAttempts: new Set(),
  };
}

function trackRuntimeAttempt(lane: SessionLane, attempt: Promise<void>): void {
  lane.runtimeAttempts.add(attempt);
  void attempt.finally(() => lane.runtimeAttempts.delete(attempt));
}

function startRuntimeAttempt(
  lane: SessionLane,
  sessionId: string,
  revision: number,
  target: RuntimeTarget,
): void {
  let attempt: Promise<unknown>;
  try {
    attempt = target.applyRuntime(sessionId, target.effort);
  } catch {
    // 会话不存在和 deferred credential switch 都会正常返回。只有真正的 runtime
    // 控制调用失败才会走到这里；保留已持久化的用户选择，发送侧再明确阻止旧 runtime。
    if (revision === lane.runtimeRevision) lane.runtimeDirty = true;
    return;
  }

  const settled = attempt.then(
    () => {
      if (revision === lane.runtimeRevision) {
        lane.runtimeDirty = false;
        return;
      }
      const latestTarget = lane.latestRuntimeTarget;
      if (!latestTarget) return;
      startRuntimeAttempt(lane, sessionId, lane.runtimeRevision, latestTarget);
    },
    () => {
      if (revision === lane.runtimeRevision) lane.runtimeDirty = true;
    },
  );
  trackRuntimeAttempt(lane, settled);
}

export function createEffortChangeCoordinator(): EffortChangeCoordinator {
  const lanes = new Map<string, SessionLane>();
  const getLane = (sessionId: string): SessionLane => {
    let lane = lanes.get(sessionId);
    if (!lane) {
      lane = createSessionLane();
      lanes.set(sessionId, lane);
    }
    return lane;
  };

  return {
    enqueue(sessionId, task) {
      const lane = getLane(sessionId);
      const result = lane.commitTail.then(task, task);
      lane.commitTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    getCommittedEffort(sessionId) {
      return getLane(sessionId).committedEffort;
    },
    setCommittedEffort(sessionId, effort) {
      getLane(sessionId).committedEffort = effort;
    },
    adoptExternalEffort(sessionId, effort, applyRuntime) {
      const lane = getLane(sessionId);
      if (lane.committedEffort === effort) return;
      lane.committedEffort = effort;
      lane.runtimeDirty = false;

      // 首次 props 水合不主动触碰 runtime；只有本组件曾发布过 runtime 目标时，
      // 外部 SSoT 更新才需要抢占旧 attempt，并立即投影以覆盖 adoption 前的迟到完成。
      if (!lane.latestRuntimeTarget) return;
      lane.runtimeRevision += 1;
      const target = { effort, applyRuntime };
      lane.latestRuntimeTarget = target;
      startRuntimeAttempt(lane, sessionId, lane.runtimeRevision, target);
    },
    publishRuntimeEffort(sessionId, effort, applyRuntime) {
      const lane = getLane(sessionId);
      lane.runtimeRevision += 1;
      lane.runtimeDirty = false;
      const target = { effort, applyRuntime };
      lane.latestRuntimeTarget = target;
      startRuntimeAttempt(lane, sessionId, lane.runtimeRevision, target);
    },
    suppressRuntimeEffort(sessionId) {
      const lane = getLane(sessionId);
      lane.runtimeRevision += 1;
      lane.latestRuntimeTarget = undefined;
      lane.runtimeDirty = false;
    },
    isRuntimeDirty(sessionId) {
      return getLane(sessionId).runtimeDirty;
    },
    async awaitRuntimeSettled(sessionId) {
      const lane = getLane(sessionId);
      // commit 会在 runtime 任务入队前完成；先等待它，覆盖“刚改档位就发送”的窗口。
      // 每次 snapshot 后复查，确保迟到调用触发的重放也已经落定，而不是人为设次数上限。
      for (;;) {
        const commitTail = lane.commitTail;
        await commitTail;
        const runtimeAttempts = [...lane.runtimeAttempts];
        // runtime failure is represented by runtimeDirty and must be handled by the
        // caller's dedicated toast path, not leak as a generic dispatch rejection.
        if (runtimeAttempts.length > 0) await Promise.allSettled(runtimeAttempts);
        if (commitTail === lane.commitTail && lane.runtimeAttempts.size === 0) return;
      }
    },
  };
}

// ChatInput 会随路由卸载，但 Main 进程中的 Agent session 不会。把协调状态放在模块单例中，
// 才不会因离开再返回会话而忘记一次尚未恢复的 runtime 同步失败。
const sharedEffortChangeCoordinator = createEffortChangeCoordinator();

export function getEffortChangeCoordinator(): EffortChangeCoordinator {
  return sharedEffortChangeCoordinator;
}

export function enqueueEffortChange(
  coordinator: EffortChangeCoordinator,
  sessionId: string,
  effort: Effort,
  pipeline: EffortChangePipeline,
): Promise<void> {
  return coordinator.enqueue(sessionId, async () => {
    await pipeline.persist(sessionId, effort);
    coordinator.setCommittedEffort(sessionId, effort);
    pipeline.onCommitted(sessionId, effort);
    coordinator.publishRuntimeEffort(sessionId, effort, pipeline.applyRuntime);
  });
}
