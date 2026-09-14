import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIslandSessionActivity } from '../../../shared/agentIsland.js';
import { SessionActivityRelay } from '../sessionActivityRelay.js';

function activity(
  sessionId: string,
  compactDetail: string,
  patch: Partial<AgentIslandSessionActivity> = {},
): AgentIslandSessionActivity {
  return {
    sessionId,
    phase: 'running',
    recordStatus: 'active',
    compactDetail,
    startedAtMs: 1,
    lastActivityAtMs: 1,
    currentActionSummary: compactDetail,
    attention: false,
    workflow: null,
    turnGeneration: null,
    gracefulStopState: 'none',
    source: 'live',
    ...patch,
  };
}

describe('SessionActivityRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bypasses throttling for unread terminal states arriving inside the window', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    expect(emit).toHaveBeenCalledTimes(1);

    // 刚发过 running(仍在 1.5s 窗口内)→ 完成未读必须立即透传,不得排队等 timer
    relay.publish([activity('s1', 'run tests', { phase: 'completed', attention: true })]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      phase: 'completed',
      attention: true,
    }));
  });

  it('publishes unread terminal activity and downgrades to a clear once read', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 0 });

    // 完成但未读:必须透传(手机端右侧完成绿点靠 phase+attention 点亮)
    relay.publish([activity('s1', 'run tests', { phase: 'completed', attention: true })]);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      phase: 'completed',
      attention: true,
    }));

    // 已读(attention 翻 false)→ 不再可发布 → 收尾清除包
    emit.mockClear();
    relay.publish([activity('s1', 'run tests', { phase: 'completed', attention: false })]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      phase: 'completed',
      attention: false,
      compactDetail: '',
    }));
  });

  it('sends the first meaningful activity immediately and rate-limits later changes per session', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.publish([activity('s1', 'Editing README')]);
    relay.publish([activity('s1', 'Running tests')]);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Thinking',
    }));

    vi.advanceTimersByTime(1_499);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Running tests',
    }));
  });

  it('filters unchanged snapshots and clears stale activity when a session disappears', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.publish([activity('s1', 'Thinking')]);
    expect(emit).toHaveBeenCalledTimes(1);

    relay.publish([]);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: false,
    });
  });

  it('replays current active activity without changing throttle state', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.replay([activity('s1', 'Thinking')]);
    relay.publish([activity('s1', 'Editing README')]);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Thinking',
    }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Thinking',
    }));

    vi.advanceTimersByTime(1_500);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Editing README',
    }));
  });

  it('replays through a scoped emit override without touching the default broadcast sink', () => {
    const emit = vi.fn();
    const scopedEmit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    emit.mockClear();

    // 定向 replay:快照只进 scoped sink(刚订阅的控制端),默认广播通道零流量
    relay.replay([activity('s1', 'Thinking')], scopedEmit);
    expect(scopedEmit).toHaveBeenCalledTimes(1);
    expect(scopedEmit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Thinking',
    }));
    expect(emit).not.toHaveBeenCalled();

    // replay 不改变节流状态:窗口内的后续 publish 仍按原节奏走默认通道
    relay.publish([activity('s1', 'Editing README')]);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Editing README',
    }));
  });

  it('replays terminal clears that late subscribers may have missed', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.publish([]);
    emit.mockClear();

    relay.replay([]);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: false,
    });

    emit.mockClear();
    relay.publish([activity('s1', 'New run')]);
    relay.replay([activity('s1', 'New run')]);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 's1',
      phase: 'running',
      compactDetail: 'New run',
    }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 's1',
      phase: 'running',
      compactDetail: 'New run',
    }));
  });

  it('ensures a terminal clear for a session with no relay entry and remembers it for replay', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    // 桌面重启 / 收尾包推送丢失后 entries 为空:已读回执仍必须发出收尾包,
    // 否则远端列表行挂着的 attention=true 旧条目永远无法收敛。
    relay.ensureSessionTerminalClear('s1');

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: false,
    });

    // 收尾包同时记入 terminal replay:发送当下推送丢失,重连 replay 也能补上。
    emit.mockClear();
    relay.replay([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      attention: false,
    }));
  });

  it('does not touch an existing relay entry when ensuring a terminal clear', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    // entry 存在(此处是 live running 帧)说明与远端有活跃同步流:ensure 不得
    // 插手 —— 发收尾包会把远端的 running / needs-interaction 指示误清成"已完成"。
    relay.publish([activity('s1', 'Thinking')]);
    emit.mockClear();

    relay.ensureSessionTerminalClear('s1');

    expect(emit).not.toHaveBeenCalled();

    // entry 保留:正常 publish 路径继续收敛(会话消失 → clear 收尾包)。
    relay.publish([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      phase: 'completed',
      attention: false,
    }));
  });

  it('does not clear a leftover unread completed entry either — publish/ledger owns that', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    // 异步 not-found 回执可能在查询窗口内碰上新一轮 completed。ensure 若因
    // 「entries 是终态」就 clear,会把新绿点误清。未读由独立账本 + publish 收敛。
    relay.publish([activity('s1', 'run tests', { phase: 'completed', attention: true })]);
    emit.mockClear();

    relay.ensureSessionTerminalClear('s1');

    expect(emit).not.toHaveBeenCalled();
  });

  it('does not clear a leftover unread error entry either', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'boom', { phase: 'error', attention: true })]);
    emit.mockClear();

    relay.ensureSessionTerminalClear('s1');

    expect(emit).not.toHaveBeenCalled();
  });

  it('leaves a live needs-interaction entry intact', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', '等待权限确认', {
      phase: 'needs-interaction',
      interactionKind: 'permission',
    })]);
    emit.mockClear();

    relay.ensureSessionTerminalClear('s1');

    expect(emit).not.toHaveBeenCalled();
  });

  it('drops pending throttled activity when the latest snapshot returns to the last sent state', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.publish([activity('s1', 'Editing README')]);
    relay.publish([activity('s1', 'Thinking')]);

    vi.advanceTimersByTime(1_500);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Thinking',
    }));
  });

  it('clears active activity on terminal phase without waiting for the throttle window', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.publish([activity('s1', 'Done', { phase: 'completed' })]);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
    }));
  });

  it('clears active activity and drops pending throttled updates on reset', () => {
    const emit = vi.fn();
    const relay = new SessionActivityRelay(emit, { minIntervalMs: 1_500 });

    relay.publish([activity('s1', 'Thinking')]);
    relay.publish([activity('s1', 'Editing README')]);
    expect(emit).toHaveBeenCalledTimes(1);

    relay.reset();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: false,
    });

    vi.advanceTimersByTime(1_500);
    expect(emit).toHaveBeenCalledTimes(2);

    relay.publish([activity('s1', 'Editing README')]);
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 's1',
      compactDetail: 'Editing README',
    }));
  });
});
