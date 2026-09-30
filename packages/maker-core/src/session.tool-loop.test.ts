import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, MANUAL_ABORT_RECOVERY_GRACE_MS } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import { createPiTranslateContext, translatePiEvent } from './agents/pi/translator.js';
import { newCodexRuntimeState, translateItemNotification } from './agents/codex/translator.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import type { AgentEvent, InteractionDecision } from './types/events.js';
import type { Logger } from './interfaces/logger.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

function setup(agentKind: 'pi' | 'codex', hangAbort = false) {
  vi.useFakeTimers();
  const queue = createAsyncQueue<AgentEvent>();
  let running = false;
  const handle = {
    id: 'native-session', agentKind, model: 'test-model',
    events: () => queue,
    send: vi.fn(async () => { running = true; }),
    abort: vi.fn(async () => {
      if (hangAbort) return new Promise<void>(() => {});
      running = false;
      queue.push({ type: 'done', data: {}, source: agentKind });
    }),
    close: vi.fn(async () => { running = false; queue.end(); }),
    isTurnRunning: () => running,
    setInteractionResolver() {},
  } as unknown as AgentSessionHandle;
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = new Session({ id: 'test-session', agentKind, handle, workDir: '/test', capabilities: {} as never, logger });
  sessions.push(session);
  const seen: AgentEvent[] = [];
  session.onEvent((event) => seen.push(event));
  const tool = async (id: string, extra: Partial<AgentEvent> = {}, name = 'read', input: unknown = { path: 'same.ts' }) => {
    queue.push({ type: 'tool_use', data: { toolUseId: id, toolName: name, input }, source: agentKind, ...extra });
    queue.push({ type: 'tool_result_full', data: { toolUseId: id, fullText: 'same result' }, source: agentKind, ...extra });
    queue.push({ type: 'tool_result', data: { toolUseIds: [id], summary: 'done' }, source: agentKind, ...extra });
    await vi.advanceTimersByTimeAsync(0);
  };
  const errors = () => seen.filter((event) => event.type === 'error');
  return { queue, session, seen, handle, tool, errors, end: async () => {
    running = false;
    queue.push({ type: 'done', data: {}, source: agentKind });
    await vi.advanceTimersByTimeAsync(0);
  } };
}

describe.each(['pi', 'codex'] as const)('%s Session tool loop coverage', (agentKind) => {
  it('does not interpret one parallel batch of distinct contract failures as retries', async () => {
    const t = setup(agentKind);
    await t.session.send('investigate');
    for (let i = 0; i < 5; i++) t.queue.push({ type: 'tool_use', source: agentKind, data: {
      toolUseId: `invalid-${i}`, toolName: 'Edit', input: { old_string: `old-${i}`, new_string: `new-${i}` },
    } });
    for (const i of [2, 0, 4, 1, 3]) t.queue.push({ type: 'tool_result_full', source: agentKind, data: {
      toolUseId: `invalid-${i}`, fullText: 'InputValidationError: Missing required parameter file_path', isError: true,
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
    // Conservative contract handling must not disable unchanged read loops.
    for (let i = 0; i < 4; i++) await t.tool(`read-${i}`);
    expect(t.errors()).toHaveLength(1);
  });

  it('detects exec/MCP calls using translated names', async () => {
    const t = setup(agentKind);
    await t.session.send('investigate');
    for (let i = 0; i < 12; i++) {
      await t.tool(String(i), {}, i % 2 ? 'mcp:search:lookup' : 'exec', { query: 'unchanged' });
    }
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ data: { toolLoop: { kind: 'pingpong', count: 12 } } });
  });

  it('preserves full results, emits one terminal error with origin, and permits a fresh turn', async () => {
    const t = setup(agentKind);
    await t.session.send('investigate', { origin: { kind: 'scheduler', scheduleId: 'schedule-1' } });
    for (let i = 0; i < 3; i++) await t.tool(String(i));
    expect(t.errors()).toHaveLength(0);
    await t.tool('3');
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ source: agentKind, turnOrigin: { kind: 'scheduler', scheduleId: 'schedule-1' }, data: {
      reason: 'tool_use_loop_detected', isTerminal: true, toolLoop: { kind: 'consecutive', count: 4 },
    } });
    const errorIndex = t.seen.indexOf(t.errors()[0]);
    expect(t.seen.slice(0, errorIndex).filter(e => e.type === 'tool_result_full')).toHaveLength(4);
    expect(t.seen.slice(0, errorIndex).filter(e => e.type === 'tool_result')).toHaveLength(4);
    expect(t.seen.slice(errorIndex).filter(e => e.type === 'tool_result')).toHaveLength(0);
    expect(t.handle.abort).toHaveBeenCalledOnce();
    expect(t.session.getObservedCurrentTurnTerminal().kind).toBe('error');
    await t.session.send('try a different approach');
    for (let i = 0; i < 3; i++) await t.tool(`new-${i}`);
    expect(t.errors()).toHaveLength(1);
  });

  it.each([false, true])('waits for the matching summary and discards pending verdict on takeover=%s', async (takeover) => {
    const t = setup(agentKind);
    await t.session.send('first');
    const generation = t.session.getTurnGeneration();
    for (let i = 0; i < 3; i++) await t.tool(String(i));
    t.queue.push({ type: 'tool_use', source: agentKind, data: { toolUseId: 'last', toolName: 'read', input: { path: 'same.ts' } } });
    t.queue.push({ type: 'tool_result_full', source: agentKind, data: { toolUseId: 'last', fullText: 'same result' } });
    t.queue.push({ type: 'tool_result', source: agentKind, data: { toolUseIds: ['unrelated'], summary: 'done' } });
    t.queue.push({ type: 'tool_result', source: agentKind, turnScope: 'background', data: { toolUseIds: ['last'], summary: 'done' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
    if (takeover) {
      await t.end();
      await t.session.send('second');
    }
    t.queue.push({ type: 'tool_result', source: agentKind, sessionTurnGeneration: generation, data: { toolUseIds: ['last'], summary: 'done' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(takeover ? 0 : 1);
    expect(t.handle.abort).toHaveBeenCalledTimes(takeover ? 0 : 1);
    if (takeover) {
      for (let i = 0; i < 4; i++) await t.tool(`new-${i}`);
      expect(t.errors()).toHaveLength(1);
    }
  });

  it('does not count background, old-generation, foreign-instance or duplicate results', async () => {
    const t = setup(agentKind);
    await t.session.send('first');
    const oldGeneration = t.session.getTurnGeneration();
    await t.end();
    await t.session.send('second');
    for (let i = 0; i < 10; i++) {
      await t.tool(`bg-${i}`, { turnScope: 'background' });
      await t.tool(`old-${i}`, { sessionTurnGeneration: oldGeneration });
      await t.tool(`foreign-${i}`, { sessionInstanceId: 'other-instance' });
    }
    await t.tool('current');
    for (let i = 0; i < 10; i++) t.queue.push({ type: 'tool_result_full', data: { toolUseId: 'current', fullText: 'same result' }, source: agentKind });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
  });

  it('keeps polling and changing arguments alive', async () => {
    const t = setup(agentKind);
    await t.session.send('wait and investigate');
    for (let i = 0; i < 140; i++) {
      await t.tool(`poll-${i}`, {}, agentKind === 'codex' ? 'dynamic:functions:write_stdin' : 'write_stdin', { session_id: 12 });
      await t.tool(`read-${i}`, {}, 'read', { path: `file-${i}.ts` });
    }
    expect(t.errors()).toHaveLength(0);
  });

  it('ignores snapshots and pauses detection while waiting for a person', async () => {
    const t = setup(agentKind);
    await t.session.send('investigate');
    for (let i = 0; i < 8; i++) {
      t.queue.push({ type: 'tool_use', source: agentKind, data: {
        toolUseId: `snapshot-${i}`, toolName: 'read', input: {}, runtimeActivity: 'snapshot',
      } });
      t.queue.push({ type: 'tool_result_full', source: agentKind, data: {
        toolUseId: `snapshot-${i}`, fullText: 'same result', runtimeActivity: 'snapshot',
      } });
    }
    let answer!: (decision: InteractionDecision) => void;
    const pending = t.session.runHostInteraction({
      kind: 'permission', requestId: 'approval', toolName: 'read', input: {},
    }, () => new Promise((resolve) => { answer = resolve; }));
    for (let i = 0; i < 8; i++) await t.tool(`waiting-${i}`);
    expect(t.errors()).toHaveLength(0);
    answer({ kind: 'permission', behavior: 'allow' });
    await pending;
    for (let i = 0; i < 4; i++) await t.tool(`resumed-${i}`);
    expect(t.errors()).toHaveLength(1);
  });

  it('uses existing abort recovery when interrupt never settles', async () => {
    const t = setup(agentKind, true);
    await t.session.send('investigate');
    for (let i = 0; i < 4; i++) await t.tool(String(i));
    expect(t.errors()).toHaveLength(1);
    // A paired terminal drains the short error timer but cannot cancel the
    // independent abort confirmation fallback.
    t.queue.push({ type: 'done', data: {}, source: agentKind });
    await vi.advanceTimersByTimeAsync(MANUAL_ABORT_RECOVERY_GRACE_MS + 1);
    expect(t.handle.close).toHaveBeenCalledOnce();
    expect(t.session.getStatus()).toBe('closed');
  });
});

it.each([false, true])('keeps translated Codex waits alive with agent states=%s', async (hasAgentStates) => {
  const t = setup('codex');
  const context = { rt: newCodexRuntimeState(), log: { info() {}, warn() {}, error() {}, debug() {} } };
  await t.session.send('wait for the child');
  for (let i = 0; i < 20; i++) {
    const item = {
      type: 'collabAgentToolCall', id: `wait-${i}`, tool: 'wait', status: 'completed',
      senderThreadId: 'parent', receiverThreadIds: hasAgentStates ? ['child'] : [],
      agentsStates: hasAgentStates ? { child: { status: 'running' } } : {},
    };
    translateItemNotification('started', {
      threadId: 'parent', turnId: 'turn', item: { ...item, status: 'inProgress' },
    }, t.queue, context);
    translateItemNotification('completed', { threadId: 'parent', turnId: 'turn', item }, t.queue, context);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(t.errors()).toHaveLength(0);
  expect(t.handle.abort).not.toHaveBeenCalled();
  expect(t.session.getStatus()).toBe('active');
  expect(t.seen.filter(e => e.type === 'tool_use')).toHaveLength(20);
  expect(t.seen.filter(e => e.type === 'tool_result')).toHaveLength(20);
  expect(t.seen.filter(e => e.type === 'tool_result_full').map(e => e.data)).toEqual(
    Array.from({ length: 20 }, (_, i) => ({
      toolUseId: `wait-${i}`, fullText: hasAgentStates ? 'child: running' : 'completed', isError: false,
    })),
  );
  await t.end();
  expect(t.handle.abort).not.toHaveBeenCalled();
});

it('pairs real Pi translator tool events without changing their results', async () => {
  const t = setup('pi');
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const context = createPiTranslateContext(logger);
  await t.session.send('investigate');
  translatePiEvent({ type: 'agent_start' }, t.queue, context);
  for (let i = 0; i < 4; i++) {
    translatePiEvent({ type: 'tool_execution_start', toolCallId: String(i), toolName: 'grep', args: { pattern: 'same' } }, t.queue, context);
    translatePiEvent({ type: 'tool_execution_end', toolCallId: String(i), toolName: 'grep', result: { content: [{ type: 'text', text: 'file.ts: unchanged' }] }, isError: false }, t.queue, context);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(t.errors()).toHaveLength(1);
  expect(t.handle.abort).toHaveBeenCalledOnce();
  expect(t.seen.slice(0, t.seen.indexOf(t.errors()[0])).filter(e => e.type === 'tool_result')).toHaveLength(4);
  expect(t.seen.filter(e => e.type === 'tool_result_full').map(e => e.data)).toEqual(
    Array.from({ length: 4 }, (_, i) => ({ toolUseId: String(i), fullText: 'file.ts: unchanged', isError: false })),
  );
});
