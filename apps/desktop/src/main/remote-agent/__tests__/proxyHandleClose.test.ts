/** Real transport -> proxy -> Session regression; only peer IO is in memory. */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Session, type AgentEvent } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteAgentHandle, type RemoteAgentHandleController } from '../controller/proxyHandle';
import { RemoteAgentRunClient } from '../controller/runClient';
import type { RemoteAgentPoller } from '../controller/poller';
import { ExecutorWorkspace } from '../executor/workspace';

function fixture(agentKind: 'codex' | 'claude-code' = 'codex') {
  let controller!: RemoteAgentHandleController;
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
    onClosed: (reason, error) => controller.onClosed(reason, error?.message, client.runId),
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
  return { controller, client, session, seen, deliver, finish, dispose, invoke };
}

describe('remote stream close settles the product turn', () => {
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
