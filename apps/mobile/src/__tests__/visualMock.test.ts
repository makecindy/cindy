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
afterEach(() => vi.unstubAllGlobals());

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

it('keeps the More menu tag catalog and session tags consistent across reads', async () => {
  const { createVisualMockDeviceLinkContext, VISUAL_MOCK_DEVICE_ID: device } = await import('@/debug/visualMock');
  const link = createVisualMockDeviceLinkContext();
  const tags = (request: import('@cindy/maker-shared').TaskTagRequest) => link.invoke<import('@cindy/maker-shared').TaskTagResult>(device, 'local-db:task-tags:execute', [request]);
  const id = 'visual-prompt-recommendation';
  expect((await tags({ action: 'get', sessionIds: [id] })).sessions).toEqual([{ sessionId: id, tags: [] }]);
  const created = await tags({ action: 'create', name: 'Review', color: 'green' });
  const tag = created.tags.find((t) => t.name === 'Review')!;
  const attached = await tags({ action: 'attach', sessionIds: [id], tagIds: [tag.id] });
  expect(attached.sessions[0].tags[0].id).toBe(tag.id);
  const revision = attached.tags.find((t) => t.id === tag.id)!.revision;
  const updated = await tags({ action: 'update', tagId: tag.id, revision, name: 'Verified', color: 'blue' });
  expect((await tags({ action: 'get', sessionIds: [id] })).sessions[0].tags[0].name).toBe('Verified');
  await expect(tags({ action: 'update', tagId: tag.id, revision, name: 'Stale' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await tags({ action: 'find', tagId: tag.id })).sessions.map((s) => s.sessionId)).toEqual([id]);
  const before = await tags({ action: 'previewDelete', tagId: tag.id });
  expect(before.deletion?.count).toBe(1);
  await expect(tags({ action: 'delete', tagId: tag.id, revision: updated.tags[0].revision, expectedCount: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
  await tags({ action: 'detach', sessionIds: [id], tagIds: [tag.id] });
  const preview = (await tags({ action: 'previewDelete', tagId: tag.id })).deletion!;
  await tags({ action: 'delete', tagId: tag.id, revision: preview.revision, expectedCount: preview.count });
  expect((await tags({ action: 'get', sessionIds: [id] })).sessions[0].tags).toEqual([]);
  expect((await tags({ action: 'list' })).tags).not.toContainEqual(expect.objectContaining({ id: tag.id }));
});

it('does not resurrect pin/archive/rename mutations on list refresh or reseed', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext(), device = mock.VISUAL_MOCK_DEVICE_ID;
  const id = 'visual-prompt-recommendation';
  const patch = (value: object) => link.invoke(device, 'local-db:sessions:patch-meta', [id, value]);
  const list = (status = 'active') => link.invoke<import('@/session/types').RemoteSession[]>(device, 'local-db:sessions:list', [100, status, { includePinned: true, fresh: true }]);
  const updatedAt = (await list()).find((s) => s.id === id)!.updatedAt;
  await expect(patch({ pinnedAt: '2026-09-28T12:00:00.000Z', title: 'Renamed' })).resolves.toMatchObject({ updatedAt });
  mock.seedVisualMockStore();
  expect((await list()).find((s) => s.id === id)).toMatchObject({ title: 'Renamed', pinnedAt: '2026-09-28T12:00:00.000Z' });
  await expect(patch({ pinnedAt: null })).resolves.toMatchObject({ updatedAt });
  expect((await list()).find((s) => s.id === id)?.pinnedAt).toBeNull();
  await expect(patch({ status: 'archived' })).resolves.toMatchObject({ updatedAt });
  expect((await list()).some((s) => s.id === id)).toBe(false);
  expect((await list('archived')).some((s) => s.id === id)).toBe(true);
  await expect(patch({ status: 'active' })).resolves.toMatchObject({ updatedAt });
  expect((await list()).some((s) => s.id === id)).toBe(true);
  await patch({ status: 'deleted' });
  expect((await list('all')).some((s) => s.id === id)).toBe(false);
  await expect(link.invoke(device, 'local-db:sessions:get', [id])).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('supports imported sessions without mutating the snapshot and isolates simulated hosts', async () => {
  config.MOBILE_VISUAL_MOCK_REALDATA_URL = 'https://fixture.invalid/snapshot.json';
  const session = { id: 'imported', title: 'Original', status: 'active', tags: [], updatedAt: '2026-09-28T00:00:00.000Z' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    schema: 'cindy-mobile-visual-realdata-v1', device: { deviceId: 'real-device', name: 'Snapshot' },
    sessions: [session], messagesBySession: {},
  }) }));
  const { createVisualMockDeviceLinkContext } = await import('@/debug/visualMock');
  const link = createVisualMockDeviceLinkContext();
  await link.invoke('real-device', 'local-db:sessions:patch-meta', ['imported', { title: 'Updated' }]);
  expect(await link.invoke('real-device', 'local-db:sessions:get', ['imported'])).toMatchObject({ title: 'Updated' });
  expect(await link.invoke('another-device', 'local-db:sessions:get', ['imported'])).toMatchObject({ title: 'Original' });
  expect(session.title).toBe('Original');
});

it('rejects invalid bulk tag operations atomically and protects returned snapshots', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext(), device = mock.VISUAL_MOCK_DEVICE_ID;
  const execute = (r: import('@cindy/maker-shared').TaskTagRequest) => link.invoke<import('@cindy/maker-shared').TaskTagResult>(device, 'local-db:task-tags:execute', [r]);
  const { tags } = await execute({ action: 'create', name: 'A', color: 'green' });
  const id = tags[0].id;
  await expect(execute({ action: 'attach', sessionIds: ['visual-prompt-recommendation', 'missing'], tagIds: [id] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await execute({ action: 'get', sessionIds: ['visual-prompt-recommendation'] })).sessions[0].tags).toEqual([]);
  tags[0].name = 'External mutation';
  expect((await execute({ action: 'list' })).tags[0].name).toBe('A');
  const b = (await execute({ action: 'create', name: 'B', color: 'blue' })).tags[1];
  const reordered = await execute({ action: 'reorder', tagIds: [b.id, id], expectedOrder: [id, b.id] });
  expect(reordered.tags.map((t) => t.id)).toEqual([b.id, id]);
  await expect(execute({ action: 'reorder', tagIds: [id, b.id], expectedOrder: [id, b.id] })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('normalizes legacy none colors in create and update without advertising none', async () => {
  const mock = await import('@/debug/visualMock');
  const link = mock.createVisualMockDeviceLinkContext();
  const execute = (r: import('@cindy/maker-shared').TaskTagRequest) => link.invoke<import('@cindy/maker-shared').TaskTagResult>(mock.VISUAL_MOCK_DEVICE_ID, 'local-db:task-tags:execute', [r]);
  const created = await execute({ action: 'create', name: 'Legacy', color: 'none' });
  const tag = created.tags.find((t) => t.name === 'Legacy')!;
  expect(tag.color).toBe('white');
  expect(created.supportedColors).toContain('white');
  expect(created.supportedColors).not.toContain('none');
  const attached = await execute({ action: 'attach', sessionIds: ['visual-prompt-recommendation'], tagIds: [tag.id] });
  let current = attached.tags.find((t) => t.id === tag.id)!;
  const blue = await execute({ action: 'update', tagId: tag.id, revision: current.revision, color: 'blue' });
  current = blue.tags.find((t) => t.id === tag.id)!;
  await execute({ action: 'update', tagId: tag.id, revision: current.revision, color: 'none' });
  const read = await execute({ action: 'get', sessionIds: ['visual-prompt-recommendation'] });
  expect(read.sessions[0].tags[0].color).toBe('white');
  expect(read.tags.find((t) => t.id === tag.id)?.color).toBe('white');
  expect(read.supportedColors).not.toContain('none');
});
