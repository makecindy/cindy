import { isTerminalAgentErrorEvent, type AgentEvent } from '@cindy/maker-core';

export const TURN_IDLE_THROTTLE_RESTORE_GRACE_MS = 1_000;

/**
 * 维护 desktop 对「逻辑 turn」和「前台恢复 keepalive」的本地视图。
 *
 * `anySessionInTurn()` 只回答产品语义上的 turn 是否还在跑，用于关闭窗口等
 * 需要真实 busy 判断的地方。terminal event 已经广播后会立即恢复 false。
 *
 * keepalive 单独服务 background throttling：terminal event 广播后保留一小段
 * grace，让 renderer 有时间收尾最后一批事件；可重试 `error` 只暴露错误提示，
 * 不释放 keepalive，也不结束逻辑 turn。
 */
export class SessionTurnActivityTracker {
  private readonly sessionInTurn = new Map<string, boolean>();
  private readonly sessionTurnDispatchBoundary = new Map<string, boolean>();
  private readonly sessionTurnKeepalive = new Map<string, boolean>();
  private readonly sessionTurnKeepaliveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastAnySessionTurnKeepalive = false;
  private onAnySessionTurnKeepaliveChange: ((isRunning: boolean) => void) | null = null;

  setTurnKeepaliveChangeListener(listener: ((isRunning: boolean) => void) | null): void {
    this.onAnySessionTurnKeepaliveChange = listener;
    this.lastAnySessionTurnKeepalive = this.anySessionTurnKeepalive();
    listener?.(this.lastAnySessionTurnKeepalive);
  }

  isSessionInTurn(sessionId: string): boolean {
    return this.sessionInTurn.get(sessionId) === true;
  }

  isSessionTurnDispatchBoundaryBusy(sessionId: string): boolean {
    return this.sessionTurnDispatchBoundary.get(sessionId) === true;
  }

  anySessionInTurn(): boolean {
    for (const isRunning of this.sessionInTurn.values()) {
      if (isRunning) return true;
    }
    return false;
  }

  sessionIdsInTurn(): string[] {
    return [...this.sessionInTurn]
      .filter(([, isRunning]) => isRunning)
      .map(([sessionId]) => sessionId);
  }

  setSessionInTurn(sessionId: string, isRunning: boolean): void {
    if (isRunning) this.clearScheduledSessionTurnKeepalive(sessionId);
    this.sessionInTurn.set(sessionId, isRunning);
    this.sessionTurnDispatchBoundary.set(sessionId, isRunning);
    this.sessionTurnKeepalive.set(sessionId, isRunning);
    this.notifyAnySessionTurnKeepaliveIfChanged();
  }

  deleteSession(sessionId: string): void {
    this.clearScheduledSessionTurnKeepalive(sessionId);
    this.sessionInTurn.delete(sessionId);
    this.sessionTurnDispatchBoundary.delete(sessionId);
    this.sessionTurnKeepalive.delete(sessionId);
    this.notifyAnySessionTurnKeepaliveIfChanged();
  }

  scheduleIdleAfterStatusBroadcast(sessionId: string): void {
    this.scheduleIdleAfterBroadcast(sessionId, { releaseDispatchBoundary: false });
  }

  scheduleIdleAfterTerminalBroadcast(sessionId: string): void {
    this.scheduleIdleAfterBroadcast(sessionId, { releaseDispatchBoundary: true });
  }

  private scheduleIdleAfterBroadcast(
    sessionId: string,
    options: { releaseDispatchBoundary: boolean },
  ): void {
    this.sessionInTurn.set(sessionId, false);
    if (options.releaseDispatchBoundary) {
      this.sessionTurnDispatchBoundary.set(sessionId, false);
    }
    this.clearScheduledSessionTurnKeepalive(sessionId);
    this.sessionTurnKeepalive.set(sessionId, true);
    this.notifyAnySessionTurnKeepaliveIfChanged();
    const timer = setTimeout(() => {
      this.sessionTurnKeepaliveTimers.delete(sessionId);
      this.sessionTurnKeepalive.set(sessionId, false);
      this.notifyAnySessionTurnKeepaliveIfChanged();
    }, TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);
    this.sessionTurnKeepaliveTimers.set(sessionId, timer);
  }

  private anySessionTurnKeepalive(): boolean {
    if (this.anySessionInTurn()) return true;
    for (const isRunning of this.sessionTurnKeepalive.values()) {
      if (isRunning) return true;
    }
    return false;
  }

  private clearScheduledSessionTurnKeepalive(sessionId: string): void {
    const timer = this.sessionTurnKeepaliveTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.sessionTurnKeepaliveTimers.delete(sessionId);
  }

  private notifyAnySessionTurnKeepaliveIfChanged(): void {
    const next = this.anySessionTurnKeepalive();
    if (next === this.lastAnySessionTurnKeepalive) return;
    this.lastAnySessionTurnKeepalive = next;
    this.onAnySessionTurnKeepaliveChange?.(next);
  }
}

export interface TurnRunningSessionSnapshot {
  isTurnRunning?: () => boolean;
}

export interface IdentifiedTurnRunningSessionSnapshot extends TurnRunningSessionSnapshot {
  id: string;
}

export function hasAnySessionInTurn(
  tracker: { anySessionInTurn(): boolean },
  activeSessions: Iterable<TurnRunningSessionSnapshot>,
): boolean {
  if (tracker.anySessionInTurn()) return true;
  for (const session of activeSessions) {
    if (session.isTurnRunning?.()) return true;
  }
  return false;
}

/**
 * Snapshot both event-delivered activity and maker-core's live dispatch state.
 * The latter closes the gap between Session.send() accepting work and the
 * first status event reaching the desktop tracker.
 */
export function listSessionIdsInTurn(
  tracker: { sessionIdsInTurn(): string[] },
  activeSessions: Iterable<IdentifiedTurnRunningSessionSnapshot>,
): string[] {
  const sessionIds = new Set(tracker.sessionIdsInTurn());
  for (const session of activeSessions) {
    if (session.isTurnRunning?.()) sessionIds.add(session.id);
  }
  return [...sessionIds];
}

/**
 * Coordinator dispatch boundary uses both views:
 * - maker-core live state covers Session.send reservations before desktop sees a status event.
 * - the desktop tracker latches until terminal done/error delivery is processed.
 */
export function isSessionTurnDispatchBoundaryBusy(
  tracker: { isSessionTurnDispatchBoundaryBusy(sessionId: string): boolean },
  sessionId: string,
  session: TurnRunningSessionSnapshot | null | undefined,
): boolean {
  return tracker.isSessionTurnDispatchBoundaryBusy(sessionId) || session?.isTurnRunning?.() === true;
}

export function isTerminalTurnErrorEvent(event: AgentEvent): boolean {
  return isTerminalAgentErrorEvent(event);
}
