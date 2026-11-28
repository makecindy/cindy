/**
 * Prime Agent 冒烟测试 —— 对着真二进制跑 `--mode rpc`。
 *
 * 这是 `agent_end` → `agent_settled` 映射的**实测验证点**:
 *   1. spawn 真的 `prime-agent --mode rpc`
 *   2. `get_state` 断言收到合法响应信封
 *   3. `prompt` 断言事件流能翻译成 `AgentEvent` **且 turn 能收口**
 *      (即 translator 合成了 `done`, Host 的 turn 状态机能出去)
 *
 * 二进制缺失时整组 skip(照仓库内 `describe.skipIf(!existsSync(binary))` 模式)。
 *
 * 用脚本化 faux provider(`PRIME_AGENT_FAUX_SCRIPT`)跑, 不碰真凭证:
 * 形状与 Prime Agent 自己的端到端用例一致
 * (crates/pa-cli/tests/rpc_mode_e2e.rs:271-302)。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../../types/events.js';
import { createAsyncQueue, type AsyncQueue } from '../../shared/async-queue.js';
import { PrimeAgentRpcProcess, type PrimeAgentRpcEvent } from '../rpc-client.js';
import { createPrimeAgentStdioTransport } from '../transport.js';
import {
  PRIME_AGENT_SOURCE,
  createPrimeAgentTranslateContext,
  markPrimeAgentHostAbortRequested,
  translatePrimeAgentEvent,
} from '../translator.js';
import type { PrimeAgentTranslateContext } from '../translator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * Prime Agent 二进制位置。可用 `PRIME_AGENT_BIN` 覆盖;
 * 缺省按本机安装路径 + 仓库 vendored 路径探测。
 */
function resolvePrimeAgentBinary(): string | undefined {
  const override = process.env.PRIME_AGENT_BIN;
  if (override && existsSync(override)) return override;
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'prime-agent', 'prime-agent.exe'),
    path.join(process.env.USERPROFILE ?? '', '.local', 'share', 'prime-agent', 'prime-agent.exe'),
    path.join(root, 'vendor', 'prime-agent', 'prime-agent.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

const binaryPath = resolvePrimeAgentBinary();

const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => logger,
};

const RPC_TIMEOUT_MS = 90_000;

/** 一个 `--mode rpc` 子进程 + 已挂好 translator 的事件队列。 */
async function startPrimeAgent(script: unknown): Promise<{
  proc: PrimeAgentRpcProcess;
  events: AgentEvent[];
  queue: AsyncQueue<AgentEvent>;
  ctx: PrimeAgentTranslateContext;
  stop: () => Promise<void>;
}> {
  const home = mkdtempSync(path.join(tmpdir(), 'cindy-prime-agent-smoke-'));
  mkdirSync(path.join(home, 'agent'), { recursive: true });
  const transport = createPrimeAgentStdioTransport({
    binaryPath: binaryPath as string,
    args: ['--mode', 'rpc', '--no-session'],
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PRIME_AGENT_CODING_AGENT_DIR: path.join(home, 'agent'),
      PRIME_AGENT_FAUX_SCRIPT: JSON.stringify(script),
      PRIME_AGENT_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
    },
    logger,
    stdinCloseGraceMs: 3_000,
  });

  const events: AgentEvent[] = [];
  const queue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
  const ctx = createPrimeAgentTranslateContext(logger);
  const proc = new PrimeAgentRpcProcess({
    transport,
    logger,
    onEvent: (event: PrimeAgentRpcEvent) => translatePrimeAgentEvent(event, queue, ctx),
    onExit: () => {
      queue.end();
    },
  });

  return {
    proc,
    events,
    queue,
    ctx,
    stop: async () => {
      await proc.close().catch(() => undefined);
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** 等到某个 AgentEvent 类型出现(轮询消费者已取出的事件数组)。 */
async function waitForEvent(
  events: AgentEvent[],
  type: string,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<AgentEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `timed out waiting for AgentEvent '${type}'; seen: ${events.map((event) => event.type).join(',') || '(none)'}`,
  );
}

/** 把 queue 里的事件持续搬进 events 数组。 */
function pump(queue: AsyncQueue<AgentEvent>, events: AgentEvent[]): void {
  void (async () => {
    for await (const event of queue) events.push(event);
  })();
}

/** 等到第 `afterCount + 1` 个某类型事件出现(跳过此前已收到的同类事件)。 */
async function waitForNewEvent(
  events: AgentEvent[],
  type: string,
  afterCount: number,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<AgentEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = events.filter((event) => event.type === type);
    if (matches.length > afterCount) return matches[afterCount] as AgentEvent;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `timed out waiting for a new AgentEvent '${type}' after ${afterCount}; `
    + `seen: ${events.map((event) => event.type).join(',') || '(none)'}`,
  );
}

describe.skipIf(!binaryPath)('Prime Agent RPC smoke (real binary)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('spawns --mode rpc and answers get_state with a valid response envelope', async () => {
    const session = await startPrimeAgent({ reasoning: true, responses: ['unused'] });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    const response = await session.proc.request(
      { type: 'get_state' },
      { timeoutMs: RPC_TIMEOUT_MS },
    );

    expect(response.type).toBe('response');
    expect(response.command).toBe('get_state');
    expect(response.success).toBe(true);
    expect(typeof response.data).toBe('object');
    const data = response.data as Record<string, unknown>;
    expect(typeof data.sessionId).toBe('string');
    expect(data.isStreaming).toBe(false);
    expect(data.isCompacting).toBe(false);
    expect(typeof data.messageCount).toBe('number');
  }, 120_000);

  it('accepts the set_auto_compaction{enabled:true} handshake step', async () => {
    const session = await startPrimeAgent({ reasoning: true, responses: ['unused'] });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    const response = await session.proc.request(
      { type: 'set_auto_compaction', enabled: true },
      { timeoutMs: RPC_TIMEOUT_MS },
    );

    expect(response.success).toBe(true);
    // Prime Agent 对这个命令答的是无 data 键的成功帧(protocol.rs:32-34)。
    expect('data' in response).toBe(false);
  }, 120_000);

  it('translates a prompt turn into AgentEvents AND closes the turn (agent_end → agent_settled)', async () => {
    const session = await startPrimeAgent({
      reasoning: true,
      responses: ['smoke reply one', 'smoke reply two'],
    });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    // 启动握手: set_auto_compaction → get_state 作 ready 门禁。
    const auto = await session.proc.request(
      { type: 'set_auto_compaction', enabled: true },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    expect(auto.success).toBe(true);
    const state = await session.proc.request(
      { type: 'get_state' },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    expect(state.success).toBe(true);

    // prompt: 应答在准入层就返回, 事件随后才到。
    const prompt = await session.proc.request(
      { type: 'prompt', message: 'hello from smoke test' },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    expect(prompt.success).toBe(true);

    // 1) 事件流翻译成了 AgentEvent
    const text = await waitForEvent(session.events, 'text');
    expect(text.data).toMatchObject({ isFinal: false });

    // 2) turn 收口 —— 这就是 agent_end → agent_settled 的实测验证点。
    const done = await waitForEvent(session.events, 'done');
    expect(done.data).toMatchObject({
      type: 'prime-agent/agent_settled',
      status: 'completed',
    });
    expect((done.data as { result?: string }).result).toContain('smoke reply one');

    // 3) 收口的另一半: status 落到 isRunning=false, Host 不会卡 running。
    const doneIndex = session.events.indexOf(done);
    const statusAfterDone = session.events
      .slice(doneIndex)
      .find((event) => event.type === 'status');
    expect(statusAfterDone?.data).toMatchObject({ isRunning: false });

    // 4) 每条事件都带 Prime Agent 来源标识。
    expect(session.events.every((event) => event.source === PRIME_AGENT_SOURCE)).toBe(true);
  }, 180_000);

  it('closes the turn again on a second prompt (settlement is repeatable)', async () => {
    const session = await startPrimeAgent({
      reasoning: true,
      responses: ['first', 'second', 'third'],
    });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    await session.proc.request({ type: 'set_auto_compaction', enabled: true });
    for (const message of ['turn one', 'turn two']) {
      const before = session.events.filter((event) => event.type === 'done').length;
      const prompt = await session.proc.request({ type: 'prompt', message });
      expect(prompt.success).toBe(true);
      // 等**新的** done: waitForEvent 会命中上一轮已存在的那一个。
      await waitForNewEvent(session.events, 'done', before);
    }
    expect(session.events.filter((event) => event.type === 'done')).toHaveLength(2);
  }, 180_000);

  it('closes the turn after a host abort (cancelled outcome)', async () => {
    const session = await startPrimeAgent({
      reasoning: true,
      // delayMs 让 turn 停在 LLM 调用里, abort 才有东西可停。
      responses: [{ text: 'slow reply', delayMs: 8_000 }],
    });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    const prompt = await session.proc.request({ type: 'prompt', message: 'will be aborted' });
    expect(prompt.success).toBe(true);
    // abort 必须在 turn 还停在 LLM 调用里时发出: `text_delta` 要等 delayMs 走完才到,
    // 所以不能等 text 事件(那时已经来不及了)。
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 与真实 handle 的 abort() 同一步: 先登记 Host 主动停止, 再发 abort RPC。
    // 不登记的话, Prime Agent 报上来的 `stopReason:'aborted'` + errorMessage 会被
    // 当成一次可恢复的 provider 错误, 终态就变成 failed 而不是 cancelled。
    markPrimeAgentHostAbortRequested(session.ctx);
    const abort = await session.proc.request({ type: 'abort' });
    expect(abort.success).toBe(true);

    const done = await waitForEvent(session.events, 'done');
    expect(done.data).toMatchObject({ status: 'cancelled' });
    expect(session.events.some((event) => event.type === 'error')).toBe(false);
    const after = await session.proc.request({ type: 'get_state' });
    expect((after.data as { isStreaming?: boolean }).isStreaming).toBe(false);
  }, 180_000);

  it('answers compact with the TS skip error on a too-short session', async () => {
    const session = await startPrimeAgent({ reasoning: true, responses: ['unused'] });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    const response = await session.proc.request(
      { type: 'compact' },
      {
        timeoutMs: RPC_TIMEOUT_MS,
        refreshTimeoutOnEvent: (event) =>
          event.type === 'compaction_start' || event.type === 'compaction_end',
      },
    );

    expect(response.success).toBe(false);
    expect(String(response.error)).toMatch(/too short to compact/i);
  }, 180_000);

  it('reports an unknown command with success:false and the echoed command name', async () => {
    const session = await startPrimeAgent({ reasoning: true, responses: ['unused'] });
    cleanups.push(session.stop);
    pump(session.queue, session.events);

    const response = await session.proc.request({ type: 'definitely_not_a_command' });
    expect(response.success).toBe(false);
    expect(response.command).toBe('definitely_not_a_command');
    expect(String(response.error)).toMatch(/^Unknown command:/);
  }, 120_000);
});

describe.skipIf(binaryPath)('Prime Agent RPC smoke (real binary) — skipped', () => {
  it('skips when the binary is absent', () => {
    expect(binaryPath).toBeUndefined();
  });
});
