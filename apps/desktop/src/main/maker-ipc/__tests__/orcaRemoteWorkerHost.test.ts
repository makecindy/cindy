import { describe, expect, it, vi } from 'vitest';
import {
  ORCA_REMOTE_WORKER_CAPS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL,
  ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
  ORCA_REMOTE_WORKER_VERSION,
} from '@cindy/device-link';

import {
  createOrcaRemoteWorkerHost,
  registerOrcaRemoteWorkerHandlers,
  type OrcaRemoteWorkerCaller,
  type OrcaRemoteWorkerExistingSession,
  type OrcaRemoteWorkerHostDeps,
} from '../orcaRemoteWorkerHost.js';
import type { OrcaRemoteLead } from '../../../shared/orcaRemoteWorker.js';

const request = {
  sessionId: 'w_remote_1',
  agentKind: 'claude-code',
  permissionMode: 'auto',
  title: 'Worker · 转写',
  lead: { leadSessionId: 'lead-1', leadTitle: '整理产品访谈报告', workerLabel: '转写' },
};

function setup(
  options: {
    caller?: OrcaRemoteWorkerCaller | null;
    existing?: OrcaRemoteWorkerExistingSession | null;
  } = {},
) {
  const sessions = new Map<string, OrcaRemoteWorkerExistingSession>();
  if (options.existing) sessions.set(request.sessionId, options.existing);
  const deps: OrcaRemoteWorkerHostDeps = {
    getCaller: () =>
      options.caller === undefined
        ? { controllerDeviceId: 'dev-xdpc', controllerName: 'XD-PC' }
        : options.caller,
    readSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    openSession: vi.fn(async (req, lead: OrcaRemoteLead) => {
      sessions.set(req.sessionId, {
        status: 'active',
        orcaRemoteLead: lead,
        workingDir: req.workingDir ?? '/Users/demo/Cindy/dialogues/w_remote_1',
        model: 'claude-opus-5-5',
        agentKind: req.agentKind,
        effort: req.effort ?? 'medium',
      });
      return {
        workingDir: req.workingDir ?? '/Users/demo/Cindy/dialogues/w_remote_1',
        model: 'claude-opus-5-5',
        agentKind: req.agentKind,
        effort: req.effort ?? 'medium',
      };
    }),
    writeRemoteLead: vi.fn(async (id: string, lead: OrcaRemoteLead) => {
      const current = sessions.get(id);
      if (current) sessions.set(id, { ...current, orcaRemoteLead: lead });
    }),
    withSessionLock: vi.fn(async (_id, task) => task()),
    now: () => 1_000,
  };
  return { deps, sessions, host: createOrcaRemoteWorkerHost(deps) };
}

describe('orca remote worker host', () => {
  it('only answers device-link callers', async () => {
    const { host } = setup({ caller: null });
    expect(() => host.caps()).toThrow(/PRECONDITION_FAILED/);
    await expect(host.open(request)).rejects.toThrow(/PRECONDITION_FAILED/);
    await expect(host.release({ sessionId: 'w_remote_1' })).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('refuses shared-task guests', async () => {
    const { host } = setup({ caller: { controllerDeviceId: 'guest', sharedTask: {} } });
    await expect(host.open(request)).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('reports its protocol version', () => {
    expect(setup().host.caps()).toEqual({ version: ORCA_REMOTE_WORKER_VERSION });
  });

  it('opens a worker task stamped with the server-verified caller, ignoring payload claims', async () => {
    const { host, deps } = setup();
    const result = await host.open({
      ...request,
      leadDeviceId: 'spoofed',
      leadDeviceName: 'spoofed',
    });
    expect(result).toEqual({
      sessionId: 'w_remote_1',
      workingDir: '/Users/demo/Cindy/dialogues/w_remote_1',
      model: 'claude-opus-5-5',
      agentKind: 'claude-code',
      effort: 'medium',
    });
    expect(deps.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'w_remote_1', permissionMode: 'auto' }),
      {
        leadDeviceId: 'dev-xdpc',
        leadDeviceName: 'XD-PC',
        leadSessionId: 'lead-1',
        leadTitle: '整理产品访谈报告',
        workerLabel: '转写',
      },
    );
    expect(deps.withSessionLock).toHaveBeenCalledWith('w_remote_1', expect.any(Function));
  });

  it('is idempotent for the same caller and lead', async () => {
    const { host, deps } = setup();
    const first = await host.open(request);
    const second = await host.open(request);
    expect(second).toEqual(first);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
  });

  it.each(['archived', 'deleted'] as const)('does not reopen a %s task after rebuilding the host', async status => {
    const { host, deps, sessions } = setup();
    await host.open(request);
    sessions.set(request.sessionId, { ...sessions.get(request.sessionId)!, status });

    await expect(createOrcaRemoteWorkerHost(deps).open(request)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(deps.openSession).toHaveBeenCalledOnce();
    expect(deps.writeRemoteLead).not.toHaveBeenCalled();
    expect(sessions.get(request.sessionId)?.status).toBe(status);
    expect(sessions.get(request.sessionId)?.orcaRemoteLead?.releasedAt).toBeUndefined();
  });

  it('replays the stored effort instead of a changed request or device default', async () => {
    const { host, deps } = setup();
    await host.open({ ...request, effort: 'low' });
    await expect(host.open({ ...request, effort: 'high' })).resolves.toMatchObject({ effort: 'low' });
    expect(deps.openSession).toHaveBeenCalledOnce();
  });

  it.each([false, true])('replays stored Fast %s after rebuilding the host instead of a changed request', async fastMode => {
    const { host, deps, sessions } = setup();
    deps.openSession = vi.fn(async (req, lead) => {
      const stored = { status: 'active' as const, orcaRemoteLead: lead, workingDir: '/remote', model: 'm',
        agentKind: req.agentKind, fastMode };
      sessions.set(req.sessionId, stored);
      return stored;
    });
    await expect(host.open({ ...request, fastMode: !fastMode })).resolves.toMatchObject({ fastMode });
    await expect(createOrcaRemoteWorkerHost(deps).open({ ...request, fastMode: !fastMode }))
      .resolves.toMatchObject({ fastMode });
    expect(deps.openSession).toHaveBeenCalledOnce();
  });

  it('refuses an id already used by another task or device', async () => {
    const plain = setup({
      existing: { status: 'active', orcaRemoteLead: null, workingDir: '/x', model: 'm', agentKind: 'codex' },
    });
    await expect(plain.host.open(request)).rejects.toThrow(/ALREADY_EXISTS/);

    const other = setup();
    await other.host.open(request);
    const foreign = createOrcaRemoteWorkerHost({
      ...other.deps,
      getCaller: () => ({ controllerDeviceId: 'dev-other' }),
    });
    await expect(foreign.open(request)).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it('does not reopen a released worker under the same id', async () => {
    const { host } = setup();
    await host.open(request);
    await host.release({ sessionId: 'w_remote_1' });
    await expect(host.open(request)).rejects.toThrow(/ALREADY_EXISTS/);
  });

  it('marks release once and keeps the task', async () => {
    const { host, deps, sessions } = setup();
    await host.open(request);
    await expect(host.release({ sessionId: 'w_remote_1' })).resolves.toEqual({ released: true });
    await expect(host.release({ sessionId: 'w_remote_1' })).resolves.toEqual({ released: true });
    expect(deps.writeRemoteLead).toHaveBeenCalledTimes(1);
    expect(sessions.get('w_remote_1')?.orcaRemoteLead?.releasedAt).toBe(1_000);
  });

  it('treats a task deleted on this computer as released', async () => {
    await expect(setup().host.release({ sessionId: 'w_remote_1' })).resolves.toEqual({
      released: true,
    });
  });

  it('refuses to release a task owned by another device', async () => {
    const { host, deps } = setup();
    await host.open(request);
    const foreign = createOrcaRemoteWorkerHost({
      ...deps,
      getCaller: () => ({ controllerDeviceId: 'dev-other' }),
    });
    await expect(foreign.release({ sessionId: 'w_remote_1' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('registers the three device-link channels', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const { host } = setup();
    registerOrcaRemoteWorkerHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      host,
    );
    expect([...handlers.keys()].sort()).toEqual(
      [
        ORCA_REMOTE_WORKER_CAPS_CHANNEL,
        ORCA_REMOTE_WORKER_OPEN_CHANNEL,
        ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
      ].sort(),
    );
    await expect(
      handlers.get(ORCA_REMOTE_WORKER_OPEN_CHANNEL)!({}, request),
    ).resolves.toMatchObject({
      sessionId: 'w_remote_1',
    });
  });
});
