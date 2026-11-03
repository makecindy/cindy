/*
 * 测试价值
 * - 生产入口与可观察结果：TaskWatch（start / applyActivity / applyInputProjection / sweep）产出的状态表行：
 *   哪些任务进表、处于什么状态、等你的那句话、谁在跟；远程电脑失败时的退避与离线标记。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md §6.3（观察范围：排除伙伴专线 / 隐藏 / Orca
 *   worker；启动时已做完的任务不补发；只有观察到完成才算做完，主人停止的任务静默离表；长工具调用在途；
 *   等你状态的时刻跨重启稳定；远程电脑离线保留最后状态；轮询失败退避，不形成重试风暴）。
 * - 现有覆盖缺口：新模块；autonomyRules 只测纯判定，不经过活动订阅、读库与远程轮询的组合时序。
 * - 最小失败输入：伙伴主任务（canonical）出现在活动里；启动时灵动岛残留「完成」；主人点停止后灵动岛条目消失
 *   被当成做完；同一条挂起交互在重启后得到新的事件 id；远程 list-active 连续失败；远程任务两次轮询之间从权限请求
 *   A 换到 B，仍显示 A；本机任务在同一相位里从请求 A 换到 B（权限或回答），沿用 A 的等待时刻；读任务元数据失败一次后，
 *   这批任务被丢掉，之后再无活动就永远不进表；启动兜底读失败一次后再不重试；启动时归属读失败，上一轮被打断的任务按空归属判给总调度、工作台把空表当成「没事」；伙伴刚开的任务在上次归属读取
 *   几秒内出现，被当成「没人开」落到总调度；出错只留横幅文案、丢了工具循环等稳定原因。
 * - tier：unit（全部 IO 经注入的内存 fake，时间由 now() 推进，无真实等待）。
 */
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { describe, expect, it, vi } from 'vitest';

import { AUTONOMY_THRESHOLDS } from '../../../shared/botAutonomy.js';
import { AutonomyEventLedger, toRoutineEvent } from '../events.js';
import {
  REMOTE_BACKOFF_MAX_MS,
  TaskWatch,
  type LocalSessionMeta,
  type RemoteDeviceTarget,
  type TaskWatchDeps,
} from '../taskWatch.js';

function meta(id: string, patch: Partial<LocalSessionMeta> = {}): LocalSessionMeta {
  return {
    id, title: `title ${id}`, workingDir: '/w', status: 'active', hiddenAt: null, source: 'desktop',
    orcaRole: null, laneRole: null, laneBotId: null, interrupted: false, activeTurnStartedAt: null, lastTurnEndedAt: null, ...patch,
  };
}

function activity(sessionId: string, phase: string, extra: Partial<SessionActivitySnapshot> = {}): SessionActivitySnapshot {
  return {
    sessionId, phase, startedAtMs: 1_000, lastActivityAtMs: 1_000, currentActionSummary: null,
    attention: false, workflow: null, turnGeneration: 1, gracefulStopState: 'none', source: 'local', ...extra,
  } as unknown as SessionActivitySnapshot;
}

function harness(options: {
  readSessionExecution?: TaskWatchDeps['readSessionExecution'];
  metas?: LocalSessionMeta[];
  snapshots?: SessionActivitySnapshot[];
  devices?: RemoteDeviceTarget[] | null;
  invokeRemote?: TaskWatchDeps['invokeRemote'];
  creators?: Record<string, string>;
  now?: number;
  schedulerOff?: boolean;
} = {}) {
  let now = options.now ?? 10_000;
  const toolsInFlight = new Set<string>();
  const metas = new Map((options.metas ?? []).map((m) => [m.id, m]));
  const pending = new Map<string, unknown[]>();
  const onChange = vi.fn();
  let metaReadFailures = 0;
  let interruptedReadFailures = 0;
  let ownershipReadFailures = 0;
  const creators = new Map(Object.entries(options.creators ?? {}));
  const invokeRemote = vi.fn(options.invokeRemote ?? (async () => { throw new Error('offline'); }));
  const readLocalSessions = vi.fn(async (ids: readonly string[]) => {
    if (metaReadFailures > 0) {
      metaReadFailures -= 1;
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    }
    return ids.flatMap((id) => (metas.has(id) ? [metas.get(id)!] : []));
  });
  const readInterruptedSessions = vi.fn(async (_since: number, _limit: number, ids?: readonly string[]) => {
    if (interruptedReadFailures > 0) {
      interruptedReadFailures -= 1;
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    }
    return [...metas.values()].filter((m) => m.interrupted && (ids === undefined || ids.includes(m.id)));
  });
  let schedulerOff = options.schedulerOff ?? false;
  const listRemoteDevices = vi.fn(async () => options.devices ?? null);
  const watch = new TaskWatch({
    now: () => now,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    getActivitySnapshots: () => options.snapshots ?? [],
    readSessionExecution: options.readSessionExecution,
    isToolCallInFlight: (id) => toolsInFlight.has(id),
    getPendingInteractions: (id) => pending.get(id) ?? [],
    readLocalSessions,
    readInterruptedSessions,
    readOwnership: async () => {
      if (ownershipReadFailures > 0) {
        ownershipReadFailures -= 1;
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      }
      return {
      bots: new Map([['sched', { status: 'active', allowSchedulerFollow: false }], ['a', { status: 'active', allowSchedulerFollow: false }]]),
      creatorBySession: new Map(creators),
      responsibleByBot: new Map(),
      };
    },
    readSchedulerOverride: () => ({ customized: true, schedulerBotId: schedulerOff ? null : 'sched' }),
    listRemoteDevices,
    invokeRemote,
    onChange,
  });
  return {
    watch, metas, pending, onChange, invokeRemote, toolsInFlight, readLocalSessions, readInterruptedSessions, listRemoteDevices,
    setSchedulerOff(value: boolean) { schedulerOff = value; },
    advance: (ms: number) => { now += ms; },
    failMetaReads: (count: number) => { metaReadFailures = count; },
    failInterruptedReads: (count: number) => { interruptedReadFailures = count; },
    failOwnershipReads: (count: number) => { ownershipReadFailures = count; },
    creators,
    now: () => now,
  };
}

describe('TaskWatch local observation', () => {
  it('tracks user and teammate tasks, skips teammate lanes, and ignores a completion seen only at startup', async () => {
    const h = harness({
      metas: [
        meta('user'), meta('delegated'), meta('lane', { laneRole: 'history', laneBotId: 'a', source: 'bot' }),
        meta('sched-main', { laneRole: 'canonical', laneBotId: 'sched', source: 'bot' }),
        meta('hidden', { hiddenAt: 1 }), meta('worker', { orcaRole: 'worker' }), meta('stale-done'),
        meta('crashed', { interrupted: true, activeTurnStartedAt: 5_000 }), meta('stopped'),
      ],
      snapshots: [activity('stale-done', 'completed')],
      creators: { delegated: 'a' },
    });
    await h.watch.start();
    // 启动兜底：上次没收尾的任务按出错进表；启动时已完成的任务不补「做完」。
    expect(h.watch.list().map((r) => [r.sessionId, r.phase, r.phaseSince, r.followerBotId])).toEqual([
      ['crashed', 'errored', 5_000, 'sched'],
    ]);

    for (const id of ['user', 'delegated', 'lane', 'hidden', 'worker', 'stopped', 'sched-main']) h.watch.applyActivity(id, activity(id, 'running'));
    await h.watch.settled();
    // 历史专线不进表；总调度自己的主任务（按 canonical 链接认出）进表但没有跟进者——不叫醒它自己。
    expect(h.watch.list().map((r) => [r.sessionId, r.source, r.followerBotId]).sort()).toEqual([
      ['crashed', 'user', 'sched'],
      ['delegated', 'bot-task', 'a'],
      ['sched-main', 'other', null],
      ['stopped', 'user', 'sched'],
      ['user', 'user', 'sched'],
    ]);
    expect(h.watch.get('sched-main')?.canonicalOfBotId).toBe('sched');

    // 长工具调用在途：灵动岛知道 tool_use 还没回；每次扫描刷新这个布尔事实。
    h.toolsInFlight.add('stopped');
    await h.watch.sweep();
    expect(h.watch.get('stopped')?.toolInFlight).toBe(true);
    expect(h.watch.get('user')?.toolInFlight).toBe(false);

    // 主人点了停止：灵动岛直接撤掉条目、没有完成态 → 静默离表，不算做完。
    h.watch.applyActivity('stopped', null);
    await h.watch.settled();
    expect(h.watch.get('stopped')).toBeUndefined();
    expect(h.watch.finished()).toEqual([]);

    // 等权限：带一句话摘要与请求 id，不带工具入参。
    h.pending.set('user', [{ kind: 'permission', requestId: 'req-9', toolName: 'Bash', input: { command: 'secret' } }]);
    h.watch.applyActivity('user', activity('user', 'needs-interaction', { interactionKind: 'permission' }));
    // 用量上限：协调器投影优先于活动相位。
    h.watch.applyInputProjection({ sessionId: 'delegated', error: 'limit', usageLimitWait: { resumeAt: 1 } });
    await h.watch.settled();
    expect(h.watch.get('user')).toMatchObject({ phase: 'waiting-permission', pendingQuestion: 'Bash', pendingRequestId: 'req-9' });
    expect(JSON.stringify(h.watch.get('user'))).not.toContain('secret');
    expect(h.watch.get('delegated')?.phase).toBe('usage-limit');

    // 观察到完成才算做完：完成态之后条目被已读清掉，行仍留到保留期满，只计一次。
    h.watch.applyActivity('user', activity('user', 'completed', { lastActivityAtMs: 9_000 }));
    await h.watch.settled();
    h.watch.applyActivity('user', null);
    await h.watch.settled();
    expect(h.watch.get('user')).toMatchObject({ phase: 'finished', phaseSince: 9_000 });
    expect(h.watch.finished().map((f) => f.sessionId)).toEqual(['user']);
  });

  // 依据:伙伴跟进要分清工具循环(换模型没用)与供应商失败;只有横幅文案时分不清,会把循环的任务也换模型。
  // 最小失败输入:带 errorReason 的出错投影;旧被控端只给 toolLoop 详情、不给 errorReason。
  it('keeps the stable reason behind an error so follow-up can tell a tool loop apart', async () => {
    const h = harness({ metas: [meta('looped'), meta('legacy-loop'), meta('plain')] });
    await h.watch.start();
    h.watch.applyInputProjection({ sessionId: 'looped', error: '重复工具调用', errorReason: 'tool_use_loop_detected' });
    h.watch.applyInputProjection({ sessionId: 'legacy-loop', error: '重复工具调用', toolLoop: { toolName: 'Bash', count: 5 } });
    h.watch.applyInputProjection({ sessionId: 'plain', error: 'server error' });
    await h.watch.settled();
    expect(h.watch.get('looped')).toMatchObject({ phase: 'errored', errorReason: 'tool_use_loop_detected' });
    expect(h.watch.get('legacy-loop')).toMatchObject({ phase: 'errored', errorReason: 'tool_use_loop_detected' });
    expect(h.watch.get('plain')).toMatchObject({ phase: 'errored', errorReason: null });
  });

  it('gives the same pending interaction the same event id after a restart', async () => {
    const waitingSnapshot = activity('t', 'needs-interaction', { interactionKind: 'ask_user_question', lastActivityAtMs: 7_000 });
    const ids: string[] = [];
    // 第二个实例模拟重启后：时间已过去很久，灵动岛里还是同一条挂起交互。
    for (const now of [10_000, 10_000 + 3 * AUTONOMY_THRESHOLDS.waitingAfterMs]) {
      const h = harness({ metas: [meta('t')], snapshots: [waitingSnapshot], now });
      await h.watch.start();
      h.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      ids.push(...new AutonomyEventLedger().evaluate(h.watch.list(), h.now()).due.map((c) => c.id));
    }
    expect(ids).toEqual(['waiting:t:7000', 'waiting:t:7000']);
  });

  it('restarts the wait clock when a local task moves from one permission request to another', async () => {
    const h = harness({ metas: [meta('t')] });
    await h.watch.start();
    const waiting = activity('t', 'needs-interaction', { interactionKind: 'permission', lastActivityAtMs: 7_000 });
    h.pending.set('t', [{ kind: 'permission', requestId: 'req-A', toolName: 'Bash' }]);
    h.watch.applyActivity('t', waiting);
    await h.watch.settled();
    expect(h.watch.get('t')).toMatchObject({ phase: 'waiting-permission', pendingRequestId: 'req-A', phaseSince: 7_000 });

    // A 被处理后紧接着出现 B，中间的「在跑」没有被单独观察到：相位不变，请求换了。
    h.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
    h.pending.set('t', [{ kind: 'permission', requestId: 'req-B', toolName: 'Write' }]);
    h.watch.applyActivity('t', waiting);
    await h.watch.settled();
    expect(h.watch.get('t')).toMatchObject({
      phase: 'waiting-permission', pendingRequestId: 'req-B', pendingQuestion: 'Write', phaseSince: h.now(),
    });
  });

  // 依据:共享给访客的任务里有账号外的人发的话,不能借事件叫醒以主人权限运行的伙伴。最小失败输入:来源 shared。
  it('shows a task shared with guests but gives it no follower', async () => {
    const h = harness({ metas: [meta('guest', { source: 'shared' })] });
    await h.watch.start();
    h.watch.applyActivity('guest', activity('guest', 'running'));
    await h.watch.settled();
    expect(h.watch.get('guest')).toMatchObject({ phase: 'running', shared: true, followerBotId: null });
  });

  it('restarts the wait clock when a local task moves from one question to another', async () => {
    const h = harness({ metas: [meta('q')] });
    await h.watch.start();
    const waiting = activity('q', 'needs-interaction', { interactionKind: 'ask_user_question', lastActivityAtMs: 7_000 });
    h.pending.set('q', [{ kind: 'ask_user_question', requestId: 'ask-A', questions: [{ question: '用哪个分支？' }] }]);
    h.watch.applyActivity('q', waiting);
    await h.watch.settled();
    expect(h.watch.get('q')).toMatchObject({ phase: 'waiting-answer', phaseSince: 7_000, pendingRequestId: null });

    h.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
    h.pending.set('q', [{ kind: 'ask_user_question', requestId: 'ask-B', questions: [{ question: '要不要推送？' }] }]);
    h.watch.applyActivity('q', waiting);
    await h.watch.settled();
    expect(h.watch.get('q')).toMatchObject({ phase: 'waiting-answer', pendingQuestion: '要不要推送？', phaseSince: h.now() });
  });

  it('keeps tasks whose metadata read failed and retries them on the next sweep', async () => {
    const h = harness({ metas: [meta('quiet')] });
    await h.watch.start();
    h.failMetaReads(1);
    // 这是这件任务最后一条活动：之后一直安静（卡住），不会再有活动把它带回来。
    h.watch.applyActivity('quiet', activity('quiet', 'running'));
    await h.watch.settled();
    expect(h.watch.get('quiet')).toBeUndefined();

    await h.watch.sweep();
    await h.watch.settled();
    expect(h.watch.get('quiet')).toMatchObject({ phase: 'running', followerBotId: 'sched' });
  });
});

describe('TaskWatch ownership and startup retries', () => {
  it('retries the startup read of interrupted tasks on a later sweep', async () => {
    const h = harness({ metas: [meta('crashed', { interrupted: true, activeTurnStartedAt: 5_000 })] });
    h.failInterruptedReads(1);
    await h.watch.start();
    expect(h.watch.get('crashed')).toBeUndefined();
    await h.watch.sweep();
    expect(h.watch.get('crashed')).toMatchObject({ phase: 'errored', phaseSince: 5_000, followerBotId: 'sched' });
  });

  it('does not add interrupted tasks with an empty ownership table; it waits until ownership loads', async () => {
    const h = harness({
      metas: [meta('crashed', { interrupted: true, activeTurnStartedAt: 5_000 }), meta('active')],
      snapshots: [activity('active', 'running')],
      creators: { crashed: 'a', active: 'a' }, schedulerOff: true,
    });
    h.failOwnershipReads(1);
    await h.watch.start();
    expect(h.watch.get('crashed')).toBeUndefined();
    // 工作台在这之前报「还没就绪」，不能把空表当成「没事要管」交给伙伴。
    expect(h.watch.isReady()).toBe(false);
    h.advance(10 * 60_000);
    await h.watch.sweep();
    await h.watch.settled();
    expect(h.watch.isReady()).toBe(true);
    expect(h.watch.get('crashed')).toMatchObject({ phase: 'errored', creatorBotId: 'a', followerBotId: 'a' });
    expect(h.watch.get('active')).toMatchObject({ phase: 'running', creatorBotId: 'a', followerBotId: 'a' });
  });

  it('re-reads ownership before judging a newly seen task unowned, even right after the last read', async () => {
    const h = harness({ metas: [meta('fresh')] });
    await h.watch.start();
    // 伙伴 a 刚开出这件任务：委派记录在上次归属读取之后一秒才写入。
    h.advance(1_000);
    h.creators.set('fresh', 'a');
    h.watch.applyActivity('fresh', activity('fresh', 'running'));
    await h.watch.settled();
    expect(h.watch.get('fresh')).toMatchObject({ creatorBotId: 'a', followerBotId: 'a', source: 'bot-task' });
  });
});

describe('TaskWatch remote polling', () => {
  // 依据：协议兼容（docs/dev-rules/protocol-compatibility.md）——旧版被控端不认 snapshotVersion，仍回数组。
  // 缺口：数组被当成「没有任务」，那台电脑的行被全部清掉还显示在线。最小失败输入：list-active 回数组。tier：unit。
  it('reads the legacy array an older computer returns, and treats an unknown shape as a failed read', async () => {
    let shape: 'array' | 'garbage' = 'array';
    const h = harness({
      devices: [{ deviceId: 'dev-1', name: 'Studio', online: true, eligible: true }],
      invokeRemote: async (_deviceId, channel) => {
        if (channel === 'maker:list-active') {
          return shape === 'array' ? [{ sessionId: 'r1', isTurnRunning: true, activityPhase: 'running' }] : { format: 'unknown' };
        }
        if (channel === 'local-db:sessions:get-many') return [{ id: 'r1', title: 'Old host build', source: 'desktop', status: 'active', hiddenAt: null }];
        return [];
      },
    });
    await h.watch.start();
    await h.watch.refreshRemote();
    expect(h.watch.get('dev-1::r1')).toMatchObject({ phase: 'running', title: 'Old host build', online: true });

    shape = 'garbage';
    h.advance(AUTONOMY_THRESHOLDS.remotePollMs);
    await h.watch.refreshRemote();
    expect(h.watch.get('dev-1::r1')).toMatchObject({ online: false });
    expect(h.watch.offlineDevices()).toEqual(['Studio']);
  });

  it('reads eligible online computers, then backs off and marks rows offline when polling fails', async () => {
    let fail = false;
    const h = harness({
      devices: [
        { deviceId: 'dev-1', name: 'Studio', online: true, eligible: true },
        { deviceId: 'dev-2', name: 'Locked', online: true, eligible: false },
      ],
      invokeRemote: async (_deviceId, channel) => {
        if (fail) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        if (channel === 'maker:list-active') {
          return { format: 'active-sessions-v2', sessions: [
            { sessionId: 'r1', isTurnRunning: true, activityPhase: 'running' },
            { sessionId: 'r2', isTurnRunning: true, activityPhase: 'running' },
          ] };
        }
        if (channel === 'local-db:sessions:get-many') {
          return [
            { id: 'r1', title: 'Remote build', source: 'desktop', status: 'active', hiddenAt: null, updatedAt: 9_000, messageCount: 3 },
            // 那台电脑伙伴自己的任务由那台电脑的伙伴跟，不跨电脑重复跟。
            { id: 'r2', title: 'Teammate lane', source: 'bot', status: 'active', hiddenAt: null },
          ];
        }
        return [];
      },
    });
    await h.watch.start();
    await h.watch.refreshRemote();
    expect(h.watch.list().map((r) => [r.sessionId, r.deviceName, r.phase, r.followerBotId, r.online])).toEqual([
      // 另一台电脑上的任务只进工作台：跟进者恒为 null，由那台电脑上的伙伴跟，避免同名伙伴各跟一遍。
      ['dev-1::r1', 'Studio', 'running', null, true],
    ]);
    expect(h.invokeRemote.mock.calls.every(([deviceId]) => deviceId === 'dev-1')).toBe(true);

    fail = true;
    h.advance(AUTONOMY_THRESHOLDS.remotePollMs);
    await h.watch.refreshRemote();
    expect(h.watch.get('dev-1::r1')?.online).toBe(false);
    expect(h.watch.offlineDevices()).toEqual(['Studio']);

    // 退避期内不再请求那台电脑；退避有上限。
    const calls = h.invokeRemote.mock.calls.length;
    h.advance(AUTONOMY_THRESHOLDS.remotePollMs);
    await h.watch.refreshRemote();
    expect(h.invokeRemote.mock.calls.length).toBe(calls);
    h.advance(REMOTE_BACKOFF_MAX_MS);
    await h.watch.refreshRemote();
    expect(h.invokeRemote.mock.calls.length).toBe(calls + 1);
  });

  it('re-reads the pending request on every poll while a remote task keeps waiting', async () => {
    const requests = [
      { kind: 'permission', requestId: 'req-A', toolName: 'Bash' },
      { kind: 'permission', requestId: 'req-B', toolName: 'Write' },
    ];
    let poll = 0;
    const h = harness({
      devices: [{ deviceId: 'dev-1', name: 'Studio', online: true, eligible: true }],
      invokeRemote: async (_deviceId, channel) => {
        if (channel === 'maker:list-active') {
          poll += 1;
          return { format: 'active-sessions-v2', sessions: [{ sessionId: 'r1', isTurnRunning: true, activityPhase: 'needs-interaction' }] };
        }
        if (channel === 'local-db:sessions:get-many') {
          return [{ id: 'r1', title: 'Remote deploy', source: 'desktop', status: 'active', hiddenAt: null, updatedAt: 9_000, messageCount: 3 }];
        }
        // 两次轮询之间远程任务从权限请求 A 直接换到 B，中间的「在跑」没被观察到。
        return [{ request: requests[poll - 1] }];
      },
    });
    await h.watch.start();
    await h.watch.refreshRemote();
    const first = h.watch.get('dev-1::r1');
    expect(first).toMatchObject({ phase: 'waiting-permission', pendingRequestId: 'req-A', pendingQuestion: 'Bash' });

    h.advance(AUTONOMY_THRESHOLDS.remotePollMs);
    await h.watch.refreshRemote();
    // 新请求是新的等待：「允许」对准 B，等待时刻从这次观察算起。
    expect(h.watch.get('dev-1::r1')).toMatchObject({
      phase: 'waiting-permission', pendingRequestId: 'req-B', pendingQuestion: 'Write', phaseSince: h.now(),
    });
    expect(h.invokeRemote.mock.calls.filter(([, channel]) => channel === 'maker:get-pending-interactions')).toHaveLength(2);
  });
});


// Unit: §6.3 demand-driven observation. Previous coverage checked model dispatch,
// but not reads made with follow-up off. Minimal input: one unrelated active task.
it('does no task reads or remote polling when off, and wakes only for a new explicit delegation', async () => {
  const h = harness({ schedulerOff: true, metas: [meta('mine'), meta('child')],
    snapshots: [activity('mine', 'running')] });
  await h.watch.start();
  h.watch.applyActivity('mine', activity('mine', 'needs-interaction'));
  await h.watch.settled();
  h.advance(120_000);
  await h.watch.sweep();
  expect(h.watch.needsSweep()).toBe(false);
  expect(h.watch.list()).toEqual([]);
  expect(h.readLocalSessions).not.toHaveBeenCalled();
  expect(h.readInterruptedSessions).not.toHaveBeenCalled();
  expect(h.listRemoteDevices).not.toHaveBeenCalled();

  h.creators.set('child', 'a');
  h.watch.applyActivity('child', activity('child', 'running'));
  // Durable delegation change uses the same refresh as the production signal.
  await h.watch.refreshFollowers();
  expect(h.watch.list().map(row => row.sessionId)).toEqual(['child']);
  expect(h.watch.needsSweep()).toBe(true);
  expect(h.readLocalSessions.mock.calls.flatMap(([ids]) => ids)).toEqual(['child']);
  expect(h.readInterruptedSessions.mock.calls[0]?.[2]).toEqual(['child']);
  h.watch.applyActivity('child', activity('child', 'completed'));
  await h.watch.settled();
  expect(h.watch.needsSweep()).toBe(false);
  expect(h.watch.finished().map(row => row.sessionId)).toEqual(['child']);
});

it('stops global observation on opt-out and rehydrates current activity on opt-in without polling peers', async () => {
  const h = harness({ schedulerOff: true, metas: [meta('mine')], snapshots: [activity('mine', 'running')] });
  await h.watch.start();
  h.setSchedulerOff(false);
  await h.watch.refreshFollowers();
  expect(h.watch.get('mine')?.followerBotId).toBe('sched');
  h.setSchedulerOff(true);
  await h.watch.refreshFollowers();
  expect(h.watch.get('mine')).toBeUndefined();
  expect(h.watch.needsSweep()).toBe(false);
  h.readLocalSessions.mockClear();
  h.advance(120_000);
  await h.watch.sweep();
  expect(h.readLocalSessions).not.toHaveBeenCalled();
  expect(h.listRemoteDevices).not.toHaveBeenCalled();
});

// Unit #6675: after returning cached glance, the visible view needs a change signal
// carrying updated rows. Previously only the awaited read saw the remote result.
it('keeps remote IO out of scheduled sweeps and notifies coalesced view reads of new rows', async () => {
  const h = harness({ devices: [{ deviceId: 'dev-1', name: 'Studio', online: true, eligible: true }],
    invokeRemote: async (_device, channel) => channel === 'maker:list-active'
      ? [{ sessionId: 'r1', isTurnRunning: true, activityPhase: 'running' }]
      : [{ id: 'r1', title: 'Remote task', source: 'desktop', status: 'active' }] });
  await h.watch.start();
  await h.watch.sweep();
  expect(h.listRemoteDevices).not.toHaveBeenCalled();
  h.onChange.mockClear();
  const displayed: string[][] = [];
  h.onChange.mockImplementation(() => { displayed.push(h.watch.list().map(row => row.title)); });
  await Promise.all([h.watch.refreshRemote(), h.watch.refreshRemote()]);
  expect(h.invokeRemote).toHaveBeenCalledTimes(2);
  expect(displayed).toEqual([['Remote task']]);
  // The notification's reread stays inside the existing remote throttle.
  await h.watch.refreshRemote();
  expect(h.invokeRemote).toHaveBeenCalledTimes(2);
  h.advance(120_000);
  await h.watch.sweep();
  expect(h.invokeRemote).toHaveBeenCalledTimes(2);
});

// #6737 review / unit: metadata IO can outlive the terminal boundary. The event
// saved to the routine queue must retain the original native execution.
it('captures completion execution before asynchronous reads or a later turn', async () => {
  let execution = { instanceId: 'native-1', generation: 1 };
  const h = harness({ metas: [meta('child')], creators: { child: 'a' }, readSessionExecution: () => execution });
  await h.watch.start();
  h.watch.applyActivity('child', activity('child', 'running', { turnGeneration: null }));
  await h.watch.settled();
  expect(h.watch.reportDelivery('child', execution, true)).toBe(true);
  h.watch.applyActivity('child', activity('child', 'completed', { turnGeneration: null }));
  execution = { instanceId: 'native-2', generation: 2 };
  await h.watch.settled();
  const [candidate] = new AutonomyEventLedger().evaluate(h.watch.list(), h.now()).due;
  expect(candidate).toBeDefined();
  const saved = JSON.parse(JSON.stringify(toRoutineEvent(candidate, h.now())));
  expect(saved.data).toMatchObject({ executionInstanceId: 'native-1', executionGeneration: 1 });
  h.watch.applyActivity('child', activity('child', 'running', { turnGeneration: 2 }));
  await h.watch.settled();
  expect(h.watch.get('child')?.execution).toEqual(execution);
  expect(saved.data).toMatchObject({ executionInstanceId: 'native-1', executionGeneration: 1 });
  h.watch.stop();
});

// Unit / #7253: a model report must not survive a different native execution,
// nor turn stopped/error activity into delivery. Existing identity coverage only
// freezes event attribution. Minimal input: true in generation 1, completion in 2.
it('binds delivery reports to the live execution and permits correcting a report before completion', async () => {
  let execution = { instanceId: 'native', generation: 1 };
  const h = harness({ metas: [meta('child')], creators: { child: 'a' }, readSessionExecution: () => execution });
  await h.watch.start();
  try {
    h.watch.applyActivity('child', activity('child', 'running', { turnGeneration: 1 }));
    expect(h.watch.reportDelivery('child', execution, true)).toBe(true);
    expect(h.watch.reportDelivery('child', execution, false)).toBe(true);
    await h.watch.settled();
    expect(h.watch.get('child')?.finalDelivery).toBe(false);
    expect(h.watch.reportDelivery('child', execution, true)).toBe(true);
    execution = { instanceId: 'native', generation: 2 };
    expect(h.watch.reportDelivery('child', { ...execution, generation: 1 }, true)).toBe(false);
    h.watch.applyActivity('child', activity('child', 'running', { turnGeneration: 2 }));
    h.watch.applyActivity('child', activity('child', 'completed', { turnGeneration: 2 }));
    await h.watch.settled();
    expect(new AutonomyEventLedger().evaluate(h.watch.list(), h.now()).due).toEqual([]);
    expect(h.watch.reportDelivery('child', execution, true)).toBe(false);
    h.watch.applyActivity('child', activity('child', 'running', { turnGeneration: 3 }));
    execution = { instanceId: 'native', generation: 3 };
    expect(h.watch.reportDelivery('child', execution, true)).toBe(true);
    h.watch.applyActivity('child', null);
    await h.watch.settled();
    expect(new AutonomyEventLedger().evaluate(h.watch.list(), h.now()).due).toEqual([]);
  } finally { h.watch.stop(); }
});
