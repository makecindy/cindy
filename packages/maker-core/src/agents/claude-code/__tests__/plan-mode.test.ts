/**
 * Claude 计划模式（planMode 一级开关）单测。
 *
 * 覆盖:
 *  - startSession planMode → SDK query 以 permissionMode='plan' 启动, 底层权限档保留
 *  - setPlanMode 开/关 → q.setPermissionMode 在 plan 与底层档之间切换
 *  - 计划模式期间 setPermissionMode 只记账不 push SDK, 退出时落到最新底层档
 *  - ExitPlanMode 批准 → 自动退出计划模式 (plan_mode_changed 事件 + SDK 切回底层档)
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };

  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    ...overrides,
  };
}

/** 最小可用的 SDK Query 假实现: 消息流永远挂起, 控制方法全部记录调用。 */
function createFakeQuery() {
  return {
    [Symbol.asyncIterator]() {
      // 消息流永远 pending — 这些用例只走控制面, 不消费流。
      return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string },
) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-plan-'));
  tempDirs.push(dir);
  return dir;
}

async function startPlanSession(planMode: boolean, depOverrides: Partial<AgentDeps> = {}) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const agent = new ClaudeCodeAgent(createDeps(depOverrides));
  const handle = await agent.startSession({
    sessionId: 'session-plan',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
    planMode,
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { permissionMode?: string; allowedTools?: string[]; canUseTool?: CanUseToolFn }
    | undefined;
  if (!queryOptions) throw new Error('expected sdk query options');
  return { agent, handle, fakeQuery, queryOptions };
}

async function nextEvent(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<AgentEvent>>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for event')), 100);
    }),
  ]);
  if (result.done) throw new Error('event stream ended');
  return result.value;
}

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent plan mode', () => {
  it('starts the SDK query in plan mode while keeping the underlying permission mode', async () => {
    const { handle, queryOptions } = await startPlanSession(true);

    expect(queryOptions.permissionMode).toBe('plan');
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('starts with the plain permission mode when planMode is off', async () => {
    const { handle, queryOptions } = await startPlanSession(false);

    expect(queryOptions.permissionMode).toBe('acceptEdits');
    expect(queryOptions.allowedTools).toBeUndefined();
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('passes a session-stable copy of host-owned allowedTools to the local SDK query', async () => {
    const source = ['mcp__cindy__ghost_list', 'mcp__cindy_memory__list_tools'];
    const { handle, queryOptions } = await startPlanSession(false, {
      claudeAllowedTools: source,
    });
    source.push('Bash');

    expect(queryOptions.allowedTools).toEqual([
      'mcp__cindy__ghost_list',
      'mcp__cindy_memory__list_tools',
    ]);
    expect(queryOptions.allowedTools).not.toBe(source);
    await handle.close();
  });

  it('passes the same allowedTools snapshot to remote cc-manager start params', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const starts: Array<Record<string, unknown>> = [];
    const fakeQuery = createFakeQuery();
    const source = ['mcp__cindy__ghost_forge_guide', 'mcp__cindy_helper__list_tools'];

    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async (args) => {
      starts.push(args.startParams);
      return fakeQuery as never;
    };
    const agent = new ClaudeCodeAgent(createDeps({
      claudeAllowedTools: source,
      remoteCcQueryFactory,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-allowed-tools',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });
    source.push('Bash');

    expect(starts).toHaveLength(1);
    expect(starts[0]?.allowedTools).toEqual([
      'mcp__cindy__ghost_forge_guide',
      'mcp__cindy_helper__list_tools',
    ]);
    expect(starts[0]?.allowedTools).not.toBe(source);
    expect(sdkMock.query).not.toHaveBeenCalled();
    await handle.close();
  });

  it('setPlanMode toggles the SDK between plan and the underlying mode', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    await handle.setPlanMode?.(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('plan');
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.setPlanMode?.(false);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('defers setPermissionMode pushes while plan mode is active', async () => {
    const { handle, fakeQuery } = await startPlanSession(true);

    await handle.setPermissionMode?.('auto');
    // 计划模式期间只记账底层档, 不 push SDK (SDK 停留在 plan)。
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();

    await handle.setPlanMode?.(false);
    // 退出计划模式落到最新的底层档。Cindy 档 'auto'(Auto-review)映射到 SDK 'default'
    // —— 不再透传 'auto' 给 CC(canUseTool 才会触发,由 Cindy 策略审查),见 toSdkPermissionMode。
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');
    await handle.close();
  });

  it('auto-exits plan mode after the user approves the plan (ExitPlanMode allow)', async () => {
    const { handle, fakeQuery, queryOptions } = await startPlanSession(true);
    const iterator = handle.events()[Symbol.asyncIterator]();
    const seen: InteractionRequest[] = [];
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      return { kind: 'plan_review', behavior: 'allow' };
    });

    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error('expected canUseTool');
    const result = await canUseTool('ExitPlanMode', { plan: '1. do X' }, { toolUseID: 'tool-1' });

    expect(result.behavior).toBe('allow');
    expect(seen[0]).toMatchObject({ kind: 'plan_review', plan: '1. do X' });
    expect(handle.getPlanMode?.()).toBe(false);
    // fire-and-forget 的 SDK 切档 — 等一个 tick。
    await vi.waitFor(() => {
      expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    });
    const ev = await nextEvent(iterator);
    expect(ev).toMatchObject({ type: 'plan_mode_changed', data: { enabled: false } });
    await handle.close();
  });

  it('defers the SDK switch when armed mid-turn, and pushes plan at the next send boundary', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    // turn 流式中(send 后 fake query 永不结束)从菜单勾计划模式 → 只记账,不动
    // in-flight turn 的 SDK 权限档。
    await handle.send({ type: 'user', content: 'first message' });
    await handle.setPlanMode?.(true);
    expect(handle.getPlanMode?.()).toBe(true);
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();

    // 下一条消息消耗武装态 → 此刻补推 plan 档。
    await handle.send({ type: 'user', content: 'plan this' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('honors the per-send plan intent snapshot over the current armed state', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    // 排队行快照 true + 当前未武装 → SDK 补推 plan 档执行本 turn。
    await handle.send({ type: 'user', content: 'queued plan request' }, { planMode: true });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('plan');
    await handle.close();
  });

  it('explicit normal send keeps the armed selection for a future message', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    // idle 武装(SDK 已推 plan)后, 排队普通消息(快照 false)派发 → SDK 降回底层档
    // 执行本 turn, 武装态保留。
    await handle.setPlanMode?.(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('plan');
    await handle.send({ type: 'user', content: 'queued normal message' }, { planMode: false });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('one-shot: send consumes the armed selection, SDK stays in plan for the turn', async () => {
    const { handle, fakeQuery } = await startPlanSession(true);
    const iterator = handle.events()[Symbol.asyncIterator]();

    await handle.send({ type: 'user', content: 'make a plan' });

    // 勾选被消耗 + plan_mode_changed(false) 广播; SDK 不在此时切档
    // (本轮 plan turn 继续, 收尾在批准分支 / onTurnEnd)。
    expect(handle.getPlanMode?.()).toBe(false);
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    let sawPlanModeChanged = false;
    for (let i = 0; i < 30 && !sawPlanModeChanged; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type === 'plan_mode_changed') {
        expect(ev.data).toEqual({ enabled: false });
        sawPlanModeChanged = true;
      }
    }
    expect(sawPlanModeChanged).toBe(true);
    await handle.close();
  });

  it('stays in plan mode when the plan is rejected', async () => {
    const { handle, fakeQuery, queryOptions } = await startPlanSession(true);
    handle.setInteractionResolver(async (): Promise<InteractionDecision> => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: '换个方案',
    }));

    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error('expected canUseTool');
    const result = await canUseTool('ExitPlanMode', { plan: '1. do X' }, { toolUseID: 'tool-1' });

    expect(result.behavior).toBe('deny');
    expect(handle.getPlanMode?.()).toBe(true);
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    await handle.close();
  });
});
