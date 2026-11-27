/**
 * Generic ACP v1 engine, driven through its public entry `openAcpSession` against
 * an in-memory ACP agent (no subprocess, no network).
 *
 * 测试价值
 * - 生产入口与可观察结果：openAcpSession / AcpSession 的公开方法；断言 Cindy 看到的
 *   AgentEvent 序列，以及发回 Agent 的 JSON-RPC（权限选项、session/cancel、resume 方法）。
 * - 规则依据：docs/plans/acp-plugin-bridge.md「一、maker-core：通用 ACP 引擎」的行为映射表；
 *   ACP v1 规范（cancel 后对未决权限请求回 cancelled；每会话同时一个 prompt；load 回放不重复展示）。
 * - 现有覆盖缺口：新模块，无既有覆盖。
 * - 最小失败输入：见各用例（例如等待权限确认时 abort、对端进程中途退出、仅支持 loadSession 的恢复）。
 * - tier：unit（进程内假对端，无真实等待；宽限期用 fake timers）。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../types/events.js';
import { NotSupportedError } from '../../types/capabilities.js';
import { LIBRARY_READ_ROOT } from '../shared/library-native-read.js';
import { AcpLineDecoder, AcpLineTooLongError, type AcpLineTransport, type AcpTransportClosed } from './line-transport.js';
import {
  AcpAccountError,
  AcpAuthRequiredError,
  AcpResumeUnavailableError,
  openAcpSession,
  type AcpSession,
  type OpenAcpSessionOptions,
} from './session.js';
import { asRecord, type AcpRecord } from './protocol.js';
import { AcpAgent, acpMcpServersFromBridge } from './acp-agent.js';
import {
  defusePluginEngineSlashMentions,
  defusePluginEngineWireEnvelope,
  formatPluginEngineSkillList,
  renderPluginEngineCapabilityBriefing,
} from './briefing.js';
import {
  createAcpMcpResultBackfiller,
  createMcpToolResultBucket,
  parseAcpMcpToolName,
} from './mcp-tool-result.js';
import {
  AgentStartupCleanupPendingError,
  AgentStartupStoppedError,
  TurnPermissionPolicyUnsupportedError,
  type SendOptions,
  type TurnPermissionPolicy,
} from '../base-agent.js';
import { NATIVE_SUBSCRIPTION_ACCOUNT } from '../../interfaces/auth-adapter.js';
import type { Logger } from '../../interfaces/logger.js';
import { Session } from '../../session.js';

type Handler = (params: AcpRecord) => unknown;

interface FakeAgentOptions {
  agentCapabilities?: AcpRecord;
  authMethods?: AcpRecord[];
  configOptions?: AcpRecord[];
  handlers?: Record<string, Handler>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Agent side of an ACP connection, scripted by each test. */
function createFakeAgent(options: FakeAgentOptions = {}) {
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(info: AcpTransportClosed) => void>();
  const sent: AcpRecord[] = [];
  const pendingAgentRequests = new Map<number, (message: AcpRecord) => void>();
  const prompts: Array<{ params: AcpRecord; settle: ReturnType<typeof deferred<AcpRecord>> }> = [];
  let nextAgentRequestId = 1000;
  let closed = false;
  let closedByClient = false;

  const toClient = (message: AcpRecord): void => {
    const line = JSON.stringify(message);
    for (const listener of [...lineListeners]) listener(line);
  };

  const handlers: Record<string, Handler> = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: options.agentCapabilities ?? {},
      authMethods: options.authMethods ?? [],
    }),
    'session/new': () => ({ sessionId: 'sess-1', configOptions: options.configOptions ?? [] }),
    'session/prompt': (params) => {
      const settle = deferred<AcpRecord>();
      prompts.push({ params, settle });
      return settle.promise;
    },
    'session/set_config_option': () => ({ configOptions: options.configOptions ?? [] }),
    ...options.handlers,
  };

  const receive = async (message: AcpRecord): Promise<void> => {
    if (typeof message.method === 'string') {
      if (message.id === undefined) return; // notification (session/cancel)
      const handler = handlers[message.method];
      try {
        if (!handler) throw Object.assign(new Error('Method not found'), { code: -32601 });
        const result = await handler((message.params ?? {}) as AcpRecord);
        toClient({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -32603;
        const data = (error as { data?: unknown }).data;
        toClient({ jsonrpc: '2.0', id: message.id, error: { code, message: (error as Error).message, ...(data !== undefined ? { data } : {}) } });
      }
      return;
    }
    if (typeof message.id === 'number') pendingAgentRequests.get(message.id)?.(message);
  };

  const transport: AcpLineTransport = {
    write(line) {
      if (closed) throw new Error('closed');
      const message = JSON.parse(line) as AcpRecord;
      sent.push(message);
      queueMicrotask(() => { void receive(message); });
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    async close() {
      closed = true;
      closedByClient = true;
    },
  };

  return {
    transport,
    sent,
    prompts,
    get closedByClient() { return closedByClient; },
    methods: () => sent.filter((message) => typeof message.method === 'string').map((message) => message.method),
    update(update: AcpRecord, sessionId = 'sess-1') {
      toClient({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    },
    rawLine(line: string) {
      for (const listener of [...lineListeners]) listener(line);
    },
    requestPermission(params: AcpRecord): Promise<AcpRecord> {
      const id = nextAgentRequestId++;
      return new Promise((resolve) => {
        pendingAgentRequests.set(id, (msg) => resolve((msg.result ?? {}) as AcpRecord));
        toClient({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'sess-1', ...params } });
      });
    },
    requestElicitation(params: AcpRecord): Promise<AcpRecord> {
      const id = nextAgentRequestId++;
      return new Promise((resolve) => {
        pendingAgentRequests.set(id, resolve);
        toClient({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { sessionId: 'sess-1', ...params } });
      });
    },
    exit() {
      closed = true;
      for (const listener of [...closeListeners]) listener({ reason: 'peer-exited', detail: 'exit code 1' });
    },
  };
}

type FakeAgent = ReturnType<typeof createFakeAgent>;

async function open(agent: FakeAgent, extra: Partial<OpenAcpSessionOptions> = {}): Promise<{ session: AcpSession; events: AgentEvent[]; ended: Promise<void> }> {
  const session = await openAcpSession({
    transport: agent.transport,
    cwd: '/work/project',
    clientInfo: { name: 'cindy', version: 'test' },
    ...extra,
  });
  const events: AgentEvent[] = [];
  const ended = (async () => { for await (const event of session.events()) events.push(event); })();
  return { session, events, ended };
}

// Absolute on every platform; never read (images are injected through readFile).
const SHOT = resolve('attachments', 'shot.png');
const NOTES = resolve('attachments', 'notes.md');

const PERMISSION_OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('ACP line decoder (host stdout chunks)', () => {
  it('splits CRLF lines, joins UTF-8 split across chunks, skips blanks and flushes the tail', () => {
    const lines: string[] = [];
    const decoder = new AcpLineDecoder((line) => lines.push(line));
    const bytes = new TextEncoder().encode('{"a":"你好"}\r\n\n{"b":1}\n{"c":2}');
    decoder.push(bytes.slice(0, 8)); // cuts inside a multi-byte character
    decoder.push(bytes.slice(8));
    decoder.flush();
    expect(lines).toEqual(['{"a":"你好"}', '{"b":1}', '{"c":2}']);
  });

  it('rejects a runaway line instead of buffering without bound', () => {
    const decoder = new AcpLineDecoder(() => {}, 8);
    expect(() => decoder.push('0123456789')).toThrow(AcpLineTooLongError);
  });
});

describe('openAcpSession handshake', () => {
  it('negotiates v1 without client fs/terminal and drops MCP transports the agent did not advertise', async () => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: false } } });
    const warn = vi.fn();
    const logger: Logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
      fatal: () => {},
      child: () => logger,
    };
    const { session } = await open(agent, {
      logger,
      mcpServers: [
        { type: 'http', name: 'cindy-tools', url: 'http://127.0.0.1:1/mcp', headers: [] },
        { name: 'local', command: '/bin/tool', args: [], env: [] },
      ],
    });
    const [initialize, sessionNew] = agent.sent;
    expect(initialize).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
        },
      },
    });
    expect(sessionNew).toMatchObject({ method: 'session/new', params: { cwd: '/work/project' } });
    expect((sessionNew.params as AcpRecord).mcpServers).toEqual([{ name: 'local', command: '/bin/tool', args: [], env: [] }]);
    expect(session.droppedMcpServers).toEqual(['cindy-tools']);
    expect(warn).toHaveBeenCalledWith(
      'acp: dropping MCP servers whose transport the agent did not advertise',
      { dropped: ['cindy-tools'], mcpCapabilities: { http: false, sse: false } },
    );
    expect(session.id).toBe('sess-1');
    expect(session.resumeOutcome).toBe('new');
  });

  // Unit: ACP v1 Session Setup requires capability gating. Exercise the real handshake
  // with a one-character instruction to catch missing or misplaced lifecycle fields.
  it.each([
    { method: 'session/new', supported: true, text: 'x', expected: { mode: 'append', content: [{ type: 'text', text: 'x' }] } },
    { method: 'session/load', supported: true, text: 'x', expected: { mode: 'append', content: [{ type: 'text', text: 'x' }] } },
    { method: 'session/resume', supported: true, text: 'x', expected: { mode: 'append', content: [{ type: 'text', text: 'x' }] } },
    { method: 'session/resume', supported: true, text: undefined, expected: undefined },
    { method: 'session/new', supported: false, text: 'x', expected: undefined },
  ])('sends the personal system prompt on $method when supported ($supported, $text)', async ({
    method, supported, text, expected,
  }) => {
    const isNew = method === 'session/new';
    const agent = createFakeAgent({
      agentCapabilities: {
        loadSession: method === 'session/load',
        sessionCapabilities: {
          ...(method === 'session/resume' ? { resume: {} } : {}),
          ...(supported ? { systemPrompt: {} } : {}),
        },
      },
      handlers: isNew ? {} : { [method]: () => ({}) },
    });
    const { session } = await open(agent, {
      personalSystemPrompt: text,
      ...(!isNew ? { resumeSessionId: 'old-1' } : {}),
    });
    expect(agent.methods()).toEqual(['initialize', method]);
    expect((agent.sent[1]!.params as AcpRecord).systemPrompt).toEqual(expected);
    await session.close();
  });

  it('maps auth-required to a typed error and closes the endpoint', async () => {
    const agent = createFakeAgent({
      authMethods: [{ id: 'login', name: 'Sign in' }],
      handlers: { 'session/new': () => { throw Object.assign(new Error('auth'), { code: -32000 }); } },
    });
    const failure = await openAcpSession({ transport: agent.transport, cwd: '/w', clientInfo: { name: 'c', version: '1' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpAuthRequiredError);
    expect((failure as AcpAuthRequiredError).authMethods).toEqual([{ id: 'login', name: 'Sign in' }]);
    expect(agent.closedByClient).toBe(true);
  });

  it.each([
    { name: 'session/resume when advertised', caps: { sessionCapabilities: { resume: {} }, loadSession: true }, method: 'session/resume', outcome: 'resumed' },
    { name: 'session/load as fallback', caps: { loadSession: true }, method: 'session/load', outcome: 'loaded' },
  ])('resumes with $name and never replays old history as new output', async ({ caps, method, outcome }) => {
    const agent = createFakeAgent({
      agentCapabilities: caps,
      handlers: {
        [method]: () => {
          // A load replays history before answering; Cindy already has it on screen.
          agent.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } }, 'old-1');
          agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } }, 'old-1');
          return {};
        },
      },
    });
    const { session, events } = await open(agent, { resumeSessionId: 'old-1' });
    expect(agent.methods()).toEqual(['initialize', method]);
    expect(session.id).toBe('old-1');
    expect(session.resumeOutcome).toBe(outcome);
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  // 引擎账号(plugin-harnesses.md 引擎账号，2026-11-23)：入口把账号原因写在 error.data._meta.cindy 里，Cindy 据此冷却账号、
  // 换号；消息只用 Cindy 自己的稳定码，不带 Agent 原文。最小失败输入：session/new 报额度用完并给重置时间。
  it('turns an account classification on session/new into an account error the host can switch on', async () => {
    const agent = createFakeAgent({
      handlers: { 'session/new': () => { throw Object.assign(new Error('quota'), { code: -32603, data: { _meta: { cindy: { kind: 'usage-limit', resetsAt: 1_900_000_000_000 } } } }); } },
    });
    const failure = await openAcpSession({ transport: agent.transport, cwd: '/w', clientInfo: { name: 'c', version: '1' } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpAccountError);
    expect((failure as AcpAccountError).message).toMatch(/^\[SUBSCRIPTION_ACCOUNT_LIMITED\]/);
    expect((failure as AcpAccountError).signals).toEqual({ usageLimit: true, usageResetAt: 1_900_000_000_000 });
  });

  it('refuses to silently start fresh when the agent cannot resume', async () => {
    const agent = createFakeAgent();
    await expect(open(agent, { resumeSessionId: 'old-1' })).rejects.toBeInstanceOf(AcpResumeUnavailableError);
    expect(agent.methods()).toEqual(['initialize']);
    expect(agent.closedByClient).toBe(true);
  });

  // Idle runtime reclamation closes only runtimes the next send can reopen; an agent with neither
  // method would fail that resume (above), so it must answer false and keep its runtime.
  it.each([
    { name: 'neither method', caps: {}, reopenable: false },
    { name: 'session/load', caps: { loadSession: true }, reopenable: true },
    { name: 'session/resume', caps: { sessionCapabilities: { resume: {} } }, reopenable: true },
  ])('reports whether a closed session can be reopened with $name', async ({ caps, reopenable }) => {
    const { session } = await open(createFakeAgent({ agentCapabilities: caps }));
    expect(session.canResumeAfterClose()).toBe(reopenable);
  });
});

describe('AcpSession turns', () => {
  // Tier 1: the provider emitted a stand-alone warning after an edit. The native turn must stay
  // pending and continue once on that same session, without resending the original command.
  // #13373: each native prompt reports its own spend. Missing usage on a continuation must preserve the first report.
  it.each([
    { name: 'both prompts report usage', resumedUsage: { inputTokens: 50, outputTokens: 6, cachedReadTokens: 8, cachedWriteTokens: 1 },
      expected: { inputTokens: 60, outputTokens: 9, cacheReadTokens: 12, cacheCreationTokens: 3 } },
    { name: 'only the first prompt reports usage', resumedUsage: undefined,
      expected: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheCreationTokens: 2 } },
  ])('holds a verification warning and settles usage once when $name', async ({ resumedUsage, expected }) => {
    const agent = createFakeAgent({ handlers: { '_cindy/checkAccountVerification': () => ({ status: 'ready' }) } });
    const owner = deferred<void>();
    const { session, events } = await open(agent, { recoverVerification: async (probe) => {
      await owner.promise;
      return (await probe()).status === 'ready' ? 'ready' : 'unavailable';
    } });
    await session.send({ type: 'user', content: 'edit-once' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'completed' });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Verification Required' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn',
      usage: { inputTokens: 16, outputTokens: 3, cachedReadTokens: 4, cachedWriteTokens: 2, totalTokens: 19 },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(events.some(e => e.type === 'done')).toBe(false);
    owner.resolve();
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.sessionId).toBe('sess-1');
    expect(JSON.stringify(agent.prompts[1]!.params.prompt)).not.toContain('edit-once');
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished.' } });
    agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn', usage: resumedUsage });
    await vi.waitFor(() => expect(events.filter(e => e.type === 'done')).toHaveLength(1));
    expect(events.at(-1)?.data).toMatchObject({ usage: expected });
    await session.close();
  });

  // Tier 1, #13373: a user may stop while the QR is on screen, or verification may fail after a billed edit.
  it.each(['stop', 'unavailable'] as const)('keeps the first usage report when verification ends with %s', async (action) => {
    const agent = createFakeAgent();
    const outcome = deferred<'ready' | 'unavailable'>();
    const recoverVerification = vi.fn(() => outcome.promise);
    const { session, events } = await open(agent, { recoverVerification });
    await session.send({ type: 'user', content: 'edit-once' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Verification Required' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } });
    await vi.waitFor(() => expect(recoverVerification).toHaveBeenCalledOnce());
    if (action === 'stop') await session.abort();
    outcome.resolve(action === 'stop' ? 'ready' : 'unavailable');
    const terminalType = action === 'stop' ? 'done' : 'error';
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe(terminalType));
    expect(events.at(-1)?.data).toMatchObject({
      type: 'acp/prompt_end', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ...(action === 'stop' ? { stopReason: 'cancelled' } : { isTerminal: true, reason: 'acp-auth-required' }),
    });
    expect(agent.prompts).toHaveLength(1);
    await session.close();
  });

  it('leaves a quota warning out of verification recovery', async () => {
    const agent = createFakeAgent();
    const recoverVerification = vi.fn();
    const { session, events } = await open(agent, { recoverVerification });
    await session.send({ type: 'user', content: 'hello' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Individual quota reached.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.some(e => e.type === 'done')).toBe(true));
    expect(recoverVerification).not.toHaveBeenCalled();
    await session.close();
  });

  it('streams thinking, text segments and tool calls in the shapes the built-in engines use', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'fix the bug' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params).toEqual({ sessionId: 'sess-1', prompt: [{ type: 'text', text: 'fix the bug' }] });

    agent.rawLine('Loading model… (banner printed on stdout)');
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Look at ' } });
    agent.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'main.ts' } });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Editing.' } });
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit main.ts', kind: 'edit', status: 'pending' });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'in_progress',
      rawInput: { path: 'main.ts' },
    });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawInput: { path: 'main.ts' },
      content: [{ type: 'diff', path: 'main.ts', oldText: 'a\n', newText: 'b\n' }],
    });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));

    const summary = events.map((event) => {
      const data = event.data as AcpRecord;
      return `${event.type}:${String(data.stage ?? data.summary ?? (data.isFinal === true ? 'final' : data.isFinal === false ? 'delta' : ''))}`;
    });
    expect(summary).toEqual([
      'status:',
      'thinking:start', 'thinking:delta', 'thinking:delta', 'thinking:final',
      'text:delta', 'text:final',
      'tool_use:', 'tool_use:', 'tool_result_full:', 'tool_result:done',
      'text:delta', 'text:final',
      'done:',
    ]);
    expect(events.find((event) => event.type === 'thinking' && (event.data as AcpRecord).stage === 'final')?.data)
      .toMatchObject({ text: 'Look at main.ts' });
    expect(events.filter((event) => event.type === 'tool_use').map((event) => event.data)).toMatchObject([
      { toolUseId: 't1', toolName: 'Edit main.ts', input: {} },
      { toolUseId: 't1', toolName: 'Edit main.ts', input: { path: 'main.ts' }, acpInputPatch: true },
    ]);
    expect((events.find((event) => event.type === 'tool_result_full')?.data as AcpRecord).fullText).toContain('-a\n+b');
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', result: 'Done.', stopReason: 'end_turn' });
    expect(events.every((event) => event.turnScope === undefined)).toBe(true);
  });

  // 2026-11-23: plugin engine usage pages counted turns but showed no tokens, because the per-turn
  // `usage` of the prompt result was dropped. Inputs are what Antigravity (agy 1.5.15) returned for two
  // turns (input excludes the cache), the same counts in the input-includes-cache form, and a result
  // without usage. Production entry: AcpSession send → done event; unit, in-process fake agent.
  it.each([
    ['input excludes the cache (agy turn 1)',
      { inputTokens: 11516, outputTokens: 27, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 25, totalTokens: 11543 },
      { inputTokens: 11516, outputTokens: 27, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    ['input excludes the cache (agy turn 2)',
      { inputTokens: 2161, outputTokens: 15, cachedReadTokens: 9459, cachedWriteTokens: 0, thoughtTokens: 12, totalTokens: 11635 },
      { inputTokens: 2161, outputTokens: 15, cacheReadTokens: 9459, cacheCreationTokens: 0 }],
    ['input includes the cache',
      { inputTokens: 11620, outputTokens: 15, cachedReadTokens: 9459, totalTokens: 11635 },
      { inputTokens: 2161, outputTokens: 15, cacheReadTokens: 9459, cacheCreationTokens: 0 }],
    ['no usage reported', undefined, undefined],
  ])('reports the turn tokens from the prompt result: %s', async (_name, reported, expected) => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'hi' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn', ...(reported ? { usage: reported } : {}) });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect((events.at(-1)?.data as AcpRecord).usage).toEqual(expected);
  });

  it('runs one prompt at a time, in send order even when the first message carries a slow image', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { image: true } } });
    const image = deferred<Uint8Array>();
    const { session, events } = await open(agent, { readFile: () => image.promise });
    const first = session.send({ type: 'user', content: [{ type: 'image', path: SHOT }, { type: 'text', text: 'one' }] });
    const second = session.send({ type: 'user', content: 'two' });
    image.resolve(new Uint8Array([1, 2, 3]));
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'text', text: 'one' },
    ]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  // 协作 Worker 的角色说明：插件引擎不收 Cindy system prompt，只能随第一条消息送达（docs/plans/acp-plugin-bridge.md 第二期「协作」）。
  // 缺口：未覆盖时说明可能每条都带（浪费上下文）或恢复后重复；最小失败输入：新会话连发两条、恢复后发一条。
  it('sends the host briefing once, ahead of the first message of a new session only', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { briefing: 'You are a Worker.' });
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'text', text: 'You are a Worker.' },
      { type: 'text', text: 'one' },
    ]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await session.send({ type: 'user', content: 'two' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
  });

  it('does not repeat the briefing in a resumed session, which already has it in its history', async () => {
    const agent = createFakeAgent({ agentCapabilities: { loadSession: true }, handlers: { 'session/load': () => ({}) } });
    const { session } = await open(agent, { resumeSessionId: 'old-1', briefing: 'You are a Worker.' });
    await session.send({ type: 'user', content: 'next' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([{ type: 'text', text: 'next' }]);
  });

  it('passes attachments as resource links when the agent does not take images', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    await session.send({ type: 'user', content: [{ type: 'image', path: SHOT }, { type: 'file', path: NOTES }] });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([
      { type: 'resource_link', uri: pathToFileURL(SHOT).href, name: 'shot.png', mimeType: 'image/png' },
      { type: 'resource_link', uri: pathToFileURL(NOTES).href, name: 'notes.md' },
    ]);
  });

  it('marks agent output produced outside a prompt as background work', async () => {
    const agent = createFakeAgent();
    const { events } = await open(agent);
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'Subagent finished', status: 'completed' });
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events.map((event) => [event.type, event.turnScope])).toEqual([
      ['tool_use', 'background'], ['tool_result_full', 'background'], ['tool_result', 'background'],
    ]);
  });

  // Regression (Antigravity, 2026-11-20): the agent answered the prompt while its `git commit`
  // was still running and reported the result 21 s later. The call used to be marked done at
  // the end of the answer, and the real result arrived as a second card nobody saw as running.
  it('keeps a call the agent is still running open past its answer and settles it with the later result', async () => {
    let now = 1_000;
    const agent = createFakeAgent();
    const { session, events } = await open(agent, { now: () => now });
    await session.send({ type: 'user', content: 'commit and open a PR' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'commit', title: 'git commit', status: 'in_progress' });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Committing, then pushing.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);
    await expect(session.hasLiveBackgroundWork()).resolves.toBe(true);

    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'commit',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '[fix 79a580a] fix' } }],
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('tool_result'));
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    expect(events.slice(-2).map((event) => [event.type, event.turnScope, (event.data as AcpRecord).summary]))
      .toEqual([['tool_result_full', 'background', undefined], ['tool_result', 'background', 'done']]);
    // Background output keeps the runtime busy for the quiet window, then it is idle.
    await expect(session.hasLiveBackgroundWork()).resolves.toBe(true);
    now += 30_001;
    await expect(session.hasLiveBackgroundWork()).resolves.toBe(false);
  });

  // Live check against Antigravity (2026-11-20): after its command finished it wrote
  // "The content of done.txt is: finished" between turns. Nothing ever closed that text, so it
  // streamed forever and was never saved (no between-turn reply of the agent was in local history).
  it('closes a reply the agent writes between turns once it pauses, so it is kept like any reply', async () => {
    vi.useFakeTimers();
    const agent = createFakeAgent();
    const { events } = await open(agent);
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The content is: ' } });
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`finished`' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.map((event) => [event.type, (event.data as AcpRecord).isFinal])).toEqual([['text', false], ['text', false]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.at(-1)).toMatchObject({
      type: 'text',
      turnScope: 'background',
      data: { text: 'The content is: `finished`', isFinal: true, isFullText: true },
    });
  });

  // PR #11776 review: progress on a running call changes nothing on screen, so it produced no
  // event, never restarted the quiet bound, and a command still reporting progress was marked done.
  it('treats progress on a call left running as activity, so the quiet bound restarts', async () => {
    vi.useFakeTimers();
    const agent = createFakeAgent();
    const { session, events } = await open(agent, { openToolQuietCapMs: 60_000 });
    await session.send({ type: 'user', content: 'build it' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'build', title: 'Build', status: 'in_progress' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(40_000);
      agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'build', status: 'in_progress' });
    }
    await vi.advanceTimersByTimeAsync(40_000);
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);
    await expect(session.hasLiveBackgroundWork()).resolves.toBe(true);
  });

  it('bounds calls left open between turns: settled after the quiet cap, interrupted when the agent exits', async () => {
    vi.useFakeTimers();
    const quiet = createFakeAgent();
    const capped = await open(quiet, { openToolQuietCapMs: 60_000 });
    await capped.session.send({ type: 'user', content: 'wait for CI' });
    await vi.waitFor(() => expect(quiet.prompts).toHaveLength(1));
    quiet.update({ sessionUpdate: 'tool_call', toolCallId: 'wait', title: 'Run schedule', status: 'in_progress' });
    quiet.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(capped.events.at(-1)?.type).toBe('done'));
    // Stopping while the agent works between turns cancels that work (agents without a prompt in flight ignore it).
    await capped.session.abort();
    expect(quiet.methods()).toContain('session/cancel');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(capped.events.at(-1)?.type).toBe('done');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capped.events.at(-1)).toMatchObject({ type: 'tool_result', turnScope: 'background', data: { summary: 'done' } });

    const exiting = createFakeAgent();
    const live = await open(exiting);
    await live.session.send({ type: 'user', content: 'deploy' });
    await vi.waitFor(() => expect(exiting.prompts).toHaveLength(1));
    exiting.update({ sessionUpdate: 'tool_call', toolCallId: 'deploy', title: 'Deploy', status: 'in_progress' });
    exiting.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(live.events.at(-1)?.type).toBe('done'));
    exiting.exit();
    await live.ended;
    expect(live.events.slice(-2)).toMatchObject([
      { type: 'tool_result_full', turnScope: 'background', data: { isError: true } },
      { type: 'tool_result', turnScope: 'background', data: { summary: 'failed' } },
    ]);
  });
});

// 插话：ACP v1 没有同轮输入，Agent 在 initialize 顶层 `_meta.steering.supported` 声明
// `_session/steering` 扩展（claude-agent-acp / codex-acp 等）时才走同轮注入。
// 缺口：此前插件引擎一律 sameTurnSteer 不支持，用户插话只能报错或等下一轮。
// 最小失败输入：声明了扩展的 Agent 运行中插话一条；Agent 回 promptRequired / 不认识方法 / 不回答。
describe('AcpSession same-turn steering', () => {
  const steeringInit = (): AcpRecord => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], _meta: { steering: { supported: true } } });
  const finalTexts = (events: AgentEvent[]): unknown[] => events
    .filter((event) => event.type === 'text' && (event.data as AcpRecord).isFinal === true)
    .map((event) => (event.data as AcpRecord).text);

  it('starts a new reply segment when the steer acknowledgement and text share a stdout chunk', async () => {
    const agent = createFakeAgent({ handlers: { initialize: steeringInit, '_session/steering': () => new Promise(() => {}) } });
    const { session, events } = await open(agent);
    expect(session.capabilities.sameTurnSteer.supported).toBe(true);
    await session.send({ type: 'user', content: 'fix the bug' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Editing a.ts.' } });

    const steer = session.steer({ type: 'user', content: 'use b.ts instead' });
    await vi.waitFor(() => expect(agent.methods()).toContain('_session/steering'));
    const request = agent.sent.find((message) => message.method === '_session/steering')!;
    expect(agent.sent.filter((message) => message.method === '_session/steering').map((message) => message.params)).toEqual([{
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'use b.ts instead' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }]);
    const chunk = [
      { jsonrpc: '2.0', id: request.id, result: { outcome: 'injected' } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Switching to b.ts.' },
      } } },
    ].map((message) => JSON.stringify(message) + '\n').join('');
    new AcpLineDecoder(agent.rawLine).push(new TextEncoder().encode(chunk));
    await steer;
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));

    expect(agent.prompts).toHaveLength(1);
    expect(finalTexts(events)).toEqual(['Editing a.ts.', 'Switching to b.ts.']);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('treats outcome: queued (e.g. zcode-acp) as accepted without flushing or withdrawing steering', async () => {
    const agent = createFakeAgent({ handlers: { initialize: steeringInit, '_session/steering': () => ({ outcome: 'queued' }) } });
    const { session, events } = await open(agent);
    const capabilityUpdates: boolean[] = [];
    session.onCapabilitiesChange((capabilities) => capabilityUpdates.push(capabilities.sameTurnSteer.supported));
    await session.send({ type: 'user', content: 'first' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1.' } });

    await expect(session.steer({ type: 'user', content: 'follow up' })).resolves.toBeUndefined();
    // Queued does not flush the in-flight assistant segment early.
    expect(finalTexts(events)).toEqual([]);
    expect(session.capabilities.sameTurnSteer.supported).toBe(true);
    expect(capabilityUpdates).toEqual([]);

    agent.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Part 2.' } });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(finalTexts(events)).toEqual(['Part 1. Part 2.']);
    expect(agent.prompts).toHaveLength(1);
  });

  it('keeps an agent without the extension as before: the message waits for the next turn', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    expect(session.capabilities.sameTurnSteer.supported).toBe(false);
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.steer({ type: 'user', content: 'two' });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'two' }]);
    expect(agent.methods()).not.toContain('_session/steering');
  });

  it.each([
    // The agent's turn already ended: the host sends the message as the next turn instead.
    { name: 'promptRequired', handler: () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' }), error: /no active turn/i, stillOffered: true },
    // Advertised but not handled: this message fails once, later ones wait for the next turn.
    { name: 'method not found', handler: undefined, error: /-32601/, stillOffered: false },
    // Sent without an answer: the agent may have it, so the host must not send it again.
    { name: 'no answer', handler: () => new Promise(() => {}), error: /delivery uncertain/, stillOffered: true },
  ])('reports $name to the host so the message is neither lost nor sent twice', async ({ handler, error, stillOffered }) => {
    const agent = createFakeAgent({ handlers: { initialize: steeringInit, ...(handler ? { '_session/steering': handler } : {}) } });
    const { session } = await open(agent, { requestTimeoutMs: 20 });
    const offered: boolean[] = [];
    session.onCapabilitiesChange((capabilities) => offered.push(capabilities.sameTurnSteer.supported));
    await session.send({ type: 'user', content: 'one' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    await expect(session.steer({ type: 'user', content: 'two' })).rejects.toThrow(error);
    expect(session.capabilities.sameTurnSteer.supported).toBe(stillOffered);
    expect(offered).toEqual(stillOffered ? [] : [false]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await Promise.resolve();
    expect(agent.prompts).toHaveLength(1);
  });
});

describe('AcpSession permissions', () => {
  it.each([
    { name: 'allow once', mode: 'ask' as const, decision: { kind: 'permission', behavior: 'allow' }, optionId: 'yes', asked: true },
    { name: 'keeps Cindy session consent scoped to the current ACP request', mode: 'ask' as const, decision: { kind: 'permission', behavior: 'allow', permissionUpdates: [{ destination: 'session' }] }, optionId: 'yes', asked: true },
    { name: 'deny', mode: 'ask' as const, decision: { kind: 'permission', behavior: 'deny' }, optionId: 'no', asked: true },
    { name: 'full access approves without asking', mode: 'bypassPermissions' as const, decision: null, optionId: 'yes', asked: false },
    { name: 'unsupported mode falls back to asking', mode: 'acceptEdits' as const, decision: { kind: 'permission', behavior: 'deny' }, optionId: 'no', asked: true },
  ])('$name', async ({ mode, decision, optionId, asked }) => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: mode });
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      return decision as InteractionDecision;
    });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({
      toolCall: { toolCallId: 't9', title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test' } },
      options: PERMISSION_OPTIONS,
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId } });
    expect(seen).toHaveLength(asked ? 1 : 0);
    if (asked) expect(seen[0]).toMatchObject({ kind: 'permission', toolUseId: 't9', toolName: 'Run npm test', input: { command: 'npm test' } });
  });

  it('rejects when no one can answer (no resolver attached)', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({ toolCall: { toolCallId: 't1', title: 'Write' }, options: PERMISSION_OPTIONS });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });

  // Security review on #12820: IM group turns carry a per-turn policy that requires the owner's
  // confirmation. A plugin's agent can act without asking Cindy, so the turn must be refused before
  // any prompt reaches the agent, in every mode. Minimal input: send with turnPermissionPolicy.
  it.each(['ask', 'bypassPermissions'] as const)('refuses a turn that carries a per-turn permission policy (%s)', async (mode) => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: mode });
    const policy = { evaluate: () => ({ kind: 'confirm' }) } as unknown as NonNullable<SendOptions['turnPermissionPolicy']>;
    expect(() => session.validateSendOptions({ turnPermissionPolicy: policy })).toThrow(TurnPermissionPolicyUnsupportedError);
    await expect(session.send({ type: 'user', content: 'go' }, { turnPermissionPolicy: policy }))
      .rejects.toMatchObject({ code: 'TURN_PERMISSION_POLICY_UNSUPPORTED', agentKind: 'acp' });
    expect(agent.prompts).toHaveLength(0);
  });

  it('does not convert allow once into persistent permission when the agent only offers the latter', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent, { permissionMode: 'ask' });
    session.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const answer = await agent.requestPermission({
      toolCall: { toolCallId: 'once-only', title: 'Write' },
      options: PERMISSION_OPTIONS.filter((option) => option.kind !== 'allow_once'),
    });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });
});

describe('AcpSession per-turn permission gate', () => {
  // Rule: plugin-harnesses.md 每轮权限闸; same contract as the built-in engines' turnPermissionPolicy.
  const gateInit = (): AcpRecord => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], _meta: { permissionGate: { supported: true } } });
  const requestMeta = (agent: ReturnType<typeof createFakeAgent>, index: number, routine = true) => {
    const { turnId } = asRecord(asRecord(agent.prompts[index]!.params._meta).permissionGate);
    expect(typeof turnId).toBe('string');
    return { _meta: { permissionGate: { turnId, routine } } };
  };
  /** IM-group-like policy: confirm shell commands and anything else not read-only. */
  const channelPolicy = (confirm: (toolName: string, input: unknown) => boolean = (name) => name !== 'Read'): TurnPermissionPolicy => ({
    origin: { kind: 'im', channel: 'feishu', taskId: 'row-1' },
    confirmationSurface: 'channel',
    forceConfirmToolCall: confirm,
  });

  async function openGated(extra: Partial<OpenAcpSessionOptions> = {}) {
    const agent = createFakeAgent({ handlers: { initialize: gateInit } });
    const opened = await open(agent, extra);
    const asked: InteractionRequest[] = [];
    opened.session.setInteractionResolver(async (request) => {
      asked.push(request);
      return { kind: 'permission', behavior: 'deny' };
    });
    return { agent, ...opened, asked };
  }

  it('refuses a policy turn on an agent without the gate, before anything reaches the agent', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    expect(session.capabilities.turnPermissionPolicy?.supported.supported).toBe(false);
    const policyTurn = { turnPermissionPolicy: channelPolicy() };
    expect(() => session.validateSendOptions(policyTurn)).toThrow(TurnPermissionPolicyUnsupportedError);
    await expect(session.send({ type: 'user', content: 'from the group' }, policyTurn)).rejects.toMatchObject({
      code: 'TURN_PERMISSION_POLICY_UNSUPPORTED', agentKind: 'acp', permissionMode: 'ask',
    });
    // Text-only turns on such an agent keep running as they did before the gate existed.
    await session.send({ type: 'user', content: 'welcome' }, { toolsDisabled: true });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params).not.toHaveProperty('_meta');
    expect(agent.prompts[0]!.params.prompt).toEqual([{ type: 'text', text: 'welcome' }]);
  });

  it('gates a policy turn: routine calls the policy allows run unasked, the rest go to you under channel names', async () => {
    const { agent, session, asked } = await openGated({ permissionMode: 'acceptEdits' });
    expect(session.capabilities.turnPermissionPolicy).toEqual({ supported: { supported: true }, unsupportedPermissionModes: ['bypassPermissions'] });
    await session.send({ type: 'user', content: 'from the group' }, { turnPermissionPolicy: channelPolicy() });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params._meta).toEqual({ permissionGate: { turnId: expect.any(String), scope: 'all-tool-calls' } });

    // ACP can report the fields first, then refer to the same call by ID for approval.
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read a.ts', kind: 'read', rawInput: { path: 'a.ts' } });
    const read = await agent.requestPermission({ toolCall: { toolCallId: 'r1' }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0) });
    const shell = await agent.requestPermission({ toolCall: { toolCallId: 'x1', title: 'Run rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build' } }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0) });
    const unmarked = await agent.requestPermission({ toolCall: { toolCallId: 'r2', title: 'Read a second file', kind: 'read' }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0, false) });
    expect([read, shell, unmarked]).toEqual([
      { outcome: { outcome: 'selected', optionId: 'yes' } },
      { outcome: { outcome: 'selected', optionId: 'no' } },
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    // The channel's own checks (destructive guard, card) see the call as a shell command.
    expect(asked.map((request) => [request.kind === 'permission' && request.toolName, request.kind === 'permission' && request.displayName])).toEqual([
      ['Bash', 'Run rm -rf build'],
      ['Read', 'Read a second file'],
    ]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

    // The next turn without a policy is not gated, and the agent's marker approves nothing.
    await session.send({ type: 'user', content: 'from the owner' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params._meta).toEqual({ permissionGate: { turnId: expect.any(String) } });
    expect(requestMeta(agent, 1)._meta.permissionGate.turnId).not.toBe(requestMeta(agent, 0)._meta.permissionGate.turnId);
    await agent.requestPermission({ toolCall: { toolCallId: 'r3', title: 'Read b.ts', kind: 'read' }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 1) });
    expect(asked).toHaveLength(3);
    expect(asked[2]).toMatchObject({ toolName: 'Read b.ts' });
  });

  it('asks you when the policy itself fails, and refuses a policy turn in Full access', async () => {
    const { agent, session, asked } = await openGated();
    const failing = channelPolicy(() => { throw new Error('classifier down'); });
    await session.send({ type: 'user', content: 'from the group' }, { turnPermissionPolicy: failing });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const read = await agent.requestPermission({ toolCall: { toolCallId: 'r1', kind: 'read', rawInput: { path: 'a.ts' } }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0) });
    expect(read).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(asked).toHaveLength(1);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

    await session.setPermissionMode('bypassPermissions');
    await expect(session.send({ type: 'user', content: 'again' }, { turnPermissionPolicy: channelPolicy() })).rejects.toMatchObject({
      code: 'TURN_PERMISSION_POLICY_UNSUPPORTED', permissionMode: 'bypassPermissions',
    });
    expect(agent.prompts).toHaveLength(1);
  });

  // Unit: IM approval uses the resolver for file edits. An explicit mode switch applies to the active turn.
  it('routes a routine IM edit to approval until the owner changes mode', async () => {
    const { agent, session, asked } = await openGated();
    const policy = { ...channelPolicy(() => false), autoReviewContext: { requesterAuthority: 'guest', source: 'group' } } as const;
    await session.send({ type: 'user', content: 'update the note' }, { turnPermissionPolicy: policy });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    const edit = { kind: 'edit', rawInput: { path: 'notes.md' } };
    const first = await agent.requestPermission({
      toolCall: { toolCallId: 'first', ...edit }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0),
    });
    expect(first).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(asked).toHaveLength(1);

    await session.setPermissionMode('bypassPermissions');
    const second = await agent.requestPermission({
      toolCall: { toolCallId: 'second', ...edit }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0),
    });
    expect(second).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(asked).toHaveLength(1);
  });

  it('refuses every tool call of a text-only turn, Full access included, and of the work it leaves running', async () => {
    const { agent, session, asked } = await openGated({ permissionMode: 'bypassPermissions' });
    await session.send({ type: 'user', content: 'say hello' }, { toolsDisabled: true });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params._meta).toEqual({ permissionGate: { turnId: expect.any(String), scope: 'all-tool-calls' } });
    const during = await agent.requestPermission({ toolCall: { toolCallId: 'x1', kind: 'execute' }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0) });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
    const after = await agent.requestPermission({ toolCall: { toolCallId: 'x2', kind: 'execute' }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 0) });
    expect([during, after]).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    expect(asked).toHaveLength(0);
  });

  it('steers a policy message only into a gated turn, adding its restrictions before the agent acts on it', async () => {
    const agent = createFakeAgent({ handlers: {
      initialize: () => ({ ...gateInit(), _meta: { permissionGate: { supported: true }, steering: { supported: true } } }),
      '_session/steering': () => ({ outcome: 'injected' }),
    } });
    const { session } = await open(agent);
    const asked: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => { asked.push(request); return { kind: 'permission', behavior: 'deny' }; });

    await session.send({ type: 'user', content: 'owner work' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    // The agent was not asked to gate this turn, so a group message waits for its own turn.
    await expect(session.steer({ type: 'user', content: 'group note' }, { turnPermissionPolicy: channelPolicy() })).rejects.toThrow(/no active turn/i);
    expect(agent.methods()).not.toContain('_session/steering');
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

    await session.send({ type: 'user', content: 'first sender' }, { turnPermissionPolicy: channelPolicy((name) => name === 'Read') });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    await session.steer({ type: 'user', content: 'second sender' }, { turnPermissionPolicy: channelPolicy((name) => name === 'Grep') });
    const read = await agent.requestPermission({ toolCall: { toolCallId: 'r1', kind: 'read', rawInput: { path: 'a.ts' } }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 1) });
    const search = await agent.requestPermission({ toolCall: { toolCallId: 's1', kind: 'search', rawInput: { query: 'a' } }, options: PERMISSION_OPTIONS, ...requestMeta(agent, 1) });
    expect([read, search]).toEqual([
      { outcome: { outcome: 'selected', optionId: 'no' } },
      { outcome: { outcome: 'selected', optionId: 'no' } },
    ]);
    expect(asked.map((request) => request.kind === 'permission' && request.toolName)).toEqual(['Read', 'Grep']);
  });
});

describe('AcpSession stop and failure', () => {
  it('stop while a permission prompt is open: cancels the prompt, answers cancelled, ends the turn as cancelled', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    session.setInteractionResolver(() => new Promise<InteractionDecision>(() => {})); // user never answers
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Delete build/', kind: 'delete', status: 'pending' });
    const answer = agent.requestPermission({ toolCall: { toolCallId: 't1' }, options: PERMISSION_OPTIONS });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'tool_use')).toBe(true));

    await session.abort();
    expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(agent.methods()).toContain('session/cancel');
    agent.prompts[0]!.settle.resolve({ stopReason: 'cancelled' });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)?.data).toMatchObject({ status: 'cancelled', result: '' });
    expect(events.find((event) => event.type === 'tool_result')?.data).toEqual({ summary: 'failed', toolUseIds: ['t1'] });
  });

  it('stop also discards a message whose attachment was still being read', async () => {
    const agent = createFakeAgent({ agentCapabilities: { promptCapabilities: { image: true } } });
    const image = deferred<Uint8Array>();
    const { session } = await open(agent, { readFile: () => image.promise });
    const sending = session.send({ type: 'user', content: [{ type: 'image', path: SHOT }] });
    await session.abort();
    image.resolve(new Uint8Array([1]));
    await sending;
    await Promise.resolve();
    expect(agent.methods()).toEqual(['initialize', 'session/new']);
  });

  it('retires the endpoint when the agent ignores a cancel past the grace period', async () => {
    vi.useFakeTimers();
    const agent = createFakeAgent();
    const exit = deferred<void>();
    const close = vi.spyOn(agent.transport, 'close').mockReturnValueOnce(exit.promise);
    const onEnded = vi.fn();
    const { session, events, ended } = await open(agent, { cancelGraceMs: 1_000, permissionMode: 'bypassPermissions', onEnded });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.abort();
    await expect(agent.requestPermission({
      toolCall: { toolCallId: 'after-stop', title: 'Write' },
      options: PERMISSION_OPTIONS,
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'cancelled' } });
    expect(close).toHaveBeenCalledOnce();
    // The product must keep this runtime until the host confirms its exit.
    expect(onEnded).not.toHaveBeenCalled();
    await expect(session.send({ type: 'user', content: 'again' })).rejects.toThrow('closed');
    expect(agent.prompts).toHaveLength(1);
    // A late answer for the abandoned prompt must not produce a second turn end.
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    exit.resolve();
    await ended;
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('agent process exit mid-turn: terminal error, event stream ends, later sends are refused', async () => {
    const agent = createFakeAgent();
    const { session, events, ended } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.exit();
    await ended;
    expect(events.at(-1)).toMatchObject({ type: 'error', data: { isTerminal: true, reason: 'acp-agent-exited' } });
    await expect(session.send({ type: 'user', content: 'again' })).rejects.toThrow('closed');
  });

  it.each([false, true])('uses personal instructions only outside isolated companions (isolated: %s)', async (isolated) => {
    const agent = createFakeAgent({ agentCapabilities: { sessionCapabilities: { systemPrompt: {} } } });
    const policy = { mode: 'allowlist' as const, configured: [], catalog: [] };
    const handle = await createAcpAgent(() => agent.transport).startSession({
      workingDir: '/w', model: '', providerId: 'acp-plugin:test:engine', userPrompt: '  x  ',
      ...(isolated ? {
        botRuntimeProfile: { botId: 'test', profileVersion: 1, skillPolicy: policy, mcpPolicy: policy, toolsetPolicy: policy },
      } : {}),
    });
    expect((agent.sent[1]!.params as AcpRecord).systemPrompt).toEqual(
      isolated ? undefined : { mode: 'append', content: [{ type: 'text', text: 'x' }] },
    );
    await handle.close();
  });

  // 引擎账号：运行中的额度用完、服务繁忙带上 Cindy 失败判定认得的字段并保留上游原文；不认识的 kind 照普通错误处理。
  it.each([
    {
      kind: 'usage-limit',
      resetsAt: 1_900_000_000_000,
      message: 'Individual quota reached. Resets in 2h13m2s.',
      expected: {
        reason: 'acp-usage-limit',
        message: 'Individual quota reached. Resets in 2h13m2s.',
        usageLimit: true,
        usageResetAt: 1_900_000_000_000,
      },
    },
    {
      kind: 'usage-limit',
      resetsAt: 1_900_000_000_000,
      message: '',
      expected: {
        reason: 'acp-usage-limit',
        message: 'The plugin engine account has reached its usage limit.',
        usageLimit: true,
        usageResetAt: 1_900_000_000_000,
      },
    },
    {
      kind: 'overloaded',
      message: 'upstream busy',
      expected: { reason: 'acp-overloaded', message: 'upstream busy', errorStatus: 529 },
    },
    { kind: 'auth-required', message: 'upstream said no', expected: { reason: 'acp-auth-required' } },
    { kind: 'something-new', message: 'upstream said no', expected: { reason: 'acp-request-failed' } },
  ])('reports a turn the agent classified as $kind with failure fields Cindy understands', async ({ kind, resetsAt, message, expected }) => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.prompts[0]!.settle.reject(Object.assign(new Error(message), { code: -32603, data: { _meta: { cindy: { kind, ...(resetsAt ? { resetsAt } : {}) } } } }));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('error'));
    expect(events.at(-1)?.data).toMatchObject({ isTerminal: true, ...expected });
  });

  it('close() ends a running turn, closes the agent session and waits for the endpoint', async () => {
    const agent = createFakeAgent({
      agentCapabilities: { sessionCapabilities: { close: {} } },
      handlers: { 'session/close': () => ({}) },
    });
    const { session, events, ended } = await open(agent);
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.close();
    await ended;
    expect(agent.methods()).toEqual(expect.arrayContaining(['session/cancel', 'session/close']));
    expect(agent.closedByClient).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'cancelled' } });
  });
});

describe('AcpSession model and effort', () => {
  const configOptions = [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'v4-flash',
      options: [{ group: 'deepseek', name: 'DeepSeek', options: [{ value: 'v4-pro', name: 'V4 Pro' }, { value: 'v4-flash', name: 'V4 Flash' }] }],
    },
    {
      id: 'reasoning_effort', name: 'Reasoning', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'turbo', name: 'Turbo' }],
    },
  ];

  it('derives models and only the effort levels Cindy can name from the agent configuration', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent);
    expect(session.model).toBe('v4-flash');
    expect(session.capabilities.switchModel).toEqual({ supported: true });
    expect(session.capabilities.availableModels.map((model) => [model.id, model.group, model.efforts])).toEqual([
      ['v4-pro', 'DeepSeek', []],
      ['v4-flash', 'DeepSeek', ['low', 'high']],
    ]);
    expect(session.capabilities.effortLevels.map((level) => level.id)).toEqual(['low', 'high']);
    expect(session.getEffort()).toBe('high');
    await expect(session.setEffort('max')).rejects.toThrow("'effort' not supported");
  });

  it('switches model through set_config_option and adopts the state the agent returns', async () => {
    const switched = configOptions.map((option) => option.id === 'model' ? { ...option, currentValue: 'v4-pro' } : option);
    const agent = createFakeAgent({ configOptions, handlers: { 'session/set_config_option': () => ({ configOptions: switched }) } });
    const { session } = await open(agent);
    const changes: string[] = [];
    session.onCapabilitiesChange((caps) => changes.push(caps.availableModels.find((model) => model.efforts.length > 0)?.id ?? ''));
    await session.setModel('v4-pro');
    expect(agent.sent.at(-1)).toMatchObject({ method: 'session/set_config_option', params: { sessionId: 'sess-1', configId: 'model', value: 'v4-pro' } });
    expect(session.model).toBe('v4-pro');
    expect(changes).toEqual(['v4-pro']);
    await expect(session.setModel('gpt-x')).rejects.toThrow('does not offer');
  });

  // A usage report has no model id. It must not follow a new selection, and
  // changes in used tokens alone must not refresh the displayed facts.
  it('reports ACP context for the confirmed selection and explicit image support', async () => {
    const choice = deferred<AcpRecord>();
    const next = configOptions.map(option =>
      option.id === 'model' ? { ...option, currentValue: 'v4-pro' } : option);
    const agent = createFakeAgent({
      agentCapabilities: { promptCapabilities: { image: false } },
      configOptions,
      handlers: { 'session/set_config_option': () => choice.promise },
    });
    const { session, ended } = await open(agent);
    const report = vi.fn();
    session.observeReportedModelDetails(report);
    expect(report).toHaveBeenLastCalledWith({ modelId: 'v4-flash', imageInput: false });
    agent.update({ sessionUpdate: 'usage_update', size: 524288, used: 0 });
    agent.update({ sessionUpdate: 'usage_update', size: 524288, used: 40 });
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith({ modelId: 'v4-flash', imageInput: false, contextWindow: 524288 });
    const switching = session.setModel('v4-pro');
    agent.update({ sessionUpdate: 'usage_update', size: 128000, used: 100 });
    expect(report).toHaveBeenCalledTimes(2);
    choice.resolve({ configOptions: next });
    await switching;
    expect(report).toHaveBeenLastCalledWith({ modelId: 'v4-pro', imageInput: false });
    agent.update({ sessionUpdate: 'usage_update', size: 256000, used: 130 });
    expect(report).toHaveBeenLastCalledWith({ modelId: 'v4-pro', imageInput: false, contextWindow: 256000 });
    agent.exit();
    await ended;
    expect(report).toHaveBeenLastCalledWith(undefined);
  });

  it('does not present omitted image support as an explicit no', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent);
    const report = vi.fn();
    session.observeReportedModelDetails(report);
    expect(report).toHaveBeenLastCalledWith(undefined);
    agent.update({ sessionUpdate: 'usage_update', size: 64000, used: 0 });
    expect(report).toHaveBeenLastCalledWith({ modelId: 'v4-flash', contextWindow: 64000 });
    await session.close();
  });

  // #12433 (unit): an active prompt's usage belongs to its model even if the
  // endpoint changes its model option before returning the prompt result.
  it('reports the model selected when the metered prompt was sent', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'hi' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const switched = configOptions.map(option =>
      option.id === 'model' ? { ...option, currentValue: 'v4-pro' } : option,
    );
    agent.update({ sessionUpdate: 'config_option_update', configOptions: switched });
    await vi.waitFor(() => expect(session.model).toBe('v4-pro'));
    agent.prompts[0]!.settle.resolve({
      stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 0 },
    });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({
      type: 'done', data: { usageModel: 'v4-flash', usage: { inputTokens: 1 } },
    }));
  });

  // Unit regression for PR #11549. The handle's own tests missed the product
  // Session rejecting newly offered effort levels after a config update.
  it('applies an effort level added after the product session started', async () => {
    const agent = createFakeAgent({ configOptions: configOptions.slice(0, 1) });
    const handle = await openAcpSession({ transport: agent.transport, cwd: '/w', clientInfo: { name: 'c', version: '1' } });
    const session = new Session({
      id: 'task', workDir: '/w', agentKind: 'acp', handle, capabilities: handle.capabilities, logger: silentLogger,
    });
    try {
      await expect(session.setEffort('low')).rejects.toThrow("'effort' not supported");
      agent.update({ sessionUpdate: 'config_option_update', configOptions });
      await session.setEffort('low');
      expect(agent.sent.at(-1)).toMatchObject({ method: 'session/set_config_option', params: { configId: 'reasoning_effort', value: 'low' } });
    } finally {
      await session.close();
    }
  });

  it('applies the stored model on open but keeps the agent default when it is no longer offered', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent, { model: 'retired-model' });
    expect(session.model).toBe('v4-flash');
    expect(agent.methods()).toEqual(['initialize', 'session/new']);
  });
});

// 2026-11-19:Antigravity(agy 1.5.12)在 configOptions 里公布 mode = default / accept-edits / auto / plan；
// 用户决定权限菜单显示 Agent 的模式并保留「全部允许」，插件基座通用。
describe('AcpSession agent modes', () => {
  const configOptions = [
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' }, { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' }, { value: 'plan', name: 'Plan' }, { value: 'yolo-x', name: 'Agent only' },
      ],
    },
  ];
  const modeChanges = (agent: FakeAgent) => agent.sent
    .filter((message) => message.method === 'session/set_config_option')
    .map((message) => (message.params as AcpRecord).value);

  it('offers the agent modes Cindy can name, then Full access, and switches the agent mode', async () => {
    let currentMode = 'default';
    const agent = createFakeAgent({
      configOptions,
      handlers: {
        'session/set_config_option': ({ configId, value }) => {
          if (configId === 'mode' && typeof value === 'string') currentMode = value;
          return {
            configOptions: configOptions.map((opt) => (opt.id === 'mode' ? { ...opt, currentValue: currentMode } : opt)),
          };
        },
      },
    });
    const { session } = await open(agent);
    expect(session.capabilities.permissionModes.map((mode) => [mode.id, mode.displayName])).toEqual([
      ['default', 'Default'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['plan', 'Plan'], ['bypassPermissions', 'Full access'],
    ]);
    await session.setPermissionMode('acceptEdits');
    await session.setPermissionMode('plan');
    // Cindy's canonical 'ask' maps to an agent's 'default' mode when the agent publishes 'default'.
    await session.setPermissionMode('ask');
    // Full access is Cindy's own answer to permission requests; the agent keeps its mode.
    await session.setPermissionMode('bypassPermissions');
    expect(modeChanges(agent)).toEqual(['accept-edits', 'plan', 'default']);
  });

  it('applies the stored mode when the task starts and still asks you about permission requests', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent, { permissionMode: 'plan' });
    expect(modeChanges(agent)).toEqual(['plan']);
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      return { kind: 'permission', behavior: 'deny' } as InteractionDecision;
    });
    await session.send({ type: 'user', content: 'go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const answer = await agent.requestPermission({ toolCall: { toolCallId: 't1', title: 'Edit file' }, options: PERMISSION_OPTIONS });
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(seen).toHaveLength(1);
  });

  // Rule: agent-initiated current_mode_update updates the tracked mode (ignoring unknown mode IDs) so switching back still sends set_config_option.
  // Minimal failing input: session opens in 'default', agent sends current_mode_update('plan'), user switches back to 'default'.
  it('syncs tracked mode on current_mode_update so switching back is not skipped', async () => {
    const agent = createFakeAgent({ configOptions });
    const { session } = await open(agent);
    agent.update({ sessionUpdate: 'current_mode_update', currentModeId: 'unknown-mode' });
    await session.setPermissionMode('default');
    expect(modeChanges(agent)).toEqual([]);
    agent.update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    await session.setPermissionMode('plan');
    expect(modeChanges(agent)).toEqual([]);
    await session.setPermissionMode('default');
    expect(modeChanges(agent)).toEqual(['default']);
  });

  // Rule: on session/load, pre-response current_mode_update is stale replay (dropped), while a post-response
  // current_mode_update arriving in the same stdout chunk is newer than configOptions and must be preserved.
  // Minimal failing input: one chunk carrying [replay('plan'), loadResponse('default'), live('accept-edits')] (and [replay('plan'), loadResponse('default')]).
  it('drops pre-response current_mode_update replay on session/load while keeping post-response updates in the same chunk', async () => {
    const runChunkedLoad = async (afterResponse?: string) => {
      const lineListeners = new Set<(line: string) => void>();
      const closeListeners = new Set<(info: AcpTransportClosed) => void>();
      const decoder = new AcpLineDecoder((line) => { for (const fn of [...lineListeners]) fn(line); });
      const sent: AcpRecord[] = [];
      const transport: AcpLineTransport = {
        write(line) {
          const msg = JSON.parse(line) as AcpRecord;
          sent.push(msg);
          queueMicrotask(() => {
            if (msg.method === 'initialize') {
              decoder.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } }) + '\n');
            } else if (msg.method === 'session/load') {
              const frames: AcpRecord[] = [
                { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'old-1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } } },
                { jsonrpc: '2.0', id: msg.id, result: { configOptions } },
              ];
              if (afterResponse) {
                frames.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'old-1', update: { sessionUpdate: 'current_mode_update', currentModeId: afterResponse } } });
              }
              decoder.push(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
            } else if (msg.method === 'session/set_config_option') {
              const value = (msg.params as AcpRecord).value;
              const updated = [{ ...configOptions[0], currentValue: value }];
              decoder.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { configOptions: updated } }) + '\n');
            }
          });
        },
        onLine(fn) { lineListeners.add(fn); return () => lineListeners.delete(fn); },
        onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
        async close() { for (const fn of [...closeListeners]) fn({ reason: 'closed-by-client' }); },
      };
      const session = await openAcpSession({ transport, cwd: '/repo', clientInfo: { name: 'cindy', version: 'test' }, resumeSessionId: 'old-1' });
      const changes = () => sent.filter((m) => m.method === 'session/set_config_option').map((m) => (m.params as AcpRecord).value);
      return { session, changes };
    };

    // Guard for the pre-response replay-drop branch: stale 'plan' before response must not beat 'default'.
    const replayOnly = await runChunkedLoad();
    await replayOnly.session.setPermissionMode('default');
    expect(replayOnly.changes()).toEqual([]);
    await replayOnly.session.setPermissionMode('plan');
    expect(replayOnly.changes()).toEqual(['plan']);

    // Post-response update in the same chunk must win over the load response's 'default'.
    const withPost = await runChunkedLoad('accept-edits');
    await withPost.session.setPermissionMode('acceptEdits');
    expect(withPost.changes()).toEqual([]);
    await withPost.session.setPermissionMode('default');
    expect(withPost.changes()).toEqual(['default']);
  });

  // Rule: a session/set_config_option response must be applied in wire order so a subsequent current_mode_update
  // arriving in the same stdout chunk is not overwritten when the await resumes.
  // Minimal failing input: one chunk carrying [setConfigResponse('plan'), current_mode_update('default')], then user requests 'plan' again.
  it('applies set_config_option responses in wire order before same-chunk mode notifications', async () => {
    const lineListeners = new Set<(line: string) => void>();
    const closeListeners = new Set<(info: AcpTransportClosed) => void>();
    const decoder = new AcpLineDecoder((line) => { for (const fn of [...lineListeners]) fn(line); });
    const sent: AcpRecord[] = [];
    let firstSet = true;
    const transport: AcpLineTransport = {
      write(line) {
        const msg = JSON.parse(line) as AcpRecord;
        sent.push(msg);
        queueMicrotask(() => {
          if (msg.method === 'initialize') {
            decoder.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + '\n');
          } else if (msg.method === 'session/new') {
            decoder.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1', configOptions } }) + '\n');
          } else if (msg.method === 'session/set_config_option') {
            const value = (msg.params as AcpRecord).value;
            const updated = [{ ...configOptions[0], currentValue: value }];
            const frames: AcpRecord[] = [{ jsonrpc: '2.0', id: msg.id, result: { configOptions: updated } }];
            if (firstSet) {
              firstSet = false;
              frames.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } } });
            }
            decoder.push(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
          }
        });
      },
      onLine(fn) { lineListeners.add(fn); return () => lineListeners.delete(fn); },
      onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
      async close() { for (const fn of [...closeListeners]) fn({ reason: 'closed-by-client' }); },
    };
    const session = await openAcpSession({ transport, cwd: '/repo', clientInfo: { name: 'cindy', version: 'test' } });
    await session.setPermissionMode('plan');
    // Same-chunk current_mode_update moved the agent back to 'default'; requesting 'plan' again must send a new RPC.
    await session.setPermissionMode('plan');
    expect(sent.filter((m) => m.method === 'session/set_config_option').map((m) => (m.params as AcpRecord).value)).toEqual(['plan', 'plan']);
  });
});

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => silentLogger };

function createAcpAgent(connect: () => FakeAgent['transport'], seen: string[] = []) {
  return new AcpAgent({
    auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
    runtimeConfig: {}, binaryPath: '', logger: silentLogger,
    clientInfo: { name: 'cindy', version: 'test' },
    endpoints: { connect: async () => connect() },
    onSessionCapabilities: (key) => seen.push(key),
  });
}

describe('AcpAgent (the acp engine)', () => {
  it('passes only the task-scoped Cindy HTTP bridge and omits external MCP credentials', () => {
    expect(acpMcpServersFromBridge({
      mcpBridge: { token: 'tok', servers: [
        { name: 'cindy_tools', url: 'http://127.0.0.1:9/mcp/cindy_tools' },
        { name: 'remote_ok', url: 'https://mcp.example/a', remote: { headerEnvVars: { 'X-Key': 'K1' }, startupTimeoutMs: 1, requestTimeoutMs: 1 } },
        { name: 'remote_missing', url: 'https://mcp.example/b', remote: { headerEnvVars: { 'X-Key': 'K2' }, startupTimeoutMs: 1, requestTimeoutMs: 1 } },
      ] },
      mcpEnv: { K1: 'secret' },
    })).toEqual([
      { type: 'http', name: 'cindy_tools', url: 'http://127.0.0.1:9/mcp/cindy_tools', headers: [{ name: 'Authorization', value: 'Bearer tok' }] },
    ]);
  });

  it('starts the harness named by the task and reports what it offers', async () => {
    const seen: string[] = [];
    const agent = createFakeAgent();
    const handle = await createAcpAgent(() => agent.transport, seen).startSession({ workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh' });
    expect(handle.agentKind).toBe('acp');
    expect(seen).toEqual(['dsh-acp:dsh']);
    await expect(createAcpAgent(() => agent.transport).startSession({ workingDir: '/w', model: '', providerId: 'anthropic' })).rejects.toThrow('harness id');
    await expect(createAcpAgent(() => agent.transport).startSession({ workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh', remoteHostId: 'box' })).rejects.toThrow("'remoteSession' not supported");
  });

  // 引擎账号：宿主账号池选中 Cindy 加的账号时，入口带着这个账号的目录启动；插件原有的登录照旧不带参数。
  // 拿出来的单独供应商(`…~<后缀>`)跑同一个引擎。最小失败输入：带账号能力启动；默认登录；带后缀的供应商 id。
  it('starts the engine on the account the host picked, and a taken-out provider on its engine', async () => {
    const connects: Array<{ key: string; options: unknown }> = [];
    const engine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {}, binaryPath: '', logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      endpoints: { connect: async (key, options) => { connects.push({ key, options }); return createFakeAgent().transport; } },
    });
    const account = (configDir: string, defaultProfile: boolean) => ({
      id: 'a', configDir, defaultProfile, assertCurrent() {}, readState: async () => ({ authenticated: true }),
    });
    await engine.startSession({ workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh~ab12cd34', [NATIVE_SUBSCRIPTION_ACCOUNT]: account('/accounts/a', false) });
    await engine.startSession({ workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh', [NATIVE_SUBSCRIPTION_ACCOUNT]: account('', true) });
    expect(connects).toEqual([
      { key: 'dsh-acp:dsh', options: { accountDir: '/accounts/a' } },
      { key: 'dsh-acp:dsh', options: undefined },
    ]);
  });

  // 用户决定（2026-11-19）：协作 Worker 整体信任插件 Agent，它的工具调用按任务自己发起（能回报 Lead）；
  // 其他插件引擎任务仍是「来源未知」。最小失败输入：同一引擎，一次带信任标记、一次不带。
  it.each([
    { trusted: true, kind: 'root', attested: true },
    { trusted: undefined, kind: 'unknown', attested: false },
  ])('tool calls count as the task own calls only when the host trusts the engine as a whole ($trusted)', async ({ trusted, kind, attested }) => {
    const contexts: Array<Record<string, unknown>> = [];
    const agent = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {}, binaryPath: '', logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      endpoints: { connect: async () => createFakeAgent().transport },
      preparePiExtraSpawnConfig: async (_providers, ctx) => { contexts.push(ctx as unknown as Record<string, unknown>); return null; },
    });
    await agent.startSession({ workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh', botProfilePrompt: 'Prompt text alone cannot grant task privileges.', ...(trusted ? { pluginEngineTrustedCaller: true } : {}) });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ mcpCallerKind: kind, mcpCallerAttested: attested });
  });

  // 用户决定（2026-11-24）：插件引擎收不到 Cindy system prompt，内置引擎从 system prompt 知道的已装插件花名册、
  // 从原生 Skill 加载知道的 Skill，改在新会话首条消息前告诉它。依据：用户反馈 Antigravity 任务不知道已装插件与 Skill，
  // 发 PR 绕开了 GitHub 插件的 pr Skill。覆盖缺口：此前首轮 briefing 只有协作角色、伙伴与远程工作区说明。
  // 最小失败输入（unit）：本机任务带花名册与 Skill；对端不收 HTTP MCP（插件网关没交出去）；伙伴任务。
  const briefingEngine = (agent: FakeAgent, roster: ReturnType<typeof vi.fn>, skills: ReturnType<typeof vi.fn>) => new AcpAgent({
    auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
    runtimeConfig: {}, binaryPath: '', logger: silentLogger, clientInfo: { name: 'cindy', version: 'test' },
    endpoints: { connect: async () => agent.transport },
    preparePiExtraSpawnConfig: async () => ({ mcpBridge: { token: 't', servers: [{ name: 'cindy', url: 'http://127.0.0.1:9/mcp/cindy' }] } }),
    getGhostRosterPrompt: roster as unknown as (ctx: { workingDir?: string }) => string,
    listSessionSkills: skills as unknown as (ctx: { workingDir?: string }) => Promise<Array<{ name: string; description?: string; path?: string }>>,
  });
  const skillList = [
    { name: 'cindy-plugin-github:pr', description: 'Carry a GitHub pull request\n from start to merge.', path: '/skills/pr/SKILL.md' },
    { name: 'no-file', description: 'Has no readable SKILL.md.' },
  ];
  const firstPrompt = async (agent: FakeAgent, handle: { send(m: { type: 'user'; content: string }): Promise<unknown> }) => {
    await handle.send({ type: 'user', content: 'open a PR' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    return agent.prompts[0]!.params.prompt as Array<{ type: string; text: string }>;
  };

  it('tells a new plugin-engine conversation which plugins and Skills it can use, once', async () => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const roster = vi.fn(() => '<ghost-roster>\n{"id":"cindy-github"}\n</ghost-roster>');
    const skills = vi.fn(async () => skillList);
    const handle = await briefingEngine(agent, roster, skills).startSession({
      workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy', pluginEngineBriefing: 'You are a Worker.',
    });
    expect(roster).toHaveBeenCalledWith({ workingDir: '/repo' });
    expect(skills).toHaveBeenCalledWith({ workingDir: '/repo' });
    const [briefing, message, more] = await firstPrompt(agent, handle);
    expect(briefing!.text.indexOf('<ghost-roster>')).toBeLessThan(briefing!.text.indexOf('<cindy-skills>'));
    expect(briefing!.text.indexOf('<cindy-skills>')).toBeLessThan(briefing!.text.indexOf('You are a Worker.'));
    expect(briefing!.text).toContain('- cindy-plugin-github:pr: Carry a GitHub pull request from start to merge. ("/skills/pr/SKILL.md")');
    expect(briefing!.text).not.toContain('no-file');
    expect(message).toEqual({ type: 'text', text: 'open a PR' });
    expect(more).toBeUndefined();
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await handle.send({ type: 'user', content: 'again' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'again' }]);
  });

  it('leaves the plugin roster out when the agent did not take the plugin gateway, and keeps the Skills', async () => {
    const agent = createFakeAgent({ agentCapabilities: {} });
    const handle = await briefingEngine(agent, vi.fn(() => '<ghost-roster></ghost-roster>'), vi.fn(async () => skillList))
      .startSession({ workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy' });
    const [briefing] = await firstPrompt(agent, handle);
    expect(briefing!.text).not.toContain('<ghost-roster>');
    expect(briefing!.text).toContain('<cindy-skills>');
  });

  it('keeps a companion on its own capability set: no roster or Skill list', async () => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const roster = vi.fn(() => '<ghost-roster></ghost-roster>');
    const skills = vi.fn(async () => skillList);
    const policy = { mode: 'allowlist' as const, configured: [], catalog: [] };
    const handle = await briefingEngine(agent, roster, skills).startSession({
      workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy', botProfilePrompt: 'You are Mika.',
      botRuntimeProfile: { botId: 'mika', profileVersion: 1, skillPolicy: policy, mcpPolicy: policy, toolsetPolicy: policy },
    });
    expect(roster).not.toHaveBeenCalled();
    expect(skills).not.toHaveBeenCalled();
    const [briefing] = await firstPrompt(agent, handle);
    expect(briefing!.text).toBe('You are Mika.');
    // A `/<skill>` message is not expanded either: the companion's Skills are its own frozen set.
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await handle.send({ type: 'user', content: '/cindy-plugin-github:pr go' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    expect(agent.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: '/cindy-plugin-github:pr go' }]);
    expect(skills).not.toHaveBeenCalled();
  });

  // Review (#12294)：V2 项目伙伴（projectContext）按普通任务装配，与内置 Pi 一致要收到花名册与 Skill；恢复的会话
  // 已有说明且恢复失败不会改开新会话，所以不读取。最小失败输入：projectContext 伙伴；带 resumeSessionId 启动。
  it('briefs a project-context companion like any task, and reads nothing for a resumed session', async () => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const policy = { mode: 'allowlist' as const, configured: [], catalog: [] };
    const handle = await briefingEngine(agent, vi.fn(() => '<ghost-roster></ghost-roster>'), vi.fn(async () => skillList)).startSession({
      workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy', botProfilePrompt: 'You are Mika.',
      botRuntimeProfile: { botId: 'mika', profileVersion: 1, projectContext: true, skillPolicy: policy, mcpPolicy: policy, toolsetPolicy: policy },
    });
    const [briefing] = await firstPrompt(agent, handle);
    expect(briefing!.text).toContain('You are Mika.');
    expect(briefing!.text).toContain('<ghost-roster>');
    expect(briefing!.text).toContain('<cindy-skills>');

    const resumed = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
      handlers: { 'session/resume': () => ({}) } });
    const roster = vi.fn(() => '<ghost-roster></ghost-roster>');
    const skills = vi.fn(async () => skillList);
    const again = await briefingEngine(resumed, roster, skills).startSession({
      workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy', resumeSessionId: 'old-1',
    });
    expect(roster).not.toHaveBeenCalled();
    expect(skills).not.toHaveBeenCalled();
    expect(await firstPrompt(resumed, again)).toEqual([{ type: 'text', text: 'open a PR' }]);
  });

  // 用户要求（2026-11-25）：插件引擎任务的 `/` 也能调 Cindy Skill。插件引擎没有 Cindy 的 Skill 加载，`/pr` 原样到了
  // 引擎只是一行字。覆盖缺口：此前插件引擎只在首轮说明里收到 Skill 清单，发送路径不认 `/<skill>`。
  // 最小失败输入（unit，临时目录里的真实 SKILL.md）：恢复的会话发 `/<别名>:pr 参数`；不带参数；没有对应 Skill；
  // 文件读不到；普通消息。
  it('expands a `/<skill>` message into the Skill instructions, the way Pi expands `/skill:`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cindy-acp-skill-'));
    try {
      const file = join(dir, 'pr', 'SKILL.md');
      mkdirSync(join(dir, 'pr'));
      writeFileSync(file, '---\nname: pr\ndescription: Carry a PR.\n---\n\nOpen the PR with the plugin.\n');
      const list = [
        { name: 'pr', description: 'Carry a PR.', path: file },
        { name: 'gone', path: join(dir, 'gone', 'SKILL.md') },
      ];
      const skills = vi.fn(async () => list);
      const agent = createFakeAgent({ agentCapabilities: { sessionCapabilities: { resume: {} } }, handlers: { 'session/resume': () => ({}) } });
      const handle = await briefingEngine(agent, vi.fn(() => ''), skills).startSession({
        workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy', resumeSessionId: 'old-1',
      });
      const block = `<skill name="pr" location="${file}">\nReferences are relative to ${join(dir, 'pr')}.\n\nOpen the PR with the plugin.\n</skill>`;
      const cases: Array<[string, string]> = [
        ['/cindy-plugin-github:pr fix the build\nplease', `${block}\n\nfix the build\nplease`],
        ['  /skill:PR', block],
        ['/review this', '/review this'],
        ['/gone now', '/gone now'],
        ['open /pr', 'open /pr'],
      ];
      for (const [index, [sent, received]] of cases.entries()) {
        await handle.send({ type: 'user', content: sent });
        await vi.waitFor(() => expect(agent.prompts).toHaveLength(index + 1));
        expect(agent.prompts[index]!.params.prompt).toEqual([{ type: 'text', text: received }]);
        agent.prompts[index]!.settle.resolve({ stopReason: 'end_turn' });
      }
      // Review (#12732)：带图片的消息以第一段文字为开头，与宿主不加说明的判定同一段（mobileClientPromptNote.ts）。
      await handle.send({ type: 'user', content: [{ type: 'image', path: '/repo/shot.png' }, { type: 'text', text: '/pr look' }] });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(cases.length + 1));
      expect(agent.prompts[cases.length]!.params.prompt).toEqual([
        expect.objectContaining({ type: 'resource_link', name: 'shot.png' }),
        { type: 'text', text: `${block}\n\nlook` },
      ]);
      // Only messages that start with `/` look the Skills up.
      expect(skills).toHaveBeenCalledTimes(5);
      expect(skills).toHaveBeenCalledWith({ workingDir: '/repo' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review (#12732, Codex P2)：插件引擎任务的 `/` 菜单此前借内置 Pi 的清单，本机 Pi 不可用（未注册）时请求失败、菜单为空，
  // 而展开照样能用。生产入口 Maker.listAgentSkills('acp') → 本方法，读展开用的同一份清单。覆盖缺口：此前插件引擎没有自己的
  // 菜单清单。最小失败输入：一个项目 Skill、一个托管 Skill、一个没有 SKILL.md 的项（展开不了，不列）；SSH 任务不列（unit）。
  it('lists for the `/` menu the Skills its `/<skill>` messages expand from', async () => {
    const skills = vi.fn(async () => [
      { name: 'deploy', description: 'Ship it.', path: '/repo/.agents/skills/deploy/SKILL.md', scope: 'repo' },
      { name: 'pr', path: '/managed/pr/SKILL.md' },
      { name: 'no-file' },
    ]);
    const engine = briefingEngine(createFakeAgent(), vi.fn(() => ''), skills);
    expect(await engine.listAgentSkills({ workingDir: '/repo' })).toEqual({ skills: [
      { kind: 'agent-skill', name: 'deploy', description: 'Ship it.', source: 'skill', path: '/repo/.agents/skills/deploy/SKILL.md', scope: 'repo', enabled: true },
      { kind: 'agent-skill', name: 'pr', source: 'skill', path: '/managed/pr/SKILL.md', scope: 'user', enabled: true },
    ] });
    expect(skills).toHaveBeenCalledWith({ workingDir: '/repo' });
    expect(await engine.listAgentSkills({ workingDir: '/repo', remoteHostId: 'ssh-1' })).toEqual({ skills: [] });
    expect(skills).toHaveBeenCalledTimes(1);
  });

  // 第三期(2026-11-20，docs/plans/acp-plugin-bridge.md)：任务的文件与命令在同账号另一台电脑上。插件引擎自带的
  // 文件与命令工具只会作用在 Agent 所在的这台电脑，所以：入口以远程工作区方式启动(插件关掉自带工具)，
  // 工具全部来自任务所在电脑的隧道，没有 cindy_exec 就拒绝；受邀者一律拒绝。此前这类会话在这里一律被拒，没有覆盖。
  // 最小失败输入：带 deviceHosted 的启动；对端不支持 HTTP MCP；deviceHosted.guest。
  const hosted = {
    workingDir: '/shadow/p', extraDirs: [], writableDirs: [], platform: 'win32' as const, shell: 'bash', isGitRepo: true,
    tunnelUrl: 'http://127.0.0.1:4711/', tunnelToken: 'tunnel-token', mcpServers: ['cindy', 'cindy_memory'],
  };

  it('runs a task of another computer with its own tools off and every tool coming through the task tunnel', async () => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const connected: unknown[] = [];
    const prepared = vi.fn(async () => ({ mcpBridge: { token: 'local', servers: [{ name: 'local_tools', url: 'http://127.0.0.1:1/mcp/local_tools' }] } }));
    const engine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {}, binaryPath: '', logger: silentLogger, clientInfo: { name: 'cindy', version: 'test' },
      preparePiExtraSpawnConfig: prepared,
      endpoints: { connect: async (_key, options) => { connected.push(options); return agent.transport; } },
    });
    const handle = await engine.startSession({
      workingDir: '/shadow/p', model: '', providerId: 'acp-plugin:dsh-acp:dsh', deviceHosted: hosted, pluginEngineBriefing: 'You are a Worker.',
    });
    expect(connected).toEqual([{ remoteWorkspace: true }]);
    // This computer's own Cindy tools, plugins and memory stay out of a task that lives elsewhere.
    expect(prepared).not.toHaveBeenCalled();
    const bearer = [{ name: 'Authorization', value: 'Bearer tunnel-token' }];
    expect((agent.sent.find((message) => message.method === 'session/new')!.params as AcpRecord).mcpServers).toEqual([
      { type: 'http', name: 'cindy_exec', url: 'http://127.0.0.1:4711/mcp/cindy_exec', headers: bearer },
      { type: 'http', name: 'cindy', url: 'http://127.0.0.1:4711/mcp/cindy', headers: bearer },
      { type: 'http', name: 'cindy_memory', url: 'http://127.0.0.1:4711/mcp/cindy_memory', headers: bearer },
    ]);
    await handle.send({ type: 'user', content: 'hi' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const [note, message, more] = agent.prompts[0]!.params.prompt as Array<{ text: string }>;
    // The agent gets no Cindy system prompt: the first message tells it where the project is and which tools reach it.
    expect(note!.text).toContain('/shadow/p');
    expect(note!.text).toContain('cindy_exec');
    expect(note!.text).toContain('You are a Worker.');
    expect(message).toEqual({ type: 'text', text: 'hi' });
    expect(more).toBeUndefined();

    // Shared-provider guest tasks add guestWorkspace: true so the plugin isolates owner-local skills/fetch/state.
    await engine.startSession({
      workingDir: '/shadow/p', model: '', providerId: 'acp-plugin:dsh-acp:dsh',
      deviceHosted: { ...hosted, guest: true },
    });
    expect(connected).toEqual([{ remoteWorkspace: true }, { remoteWorkspace: true, guestWorkspace: true }]);
    expect(prepared).not.toHaveBeenCalled();
  });

  // Review (#12294, P1)：托管任务与内置引擎一致，附任务所在电脑带来的花名册快照（隧道提供 cindy 时），不读本机花名册，
  // 也不附 Skill 清单。最小失败输入：带快照的托管启动；隧道没有 cindy 的托管启动。unit tier。
  it.each([
    { name: 'with the gateway', servers: ['cindy', 'cindy_memory'], expected: true },
    { name: 'without the gateway', servers: ['cindy_memory'], expected: false },
  ])('gives a hosted task the roster snapshot of the task computer $name, never this computer\'s', async ({ servers, expected }) => {
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const roster = vi.fn(() => '<ghost-roster>{"id":"local-only"}</ghost-roster>');
    const skills = vi.fn(async () => skillList);
    const handle = await briefingEngine(agent, roster, skills).startSession({
      workingDir: '/shadow/p', model: '', providerId: 'acp-plugin:dsh-acp:dsh',
      deviceHosted: { ...hosted, mcpServers: servers },
      ghostRosterSnapshot: '<ghost-roster>\n{"id":"task-computer-plugin"}\n</ghost-roster>',
    });
    expect(roster).not.toHaveBeenCalled();
    expect(skills).not.toHaveBeenCalled();
    const [briefing] = await firstPrompt(agent, handle);
    expect(briefing!.text.includes('task-computer-plugin')).toBe(expected);
    expect(briefing!.text).not.toContain('local-only');
    expect(briefing!.text).not.toContain('<cindy-skills>');
  });

  it.each([
    ['the agent cannot connect to the tools of the task\'s computer', { agentCapabilities: {} }, { deviceHosted: hosted, model: '' }, 'PLUGIN_ENGINE_REMOTE_TOOLS_UNSUPPORTED'],
    ['the task is on an SSH host', { agentCapabilities: { mcpCapabilities: { http: true } } }, { remoteHostId: 'box', model: '' }, "'remoteSession' not supported"],
    ['a hosted guest requests an approved model that the engine does not apply', {
      agentCapabilities: { mcpCapabilities: { http: true } },
      configOptions: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'default-unapproved', options: [{ value: 'default-unapproved', name: 'Default' }] }],
    }, { deviceHosted: { ...hosted, guest: true }, model: 'approved-only' }, 'does not offer model'],
  ])('refuses a remote task when %s', async (_name, agentOptions, extra, message) => {
    const agent = createFakeAgent(agentOptions);
    await expect(createAcpAgent(() => agent.transport).startSession({
      workingDir: '/shadow/p', providerId: 'acp-plugin:dsh-acp:dsh', ...extra,
    })).rejects.toThrow(message);
    expect(agent.prompts).toHaveLength(0);
  });

  // Unit regressions for PR #11549. Simulate a failed resume with and without
  // an exit receipt at AcpAgent.startSession, which Maker uses for cleanup.
  it('preserves the old conversation and surfaces an actionable resume error', async () => {
    const agent = createFakeAgent();
    const confirmNativeReset = vi.fn(async () => true);
    const start = createAcpAgent(() => agent.transport).startSession({
      workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh',
      resumeSessionId: 'old-1', onInvalidResumeSession: confirmNativeReset,
    });
    const error = await start.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AgentStartupStoppedError);
    expect(error).toMatchObject({ cause: { sessionId: 'old-1', message: expect.stringContaining('[PLUGIN_ENGINE_RESUME_UNAVAILABLE]') } });
    expect(confirmNativeReset).not.toHaveBeenCalled();
    expect(agent.methods()).toEqual(['initialize']);
    expect(agent.closedByClient).toBe(true);
  });

  it('retains cleanup responsibility when resume fails and the endpoint is still running', async () => {
    const agent = createFakeAgent();
    const close = vi.spyOn(agent.transport, 'close').mockRejectedValueOnce(new Error('endpoint still running'));
    const connect = vi.fn(() => agent.transport);
    const error = await createAcpAgent(connect).startSession({
      workingDir: '/w', model: '', providerId: 'acp-plugin:dsh-acp:dsh', resumeSessionId: 'old-1',
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AgentStartupCleanupPendingError);
    if (!(error instanceof AgentStartupCleanupPendingError)) throw error;
    const stopped = vi.fn();
    void error.whenStopped.then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    await error.retryCleanup?.();
    await error.whenStopped;
    expect(close).toHaveBeenCalledTimes(2);
    expect(stopped).toHaveBeenCalledOnce();
  });

  // 生产入口与可观察结果：AcpAgent.startSession 在伙伴会话中把身份/上下文/记忆快照/用户画像拼入新会话首轮 briefing，并按伙伴的工具允许列表挂载工具桥。
  // 依据：docs/product-rules/cindy-bots-runtime.md §5，不改动内置引擎提示词，ACP 走首轮 briefing。
  // 覆盖缺口：此前 AcpAgent 只转发 pluginEngineBriefing 与 pluginEngineTrustedCaller，忽略 botProfile* 字段。
  // 最小失败输入与 tier：unit，带 botProfilePrompt / botProfileContextPrompt / makerMemoryIndexSnapshot / botUserProfilePrompt 启动并发送首条消息。
  // A plugin may change its catalogue between saving the companion and starting its chat.
  it.each(['missing', 'refused', 'kept-previous'] as const)('never sends a companion message on a different model: %s', async condition => {
    const offered = { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'first',
      options: [{ value: 'first', name: 'First' }, ...(condition === 'missing' ? [] : [{ value: 'chosen', name: 'Chosen' }])] };
    const fake = createFakeAgent({ configOptions: [offered], handlers: { 'session/set_config_option': () => {
      if (condition === 'refused') throw new Error('Model selection refused');
      return { configOptions: [offered] };
    } } });
    const engine = createAcpAgent(() => fake.transport);
    const policy = { mode: 'allowlist' as const, configured: [], catalog: [] };
    await expect(engine.startSession({ workingDir: '/w', model: 'chosen', providerId: 'acp-plugin:sample:engine',
      botRuntimeProfile: { botId: 'research', profileVersion: 1, skillPolicy: policy, mcpPolicy: policy, toolsetPolicy: policy },
    })).rejects.toThrow(/model/i);
    expect(fake.prompts).toHaveLength(0);
    expect(fake.closedByClient).toBe(true);
  });

  // A profile edit rebuilds the runtime around the same native history. Only current companion context is replayable.
  it.each([
    { method: 'session/resume', caps: { sessionCapabilities: { resume: {} } } },
    { method: 'session/load', caps: { loadSession: true } },
  ])('restores the current companion profile once with $method and keeps the engine default', async ({ method, caps }) => {
    const fake = createFakeAgent({ agentCapabilities: caps, handlers: { [method]: () => ({}) } });
    const engine = createAcpAgent(() => fake.transport);
    const policy = { mode: 'allowlist' as const, configured: [], catalog: [] };
    const handle = await engine.startSession({
      workingDir: '/w', model: 'default', providerId: 'acp-plugin:sample:engine', resumeSessionId: 'old-1',
      botRuntimeProfile: { botId: 'research', profileVersion: 2, skillPolicy: policy, mcpPolicy: policy, toolsetPolicy: policy },
      botProfilePrompt: 'Your new name is Lantern.', botUserProfilePrompt: 'The user now prefers short answers.',
      pluginEngineBriefing: 'One-time handoff.',
    });
    expect(fake.methods()).toEqual(['initialize', method]);
    await handle.send({ type: 'user', content: 'name?' });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    expect(fake.prompts[0]!.params).toMatchObject({ sessionId: 'old-1', prompt: [
      { type: 'text', text: 'Your new name is Lantern.\n\nThe user now prefers short answers.' }, { type: 'text', text: 'name?' },
    ] });
    fake.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await handle.send({ type: 'user', content: 'again?' });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2));
    expect(fake.prompts[1]!.params.prompt).toEqual([{ type: 'text', text: 'again?' }]);
    fake.prompts[1]!.settle.resolve({ stopReason: 'end_turn' });
    await handle.close();
  });

  it('sends as the companion with its selected plugin model and receives the reply', async () => {
    const offered = { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'first',
      options: [{ value: 'first', name: 'First' }, { value: 'chosen', name: 'Chosen' }] };
    const fake = createFakeAgent({ configOptions: [offered], handlers: {
      'session/set_config_option': ({ value }) => ({ configOptions: [{ ...offered, currentValue: value }] }),
    } });
    const connect = vi.fn(async (_key: string) => fake.transport);
    const contexts: Array<Record<string, unknown>> = [];
    const engine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {}, binaryPath: '', logger: silentLogger, clientInfo: { name: 'cindy', version: 'test' },
      endpoints: { connect },
      preparePiExtraSpawnConfig: async (_providers, ctx) => { contexts.push(ctx as unknown as Record<string, unknown>); return null; },
    });
    const handle = await engine.startSession({
      workingDir: '/w',
      model: 'chosen',
      providerId: 'acp-plugin:dsh-acp:dsh',
      botProfilePrompt: 'You are Mika, a calm research buddy.',
      botRuntimeProfile: {
        botId: 'research', profileVersion: 1,
        skillPolicy: { mode: 'allowlist', configured: [], catalog: [] },
        toolsetPolicy: { mode: 'allowlist', configured: [], catalog: [] },
        mcpPolicy: { mode: 'allowlist', configured: ['notes'], catalog: [{ name: 'notes', source: 'custom' }] },
      },
      botProfileContextPrompt: 'Teammate rules and capabilities.',
      makerMemoryEnabled: true,
      makerMemoryIndexSnapshot: 'Memory index: prefers concise tables.',
      botUserProfilePrompt: 'The user prefers weekly summaries.',
    });
    expect(connect).toHaveBeenCalledWith('dsh-acp:dsh');
    expect(handle.model).toBe('chosen');
    expect(fake.sent).toContainEqual(expect.objectContaining({ method: 'session/set_config_option',
      params: expect.objectContaining({ configId: 'model', value: 'chosen' }) }));
    const events: Array<{ type: string; data: unknown }> = [];
    const readReply = (async () => {
      for await (const event of handle.events()) {
        events.push(event);
        if (event.type === 'done') break;
      }
    })();
    expect(contexts).toEqual([expect.objectContaining({ mcpCallerKind: 'unknown', mcpCallerAttested: false, memoryEnabled: true,
      botMcpPolicy: { mode: 'allowlist', configured: ['notes'], catalog: [{ name: 'notes', source: 'custom' }] } })]);
    await handle.send({ type: 'user', content: 'hello' });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    const [brief, userMsg] = fake.prompts[0]!.params.prompt as Array<{ text: string }>;
    expect(brief!.text).toContain('You are Mika, a calm research buddy.');
    expect(brief!.text).toContain('Teammate rules and capabilities.');
    expect(brief!.text).toContain('Memory index: prefers concise tables.');
    expect(brief!.text).toContain('The user prefers weekly summaries.');
    expect(userMsg).toEqual({ type: 'text', text: 'hello' });
    fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from the chosen model.' } });
    fake.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await readReply;
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', data: expect.objectContaining({ text: 'Hello from the chosen model.' }) }));
    await handle.setModel?.('default');
    expect(handle.model).toBe('first');
    await handle.close();
  });

  // Regression (Antigravity agy 1.5.16, 2026-11-25): `agy acp` scans the entire `session/prompt`
  // text for standalone `/command` tokens and appends `/learn` (plus `<LEARN>` instructions) when
  // Cindy's Turn-1 Skill list, plugin roster, handoff replay or wire notes mention `/learn` or `/pr`.
  it('defuses slash-command mentions in host briefings and handoffs without touching paths, URLs or user text', async () => {
    const rawLearnPath = '/opt/cindy/shared-system-skills/learn/SKILL.md';
    const skills = [
      {
        name: 'learn',
        description: 'Capture reusable lessons when the user directly invokes /learn or /skill:learn in Pi. See https://cindy.app/learn and cost/spend.',
        path: rawLearnPath,
      },
      {
        name: 'cindy-plugin-github:pr',
        description: 'Use when the user invokes /pr or /mr, checks @expo/ui on iOS/Android, or reads /tmp/build.log and /learn.md.',
        path: '/work/skills/pr/SKILL.md',
      },
      {
        name: 'custom-deploy',
        description: 'Run /custom-deploy after PUT /harnesses in ~/learn or ./plan.',
        path: '/work/skills/custom-deploy/SKILL.md',
      },
    ];
    const rendered = renderPluginEngineCapabilityBriefing(
      {
        pluginRoster: '<ghost-roster>\n{"id":"cindy-github","recall":"发 PR 时输入 /pr 或调用/learn时触发"}\n</ghost-roster>',
        skills,
      },
      ['cindy'],
    );
    expect(rendered).toContain('directly invokes learn or skill:learn in Pi.');
    expect(rendered).toContain('invokes pr or mr,');
    expect(rendered).toContain('Run custom-deploy after PUT /harnesses in ~/learn or ./plan.');
    expect(rendered).toContain('发 PR 时输入 pr 或调用learn时触发');
    // Paths, closing XML tags, URLs, scoped packages, ratios and dotted filenames stay intact.
    expect(rendered).toContain(JSON.stringify(rawLearnPath));
    expect(rendered).toContain('</cindy-skills>');
    expect(rendered).toContain('</ghost-roster>');
    expect(rendered).toContain('https://cindy.app/learn');
    expect(rendered).toContain('cost/spend');
    expect(rendered).toContain('@expo/ui');
    expect(rendered).toContain('iOS/Android');
    expect(rendered).toContain('/tmp/build.log');
    expect(rendered).toContain('/learn.md');
    expect(defusePluginEngineSlashMentions('No slash here')).toBe('No slash here');
    expect(formatPluginEngineSkillList(skills)).toContain('invokes learn or skill:learn');

    // Host wire envelope defuses notes/handoffs while preserving the user's own `/learn` or `/plan`.
    expect(defusePluginEngineWireEnvelope(
      '[客户端说明] 之前提到 `/learn` 与 /compact。\n\n请帮我执行 /learn 总结这轮改动',
      '请帮我执行 /learn 总结这轮改动',
    )).toBe('[客户端说明] 之前提到 `learn` 与 compact。\n\n请帮我执行 /learn 总结这轮改动');
    const userBlock = { type: 'text', text: '/plan 重构认证模块' };
    expect(defusePluginEngineWireEnvelope(
      { type: 'user', content: [{ type: 'text', text: '[引用说明] 上条提到 /learn。' }, userBlock] },
      { type: 'user', content: [userBlock] },
    )).toEqual({
      type: 'user',
      content: [{ type: 'text', text: '[引用说明] 上条提到 learn。' }, userBlock],
    });
    expect(defusePluginEngineWireEnvelope(
      '[引用说明] 上条提到 /release-check。\n\n请继续处理',
      '请继续处理',
      ['release-check'],
    )).toBe('[引用说明] 上条提到 release-check。\n\n请继续处理');

    // Live ACP session: available_commands_update custom commands are defused in pendingBriefing and
    // handoff prefixes, while a leading user `/plan` keeps index 0 and defers pendingBriefing to Turn 2.
    const agent = createFakeAgent({
      agentCapabilities: { mcpCapabilities: { http: true } },
      handlers: {
        'session/new': () => {
          queueMicrotask(() => {
            agent.update({
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'release-check', description: 'Run release check' }],
            });
          });
          return { sessionId: 'sess-1', configOptions: [] };
        },
      },
    });
    const handle = await briefingEngine(
      agent,
      vi.fn(() => '<ghost-roster>{"id":"cindy-github","recall":"Run /release-check or /learn"}</ghost-roster>'),
      vi.fn(async () => skills),
    ).startSession({
      workingDir: '/repo',
      model: '',
      providerId: 'acp-plugin:agy:agy',
      pluginEngineBriefing: 'Worker note: do not run /compact or /release-check.',
    });
    await vi.waitFor(() => expect(agent.methods()).toContain('session/new'));
    await new Promise((r) => setTimeout(r, 0));

    // Turn 1 starts with a native slash command: stays at prompt[0], briefing waits for Turn 2.
    await handle.send({ type: 'user', content: '/plan check auth flow' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    expect(agent.prompts[0]!.params.prompt).toEqual([{ type: 'text', text: '/plan check auth flow' }]);
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

    // Turn 2 starts with a file path `/tmp/build.log` (not a slash command). User text is preserved
    // byte-for-byte, including pasted handoff markers and slash commands.
    const handoffAndUser = [
      '[Session handoff · internal context]',
      'Earlier note mentioned /learn and /release-check.',
      "== End of handoff note; the user's new message follows ==",
      '',
      '/tmp/build.log 里为什么报 /learn 相关错误？',
    ].join('\n');
    await handle.send({ type: 'user', content: handoffAndUser });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    const [briefingBlock, secondMessage] = agent.prompts[1]!.params.prompt as Array<{ type: string; text: string }>;
    expect(briefingBlock!.text).toContain('Run release-check or learn');
    expect(briefingBlock!.text).toContain('do not run compact or release-check.');
    expect(secondMessage!.text).toContain('Earlier note mentioned /learn and /release-check.');
    expect(secondMessage!.text).toContain('/tmp/build.log 里为什么报 /learn 相关错误？');
    agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn' });
    await handle.close();
  });

  // 测试价值
  // - 生产入口与可观察结果：AcpAgent.startSession 首轮 briefing 与 formatPluginEngineSkillList；
  //   确认单条 Skill 描述在 600 字符以内完整保留尾部触发条件、超长描述仍受 600 字符约束，且
  //   Cindy 托管/插件 Skill（managed: true）排在普通扫描 Skill 之前、在触及 24,000 字符或 120 条
  //   上限时最后被裁切，同时同路径去重优先保留 managed 项。
  // - Bug／规则依据：docs/plans/acp-plugin-bridge.md「插件与 Skill 告知」；此前 280 字符硬截断
  //   会把 pr 等 400+ 字符 Skill 的 "Use when ..." 触发段腰斩，且纯字母排序 + 尾部 pop 会在超预算时
  //   优先静默淘汰字母靠后的 pr / mr。
  // - 现有覆盖缺口：此前 acp-session.test.ts 未覆盖 >280 字符描述保留、>600 字符截断边界及
  //   managed Skill 的排序与预算保护。
  // - 最小失败输入：1 条 405 字符且带 managed: true 的 pr Skill、1 条 >600 字符扫描 Skill，以及
  //   足以触及 24,000 字符预算和 120 条上限的字母靠前扫描 Skill。
  // - tier：unit（内存假 ACP 对端与纯函数格式化）。
  it('preserves Skill trigger clauses up to 600 chars and keeps managed Skills first under budget caps', async () => {
    const prDescription =
      'Carry a GitHub pull request from start to merge in any Git repository - start the work on a fresh branch, ' +
      'open the PR only when the user asks for it, fix failing checks, merge conflicts and review feedback, ' +
      'follow it in the background, and clean up after merge. Use when the user invokes /pr or gives a PR link, ' +
      'starts a feature or fix that will become a pull request, or asks to open, fix or follow a PR.';
    const hugeDescription = `${'A'.repeat(590)} /pr ${'B'.repeat(200)}`;
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const skills = [
      { name: 'aaa-scanned', description: hugeDescription, path: '/home/.agents/skills/aaa-scanned/SKILL.md' },
      { name: 'pr-duplicate', description: 'Scanned copy', path: '/cindy/plugins/cindy-github/skills/pr/SKILL.md' },
      { name: 'pr', description: prDescription, path: '/cindy/plugins/cindy-github/skills/pr/SKILL.md', managed: true },
    ];
    const handle = await briefingEngine(
      agent,
      vi.fn(() => '<ghost-roster>{"id":"cindy-github"}</ghost-roster>'),
      vi.fn(async () => skills),
    ).startSession({ workingDir: '/repo', model: '', providerId: 'acp-plugin:agy:agy' });

    const [briefing] = await firstPrompt(agent, handle);
    const prIdx = briefing!.text.indexOf('- pr: ');
    const scannedIdx = briefing!.text.indexOf('- aaa-scanned: ');
    expect(prIdx).toBeGreaterThan(-1);
    expect(scannedIdx).toBeGreaterThan(prIdx);
    expect(briefing!.text).toContain('Use when the user invokes pr or gives a PR link, starts a feature or fix that will become a pull request, or asks to open, fix or follow a PR.');
    expect(briefing!.text).not.toContain('- pr-duplicate:');
    // Over-600 scanned description is bounded and slash-defused without leaking trailing tail.
    const scannedLine = briefing!.text.split('\n').find((line) => line.startsWith('- aaa-scanned: '))!;
    expect(scannedLine).toContain(' pr ');
    expect(scannedLine).not.toContain('/pr');
    expect(scannedLine).not.toContain('B'.repeat(20));

    // Character budget (24,000) evicts trailing non-managed scanned Skills while preserving managed `pr` / `mr`.
    const budgetOverflow = [
      ...Array.from({ length: 60 }, (_, i) => ({
        name: `aaa-expo-${String(i).padStart(2, '0')}`,
        description: 'X'.repeat(550),
        path: `/home/.agents/skills/aaa-expo-${i}/SKILL.md`,
      })),
      { name: 'pr', description: prDescription, path: '/cindy/skills/pr/SKILL.md', managed: true },
      { name: 'mr', description: 'Follow GitLab MRs.', path: '/cindy/skills/mr/SKILL.md', managed: true },
    ];
    const budgeted = formatPluginEngineSkillList(budgetOverflow);
    expect(budgeted.length).toBeLessThanOrEqual(24_000);
    expect(budgeted.indexOf('- mr: ')).toBeLessThan(budgeted.indexOf('- pr: '));
    expect(budgeted.indexOf('- pr: ')).toBeLessThan(budgeted.indexOf('- aaa-expo-00: '));
    expect(budgeted).toContain('asks to open, fix or follow a PR.');
    expect(budgeted).not.toContain('- aaa-expo-59: ');

    // Item cap (120) also keeps managed Skills ahead of 125 alphabetically earlier scanned Skills.
    const itemOverflow = [
      ...Array.from({ length: 125 }, (_, i) => ({
        name: `aaa-skill-${String(i).padStart(3, '0')}`,
        description: 'Short',
        path: `/home/.agents/skills/s-${i}/SKILL.md`,
      })),
      { name: 'pr', description: 'PR workflow', path: '/cindy/skills/pr/SKILL.md', managed: true },
    ];
    const capped = formatPluginEngineSkillList(itemOverflow);
    expect(capped).toContain('- pr: PR workflow');
    expect(capped).not.toContain('- aaa-skill-124:');

    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await handle.close();
  });

  // 测试价值
  // - 生产入口与可观察结果：AcpAgent.startSession / openAcpSession / createAcpMcpResultBackfiller；
  //   当 ACP 引擎对 MCP tool_call_update 不返回 content/rawOutput（如 agy acp）时，tool_result_full
  //   从 Host MCP 回执回填带 xdt_card_id 的完整文本并透传 isError；已有 ACP 输出或中断调用不被覆盖。
  // - Bug／规则依据：Antigravity 插件引擎调用 pr_card 等 Cindy 插件工具后，ACP 只发 status: completed
  //   且无输出正文，导致消息落库为 "done"、PR 卡片与媒体回锚消失。
  // - 现有覆盖缺口：此前 acp-session.test.ts 仅验证带 content/diff 的普通工具，未覆盖空 MCP 结算回填。
  // - 最小失败输入：ACP 发送 mcp__cindy__ghost_call 的 tool_call 与无 content/rawOutput 的 completed
  //   更新，同时 Host MCP 桶已记录带 toolSummary 与 xdt_card_id 的回包。
  // - tier：unit（内存假 ACP 对端与纯函数桶）。
  it('backfills empty ACP MCP tool_call_update results from Host receipts without overwriting agent output or interrupted calls', async () => {
    const bucket = createMcpToolResultBucket();
    const prCardJson = JSON.stringify({
      ok: true,
      result: { card_id: 'card-pr-1', stage: 'open' },
      xdt_card_id: 'card-pr-1',
      xdt_card_turn_end: true,
    });
    const searchJson = JSON.stringify({ ok: true, result: { hits: 2 } });
    const errJson = JSON.stringify({ ok: false, errorCode: 'DENIED', message: 'forbidden' });

    const seenCtx: Array<Record<string, unknown>> = [];
    const agent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const engine = new AcpAgent({
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: {},
      binaryPath: '',
      logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      endpoints: { connect: async () => agent.transport },
      preparePiExtraSpawnConfig: async (_providers, ctx) => {
        seenCtx.push(ctx as unknown as Record<string, unknown>);
        return {
          mcpBridge: {
            token: 'tok',
            servers: [
              { name: 'cindy', url: 'http://127.0.0.1:1/mcp/cindy' },
              { name: 'cindy_helper', url: 'http://127.0.0.1:1/mcp/cindy_helper' },
            ],
          },
          takeMcpToolResult: (query) => bucket.take(query),
        };
      },
    });

    const handle = await engine.startSession({
      workingDir: '/repo',
      model: '',
      providerId: 'acp-plugin:agy:agy',
    });
    expect(seenCtx).toHaveLength(1);
    expect(seenCtx[0]!.recordMcpToolResults).toBe(true);

    const events: AgentEvent[] = [];
    const pump = (async () => {
      for await (const event of handle.events()) events.push(event);
    })();

    await handle.send({ type: 'user', content: 'open PR card' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    // Concurrent calls that finish out of order; Host recorded args with toolSummary & different key order.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-pr',
      title: 'mcp__cindy__ghost_call',
      rawInput: { args: { pr: '12880', repo: 'makecindy/cindy' }, ghost_id: 'cindy-github', namespace: null, tool: 'pr_card' },
    });
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-search',
      title: 'mcp__cindy__ghost_call',
      rawInput: { args: { q: 'foo' }, ghost_id: 'xd-feishu', namespace: 'xd', tool: 'search' },
    });
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-err',
      title: 'mcp__cindy_helper__call_tool',
      rawInput: { name: 'set_title', args: { title: 'x' } },
    });
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-native',
      title: 'mcp__cindy__ghost_info',
      rawInput: { ghost_id: 'cindy-github' },
    });

    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_call',
      input: { tool: 'pr_card', namespace: null, ghost_id: 'cindy-github', args: { repo: 'makecindy/cindy', pr: '12880' }, toolSummary: 'Show PR card' },
      fullText: prCardJson,
      isError: false,
    });
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_call',
      input: { ghost_id: 'xd-feishu', namespace: 'xd', tool: 'search', args: { q: 'foo' }, toolSummary: 'Search' },
      fullText: searchJson,
      isError: false,
    });
    bucket.record({
      serverName: 'cindy_helper',
      toolName: 'call_tool',
      input: { name: 'set_title', args: { title: 'x' } },
      fullText: errJson,
      isError: true,
    });
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_info',
      input: { ghost_id: 'cindy-github' },
      fullText: '{"from":"host"}',
      isError: false,
    });

    // Finish search before pr_card, both with empty ACP content/rawOutput.
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-search', status: 'completed' });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-pr', status: 'completed' });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-err', status: 'completed' });
    // Agent DOES report content here: must NOT overwrite with Host receipt.
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-native',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '{"from":"agent"}' } }],
    });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done')).toBe(true));

    const fullById = new Map(
      events
        .filter((e) => e.type === 'tool_result_full')
        .map((e) => [(e.data as AcpRecord).toolUseId as string, e.data as AcpRecord]),
    );
    const summaryById = new Map(
      events
        .filter((e) => e.type === 'tool_result')
        .map((e) => [((e.data as AcpRecord).toolUseIds as string[])[0]!, (e.data as AcpRecord).summary as string]),
    );

    expect(fullById.get('call-pr')).toEqual({ toolUseId: 'call-pr', fullText: prCardJson, isError: false });
    expect(fullById.get('call-search')).toEqual({ toolUseId: 'call-search', fullText: searchJson, isError: false });
    expect(fullById.get('call-err')).toEqual({ toolUseId: 'call-err', fullText: errJson, isError: true });
    expect(summaryById.get('call-err')).toBe('failed');
    expect(fullById.get('call-native')).toEqual({ toolUseId: 'call-native', fullText: '{"from":"agent"}', isError: false });
    // Native-output call retired its matching Host receipt so a later identical empty call cannot reuse it.
    expect(bucket.size()).toBe(0);

    // Follow-up identical call with empty ACP output gets only its own fresh receipt.
    await handle.send({ type: 'user', content: 'repeat ghost_info and cancel mid call' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-native-repeat',
      title: 'mcp__cindy__ghost_info',
      rawInput: { ghost_id: 'cindy-github' },
    });
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_info',
      input: { ghost_id: 'cindy-github' },
      fullText: '{"from":"host-v2"}',
      isError: false,
    });
    agent.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-native-repeat', status: 'completed' });

    // Interrupted call retires its already-recorded Host receipt while keeping the interrupted text.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-cancelled',
      title: 'mcp__cindy__ghost_info',
      rawInput: { ghost_id: 'cindy-github' },
    });
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_info',
      input: { ghost_id: 'cindy-github' },
      fullText: '{"from":"interrupted-call"}',
      isError: false,
    });
    agent.prompts[1]!.settle.resolve({ stopReason: 'cancelled' });
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'done')).toHaveLength(2));
    const repeatFull = events.find(
      (e) => e.type === 'tool_result_full' && (e.data as AcpRecord).toolUseId === 'call-native-repeat',
    )?.data as AcpRecord | undefined;
    expect(repeatFull).toEqual({
      toolUseId: 'call-native-repeat',
      fullText: '{"from":"host-v2"}',
      isError: false,
    });
    const cancelledFull = events.find(
      (e) => e.type === 'tool_result_full' && (e.data as AcpRecord).toolUseId === 'call-cancelled',
    )?.data as AcpRecord | undefined;
    expect(cancelledFull).toEqual({
      toolUseId: 'call-cancelled',
      fullText: 'Interrupted before the tool finished.',
      isError: true,
    });
    expect(bucket.size()).toBe(0);

    await handle.close();
    await pump;
  });

  it('backfills remote device-hosted ACP tool_result_full via createAcpMcpResultBackfiller and parses underscore MCP names', () => {
    expect(parseAcpMcpToolName('mcp__cindy_helper__call_tool', ['cindy', 'cindy_helper'])).toEqual({
      serverName: 'cindy_helper',
      toolName: 'call_tool',
    });
    expect(parseAcpMcpToolName('mcp_cindy_helper_call_tool', ['cindy', 'cindy_helper'])).toEqual({
      serverName: 'cindy_helper',
      toolName: 'call_tool',
    });

    const bucket = createMcpToolResultBucket();
    const cardText = '{"ok":true,"xdt_card_id":"remote-card-1"}';
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_call',
      input: { ghost_id: 'cindy-github', namespace: null, tool: 'pr_card', args: { pr: '42' }, toolSummary: 'PR' },
      fullText: cardText,
      isError: false,
    });
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_call',
      input: { ghost_id: 'cindy-github', namespace: null, tool: 'status_watch', args: {} },
      fullText: '{"ok":false,"errorCode":"AUTH"}',
      isError: true,
    });

    const mapEvent = createAcpMcpResultBackfiller({
      takeMcpToolResult: (q) => bucket.take(q),
      serverNames: ['cindy'],
    });

    // Input arrives via patch after initial empty tool_use, then empty tool_result_full.
    mapEvent({ type: 'tool_use', data: { toolUseId: 'tu-1', toolName: 'mcp__cindy__ghost_call', input: {} } });
    mapEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'tu-1',
        toolName: 'mcp__cindy__ghost_call',
        input: { ghost_id: 'cindy-github', namespace: null, tool: 'pr_card', args: { pr: '42' } },
        acpInputPatch: true,
      },
    });
    const filled = mapEvent({ type: 'tool_result_full', data: { toolUseId: 'tu-1', fullText: '', isError: false } });
    expect(filled.data).toEqual({ toolUseId: 'tu-1', fullText: cardText, isError: false });

    // Error receipt flips both tool_result_full.isError and subsequent tool_result.summary.
    mapEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'tu-2',
        toolName: 'mcp__cindy__ghost_call',
        input: { ghost_id: 'cindy-github', namespace: null, tool: 'status_watch', args: {} },
      },
    });
    const errFilled = mapEvent({ type: 'tool_result_full', data: { toolUseId: 'tu-2', fullText: '', isError: false } });
    expect(errFilled.data).toEqual({
      toolUseId: 'tu-2',
      fullText: '{"ok":false,"errorCode":"AUTH"}',
      isError: true,
    });
    const errSummary = mapEvent({ type: 'tool_result', data: { summary: 'done', toolUseIds: ['tu-2'] } });
    expect(errSummary.data).toEqual({ summary: 'failed', toolUseIds: ['tu-2'] });

    // Non-empty tool_result_full passes through unchanged AND retires its matching Host receipt,
    // so a subsequent identical empty-output call receives its own fresh receipt instead of the old one.
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_call',
      input: { ghost_id: 'cindy-github', namespace: null, tool: 'pr_card', args: { pr: '99' } },
      fullText: '{"ok":true,"xdt_card_id":"stale-card"}',
      isError: false,
    });
    mapEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'tu-3',
        toolName: 'mcp__cindy__ghost_call',
        input: { ghost_id: 'cindy-github', namespace: null, tool: 'pr_card', args: { pr: '99' } },
      },
    });
    const untouched = mapEvent({ type: 'tool_result_full', data: { toolUseId: 'tu-3', fullText: 'already here', isError: false } });
    expect(untouched.data).toEqual({ toolUseId: 'tu-3', fullText: 'already here', isError: false });
    bucket.record({
      serverName: 'cindy',
      toolName: 'ghost_call',
      input: { ghost_id: 'cindy-github', namespace: null, tool: 'pr_card', args: { pr: '99' } },
      fullText: '{"ok":true,"xdt_card_id":"fresh-card"}',
      isError: false,
    });
    mapEvent({
      type: 'tool_use',
      data: {
        toolUseId: 'tu-4',
        toolName: 'mcp__cindy__ghost_call',
        input: { ghost_id: 'cindy-github', namespace: null, tool: 'pr_card', args: { pr: '99' } },
      },
    });
    const freshFilled = mapEvent({ type: 'tool_result_full', data: { toolUseId: 'tu-4', fullText: '', isError: false } });
    expect(freshFilled.data).toEqual({
      toolUseId: 'tu-4',
      fullText: '{"ok":true,"xdt_card_id":"fresh-card"}',
      isError: false,
    });
  });
});

// 测试价值
// - 生产入口与可观察结果：AcpAgent.startSession / openAcpSession / AcpSession.setExtraDirs / setWritableDirs /
//   decidePermission；断言能力声明、目录说明与撤销注入、非完全访问下 routine 写目录边界校验，以及完全访问（bypassPermissions）放行。
// - 规则依据：docs/dev-rules/protocol-compatibility/plugin-harnesses.md「附加目录、只读 /review 与共享任务」与
//   docs/dev-rules/pi-full-access-native-parity.md（完全访问与内置引擎一致放行，非完全访问校验可写边界）。
// - 现有覆盖缺口：此前 ACP 的 extraDirs/writableDirs 标为 not-implemented 且缺少目录边界与完全访问放行回归覆盖。
// - 最小失败输入与 tier：unit；非完全访问下越界写/大小写路径键/软链逃逸/悬空链接/凭据路径/Library 根写入/并发撤权，以及完全访问下工作目录外写。
describe('AcpSession extraDirs and writableDirs', () => {
  const gateInit = () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: {}, mcpCapabilities: {}, sessionCapabilities: {} },
    _meta: { permissionGate: { supported: true } },
  });
  const requestMeta = (agent: ReturnType<typeof createFakeAgent>, index: number, routine = true) => {
    const { turnId } = asRecord(asRecord(agent.prompts[index]!.params._meta).permissionGate);
    return { _meta: { permissionGate: { turnId, routine } } };
  };
  const routineDesktopPolicy = (): TurnPermissionPolicy => ({
    origin: { kind: 'desktop' },
    confirmationSurface: 'desktop',
    forceConfirmToolCall: () => false,
  });

  it('advertises directory grant capabilities, includes briefing sections, excludes libraryRoot from general list, and emits mid-session updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-dirs-briefing-'));
    try {
      const workDir = join(root, 'workspace');
      const refDir = join(root, 'refs');
      const writeDir = join(root, 'writable');
      const libRoot = join(root, 'library');
      mkdirSync(workDir, { recursive: true });
      mkdirSync(refDir, { recursive: true });
      mkdirSync(writeDir, { recursive: true });
      mkdirSync(libRoot, { recursive: true });

      const agent = createFakeAgent({ handlers: { initialize: gateInit } });
      const engine = new AcpAgent(
        {
          auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
          runtimeConfig: {},
          binaryPath: '',
          logger: silentLogger,
          mcpProviders: [],
          clientInfo: { name: 'cindy-test', version: '0.0.0' },
          endpoints: { connect: async () => agent.transport },
        },
      );
      const handle = await engine.startSession({
        workingDir: workDir,
        model: '',
        providerId: 'acp-plugin:dsh:dsh',
        extraDirs: [refDir, libRoot],
        writableDirs: [writeDir],
        [LIBRARY_READ_ROOT]: libRoot,
      });

      expect(handle.negotiatedCapabilities?.extraDirs).toEqual({ supported: true });
      expect(handle.negotiatedCapabilities?.writableDirs).toEqual({ supported: true });

      const assetRef = `library:assets/ab/${'ab'.repeat(32)}/blob.png`;
      await handle.send({ type: 'user', content: `Inspect ${assetRef}` });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
      const turn1Blocks = agent.prompts[0]!.params.prompt as Array<{ type: string; text?: string }>;
      expect(turn1Blocks[0]!.text).toContain('<cindy-extra-reference-directories>');
      expect(turn1Blocks[0]!.text).toContain(`- ${refDir}`);
      expect(turn1Blocks[0]!.text).not.toContain(`- ${libRoot}`);
      expect(turn1Blocks[0]!.text).toContain('<cindy-extra-writable-directories>');
      expect(turn1Blocks[0]!.text).toContain(`- ${writeDir}`);
      const libBlock = turn1Blocks.at(-1)?.text ?? '';
      expect(libBlock).toContain('<cindy-library-native-read>');
      expect(libBlock).toContain(JSON.stringify({ libraryRoot: libRoot }));
      expect(libBlock).toContain(assetRef);
      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });

      // Revoke all extra & writable dirs and library root mid-session.
      await handle.setExtraDirs?.([], null);
      await handle.setWritableDirs?.([]);
      await handle.send({ type: 'user', content: 'Continue after revoke' });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(2));
      const turn2Blocks = agent.prompts[1]!.params.prompt as Array<{ type: string; text?: string }>;
      expect(turn2Blocks[0]!.text).toContain('<cindy-directory-grants-update>');
      expect(turn2Blocks[0]!.text).toContain('No extra reference directories or extra writable directories are currently authorized');
      expect(turn2Blocks.at(-1)?.text ?? '').toContain(JSON.stringify({ libraryRoot: null }));
      agent.prompts[1]!.settle.resolve({ stopReason: 'end_turn' });
      await handle.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces realpath-verified write directory boundaries and immediate revocation for routine policy auto-approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-write-bounds-'));
    try {
      const workDir = join(root, 'workspace');
      const writableDir = join(root, 'writable');
      const outsideDir = join(root, 'outside');
      const libraryDir = join(root, 'library');
      mkdirSync(workDir, { recursive: true });
      mkdirSync(writableDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(libraryDir, { recursive: true });
      const insideFile = join(workDir, 'app.ts');
      const outsideFile = join(outsideDir, 'secret.txt');
      writeFileSync(insideFile, 'ok');
      writeFileSync(outsideFile, 'nope');

      const escapingLink = join(writableDir, 'escape.txt');
      const danglingLink = join(writableDir, 'dangling.txt');
      let symlinksReady = true;
      try {
        symlinkSync(outsideFile, escapingLink);
        symlinkSync(join(outsideDir, 'missing.txt'), danglingLink);
      } catch {
        symlinksReady = false;
      }

      const agent = createFakeAgent({ handlers: { initialize: gateInit } });
      const { session } = await open(agent, {
        cwd: workDir,
        permissionMode: 'ask',
        extraDirs: [libraryDir],
        libraryRoot: libraryDir,
      });
      const asked: InteractionRequest[] = [];
      session.setInteractionResolver(async (request) => {
        asked.push(request);
        return { kind: 'permission', behavior: 'deny' };
      });

      await session.send({ type: 'user', content: 'Edit files' }, { turnPermissionPolicy: routineDesktopPolicy() });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

      // Inside cwd -> auto-approved for routine policy calls.
      const inside = await agent.requestPermission({
        toolCall: { toolCallId: 'w-in', kind: 'edit', rawInput: { path: 'app.ts' } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      expect(inside).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
      expect(asked).toHaveLength(0);

      // Outside cwd before grant (including PascalCase `Path` key without locations) -> escalated to resolver.
      const outsideBefore = await agent.requestPermission({
        toolCall: { toolCallId: 'w-out-1', kind: 'edit', rawInput: { path: outsideFile } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      const outsidePascalCase = await agent.requestPermission({
        toolCall: { toolCallId: 'w-out-pascal', kind: 'edit', rawInput: { Path: outsideFile } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      expect([outsideBefore, outsidePascalCase]).toEqual([
        { outcome: { outcome: 'selected', optionId: 'no' } },
        { outcome: { outcome: 'selected', optionId: 'no' } },
      ]);
      expect(asked).toHaveLength(2);

      // Grant writableDir -> existing or non-existent nested file inside writableDir is auto-approved (case-insensitive keys).
      await session.setWritableDirs([writableDir]);
      const grantedNested = await agent.requestPermission({
        toolCall: { toolCallId: 'w-grant', kind: 'edit', rawInput: { file_path: join(writableDir, 'nested', 'new.ts') } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      const grantedPascalCase = await agent.requestPermission({
        toolCall: { toolCallId: 'w-grant-pascal', kind: 'edit', rawInput: { Path: join(writableDir, 'nested', 'other.ts') } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      expect([grantedNested, grantedPascalCase]).toEqual([
        { outcome: { outcome: 'selected', optionId: 'yes' } },
        { outcome: { outcome: 'selected', optionId: 'yes' } },
      ]);
      expect(asked).toHaveLength(2);

      // Symlink escape and dangling symlink inside writableDir -> fail closed (escalated, not auto-approved).
      if (symlinksReady) {
        const escaped = await agent.requestPermission({
          toolCall: { toolCallId: 'w-sym', kind: 'edit', rawInput: { path: escapingLink } },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        });
        const dangling = await agent.requestPermission({
          toolCall: { toolCallId: 'w-dang', kind: 'edit', rawInput: { path: danglingLink } },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        });
        expect(escaped).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
        expect(dangling).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
      }

      // Move from writableDir to outsideDir -> fail closed (destination outside).
      const crossMove = await agent.requestPermission({
        toolCall: {
          toolCallId: 'w-move',
          kind: 'move',
          rawInput: { from: join(writableDir, 'a.ts'), to: join(outsideDir, 'b.ts') },
        },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      expect(crossMove).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });

      // Sensitive credential path inside cwd and read-only libraryRoot -> never auto-approved.
      const envEdit = await agent.requestPermission({
        toolCall: { toolCallId: 'w-env', kind: 'edit', rawInput: { path: join(workDir, '.env') } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      const libEdit = await agent.requestPermission({
        toolCall: { toolCallId: 'w-lib', kind: 'delete', rawInput: { path: join(libraryDir, 'blob.png') } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      // Missing path under permissionGate -> never auto-approved.
      const blindWrite = await agent.requestPermission({
        toolCall: { toolCallId: 'w-blind', kind: 'edit', rawInput: {} },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      expect([envEdit, libEdit, blindWrite]).toEqual([
        { outcome: { outcome: 'selected', optionId: 'no' } },
        { outcome: { outcome: 'selected', optionId: 'no' } },
        { outcome: { outcome: 'selected', optionId: 'no' } },
      ]);

      // Immediate revocation via setWritableDirs([]) blocks the previously allowed dir right away.
      await session.setWritableDirs([]);
      const askedBeforeRevoke = asked.length;
      const afterRevoke = await agent.requestPermission({
        toolCall: { toolCallId: 'w-revoked', kind: 'edit', rawInput: { file_path: join(writableDir, 'nested', 'new.ts') } },
        options: PERMISSION_OPTIONS,
        ...requestMeta(agent, 0),
      });
      expect(afterRevoke).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
      expect(asked.length).toBe(askedBeforeRevoke + 1);

      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await session.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('auto-approves writes outside cwd and writableDirs under bypassPermissions (Full access)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-full-access-writes-'));
    try {
      const workDir = join(root, 'workspace');
      const outsideDir = join(root, 'outside');
      const libraryDir = join(root, 'library');
      mkdirSync(workDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(libraryDir, { recursive: true });
      const outsideFile = join(outsideDir, 'worktree-file.ts');
      writeFileSync(outsideFile, 'export const a = 1;\n');

      for (const withGate of [false, true]) {
        const agent = createFakeAgent(withGate ? { handlers: { initialize: gateInit } } : undefined);
        const { session } = await open(agent, {
          cwd: workDir,
          permissionMode: 'bypassPermissions',
          extraDirs: [libraryDir],
          libraryRoot: libraryDir,
        });
        const asked: InteractionRequest[] = [];
        session.setInteractionResolver(async (request) => {
          asked.push(request);
          return { kind: 'permission', behavior: 'deny' };
        });

        await session.send({ type: 'user', content: 'Edit files across directories' });
        await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
        const meta = withGate ? requestMeta(agent, 0) : {};

        const outsideEdit = await agent.requestPermission({
          toolCall: {
            toolCallId: 'fa-out',
            kind: 'edit',
            locations: [{ path: outsideFile }],
            rawInput: { Path: outsideFile, Target: 'a = 1', Replacement: 'a = 2' },
          },
          options: PERMISSION_OPTIONS,
          ...meta,
        });
        const envEdit = await agent.requestPermission({
          toolCall: { toolCallId: 'fa-env', kind: 'edit', rawInput: { path: join(workDir, '.env') } },
          options: PERMISSION_OPTIONS,
          ...meta,
        });
        const libDelete = await agent.requestPermission({
          toolCall: { toolCallId: 'fa-lib', kind: 'delete', rawInput: { path: join(libraryDir, 'blob.png') } },
          options: PERMISSION_OPTIONS,
          ...meta,
        });
        const crossMove = await agent.requestPermission({
          toolCall: {
            toolCallId: 'fa-move',
            kind: 'move',
            rawInput: { from: join(workDir, 'a.ts'), to: join(outsideDir, 'b.ts') },
          },
          options: PERMISSION_OPTIONS,
          ...meta,
        });

        expect([outsideEdit, envEdit, libDelete, crossMove]).toEqual([
          { outcome: { outcome: 'selected', optionId: 'yes' } },
          { outcome: { outcome: 'selected', optionId: 'yes' } },
          { outcome: { outcome: 'selected', optionId: 'yes' } },
          { outcome: { outcome: 'selected', optionId: 'yes' } },
        ]);
        expect(asked).toHaveLength(0);

        agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
        await session.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never auto-approves routine policy writes when writableDirs is revoked during a second async directory recheck', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-write-race-'));
    try {
      const workDir = join(root, 'workspace');
      const writableDir = join(root, 'writable');
      const extraWritableDir = join(root, 'writable-2');
      mkdirSync(workDir, { recursive: true });
      mkdirSync(writableDir, { recursive: true });
      mkdirSync(extraWritableDir, { recursive: true });
      const targetFile = join(writableDir, 'race.ts');
      writeFileSync(targetFile, 'initial\n');

      const agent = createFakeAgent({ handlers: { initialize: gateInit } });
      const { session } = await open(agent, {
        cwd: workDir,
        permissionMode: 'ask',
        writableDirs: [writableDir],
      });
      const asked: InteractionRequest[] = [];
      session.setInteractionResolver(async (request) => {
        asked.push(request);
        return { kind: 'permission', behavior: 'deny' };
      });

      await session.send(
        { type: 'user', content: 'Edit file under concurrent revoke' },
        { turnPermissionPolicy: routineDesktopPolicy() },
      );
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

      const fsPromises = (await import('node:fs')).promises;
      const realRealpath = fsPromises.realpath.bind(fsPromises);
      let targetChecks = 0;
      const realpathSpy = vi.spyOn(fsPromises, 'realpath').mockImplementation(async (p, ...rest) => {
        const resolved = await realRealpath(p, ...rest);
        if (String(p) === targetFile) {
          targetChecks += 1;
          if (targetChecks === 1) {
            // Generation bumps during attempt 1 while writableDir is still granted.
            await session.setWritableDirs([writableDir, extraWritableDir]);
          } else if (targetChecks === 2) {
            // User revokes writableDir while attempt 2 is already in flight with the stale array.
            await session.setWritableDirs([]);
          }
        }
        return resolved;
      });
      try {
        const outcome = await agent.requestPermission({
          toolCall: { toolCallId: 'w-race', kind: 'edit', rawInput: { path: targetFile } },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        });
        expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
        expect(asked).toHaveLength(1);
        expect(targetChecks).toBeGreaterThanOrEqual(2);
      } finally {
        realpathSpy.mockRestore();
      }

      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await session.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 测试价值
// - 生产入口与可观察结果：AcpAgent.startSession({ reviewMode: true, reviewReadPaths }) 与 AcpSession.decidePermission / send；
//   断言缺少 permissionGate 时 fail-closed 关停并抛 AgentStartupStoppedError(NotSupportedError)、剥离全部 MCP/花名册/Skill/说明、
//   每轮强制 scope=all-tool-calls 及不可绕过的只读审查闸。
// - 规则依据：docs/dev-rules/protocol-compatibility/plugin-harnesses.md「只读 /review 沙盒」与 claude-code/pi 的 reviewMode 不变量。
// - 现有覆盖缺口：此前 AcpAgent 在握手前硬拒绝所有 reviewMode，无只读审查沙盒与 fail-closed 覆盖。
// - 最小失败输入与 tier：unit；无 permissionGate 的对端、bypassPermissions 下的写/命令/联网/凭据/越界读/逃逸 glob 与越界附件。
describe('AcpAgent and AcpSession read-only /review sandbox', () => {
  const gateInit = () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: {} },
    _meta: { permissionGate: { supported: true } },
  });
  const requestMeta = (agent: ReturnType<typeof createFakeAgent>, index: number) => {
    const { turnId } = asRecord(asRecord(agent.prompts[index]!.params._meta).permissionGate);
    return { _meta: { permissionGate: { turnId, routine: true } } };
  };

  it('fails closed and closes the endpoint when the ACP agent does not advertise permissionGate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-review-nogate-'));
    try {
      const workDir = join(root, 'repo');
      mkdirSync(workDir, { recursive: true });
      const agent = createFakeAgent();
      const closeSpy = vi.spyOn(agent.transport, 'close');
      const prepareBridge = vi.fn();
      const engine = new AcpAgent({
        auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
        runtimeConfig: {},
        binaryPath: '',
        logger: silentLogger,
        mcpProviders: [],
        preparePiExtraSpawnConfig: prepareBridge,
        clientInfo: { name: 'cindy-test', version: '0.0.0' },
        endpoints: { connect: async () => agent.transport },
      });

      let caught: unknown;
      try {
        await engine.startSession({
          workingDir: workDir,
          model: '',
          providerId: 'acp-plugin:dsh:dsh',
          reviewMode: true,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AgentStartupStoppedError);
      const cause = (caught as AgentStartupStoppedError).cause;
      expect(cause).toBeInstanceOf(NotSupportedError);
      expect((cause as NotSupportedError).capability).toBe('reviewMode');
      expect((cause as NotSupportedError).status).toMatchObject({ supported: false, reason: 'sdk-missing' });
      expect(closeSpy).toHaveBeenCalled();
      expect(prepareBridge).not.toHaveBeenCalled();
      expect(agent.methods()).toEqual(['initialize']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips all MCP/context/skills, forces permissionGate every turn, and enforces an unbypassable read-only sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-review-sandbox-'));
    try {
      const workDir = join(root, 'repo');
      const extraRepo = join(root, 'extra-repo');
      const artifactDir = join(root, 'artifacts');
      const outsideDir = join(root, 'outside');
      mkdirSync(join(workDir, 'src'), { recursive: true });
      mkdirSync(join(workDir, '.git'), { recursive: true });
      mkdirSync(extraRepo, { recursive: true });
      mkdirSync(artifactDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const srcFile = join(workDir, 'src', 'index.ts');
      const envFile = join(workDir, '.env');
      const privateKeyFile = join(workDir, 'private.key');
      const gitConfig = join(workDir, '.git', 'config');
      const extraRepoFile = join(extraRepo, 'lib.ts');
      const allowedArtifact = join(artifactDir, 'report.md');
      const siblingArtifact = join(artifactDir, 'other.md');
      const outsideFile = join(outsideDir, 'secret.txt');
      writeFileSync(srcFile, 'export const ok = true;\n');
      writeFileSync(envFile, 'FIXTURE_ENV_VAR=placeholder\n');
      writeFileSync(privateKeyFile, 'synthetic-key-fixture-not-a-real-key\n');
      writeFileSync(gitConfig, '[core]\n');
      writeFileSync(extraRepoFile, 'export const lib = 1;\n');
      writeFileSync(allowedArtifact, '# report\n');
      writeFileSync(siblingArtifact, '# sibling\n');
      writeFileSync(outsideFile, 'top-secret\n');

      const symlinkInRepo = join(workDir, 'src', 'leak.txt');
      let symlinksReady = true;
      try {
        symlinkSync(outsideFile, symlinkInRepo);
      } catch {
        symlinksReady = false;
      }

      const agent = createFakeAgent({ handlers: { initialize: gateInit } });
      const prepareBridge = vi.fn();
      const readRoster = vi.fn(() => '<ghost-roster>should-not-appear</ghost-roster>');
      const listSkills = vi.fn(async () => [{ name: 'pr', path: join(workDir, 'SKILL.md') }]);
      const engine = new AcpAgent({
        auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
        runtimeConfig: {},
        binaryPath: '',
        logger: silentLogger,
        mcpProviders: [],
        preparePiExtraSpawnConfig: prepareBridge,
        getGhostRosterPrompt: readRoster,
        listSessionSkills: listSkills,
        clientInfo: { name: 'cindy-test', version: '0.0.0' },
        endpoints: { connect: async () => agent.transport },
      });

      const handle = await engine.startSession({
        workingDir: workDir,
        model: '',
        providerId: 'acp-plugin:dsh:dsh',
        permissionMode: 'bypassPermissions',
        reviewMode: true,
        reviewReadPaths: [extraRepo, allowedArtifact],
        extraDirs: [outsideDir],
        writableDirs: [outsideDir],
        pluginEngineBriefing: 'Worker briefing should be stripped',
        botRuntimeProfile: { botId: 'b1', mode: 'project', mcpPolicy: { allow: [] } } as never,
        botProfilePrompt: 'Bot prompt should be stripped',
        makerMemoryEnabled: true,
        makerMemoryIndexSnapshot: 'Memory should be stripped',
      });

      expect(prepareBridge).not.toHaveBeenCalled();
      expect(readRoster).not.toHaveBeenCalled();
      expect(listSkills).not.toHaveBeenCalled();
      const sessionNewCall = agent.sent.find((req) => req.method === 'session/new');
      expect(asRecord(sessionNewCall?.params).mcpServers).toEqual([]);

      // Even attempting to elevate permission mode or directories mid-session stays a no-op.
      await handle.setPermissionMode?.('bypassPermissions');
      await handle.setWritableDirs?.([outsideDir]);
      await handle.setExtraDirs?.([outsideDir]);

      // Direct attachments outside reviewReadPaths or sensitive paths are refused before send.
      await expect(handle.send({
        type: 'user',
        content: [{ type: 'text', text: 'check' }, { type: 'file', path: outsideFile }],
      })).rejects.toThrow();
      await expect(handle.send({
        type: 'user',
        content: [{ type: 'text', text: 'check' }, { type: 'file', path: envFile }],
      })).rejects.toThrow();

      const asked: InteractionRequest[] = [];
      handle.setInteractionResolver(async (request) => {
        asked.push(request);
        return { kind: 'permission', behavior: 'allow' };
      });

      await handle.send({
        type: 'user',
        content: [{ type: 'text', text: 'Review changes' }, { type: 'file', path: allowedArtifact }],
      });
      await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
      expect(agent.prompts[0]!.params._meta).toEqual({
        permissionGate: { turnId: expect.any(String), scope: 'all-tool-calls' },
      });
      // Prompt has no stripped briefing/roster/skills/memory/dir notes.
      const promptBlocks = agent.prompts[0]!.params.prompt as Array<{ type: string; text?: string }>;
      expect(promptBlocks[0]).toEqual({ type: 'text', text: 'Review changes' });

      // Allowed reads and single-file searches within cwd + reviewReadPaths.
      const allowedCalls = await Promise.all([
        agent.requestPermission({
          toolCall: { toolCallId: 'r-cwd', kind: 'read', rawInput: { file_path: 'src/index.ts' } },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        }),
        agent.requestPermission({
          toolCall: { toolCallId: 'r-extra', kind: 'read', locations: [{ path: extraRepoFile }] },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        }),
        agent.requestPermission({
          toolCall: { toolCallId: 'r-exact', kind: 'read', rawInput: { path: allowedArtifact } },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        }),
        agent.requestPermission({
          toolCall: { toolCallId: 's-grep-file', kind: 'search', name: 'Grep', rawInput: { pattern: 'export const', path: 'src/index.ts' } },
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        }),
      ]);
      expect(allowedCalls).toEqual(Array(4).fill({ outcome: { outcome: 'selected', optionId: 'yes' } }));

      // Denied calls: writes, deletes, moves, execute, fetch, unknown, outside reads, sibling of exact file,
      // credentials, directory-wide searches/reads (which cannot filter private.key/.env/symlinks in external harnesses), and escaping globs.
      const deniedToolCalls: AcpRecord[] = [
        { toolCallId: 'd-edit', kind: 'edit', rawInput: { path: srcFile } },
        { toolCallId: 'd-del', kind: 'delete', rawInput: { path: srcFile } },
        { toolCallId: 'd-move', kind: 'move', rawInput: { from: srcFile, to: join(workDir, 'src', 'b.ts') } },
        { toolCallId: 'd-exec', kind: 'execute', rawInput: { command: 'ls' } },
        { toolCallId: 'd-fetch', kind: 'fetch', rawInput: { url: 'https://example.com' } },
        { toolCallId: 'd-other', kind: 'other', rawInput: { path: srcFile } },
        { toolCallId: 'd-nopath', kind: 'read', rawInput: {} },
        { toolCallId: 'd-read-dir', kind: 'read', rawInput: { path: workDir } },
        { toolCallId: 'd-outside', kind: 'read', rawInput: { path: outsideFile } },
        { toolCallId: 'd-sibling', kind: 'read', rawInput: { path: siblingArtifact } },
        { toolCallId: 'd-env', kind: 'read', rawInput: { path: envFile } },
        { toolCallId: 'd-key', kind: 'read', rawInput: { path: privateKeyFile } },
        { toolCallId: 'd-git', kind: 'read', rawInput: { path: gitConfig } },
        { toolCallId: 'd-grep-root', kind: 'search', name: 'Grep', rawInput: { path: '.', pattern: 'synthetic-key-fixture' } },
        { toolCallId: 'd-grep-dir', kind: 'search', name: 'Grep', rawInput: { pattern: 'export const', path: 'src', glob: '*.ts' } },
        { toolCallId: 'd-grep-nopath', kind: 'search', name: 'Grep', rawInput: { pattern: 'synthetic-key-fixture' } },
        { toolCallId: 'd-glob-dir', kind: 'search', name: 'Glob', rawInput: { pattern: 'src/**/*.ts' } },
        { toolCallId: 'd-grep-key', kind: 'search', name: 'Grep', rawInput: { path: privateKeyFile, pattern: 'synthetic-key-fixture' } },
        { toolCallId: 'd-glob-escape', kind: 'search', name: 'Glob', rawInput: { pattern: '../outside/*' } },
        { toolCallId: 'd-grep-env', kind: 'search', name: 'Grep', rawInput: { pattern: 'FIXTURE_ENV_VAR', glob: '**/.env*' } },
        ...(symlinksReady ? [{ toolCallId: 'd-sym', kind: 'read', rawInput: { path: symlinkInRepo } }] : []),
      ];
      for (const toolCall of deniedToolCalls) {
        const outcome = await agent.requestPermission({
          toolCall,
          options: PERMISSION_OPTIONS,
          ...requestMeta(agent, 0),
        });
        expect(outcome, String(toolCall.toolCallId)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
      }
      // Review gate never escalates to interactive resolver (even if resolver would approve).
      expect(asked).toHaveLength(0);

      agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
      await handle.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AcpSession turnChangeCapture', () => {
  it('awaits beforeKnownFileWrite before allowing permission-gated edit/move and skips rejected calls', async () => {
    const order: string[] = [];
    const beforeKnownFileWrite = vi.fn(async (params: { sessionId: string; provider: string; cwd: string; targetPath: string }) => {
      order.push(`capture:${params.targetPath}`);
    });
    const recordKnownFilePreimage = vi.fn(async () => {});
    const noteOpaqueWrite = vi.fn();

    const agent = createFakeAgent();
    const { session, ended } = await open(agent, {
      captureSessionId: 'biz-session-1',
      turnChangeCapture: { beforeKnownFileWrite, recordKnownFilePreimage, noteOpaqueWrite },
    });
    const decisions: InteractionDecision[] = [
      { kind: 'permission', behavior: 'allow' },
      { kind: 'permission', behavior: 'deny' },
    ];
    session.setInteractionResolver(async () => decisions.shift()!);

    await session.send({ type: 'user', content: 'edit files' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    // Allow edit with locations + rawInput old_path/new_path: capture must finish before allow_once reply.
    const editReply = await agent.requestPermission({
      toolCall: {
        toolCallId: 'tc-move',
        title: 'Move file',
        kind: 'move',
        locations: [{ path: 'src/a.ts' }],
        rawInput: { old_path: 'src/a.ts', new_path: 'src/b.ts' },
      },
      options: PERMISSION_OPTIONS,
    });
    order.push(`reply:${(editReply.outcome as { optionId?: string }).optionId}`);
    expect(editReply).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(order).toEqual(['capture:src/a.ts', 'capture:src/b.ts', 'reply:yes']);
    expect(beforeKnownFileWrite).toHaveBeenCalledWith({
      sessionId: 'biz-session-1',
      provider: 'acp',
      cwd: '/work/project',
      targetPath: 'src/a.ts',
    });

    // Reject delete: must NOT trigger capture or opaque marking.
    const deleteReply = await agent.requestPermission({
      toolCall: {
        toolCallId: 'tc-del',
        title: 'Delete file',
        kind: 'delete',
        rawInput: { file_path: 'src/secret.ts' },
      },
      options: PERMISSION_OPTIONS,
    });
    expect(deleteReply).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(beforeKnownFileWrite).toHaveBeenCalledTimes(2);
    expect(noteOpaqueWrite).not.toHaveBeenCalled();

    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await session.close();
    await ended;
  });

  it('records structured diff preimages under bypassPermissions and defers opaque marking until tool settles', async () => {
    const beforeKnownFileWrite = vi.fn(async () => {});
    const recordKnownFilePreimage = vi.fn(async () => {});
    const noteOpaqueWrite = vi.fn();

    const agent = createFakeAgent();
    const { session, ended } = await open(agent, {
      permissionMode: 'bypassPermissions',
      captureSessionId: 'biz-session-2',
      turnChangeCapture: { beforeKnownFileWrite, recordKnownFilePreimage, noteOpaqueWrite },
    });

    session.send({ type: 'user', content: 'apply edits' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    // Edit starts without path or diff yet — must NOT prematurely poison turn as opaque.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-diff',
      title: 'Edit',
      kind: 'edit',
      status: 'in_progress',
    });
    expect(noteOpaqueWrite).not.toHaveBeenCalled();

    // Update delivers structured diffs (modify + create) — must record preimages and stay non-opaque.
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-diff',
      status: 'completed',
      content: [
        { type: 'diff', path: 'src/app.ts', oldText: 'const a = 1;\n', newText: 'const a = 2;\n' },
        { type: 'diff', path: 'src/new.ts', oldText: null, newText: 'export const x = 1;\n' },
      ],
    });
    expect(recordKnownFilePreimage).toHaveBeenCalledWith({
      sessionId: 'biz-session-2',
      provider: 'acp',
      cwd: '/work/project',
      targetPath: 'src/app.ts',
      beforeExists: true,
      beforeText: 'const a = 1;\n',
    });
    expect(recordKnownFilePreimage).toHaveBeenCalledWith({
      sessionId: 'biz-session-2',
      provider: 'acp',
      cwd: '/work/project',
      targetPath: 'src/new.ts',
      beforeExists: false,
      beforeText: '',
    });
    expect(noteOpaqueWrite).not.toHaveBeenCalled();

    // Edit that completes with neither paths nor structured diffs marks opaque.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-blind-edit',
      title: 'Mystery Edit',
      kind: 'edit',
      status: 'completed',
    });
    expect(noteOpaqueWrite).toHaveBeenCalledTimes(1);
    expect(noteOpaqueWrite).toHaveBeenLastCalledWith({
      sessionId: 'biz-session-2',
      provider: 'acp',
      cwd: '/work/project',
    });

    // Under bypassPermissions, a path-only notification without structured diff must NOT treat
    // an un-paused disk read as a reliable baseline and must mark opaque when settled.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-late-path',
      title: 'Bypass Edit',
      kind: 'edit',
      status: 'in_progress',
    });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-late-path',
      status: 'completed',
      locations: [{ path: 'src/late.ts' }],
    });
    expect(beforeKnownFileWrite).not.toHaveBeenCalled();
    expect(noteOpaqueWrite).toHaveBeenCalledTimes(2);

    // Shell execute immediately marks opaque.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-exec',
      title: 'Run shell',
      kind: 'execute',
      status: 'in_progress',
    });
    expect(noteOpaqueWrite).toHaveBeenCalledTimes(3);

    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await session.close();
    await ended;
  });

  // Review (#13294, Greptile P1): when tool_call arrives before session/request_permission,
  // approval must await any in-flight capture (and capture paths not yet read) before replying
  // allow_once; a pathless permission followed later by path-only updates must remain opaque.
  it('awaits in-flight pre-notification captures before permission approval and keeps pathless-then-late-path writes opaque', async () => {
    const order: string[] = [];
    let releaseDiffCapture!: () => void;
    const diffCaptured = new Promise<void>((resolve) => { releaseDiffCapture = resolve; });
    const beforeKnownFileWrite = vi.fn(async (params: { targetPath: string }) => {
      order.push(`before:${params.targetPath}`);
    });
    const recordKnownFilePreimage = vi.fn(async (params: { targetPath: string }) => {
      order.push(`diff-start:${params.targetPath}`);
      await diffCaptured;
      order.push(`diff-done:${params.targetPath}`);
    });
    const noteOpaqueWrite = vi.fn();

    const agent = createFakeAgent();
    const { session, ended } = await open(agent, {
      captureSessionId: 'biz-session-3',
      turnChangeCapture: { beforeKnownFileWrite, recordKnownFilePreimage, noteOpaqueWrite },
    });
    session.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));

    await session.send({ type: 'user', content: 'edit carefully' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    // 1. Agent announces tool_call with a structured diff first, then immediately requests permission
    // while recordKnownFilePreimage is still in flight. Approval must wait for it before allow_once.
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-race',
      title: 'Edit raced',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'src/raced.ts' }],
      content: [{ type: 'diff', path: 'src/raced.ts', oldText: 'v1\n', newText: 'v2\n' }],
    });
    let replied = false;
    const permPromise = agent.requestPermission({
      toolCall: {
        toolCallId: 'tc-race',
        title: 'Edit raced',
        kind: 'edit',
        locations: [{ path: 'src/raced.ts' }],
      },
      options: PERMISSION_OPTIONS,
    }).then((res) => {
      replied = true;
      order.push(`reply:${(res.outcome as { optionId?: string }).optionId}`);
      return res;
    });
    await vi.waitFor(() => expect(order).toEqual(['diff-start:src/raced.ts']));
    await new Promise((r) => setTimeout(r, 10));
    expect(replied).toBe(false);
    releaseDiffCapture();
    await permPromise;
    expect(order).toEqual(['diff-start:src/raced.ts', 'diff-done:src/raced.ts', 'reply:yes']);
    expect(beforeKnownFileWrite).not.toHaveBeenCalled();
    expect(noteOpaqueWrite).not.toHaveBeenCalled();

    // 2. Agent requests permission WITHOUT paths, receives allow_once, and only later reports
    // a path in tool_call_update without a structured diff — must stay opaque and NOT read disk.
    const pathlessReply = await agent.requestPermission({
      toolCall: {
        toolCallId: 'tc-pathless',
        title: 'Opaque Edit',
        kind: 'edit',
      },
      options: PERMISSION_OPTIONS,
    });
    expect(pathlessReply).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-pathless',
      status: 'completed',
      locations: [{ path: 'src/after-the-fact.ts' }],
    });
    expect(beforeKnownFileWrite).not.toHaveBeenCalled();
    expect(noteOpaqueWrite).toHaveBeenCalledTimes(1);

    // 3. Agent announces a pending edit with path BEFORE requesting permission; user denies.
    // Must not read disk and must not mark opaque.
    session.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'deny' }));
    agent.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-denied-after-update',
      title: 'Denied Edit',
      kind: 'edit',
      status: 'pending',
      rawInput: { file_path: 'src/untouched.ts' },
    });
    const deniedReply = await agent.requestPermission({
      toolCall: {
        toolCallId: 'tc-denied-after-update',
        title: 'Denied Edit',
        kind: 'edit',
        rawInput: { file_path: 'src/untouched.ts' },
      },
      options: PERMISSION_OPTIONS,
    });
    expect(deniedReply).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    agent.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-denied-after-update',
      status: 'failed',
    });
    expect(beforeKnownFileWrite).not.toHaveBeenCalled();
    expect(noteOpaqueWrite).toHaveBeenCalledTimes(1);

    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await session.close();
    await ended;
  });
});

describe('AcpSession form elicitation, plans, additionalDirectories, planMode and context usage', () => {
  // Rule: ACP `elicitation/create` (form mode) maps into Cindy's `ask_user_question` interaction card,
  // collapsing companion `*_other` write-in fields into the single question's custom-answer slot.
  // Minimal failing input: Antigravity-shaped `q1` (oneOf) + `q1_other` and `q2` (array/anyOf) + `q2_other`.
  // Tier: unit.
  it('translates ACP form elicitation (single, multi-select, write-in) into ask_user_question cards', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);
    const seen: InteractionRequest[] = [];
    session.setInteractionResolver(async (request) => {
      seen.push(request);
      return {
        kind: 'ask_user_question',
        answers: {
          q1: 'Option B',
          q2: JSON.stringify(['Choice 1', 'Extra custom note']),
        },
      };
    });
    await session.send({ type: 'user', content: 'redesign' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    const reply = await agent.requestElicitation({
      toolCallId: 'call_ask_1',
      mode: 'form',
      message: 'The agent has 2 questions.',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'string',
            title: 'Which scope?',
            oneOf: [
              { const: '1', title: '(Recommended) Option A' },
              { const: '2', title: 'Option B' },
            ],
          },
          q1_other: {
            type: 'string',
            title: 'Other',
            description: 'Optional free-form answer to: Which scope?',
          },
          q2: {
            type: 'array',
            title: 'Which extras?',
            items: {
              anyOf: [
                { const: '1', title: 'Choice 1' },
                { const: '2', title: 'Choice 2' },
              ],
            },
          },
          q2_other: {
            type: 'string',
            title: 'Other',
            description: 'Optional free-form answer to: Which extras?',
          },
        },
      },
    });

    expect(seen).toEqual([
      {
        kind: 'ask_user_question',
        requestId: 'acp-elicitation-1',
        toolUseId: 'call_ask_1',
        questions: [
          {
            id: 'q1',
            question: 'Which scope?',
            options: [{ label: '(Recommended) Option A' }, { label: 'Option B' }],
            multiSelect: false,
          },
          {
            id: 'q2',
            question: 'Which extras?',
            options: [{ label: 'Choice 1' }, { label: 'Choice 2' }],
            multiSelect: true,
          },
        ],
      },
    ]);
    expect(reply.result).toEqual({
      action: 'accept',
      content: {
        q1: '2',
        q2: ['1'],
        q2_other: 'Extra custom note',
      },
    });

    // Single-select custom write-in routes to `q1_other`, skip returns `decline`, and abort returns `cancel`.
    session.setInteractionResolver(async () => ({
      kind: 'ask_user_question',
      answers: { q1: 'My custom scope' },
    }));
    const writeInReply = await agent.requestElicitation({
      mode: 'form',
      message: 'The agent has 1 question.',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'string',
            title: 'Which scope?',
            oneOf: [{ const: '1', title: 'Option A' }],
          },
          q1_other: { type: 'string', title: 'Other' },
        },
      },
    });
    expect(writeInReply.result).toEqual({
      action: 'accept',
      content: { q1_other: 'My custom scope' },
    });

    session.setInteractionResolver(async () => ({ kind: 'ask_user_question', answers: {} }));
    const skipped = await agent.requestElicitation({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { note: { type: 'string', title: 'Any note?' } },
      },
    });
    expect(skipped.result).toEqual({ action: 'decline' });

    // Unsupported mode (`url`) or password fields are rejected with JSON-RPC -32602 so the agent can fall back.
    const urlReply = await agent.requestElicitation({
      mode: 'url',
      url: 'https://example.test/auth',
      message: 'Sign in',
    });
    expect(urlReply.error).toMatchObject({ code: -32602 });

    const secretReply = await agent.requestElicitation({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { token: { type: 'string', format: 'password', title: 'API key' } },
      },
    });
    expect(secretReply.error).toMatchObject({ code: -32602 });

    // Aborting while a question card is open cancels the elicitation immediately.
    const hanging = deferred<InteractionDecision>();
    let aborted = false;
    session.setInteractionResolver((_req, signal) => {
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return hanging.promise;
    });
    const pendingElicitation = agent.requestElicitation({
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Proceed?' } },
      },
    });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    await session.abort();
    expect(await pendingElicitation).toMatchObject({ result: { action: 'cancel' } });
    expect(aborted).toBe(true);
    agent.prompts[0]!.settle.resolve({ stopReason: 'cancelled' });
    await session.close();
  });

  // Rule: ACP `plan` and `plan_update` notifications emit Cindy's standard `update_plan` snapshot tool_use
  // so PinnedPlanPanel and inline plan cards render on desktop and mobile.
  // Minimal failing input: `session/update` with `sessionUpdate: 'plan'` or `'plan_update'`.
  // Tier: unit.
  it('translates ACP plan and plan_update notifications into update_plan snapshot events', async () => {
    const agent = createFakeAgent();
    const { session, events } = await open(agent);
    await session.send({ type: 'user', content: 'work' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));

    agent.update({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect codebase', priority: 'high', status: 'completed' },
        { content: 'Implement fix', priority: 'high', status: 'in_progress' },
        { content: 'Run tests', priority: 'medium', status: 'pending' },
      ],
    });
    agent.update({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        planId: 'custom-plan',
        entries: [
          { content: 'Step 1', priority: 'high', status: 'completed' },
          { content: 'Step 2', priority: 'medium', status: 'cancelled' },
        ],
      },
    });
    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'done')).toBe(true));

    const planEvents = events.filter((e) => e.type === 'tool_use' && (e.data as AcpRecord).toolName === 'update_plan');
    expect(planEvents).toEqual([
      {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:acp-sess-1-plan-1',
          toolName: 'update_plan',
          runtimeActivity: 'snapshot',
          input: {
            plan: [
              { step: 'Inspect codebase', status: 'completed' },
              { step: 'Implement fix', status: 'in_progress' },
              { step: 'Run tests', status: 'pending' },
            ],
          },
        },
      },
      {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:custom-plan',
          toolName: 'update_plan',
          runtimeActivity: 'snapshot',
          input: {
            plan: [
              { step: 'Step 1', status: 'completed' },
              { step: 'Step 2', status: 'completed' },
            ],
          },
        },
      },
    ]);
    await session.close();
  });

  // Rule: ACP agents advertising `sessionCapabilities.additionalDirectories`, `plan` mode, and `usage_update`
  // expose Cindy `extraDirs`, `planMode`, and `getContextUsage` dynamically.
  // Minimal failing input: initialize with `additionalDirectories: {}`, `mode` option containing `plan`, and `usage_update`.
  // Tier: unit.
  it('supports additionalDirectories, planMode toggle, and getContextUsage when negotiated', async () => {
    const configOptions = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
    ];
    let currentMode = 'default';
    const agent = createFakeAgent({
      agentCapabilities: { sessionCapabilities: { additionalDirectories: {}, resume: {} } },
      configOptions,
      handlers: {
        'session/set_config_option': (params) => {
          if (params.configId === 'mode' && typeof params.value === 'string') currentMode = params.value;
          return {
            configOptions: configOptions.map((opt) => opt.id === 'mode' ? { ...opt, currentValue: currentMode } : opt),
          };
        },
      },
    });
    const { session } = await open(agent, { extraDirs: ['/extra/a', '/extra/b', '/extra/a'] });

    const sessionNew = agent.sent.find((m) => m.method === 'session/new');
    expect((sessionNew?.params as AcpRecord).additionalDirectories).toEqual(['/extra/a', '/extra/b']);
    expect(session.capabilities.extraDirs.supported).toBe(true);
    expect(session.requiresRuntimeRecycleForExtraDirs()).toBe(true);
    expect(session.capabilities.planMode?.supported).toBe(true);
    expect(session.getPlanMode()).toBe(false);

    await session.setPlanMode(true);
    expect(session.getPlanMode()).toBe(true);
    await session.setPlanMode(false);
    expect(session.getPlanMode()).toBe(false);

    await session.setExtraDirs(['/extra/c']);

    // An engine that does not negotiate native `additionalDirectories` never asks the host to recycle on extraDirs changes.
    const noAdditionalDirsAgent = createFakeAgent({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    });
    const { session: noAdditionalDirsSession } = await open(noAdditionalDirsAgent);
    expect(noAdditionalDirsSession.requiresRuntimeRecycleForExtraDirs()).toBe(false);
    await noAdditionalDirsSession.close();

    // An engine advertising additionalDirectories without session/resume or session/load rejects live dir changes.
    const nonResumable = createFakeAgent({
      agentCapabilities: { loadSession: false, sessionCapabilities: { additionalDirectories: {} } },
    });
    const { session: unresumableSession } = await open(nonResumable, { extraDirs: ['/extra/a'] });
    await expect(unresumableSession.setExtraDirs(['/extra/a'])).resolves.toBeUndefined();
    await expect(unresumableSession.setExtraDirs(['/extra/b'])).rejects.toThrow();
    await unresumableSession.close();

    // Context usage is unavailable before the agent reports a context window, then reflects `usage_update` + turn usage.
    await expect(session.getContextUsage()).rejects.toThrow();
    await session.send({ type: 'user', content: 'hi' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    agent.update({ sessionUpdate: 'usage_update', used: 25_000, size: 200_000 });
    agent.prompts[0]!.settle.resolve({
      stopReason: 'end_turn',
      usage: { inputTokens: 1_000, outputTokens: 200, cachedReadTokens: 500, cachedWriteTokens: 0, totalTokens: 1_700 },
    });
    await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
    expect(session.getUsageSnapshot().contextWindow).toBe(200_000);

    expect(await session.getContextUsage()).toMatchObject({
      totalTokens: 25_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 12.5,
      model: 'gemini-4-neon',
      apiUsage: {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 500,
      },
    });
    await session.close();
  });

  it('mutates live vendorOptions in-place and queues role briefing on setVendorOptions', async () => {
    const agent = createFakeAgent();
    const capturedContexts: Array<Record<string, unknown>> = [];
    const engine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {},
      binaryPath: '',
      logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      endpoints: { connect: async () => agent.transport },
      preparePiExtraSpawnConfig: async (_providers, ctx) => {
        capturedContexts.push(ctx as unknown as Record<string, unknown>);
        return null;
      },
    });
    const session = await engine.startSession({
      workingDir: '/w',
      model: '',
      providerId: 'acp-plugin:dsh-acp:dsh',
      pluginEngineTrustedCaller: true,
    });
    const vendorOptions = capturedContexts[0]?.vendorOptions as Record<string, unknown>;
    expect(vendorOptions).toEqual({});

    await session.setVendorOptions!({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-1',
      pluginEngineRoleBriefing: 'You are now the Orca Lead.',
    });
    expect(vendorOptions).toEqual({
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-1',
    });

    await session.send({ type: 'user', content: 'delegate this task' });
    await vi.waitFor(() => expect(agent.prompts).toHaveLength(1));
    const blocks = agent.prompts[0]!.params.prompt as Array<{ type: string; text: string }>;
    expect(blocks.map((b) => b.text).join('\n')).toContain('You are now the Orca Lead.');
    expect(blocks.map((b) => b.text).join('\n')).toContain('delegate this task');

    agent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(session.isTurnRunning?.()).toBe(false));

    await session.setVendorOptions!({ orcaRole: null, orcaWorkflowId: null, orcaLeadSessionId: null });
    expect(vendorOptions).toEqual({});
    await session.close();
  });

  it('enforces elicitation schema invariants: required choices, multi-select custom text, and minItems/maxItems', async () => {
    const agent = createFakeAgent();
    const { session } = await open(agent);

    // 1. Required choice paired with optional *_other is NOT folded so the required choice can never go missing.
    session.setInteractionResolver(async (request) => {
      if (request.kind !== 'ask_user_question') throw new Error('unexpected');
      expect(request.questions).toHaveLength(2);
      expect(request.questions[0]?.id).toBe('q1');
      expect(request.questions[1]?.id).toBe('q1_other');
      // Attempting custom-only answer for required q1 declines instead of omitting q1.
      return { kind: 'ask_user_question', answers: { q1: 'not-a-choice', q1_other: 'extra note' } };
    });
    expect((await agent.requestElicitation({
      mode: 'form',
      message: 'Pick one',
      requestedSchema: {
        type: 'object',
        required: ['q1'],
        properties: {
          q1: { type: 'string', title: 'Choice', oneOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] },
          q1_other: { type: 'string', title: 'Other' },
        },
      },
    })).result).toEqual({ action: 'decline' });

    // 2. Multi-select without a companion write-in key rejects mixed listed + custom text instead of dropping custom text.
    session.setInteractionResolver(async () => ({
      kind: 'ask_user_question',
      answers: { tags: JSON.stringify(['Alpha', 'unlisted custom text']) },
    }));
    expect((await agent.requestElicitation({
      mode: 'form',
      message: 'Pick tags',
      requestedSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            title: 'Tags',
            minItems: 1,
            maxItems: 2,
            items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }, { const: 'c', title: 'Gamma' }] },
          },
        },
      },
    })).result).toEqual({ action: 'decline' });

    // 3. Multi-select enforces maxItems / minItems bounds.
    session.setInteractionResolver(async () => ({
      kind: 'ask_user_question',
      answers: { tags: JSON.stringify(['Alpha', 'Beta', 'Gamma']) },
    }));
    expect((await agent.requestElicitation({
      mode: 'form',
      message: 'Pick at most two',
      requestedSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            title: 'Tags',
            minItems: 1,
            maxItems: 2,
            items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }, { const: 'c', title: 'Gamma' }] },
          },
        },
      },
    })).result).toEqual({ action: 'decline' });

    session.setInteractionResolver(async () => ({
      kind: 'ask_user_question',
      answers: { tags: JSON.stringify(['Alpha', 'Beta']) },
    }));
    expect((await agent.requestElicitation({
      mode: 'form',
      message: 'Pick at most two',
      requestedSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            title: 'Tags',
            minItems: 1,
            maxItems: 2,
            items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }, { const: 'c', title: 'Gamma' }] },
          },
        },
      },
    })).result).toEqual({ action: 'accept', content: { tags: ['a', 'b'] } });

    // 4. Impossible minItems > maxItems schema is rejected with -32602.
    expect((await agent.requestElicitation({
      mode: 'form',
      message: 'Invalid bounds',
      requestedSchema: {
        type: 'object',
        properties: {
          tags: { type: 'array', minItems: 3, maxItems: 1, items: { enum: ['a', 'b'] } },
        },
      },
    })).error).toMatchObject({ code: -32602 });

    await session.close();
  });

  // 测试价值
  // - 生产入口与可观察结果：AcpAgent.startSession 在普通本地与设备托管 ACP 会话的首轮 briefing 中按 loadMemoryContext 契约注入 Maker Memory（含 /command 脱敏与 cindy_memory MCP 门控），恢复会话不重复注入。
  // - Bug／规则依据：修复 ACP 普通任务忽略 makerMemory 导致用户持久化偏好（如 PR 跟进规则）在插件引擎上不生效的线上回归；对齐 built-in 引擎 loadMemoryContext 契约。
  // - 现有覆盖缺口：此前 acp-session.test.ts 仅覆盖 botRuntimeProfile 伙伴会话的 makerMemoryIndexSnapshot，普通 ACP 会话与设备托管 ACP 会话完全无记忆注入覆盖。
  // - 最小失败输入与 tier：unit，传入 makerMemoryEnabled: true + 内存 fake makerMemory 启动本地/托管/项目目录/恢复 ACP 会话并检查首轮 session/prompt。
  it('injects Maker Memory rules and index into ordinary local, hosted, and project-dir ACP briefings once', async () => {
    const getStore = vi.fn(async (_scopeKey: string) => ({
      getIndex: async () => '# Memory Index\n- user_pr-follow-preferences.md: never merge /pr automatically',
    }));
    const getProjectMemoryDirectory = vi.fn(() => undefined as string | undefined);
    const fakeMemory = { getStore, getProjectMemoryDirectory } as unknown as NonNullable<ConstructorParameters<typeof AcpAgent>[0]['makerMemory']>;

    // 1. Local ACP task with accepted cindy_memory MCP gets both rules and defused index on first prompt only.
    const localAgent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const localEngine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {},
      binaryPath: '',
      logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      makerMemory: fakeMemory,
      endpoints: { connect: async () => localAgent.transport },
      preparePiExtraSpawnConfig: async () => ({
        mcpBridge: { token: 't', servers: [{ name: 'cindy_memory', url: 'http://127.0.0.1:9/mcp/cindy_memory' }] },
      }),
    });
    const localSession = await localEngine.startSession({
      workingDir: '/work/repo',
      model: '',
      providerId: 'acp-plugin:agy:agy',
      makerMemoryEnabled: true,
    });
    await localSession.send({ type: 'user', content: 'check PR status' });
    await vi.waitFor(() => expect(localAgent.prompts).toHaveLength(1));
    const [localBriefing, localUserMsg] = localAgent.prompts[0]!.params.prompt as Array<{ type: string; text: string }>;
    expect(localBriefing!.text).toContain('# Maker Memory');
    expect(localBriefing!.text).toContain('# Memory Index');
    expect(localBriefing!.text).toContain('user_pr-follow-preferences.md: never merge pr automatically');
    expect(localBriefing!.text).not.toContain('merge /pr');
    expect(localUserMsg).toEqual({ type: 'text', text: 'check PR status' });
    localAgent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await localSession.close();

    // 2. When cindy_memory MCP is not accepted, rules referencing MCP tools are omitted while index still reaches the agent.
    const noMcpAgent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: false } } });
    const noMcpEngine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {},
      binaryPath: '',
      logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      makerMemory: fakeMemory,
      endpoints: { connect: async () => noMcpAgent.transport },
      preparePiExtraSpawnConfig: async () => ({
        mcpBridge: { token: 't', servers: [{ name: 'cindy_memory', url: 'http://127.0.0.1:9/mcp/cindy_memory' }] },
      }),
    });
    const noMcpSession = await noMcpEngine.startSession({
      workingDir: '/work/repo',
      model: '',
      providerId: 'acp-plugin:agy:agy',
      makerMemoryEnabled: true,
    });
    await noMcpSession.send({ type: 'user', content: 'hello' });
    await vi.waitFor(() => expect(noMcpAgent.prompts).toHaveLength(1));
    const [noMcpBriefing] = noMcpAgent.prompts[0]!.params.prompt as Array<{ type: string; text: string }>;
    expect(noMcpBriefing!.text).not.toContain('# Maker Memory');
    expect(noMcpBriefing!.text).toContain('user_pr-follow-preferences.md');
    noMcpAgent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await noMcpSession.close();

    // 3. Device-hosted ACP task uses only the caller's snapshot and never touches local makerMemory store.
    getStore.mockClear();
    const hostedAgent = createFakeAgent({ agentCapabilities: { mcpCapabilities: { http: true } } });
    const hostedEngine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {},
      binaryPath: '',
      logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      makerMemory: fakeMemory,
      endpoints: { connect: async () => hostedAgent.transport },
    });
    const hostedSession = await hostedEngine.startSession({
      workingDir: '/remote/repo',
      model: '',
      providerId: 'acp-plugin:agy:agy',
      makerMemoryEnabled: true,
      makerMemoryIndexSnapshot: '# Memory Index\n- remote_pref.md: hosted preference',
      deviceHosted: {
        workingDir: '/remote/repo',
        extraDirs: [],
        writableDirs: [],
        platform: 'darwin',
        shell: 'zsh',
        isGitRepo: true,
        tunnelUrl: 'http://127.0.0.1:4711/',
        tunnelToken: 'tok',
        mcpServers: ['cindy_memory'],
      },
    });
    expect(getStore).not.toHaveBeenCalled();
    await hostedSession.send({ type: 'user', content: 'hi' });
    await vi.waitFor(() => expect(hostedAgent.prompts).toHaveLength(1));
    const [hostedBriefing] = hostedAgent.prompts[0]!.params.prompt as Array<{ type: string; text: string }>;
    expect(hostedBriefing!.text).toContain('# Maker Memory');
    expect(hostedBriefing!.text).toContain('hosted preference');
    hostedAgent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await hostedSession.close();

    // 4. Resumed ACP session does not re-read or re-inject memory briefing.
    getStore.mockClear();
    const resumedAgent = createFakeAgent({
      agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
      handlers: { 'session/resume': () => ({}) },
    });
    const resumedEngine = new AcpAgent({
      auth: { getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
      runtimeConfig: {},
      binaryPath: '',
      logger: silentLogger,
      clientInfo: { name: 'cindy', version: 'test' },
      makerMemory: fakeMemory,
      endpoints: { connect: async () => resumedAgent.transport },
    });
    const resumedSession = await resumedEngine.startSession({
      workingDir: '/work/repo',
      model: '',
      providerId: 'acp-plugin:agy:agy',
      resumeSessionId: 'old-sess',
      makerMemoryEnabled: true,
    });
    expect(getStore).not.toHaveBeenCalled();
    await resumedSession.send({ type: 'user', content: 'continue' });
    await vi.waitFor(() => expect(resumedAgent.prompts).toHaveLength(1));
    expect(resumedAgent.prompts[0]!.params.prompt).toEqual([{ type: 'text', text: 'continue' }]);
    resumedAgent.prompts[0]!.settle.resolve({ stopReason: 'end_turn' });
    await resumedSession.close();
  });
});
