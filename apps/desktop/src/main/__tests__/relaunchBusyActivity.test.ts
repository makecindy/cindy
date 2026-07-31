/**
 * 手动更新重启的阻断判定 —— 三个活动来源的聚合与 fail-closed。
 *
 * 这个判定服务的是不可撤销的破坏性动作(forceQuit → process.exit(0)),所以两条不变量:
 *  1. **任一来源报忙就是忙**（三源等价，没有主次）;
 *  2. **任一来源读不出来也算忙**（「无法确认」不等于「确认没有」）。
 * 每个来源各有一条独立用例 —— 少一条就意味着少覆盖一个真实的静默中断入口。
 */

import { describe, expect, it } from 'vitest';

import { evaluateRelaunchBusyActivity } from '../relaunchBusyActivity.js';

const idle = {
  anySessionInTurn: () => false,
  listClaudeBackgroundSessions: () => [] as readonly string[],
  anyGhostSessionBusy: () => false,
};

describe('evaluateRelaunchBusyActivity', () => {
  it('全部空闲时不阻断', () => {
    expect(evaluateRelaunchBusyActivity(idle)).toEqual({ busy: false, reasons: [] });
  });

  it('逻辑 turn 在跑时阻断', () => {
    const r = evaluateRelaunchBusyActivity({ ...idle, anySessionInTurn: () => true });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['session-in-turn']);
  });

  it('Claude 后台活动(turn 已结束但仍在调模型)时阻断', () => {
    const r = evaluateRelaunchBusyActivity({
      ...idle,
      listClaudeBackgroundSessions: () => ['sess-a'],
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['claude-background-activity']);
  });

  it('Ghost card-action 后台活动时阻断(它完全不经 LLM turn)', () => {
    const r = evaluateRelaunchBusyActivity({ ...idle, anyGhostSessionBusy: () => true });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['ghost-background-activity']);
  });

  it('多个来源同时命中时全部记进 reasons(不短路,便于诊断)', () => {
    const r = evaluateRelaunchBusyActivity({
      anySessionInTurn: () => true,
      listClaudeBackgroundSessions: () => ['sess-a'],
      anyGhostSessionBusy: () => true,
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual([
      'session-in-turn',
      'claude-background-activity',
      'ghost-background-activity',
    ]);
  });

  it.each([
    ['anySessionInTurn', 'session-in-turn'],
    ['listClaudeBackgroundSessions', 'claude-background-activity'],
    ['anyGhostSessionBusy', 'ghost-background-activity'],
  ] as const)('%s 抛错时 fail closed 并标记探针失败', (key, label) => {
    const r = evaluateRelaunchBusyActivity({
      ...idle,
      [key]: () => { throw new Error('probe exploded'); },
    });
    expect(r.busy).toBe(true);
    // 标签区分「真的有活动」与「探针坏了」—— 两者都拦，但排查方向完全不同。
    expect(r.reasons).toEqual([`${label}-probe-failed`]);
  });

  it('一个来源抛错不影响其它来源继续被读到', () => {
    const r = evaluateRelaunchBusyActivity({
      anySessionInTurn: () => { throw new Error('probe exploded'); },
      listClaudeBackgroundSessions: () => [] as readonly string[],
      anyGhostSessionBusy: () => true,
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['session-in-turn-probe-failed', 'ghost-background-activity']);
  });
});
