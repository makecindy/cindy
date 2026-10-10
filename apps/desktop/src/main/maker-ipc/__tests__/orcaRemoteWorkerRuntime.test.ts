import { describe, expect, it, vi } from 'vitest';

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
  agentMeta?: { parentUuid: string };
}

interface FakeDevice {
  offline: boolean;
  running: boolean;
  receipts: Record<string, string>;
  assistant: { id: string; content: unknown } | null;
  terminalError: boolean;
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
    assistant: { id: 'msg-0', content: '旧回复' },
    terminalError: false,
    enqueued: [],
    aborted: 0,
    released: 0,
    ...device,
  };
  const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
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
          agentKind: 'cc',
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
      case 'maker:input:get-projection': {
        const ids = (args[1] as { deliveryClientIds: string[] }).deliveryClientIds;
        return {
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
  it('enqueues a Lead message on the execution device with the device task’s own settings', async () => {
    const { runtime, state } = setup();
    await expect(
      runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写这段访谈', clientId: 'c-1' }),
    ).resolves.toEqual({ ok: true, mode: 'dispatched' });
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toMatchObject({
      clientId: 'c-1',
      durableDelivery: true,
      text: '[From Orca Lead]\n转写这段访谈',
      origin: { kind: 'orca', senderLabel: 'Lead', displayText: '转写这段访谈' },
      createOpts: {
        agentKind: 'claude-code',
        workingDir: '/Users/demo/Interviews',
        model: 'claude-opus-5-5',
        resumeSessionId: 'sdk-1',
      },
    });
    expect((state.enqueued[0] as { text: string }).text).not.toContain('worker_id');
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

  it('treats a lost enqueue reply as delivered when the device already holds the message', async () => {
    const lost = Object.assign(new Error('[INVOKE_TIMEOUT] no reply'), { inFlight: true });
    const { runtime, state } = setup({ enqueueError: lost, receipts: { 'c-1': 'pending' } });
    await expect(
      runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' }),
    ).resolves.toEqual({ ok: true, mode: 'dispatched' });
    expect(state.enqueued).toHaveLength(0);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
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
