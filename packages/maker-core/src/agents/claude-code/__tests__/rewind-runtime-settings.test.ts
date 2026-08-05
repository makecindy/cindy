/**
 * Rewind 窗口期运行时切换（setModel / setEffort / setFastMode / setPermissionMode /
 * setPlanMode）回归测试。
 *
 * 背景（2026-07-07 release 实踩）：commitRewindFiles 会 close 旧 SDK Query 并设
 * pendingRewindTo，新 Query 延迟到下一次 send 才重建。这个窗口里旧实现直接对已
 * close 的 q 发 control request，SDK 抛 "ProcessTransport is not ready for writing"，
 * renderer 端表现为"设置切换失败,未生效" toast——用户 rewind 后切模型/切来源必现。
 *
 * 覆盖:
 *  - rewind 窗口内 setModel / setEffort / setFastMode / setPermissionMode 不碰旧 q、
 *    不抛错，只更新闭包状态
 *  - 下一次 send 重建 Query 时，新 model / permissionMode 自然带上（buildQuery 读闭包最新值）
 *  - rewind 窗口内 setPlanMode 武装计划模式同样不抛，重建后以 plan 档起步
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { ModelDescriptor } from '../../../types/capabilities.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

const imageResizerMock = vi.hoisted(() => ({
  process: vi.fn(async (p: string) => p),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('../../shared/image-resizer.js', () => ({
  getDefaultImageResizer: () => imageResizerMock,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;

const TEST_MODELS: ModelDescriptor[] = [
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
];

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

function createDeps(runtimeConfig: AgentDeps['runtimeConfig'] = {}): AgentDeps {
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
    runtimeConfig,
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
}

/** 可控挂起流：默认不吐消息；测试可按需 emit SDK 消息喂给 forward loop。 */
function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  let pendingError: unknown;
  let ended = false;

  function pump(): void {
    if (!waiter) return;
    if (pendingError !== undefined) {
      const w = waiter;
      waiter = null;
      const err = pendingError;
      pendingError = undefined;
      w.reject(err);
      return;
    }
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
      return;
    }
    if (ended) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: true, value: undefined });
    }
  }

  return {
    emit(msg: unknown): void {
      items.push(msg);
      pump();
    },
    fail(error: unknown): void {
      pendingError = error;
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

/**
 * 模拟真实 SDK transport 语义的 fake Query：close() 之后任何 control request
 * 都抛 "ProcessTransport is not ready for writing"——这正是线上事故的报错形态。
 */
function createFakeQuery(stream = createControlledStream()) {
  let closed = false;
  const assertWritable = () => {
    if (closed) throw new Error('ProcessTransport is not ready for writing');
  };
  return {
    stream,
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => assertWritable()),
    setModel: vi.fn(async () => assertWritable()),
    applyFlagSettings: vi.fn(async () => assertWritable()),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(() => {
      closed = true;
    }),
    rewindFiles: vi.fn(async () => ({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-rewind-'));
  tempDirs.push(dir);
  return dir;
}

async function startRewindableSession(
  options: { autoCompactThresholdPct?: number; idleTimeoutMs?: number } = {},
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  // 默认关掉 upstream-idle watchdog, 避免测试进程挂 30min 定时器; 单个用例可覆盖成短阈值。
  process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = String(options.idleTimeoutMs ?? 0);
  const workingDir = await makeTempDir();

  const firstQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(firstQuery);

  const agent = new ClaudeCodeAgent({
    ...createDeps({ autoCompactThresholdPct: options.autoCompactThresholdPct }),
    capabilityAdditions: { availableModels: TEST_MODELS },
  });
  const handle = await agent.startSession({
    sessionId: 'session-rewind',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });

  return { agent, handle, firstQuery };
}

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  imageResizerMock.process.mockReset();
  imageResizerMock.process.mockImplementation(async (p: string) => p);
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  if (originalIdleTimeout === undefined) {
    delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
  } else {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent runtime settings during rewind window', () => {
  it('passes max through when changing effort in a live Sonnet 5 session', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.setModel?.('claude-sonnet-5');
    await handle.setEffort?.('max');

    expect(firstQuery.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'max' });

    await handle.close();
  });

  it('falls back to the model-supported xhigh when an older runtime rejects max', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings
      .mockRejectedValueOnce(new Error('invalid effortLevel: max'))
      .mockResolvedValueOnce(undefined);

    await handle.setModel?.('claude-sonnet-5');
    await expect(handle.setEffort?.('max')).resolves.toBeUndefined();

    expect(firstQuery.applyFlagSettings.mock.calls.slice(-2)).toEqual([
      [{ effortLevel: 'max' }],
      [{ effortLevel: 'xhigh' }],
    ]);

    await handle.close();
  });

  it('falls back to high when the selected model does not support xhigh', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings
      .mockRejectedValueOnce(new Error('invalid effortLevel: max'))
      .mockResolvedValueOnce(undefined);

    await expect(handle.setEffort?.('max')).resolves.toBeUndefined();

    expect(firstQuery.applyFlagSettings.mock.calls.slice(-2)).toEqual([
      [{ effortLevel: 'max' }],
      [{ effortLevel: 'high' }],
    ]);

    await handle.close();
  });

  it('does not retry max when applyFlagSettings fails at the transport layer', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings.mockRejectedValueOnce(
      new Error('ProcessTransport is not ready for writing'),
    );

    await expect(handle.setEffort?.('max')).rejects.toThrow(
      'ProcessTransport is not ready for writing',
    );
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('does not retry failures for non-max effort levels', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings.mockRejectedValueOnce(new Error('transport failed'));

    await expect(handle.setEffort?.('high')).rejects.toThrow('transport failed');
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('replays max without downgrading it when effort changes during query rebuild', async () => {
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setModel?.('claude-sonnet-5');
      void handle.setEffort?.('max');
      return secondQuery;
    });

    await handle.send({ type: 'user', content: 'use max after rewind' });

    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });

    await handle.close();
  });

  it('setModel / setEffort / setFastMode / setPermissionMode skip the closed query and apply on rebuild', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    expect(firstQuery.close).toHaveBeenCalled();

    // 事故形态回归: 修复前这四个调用会打到已 close 的 transport 直接 reject。
    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();
    await expect(handle.setEffort?.('low')).resolves.toBeUndefined();
    await expect(handle.setFastMode?.(true)).resolves.toBeUndefined();
    await expect(handle.setPermissionMode?.('auto')).resolves.toBeUndefined();

    // 窗口内不许对旧 q 发任何 control request（fake 会抛, 这里再显式钉死语义）。
    expect(firstQuery.setModel).not.toHaveBeenCalled();
    expect(firstQuery.applyFlagSettings).not.toHaveBeenCalled();
    // startSession 阶段可能推过 permissionMode; commit 后不许再推。
    const permCallsAfterClose = firstQuery.setPermissionMode.mock.invocationCallOrder.filter(
      (order) => order > (firstQuery.close.mock.invocationCallOrder[0] ?? 0),
    );
    expect(permCallsAfterClose).toHaveLength(0);

    // 下一次 send 触发重建: 新 Query 直接带上窗口期改的 model / permissionMode。
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    // fixture 把 sonnet-5 配成 500K 窗口 → 窗口驱动的 wire 规则不带 [1m](<1M 不带)。
    expect(rebuildArgs.options.model).toBe('claude-sonnet-5');
    expect(rebuildArgs.options.permissionMode).toBe('auto');
    expect(rebuildArgs.options.forkSession).toBe(true);
    expect(rebuildArgs.options.resumeSessionAt).toBe('assistant-uuid-1');

    await handle.close();
  });

  it('setPlanMode armed during rewind window does not throw and rebuild starts in plan mode', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    await expect(handle.setPlanMode?.(true)).resolves.toBeUndefined();
    const permCallsAfterClose = firstQuery.setPermissionMode.mock.invocationCallOrder.filter(
      (order) => order > (firstQuery.close.mock.invocationCallOrder[0] ?? 0),
    );
    expect(permCallsAfterClose).toHaveLength(0);

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'plan after rewind' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('plan');

    await handle.close();
  });

  it('runtime settings arriving during the async rebuild window still skip the old query', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    // 不 await: send 同步执行完 rebuild 前置段后挂起在 `await buildQuery` 上,
    // 此刻 q 仍指向旧 closed query。修复前 pendingRewindTo 在 await 之前就被清掉,
    // 这里的 setModel 会判定窗口已结束 → 打旧 q → 抛 transport 错误。
    const sendPromise = handle.send({ type: 'user', content: 'hello after rewind' });
    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();
    expect(firstQuery.setModel).not.toHaveBeenCalled();

    await sendPromise;
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    // buildQuery 头部在竞态切换之前就快照了旧 model — 重建 options 里是旧值,
    // 全靠 rebuild 完成后的 diff 重放把新 model 补推到新 q(否则 UI 报成功但
    // session 实际还在旧模型上跑, Codex review P2)。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.model).toBe('claude-opus-4-6[1m]');
    // sonnet-5 fixture 窗口 500K < 1M → wire 串不带 [1m](窗口驱动规则)。
    expect(secondQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5');

    await handle.close();
  });

  it('setPlanMode arriving after rewind q install but before turn start stays deferred', async () => {
    // 覆盖 pendingRewindTo 已清、new q 已安装,但 turnInFlight 尚未登记的接受窗口。
    // 这里的 setPlanMode 只能 arm 下一 turn,不能把当前显式普通 send 升级为 plan turn。
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setModel?.('claude-sonnet-5'); // 让 rebuild replay 进入 q.setModel await 窗口
      return secondQuery;
    });
    secondQuery.setModel.mockImplementationOnce(async () => {
      await handle.setPlanMode?.(true);
    });

    await handle.send({ type: 'user', content: 'normal turn please' }, { planMode: false });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('acceptEdits');
    // sonnet-5 fixture 窗口 500K < 1M → wire 串不带 [1m](窗口驱动规则)。
    expect(secondQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    const planSwitches = secondQuery.setPermissionMode.mock.calls.filter((c: unknown[]) => c[0] === 'plan');
    expect(planSwitches, 'accepting-window setPlanMode must not upgrade the current normal send').toHaveLength(0);
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.close();
  });

  it('setModel crossing compact threshold during accepting window is bridge-counted', async () => {
    // pendingRewindTo 清掉后、turnInFlight=true 前的 setModel 若直接触发 /compact,
    // 该 compact 没有 queuedBridgeTurns 标记,done/status 会泄漏成独立 turn。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setEffort?.('low'); // 让 rebuild replay 进入 applyFlagSettings await 窗口
      return secondQuery;
    });
    secondQuery.applyFlagSettings.mockImplementationOnce(async () => {
      await handle.setModel?.('claude-sonnet-5'); // 500K 窗口: 400K usage 跨过 50% 阈值
    });

    await handle.send({ type: 'user', content: 'normal turn after accepting-window model switch' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content).toBe('normal turn after accepting-window model switch');

    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.type === 'done'), 'accepting-window /compact done must be bridge-suppressed').toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(true);

    await handle.close();
  });

  it('setModel skips auto-compact trigger while the rewind rebuild is pending', async () => {
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const eventIterator = handle.events()[Symbol.asyncIterator]();

    // 先写入一份旧窗口下未达阈值、切到小窗口后会达阈值的 usage 快照。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    const usageStatus = await eventIterator.next();
    expect(usageStatus.value?.type).toBe('status');
    expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    expect(handle.isTurnRunning?.()).toBe(false);

    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();

    expect(handle.getUsageSnapshot().contextWindow).toBe(500_000);
    // 修复前这里会立即注入 /compact 到即将被重建丢弃的 inputQueue, 并把 turnInFlight 置 true。
    expect(handle.isTurnRunning?.()).toBe(false);

    await handle.close();
  });

  it('rebuild replays auto-compact when a large→small window switch crossed the threshold during rewind', async () => {
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const eventIterator = handle.events()[Symbol.asyncIterator]();

    // 旧窗口 1M / usage 400K → ratio 40% (未达 50% 阈值)。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    const status = await eventIterator.next();
    expect(status.value?.type).toBe('status');

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    // 切到 500K 窗口 → ratio 80% (跨过阈值)。窗口期跳过了立即触发,
    // 补触发要延到 rebuild 完成时。
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 断言新 inputQueue 里 /compact 先于用户消息 — SDK 会先压缩再处理用户消息,
    // 语义与 idle setModel 触发 /compact 等价, 不会让首轮直接撞小窗上下文上限。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    const iterator = rebuildArgs.prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value?.message?.content).toBe('/compact');
    expect(second.value?.message?.content).toBe('hello after rewind');

    await handle.close();
  });

  it('late stream_end from the closed rewind query does not tear down the rebuilt bridge turn', async () => {
    // 反馈原型 (Codex review 3539123827): commitRewindFiles close 的旧 Query
    // forward loop 可能晚于下一次 send rebuild 才退出。若只看共享 pendingRewindTo,
    // 新 q 接管后该标记已清,旧 q 的迟到 stream_end 会误进 bridge_stream_closed /
    // remote_daemon_closed 兜底,把刚重建的首个 post-rewind turn 关掉。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after delayed old stream_end' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(2); // bridge /compact + real user message are still alive.

    firstQuery.stream.end();
    await new Promise((r) => setTimeout(r, 20));

    expect(
      events.find(
        (e) =>
          e.type === 'error' &&
          ['bridge_stream_closed', 'remote_daemon_closed'].includes((e.data as { reason?: string }).reason ?? ''),
      ),
      'late stream_end from the closed rewind query must stay silent after rebuild',
    ).toBeUndefined();
    expect(
      events.find(
        (e) =>
          e.type === 'done' &&
          ['bridge_stream_closed', 'remote_daemon_closed'].includes((e.data as { reason?: string }).reason ?? ''),
      ),
      'late stream_end from the closed rewind query must not finalize the rebuilt turn',
    ).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(true);
    expect(rebuildArgs.prompt.pending).toBe(2);

    await handle.close();
  });

  it('late stream_end from the closed rewind query preserves the rebuilt turn watchdog', async () => {
    // 反馈原型 (Codex review 3541143604): 旧 rewind Query 可能在新 Query 已接受
    // 用户输入并 arm upstream-idle watchdog 后才退出。旧 loop 的 shared finally
    // 不能清掉属于新 turn 的 timer,否则新 turn 在首个 SDK event 前挂死时不会自愈。
    const { handle, firstQuery } = await startRewindableSession({ idleTimeoutMs: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after delayed old stream_end' });

    firstQuery.stream.end();

    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout',
          ),
          'new turn watchdog must survive stale rewind query cleanup',
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    expect(secondQuery.interrupt).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('suppresses middle-turn end-status/done while inputQueue has a queued turn', async () => {
    // 反馈原型: rebuild 尾部注入 /compact 是 SDK 独立 turn, 处理完发 status(isRunning=false)+done。
    // 这两个事件到 register.ts 会触发 turn-finalization 副作用 (idle 调度 / turn 结束回写 /
    // IM handleTurnDoneAsync / snapshot), 让真正的用户回答被当作"第二个 turn"。
    // forward loop 的事件 sink 在 pending>0 时 suppress 这两类边界事件。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    // fake stream 不响应 abortController, handle.events() iterator 不会自然结束 —
    // 不 await collected, 用 .catch 消 unhandled rejection, 测试结束时 vitest 自动 gc。
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // fake 不 drain inputQueue, pending 保持 >0 → middle-turn 判定成立。
    // 让 SDK "处理完 /compact turn" 发 result — translator 会推出 status(isRunning=false)+done,
    // forward loop 的 sink 必须把这两条吞掉。
    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 200_000, output_tokens: 10 },
    });
    await vi.waitFor(() => {
      // translator handleResult 会同步 push 一些非边界事件 (endTurn 的 log 等), 但边界事件
      // 应被 suppress; 等 forward loop 消费完这一 rawMsg。
      expect(events.length).toBeGreaterThanOrEqual(beforeCount);
    });
    // 再等一小段确认后续没有 middle-turn 的 done / end-status 漏出来。
    await new Promise((r) => setTimeout(r, 20));

    const middleDone = events.find((e) => e.type === 'done');
    expect(middleDone, 'middle-turn done must be suppressed while queued turn exists').toBeUndefined();
    const middleEndStatus = events.find(
      (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
    );
    expect(middleEndStatus, 'middle-turn end-status must be suppressed while queued turn exists').toBeUndefined();

    await handle.close();
  });

  it('still suppresses middle-turn events after SDK drains inputQueue (bridge counter is source of truth)', async () => {
    // 反馈原型 (Codex review 3535259132 / 3535293200): 用 inputQueue.pending 判"排队 turn"
    // 有两个漏窗:
    //  (a) send 里 push /compact 后到 push user message 之间是 async 空窗
    //      (toClaudeSdkContent 图片 resize 几百 ms), SDK 可能已 drain /compact → pending 归 0
    //  (b) SDK prompt 是 AsyncIterable, 可能 eager 消费两条 → pending 归 0 但两 turn 都还在跑
    // 修复用显式桥接 turn 计数, 与 pending 无关。这条用例模拟"SDK 已 drain inputQueue
    // → pending=0"但计数仍 >0 的时刻: middle-turn 边界事件必须仍被 suppress。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 手动 drain 掉 rebuild 里 push 的 /compact + user message, 模拟 SDK 消费完毕 → pending=0。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { prompt: AsyncIterable<unknown> };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    await promptIter.next();
    await promptIter.next();

    // pending=0 后 emit /compact turn 的 result: 靠 pending 判定的旧实现会误放行,
    // 靠 bridge counter 的新实现仍 suppress (计数在 onTurnEnd 里才 -1)。
    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(beforeCount);
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.type === 'done'), 'bridge /compact turn done must stay suppressed regardless of pending').toBeUndefined();
    expect(
      events.find((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false),
      'bridge /compact turn end-status must stay suppressed regardless of pending',
    ).toBeUndefined();

    await handle.close();
  });

  it('lets end-status/done through after bridge /compact turn ends (real user turn end)', async () => {
    // 反向对照: 桥接 turn 消费掉之后 (onTurnEnd 里 counter -1 归 0), 真正用户 turn 结束
    // 时 translator 的 status(isRunning=false)+done 必须正常放行 — 否则真终态永远
    // 收不到, register.ts 上层挂死。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // ① /compact turn 结束 → onTurnEnd 消费一个 bridge turn (counter 1 → 0), 边界事件仍 suppress
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true); // 保持 in-flight (等真正用户 turn)
    });

    // ② 真正的用户 turn 结束 → counter=0 → 边界事件放行
    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 220_000, output_tokens: 100 },
    });
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(beforeCount);
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
    expect(
      events.some((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false),
    ).toBe(true);

    await handle.close();
  });

  it('preserves turnInFlight across the /compact → user message queued turn boundary', async () => {
    // 反馈原型: /compact 是独立 turn, SDK 处理完发 result → translator.onTurnEnd
    // 清 turnInFlight; 已排队的用户消息之后被消费起新 turn, 但没人把 turnInFlight
    // 置回 true → isTurnRunning() 返 false, rewind preview 守卫失守。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const eventIterator = handle.events()[Symbol.asyncIterator]();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    const status = await eventIterator.next();
    expect(status.value?.type).toBe('status');

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // send 后应仍处于 in-flight (compact + user 两条已在 inputQueue 排队)。
    expect(handle.isTurnRunning?.()).toBe(true);

    // 让 SDK 消费 /compact 起的 turn, 再吐一个 result 收尾 —— 这一次 onTurnEnd 触发,
    // 但 inputQueue 还剩用户消息 (pending>0), 修复后仍保持 turnInFlight=true。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 200_000, output_tokens: 10 },
    });
    // 等 forward loop 消费掉 result, 走完 translator.onTurnEnd。
    await vi.waitFor(() => {
      expect(sdkMock.query).toHaveBeenCalledTimes(2);
    });
    // 关键回归断言: 排队 turn 存在时 onTurnEnd 不该清 turnInFlight。
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });

    await handle.close();
  });

  it('bridge /compact turn end does not consume the queued plan turn state', async () => {
    // 反馈原型 (Codex review 3535545475): 用户 arm 了 plan mode 后 send, rewind 尾部又
    // 注入了 /compact bridge; SDK 消费 /compact 发 result → onTurnEnd。
    // 若 onTurnEnd 里 plan cleanup 在 bridge 消费之前跑, planTurnActive 会被清、
    // SDK 权限档会被降回底层 — 真正的用户 plan turn 就变成普通 turn 跑, plan_review 消失。
    // 修: bridge 消费必须优先, 保留 plan 状态给用户 turn。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    void (async () => {
      try { for await (const _event of handle.events()) { void _event; /* discard */ } } catch { /* ignore */ }
    })();

    // 写 usage 让 500K 窗口切换后过阈值。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    // arm plan mode → 下一次 send 消耗 arm 态启动 plan turn。
    await handle.setPlanMode?.(true);
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5'); // 500K 窗口 → 触发 auto-compact bridge

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    // send 里消耗 plan arm: planTurnActive=true / mutablePlanMode=false / SDK 起在 plan 档;
    // rebuild 尾部触发 auto-compact bridge: queuedBridgeTurns=1。
    await handle.send({ type: 'user', content: 'draft me a plan' });

    // 快照 SDK 起 turn 时的 permissionMode / plan 状态: 起在 plan 档。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('plan');
    const permCallsBefore = secondQuery.setPermissionMode.mock.calls.length;

    // 让 SDK "跑完 /compact turn"发 result → 触发 onTurnEnd。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 10 },
    });

    // 修复前: onTurnEnd 里的 plan cleanup 会 fire, 调 setPermissionMode 把 SDK 从
    // plan 降到 acceptEdits (mutablePermissionMode) — 用户 plan turn 因此崩;
    // 修复后: bridge 消费优先, 直接 return, 不动 plan / setPermissionMode。
    await vi.waitFor(() => {
      // 等 forward loop 消费完 result 后再看 setPermissionMode 调用。
      expect(true).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));

    const permCallsAfter = secondQuery.setPermissionMode.mock.calls.length;
    expect(
      permCallsAfter - permCallsBefore,
      'bridge /compact turn must not downgrade SDK permission mode (plan → acceptEdits)',
    ).toBe(0);
    // handle 端仍视为 in-flight, 准备接用户 plan turn。
    expect(handle.isTurnRunning?.()).toBe(true);

    await handle.close();
  });

  it('suppresses middle-turn terminal error from a failed bridge /compact turn', async () => {
    // 反馈原型 (Codex review 3535545481): bridge /compact turn 内部失败 (is_error result)
    // 会走 translator terminal-error 路径, 事件类型是 error, isTerminal:true。
    // register.ts 上层拿 isTerminal 做 turn finalization / abort, 泄漏后用户消息又变第二 turn。
    // 修: filter 也 suppress bridge 期间的 terminal error。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 让 SDK 处理 /compact 时**失败**: is_error result → translator 走 terminal-error 路径,
    // 依次 push error(isTerminal:true) + status(isRunning:false) + done。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content).toBe('hello after rewind');
    expect(rebuildArgs.prompt.pending).toBe(0);

    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: null,
      is_error: true,
      subtype: 'error_during_execution',
      result: 'compact failed: context too small',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(beforeCount);
    });
    await new Promise((r) => setTimeout(r, 20));

    // 三个边界事件都必须被 suppress: terminal error / end-status / done。
    expect(events.find((e) => e.type === 'error' && (e.data as { isTerminal?: boolean }).isTerminal === true),
      'bridge /compact terminal error must be suppressed to avoid triggering turn finalization',
    ).toBeUndefined();
    expect(events.find((e) => e.type === 'done'), 'bridge /compact done must be suppressed').toBeUndefined();
    expect(
      events.find((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false),
      'bridge /compact end-status must be suppressed',
    ).toBeUndefined();

    // handle 保持 in-flight, 用户 turn 继续走。
    expect(handle.isTurnRunning?.()).toBe(true);

    // /compact 失败未到 compact_boundary,需要重置 auto-compact fired latch。
    // 用户 turn 结束后如果 usage 仍过阈值,应能再次排队 /compact。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 410_000, output_tokens: 10 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });
    expect(rebuildArgs.prompt.pending).toBe(1);
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');

    await handle.close();
  });

  it('upstream-idle watchdog during bridge closes query and rebuilds from rewind point', async () => {
    // 反馈原型 (Codex review 3535664420 / 3536509277): watchdog 是**直接 push eventQueue**
    // 绕过 filter;若打在 bridge /compact 上,只清 counter + interrupt 仍无法追回 SDK 已
    // eager-drain 的真实用户消息。修: watchdog 与手动 Stop 一样 close 当前 Query,保留
    // rewind resume point,下一次 send 从同一 checkpoint 重建。
    const { handle, firstQuery } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      idleTimeoutMs: 50, // 快速触发 watchdog
    });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 不 emit result — SDK 静默, watchdog 阈值内触发。
    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout',
          ),
          'watchdog terminal error must reach eventQueue (not swallowed by bridge filter)',
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout'),
      ).toBe(true);
    });

    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);

    // 旧 Query 迟到 result 必须被丢弃;下一次 send 从同一个 rewind point 重建。
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after watchdog' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after watchdog');

    await handle.close();
  });

  it('upstream-idle watchdog during bridge closes query and clears queued real user input', async () => {
    // 反馈原型 (Codex review 3535996876 / 3536509277): watchdog 打在 bridge /compact 上时,
    // 只清 counter/inputQueue 或只 interrupt 都无法取消 SDK 已 eager-drain 的真实用户消息。
    // 修: watchdog 与手动 Stop 一样 close 当前 Query,同时清尚未被 SDK 消费的本地 queue。
    const { handle, firstQuery } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      idleTimeoutMs: 50,
    });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'must be cleared by watchdog' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(2); // /compact + 真实用户消息都还没被 SDK 拉取

    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout',
          ),
        ).toBe(true);
      },
      { timeout: 1000 },
    );

    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(secondQuery.close).toHaveBeenCalled();
    expect(rebuildArgs.prompt.pending).toBe(0);

    await handle.close();
  });

  it('send failure after bridge compact injection cancels bridge query and preserves retry point', async () => {
    // 反馈原型 (Codex review 3535996878 / 3538382993 / 3538551816): rebuild 后先注入
    // /compact,再 await toClaudeSdkContent。若附件处理/取消在真实用户消息 push 前失败,
    // 必须取消整条 bridge query,不能让已排队 /compact 作为普通 turn 继续跑并立即重试。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    imageResizerMock.process.mockRejectedValueOnce(new Error('resize failed'));
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await expect(
      handle.send({ type: 'user', content: [{ type: 'image', path: path.join(os.tmpdir(), 'missing.png') }] }),
    ).rejects.toThrow('resize failed');

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: Record<string, unknown>;
    };
    expect(rebuildArgs.prompt.pending).toBe(0);
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
    expect(
      events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned'),
    ).toBe(true);
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;

    // 旧 query 的迟到 compact failure 不应再驱动事件或立即排队下一次 /compact。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: null,
      is_error: true,
      subtype: 'error_during_execution',
      result: 'compact failed after abandoned send',
      total_cost_usd: 0,
      usage: { input_tokens: 410_000, output_tokens: 10 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);
    expect(rebuildArgs.prompt.pending).toBe(0);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after abandoned bridge' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after abandoned bridge');

    await handle.close();
  });
  it('send failure after bridge compact has already ended still cancels bridge query', async () => {
    // 反馈原型 (Codex review 3539298190): /compact result 可能先于图片/文件
    // content conversion 失败到达,此时 queuedBridgeTurns 已被 onTurnEnd 消费为 0,
    // 但 activeBridgeRewindResumeAt 仍保留到真实用户 turn 的首条 SDK message。catch
    // 不能只看 queuedBridgeTurns,否则已 emit isRunning:true 的 send 会卡在 running。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    let rejectResize!: (error: Error) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => { rejectResize = reject; }),
    );
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(os.tmpdir(), 'slow-missing.png') }],
    });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect(rebuildArgs.prompt.pending).toBe(0);
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0.0025,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await new Promise((r) => setTimeout(r, 20));

    rejectResize(new Error('resize failed after compact'));
    await expect(sendPromise).rejects.toThrow('resize failed after compact');

    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned'),
      ).toBe(true);
    });
    const abandonedDone = events.find(
      (e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned',
    );
    expect(abandonedDone?.data).toMatchObject({
      total_cost_usd: 0.0025,
      usage: { input_tokens: 210_000, output_tokens: 20 },
      reason: 'bridge_send_abandoned',
    });

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after compact-ended abandoned bridge' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after compact-ended abandoned bridge');

    await handle.close();
  });

  it('re-arms bridge auto-compact after compact boundary followed by send failure', async () => {
    // 反馈原型 (Codex review 3539465005): bridge /compact 已成功吐出 compact_boundary 后,
    // controller 会清 latest + fired。若随后真实用户消息的附件处理失败并回滚到 rewind
    // point,只调用 onCompactCanceled 已无 snapshot 可重试,下一次 send 会漏掉必需的 /compact。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    let rejectResize!: (error: Error) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => { rejectResize = reject; }),
    );
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(os.tmpdir(), 'compact-boundary-then-fail.png') }],
    });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');

    secondQuery.stream.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 400_000,
        post_tokens: 120_000,
        duration_ms: 10,
      },
    });
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await new Promise((r) => setTimeout(r, 20));

    rejectResize(new Error('resize failed after compact boundary'));
    await expect(sendPromise).rejects.toThrow('resize failed after compact boundary');
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after compact-boundary abandoned bridge' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after compact-boundary abandoned bridge');

    await handle.close();
  });

  it('does not emit bridge_send_abandoned after Stop aborts a bridge send in content conversion', async () => {
    // 反馈原型 (Codex review 3540961667): rebuild 已注入 /compact,真实用户消息还在
    // toClaudeSdkContent(image/file) 里时用户点 Stop。abort 已 close query + emit
    // bridge_aborted;随后 send 观察到 aborted signal 进 catch 时必须 no-op,不能再发
    // bridge_send_abandoned 第二个终态边界。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    let resolveResize!: (value: string) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveResize = resolve; }),
    );
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    const controller = new AbortController();
    const sendPromise = handle.send(
      { type: 'user', content: [{ type: 'image', path: path.join(os.tmpdir(), 'slow-stop.png') }] },
      { signal: controller.signal },
    );

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');

    controller.abort();
    await handle.abort();
    resolveResize(path.join(os.tmpdir(), 'slow-stop.png'));
    await expect(sendPromise).rejects.toThrow('Claude send cancelled before acceptance');

    expect(secondQuery.close).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted')).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(
      events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned'),
      'send catch after Stop must not emit a second terminal bridge boundary',
    ).toBe(false);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(handle.isTurnRunning?.()).toBe(false);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after stop during conversion' });
    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after stop during conversion');

    await handle.close();
  });

  it('setPlanMode(true) arriving during rebuild must not upgrade a normal send to plan turn', async () => {
    // 反馈原型 (Codex review 3535660068): rebuild await 期间到达的 setPlanMode 只翻
    // mutablePlanMode(arm), replay 若用 effectiveSdkPermissionMode() 会读到 arm 态 →
    // 判定档位漂移 → 把 SDK 切到 plan, 让本轮"普通 send"意外升级为 plan turn。
    // 修: rebuild 起档 + replay 都用 currentTurnSdkPermissionMode()(只看 planTurnActive,
    // 不含 arm),arm 留给下一次 send。
    //
    // 复刻思路: mockImplementation 让 sdkMock.query 在返回 secondQuery 前**同步**改 arm 态,
    // 精确模拟 "buildQuery options 已按本 turn 普通档构造 → mockImpl 里 flip arm=true →
    // buildQuery return → replay 读 current" 的 timing。
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setPlanMode?.(true); // rewindPending() 短路, 只翻 mutablePlanMode arm
      return secondQuery;
    });

    await handle.send({ type: 'user', content: 'normal turn please' }, { planMode: false });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('acceptEdits');
    const planSwitches = secondQuery.setPermissionMode.mock.calls.filter((c: unknown[]) => c[0] === 'plan');
    expect(planSwitches, 'rebuild replay must not upgrade normal send to plan turn').toHaveLength(0);
    // arm 态保留: 下一次 send 才该消费。
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.close();
  });

  it('explicit normal send ignores plan arm already pending during rewind rebuild start', async () => {
    // 反馈原型 (Codex review 3535801840): plan arm 已在 rewind 窗口里存在时,
    // 排队/自动化 send 仍可能显式带 planMode:false。send 头部会判定本轮是普通 turn,
    // 但旧 buildQuery 起档仍读含 arm 态的 effectiveSdkPermissionMode() → 新 Query 从 plan 起,
    // replay 又用 turn-scoped 档看不到 diff,因此不会 downgrade,普通 turn 被误跑成 plan turn。
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    await handle.setPlanMode?.(true); // rewindPending() 短路,只留下 mutablePlanMode arm
    expect(handle.getPlanMode?.()).toBe(true);

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'explicit normal turn' }, { planMode: false });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('acceptEdits');
    const planSwitches = secondQuery.setPermissionMode.mock.calls.filter((c: unknown[]) => c[0] === 'plan');
    expect(planSwitches, 'rebuild must not start or replay this explicit normal send as plan').toHaveLength(0);
    // arm 态仍留给下一条未显式 planMode:false 的 send 消费。
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.close();
  });

  it('abort during bridge compact closes query so eager-drained user input cannot continue', async () => {
    // 反馈原型 (Codex review 3536258014): SDK 可能 eager-drain /compact 和真实用户消息。
    // Stop 只 inputQueue.clear() 时,已被 SDK 拉走的真实消息无法追回,q.interrupt() 也只
    // 中断 active /compact turn,后续真实消息仍可能继续跑。修:bridge Stop 直接 close 当前
    // Query,保留 rewind resume point,下一次 send 重新 buildQuery。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'eager-drained but should be cancelled' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content).toBe('eager-drained but should be cancelled');
    expect(rebuildArgs.prompt.pending).toBe(0);

    await handle.abort();

    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted'),
      ).toBe(true);
    });
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;

    // 旧 Query 的迟到 result 不应再进入事件流;下一次 send 从同一个 resume point 重建。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'next clean turn' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('next clean turn');

    await handle.close();
  });

  it('abort after bridge compact ends but before user turn starts still cancels queued input', async () => {
    // 反馈原型 (Codex review 3536509265): SDK 跑完 bridge /compact 后,可能尚未开始
    // 后续真实用户 turn。若 onTurnEnd 在 counter 归零时立刻清 activeBridgeRewindResumeAt,
    // 这个 gap 里的 Stop 会退化成普通 q.interrupt(),既不清 queued input,也无法下次从
    // rewind point 重建。修: bridge resume point 保留到下一条 SDK message 到达。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'queued but not started' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect(rebuildArgs.prompt.pending).toBe(1);

    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 10 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });
    expect(rebuildArgs.prompt.pending).toBe(1);

    await handle.abort();

    expect(secondQuery.close).toHaveBeenCalled();
    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(rebuildArgs.prompt.pending).toBe(0);
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted'),
      ).toBe(true);
    });
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;

    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after gap stop' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after gap stop');

    await handle.close();
  });

  it('abort during bridge compact closes query and clears queued input', async () => {
    // 反馈原型 (Codex review 3535801846): Stop 发生在 rebuild 注入的 /compact bridge turn
    // 正在跑时,旧 onTurnEnd 会把 interrupted /compact result 当 bridge result 消费:counter-- 后
    // return,不清 turnInFlight,也不放行 done/status;同时 inputQueue 里的真实用户消息仍可能继续跑。
    // 修: abort 先 close 当前 Query 取消 SDK 侧已 drain 的后续输入,并 clear 尚未被 SDK
    // 消费的本地 queued input。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'should be cancelled by stop' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    const compactInput = await promptIter.next();
    expect(compactInput.value?.message?.content).toBe('/compact');
    expect(rebuildArgs.prompt.pending).toBe(1); // 真实用户消息仍在本地 queue 中等待 SDK 拉取

    await handle.abort();

    expect(secondQuery.close).toHaveBeenCalled();
    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(rebuildArgs.prompt.pending).toBe(0); // Stop 丢弃尚未被 SDK 消费的真实用户消息

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted'),
      ).toBe(true);
    });
    const doneCountAfterFirstAbort = events.filter((e) => e.type === 'done').length;

    // 重复 / 迟到的 Stop 不能再次进入 bridge-cancel 分支,否则会重复发 turn boundary。
    await handle.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(secondQuery.close).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountAfterFirstAbort);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after stop' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after stop');

    await handle.close();
  });

  it('keeps applying runtime settings while bridge compact is running', async () => {
    // activeBridgeRewindResumeAt 保留期间有两种状态:
    //  - Stop/watchdog 已 close 当前 Query → control request 必须跳过, 等下次 rebuild
    //  - 正常 bridge /compact 正在跑 → 当前 Query 仍可写,运行时设置必须继续打给 SDK
    // 这条覆盖第二种,避免长 compact 窗口里切模型/权限档只改闭包不改 live q。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'long bridge compact' });

    await expect(handle.setModel?.('claude-opus-4-6')).resolves.toBeUndefined();
    await expect(handle.setEffort?.('xhigh')).resolves.toBeUndefined();
    await expect(handle.setFastMode?.(true)).resolves.toBeUndefined();
    await expect(handle.setPermissionMode?.('auto')).resolves.toBeUndefined();

    expect(secondQuery.setModel).toHaveBeenCalledWith('claude-opus-4-6[1m]');
    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' });
    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    expect(secondQuery.setPermissionMode).toHaveBeenCalledWith('auto');

    await handle.close();
  });

  it('cancels a rewind rebuild before bridge compact or turn-start side effects', async () => {
    // 反馈原型: Session.abort() 可在 await buildQuery 期间取消 sendOpts.signal。
    // rebuild resolve 后必须立刻检查 signal,否则会继续注入 /compact、emit running status,
    // 最后才在内容转换处抛取消,留下没有真实用户输入的 in-flight turn。
    const { handle } = await startRewindableSession();
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    let resolveRebuild!: (query: ReturnType<typeof createFakeQuery>) => void;
    const rebuildPromise = new Promise<ReturnType<typeof createFakeQuery>>((resolve) => {
      resolveRebuild = resolve;
    });
    sdkMock.query.mockImplementationOnce(() => rebuildPromise as unknown as ReturnType<typeof createFakeQuery>);
    const controller = new AbortController();

    const sendPromise = handle.send({ type: 'user', content: 'cancel during rebuild' }, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(sdkMock.query).toHaveBeenCalledTimes(2);
    });

    controller.abort();
    const secondQuery = createFakeQuery();
    resolveRebuild(secondQuery);

    await expect(sendPromise).rejects.toThrow(/cancelled before acceptance/i);
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      events.some((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === true),
      'cancelled rebuild must not emit a running turn status',
    ).toBe(false);

    await handle.close();
  });

  it('cancels a post-rebuild send if Stop arrives during accept replay', async () => {
    // 反馈原型 (Codex review 3541310178): rebuild 后 turnInFlight/status 已登记,
    // acceptingRebuiltSend 的第二轮 runtime drift replay 仍可能 await control request。
    // 此时 Stop 若让 send 在真实用户输入 push 前 reject,必须补齐 terminal boundary,
    // 否则 isTurnRunning 会永久停在 true。
    const { handle } = await startRewindableSession();
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    let setModelCalls = 0;
    let resolveAcceptReplay!: () => void;
    let notifyAcceptReplayStarted!: () => void;
    const acceptReplayStarted = new Promise<void>((resolve) => { notifyAcceptReplayStarted = resolve; });
    const acceptReplayHold = new Promise<void>((resolve) => { resolveAcceptReplay = resolve; });
    secondQuery.setModel.mockImplementation(async () => {
      setModelCalls += 1;
      if (setModelCalls <= 5) {
        throw new Error('temporary replay failure');
      }
      notifyAcceptReplayStarted();
      await acceptReplayHold;
    });
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setModel?.('claude-sonnet-5');
      return secondQuery;
    });
    const controller = new AbortController();

    const sendPromise = handle.send(
      { type: 'user', content: 'cancel during accept replay' },
      { signal: controller.signal },
    );
    await acceptReplayStarted;
    expect(handle.isTurnRunning?.()).toBe(true);

    controller.abort();
    await handle.abort();
    resolveAcceptReplay();

    await expect(sendPromise).rejects.toThrow('Claude send cancelled before acceptance');
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'send_cancelled_before_acceptance'),
      ).toBe(true);
    });
    expect(secondQuery.close).not.toHaveBeenCalled();

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(0);
    await handle.send({ type: 'user', content: 'next after accept replay cancellation' });
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('next after accept replay cancellation');

    await handle.close();
  });

  it('tears down and emits a terminal boundary if bridge compact stream crashes', async () => {
    // bridge /compact 的 SDK stream 自发抛错不是主动 Stop/watchdog close,不能按 rewind
    // transition 静默;否则 queuedBridgeTurns 会残留并吞掉下一次真实用户 turn 的终态。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'will be cancelled by bridge crash' });

    secondQuery.stream.fail(new Error('bridge stream exploded'));

    await vi.waitFor(() => {
      expect(
        events.some(
          (e) =>
            e.type === 'error' &&
            (e.data as { reason?: string; isTerminal?: boolean }).reason === 'bridge_sdk_stream_crashed' &&
            (e.data as { isTerminal?: boolean }).isTerminal === true,
        ),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_sdk_stream_crashed'),
      ).toBe(true);
    });
    expect(handle.isTurnRunning?.()).toBe(false);
  });
});
