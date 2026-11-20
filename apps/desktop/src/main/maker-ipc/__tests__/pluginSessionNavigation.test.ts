import { expect, it, vi } from 'vitest';
import { handlePluginObserveRequest } from '../../cindy-brain/pluginObserveSlot.js';
import { openPluginSession } from '../pluginSessionNavigation.js';

function fixture() {
  const session = { id: 'session', status: 'active' };
  const ports = {
    selfDeviceId: () => 'self',
    readLocal: vi.fn(async () => session),
    readRemote: vi.fn(async () => ({ ok: true as const, result: session })),
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
  expect(ports.navigate).toHaveBeenLastCalledWith('session', undefined);
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

it('ignores a remote reply after the link closes and rejects hidden targets', async () => {
  const { ports, session, request } = fixture();
  ports.readRemote.mockImplementationOnce(async () => {
    ports.closeEpoch.mockReturnValue(1);
    return { ok: true, result: session };
  });
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'REMOTE_UNAVAILABLE' } });
  ports.readRemote.mockResolvedValueOnce({ ok: true, result: { ...session, status: 'deleted' } });
  await expect(request('remote')).resolves.toMatchObject({ error: { code: 'TARGET_UNAVAILABLE' } });
  expect(ports.navigate).not.toHaveBeenCalled();
});
