import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Scheduler,
  DEFAULT_MAX_CONCURRENT_RUNS,
  RUN_HEARTBEAT_INTERVAL_MS,
  RUN_HEARTBEAT_STALE_MS,
  RUN_LEGACY_STALE_MS,
} from '../engine/scheduler.js';
import type {
  Schedule,
  ScheduleRun,
  CreateScheduleInput,
  ListFilter,
} from '../types.js';
import type { ScheduleStorage } from '../interfaces/schedule-storage.js';
import type { FireContext, FireResult, ScheduleRunner } from '../interfaces/schedule-runner.js';
import type { Logger } from '../interfaces/logger.js';

class InMemoryStorage implements ScheduleStorage {
  schedules = new Map<string, Schedule>();
  runs = new Map<string, ScheduleRun>();

  async list(filter?: ListFilter): Promise<Schedule[]> {
    const all = [...this.schedules.values()];
    return filter?.status ? all.filter((s) => s.status === filter.status) : all;
  }
  async listActive(): Promise<Schedule[]> {
    return [...this.schedules.values()].filter((s) => s.status === 'active');
  }
  async get(id: string): Promise<Schedule | null> {
    const s = this.schedules.get(id);
    return s ? { ...s } : null;
  }
  async insert(schedule: Schedule): Promise<Schedule> {
    this.schedules.set(schedule.id, { ...schedule });
    return { ...schedule };
  }
  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | null> {
    const ex = this.schedules.get(id);
    if (!ex) return null;
    const merged: Schedule = { ...ex, ...patch };
    this.schedules.set(id, merged);
    return { ...merged };
  }
  async delete(id: string): Promise<void> {
    this.schedules.delete(id);
  }
  async insertRun(run: ScheduleRun): Promise<ScheduleRun> {
    this.runs.set(run.id, { ...run });
    return { ...run };
  }
  async updateRun(id: string, patch: Partial<ScheduleRun>): Promise<ScheduleRun | null> {
    const ex = this.runs.get(id);
    if (!ex) return null;
    const merged: ScheduleRun = { ...ex, ...patch };
    this.runs.set(id, merged);
    return { ...merged };
  }
  // 与真实现同语义:按 firedAt 降序 + 条数上限(引擎侧不变量绝不能依赖这个
  // 有上限的历史查询,回归测试靠这里的保真复现漏判)。
  async listRuns(scheduleId: string, limit = 50): Promise<ScheduleRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.scheduleId === scheduleId)
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(0, limit);
  }
  async hasRunningRuns(scheduleId?: string): Promise<boolean> {
    return [...this.runs.values()].some(
      (r) => r.status === 'running' && (scheduleId === undefined || r.scheduleId === scheduleId),
    );
  }
  async deleteRun(id: string): Promise<ScheduleRun | null> {
    const ex = this.runs.get(id);
    if (!ex) return null;
    this.runs.delete(id);
    return { ...ex };
  }
  // 与 DrizzleScheduleStorage 相同语义:带心跳的行按 staleBefore、NULL 心跳行按
  // legacyStaleBefore(未传回落 staleBefore)判过期,excludeRunIds 无条件跳过,
  // 返回受影响 scheduleId(去重)。
  async markRunningAsInterrupted(
    staleBefore: number,
    excludeRunIds: readonly string[] = [],
    opts?: { legacyStaleBefore?: number },
  ): Promise<string[]> {
    const exclude = new Set(excludeRunIds);
    const legacyStaleBefore = opts?.legacyStaleBefore ?? staleBefore;
    const affected: string[] = [];
    for (const r of this.runs.values()) {
      if (r.status !== 'running') continue;
      if (exclude.has(r.id)) continue;
      if (r.heartbeatAt !== undefined && r.heartbeatAt >= staleBefore) continue;
      if (r.heartbeatAt === undefined && r.firedAt >= legacyStaleBefore) continue;
      r.status = 'interrupted';
      r.finishedAt = Date.now();
      r.errorMsg = 'app restarted';
      affected.push(r.scheduleId);
    }
    return [...new Set(affected)];
  }
  async touchRunHeartbeats(runIds: readonly string[], heartbeatAt: number): Promise<void> {
    for (const id of runIds) {
      const r = this.runs.get(id);
      if (r && r.status === 'running') r.heartbeatAt = heartbeatAt;
    }
  }
  // 与 DrizzleScheduleStorage.claimDueFire 相同的 CAS 语义:active 且 nextFireAt
  // 精确匹配才认领成功(置空 nextFireAt),否则返回 null 不动行。
  async claimDueFire(id: string, expectedNextFireAt: number): Promise<Schedule | null> {
    const ex = this.schedules.get(id);
    if (!ex || ex.status !== 'active' || ex.nextFireAt !== expectedNextFireAt) return null;
    ex.nextFireAt = undefined;
    return { ...ex };
  }
}

class FakeClock {
  current = Date.UTC(2026, 0, 1, 0, 0, 30); // start at 2026-01-01 00:00:30 UTC
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  setTo(ms: number): void {
    this.current = ms;
  }
}

const baseInput: CreateScheduleInput = {
  name: 'test',
  prompt: 'do thing',
  kind: 'cron',
  cronExpr: '* * * * *', // every minute
  timezone: 'UTC',
  recurring: true,
  agentKind: 'claude-code',
  useWorktree: false,
  notify: { desktop: false, feishu: false },
};

function makeIdGen(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

interface FireCall {
  schedule: Schedule;
  ctx: FireContext;
}

interface Harness {
  scheduler: Scheduler;
  storage: InMemoryStorage;
  clock: FakeClock;
  runner: ScheduleRunner & { fire: ReturnType<typeof vi.fn> };
  fireCalls: FireCall[];
}

function makeHarness(opts?: {
  runnerImpl?: (s: Schedule, ctx: FireContext) => Promise<FireResult>;
  isManagedWorkspaceDir?: (dir: string) => boolean;
  /** 传入共享 storage / clock 模拟"两个 app 实例共用同一 DB"的双开场景。 */
  storage?: InMemoryStorage;
  clock?: FakeClock;
  generateId?: () => string;
  passive?: boolean;
  maxConcurrentRuns?: number;
  logger?: Logger;
}): Harness {
  const storage = opts?.storage ?? new InMemoryStorage();
  const clock = opts?.clock ?? new FakeClock();
  const fireCalls: FireCall[] = [];
  const impl =
    opts?.runnerImpl ??
    (async (s: Schedule) => ({ sessionId: `sess-${s.id}` }));
  const runner = {
    fire: vi.fn(async (s: Schedule, ctx: FireContext) => {
      fireCalls.push({ schedule: s, ctx });
      return impl(s, ctx);
    }),
  };
  const scheduler = new Scheduler({
    storage,
    runner,
    clock,
    generateId: opts?.generateId ?? makeIdGen(),
    tickIntervalMs: 60_000_000, // effectively disabled; tests call tick() manually
    isManagedWorkspaceDir: opts?.isManagedWorkspaceDir,
    passive: opts?.passive,
    maxConcurrentRuns: opts?.maxConcurrentRuns,
    logger: opts?.logger,
    instanceId: 'test-scheduler',
    processId: 1234,
  });
  return { scheduler, storage, clock, runner, fireCalls };
}

describe('Scheduler', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('create() computes nextFireAt and adds to active map', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    // From 00:00:30, next minute boundary = 00:01:00
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));
    expect(sch.status).toBe('active');
    // baseInput 无 workingDir / worktree / targetSessionId → 推断为对话任务
    expect(sch.workspaceKind).toBe('dialogue');
    const list = await h.scheduler.list({ status: 'active' });
    expect(list).toHaveLength(1);
  });

  it('marks skipped child runs as zero-cost', async () => {
    const childHarness = makeHarness({
      runnerImpl: async (_schedule, ctx) => {
        await ctx.createChildRun?.({ status: 'skipped' });
        return { sessionId: '' };
      },
    });
    const sch = await childHarness.scheduler.create({ ...baseInput });

    await childHarness.scheduler.runNow(sch.id);

    const skippedRun = (await childHarness.scheduler.listRuns(sch.id)).find(
      (run) => run.status === 'skipped',
    );
    expect(skippedRun?.costAttribution).toBe('zero');
  });

  it('create() preserves dialogue workspace target', async () => {
    const sch = await h.scheduler.create({ ...baseInput, workspaceKind: 'dialogue' });
    expect(sch.workspaceKind).toBe('dialogue');
  });

  it('create() 未传 workspaceKind 时按目标推断 dialogue/project', async () => {
    // 给了 workingDir → project
    const withDir = await h.scheduler.create({ ...baseInput, workingDir: '/repo' });
    expect(withDir.workspaceKind).toBe('project');
    // 开 worktree(目录由 runner 解析)→ project
    const withWorktree = await h.scheduler.create({ ...baseInput, useWorktree: true });
    expect(withWorktree.workspaceKind).toBe('project');
    // heartbeat(绑已有会话)→ project,不归对话组
    const heartbeat = await h.scheduler.create({ ...baseInput, targetSessionId: 's-1' });
    expect(heartbeat.workspaceKind).toBe('project');
    // 显式 workspaceKind 不被推断覆盖
    const explicit = await h.scheduler.create({ ...baseInput, workspaceKind: 'project' });
    expect(explicit.workspaceKind).toBe('project');
    // 空白串 workingDir 等同未传 → dialogue
    const blankDir = await h.scheduler.create({ ...baseInput, workingDir: '  ' });
    expect(blankDir.workspaceKind).toBe('dialogue');
  });

  it('create()/update() 把 app 管理工作区目录归一成对话任务(host 注入谓词)', async () => {
    const h2 = makeHarness({
      isManagedWorkspaceDir: (dir) => dir.startsWith('/managed/'),
    });
    // agent 把对话自己的 cwd 当 workingDir 传入 → 归一:清目录 + dialogue
    const sch = await h2.scheduler.create({
      ...baseInput,
      workingDir: '/managed/2026-06-12/sess-1',
    });
    expect(sch.workspaceKind).toBe('dialogue');
    expect(sch.workingDir).toBeUndefined();
    // 真实项目目录不受影响
    const proj = await h2.scheduler.create({ ...baseInput, workingDir: '/repo' });
    expect(proj.workspaceKind).toBe('project');
    expect(proj.workingDir).toBe('/repo');
    // update 改成管理目录同样归一
    const updated = await h2.scheduler.update(proj.id, {
      workingDir: '/managed/2026-06-12/sess-2',
    });
    expect(updated.workspaceKind).toBe('dialogue');
    expect(updated.workingDir).toBeUndefined();
    // 未注入谓词的实例不归一(默认 harness)
    const plain = await h.scheduler.create({
      ...baseInput,
      workingDir: '/managed/2026-06-12/sess-3',
    });
    expect(plain.workspaceKind).toBe('project');
  });

  it('update() 给了真实 workingDir 时翻成 project(与 create 推断对称)', async () => {
    // 对话任务后来被显式改了项目目录 → 不能仍留 dialogue,否则 fire 时
    // 新目录会被管理工作区分配覆盖,显式设置被静默丢弃
    const sch = await h.scheduler.create({ ...baseInput }); // 推断 dialogue
    const updated = await h.scheduler.update(sch.id, { workingDir: '/real/project' });
    expect(updated.workspaceKind).toBe('project');
    expect(updated.workingDir).toBe('/real/project');
    // patch 显式指明 workspaceKind 时不被推断覆盖
    const sch2 = await h.scheduler.create({ ...baseInput });
    const updated2 = await h.scheduler.update(sch2.id, {
      workingDir: '/x',
      workspaceKind: 'dialogue',
    });
    expect(updated2.workspaceKind).toBe('dialogue');
  });

  it('validates script-only schedule shape before insert/update', async () => {
    await expect(
      h.scheduler.create({
        ...baseInput,
        executionMode: 'script',
        scriptConfig: { command: '  ', capabilities: [] },
        workspaceKind: 'project',
        workingDir: '/repo',
        prompt: '',
      }),
    ).rejects.toThrow('non-empty command');

    const script = await h.scheduler.create({
      ...baseInput,
      executionMode: 'script',
      scriptConfig: {
        command: '  python auto.py  ',
        timeoutMs: 1234.8,
        capabilities: ['jira.read', 'jira.read', 'sessions.dispatch'],
      },
      workspaceKind: 'project',
      workingDir: '/repo',
      prompt: '',
    });
    expect(script.scriptConfig).toEqual({
      command: 'python auto.py',
      timeoutMs: 1234,
      capabilities: ['jira.read', 'sessions.dispatch'],
    });

    await expect(h.scheduler.update(script.id, { useWorktree: true })).rejects.toThrow(
      'does not support worktrees or bound sessions',
    );
    await expect(h.scheduler.update(script.id, { silentWhenIdle: true })).rejects.toThrow(
      'does not support silentWhenIdle',
    );

    // 堵 update 逃逸:script 任务(prompt 合法为空)只切 executionMode='agent'
    // 不带 prompt → 会落库空提示词的 agent 任务,必须拒;带 prompt 一起切才放行。
    await expect(
      h.scheduler.update(script.id, { executionMode: 'agent', scriptConfig: null }),
    ).rejects.toThrow('prompt is required for agent execution mode');
    const converted = await h.scheduler.update(script.id, {
      executionMode: 'agent',
      scriptConfig: null,
      prompt: '/standup',
    });
    expect(converted.executionMode).toBe('agent');
    expect(converted.scriptConfig).toBeUndefined();
    // 存量兼容:patch 不动 executionMode/prompt 时不触发该校验(改名等照常)
    const renamed = await h.scheduler.update(script.id, { name: 'renamed' });
    expect(renamed.name).toBe('renamed');

    // create 兜底:agent 模式空 prompt 直接拒(工具层/UI 已拦,引擎是最后防线)
    await expect(
      h.scheduler.create({ ...baseInput, prompt: '   ' }),
    ).rejects.toThrow('prompt is required for agent execution mode');
  });

  it('recurring fire updates lastFiredAt and recomputes nextFireAt', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('active');
    expect(after?.lastFiredAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 5));
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));
    // Run row recorded
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].sessionId).toBe(`sess-${sch.id}`);
  });

  it('one-shot schedule moves to expired after fire', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('expired');
    expect(after?.nextFireAt).toBeUndefined();
    // No re-fire even after another tick
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 5, 0));
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
  });

  it('paused schedule is not fired', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.pause(sch.id);
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('paused');
  });

  it('resume recomputes nextFireAt and re-arms', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.pause(sch.id);
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 5, 30));
    await h.scheduler.resume(sch.id);
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('active');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
    await h.scheduler.tick(); // not yet due
    expect(h.runner.fire).not.toHaveBeenCalled();
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 6, 5));
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
  });

  it('runner exception marks run failed but schedule stays active', async () => {
    const local = makeHarness({
      runnerImpl: async () => {
        throw new Error('boom');
      },
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMsg).toBe('boom');
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('active'); // not paused/expired on failure
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));
  });

  it("script 任务失败消息含 'abort' 字样不误判成 aborted:记 failed 且照常重排(codex review 966)", async () => {
    // script runner 第一方接了 signal(真 abort 时 signal 必已置位),而它的失败
    // 消息携带脚本自己的 stderr——任意文本(如 "operation aborted by remote
    // server")都可能撞上 agent 模式的 /abort/i 兜底。误判成 aborted 会走"不重排
    // nextFireAt"的分支,而 claimDueFire 已把 nextFireAt 清空,recurring 任务就此
    // 静默停摆到重启。
    const local = makeHarness({
      runnerImpl: async () => {
        throw new Error('script exited with code 1: fatal: operation aborted by remote server');
      },
    });
    const sch = await local.scheduler.create({
      ...baseInput,
      executionMode: 'script',
      scriptConfig: { command: 'python auto.py', capabilities: [] },
      workspaceKind: 'project',
      workingDir: '/repo',
      prompt: '',
    });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed'); // 不是 'aborted'
    expect(runs[0].errorMsg).toContain('operation aborted by remote server');
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('active');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0)); // 照常重排,不停摆
  });

  it("agent 任务错误文本 /abort/i 兜底保持原语义(runner 没接 signal 的存量路径)", async () => {
    const local = makeHarness({
      runnerImpl: async () => {
        throw new Error('session aborted');
      },
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs[0].status).toBe('aborted');
    // aborted 分支不重排(schedule 大概率已被 delete/pause;resume 会自己重算)
    const after = await local.storage.get(sch.id);
    expect(after?.nextFireAt).toBeUndefined();
  });

  it('deferred fire 撤销预插 run、不通知、nextFireAt 前移 deferRetryMs、不写 lastFiredAt', async () => {
    const RETRY = 90_000;
    const local = makeHarness({
      runnerImpl: async (s) => ({ sessionId: `sess-${s.id}`, deferred: true, deferRetryMs: RETRY }),
    });
    const events: string[] = [];
    let firedRunId: string | undefined;
    let deferredRunId: string | undefined;
    local.scheduler.on('fired', (e) => { firedRunId = e.runId; });
    local.scheduler.on('completed', () => events.push('completed'));
    local.scheduler.on('failed', () => events.push('failed'));
    local.scheduler.on('changed', () => events.push('changed'));
    local.scheduler.on('deferred', (e) => { events.push('deferred'); deferredRunId = e.runId; });
    const sch = await local.scheduler.create({ ...baseInput });
    const fireTime = Date.UTC(2026, 0, 1, 0, 1, 5);
    local.clock.setTo(fireTime);
    await local.scheduler.tick();

    expect(local.runner.fire).toHaveBeenCalledTimes(1);
    // 不留可见记录:预插的 running run 被 deleteRun
    expect(await local.scheduler.listRuns(sch.id)).toHaveLength(0);
    // 不通知(completed/failed 都不 emit),emit deferred(清 UI running 态)+ changed(revalidate)
    expect(events).not.toContain('completed');
    expect(events).not.toContain('failed');
    expect(events).toContain('deferred');
    expect(events).toContain('changed');
    // deferred 必须带与 fired 同一个 runId,renderer 才能精确清掉那条 ephemeral running
    expect(deferredRunId).toBe(firedRunId);
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('active');
    // nextFireAt 前移到 finishedAt + deferRetryMs(防忙循环),不是正常 cron 槽位
    expect(after?.nextFireAt).toBe(fireTime + RETRY);
    // 没真跑 → 不写 lastFiredAt
    expect(after?.lastFiredAt).toBeUndefined();
  });

  it('deferred runNow 同样撤销 run、不通知、nextFireAt 前移、还原 lastFiredAt', async () => {
    const RETRY = 90_000;
    const local = makeHarness({
      runnerImpl: async (s) => ({ sessionId: `sess-${s.id}`, deferred: true, deferRetryMs: RETRY }),
    });
    const events: string[] = [];
    let firedRunId: string | undefined;
    let deferredRunId: string | undefined;
    local.scheduler.on('fired', (e) => { firedRunId = e.runId; });
    local.scheduler.on('completed', () => events.push('completed'));
    local.scheduler.on('failed', () => events.push('failed'));
    local.scheduler.on('deferred', (e) => { events.push('deferred'); deferredRunId = e.runId; });
    const sch = await local.scheduler.create({ ...baseInput });
    const runAt = Date.UTC(2026, 0, 1, 0, 0, 45);
    local.clock.setTo(runAt);
    await local.scheduler.runNow(sch.id);

    expect(await local.scheduler.listRuns(sch.id)).toHaveLength(0);
    const after = await local.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(runAt + RETRY);
    // runNow 顺延同样:不通知,emit deferred(配对 fired 的 runId)清 UI running 态
    expect(events).not.toContain('completed');
    expect(events).not.toContain('failed');
    expect(events).toContain('deferred');
    expect(deferredRunId).toBe(firedRunId);
    // runNow 在 fire 前乐观写了 lastFiredAt=runAt;顺延必须还原回 fire 前的值
    // (这里 baseInput 没跑过 → undefined),否则顺延却显示成"已触发",且 Once 任务
    // 重启会因 lastFiredAt 已设而吞掉重试。
    expect(after?.lastFiredAt).toBeUndefined();
  });

  it('heartbeat schedule passes targetSessionId through to runner.fire', async () => {
    await h.scheduler.create({
      ...baseInput,
      targetSessionId: 'sess-existing',
    });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(h.fireCalls).toHaveLength(1);
    expect(h.fireCalls[0].schedule.targetSessionId).toBe('sess-existing');
  });

  it('emits fired/completed/changed events', async () => {
    const events: Array<{ type: string; scheduleId: string }> = [];
    h.scheduler.on('fired', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    h.scheduler.on('completed', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    h.scheduler.on('failed', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    h.scheduler.on('changed', (e) => events.push({ type: e.type, scheduleId: e.scheduleId }));
    const sch = await h.scheduler.create({ ...baseInput });
    expect(events.find((e) => e.type === 'changed' && e.scheduleId === sch.id)).toBeTruthy();
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect(events.some((e) => e.type === 'fired' && e.scheduleId === sch.id)).toBe(true);
    expect(events.some((e) => e.type === 'completed' && e.scheduleId === sch.id)).toBe(true);
    const completedIndex = events.findIndex((e) => e.type === 'completed' && e.scheduleId === sch.id);
    const changedAfterCompletedIndex = events.findIndex((e, i) =>
      i > completedIndex &&
      e.type === 'changed' &&
      e.scheduleId === sch.id,
    );
    expect(changedAfterCompletedIndex).toBeGreaterThan(completedIndex);
  });

  it('runNow updates lastFiredAt but keeps nextFireAt; emits changed', async () => {
    // 设计说明：lastFiredAt 语义包含手动 fire（UI "Last X ago" 应反映实际执行）；
    // nextFireAt 不动是因为手动触发不该改变 cron 排定的下一次时间。
    const sch = await h.scheduler.create({ ...baseInput });
    const beforeNext = sch.nextFireAt;
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 0, 45));
    const changed: string[] = [];
    h.scheduler.on('changed', (e) => changed.push(e.scheduleId));
    await h.scheduler.runNow(sch.id);
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(beforeNext);
    expect(after?.lastFiredAt).toBe(Date.UTC(2026, 0, 1, 0, 0, 45));
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(changed).toContain(sch.id);
  });

  it('fireOne marks success even when runner returns empty-string sessionId', async () => {
    const local = makeHarness({ runnerImpl: async () => ({ sessionId: '' }) });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await local.scheduler.tick();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].sessionId).toBe('');
  });

  it('delete removes schedule and emits changed', async () => {
    const sch = await h.scheduler.create({ ...baseInput });
    let sawDelete = false;
    h.scheduler.on('changed', (e) => {
      if (e.scheduleId === sch.id) sawDelete = true;
    });
    await h.scheduler.delete(sch.id);
    expect(await h.storage.get(sch.id)).toBeNull();
    expect(sawDelete).toBe(true);
  });

  it('start() loads active schedules and recomputes nextFireAt for stale ones', async () => {
    // 用 daily cron 避免触发 interval 自动迁移分支（那是另一个测试覆盖）
    h.storage.schedules.set('preseeded', {
      id: 'preseeded',
      name: 'old',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 9 * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
      nextFireAt: Date.UTC(2020, 0, 1, 0, 0, 0), // way in the past
    });
    await h.scheduler.start();
    const after = await h.storage.get('preseeded');
    // Recomputed forward to next 09:00 UTC
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    await h.scheduler.stop();
  });

  // ── intervalMs（"上次完成 + N" 语义）──
  // 这条线和 cron-槽位 完全分支：fireOne / start / resume / create 都要分别覆盖。

  it('intervalMs create() schedules first fire at createdAt + intervalMs', async () => {
    // clock = 00:00:30, intervalMs = 5min → first fire at 00:05:30
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 5 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 5, 30));
    expect(sch.intervalMs).toBe(5 * 60_000);
  });

  it('intervalMs recurring fire schedules nextFireAt at finishedAt + intervalMs', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 30 * 60_000 });
    // 触发到 next: 00:30:30, runner 立即 resolve（同一时刻 finishedAt = firedAt）
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 30, 30));
    await h.scheduler.tick();
    const after = await h.storage.get(sch.id);
    expect(after?.lastFinishedAt).toBe(Date.UTC(2026, 0, 1, 0, 30, 30));
    // 关键断言：next = finishedAt + 30min（不是壁钟槽位 01:00）
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 1, 0, 30));
  });

  it('start() does NOT backfill intervalMs onto interval-shaped cron schedules', async () => {
    // 回归：曾有"老数据迁移"在 start() 时给 `*/N` 形态的纯 cron 任务回填 intervalMs，
    // 误伤 MCP 新建的任务（被转成 interval 语义后，后续改 cron 永远不生效）。
    // 现在 start() 必须保持纯 cron 任务原样，只重算过期的 nextFireAt。
    h.storage.schedules.set('cron-30m', {
      id: 'cron-30m',
      name: 'pure cron 30m',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '*/30 * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      updatedAt: 0,
      lastFinishedAt: Date.UTC(2026, 0, 1, 0, 0, 17),
      nextFireAt: Date.UTC(2026, 0, 1, 0, 30, 0),
    });
    await h.scheduler.start();
    const after = await h.storage.get('cron-30m');
    expect(after?.intervalMs).toBeUndefined();
    // 壁钟槽位语义保持：下一次仍是 00:30:00 整
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 30, 0));
    await h.scheduler.stop();
  });

  it('start() preserves planned nextFireAt when it is still in the future (no restart-bump)', async () => {
    // 复刻线上 bug：上次跑完 17:22:25，原计划 18:22:25。app 在 18:11 重启时，
    // 旧逻辑 max(base+N, now+N) 永远取 now+N → next 被错误推到 19:11。
    // 修复后：planned > now 时尊重原计划，next 仍是 18:22:25。
    h.clock.setTo(Date.UTC(2026, 0, 1, 17, 22, 25));
    h.storage.schedules.set('hourly', {
      id: 'hourly',
      name: 'every hour',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 * * * *',
      intervalMs: 60 * 60_000,
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'active',
      createdAt: Date.UTC(2026, 0, 1, 16, 0, 0),
      updatedAt: 0,
      lastFiredAt: Date.UTC(2026, 0, 1, 17, 22, 18),
      lastFinishedAt: Date.UTC(2026, 0, 1, 17, 22, 25),
      nextFireAt: Date.UTC(2026, 0, 1, 18, 22, 25),
    });
    // 模拟 49 分钟后冷启动
    h.clock.setTo(Date.UTC(2026, 0, 1, 18, 11, 0));
    await h.scheduler.start();
    const after = await h.storage.get('hourly');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 18, 22, 25));
    await h.scheduler.stop();
  });

  it('resume() with intervalMs starts a fresh N countdown from now', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    await h.scheduler.pause(sch.id);
    h.clock.setTo(Date.UTC(2026, 0, 1, 5, 0, 0));
    await h.scheduler.resume(sch.id);
    const after = await h.storage.get(sch.id);
    // 没跑过，base = createdAt = 00:00:30。max(00:10:30, 05:10:00) = 05:10:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 5, 10, 0));
  });

  it('resume() with intervalMs cold-starts from now even when the last run is recent', async () => {
    // Regression: resume is documented as a cold start ("起新一轮 N 倒计时"), matching
    // update()'s `now + intervalMs`. A schedule that finished 17:22:25 with a 1h
    // interval, resumed at 17:40:00 (well within that hour), must re-arm at
    // now + 1h = 18:40:00 — NOT lastFinishedAt + 1h = 18:22:25. The latter is
    // start()/restart's "respect the original cadence" semantics, which must not
    // leak into a user-initiated resume.
    h.storage.schedules.set('hourly', {
      id: 'hourly',
      name: 'every hour',
      prompt: 'p',
      kind: 'cron',
      cronExpr: '0 * * * *',
      intervalMs: 60 * 60_000,
      timezone: 'UTC',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
      status: 'paused',
      createdAt: Date.UTC(2026, 0, 1, 16, 0, 0),
      updatedAt: 0,
      lastFiredAt: Date.UTC(2026, 0, 1, 17, 22, 18),
      lastFinishedAt: Date.UTC(2026, 0, 1, 17, 22, 25),
      nextFireAt: Date.UTC(2026, 0, 1, 18, 22, 25),
    });
    h.clock.setTo(Date.UTC(2026, 0, 1, 17, 40, 0));
    await h.scheduler.resume('hourly');
    const after = await h.storage.get('hourly');
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 18, 40, 0));
  });

  // ── update() 在用户编辑时是否立刻取消 pending fire ──
  // 用户体感："Next 13:50" 还有 9 分钟到，我把 Every 10min 改成 Every 5min，
  // 应该看到 nextFireAt 立刻刷成 now+5min（取消旧的 13:50）。

  it('update(intervalMs) cancels pending fire and reschedules from now', async () => {
    // create at 00:00:30 with intervalMs=10min → nextFireAt = 00:10:30
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    // advance to 00:01:00 and shrink interval to 5min
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await h.scheduler.update(sch.id, { intervalMs: 5 * 60_000, cronExpr: '*/5 * * * *' });
    const after = await h.storage.get(sch.id);
    // pending fire is cancelled; new fire scheduled at now+5min = 00:06:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
  });

  it('update(cronExpr) from interval to daily cancels pending fire', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // switch to daily 09:00 UTC; explicitly pass intervalMs:undefined like form does
    await h.scheduler.update(sch.id, { cronExpr: '0 9 * * *', intervalMs: undefined });
    const after = await h.storage.get(sch.id);
    // should be next 09:00, NOT old 00:10:30 and NOT now+10min
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(after?.intervalMs).toBeUndefined();
  });

  // ── update(cronExpr) 不带 intervalMs 时一律清空、按字面壁钟语义执行 ──
  // MCP 工具的 schema 不暴露 intervalMs，patch 只有 cronExpr。修复前旧 intervalMs
  // 原样保留并继续获胜 → 改 cron 形同虚设（PR 跟进任务退避阶梯被永久冻结在 10min）。
  // 注意**不做**"按形态推导 interval"：cron 就是 cron，interval 语义只属于显式
  // 传 intervalMs 的调用方（与 create() 对称，避免壁钟意图被静默转 interval）。

  it('update(cronExpr only) clears stale intervalMs when new cron is wall-clock', async () => {
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 模拟 MCP patch：只带 cronExpr，没有 intervalMs key
    await h.scheduler.update(sch.id, { cronExpr: '0 9 * * *' });
    const after = await h.storage.get(sch.id);
    expect(after?.intervalMs).toBeUndefined();
    // 按新 cron 的壁钟槽位排，而不是 now + 旧10min = 00:11:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });

  it('update(cronExpr only) clears intervalMs even when new cron is interval-shaped', async () => {
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await h.scheduler.update(sch.id, { cronExpr: '*/30 * * * *' });
    const after = await h.storage.get(sch.id);
    // 不按形态推导：interval 形态的 cron 同样回到纯壁钟语义
    expect(after?.intervalMs).toBeUndefined();
    // 下一个 */30 壁钟槽位 = 00:30:00（不是 now+30min=00:31:00，更不是 now+旧10min）
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 30, 0));
  });

  it('update with explicit intervalMs key still wins over cron-derived value', async () => {
    const sch = await h.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *', intervalMs: 10 * 60_000 });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 表单形态：cronExpr 和 intervalMs 都显式带（与 cron 不一致也尊重调用方）
    await h.scheduler.update(sch.id, { cronExpr: '*/30 * * * *', intervalMs: 5 * 60_000 });
    const after = await h.storage.get(sch.id);
    expect(after?.intervalMs).toBe(5 * 60_000);
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
  });

  // 模拟真实表单 patch 形态：full CreateScheduleInput 字段全量带过来
  // （form.toInput() 总是返回所有字段，而不是 diff）
  it('update with full form-shaped patch recomputes nextFireAt', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    // 模拟 useScheduleForm.toInput() 的输出：所有字段都带，intervalMs 改 5min
    await h.scheduler.update(sch.id, {
      name: 'test',
      prompt: 'do thing',
      kind: 'cron',
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      recurring: true,
      manual: false,
      intervalMs: 5 * 60_000,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      useWorktree: false,
      notify: { desktop: false, feishu: false },
    });
    const after = await h.storage.get(sch.id);
    // 期望取消旧的 00:10:30，重排到 now(00:01:00) + 5min = 00:06:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 6, 0));
    expect(after?.intervalMs).toBe(5 * 60_000);
  });

  it('update revives an expired one-shot after it becomes recurring and survives restart', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect((await h.storage.get(sch.id))?.status).toBe('expired');

    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 2, 10));
    const revived = await h.scheduler.update(sch.id, { recurring: true });
    expect(revived.status).toBe('active');
    expect(revived.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 3, 0));

    // 模拟重启：新 Scheduler 必须能从 storage.listActive() 重新加载并按新排期触发。
    const restarted = makeHarness({ storage: h.storage, clock: h.clock });
    await restarted.scheduler.start();
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 3, 0));
    await restarted.scheduler.tick();
    expect(restarted.runner.fire).toHaveBeenCalledTimes(1);
    expect((await h.storage.get(sch.id))?.status).toBe('active');
    await restarted.scheduler.stop();
  });

  it('updateFromCurrent 把读取、生成 patch 与写入放在同一任务锁内', async () => {
    const sch = await h.scheduler.create({
      ...baseInput,
      preRunHook: { command: 'node old.mjs' },
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = h.scheduler.updateFromCurrent(sch.id, async () => {
      firstEntered();
      await firstGate;
      return { preRunHook: { command: 'node new.mjs' } };
    });
    await firstEnteredPromise;

    let secondSnapshot: Schedule | undefined;
    const second = h.scheduler.updateFromCurrent(sch.id, async (current) => {
      secondSnapshot = current;
      return { name: 'renamed', preRunHook: current.preRunHook };
    });
    await Promise.resolve();
    expect(secondSnapshot).toBeUndefined();

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondSnapshot?.preRunHook?.command).toBe('node new.mjs');
    expect((await h.storage.get(sch.id))?.preRunHook?.command).toBe('node new.mjs');
  });

  it('serializes pause behind an expired schedule revival so active cache stays paused', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    expect((await h.storage.get(sch.id))?.status).toBe('expired');

    const storageUpdate = h.storage.update.bind(h.storage);
    let releaseRevival!: () => void;
    const revivalGate = new Promise<void>((resolve) => {
      releaseRevival = resolve;
    });
    let revivalPersisted!: () => void;
    const revivalPersistedPromise = new Promise<void>((resolve) => {
      revivalPersisted = resolve;
    });
    let pauseWriteCalls = 0;
    vi.spyOn(h.storage, 'update').mockImplementation(async (id, patch) => {
      const updated = await storageUpdate(id, patch);
      if (patch.status === 'active') {
        revivalPersisted();
        await revivalGate;
      } else if (patch.status === 'paused') {
        pauseWriteCalls += 1;
      }
      return updated;
    });

    const revivePromise = h.scheduler.update(sch.id, { recurring: true });
    await revivalPersistedPromise;
    const pausePromise = h.scheduler.pause(sch.id);

    // 让 pause 的 microtask 有机会推进；同一 schedule 的 mutation 临界区仍被 revival 占用，
    // 因此 pause 不能越过它先写 DB / 删除缓存。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pauseWriteCalls).toBe(0);

    releaseRevival();
    await Promise.all([revivePromise, pausePromise]);
    expect((await h.storage.get(sch.id))?.status).toBe('paused');
    // @ts-expect-error 访问私有 map 仅用于验证 reviewer 指出的缓存竞态。
    expect(h.scheduler.activeSchedules.has(sch.id)).toBe(false);
  });

  it('update keeps an expired one-shot expired when it remains non-recurring', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const updated = await h.scheduler.update(sch.id, { name: 'still one-shot' });
    expect(updated.status).toBe('expired');
    expect(updated.nextFireAt).toBeUndefined();
  });

  it('update keeps an expired schedule out of auto scheduling when recurring but manual', async () => {
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const updated = await h.scheduler.update(sch.id, { recurring: true, manual: true });
    expect(updated.status).toBe('expired');
    expect(updated.nextFireAt).toBeUndefined();
  });

  // ── delete/pause abort in-flight runs ─────────────────────────────────────
  //
  // 这组用例覆盖"删除/暂停时彻底中断已在跑的 run"。
  // runner.fire 永远不自然 resolve,只 await ctx.signal abort —— 模拟真实 agent
  // 长时间挂在 turnFinished 上的场景。test 用 ctx.signal abort 触发 reject,
  // 验证 engine 把 run 标 'aborted'、map 清空、schedule 状态正确。

  it('delete aborts in-flight run, marks status=aborted, leaks no entries', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    // 不 await —— tick 起飞 runner 但 runner 永远不 resolve
    const tickPromise = local.scheduler.tick();
    // 让 microtask queue 跑一圈,确保 fireOne 已注册 controller
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    // delete 触发 abort,等 fireOne 走完 finally + storage.updateRun
    await local.scheduler.delete(sch.id);
    await tickPromise;
    expect(await local.storage.get(sch.id)).toBeNull();
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const runs = [...local.storage.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('aborted');
    expect(runs[0].errorMsg).toMatch(/cancelled by user/);
  });

  it('pause aborts in-flight run, keeps schedule with status=paused', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    await local.scheduler.pause(sch.id);
    await tickPromise;
    const after = await local.storage.get(sch.id);
    expect(after?.status).toBe('paused');
    // pause 不应该把 lastFinishedAt / nextFireAt 写脏(aborted 短路了重排)
    expect(after?.lastFinishedAt).toBeUndefined();
    const runs = await local.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('aborted');
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
  });

  it('getInflightCount tracks 0 → 1 → 0 across a single fire', async () => {
    let resolveRunner!: (v: { sessionId: string }) => void;
    const local = makeHarness({
      runnerImpl: () => new Promise<{ sessionId: string }>((r) => { resolveRunner = r; }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    resolveRunner({ sessionId: 'sess-1' });
    await tickPromise;
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
  });

  it('concurrent fires (cron + runNow) all abort cleanly on delete', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    // 先 cron tick 起一个,再 runNow 起第二个 —— 并发 2 个 in-flight
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 5));
    const runNowPromise = local.scheduler.runNow(sch.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(2);
    // delete 一次性 abort 两条
    await local.scheduler.delete(sch.id);
    await Promise.allSettled([tickPromise, runNowPromise]);
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const runs = [...local.storage.runs.values()];
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'aborted')).toBe(true);
  });

  // ── delete/pause 的 caller-run 豁免(exemptRunId)────────────────────────────
  //
  // 场景:agent 在任务 run 内 delete/pause 自己所属的 schedule(心跳收口的标准
  // 动作)。不豁免的话 delete 会 abort 发起方自己这轮 run —— turn 被强杀、收尾
  // 汇报被掐断(2026-07-03 PR #471 心跳实锤)。豁免后该 run 自然跑完。
  //
  // 注意:InMemoryStorage.delete 不模拟 SQLite 的 ON DELETE CASCADE(上面
  // aborted 断言依赖非级联行为),所以豁免 run 的 success 落库在这里可见;
  // 真实 SQLite 下 run 行已随 schedule 级联删除,updateRun 是 no-op —— 两种
  // 语义下 fireOne 收尾都不抛错,这正是本组用例要固化的行为。

  it('delete with exemptRunId leaves caller run running; it completes normally', async () => {
    const signalAborted: boolean[] = [];
    let resolveRunner!: (v: { sessionId: string }) => void;
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveRunner = resolve;
          ctx.signal.addEventListener('abort', () => signalAborted.push(true));
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);
    const callerRunId = local.fireCalls[0].ctx.runId;

    // 豁免 caller run:delete 立即返回(不 abort 它、不等它 settle)
    await local.scheduler.delete(sch.id, { exemptRunId: callerRunId });
    expect(signalAborted).toHaveLength(0);
    expect(await local.storage.get(sch.id)).toBeNull();
    // caller run 仍在 in-flight(fireOne 还没走完 finally)
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);

    // caller run 自然跑完:fireOne 收尾不抛错,run 走 success 分支
    resolveRunner({ sessionId: 'sess-caller' });
    await tickPromise;
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const run = local.storage.runs.get(callerRunId);
    expect(run?.status).toBe('success');
    // schedule 行已删,fireOne 尾部重排的 storage.update 是 no-op,不会复活 schedule
    expect(await local.storage.get(sch.id)).toBeNull();
  });

  it('delete with exemptRunId still aborts sibling in-flight runs', async () => {
    const abortedRunIds: string[] = [];
    const resolvers = new Map<string, (v: { sessionId: string }) => void>();
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve, reject) => {
          resolvers.set(ctx.runId, resolve);
          ctx.signal.addEventListener('abort', () => {
            abortedRunIds.push(ctx.runId);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 5));
    const runNowPromise = local.scheduler.runNow(sch.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(2);
    const callerRunId = local.fireCalls[0].ctx.runId;
    const siblingRunId = local.fireCalls[1].ctx.runId;

    // 豁免 caller,兄弟 run 照常 abort;delete 等兄弟 settle 后返回
    await local.scheduler.delete(sch.id, { exemptRunId: callerRunId });
    expect(abortedRunIds).toEqual([siblingRunId]);
    expect(await local.storage.get(sch.id)).toBeNull();

    resolvers.get(callerRunId)!({ sessionId: 'sess-caller' });
    await Promise.allSettled([tickPromise, runNowPromise]);
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    expect(local.storage.runs.get(siblingRunId)?.status).toBe('aborted');
    expect(local.storage.runs.get(callerRunId)?.status).toBe('success');
  });

  it('delete with an unrelated exemptRunId behaves like plain delete (all aborted)', async () => {
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((_, reject) => {
          ctx.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(local.scheduler.getInflightCount(sch.id)).toBe(1);

    // exemptRunId 不属于本 schedule 的 in-flight set → 豁免不命中,全部 abort
    await local.scheduler.delete(sch.id, { exemptRunId: 'run-of-another-schedule' });
    await tickPromise;
    expect(local.scheduler.getInflightCount(sch.id)).toBe(0);
    const runs = [...local.storage.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('aborted');
  });

  it('pause with exemptRunId leaves caller run running; run lands success on a paused schedule', async () => {
    const signalAborted: boolean[] = [];
    let resolveRunner!: (v: { sessionId: string }) => void;
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveRunner = resolve;
          ctx.signal.addEventListener('abort', () => signalAborted.push(true));
        }),
    });
    const sch = await local.scheduler.create({ ...baseInput });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    const callerRunId = local.fireCalls[0].ctx.runId;

    const paused = await local.scheduler.pause(sch.id, { exemptRunId: callerRunId });
    expect(paused.status).toBe('paused');
    expect(signalAborted).toHaveLength(0);

    resolveRunner({ sessionId: 'sess-caller' });
    await tickPromise;
    // run 正常 success 落库;schedule 保持 paused,fireOne 尾部不会把它加回 active
    expect(local.storage.runs.get(callerRunId)?.status).toBe('success');
    expect((await local.storage.get(sch.id))?.status).toBe('paused');
    // 旧 fire 时间再到也不触发(activeSchedules 已摘除)
    local.clock.setTo(Date.UTC(2026, 0, 2, 0, 1, 5));
    await local.scheduler.tick();
    expect(local.runner.fire).toHaveBeenCalledTimes(1);
  });

  it('one-shot schedule paused by its own run stays paused after run completes', async () => {
    // 回归：recurring=false 的 run 调 pause(exemptRunId=self) → fireOne 收尾不得把
    // 'paused' 覆盖成 'expired'。
    let resolveRunner!: (v: { sessionId: string }) => void;
    const ref: { scheduler?: Scheduler } = {};
    const local = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveRunner = resolve;
          void ref.scheduler!.pause(_s.id, { exemptRunId: ctx.runId });
        }),
    });
    ref.scheduler = local.scheduler;
    const sch = await local.scheduler.create({ ...baseInput, recurring: false });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tickPromise = local.scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    const callerRunId = local.fireCalls[0].ctx.runId;

    // run 内 pause 已将 schedule 标为 paused
    expect((await local.storage.get(sch.id))?.status).toBe('paused');

    // runner 完成 → fireOne 收尾不得把 paused 覆盖成 expired
    resolveRunner({ sessionId: 'sess-one-shot' });
    await tickPromise;
    expect(local.storage.runs.get(callerRunId)?.status).toBe('success');
    expect((await local.storage.get(sch.id))?.status).toBe('paused');
  });

  // tick 验证：编辑后旧时间到了不会再触发（nextFireAt 已被重排）
  it('after update, old pending fire time is skipped by tick', async () => {
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 10 * 60_000 });
    expect(sch.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 0));
    await h.scheduler.update(sch.id, { intervalMs: 5 * 60_000, cronExpr: '*/5 * * * *' });
    // 推进到原来的 00:10:30 触发点
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 10, 30));
    await h.scheduler.tick();
    // 新 nextFireAt = 00:06:00，已经过了 → 应该 fire 一次（new schedule 触发）
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    const after = await h.storage.get(sch.id);
    // fireOne 完成后，nextFireAt = finishedAt + 5min = 00:10:30 + 5min = 00:15:30
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 15, 30));
  });

  // ── fireOne 收尾重排必须用 DB 最新行，不能用 fire 时刻的快照 ──
  // 真实场景：PR 跟进任务在 run 内调 schedule_update 自适应降档改 cron，
  // 修复前 run 结束的重排按旧快照把 nextFireAt 覆盖回旧 cron 的槽位。

  it('mid-run cronExpr update is not clobbered by post-run recompute', async () => {
    const ref: { scheduler?: Scheduler } = {};
    const local = makeHarness({
      runnerImpl: async (s) => {
        // run 内 agent 把节奏从 */10 降档到每天 09:00
        await ref.scheduler!.update(s.id, { cronExpr: '0 9 * * *' });
        return { sessionId: 'sess-mid-update' };
      },
    });
    ref.scheduler = local.scheduler;
    const sch = await local.scheduler.create({ ...baseInput, cronExpr: '*/10 * * * *' });
    local.clock.setTo(Date.UTC(2026, 0, 1, 0, 10, 5));
    await local.scheduler.tick();
    const after = await local.storage.get(sch.id);
    // 按新 cron 排到 09:00，而不是旧 */10 的下一个槽位 00:20:00
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(after?.intervalMs).toBeUndefined();
  });

  // ---------- 静默 run(silenceRun / isRunSilenced)----------

  it('silenced run lands with readAt set (success path, fireOne)', async () => {
    // runnerImpl 在 fire 期间用本轮 ctx.runId 调 silenceRun —— 模拟任务内 agent
    // 经 MCP 工具声明"本轮无需关注"
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-x');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        return { sessionId: 'sess-x' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const events: unknown[] = [];
    h.scheduler.on('silenced', (e) => events.push(e));
    h.scheduler.on('completed', (e) => events.push(e));
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    // 生而已读:readAt = finishedAt,小红点计算(!readAt && 终态)排除本条
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      { type: 'silenced', scheduleId: sch.id, runId: runs[0].id, sessionId: 'sess-x' },
      {
        type: 'completed',
        scheduleId: sch.id,
        runId: runs[0].id,
        sessionId: 'sess-x',
        silenced: true,
      },
    ]);
    // 终态后清理内存标记,不泄漏
    expect(h.scheduler.isRunSilenced(runs[0].id)).toBe(false);
  });

  it('silenced run via runNow also lands read', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-x');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        return { sessionId: 'sess-x' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const { runId } = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].id).toBe(runId);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(h.scheduler.isRunSilenced(runId)).toBe(false);
  });

  it('silentWhenIdle run is silent by default', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        await ctx.onSessionBound?.('sess-silent');
        ctx.onTurnActive?.('sess-silent');
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        return { sessionId: 'sess-silent' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: true });
    const events: unknown[] = [];
    h.scheduler.on('fired', (e) => events.push(e));
    h.scheduler.on('session-bound', (e) => events.push(e));
    h.scheduler.on('silenced', (e) => events.push(e));
    h.scheduler.on('completed', (e) => events.push(e));
    const { runId } = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);

    expect(runs[0].id).toBe(runId);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      { type: 'fired', scheduleId: sch.id, runId, silent: true },
      { type: 'session-bound', scheduleId: sch.id, runId, sessionId: 'sess-silent' },
      { type: 'silenced', scheduleId: sch.id, runId, sessionId: 'sess-silent' },
      { type: 'completed', scheduleId: sch.id, runId, sessionId: 'sess-silent', silenced: true },
    ]);
  });

  it('notifyRun restores notification for a silentWhenIdle run', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        await ctx.onSessionBound?.('sess-notify');
        ctx.onTurnActive?.('sess-notify');
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        expect(h.scheduler.notifyRun(ctx.runId)).toBe(true);
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(false);
        return { sessionId: 'sess-notify' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, silentWhenIdle: true });
    const events: unknown[] = [];
    h.scheduler.on('notified', (e) => events.push(e));
    h.scheduler.on('completed', (e) => events.push(e));
    const { runId } = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);

    expect(runs[0].id).toBe(runId);
    expect(runs[0].readAt).toBeUndefined();
    expect(events).toEqual([
      { type: 'notified', scheduleId: sch.id, runId, sessionId: 'sess-notify' },
      { type: 'completed', scheduleId: sch.id, runId, sessionId: 'sess-notify' },
    ]);
  });

  it('failed run ignores silence mark (fail-safe: 异常保持未读)', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-x');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        throw new Error('agent exploded after silencing');
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].readAt).toBeUndefined();
    // 失败路径同样清理标记
    expect(h.scheduler.isRunSilenced(runs[0].id)).toBe(false);
  });

  it('silenceRun 只静默指定 run,不误伤同 schedule 的其它并发 run', async () => {
    // 两条 run 并发在跑:只静默第一条,第二条照常通知(线程 3 的回归)
    const gates: Array<() => void> = [];
    h = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise((resolve) => {
          // 第一条 run 静默自己,第二条不静默;都挂起等闸门放行
          ctx.onTurnActive?.(`sess-${ctx.runId}`);
          if (gates.length === 0) expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
          gates.push(() => resolve({ sessionId: `sess-${ctx.runId}` }));
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p1 = h.scheduler.runNow(sch.id);
    const p2 = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates.forEach((g) => g());
    const [r1, r2] = await Promise.all([p1, p2]);
    const runs = await h.scheduler.listRuns(sch.id);
    const run1 = runs.find((r) => r.id === r1.runId)!;
    const run2 = runs.find((r) => r.id === r2.runId)!;
    expect(run1.readAt).toBe(run1.finishedAt); // 静默 → 已读
    expect(run2.readAt).toBeUndefined(); // 未静默 → 保持未读,会通知
  });

  it('silenceRun 对不存在 / 已结束的 runId 返回 false', () => {
    expect(h.scheduler.silenceRun('no-such-run')).toBe(false);
  });

  it('silenceRun 显式 runId 路径不依赖 active turn 映射', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        await ctx.onSessionBound?.('sess-no-active-turn');
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        expect(h.scheduler.isRunSilenced(ctx.runId)).toBe(true);
        return { sessionId: 'sess-no-active-turn' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const events: unknown[] = [];
    h.scheduler.on('silenced', (e) => events.push(e));
    const result = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      {
        type: 'silenced',
        scheduleId: sch.id,
        runId: result.runId,
        sessionId: 'sess-no-active-turn',
      },
    ]);
  });

  it('silenceRun 早于 onSessionBound 时在 session 绑定后广播静默事件', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        expect(h.scheduler.silenceRun(ctx.runId)).toBe(true);
        await ctx.onSessionBound?.('sess-late-bound');
        return { sessionId: 'sess-late-bound' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const events: unknown[] = [];
    h.scheduler.on('session-bound', (e) => events.push(e));
    h.scheduler.on('silenced', (e) => events.push(e));
    const result = await h.scheduler.runNow(sch.id);
    const runs = await h.scheduler.listRuns(sch.id);

    expect(runs[0].readAt).toBe(runs[0].finishedAt);
    expect(events).toEqual([
      {
        type: 'session-bound',
        scheduleId: sch.id,
        runId: result.runId,
        sessionId: 'sess-late-bound',
      },
      {
        type: 'silenced',
        scheduleId: sch.id,
        runId: result.runId,
        sessionId: 'sess-late-bound',
      },
    ]);
  });

  // ---------- 按 session 解析 in-flight run(resolveInflightRunForSession)----------

  it('resolveInflightRunForSession 返回本会话 in-flight runId,run 结束后清空', async () => {
    let gate: (() => void) | undefined;
    let boundRunId: string | undefined;
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        boundRunId = ctx.runId;
        // 反向映射在 turn 被接受时写(onTurnActive),不在 onSessionBound(send 前)
        ctx.onTurnActive?.('sess-A');
        await new Promise<void>((r) => {
          gate = r;
        });
        return { sessionId: 'sess-A' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gate).toBeDefined());
    // in-flight 期间:按 sessionId 反查到本轮 runId
    expect(h.scheduler.resolveInflightRunForSession('sess-A')).toBe(boundRunId);
    gate!();
    await p;
    // 结束后清空,不泄漏
    expect(h.scheduler.resolveInflightRunForSession('sess-A')).toBeUndefined();
  });

  it('按 session 静默:resolve → silenceRun 让本轮落地已读(MCP 工具路径,不靠 agent 传 runId)', async () => {
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-S');
        // 模拟 MCP 工具:不读 ctx.runId,纯按 sessionId 反查并静默
        const rid = h.scheduler.resolveInflightRunForSession('sess-S');
        expect(rid).toBe(ctx.runId);
        expect(h.scheduler.silenceRun(rid!)).toBe(true);
        return { sessionId: 'sess-S' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs[0].status).toBe('success');
    expect(runs[0].readAt).toBe(runs[0].finishedAt);
  });

  it('同 session 两轮都被接受:映射覆盖为最新 runId,先结束的清理不误删新映射', async () => {
    const gates: Array<() => void> = [];
    const runIds: string[] = [];
    h = makeHarness({
      runnerImpl: (_s, ctx) =>
        new Promise((resolve) => {
          runIds.push(ctx.runId);
          ctx.onTurnActive?.('sess-D');
          gates.push(() => resolve({ sessionId: 'sess-D' }));
        }),
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p1 = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const p2 = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    // 第二轮覆盖:resolve 返回最新 runId
    expect(h.scheduler.resolveInflightRunForSession('sess-D')).toBe(runIds[1]);
    // 先放行先绑定的第一轮 —— 其 cleanup 不能误删指向第二轮的映射
    gates[0]();
    await p1;
    expect(h.scheduler.resolveInflightRunForSession('sess-D')).toBe(runIds[1]);
    gates[1]();
    await p2;
    expect(h.scheduler.resolveInflightRunForSession('sess-D')).toBeUndefined();
  });

  it('同 session 重叠:被拒 run(只 onSessionBound 未 onTurnActive)不污染活跃 run 映射(codex P2)', async () => {
    // 复刻 review 场景:run A 已被接受并执行中(onTurnActive 落映射);run B 撞同
    // session,send 被 SESSION_RUNNING 拒 —— B 只走到 onSessionBound(send 前),never
    // onTurnActive,随后抛错失败。断言:A 的映射不被 B 覆盖/带走,A 仍能解析到自己。
    let releaseA: (() => void) | undefined;
    let runIdA: string | undefined;
    let n = 0;
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        n += 1;
        if (n === 1) {
          runIdA = ctx.runId;
          ctx.onTurnActive?.('sess-O'); // A 被接受,落映射
          await new Promise<void>((r) => {
            releaseA = r;
          });
          return { sessionId: 'sess-O' };
        }
        // B:send 被拒 —— 只调 onSessionBound(早于 send),不调 onTurnActive,然后失败
        await ctx.onSessionBound?.('sess-O');
        throw new Error('SESSION_RUNNING: session busy');
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const pA = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(runIdA).toBeDefined());
    expect(h.scheduler.resolveInflightRunForSession('sess-O')).toBe(runIdA);
    // B 触发并失败
    await h.scheduler.runNow(sch.id);
    // A 仍在执行,映射必须还指向 A(没被 B 覆盖、也没被 B 的 cleanup 删掉)
    expect(h.scheduler.resolveInflightRunForSession('sess-O')).toBe(runIdA);
    releaseA!();
    await pA;
    expect(h.scheduler.resolveInflightRunForSession('sess-O')).toBeUndefined();
  });

  it('stop() 清空 sessionId→runId 映射', async () => {
    let gate: (() => void) | undefined;
    h = makeHarness({
      runnerImpl: async (_s, ctx) => {
        ctx.onTurnActive?.('sess-Z');
        await new Promise<void>((r) => {
          gate = r;
        });
        return { sessionId: 'sess-Z' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gate).toBeDefined());
    expect(h.scheduler.resolveInflightRunForSession('sess-Z')).toBeDefined();
    await h.scheduler.stop();
    expect(h.scheduler.resolveInflightRunForSession('sess-Z')).toBeUndefined();
    gate!();
    await p;
  });
});

// ── 多实例共库互斥(dev / release 双开)────────────────────────────────────
// 两个 Scheduler 实例共享同一 storage,模拟两个 app 进程共用同一 SQLite。
// 触发互斥靠 fireOne 的 claimDueFire CAS;这里验证同一次到点只会真跑一次。
describe('Scheduler cross-instance dedupe', () => {
  it('两个实例同时 tick 同一到点任务,只有一个真正执行', async () => {
    const storage = new InMemoryStorage();
    const clock = new FakeClock();
    const a = makeHarness({ storage, clock, generateId: (() => { let n = 0; return () => `a-${++n}`; })() });
    const b = makeHarness({ storage, clock, generateId: (() => { let n = 0; return () => `b-${++n}`; })() });
    const sch = await a.scheduler.create({ ...baseInput });
    // 模拟实例 B 冷启动:从共享 DB 加载 actives 进自己的内存
    await b.scheduler.start();
    await b.scheduler.stop(); // 停掉真实 interval;stop 会清内存,重新手动灌入
    const fromDb = await storage.get(sch.id);
    // @ts-expect-error 访问私有 map 仅测试用:模拟 B 内存里已有这条任务
    b.scheduler.activeSchedules.set(sch.id, fromDb!);

    clock.advance(60_000); // 双方都判定到点
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);

    const totalFires = a.fireCalls.length + b.fireCalls.length;
    expect(totalFires).toBe(1);
    // run 记录也只有一条(没有重复触发的双记录)
    const runs = await storage.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
  });

  it('claimDueFire 输掉 CAS 时:不跑 runner、不留 run 记录、不发 fired 事件', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput });
    const firedEvents: unknown[] = [];
    h.scheduler.on('fired', (e) => firedEvents.push(e));
    // 模拟另一进程在本进程 CAS 前一瞬抢先认领
    vi.spyOn(h.storage, 'claimDueFire').mockResolvedValueOnce(null);
    h.clock.advance(60_000);
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
    expect(await h.storage.listRuns(sch.id)).toHaveLength(0);
    expect(firedEvents).toHaveLength(0);
  });

  it('claimDueFire 抛错时:放回内存,下个 tick 重试成功', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput });
    vi.spyOn(h.storage, 'claimDueFire').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    h.clock.advance(60_000);
    await h.scheduler.tick();
    expect(h.runner.fire).not.toHaveBeenCalled();
    // 第二个 tick:spy 只挡一次,这次 CAS 正常走 → 真跑
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    expect(await h.storage.listRuns(sch.id)).toHaveLength(1);
  });

  it('周期性 DB 同步:另一实例新建/接管的任务,本实例 30s 后能看到并接管触发', async () => {
    const h = makeHarness();
    await h.scheduler.start();
    await h.scheduler.stop(); // 关掉真实 interval,手动 tick
    // stop 清空了内存;直接往共享 storage 写入一条"另一实例创建"的任务
    const now = h.clock.now();
    await h.storage.insert({
      ...baseInput,
      id: 'other-created',
      manual: false,
      persistentSession: false,
      silentWhenIdle: false,
      // CreateScheduleInput.preRunHook / scriptConfig 允许 null(JSON 边界),Schedule 只有两态
      preRunHook: undefined,
      scriptConfig: undefined,
      workspaceKind: 'dialogue',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      nextFireAt: now + 60_000,
    });
    // 越过 DB 同步间隔(30s)+ 到点时刻
    h.clock.advance(61_000);
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    expect(h.fireCalls[0].schedule.id).toBe('other-created');
  });
});

// ── 被动模式(双开时 dev 端让出自动触发)──────────────────────────────────
describe('Scheduler passive mode', () => {
  it('start() 不清僵尸、不加载 actives、不装时钟;runNow 照常可用', async () => {
    const storage = new InMemoryStorage();
    const h = makeHarness({ storage, passive: true });
    const markSpy = vi.spyOn(storage, 'markRunningAsInterrupted');
    const listActiveSpy = vi.spyOn(storage, 'listActive');
    const sch = await h.scheduler.create({ ...baseInput });
    await h.scheduler.start();
    expect(markSpy).not.toHaveBeenCalled();
    expect(listActiveSpy).not.toHaveBeenCalled();
    // 手动触发不受被动模式影响
    await h.scheduler.runNow(sch.id);
    expect(h.runner.fire).toHaveBeenCalledTimes(1);
    await h.scheduler.stop();
  });
});

describe('Scheduler preRunHook results', () => {
  it('前置检查结果落库暂时失败时不覆盖 skip 判定', async () => {
    const logger: Logger = { warn: vi.fn() };
    const preRunHookResult: NonNullable<ScheduleRun['preRunHookResult']> = {
      status: 'skipped',
      decision: 'skip',
      exitCode: 2,
      durationMs: 6,
      stdout: 'no work',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    };
    const h = makeHarness({
      logger,
      runnerImpl: async (_schedule, ctx) => {
        await ctx.onPreRunHookCompleted?.(preRunHookResult);
        return { sessionId: '', skipped: true, resultText: 'exit 2: no work' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });
    vi.spyOn(h.storage, 'updateRun').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const failedEvents: unknown[] = [];
    h.scheduler.on('failed', (event) => failedEvents.push(event));

    const { runId } = await h.scheduler.runNow(sch.id);
    const run = (await h.scheduler.listRuns(sch.id)).find((item) => item.id === runId);

    expect(run?.status).toBe('skipped');
    expect(run?.readAt).toBeDefined();
    expect(run?.preRunHookResult).toBeUndefined();
    expect(failedEvents).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('persist pre-run hook result failed', {
      runId,
      error: 'SQLITE_BUSY',
    });
  });

  it('runNow fail-closed:检查结果在无 session 时仍落库，run 记 failed 且未读', async () => {
    const preRunHookResult: NonNullable<ScheduleRun['preRunHookResult']> = {
      status: 'failed',
      decision: 'block',
      exitCode: 1,
      durationMs: 6,
      stdout: '',
      stderr: 'syntax error',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    };
    const h = makeHarness({
      runnerImpl: async (_schedule, ctx) => {
        await ctx.onPreRunHookCompleted?.(preRunHookResult);
        throw new Error('pre-run hook failed with exit code 1');
      },
    });
    const sch = await h.scheduler.create({ ...baseInput });

    const { runId } = await h.scheduler.runNow(sch.id);
    const run = (await h.scheduler.listRuns(sch.id)).find((item) => item.id === runId);

    expect(run?.status).toBe('failed');
    expect(run?.sessionId).toBeUndefined();
    expect(run?.readAt).toBeUndefined();
    expect(run?.preRunHookResult).toEqual(preRunHookResult);
  });

  it('cron fire skipped: run 保留为 skipped(生而已读)、照常重排、发 skipped 事件', async () => {
    const h = makeHarness({
      runnerImpl: async () => ({
        sessionId: '',
        skipped: true,
        resultText: 'exit 2: no new PRs',
      }),
    });
    const sch = await h.scheduler.create({
      ...baseInput,
      preRunHook: { command: 'node check.mjs' },
    });
    const skippedEvents: Array<{ scheduleId: string; runId: string; sessionId: string }> = [];
    const completedEvents: unknown[] = [];
    const failedEvents: unknown[] = [];
    h.scheduler.on('skipped', (e) => skippedEvents.push(e));
    h.scheduler.on('completed', (e) => completedEvents.push(e));
    h.scheduler.on('failed', (e) => failedEvents.push(e));

    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();

    const runs = await h.scheduler.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('skipped');
    // 生而已读:不产生未读红点
    expect(runs[0].readAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 5));
    expect(runs[0].resultText).toBe('exit 2: no new PRs');
    expect(runs[0].sessionId).toBeUndefined();

    // 与 deferred 不同:照常按 cron 重排下一槽位,不是短延重试
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));
    expect(after?.lastFiredAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 5));

    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].sessionId).toBe('');
    expect(completedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(0);
  });

  it('runNow skipped: run 保留为 skipped,nextFireAt 不被打乱', async () => {
    const h = makeHarness({
      runnerImpl: async () => ({ sessionId: '', skipped: true }),
    });
    const sch = await h.scheduler.create({ ...baseInput });
    const before = await h.storage.get(sch.id);
    const skippedEvents: Array<{ sessionId: string }> = [];
    h.scheduler.on('skipped', (e) => skippedEvents.push(e));

    const { runId } = await h.scheduler.runNow(sch.id);

    const run = (await h.scheduler.listRuns(sch.id)).find((r) => r.id === runId);
    expect(run?.status).toBe('skipped');
    expect(run?.readAt).toBeDefined();
    expect(run?.sessionId).toBeUndefined(); // 空串 sessionId 不落库
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0].sessionId).toBe('');
    // runNow 不动 cron 排期(与 success 路径一致)
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(before?.nextFireAt);
  });

  it('one-shot skipped: 与 success 一致,消费掉本次触发并 expired', async () => {
    const h = makeHarness({
      runnerImpl: async () => ({ sessionId: '', skipped: true }),
    });
    const sch = await h.scheduler.create({ ...baseInput, recurring: false });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    await h.scheduler.tick();
    const after = await h.storage.get(sch.id);
    expect(after?.status).toBe('expired');
    expect(after?.nextFireAt).toBeUndefined();
  });

  it('create() 透传 preRunHook 配置', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({
      ...baseInput,
      preRunHook: { command: 'python check.py', timeoutMs: 5000 },
    });
    expect(sch.preRunHook).toEqual({ command: 'python check.py', timeoutMs: 5000 });
    // 未配置的任务字段为 undefined,零行为变化
    const plain = await h.scheduler.create({ ...baseInput });
    expect(plain.preRunHook).toBeUndefined();
  });
});

// ── 心跳租约与僵尸 run 清理(多实例共库安全)──────────────────────────────
// 回归背景:markRunningAsInterrupted 曾无条件把所有 'running' 行标 interrupted,
// 双开时一个实例启动会误杀另一个活实例正在执行的 run(对方静默完成后,本实例
// UI 留下永远消不掉的假失败红点 + errorMsg 残留)。现在只回收心跳过期的行。
describe('Scheduler run heartbeat lease & zombie sweep', () => {
  function insertRunningRun(
    storage: InMemoryStorage,
    id: string,
    scheduleId: string,
    firedAt: number,
    heartbeatAt?: number,
  ): void {
    storage.runs.set(id, {
      id,
      scheduleId,
      firedAt,
      status: 'running',
      ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
    });
  }

  it('start() 只清心跳过期的僵尸;另一活实例心跳新鲜的 in-flight run 不动', async () => {
    const storage = new InMemoryStorage();
    const clock = new FakeClock();
    const a = makeHarness({ storage, clock });
    const sch = await a.scheduler.create({ ...baseInput, manual: true });
    const now = clock.now();
    // 对方活实例正在跑(心跳刚续过)
    insertRunningRun(storage, 'run-alive', sch.id, now - 300_000, now - 5_000);
    // 真僵尸:心跳停在过期窗口之外
    insertRunningRun(storage, 'run-dead', sch.id, now - 300_000, now - RUN_HEARTBEAT_STALE_MS - 1_000);
    // 老版本写入的行(无心跳字段):按 firedAt 兜底,同样过期
    insertRunningRun(storage, 'run-legacy', sch.id, now - RUN_HEARTBEAT_STALE_MS - 1_000);

    const b = makeHarness({ storage, clock });
    await b.scheduler.start();
    expect(storage.runs.get('run-alive')?.status).toBe('running');
    expect(storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(storage.runs.get('run-dead')?.errorMsg).toBe('app restarted');
    expect(storage.runs.get('run-legacy')?.status).toBe('interrupted');
    await b.scheduler.stop();
  });

  it('运行期清扫:暖场窗口后把心跳过期的行改写 interrupted 并广播 changed', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const changedIds: string[] = [];
    h.scheduler.on('changed', (e: { scheduleId: string }) => changedIds.push(e.scheduleId));
    // 启动后才出现的僵尸(另一实例此刻崩溃):心跳停在 start 时刻
    insertRunningRun(h.storage, 'run-dead', sch.id, h.clock.now(), h.clock.now());
    // 老版本实例正在跑的 run(无心跳字段):它活着也不会续心跳,60s 心跳窗口内
    // 绝不能按 firedAt 秒杀 —— NULL 行走独立的 RUN_LEGACY_STALE_MS 宽窗口。
    insertRunningRun(h.storage, 'run-old-version', sch.id, h.clock.now());
    // 以 ≤SUSPEND_GAP 的步长推进(模拟正常连续 tick,不触发挂起宽限):
    // 暖场窗口(start + RUN_HEARTBEAT_STALE_MS)内清扫不动手 ——
    h.clock.advance(25_000);
    await h.scheduler.tick();
    h.clock.advance(25_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('running');
    // —— 过了暖场窗口且心跳过期后,清扫在下一个 DB-sync 周期(清扫挂在它上面,
    // 30s 一轮)改写并广播
    h.clock.advance(25_000);
    await h.scheduler.tick();
    h.clock.advance(25_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(h.storage.runs.get('run-old-version')?.status).toBe('running');
    expect(changedIds).toContain(sch.id);
    await h.scheduler.stop();
  });

  it('运行期清扫排除本进程 in-flight run(自家心跳停摆也不自伤)', async () => {
    let gate: (() => void) | undefined;
    const h = makeHarness({
      runnerImpl: async () => {
        await new Promise<void>((r) => {
          gate = r;
        });
        return { sessionId: 'sess-long' };
      },
    });
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const p = h.scheduler.runNow(sch.id);
    await vi.waitFor(() => expect(gate).toBeDefined());
    // 真实心跳定时器在 fake clock 下永不触发 → heartbeatAt 停在 firedAt,
    // 从 DB 视角看已"过期";但它在本进程 inflight 名单里,清扫必须放过。
    for (let i = 0; i < 5; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    const runs = await h.storage.listRuns(sch.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    gate!();
    await p;
    expect((await h.storage.listRuns(sch.id))[0].status).toBe('success');
    await h.scheduler.stop();
  });

  it('挂起唤醒(tick 大缺口)后清扫延迟一个完整过期窗口再恢复', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    insertRunningRun(h.storage, 'run-dead', sch.id, h.clock.now(), h.clock.now());
    // 一次性跳 10 分钟模拟系统睡眠:同机所有实例的心跳都停在睡前,
    // 唤醒后的第一波 tick 不许清扫(对方可能马上续心跳)。
    h.clock.advance(600_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('running');
    // 宽限窗口内继续小步 tick 仍不动手
    h.clock.advance(25_000);
    await h.scheduler.tick();
    expect(h.storage.runs.get('run-dead')?.status).toBe('running');
    // 宽限过后(且撞上下一个 DB-sync 周期)恢复清扫
    for (let i = 0; i < 3; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    await h.scheduler.stop();
  });

  it('in-flight 期间周期续心跳;结束后定时器停止', async () => {
    vi.useFakeTimers();
    try {
      let gate: (() => void) | undefined;
      const h = makeHarness({
        runnerImpl: async () => {
          await new Promise<void>((r) => {
            gate = r;
          });
          return { sessionId: 'sess-hb' };
        },
      });
      const touchSpy = vi.spyOn(h.storage, 'touchRunHeartbeats');
      const sch = await h.scheduler.create({ ...baseInput, manual: true });
      const p = h.scheduler.runNow(sch.id);
      await vi.waitFor(() => expect(gate).toBeDefined());
      const runId = (await h.storage.listRuns(sch.id))[0].id;
      const firedAt = (await h.storage.listRuns(sch.id))[0].firedAt;
      // 初始 run 落库即带心跳(= firedAt),不给"插入后第一拍前"留过期空窗
      expect(h.storage.runs.get(runId)?.heartbeatAt).toBe(firedAt);
      // 推进一个心跳周期:touch 落到 storage,时间戳取引擎时钟
      h.clock.advance(RUN_HEARTBEAT_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
      expect(touchSpy).toHaveBeenCalledWith([runId], h.clock.now());
      expect(h.storage.runs.get(runId)?.heartbeatAt).toBe(h.clock.now());
      // run 结束 → inflight 清空 → 定时器停止,不再 touch
      gate!();
      await p;
      const callsAfterDone = touchSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 3);
      expect(touchSpy.mock.calls.length).toBe(callsAfterDone);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 清扫善后:恢复崩溃认领悬置的排期(codex review P1)────────────────────
  // claimDueFire 认领会把 nextFireAt 置空,认领方崩溃后没有 fireOne 收口重排;
  // 只标 run 不补排的话,幸存实例的 DB 同步会一直重灌回"active 但无排期"的
  // schedule,任务无声停摆直到某个实例重启。
  async function advancePastSweep(h: Harness): Promise<void> {
    // 25s × 4 步:跨过暖场窗口(start + 60s)并命中 DB-sync 周期(30s,清扫挂其上),
    // 步长 ≤ SUSPEND_GAP 不触发挂起宽限。
    for (let i = 0; i < 4; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
  }

  it('清扫崩溃认领的僵尸后,按 start() 归一语义恢复 nextFireAt', async () => {
    const h = makeHarness();
    // interval 1h:测试窗口内不会自然触发,专注清扫路径
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    // 模拟另一实例认领后崩溃:nextFireAt 被置空 + 留下心跳过期的 running 行
    await h.storage.update(sch.id, { nextFireAt: undefined });
    insertRunningRun(h.storage, 'run-claimed-dead', sch.id, h.clock.now(), h.clock.now());
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-claimed-dead')?.status).toBe('interrupted');
    // 排期已恢复:interval 语义 = base(createdAt,没跑完过) + intervalMs
    const after = await h.storage.get(sch.id);
    expect(after?.nextFireAt).toBe(sch.createdAt + 3_600_000);
    await h.scheduler.stop();
  });

  it('清扫后该 schedule 仍有 running 行(另一活实例在执行)→ 不抢排', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    await h.storage.update(sch.id, { nextFireAt: undefined });
    // 心跳过期的僵尸 + 心跳新鲜的活 run 并存(如 runNow 僵尸 + 认领执行中)
    insertRunningRun(h.storage, 'run-dead', sch.id, h.clock.now(), h.clock.now());
    insertRunningRun(h.storage, 'run-live', sch.id, h.clock.now(), h.clock.now() + 90_000);
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(h.storage.runs.get('run-live')?.status).toBe('running');
    // 执行方 fireOne 收口时会按 recurring 语义重排,这里不抢
    expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
    await h.scheduler.stop();
  });

  it('老版本 NULL 心跳残留:60s 窗口内放过,超过 RUN_LEGACY_STALE_MS 后运行期收掉', async () => {
    // 回归(codex review P2):NULL 行曾被运行期清扫一刀切跳过 —— 启动时未过期的
    // 老版本崩溃残留(如老 app 崩溃后 60s 内新版本就启动)将永远无人收,running
    // 行永久卡死,auto-relaunch busy probe 一直看到"忙"。现在 NULL 行按 firedAt
    // 走独立的 2h 宽窗口:短期内不误杀跨版本活 run,真僵尸有界回收。
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, manual: true });
    await h.scheduler.start();
    const bornAt = h.clock.now();
    insertRunningRun(h.storage, 'run-legacy-zombie', sch.id, bornAt);
    // 心跳窗口(60s)过后仍在宽限内:不收
    for (let i = 0; i < 4; i++) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    expect(h.storage.runs.get('run-legacy-zombie')?.status).toBe('running');
    // 跨过 RUN_LEGACY_STALE_MS(以 ≤SUSPEND_GAP 步长推进避免挂起宽限;步进本身
    // 远超 2h,末段小步 tick 让 DB-sync 周期命中清扫)
    const target = bornAt + RUN_LEGACY_STALE_MS + 120_000;
    while (h.clock.now() < target) {
      h.clock.advance(25_000);
      await h.scheduler.tick();
    }
    expect(h.storage.runs.get('run-legacy-zombie')?.status).toBe('interrupted');
    await h.scheduler.stop();
  });

  it('活 run 被 10+ 条更新的终态行挤出 listRuns 窗口时,守卫仍能看见它、不误补排', async () => {
    // 回归(codex review P2):守卫曾用 listRuns(scheduleId, 10) 查活 run,长跑的
    // claim run 之后又落了 10+ 条 runNow/终态行时会被挤出窗口 → 漏判 → 误补排 →
    // due 循环在原认领仍在执行时再开一轮。现在必须走无上限的 hasRunningRuns。
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    await h.storage.update(sch.id, { nextFireAt: undefined });
    const t0 = h.clock.now();
    // 长跑中的活 claim run(心跳新鲜),firedAt 最老
    insertRunningRun(h.storage, 'run-live-old', sch.id, t0 - 600_000, t0 + 90_000);
    // 其后落库的 12 条终态行,把活 run 挤出 listRuns(…, 10) 的窗口
    for (let i = 0; i < 12; i++) {
      h.storage.runs.set(`run-done-${i}`, {
        id: `run-done-${i}`,
        scheduleId: sch.id,
        firedAt: t0 - 500_000 + i * 1_000,
        finishedAt: t0 - 499_000 + i * 1_000,
        status: 'success',
      });
    }
    // 心跳过期的僵尸,触发清扫善后
    insertRunningRun(h.storage, 'run-dead', sch.id, t0, t0);
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-dead')?.status).toBe('interrupted');
    expect(h.storage.runs.get('run-live-old')?.status).toBe('running');
    // 活 run 仍在 → 绝不能补排
    expect((await h.storage.get(sch.id))?.nextFireAt).toBeUndefined();
    await h.scheduler.stop();
  });

  it('清扫 runNow 僵尸(排期未被认领置空)→ nextFireAt 原样不动', async () => {
    const h = makeHarness();
    const sch = await h.scheduler.create({ ...baseInput, intervalMs: 3_600_000 });
    await h.scheduler.start();
    const plannedNext = (await h.storage.get(sch.id))?.nextFireAt;
    expect(plannedNext).toBeDefined();
    insertRunningRun(h.storage, 'run-manual-dead', sch.id, h.clock.now(), h.clock.now());
    await advancePastSweep(h);
    expect(h.storage.runs.get('run-manual-dead')?.status).toBe('interrupted');
    expect((await h.storage.get(sch.id))?.nextFireAt).toBe(plannedNext);
    await h.scheduler.stop();
  });
});

describe('Scheduler concurrency gate(并发闸门)', () => {
  /** runner.fire 挂起直到测试手动 resolve —— 模拟长跑 run 占用槽位。 */
  function makePendingRunner(): {
    impl: (s: Schedule, ctx: FireContext) => Promise<FireResult>;
    resolveNext: () => void;
    pendingCount: () => number;
  } {
    const pending: Array<() => void> = [];
    return {
      impl: (s: Schedule) =>
        new Promise<FireResult>((resolve) => {
          pending.push(() => resolve({ sessionId: `sess-${s.id}` }));
        }),
      resolveNext: () => {
        const r = pending.shift();
        if (r) r();
      },
      pendingCount: () => pending.length,
    };
  }

  it('in-flight 达上限时 tick 扣住到点任务;槽位释放后按等待最久优先接力', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ maxConcurrentRuns: 1, runnerImpl: runnerCtl.impl });
    // A 先到点(00:01:00),B 后到点(00:02:00)
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 10));
    const b = await h.scheduler.create({ ...baseInput, name: 'B' });
    expect(a.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 1, 0));
    expect(b.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 2, 0));

    // 两个都到点,cap=1 → 只放行等得最久的 A
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 2, 5));
    const tick1 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    expect(h.fireCalls[0].schedule.id).toBe(a.id);

    // A 还在跑 → 后续 tick 不放行 B(B 留在队列,不丢)
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(1);

    // A 跑完释放槽位 → 下个 tick 接力放行 B
    runnerCtl.resolveNext();
    await tick1;
    const tick2 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(2));
    expect(h.fireCalls[1].schedule.id).toBe(b.id);
    runnerCtl.resolveNext();
    await tick2;
  });

  it('未配置时默认上限 DEFAULT_MAX_CONCURRENT_RUNS,同 tick 只放行上限数量', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ runnerImpl: runnerCtl.impl });
    const total = DEFAULT_MAX_CONCURRENT_RUNS + 2;
    for (let i = 0; i < total; i++) {
      await h.scheduler.create({ ...baseInput, name: `S${i}` });
    }
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tick1 = h.scheduler.tick();
    await vi.waitFor(() =>
      expect(h.runner.fire).toHaveBeenCalledTimes(DEFAULT_MAX_CONCURRENT_RUNS),
    );
    // 再 tick 也不超发
    await h.scheduler.tick();
    expect(h.runner.fire).toHaveBeenCalledTimes(DEFAULT_MAX_CONCURRENT_RUNS);
    // 首批跑完释放槽位 → 下个 tick 放行剩余 2 个
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_RUNS; i++) runnerCtl.resolveNext();
    await tick1;
    const tick2 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(total));
    runnerCtl.resolveNext();
    runnerCtl.resolveNext();
    await tick2;
  });

  it('runNow 不受闸门拦截(用户显式动作),但计入 in-flight 占用', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ maxConcurrentRuns: 1, runnerImpl: runnerCtl.impl });
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    const b = await h.scheduler.create({ ...baseInput, name: 'B' });

    // A 经 tick 占满唯一槽位
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tick1 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    expect(h.fireCalls[0].schedule.id).toBe(a.id);

    // 槽位已满,runNow(B) 仍然立即执行
    const runNowP = h.scheduler.runNow(b.id);
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(2));
    expect(h.fireCalls[1].schedule.id).toBe(b.id);

    runnerCtl.resolveNext();
    runnerCtl.resolveNext();
    await tick1;
    await runNowP;

    // 锁定既有语义:手动 runNow **不消耗** cron 槽位(runNow 注释:「nextFireAt
    // 不动 —— 手动触发不应改变下一次按 cron 排定的时间」)。B 排队期间被手动跑过,
    // 槽位释放后下个 tick 仍按计划把 B 的这次到点触发补上 —— 闸门只延后计划触发,
    // 不改变「手动与计划相互独立」的语义。
    const tick2 = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(3));
    expect(h.fireCalls[2].schedule.id).toBe(b.id);
    runnerCtl.resolveNext();
    await tick2;
  });

  it('runtime snapshot 精确列出 in-flight 来源和真实排队任务', async () => {
    const runnerCtl = makePendingRunner();
    const runtimeEvents: unknown[] = [];
    const info = vi.fn();
    const h = makeHarness({
      maxConcurrentRuns: 1,
      runnerImpl: runnerCtl.impl,
      logger: { info },
    });
    h.scheduler.on('runtime-state', (event) => runtimeEvents.push(event.snapshot));
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    const b = await h.scheduler.create({
      ...baseInput,
      name: 'B',
      executionMode: 'script',
      workspaceKind: 'project',
      workingDir: '/repo',
      scriptConfig: { command: 'node task.mjs', capabilities: [] },
    });

    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const tick = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));

    const snapshot = h.scheduler.getRuntimeSnapshot();
    expect(snapshot).toMatchObject({
      schedulerInstanceId: 'test-scheduler',
      processId: 1234,
      inFlight: 1,
      maxConcurrentRuns: 1,
    });
    expect(snapshot.inFlightRuns).toEqual([
      expect.objectContaining({
        scheduleId: a.id,
        scheduleName: 'A',
        source: 'automatic',
        executionMode: 'agent',
        slotWaitMs: 5_000,
        phase: 'running',
      }),
    ]);
    expect(snapshot.waitingSchedules).toEqual([
      { scheduleId: b.id, scheduleName: 'B', waitingSince: b.nextFireAt },
    ]);
    expect(info).toHaveBeenCalledWith(
      'scheduler: concurrency gate holding due fires',
      expect.objectContaining({
        schedulerInstanceId: 'test-scheduler',
        processId: 1234,
        inFlightRuns: [
          expect.objectContaining({ scheduleId: a.id, source: 'automatic', phase: 'claiming' }),
        ],
        gatedSchedules: [expect.objectContaining({ scheduleId: b.id, scheduleName: 'B' })],
      }),
    );
    expect(runtimeEvents.length).toBeGreaterThan(0);

    runnerCtl.resolveNext();
    await tick;
  });

  it('runNow 合法超额时标明来源，完成终态仍配对释放', async () => {
    const info = vi.fn();
    const runnerCtl = makePendingRunner();
    const h = makeHarness({
      maxConcurrentRuns: 1,
      runnerImpl: runnerCtl.impl,
      logger: { info },
    });
    const a = await h.scheduler.create({ ...baseInput, name: 'A' });
    const b = await h.scheduler.create({ ...baseInput, name: 'B' });
    h.clock.setTo(Date.UTC(2026, 0, 1, 0, 1, 5));
    const automatic = h.scheduler.tick();
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    const manual = h.scheduler.runNow(b.id);
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(2));

    expect(h.scheduler.getRuntimeSnapshot().inFlightRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scheduleId: a.id, source: 'automatic' }),
        expect.objectContaining({ scheduleId: b.id, source: 'run-now' }),
      ]),
    );
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(2);

    runnerCtl.resolveNext();
    runnerCtl.resolveNext();
    await automatic;
    await manual;
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run registered')).toHaveLength(2);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run released')).toHaveLength(2);
  });

  it('stop 立即清空结构化占用，迟到 finally 不会把计数减成负数', async () => {
    const runnerCtl = makePendingRunner();
    const h = makeHarness({ runnerImpl: runnerCtl.impl });
    const schedule = await h.scheduler.create({ ...baseInput });
    const run = h.scheduler.runNow(schedule.id);
    await vi.waitFor(() => expect(h.runner.fire).toHaveBeenCalledTimes(1));
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(1);

    await h.scheduler.stop();
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    runnerCtl.resolveNext();
    await run;
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
  });

  it('runner 抛错时也释放结构化占用', async () => {
    const info = vi.fn();
    const h = makeHarness({
      runnerImpl: async () => {
        throw new Error('runner exploded');
      },
      logger: { info },
    });
    const schedule = await h.scheduler.create({ ...baseInput });

    await expect(h.scheduler.runNow(schedule.id)).resolves.toEqual({ runId: expect.any(String) });
    expect(h.scheduler.getRuntimeSnapshot().inFlight).toBe(0);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run registered')).toHaveLength(1);
    expect(info.mock.calls.filter(([message]) => message === 'scheduler: in-flight run released')).toHaveLength(1);
  });
});
