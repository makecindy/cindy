/** Claude invalid-resume 的 preflight + 单次运行期 fresh fallback 回归。 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, StartSessionOptions } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import { sanitizeClaudeProjectKey } from '../claude-projects-fs.js';

const sdkMock = vi.hoisted(() => ({ query: vi.fn(), forkSession: vi.fn() }));

const imageResizerMock = vi.hoisted(() => ({
  process: vi.fn(async (p: string) => p),
  validateBuffer: vi.fn(async () => true),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMock.query,
  forkSession: sdkMock.forkSession,
}));

vi.mock('../../shared/image-resizer.js', () => ({
  getDefaultImageResizer: () => imageResizerMock,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createLogger(): Logger {
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
    logger: createLogger(),
    ...overrides,
  };
}

function createControlledStream() {
  const items: unknown[] = [];
  let waiter: {
    resolve: (value: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let failure: unknown;
  let ended = false;
  const pump = (): void => {
    if (!waiter) return;
    const current = waiter;
    if (items.length > 0) {
      waiter = null;
      current.resolve({ done: false, value: items.shift() });
    } else if (failure !== undefined) {
      waiter = null;
      current.reject(failure);
    } else if (ended) {
      waiter = null;
      current.resolve({ done: true, value: undefined });
    }
  };
  return {
    emit(value: unknown): void {
      items.push(value);
      pump();
    },
    fail(error: unknown): void {
      failure = error;
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

function createFakeQuery(stream: ReturnType<typeof createControlledStream>) {
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {
      stream.end();
    }),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-invalid-resume-'));
  tempDirs.push(dir);
  return dir;
}

async function seedTranscript(configDir: string, workingDir: string, sdkSessionId: string): Promise<void> {
  const normalized = await fs.realpath(workingDir);
  const projectDir = path.join(configDir, 'projects', sanitizeClaudeProjectKey(normalized));
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${sdkSessionId}.jsonl`), '{"type":"summary"}\n', 'utf8');
}

async function startHarness(args: {
  resumeSessionId?: string;
  transcriptExists: boolean;
  onInvalidResumeSession: StartSessionOptions['onInvalidResumeSession'];
}) {
  const configDir = await makeTempDir();
  const workingDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  if (args.transcriptExists && args.resumeSessionId) {
    await seedTranscript(configDir, workingDir, args.resumeSessionId);
  }

  const streams = [createControlledStream(), createControlledStream(), createControlledStream()];
  const queries = streams.map(createFakeQuery);
  const queryOptions: Array<Record<string, unknown>> = [];
  const consumedInputs: unknown[][] = [];
  sdkMock.query.mockImplementation((options: unknown) => {
    const index = queryOptions.length;
    queryOptions.push((options as { options?: Record<string, unknown> }).options ?? {});
    const consumed: unknown[] = [];
    consumedInputs.push(consumed);
    const prompt = (options as { prompt?: AsyncIterable<unknown> }).prompt;
    if (prompt) {
      void (async () => {
        try {
          for await (const input of prompt) consumed.push(input);
        } catch {
          /* query replacement closes the old prompt */
        }
      })();
    }
    return queries[index];
  });

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'local-session',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
    resumeSessionId: args.resumeSessionId,
    onInvalidResumeSession: args.onInvalidResumeSession,
  });
  const events: AgentEvent[] = [];
  const collected = (async () => {
    for await (const event of handle.events()) events.push(event);
  })();
  return {
    handle,
    streams,
    queries,
    queryOptions,
    consumedInputs,
    events,
    collected,
  };
}

async function waitForDone(events: AgentEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.type === 'done')).toBe(true));
}

afterEach(async () => {
  sdkMock.query.mockReset();
  sdkMock.forkSession.mockReset();
  imageResizerMock.process.mockClear();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Claude invalid-resume recovery', () => {
  it('preflight missing clears the old id and starts fresh before any turn is sent', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-missing',
      transcriptExists: false,
      onInvalidResumeSession: clear,
    });

    expect(clear).toHaveBeenCalledWith('sdk-missing');
    expect(h.queryOptions).toHaveLength(1);
    expect(h.queryOptions[0]).not.toHaveProperty('resume');
    await h.handle.close();
    h.streams[0].end();
    await h.collected;
  });

  it('recovers silently when resume fails before any user turn (present-but-unresumable transcript)', async () => {
    // 停泊会话的转录存在(preflight 找得到 → 不清),但 CLI 仍拒绝续接(孤儿/半写
    // jsonl):失败发生在任何 send 之前。旧行为 surface 终态 resume_session_not_found
    // 且不清 id → 用户看到红条并被迫手动重试(切到 Claude 的偶发报错)。新行为:
    // 清失效 id + 静默重建全新 idle 会话,首条真实消息直接在新会话上跑。
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    // preflight 命中转录、保留 resume id;首个 query 带 resume。
    expect(h.queryOptions).toHaveLength(1);
    expect(h.queryOptions[0]).toHaveProperty('resume', 'sdk-orphan');

    // 尚未 send,CLI 在 bootstrap 阶段就吐出 "No conversation found"。
    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));

    // 失效 id 被清;重建的 query 不带 resume;没有 surface 任何终态错误。
    expect(clear).toHaveBeenCalledWith('sdk-orphan');
    expect(h.queryOptions[1]).not.toHaveProperty('resume');
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(h.events.some((event) => event.type === 'done')).toBe(false);
    // idle 重建:首个 query 在失败前没消费任何输入,新 query 也还没有输入在跑。
    await vi.waitFor(() =>
      expect(h.consumedInputs.map((inputs) => inputs.length)).toEqual([0, 0]),
    );

    // 用户的首条真实消息直接在全新会话上跑通。
    await h.handle.send({ type: 'user', content: 'first real message' });
    h.streams[1].emit({ type: 'system', subtype: 'init', session_id: 'sdk-fresh' });
    h.streams[1].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'fresh ok' }] },
      session_id: 'sdk-fresh',
    });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'fresh ok',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(h.events).toContainEqual({ type: 'session_id', data: 'sdk-fresh', source: 'claude-code' });
    await vi.waitFor(() => expect(h.consumedInputs[1]?.length).toBe(1));

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('cleans up the in-flight send turn when it collides with the no-replay rebuild window', async () => {
    // 竞态回归(review PR #499):send 已过入口门禁、turnInFlight 已置,但还停在
    // toClaudeSdkContent 的附件转换里(replayableUserInput 尚未赋值)。此时 bootstrap
    // resume 失败走无 replay 恢复分支,end 旧队列后挂在 await currentQ.close() ——
    // send 恢复执行时 push 撞上「旧队列已 end、新队列未替换」的窗口返回 false。
    // 修复前:send 抛错但 turnInFlight 悬置 true、永无终态事件,会话永久 busy
    // (Session 层一律 SESSION_RUNNING、renderer 静默排队重试)。修复后:回收合成
    // turn(终态 done 边界),重建完成后会话照常可用。
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    // 让 send 停在附件转换里。
    let releaseResize!: (value: string) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseResize = resolve; }),
    );
    // 让恢复流程挂在 await currentQ.close(),把新旧队列交替窗口拉开。
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.queries[0].close.mockImplementation(async () => { await closeGate; });

    const sendPromise = h.handle.send({
      type: 'user',
      content: [
        { type: 'text', text: 'with attachment' },
        { type: 'image', path: '/tmp/pic.png' },
      ],
    });
    sendPromise.catch(() => { /* asserted below */ });
    await vi.waitFor(() => expect(imageResizerMock.process).toHaveBeenCalledTimes(1));
    expect(h.handle.isTurnRunning?.()).toBe(true);

    // bootstrap 阶段 resume 失败 → 无 replay 恢复分支启动,end 旧队列后停在 close 上。
    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(h.queries[0].close).toHaveBeenCalledTimes(1));

    // send 恢复执行:push 被已 end 的旧队列拒绝 → 抛错,但 turn 状态必须回收。
    releaseResize('/tmp/pic-resized.png');
    await expect(sendPromise).rejects.toThrow('Claude input queue is closed');
    expect(h.handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() =>
      expect(
        h.events.some(
          (event) =>
            event.type === 'done' &&
            (event.data as { reason?: string }).reason === 'send_failed_before_user_input',
        ),
      ).toBe(true),
    );

    // 放行 close → 重建完成;失效 id 已清、新 query 不带 resume,会话仍然可用。
    releaseClose();
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    expect(clear).toHaveBeenCalledWith('sdk-orphan');
    expect(h.queryOptions[1]).not.toHaveProperty('resume');
    await h.handle.send({ type: 'user', content: 'after recovery' });
    h.streams[1].emit({ type: 'system', subtype: 'init', session_id: 'sdk-fresh' });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await vi.waitFor(() => expect(h.consumedInputs[1]?.length).toBe(1));
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('parks a send arriving during the idle resume rebuild window and delivers it on the fresh query', async () => {
    // 重建窗口(旧队列已 end、新 query 未 startForwardLoop)内新进入的 send 不拒绝:
    // Session.send 的 onAccepted 已持久化/ack 消息,抛错会孤儿化。send 在入口等待
    // 重建门禁放行(亚秒),之后走正常受理,消息透明跑在新会话上。
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.queries[0].close.mockImplementation(async () => { await closeGate; });

    // 尚未 send,bootstrap 失败进入无 replay 重建;挂在 close 上拉开窗口。
    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(h.queries[0].close).toHaveBeenCalledTimes(1));

    // 窗口内 send 挂起等待,不入死队列、不抛错。
    let sendSettled = false;
    const sendPromise = h.handle
      .send({ type: 'user', content: 'queued during rebuild' })
      .finally(() => { sendSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSettled).toBe(false);

    // 窗口结束后 send 被正常受理并投递到新 query。
    releaseClose();
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    await sendPromise;
    await vi.waitFor(() => expect(h.consumedInputs[1]?.length).toBe(1));
    h.streams[1].emit({ type: 'system', subtype: 'init', session_id: 'sdk-fresh' });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('stops rebuilding when the session is closed mid-fallback', async () => {
    // close 竞态:用户在无 replay 重建窗口内关会话。恢复流程必须检测 closed 并收手,
    // 不能再起替换 query —— 否则会泄漏一个无 handle 管理的 CLI 进程 / 远端会话。
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.queries[0].close.mockImplementation(async () => { await closeGate; });

    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(h.queries[0].close).toHaveBeenCalledTimes(1));

    // 重建窗口内关会话;handle.close 不依赖挂起中的旧 query close,立即返回。
    await h.handle.close();
    releaseClose();
    await h.collected;

    // 恢复流程收手:不再创建替换 query,也没有 surface 终态错误。
    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('parks a send that arrives while the CAS clear is still awaiting', async () => {
    // gate 必须在 CAS await 之前装上:onInvalidResumeSession 可能很慢,期间新进入的
    // send 若不被拦在入口,会在 onAccepted 持久化后撞进稍后的队列交替窗口变成
    // 「已落库但从未送达」。正确行为:send 在入口挂起,重建完成后透明投递。
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const clear = vi.fn(async () => { await clearGate; return true; });
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.queries[0].close.mockImplementation(async () => { await closeGate; });

    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));

    // CAS 未返回,send 已被门禁拦在入口:未进入消息体处理(附件转换未发生),
    // 也没有登记 turn 状态。
    let sendSettled = false;
    const sendPromise = h.handle
      .send({
        type: 'user',
        content: [
          { type: 'text', text: 'during cas' },
          { type: 'image', path: '/tmp/cas-pic.png' },
        ],
      })
      .finally(() => { sendSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSettled).toBe(false);
    expect(imageResizerMock.process).not.toHaveBeenCalled();
    expect(h.handle.isTurnRunning?.()).toBe(false);

    // CAS 返回后重建继续(close 挂起拉开窗口),send 仍被拦住。
    releaseClear();
    await vi.waitFor(() => expect(h.queries[0].close).toHaveBeenCalledTimes(1));
    expect(imageResizerMock.process).not.toHaveBeenCalled();

    // 重建完成 → send 正常受理并投递到新 query。
    releaseClose();
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    await sendPromise;
    await vi.waitFor(() => expect(h.consumedInputs[1]?.length).toBe(1));
    h.streams[1].emit({ type: 'system', subtype: 'init', session_id: 'sdk-fresh' });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('keeps the deferred resume failure suppressed while a slow CAS clear is in flight', async () => {
    // 两步失败形态:先泛化 is_error result(进入 50ms 关联缓冲),再精确
    // "No conversation found" throw。CAS 很慢时,50ms 定时器若未在恢复入口被停掉,
    // 会把本该被静默恢复吞掉的终态错误漏给 UI。
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const clear = vi.fn(async () => { await clearGate; return true; });
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    h.streams[0].emit({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));

    // CAS 挂起超过 50ms 关联窗:缓冲的终态错误不得泄漏。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(h.events.some((event) => event.type === 'done')).toBe(false);

    releaseClear();
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('parks rewind preview until the idle rebuild finishes', async () => {
    // 重建窗口内 q 是死掉/半替换的旧 query:rewind preview/commit 不得打在它上面,
    // 与 send 同款等待门禁,替换 query 就绪后再操作。
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-orphan',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.queries[0].close.mockImplementation(async () => { await closeGate; });

    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-orphan'),
    );
    await vi.waitFor(() => expect(h.queries[0].close).toHaveBeenCalledTimes(1));

    // 窗口内发起 preview:挂起等待,不打在旧 query 上。
    const previewPromise = h.handle.previewRewindFiles?.('user-uuid-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.queries[0].rewindFiles).not.toHaveBeenCalled();

    // 重建完成后 preview 在新 query 上执行(全新会话自然软拒绝 canRewind:false)。
    releaseClose();
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    const result = await previewPromise!;
    expect(h.queries[1].rewindFiles).toHaveBeenCalledWith('user-uuid-1', { dryRun: true });
    expect(h.queries[0].rewindFiles).not.toHaveBeenCalled();
    expect(result.canRewind).toBe(false);

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('suppresses the failed resume boundary, replays one input, and finishes on a fresh query', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });

    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].emit({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    h.streams[0].fail(
      new Error('Claude Code returned an error result: No conversation found with session ID: sdk-old'),
    );
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    h.streams[1].emit({
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-new',
    });
    h.streams[1].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'recovered' }] },
      session_id: 'sdk-new',
    });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'recovered',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions[0]).toHaveProperty('resume', 'sdk-old');
    expect(h.queryOptions[1]).not.toHaveProperty('resume');
    await vi.waitFor(() => expect(h.consumedInputs.map((inputs) => inputs.length)).toEqual([1, 1]));
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(h.events).toContainEqual({
      type: 'session_id',
      data: 'sdk-new',
      source: 'claude-code',
    });

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('recovers a fresh session whose own assigned id the CLI reports as not found', async () => {
    // 把 Codex 会话切成全新 Claude 会话(无 resume):SDK 回填 sdk_session_id 并落库后,
    // 首个 turn 在转录落盘前就崩,CLI 把这个刚落库的 fresh id 报成 "No conversation found"。
    // 旧行为:因为不是 resume,失效识别门被跳过 → surface 原始终态报错 + 幽灵 id 留库,
    // 下一次 send resume 同一死会话反复失败。新行为:兜底匹配自身 sdkSessionId → 清幽灵 id
    // + 单次 fresh 重放,静默恢复。
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: undefined,
      transcriptExists: false,
      onInvalidResumeSession: clear,
    });

    // 全新会话:首个 query 不带 resume。
    expect(h.queryOptions).toHaveLength(1);
    expect(h.queryOptions[0]).not.toHaveProperty('resume');

    await h.handle.send({ type: 'user', content: 'hello once' });
    // SDK 回填 fresh id(生产链路里此 id 会被 maker 落库)。
    h.streams[0].emit({ type: 'system', subtype: 'init', session_id: 'sdk-fresh-phantom' });
    // 首个 turn 在转录落盘前崩,CLI 把 fresh id 报成 not found(以 exit error 抛出 → 走 catch)。
    h.streams[0].fail(
      new Error(
        'Claude Code returned an error result: No conversation found with session ID: sdk-fresh-phantom',
      ),
    );
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));

    // 幽灵 id 被清;重建 query 仍是全新(无 resume);没有 surface 终态错误。
    expect(clear).toHaveBeenCalledWith('sdk-fresh-phantom');
    expect(h.queryOptions[1]).not.toHaveProperty('resume');

    h.streams[1].emit({ type: 'system', subtype: 'init', session_id: 'sdk-fresh-2' });
    h.streams[1].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'recovered' }] },
      session_id: 'sdk-fresh-2',
    });
    h.streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'recovered',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);

    expect(clear).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.consumedInputs.map((inputs) => inputs.length)).toEqual([1, 1]));
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(h.events).toContainEqual({ type: 'session_id', data: 'sdk-fresh-2', source: 'claude-code' });

    await h.handle.close();
    h.streams[1].end();
    await h.collected;
  });

  it('stops after one fresh fallback when the replacement query also crashes', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].fail(new Error('No conversation found with session ID: sdk-old'));
    await vi.waitFor(() => expect(h.queryOptions).toHaveLength(2));
    h.streams[1].fail(new Error('fresh query crashed'));
    await h.collected;

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions).toHaveLength(2);
    expect(h.events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'sdk_stream_crashed',
      isTerminal: true,
    });
  });

  it('does not overwrite a concurrently replaced id when compare-and-clear misses', async () => {
    const clear = vi.fn(async () => false);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].fail(new Error('No conversation found with session ID: sdk-old'));
    await h.collected;

    expect(clear).toHaveBeenCalledTimes(1);
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'resume_session_not_found',
      isTerminal: true,
    });
  });

  it('keeps a valid resumed conversation on the original query without invoking recovery', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-valid',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'valid response' }] },
      session_id: 'sdk-valid',
    });
    h.streams[0].emit({
      type: 'result',
      is_error: false,
      result: 'valid response',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(h.events);

    expect(clear).not.toHaveBeenCalled();
    expect(h.queryOptions).toHaveLength(1);
    expect(h.queryOptions[0]).toHaveProperty('resume', 'sdk-valid');
    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(0);
    await h.handle.close();
    h.streams[0].end();
    await h.collected;
  });

  it('does not clear or retry unrelated HTTP failures', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-old',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].fail(new Error('HTTP 404 from upstream gateway'));
    await h.collected;

    expect(clear).not.toHaveBeenCalled();
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'sdk_stream_crashed',
      isTerminal: true,
    });
  });

  it('releases a non-resume is_error result after the short correlation window', async () => {
    const clear = vi.fn(async () => true);
    const h = await startHarness({
      resumeSessionId: 'sdk-valid',
      transcriptExists: true,
      onInvalidResumeSession: clear,
    });
    await h.handle.send({ type: 'user', content: 'hello once' });
    h.streams[0].emit({
      type: 'result',
      is_error: true,
      result: 'rate limit reached',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await waitForDone(h.events);

    expect(clear).not.toHaveBeenCalled();
    expect(h.queryOptions).toHaveLength(1);
    expect(h.events.find((event) => event.type === 'error')?.data).toMatchObject({
      message: 'rate limit reached',
      isTerminal: true,
    });
    await h.handle.close();
    h.streams[0].end();
    await h.collected;
  });

  it('uses the same one-shot fresh fallback for remote Claude sessions', async () => {
    const workingDir = await makeTempDir();
    const streams = [createControlledStream(), createControlledStream()];
    const queries = streams.map((stream) => ({
      ...createFakeQuery(stream),
      send: vi.fn(async () => {}),
    }));
    const startParams: Array<Record<string, unknown>> = [];
    const remoteCcQueryFactory = vi.fn(async (options: { startParams: Record<string, unknown> }) => {
      startParams.push(options.startParams);
      return queries[startParams.length - 1] as never;
    });
    const clear = vi.fn(async () => true);
    const agent = new ClaudeCodeAgent(
      createDeps({
        runtimeConfig: { remoteEndpoint: 'https://gateway.example' },
        remoteCcQueryFactory,
      }),
    );
    const handle = await agent.startSession({
      sessionId: 'remote-local-session',
      remoteHostId: 'remote-host',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
      resumeSessionId: 'remote-sdk-old',
      onInvalidResumeSession: clear,
    });
    const events: AgentEvent[] = [];
    const collected = (async () => {
      for await (const event of handle.events()) events.push(event);
    })();

    await handle.send({ type: 'user', content: 'remote hello' });
    await vi.waitFor(() => expect(queries[0].send).toHaveBeenCalledTimes(1));
    streams[0].fail(new Error('No conversation found with session ID: remote-sdk-old'));
    await vi.waitFor(() => expect(remoteCcQueryFactory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(queries[1].send).toHaveBeenCalledTimes(1));
    streams[1].emit({
      type: 'system',
      subtype: 'init',
      session_id: 'remote-sdk-new',
    });
    streams[1].emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'remote recovered' }] },
      session_id: 'remote-sdk-new',
    });
    streams[1].emit({
      type: 'result',
      is_error: false,
      result: 'remote recovered',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await waitForDone(events);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(startParams[0]).toHaveProperty('resumeSdkSessionId', 'remote-sdk-old');
    expect(startParams[1]).not.toHaveProperty('resumeSdkSessionId');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    await handle.close();
    streams[1].end();
    await collected;
  });

  it('replays runtime drift that arrives during the remote rebuild RPC window', async () => {
    // 远端分支 buildQuery 的 startParams 组装后要 await remoteCcQueryFactory 一次 RPC
    // 往返;窗口内到达的 runtime setter 被 controlRequestsBlocked() 短路成只改闭包。
    // 重建完成后必须按快照 diff 回放漂移(与 rewind rebuild 同款),否则新 query 带旧
    // 档位起跑而 handle getter 报新值。
    const workingDir = await makeTempDir();
    const streams = [createControlledStream(), createControlledStream()];
    const queries = streams.map((stream) => ({
      ...createFakeQuery(stream),
      send: vi.fn(async () => {}),
    }));
    const startParams: Array<Record<string, unknown>> = [];
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => { releaseFactory = resolve; });
    const remoteCcQueryFactory = vi.fn(async (options: { startParams: Record<string, unknown> }) => {
      startParams.push(options.startParams);
      const index = startParams.length - 1;
      if (index === 1) await factoryGate;
      return queries[index] as never;
    });
    const clear = vi.fn(async () => true);
    const agent = new ClaudeCodeAgent(
      createDeps({
        runtimeConfig: { remoteEndpoint: 'https://gateway.example' },
        remoteCcQueryFactory,
      }),
    );
    const handle = await agent.startSession({
      sessionId: 'remote-drift-session',
      remoteHostId: 'remote-host',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
      resumeSessionId: 'remote-sdk-old',
      onInvalidResumeSession: clear,
    });
    const events: AgentEvent[] = [];
    const collected = (async () => {
      for await (const event of handle.events()) events.push(event);
    })();

    // 尚未 send,bootstrap resume 失败 → 无 replay 重建;第二次 factory 调用被挂起。
    streams[0].fail(new Error('No conversation found with session ID: remote-sdk-old'));
    await vi.waitFor(() => expect(remoteCcQueryFactory).toHaveBeenCalledTimes(2));

    // RPC 窗口内切权限档:setter 被短路成只改闭包,不写死 query。
    await handle.setPermissionMode?.('default');
    expect(queries[1].setPermissionMode).not.toHaveBeenCalled();

    // 重建完成后漂移被回放到新 query。
    releaseFactory();
    await vi.waitFor(() => expect(queries[1].setPermissionMode).toHaveBeenCalledWith('default'));
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);

    await handle.close();
    streams[1].end();
    await collected;
  });
});
