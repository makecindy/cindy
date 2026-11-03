import { File } from 'expo-file-system';
import { FILE_PEER_MAX_BYTES, isSharedTaskPeer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getActiveMobileSessionRealm } from '@/config/env';
import { createPeerFileCache } from '@/device-link/peerFileCache';
import { effectiveRemoteMediaSshContext, remoteFileMediaUrl, type RemoteMediaSshContext } from './fileBrowserGallery';
import { HTML_SNAPSHOT_MAX_ENTRIES, HTML_SNAPSHOT_MAX_BYTES, type HtmlSnapshotEntry } from './htmlDirectorySnapshot';

/** Reuse the account's existing disk cache and pressure-based eviction. No network here. */
export function createMobileHtmlPreviewCache(deviceId: string, root: string, ssh?: RemoteMediaSshContext | null) {
  const owner = getMobileAuthOwner();
  if (!owner.accountId || isSharedTaskPeer(deviceId)) return undefined;
  const cache = createPeerFileCache(JSON.stringify([getActiveMobileSessionRealm(), owner.accountId]));
  const current = () => isMobileAuthOwnerCurrent(owner);
  const key = (relative: string, manifest = false) => JSON.stringify([
    deviceId, effectiveRemoteMediaSshContext(ssh), root, manifest ? 'manifest' : 'resource', relative,
  ]);
  return {
    current,
    async copy(relative: string, destination: File, maxBytes = FILE_PEER_MAX_BYTES): Promise<number | null> {
      try {
        if (!current()) return null;
        const hit = await (await cache).lookupPreview(key(relative), {
          device: deviceId,
          url: remoteFileMediaUrl(root.replace(/\/$/, '') + '/' + relative, undefined, ssh,
            { baseDir: root, maxBytes: FILE_PEER_MAX_BYTES }),
        });
        if (!hit || hit.size > maxBytes || !current()) return null;
        await new File(hit.uri).copy(destination);
        if (current() && destination.size === hit.size) return hit.size;
      } catch { /* Missing/evicted files are ordinary cache misses. */ }
      try { destination.delete(); } catch {}
      return null;
    },
    async store(relative: string, source: File, mime: string) {
      try {
        const disk = await cache;
        if (current()) await disk.storePreview(key(relative), source.uri, mime, source.size);
      } catch { /* Persistence must not fail a readable preview. */ }
    },
    async manifest(entry: string): Promise<HtmlSnapshotEntry[] | null> {
      try {
        const hit = await (await cache).lookupPreview(key(entry, true));
        if (!hit || !current() || hit.size > 1024 * 1024) return null;
        const files: unknown = JSON.parse(await new File(hit.uri).text());
        if (!current() || !Array.isArray(files) || files.length > HTML_SNAPSHOT_MAX_ENTRIES) return null;
        let total = 0;
        const seen = new Set<string>();
        for (const file of files) {
          if (!file || file.type !== 'file' || typeof file.relPath !== 'string'
            || /[\\:\0\r\n]/.test(file.relPath) || file.relPath.split('/').length > 32
            || file.relPath.split('/').some((p: string) => !p || p.startsWith('.'))
            || seen.has(file.relPath) || !Number.isSafeInteger(file.size) || file.size < 0) return null;
          seen.add(file.relPath);
          total += file.size;
        }
        return total <= HTML_SNAPSHOT_MAX_BYTES && seen.has(entry) ? files : null;
      } catch { return null; }
    },
    async storeManifest(entry: string, files: HtmlSnapshotEntry[], temporary: File) {
      try {
        temporary.write(JSON.stringify(files));
        const disk = await cache;
        if (current()) await disk.storePreview(key(entry, true), temporary.uri, 'application/json', temporary.size);
      } catch { /* Old clients may rebuild the directory if its manifest was evicted. */ }
      finally { try { temporary.delete(); } catch {} }
    },
  };
}
export type MobileHtmlPreviewCache = ReturnType<typeof createMobileHtmlPreviewCache>;
