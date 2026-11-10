import { describe, expect, it, vi } from 'vitest';
import { TurnDispatchRejectedError, SUPERSEDE_ASYNC_QUESTIONS } from './agents/base-agent.js';
import { Session } from './session.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentEvent, InteractionDecision, InteractionRequest, AskUserQuestionItem } from './types/events.js';
import type { Logger } from './interfaces/logger.js';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const questions = [{ question: 'Which scope?', options: [{ label: 'Personal' }, { label: 'Both' }] }];
const answer: InteractionDecision = { kind: 'ask_user_question', answers: { 'Which scope?': 'Both' } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(agentKind: 'claude-code' | 'pi' | 'codex') {
  const queue = createAsyncQueue<AgentEvent>();
  let running = false;
  let nativeId = 0;
  const requests: InteractionRequest[] = [];
  const resolvers: Array<(decision: InteractionDecision) => void> = [];
  let resolveNative!: (request: InteractionRequest) => Promise<InteractionDecision>;
  const handle = {
    id: 'thread', agentKind, model: 'test-model', events: () => queue,
    send: vi.fn(async () => { running = true; }), steer: vi.fn(async () => {}),
    abort: vi.fn(async () => { running = false; }),
    close: vi.fn(async () => { running = false; queue.end(); }),
    isTurnRunning: () => running, setInteractionResolver(resolve: typeof resolveNative) { resolveNative = resolve; },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
  } as unknown as AgentSessionHandle;
  const session = new Session({ id: 'task', agentKind, workDir: '/repo', handle, logger,
    capabilities: { sameTurnSteer: { supported: true } } as never, turnStallMs: 0 });
  session.setInteractionListener((request) => {
    requests.push(request);
    return new Promise((resolve) => { resolvers.push(resolve); });
  });
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));
  await session.send('Start independent work');
  return { session, handle, requests, resolvers, events,
    ask(items: AskUserQuestionItem[] = questions) {
      if (agentKind !== 'codex') return session.askUserQuestionAsync(items).request_id;
      const id = `native-${++nativeId}`;
      void resolveNative({ kind: 'ask_user_question', requestId: id, questions: items, delivery: 'async' });
      return id;
    },
    askSync() { return resolveNative({ kind: 'ask_user_question', requestId: 'sync', questions }); },
    end(type: 'done' | 'error' = 'done') {
      running = false;
      queue.push({ type, source: agentKind, data: type === 'error' ? { isTerminal: true, message: 'failed' } : {} });
      if (type === 'error') queue.push({ type: 'done', source: agentKind, data: {} });
    },
    backgroundDone() { queue.push({ type: 'done', turnScope: 'background', data: {}, source: agentKind }); },
  };
}

const dismissedIds = (s: Awaited<ReturnType<typeof setup>>) => s.events.filter((e) => e.type === 'interaction_dismissed')
  .map((e) => (e.data as { requestId: string }).requestId);

describe.each(['claude-code', 'pi', 'codex'] as const)('%s terminal-aligned async questions', (agentKind) => {
  // Regression: obsolete cards should be explicitly withdrawn without consuming useful questions
  // or an answer already admitted. Entry: production Session methods; tier: unit.
  it('lists each question and withdraws only obsolete questions after work ends', async () => {
    const s = await setup(agentKind);
    try {
      s.ask([{ question: 'Already found?' }, { question: 'Still useful?' }]);
      s.end();
      await flush();
      const pending = s.session.manageAsyncUserQuestions({ action: 'list' }).questions!;
      expect(pending.map((q) => q.question)).toEqual(['Already found?', 'Still useful?']);
      const id = pending[0].request_id;
      expect(s.session.manageAsyncUserQuestions({ action: 'withdraw', request_ids: [id], reason: '已从日志确认' }).results)
        .toEqual([{ request_id: id, status: 'withdrawn' }]);
      expect(s.events).toContainEqual(expect.objectContaining({ type: 'interaction_dismissed',
        data: expect.objectContaining({ requestId: id, reason: 'question_withdrawn', withdrawalReason: '已从日志确认' }) }));
      expect(s.session.manageAsyncUserQuestions({ action: 'withdraw', request_ids: [id, 'another-task'], reason: '不再需要' }).results)
        .toEqual([{ request_id: id, status: 'not_pending' }, { request_id: 'another-task', status: 'not_pending' }]);
      s.resolvers[0]({ kind: 'ask_user_question', answers: { 'Already found?': 'late' } });
      await flush();
      expect(s.handle.send).toHaveBeenCalledTimes(1);
      expect(s.session.manageAsyncUserQuestions({ action: 'list' }).questions).toHaveLength(1);
      s.resolvers[1]({ kind: 'ask_user_question', answers: { 'Still useful?': 'yes' } });
      await vi.waitFor(() => expect(s.handle.send).toHaveBeenCalledTimes(2));
    } finally { await s.session.close(); }
  });

  it('gives an answer already being submitted priority over withdrawal', async () => {
    const s = await setup(agentKind);
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    s.session.setAsyncQuestionAnswerDispatcher(async () => admitted);
    try {
      const id = s.ask();
      const submit = s.session.submitAsyncQuestionAnswer(id, answer);
      expect(s.session.manageAsyncUserQuestions({ action: 'withdraw', request_ids: [id], reason: '不再需要' }).results)
        .toEqual([{ request_id: id, status: 'answer_in_flight' }]);
      expect(dismissedIds(s)).toEqual([]);
      release();
      await expect(submit).resolves.toBe(true);
    } finally { release(); await s.session.close(); }
  });

  it.each(['sync-first', 'async-first'] as const)('keeps both kinds answerable with %s arrival', async (order) => {
    const s = await setup(agentKind);
    try {
      if (order === 'async-first') s.ask();
      const sync = s.askSync();
      if (order === 'sync-first') s.ask();
      expect(s.requests).toHaveLength(2);
      expect(dismissedIds(s)).toEqual([]);
      s.resolvers[s.requests.findIndex((q) => q.requestId === 'sync')](answer);
      await expect(sync).resolves.toEqual(answer);
      expect(s.handle.steer).not.toHaveBeenCalled();
      s.resolvers[s.requests.findIndex((q) => q.requestId !== 'sync')](answer);
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
    } finally { await s.session.close(); }
  });

  it('returns immediately and delivers a same-turn answer once', async () => {
    const s = await setup(agentKind);
    try {
      const id = s.ask();
      expect(s.requests).toEqual([expect.objectContaining({ kind: 'ask_user_question', requestId: id, delivery: 'async' })]);
      expect(s.session.getTurnControlSnapshot().pendingInteractionCount).toBe(0);
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
      expect(s.handle.steer).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Both') }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }));
      s.resolvers[0](answer);
      await flush();
      expect(s.handle.steer).toHaveBeenCalledOnce();
      expect(s.handle.send).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });

  it('adds applicability context only when the original question turn has ended', async () => {
    const s = await setup(agentKind);
    try {
      s.ask();
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
      expect(JSON.stringify(vi.mocked(s.handle.steer).mock.calls[0])).not.toContain('<cindy_question_context>');
      s.ask();
      s.end();
      await flush();
      s.resolvers[1](answer);
      await vi.waitFor(() => expect(s.handle.send).toHaveBeenCalledTimes(2));
      expect(JSON.stringify(vi.mocked(s.handle.send).mock.calls[1])).toContain('<cindy_question_context>');
      expect(JSON.stringify(vi.mocked(s.handle.send).mock.calls[1])).toContain('Both');
    } finally { await s.session.close(); }
  });

  it.each(['done', 'error', 'abort'] as const)('retains unanswered questions on %s; a late answer starts a new turn', async (action) => {
    const s = await setup(agentKind);
    try {
      s.ask();
      if (action === 'abort') await s.session.abort(); else s.end(action);
      await flush();
      expect(dismissedIds(s)).toEqual([]);
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.send).toHaveBeenCalledTimes(2));
      expect(s.handle.steer).not.toHaveBeenCalled();
    } finally { await s.session.close(); }
  });

  it.each(['close', 'detach'] as const)('retires questions at session %s', async (action) => {
    const s = await setup(agentKind);
    try {
      const id = s.ask();
      await s.session[action]();
      expect(dismissedIds(s)).toContain(id);
      s.resolvers[0](answer);
      await flush();
      expect(s.handle.steer).not.toHaveBeenCalled();
      expect(s.handle.send).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });

  it('accumulates same-title questions, answers/skips independently, and preserves the remainder', async () => {
    const s = await setup(agentKind);
    try {
      s.ask([...questions, ...questions]);
      s.ask([{ question: 'Style?' }]);
      expect(new Set(s.requests.map((r) => r.requestId)).size).toBe(3);
      expect(s.requests.every((r) => r.kind === 'ask_user_question' && r.questions.length === 1)).toBe(true);
      s.end(); await flush();
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.send).toHaveBeenCalledTimes(2));
      s.resolvers[1]({ kind: 'ask_user_question', answers: {}, dismissed: true });
      s.backgroundDone(); await flush();
      expect(dismissedIds(s)).toEqual([]);
      s.resolvers[2]({ kind: 'ask_user_question', answers: { 'Style?': 'Simple' } });
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
    } finally { await s.session.close(); }
  });

  // Regression: generic Session inputs include automation and worker reports; the user is absent.
  // Entry: real Session send/steer, minimum one unanswered question; tier: unit.
  it.each(['steer', 'send'] as const)('retains questions across unclassified or automatic %s', async (action) => {
    const s = await setup(agentKind);
    try {
      const id = s.ask();
      if (action === 'send') { s.end(); await flush(); }
      await s.session[action]('Automatic follow-up');
      expect(dismissedIds(s)).toEqual([]);
      expect(s.session.manageAsyncUserQuestions({ action: 'list' }).questions)
        .toEqual([expect.objectContaining({ request_id: id, status: 'pending' })]);
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledTimes(action === 'steer' ? 2 : 1));
    } finally { await s.session.close(); }
  });

  it.each(['steer', 'send'] as const)('only accepted host-classified user %s clears old questions', async (action) => {
    const s = await setup(agentKind);
    try {
      const oldId = s.ask();
      if (action === 'send') { s.end(); await flush(); }
      vi.mocked(s.handle[action]).mockRejectedValueOnce(new TurnDispatchRejectedError('not accepted'));
      if (action === 'send') await expect(s.session.send('New task', { [SUPERSEDE_ASYNC_QUESTIONS]: true })).resolves.toMatchObject({ accepted: false });
      else await expect(s.session.steer('New task', { [SUPERSEDE_ASYNC_QUESTIONS]: true })).rejects.toThrow();
      expect(dismissedIds(s)).toEqual([]);
      await s.session[action]('New task', { [SUPERSEDE_ASYNC_QUESTIONS]: true });
      expect(dismissedIds(s)).toEqual([oldId]);
      s.resolvers[0](answer);
      await flush();
      expect(s.handle.steer).toHaveBeenCalledTimes(action === 'steer' ? 2 : 0);
    } finally { await s.session.close(); }
  });

  it.each([{}, { 'Which scope?': ' ' }, { unrelated: 'Not an answer' }] as Record<string, string>[])('does not send empty or unrelated answers %j', async (answers) => {
    const s = await setup(agentKind);
    try {
      s.ask();
      s.resolvers[0]({ kind: 'ask_user_question', answers });
      await flush();
      expect(s.handle.steer).not.toHaveBeenCalled();
      expect(s.handle.send).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });

  it('keeps a rejected host admission answerable and admits retries once', async () => {
    const s = await setup(agentKind);
    try {
      const dispatch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
      s.session.setAsyncQuestionAnswerDispatcher(dispatch);
      const id = s.ask();
      await expect(s.session.submitAsyncQuestionAnswer(id, answer)).rejects.toThrow('offline');
      expect(dismissedIds(s)).toEqual([]);
      s.end(); await flush();
      await expect(s.session.submitAsyncQuestionAnswer(id, answer)).resolves.toBe(true);
      expect(dispatch.mock.calls[1][0]).toBe(dispatch.mock.calls[0][0]);
      s.resolvers[0](answer);
      await flush();
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(s.handle.steer).not.toHaveBeenCalled();
    } finally { await s.session.close(); }
  });

  it('never retries unknown delivery as a fresh task', async () => {
    const s = await setup(agentKind);
    try {
      vi.mocked(s.handle.steer).mockRejectedValueOnce(new Error('transport closed after write'));
      s.ask(); s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.events.some((e) => e.type === 'error' && (e.data as { isTerminal?: boolean }).isTerminal === false)).toBe(true));
      expect(s.handle.send).toHaveBeenCalledOnce();
      expect(s.handle.steer).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });
});

it('keeps Codex on its native question entry', async () => {
  const s = await setup('codex');
  try {
    s.ask();
    expect(() => s.session.askUserQuestionAsync(questions)).toThrow('native');
    expect(s.requests).toHaveLength(1);
  } finally { await s.session.close(); }
});

// Receipt IDs must be the actual independently withdrawable IDs, including repeated titles.
// Entry: public Session tool method and manager; tier: unit.
it.each(['claude-code', 'pi'] as const)('%s returns each request ID and current pending count', async (agentKind) => {
  const s = await setup(agentKind);
  try {
    s.ask();
    const receipt = s.session.askUserQuestionAsync([{ question: 'Same?' }, { question: 'Same?' }]);
    expect(receipt.questions).toEqual(s.requests.slice(1).map((request) => ({ request_id: request.requestId, question: 'Same?' })));
    expect(new Set(receipt.questions.map((q) => q.request_id)).size).toBe(2);
    expect(receipt.pending_count).toBe(3);
    expect(s.session.manageAsyncUserQuestions({ action: 'withdraw', request_ids: [receipt.questions[0].request_id], reason: '已查明' }).results)
      .toEqual([{ request_id: receipt.questions[0].request_id, status: 'withdrawn' }]);
    expect(s.session.manageAsyncUserQuestions({ action: 'list' }).questions).toHaveLength(2);
  } finally { await s.session.close(); }
});
