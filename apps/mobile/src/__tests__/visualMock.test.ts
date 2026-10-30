import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PLUGIN_COLLECTION, type DeviceView } from '@cindy/device-link';
import { getRemoteResource, listRemoteCollection, normalizeRemoteCollectionItems } from '@/device-link/remoteResources';
import { invokePlugin } from '@/plugins/pluginClient';
import { projectHistoryView } from '@cindy/maker-shared/message-window';
import type { RemoteMessage } from '@/session/types';
import { UI_MOCK_PROJECTS } from '@cindy/maker-shared/ui-mock';
import { markdownPreviewFixture } from '@/debug/markdownPreviewFixture';
import type { FileBrowserReadFileResult, FileBrowserListAllFilesResult } from '@/device-link/mobileMakerTransport';

const config = vi.hoisted(() => ({ MOBILE_VISUAL_MOCK_REALDATA_URL: '' }));
vi.mock('@/config/env', () => config);
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  setDeviceIdentity: vi.fn(), setDeviceSessions: vi.fn(), setMessages: vi.fn(),
  setInputProjection: vi.fn(), setPendingInteractions: vi.fn(), setActiveSessionSnapshots: vi.fn(),
} }));
beforeEach(() => { vi.resetModules(); config.MOBILE_VISUAL_MOCK_REALDATA_URL = ''; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('serves showcase files without replacing legacy Markdown and media regression fixtures', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext();
  for (const name of ['orbit-garden-zh', 'orbit-garden-en']) {
    const project = UI_MOCK_PROJECTS.find(item => item.name === name)!;
    const request = <T>(args: Record<string, unknown>) => link.invoke<T>(mock.VISUAL_MOCK_DEVICE_ID, 'file-browser:remote-op', [{ workdir: `/Users/demo/Projects/${project.name}`, ...args }]);
    expect(await request({ op: 'listDir', relPath: '' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'directory', name: 'reports', relPath: 'reports' }),
      expect.objectContaining({ type: 'file', name: 'README.md' }),
    ]));
    expect(await request({ op: 'listDir', relPath: 'reports' })).toEqual([
      expect.objectContaining({ type: 'file', name: 'playtest.md', relPath: 'reports/playtest.md' }),
    ]);
    const result = await request<FileBrowserReadFileResult>({ op: 'readFile', relPath: 'reports/playtest.md' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.content).toBe(project.files['reports/playtest.md']);
      expect(result.data.size).toBe(new TextEncoder().encode(result.data.content).byteLength);
    }
    expect(await request({ op: 'readFile', relPath: '../private.md' })).toMatchObject({ ok: false, code: 'READ_FAILED' });
    expect(await request({ op: 'listDir', relPath: '../' })).toEqual([]);
    const all = await request<FileBrowserListAllFilesResult>({ op: 'listAllFiles', cap: 2 });
    expect(all.files).toHaveLength(2);
    expect(all.truncated).toBe(true);
    expect(await request({ op: 'searchCollect', query: '24' })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ relPath: 'reports/playtest.md' })]) });
    expect(await request({ op: 'searchCollect', query: 'does-not-exist' })).toMatchObject({ matches: [], totalFiles: 0, totalMatches: 0, truncated: false });
    expect(await request({ op: 'searchCollect', query: 'orbit garden', caseSensitive: true })).toMatchObject({ matches: [], totalFiles: 0 });
    expect(await request({ op: 'searchCollect', query: 'orbit garden', maxMatches: 1 })).toMatchObject({ matches: [expect.any(Object)], totalFiles: 1, totalMatches: 1, truncated: true });
  }

  // Regression: matching every shared project hid the old media and Markdown fixtures.
  // Exercise the real mock transport with remote POSIX paths; no filesystem or network.
  for (const name of ['cindy-demo', 'design-system']) {
    const request = (args: Record<string, unknown>) => link.invoke(mock.VISUAL_MOCK_DEVICE_ID,
      'file-browser:remote-op', [{ workdir: `/Users/demo/Projects/${name}`, ...args }]);
    expect(await request({ op: 'listDir', relPath: '' })).toEqual(expect.arrayContaining(
      ['README.md', 'visual-report.md', 'chart.png', 'demo.mp4'].map(relPath => expect.objectContaining({ type: 'file', relPath })),
    ));
    expect(await request({ op: 'readFile', relPath: 'README.md' })).toMatchObject({ ok: true, data: { content: markdownPreviewFixture } });
    expect(await request({ op: 'readFile', relPath: 'visual-report.md' })).toMatchObject({ ok: true, data: { content: expect.stringContaining('Swipe right') } });
    expect(await request({ op: 'thumbnail', relPath: 'chart.png' })).toMatchObject({ ok: true, dataBase64: expect.any(String) });
    expect(await request({ op: 'caps' })).toMatchObject({ ok: true, gzip: true });
    expect(await request({ op: 'listAllFiles' })).toMatchObject({ files: expect.arrayContaining(['apps/mobile/app/_layout.tsx']) });
    expect(await request({ op: 'searchCollect', query: 'DeviceLinkProvider' })).toMatchObject({ matches: expect.arrayContaining([
      expect.objectContaining({ relPath: 'apps/mobile/app/_layout.tsx', lineText: 'DeviceLinkProvider' }),
    ]) });
  }
});

it('supplies valid demo plugin projections and confirms enable/disable through the real client', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext();
  const host = { deviceId: mock.VISUAL_MOCK_DEVICE_ID, deviceName: mock.VISUAL_MOCK_DEVICE_NAME };
  const items = normalizeRemoteCollectionItems(await listRemoteCollection(link.invoke, host, PLUGIN_COLLECTION), PLUGIN_COLLECTION);
  expect(items).toHaveLength(28);
  expect(items.filter(item => item.display.badges?.length)).toHaveLength(2);
  const ref = items[0].ref;
  await invokePlugin(link.invoke, host.deviceId, ref.id, 'disable');
  expect((await getRemoteResource(link.invoke, host, ref)).actions).toEqual([{ id: 'enable', label: 'Enable', disabled: false }]);
  await invokePlugin(link.invoke, host.deviceId, ref.id, 'enable');
  expect((await getRemoteResource(link.invoke, host, ref)).actions).toEqual([{ id: 'disable', label: 'Disable', disabled: false }]);
  await expect(invokePlugin(link.invoke, host.deviceId, ref.id, 'unexpected')).rejects.toThrow('UNSUPPORTED_DEMO_PLUGIN_ACTION');
});

it('does not add demo plugins to an imported real-data preview', async () => {
  config.MOBILE_VISUAL_MOCK_REALDATA_URL = 'https://fixture.invalid/snapshot.json';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    schema: 'cindy-mobile-visual-realdata-v1', device: { deviceId: 'real-device', name: 'Snapshot' },
    sessions: [], messagesBySession: {},
  }) }));
  const mock = await import('@/debug/visualMock');
  const link = await mock.prepareVisualMockDeviceLinkContext();
  const host = { deviceId: 'real-device', deviceName: 'Snapshot' };
  expect(normalizeRemoteCollectionItems(await listRemoteCollection(link.invoke, host, PLUGIN_COLLECTION), PLUGIN_COLLECTION)).toEqual([]);
});

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

it('generates a rename draft without changing the demo task title', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext();
  const readSession = () => link.invoke<{ title: string }>(mock.VISUAL_MOCK_DEVICE_ID,
    'local-db:sessions:get', [mock.VISUAL_MOCK_SESSION_ID]);
  const original = await readSession();
  const draft = await link.invoke<{ title: string }>(mock.VISUAL_MOCK_DEVICE_ID,
    'maker:regenerate-title', [{ sessionId: mock.VISUAL_MOCK_SESSION_ID }]);
  expect(draft.title.trim()).not.toBe('');
  expect(draft.title).not.toBe(original.title);
  expect((await readSession()).title).toBe(original.title);
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
it('returns task preferences through the same action result envelope as the real Host', async () => {
  const { pluginVisualFixture } = await import('@/debug/pluginVisualFixture');
  const { REMOTE_RESOURCE_INVOKE_CHANNEL } = await import('@cindy/device-link');
  expect(pluginVisualFixture(REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    resourceRef: { collectionId: 'plugins', id: '8' }, actionId: 'task-settings:get',
  }])).toMatchObject({ effects: [], result: { revision: 'demo-prefs', config: {}, permissionModes: ['ask', 'auto'] } });
});
it('allows preview deep links only for explicit development visual mock fixtures', async () => {
  const { pluginVisualPreview } = await import('@/debug/pluginVisualFixture');
  vi.stubGlobal('__DEV__', false);
  vi.stubEnv('EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK', '1');
  expect(pluginVisualPreview('1-settings')).toBeUndefined();
  vi.stubGlobal('__DEV__', true);
  expect(pluginVisualPreview('1-settings')).toEqual({ id: '1', settings: true });
  expect(pluginVisualPreview('real-plugin')).toBeUndefined();
  expect(pluginVisualPreview('99')).toBeUndefined();
  vi.stubEnv('EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK', '0');
  expect(pluginVisualPreview('1')).toBeUndefined();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
