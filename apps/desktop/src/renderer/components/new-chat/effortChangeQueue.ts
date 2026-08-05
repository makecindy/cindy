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
  enqueue(sessionId: string, task: () => Promise<void>): Promise<void>;
  getCommittedEffort(sessionId: string): Effort | undefined;
  setCommittedEffort(sessionId: string, effort: Effort): void;
  adoptExternalEffort(sessionId: string, effort: Effort, applyRuntime: ApplyRuntimeEffort): void;
  publishRuntimeEffort(sessionId: string, effort: Effort, applyRuntime: ApplyRuntimeEffort): void;
  suppressRuntimeEffort(sessionId: string): void;
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
}

function createSessionLane(): SessionLane {
  return {
    commitTail: Promise.resolve(),
    runtimeRevision: 0,
  };
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
    return;
  }

  void attempt.then(
    () => {
      if (revision === lane.runtimeRevision) return;
      const latestTarget = lane.latestRuntimeTarget;
      if (!latestTarget) return;
      startRuntimeAttempt(lane, sessionId, lane.runtimeRevision, latestTarget);
    },
    () => undefined,
  );
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
      lane.commitTail = result.catch(() => undefined);
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
      const target = { effort, applyRuntime };
      lane.latestRuntimeTarget = target;
      startRuntimeAttempt(lane, sessionId, lane.runtimeRevision, target);
    },
    suppressRuntimeEffort(sessionId) {
      const lane = getLane(sessionId);
      lane.runtimeRevision += 1;
      lane.latestRuntimeTarget = undefined;
    },
  };
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
