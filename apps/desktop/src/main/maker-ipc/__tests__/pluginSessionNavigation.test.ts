import { describe, expect, it, vi } from 'vitest';
import type { InvokeResultPayload } from '@cindy/device-link';
import { createGhostPageBridge } from '../../../shared/ghostPageBridge.js';
import { handlePluginObserveRequest } from '../../cindy-brain/pluginObserveSlot.js';
import { openPluginSession, readPluginSessionStatuses } from '../pluginSessionNavigation.js';

function fixture() {
  const session = { id: 'session', status: 'active', hiddenAt: null as string | null };
  const ports = {
    selfDeviceId: () => 'self',
    readLocal: vi.fn(async () => session),
    readRemote: vi.fn(async (): Promise<InvokeResultPayload> => ({ ok: true, result: session })),
    closeEpoch: vi.fn(() => 0),
    navigate: vi.fn(),
  };
  const hasHistory = vi.fn(() => true);
  const request = (deviceId?: string) => handlePluginObserveRequest({
    projectTasks: async () => [],
    openTask: async () => {},
    openSession: (id, device, guard) => openPluginSession(ports, id, device, guard),
  }, { kind: 'open-session', sessionId: 'session', deviceId }, () => {}, hasHistory);
  return { ports, session, hasHistory, request };
}

it('routes identical session ids to the explicitly selected computer', async () => {
  const { ports, request } = fixture();
  await expect(request('remote')).resolves.toMatchObject({ ok: true, data: { opened: true } });
  expect(ports.readLocal).not.toHaveBeenCalled();
  expect(ports.navigate).toHaveBeenCalledWith('session', 'remote');
  await request('self');
  expect(ports.navigate).toHaveBeenLastCalledWith('session', 'local');
});

it('requires history approval before reading and rechecks it before navigating', async () => {
  const { ports, session, request, hasHistory } = fixture();
  hasHistory.mockReturnValue(false);
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  expect(ports.readRemote).not.toHaveBeenCalled();
  hasHistory.mockReturnValue(true);
  ports.readRemote.mockImplementationOnce(async () => {
    hasHistory.mockReturnValue(false);
    return { ok: true, result: session };
  });
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  expect(ports.navigate).not.toHaveBeenCalled();
});

it('ignores a remote reply after the link closes', async () => {
  const { ports, session, request } = fixture();
  ports.readRemote.mockImplementationOnce(async () => {
    ports.closeEpoch.mockReturnValue(1);
    return { ok: true, result: session };
  });
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'REMOTE_UNAVAILABLE' } });
  expect(ports.navigate).not.toHaveBeenCalled();
});

it.each([undefined, 'remote'])('rejects hidden active sessions on %s', async (device) => {
  const { ports, session, request } = fixture();
  session.hiddenAt = '2026-11-20T00:00:00Z';
  await expect(request(device)).resolves.toMatchObject({ error: { code: 'TARGET_UNAVAILABLE' } });
  expect(ports.navigate).not.toHaveBeenCalled();
});

it('distinguishes a missing remote session from an unavailable connection', async () => {
  const { ports, request } = fixture();
  ports.readRemote.mockResolvedValueOnce({ ok: false, error: { code: 'IPC_ERROR', message: '[NOT_FOUND] Session 不存在' } });
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'TARGET_UNAVAILABLE' } });
  ports.readRemote.mockResolvedValueOnce({ ok: false, error: { code: 'DEVICE_OFFLINE', message: 'Offline' } });
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'REMOTE_UNAVAILABLE' } });
  expect(ports.navigate).not.toHaveBeenCalled();
});

// Unit coverage for the observe/history contract and engineering-conventions §8.1.
// Navigation alone cannot show which computer supplied a status or which fields reached the plugin.
describe('session-status', () => {
  const channel = 'local-db:sessions:get-many';
  const localRow = { id: 'session', status: 'idle' as const };
  const remoteRow = { id: 'session', status: 'running' };
  const remoteReply = { ok: true, result: { sessions: [{ ...remoteRow, title: 'private', latestMessageExtract: 'preview' }] } } as const;
  const failure = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });

  function statusFixture() {
    const access = { observe: true, history: true, account: 'first' };
    const device = { deviceId: 'remote', platform: 'darwin', online: true, controlEnabled: true, remoteControlEnabled: true };
    const ports = {
      selfDeviceId: () => 'self',
      closeEpoch: vi.fn(() => 0),
      listDevices: vi.fn(async () => [device]),
      readLocal: vi.fn(async (_ids: string[]) => [localRow]),
      invoke: vi.fn<Parameters<typeof readPluginSessionStatuses>[0]['invoke']>().mockResolvedValue(remoteReply),
    };
    const send = (payload: unknown) => {
      const account = access.account;
      return handlePluginObserveRequest({
        projectTasks: async () => [],
        openTask: async () => {},
        sessionStatus: (ids, target, guard) => readPluginSessionStatuses(ports, ids, target, guard),
      }, payload, () => {
        if (!access.observe || access.account !== account) throw new Error('PERMISSION_DENIED');
      }, () => access.history);
    };
    const page = createGhostPageBridge({ ping: async () => ({ ok: true, id: 'plugin' }), send }).api;
    const request = (deviceId?: string, sessionIds: unknown = ['session']) => send({ kind: 'session-status', deviceId, sessionIds });
    return { access, device, ports, page, request };
  }

  it('reads the selected computer and returns only matched ids and sidebar statuses', async () => {
    const { ports, page } = statusFixture();
    const ids = ['session', ...Array.from({ length: 199 }, (_, i) => `missing-${i}`)];
    const read = page.observe.sessionStatus!;
    await expect(read({ sessionIds: ids })).resolves.toEqual({ sessions: [localRow] });
    expect(ports.readLocal).toHaveBeenCalledExactlyOnceWith(ids);
    await expect(read({ sessionIds: ['session'], deviceId: 'self' })).resolves.toEqual({ sessions: [localRow] });
    await expect(read({ deviceId: 'remote', sessionIds: ['session', 'missing', 'session'] })).resolves.toEqual({ sessions: [remoteRow] });
    expect(ports.invoke).toHaveBeenCalledExactlyOnceWith('remote', channel,
      [{ projection: 'sidebar-status', ids: ['session', 'missing'] }], { preSend: expect.any(Function), noResultCache: true });
  });

  it.each([
    ['empty batch', 'remote', []],
    ['201 ids before deduplication', 'remote', Array<string>(201).fill('session')],
    ['shared device', 'share:remote', ['session']],
    ['device-qualified session', 'remote', ['remote::session']],
  ] as const)('rejects a request with %s before lookup', async (_case, device, ids) => {
    const { ports, request } = statusFixture();
    await expect(request(device, ids)).resolves.toEqual(failure('INVALID_PARAMS'));
    expect(ports.readLocal).not.toHaveBeenCalled();
    expect(ports.listDevices).not.toHaveBeenCalled();
    expect(ports.invoke).not.toHaveBeenCalled();
  });

  it.each(['observe', 'history'] as const)('requires %s approval before reading', async approval => {
    const { access, ports, request } = statusFixture();
    access[approval] = false;
    await expect(request('remote')).resolves.toEqual(failure('PERMISSION_DENIED'));
    expect(ports.listDevices).not.toHaveBeenCalled();
    expect(ports.invoke).not.toHaveBeenCalled();
  });

  it('withholds ids if history is withdrawn while opening the background link', async () => {
    const { access, ports, request } = statusFixture();
    const send = vi.fn();
    ports.invoke.mockImplementationOnce(async (_target, _channel, _args, options) => {
      access.history = false;
      options?.preSend?.();
      send();
      return remoteReply;
    });
    await expect(request('remote')).resolves.toEqual(failure('PERMISSION_DENIED'));
    expect(send).not.toHaveBeenCalled();
  });

  it('discards local statuses if the account changes during the read', async () => {
    const { access, ports, request } = statusFixture();
    ports.readLocal.mockImplementationOnce(async () => {
      access.account = 'next';
      return [localRow];
    });
    await expect(request('local')).resolves.toEqual(failure('PERMISSION_DENIED'));
  });

  it.each([
    ['observe approval', 'PERMISSION_DENIED'],
    ['link epoch', 'REMOTE_UNAVAILABLE'],
  ] as const)('discards a remote reply after the %s changes', async (change, code) => {
    const { access, ports, request } = statusFixture();
    ports.invoke.mockImplementationOnce(async () => {
      if (change === 'observe approval') access.observe = false;
      else ports.closeEpoch.mockReturnValue(1);
      return remoteReply;
    });
    await expect(request('remote')).resolves.toEqual(failure(code));
  });

  it.each([
    ['online', 'REMOTE_UNAVAILABLE'],
    ['controlEnabled', 'PERMISSION_DENIED'],
    ['remoteControlEnabled', 'PERMISSION_DENIED'],
  ] as const)('stops before dispatch when the directory reports %s is false', async (flag, code) => {
    const { device, ports, request } = statusFixture();
    device[flag] = false;
    await expect(request('remote')).resolves.toEqual(failure(code));
    expect(ports.invoke).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'IPC_ERROR', message: '[INVALID_PARAMS] sessionIds must be an array of at most 32 ids' }, 'UNSUPPORTED_CAPABILITY'],
    [{ code: 'IPC_ERROR', message: '[INVALID_PARAMS] sessionIds must be an array' }, 'REMOTE_UNAVAILABLE'],
    [{ code: 'IPC_ERROR', message: `[NOT_FOUND] no local IPC handler for channel '${channel}'` }, 'UNSUPPORTED_CAPABILITY'],
    [{ code: 'IPC_ERROR', message: "[NOT_FOUND] no local IPC handler for channel 'local-db:sessions:get'" }, 'REMOTE_UNAVAILABLE'],
    [{ code: 'CHANNEL_NOT_ALLOWED', message: `channel '${channel}' not allowed remotely` }, 'UNSUPPORTED_CAPABILITY'],
    [{ code: 'CHANNEL_NOT_ALLOWED', message: `channel '${channel}' not allowed` }, 'PERMISSION_DENIED'],
    [new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Encrypted transport required'), 'PERMISSION_DENIED'],
    [{ code: 'ACCESS_REVOKED', message: 'access revoked by target device' }, 'PERMISSION_DENIED'],
    // Device Link forwards the source status reader's account-switch error message in IPC_ERROR.
    [{ code: 'IPC_ERROR', message: 'PERMISSION_DENIED' }, 'PERMISSION_DENIED'],
    [new Error('[UNSUPPORTED_CAPABILITY] remote device does not support background links'), 'UNSUPPORTED_CAPABILITY'],
  ] as const)('maps %s to %s without retrying a preview read', async (error, code) => {
    const { ports, request } = statusFixture();
    if (error instanceof Error) ports.invoke.mockRejectedValueOnce(error);
    else ports.invoke.mockResolvedValueOnce({ ok: false, error });
    await expect(request('remote')).resolves.toEqual(failure(code));
    expect(ports.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['legacy preview array', [remoteRow]],
    ['unrequested id', { sessions: [remoteRow, { id: 'outside', status: 'idle' }] }],
    ['duplicate id', { sessions: [remoteRow, remoteRow] }],
    ['record status', { sessions: [remoteRow, { id: 'other', status: 'active' }] }],
  ] as const)('rejects the entire remote batch for a %s', async (_reason, result) => {
    const { ports, request } = statusFixture();
    ports.invoke.mockResolvedValueOnce({ ok: true, result });
    await expect(request('remote', ['session', 'other'])).resolves.toEqual(failure('REMOTE_UNAVAILABLE'));
  });
});
