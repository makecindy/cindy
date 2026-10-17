import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkersSnapshot } from '../../hooks/workerProjectionStore';

const projection = vi.hoisted(() => ({
  version: 0,
  retained: [] as Array<readonly [string, WorkersSnapshot]>,
  listeners: new Set<() => void>(),
}));

vi.mock('@/lib/makerTransport', () => ({
  isRemoteSessionSticky: (sessionId: string) => sessionId === 'remote-lead',
}));

vi.mock('../../hooks/workerProjectionStore', () => ({
  getAllWorkerProjectionVersion: () => projection.version,
  listRetainedWorkerProjections: () => projection.retained,
  subscribeAllWorkerProjections: (listener: () => void) => {
    projection.listeners.add(listener);
    return () => projection.listeners.delete(listener);
  },
}));

import {
  addSessionAttention,
  clearSessionAttentionMany,
  getSessionAttentionKinds,
  type AttentionKind,
} from '@/lib/sessionAttentionStore';
import {
  projectSidebarSessionActivity,
  resolveSidebarRightStatus,
} from '../../sidebar/sidebarRightStatus';
import {
  deriveOrcaLeadWorkerAttention,
  findOrcaLeadSessionIdForWorker,
  formatOrcaWorkerNotificationTitle,
  getOrcaLeadWorkerAttention,
  getSessionAttentionKindsWithOrcaLeads,
  mergeOrcaLeadAttentionKind,
  subscribeOrcaLeadWorkerAttention,
  mergeOrcaLeadAttentionKinds,
  mergeOrcaLeadNotifications,
  shouldNotifyOrcaWorkerEvent,
} from '../orcaLeadWorkerAttention';

function snapshot(...workerSessionIds: string[]): WorkersSnapshot {
  return {
    workers: workerSessionIds.map((sessionId) => ({
      workerId: `id-${sessionId}`,
      sessionId,
      role: 'developer',
      agent: 'claude-code',
      model: 'm',
      effort: null,
      label: null,
      status: 'running',
      focused: false,
      idleSince: null,
    })),
    softLimit: 5,
    hardLimit: 8,
    workerStatus: 'applied',
    requestId: 1,
    updatedAt: 0,
  };
}

function setProjections(entries: Array<readonly [string, WorkersSnapshot]>): void {
  projection.retained = entries;
  projection.version += 1;
  for (const listener of projection.listeners) listener();
}

function kinds(entries: Array<[string, AttentionKind]>): Map<string, AttentionKind> {
  return new Map(entries);
}

afterEach(() => {
  clearSessionAttentionMany([...getSessionAttentionKinds().keys()], { intent: 'explicit' });
  setProjections([]);
});

describe('deriveOrcaLeadWorkerAttention', () => {
  it('汇总 Worker 的出错 / 等待确认,出错优先', () => {
    const result = deriveOrcaLeadWorkerAttention(
      [
        ['lead-a', ['w1', 'w2']],
        ['lead-b', ['w3']],
      ],
      kinds([
        ['w1', 'awaiting'],
        ['w2', 'error'],
        ['w3', 'awaiting'],
      ]),
    );
    expect(result).toEqual(new Map([
      ['lead-a', 'error'],
      ['lead-b', 'awaiting'],
    ]));
  });

  it('Worker 的完成不汇总;没有 Worker attention 时不出条目', () => {
    expect(
      deriveOrcaLeadWorkerAttention([['lead', ['w1', 'w2']]], kinds([['w1', 'done']])).size,
    ).toBe(0);
    expect(deriveOrcaLeadWorkerAttention([['lead', []]], kinds([['lead', 'error']])).size).toBe(0);
  });
});

describe('mergeOrcaLeadAttentionKind', () => {
  it('出错 > 等待确认 > Lead 自身', () => {
    expect(mergeOrcaLeadAttentionKind(undefined, 'awaiting')).toBe('awaiting');
    expect(mergeOrcaLeadAttentionKind('done', 'awaiting')).toBe('awaiting');
    expect(mergeOrcaLeadAttentionKind('done', 'error')).toBe('error');
    expect(mergeOrcaLeadAttentionKind('awaiting', 'error')).toBe('error');
    expect(mergeOrcaLeadAttentionKind('error', 'awaiting')).toBe('error');
    expect(mergeOrcaLeadAttentionKind('done', undefined)).toBe('done');
    expect(mergeOrcaLeadAttentionKind(undefined, undefined)).toBeUndefined();
  });

  it('Lead 运行中 + Worker 等待确认:侧栏 Lead 行显示蓝点而不是转圈', () => {
    const workerKind = deriveOrcaLeadWorkerAttention(
      [['lead', ['worker']]],
      kinds([['worker', 'awaiting']]),
    ).get('lead');
    const activity = projectSidebarSessionActivity({
      sessionId: 'lead',
      liveActivity: { phase: 'running', currentTurnActive: true },
      attentionKind: mergeOrcaLeadAttentionKind(undefined, workerKind),
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: workerKind !== undefined,
    });
    expect(resolveSidebarRightStatus(activity)).toBe('awaiting');
  });

  it('Lead 运行中 + Worker 出错:红点盖过运行中', () => {
    const activity = projectSidebarSessionActivity({
      sessionId: 'lead',
      liveActivity: { phase: 'running', currentTurnActive: true },
      attentionKind: mergeOrcaLeadAttentionKind(undefined, 'error'),
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    });
    expect(resolveSidebarRightStatus(activity)).toBe('error');
  });
});

describe('整表合并', () => {
  it('没有 Worker 汇总时原样返回入参引用', () => {
    const attention = kinds([['a', 'done']]);
    const notifications = new Set(['a']);
    expect(mergeOrcaLeadAttentionKinds(attention, new Map())).toBe(attention);
    expect(mergeOrcaLeadNotifications(notifications, new Map())).toBe(notifications);
    // Lead 自身已是更高档:不新建 Map。
    expect(
      mergeOrcaLeadAttentionKinds(kinds([['lead', 'error']]), new Map([['lead', 'awaiting']])).get('lead'),
    ).toBe('error');
  });

  it('并入 Lead 的 kind 与未读,不改动入参', () => {
    const attention = kinds([['lead', 'done']]);
    const merged = mergeOrcaLeadAttentionKinds(attention, new Map([['lead', 'awaiting']]));
    expect(merged.get('lead')).toBe('awaiting');
    expect(attention.get('lead')).toBe('done');
    const notifications = new Set<string>();
    expect([...mergeOrcaLeadNotifications(notifications, new Map([['lead', 'error']]))]).toEqual([
      'lead',
    ]);
    expect(notifications.size).toBe(0);
  });
});

describe('模块级派生快照', () => {
  it('跟随 Worker 自己的 attention 出现与消失,且不写回 attention store', () => {
    setProjections([['lead', snapshot('worker')]]);
    expect(getOrcaLeadWorkerAttention().size).toBe(0);

    addSessionAttention('worker', 'awaiting');
    expect(getOrcaLeadWorkerAttention().get('lead')).toBe('awaiting');
    expect(getSessionAttentionKindsWithOrcaLeads().get('lead')).toBe('awaiting');
    expect(getSessionAttentionKinds().has('lead')).toBe(false);

    addSessionAttention('worker', 'error');
    expect(getOrcaLeadWorkerAttention().get('lead')).toBe('error');

    clearSessionAttentionMany(['worker'], { intent: 'explicit' });
    expect(getOrcaLeadWorkerAttention().has('lead')).toBe(false);
  });

  it('内容不变时复用同一引用;无汇总时合并表就是原表', () => {
    setProjections([['lead', snapshot('worker')]]);
    addSessionAttention('worker', 'error');
    const first = getOrcaLeadWorkerAttention();
    // 无关会话变化:attention 表换了引用,但 Lead 汇总内容不变。
    addSessionAttention('other', 'done');
    expect(getOrcaLeadWorkerAttention()).toBe(first);

    clearSessionAttentionMany(['worker'], { intent: 'explicit' });
    expect(getSessionAttentionKindsWithOrcaLeads()).toBe(getSessionAttentionKinds());
  });

  it('Worker 离开投影(归档 / 协同结束)后不再汇总;远程 Lead 不在范围内', () => {
    addSessionAttention('worker', 'error');
    addSessionAttention('remote-worker', 'error');
    setProjections([
      ['lead', snapshot('worker')],
      ['remote-lead', snapshot('remote-worker')],
    ]);
    expect([...getOrcaLeadWorkerAttention().keys()]).toEqual(['lead']);

    setProjections([['lead', snapshot()]]);
    expect(getOrcaLeadWorkerAttention().size).toBe(0);
  });

  it('逐行订阅只在 Lead 汇总内容变化时被唤醒', () => {
    setProjections([['lead', snapshot('worker')]]);
    const listener = vi.fn();
    const unsubscribe = subscribeOrcaLeadWorkerAttention(listener);
    addSessionAttention('other', 'error');
    setProjections([['lead', snapshot('worker', 'worker-2')]]);
    expect(listener).not.toHaveBeenCalled();

    addSessionAttention('worker', 'awaiting');
    expect(listener).toHaveBeenCalledTimes(1);
    addSessionAttention('worker-2', 'awaiting');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('按投影反查 Worker 所属 Lead', () => {
    setProjections([['lead', snapshot('w1', 'w2')]]);
    expect(findOrcaLeadSessionIdForWorker('w2')).toBe('lead');
    expect(findOrcaLeadSessionIdForWorker('unknown')).toBeNull();
  });
});

describe('Worker 通知', () => {
  it('只放行本机 Worker 的出错与需要确认,完成不单独通知', () => {
    expect(shouldNotifyOrcaWorkerEvent('done', {})).toBe(false);
    expect(shouldNotifyOrcaWorkerEvent('error', {})).toBe(true);
    expect(shouldNotifyOrcaWorkerEvent('needs-reply', {})).toBe(true);
    expect(shouldNotifyOrcaWorkerEvent('error', { deviceLinkDeviceId: 'host' })).toBe(false);
  });

  it('标题为「Lead 标题 · Worker 标题」,找不到 Lead 时退回 Worker 标题', () => {
    expect(formatOrcaWorkerNotificationTitle('Worker · developer', '重构登录')).toBe(
      '重构登录 · Worker · developer',
    );
    expect(formatOrcaWorkerNotificationTitle('Worker · developer', null)).toBe('Worker · developer');
  });
});
