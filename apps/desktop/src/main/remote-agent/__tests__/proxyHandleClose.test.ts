/** Real transport -> proxy -> Session regression; only peer IO is in memory. */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Session, type AgentEvent } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteAgentHandle, type RemoteAgentHandleController } from '../controller/proxyHandle';
import { RemoteAgentRunClient } from '../controller/runClient';
import type { RemoteAgentPoller } from '../controller/poller';
import { ExecutorWorkspace } from '../executor/workspace';
import { RemoteTurnTerminalOwnership } from '../turnLifecycle';

function fixture(agentKind: 'codex' | 'claude-code' = 'codex') {
  let controller!: RemoteAgentHandleController;
  const restartRecovery = vi.fn();
  const deliver = (item: unknown) => client.onData(Buffer.from(JSON.stringify(item) + '\n'), false);
  const invoke = vi.fn(async (args: unknown[]) => {
    const request = args[0] as { op: string; callId: string };
    if (request.op === 'call') deliver({ t: 'result', callId: request.callId, ok: true });
    if (request.op === 'close') deliver({ t: 'closed', reason: 'closed' });
    return {};
  });
  const client = new RemoteAgentRunClient(randomUUID(), {
    invoke, unregister: vi.fn(),
  } as unknown as RemoteAgentPoller, {
    onEvent: event => controller.onEvent(event), onState: state => controller.onState(state),
    onClosed: (reason, error) => {
      if (reason === 'provider-restarting') controller.onInterrupted(restartRecovery);
      else controller.onClosed(reason, error?.message, client.runId);
    },
    onRequest: async () => ({ type: 'callback' }), onWs() {},
  }, randomUUID);
  const dispose = vi.fn(async () => undefined);
  controller = createRemoteAgentHandle({ client,
    started: { id: 'sdk-fixture', agentKind, model: 'fixture', shadowDir: '', methods: [], state: {} },
    workspace: new ExecutorWorkspace({ workingDir: os.tmpdir() }),
    recordApproval() {}, newId: randomUUID, dispose,
  });
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  const session = new Session({ id: randomUUID(), agentKind, workDir: os.tmpdir(),
    handle: controller.handle, capabilities: {} as never, logger, turnStallMs: 0 });
  const seen: AgentEvent[] = [];
  session.onEvent(event => seen.push(event));
  const finish = async () => {
    await vi.waitFor(() => expect(session.getStatus()).toBe('closed'));
    await session.close();
  };
  return { controller, client, session, seen, deliver, finish, dispose, invoke, restartRecovery };
}

describe('remote stream close settles the product turn', () => {
  it('reuses Session after an explicit remote preflight refusal without a stale tail fence', async () => {
    const f = fixture();
    try {
      f.invoke.mockImplementationOnce(async (args: unknown[]) => {
        const request = args[0] as { callId: string };
        f.deliver({ t: 'result', callId: request.callId, ok: false,
          error: { code: 'TURN_DISPATCH_REJECTED', name: 'TurnDispatchRejectedError', message: 'unsupported turn options' } });
        return {};
      });
      const refused = await f.session.send('invalid').catch(error => error);
      expect(refused).toMatchObject({ accepted: false, reason: 'provider-rejected-before-dispatch' });
      expect(await f.session.send('valid retry')).toMatchObject({ accepted: true });
      f.deliver({ t: 'event', event: { type: 'done', source: 'codex', data: {} } });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'done', generation: 1 }));
      expect(f.controller.isQuiet()).toBe(true);
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
    } finally { await f.session.close(); }
  });

  it('keeps an unsettled old Session owner across remote preflight refusal and retry', async () => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'prior progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      f.invoke.mockImplementationOnce(async (args: unknown[]) => {
        const request = args[0] as { callId: string };
        f.deliver({ t: 'result', callId: request.callId, ok: false,
          error: { code: 'TURN_DISPATCH_REJECTED', name: 'TurnDispatchRejectedError', message: 'unsupported turn options' } });
        return {};
      });
      expect(await f.session.send('refused')).toMatchObject({ accepted: false });
      expect(await f.session.send('valid retry')).toMatchObject({ accepted: true });
      f.deliver({ t: 'event', event: { type: 'done', source: 'codex', data: {} } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'none' });
      expect(f.controller.hasActiveTurn()).toBe(true);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ sessionTurnGeneration: 2, data: expect.objectContaining({ reason: 'remote_agent_closed' }) }),
      ]);
    } finally { await f.session.close(); }
  });

  it('does not let a claimed SDK boundary consume the prior send fence', () => {
    const owner = new RemoteTurnTerminalOwnership();
    owner.beginSend(false, 'first');
    owner.acceptSend('first');
    owner.observe({ type: 'text', source: 'codex', data: { text: 'first progress' } });
    owner.beginSend(true, 'second');
    owner.acceptSend('second');
    expect(owner.observe({ type: 'status', source: 'codex', turnContinuationId: 7, data: { isRunning: false } })).toBe(false);
    expect(owner.observe({ type: 'done', source: 'codex', turnContinuationId: 7, data: {} })).toBe(false);
    expect(owner.observe({ type: 'done', source: 'codex', data: {} })).toBe(false);
    owner.observe({ type: 'text', source: 'codex', data: { text: 'second progress' } });
    expect(owner.observe({ type: 'done', source: 'codex', data: {} })).toBe(true);
    owner.beginSend(false, 'third');
    expect(owner.observe({ type: 'error', source: 'codex', turnContinuationId: 7,
      data: { isTerminal: true, message: 'continuation failed' } })).toBe(true);
  });

  it('keeps an observed error fence across a late ordinary running snapshot', () => {
    const owner = new RemoteTurnTerminalOwnership();
    owner.beginSend(false, 'first');
    owner.acceptSend('first');
    expect(owner.observe({ type: 'error', source: 'codex', data: { isTerminal: true, message: 'first failed' } })).toBe(true);
    owner.observe({ type: 'status', source: 'codex', data: { isRunning: true } });
    owner.beginSend(false, 'second');
    expect(owner.observe({ type: 'done', source: 'codex', data: {} })).toBe(false);
  });

  it.each([false, true])('matches Session done ownership after a dispatch-time prior idle/error (prior running=%s)', async priorRunning => {
    const f = fixture();
    try {
      await f.session.send('first');
      if (priorRunning) f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: true } } });
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      f.invoke.mockImplementationOnce(async (args: unknown[]) => {
        const request = args[0] as { callId: string };
        f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
        f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'prior failed' } } });
        await new Promise<void>(resolve => setImmediate(resolve));
        f.deliver({ t: 'result', callId: request.callId, ok: true });
        return {};
      });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
      f.deliver({ t: 'event', event: { type: 'done', source: 'codex', data: {} } });
      if (!priorRunning) {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
        expect(f.controller.hasActiveTurn()).toBe(true);
        f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'second progress' } } });
        f.deliver({ t: 'event', event: { type: 'done', source: 'codex', data: {} } });
      }
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'done', generation: 2 }));
      expect(f.controller.hasActiveTurn()).toBe(false);
      expect(f.controller.isQuiet()).toBe(true);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
    } finally { await f.session.close(); }
  });

  it('keeps a third send unfinished when earlier sends drain delayed errors', async () => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'first late error' } } });
      await new Promise<void>(resolve => setImmediate(resolve));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      f.invoke.mockImplementationOnce(async (args: unknown[]) => {
        const request = args[0] as { callId: string };
        f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
        f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'second late error' } } });
        await new Promise<void>(resolve => setImmediate(resolve));
        f.deliver({ t: 'result', callId: request.callId, ok: true });
        return {};
      });
      expect(await f.session.send('third')).toMatchObject({ accepted: true });
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
      expect(f.controller.hasActiveTurn()).toBe(true);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ sessionTurnGeneration: 3, data: expect.objectContaining({ reason: 'remote_agent_closed' }) }),
      ]);
    } finally { await f.session.close(); }
  });

  it.each([false, true])('preserves a dispatch idle/error after the prior terminal error has settled (stopped=%s)', async stopped => {
    const f = fixture();
    try {
      await f.session.send('first');
      if (stopped) await f.session.abort();
      f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'prior failed' } } });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'error', generation: 1 }));
      f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'status')).toBe(true));
      f.invoke.mockImplementationOnce(async (args: unknown[]) => {
        const request = args[0] as { callId: string };
        f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
        f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'new start failed' } } });
        await new Promise<void>(resolve => setImmediate(resolve));
        f.deliver({ t: 'result', callId: request.callId, ok: true });
        return {};
      });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'error', generation: 2 }));
      expect(f.controller.hasActiveTurn()).toBe(false);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error').map(e => (e.data as { message: string }).message))
        .toEqual(['prior failed', 'new start failed']);
    } finally { await f.session.close(); }
  });

  it('preserves a genuine accepted error after consuming the prior idle tail', async () => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
      // Session consumes this as N's idle tail without fanning it out to N+1.
      await new Promise<void>(resolve => setImmediate(resolve));
      f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'second failed' } } });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'error', generation: 2 }));
      expect(f.controller.hasActiveTurn()).toBe(false);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ message: 'second failed' }) }),
      ]);
    } finally { await f.session.close(); }
  });

  it('does not adopt a prior error when idle was consumed before the new send', async () => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
      await new Promise<void>(resolve => setImmediate(resolve));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'prior failed' } } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_closed' }) }),
      ]);
      expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'error', generation: 2 });
    } finally { await f.session.close(); }
  });

  it('keeps the prior-error tail fence only until its own send is accepted', () => {
    const owner = new RemoteTurnTerminalOwnership();
    const error: AgentEvent = { type: 'error', source: 'codex', data: { isTerminal: true, message: 'prior failure' } };
    const done: AgentEvent = { type: 'done', source: 'codex', data: {} };
    owner.beginSend(false, 'first');
    expect(owner.observe(error)).toBe(true);
    owner.beginSend(false, 'second');
    owner.acceptSend('first');
    expect(owner.observe(done)).toBe(false);
    expect(owner.observe(error)).toBe(true);
    owner.beginSend(false, 'third');
    owner.acceptSend('third');
    expect(owner.observe(done)).toBe(true);
    owner.beginSend(true, 'fourth');
    owner.acceptSend('fourth');
    expect(owner.observe(done)).toBe(false);
    expect(owner.observe(error)).toBe(true);
    owner.observe({ type: 'text', source: 'codex', data: { text: 'automatic new turn' } });
    owner.beginSend(true, 'fifth');
    owner.acceptSend('fifth');
    expect(owner.observe(done)).toBe(false);
    owner.observe({ type: 'text', source: 'codex', data: { text: 'unfinished prior' } });
    owner.observe({ type: 'status', source: 'codex', data: { isRunning: false } });
    owner.beginSend(true, 'sixth');
    owner.acceptSend('sixth');
    expect(owner.observe(error)).toBe(false);
  });

  it('becomes quiet after an accepted result-only done following a terminal error', async () => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'error', source: 'codex', data: { isTerminal: true, message: 'prompt is too long' } } });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'error', generation: 1 }));
      // Codex idle releases Session's terminal-error drain without supplying
      // the missing paired done; keep the real send admission gate intact.
      f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: false } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'status')).toBe(true));
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      f.deliver({ t: 'event', event: { type: 'done', source: 'codex', data: {} } });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'done', generation: 2 }));
      expect(f.controller.hasActiveTurn()).toBe(false);
      expect(f.controller.isQuiet()).toBe(true);
      f.deliver({ t: 'closed', reason: 'ended' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toHaveLength(1);
      expect(f.restartRecovery).not.toHaveBeenCalled();
    } finally { await f.session.close(); }
  });

  it.each(['provider-restarting', 'error'])('does not recover when Stop follows a queued foreground event (%s)', async reason => {
    const f = fixture();
    let stop: Promise<unknown> | undefined;
    f.session.onEvent(event => {
      if (event.type === 'text') stop = f.session.abort().catch(() => undefined);
    });
    try {
      await f.session.send('work');
      f.client.onData(Buffer.from([
        JSON.stringify({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'queued body' } } }),
        JSON.stringify({ t: 'closed', reason }), '',
      ].join('\n')), false);
      await new Promise<void>(resolve => setImmediate(resolve));
      await stop;
      expect(f.restartRecovery).not.toHaveBeenCalled();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
      expect(f.controller.hasActiveTurn()).toBe(false);
    } finally { await f.session.close(); }
  });

  it('drains an interrupted send before a following runtime EOF clears its owner', async () => {
    const f = fixture();
    try {
      await f.session.send('work');
      f.controller.onInterrupted(f.restartRecovery);
      f.controller.onClosed('ended', undefined, f.client.runId);
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_restarted', isTerminal: true }) }),
      ]);
      expect(f.seen.filter(e => e.type === 'done')).toHaveLength(1);
      expect(f.restartRecovery).toHaveBeenCalledOnce();
    } finally { await f.session.close(); }
  });

  it.each(['done', 'provider-error', 'quota-error'])('preserves a queued current %s before provider restart', async terminal => {
    const f = fixture();
    try {
      await f.session.send('work');
      const event: AgentEvent = terminal === 'done'
        ? { type: 'done', source: 'codex', data: { status: 'completed' } }
        : { type: 'error', source: 'codex', data: { message: 'original provider detail', reason: terminal,
          isTerminal: true, ...(terminal === 'quota-error' ? { resetAt: 1234567890 } : {}) } };
      // One poll payload: no iterator turn between the terminal and restart.
      f.client.onData(Buffer.from([JSON.stringify({ t: 'event', event }),
        JSON.stringify({ t: 'closed', reason: 'provider-restarting' }), ''].join('\n')), false);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.seen.filter(e => e.type === 'error')).toEqual(terminal === 'done' ? [] : [expect.objectContaining({ data: event.data })]);
      expect(f.seen.filter(e => e.type === 'done')).toHaveLength(terminal === 'done' ? 1 : 0);
      expect(f.session.getObservedCurrentTurnTerminal().kind).toBe(terminal === 'done' ? 'done' : 'error');
      expect(f.dispose).not.toHaveBeenCalled();
      expect(f.restartRecovery).not.toHaveBeenCalled();
    } finally { await f.session.close(); }
  });

  it.each(['none', 'done', 'error'])('keeps restart failure for the new send after prior %s', async tail => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      if (tail !== 'none') f.deliver({ t: 'event', event: { type: tail, source: 'codex',
        data: { reason: 'prior tail', ...(tail === 'error' ? { message: 'old failure', isTerminal: true } : {}) } } });
      f.deliver({ t: 'closed', reason: 'provider-restarting' });
      await vi.waitFor(() => expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_restarted', isTerminal: true }) }),
      ]));
      expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ generation: 2, kind: 'error' });
      expect(f.dispose).not.toHaveBeenCalled();
      expect(f.restartRecovery).toHaveBeenCalledOnce();
    } finally { await f.session.close(); }
  });

  it.each(['ended', 'closed', 'detached'])('preserves %s instead of inventing an event loop crash', async reason => {
    const f = fixture();
    try {
      expect(await f.session.send('work')).toMatchObject({ accepted: true });
      // The provider may report idle before its terminal event arrives.
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(f.controller.hasActiveTurn()).toBe(true);
      if (reason === 'ended') f.client.onData(Buffer.alloc(0), true);
      else f.deliver({ t: 'closed', reason, error: { code: 'REMOTE_AGENT_UNAVAILABLE', message: 'peer close detail' } });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ isTerminal: true, reason: 'remote_agent_closed',
          remoteCloseReason: reason, remoteRunId: f.client.runId,
          sdkError: expect.stringContaining(f.client.runId) }) }),
      ]);
      if (reason !== 'ended') expect(f.seen.find(e => e.type === 'error')?.data).toMatchObject({ message: 'peer close detail' });
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.invoke.mock.calls.filter(([args]) => (args[0] as { method?: string }).method === 'send')).toHaveLength(1);
    } finally { await f.session.close(); }
  });

  it.each(['ended', 'error', 'superseded'])('preserves the close terminal while send awaits its RPC result (%s)', async reason => {
    const f = fixture();
    try {
      f.invoke.mockImplementationOnce(async () => {
        f.deliver({ t: 'closed', reason });
        return {};
      });
      // EOF before the RPC acknowledgement cannot prove provider acceptance.
      await expect(f.session.send('work')).rejects.toThrow('terminated before provider acceptance could be reconciled');
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual(reason === 'superseded' ? [] : [
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_closed',
          remoteCloseReason: reason, remoteRunId: f.client.runId }) }),
      ]);
      if (reason === 'superseded') expect(f.seen).toContainEqual(expect.objectContaining({ type: 'done',
        data: expect.objectContaining({ status: 'cancelled' }) }));
    } finally { await f.session.close(); }
  });

  it.each(['done', 'terminal-error', 'abort', 'close', 'superseded'])('does not add a remote failure after %s', async mode => {
    const f = fixture();
    try {
      await f.session.send('work');
      if (mode === 'done') f.deliver({ t: 'event', event: { type: 'done', data: { status: 'completed' }, source: 'codex' } });
      if (mode === 'terminal-error') f.deliver({ t: 'event', event: { type: 'error', data: {
        message: 'provider failure', reason: 'provider-error', isTerminal: true,
      }, source: 'codex' } });
      if (mode === 'abort') {
        await f.session.abort();
        f.deliver({ t: 'state', state: { turnRunning: true } });
      }
      if (mode === 'close') await f.session.close();
      else f.deliver({ t: 'closed', reason: mode === 'superseded' ? 'superseded' : 'ended' });
      await f.finish();
      const errors = f.seen.filter(e => e.type === 'error');
      // Session owns explicit mid-turn close and its existing fallback receipt.
      expect(errors).toHaveLength(mode === 'terminal-error' || mode === 'close' ? 1 : 0);
      expect(errors.some(event => (event.data as { reason?: string }).reason === 'remote_agent_closed')).toBe(false);
      if (mode === 'terminal-error') expect(errors[0].data).toMatchObject({ reason: 'provider-error', message: 'provider failure' });
      if (mode === 'abort') expect(f.seen).toContainEqual(expect.objectContaining({ type: 'done',
        data: expect.objectContaining({ status: 'cancelled' }) }));
      if (mode === 'superseded') expect(f.seen).toContainEqual(expect.objectContaining({ type: 'done',
        data: expect.objectContaining({ status: 'cancelled' }) }));
    } finally { await f.session.close(); }
  });

  it('reports a genuine early close on a new send after cancellation', async () => {
    const f = fixture();
    try {
      await f.session.send('first');
      await f.session.abort();
      f.deliver({ t: 'event', event: { type: 'done', data: { status: 'cancelled' }, source: 'codex' } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'done')).toBe(true));
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      f.client.onData(Buffer.alloc(0), true);
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_closed' }) }),
      ]);
    } finally { await f.session.close(); }
  });

  it.each([{ reason: 'ended', tail: 'done' }, { reason: 'error', tail: 'done' }, { reason: 'ended', tail: false },
    { reason: 'error', tail: 'error' }, { reason: 'ended', tail: 'done', immediate: true }])(
    'keeps the new send close after an unsettled prior turn ($reason, tail=$tail)', async ({ reason, tail, immediate }) => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      if (tail) f.deliver({ t: 'event', event: { type: tail === 'error' ? 'error' : 'done', source: 'codex',
        data: { reason: 'prior tail', ...(tail === 'error' ? { message: 'old failure', isTerminal: true } : {}) } } });
      if (!immediate) await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.session.getObservedCurrentTurnTerminal()).toEqual({ kind: 'none' });
      f.deliver({ t: 'closed', reason });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_closed',
          remoteCloseReason: reason, remoteRunId: f.client.runId }) }),
      ]);
    } finally { await f.session.close(); }
  });

  it.each(['completed-prior', 'silent-stop', 'unsettled-prior'])('keeps a zero-output current done valid (%s)', async mode => {
    const f = fixture();
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'text', source: 'codex', data: { text: 'first progress' } } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'text')).toBe(true));
      if (mode === 'completed-prior') {
        f.deliver({ t: 'event', event: { type: 'done', source: 'codex', data: {} } });
        await vi.waitFor(() => expect(f.seen.some(e => e.type === 'done')).toBe(true));
      }
      f.deliver({ t: 'state', state: { turnRunning: false } });
      expect(await f.session.send('second')).toMatchObject({ accepted: true });
      if (mode === 'unsettled-prior') {
        // The first running may release next() that was already waiting on N.
        f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: true } } });
        await vi.waitFor(() => expect(f.seen.some(e => e.type === 'status')).toBe(true));
      }
      f.deliver({ t: 'event', event: { type: 'status', source: 'codex', data: { isRunning: true } } });
      f.deliver({ t: 'event', event: { type: 'done', source: 'codex',
        data: mode === 'silent-stop' ? { silentStop: true } : {} } });
      await vi.waitFor(() => expect(f.session.getObservedCurrentTurnTerminal()).toMatchObject({ kind: 'done', generation: 2 }));
      f.deliver({ t: 'closed', reason: 'error' });
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
    } finally { await f.session.close(); }
  });

  it('ignores background terminals and nonterminal errors when deciding whether EOF is expected', async () => {
    const f = fixture();
    try {
      await f.session.send('work');
      f.deliver({ t: 'event', event: { type: 'done', turnScope: 'background', data: {}, source: 'codex' } });
      f.deliver({ t: 'event', event: { type: 'error', data: { message: 'retrying', isTerminal: false }, source: 'codex' } });
      f.client.onData(Buffer.alloc(0), true);
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error' && (e.data as { isTerminal?: boolean }).isTerminal))
        .toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_closed' }) })]);
    } finally { await f.session.close(); }
  });

  it('does not replace a completed result with a late busy snapshot or duplicate close', async () => {
    const f = fixture();
    try {
      await f.session.send('work');
      f.deliver({ t: 'event', event: { type: 'done', data: { status: 'completed' }, source: 'codex' } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'done')).toBe(true));
      f.deliver({ t: 'event', event: { type: 'text', turnScope: 'background', data: { text: 'background output' }, source: 'codex' } });
      f.deliver({ t: 'event', event: { type: 'text', agentMeta: { parentUuid: 'child-task' }, data: { text: 'child output' }, source: 'codex' } });
      f.deliver({ t: 'state', state: { turnRunning: true } });
      expect(f.controller.hasActiveTurn()).toBe(false);
      f.deliver({ t: 'closed', reason: 'error' });
      f.controller.onClosed('error', 'duplicate', f.client.runId);
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([]);
      expect(f.seen.filter(e => e.type === 'done')).toHaveLength(1);
      expect(f.dispose).toHaveBeenCalledOnce();
    } finally { await f.session.close(); }
  });

  it.each(['send', 'provider-start', 'provider-progress'])('tracks a new %s after an earlier completed turn', async mode => {
    const f = fixture(mode === 'provider-start' ? 'claude-code' : 'codex');
    try {
      await f.session.send('first');
      f.deliver({ t: 'event', event: { type: 'done', data: { status: 'completed' }, source: 'codex' } });
      await vi.waitFor(() => expect(f.seen.some(e => e.type === 'done')).toBe(true));
      if (mode === 'send') expect(await f.session.send('second')).toMatchObject({ accepted: true });
      else if (mode === 'provider-progress') f.deliver({ t: 'event', event: { type: 'text', source: 'codex',
        data: { text: 'automatic continuation' } } });
      else f.deliver({ t: 'event', event: { type: 'status', source: 'claude-code',
        data: { isRunning: true, providerInitiatedTurn: true } } });
      f.client.onData(Buffer.alloc(0), true);
      await f.finish();
      expect(f.seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_closed' }) }),
      ]);
    } finally { await f.session.close(); }
  });
});
