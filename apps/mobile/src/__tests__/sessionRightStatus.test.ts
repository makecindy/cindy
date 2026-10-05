/**
 * sessionRightStatus.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖:会话行右侧状态槽五档优先级与桌面 sidebarRightStatus 对齐 ——
 * error 红 > awaiting TapTap 蓝 > running spinner > 完成未读绿 > 时间。
 */

import { describe, expect, it } from 'vitest';

import { resolveMobileCollapsedGroupStatus, resolveMobileSessionRightStatus } from '../session/sessionRightStatus';

const base = {
  liveAttention: false,
  livePhase: undefined,
  pendingInteractionCount: 0,
  running: false,
  scheduleUnreadCount: 0,
} as const;

it('shows the host interruption without live activity, survives read ACK and clears on resolution', () => {
  const interruption = {
    status: 'active',
    activeTurnStartedAt: 1000,
    interruptedTurnStartedAt: 1000,
    lastTurnEndedAt: 900,
  };
  expect(resolveMobileSessionRightStatus({ ...base, interruption })).toBe('error');
  expect(
    resolveMobileSessionRightStatus({
      ...base,
      interruption,
      liveAttention: false,
    }),
  ).toBe('error');
  expect(
    resolveMobileSessionRightStatus({
      ...base,
      interruption: { ...interruption, lastTurnEndedAt: 1000 },
    }),
  ).toBe('time');
  expect(
    resolveMobileSessionRightStatus({
      ...base,
      interruption: { ...interruption, interruptedTurnStartedAt: undefined },
    }),
  ).toBe('time');
});

describe('resolveMobileSessionRightStatus', () => {
  it('error 未读压过一切(含 running 与待处理交互)', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      liveAttention: true,
      livePhase: 'error',
      pendingInteractionCount: 2,
      running: true,
      scheduleUnreadCount: 3,
    })).toBe('error');
  });

  it('error phase 但已读(attention=false)不亮红', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      livePhase: 'error',
    })).toBe('time');
  });

  it('awaiting 压过 running:实时待处理交互', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      pendingInteractionCount: 1,
      running: true,
    })).toBe('awaiting');
  });

  it('awaiting 也可由 liveActivity 未读 needs-interaction 点亮(relay 兜底)', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      liveAttention: true,
      livePhase: 'needs-interaction',
    })).toBe('awaiting');
  });

  it('running 压过完成未读', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      running: true,
      scheduleUnreadCount: 1,
    })).toBe('running');
  });

  it('完成未读走 done:定时任务未读或 liveActivity 未读 completed', () => {
    expect(resolveMobileSessionRightStatus({
      ...base,
      scheduleUnreadCount: 2,
    })).toBe('done');
    expect(resolveMobileSessionRightStatus({
      ...base,
      liveAttention: true,
      livePhase: 'completed',
    })).toBe('done');
  });

  it('无任何信号显示时间', () => {
    expect(resolveMobileSessionRightStatus(base)).toBe('time');
  });
});

it('unread failed automation is red even without a live activity, and clears after read', () => {
  expect(resolveMobileSessionRightStatus({ ...base, scheduleUnreadCount: 1, scheduleHasUnreadFailedRun: true })).toBe('error');
  expect(resolveMobileSessionRightStatus({ ...base, scheduleUnreadCount: 1, scheduleHasUnreadFailedRun: true, running: true })).toBe('error');
  expect(resolveMobileSessionRightStatus({ ...base, scheduleUnreadCount: 0, scheduleHasUnreadFailedRun: false })).toBe('time');
});

describe('resolveMobileCollapsedGroupStatus(收起项目 / 对话组组头,对齐桌面收起项目)', () => {
  type Row = import('@cindy/maker-shared/session-list').RemoteSessionListItem;
  const row = (id: string, patch: Partial<Row> = {}): Row => ({
    session: { id, status: 'active' } as Row['session'],
    title: id,
    subtitle: '',
    detail: '',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    pendingInteractionCount: 0,
    scheduleInfo: null,
    ...patch,
  });
  const completedUnread = { liveActivity: { sessionId: '', phase: 'completed', compactDetail: '', attention: true } } as const;
  const errorUnread = { liveActivity: { sessionId: '', phase: 'error', compactDetail: '', attention: true } } as const;
  const notRunning = () => false;

  it('空闲 / 已读的组头无点、不呼吸', () => {
    expect(resolveMobileCollapsedGroupStatus([row('a'), row('b')], notRunning)).toEqual({ running: false, dot: null });
  });

  it('运行态只让图标呼吸,不占右槽', () => {
    expect(resolveMobileCollapsedGroupStatus([row('a')], (id) => id === 'a')).toEqual({ running: true, dot: null });
  });

  it('运行与完成未读可同时出现(兄弟任务各自贡献)', () => {
    expect(resolveMobileCollapsedGroupStatus([row('a'), row('b', completedUnread)], (id) => id === 'a'))
      .toEqual({ running: true, dot: 'done' });
  });

  it('任务重新在跑时旧的完成未读不再点绿,出错红点仍保留', () => {
    expect(resolveMobileCollapsedGroupStatus([row('a', completedUnread)], (id) => id === 'a'))
      .toEqual({ running: true, dot: null });
    expect(resolveMobileCollapsedGroupStatus([row('a', errorUnread)], (id) => id === 'a'))
      .toEqual({ running: true, dot: 'error' });
  });

  it('多档同时存在时只取最高一档:红 > 蓝 > 绿', () => {
    const awaiting = row('w', { pendingInteractionCount: 1 });
    expect(resolveMobileCollapsedGroupStatus([row('d', completedUnread), awaiting], notRunning).dot).toBe('awaiting');
    expect(resolveMobileCollapsedGroupStatus([row('d', completedUnread), awaiting, row('e', errorUnread)], notRunning).dot)
      .toBe('error');
  });

  it('计入自动化组折叠起来的每次运行', () => {
    const failedRun = row('run-1', { scheduleInfo: { unreadCount: 1, hasUnreadFailedRun: true } as Row['scheduleInfo'] });
    const latest = row('run-2');
    const group = { ...latest, automationGroup: { key: 'g', items: [failedRun, latest] } } as unknown as Row;
    expect(resolveMobileCollapsedGroupStatus([group], notRunning).dot).toBe('error');
    expect(resolveMobileCollapsedGroupStatus([group], (id) => id === 'run-1').running).toBe(true);
  });
});
