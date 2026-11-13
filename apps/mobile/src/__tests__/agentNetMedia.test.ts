/** Unit value: public App openMobileAgentNetMedia must yield a seekable player
 * URL before whole-file I/O, retain its owner fence after the metadata request
 * ends, and retire a late URL at logout. V2 preserves V1 progressive playback.
 * Existing remoteMedia tests mock this adapter; the native integration tests
 * exercise the SDK, not App cache/lifetime selection. Minimal inputs: a video,
 * a completed request's abort signal, and a held stream open crossing logout.
 * Playback cases belong here because this adapter needs distinct Expo disk/native
 * boundaries; merging into sharing/signature tests would replace their subject.
 * Disk/native OS boundaries are fakes; production route/reference/fences run.
 * Standalone runtime: 0.98 seconds on 2026-11-08.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { buildAgentNetMediaKey } from '@cindy/agent-net-protocol';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
const fake = vi.hoisted(() => ({ open: vi.fn(), api: null as any, engine: { destroy: vi.fn(async () => {}) } }));
vi.mock('expo-file-system', () => ({ Paths: { availableDiskSpace: 10 ** 12 },
  File: class { constructor() { throw new Error('VIDEO_MUST_NOT_DOWNLOAD_FIRST'); } },
  Directory: class { constructor() { throw new Error('VIDEO_MUST_NOT_DOWNLOAD_FIRST'); } },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }));
vi.mock('@cindy/agent-net/portable', async original => ({ ...await original<typeof import('@cindy/agent-net/portable')>(), openNativeMediaStream: fake.open }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global', getOfficialAgentNetApiBaseUrl: () => null }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({
  getActiveSelfHostedRelay: () => ({ relayId: '11111111-1111-4111-8111-111111111111' }), getSelfHostedRelayRouteGeneration: () => 0,
}));
vi.mock('@/device-link/agentNetIdentity', () => ({
  currentMobileAgentNetIdentity: () => ({ api: fake.api, signer: { assertCurrent() {} }, newCryptoEngine: async () => fake.engine }),
}));
vi.mock('@/device-link/agentNetPreferences', () => ({
  getMobileAgentNetPreferences: () => ({ ready: true, enabled: true, generation: 0 }),
  mobileAgentNetRequiresEncryption: () => true, subscribeMobileAgentNetPreferences: () => () => {},
}));
vi.mock('@/device-link/agentNetRuntime', () => ({ isMobileAgentNetActive: () => true, mobileAgentNetMediaPeer: () => null }));
vi.mock('@/device-link/agentNetSharing', () => ({ mobileAgentNetSharingMediaSource: () => null, mobileAgentNetSharingMediaTarget: () => null }));
vi.mock('@/device-link/agentNetNative', () => ({ MobileAgentNetEngine: {} }));
vi.mock('@/session/remoteMediaDiskCache', () => ({ createRemoteMediaDiskCache: () => ({ lookup: async () => null, protect: () => () => {} }) }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ createExpoRemoteMediaDiskCacheIO: () => ({}) }));
vi.mock('@/device-link/peerFileRegistry', () => ({ PEER_FILE_DISK_RESERVE_BYTES: 1 }));
import { openMobileAgentNetMedia } from '@/device-link/agentNetMedia';
const networkId = 'private:11111111-1111-4111-8111-111111111111';
const key = buildAgentNetMediaKey({ slot: '11111111-1111-4111-8111-111111111111', networkId,
  id: '22222222-2222-4222-8222-222222222222', headerSha256: 'a'.repeat(64), contentType: 'video/mp4' });
function stream() {
  let active = true;
  return { url: 'http://127.0.0.1:12345/' + 'Q'.repeat(43), size: 100_000_000,
    isOpen: () => active, close: async () => { active = false; } };
}
beforeEach(() => {
  setMobileAuthOwner('unit-video-owner'); fake.open.mockReset(); fake.engine.destroy.mockClear();
  fake.api = { base: 'https://private.example.test', rootPublicKey: 'Q'.repeat(43), certificate: { networkId } };
});
afterEach(() => setMobileAuthOwner(null));
it('starts video without whole-file I/O and uses renewed credentials after its request signal ends', async () => {
  const preview = stream(); fake.open.mockResolvedValue(preview);
  const controller = new AbortController();
  const value = await openMobileAgentNetMedia(key, { signal: controller.signal });
  expect(value.getUrl).toBe(preview.url); expect(value.size).toBe(preview.size);
  const [getApi, , , , , options] = fake.open.mock.calls[0];
  controller.abort(); expect(() => options.assertCurrent()).not.toThrow();
  const renewed = { ...fake.api, renewal: 2 }; fake.api = renewed;
  expect(getApi()).toBe(renewed);
  fake.api = { ...renewed, rootPublicKey: 'R'.repeat(43) };
  expect(getApi).toThrow('AGENT_NET_MEDIA_SCOPE_MISMATCH');
});
it('closes a late native player URL instead of publishing it into a new account', async () => {
  let resolve!: (value: ReturnType<typeof stream>) => void, started!: () => void;
  const sent = new Promise<void>(done => { started = done; });
  fake.open.mockImplementation(() => { started(); return new Promise(done => { resolve = done; }); });
  const pending = openMobileAgentNetMedia(key), rejected = expect(pending).rejects.toThrow('AGENT_NET_OWNER_CHANGED');
  await sent; setMobileAuthOwner('unit-other-owner');
  const preview = stream(); resolve(preview); await rejected;
  expect(preview.isOpen()).toBe(false);
});
