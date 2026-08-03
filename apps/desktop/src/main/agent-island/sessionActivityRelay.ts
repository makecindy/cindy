import type { SessionActivityPayload } from '@cindy/device-link';
import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';

const DEFAULT_MIN_INTERVAL_MS = 1_500;
const MAX_REPLAY_TERMINAL_PAYLOADS = 200;

type Timer = ReturnType<typeof setTimeout>;

interface SessionActivityRelayOptions {
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

interface SessionActivityRelayEntry {
  lastSentAt: number;
  lastSignature: string;
  pending: SessionActivityPayload | null;
  timer: Timer | null;
}

/**
 * Per-session throttle for list-level Agent Island activity pushes.
 * It keeps the `sessions` topic low-frequency while still sending terminal
 * clears promptly so remote list rows do not retain stale activity.
 */
export class SessionActivityRelay {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly entries = new Map<string, SessionActivityRelayEntry>();
  private readonly terminalReplayPayloads = new Map<string, SessionActivityPayload>();

  constructor(
    private readonly emit: (payload: SessionActivityPayload) => void,
    options: SessionActivityRelayOptions = {},
  ) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  publish(list: readonly AgentIslandSessionActivity[]): void {
    const activeSessionIds = new Set<string>();
    for (const activity of list) {
      if (!activity.sessionId) continue;
      activeSessionIds.add(activity.sessionId);
      this.publishOne(toSessionActivityPayload(activity));
    }

    for (const sessionId of [...this.entries.keys()]) {
      if (activeSessionIds.has(sessionId)) continue;
      this.clear(sessionId);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) this.clearTimer(entry.timer);
    }
    this.entries.clear();
    this.terminalReplayPayloads.clear();
  }

  /**
   * Clears all active sessions for consumers, then drops timers/signatures.
   * Runtime reset should not leave remote lists showing stale running rows.
   */
  reset(): void {
    for (const sessionId of [...this.entries.keys()]) {
      this.clear(sessionId);
    }
  }

  /**
   * 已读回执的收尾包兜底:entries 里**没有**该会话条目时,补发一帧收尾包(幂等,
   * 远端删除不存在的条目是 no-op)并记入 terminal replay(重连 replay 时补发,
   * 推送当下丢失也能收敛)。
   *
   * 为什么需要:publish() 的隐式收敛(clear 不在 list 里的 entry / attention 翻
   * false 的 entry)依赖 entries 里还留着该会话 —— 桌面重启(entries 清零)或
   * 收尾包推送丢失后,远端列表行可能仍挂着 attention=true 的旧条目,而 entries
   * 已无记录,任何后续 publish 都不会再为它发出任何帧,绿/红点永久挂死。
   *
   * 为什么 entries 有条目时必须不动:条目存在说明本进程与远端就该会话有活跃
   * 同步流 —— 它可能是 running / needs-interaction 的 live 帧(此刻发收尾包会把
   * 远端正在展示的运行 / 等待授权指示误清成"已完成",needs-interaction 是稳定态,
   * 没有后续事件能补回),也可能是刚发出的未读终态;两者都由紧随的 publish()
   * 正常路径收敛(live 继续、已读走 clear 发收尾包),这里插手只会产生误清或重复帧。
   */
  ensureSessionTerminalClear(sessionId: string): void {
    if (this.entries.has(sessionId)) return;
    const payload = toTerminalActivityPayload(sessionId);
    this.rememberTerminalReplayPayload(payload);
    this.emit(payload);
  }

  /**
   * Replays current list activity without changing throttle state.
   *
   * `emit` 可覆盖为**定向 sink**(只投给刚订阅的那一台控制端):replay 是按需的
   * 全量快照补发,若沿默认广播通道扇出,每次有控制端 subscribe 都会把 O(会话数)
   * 的帧重复灌给其它所有控制端,在多控制端重连风暴中互相挤爆对方的传输窗口。
   */
  replay(
    list: readonly AgentIslandSessionActivity[],
    emit: (payload: SessionActivityPayload) => void = this.emit,
  ): void {
    const seenSessionIds = new Set<string>();
    for (const activity of list) {
      if (!activity.sessionId) continue;
      seenSessionIds.add(activity.sessionId);
      const payload = toSessionActivityPayload(activity);
      emit(isPublishableActivity(payload) ? payload : toTerminalActivityPayload(activity.sessionId));
    }
    for (const [sessionId, payload] of this.terminalReplayPayloads) {
      if (!seenSessionIds.has(sessionId)) emit(payload);
    }
  }

  private publishOne(payload: SessionActivityPayload): void {
    const entry = this.entries.get(payload.sessionId);
    if (!isPublishableActivity(payload)) {
      if (entry) this.clear(payload.sessionId);
      return;
    }

    const signature = activitySignature(payload);
    if (entry?.lastSignature === signature) {
      this.clearPending(entry);
      return;
    }
    if (entry?.pending && activitySignature(entry.pending) === signature) {
      return;
    }

    const now = this.now();
    // 未读终态(completed / error + attention)绕过节流立即发:它是一次性、低频、
    // 用户可见的完成/出错信号(远端行绿/红点),被 1.5s 窗口压住会让远端行短暂
    // 停留在过期的 running 活动上 —— 与 clear() 即时发收尾包同一理由。signature
    // 去重仍然生效,同一终态不会重复发。
    const isUnreadTerminal = payload.phase === 'completed' || payload.phase === 'error';
    if (!entry || isUnreadTerminal || now - entry.lastSentAt >= this.minIntervalMs) {
      this.emitNow(payload, signature, now, entry);
      return;
    }

    entry.pending = payload;
    if (entry.timer) return;
    entry.timer = this.setTimer(
      () => this.flush(payload.sessionId),
      Math.max(0, entry.lastSentAt + this.minIntervalMs - now),
    );
  }

  private flush(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.timer = null;
    const pending = entry.pending;
    entry.pending = null;
    if (!pending) return;
    this.emitNow(pending, activitySignature(pending), this.now(), entry);
  }

  private clear(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.timer) this.clearTimer(entry.timer);
    this.entries.delete(sessionId);
    const payload = toTerminalActivityPayload(sessionId);
    this.rememberTerminalReplayPayload(payload);
    this.emit(payload);
  }

  private emitNow(
    payload: SessionActivityPayload,
    signature: string,
    now: number,
    entry: SessionActivityRelayEntry | undefined,
  ): void {
    if (entry?.timer) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    this.terminalReplayPayloads.delete(payload.sessionId);
    this.emit(payload);
    this.entries.set(payload.sessionId, {
      lastSentAt: now,
      lastSignature: signature,
      pending: null,
      timer: null,
    });
  }

  private clearPending(entry: SessionActivityRelayEntry): void {
    entry.pending = null;
    if (!entry.timer) return;
    this.clearTimer(entry.timer);
    entry.timer = null;
  }

  private rememberTerminalReplayPayload(payload: SessionActivityPayload): void {
    this.terminalReplayPayloads.delete(payload.sessionId);
    this.terminalReplayPayloads.set(payload.sessionId, payload);
    while (this.terminalReplayPayloads.size > MAX_REPLAY_TERMINAL_PAYLOADS) {
      const oldestSessionId = this.terminalReplayPayloads.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      this.terminalReplayPayloads.delete(oldestSessionId);
    }
  }
}

function toSessionActivityPayload(activity: AgentIslandSessionActivity): SessionActivityPayload {
  return {
    sessionId: activity.sessionId,
    phase: activity.phase,
    compactDetail: activity.compactDetail,
    interactionKind: activity.interactionKind,
    attention: activity.attention,
  };
}

/**
 * 可发布 = active(running / needs-interaction)或**未读终态**(completed / error 且
 * attention=true)。未读终态必须透传:手机端会话行右侧状态槽靠 phase+attention 点亮
 * 完成绿点 / 出错红点(与桌面侧栏同语义)。已读后 attention 翻 false → 不再可发布 →
 * clear() 发收尾包,手机端据此清点。
 */
function isPublishableActivity(payload: SessionActivityPayload): boolean {
  return payload.phase === 'running'
    || payload.phase === 'needs-interaction'
    || payload.attention === true;
}

function toTerminalActivityPayload(sessionId: string): SessionActivityPayload {
  return {
    sessionId,
    phase: 'completed',
    compactDetail: '',
    attention: false,
  };
}

function activitySignature(payload: SessionActivityPayload): string {
  return [
    payload.phase,
    payload.compactDetail,
    payload.interactionKind ?? '',
    payload.attention === true ? '1' : '0',
  ].join('\u0000');
}
