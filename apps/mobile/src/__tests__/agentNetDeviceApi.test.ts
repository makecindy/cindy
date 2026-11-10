/**
 * Production entry: mobileAgentNetDeviceRequest, the AuthContext device API adapter.
 * Agent-Net compatibility rule: enabling V2 without encrypted-only must retain
 * legacy devices and their management route. Earlier join/media tests never
 * requested a mixed-version device directory. Minimal failures: a V1-only row,
 * the same device online only on V1, an old-device mutation, or a late account switch.
 * Unit tier: in-memory signed-directory/auth/cache boundaries, no real account or I/O.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';

const fake = vi.hoisted(() => ({ owner: 'owner-a', encryptedOnly: false, relayMode: 'official' as 'official' | 'mixed' | 'v2-only',
  directory: vi.fn(), mutation: vi.fn(), legacy: vi.fn(), cache: vi.fn() }));
vi.mock('@/api/client', () => ({ ApiError: class extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
} }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://devices.example.test' }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => fake.owner, isMobileAuthOwnerCurrent: (owner: string) => owner === fake.owner }));
vi.mock('@/device-link/agentNetRuntime', () => ({ isMobileAgentNetActive: () => true }));
vi.mock('@/device-link/agentNetIdentity', () => ({ ensureMobileAgentNetIdentity: async () => ({ api: { directory: fake.directory, request: fake.mutation } }) }));
vi.mock('@/device-link/agentNetPreferences', () => ({ getMobileAgentNetPreferences: () => ({ generation: 0 }),
  mobileAgentNetRequiresEncryption: () => fake.encryptedOnly || fake.relayMode === 'v2-only' }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getSelfHostedRelayRouteGeneration: () => 0, normalizeSelfHostedRelayBase: (base: string) => base,
  getActiveSelfHostedRelay: () => fake.relayMode === 'official' ? null : { agentNetOnly: fake.relayMode === 'v2-only' },
  isAgentNetOnlyRoute: (route: { agentNetOnly?: boolean } | null) => route?.agentNetOnly === true }));
vi.mock('@/device-link/agentNetDirectoryCache', () => ({ writeMobileAgentNetDirectory: fake.cache }));
import { mobileAgentNetDeviceRequest } from '@/device-link/agentNetDeviceApi';

const options = { baseUrl: 'https://devices.example.test' };
const enrollment = { deviceId: 'phone', deviceName: 'Phone', getAccessToken: async () => null };
const legacyDevice = (deviceId: string): DeviceView => ({ deviceId, name: deviceId, platform: 'test', appVersion: 'old', lastSeenAt: null,
  online: true, busy: false, remoteControlEnabled: true, isSelf: false });
const encryptedDevice = (deviceId: string, online = true) => ({ certificate: { deviceId }, name: 'V2 ' + deviceId,
  platform: 'test', appVersion: 'new', online, remoteControlEnabled: false });
const request = (path = '/api/device-link/devices', extra = {}) => mobileAgentNetDeviceRequest<{ devices: DeviceView[] }>(path, { ...options, ...extra }, enrollment, fake.legacy);
beforeEach(() => {
  vi.clearAllMocks(); fake.owner = 'owner-a'; fake.encryptedOnly = false; fake.relayMode = 'official';
  fake.directory.mockResolvedValue([encryptedDevice('new'), encryptedDevice('shared', false)]);
  fake.legacy.mockResolvedValue({ devices: [legacyDevice('old'), legacyDevice('shared')] });
  fake.cache.mockResolvedValue(undefined); fake.mutation.mockResolvedValue({ name: 'Renamed' });
});

it('merges V1-only devices with V2 presence and preserves an online legacy route', async () => {
  expect(await request()).toMatchObject({ handled: true, value: { devices: [
    { deviceId: 'old', online: true }, { deviceId: 'shared', name: 'shared', online: true },
    { deviceId: 'new', name: 'V2 new', remoteControlEnabled: false },
  ] } });
  expect(fake.legacy).toHaveBeenCalledTimes(1);
});

it.each(['PATCH', 'DELETE'])('keeps a V1-only device on the existing %s management path', async method => {
  expect(await request('/api/device-link/devices/old', { method, body: { name: 'Renamed' } })).toEqual({ handled: false });
  expect(fake.mutation).not.toHaveBeenCalled();
});

it('reads only the encrypted directory when encrypted-only is selected', async () => {
  fake.encryptedOnly = true;
  const result = await request();
  expect(result).toMatchObject({ handled: true, value: { devices: [{ deviceId: 'new' }, { deviceId: 'shared', online: false }] } });
  expect(fake.legacy).not.toHaveBeenCalled();
});

it('does not turn certificate or membership denial into a legacy fallback', async () => {
  fake.directory.mockRejectedValue(Object.assign(new Error('certificate rejected'), { status: 403, code: 'CERTIFICATE_INVALID' }));
  await expect(request()).rejects.toMatchObject({ status: 403, code: 'CERTIFICATE_INVALID' });
});

it('keeps a live V2 directory during a transient legacy outage', async () => {
  fake.legacy.mockRejectedValue(Object.assign(new Error('offline'), { status: 0, code: 'NETWORK_ERROR' }));
  expect(await request()).toMatchObject({ handled: true, value: { devices: [{ deviceId: 'new' }, { deviceId: 'shared' }] } });
});

it.each(['AGENT_NET_NETWORK_ERROR', 'AGENT_NET_REQUEST_TIMEOUT'])('keeps live legacy devices during a V2 %s', async code => {
  fake.directory.mockRejectedValue(Object.assign(new Error(code), { status: 0, code }));
  expect(await request()).toMatchObject({ handled: true, value: { devices: [{ deviceId: 'old' }, { deviceId: 'shared' }] } });
  fake.encryptedOnly = true;
  await expect(request()).rejects.toMatchObject({ status: 0, code });
});

it('rejects a mixed directory that finishes after the account changes', async () => {
  let finish!: (value: { devices: DeviceView[] }) => void;
  fake.legacy.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const result = request();
  await vi.waitFor(() => expect(fake.legacy).toHaveBeenCalledTimes(1));
  fake.owner = 'owner-b'; finish({ devices: [legacyDevice('old')] });
  await expect(result).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
});

// Unit: independent V1/V2 membership stores, as in the self-hosted kernels.
// Earlier directory tests never renamed/deleted a device present in both stores.
it.each((['PATCH', 'DELETE'] as const).flatMap(method => [false, true].map(encryptedOnly => ({ method, encryptedOnly }))))
  ('synchronizes private $method membership before success (encryptedOnly=$encryptedOnly)', async ({ method, encryptedOnly }) => {
    fake.relayMode = 'mixed'; fake.encryptedOnly = encryptedOnly;
    let operation: string = method;
    const legacy = new Map([['shared', legacyDevice('shared')]]), encrypted = new Map([['shared', encryptedDevice('shared', false)]]);
    fake.directory.mockImplementation(async () => [...encrypted.values()]);
    fake.mutation.mockImplementation(async (method, _path, body) => {
      if (method === 'DELETE') encrypted.delete('shared'); else encrypted.get('shared')!.name = body.name;
      return { name: 'Renamed' };
    });
    fake.legacy.mockImplementation(async () => {
      if (operation === 'GET') return { devices: [...legacy.values()] };
      if (operation === 'DELETE') legacy.delete('shared'); else legacy.get('shared')!.name = 'Renamed';
      return { deviceId: 'shared', name: 'Renamed', deleted: operation === 'DELETE' };
    });
    await request('/api/device-link/devices/shared', { method, body: method === 'PATCH' ? { name: 'Renamed' } : undefined });
    // Turning V2 off must not resurrect the old alias or a deleted pairing.
    operation = 'GET'; fake.encryptedOnly = false; fake.directory.mockResolvedValue([]);
    expect(await request()).toMatchObject({ handled: true, value: { devices: method === 'DELETE' ? [] : [{ deviceId: 'shared', name: 'Renamed' }] } });
  });

it.each(['PATCH', 'DELETE'])('keeps a V2-only network off the legacy %s path', async method => {
  fake.relayMode = 'v2-only';
  expect(await request('/api/device-link/devices/new', { method, body: { name: 'Renamed' } })).toMatchObject({ handled: true });
  expect(fake.legacy).not.toHaveBeenCalled();
});

it('does not report successful deletion until both stores have succeeded, and can finish the legacy retry', async () => {
  fake.relayMode = 'mixed'; fake.encryptedOnly = true;
  fake.legacy.mockRejectedValue(Object.assign(new Error('legacy unavailable'), { status: 503, code: 'SERVICE_UNAVAILABLE' }));
  await expect(request('/api/device-link/devices/shared', { method: 'DELETE' })).rejects.toMatchObject({ status: 503 });
  fake.directory.mockResolvedValue([]);
  fake.legacy.mockResolvedValue({ deviceId: 'shared', deleted: true });
  expect(await request('/api/device-link/devices/shared', { method: 'DELETE' })).toEqual({ handled: true, value: { deviceId: 'shared', deleted: true } });
  expect(fake.mutation).toHaveBeenCalledTimes(1);
});

it('allows a V2-only device absent from the legacy store but preserves legacy denial and owner fences', async () => {
  fake.relayMode = 'mixed';
  fake.legacy.mockRejectedValue(Object.assign(new Error('absent'), { status: 404, code: 'NOT_FOUND' }));
  expect(await request('/api/device-link/devices/new', { method: 'PATCH', body: { name: 'Renamed' } })).toMatchObject({ handled: true });
  fake.legacy.mockRejectedValue(Object.assign(new Error('denied'), { status: 403, code: 'FORBIDDEN' }));
  await expect(request('/api/device-link/devices/new', { method: 'PATCH', body: { name: 'Renamed' } })).rejects.toMatchObject({ status: 403 });
  fake.legacy.mockImplementation(async () => { fake.owner = 'owner-b'; return {}; });
  await expect(request('/api/device-link/devices/new', { method: 'DELETE' })).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
});
