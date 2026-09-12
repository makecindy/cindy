import { releasePeerMedia } from '@/device-link/peerFileRegistry';
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { getRandomBytes } from 'expo-crypto';
import native from '../../modules/cindy-html-preview/src/CindyHtmlPreviewModule';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { assertHtmlSnapshotActive, collectHtmlSnapshot, htmlSnapshotLocation, HTML_SNAPSHOT_MAX_ENTRIES, snapshotDocumentPaths } from './htmlDirectorySnapshot';
import { HTML_SNAPSHOT_CSP, withSnapshotHtmlCsp } from './htmlPreviewCsp';
import { fetchRemoteAbsFileOnce, type RemoteAbsFileFetchDeps } from './remoteAbsFileFetch';
import type { RemoteMediaSshContext } from './fileBrowserGallery';

export interface MobileHtmlPreview {
  url: string;
  documents: string[];
  close(): Promise<void>;
}
export type PrepareMobileHtmlPreview = (absPath: string, signal: AbortSignal) => Promise<MobileHtmlPreview>;

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain',
};

let sweptPreviousProcess = false;
function sweepInterruptedSnapshots() {
  if (sweptPreviousProcess) return;
  sweptPreviousProcess = true;
  const parent = new Directory(Paths.cache, 'html-previews');
  if (!parent.exists) return;
  // These random-name directories belong solely to this feature. Never sweep general app caches.
  for (const child of parent.list()) {
    if (child instanceof Directory && /^[a-f0-9]{48}$/.test(child.name)) {
      try { child.delete(); } catch { /* A later OS cache eviction can reclaim it. */ }
    }
  }
}

/** Source identity stays in the transport; no device credentials enter the snapshot. */
export async function prepareMobileHtmlPreview(absPath: string, deps: RemoteAbsFileFetchDeps & {
  maker: MobileMakerTransport;
  ssh?: RemoteMediaSshContext | null;
  deleteOssObject(key: string): void;
}, signal: AbortSignal): Promise<MobileHtmlPreview> {
  if (!native) throw new Error('HTML_PREVIEW_NATIVE_UNAVAILABLE');
  const server = native;
  assertHtmlSnapshotActive(signal);
  const { root, entry } = htmlSnapshotLocation(absPath);
  // SSH enumeration must keep the original session workdir so the desktop resolves the SSH endpoint.
  const listingRoot = deps.ssh?.workdir ?? root;
  const prefix = deps.ssh ? root.slice(listingRoot.replace(/\/$/, '').length).replace(/^\//, '') : '';
  if (deps.ssh && root !== listingRoot && !root.startsWith(listingRoot.replace(/\/$/, '') + '/')) throw new Error('OUTSIDE_WORKDIR');
  const caps = await withTransientRemoteRetry(async () => {
    await deps.openLink(deps.deviceId);
    return deps.maker.fileBrowser.caps(listingRoot);
  });
  if (!caps.ok || caps.completeDirectoryListing !== true) throw new Error('COMPLETE_DIRECTORY_LISTING_UNSUPPORTED');
  const files = await collectHtmlSnapshot(entry, async (rel) => {
    const path = [prefix, rel].filter(Boolean).join('/');
    const result = await withTransientRemoteRetry(async () => {
      assertHtmlSnapshotActive(signal);
      await deps.openLink(deps.deviceId);
      return deps.maker.fileBrowser.listDir(listingRoot, path, { includeIgnored: true, maxEntries: HTML_SNAPSHOT_MAX_ENTRIES });
    });
    if (!prefix || !Array.isArray(result)) return result;
    return result.map((item: unknown) => {
      if (!item || typeof item !== 'object' || !('relPath' in item) || typeof item.relPath !== 'string'
        || !item.relPath.startsWith(prefix + '/')) throw new Error('PREVIEW_LIST_FAILED');
      return { ...item, relPath: item.relPath.slice(prefix.length + 1) };
    });
  }, signal);
  assertHtmlSnapshotActive(signal);
  sweepInterruptedSnapshots();
  const token = Array.from(getRandomBytes(24), (n) => n.toString(16).padStart(2, '0')).join('');
  const dir = new Directory(Paths.cache, 'html-previews', token);
  dir.create({ intermediates: true });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await server.stop(token); } finally { try { dir.delete(); } catch { /* OS cache reclamation is the fallback. */ } }
  };
  try {
    const manifest: string[][] = [];
    for (const [index, file] of files.entries()) {
      assertHtmlSnapshotActive(signal);
      const uploaded = new Set<string>();
      const destination = new File(dir, String(index));
      try {
        const media = await fetchRemoteAbsFileOnce(deps, root.replace(/\/$/, '') + '/' + file.relPath, deps.ssh,
          (key) => uploaded.add(key), { baseDir: root, maxBytes: Math.max(1, file.size) }, signal);
        assertHtmlSnapshotActive(signal);
        if (media.size !== file.size) throw new Error('PREVIEW_CHANGED');
        if (media.url.startsWith('file://')) {
          try { new File(media.url).copy(destination); } finally { releasePeerMedia(media.url); }
          if (destination.size !== file.size) throw new Error('PREVIEW_CHANGED');
        } else {
        let exceeded = false;
        const download = createDownloadResumable(media.url, destination.uri, {}, (progress) => {
          if (progress.totalBytesWritten > file.size) { exceeded = true; void download.pauseAsync().catch(() => {}); }
        });
        const abort = () => { void download.pauseAsync().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          assertHtmlSnapshotActive(signal);
          const result = await download.downloadAsync();
          assertHtmlSnapshotActive(signal);
          if (!result || result.status !== 200 || exceeded || destination.size !== file.size) throw new Error('PREVIEW_CHANGED');
        } finally { signal.removeEventListener('abort', abort); }
        }
        const mime = MIME[file.relPath.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
        if (mime === 'text/html') {
          // Reject invalid UTF-8 instead of publishing a corrupted page. No source text is truncated.
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await destination.bytes());
          destination.write(withSnapshotHtmlCsp(text));
        }
        manifest.push([file.relPath, String(index), mime]);
      } finally { for (const key of uploaded) deps.deleteOssObject(key); }
    }
    assertHtmlSnapshotActive(signal);
    const url = await server.start(decodeURIComponent(dir.uri.replace(/^file:\/\//, '')), entry, token, HTML_SNAPSHOT_CSP, manifest);
    assertHtmlSnapshotActive(signal);
    return { url, documents: snapshotDocumentPaths(files), close };
  } catch (error) { await close(); throw error; }
}
