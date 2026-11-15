import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { isOrdinaryRemoteTurnSession, projectActiveRuntimeSummary, REMOTE_STOP_TURN, RemoteTurnControl, remoteTurnInputBoundary } from '../remoteTurnControl.js';

function fakeRuntime(generation: number) {
  return {
    generation,
    instanceId: 'runtime-1',
    running: true,
    isTurnRunning() { return this.running; },
    getTurnGeneration() { return this.generation; },
  };
}

describe('remote turn control admission', () => {
  it('requires the exact controller, runtime and turn, and admits a single stop', () => {
    const current = fakeRuntime(1);
    const replacement = fakeRuntime(1);
    const authority = new RemoteTurnControl<ReturnType<typeof fakeRuntime>>();
    const first = authority.token(current, 'controller-one');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(authority.token(current, 'controller-one')).toBe(first);
    expect(authority.consume(current, 'controller-two', first)).toBe(false);
    expect(authority.consume(replacement, 'controller-one', first)).toBe(false);
    current.generation = 2;
    expect(authority.consume(current, 'controller-one', first)).toBe(false);
    const second = authority.token(current, 'controller-one');
    const alternate = authority.token(current, 'controller-two');
    expect(authority.consume(current, 'controller-one', second)).toBe(true);
    expect(authority.consume(current, 'controller-one', second)).toBe(false);
    expect(authority.consume(current, 'controller-two', alternate)).toBe(false);
    expect(authority.token(current, 'controller-one')).toBeUndefined();
    current.generation = 3;
    expect(authority.token(current, 'controller-one')).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['claude-code', { terminal_reason: 'aborted_streaming', stop_reason: 'tool_use', is_error: true }],
    ['codex', { cancelled: true, raw: { status: 'interrupted' } }],
    ['pi', { type: 'pi/agent_settled', status: 'cancelled' }],
  ])('reports an exact native %s terminal after stop admission', (source, data) => {
    const runtime = fakeRuntime(2);
    const authority = new RemoteTurnControl<ReturnType<typeof fakeRuntime>>();
    const event = { type: 'done', source, data, sessionInstanceId: runtime.instanceId, sessionTurnGeneration: 2 };
    const token = authority.token(runtime, 'controller');
    authority.observeTerminal(runtime, event);
    expect(authority.consume(runtime, 'controller', token)).toBe(true);
    runtime.running = false;
    authority.observeTerminal(runtime, { ...event, sessionTurnGeneration: 1 });
    authority.observeTerminal(runtime, { ...event, sessionInstanceId: 'replaced-runtime' });
    authority.observeTerminal(runtime, { ...event, turnScope: 'background' });
    authority.observeTerminal(runtime, { ...event, data: { terminal_reason: 'api_error', is_error: true } });
    authority.observeTerminal(runtime, { ...event, data: { cancelled: true, status: 'cancelled' } });
    expect(authority.outcome(runtime)).toBeUndefined();
    authority.observeTerminal(runtime, event);
    expect(authority.outcome(runtime)).toBe('interrupted');
    runtime.generation = 3;
    expect(authority.outcome(runtime)).toBeUndefined();
  });

  it('rejects an idle turn and invalid token without consuming live authority', () => {
    const runtime = fakeRuntime(1);
    const authority = new RemoteTurnControl<ReturnType<typeof fakeRuntime>>();
    const token = authority.token(runtime, 'controller');
    expect(authority.consume(runtime, 'controller', 'unknown')).toBe(false);
    runtime.running = false;
    expect(authority.consume(runtime, 'controller', token)).toBe(false);
    expect(authority.token(runtime, 'controller')).toBeUndefined();
  });

  it('admits only active local desktop sessions for token issuance and stop', () => {
    const ordinary = { status: 'active', source: 'desktop' };
    expect(isOrdinaryRemoteTurnSession(ordinary)).toBe(true);
    for (const excluded of [
      { status: 'archived' }, { source: 'review' }, { remoteHostId: 'host' },
      { agentDeviceId: 'device' }, { orcaRole: 'worker' }, { orcaRemoteLead: 'lead' },
    ]) {
      expect(isOrdinaryRemoteTurnSession({ ...ordinary, ...excluded })).toBe(false);
    }
  });

  it('withholds authority during clear and rejects an old token after the clear commits', () => {
    const runtime = fakeRuntime(1);
    const authority = new RemoteTurnControl<ReturnType<typeof fakeRuntime>>();
    const before = { generation: 0, clearInFlight: false, observedClear: null, persistedClear: null };
    const original = remoteTurnInputBoundary(before)!;
    const oldToken = authority.token(runtime, 'controller', original);
    const pending = { generation: 1, clearInFlight: true, observedClear: 100, persistedClear: null };
    expect(remoteTurnInputBoundary(pending)).toBeUndefined();
    expect(remoteTurnInputBoundary({ ...pending, clearInFlight: false })).toBeUndefined();
    const after = remoteTurnInputBoundary({ ...pending, clearInFlight: false, persistedClear: 100 })!;
    expect(authority.consume(runtime, 'controller', oldToken, after)).toBe(false);
    const newToken = authority.token(runtime, 'controller', after);
    expect(authority.consume(runtime, 'controller', newToken, after)).toBe(true);
  });

  it('carries a running turn token only for a negotiated same-account snapshot', () => {
    const token = 'a'.repeat(64);
    const snapshot = { format: 'active-sessions-v2', turnControlVersion: 1, sessions: [
      { sessionId: 'active', isTurnRunning: true, turnControlToken: token },
      { sessionId: 'idle', isTurnRunning: false, turnControlToken: token, turnControlOutcome: 'interrupted' },
    ] };
    const args = [{ summary: true, snapshotVersion: 2, turnControlVersion: 1 }];
    const projected = projectActiveRuntimeSummary(snapshot, args[0], true);
    expect(projected).toEqual({ format: snapshot.format, turnControlVersion: 1, sessions: [
      snapshot.sessions[0], { sessionId: 'idle', isTurnRunning: false, turnControlOutcome: 'interrupted' },
    ] });
    const stripped = { format: snapshot.format, sessions: [
      { sessionId: 'active', isTurnRunning: true }, { sessionId: 'idle', isTurnRunning: false },
    ] };
    expect(projectActiveRuntimeSummary(snapshot, args[0], false)).toEqual(stripped);
    expect(projectActiveRuntimeSummary(snapshot, { summary: true, snapshotVersion: 2 }, true)).toEqual(stripped);
  });
});

// Execute the registered closures with a fake IPC and DB, as other register.ts tests do.
describe('remote turn control IPC', () => {
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const block = (from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error('Stop IPC test anchor missing');
    return source.slice(start, end);
  };
  const code = ts.transpileModule([
    block('  const readRemoteStopBoundary = ', '  ipcMain.handle(MAKER_INVOKE.INPUT_RESUME,'),
    block('  ipcMain.handle(MAKER_INVOKE.LIST_ACTIVE,', '    MAKER_INVOKE.RESOLVE_INTERACTION,')
      .split('\n  ipcMain.handle(\n').at(0),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  function fixture() {
    const sid = 'active-session';
    const runtime = { ...fakeRuntime(1), id: sid };
    const row = { id: sid, status: 'active', source: 'desktop', clearedAt: null as number | null };
    const state = { generation: 0, clearing: false, observedClear: null as number | null, authorized: true };
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const stopInput = vi.fn(() => ({ bookkeeping: Promise.resolve() }));
    const query = vi.fn(() => ({ from: () => ({ where: async () => [row] }) }));
    const owner = { client: { drizzle: { select: query } } };
    const caller = { channel: REMOTE_STOP_TURN, controllerDeviceId: 'controller',
      isCurrentController: () => state.authorized };
    const getInputSessionRow = vi.fn(async () => row);
    const bindings = {
      ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
      MAKER_INVOKE: { LIST_ACTIVE: 'list-active' },
      REMOTE_STOP_TURN,
      getDeviceLinkInvokeContext: () => caller,
      requireSessionId: (value: unknown) => value,
      throwIpcError: (error: string) => { throw new Error(error); },
      assertRemoteInputClearNotInFlight: () => {
        if (state.clearing) throw new Error('Clear is still sealing');
      },
      inputCoordinator: {
        getGeneration: () => state.generation,
        isGenerationCurrent: (_id: string, generation: number) => generation === state.generation,
        getClearBoundaryMs: () => state.observedClear,
      },
      getCurrentDbClientSnapshot: () => owner,
      getInputSessionRow,
      isSessionHiddenSync: () => false,
      hasLocalAgentVisibleRuntime: () => false,
      getStableSessionForTurnBoundary: () => runtime,
      inputClearInFlightSessions: { has: () => state.clearing },
      normalizeAgentInputClearBoundaryMs: (value: unknown) => value,
      isOrdinaryRemoteTurnSession,
      remoteTurnInputBoundary,
      remoteTurnControl: new RemoteTurnControl<typeof runtime>(),
      maker: { listActiveSessions: () => [runtime] },
      sessions: { id: 'id', status: 'status', source: 'source' },
      inArray: () => undefined,
      getAgentIslandService: () => undefined,
      stopInput,
    };
    new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    const snapshot = (opts: unknown) => handlers.get('list-active')!(null, opts);
    const negotiated = () => snapshot({ summary: true, snapshotVersion: 2, turnControlVersion: 1 }) as
      Promise<{ sessions: Array<{ turnControlToken?: string }> }>;
    const stop = (token: unknown) => handlers.get(REMOTE_STOP_TURN)!(null, sid, token);
    return { row, state, query, getInputSessionRow, snapshot, negotiated, stop, stopInput };
  }

  it('looks up eligibility only for negotiated snapshots and withholds authority from Review', async () => {
    const host = fixture();
    await host.snapshot({ summary: true, snapshotVersion: 2 });
    expect(host.query).not.toHaveBeenCalled();
    expect((await host.negotiated()).sessions[0].turnControlToken).toMatch(/^[a-f0-9]{64}$/);
    expect(host.query).toHaveBeenCalledTimes(1);
    host.row.source = 'review';
    expect((await host.negotiated()).sessions[0].turnControlToken).toBeUndefined();
  });

  it('rejects a stop whose authority changes during the database read', async () => {
    const host = fixture();
    const token = (await host.negotiated()).sessions[0].turnControlToken;
    host.getInputSessionRow.mockImplementationOnce(async () => {
      host.state.generation++;
      host.state.clearing = true;
      host.state.observedClear = 100;
      return host.row;
    });
    await expect(host.stop(token)).rejects.toThrow('PRECONDITION_FAILED');
    expect(host.stopInput).not.toHaveBeenCalled();
    host.state.clearing = false;
    host.row.clearedAt = 100;
    await expect(host.stop(token)).resolves.toMatchObject({ accepted: false });
    const fresh = (await host.negotiated()).sessions[0].turnControlToken;
    host.getInputSessionRow.mockImplementationOnce(async () => {
      host.state.authorized = false;
      return host.row;
    });
    await expect(host.stop(fresh)).rejects.toThrow('PRECONDITION_FAILED');
    expect(host.stopInput).not.toHaveBeenCalled();
    host.state.authorized = true;
    await expect(host.stop(fresh)).resolves.toMatchObject({ accepted: true });
    expect(host.stopInput).toHaveBeenCalledWith('active-session', true, { keepQueue: true, pauseQueue: true });
  });
});
