export type SessionMessageReclaimReason =
  | 'detail-blur'
  | 'session-switch'
  | 'app-background';

export interface SessionMessageAuthority {
  readonly sessionId: string;
  readonly generation: number;
}

export interface SessionMessageUnenteredAuthority extends SessionMessageAuthority {
  readonly resetEpoch: number;
}

export interface SessionMessageWorkLease {
  /** 更新这份工作租约是否仍持有不可回收的本地状态。 */
  update(active: boolean): void;
  /** 幂等释放；最后一份租约释放后会在 microtask 中重试暂缓回收。 */
  release(): void;
}

type Reclaimer = (sessionId: string, reason: SessionMessageReclaimReason) => boolean;

interface SessionLifecycleState {
  generation: number;
  visible: boolean;
  pendingReclaim: SessionMessageReclaimReason | null;
  work: Map<symbol, boolean>;
  workEpoch: number;
  reclaimScheduled: boolean;
}

function createState(): SessionLifecycleState {
  return {
    generation: 0,
    visible: false,
    pendingReclaim: null,
    work: new Map(),
    workEpoch: 0,
    reclaimScheduled: false,
  };
}

/**
 * 纯状态控制器：页面只报告 focus / AppState / 本地工作事实，真正回收由 store
 * 注册的单一 reclaimer 完成。状态常驻模块级，不依赖页面 effect 是否仍挂载。
 */
export function createSessionMessageLifecycleController() {
  const states = new Map<string, SessionLifecycleState>();
  const listeners = new Set<() => void>();
  let reclaimer: Reclaimer | null = null;
  // 不随 forget/reset 回绕。session 被删除、设备移除或登出后，旧异步请求即使在
  // 同一个 sessionId 重新出现后才返回，也不能撞上复用的 generation。
  let nextGeneration = 0;
  // states 在全局 store reset 时会清空，未进入过详情的 session 随后会重新从
  // generation=0 建立。单调 epoch 用于隔离 reset 前后同 ID 的无 authority 读取。
  let resetEpoch = 0;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const stateFor = (sessionId: string): SessionLifecycleState => {
    let state = states.get(sessionId);
    if (!state) {
      state = createState();
      states.set(sessionId, state);
    }
    return state;
  };

  const hasWork = (state: SessionLifecycleState): boolean => {
    for (const active of state.work.values()) {
      if (active) return true;
    }
    return false;
  };

  const schedulePendingReclaim = (sessionId: string): void => {
    const state = stateFor(sessionId);
    if (
      state.reclaimScheduled
      || state.visible
      || state.pendingReclaim === null
      || hasWork(state)
    ) return;
    state.reclaimScheduled = true;
    const generationAtSchedule = state.generation;
    queueMicrotask(() => {
      const current = states.get(sessionId);
      if (!current) return;
      current.reclaimScheduled = false;
      if (current.generation !== generationAtSchedule) {
        // 另一份 leave 可能在本 microtask 执行前推进了代际。当时由于
        // reclaimScheduled=true 没有另排任务，这里负责把仍有效的 pending 补上。
        schedulePendingReclaim(sessionId);
        return;
      }
      if (
        current.visible
        || current.pendingReclaim === null
        || hasWork(current)
      ) return;
      const reason = current.pendingReclaim;
      // false = store 侧仍有运行中、交互、pending queue 或草稿等保护事实。
      // 保留 pending，等相应状态变化时 retryPendingReclaim 再试。
      if (reclaimer?.(sessionId, reason) === true) current.pendingReclaim = null;
    });
  };

  return {
    setReclaimer(next: Reclaimer | null): void {
      reclaimer = next;
    },

    enter(sessionId: string): SessionMessageAuthority {
      const state = stateFor(sessionId);
      state.generation = ++nextGeneration;
      state.visible = true;
      state.pendingReclaim = null;
      notify();
      return { sessionId, generation: state.generation };
    },

    /**
     * token 可选：传入时只有同一代 cleanup 才能撤权，防止第一代 cleanup 晚到
     * 误伤已经重新聚焦的第二代。
     */
    leave(
      sessionId: string,
      reason: SessionMessageReclaimReason,
      token?: SessionMessageAuthority | null,
    ): boolean {
      const state = stateFor(sessionId);
      if (token && (
        token.sessionId !== sessionId
        || token.generation !== state.generation
        || !state.visible
      )) return false;
      state.generation = ++nextGeneration;
      state.visible = false;
      state.pendingReclaim = reason;
      notify();
      schedulePendingReclaim(sessionId);
      return true;
    },

    capture(sessionId: string): SessionMessageAuthority {
      const state = stateFor(sessionId);
      return { sessionId, generation: state.generation };
    },

    captureUnentered(sessionId: string): SessionMessageUnenteredAuthority {
      const state = stateFor(sessionId);
      return { sessionId, generation: state.generation, resetEpoch };
    },

    canCommit(authority: SessionMessageAuthority | null | undefined): boolean {
      if (!authority) return false;
      const state = stateFor(authority.sessionId);
      return state.visible && state.generation === authority.generation;
    },

    canCommitUnentered(
      authority: SessionMessageUnenteredAuthority | null | undefined,
    ): boolean {
      if (!authority || authority.resetEpoch !== resetEpoch) return false;
      const state = stateFor(authority.sessionId);
      return !state.visible
        && state.generation === 0
        && state.generation === authority.generation;
    },

    isVisible(sessionId: string): boolean {
      return stateFor(sessionId).visible;
    },

    hasEntered(sessionId: string): boolean {
      return stateFor(sessionId).generation > 0;
    },

    getSnapshot(sessionId: string): string {
      const state = stateFor(sessionId);
      return `${state.generation}:${state.visible ? 1 : 0}`;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    hasLocalWork(sessionId: string): boolean {
      return hasWork(stateFor(sessionId));
    },

    acquireWork(sessionId: string, active = false): SessionMessageWorkLease {
      const state = stateFor(sessionId);
      const id = Symbol(sessionId);
      const workEpoch = state.workEpoch;
      let released = false;
      state.work.set(id, active);
      return {
        update(nextActive: boolean): void {
          if (released) return;
          const current = states.get(sessionId);
          if (!current || current !== state || current.workEpoch !== workEpoch) return;
          current.work.set(id, nextActive);
          if (!nextActive) schedulePendingReclaim(sessionId);
        },
        release(): void {
          if (released) return;
          released = true;
          const current = states.get(sessionId);
          if (!current || current !== state || current.workEpoch !== workEpoch) return;
          current.work.delete(id);
          // 页面其它 cleanup（outbox 回草稿、上传取消等）需先完成，故不在当前
          // cleanup 栈里同步做破坏性回收。
          schedulePendingReclaim(sessionId);
        },
      };
    },

    retryPendingReclaim(sessionId: string): void {
      schedulePendingReclaim(sessionId);
    },

    forget(sessionId: string): void {
      // 保留一个已撤权 tombstone：删除/归档/移除设备后的迟到 push 不能重新被当成
      // “从未打开过的 regular 会话”而获准写正文。下次真正 enter 会推进到新代际。
      const state = stateFor(sessionId);
      state.generation = ++nextGeneration;
      state.visible = false;
      state.pendingReclaim = null;
      state.work.clear();
      state.workEpoch += 1;
      state.reclaimScheduled = false;
      notify();
    },

    reset(): void {
      resetEpoch += 1;
      states.clear();
      notify();
    },

    /** 测试与 store 诊断使用，不暴露可变内部对象。 */
    inspect(sessionId: string): {
      generation: number;
      visible: boolean;
      pendingReclaim: SessionMessageReclaimReason | null;
      workCount: number;
    } {
      const state = stateFor(sessionId);
      return {
        generation: state.generation,
        visible: state.visible,
        pendingReclaim: state.pendingReclaim,
        workCount: [...state.work.values()].filter(Boolean).length,
      };
    },
  };
}

export const sessionMessageLifecycle = createSessionMessageLifecycleController();
