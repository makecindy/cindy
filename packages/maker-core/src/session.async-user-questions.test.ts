import { describe, expect, it, vi } from 'vitest';
import { Session } from './session.js';
import type { AgentSessionHandle } from './agents/base-agent.js';
import { createAsyncQueue } from './agents/shared/async-queue.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from './types/events.js';
import type { Logger } from './interfaces/logger.js';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const questions = [{ question: 'Which scope?', options: [{ label: 'Personal' }, { label: 'Both' }] }];
const answer: InteractionDecision = { kind: 'ask_user_question', answers: { 'Which scope?': 'Both' } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(agentKind: 'claude-code' | 'pi' | 'codex') {
  const queue = createAsyncQueue<AgentEvent>();
  let running = false;
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
    askSync() { return resolveNative({ kind: 'ask_user_question', requestId: 'sync', questions }); },
    end(type: 'done' | 'error' = 'done') {
      running = false;
      queue.push({ type, source: agentKind, data: type === 'error' ? { isTerminal: true, message: 'failed' } : {} });
    },
    backgroundDone() { queue.push({ type: 'done', turnScope: 'background', data: {}, source: agentKind }); },
  };
}

describe.each(['claude-code', 'pi'] as const)('%s async questions', (agentKind) => {
  it.each(['sync-first', 'async-first'] as const)('keeps the blocking question answerable with %s arrival', async (order) => {
    const s = await setup(agentKind);
    try {
      const oldId = order === 'async-first' ? s.session.askUserQuestionAsync(questions) : null;
      const sync = s.askSync();
      expect(() => s.session.askUserQuestionAsync(questions)).toThrow('blocking user question');
      expect(s.requests.at(-1)?.requestId).toBe('sync');
      if (oldId) {
        expect(s.events.some((e) => e.type === 'interaction_dismissed'
          && (e.data as { requestId?: string }).requestId === oldId)).toBe(true);
        s.resolvers[0](answer);
      }
      s.resolvers.at(-1)!(answer);
      await expect(sync).resolves.toEqual(answer);
      await flush();
      expect(s.handle.steer).not.toHaveBeenCalled();
      // Settling the blocking request releases the card slot.
      expect(s.session.askUserQuestionAsync(questions)).toBeTypeOf('string');
    } finally { await s.session.close(); }
  });

  it.each(['done', 'error', 'abort', 'close', 'replace'] as const)('cancels in-flight answer delivery on %s without expiring the answered card', async (action) => {
    const s = await setup(agentKind);
    let settle!: () => void;
    vi.mocked(s.handle.steer).mockImplementationOnce(async () => new Promise<void>((resolve) => { settle = resolve; }));
    try {
      const id = s.session.askUserQuestionAsync(questions);
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
      const signal = vi.mocked(s.handle.steer).mock.calls[0][1]?.signal;
      if (action === 'done' || action === 'error') s.end(action);
      else if (action === 'replace') s.session.askUserQuestionAsync([{ question: 'Another question?' }]);
      else await s.session[action]();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(s.events.filter((e) => e.type === 'interaction_dismissed'
        && (e.data as { requestId?: string }).requestId === id)).toEqual([]);
      settle();
      await flush();
    } finally { settle?.(); await s.session.close(); }
  });

  it('returns immediately, uses the existing card and sends a same-turn answer only once', async () => {
    const s = await setup(agentKind);
    try {
      const id = s.session.askUserQuestionAsync(questions);
      expect(s.requests).toEqual([{ kind: 'ask_user_question', requestId: id, questions, delivery: 'async' }]);
      expect(s.session.getTurnControlSnapshot().pendingInteractionCount).toBe(0);
      expect(s.handle.steer).not.toHaveBeenCalled();
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
      expect(s.handle.steer).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('"answer":"Both"'),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(s.handle.send).toHaveBeenCalledOnce();
      s.resolvers[0](answer);
      await flush();
      expect(s.handle.steer).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });

  it.each(['done', 'error', 'abort', 'close', 'detach'] as const)('expires unanswered questions on %s and ignores a late answer', async (action) => {
    const s = await setup(agentKind);
    try {
      const id = s.session.askUserQuestionAsync(questions);
      if (action === 'done' || action === 'error') s.end(action);
      else await s.session[action]();
      await vi.waitFor(() => expect(s.events.some((e) => e.type === 'interaction_dismissed' && (e.data as { requestId?: string }).requestId === id)).toBe(true));
      if (action === 'done') {
        await vi.waitFor(() => expect(s.events.some((e) => e.type === 'done')).toBe(true));
        expect(s.events.findIndex((e) => e.type === 'interaction_dismissed')).toBeLessThan(s.events.findIndex((e) => e.type === 'done'));
        // A completed card may not answer a later execution of the same Session.
        await s.session.send('Next independent task');
      }
      s.resolvers[0](answer);
      await flush();
      expect(s.handle.steer).not.toHaveBeenCalled();
      expect(s.handle.send).toHaveBeenCalledTimes(action === 'done' ? 2 : 1);
    } finally { await s.session.close(); }
  });

  it('expires the replaced question and keeps background completion from dismissing the new card', async () => {
    const s = await setup(agentKind);
    try {
      const oldId = s.session.askUserQuestionAsync(questions);
      const newId = s.session.askUserQuestionAsync([{ question: 'New question?' }]);
      s.backgroundDone();
      await flush();
      expect(s.events.filter((e) => e.type === 'interaction_dismissed').map((e) => (e.data as { requestId?: string }).requestId)).toEqual([oldId]);
      s.resolvers[0](answer);
      s.resolvers[1]({ kind: 'ask_user_question', answers: { 'New question?': 'Free text' } });
      await vi.waitFor(() => expect(s.handle.steer).toHaveBeenCalledOnce());
      expect(s.requests[1].requestId).toBe(newId);
    } finally { await s.session.close(); }
  });

  it.each([{}, { dismissed: true }] as const)('does not invent a choice for an empty or dismissed answer %j', async (extra) => {
    const s = await setup(agentKind);
    try {
      s.session.askUserQuestionAsync(questions);
      s.resolvers[0]({ kind: 'ask_user_question', answers: {}, ...extra });
      await flush();
      expect(s.handle.steer).not.toHaveBeenCalled();
      expect(s.handle.send).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });

  it('never replays a failed answer as a fresh task', async () => {
    const s = await setup(agentKind);
    try {
      vi.mocked(s.handle.steer).mockRejectedValueOnce(new Error('transport closed after write'));
      s.session.askUserQuestionAsync(questions);
      s.resolvers[0](answer);
      await vi.waitFor(() => expect(s.events.some((e) => e.type === 'error' && (e.data as { isTerminal?: boolean }).isTerminal === false)).toBe(true));
      expect(s.handle.send).toHaveBeenCalledOnce();
      expect(s.handle.steer).toHaveBeenCalledOnce();
    } finally { await s.session.close(); }
  });
});

// Even a stale/misattributed MCP context cannot create a shared question in a
// Codex Session: the live Session owns the harness identity.
it('rejects shared questions around a native Codex card without disturbing it', async () => {
  const s = await setup('codex');
  try {
    expect(() => s.session.askUserQuestionAsync(questions)).toThrow('native');
    const nativeRequest: InteractionRequest = {
      kind: 'ask_user_question', requestId: 'native', questions, delivery: 'async',
    };
    const native = s.session.runHostInteraction(nativeRequest, () => new Promise((resolve) => {
      s.requests.push(nativeRequest);
      s.resolvers.push(resolve);
    }));
    expect(() => s.session.askUserQuestionAsync(questions)).toThrow('native');
    expect(s.requests).toEqual([nativeRequest]);
    expect(s.session.getTurnControlSnapshot().pendingInteractionCount).toBe(0);
    expect(s.events.filter((e) => e.type === 'interaction_dismissed')).toEqual([]);
    s.resolvers[0](answer);
    await expect(native).resolves.toEqual(answer);
    expect(() => s.session.askUserQuestionAsync(questions)).toThrow('native');
    await flush();
    expect(s.handle.steer).not.toHaveBeenCalled();
  } finally { await s.session.close(); }
});
