/**
 * sessionLampAggregation — 聚合灯语的口径测试
 * ---------------------------------------------------------------------------
 * 该 helper 是 rail 段钮 / rail 浮层面板项目行 / 展开态项目行 / 「对话」组行 /
 * 设备段头共用的唯一事实源。这里钉住三件事:
 *   1. tone 优先级:error > awaiting > done;urgent(定时任务失败未读)提升为 error;
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

  it('urgent 会话提升为 error(定时任务失败未读兜底)', () => {
    const c = ctx({ notifications: ['a'], urgent: ['a'] });
    expect(dotToneOf('a', c.notifications, c.attentionKinds, c.urgentSessionIds)).toBe('error');
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

  it('tone 取聚合最高档:done < awaiting < error', () => {
    const c = ctx({
      notifications: ['a', 'b', 'c'],
      kinds: { b: 'awaiting', c: 'error' },
    });
    expect(aggregateSessionLamps(['a'], c).dotTone).toBe('done');
    expect(aggregateSessionLamps(['a', 'b'], c).dotTone).toBe('awaiting');
    expect(aggregateSessionLamps(['a', 'b', 'c'], c).dotTone).toBe('error');
  });

  it('running 与未读点相互独立,可同时成立', () => {
    const c = ctx({ running: ['r'], notifications: ['a'] });
    expect(aggregateSessionLamps(['r', 'a'], c)).toEqual({ running: true, dotTone: 'done' });
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
    const agg = aggregateSessionLamps(['remote-run', 'remote-wait'], ctx({}));
    expect(agg).toEqual({ running: true, dotTone: 'awaiting' });
  });

  it('远程完成未读(attention 存续期条目)记绿 done;本地 error 仍压过它', () => {
    applyRemoteSessionActivity('device-1', {
      sessionId: 'remote-done',
      phase: 'completed',
      attention: true,
      compactDetail: '',
    });
    expect(aggregateSessionLamps(['remote-done'], ctx({})).dotTone).toBe('done');
    const c = ctx({ notifications: ['local-err'], kinds: { 'local-err': 'error' } });
    expect(aggregateSessionLamps(['remote-done', 'local-err'], c).dotTone).toBe('error');
  });
});

describe('remoteLampOf', () => {
  it('无镜像条目 → null;error phase → error tone', () => {
    expect(remoteLampOf('nope')).toBeNull();
    applyRemoteSessionActivity('device-1', {
      sessionId: 'remote-err',
      phase: 'error',
      attention: true,
      compactDetail: '',
    });
    expect(remoteLampOf('remote-err')).toEqual({ running: false, tone: 'error' });
  });
});
