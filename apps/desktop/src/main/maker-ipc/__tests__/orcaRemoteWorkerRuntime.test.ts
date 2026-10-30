import { describe, expect, it, vi } from 'vitest';
import { remoteOrcaInputDigest, createRemoteOrcaInputAdmission } from '../orcaRemoteInputProvenance.js';
import { stampTrustedDesktopQueuedOrigin } from '../makerSendTransaction.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { AgentInputProjection } from '../../../shared/agentInputQueue.js';

import {
  createOrcaRemoteWorkerRuntime,
  type OrcaRemoteWorkerRuntimeDeps,
  type RemoteWorkerRef,
  type RemoteWorkerTurnEnd,
} from '../orcaRemoteWorkerRuntime.js';

const ref: RemoteWorkerRef = {
  workerId: 'worker-1',
  teamId: 'team-1',
  leadSessionId: 'lead-1',
  proxySessionId: 'proxy-1',
  deviceId: 'mac-mini',
  remoteSessionId: 'remote-1',
  lastBridgedMessageId: null,
};

interface FakeHistoryMessage {
  id: string;
  clientId?: string;
  role: 'user' | 'assistant';
  content: unknown;
  agentMeta?: { parentUuid?: string; autoResume?: boolean };
}

interface FakeDevice {
  agentKind?: string;
  offline: boolean;
  running: boolean;
  receipts: Record<string, string>;
  acceptedAgents: Record<string, string>;
  assistant: { id: string; content: unknown } | null;
  terminalError: boolean;
  inputProjection?: Partial<AgentInputProjection>;
  history?: FakeHistoryMessage[];
  enqueueError?: Error & { inFlight?: boolean };
  enqueued: unknown[];
  aborted: number;
  released: number;
}

function setup(device: Partial<FakeDevice> = {}) {
  const state: FakeDevice = {
    offline: false,
    running: false,
    receipts: {},
    acceptedAgents: {},
    assistant: { id: 'msg-0', content: '旧回复' },
    terminalError: false,
    enqueued: [],
    aborted: 0,
    released: 0,
    ...device,
  };
  const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]): Promise<unknown> => {
    if (state.offline) throw new Error('[DEVICE_OFFLINE] target offline');
    switch (channel) {
      case 'maker:list-active':
        return {
          format: 'active-sessions-v2',
          sessions: [{ sessionId: 'remote-1', isTurnRunning: state.running }],
        };
      case 'local-db:sessions:get':
        return {
          id: 'remote-1',
          status: 'active',
          agentKind: state.agentKind ?? 'cc',
          workingDir: '/Users/demo/Interviews',
          model: 'claude-opus-5-5',
          effort: 'high',
          permissionMode: 'auto',
          fastMode: false,
          sdkSessionId: 'sdk-1',
        };
      case 'local-db:history:messages': {
        // 与运行设备的入参校验一致(localDb/ipc/history.ts)。
        const limit = (args[0] as { contentCharLimit?: number | null }).contentCharLimit;
        if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 8_000)) {
          throw new Error('[INVALID_PARAMS] contentCharLimit must be an integer between 1 and 8000 or null');
        }
        const inputs = Object.entries(state.receipts)
          .filter(([, delivery]) => delivery === 'accepted')
          .map(([clientId]) => ({ id: `input-${clientId}`, clientId, role: 'user' as const, content: 'Lead input' }));
        const assistant = state.assistant ? [{ ...state.assistant, role: 'assistant' as const }] : [];
        const history = state.history ?? (state.assistant?.id === 'msg-0'
          ? [...assistant, ...inputs] : [...inputs, ...assistant]);
        const request = args[0] as { roles: string[]; limit: number; cursor: { id: string } | null };
        const rows = history.filter((row) => request.roles.includes(row.role)).slice().reverse();
        const start = request.cursor ? rows.findIndex((row) => row.id === request.cursor!.id) + 1 : 0;
        const items = rows.slice(start, start + request.limit);
        const hasMore = start + items.length < rows.length;
        return {
          items,
          hasMore,
          nextCursor: hasMore ? { id: items.at(-1)!.id, createdAt: 0 } : null,
          terminal: state.terminalError ? { status: 'error' } : null,
        };
      }
      case 'maker:input:enqueue':
        if (state.enqueueError) throw state.enqueueError;
        state.enqueued.push(args[1]);
        state.receipts[(args[1] as { clientId: string }).clientId] = 'pending';
        return {};
      case 'local-db:messages:around-client-id': {
        const clientId = args[1] as string;
        const agentKind = state.acceptedAgents[clientId];
        return agentKind ? [{ clientId, role: 'user', agentKind }] : [];
      }
      case 'maker:input:get-projection': {
        const ids = (args[1] as { deliveryClientIds: string[] }).deliveryClientIds;
        return {
          ...state.inputProjection,
          deliveryReceipts: ids.map((clientId) => ({
            clientId,
            state: state.receipts[clientId] ?? 'unknown',
          })),
        };
      }
      case 'maker:abort-session':
        state.aborted += 1;
        return undefined;
      case 'maker:orca:remote-worker:release':
        state.released += 1;
        return { released: true };
      default:
        throw new Error(`[CHANNEL_NOT_ALLOWED] ${channel}`);
    }
  });
  const onTurnEnded = vi.fn(async (_proxySessionId: string, _turn: RemoteWorkerTurnEnd) => true);
  const deps: OrcaRemoteWorkerRuntimeDeps = {
    invoke,
    deviceName: () => 'Mac mini',
    saveReport: vi.fn(async () => undefined),
    onTurnStarted: vi.fn(async () => undefined),
    captureTurnEnded: (proxySessionId) => (turn) => onTurnEnded(proxySessionId, turn),
    onWorkerStateChanged: vi.fn(),
    now: () => Date.parse('2026-10-09T10:24:00Z'),
    setTimeout: vi.fn(() => ({})),
    clearTimeout: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const coreRuntime = createOrcaRemoteWorkerRuntime(deps);
  coreRuntime.track(ref);
  const runtime = { ...coreRuntime, dispatch: async (params: Parameters<typeof coreRuntime.dispatch>[0]) => {
    const result = await coreRuntime.dispatch(params);
    if (result.ok) coreRuntime.confirmDispatchAccepted(params.proxySessionId, params.clientId);
    return result;
  } };
  return { runtime, coreRuntime, deps: { ...deps, onTurnEnded }, state, invoke };
}

describe('orca remote worker runtime', () => {
  it('admits only its exact in-flight input and expires proof after the RPC', async () => {
    const h = setup();
    const original = h.invoke.getMockImplementation()!;
    let digest = '';
    h.invoke.mockImplementation(async (device, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        const raw = args[1] as AgentInputQueuedMessage;
        digest = remoteOrcaInputDigest(raw);
        expect(h.runtime.verifyInput(device, 'remote-1', 'proof-1', digest, 'lead-1', 'team-1')).toBe(true);
        expect(h.runtime.verifyInput('other-device', 'remote-1', 'proof-1', digest, 'lead-1', 'team-1')).toBe(false);
        expect(h.runtime.verifyInput(device, 'remote-1', 'proof-1', digest, 'other-lead', 'team-1')).toBe(false);
        expect(h.runtime.verifyInput(device, 'remote-1', 'proof-1', digest, 'lead-1', 'other-team')).toBe(false);
        expect(h.runtime.verifyInput(device, 'other-task', 'proof-1', digest, 'lead-1', 'team-1')).toBe(false);
        expect(h.runtime.verifyInput(device, 'remote-1', 'proof-1', remoteOrcaInputDigest({ ...raw, text: 'forged' }), 'lead-1', 'team-1')).toBe(false);
        const admit = createRemoteOrcaInputAdmission({
          owner: () => 1, caller: () => ({ controllerDeviceId: 'lead-pc' }),
          readSession: async () => ({ status: 'active', orcaRemoteLead: {
            leadDeviceId: 'lead-pc', leadDeviceName: 'PC', leadSessionId: 'lead-1', leadTitle: 'Lead', workerLabel: 'worker',
          } }),
          invoke: async (_device, _channel, proof) => ({ ok: true,
            result: h.runtime.verifyInput(device, proof[0], proof[1], proof[2], proof[3], 'team-1') }),
        });
        const clean = stampTrustedDesktopQueuedOrigin(raw, true);
        expect(clean.origin).toBeUndefined();
        expect((await admit('remote-1', raw, clean)).origin?.kind).toBe('orca');
      }
      return original(device, channel, args);
    });
    await h.runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'proof-1' });
    expect(h.runtime.verifyInput('mac-mini', 'remote-1', 'proof-1', digest, 'lead-1', 'team-1')).toBe(false);
  });

  it('revokes input proof on untracking and failed delivery', async () => {
    const h = setup();const original = h.invoke.getMockImplementation()!;
    let digest = '';
    h.invoke.mockImplementation(async (device, channel, args) => {
      if (channel === 'maker:input:enqueue') {
        digest = remoteOrcaInputDigest(args[1]);
        expect(h.runtime.verifyInput(device, 'remote-1', 'proof-fail', digest, 'lead-1', 'team-1')).toBe(true);
        h.runtime.untrack('proxy-1');
        expect(h.runtime.verifyInput(device, 'remote-1', 'proof-fail', digest, 'lead-1', 'team-1')).toBe(false);
        throw new Error('transport failed');
      }
      return original(device, channel, args);
    });
    await h.runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'proof-fail' });
    expect(h.runtime.verifyInput('mac-mini', 'remote-1', 'proof-fail', digest, 'lead-1', 'team-1')).toBe(false);
  });

  it('enqueues a Lead message on the execution device with the device task’s own settings', async () => {
    const { runtime, state } = setup();
    await expect(
      runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写这段访谈', clientId: 'c-1' }),
    ).resolves.toEqual({ ok: true, mode: 'queued', agentKind: 'claude-code' });
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toMatchObject({
      clientId: 'c-1',
      durableDelivery: true,
      text: expect.stringContaining('[From Orca Lead]\n转写这段访谈'),
      origin: { kind: 'orca', senderLabel: 'Lead', displayText: '转写这段访谈' },
      createOpts: {
        agentKind: 'claude-code',
        workingDir: '/Users/demo/Interviews',
        model: 'claude-opus-5-5',
        resumeSessionId: 'sdk-1',
      },
    });
    expect((state.enqueued[0] as { text: string }).text).toContain('worker_id for tool calls is worker-1');
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  it('reports the turn start once and the final reply once after the message was consumed', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写', clientId: 'c-1' });

    state.running = true;
    state.receipts['c-1'] = 'accepted';
    await runtime.pollNow();
    await runtime.pollNow();
    expect(deps.onTurnStarted).toHaveBeenCalledTimes(1);
    expect(runtime.isTurnRunning('proxy-1')).toBe(true);

    state.running = false;
    state.assistant = { id: 'msg-1', content: [{ type: 'text', text: '逐字稿已生成' }] };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', {
      status: 'done',
      finalText: '逐字稿已生成',
    });
    expect(deps.saveReport).toHaveBeenCalledWith('worker-1', null, 'msg-1');
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);

    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledTimes(1);
  });

  // A manual bridge report must retire the same persisted poll identity, even before
  // the first running poll; otherwise the next poll reopens running and reports twice.
  it('retires a manual report before the first running poll without auto-reporting it again', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'report', clientId: 'c-1' });
    await expect(runtime.captureReportSettlement('proxy-1', ['c-1'])()).resolves.toBe(true);
    expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', null);
    state.running = true;
    await runtime.pollNow();
    state.running = false;
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'msg-1', content: 'already reported' };
    await runtime.pollNow();
    expect(deps.onTurnStarted).not.toHaveBeenCalled();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it('does not let an older manual report settle a newly dispatched task', async () => {
    const { runtime } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'old', clientId: 'c-1' });
    const settleOld = runtime.captureReportSettlement('proxy-1', ['c-1']);
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'new', clientId: 'c-2' });
    await expect(settleOld()).resolves.toBe(false);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  // Unit regression for the 2026-10-21 review: capture used to retire the whole A+B
  // group when A reported after B was already queued. The older test captured before B.
  // Public dispatch/settlement/poll must keep B's durable identity and deliver its result,
  // including after track restores the saved pending record; no timers or real device IO.
  it.each([false, true])('reports queued B after A reports, restored=%s', async (restore) => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'A', clientId: 'a' });
    state.receipts.a = 'accepted';
    state.running = true;
    await runtime.pollNow();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'B', clientId: 'b' });

    await expect(runtime.captureReportSettlement('proxy-1', ['a'])()).resolves.toBe(false);
    expect(state.receipts.b).toBe('pending');
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', {
      clientIds: ['b'], baselineMessageId: 'msg-0',
    });
    if (restore) {
      runtime.untrack('proxy-1');
      runtime.track({ ...ref, pendingReport: { clientIds: ['b'], baselineMessageId: 'msg-0' } });
    }
    state.receipts.b = 'accepted';
    state.running = false;
    state.assistant = { id: 'result-b', content: 'B completed' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', {
      status: 'done', finalText: 'B completed',
    });
  });

  it('waits for an in-flight running notification before settling a manual report', async () => {
    const { runtime, deps, state } = setup();
    let release!: () => void;
    vi.mocked(deps.onTurnStarted).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'report', clientId: 'c-1' });
    state.running = true;
    const poll = runtime.pollNow();
    await vi.waitFor(() => expect(deps.onTurnStarted).toHaveBeenCalledTimes(1));
    const settled = runtime.captureReportSettlement('proxy-1', ['c-1'])();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    release();
    await poll;
    await expect(settled).resolves.toBe(true);
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it('keeps automatic reporting when an older peer supplies no input identity', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'A', clientId: 'a' });
    await expect(runtime.captureReportSettlement('proxy-1')()).resolves.toBe(false);
    state.receipts.a = 'accepted';
    state.assistant = { id: 'result-a', content: 'A completed' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', {
      status: 'done', finalText: 'A completed',
    });
  });

  // The settlement save can overlap a new dispatch; its failed enqueue must not roll
  // back to already reported A. Public dispatch/poll and persisted state are the contract.
  it('does not resurrect reported A when B is prepared during settlement then rejected', async () => {
    const { runtime, deps, state, invoke } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'A', clientId: 'a' });
    let release!: () => void;
    vi.mocked(deps.saveReport).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const settle = runtime.captureReportSettlement('proxy-1', ['a'])();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    invoke.mockClear();
    const dispatch = runtime.dispatch({
      proxySessionId: 'proxy-1', rawContent: 'B', clientId: 'b',
      beforeEnqueue: () => { throw new Error('B rejected'); },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(ref.deviceId, 'local-db:sessions:get', ['remote-1']));
    release();
    await settle;
    expect(await dispatch).toMatchObject({ message: 'B rejected' });
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
    expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', null, undefined);
    state.receipts.a = 'accepted';
    state.assistant = { id: 'result-a', content: 'already reported' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
  });

  it('preserves automatic reporting when persisting manual settlement fails', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'report', clientId: 'c-1' });
    vi.mocked(deps.saveReport).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(runtime.captureReportSettlement('proxy-1', ['c-1'])()).rejects.toThrow('storage unavailable');
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'msg-1', content: 'result' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledTimes(1);
  });

  // The Team commit callback adds an asynchronous boundary to report retirement.
  // Public dispatch/settlement/poll must preserve B prepared while that callback waits;
  // the old save-only races did not exercise this boundary. Unit, no real IO/timers.
  it('preserves B prepared while the Team settlement is waiting', async () => {
    const { runtime, deps, invoke, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'A', clientId: 'a' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const settle = runtime.captureReportSettlement('proxy-1', ['a'], async commit => {
      entered(); await gate; await commit(true);
    })();
    try {
      await started;
      invoke.mockClear();
      const dispatch = runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'B', clientId: 'b' });
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(ref.deviceId, 'local-db:sessions:get', ['remote-1']));
      release();
      await expect(settle).resolves.toBe(false);
      await dispatch;
      expect(runtime.hasPendingReport('proxy-1')).toBe(true);
      expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', {
        clientIds: ['b'], baselineMessageId: 'msg-0',
      }, undefined);
      state.receipts.b = 'accepted';
      state.assistant = { id: 'result-b', content: 'B completed' };
      await runtime.pollNow();
      expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', {
        status: 'done', finalText: 'B completed',
      });
    } finally { release(); await settle; }
  });

  it('keeps waiting while the message is still queued behind other input on the device', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写', clientId: 'c-1' });
    state.assistant = { id: 'msg-user-turn', content: '插话的回复' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  it('does not report turns started by someone on the device itself', async () => {
    const { runtime, deps, state } = setup();
    state.running = true;
    await runtime.pollNow();
    expect(runtime.isTurnRunning('proxy-1')).toBe(true);
    state.running = false;
    state.assistant = { id: 'msg-9', content: '插话的回复' };
    await runtime.pollNow();
    expect(deps.onTurnStarted).not.toHaveBeenCalled();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
  });

  it('reports the Lead reply across pages instead of a later phone reply or its terminal error', async () => {
    const { runtime, deps, state, invoke } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      { id: 'lead-progress', role: 'assistant', content: 'Lead progress' },
      { id: 'lead-final', role: 'assistant', content: 'Lead final' },
      ...Array.from({ length: 80 }, (_, i): FakeHistoryMessage[] => [
        { id: `phone-input-${i}`, clientId: `phone-${i}`, role: 'user', content: 'Phone input' },
        { id: `phone-reply-${i}`, role: 'assistant', content: 'Phone reply' },
      ]).flat(),
    ];
    state.terminalError = true;
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Lead final' });
    expect(deps.saveReport).toHaveBeenCalledWith('worker-1', null, 'lead-final');
    expect(invoke.mock.calls.some(([, channel, args]) => channel === 'local-db:history:messages'
      && (args[0] as { cursor: unknown }).cursor !== null)).toBe(true);
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledTimes(1);
  });

  it('keeps awaiting when only the later phone input has a reply', async () => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      { id: 'phone-input', clientId: 'phone-1', role: 'user', content: 'Phone input' },
      { id: 'phone-reply', role: 'assistant', content: 'Phone reply' },
    ];
    state.terminalError = true;
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  it('continues a bounded history scan on the next poll instead of declaring a missing reply', async () => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Long task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'input-1', clientId: 'c-1', role: 'user', content: 'Long task' },
      ...Array.from({ length: 2001 }, (_, i): FakeHistoryMessage => ({
        id: `reply-${i}`, role: 'assistant', content: i === 2000 ? 'Final result' : 'Progress',
      })),
    ];
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Final result' });
  });

  it('discards a previous partial history scan when another dispatch is accepted', async () => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Long task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'input-1', clientId: 'c-1', role: 'user', content: 'Long task' },
      ...Array.from({ length: 2001 }, (_, i): FakeHistoryMessage => ({ id: `reply-${i}`, role: 'assistant', content: 'Old progress' })),
    ];
    await runtime.pollNow();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'New task', clientId: 'c-2' });
    state.receipts['c-2'] = 'accepted';
    state.history.push(
      { id: 'input-2', clientId: 'c-2', role: 'user', content: 'New task' },
      { id: 'reply-new', role: 'assistant', content: 'New result' },
    );
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledOnce();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'New result' });
  });

  it.each(['confirm', 'reject'])('ignores a stale accepted lifecycle %s while a newer dispatch is awaiting', async (action) => {
    const { coreRuntime, deps, state } = setup();
    await coreRuntime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'First', clientId: 'c-1' });
    await coreRuntime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Second', clientId: 'c-2' });
    if (action === 'confirm') coreRuntime.confirmDispatchAccepted('proxy-1', 'c-1');
    else coreRuntime.rejectDispatchAcceptance('proxy-1', 'c-1');
    state.receipts = { 'c-1': 'accepted', 'c-2': 'accepted' };
    state.assistant = { id: 'reply-2', content: 'Second result' };
    await coreRuntime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(coreRuntime.hasPendingReport('proxy-1')).toBe(true);
    coreRuntime.confirmDispatchAccepted('proxy-1', 'c-2');
    await coreRuntime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Second result' });
  });

  it('uses the latest accepted Lead input and ignores child Agent messages', async () => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'First task', clientId: 'c-1' });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Second task', clientId: 'c-2' });
    state.receipts = { 'c-1': 'accepted', 'c-2': 'accepted' };
    state.history = [
      { id: 'input-1', clientId: 'c-1', role: 'user', content: 'First task' },
      { id: 'reply-1', role: 'assistant', content: 'First reply' },
      { id: 'input-2', clientId: 'c-2', role: 'user', content: 'Second task' },
      { id: 'child-input', role: 'user', content: 'Child task', agentMeta: { parentUuid: 'subagent-tool' } },
      { id: 'reply-2', role: 'assistant', content: 'Second reply' },
      { id: 'child-reply', role: 'assistant', content: 'Child reply', agentMeta: { parentUuid: 'subagent-tool' } },
      { id: 'phone-input', clientId: 'phone-1', role: 'user', content: 'Phone input' },
      { id: 'phone-reply', role: 'assistant', content: 'Phone reply' },
    ];
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Second reply' });
    expect(deps.saveReport).toHaveBeenCalledWith('worker-1', null, 'reply-2');
  });

  it('reports the reply after an automatic continue (usage reset or provider group switch) as the Lead result', async () => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      { id: 'partial', role: 'assistant', content: 'Half done' },
      { id: 'continue', clientId: 'auto-1', role: 'user', content: 'Continue', agentMeta: { autoResume: true } },
      { id: 'final', role: 'assistant', content: 'Finished on another computer' },
    ];
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Finished on another computer' });
    expect(deps.saveReport).toHaveBeenCalledWith('worker-1', null, 'final');
  });

  // Test value: dispatch/pollNow must keep the Lead input through overload recovery
  // (Orca contract 5a and the 2026-10-21 capacity failure). The existing autoResume
  // test polls only after the final. These unit cases poll during recovery first;
  // they verify no premature report, then one recovered final or one surfaced error.
  const recoveryInfo = { attempt: 1, maxAttempts: 5, sessionTotal: 1 };
  const recoveringProjections: Array<{ phase: string; projection: Partial<AgentInputProjection> }> = [
    { phase: 'backoff', projection: { autoResumePending: recoveryInfo } },
    { phase: 'queued continuation', projection: { pendingQueue: [{
      clientId: 'continue-1', autoResume: true, retrySourceClientId: 'c-1',
    } as AgentInputProjection['pendingQueue'][number]] } },
    { phase: 'dispatch preparation', projection: { autoResumePending: recoveryInfo, turnInProgress: true } },
    { phase: 'vendor running after the idle snapshot', projection: { turnInProgress: true } },
    { phase: 'usage reset wait', projection: { usageLimitWait: { resumeAt: 1_900_000_000_000 } } },
    { phase: 'queued retry waiting for usage reset', projection: {
      usageLimitWait: { resumeAt: 1_900_000_000_000 },
      recovery: { kind: 'queue-head', clientId: 'retry-1' },
      pendingQueue: [{ clientId: 'retry-1', retrySourceClientId: 'c-1' } as AgentInputProjection['pendingQueue'][number]],
    } },
  ];
  it.each(recoveringProjections)('holds the dispatch during $phase and reports its recovered final once', async ({ projection }) => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      { id: 'partial', role: 'assistant', content: 'Progress before capacity error' },
    ];
    state.inputProjection = projection;
    state.terminalError = true;
    for (let i = 0; i < 16; i += 1) await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    state.inputProjection = { turnInProgress: false };
    state.terminalError = false;
    state.history.push(
      { id: 'continue', role: 'user', content: 'Continue', agentMeta: { autoResume: true } },
      { id: 'final', role: 'assistant', content: 'Recovered final' },
    );
    await runtime.pollNow();
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', { status: 'done', finalText: 'Recovered final' });
    expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', null, 'final');
  });

  it('reports a surfaced recovery failure once when the execution host gives up', async () => {
    const { runtime, deps, state } = setup({ inputProjection: { autoResumePending: recoveryInfo } });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.terminalError = true;
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    state.inputProjection = { turnInProgress: false };
    await runtime.pollNow();
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledOnce();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', expect.objectContaining({ status: 'error' }));
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it.each([false, true])('discards the old history candidate when recovery starts during the history read (paged=%s)', async paged => {
    const { runtime, deps, state, invoke } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'partial', content: 'Progress before capacity error' };
    if (paged) state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      ...Array.from({ length: 2001 }, (_, i): FakeHistoryMessage => ({ id: `partial-${i}`, role: 'assistant', content: 'Progress' })),
    ];
    const original = invoke.getMockImplementation()!;
    let inject = true;
    invoke.mockImplementation(async (deviceId, channel, args) => {
      const result = await original(deviceId, channel, args);
      if (inject && channel === 'local-db:history:messages' && (args[0] as { roles: string[] }).roles.includes('user')) {
        inject = false;
        state.inputProjection = { autoResumePending: recoveryInfo };
      }
      return result;
    });
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    state.inputProjection = {};
    state.assistant = { id: 'final', content: 'Recovered final' };
    state.history?.push({ id: 'final', role: 'assistant', content: 'Recovered final' });
    await runtime.pollNow();
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', { status: 'done', finalText: 'Recovered final' });
  });

  it('keeps a no-output recovery pending beyond the missing-reply budget', async () => {
    const { runtime, deps, state } = setup({ assistant: null });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.inputProjection = { autoResumePending: recoveryInfo };
    for (let i = 0; i < 16; i += 1) await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    state.inputProjection = {};
    state.assistant = { id: 'final', content: 'Recovered first reply' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', { status: 'done', finalText: 'Recovered first reply' });
  });

  it('keeps another Worker on the same execution device reporting while one is recovering', async () => {
    const { runtime, deps, state, invoke } = setup();
    const pendingReport = { clientIds: ['c-1'], baselineMessageId: null };
    runtime.untrack('proxy-1');
    runtime.track({ ...ref, pendingReport });
    runtime.track({ ...ref, workerId: 'worker-2', proxySessionId: 'proxy-2', remoteSessionId: 'remote-2', pendingReport });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'final', content: 'Other Worker result' };
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (deviceId, channel, args) => {
      const value = await original(deviceId, channel, args);
      return channel === 'maker:input:get-projection' && args[0] === 'remote-1'
        ? { ...(value as object), autoResumePending: recoveryInfo } : value;
    });
    await runtime.pollNow();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(runtime.hasPendingReport('proxy-2')).toBe(false);
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-2', { status: 'done', finalText: 'Other Worker result' });
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'maker:list-active')).toHaveLength(1);
    expect(invoke.mock.calls.some(([, channel]) => channel === 'maker:abort-session' || channel === 'maker:input:enqueue')).toBe(false);
  });

  it('does not hold an older completed Lead reply for a later phone input waiting to recover', async () => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      { id: 'lead-final', role: 'assistant', content: 'Lead final' },
      { id: 'phone-input', clientId: 'phone-1', role: 'user', content: 'Phone task' },
    ];
    state.inputProjection = {
      autoResumePending: recoveryInfo,
      recovery: { kind: 'active-turn', item: { clientId: 'phone-1' } as AgentInputProjection['pendingQueue'][number] },
      pendingQueue: [{ clientId: 'phone-continue', autoResume: true, retrySourceClientId: 'phone-1' } as AgentInputProjection['pendingQueue'][number]],
    };
    state.terminalError = true;
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', { status: 'done', finalText: 'Lead final' });
  });

  // PR #6787 / Orca contract 5a, unit: the active-turn case above misses a phone
  // input rejected before acceptance. pollNow must report the completed Lead input
  // once even while that unrelated queue head waits for its provider group quota.
  it.each([false, true])('reports a completed Lead reply while an unrelated queue head waits for quota (continuation=%s)', async continuation => {
    const { runtime, deps, state } = setup({ history: [] });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Lead task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.history = [
      { id: 'lead-input', clientId: 'c-1', role: 'user', content: 'Lead task' },
      { id: 'lead-final', role: 'assistant', content: 'Lead final' },
      ...(continuation ? [{ id: 'phone-input', clientId: 'phone-1', role: 'user' as const, content: 'Phone task' }] : []),
    ];
    const queued = continuation
      ? { clientId: 'phone-continue', autoResume: true, retrySourceClientId: 'phone-1' }
      : { clientId: 'phone-1' };
    state.inputProjection = {
      usageLimitWait: { resumeAt: 1_900_000_000_000 },
      recovery: { kind: 'queue-head', clientId: queued.clientId },
      pendingQueue: [queued as AgentInputProjection['pendingQueue'][number]],
    };
    await runtime.pollNow();
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledExactlyOnceWith('proxy-1', { status: 'done', finalText: 'Lead final' });
    expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', null, 'lead-final');
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it('retains a new dispatch accepted while reading the previous reply', async () => {
    const { runtime, deps, state, invoke } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'First task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'reply-1', content: 'First reply' };
    const originalInvoke = invoke.getMockImplementation()!;
    let injected = false;
    invoke.mockImplementation(async (deviceId, channel, args) => {
      if (!injected && channel === 'local-db:history:messages'
        && (args[0] as { roles: string[] }).roles.includes('user')) {
        injected = true;
        await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'Second task', clientId: 'c-2' });
      }
      return originalInvoke(deviceId, channel, args);
    });
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    state.receipts['c-2'] = 'accepted';
    state.assistant = { id: 'reply-2', content: 'Second reply' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Second reply' });
  });

  it('marks the device unreachable without failing the worker, then recovers and still reports', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写', clientId: 'c-1' });
    state.offline = true;
    await runtime.pollNow();
    expect(runtime.isReachable('proxy-1')).toBe(false);
    expect(deps.onWorkerStateChanged).toHaveBeenCalledWith('lead-1');
    expect(deps.onTurnEnded).not.toHaveBeenCalled();

    state.offline = false;
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'msg-1', content: '断线期间完成' };
    await runtime.pollNow();
    expect(runtime.isReachable('proxy-1')).toBe(true);
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', {
      status: 'done',
      finalText: '断线期间完成',
    });
  });

  it('fails a dispatch to an offline device instead of queueing it', async () => {
    const { runtime, state } = setup({ offline: true });
    const result = await runtime.dispatch({
      proxySessionId: 'proxy-1',
      rawContent: 'x',
      clientId: 'c-1',
    });
    expect(result).toMatchObject({ ok: false, code: 'DEVICE_UNREACHABLE' });
    expect(state.enqueued).toHaveLength(0);
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it.each(['cc', 'codex', 'pi'])('does not claim Agent %s accepted when the enqueue reply is lost and delivery is pending', async (agentKind) => {
    const lost = Object.assign(new Error('[INVOKE_TIMEOUT] no reply'), { inFlight: true });
    const { runtime, state, invoke } = setup({ agentKind, enqueueError: lost, receipts: { 'c-1': 'pending' } });
    await expect(
      runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' }),
    ).resolves.toEqual({ ok: true, mode: 'queued', agentKind: agentKind === 'cc' ? 'claude-code' : agentKind });
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'maker:input:enqueue')).toHaveLength(1);
    expect(state.enqueued).toHaveLength(0);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  const kinds = ['cc', 'codex', 'pi'] as const;
  it.each(kinds.flatMap(from => kinds.filter(to => to !== from).map(to => ({ from, to }))))(
    'reports the accepted input Agent after a pending $from → $to switch, even if the task switches again', async ({ from, to }) => {
      const { runtime, state, invoke } = setup({ agentKind: from });
      const original = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (deviceId, channel, args) => {
        const result = await original(deviceId, channel, args);
        if (channel === 'maker:input:enqueue') {
          state.acceptedAgents['c-1'] = to;
          state.receipts['c-1'] = 'accepted';
          state.agentKind = from; // A later switch must not relabel this accepted input.
        }
        return result;
      });
      await expect(runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' }))
        .resolves.toMatchObject({ ok: true, mode: 'dispatched', agentKind: to === 'cc' ? 'claude-code' : to });
      expect(state.enqueued[0]).toMatchObject({ createOpts: { agentKind: from === 'cc' ? 'claude-code' : from } });
      expect(invoke).toHaveBeenCalledWith('mac-mini', 'local-db:messages:around-client-id',
        ['remote-1', 'c-1', { radius: 0, contentCharLimit: 1 }]);
    },
  );

  it.each(['read-failed', 'old-peer', 'wrong-client', 'wrong-role'])('keeps delivered input queued when accepted-Agent evidence is %s', async reason => {
    const { runtime, state, invoke } = setup();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (deviceId, channel, args) => {
      if (channel === 'local-db:messages:around-client-id') {
        if (reason === 'read-failed') throw new Error('[INVOKE_TIMEOUT] no reply');
        return [{ clientId: reason === 'wrong-client' ? 'other' : 'c-1',
          role: reason === 'wrong-role' ? 'assistant' : 'user',
          ...(reason === 'old-peer' ? {} : { agentKind: 'pi' }) }];
      }
      return original(deviceId, channel, args);
    });
    await expect(runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' }))
      .resolves.toMatchObject({ ok: true, mode: 'queued' });
    expect(state.enqueued).toHaveLength(1);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(runtime.isReachable('proxy-1')).toBe(true);
  });

  it('recovers the accepting Agent after a lost enqueue acknowledgement without resending', async () => {
    const lost = Object.assign(new Error('[INVOKE_TIMEOUT] no reply'), { inFlight: true });
    const { runtime, invoke } = setup({ agentKind: 'cc', enqueueError: lost,
      receipts: { 'c-1': 'accepted' }, acceptedAgents: { 'c-1': 'pi' } });
    await expect(runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' }))
      .resolves.toMatchObject({ ok: true, mode: 'dispatched', agentKind: 'pi' });
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'maker:input:enqueue')).toHaveLength(1);
  });

  it('does not re-report an already bridged reply and ends with an error when no new reply appears', async () => {
    const { runtime, deps, state } = setup({ assistant: { id: 'msg-0', content: '旧回复' } });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    for (let i = 0; i < 14; i += 1) await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith(
      'proxy-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('reports an error turn when the device marks the session as failed', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.terminalError = true;
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith(
      'proxy-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('reports an error when the message was withdrawn on the device', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    state.receipts['c-1'] = 'removed';
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith(
      'proxy-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('aborts and releases through the device and treats an already-deleted task as released', async () => {
    const { runtime, state, invoke } = setup();
    await expect(runtime.abort('proxy-1')).resolves.toBe(true);
    expect(state.aborted).toBe(1);
    await expect(runtime.release(ref)).resolves.toBe(true);
    expect(state.released).toBe(1);
    invoke.mockRejectedValueOnce(new Error('[NOT_FOUND] gone'));
    await expect(runtime.release(ref)).resolves.toBe(true);
    state.offline = true;
    await expect(runtime.release(ref)).resolves.toBe(false);
  });

  it('learns the working directory on the device once for display', async () => {
    const { runtime, deps, invoke } = setup();
    expect(runtime.workingDir('proxy-1')).toBeNull();
    await runtime.pollNow();
    expect(runtime.workingDir('proxy-1')).toBe('/Users/demo/Interviews');
    expect(deps.onWorkerStateChanged).toHaveBeenCalledWith('lead-1');
    await runtime.pollNow();
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'local-db:sessions:get')).toHaveLength(1);
    runtime.track({ ...ref, proxySessionId: 'proxy-2' }, { workingDir: 'D:\\work' });
    expect(runtime.workingDir('proxy-2')).toBe('D:\\work');
  });

  it('polls slowly when idle and quickly while a report is pending', async () => {
    const { runtime, deps } = setup();
    expect(deps.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 15_000);
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    expect(deps.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
    runtime.untrack('proxy-1');
    expect(runtime.isRemote('proxy-1')).toBe(false);
  });

  it('persists the input identity before enqueue and restores its report without resending', async () => {
    const { runtime, deps, state, invoke } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' });
    expect(vi.mocked(deps.saveReport).mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[invoke.mock.calls.findIndex(([, channel]) => channel === 'maker:input:enqueue')]!,
    );
    const pendingReport = vi.mocked(deps.saveReport).mock.calls[0]![1];
    runtime.stop();
    const restored = createOrcaRemoteWorkerRuntime(deps);
    restored.track({ ...ref, pendingReport });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'restored-reply', content: 'Recovered result' };
    await restored.pollNow();
    await restored.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledOnce();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', { status: 'done', finalText: 'Recovered result' });
    expect(state.enqueued).toHaveLength(1);
    expect(restored.hasPendingReport('proxy-1')).toBe(false);
  });

  it('keeps retrying a rejected report and advances the cursor only after acceptance', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'reply-1', content: 'Result' };
    deps.onTurnEnded.mockResolvedValueOnce(false);
    await runtime.pollNow();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(runtime.get('proxy-1')?.lastBridgedMessageId).toBeNull();
    expect(deps.saveReport).not.toHaveBeenCalledWith('worker-1', null, 'reply-1');
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledTimes(2);
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
    expect(runtime.get('proxy-1')?.lastBridgedMessageId).toBe('reply-1');
  });

  it('retains pending bookkeeping when completion persistence fails, then retries it', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'reply-1', content: 'Result' };
    vi.mocked(deps.saveReport).mockRejectedValueOnce(new Error('database busy'));
    await runtime.pollNow();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(runtime.get('proxy-1')?.lastBridgedMessageId).toBeNull();
    await runtime.pollNow();
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it('does not erase a newer dispatch while saving an older completion', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'first', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'reply-1', content: 'First result' };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(deps.saveReport).mockImplementationOnce(async () => { entered(); await gate; });
    const poll = runtime.pollNow();
    await writing;
    const dispatch = runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'second', clientId: 'c-2' });
    // Let the dispatch reach its prewrite while the previous write is in flight.
    await vi.waitFor(() => expect(deps.saveReport).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([poll, dispatch]);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(deps.saveReport).toHaveBeenLastCalledWith('worker-1', expect.objectContaining({ clientIds: ['c-1', 'c-2'] }), undefined);
    state.receipts['c-2'] = 'accepted';
    state.assistant = { id: 'reply-2', content: 'Second result' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenLastCalledWith('proxy-1', { status: 'done', finalText: 'Second result' });
  });

  it.each([true, false])('reconciles unknown receipts with history and bounds missing execution (history=%s)', async (hasHistory) => {
    const { coreRuntime, deps, state } = setup({ history: hasHistory ? [
      { id: 'input-1', clientId: 'c-1', role: 'user', content: 'Lead input' },
      { id: 'reply-1', role: 'assistant', content: 'Recovered result' },
    ] : [] });
    coreRuntime.untrack('proxy-1');
    coreRuntime.track({ ...ref, pendingReport: { clientIds: ['c-1'], baselineMessageId: null } });
    for (let i = 0; i < 15; i++) await coreRuntime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledOnce();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', expect.objectContaining({ status: hasHistory ? 'done' : 'error' }));
    expect(coreRuntime.hasPendingReport('proxy-1')).toBe(false);
    expect(state.enqueued).toHaveLength(0);
  });

  it('does not send if pending identity cannot be persisted', async () => {
    const { runtime, deps, state } = setup();
    vi.mocked(deps.saveReport).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' })).resolves.toMatchObject({ ok: false });
    expect(state.enqueued).toHaveLength(0);
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it('ignores a late poll after tracking has been reset for another account', async () => {
    const { runtime, deps, invoke } = setup();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (deviceId, channel, args) => {
      if (channel === 'maker:list-active') {
        runtime.reset();
        runtime.track({ ...ref, proxySessionId: 'new-proxy' });
      }
      return original(deviceId, channel, args);
    });
    await runtime.pollNow();
    expect(runtime.workingDir('new-proxy')).toBeNull();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(deps.saveReport).not.toHaveBeenCalled();
  });

  it('keeps another peer reporting while one execution device is offline', async () => {
    const { runtime, deps, invoke, state } = setup();
    runtime.untrack('proxy-1');
    const pendingReport = { clientIds: ['c-1'], baselineMessageId: null };
    runtime.track({ ...ref, pendingReport });
    runtime.track({ ...ref, workerId: 'worker-2', proxySessionId: 'proxy-2', deviceId: 'other-pc',
      remoteSessionId: 'remote-2', pendingReport });
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'reply-1', content: 'Other peer result' };
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (deviceId, channel, args) => {
      if (deviceId === 'mac-mini') throw new Error('[DEVICE_OFFLINE] disconnected');
      return original(deviceId, channel, args);
    });
    await runtime.pollNow();
    expect(runtime.isReachable('proxy-1')).toBe(false);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
    expect(runtime.isReachable('proxy-2')).toBe(true);
    expect(runtime.hasPendingReport('proxy-2')).toBe(false);
    expect(deps.onTurnEnded).toHaveBeenCalledOnce();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-2', { status: 'done', finalText: 'Other peer result' });
  });
});
