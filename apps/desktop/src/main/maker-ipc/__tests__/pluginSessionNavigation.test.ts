import { expect, it, vi } from 'vitest';
import type { InvokeResultPayload } from '@cindy/device-link';
import { handlePluginObserveRequest } from '../../cindy-brain/pluginObserveSlot.js';
import { openPluginSession } from '../pluginSessionNavigation.js';

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
