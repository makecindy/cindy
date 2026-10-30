import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, MANUAL_ABORT_RECOVERY_GRACE_MS } from './session.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import { createPiTranslateContext, translatePiEvent } from './agents/pi/translator.js';
import { newCodexRuntimeState, translateItemNotification } from './agents/codex/translator.js';
import { AUTO_REVIEW_USER_INTENT, type AgentSessionHandle } from './agents/base-agent.js';
import type { AgentEvent, InteractionDecision, InteractionResolver } from './types/events.js';
import type { Logger } from './interfaces/logger.js';
import type { ToolLoopReviewer } from './agents/shared/tool-loop-review.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

function setup(agentKind: 'pi' | 'codex', hangAbort = false, toolLoopReviewer: ToolLoopReviewer = async () => 'stop') {
  vi.useFakeTimers();
  const queue = createAsyncQueue<AgentEvent>();
  let running = false;
  let resolveInteraction!: InteractionResolver;
  const handle = {
    id: 'native-session', agentKind, model: 'test-model',
    events: () => queue,
    send: vi.fn(async () => { running = true; }),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {
      if (hangAbort) return new Promise<void>(() => {});
      running = false;
      queue.push({ type: 'done', data: {}, source: agentKind });
    }),
    close: vi.fn(async () => { running = false; queue.end(); }),
    isTurnRunning: () => running,
    setInteractionResolver(resolve: InteractionResolver) { resolveInteraction = resolve; },
  } as unknown as AgentSessionHandle;
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = new Session({
    id: 'test-session', agentKind, handle, workDir: '/test',
    capabilities: { sameTurnSteer: { supported: true } } as never, logger, toolLoopReviewer,
  });
  sessions.push(session);
  const seen: AgentEvent[] = [];
  session.onEvent((event) => seen.push(event));
  // Each call follows a model sampling (seconds), unlike one script issuing calls back to back.
  const tool = async (id: string, extra: Partial<AgentEvent> = {}, name = 'read', input: unknown = { path: 'same.ts' }) => {
    await vi.advanceTimersByTimeAsync(3_000);
    queue.push({ type: 'tool_use', data: { toolUseId: id, toolName: name, input }, source: agentKind, ...extra });
    queue.push({ type: 'tool_result_full', data: { toolUseId: id, fullText: 'same result' }, source: agentKind, ...extra });
    queue.push({ type: 'tool_result', data: { toolUseIds: [id], summary: 'done' }, source: agentKind, ...extra });
    await vi.advanceTimersByTimeAsync(0);
  };
  const errors = () => seen.filter((event) => event.type === 'error');
  return { queue, session, seen, handle, tool, errors, logger,
    ask: (delivery?: 'async') => resolveInteraction({ kind: 'ask_user_question', requestId: 'question',
      questions: [{ question: 'Scope?' }], ...(delivery ? { delivery } : {}) }),
    end: async () => {
      running = false;
      queue.push({ type: 'done', data: {}, source: agentKind });
      await vi.advanceTimersByTimeAsync(0);
    } };
}

describe.each(['pi', 'codex'] as const)('%s Session tool loop coverage', (agentKind) => {
  it.each(['sync', 'async'] as const)('only suspends loop detection for a blocking question: %s', async (delivery) => {
    const t = setup(agentKind);
    let answer!: (decision: InteractionDecision) => void;
    t.session.setInteractionListener(() => new Promise((resolve) => { answer = resolve; }));
    await t.session.send('investigate');
    const pending = t.ask(delivery === 'async' ? delivery : undefined);
    for (let i = 0; i < 4; i++) await t.tool(`pending-${i}`);
    expect(t.handle.abort).toHaveBeenCalledTimes(delivery === 'async' ? 1 : 0);
    answer({ kind: 'ask_user_question', answers: {} });
    await pending;
    if (delivery === 'sync') {
      for (let i = 0; i < 4; i++) await t.tool(`resumed-${i}`);
      expect(t.handle.abort).toHaveBeenCalledOnce();
    }
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ data: { reason: 'tool_use_loop_detected' } });
  });

  it('does not interpret one parallel batch of distinct contract failures as retries', async () => {
    const t = setup(agentKind);
    await t.session.send('investigate');
    for (let i = 0; i < 5; i++) t.queue.push({ type: 'tool_use', source: agentKind, data: {
      toolUseId: `invalid-${i}`, toolName: 'Edit', input: { old_string: `old-${i}`, new_string: `new-${i}` },
    } });
    for (const i of [2, 0, 4, 1, 3]) t.queue.push({ type: 'tool_result_full', source: agentKind, data: {
      toolUseId: `invalid-${i}`, fullText: 'InputValidationError: Missing required parameter file_path', isError: true,
    } });
    t.queue.push({ type: 'tool_result', source: agentKind, data: {
      toolUseIds: [0, 1, 2, 3, 4].map((i) => `invalid-${i}`), summary: 'invalid parameters',
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
    await vi.advanceTimersByTimeAsync(3_000);
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

  it('keeps paced CI polling alive (2026-10 PR #18 false positive)', async () => {
    const t = setup(agentKind);
    await t.session.send('wait for CI');
    const poll = { cmd: 'gh api repos/o/r/actions/jobs/1 --jq .status' };
    for (let i = 0; i < 30; i++) {
      await t.tool(`sleep-${i}`, {}, 'mcp:clock:sleep', { duration_ms: 55_000 });
      await vi.advanceTimersByTimeAsync(66_000);
      await t.tool(`poll-${i}`, {}, 'exec', poll);
    }
    expect(t.errors()).toHaveLength(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
  });

  // 游戏截图误停：16 次四种调用轮转不等于空转；三次放行后仍需继续，且不增加复核调用。
  it('reviews phone operation with user goals and explanations, then keeps running within the review budget', async () => {
    const reviewer = vi.fn<ToolLoopReviewer>(async () => 'continue');
    const t = setup(agentKind, false, reviewer);
    const userIntent = { earlierUserMessages: ['Play the phone game using screenshots.'], currentUserMessage: 'Continue until the level ends.' };
    await t.session.send('Continue until the level ends.', { [AUTO_REVIEW_USER_INTENT]: userIntent });
    // PR #7404 review: delta + final 全文不能重复，避免 2000 字符发送预算挤掉最新理由。
    const prefix = 'Observing the animation. '.repeat(50);
    const explanation = `${prefix}The target moves; I will observe its new position before tapping.`;
    if (agentKind === 'pi') {
      const context = createPiTranslateContext(t.logger);
      translatePiEvent({ type: 'message_update', assistantMessageEvent: {
        type: 'text_delta', contentIndex: 0, delta: prefix,
      } }, t.queue, context);
      translatePiEvent({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: explanation }], stopReason: 'toolUse',
      } }, t.queue, context);
    } else {
      const context = { rt: newCodexRuntimeState(), log: { info() {}, warn() {}, error() {}, debug() {} } };
      const item = { type: 'agentMessage', id: 'explanation', text: prefix };
      translateItemNotification('started', { threadId: 'thread', turnId: 'turn', item }, t.queue, context);
      translateItemNotification('completed', {
        threadId: 'thread', turnId: 'turn', item: { ...item, text: explanation },
      }, t.queue, context);
    }
    t.queue.push({ type: 'thinking', data: { text: 'private reasoning must not be sent' }, source: agentKind });
    t.queue.push({ type: 'text', data: { text: 'unrelated background task' }, source: agentKind, turnScope: 'background' });
    const operations = ['screenshot', 'tap', 'swipe', 'Read'];
    for (let i = 0; i < 16; i++) await t.tool(String(i), {}, operations[i % 4]);
    expect(reviewer).toHaveBeenCalledOnce();
    expect(reviewer.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'test-session', agentKind, model: 'test-model',
      userIntent,
      assistantExplanation: explanation,
      verdict: { reason: 'rotation', count: 16, toolName: 'Read' },
    });
    for (let i = 16; i < 100; i++) await t.tool(String(i), {}, operations[i % 4]);
    expect(reviewer).toHaveBeenCalledTimes(3);
    expect(t.errors()).toHaveLength(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
  });

  it('includes accepted steering and discards a stop based on the previous user goal', async () => {
    let decide!: (decision: 'continue' | 'stop') => void;
    const reviewer = vi.fn<ToolLoopReviewer>(() => new Promise((resolve) => { decide = resolve; }));
    const t = setup(agentKind, false, reviewer);
    await t.session.send('Read the current screen.');
    for (let i = 0; i < 4; i++) await t.tool(String(i));
    await t.session.steer('Keep observing until the animation ends.');
    decide('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
    await t.tool('after-steer');
    expect(reviewer.mock.calls[1]?.[0].userIntent).toEqual({
      earlierUserMessages: ['Read the current screen.'],
      currentUserMessage: 'Keep observing until the animation ends.',
    });
  });

  it('interrupts after the reviewer confirms a loop, once and only for the reviewed turn', async () => {
    let decide!: (decision: 'continue' | 'stop') => void;
    const reviewer = vi.fn<ToolLoopReviewer>(() => new Promise((resolve) => { decide = resolve; }));
    const t = setup(agentKind, false, reviewer);
    await t.session.send('investigate');
    for (let i = 0; i < 4; i++) await t.tool(String(i));
    expect(t.errors()).toHaveLength(0);
    decide('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(1);
    expect(t.errors()[0]).toMatchObject({ data: {
      reason: 'tool_use_loop_detected', isTerminal: true, toolLoop: { kind: 'consecutive', count: 4 },
    } });
    expect(t.handle.abort).toHaveBeenCalledOnce();

    // 新 turn 再次进入复核;turn 结束后才到的 stop 结论必须丢弃。
    await t.session.send('try again');
    for (let i = 0; i < 4; i++) await t.tool(`next-${i}`);
    await t.end();
    decide('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(1);
    expect(t.handle.abort).toHaveBeenCalledOnce();
  });

  it('emits a reviewed stop only after the pending result summary', async () => {
    let decide!: (decision: 'continue' | 'stop') => void;
    const reviewer = vi.fn<ToolLoopReviewer>(() => new Promise((resolve) => { decide = resolve; }));
    const t = setup(agentKind, false, reviewer);
    await t.session.send('investigate');
    for (let i = 0; i < 3; i++) await t.tool(String(i));
    await vi.advanceTimersByTimeAsync(3_000);
    t.queue.push({ type: 'tool_use', source: agentKind, data: { toolUseId: 'last', toolName: 'read', input: { path: 'same.ts' } } });
    t.queue.push({ type: 'tool_result_full', source: agentKind, data: { toolUseId: 'last', fullText: 'same result' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(reviewer).toHaveBeenCalledOnce();
    decide('stop');
    await vi.advanceTimersByTimeAsync(0);
    // 完整结果已送达、摘要未到:终态必须等摘要。
    expect(t.errors()).toHaveLength(0);
    t.queue.push({ type: 'tool_result', source: agentKind, data: { toolUseIds: ['last'], summary: 'done' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(1);
    const summaryIndex = t.seen.findIndex((e) => e.type === 'tool_result'
      && (e.data as { toolUseIds?: string[] }).toolUseIds?.includes('last'));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(t.seen.indexOf(t.errors()[0]!));
    expect(t.handle.abort).toHaveBeenCalledOnce();
  });

  it('discards a reviewed stop that arrives after detachment starts', async () => {
    let decide!: (decision: 'continue' | 'stop') => void;
    const reviewer = vi.fn<ToolLoopReviewer>(() => new Promise((resolve) => { decide = resolve; }));
    const t = setup(agentKind, false, reviewer);
    // handle.detach 挂起:会话仍处于 active,但拆除已开始。
    (t.handle as unknown as { detach: () => Promise<void> }).detach = vi.fn(() => new Promise<void>(() => {}));
    await t.session.send('investigate');
    for (let i = 0; i < 4; i++) await t.tool(String(i));
    void t.session.detach({ reason: 'account-boundary' });
    await vi.advanceTimersByTimeAsync(0);
    decide('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors()).toHaveLength(0);
    expect(t.handle.abort).not.toHaveBeenCalled();
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

// 2026-10-18 误报:code mode 脚本在后台连着发起调用(点保存后反复截快照等页面更新),
// app-server 不标注调用属于哪段脚本。同一调用的突发重复(无模型采样间隔)不计数,模型逐次重复仍须中断。
it('does not count a Codex call repeated in a script burst, but still stops a model repeating itself', async () => {
  const t = setup('codex');
  const context = { rt: newCodexRuntimeState(), log: { info() {}, warn() {}, error() {}, debug() {} } };
  let n = 0;
  const call = async (action: string, text: string, ref?: string) => {
    const item = {
      type: 'mcpToolCall', id: `exec-${n++}`, server: 'cindy_browser', tool: 'call_tool',
      arguments: { name: 'browser', args: { action, ...(ref ? { ref } : {}) } }, status: 'completed',
      result: { content: [{ type: 'text', text }] },
    };
    translateItemNotification('started', { threadId: 'thread', turnId: 'turn', item }, t.queue, context);
    translateItemNotification('completed', { threadId: 'thread', turnId: 'turn', item }, t.queue, context);
    await vi.advanceTimersByTimeAsync(0);
  };
  await t.session.send('upload the icons');
  await vi.advanceTimersByTimeAsync(3_000);
  for (let i = 0; i < 30; i++) {
    await call(i % 7 === 0 ? 'click' : 'snapshot', i % 7 === 0 ? `clicked e${i}` : 'saving', i % 7 === 0 ? `e${i}` : undefined);
    await vi.advanceTimersByTimeAsync(800);
  }
  expect(t.errors()).toHaveLength(0);
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(3_000);
    await call('snapshot', 'saving');
  }
  expect(t.errors()).toHaveLength(1);
  expect(t.errors()[0]).toMatchObject({ data: { toolLoop: { kind: 'consecutive', count: 4 } } });
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
