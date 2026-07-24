/**
 * 用户 Stop 确定性全停后台任务的回归测试(2026-07-16 Lizi 拍板的产品语义:
 * 点 Stop = 本会话所有模型调用停止,不允许残留)。
 *
 * 背景:q.interrupt() 只中断当前 turn;跨 turn 存活的后台 wake 任务(Agent tool
 * run_in_background 的 subagent / workflow)会继续调模型烧用量(2026-07-13 事故),
 * 且完成后经 task_notification 自动续跑新 turn("诈尸")。abort() 现在会在
 * interrupt 之前对 running 的 wake 型任务逐个 q.stopTask()。
 *
 * 覆盖:
 *  - running 的 local_agent 任务 → abort 时 stopTask + interrupt 都被调用
 *  - 已到终态(completed)的任务 → 不再 stopTask
 *  - local_bash(不调模型,可能是 dev server)→ 不 stopTask
 *  - task_updated 补丁(无 task_type)不丢 wake 锁存
 *  - stopTask 单个失败 → 不阻塞 interrupt,abort 正常返回
 *  - 老 SDK / 老远端 daemon 没有 stopTask 方法 → 降级 interrupt-only 不抛错
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
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

function createDeps(): AgentDeps {
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
  };
}

/** 可控 SDK 消息流(与 auto-continued-turn-in-flight.test.ts 同款 harness)。 */
function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  let ended = false;
  let failure: unknown = null;

  function pump(): void {
    if (!waiter) return;
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
    } else if (failure !== null) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    } else if (ended) {
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

function createFakeQuery(
  stream: ReturnType<typeof createControlledStream>,
  opts?: { omitStopTask?: boolean },
) {
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
    ...(opts?.omitStopTask ? {} : { stopTask: vi.fn(async (_taskId: string) => {}) }),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-stoptask-'));
  tempDirs.push(dir);
  return dir;
}

async function startSessionWithStream(queryOpts?: { omitStopTask?: boolean }) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const stream = createControlledStream();
  const fakeQuery = createFakeQuery(stream, queryOpts);
  sdkMock.query.mockImplementation((options: unknown) => {
    const prompt = (options as { prompt?: AsyncIterable<unknown> } | undefined)?.prompt;
    if (prompt) {
      void (async () => {
        try {
          for await (const _ of prompt) { /* discard — 只对齐 pending 语义 */ }
        } catch { /* end / abort 都算正常收尾 */ }
      })();
    }
    return fakeQuery;
  });

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-stop-task',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });

  const events: AgentEvent[] = [];
  const collected = (async () => {
    for await (const ev of handle.events()) {
      events.push(ev);
    }
  })();

  return { agent, handle, stream, fakeQuery, events, collected };
}

function taskStarted(taskId: string, taskType: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `tu-${taskId}`,
    description: `bg work ${taskId}`,
    task_type: taskType,
  };
}

function taskNotification(taskId: string, status: 'completed' | 'failed' | 'stopped'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
  };
}

/** 等待条件成立(事件经 AsyncQueue 异步 fan-out,不能同步断言)。 */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function taskEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === 'agent_task_update');
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

describe('ClaudeCodeAgent abort stops background wake tasks', () => {
  it('stops running wake tasks (local_agent / local_workflow) and still interrupts; bash tasks are spared', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    stream.emit(taskStarted('task-wf', 'local_workflow'));
    stream.emit(taskStarted('task-bash', 'local_bash'));
    await waitFor(() => taskEvents(events).length >= 3, 'task_started events observed');

    await handle.abort();

    const stoppedIds = fakeQuery.stopTask!.mock.calls.map((c) => c[0]).sort();
    expect(stoppedIds).toEqual(['task-agent', 'task-wf']);
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('does not stop tasks that already reached a terminal status', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    stream.emit(taskNotification('task-1', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task terminal event observed');

    await handle.abort();

    expect(fakeQuery.stopTask).not.toHaveBeenCalled();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('keeps the wake latch across task_updated patches that omit task_type', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    // tasks-panel 补丁:无 task_type,status pending → running,不得把 wake 降级。
    stream.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: { status: 'pending' },
    });
    await waitFor(() => taskEvents(events).length >= 2, 'patch event observed');

    await handle.abort();

    expect(fakeQuery.stopTask!.mock.calls.map((c) => c[0])).toEqual(['task-1']);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('a rejecting stopTask does not block interrupt and abort still resolves', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');

    fakeQuery.stopTask!.mockRejectedValueOnce(new Error('task already finished'));
    await expect(handle.abort()).resolves.toBeUndefined();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
    // fire-and-forget 的 rejection 被 catch 消化 —— 给微任务一拍确认无 unhandled。
    await new Promise((r) => setTimeout(r, 20));

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask stops a single running task (including local_bash) without interrupting the turn', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-bash', 'local_bash'));
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 2, 'task_started events observed');

    await handle.stopBackgroundTask!('task-bash');

    // 精确停单个任务:只停被点名的 bash,不碰其他任务、不 interrupt 当前 turn。
    expect(fakeQuery.stopTask!.mock.calls.map((c) => c[0])).toEqual(['task-bash']);
    expect(fakeQuery.interrupt).not.toHaveBeenCalled();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask is idempotent for terminal / unknown tasks', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_bash'));
    stream.emit(taskNotification('task-1', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task terminal event observed');

    // 已终态与从未存在的任务都静默成功(UI 点击与 task_notification 天然竞态)。
    await expect(handle.stopBackgroundTask!('task-1')).resolves.toBeUndefined();
    await expect(handle.stopBackgroundTask!('task-unknown')).resolves.toBeUndefined();
    expect(fakeQuery.stopTask).not.toHaveBeenCalled();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask rejects when the query has no stopTask (old SDK / old remote daemon)', async () => {
    const { handle, stream, events } = await startSessionWithStream({ omitStopTask: true });

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_bash'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');

    // 不支持时明确失败,按钮不能假装成功(与 abort 的降级容忍语义不同)。
    await expect(handle.stopBackgroundTask!('task-1')).rejects.toThrow(/not supported/);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('degrades to interrupt-only when the query has no stopTask (old SDK / old remote daemon)', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream({ omitStopTask: true });

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');

    await expect(handle.abort()).resolves.toBeUndefined();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });
});
