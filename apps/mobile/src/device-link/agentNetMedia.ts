import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { randomUUID } from 'expo-crypto';
import { File, Directory, Paths } from 'expo-file-system';
import { buildAgentNetMediaKey, parseAgentNetMediaKey } from '@cindy/agent-net-protocol';
import { isScopedPeer } from '@cindy/device-link';
import { uploadNativeMedia, readNativeMedia, openNativeMediaStream, type NativeMediaStream, utf8 } from '@cindy/agent-net/portable';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { getActiveMobileSessionRealm, getOfficialAgentNetApiBaseUrl } from '@/config/env';
import { createRemoteMediaDiskCache } from '@/session/remoteMediaDiskCache';
import { createExpoRemoteMediaDiskCacheIO } from '@/session/remoteMediaDiskCacheExpo';
import { getActiveSelfHostedRelay, getSelfHostedRelayRouteGeneration } from './selfHostedRelayRouting';
import { currentMobileAgentNetIdentity, ensureMobileAgentNetIdentity, type MobileAgentNetEnrollmentOptions, type PreparedMobileAgentNetIdentity } from './agentNetIdentity';
import { getMobileAgentNetPreferences, mobileAgentNetRequiresEncryption, subscribeMobileAgentNetPreferences } from './agentNetPreferences';
import { mobileAgentNetMediaPeer, isMobileAgentNetActive } from './agentNetRuntime';
import { PEER_FILE_DISK_RESERVE_BYTES } from './peerFileRegistry';
import { localAgentNetMediaReceipt } from './agentNetLocalMediaReceipt';
import { mobileAgentNetSharingMediaSource, mobileAgentNetSharingMediaTarget } from './agentNetSharing';
import { MobileAgentNetEngine } from './agentNetNative';

const caches = new Map<string, ReturnType<typeof createRemoteMediaDiskCache>>();
const previews = new Map<string, Promise<NativeMediaStream>>();
function stopPreviews(): void {
  for (const preview of previews.values()) void preview.then(stream => stream.close(), () => undefined);
  previews.clear();
}
subscribeMobileAuthOwner(stopPreviews);
subscribeMobileAgentNetPreferences(stopPreviews);
const stagingFiles = new Set<string>();
let stagingSweptAt = 0;
function slot(): string {
  const relay = getActiveSelfHostedRelay(); if (relay) return relay.relayId;
  const bytes = sha256(utf8(JSON.stringify(['cindy-agent-net/official-vault/2', getActiveMobileSessionRealm(), getOfficialAgentNetApiBaseUrl()]))).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x40; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function scopeGuard(signal?: AbortSignal, caller?: () => void) {
  const owner = getMobileAuthOwner(), route = getSelfHostedRelayRouteGeneration(), preferences = getMobileAgentNetPreferences().generation;
  return () => {
    caller?.();
    if (signal?.aborted || !owner.accountId || !isMobileAuthOwnerCurrent(owner) || route !== getSelfHostedRelayRouteGeneration()
      || preferences !== getMobileAgentNetPreferences().generation) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
}
async function identityFor(enrollment?: MobileAgentNetEnrollmentOptions): Promise<PreparedMobileAgentNetIdentity> {
  const identity = enrollment ? await ensureMobileAgentNetIdentity(enrollment) : currentMobileAgentNetIdentity();
  if (!identity) throw new Error('AGENT_NET_IDENTITY_REQUIRED');
  identity.signer.assertCurrent(); return identity;
}
export { canUploadMobileAgentNetMedia } from './agentNetRuntime';
export async function uploadMobileAgentNetMedia(deviceId: string | undefined, size: number, contentType: string,
  read: (offset: number, length: number) => Promise<Uint8Array>, options: { signal?: AbortSignal; assertCurrent?(): void } = {},
): Promise<{ key: string; sha256: string } | null> {
  const scoped = deviceId ? mobileAgentNetSharingMediaTarget(deviceId) : null;
  if (scoped) {
    const guard = scopeGuard(options.signal, options.assertCurrent); guard();
    const engine = await MobileAgentNetEngine.create({ ...scoped.native, udp: false }, () => { guard(); scoped.signer.assertCurrent(); });
    try {
      const result = await uploadNativeMedia(scoped.api, engine, scoped.recipient, scoped.transportKey, size, read,
        { ...options, assertCurrent: guard, binding: scoped.binding }); guard();
      return { key: buildAgentNetMediaKey({ slot: scoped.slot, networkId: scoped.api.certificate.networkId,
        grantId: scoped.api.delegation!.id, sharedTask: { sharedTaskId: scoped.sharedTaskId, deviceId: scoped.api.identity.deviceId },
        id: result.id, headerSha256: result.headerSha256, contentType }), sha256: result.sha256 };
    } finally { await engine.destroy(); }
  }
  if (deviceId && isScopedPeer(deviceId)) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  const peer = deviceId && isMobileAgentNetActive() ? mobileAgentNetMediaPeer(deviceId) : null;
  if (!peer) {
    if (mobileAgentNetRequiresEncryption()) throw new Error('AGENT_NET_ENCRYPTED_MEDIA_TARGET_REQUIRED');
    return null;
  }
  const guard = scopeGuard(options.signal, options.assertCurrent); guard();
  const identity = await identityFor(); guard();
  const engine = await identity.newCryptoEngine(guard);
  try {
    const result = await uploadNativeMedia(identity.api, engine, deviceId!, peer.certificate.transportKey, size, read, { ...options, assertCurrent: guard });
    guard();
    return { key: buildAgentNetMediaKey({ slot: slot(), networkId: identity.api.certificate.networkId,
      id: result.id, headerSha256: result.headerSha256, contentType }), sha256: result.sha256 };
  } finally { await engine.destroy(); }
}
function cacheFor(identity: Pick<PreparedMobileAgentNetIdentity, 'api'>) {
  const key = bytesToHex(sha256(utf8(JSON.stringify([getMobileAuthOwner().accountKey, identity.api.base,
    identity.api.rootPublicKey, identity.api.certificate.networkId]))));
  let cache = caches.get(key);
  if (!cache) {
    cache = createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO('agent-net-' + key), {
      maxBytes: 4 * 1024 * 1024 * 1024, availableBytes: () => Paths.availableDiskSpace,
      reserveBytes: PEER_FILE_DISK_RESERVE_BYTES, persistAccess: true,
    });
    caches.set(key, cache);
  }
  return cache;
}
export async function openMobileAgentNetMedia(key: string, options: { signal?: AbortSignal; assertCurrent?(): void;
  enrollment?: MobileAgentNetEnrollmentOptions; onProgress?(loaded: number, total: number): void } = {}) {
  const reference = parseAgentNetMediaKey(key); if (!reference) throw new Error('INVALID_MEDIA_KEY');
  const guard = scopeGuard(options.signal, options.assertCurrent); guard();
  const scoped = mobileAgentNetSharingMediaSource(reference.slot, reference.networkId, reference.sharedTask?.sharedTaskId);
  if (reference.sharedTask && !scoped) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  const stableGuard = scopeGuard();
  const identity = scoped ? { api: scoped.api, newCryptoEngine: (extra: () => void) => MobileAgentNetEngine.create({ ...scoped.native, udp: false },
    () => { stableGuard(); extra(); scoped.signer.assertCurrent(); }) } : await identityFor(options.enrollment); guard();
  if (!scoped && (reference.slot !== slot() || reference.networkId !== identity.api.certificate.networkId || reference.grantId)) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  const cache = cacheFor(identity), cached = await cache.lookup(key); guard();
  const receipt = (uri: string, size: number) => localAgentNetMediaReceipt({ getUrl: uri, size, mimeType: reference.contentType,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), protectLocalFile: () => cache.protect(key) });
  if (cached) return receipt(cached.uri, cached.size);
  if (/^(video|audio)\//.test(reference.contentType)) {
    const previewKey = bytesToHex(sha256(utf8(JSON.stringify([getMobileAuthOwner(), getSelfHostedRelayRouteGeneration(),
      getMobileAgentNetPreferences().generation, key]))));
    let preview = previews.get(previewKey);
    if (preview && !(await preview).isOpen()) { previews.delete(previewKey); preview = undefined; }
    if (!preview) {
      while (previews.size >= 4) { const first = previews.keys().next().value!;
        void previews.get(first)!.then(stream => stream.close(), () => undefined); previews.delete(first); }
      preview = (async () => {
        const engine = await identity.newCryptoEngine(stableGuard);
        const currentApi = () => {
          stableGuard();
          const current = scoped ? mobileAgentNetSharingMediaSource(reference.slot, reference.networkId, reference.sharedTask?.sharedTaskId)?.api
            : currentMobileAgentNetIdentity()?.api;
          if (!current || current.rootPublicKey !== identity.api.rootPublicKey || current.certificate.networkId !== reference.networkId
            || scoped && current.delegation?.id !== reference.grantId) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
          return current;
        };
        return openNativeMediaStream(currentApi, engine, reference.id, reference.headerSha256, reference.contentType,
          { assertCurrent: stableGuard, ...(scoped ? { binding: scoped.binding } : {}) });
      })();
      previews.set(previewKey, preview);
      void preview.catch(() => { if (previews.get(previewKey) === preview) previews.delete(previewKey); });
    }
    const stream = await preview;
    try { guard(); }
    catch (error) { await stream.close(); throw error; }
    return localAgentNetMediaReceipt({ getUrl: stream.url, size: stream.size, mimeType: reference.contentType,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  }
  const directory = new Directory(Paths.cache, 'agent-net-staging');
  directory.create({ intermediates: true, idempotent: true });
  if (Date.now() - stagingSweptAt > 60 * 60_000) {
    stagingSweptAt = Date.now();
    for (const entry of directory.list()) {
      if (entry instanceof File && /^[a-f0-9-]{36}$/i.test(entry.name) && !stagingFiles.has(entry.uri)
        && entry.modificationTime !== null && Date.now() - entry.modificationTime > 24 * 60 * 60_000) {
        try { entry.delete(); } catch { /* OS cache cleanup may have raced this sweep. */ }
      }
    }
  }
  const file = new File(directory, randomUUID());
  const engine = await identity.newCryptoEngine(guard);
  let handle: ReturnType<File['open']> | undefined;
  try {
    stagingFiles.add(file.uri); file.create(); handle = file.open();
    const result = await readNativeMedia(identity.api, engine, reference.id, reference.headerSha256, async (bytes, offset) => {
      guard();
      if (Paths.availableDiskSpace < bytes.length + PEER_FILE_DISK_RESERVE_BYTES) throw new Error('INSUFFICIENT_STORAGE');
      handle!.offset = offset; handle!.writeBytes(bytes);
    }, { signal: options.signal, assertCurrent: guard, onProgress: options.onProgress, ...(scoped ? { binding: scoped.binding } : {}) });
    handle.close(); handle = undefined; guard();
    if (file.size !== result.size || !(await cache.prune(result.size, key))) throw new Error('INSUFFICIENT_STORAGE');
    await cache.store(key, file.uri, reference.contentType, result.size); guard();
    const saved = await cache.lookup(key); guard();
    if (!saved || saved.size !== result.size) throw new Error('MEDIA_CACHE_WRITE_FAILED');
    return receipt(saved.uri, saved.size);
  } finally { handle?.close(); await engine.destroy(); stagingFiles.delete(file.uri); if (file.exists) file.delete(); }
}
export async function deleteMobileAgentNetMedia(key: string, enrollment?: MobileAgentNetEnrollmentOptions): Promise<void> {
  const reference = parseAgentNetMediaKey(key); if (!reference) throw new Error('INVALID_MEDIA_KEY');
  const guard = scopeGuard(); guard();
  const scoped = mobileAgentNetSharingMediaSource(reference.slot, reference.networkId, reference.sharedTask?.sharedTaskId);
  if (reference.sharedTask && !scoped) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  if (scoped) { await scoped.api.request('DELETE', '/media/' + reference.id); guard(); return; }
  const identity = await identityFor(enrollment); guard();
  if (reference.slot !== slot() || reference.networkId !== identity.api.certificate.networkId || reference.grantId) throw new Error('AGENT_NET_MEDIA_SCOPE_MISMATCH');
  await identity.api.request('DELETE', '/media/' + reference.id); guard();
  // A completed consumer copy remains subject to the ordinary cache lifetime.
}
