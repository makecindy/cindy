import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import type { OrcaTeamService, OrcaTeamServiceDeps, WorkerTerminalTurnCapture } from '../orcaTeamService.js';
import { withSendToSessionLock } from '../sendToSessionLock.js';
import { createOrcaRemoteWorkerHost, type OrcaRemoteWorkerExistingSession } from '../orcaRemoteWorkerHost.js';

const store = vi.hoisted(() => ({
  archiveSingleWorkerSession: vi.fn(async () => undefined),
  getRemoteWorkerByProxySession: vi.fn(async () => null),
  listActiveRemoteWorkers: vi.fn(async () => []),
  listUnreleasedEndedRemoteWorkers: vi.fn(async () => []),
  markWorkerRemoteReleased: vi.fn(async () => undefined),
  saveWorkerRemoteReport: vi.fn(async () => undefined),
  markWorkerRemoteStopConfirmed: vi.fn(async () => undefined),
  getWorkerRemoteReleaseState: vi.fn(async () => ({ remoteStopConfirmedAt: null as number | null, remoteReleasedAt: null as number | null })),
  saveRemoteWorkerOpen: vi.fn(async () => undefined),
  removeRemoteWorkerOpen: vi.fn(async () => undefined),
  listOrphanRemoteWorkerOpens: vi.fn(async (_sessionId?: string) => []),
  addRemoteWorker: vi.fn(async () => undefined),
  removeWorker: vi.fn(async () => undefined),
}));
vi.mock('../../localDb/orcaTeamStore.js', () => store);
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

import {
  createOrcaRemoteWorkers,
  invokeDeviceValue,
  isExecutionDeviceCandidate,
} from '../orcaRemoteWorkers.js';

function device(overrides: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView {
  return {
    deviceId: 'mac-mini',
    name: 'Mac mini',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...overrides,
  };
}

const ok = (result: unknown): InvokeResultPayload => ({ ok: true, result }) as InvokeResultPayload;
const fail = (code: string, message: string): InvokeResultPayload =>
  ({ ok: false, error: { code, message } }) as InvokeResultPayload;

function setup(opts: {
  getOwnerToken?: () => unknown;
  devices?: DeviceLinkDeviceView[];
  handle?: (deviceId: string, channel: string, args: unknown[]) => InvokeResultPayload | undefined | Promise<InvokeResultPayload | undefined>;
  getTeamService?: () => OrcaTeamService | null;
} = {}) {
  const devices = opts.devices ?? [device({})];
  const remoteInvoke = vi.fn(async (deviceId: string, channel: string, args: unknown[]) => {
    const custom = await opts.handle?.(deviceId, channel, args);
    if (custom) return custom;
    switch (channel) {
      case 'maker:orca:remote-worker:caps':
        return ok({ version: 1 });
      case 'maker:orca:remote-worker:open':
        return ok({
          sessionId: (args[0] as { sessionId: string }).sessionId,
          workingDir: '/Users/demo/Interviews',
          model: 'claude-opus-5-5',
          agentKind: 'claude-code',
        });
      case 'local-db:sessions:get':
        return ok({ id: 'remote-1', status: 'active', agentKind: 'cc', workingDir: '/Users/demo/Interviews', model: 'm' });
      case 'local-db:history:messages':
        return ok({ items: [], terminal: null });
      case 'maker:input:enqueue':
        return ok({});
      case 'maker:abort-session':
        return ok(undefined);
      case 'maker:orca:remote-worker:release':
        return ok({ released: true });
      default:
        return fail('CHANNEL_NOT_ALLOWED', channel);
    }
  });
  const workers = createOrcaRemoteWorkers({
    getOwnerToken: opts.getOwnerToken,
    remoteInvoke,
    listDevices: async () => ({ devices }),
    getTeamService: opts.getTeamService ?? (() => null),
    broadcastOrcaWorkerChanged: vi.fn(),
    readLeadTitle: async () => '访谈整理',
    log: { info: vi.fn(), warn: vi.fn() },
  });
  return { workers, remoteInvoke };
}

const openInput = {
  deviceId: 'mac-mini',
  workerId: 'w-1',
  teamId: 'team-1',
  leadSessionId: 'lead-1',
  label: 'transcriber',
  role: 'developer',
  agent: 'claude-code' as const,
  permissionMode: 'auto' as const,
  title: 'transcriber',
};

const proxySeed = { title: 'transcriber', agentKind: 'cc', model: 'claude-opus-5-5',
  effort: null, permissionMode: 'auto', fastMode: false };

function baseDeps() {
  return {
    getLiveSession: vi.fn(() => null),
    dispatchWorkerMessage: vi.fn(async () => ({ ok: true, local: true })),
    hasPendingWorkerInput: vi.fn(async () => true),
    archiveWorkerSession: vi.fn(async () => undefined),
    withSessionSendLock: withSendToSessionLock,
  } as unknown as OrcaTeamServiceDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('invokeDeviceValue', () => {
  it('unwraps the tunnel result and keeps the original error code', async () => {
    await expect(invokeDeviceValue(async () => ok(3), 'd', 'c', [])).resolves.toBe(3);
    await expect(
      invokeDeviceValue(async () => fail('IPC_ERROR', '[NOT_FOUND] gone'), 'd', 'c', []),
    ).rejects.toThrow(/^\[NOT_FOUND\]/);
    await expect(
      invokeDeviceValue(async () => fail('DEVICE_OFFLINE', 'offline'), 'd', 'c', []),
    ).rejects.toThrow(/^\[DEVICE_OFFLINE\]/);
  });

  it('marks link errors that hit an in-flight request', async () => {
    const lost = Object.assign(new DeviceLinkError('INVOKE_TIMEOUT' as never, 'lost'), {
      inFlight: true,
    });
    await expect(
      invokeDeviceValue(async () => Promise.reject(lost), 'd', 'c', []),
    ).rejects.toMatchObject({ message: '[INVOKE_TIMEOUT] lost', inFlight: true });
  });
});

describe('execution devices', () => {
  it('only offers other online desktops that allow remote control', () => {
    expect(isExecutionDeviceCandidate(device({}))).toBe(true);
    expect(isExecutionDeviceCandidate(device({ online: false }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ remoteControlEnabled: false }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ controlEnabled: false }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ isSelf: true }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ platform: 'ios' }))).toBe(false);
  });

  it('lists outdated devices as unsupported and leaves out devices that did not answer', async () => {
    const { workers } = setup({
      devices: [
        device({}),
        device({ deviceId: 'old-pc', name: 'Old PC', platform: 'win32' }),
        device({ deviceId: 'flaky', name: 'Flaky' }),
      ],
      handle: (deviceId, channel) =>
        channel !== 'maker:orca:remote-worker:caps'
          ? undefined
          : deviceId === 'old-pc'
            ? fail('CHANNEL_NOT_ALLOWED', channel)
            : deviceId === 'flaky'
              ? fail('DEVICE_OFFLINE', 'offline')
              : undefined,
    });
    await expect(workers.listExecutionDevices()).resolves.toEqual([
      { deviceId: 'mac-mini', name: 'Mac mini', platform: 'darwin', supported: true },
      { deviceId: 'old-pc', name: 'Old PC', platform: 'win32', supported: false },
    ]);
  });

  it('lists usable devices first in a stable order', async () => {
    const { workers } = setup({
      devices: [
        device({ deviceId: 'old-pc', name: 'Old PC' }),
        device({ deviceId: 'b', name: 'Beta' }),
        device({ deviceId: 'a', name: 'Alpha' }),
      ],
      handle: (deviceId, channel) =>
        channel === 'maker:orca:remote-worker:caps' && deviceId === 'old-pc'
          ? fail('CHANNEL_NOT_ALLOWED', channel)
          : undefined,
    });
    expect((await workers.listExecutionDevices()).map((d) => d.deviceId)).toEqual([
      'a',
      'b',
      'old-pc',
    ]);
  });
});

describe('openRemoteWorker', () => {
  it.each([
    [false, true, false],
    [true, false, true],
    [true, undefined, true],
    [undefined, true, true],
    [undefined, undefined, false],
  ] as const)('uses admitted remote Fast %s with requested Fast %s (old hosts omit it)', async (fastMode, requested, expected) => {
    const { workers } = setup({ handle: (_device, channel, args) =>
      channel === 'maker:orca:remote-worker:open' ? ok({
        sessionId: (args[0] as { sessionId: string }).sessionId,
        agentKind: 'claude-code', model: 'device-model', workingDir: '/remote',
        ...(fastMode !== undefined ? { fastMode } : {}),
      }) : undefined });
    try {
      const result = await workers.openRemoteWorker({ ...openInput, fast: requested });
      expect(result).toMatchObject({ ok: true, proxySession: { fastMode: expected } });
      if (!result.ok) throw Error('expected successful open');
      await workers.recordRemoteWorker({ ...openInput, proxySessionId: result.proxySessionId,
        proxySession: result.proxySession, remoteSessionId: result.remoteSessionId });
      expect(store.addRemoteWorker).toHaveBeenCalledWith(expect.objectContaining({
        proxySession: expect.objectContaining({ fastMode: expected }),
      }));
    } finally { workers.stop(); }
  });

  it.each([
    ['medium', undefined, 'medium'],
    ['low', 'high', 'low'],
    ['', 'high', ''],
    [undefined, 'xhigh', 'xhigh'],
    [undefined, undefined, null],
  ] as const)('uses admitted remote effort %s with requested effort %s (old hosts omit it)', async (effort, requested, expected) => {
    const { workers } = setup({ handle: (_device, channel, args) =>
      channel === 'maker:orca:remote-worker:open' ? ok({
        sessionId: (args[0] as { sessionId: string }).sessionId,
        agentKind: 'claude-code', model: 'device-model', workingDir: '/remote',
        ...(effort !== undefined ? { effort } : {}),
      }) : undefined });
    const result = await workers.openRemoteWorker({ ...openInput, effort: requested });
    expect(result).toMatchObject({ ok: true, proxySession: { effort: expected } });
    workers.stop();
  });

  it('opens the device task and defers the local proxy until Worker association', async () => {
    const { workers, remoteInvoke } = setup();
    const result = await workers.openRemoteWorker({ ...openInput, workingDir: '/Users/demo/Interviews' });
    expect(result).toMatchObject({
      ok: true,
      agent: 'claude-code',
      model: 'claude-opus-5-5',
      workingDir: '/Users/demo/Interviews',
    });
    const open = remoteInvoke.mock.calls.find(([, channel]) => channel === 'maker:orca:remote-worker:open');
    expect(open?.[2][0]).toMatchObject({
      agentKind: 'claude-code',
      permissionMode: 'auto',
      workingDir: '/Users/demo/Interviews',
      lead: { leadSessionId: 'lead-1', leadTitle: '访谈整理', workerLabel: 'transcriber' },
    });
    expect(store.addRemoteWorker).not.toHaveBeenCalled();
    if (!result.ok) throw Error('expected successful open');
    await workers.recordRemoteWorker({ workerId: 'w-1', teamId: 'team-1', leadSessionId: 'lead-1',
      proxySessionId: result.proxySessionId, proxySession: result.proxySession,
      remoteSessionId: result.remoteSessionId, deviceId: 'mac-mini', label: 'transcriber', role: 'developer' });
    expect(store.addRemoteWorker).toHaveBeenCalledWith(expect.objectContaining({
      proxySessionId: result.proxySessionId, proxySession: proxySeed,
    }));
    workers.stop();
  });

  it('refuses an offline device without falling back to this computer', async () => {
    const { workers, remoteInvoke } = setup({ devices: [device({ online: false })] });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({
      ok: false,
      errorCode: 'REMOTE_AGENT_DEVICE_UNREACHABLE',
    });
    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(store.addRemoteWorker).not.toHaveBeenCalled();
  });

  it('reports an outdated device as unsupported', async () => {
    const { workers } = setup({
      handle: (_d, channel) =>
        channel === 'maker:orca:remote-worker:caps' ? fail('CHANNEL_NOT_ALLOWED', channel) : undefined,
    });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({
      ok: false,
      errorCode: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('explains a rejected directory on the device', async () => {
    const { workers } = setup({
      handle: (_d, channel) =>
        channel === 'maker:orca:remote-worker:open' ? fail('CHANNEL_NOT_ALLOWED', 'path guard') : undefined,
    });
    await expect(
      workers.openRemoteWorker({ ...openInput, workingDir: '/nope' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS', message: expect.stringContaining('/nope') });
  });
});

describe('start', () => {
  it('rebuilds tracking for the current account each time it runs', async () => {
    const row = {
      workerId: 'w-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1',
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      label: 'transcriber',
      role: 'developer',
      lastBridgedMessageId: null,
    };
    let owner = {};
    const { workers } = setup({ getOwnerToken: () => owner });
    store.listActiveRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.start();
    expect(workers.runtime.isRemote('proxy-1')).toBe(true);
    // 换账号后重建：上一账号的 Worker 不再被当作远端处理。
    owner = {};
    store.listActiveRemoteWorkers.mockResolvedValueOnce([] as never);
    await workers.start();
    expect(workers.runtime.isRemote('proxy-1')).toBe(false);
    workers.stop();
  });

  it('keeps accepted reports when ensureReady starts the same owner again', async () => {
    const { workers } = setup();
    const row = { ...openInput, proxySessionId: 'proxy-1', remoteSessionId: 'remote-1', lastBridgedMessageId: null };
    store.listActiveRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.start();
    await workers.runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' });
    await workers.start();
    expect(store.listActiveRemoteWorkers).toHaveBeenCalledOnce();
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
    workers.stop();
  });

  it('restores the TeamService report identity before tracking its durable pending input', async () => {
    const restore = vi.fn();
    const service = { restoreWorkerPendingReport: restore, captureWorkerTerminalTurn: vi.fn(() => ({ autoBridgeIdentity: {} })) };
    const { workers } = setup({ getTeamService: () => service as unknown as OrcaTeamService });
    const row = { ...openInput, proxySessionId: 'proxy-1', remoteSessionId: 'remote-1', lastBridgedMessageId: null,
      pendingReport: { clientIds: ['c-1'], baselineMessageId: null } };
    store.listActiveRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.start();
    expect(restore).toHaveBeenCalledWith('proxy-1', row);
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(service.captureWorkerTerminalTurn.mock.invocationCallOrder[0]!);
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
    workers.stop();
  });

  it('does not install an old account snapshot after another owner has restored', async () => {
    let owner = {};
    const { workers } = setup({ getOwnerToken: () => owner });
    let resolveRows!: (rows: never[]) => void;
    const gate = new Promise<never[]>((resolve) => { resolveRows = resolve; });
    store.listActiveRemoteWorkers.mockImplementationOnce(() => gate);
    const first = workers.start();
    await vi.waitFor(() => expect(store.listActiveRemoteWorkers).toHaveBeenCalledOnce());
    owner = {};
    store.listActiveRemoteWorkers.mockResolvedValueOnce([]);
    await workers.start();
    resolveRows([{ ...openInput, proxySessionId: 'old-proxy', remoteSessionId: 'remote-1' }] as never[]);
    await first;
    expect(workers.runtime.isRemote('old-proxy')).toBe(false);
    workers.stop();
  });
});

describe('wrapTeamDeps', () => {
  const restoredRow = { workerId: 'w-1', teamId: 'team-1', leadSessionId: 'lead-1',
    proxySessionId: 'proxy-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1', lastBridgedMessageId: null };

  it('blocks resume, dispatch and local bootstrap detection until routing has restored', async () => {
    let restoreRows!: (rows: never[]) => void;
    store.listActiveRemoteWorkers.mockImplementationOnce(() => new Promise(resolve => { restoreRows = resolve; }));
    const { workers, remoteInvoke } = setup();
    const base = baseDeps();
    base.resumeWorkerSession = vi.fn(async () => undefined);
    const wrapped = workers.wrapTeamDeps(base);
    const starting = workers.start();
    const detecting = workers.isRemoteWorker('proxy-1');
    const resuming = wrapped.resumeWorkerSession({ sessionId: 'proxy-1' } as never, {} as never);
    const sending = wrapped.dispatchWorkerMessage({ targetSessionId: 'proxy-1', message: 'work', workerId: 'w-1',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' } } as never);
    expect(base.resumeWorkerSession).not.toHaveBeenCalled();
    expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
    restoreRows([restoredRow] as never[]);
    try {
      await starting;
      await expect(detecting).resolves.toBe(true);
      await resuming;
      await expect(sending).resolves.toMatchObject({ ok: true });
      expect(base.resumeWorkerSession).not.toHaveBeenCalled();
      expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
      expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(true);
    } finally { workers.stop(); }
  });

  it('does not fall back locally when restoring routes fails', async () => {
    store.listActiveRemoteWorkers.mockRejectedValueOnce(new Error('database unavailable'));
    const { workers } = setup();
    const base = baseDeps();
    try {
      await expect(workers.wrapTeamDeps(base).dispatchWorkerMessage({ targetSessionId: 'proxy-1' } as never))
        .rejects.toThrow('database unavailable');
      expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
    } finally { workers.stop(); }
  });

  it('rejects a pending dispatch when the database owner changes during restore', async () => {
    let owner = {};
    let restoreRows!: (rows: never[]) => void;
    store.listActiveRemoteWorkers.mockImplementationOnce(() => new Promise(resolve => { restoreRows = resolve; }));
    const { workers, remoteInvoke } = setup({ getOwnerToken: () => owner });
    const base = baseDeps();
    const sending = workers.wrapTeamDeps(base).dispatchWorkerMessage({ targetSessionId: 'proxy-1' } as never);
    const rejected = expect(sending).rejects.toThrow('owner changed');
    owner = {};
    restoreRows([restoredRow] as never[]);
    try {
      await rejected;
      expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
      expect(remoteInvoke).not.toHaveBeenCalled();
    } finally { workers.stop(); }
  });

  it('recognizes an archived durable route even though it is not polled', async () => {
    store.getRemoteWorkerByProxySession.mockResolvedValueOnce(restoredRow as never);
    const { workers } = setup();
    try {
      await expect(workers.isRemoteWorker('proxy-1')).resolves.toBe(true);
      expect(workers.runtime.isRemote('proxy-1')).toBe(false);
    } finally { workers.stop(); }
  });

  it('retries an offline rollback after restart and only then deletes the cleanup row', async () => {
    store.getRemoteWorkerByProxySession.mockResolvedValueOnce(restoredRow as never);
    store.getWorkerRemoteReleaseState.mockResolvedValueOnce({ remoteStopConfirmedAt: null, remoteReleasedAt: null,
      removeAfterRelease: true } as never);
    const first = setup({ handle: (_device, channel) => channel === 'maker:abort-session'
      ? fail('DEVICE_OFFLINE', 'offline') : undefined });
    await expect(first.workers.rollbackCreatedWorker('proxy-1')).resolves.toBe(true);
    expect(store.removeWorker).toHaveBeenCalledOnce();
    expect(store.markWorkerRemoteReleased).not.toHaveBeenCalled();
    first.workers.stop();
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([restoredRow] as never);
    store.getWorkerRemoteReleaseState.mockResolvedValueOnce({ remoteStopConfirmedAt: null, remoteReleasedAt: null,
      removeAfterRelease: true } as never);
    const second = setup();
    try {
      await second.workers.releaseEnded([]);
      expect(store.markWorkerRemoteStopConfirmed).toHaveBeenCalledOnce();
      expect(store.markWorkerRemoteReleased).toHaveBeenCalledOnce();
      expect(store.removeWorker).toHaveBeenCalledTimes(2);
      expect(second.remoteInvoke.mock.calls.map(([, channel]) => channel))
        .toEqual(['maker:abort-session', 'maker:orca:remote-worker:release']);
    } finally { second.workers.stop(); }
  });

  async function trackedWorker(setupOpts?: Parameters<typeof setup>[0]) {
    const ctx = setup(setupOpts);
    await ctx.workers.recordRemoteWorker({
      workerId: 'w-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1',
      proxySession: proxySeed,
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      label: 'transcriber',
      role: 'developer',
      workingDir: '/Users/demo/Interviews',
    });
    return ctx;
  }

  function reportService() {
    let capture: WorkerTerminalTurnCapture = {
      sessionId: 'proxy-1', manualInterrupt: null, autoBridgeIdentity: null,
    };
    const service = {
      captureWorkerTerminalTurn: vi.fn(() => capture),
      captureWorkerText: vi.fn(),
      handleWorkerTerminalTurn: vi.fn(async () => { capture = { ...capture, autoBridgeIdentity: null }; }),
      handleWorkerTurnStarted: vi.fn(async () => undefined),
    };
    const history: Array<{ id: string; clientId?: string; role: string; content: string }> = [];
    const handle = (_deviceId: string, channel: string, args: unknown[]) => {
      if (channel === 'maker:input:enqueue') {
        const clientId = (args[1] as { clientId: string }).clientId;
        history.push({ id: `input-${clientId}`, clientId, role: 'user', content: 'Lead input' });
        return ok({});
      }
      if (channel === 'maker:input:get-projection') {
        return ok({ deliveryReceipts: (args[1] as { deliveryClientIds: string[] }).deliveryClientIds
          .map((clientId) => ({ clientId, state: 'accepted' })) });
      }
      if (channel === 'maker:list-active') return ok({ sessions: [] });
      if (channel === 'local-db:history:messages') {
        const roles = (args[0] as { roles: string[] }).roles;
        return ok({ items: history.filter((row) => roles.includes(row.role)).slice().reverse(), hasMore: false });
      }
      return undefined;
    };
    const onAccepted = async () => {
      capture = { sessionId: 'proxy-1', manualInterrupt: null, autoBridgeIdentity: {} };
    };
    return { service, history, handle, onAccepted, capture: () => capture };
  }

  it('waits for the host accepted lifecycle before reporting an immediate remote reply', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    let finishCommit!: () => void;
    let enteredCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { finishCommit = resolve; });
    const entered = new Promise<void>((resolve) => { enteredCommit = resolve; });
    const dispatch = wrapped.dispatchWorkerMessage({
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
      onAccepted: report.onAccepted,
      onAcceptedCommit: async () => { enteredCommit(); await commitGate; },
    } as never);
    try {
      await entered;
      report.history.push({ id: 'reply-1', role: 'assistant', content: 'Immediate result' });
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).not.toHaveBeenCalled();
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
      finishCommit();
      await dispatch;
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({
        finalText: 'Immediate result', capture: expect.objectContaining({ sessionId: 'proxy-1' }),
      }));
    } finally {
      finishCommit();
      await dispatch;
      workers.stop();
    }
  });

  it('keeps the old terminal capture when a new dispatch commits during report persistence', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    const dispatch = () => wrapped.dispatchWorkerMessage({
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' }, onAccepted: report.onAccepted,
    } as never);
    try {
      await dispatch();
      const firstCapture = report.capture();
      report.history.push({ id: 'reply-1', role: 'assistant', content: 'First result' });
      report.service.handleWorkerTerminalTurn.mockImplementationOnce(async () => { await dispatch(); });
      await workers.runtime.pollNow();
      expect(report.capture()).not.toBe(firstCapture);
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({
        finalText: 'First result', capture: firstCapture,
      }));
      expect(report.service.captureWorkerText).not.toHaveBeenCalled();
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
      report.history.push({ id: 'reply-2', role: 'assistant', content: 'Second result' });
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenLastCalledWith(expect.objectContaining({
        finalText: 'Second result', capture: expect.objectContaining({ sessionId: 'proxy-1' }),
      }));
    } finally { workers.stop(); }
  });

  it('serializes concurrent remote sends through accepted commit so the latest reply owns the latest capture', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const params = {
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' }, onAccepted: report.onAccepted,
    };
    const first = wrapped.dispatchWorkerMessage({ ...params, onAccepted: async () => {
      enteredFirst(); await firstGate; await report.onAccepted();
    } } as never);
    let second: ReturnType<typeof wrapped.dispatchWorkerMessage> | undefined;
    try {
      await entered;
      second = wrapped.dispatchWorkerMessage(params as never);
      // Drain queued microtasks without releasing the first accepted callback.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(report.history.filter((row) => row.role === 'user')).toHaveLength(0);
      releaseFirst();
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(report.history.filter((row) => row.role === 'user')).toHaveLength(2);
      report.history.push({ id: 'reply-final', role: 'assistant', content: 'Latest result' });
      const latestCapture = report.capture();
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledOnce();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({
        finalText: 'Latest result', capture: latestCapture,
      }));
    } finally {
      releaseFirst();
      await first;
      await second;
      workers.stop();
    }
  });

  it.each([false, true])('restores the previous report after an accepted callback rolls back (previous=%s)', async (previous) => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    const params = {
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' }, onAccepted: report.onAccepted,
    };
    try {
      if (previous) {
        await wrapped.dispatchWorkerMessage(params as never);
        report.history.push({ id: 'reply-1', role: 'assistant', content: 'First result' });
      }
      const historyBeforeRejectedDispatch = report.history.slice();
      await expect(wrapped.dispatchWorkerMessage({ ...params,
        onAccepted: async () => { throw new Error('accepted lifecycle rolled back'); },
      } as never)).rejects.toThrow('accepted lifecycle rolled back');
      expect(report.history).toEqual(historyBeforeRejectedDispatch);
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(previous);
      if (previous) {
        const previousCapture = report.capture();
        await workers.runtime.pollNow();
        expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({ finalText: 'First result', capture: previousCapture }));
      }
    } finally { workers.stop(); }
  });

  it.each(['plugin source revoked', 'worker status write failed'])(
    'does not enqueue remote work when accepted preflight rejects (%s)', async message => {
      const { workers, remoteInvoke } = await trackedWorker();
      const error = new Error(message);
      const onAcceptedRollback = vi.fn(async () => undefined);
      const onAcceptedCommit = vi.fn(async () => undefined);
      try {
        await expect(workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
          targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
          dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
          onAccepted: async () => { throw error; }, onAcceptedRollback, onAcceptedCommit,
        })).rejects.toBe(error);
        expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(false);
        expect(onAcceptedRollback).toHaveBeenCalledOnce();
        expect(onAcceptedCommit).not.toHaveBeenCalled();
        expect(workers.runtime.hasPendingReport('proxy-1')).toBe(false);
      } finally { workers.stop(); }
    },
  );

  it('rolls back accepted state when remote enqueue is definitively rejected', async () => {
    const { workers } = await trackedWorker({ handle: (_device, channel) =>
      channel === 'maker:input:enqueue' ? fail('PERMISSION_DENIED', 'remote control disabled') : undefined });
    const onAccepted = vi.fn(async () => undefined);
    const onAcceptedRollback = vi.fn(async () => undefined);
    const onAcceptedCommit = vi.fn(async () => undefined);
    try {
      await expect(workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
        targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
        dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
        onAccepted, onAcceptedRollback, onAcceptedCommit,
      })).resolves.toMatchObject({ ok: false });
      expect(onAccepted).toHaveBeenCalledOnce();
      expect(onAcceptedRollback).toHaveBeenCalledOnce();
      expect(onAcceptedCommit).not.toHaveBeenCalled();
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(false);
    } finally { workers.stop(); }
  });

  it('preserves accepted rejection when its rollback also fails', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    const error = new Error('permission revoked');
    const onAcceptedRollback = vi.fn(async () => { throw new Error('rollback write failed'); });
    try {
      await expect(workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
        targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
        dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
        onAccepted: async () => { throw error; }, onAcceptedRollback,
      })).rejects.toBe(error);
      expect(onAcceptedRollback).toHaveBeenCalledOnce();
      expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(false);
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(false);
    } finally { workers.stop(); }
  });

  it('preserves accepted rejection when restoring the report record fails', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    const error = new Error('permission revoked');
    store.saveWorkerRemoteReport.mockResolvedValueOnce(undefined);
    store.saveWorkerRemoteReport.mockRejectedValueOnce(new Error('report rollback write failed'));
    const onAcceptedRollback = vi.fn(async () => undefined);
    try {
      await expect(workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
        targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
        dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
        onAccepted: async () => { throw error; }, onAcceptedRollback,
      })).rejects.toBe(error);
      expect(store.saveWorkerRemoteReport).toHaveBeenCalledTimes(2);
      expect(onAcceptedRollback).toHaveBeenCalledOnce();
      expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(false);
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(false);
    } finally { workers.stop(); }
  });

  it.each(['account change', 'worker release'])(
    'rechecks the dispatch after accepted preflight (%s)', async change => {
      let owner = {};
      const { workers, remoteInvoke } = setup({ getOwnerToken: () => owner });
      workers.runtime.track(restoredRow);
      const onAcceptedRollback = vi.fn(async () => undefined);
      const onAcceptedCommit = vi.fn(async () => undefined);
      try {
        await expect(workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
          targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
          dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
          onAccepted: async () => {
            await Promise.resolve();
            if (change === 'account change') owner = {};
            else workers.runtime.untrack('proxy-1');
          }, onAcceptedRollback, onAcceptedCommit,
        })).resolves.toMatchObject({ ok: false });
        expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(false);
        expect(onAcceptedRollback).toHaveBeenCalledOnce();
        expect(onAcceptedCommit).not.toHaveBeenCalled();
      } finally { workers.stop(); }
    },
  );

  it('treats an idle remote worker as not live so dispatch reports it as resumed', async () => {
    const { workers } = await trackedWorker();
    const wrapped = workers.wrapTeamDeps(baseDeps());
    expect(wrapped.getLiveSession('proxy-1')).toBeNull();
    workers.stop();
  });

  it('leaves local workers on the existing path', async () => {
    const { workers } = await trackedWorker();
    const base = baseDeps();
    const wrapped = workers.wrapTeamDeps(base);
    await wrapped.dispatchWorkerMessage({ targetSessionId: 'local-1' } as never);
    expect(base.dispatchWorkerMessage).toHaveBeenCalledTimes(1);
    await expect(wrapped.hasPendingWorkerInput('local-1')).resolves.toBe(true);
    workers.stop();
  });

  it('sends a Lead message for a remote worker to its device', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    const base = baseDeps();
    const onAccepted = vi.fn(async () => undefined);
    const result = await workers.wrapTeamDeps(base).dispatchWorkerMessage({
      targetSessionId: 'proxy-1',
      workerId: 'w-1',
      message: '转写这段访谈',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
      onAccepted,
    } as never);
    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(true);
    workers.stop();
  });

  it('fails the dispatch when the device is offline instead of queueing it', async () => {
    let offline = false;
    const { workers } = await trackedWorker({
      handle: () => (offline ? fail('DEVICE_OFFLINE', 'offline') : undefined),
    });
    offline = true;
    const result = await workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
      targetSessionId: 'proxy-1',
      workerId: 'w-1',
      message: 'x',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
    } as never);
    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: { kind: 'host-send', accepted: false, code: 'HOST_NOT_READY' },
    });
    workers.stop();
  });

  it.each([false, true])('waits for the one reserved stop request before enqueue (stop fails=%s)', async fails => {
    let settleStop!: (result: InvokeResultPayload) => void;
    let enteredStop!: () => void;
    const stopping = new Promise<InvokeResultPayload>(resolve => { settleStop = resolve; });
    const entered = new Promise<void>(resolve => { enteredStop = resolve; });
    const { workers, remoteInvoke } = await trackedWorker({ handle: async (_device, channel) => {
      if (channel === 'maker:abort-session') { enteredStop(); return stopping; }
      return undefined;
    } });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    let outcome: Awaited<ReturnType<typeof wrapped.requestWorkerInterrupt>> | undefined;
    const reservation = wrapped.reserveWorkerMessage({
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'replacement',
      dispatchMeta: { source: 'mcp', context: 'interrupt_worker' },
      onReserved: () => wrapped.requestWorkerInterrupt('proxy-1').then(result => { outcome = result; }),
    });
    try {
      await entered;
      expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
      expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(false);
      settleStop(fails ? fail('INVOKE_TIMEOUT', 'stop unconfirmed') : ok(undefined));
      await expect(reservation).resolves.toMatchObject({ ok: true });
      expect(outcome).toEqual({ stopOutcome: fails ? 'unconfirmed' : 'requested', queuePaused: false });
      const channels = remoteInvoke.mock.calls.map(([, channel]) => channel);
      expect(channels.filter(channel => channel === 'maker:abort-session')).toHaveLength(1);
      expect(channels.indexOf('maker:abort-session')).toBeLessThan(channels.indexOf('maker:input:enqueue'));
    } finally {
      settleStop(ok(undefined)); await reservation; workers.stop();
    }
  });

  it('stops once when reserving a remote replacement without a boundary callback', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    try {
      await expect(workers.wrapTeamDeps(baseDeps()).reserveWorkerMessage({
        targetSessionId: 'proxy-1', workerId: 'w-1', message: 'replacement',
        dispatchMeta: { source: 'mcp', context: 'interrupt_worker' },
      })).resolves.toMatchObject({ ok: true });
      expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    } finally { workers.stop(); }
  });

  it('archives a remote worker by releasing it on the device and keeping the task there', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    store.getRemoteWorkerByProxySession.mockResolvedValueOnce({
      workerId: 'w-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1',
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      lastBridgedMessageId: null,
    } as never);
    const base = baseDeps();
    await workers.wrapTeamDeps(base).archiveWorkerSession('proxy-1');
    expect(base.archiveWorkerSession).not.toHaveBeenCalled();
    expect(store.archiveSingleWorkerSession).toHaveBeenCalledWith('proxy-1', expect.any(Function));
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(true);
    expect(store.markWorkerRemoteReleased).toHaveBeenCalledWith('w-1');
    expect(workers.runtime.isRemote('proxy-1')).toBe(false);
  });

  it('keeps remote routing when archive persistence or authorization fails', async () => {
    const { workers } = await trackedWorker();
    store.archiveSingleWorkerSession.mockRejectedValueOnce(new Error('permission revoked'));
    const base = baseDeps();
    const wrapped = workers.wrapTeamDeps(base);
    await expect(wrapped.archiveWorkerSession('proxy-1')).rejects.toThrow('permission revoked');
    expect(workers.runtime.isRemote('proxy-1')).toBe(true);
    await wrapped.dispatchWorkerMessage({ targetSessionId: 'proxy-1', message: 'task', dispatchMeta: { source: 'mcp' } } as never);
    expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
    workers.stop();
  });

  it('retries a Lead refusal until its captured report identity is settled', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    await workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({ targetSessionId: 'proxy-1', message: 'task',
      dispatchMeta: { source: 'mcp' }, onAccepted: report.onAccepted } as never);
    report.history.push({ id: 'reply-1', role: 'assistant', content: 'Result' });
    report.service.handleWorkerTerminalTurn.mockImplementationOnce(async () => undefined);
    await workers.runtime.pollNow();
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
    await workers.runtime.pollNow();
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(false);
    expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledTimes(2);
    workers.stop();
  });

  it('stops a freshly dispatched Worker without waiting for the running poll and persists that phase', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    const row = { workerId: 'w-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1', remoteStopConfirmedAt: null };
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.releaseEnded(['proxy-1']);
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    expect(store.markWorkerRemoteStopConfirmed).toHaveBeenCalledWith('w-1');
    expect(store.markWorkerRemoteStopConfirmed.mock.invocationCallOrder[0]).toBeLessThan(
      remoteInvoke.mock.invocationCallOrder[remoteInvoke.mock.calls.findIndex(([, channel]) => channel === 'maker:orca:remote-worker:release')]!,
    );
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([{ ...row, remoteStopConfirmedAt: Date.now() }] as never);
    store.getWorkerRemoteReleaseState.mockResolvedValueOnce({ remoteStopConfirmedAt: Date.now(), remoteReleasedAt: null });
    await workers.releaseEnded([]);
    // A lost release reply must not stop a new ordinary task on the same B session.
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    workers.stop();
  });

  it('coalesces overlapping releases and rereads phase before processing a stale snapshot', async () => {
    let releaseGate!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const releasing = new Promise<void>((resolve) => { entered = resolve; });
    const { workers, remoteInvoke } = await trackedWorker({ handle: async (_device, channel) => {
      if (channel === 'maker:orca:remote-worker:release') { entered(); await gate; }
      return undefined;
    } });
    const row = { workerId: 'w-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1' };
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([row] as never).mockResolvedValueOnce([row] as never);
    const first = workers.releaseEnded(['proxy-1']);
    await releasing;
    const second = workers.releaseEnded([]);
    await vi.waitFor(() => expect(store.listUnreleasedEndedRemoteWorkers).toHaveBeenCalledTimes(2));
    releaseGate();
    await Promise.all([first, second]);
    store.getWorkerRemoteReleaseState.mockResolvedValueOnce({ remoteStopConfirmedAt: 1, remoteReleasedAt: 2 });
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.releaseEnded([]);
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:orca:remote-worker:release')).toHaveLength(1);
    workers.stop();
  });
});

describe('remote open recovery', () => {
  it.each(['archived', 'deleted'] as const)('rejects a lost open ACK retry after the task becomes %s and releases only its marker', async status => {
    let session: OrcaRemoteWorkerExistingSession | null = null;
    const host = createOrcaRemoteWorkerHost({
      getCaller: () => ({ controllerDeviceId: 'lead-device' }),
      readSession: async () => session,
      openSession: vi.fn(async (request, lead) => {
        session = { status: 'active', orcaRemoteLead: lead, workingDir: '/remote', model: 'device-model',
          agentKind: request.agentKind, effort: 'medium' };
        return { workingDir: '/remote', model: 'device-model', agentKind: request.agentKind, effort: 'medium' };
      }),
      writeRemoteLead: async (_id, lead) => { session = { ...session!, orcaRemoteLead: lead }; },
      withSessionLock: async <T,>(_id: string, task: () => Promise<T>) => task(),
      now: () => 123,
    });
    let loseOpenReply = true;
    const handle = async (_device: string, channel: string, args: unknown[]) => {
      if (channel === 'maker:orca:remote-worker:open') {
        try {
          const result = await host.open(args[0]);
          if (loseOpenReply) {
            loseOpenReply = false;
            session = { ...session!, status };
            return fail('INVOKE_TIMEOUT', 'ACK lost');
          }
          return ok(result);
        } catch (err) { return fail('IPC_ERROR', (err as Error).message); }
      }
      if (channel === 'local-db:sessions:get') return ok(session);
      if (channel === 'maker:orca:remote-worker:release') return ok(await host.release(args[0]));
      return undefined;
    };
    const { workers, remoteInvoke } = setup({ handle });
    try {
      await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
      expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:orca:remote-worker:open')).toHaveLength(2);
      expect(store.addRemoteWorker).not.toHaveBeenCalled();
      expect(store.removeRemoteWorkerOpen).not.toHaveBeenCalled();
      const [, remoteSessionId] = store.saveRemoteWorkerOpen.mock.calls[0] as unknown as [string, string];
      const receipt = { deviceId: 'mac-mini', remoteSessionId, createdAt: Date.now() };
      store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
      store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
      await workers.releaseEnded([]);
      expect(session).toMatchObject({ status, orcaRemoteLead: { releasedAt: 123 } });
      expect(store.removeRemoteWorkerOpen).toHaveBeenCalledWith(remoteSessionId);
      expect(store.archiveSingleWorkerSession).not.toHaveBeenCalled();
      expect(remoteInvoke.mock.calls.some(([, channel]) =>
        channel === 'maker:abort-session' || channel === 'maker:input:enqueue')).toBe(false);
    } finally { workers.stop(); }
  });

  it.each(['startup failed', '[INTERNAL] startup failed'])(
    'reconciles a persisted task after a non-timeout startup error (%s)', async message => {
      let session: OrcaRemoteWorkerExistingSession | null = null;
      const host = createOrcaRemoteWorkerHost({
        getCaller: () => ({ controllerDeviceId: 'lead-device' }),
        readSession: async () => session,
        openSession: async (_request, lead) => {
          session = { status: 'active', orcaRemoteLead: lead, workingDir: '/remote', model: 'device-model',
            agentKind: 'claude-code', effort: 'medium' };
          throw new Error(message);
        },
        writeRemoteLead: async (_id, lead) => { session = { ...session!, orcaRemoteLead: lead }; },
        withSessionLock: async <T,>(_id: string, task: () => Promise<T>) => task(),
        now: () => 123,
      });
      const handle = async (_device: string, channel: string, args: unknown[]) => {
        if (channel === 'maker:orca:remote-worker:open') {
          try { return ok(await host.open(args[0])); }
          catch (err) { return fail('IPC_ERROR', (err as Error).message); }
        }
        if (channel === 'local-db:sessions:get') return ok(session);
        if (channel === 'maker:orca:remote-worker:release') return ok(await host.release(args[0]));
        return undefined;
      };
      const first = setup({ handle });
      await expect(first.workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
      expect(store.saveRemoteWorkerOpen).toHaveBeenCalledOnce();
      expect(store.removeRemoteWorkerOpen).not.toHaveBeenCalled();
      const [, remoteSessionId] = store.saveRemoteWorkerOpen.mock.calls[0] as unknown as [string, string];
      first.workers.stop();
      const receipt = { deviceId: 'mac-mini', remoteSessionId, createdAt: Date.now() };
      store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
      store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
      const second = setup({ handle });
      try {
        await second.workers.releaseEnded([]);
        expect(second.remoteInvoke.mock.calls.map(([, channel]) => channel))
          .toEqual(['local-db:sessions:get', 'maker:orca:remote-worker:release']);
        expect(session!.orcaRemoteLead!.releasedAt).toBe(123);
        expect(store.removeRemoteWorkerOpen).toHaveBeenCalledWith(remoteSessionId);
        expect(store.addRemoteWorker).not.toHaveBeenCalled();
      } finally { second.workers.stop(); }
    },
  );

  it.each(['CHANNEL_NOT_ALLOWED', 'ALREADY_EXISTS'])(
    'discards a definitive rejection without touching another task (%s)', async code => {
      const { workers, remoteInvoke } = setup({ handle: (_device, channel) =>
        channel === 'maker:orca:remote-worker:open' ? fail(code, 'not created') : undefined });
      await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
      expect(store.removeRemoteWorkerOpen).toHaveBeenCalledOnce();
      expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(false);
      workers.stop();
    },
  );

  it('keeps another controller on the same host unaffected by a lost cleanup ACK', async () => {
    const sessions = new Map<string, OrcaRemoteWorkerExistingSession>();
    const hostFor = (controllerDeviceId: string) => createOrcaRemoteWorkerHost({
      getCaller: () => ({ controllerDeviceId }),
      readSession: async id => sessions.get(id) ?? null,
      openSession: async (request, lead) => {
        const opened = { workingDir: '/remote', model: 'device-model', agentKind: request.agentKind, effort: 'medium' };
        sessions.set(request.sessionId, { ...opened, status: 'active', orcaRemoteLead: lead });
        if (controllerDeviceId === 'first-controller') throw new Error('startup failed');
        return opened;
      },
      writeRemoteLead: async (id, lead) => { sessions.set(id, { ...sessions.get(id)!, orcaRemoteLead: lead }); },
      withSessionLock: async <T,>(_id: string, task: () => Promise<T>) => task(),
      now: () => 123,
    });
    const firstHost = hostFor('first-controller');
    const otherHost = hostFor('other-controller');
    const otherRequest = { sessionId: 'other-task', agentKind: 'claude-code', permissionMode: 'auto', title: 'Other',
      lead: { leadSessionId: 'other-lead', leadTitle: 'Other lead', workerLabel: 'other' } };
    const before = await otherHost.open(otherRequest);
    let loseReply = true;
    const { workers } = setup({ handle: async (_device, channel, args) => {
      if (channel === 'maker:orca:remote-worker:open') {
        try { return ok(await firstHost.open(args[0])); }
        catch (err) { return fail('IPC_ERROR', (err as Error).message); }
      }
      if (channel === 'local-db:sessions:get') return ok(sessions.get(args[0] as string));
      if (channel === 'maker:orca:remote-worker:release') {
        const result = await firstHost.release(args[0]);
        if (loseReply) { loseReply = false; return fail('INVOKE_TIMEOUT', 'ACK lost'); }
        return ok(result);
      }
      return undefined;
    } });
    try {
      await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
      const [, remoteSessionId] = store.saveRemoteWorkerOpen.mock.calls[0] as unknown as [string, string];
      const receipt = { deviceId: 'mac-mini', remoteSessionId, createdAt: Date.now() };
      for (let attempt = 0; attempt < 2; attempt++) {
        store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
        store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
        await workers.releaseEnded([]);
        await expect(otherHost.open(otherRequest)).resolves.toEqual(before);
        expect(sessions.get('other-task')!.orcaRemoteLead!.releasedAt).toBeUndefined();
        if (attempt === 0) expect(store.removeRemoteWorkerOpen).not.toHaveBeenCalled();
      }
      expect(store.removeRemoteWorkerOpen).toHaveBeenCalledWith(remoteSessionId);
    } finally { workers.stop(); }
  });

  it.each([false, true])('does not touch a colliding existing task after association fails (remote=%s)', async remote => {
    const existing = { workerId: 'other-worker', teamId: 'other-team', leadSessionId: 'other-lead',
      proxySessionId: 'proxy-1', deviceId: 'other-device', remoteSessionId: 'other-remote', lastBridgedMessageId: null };
    const { workers, remoteInvoke } = setup();
    if (remote) workers.runtime.track(existing);
    store.addRemoteWorker.mockRejectedValueOnce(new Error('UNIQUE constraint failed: sessions.id'));
    store.getRemoteWorkerByProxySession.mockResolvedValueOnce(remote ? existing as never : null);
    const input = { ...openInput, proxySessionId: 'proxy-1', proxySession: proxySeed, remoteSessionId: 'new-remote' };
    try {
      await expect(workers.recordRemoteWorker(input)).rejects.toThrow('UNIQUE');
      await workers.discardRemoteWorker(input);
      expect(store.removeWorker).not.toHaveBeenCalled();
      expect(store.archiveSingleWorkerSession).not.toHaveBeenCalled();
      expect(workers.runtime.isRemote('proxy-1')).toBe(remote);
      expect(remoteInvoke.mock.calls.map(([, channel]) => channel)).toEqual(['maker:orca:remote-worker:release']);
      expect(remoteInvoke.mock.calls[0]![0]).toBe('mac-mini');
      expect(store.removeRemoteWorkerOpen).toHaveBeenCalledWith('new-remote');
    } finally { workers.stop(); }
  });

  it('recovers an open abandoned before association without creating a local proxy', async () => {
    const first = setup();
    const opened = await first.workers.openRemoteWorker(openInput);
    if (!opened.ok) throw Error('expected successful open');
    expect(store.addRemoteWorker).not.toHaveBeenCalled();
    first.workers.stop();
    const receipt = { deviceId: 'mac-mini', remoteSessionId: opened.remoteSessionId, createdAt: Date.now() };
    store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
    store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([receipt] as never[]);
    const second = setup();
    try {
      await second.workers.releaseEnded([]);
      expect(second.remoteInvoke.mock.calls.map(([, channel]) => channel))
        .toEqual(['local-db:sessions:get', 'maker:orca:remote-worker:release']);
      expect(store.removeRemoteWorkerOpen).toHaveBeenCalledWith(opened.remoteSessionId);
      expect(store.addRemoteWorker).not.toHaveBeenCalled();
      expect(store.archiveSingleWorkerSession).not.toHaveBeenCalled();
    } finally { second.workers.stop(); }
  });

  it('rechecks an orphan snapshot after a Worker has become associated', async () => {
    const { workers, remoteInvoke } = setup();
    let deliver!: (rows: never[]) => void;
    let entered!: () => void;
    const gate = new Promise<never[]>((resolve) => { deliver = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    store.listOrphanRemoteWorkerOpens.mockImplementationOnce(async () => { entered(); return gate; });
    const cleanup = workers.releaseEnded([]);
    await reading;
    await workers.recordRemoteWorker({ ...openInput, proxySessionId: 'proxy-1', proxySession: proxySeed, remoteSessionId: 'remote-1' });
    store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([]);
    deliver([{ deviceId: 'mac-mini', remoteSessionId: 'remote-1', createdAt: Date.now() }] as never[]);
    await cleanup;
    expect(store.listOrphanRemoteWorkerOpens).toHaveBeenLastCalledWith('remote-1');
    expect(workers.runtime.isRemote('proxy-1')).toBe(true);
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(false);
    workers.stop();
  });

  it('rejects an old owner open that resumes after a new account starts', async () => {
    let owner = {};
    let finishList!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { finishList = resolve; });
    const listing = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = vi.fn(async () => ok({ version: 1 }));
    let first = true;
    const workers = createOrcaRemoteWorkers({ getOwnerToken: () => owner, remoteInvoke: invoke,
      listDevices: async () => { if (first) { first = false; entered(); await gate; } return { devices: [device({})] }; },
      getTeamService: () => null, broadcastOrcaWorkerChanged: vi.fn(), readLeadTitle: async () => 'Old Lead',
      log: { info: vi.fn(), warn: vi.fn() } });
    const opening = workers.openRemoteWorker(openInput);
    // Attach the rejection assertion before allowing the old asynchronous request to resume.
    const rejected = expect(opening).rejects.toThrow('owner changed');
    await listing;
    workers.stop(); owner = {};
    await workers.start();
    finishList(); await rejected;
    expect(store.saveRemoteWorkerOpen).not.toHaveBeenCalled();
    expect(store.addRemoteWorker).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    workers.stop();
  });

  it('does not associate or discard an old creation in a new account', async () => {
    let owner = {};
    const { workers, remoteInvoke } = setup({ getOwnerToken: () => owner });
    const opened = await workers.openRemoteWorker(openInput);
    if (!opened.ok) throw Error('expected successful open');
    workers.stop(); owner = {}; await workers.start();
    const record = { ...openInput, proxySessionId: opened.proxySessionId, proxySession: opened.proxySession, remoteSessionId: opened.remoteSessionId };
    await expect(workers.recordRemoteWorker(record)).rejects.toThrow('owner changed');
    await workers.discardRemoteWorker(record);
    expect(store.addRemoteWorker).not.toHaveBeenCalled();
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(false);
    workers.stop();
  });

  it('reuses the same remote session id after losing an open reply', async () => {
    let opens = 0;
    const { workers, remoteInvoke } = setup({ handle: (_device, channel) => {
      if (channel === 'maker:orca:remote-worker:open' && ++opens === 1) return fail('INVOKE_TIMEOUT', 'reply lost');
      return undefined;
    } });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: true });
    const calls = remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:orca:remote-worker:open');
    expect(calls).toHaveLength(2);
    expect(calls[0]![2]).toEqual(calls[1]![2]);
    expect(store.saveRemoteWorkerOpen).toHaveBeenCalledOnce();
    workers.stop();
  });

  it('retains an uncertain open for durable cleanup when both replies are lost', async () => {
    const { workers } = setup({ handle: (_device, channel) =>
      channel === 'maker:orca:remote-worker:open' ? fail('INVOKE_TIMEOUT', 'reply lost') : undefined });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
    expect(store.saveRemoteWorkerOpen).toHaveBeenCalledOnce();
    expect(store.removeRemoteWorkerOpen).not.toHaveBeenCalled();
    workers.stop();
  });

  it('retains a timed out open even if the reconciliation receives a definitive error', async () => {
    let opens = 0;
    const { workers } = setup({ handle: (_device, channel) =>
      channel === 'maker:orca:remote-worker:open'
        ? fail(++opens === 1 ? 'INVOKE_TIMEOUT' : 'ALREADY_EXISTS', 'reply lost or released') : undefined });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
    expect(store.removeRemoteWorkerOpen).not.toHaveBeenCalled();
    workers.stop();
  });

  it.each(['REMOTE_WORKDIR_NOT_FOUND', 'REMOTE_WORKDIR_NOT_DIRECTORY', 'REMOTE_WORKDIR_INVALID', 'REMOTE_WORKDIR_UNAVAILABLE'])(
    'preserves the target directory error %s', async (code) => {
      const { workers } = setup({ handle: (_device, channel) => channel === 'maker:orca:remote-worker:open' ? fail(code, 'directory unavailable') : undefined });
      await expect(workers.openRemoteWorker({ ...openInput, workingDir: '/remote/folder' })).resolves.toMatchObject({ ok: false, errorCode: code });
      workers.stop();
    },
  );
});
