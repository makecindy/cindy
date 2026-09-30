import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';
import { projectHistoryView } from '@cindy/maker-shared/message-window';
import type { RemoteMessage } from '@/session/types';

const config = vi.hoisted(() => ({ MOBILE_VISUAL_MOCK_REALDATA_URL: '' }));
vi.mock('@/config/env', () => config);
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  setDeviceIdentity: vi.fn(), setDeviceSessions: vi.fn(), setMessages: vi.fn(),
  setInputProjection: vi.fn(), setPendingInteractions: vi.fn(), setActiveSessionSnapshots: vi.fn(),
} }));
beforeEach(() => { vi.resetModules(); config.MOBILE_VISUAL_MOCK_REALDATA_URL = ''; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('waits for all 1,000 imported tasks before seeding and publishing their device identity', async () => {
  vi.useFakeTimers();
  config.MOBILE_VISUAL_MOCK_REALDATA_URL = 'https://fixture.invalid/snapshot.json';
  let resolveFetch!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveFetch = resolve; })));
  const mock = await import('@/debug/visualMock');
  const { remoteSessionStore: store } = await import('@/session/remoteSessionStore');
  const ready = mock.prepareVisualMockDeviceLinkContext();
  expect(mock.prepareVisualMockDeviceLinkContext()).toBe(ready);
  expect(store.setDeviceSessions).not.toHaveBeenCalled();
  const sessions = Array.from({ length: 1000 }, (_, i) => ({ id: `imported-${i}` }));
  resolveFetch({ ok: true, json: async () => ({ schema: 'cindy-mobile-visual-realdata-v1',
    device: { deviceId: 'real-device', name: 'Imported 1000' }, sessions, messagesBySession: {} }) });
  const link = await ready;
  expect(store.setDeviceSessions).toHaveBeenCalledExactlyOnceWith('real-device', 'Imported 1000', sessions);
  expect(store.setMessages).toHaveBeenCalledTimes(1000);
  expect(link.lastPresenceSnapshot).toMatchObject({ deviceId: 'real-device', deviceName: 'Imported 1000' });
  expect((await link.readDeviceList()).devices.find(device => device.deviceId === 'real-device')?.name).toBe('Imported 1000');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['fetch', 'body'])('falls back when snapshot %s stalls and ignores a late response', async (phase) => {
  vi.useFakeTimers();
  config.MOBILE_VISUAL_MOCK_REALDATA_URL = 'https://fixture.invalid/snapshot.json';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let resolveStalled!: (value: unknown) => void;
  const stalled = new Promise(resolve => { resolveStalled = resolve; });
  const fetchMock = vi.fn(() => phase === 'fetch' ? stalled : Promise.resolve({ ok: true, json: () => stalled }));
  vi.stubGlobal('fetch', fetchMock);
  const mock = await import('@/debug/visualMock');
  const { remoteSessionStore: store } = await import('@/session/remoteSessionStore');
  const ready = mock.prepareVisualMockDeviceLinkContext();
  await vi.advanceTimersByTimeAsync(mock.VISUAL_REALDATA_TIMEOUT_MS - 1);
  expect(store.setDeviceSessions).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  const link = await ready;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(link.lastPresenceSnapshot?.deviceId).toBe(mock.VISUAL_MOCK_DEVICE_ID);
  expect((await link.readDeviceList()).devices.some(device => device.deviceId === mock.VISUAL_MOCK_DEVICE_ID)).toBe(true);
  expect(store.setDeviceSessions).toHaveBeenCalledExactlyOnceWith(
    mock.VISUAL_MOCK_DEVICE_ID, mock.VISUAL_MOCK_DEVICE_NAME, expect.any(Array),
  );
  const sessions = await link.invoke<unknown[]>(mock.VISUAL_MOCK_DEVICE_ID, 'local-db:sessions:list');
  expect(sessions.length).toBeGreaterThan(0);
  const snapshot = { schema: 'cindy-mobile-visual-realdata-v1',
    device: { deviceId: 'late-device', name: 'Late import' }, sessions: [{ id: 'late-session' }], messagesBySession: {} };
  resolveStalled(phase === 'fetch' ? { ok: true, json: async () => snapshot } : snapshot);
  await vi.advanceTimersByTimeAsync(0);
  expect(await link.invoke(mock.VISUAL_MOCK_DEVICE_ID, 'local-db:sessions:list')).toEqual(sessions);
  expect(store.setDeviceSessions).toHaveBeenCalledTimes(1);
  expect(mock.createVisualMockDeviceLinkContext().lastPresenceSnapshot?.deviceId).toBe(mock.VISUAL_MOCK_DEVICE_ID);
  expect(mock.prepareVisualMockDeviceLinkContext()).toBe(ready);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['network', 'http', 'invalid'])('uses a consistent demo device after a %s failure', async (failure) => {
  vi.useFakeTimers();
  config.MOBILE_VISUAL_MOCK_REALDATA_URL = 'https://fixture.invalid/snapshot.json';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => failure === 'network' ? Promise.reject(new Error('offline'))
    : Promise.resolve({ ok: failure !== 'http', status: 503, json: async () => ({}) })));
  const mock = await import('@/debug/visualMock');
  const link = await mock.prepareVisualMockDeviceLinkContext();
  const { remoteSessionStore: store } = await import('@/session/remoteSessionStore');
  expect(link.lastPresenceSnapshot?.deviceId).toBe(mock.VISUAL_MOCK_DEVICE_ID);
  expect(store.setDeviceSessions).toHaveBeenCalledExactlyOnceWith(
    mock.VISUAL_MOCK_DEVICE_ID, mock.VISUAL_MOCK_DEVICE_NAME, expect.any(Array),
  );
  expect(vi.getTimerCount()).toBe(0);
});

it('supplies the task tag catalog required when opening session options', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext();
  expect(await link.invoke(mock.VISUAL_MOCK_DEVICE_ID, 'local-db:task-tags:execute', [{ action: 'list' }]))
    .toMatchObject({ tags: [], sessions: [] });
  expect(await link.invoke(mock.VISUAL_MOCK_DEVICE_ID, 'local-db:task-tags:execute',
    [{ action: 'get', sessionIds: ['session-primary'] }]))
    .toMatchObject({ tags: [], sessions: [{ sessionId: 'session-primary', tags: [] }] });
});

it('projects imported history rows without falling back to synthetic messages', async () => {
  config.MOBILE_VISUAL_MOCK_REALDATA_URL = 'https://fixture.invalid/snapshot.json';
  const rows: RemoteMessage[] = [{ id: 'real-message', clientId: 'real-message',
    sessionId: 'imported', role: 'user', toolUseId: null, agentMeta: null,
    content: 'Imported snapshot content', createdAt: '2026-09-19T00:00:00.000Z' }];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    schema: 'cindy-mobile-visual-realdata-v1', device: { deviceId: 'real-device', name: 'Snapshot' },
    selectedSessionId: 'imported', sessions: [], messagesBySession: { imported: rows },
  }) }));
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext();
  for (const args of [[], ['imported']]) {
    expect(await link.invoke('real-device', 'local-db:messages:view', args)).toEqual({
      version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null,
    });
  }
  expect(await link.invoke('real-device', 'local-db:messages:view', ['missing'])).toEqual({
    version: 1, items: [], hasMore: false, nextCursor: null,
  });
});

it('provides a completed preview task and recommendation without a real prediction', async () => {
  const mock = await import('@/debug/visualMock');
  mock.seedVisualMockStore();
  const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
  expect(getMobileAuthOwner().accountId).toBe(mock.visualMockUser.id);
  const link = mock.createVisualMockDeviceLinkContext();
  const session = await link.invoke<{ lastTurnEndedAt: number }>(mock.VISUAL_MOCK_DEVICE_ID,
    'local-db:sessions:get', ['visual-prompt-recommendation']);
  expect(session.lastTurnEndedAt).toBeGreaterThan(0);
  expect(await link.invoke(mock.VISUAL_MOCK_DEVICE_ID, 'maker:predict-prompt', [
    { sessionId: 'visual-prompt-recommendation', cacheOnly: true },
  ])).toEqual({ prompt: '继续跟进 PR #4670' });
  expect(await link.invoke(mock.VISUAL_MOCK_DEVICE_ID, 'maker:predict-prompt', [
    { sessionId: 'session-primary', cacheOnly: true },
  ])).toEqual({ prompt: null });
});

it('deletes an offline fixture without resurrecting it in later directory reads', async () => {
  const mock = await import('@/debug/visualMock');
  const path = `/api/device-link/devices/${mock.VISUAL_MOCK_OFFLINE_DEVICE_ID}`;
  expect(
    await mock.visualMockApiFetch(path, { baseUrl: '', method: 'DELETE' }),
  ).toEqual({
    deviceId: mock.VISUAL_MOCK_OFFLINE_DEVICE_ID,
    deleted: true,
  });
  const result = await mock.visualMockApiFetch<{ devices: DeviceView[] }>(
    '/api/device-link/devices',
  );
  expect(
    result.devices.some(
      (device) => device.deviceId === mock.VISUAL_MOCK_OFFLINE_DEVICE_ID,
    ),
  ).toBe(false);
  expect(mock.visualMockDevices()).toEqual(result.devices);
  await expect(
    mock.visualMockApiFetch(path, { baseUrl: '', method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('rejects online deletion and partial ID matches without losing devices', async () => {
  const mock = await import('@/debug/visualMock');
  const before = mock.visualMockDevices();
  const path = `/api/device-link/devices/${mock.VISUAL_MOCK_DEVICE_ID}`;
  await expect(
    mock.visualMockApiFetch(path, { baseUrl: '', method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  await expect(
    mock.visualMockApiFetch(`${path}-extra`, { baseUrl: '', method: 'DELETE' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(mock.visualMockDevices()).toEqual(before);
});

it('persists a renamed fixture in later directory reads', async () => {
  const mock = await import('@/debug/visualMock');
  const path = `/api/device-link/devices/${mock.VISUAL_MOCK_DEVICE_ID}`;
  expect(
    await mock.visualMockApiFetch(path, {
      baseUrl: '',
      method: 'PATCH',
      body: { name: '  Office Mac  ' },
    }),
  ).toEqual({
    deviceId: mock.VISUAL_MOCK_DEVICE_ID,
    name: 'Office Mac',
  });
  const result = await mock.visualMockApiFetch<{ devices: DeviceView[] }>(
    '/api/device-link/devices',
  );
  expect(
    result.devices.find(
      (device) => device.deviceId === mock.VISUAL_MOCK_DEVICE_ID,
    )?.name,
  ).toBe('Office Mac');
});
