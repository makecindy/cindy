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

const fake = vi.hoisted(() => ({ owner: 'owner-a', encryptedOnly: false, directory: vi.fn(), mutation: vi.fn(), legacy: vi.fn(), cache: vi.fn() }));
vi.mock('@/api/client', () => ({ ApiError: class extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
} }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://devices.example.test' }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => fake.owner, isMobileAuthOwnerCurrent: (owner: string) => owner === fake.owner }));
vi.mock('@/device-link/agentNetRuntime', () => ({ isMobileAgentNetActive: () => true }));
vi.mock('@/device-link/agentNetIdentity', () => ({ ensureMobileAgentNetIdentity: async () => ({ api: { directory: fake.directory, request: fake.mutation } }) }));
vi.mock('@/device-link/agentNetPreferences', () => ({ getMobileAgentNetPreferences: () => ({ generation: 0 }), mobileAgentNetRequiresEncryption: () => fake.encryptedOnly }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getSelfHostedRelayRouteGeneration: () => 0, normalizeSelfHostedRelayBase: (base: string) => base }));
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
  vi.clearAllMocks(); fake.owner = 'owner-a'; fake.encryptedOnly = false;
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

it('rejects a mixed directory that finishes after the account changes', async () => {
  let finish!: (value: { devices: DeviceView[] }) => void;
  fake.legacy.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const result = request();
  await vi.waitFor(() => expect(fake.legacy).toHaveBeenCalledTimes(1));
  fake.owner = 'owner-b'; finish({ devices: [legacyDevice('old')] });
  await expect(result).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
});
