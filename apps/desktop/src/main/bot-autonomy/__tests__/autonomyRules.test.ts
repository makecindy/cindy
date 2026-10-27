/*
 * 测试价值
 * - 生产入口与可观察结果：bot-autonomy 的判定入口 deriveFollowerBotId / resolveSchedulerBotId（谁被叫醒）、
 *   AutonomyEventLedger.evaluate + settle（何时、发几次事件）、projectBotGlance（工作台一眼看到哪些任务）。
 *   结果直接决定哪个伙伴被叫醒、主人是否被打扰、工作台显示范围。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md §6.3「谁来跟」「阈值」「防打转」与 §7 红线
 *   （总调度唯一；伙伴之间不能无限互相触发）。
 * - 现有覆盖缺口：新模块，无既有覆盖；taskWatch / runtime 测试只走代表路径，不穷举跟进者矩阵与阈值边界。
 * - 最小失败输入：creator 暂停且未允许代跟 → 必须 null（不是总调度）；同一 (类型, phaseSince) 第二次判定
 *   不再出现；第 7 次同类事件被截停；另一台电脑上的任务在这台电脑发了事件（两台电脑的同名伙伴各跟一遍）；
 *   一次 10 分钟以上的长构建（工具在途、没有活动事件）被判卡住；
 *   非总调度伙伴看不到别人开的任务。
 * - tier：unit（纯函数，无 IO、无计时器）。
 */
import { describe, expect, it } from 'vitest';

import {
  AUTONOMY_THRESHOLDS,
  DEFAULT_SCHEDULER_BOT_ID,
  type WatchedSession,
} from '../../../shared/botAutonomy.js';
import { AutonomyEventLedger, dueEventType, toSweepEvent } from '../events.js';
import { filterFollowUpEvents, deriveFollowerBotId, resolveSchedulerBotId, type FollowerBotState } from '../follower.js';
import { projectBotGlance } from '../glance.js';
import { parseActiveSessionList, summarizeInteraction } from '../phase.js';

const bot = (status: string, allowSchedulerFollow = false, shadowed = false): FollowerBotState => ({
  status, allowSchedulerFollow, shadowed,
});

function row(patch: Partial<WatchedSession>): WatchedSession {
  return {
    sessionId: 's1',
    deviceId: null,
    deviceName: null,
    online: true,
    title: 'Task',
    workingDir: null,
    finalDelivery: true,
    phase: 'running',
    phaseSince: 0,
    lastActivityAt: 0,
    startedAt: 0,
    pendingQuestion: null,
    error: null,
    creatorBotId: null,
    followerBotId: 'sched',
    source: 'user',
    ...patch,
  };
}

describe('who follows a task', () => {
  it.each([
    ['owner task → scheduler', null, 'sched', { sched: bot('active') }, 'sched'],
    ['owner task, scheduler paused → nobody', null, 'sched', { sched: bot('paused') }, null],
    ['owner task, no scheduler → nobody', null, null, {}, null],
    ['teammate task → its creator', 'a', 'sched', { a: bot('active'), sched: bot('active') }, 'a'],
    ['creator paused, not shared → nobody', 'a', 'sched', { a: bot('paused'), sched: bot('active') }, null],
    ['creator paused, shared → scheduler', 'a', 'sched', { a: bot('paused', true), sched: bot('active') }, 'sched'],
    ['creator runs on another computer, shared → scheduler', 'a', 'sched', { a: bot('active', true, true), sched: bot('active') }, 'sched'],
    ['creator gone → nobody', 'gone', 'sched', { sched: bot('active') }, null],
  ] as const)('%s', (_name, creatorBotId, schedulerBotId, bots, expected) => {
    expect(deriveFollowerBotId({
      creatorBotId,
      schedulerBotId,
      bots: new Map(Object.entries(bots)),
    })).toBe(expected);
  });

  it.each([
    ['not customized → off even with active Cindy assistant', { customized: false, schedulerBotId: null }, { [DEFAULT_SCHEDULER_BOT_ID]: bot('active') }, null],
    ['not customized, assistant paused → none', { customized: false, schedulerBotId: null }, { [DEFAULT_SCHEDULER_BOT_ID]: bot('paused') }, null],
    ['customized off stays off', { customized: true, schedulerBotId: null }, { [DEFAULT_SCHEDULER_BOT_ID]: bot('active') }, null],
    ['customized teammate', { customized: true, schedulerBotId: 'a' }, { a: bot('paused'), [DEFAULT_SCHEDULER_BOT_ID]: bot('active') }, 'a'],
    ['customized teammate archived → off, never transfer consent', { customized: true, schedulerBotId: 'a' }, { a: bot('archived'), [DEFAULT_SCHEDULER_BOT_ID]: bot('active') }, null],
  ] as const)('scheduler: %s', (_name, override, bots, expected) => {
    expect(resolveSchedulerBotId(override, new Map(Object.entries(bots)))).toBe(expected);
  });
});

describe('autonomy event thresholds and loop guard', () => {
  it('fires each (type, phaseSince) once, waits for thresholds, and caps repeats per 24h', () => {
    const ledger = new AutonomyEventLedger();
    const t0 = 1_000_000;
    const rows = [
      row({ sessionId: 'run', phase: 'running', phaseSince: t0, lastActivityAt: t0 }),
      row({ sessionId: 'wait', phase: 'waiting-answer', phaseSince: t0 }),
      row({ sessionId: 'err', phase: 'errored', phaseSince: t0 }),
      row({ sessionId: 'auto', phase: 'finished', phaseSince: t0, source: 'routine' }),
      row({ sessionId: 'off', phase: 'errored', phaseSince: t0, online: false }),
      // 另一台电脑上的任务由那台电脑上的伙伴跟：即使误带了跟进者，这台电脑也不发事件。
      row({ sessionId: 'remote', deviceId: 'd1', phase: 'errored', phaseSince: t0 }),
    ];
    // 出错立即发；卡住 / 等你未到阈值；自动化任务做完、离线电脑与另一台电脑的任务不发。
    expect(ledger.evaluate(rows, t0 + 1).due.map((c) => c.id)).toEqual([`errored:err:${t0}`]);
    const later = t0 + AUTONOMY_THRESHOLDS.stuckAfterMs;
    const first = ledger.evaluate(rows, later).due;
    expect(first.map((c) => c.type).sort()).toEqual(['errored', 'stuck', 'waiting']);
    for (const candidate of first) ledger.settle(candidate, later);
    expect(ledger.evaluate(rows, later + 1).due).toEqual([]);

    // 同一任务反复进出同一状态：第 maxEventsPerSessionPerDay + 1 次被截停，只进 capped。
    const max = AUTONOMY_THRESHOLDS.maxEventsPerSessionPerDay;
    let capped = 0;
    for (let i = 1; i <= max; i += 1) {
      const result = ledger.evaluate([row({ sessionId: 'err', phase: 'errored', phaseSince: t0 + i })], later + i);
      capped += result.capped.length;
      for (const candidate of result.due) ledger.settle(candidate, later + i);
    }
    expect(capped).toBe(1);
    // 24h 后计数清零，又可以发。
    const nextDay = later + max + 24 * 60 * 60_000;
    expect(ledger.evaluate([row({ sessionId: 'err', phase: 'errored', phaseSince: nextDay })], nextDay).due).toHaveLength(1);
  });
});

describe('stuck while a tool call is in flight', () => {
  it('waits for the longer in-tool threshold before calling a running task stuck', () => {
    const t0 = 0;
    const longBuild = row({ phase: 'running', phaseSince: t0, lastActivityAt: t0, toolInFlight: true });
    expect(dueEventType(longBuild, t0 + AUTONOMY_THRESHOLDS.stuckAfterMs)).toBeNull();
    expect(dueEventType(longBuild, t0 + AUTONOMY_THRESHOLDS.stuckInToolAfterMs)).toBe('stuck');
    expect(dueEventType({ ...longBuild, toolInFlight: false }, t0 + AUTONOMY_THRESHOLDS.stuckAfterMs)).toBe('stuck');
  });
});

describe('workbench glance scope', () => {
  it('shows every task to the scheduler but only own or taken-over tasks to other teammates', () => {
    const now = 10 * 60_000;
    const rows = [
      row({ sessionId: 'mine', creatorBotId: 'a', phase: 'waiting-permission', phaseSince: 0, pendingRequestId: 'req-1' }),
      row({ sessionId: 'taken', phase: 'running', startedAt: 60_000 }),
      row({ sessionId: 'owner', phase: 'errored', error: 'boom', phaseSince: 120_000 }),
      // 另一台电脑上的任务没有跟进者，但总调度的工作台照样看得到、可以允许。
      row({ sessionId: 'remote', deviceId: 'd1', deviceName: 'Mac mini', phase: 'usage-limit', phaseSince: 0, followerBotId: null }),
    ];
    const base = {
      rows,
      responsibleSessionIds: new Set(['taken']),
      finished: [
        { sessionId: 'mine', creatorBotId: 'a', at: now - 1 },
        { sessionId: 'owner', creatorBotId: null, at: now - 1 },
      ],
      offlineDevices: ['Old PC'],
      lastSweepAt: now,
      now,
    };
    const own = projectBotGlance({ ...base, botId: 'a', schedulerBotId: 'sched' });
    expect(own.scope).toBe('own');
    expect(own.waiting.map((r) => [r.sessionId, r.waitingFor, r.requestId])).toEqual([['mine', 'permission', 'req-1']]);
    expect(own.working.map((r) => [r.sessionId, r.minutes])).toEqual([['taken', 9]]);
    expect(own.doneToday).toBe(1);
    expect(own.offlineDevices).toEqual([]);

    const all = projectBotGlance({ ...base, botId: 'sched', schedulerBotId: 'sched', responsibleSessionIds: new Set() });
    expect(all.scope).toBe('all');
    expect(all.waiting.map((r) => [r.sessionId, r.waitingFor, r.question])).toEqual([
      ['mine', 'permission', null],
      ['owner', 'error', 'boom'],
    ]);
    expect(all.working.map((r) => r.sessionId)).toEqual(['taken', 'remote']);
    expect(all.doneToday).toBe(2);
    expect(all.offlineDevices).toEqual(['Old PC']);
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果：projectBotGlance 带 excludeBotIds（远程端 glance IPC 传入隐藏 / 归档伙伴）时的等你 / 在做 / 今天做完。
   * - Bug／规则依据：隐藏伙伴只在本机恢复（botRemoteVisibility.ts）；隐藏只写 botProfiles.hiddenAt、不写 sessions.hiddenAt，
   *   总调度（scope all）的远程工作台曾照样列出隐藏伙伴开的、它的主任务与它在跟的任务。
   * - 现有覆盖缺口：上一用例不传排除集；本机渲染层不排除，远程排除只有这里守护。
   * - 最小失败输入：隐藏伙伴开的等你 / 在做任务、它的主任务、它今天做完的任务。
   * - tier：unit（纯函数）。
   */
  it('hides tasks of companions excluded for a remote controller, keeping owner and visible teammates tasks', () => {
    const now = 10 * 60_000;
    const glance = projectBotGlance({
      botId: 'sched',
      schedulerBotId: 'sched',
      rows: [
        row({ sessionId: 'h-wait', creatorBotId: 'hidden', followerBotId: 'hidden', phase: 'waiting-answer', pendingQuestion: 'q' }),
        row({ sessionId: 'h-work', creatorBotId: 'hidden', followerBotId: 'hidden', phase: 'running' }),
        row({ sessionId: 'h-main', canonicalOfBotId: 'hidden', phase: 'errored', error: 'boom' }),
        row({ sessionId: 'owner', phase: 'usage-limit', startedAt: 60_000 }),
        row({ sessionId: 'b-task', creatorBotId: 'b', followerBotId: 'b', phase: 'waiting-permission' }),
      ],
      responsibleSessionIds: new Set(),
      finished: [
        { sessionId: 'h-done', creatorBotId: 'hidden', at: now - 1 },
        { sessionId: 'owner-done', creatorBotId: null, at: now - 1 },
      ],
      offlineDevices: [],
      lastSweepAt: now,
      now,
      excludeBotIds: new Set(['hidden']),
    });
    expect(glance.waiting.map((r) => [r.sessionId, r.phase])).toEqual([['b-task', 'waiting-permission']]);
    expect(glance.working.map((r) => [r.sessionId, r.phase])).toEqual([['owner', 'usage-limit']]);
    expect(glance.doneToday).toBe(1);
  });
});

describe('pending interaction identity and active-session responses', () => {
  // 依据：同一相位里换了一条请求要重新计时；缺口：回答 / 确认卡的 id 被归成 null，换了也认不出。
  // 「允许」只对真正的权限请求：确认卡有 id 也不能成为可批准的 requestId。tier：unit。
  it('keeps every interaction id for change detection but only exposes permission ids for approval', () => {
    expect(summarizeInteraction({ kind: 'ask_user_question', requestId: 'q1', questions: [{ question: '用哪个分支？' }] }))
      .toEqual({ summary: '用哪个分支？', waitingFor: 'answer', requestId: null, interactionId: 'q1' });
    expect(summarizeInteraction({ kind: 'host_confirm', requestId: 'c1' }))
      .toEqual({ summary: null, waitingFor: 'permission', requestId: null, interactionId: 'c1' });
  });

  it('reads both the v2 wrapper and the legacy array from list-active, and rejects anything else', () => {
    const rows = [{ sessionId: 's1' }];
    expect(parseActiveSessionList({ format: 'active-sessions-v2', sessions: rows })).toBe(rows);
    expect(parseActiveSessionList(rows)).toBe(rows);
    expect(parseActiveSessionList({ format: 'unknown' })).toBeNull();
    expect(parseActiveSessionList(null)).toBeNull();
  });
});

describe('waiting-row summary for a permission request', () => {
  it('shows an MCP tool as "server · tool" instead of the raw mcp__ identifier, and keeps other names', () => {
    // Seen in the dev build: the glance row title was `mcp__cindy_helper__call_tool` (programmer-speak on a user-facing row).
    const mcp = summarizeInteraction({ kind: 'permission', requestId: 'r1', toolName: 'mcp__cindy_helper__call_tool' });
    expect(mcp).toEqual({ summary: 'cindy_helper · call_tool', waitingFor: 'permission', requestId: 'r1', interactionId: 'r1' });
    const bash = summarizeInteraction({ kind: 'permission', requestId: 'r2', title: 'bash' });
    expect(bash?.summary).toBe('bash');
  });
});

// Queued summaries from before opt-out must never reach the model; delegated work still runs.
it('filters old follow-up batches using current consent rather than the saved follower', () => {
  const bots = new Map([['sched', bot('active')]]);
  const rows = [row({ sessionId: 'mine', phase: 'errored' }), row({ sessionId: 'delegated', creatorBotId: 'sched' })];
  const events = ['mine', 'delegated', 'deleted'].map((subject) => ({
    sourceId: 'host:sessions', event: { id: subject, subject, type: 'errored', occurredAt: 1, data: {} },
  }));
  const sweep = { sourceId: 'host:sessions', event: toSweepEvent('sched', 10) };
  expect(filterFollowUpEvents('sched', [...events, sweep], rows, null, bots, 10)).toEqual([events[1]]);
  expect(filterFollowUpEvents('sched', [...events, sweep], rows, 'sched', bots, 10)).toEqual([events[0], events[1], sweep]);
  expect(filterFollowUpEvents('sched', events, [row({sessionId: 'mine', shared: true})], 'sched', bots, 10)).toEqual([]);
});
