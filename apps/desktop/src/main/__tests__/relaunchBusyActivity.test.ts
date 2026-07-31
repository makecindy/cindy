/**
 * 手动更新重启的阻断判定 —— 三个活动来源的聚合与 fail-closed。
 *
 * 这个判定服务的是不可撤销的破坏性动作(forceQuit → process.exit(0)),所以两条不变量:
 *  1. **任一来源报忙就是忙**（四源等价，没有主次）;
 *  2. **任一来源读不出来也算忙**（「无法确认」不等于「确认没有」）。
 * 每个来源各有一条独立用例 —— 少一条就意味着少覆盖一个真实的静默中断入口。
 *
 * scheduler 源尤其不能省:script 模式与 pre-run hook 阶段的 run 都不创建 session,三个内存
 * 探针全看不到它们。
 */

import { describe, expect, it } from 'vitest';

import { evaluateRelaunchBusyActivity } from '../relaunchBusyActivity.js';

const idle = {
  anySessionInTurn: () => false,
  listClaudeBackgroundSessions: () => [] as readonly string[],
  anyGhostSessionBusy: () => false,
  anySchedulerRunRunning: async () => false,
};

describe('evaluateRelaunchBusyActivity', () => {
  it('全部空闲时不阻断', async () => {
    await expect(evaluateRelaunchBusyActivity(idle)).resolves.toEqual({ busy: false, reasons: [] });
  });

  it('逻辑 turn 在跑时阻断', async () => {
    const r = await evaluateRelaunchBusyActivity({ ...idle, anySessionInTurn: () => true });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['session-in-turn']);
  });

  it('Claude 后台活动(turn 已结束但仍在调模型)时阻断', async () => {
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      listClaudeBackgroundSessions: () => ['sess-a'],
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['claude-background-activity']);
  });

  it('Ghost card-action 后台活动时阻断(它完全不经 LLM turn)', async () => {
    const r = await evaluateRelaunchBusyActivity({ ...idle, anyGhostSessionBusy: () => true });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['ghost-background-activity']);
  });

  it('多个来源同时命中时全部记进 reasons(不短路,便于诊断)', async () => {
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
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
  ] as const)('%s 抛错时 fail closed 并标记探针失败', async (key, label) => {
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      [key]: () => { throw new Error('probe exploded'); },
    });
    expect(r.busy).toBe(true);
    // 标签区分「真的有活动」与「探针坏了」—— 两者都拦，但排查方向完全不同。
    expect(r.reasons).toEqual([`${label}-probe-failed`]);
  });

  it('一个来源抛错不影响其它来源继续被读到', async () => {
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      anySessionInTurn: () => { throw new Error('probe exploded'); },
      anyGhostSessionBusy: () => true,
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['session-in-turn-probe-failed', 'ghost-background-activity']);
  });

  // scheduler:script 模式与 pre-run hook 阶段的 run 都不创建 session,内存探针看不到 ——
  // 漏掉它意味着重启会让 run 来不及落终态、脚本子进程变成失联进程。
  it('scheduler 有 run 在跑时阻断(内存源全空闲也要拦)', async () => {
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      anySchedulerRunRunning: async () => true,
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['scheduler-run-running']);
  });

  it('scheduler 查询 reject 时 fail closed', async () => {
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      anySchedulerRunRunning: async () => { throw new Error('sqlite is gone'); },
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['scheduler-run-probe-failed']);
  });

  it('内存源已命中时不再查 scheduler(省一次 SQLite 往返)', async () => {
    let called = 0;
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      anySessionInTurn: () => true,
      anySchedulerRunRunning: async () => { called += 1; return false; },
    });
    expect(r.busy).toBe(true);
    expect(called).toBe(0);
  });

  it('查库期间新起的 turn 会被二次采样抓到', async () => {
    let turnRunning = false;
    const r = await evaluateRelaunchBusyActivity({
      ...idle,
      // 第一次读为空闲;scheduler 查询期间 turn 起来,复采时才为 true。
      anySessionInTurn: () => turnRunning,
      anySchedulerRunRunning: async () => { turnRunning = true; return false; },
    });
    expect(r.busy).toBe(true);
    expect(r.reasons).toEqual(['session-in-turn']);
  });
});
