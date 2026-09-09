/**
 * RenameSessionsConfirmBridge —— rename_sessions 工具的写入前用户确认桥。
 *
 * MCP tool handler 在 main 进程发起确认请求,本桥 broadcast 一个
 * kind='rename_sessions_confirm' 的 interaction 到 renderer,并挂起到用户确认、
 * 取消、超时或会话清理。确认卡只展示本次将写入的标题变更;真正写库路径只能
 * 在 confirmed 后继续。
 */

import { createDesktopOnlyConfirmationRequestId } from '../cindy-brain/desktopOnlyConfirmationProjection.js';
import { MAKER_PUSH } from '../maker-ipc/channels';
import { HOST_CONFIRM_TIMEOUT_MS } from '../maker-ipc/hostConfirmTiming.js';

export interface RenameSessionsConfirmItem {
  sessionId: string;
  currentTitle: string | null;
  newTitle: string;
  workingDir: string | null;
  updatedAt: string;
}

export type RenameSessionsConfirmDecision =
  | { confirmed: true }
  | {
      confirmed: false;
      reason: 'cancelled' | 'timeout' | 'session_closed' | 'session_aborted';
    };

/** Renderer 可重放的批量改名确认请求；主进程持有它直到确认流程 settle。 */
export interface RenameSessionsConfirmInteractionSnapshot {
  kind: 'rename_sessions_confirm';
  requestId: string;
  changes: RenameSessionsConfirmItem[];
}

export interface RenameSessionsConfirmBridgeDeps {
  broadcast: (channel: string, payload: unknown) => void;
  /** 确认超时,默认 9 分钟,须早于外层 MCP 的 10 分钟 deadline。测试注小值。 */
  timeoutMs?: number;
  logger?: { warn: (...args: unknown[]) => void };
  /** 同 IssueConfirmBridgeDeps.onDesktopOnlyConfirmPending(#926):IM 侧「去桌面确认」提示。 */
  onDesktopOnlyConfirmPending?: (sessionId: string) => void;
}

interface PendingConfirmEntry {
  sessionId: string;
  request: RenameSessionsConfirmInteractionSnapshot;
  resolve: (decision: RenameSessionsConfirmDecision) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class RenameSessionsConfirmBridge {
  private readonly pending = new Map<string, PendingConfirmEntry>();

  constructor(private readonly deps: RenameSessionsConfirmBridgeDeps) {}

  request(
    sessionId: string,
    changes: RenameSessionsConfirmItem[],
  ): Promise<RenameSessionsConfirmDecision> {
    const requestId = createDesktopOnlyConfirmationRequestId();
    const request: RenameSessionsConfirmInteractionSnapshot = {
      kind: 'rename_sessions_confirm',
      requestId,
      changes,
    };
    return new Promise<RenameSessionsConfirmDecision>((resolve) => {
      const timeoutMs = this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        this.settle(requestId, { confirmed: false, reason: 'timeout' }, 'timeout');
      }, timeoutMs);
      this.pending.set(requestId, { sessionId, request, resolve, timeoutId });
      this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, {
        sessionId,
        request,
      });
      try {
        this.deps.onDesktopOnlyConfirmPending?.(sessionId);
      } catch (err) {
        // 旁路提示绝不反噬确认流程:回调同步抛错会在 Promise executor 里把
        // request() 直接 reject(review 反馈)——吞错只 warn。
        this.deps.logger?.warn('onDesktopOnlyConfirmPending threw (ignored)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** 打开、重连或刷新会话时供 renderer 补回错过的确认卡。 */
  pendingSnapshots(sessionId?: string): Array<{
    sessionId: string;
    request: RenameSessionsConfirmInteractionSnapshot;
  }> {
    return Array.from(this.pending.values())
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map((entry) => ({ sessionId: entry.sessionId, request: entry.request }));
  }

  resolve(requestId: string, rawDecision: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    let decision = parseDecision(rawDecision);
    if (!decision) {
      this.deps.logger?.warn(
        'rename-sessions-confirm: invalid decision shape, fallback to cancelled',
        {
          requestId,
        },
      );
      decision = { confirmed: false, reason: 'cancelled' };
    }
    this.settlePending(requestId, entry, decision);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: 'resolved',
      resolvedAs: decision.confirmed ? 'allow' : 'deny',
    });
    return true;
  }

  cleanupForSession(sessionId: string, reason: 'session_closed' | 'session_aborted'): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId !== sessionId) continue;
      this.settle(requestId, { confirmed: false, reason }, reason);
    }
  }

  private settle(
    requestId: string,
    decision: RenameSessionsConfirmDecision & { confirmed: false },
    dismissReason: string,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.settlePending(requestId, entry, decision);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: dismissReason,
      resolvedAs: 'deny',
    });
  }

  private settlePending(
    requestId: string,
    entry: PendingConfirmEntry,
    decision: RenameSessionsConfirmDecision,
  ): void {
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.resolve(decision);
  }
}

function parseDecision(raw: unknown): RenameSessionsConfirmDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.confirmed === true) return { confirmed: true };
  if (obj.confirmed === false) return { confirmed: false, reason: 'cancelled' };
  return null;
}
