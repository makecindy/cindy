/**
 * cindy_schedulerMcpServer smoke test.
 *
 * 用 MCP SDK 真实 Client + InMemoryTransport pair（@modelcontextprotocol/sdk
 * 提供的 in-process transport）连真 `createSchedulerMcpServer`，端到端验证：
 *
 *   - list_tools 入口：无参数 → 返回 categories；传 category='scheduler' → 11 个 tool
 *   - call_tool 入口：透传到 SchedulerToolRegistry；正确分发 handler
 *   - 真 Scheduler（InMemoryStorage + mock runner）的 create / list / get /
 *     run_now / list_runs 行为透传给 MCP 调用方时形态正确
 *   - MCP 错误码翻译契约：
 *       * UNKNOWN_TOOL — 调不存在的 tool
 *       * INVALID_ARGS — zod schema 校验失败（带 schema 自纠 payload）
 *       * NOT_FOUND    — Scheduler 抛 'schedule {id} not found'
 *       * SCHEDULER_NOT_READY — getScheduler() 抛 'scheduler not started'
 *
 * 不 cover 的边界（仍需在 desktop 端到端验证）：
 *   - cc / codex agent 把 cindy_scheduler provider 拼进 mcpServers config 的 spawn 链
 *   - 真 LLM 模型在对话里能 discovery 并调用这些 tool
 *   - GUI 列表 onEvent 推送实时刷新
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Scheduler } from '@cindy/maker-scheduler';
import type {
  CreateScheduleInput,
  ListFilter,
  Schedule,
  ScheduleRun,
} from '@cindy/maker-scheduler';
import type { ScheduleStorage } from '@cindy/maker-scheduler';
import type { FireContext, ScheduleRunner } from '@cindy/maker-scheduler';

import { createSchedulerMcpServer } from '../cindy_schedulerMcpServer.js';
import { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import { registerScheduleDeleteTool } from '../scheduler/delete.js';
import { registerScheduleNotifyCurrentRunTool } from '../scheduler/notifyCurrentRun.js';
import { registerSchedulePauseTool } from '../scheduler/pause.js';
import { registerScheduleSilenceCurrentRunTool } from '../scheduler/silenceCurrentRun.js';
import { registerScheduleCreateTool } from '../scheduler/create.js';
import { registerScheduleUpdateTool } from '../scheduler/update.js';
import { registerScheduleSetPreRunHookTool } from '../scheduler/setPreRunHook.js';
import type { LiziMcpSessionContext } from '../types.js';

// ── In-memory ScheduleStorage / Runner / Clock (same shape as Phase 1 tests) ──

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
  async listRuns(scheduleId: string): Promise<ScheduleRun[]> {
    return [...this.runs.values()].filter((r) => r.scheduleId === scheduleId);
  }
  async deleteRun(id: string): Promise<ScheduleRun | null> {
    const ex = this.runs.get(id);
    if (!ex) return null;
    this.runs.delete(id);
    return { ...ex };
  }
  async markRunningAsInterrupted(): Promise<string[]> {
    return [];
  }
  async touchRunHeartbeats(): Promise<void> {}
  async hasRunningRuns(scheduleId?: string): Promise<boolean> {
    return [...this.runs.values()].some(
      (r) => r.status === 'running' && (scheduleId === undefined || r.scheduleId === scheduleId),
    );
  }
  // 与真实现相同的 CAS 语义:active 且 nextFireAt 精确匹配才认领(置空),否则 null。
  async claimDueFire(id: string, expectedNextFireAt: number): Promise<Schedule | null> {
    const ex = this.schedules.get(id);
    if (!ex || ex.status !== 'active' || ex.nextFireAt !== expectedNextFireAt) return null;
    ex.nextFireAt = undefined;
    return { ...ex };
  }
}

class FakeClock {
  current = Date.UTC(2026, 0, 1, 0, 0, 30); // 2026-01-01 00:00:30 UTC
  now(): number {
    return this.current;
  }
}

function makeIdGen(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const noopRunner: ScheduleRunner = {
  fire: async (s: Schedule, ctx: FireContext) => ({ sessionId: `sess-${s.id}-${ctx.runId}` }),
};

const baseCreate: CreateScheduleInput = {
  name: 'phase5-smoke',
  prompt: '/standup',
  kind: 'cron',
  cronExpr: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  recurring: true,
  agentKind: 'claude-code',
  workingDir: 'D:/repo',
  useWorktree: false,
  notify: { desktop: true, feishu: false },
};

// ── Test harness: real MCP server + real Client over in-memory transport ────

interface Harness {
  client: Client;
  scheduler: Scheduler;
  storage: InMemoryStorage;
  cleanup: () => Promise<void>;
}

async function makeHarness(opts?: {
  schedulerNotReady?: boolean;
}): Promise<Harness> {
  const storage = new InMemoryStorage();
  const clock = new FakeClock();
  const scheduler = new Scheduler({
    storage,
    runner: noopRunner,
    clock,
    generateId: makeIdGen(),
    tickIntervalMs: 60_000_000, // effectively disabled
  });
  // Don't start() — tests don't need the tick loop, and `start()` would try
  // to compute nextFireAt for any pre-existing actives (none here).

  const server = createSchedulerMcpServer({
    getScheduler: () => {
      if (opts?.schedulerNotReady) {
        throw new Error('scheduler not started');
      }
      return scheduler;
    },
  });

  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'phase5-smoke-client', version: '0.0.0' });

  await Promise.all([
    server.connect(serverTx),
    client.connect(clientTx),
  ]);

  return {
    client,
    scheduler,
    storage,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// Helpers to extract the JSON envelope our handlers wrap responses with.
type ToolResultEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string };

function parseToolResult(result: { content: unknown[]; isError?: boolean }): {
  envelope: ToolResultEnvelope;
  isError: boolean;
} {
  const first = result.content[0] as { type: string; text: string } | undefined;
  expect(first?.type).toBe('text');
  return {
    envelope: JSON.parse(first!.text) as ToolResultEnvelope,
    isError: result.isError === true,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cindy_scheduler MCP server (in-process smoke)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  it('list_tools without category returns the scheduler category', async () => {
    const result = await h.client.callTool({ name: 'list_tools', arguments: {} });
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(first.text) as {
      ok: boolean;
      categories: { name: string; tool_count: number }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.categories).toEqual([{ name: 'scheduler', tool_count: 11 }]);
    await h.cleanup();
  });

  it('list_tools(category=scheduler) lists all 11 tools by name', async () => {
    const result = await h.client.callTool({
      name: 'list_tools',
      arguments: { category: 'scheduler' },
    });
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(first.text) as {
      ok: boolean;
      tools: { name: string }[];
    };
    expect(payload.ok).toBe(true);
    const names = payload.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'schedule_create',
      'schedule_delete',
      'schedule_get',
      'schedule_list',
      'schedule_list_runs',
      'schedule_notify_current_run',
      'schedule_pause',
      'schedule_resume',
      'schedule_run_now',
      'schedule_silence_current_run',
      'schedule_update',
    ]);
    await h.cleanup();
  });

  it('call_tool(schedule_create) creates a schedule and call_tool(schedule_list) returns it (same payload as scheduler.list)', async () => {
    // schedule_create
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: baseCreate as unknown as Record<string, unknown> },
    });
    const { envelope, isError } = parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(false);
    expect(envelope).toMatchObject({ ok: true });
    if (!envelope.ok) throw new Error('unreachable');
    const createdData = envelope.data as Schedule;
    expect(createdData.id).toBeDefined();
    expect(createdData.name).toBe('phase5-smoke');
    expect(createdData.cronExpr).toBe('0 9 * * *');
    expect(createdData.notify).toEqual({ desktop: true, feishu: false });
    expect(typeof createdData.nextFireAt).toBe('number');

    // schedule_list — verify the same payload shape as scheduler.list().
    const listed = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_list', args: {} },
    });
    const listedEnv = parseToolResult(listed as { content: unknown[]; isError?: boolean }).envelope;
    if (!listedEnv.ok) throw new Error('unreachable');
    const fromMcp = listedEnv.data as Schedule[];
    const fromScheduler = await h.scheduler.list();
    expect(fromMcp).toEqual(fromScheduler);
    expect(fromMcp).toHaveLength(1);
    expect(fromMcp[0]).toEqual(createdData);

    await h.cleanup();
  });

  it('call_tool(schedule_create) accepts agentKind: pi as a first-class scheduled agent', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_create',
        args: { ...baseCreate, name: 'pi-scheduled', agentKind: 'pi' } as unknown as Record<string, unknown>,
      },
    });
    const { envelope, isError } = parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(false);
    expect(envelope).toMatchObject({ ok: true });
    if (!envelope.ok) throw new Error('unreachable');
    const createdData = envelope.data as Schedule;
    expect(createdData.agentKind).toBe('pi');

    await h.cleanup();
  });

  it('call_tool(schedule_create) accepts intervalMs and schedules first fire relative to creation time', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_create',
        args: {
          ...baseCreate,
          cronExpr: '*/10 * * * *',
          intervalMs: 10 * 60_000,
        } as unknown as Record<string, unknown>,
      },
    });
    const { envelope, isError } = parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(false);
    expect(envelope).toMatchObject({ ok: true });
    if (!envelope.ok) throw new Error('unreachable');
    const createdData = envelope.data as Schedule;
    expect(createdData.intervalMs).toBe(10 * 60_000);
    expect(createdData.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));

    await h.cleanup();
  });

  it('call_tool(schedule_update) accepts intervalMs and reschedules from now', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: baseCreate as unknown as Record<string, unknown> },
    });
    const createdData = (parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    ).envelope as { ok: true; data: Schedule }).data;

    const updated = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: {
          id: createdData.id,
          cronExpr: '*/10 * * * *',
          intervalMs: 10 * 60_000,
        },
      },
    });
    const { envelope, isError } = parseToolResult(
      updated as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(false);
    expect(envelope).toMatchObject({ ok: true });
    if (!envelope.ok) throw new Error('unreachable');
    const updatedData = envelope.data as Schedule;
    expect(updatedData.intervalMs).toBe(10 * 60_000);
    expect(updatedData.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 10, 30));

    await h.cleanup();
  });

  it('call_tool(schedule_create) with intervalMs rejects invalid cronExpr (INVALID_PARAMS)', async () => {
    // intervalMs 模式下引擎不解析 cronExpr,工具层必须补回校验,否则非法 cron 静默落库。
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_create',
        args: {
          ...baseCreate,
          cronExpr: 'not a cron',
          intervalMs: 10 * 60_000,
        } as unknown as Record<string, unknown>,
      },
    });
    const { envelope, isError } = parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(true);
    expect(envelope).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });

    await h.cleanup();
  });

  it('call_tool(schedule_create) with intervalMs rejects invalid timezone (INVALID_PARAMS)', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_create',
        args: {
          ...baseCreate,
          cronExpr: '*/10 * * * *',
          timezone: 'Not/AZone',
          intervalMs: 10 * 60_000,
        } as unknown as Record<string, unknown>,
      },
    });
    const { envelope, isError } = parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(true);
    expect(envelope).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });

    await h.cleanup();
  });

  it('call_tool(schedule_update) with intervalMs rejects invalid cronExpr (INVALID_PARAMS)', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: baseCreate as unknown as Record<string, unknown> },
    });
    const createdData = (parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    ).envelope as { ok: true; data: Schedule }).data;

    const updated = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: {
          id: createdData.id,
          cronExpr: 'bogus */10',
          intervalMs: 10 * 60_000,
        },
      },
    });
    const { envelope, isError } = parseToolResult(
      updated as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(true);
    expect(envelope).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });

    await h.cleanup();
  });

  it('call_tool(schedule_run_now) returns runId, does not change nextFireAt, and list_runs sees the run', async () => {
    // arrange: create
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: baseCreate as unknown as Record<string, unknown> },
    });
    const createdData = (parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    ).envelope as { ok: true; data: Schedule }).data;
    const before = createdData.nextFireAt;

    // act: run_now
    const runResult = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_run_now', args: { id: createdData.id } },
    });
    const runEnv = parseToolResult(
      runResult as { content: unknown[]; isError?: boolean },
    ).envelope as { ok: true; data: { runId: string } };
    expect(typeof runEnv.data.runId).toBe('string');
    expect(runEnv.data.runId).toBeTruthy();

    // assert: nextFireAt unchanged
    const after = await h.scheduler.get(createdData.id);
    expect(after?.nextFireAt).toBe(before);

    // assert: list_runs sees a success run
    const runs = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_list_runs', args: { scheduleId: createdData.id } },
    });
    const runsEnv = parseToolResult(runs as { content: unknown[]; isError?: boolean }).envelope as {
      ok: true;
      data: ScheduleRun[];
    };
    expect(runsEnv.data).toHaveLength(1);
    expect(runsEnv.data[0].status).toBe('success');
    expect(runsEnv.data[0].sessionId).toContain('sess-');

    await h.cleanup();
  });

  it('call_tool(unknown name) returns UNKNOWN_TOOL with the available list', async () => {
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_does_not_exist', args: {} },
    });
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(first.text) as {
      ok: false;
      errorCode: string;
      data: { available: string[] };
    };
    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('UNKNOWN_TOOL');
    expect(payload.data.available).toContain('schedule_create');
    await h.cleanup();
  });

  it('call_tool(schedule_create, missing required field) returns INVALID_ARGS with schema', async () => {
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: { name: 'x' } /* missing prompt/cron/etc */ },
    });
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(first.text) as {
      ok: false;
      errorCode: string;
      data: { schema: unknown; validation_errors: unknown[] };
    };
    expect(result.isError).toBe(true);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(payload.data.schema).toBeDefined();
    expect(Array.isArray(payload.data.validation_errors)).toBe(true);
    await h.cleanup();
  });

  it('call_tool(schedule_create, invalid effort) — non-whitelist effort caught at zod (INVALID_ARGS)', async () => {
    const args = { ...baseCreate, effort: 'turbo' } as unknown as Record<string, unknown>;
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args },
    });
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(first.text) as { ok: false; errorCode: string };
    expect(result.isError).toBe(true);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    await h.cleanup();
  });

  it('call_tool(schedule_get, non-existent id) returns ok:true data:null (Scheduler.get is null-safe)', async () => {
    // schedule_get returns null when not found per Scheduler API; we透传 null.
    // (compare: schedule_run_now / schedule_pause / etc throw 'not found'.)
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_get', args: { id: 'does-not-exist' } },
    });
    const env = parseToolResult(result as { content: unknown[]; isError?: boolean }).envelope;
    expect(env).toEqual({ ok: true, data: null });
    await h.cleanup();
  });

  it('call_tool(schedule_run_now, non-existent id) returns NOT_FOUND', async () => {
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_run_now', args: { id: 'does-not-exist' } },
    });
    const env = parseToolResult(result as { content: unknown[]; isError?: boolean }).envelope;
    expect(env).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    if (env.ok) throw new Error('unreachable');
    expect(env.message).toMatch(/not found/i);
    await h.cleanup();
  });

  // ── script 模式(仅运行脚本,executionMode='script')────────────────────────

  const scriptCreate = {
    name: 'script-task',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'codex',
    workingDir: 'D:/repo',
    notify: { desktop: true, feishu: false },
    executionMode: 'script',
    scriptConfig: { command: 'python auto.py', capabilities: ['jira.read', 'sessions.dispatch'] },
  } as unknown as Record<string, unknown>;

  it('call_tool(schedule_create, executionMode=script) creates a script schedule without prompt', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: scriptCreate },
    });
    const { envelope, isError } = parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    );
    expect(isError).toBe(false);
    if (!envelope.ok) throw new Error('unreachable');
    const data = envelope.data as Schedule;
    expect(data.executionMode).toBe('script');
    expect(data.scriptConfig).toEqual({
      command: 'python auto.py',
      capabilities: ['jira.read', 'sessions.dispatch'],
    });
    expect(data.prompt).toBe('');
    expect(data.workspaceKind).toBe('project');
    await h.cleanup();
  });

  it('call_tool(schedule_create, script without scriptConfig) returns INVALID_PARAMS', async () => {
    const { scriptConfig: _omit, ...rest } = scriptCreate;
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: rest },
    });
    const env = parseToolResult(result as { content: unknown[]; isError?: boolean }).envelope;
    expect(env).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    if (env.ok) throw new Error('unreachable');
    expect(env.message).toContain('scriptConfig.command');
    await h.cleanup();
  });

  it('call_tool(schedule_create, script + bound-session/worktree combos) returns INVALID_PARAMS', async () => {
    for (const extra of [
      { persistentSession: true },
      { useWorktree: true },
      { bindToCurrentSession: true },
    ]) {
      const result = await h.client.callTool({
        name: 'call_tool',
        arguments: { name: 'schedule_create', args: { ...scriptCreate, ...extra } },
      });
      const env = parseToolResult(result as { content: unknown[]; isError?: boolean }).envelope;
      expect(env).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    }
    await h.cleanup();
  });

  it('call_tool(schedule_create, agent mode without prompt) returns INVALID_PARAMS', async () => {
    const { prompt: _omit, ...rest } = baseCreate as unknown as Record<string, unknown>;
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: rest },
    });
    const env = parseToolResult(result as { content: unknown[]; isError?: boolean }).envelope;
    expect(env).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    if (env.ok) throw new Error('unreachable');
    expect(env.message).toContain('prompt');
    await h.cleanup();
  });

  it('call_tool(schedule_update) can switch an agent schedule to script mode and back', async () => {
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_create', args: baseCreate as unknown as Record<string, unknown> },
    });
    const createdData = (parseToolResult(
      created as { content: unknown[]; isError?: boolean },
    ).envelope as { ok: true; data: Schedule }).data;

    // agent → script(patch 同时带 scriptConfig)
    const toScript = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: {
          id: createdData.id,
          executionMode: 'script',
          scriptConfig: { command: 'node run.mjs', capabilities: [] },
        },
      },
    });
    const scriptEnv = parseToolResult(toScript as { content: unknown[]; isError?: boolean }).envelope;
    if (!scriptEnv.ok) throw new Error(`unexpected: ${JSON.stringify(scriptEnv)}`);
    expect((scriptEnv.data as Schedule).executionMode).toBe('script');
    expect((scriptEnv.data as Schedule).scriptConfig?.command).toBe('node run.mjs');

    // script 状态下清空 scriptConfig(不切回 agent)→ 引擎合并态校验拦下
    const badClear = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: { id: createdData.id, scriptConfig: null },
      },
    });
    const badEnv = parseToolResult(badClear as { content: unknown[]; isError?: boolean }).envelope;
    expect(badEnv).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    if (badEnv.ok) throw new Error('unreachable');
    expect(badEnv.message).toMatch(/script execution/i);

    // script → agent(同时清 scriptConfig)
    const toAgent = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: { id: createdData.id, executionMode: 'agent', scriptConfig: null },
      },
    });
    const agentEnv = parseToolResult(toAgent as { content: unknown[]; isError?: boolean }).envelope;
    if (!agentEnv.ok) throw new Error(`unexpected: ${JSON.stringify(agentEnv)}`);
    expect((agentEnv.data as Schedule).executionMode).toBe('agent');
    expect((agentEnv.data as Schedule).scriptConfig).toBeUndefined();

    await h.cleanup();
  });

  it('call_tool(schedule_update, targetSessionId=null) unbinds so a bound schedule can switch to script mode (codex review 966)', async () => {
    // 已绑定会话的任务:schema 只收 string 或缺省时,JSON 调用方拼不出"解绑"的
    // 合法 patch(缺省 = 不修改),也就永远切不成 script 模式——null 必须被翻译
    // 成 key 在但值 undefined 的引擎语义(同 preRunHook 约定)。
    const created = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_create',
        args: { ...baseCreate, targetSessionId: 'sess-bound-1' } as unknown as Record<string, unknown>,
      },
    });
    const createdEnv = parseToolResult(created as { content: unknown[]; isError?: boolean }).envelope;
    if (!createdEnv.ok) throw new Error(`unexpected: ${JSON.stringify(createdEnv)}`);
    expect((createdEnv.data as Schedule).targetSessionId).toBe('sess-bound-1');
    const id = (createdEnv.data as Schedule).id;

    // 不解绑直接切 script → 引擎合并态校验拦下(绑定与 script 互斥)
    const stillBound = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: {
          id,
          executionMode: 'script',
          scriptConfig: { command: 'node run.mjs', capabilities: [] },
        },
      },
    });
    const stillBoundEnv = parseToolResult(stillBound as { content: unknown[]; isError?: boolean }).envelope;
    expect(stillBoundEnv).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });

    // targetSessionId: null 解绑 + 切 script,一个 patch 完成
    const unboundToScript = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'schedule_update',
        args: {
          id,
          targetSessionId: null,
          executionMode: 'script',
          scriptConfig: { command: 'node run.mjs', capabilities: [] },
        },
      },
    });
    const okEnv = parseToolResult(unboundToScript as { content: unknown[]; isError?: boolean }).envelope;
    if (!okEnv.ok) throw new Error(`unexpected: ${JSON.stringify(okEnv)}`);
    expect((okEnv.data as Schedule).executionMode).toBe('script');
    expect((okEnv.data as Schedule).targetSessionId).toBeUndefined();

    await h.cleanup();
  });
});

describe('cindy_scheduler MCP server — SCHEDULER_NOT_READY', () => {
  it('returns SCHEDULER_NOT_READY when getScheduler() throws "scheduler not started"', async () => {
    const h = await makeHarness({ schedulerNotReady: true });
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'schedule_list', args: {} },
    });
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(first.text) as { ok: false; code: string; message: string };
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('SCHEDULER_NOT_READY');
    expect(payload.message).toMatch(/scheduler not started/i);
    await h.cleanup();
  });
});

// ── schedule_silence_current_run: 按 session 自动定位 runId 的分支逻辑 ──────────
//
// 直接在 SchedulerToolRegistry 上注册该工具(fake scheduler + 可配 getSessionContext),
// 调 registry.call 验证四条分支,无需起 MCP transport / 真 fire。

describe('schedule_silence_current_run — runId resolution branches', () => {
  interface FakeScheduler {
    resolveInflightRunForSession: (sessionId: string) => string | undefined;
    silenceRun: (runId: string) => boolean;
    silencedArg?: string;
  }

  function setup(opts: {
    sessionId?: string;
    inflightRunForSession?: string | undefined;
    silenceReturns?: boolean;
  }) {
    const fake: FakeScheduler = {
      resolveInflightRunForSession: () => opts.inflightRunForSession,
      silenceRun: (runId: string) => {
        fake.silencedArg = runId;
        return opts.silenceReturns ?? true;
      },
    };
    const registry = new SchedulerToolRegistry();
    const sessionCtx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: '/x',
      sessionId: opts.sessionId,
    };
    registerScheduleSilenceCurrentRunTool(
      registry,
      // deps：只需 getScheduler 返回 fake
      { getScheduler: () => fake as never },
      () => sessionCtx,
    );
    return { fake, registry };
  }

  async function callSilence(
    registry: SchedulerToolRegistry,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; code?: string; message?: string }> {
    const res = await registry.call('schedule_silence_current_run', args);
    const text = (res.content[0] as { text: string }).text;
    return JSON.parse(text);
  }

  it('sessionId 已知 + 有 in-flight run → 解析并静默该 run(忽略传入的 runId)', async () => {
    const { fake, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: 'run-owned',
    });
    // 即便 agent 错传了别的 runId,也只命中按 session 解析出的本轮 run
    const env = await callSilence(registry, { runId: 'run-someone-else' });
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ silenced: true, runId: 'run-owned' });
    expect(fake.silencedArg).toBe('run-owned');
  });

  it('sessionId 已知 + 无 in-flight run → NOT_FOUND(不回退到传入 runId)', async () => {
    const { fake, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: undefined,
    });
    const env = await callSilence(registry, { runId: 'run-x' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('NOT_FOUND');
    expect(fake.silencedArg).toBeUndefined(); // 未尝试静默任何 run
  });

  it('sessionId 未知 + 传了 runId → 回退用该 runId 静默', async () => {
    const { fake, registry } = setup({ sessionId: undefined });
    const env = await callSilence(registry, { runId: 'run-fallback' });
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ silenced: true, runId: 'run-fallback' });
    expect(fake.silencedArg).toBe('run-fallback');
  });

  it('sessionId 未知 + 未传 runId → NOT_FOUND', async () => {
    const { registry } = setup({ sessionId: undefined });
    const env = await callSilence(registry, {});
    expect(env.ok).toBe(false);
    expect(env.code).toBe('NOT_FOUND');
  });
});

describe('schedule_notify_current_run — runId resolution branches', () => {
  interface FakeScheduler {
    resolveInflightRunForSession: (sessionId: string) => string | undefined;
    notifyRun: (runId: string) => boolean;
    notifiedArg?: string;
  }

  function setup(opts: {
    sessionId?: string;
    inflightRunForSession?: string | undefined;
    notifyReturns?: boolean;
  }) {
    const fake: FakeScheduler = {
      resolveInflightRunForSession: () => opts.inflightRunForSession,
      notifyRun: (runId: string) => {
        fake.notifiedArg = runId;
        return opts.notifyReturns ?? true;
      },
    };
    const registry = new SchedulerToolRegistry();
    const sessionCtx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: '/x',
      sessionId: opts.sessionId,
    };
    registerScheduleNotifyCurrentRunTool(
      registry,
      { getScheduler: () => fake as never },
      () => sessionCtx,
    );
    return { fake, registry };
  }

  async function callNotify(
    registry: SchedulerToolRegistry,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; code?: string; message?: string }> {
    const res = await registry.call('schedule_notify_current_run', args);
    const text = (res.content[0] as { text: string }).text;
    return JSON.parse(text);
  }

  it('sessionId 已知 + 有 in-flight run → 解析并主动上报该 run(忽略传入的 runId)', async () => {
    const { fake, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: 'run-owned',
    });
    const env = await callNotify(registry, { runId: 'run-someone-else' });
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ notified: true, runId: 'run-owned' });
    expect(fake.notifiedArg).toBe('run-owned');
  });

  it('sessionId 已知 + 无 in-flight run → NOT_FOUND(不回退到传入 runId)', async () => {
    const { fake, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: undefined,
    });
    const env = await callNotify(registry, { runId: 'run-x' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('NOT_FOUND');
    expect(fake.notifiedArg).toBeUndefined();
  });

  it('sessionId 未知 + 传了 runId → 回退用该 runId 主动上报', async () => {
    const { fake, registry } = setup({ sessionId: undefined });
    const env = await callNotify(registry, { runId: 'run-fallback' });
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ notified: true, runId: 'run-fallback' });
    expect(fake.notifiedArg).toBe('run-fallback');
  });
});

// ── schedule_create: bindToCurrentSession 按 ctx 自动绑定 targetSessionId ───────

describe('schedule_create — bindToCurrentSession', () => {
  function setup(sessionId?: string) {
    const created: { input?: { targetSessionId?: string } } = {};
    const fakeScheduler = {
      create: (input: { targetSessionId?: string }) => {
        created.input = input;
        return { id: 'new-sched', ...input };
      },
    };
    const registry = new SchedulerToolRegistry();
    const sessionCtx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: '/x',
      sessionId,
    };
    registerScheduleCreateTool(
      registry,
      { getScheduler: () => fakeScheduler as never },
      () => sessionCtx,
    );
    return { created, registry };
  }

  const baseArgs = {
    name: 't',
    prompt: 'p',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'claude-code',
    notify: { desktop: true, feishu: false },
  };

  async function callCreate(registry: SchedulerToolRegistry, extra: Record<string, unknown>) {
    const res = await registry.call('schedule_create', { ...baseArgs, ...extra });
    return JSON.parse((res.content[0] as { text: string }).text) as {
      ok: boolean;
      code?: string;
    };
  }

  it('bindToCurrentSession=true + ctx 有 sessionId → targetSessionId 自动绑为当前会话(覆盖 agent 传的)', async () => {
    const { created, registry } = setup('sess-current');
    const env = await callCreate(registry, {
      bindToCurrentSession: true,
      targetSessionId: 'sess-WRONG-stale', // 模拟 agent 复用了过期 id
    });
    expect(env.ok).toBe(true);
    expect(created.input?.targetSessionId).toBe('sess-current');
  });

  it('bindToCurrentSession=true + 无 ctx sessionId → INVALID_PARAMS,不创建', async () => {
    const { created, registry } = setup(undefined);
    const env = await callCreate(registry, { bindToCurrentSession: true });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('INVALID_PARAMS');
    expect(created.input).toBeUndefined();
  });

  it('不设 bindToCurrentSession → 沿用 agent 传的 targetSessionId(向后兼容)', async () => {
    const { created, registry } = setup('sess-current');
    const env = await callCreate(registry, { targetSessionId: 'sess-explicit' });
    expect(env.ok).toBe(true);
    expect(created.input?.targetSessionId).toBe('sess-explicit');
  });
});

// ── schedule_update: intervalMs / preRunHook.timeoutMs 的真 partial 边界翻译 ─────

describe('schedule_update — partial 语义的 JSON 边界翻译', () => {
  function setup(existing: Partial<Schedule> = {}) {
    const updated: { id?: string; patch?: Record<string, unknown> } = {};
    const fakeScheduler = {
      updateFromCurrent: async (
        id: string,
        buildPatch: (current: Schedule) => Promise<Record<string, unknown>>,
      ) => {
        const patch = await buildPatch({ id, ...existing } as Schedule);
        updated.id = id;
        updated.patch = patch;
        return { id, ...existing, ...patch };
      },
    };
    const registry = new SchedulerToolRegistry();
    registerScheduleUpdateTool(registry, {
      getScheduler: () => fakeScheduler as never,
      // 身份 stabilizer:hook 用例只验证 timeoutMs 的 partial 语义,不测路径固化
      hookScript: { stabilizeCommand: async ({ command }: { command: string }) => command },
    } as never);
    return { updated, registry };
  }

  async function callUpdate(registry: SchedulerToolRegistry, extra: Record<string, unknown>) {
    const res = await registry.call('schedule_update', { id: 'sch-1', ...extra });
    return JSON.parse((res.content[0] as { text: string }).text) as { ok: boolean; code?: string };
  }

  it('只改 prompt → patch 不含 intervalMs key(真 partial,不再需要三件套)', async () => {
    const { updated, registry } = setup({ intervalMs: 600_000 });
    const env = await callUpdate(registry, { prompt: 'new prompt' });
    expect(env.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(updated.patch ?? {}, 'intervalMs')).toBe(false);
  });

  it('intervalMs: null → 翻译成带 key 的 undefined(显式清空,回到 cron 语义)', async () => {
    const { updated, registry } = setup({ intervalMs: 600_000 });
    const env = await callUpdate(registry, { intervalMs: null });
    expect(env.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(updated.patch ?? {}, 'intervalMs')).toBe(true);
    expect(updated.patch?.intervalMs).toBeUndefined();
  });

  it('preRunHook 只改 command → 沿用任务现有 timeoutMs,不再静默清成不限时', async () => {
    const { updated, registry } = setup({
      preRunHook: { command: 'node /abs/old.mjs', timeoutMs: 180_000 },
    });
    const env = await callUpdate(registry, { preRunHook: { command: 'node /abs/new.mjs' } });
    expect(env.ok).toBe(true);
    expect(updated.patch?.preRunHook).toEqual({ command: 'node /abs/new.mjs', timeoutMs: 180_000 });
  });

  it('preRunHook.timeoutMs: null → 显式清除超时(patch 里不带 timeoutMs)', async () => {
    const { updated, registry } = setup({
      preRunHook: { command: 'node /abs/old.mjs', timeoutMs: 180_000 },
    });
    const env = await callUpdate(registry, {
      preRunHook: { command: 'node /abs/old.mjs', timeoutMs: null },
    });
    expect(env.ok).toBe(true);
    expect(updated.patch?.preRunHook).toEqual({ command: 'node /abs/old.mjs' });
  });

  it('interval 任务只 patch cronExpr 也校验表达式,无效 cron 不被静默写入', async () => {
    // 真 partial 保留原 interval → 引擎按 now + intervalMs 重排、不解析 cron;
    // 工具层必须无条件校验显式提供的 cronExpr,否则坏表达式潜伏到切回 cron 才爆。
    const { updated, registry } = setup({ intervalMs: 600_000 });
    const env = await callUpdate(registry, { cronExpr: 'not-a-cron' });
    expect(env.ok).toBe(false);
    expect(updated.patch).toBeUndefined();

    const okEnv = await callUpdate(registry, { cronExpr: '*/10 * * * *' });
    expect(okEnv.ok).toBe(true);
  });

  it('preRunHook.timeoutMs 带 key 的 undefined → 视作缺省沿用现有超时,不是清除', async () => {
    // JSON 表达不出这个形态,但进程内调用能;只有 null 才是清除
    // (copilot review 指出带 key undefined 曾漏进清空分支)。
    const { updated, registry } = setup({
      preRunHook: { command: 'node /abs/old.mjs', timeoutMs: 180_000 },
    });
    const env = await callUpdate(registry, {
      preRunHook: { command: 'node /abs/new.mjs', timeoutMs: undefined },
    });
    expect(env.ok).toBe(true);
    expect(updated.patch?.preRunHook).toEqual({ command: 'node /abs/new.mjs', timeoutMs: 180_000 });
  });
});

// ── schedule_update: bindToCurrentSession 同 create 语义 ────────────────────────

describe('schedule_update — bindToCurrentSession', () => {
  function setup(sessionId?: string) {
    const updated: { id?: string; patch?: { targetSessionId?: string } } = {};
    const fakeScheduler = {
      update: (id: string, patch: { targetSessionId?: string }) => {
        updated.id = id;
        updated.patch = patch;
        return { id, ...patch };
      },
      updateFromCurrent: async (
        id: string,
        buildPatch: (current: Schedule) => Promise<{ targetSessionId?: string }>,
      ) => fakeScheduler.update(id, await buildPatch({ id } as Schedule)),
    };
    const registry = new SchedulerToolRegistry();
    const sessionCtx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: '/x',
      sessionId,
    };
    registerScheduleUpdateTool(
      registry,
      { getScheduler: () => fakeScheduler as never },
      () => sessionCtx,
    );
    return { updated, registry };
  }

  async function callUpdate(registry: SchedulerToolRegistry, extra: Record<string, unknown>) {
    const res = await registry.call('schedule_update', { id: 'sch-1', ...extra });
    return JSON.parse((res.content[0] as { text: string }).text) as { ok: boolean; code?: string };
  }

  it('bindToCurrentSession=true + ctx 有 sessionId → patch.targetSessionId 改绑当前会话(覆盖 agent 传的旧值)', async () => {
    const { updated, registry } = setup('sess-current');
    const env = await callUpdate(registry, {
      bindToCurrentSession: true,
      targetSessionId: '6fb7-stale', // 复刻用户场景:传了过期 id
    });
    expect(env.ok).toBe(true);
    expect(updated.id).toBe('sch-1');
    expect(updated.patch?.targetSessionId).toBe('sess-current');
  });

  it('bindToCurrentSession=true + 无 ctx sessionId → INVALID_PARAMS,不更新', async () => {
    const { updated, registry } = setup(undefined);
    const env = await callUpdate(registry, { bindToCurrentSession: true });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('INVALID_PARAMS');
    expect(updated.patch).toBeUndefined();
  });
});

describe('schedule_update — pre-run hook 路径稳定化', () => {
  it('改绑会话时用旧任务目录固化未修改的相对脚本命令', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const existing = {
      id: 'sch-1',
      name: 'check',
      workingDir: '/project-a',
      preRunHook: { command: 'node scripts/check.mjs', timeoutMs: 5_000 },
    } as Schedule;
    const registry = new SchedulerToolRegistry();
    registerScheduleUpdateTool(registry, {
      getScheduler: () =>
        ({
          updateFromCurrent: async (
            _id: string,
            buildPatch: (current: Schedule) => Promise<Record<string, unknown>>,
          ) => {
            const patch = await buildPatch(existing);
            updates.push(patch);
            return { ...existing, ...patch };
          },
        }) as never,
      hookScript: {
        resolveSessionWorkDir: async (sessionId) =>
          sessionId === 'session-b' ? '/project-b' : undefined,
        stabilizeCommand: async ({ command, workingDir }) => `${command}@${workingDir}`,
        install: async () => {
          throw new Error('not used');
        },
      },
    });

    const result = await registry.call('schedule_update', {
      id: 'sch-1',
      targetSessionId: 'session-b',
      preRunHook: { command: 'node scripts/check.mjs', timeoutMs: 5_000 },
    });
    const env = JSON.parse((result.content[0] as { text: string }).text) as { ok: boolean };

    expect(env.ok).toBe(true);
    expect(updates).toEqual([
      {
        targetSessionId: 'session-b',
        preRunHook: {
          command: 'node scripts/check.mjs@/project-a',
          timeoutMs: 5_000,
        },
      },
    ]);
  });

  it('create 带 hook 但 host 未提供稳定化服务时 fail-closed', async () => {
    const create = vi.fn();
    const registry = new SchedulerToolRegistry();
    registerScheduleCreateTool(registry, {
      getScheduler: () => ({ create }) as never,
    });

    const result = await registry.call('schedule_create', {
      ...baseCreate,
      preRunHook: { command: 'node scripts/check.mjs' },
    });
    const env = JSON.parse((result.content[0] as { text: string }).text) as {
      ok: boolean;
      code?: string;
    };

    expect(env.ok).toBe(false);
    expect(env.code).toBe('INVALID_PARAMS');
    expect(create).not.toHaveBeenCalled();
  });

  it('update 已有 hook 但 host 未提供稳定化服务时 fail-closed', async () => {
    const registry = new SchedulerToolRegistry();
    const existing = {
      id: 'sch-1',
      preRunHook: { command: 'node scripts/check.mjs' },
    } as Schedule;
    registerScheduleUpdateTool(registry, {
      getScheduler: () =>
        ({
          updateFromCurrent: async (
            _id: string,
            buildPatch: (current: Schedule) => Promise<Record<string, unknown>>,
          ) => buildPatch(existing),
        }) as never,
    });

    const result = await registry.call('schedule_update', {
      id: 'sch-1',
      targetSessionId: 'session-b',
    });
    const env = JSON.parse((result.content[0] as { text: string }).text) as {
      ok: boolean;
      code?: string;
    };

    expect(env.ok).toBe(false);
    expect(env.code).toBe('INVALID_PARAMS');
  });
});

// ── 网关 strict:未知字段必须报错,不能静默丢弃 ────────────────────────────────

describe('SchedulerToolRegistry — strict args (no silent drop)', () => {
  it('传未知字段 → INVALID_ARGS(而非 ok:true 静默忽略)', async () => {
    const registry = new SchedulerToolRegistry();
    registerScheduleUpdateTool(
      registry,
      { getScheduler: () => ({ update: () => ({ id: 'x' }) }) as never },
      () => ({ agentKind: 'claude-code', workingDir: '/x', sessionId: 's' }),
    );
    // 拼错 / 不支持的字段:旧行为会被剥掉并 ok:true,strict 后必须报错
    const res = await registry.call('schedule_update', {
      id: 'sch-1',
      bindToCurrentSesion: true, // 故意拼错(少一个 s)
    });
    const env = JSON.parse((res.content[0] as { text: string }).text) as {
      ok: boolean;
      errorCode?: string;
    };
    expect(env.ok).toBe(false);
    expect(env.errorCode).toBe('INVALID_ARGS');
  });
});

// ── schedule_delete / schedule_pause: caller-ownership 豁免透传 ────────────────
//
// agent 在任务 run 内 delete/pause 自己所属的 schedule 时,MCP 层应把按调用方
// session 解析出的 in-flight runId 作为 exemptRunId 传给 engine(否则 engine 会
// abort 发起方自己这轮 run —— 自杀式竞态,真实事故:PR 心跳 merge 后删除自己)。
// fake scheduler 记录收到的 opts,验证四条分支的透传形态。

describe('schedule_delete / schedule_pause — caller-run exemption passthrough', () => {
  interface CapturedCall {
    id: string;
    opts?: { exemptRunId?: string };
  }

  function setup(opts: {
    sessionId?: string;
    inflightRunForSession?: string | undefined;
  }) {
    const captured: { delete?: CapturedCall; pause?: CapturedCall } = {};
    const fake = {
      resolveInflightRunForSession: () => opts.inflightRunForSession,
      delete: async (id: string, o?: { exemptRunId?: string }) => {
        captured.delete = { id, opts: o };
      },
      pause: async (id: string, o?: { exemptRunId?: string }) => {
        captured.pause = { id, opts: o };
        return { id, status: 'paused' };
      },
    };
    const registry = new SchedulerToolRegistry();
    const sessionCtx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: '/x',
      sessionId: opts.sessionId,
    };
    const deps = { getScheduler: () => fake as never };
    registerScheduleDeleteTool(registry, deps, () => sessionCtx);
    registerSchedulePauseTool(registry, deps, () => sessionCtx);
    return { captured, registry };
  }

  async function call(
    registry: SchedulerToolRegistry,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    const res = await registry.call(tool, args);
    return JSON.parse((res.content[0] as { text: string }).text);
  }

  it('delete:sessionId 已知 + 有 in-flight run → 透传 exemptRunId', async () => {
    const { captured, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: 'run-owned',
    });
    const env = await call(registry, 'schedule_delete', { id: 'sch-1' });
    expect(env.ok).toBe(true);
    expect(captured.delete).toEqual({ id: 'sch-1', opts: { exemptRunId: 'run-owned' } });
  });

  it('delete:sessionId 已知 + 无 in-flight run → 不传 opts(原行为)', async () => {
    const { captured, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: undefined,
    });
    const env = await call(registry, 'schedule_delete', { id: 'sch-1' });
    expect(env.ok).toBe(true);
    expect(captured.delete).toEqual({ id: 'sch-1', opts: undefined });
  });

  it('delete:sessionId 未知 → 不解析、不传 opts(原行为)', async () => {
    const { captured, registry } = setup({ sessionId: undefined });
    const env = await call(registry, 'schedule_delete', { id: 'sch-1' });
    expect(env.ok).toBe(true);
    expect(captured.delete).toEqual({ id: 'sch-1', opts: undefined });
  });

  it('pause:sessionId 已知 + 有 in-flight run → 透传 exemptRunId', async () => {
    const { captured, registry } = setup({
      sessionId: 'sess-1',
      inflightRunForSession: 'run-owned',
    });
    const env = await call(registry, 'schedule_pause', { id: 'sch-1' });
    expect(env.ok).toBe(true);
    expect(captured.pause).toEqual({ id: 'sch-1', opts: { exemptRunId: 'run-owned' } });
  });
});

// ── schedule_set_pre_run_hook: 前置检查脚本统一安装通道 ─────────────────────────
//
// fake scheduler + fake hookScript service,验证:上下文继承(scheduleId → 目录/
// 名称/现有命令)、挂载、缺参校验、host 未注入服务时不注册。

describe('schedule_set_pre_run_hook — 统一安装通道', () => {
  interface InstallCall {
    script?: string;
    description?: string;
    scheduleName?: string;
    workingDir?: string;
    currentCommand?: string;
    providerId?: string;
    agentKind?: 'codex' | 'claude-code';
    model?: string;
  }

  function setup(opts: {
    withService?: boolean;
    scheduleRow?: Record<string, unknown> | null;
    resolveSessionWorkDir?: (sessionId: string) => Promise<string | undefined>;
  }) {
    const installCalls: InstallCall[] = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const fakeScheduler = {
      get: async (_id: string) =>
        opts.scheduleRow === null ? null : (opts.scheduleRow as never),
      update: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { id, ...patch } as never;
      },
    };
    const registry = new SchedulerToolRegistry();
    registerScheduleSetPreRunHookTool(registry, {
      getScheduler: () => fakeScheduler as never,
      ...(opts.withService === false
        ? {}
        : {
            hookScript: {
              ...(opts.resolveSessionWorkDir
                ? { resolveSessionWorkDir: opts.resolveSessionWorkDir }
                : {}),
              install: async (input: InstallCall) => {
                installCalls.push(input);
                return {
                  command: 'node scripts/schedule-checks/x.mjs',
                  filePath: '/repo/scripts/schedule-checks/x.mjs',
                  content: 'process.exit(2)',
                  test: {
                    status: 'skipped' as const,
                    decision: 'skip' as const,
                    exitCode: 2,
                    timedOut: false,
                    aborted: false,
                    durationMs: 5,
                    stdout: '',
                    stderr: '',
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  },
                };
              },
            },
          }),
    });
    return { registry, installCalls, updates };
  }

  async function callTool(
    registry: SchedulerToolRegistry,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: Record<string, unknown>; errorCode?: string; code?: string; message?: string }> {
    const res = await registry.call('schedule_set_pre_run_hook', args);
    const text = (res.content[0] as { text: string }).text;
    return JSON.parse(text);
  }

  it('host 未注入 hookScript 服务 → 工具不注册(UNKNOWN_TOOL)', async () => {
    const { registry } = setup({ withService: false });
    const env = await callTool(registry, { script: 'process.exit(0)' });
    expect(env.ok).toBe(false);
    expect(env.errorCode ?? env.code).toBe('UNKNOWN_TOOL');
  });

  it('script 与 description 都缺 → INVALID_PARAMS', async () => {
    const { registry, installCalls } = setup({});
    const env = await callTool(registry, {});
    expect(env.ok).toBe(false);
    expect(env.errorCode ?? env.code).toBe('INVALID_PARAMS');
    expect(installCalls).toHaveLength(0);
  });

  it('传 scheduleId → 继承目录/名称/现有命令,安装后直接挂载', async () => {
    const { registry, installCalls, updates } = setup({
      scheduleRow: {
        id: 'sch-1',
        name: 'PR 巡检',
        workingDir: '/repo',
        providerId: 'custom-claude',
        agentKind: 'claude-code',
        model: 'claude-connect-4-6',
        preRunHook: { command: 'node scripts/schedule-checks/old.mjs' },
      },
    });
    const env = await callTool(registry, {
      scheduleId: 'sch-1',
      script: 'process.exit(2)',
    });
    expect(env.ok).toBe(true);
    expect(installCalls[0]).toMatchObject({
      script: 'process.exit(2)',
      scheduleName: 'PR 巡检',
      workingDir: '/repo',
      currentCommand: 'node scripts/schedule-checks/old.mjs',
      providerId: 'custom-claude',
      agentKind: 'claude-code',
      model: 'claude-connect-4-6',
    });
    expect(updates).toEqual([
      {
        id: 'sch-1',
        patch: { preRunHook: { command: 'node scripts/schedule-checks/x.mjs' } },
      },
    ]);
    const data = env.data as Record<string, unknown>;
    expect(data.attached).toBe(true);
    expect((data.test as Record<string, unknown>).decision).toBe('skip');
  });

  it('绑定会话任务 → 优先用 resolveSessionWorkDir 解析的会话目录落盘(schedule.workingDir 过期不用)', async () => {
    const { registry, installCalls } = setup({
      scheduleRow: {
        id: 'sch-1',
        name: 'PR 巡检',
        workingDir: '/stale/project',
        targetSessionId: 'sess-bound',
      },
      resolveSessionWorkDir: async () => '/bound/project',
    });
    const env = await callTool(registry, { scheduleId: 'sch-1', script: 'process.exit(0)' });
    expect(env.ok).toBe(true);
    expect(installCalls[0]).toMatchObject({ workingDir: '/bound/project' });
  });

  it('绑定会话但解析器缺席/失败 → 回落 schedule.workingDir 旧行为', async () => {
    const { registry, installCalls } = setup({
      scheduleRow: {
        id: 'sch-1',
        name: 'PR 巡检',
        workingDir: '/repo',
        targetSessionId: 'sess-bound',
      },
    });
    const env = await callTool(registry, { scheduleId: 'sch-1', script: 'process.exit(0)' });
    expect(env.ok).toBe(true);
    expect(installCalls[0]).toMatchObject({ workingDir: '/repo' });
  });

  it('传 scheduleId 重挂时保留任务现有 timeoutMs(修改脚本不动超时)', async () => {
    const { registry, updates } = setup({
      scheduleRow: {
        id: 'sch-1',
        name: 'PR 巡检',
        workingDir: '/repo',
        preRunHook: { command: 'node scripts/schedule-checks/old.mjs', timeoutMs: 60_000 },
      },
    });
    const env = await callTool(registry, { scheduleId: 'sch-1', script: 'process.exit(2)' });
    expect(env.ok).toBe(true);
    expect(updates).toEqual([
      {
        id: 'sch-1',
        patch: {
          preRunHook: { command: 'node scripts/schedule-checks/x.mjs', timeoutMs: 60_000 },
        },
      },
    ]);
  });

  it('不传 scheduleId → 只落盘返回 command,不挂载', async () => {
    const { registry, updates } = setup({});
    const env = await callTool(registry, { description: 'run only on weekdays' });
    expect(env.ok).toBe(true);
    expect((env.data as Record<string, unknown>).attached).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('scheduleId 不存在 → NOT_FOUND', async () => {
    const { registry } = setup({ scheduleRow: null });
    const env = await callTool(registry, { scheduleId: 'nope', script: 'process.exit(0)' });
    expect(env.ok).toBe(false);
    expect(env.errorCode ?? env.code).toBe('NOT_FOUND');
  });
});
