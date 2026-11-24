/**
 * CLOSE_SESSION IPC 的业务体（依赖注入、可单测），register.ts 里的 ipcMain.handle
 * 只做 adapter（模式对齐 runtimeSetModel.ts）。
 *
 * preserveWorkspace 语义：调用方声明「这次 close 只是软重启子进程，会话逻辑上还活着」
 * ——典型场景是 /clear（清上下文后停留在同一会话）和鉴权重连（close + 1.5s 后 resend）。
 * 这类瞬态 close 不能触发 onClose 的重副作用（worktree auto-stash + 删除、临时附件
 * 清理），否则用户毫无感知地丢掉工作区（2026-07 实报：/clear 静默删活会话 worktree）。
 * 实现复用 rehydrate 同款 withRehydrateCloseSuppressed 抑制窗口。
 */

export interface CloseSessionRequestDeps {
  closeSession(sessionId: string): Promise<void>;
  withRehydrateCloseSuppressed<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  /** close 完成后的挂起交互清理（本地 IPC 附带动作，与 workspace 无关，恒执行）。 */
  cleanupPendingInteractions(sessionId: string): void;
}

export interface CloseSessionRequestOptions {
  preserveWorkspace?: boolean;
  contextClearedAt?: string;
}

/**
 * 解析 IPC 传来的 opts（跨进程边界，形状不可信）：仅软重启可携带上下文清理标记，
 * 其余一律当普通 close。老版本 renderer / 老被控端不传第二参 → undefined → 旧行为。
 */
export function parseCloseSessionOptions(raw: unknown): CloseSessionRequestOptions {
  if (typeof raw !== 'object' || raw === null) return {};
  const { preserveWorkspace, contextClearedAt } = raw as Record<string, unknown>;
  return {
    preserveWorkspace: preserveWorkspace === true,
    ...(preserveWorkspace === true && typeof contextClearedAt === 'string' ? { contextClearedAt } : {}),
  };
}

export async function handleCloseSessionRequest(
  deps: CloseSessionRequestDeps,
  sessionId: string,
  rawOpts: unknown,
): Promise<void> {
  const opts = parseCloseSessionOptions(rawOpts);
  if (opts.preserveWorkspace) {
    await deps.withRehydrateCloseSuppressed(sessionId, () => deps.closeSession(sessionId));
  } else {
    await deps.closeSession(sessionId);
  }
  deps.cleanupPendingInteractions(sessionId);
}

interface ContextClearSession {
  instanceId: string;
  agentKind: string;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  getTurnGeneration(): number;
}

/** Connect the two Desktop clear IPCs using the origin and live turn captured by Main. */
export function createContextClearSessionClose<Session extends ContextClearSession>(
  deps: CloseSessionRequestDeps & {
    getSession(sessionId: string): Session | null;
    closeSessionIfCurrent(session: Session, generation: number): Promise<void>;
  },
) {
  const localPiContextClears = new WeakMap<object, Map<string, {
    instanceId: string;
    clearedAt: string;
    generation: number;
  }>>();

  return {
    noteClear(sender: object | undefined, sessionId: string, clearedAt: unknown, remoteInvoke: boolean): void {
      if (remoteInvoke || !sender || typeof clearedAt !== 'string') return;
      const live = deps.getSession(sessionId);
      if (live?.agentKind !== 'pi' || live.remoteHostId || live.agentDeviceId) return;
      let clears = localPiContextClears.get(sender);
      if (!clears) {
        clears = new Map();
        localPiContextClears.set(sender, clears);
      }
      clears.set(sessionId, {
        instanceId: live.instanceId,
        clearedAt,
        generation: live.getTurnGeneration(),
      });
    },

    async close(sender: object | undefined, sessionId: string, rawOpts: unknown, remoteInvoke: boolean): Promise<void> {
      const { contextClearedAt } = parseCloseSessionOptions(rawOpts);
      const clears = !remoteInvoke && sender && contextClearedAt !== undefined
        ? localPiContextClears.get(sender)
        : undefined;
      const clear = clears?.get(sessionId);
      const live = clear ? deps.getSession(sessionId) : null;
      if (clear) {
        if (clear.clearedAt !== contextClearedAt) return;
        clears?.delete(sessionId);
        if (!live || live.instanceId !== clear.instanceId || live.getTurnGeneration() !== clear.generation) {
          return;
        }
      }
      await handleCloseSessionRequest({
        ...deps,
        closeSession: live && clear
          ? () => deps.closeSessionIfCurrent(live, clear.generation)
          : deps.closeSession,
      }, sessionId, rawOpts);
    },
  };
}
