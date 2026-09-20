/**
 * sessionLampAggregation — 聚合灯语的口径测试
 * ---------------------------------------------------------------------------
 * 该 helper 是 rail 段钮 / rail 浮层面板项目行 / 展开态项目行 / 「对话」组行 /
 * 设备段头共用的唯一事实源。这里钉住三件事:
 *   1. 任务入口只显示 awaiting > done；urgent 不遮住 awaiting;
 *   2. 未读集合之外的会话不点灯(attention kind 存在也不行);
 *   3. device-link 远程镜像并入:running / needs-interaction / error / 完成未读
 *      与本地链路合并取最高档(否则远程「行亮而上层入口不亮」)。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import type { AttentionKind } from '@/lib/sessionAttentionStore';
import { aggregateSessionLamps, dotToneOf, remoteLampOf } from '../sessionLampAggregation';

const ctx = (over: {
  running?: string[];
  notifications?: string[];
  kinds?: Record<string, AttentionKind>;
  urgent?: string[];
}) => ({
  runningSessionIds: new Set(over.running ?? []),
  notifications: new Set(over.notifications ?? []),
  attentionKinds: new Map(Object.entries(over.kinds ?? {})),
  urgentSessionIds: new Set(over.urgent ?? []),
});

afterEach(() => {
  clearRemoteSessionActivity();
});

describe('dotToneOf', () => {
  it('未读集合之外不点灯,即便 attention kind 存在', () => {
    const c = ctx({ kinds: { a: 'error' } });
    expect(dotToneOf('a', c.notifications, c.attentionKinds, c.urgentSessionIds)).toBeNull();
  });

  it('失败的自动运行不显示提醒点', () => {
    const c = ctx({ notifications: ['a'], urgent: ['a'] });
    expect(dotToneOf('a', c.notifications, c.attentionKinds, c.urgentSessionIds)).toBeNull();
  });

  it('同一任务旧失败不遮住待回复，运行标记也保持独立', () => {
    const c = ctx({ notifications: ['a'], kinds: { a: 'awaiting' }, urgent: ['a'], running: ['a'] });
    expect(dotToneOf('a', c.notifications, c.attentionKinds, c.urgentSessionIds)).toBe('awaiting');
    expect(aggregateSessionLamps([{ id: 'a' }], c)).toEqual({ running: true, dotTone: 'awaiting' });
  });

  it('kind 缺失的未读回落绿 done', () => {
    const c = ctx({ notifications: ['a'] });
    expect(dotToneOf('a', c.notifications, c.attentionKinds, c.urgentSessionIds)).toBe('done');
  });
});

describe('aggregateSessionLamps', () => {
  it('空集合 → 无灯', () => {
    expect(aggregateSessionLamps([], ctx({}))).toEqual({ running: false, dotTone: null });
  });

  it('错误不遮住等待回复与成功未读提醒', () => {
    const c = ctx({
      notifications: ['a', 'b', 'c'],
      kinds: { b: 'awaiting', c: 'error' },
    });
    expect(aggregateSessionLamps([{ id: 'a' }], c).dotTone).toBe('done');
    expect(aggregateSessionLamps([{ id: 'a' }, { id: 'b' }], c).dotTone).toBe('awaiting');
    expect(aggregateSessionLamps([{ id: 'a' }, { id: 'b' }, { id: 'c' }], c).dotTone).toBe('awaiting');
  });

  it('running 与未读点相互独立,可同时成立', () => {
    const c = ctx({ running: ['r'], notifications: ['a'] });
    expect(aggregateSessionLamps([{ id: 'r' }, { id: 'a' }], c)).toEqual({ running: true, dotTone: 'done' });
  });

  it('device-link 远程镜像并入:running 与 needs-interaction 合并取最高档', () => {
    applyRemoteSessionActivity('device-1', {
      sessionId: 'remote-run',
      phase: 'running',
      compactDetail: '',
    });
    applyRemoteSessionActivity('device-1', {
      sessionId: 'remote-wait',
      phase: 'needs-interaction',
      compactDetail: '',
    });
    const agg = aggregateSessionLamps([{ id: 'remote-run', deviceLinkDeviceId: 'device-1' }, { id: 'remote-wait', deviceLinkDeviceId: 'device-1' }], ctx({}));
    expect(agg).toEqual({ running: true, dotTone: 'awaiting' });
  });

  it('远程成功未读仍显示绿点，不被本地错误遮住', () => {
    applyRemoteSessionActivity('device-1', {
      sessionId: 'remote-done',
      phase: 'completed',
      attention: true,
      compactDetail: '',
    });
    expect(aggregateSessionLamps([{ id: 'remote-done', deviceLinkDeviceId: 'device-1' }], ctx({})).dotTone).toBe('done');
    const c = ctx({ notifications: ['local-err'], kinds: { 'local-err': 'error' } });
    expect(aggregateSessionLamps([{ id: 'remote-done', deviceLinkDeviceId: 'device-1' }, { id: 'local-err' }], c).dotTone).toBe('done');
  });
});

describe('remoteLampOf', () => {
  it('无镜像与远程错误均不显示提醒点', () => {
    expect(remoteLampOf('nope', undefined)).toBeNull();
    applyRemoteSessionActivity('device-1', {
      sessionId: 'remote-err',
      phase: 'error',
      attention: true,
      compactDetail: '',
    });
    expect(remoteLampOf('remote-err', 'device-1')).toEqual({ running: false, tone: null });
  });
});

 describe('设备隔离', () => {
  it('同名本地任务及另一设备不读取 device-1 镜像', () => {
    applyRemoteSessionActivity('device-1', { sessionId: 'same', phase: 'running' });
    expect(aggregateSessionLamps([{ id: 'same' }], ctx({})).running).toBe(false);
    expect(aggregateSessionLamps([{ id: 'same', deviceLinkDeviceId: 'device-2' }], ctx({})).running).toBe(false);
    expect(aggregateSessionLamps([{ id: 'same', deviceLinkDeviceId: 'device-1' }], ctx({})).running).toBe(true);
  });
  it('本地同名 running 不污染远程任务', () => {
    expect(aggregateSessionLamps([{ id: 'same', deviceLinkDeviceId: 'device-2' }], ctx({ running: ['same'] })).running).toBe(false);
  });
});
