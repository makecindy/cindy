import { createFileReadQueue, FILE_PEER_MAX_BYTES } from '@cindy/device-link';
import { releasePeerMedia } from '@/device-link/peerFileRegistry';
import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable } from 'expo-file-system/legacy';
import { getRandomBytes } from 'expo-crypto';
import native from '../../modules/cindy-html-preview/src/CindyHtmlPreviewModule';
import { errorText } from '@/debug/fileDiagnostics';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { assertHtmlSnapshotActive, collectHtmlSnapshot, htmlSnapshotLocation, HTML_SNAPSHOT_MAX_ENTRIES, HTML_SNAPSHOT_MAX_BYTES, snapshotDocumentPaths } from './htmlDirectorySnapshot';
import { HTML_SNAPSHOT_CSP, withSnapshotHtmlCsp } from './htmlPreviewCsp';
import { fetchRemoteAbsFileOnce, type RemoteAbsFileFetchDeps } from './remoteAbsFileFetch';
import type { RemoteMediaSshContext } from './fileBrowserGallery';
import { createTransferProgressMeter, type TransferProgress } from './transferProgress';
import { createMobileHtmlPreviewCache, type MobileHtmlPreviewCache } from './mobileHtmlPreviewCache';
import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

export interface MobileHtmlPreview {
  url: string;
  documents: string[];
  onDemand?: boolean;
  /** One background check of the entry HTML; failures leave the current page intact. */
  updated?: Promise<MobileHtmlPreview | null>;
  close(): Promise<void>;
}
export interface HtmlPreviewProgress extends TransferProgress { name: string }
type ProgressListener = (progress: HtmlPreviewProgress) => void;
export type PrepareMobileHtmlPreview = (absPath: string, signal: AbortSignal, onProgress?: ProgressListener, preferCache?: boolean) => Promise<MobileHtmlPreview>;

type HtmlPreviewDeps = RemoteAbsFileFetchDeps & {
  maker: MobileMakerTransport;
  ssh?: RemoteMediaSshContext | null;
  deleteOssObject(key: string): void;
};

/** One meter per file; a fallback resets its byte count instead of inventing overall page progress. */
function resourceProgress(name: string, signal: AbortSignal, listener?: ProgressListener) {
  const measure = createTransferProgressMeter();
  let last = -Infinity;
  let lastTotal = -1;
  return (loaded: number, total: number) => {
    if (signal.aborted || !listener) return;
    const progress = measure(loaded, total);
    const now = Date.now();
    if (total === lastTotal && loaded !== 0 && loaded !== total && now - last < 200) return;
    last = now;
    lastTotal = total;
    try { listener({ ...progress, name }); } catch { /* Observation must not fail a download. */ }
  };
}

/** Copy into the existing preview directory before allowing WebKit to request the document. */
async function materializeResource(deps: HtmlPreviewDeps, root: string, relative: string,
  dir: Directory, filename: string, signal: AbortSignal, onProgress?: ProgressListener, cache?: MobileHtmlPreviewCache) {
  const destination = new File(dir, filename);
  const uploaded = new Set<string>();
  const progress = resourceProgress(relative, signal, onProgress);
  progress(0, 0);
  try {
    assertHtmlSnapshotActive(signal);
    const media = await fetchRemoteAbsFileOnce(deps, root.replace(/\/$/, '') + '/' + relative, deps.ssh,
      (key) => uploaded.add(key), { baseDir: root, maxBytes: FILE_PEER_MAX_BYTES }, signal, progress);
    try {
      assertHtmlSnapshotActive(signal);
      if (!Number.isSafeInteger(media.size) || media.size < 0 || media.size > FILE_PEER_MAX_BYTES) throw new Error('PREVIEW_TOO_LARGE');
      if (!(Paths.availableDiskSpace >= media.size + 256 * 1024 * 1024)) throw new Error('PREVIEW_DISK_FULL');
      if (media.inlineBase64 !== undefined) {
        destination.create();
        destination.write(Uint8Array.from(atob(media.inlineBase64), (char) => char.charCodeAt(0)));
      } else if (media.url.startsWith('file://')) {
        await new File(media.url).copy(destination);
      } else {
        progress(0, media.size);
        let exceeded = false;
        const download = createDownloadResumable(media.url, destination.uri, {}, (value) => {
          if (value.totalBytesWritten > media.size) { exceeded = true; void download.pauseAsync().catch(() => {}); }
          else progress(value.totalBytesWritten, media.size);
        });
        const abort = () => { void download.pauseAsync().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          assertHtmlSnapshotActive(signal);
          const result = await download.downloadAsync();
          assertHtmlSnapshotActive(signal);
          if (!result || result.status !== 200 || exceeded) throw new Error('PREVIEW_CHANGED');
        } finally { signal.removeEventListener('abort', abort); }
      }
      assertHtmlSnapshotActive(signal);
      if (destination.size !== media.size) throw new Error('PREVIEW_CHANGED');
      progress(media.size, media.size);
      const mime = MIME[relative.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
      const html = mime === 'text/html' ? new TextDecoder('utf-8', { fatal: true }).decode(await destination.bytes()) : undefined;
      assertHtmlSnapshotActive(signal);
      await cache?.store(relative, destination, mime);
      assertHtmlSnapshotActive(signal);
      if (html !== undefined) {
        destination.write(withSnapshotHtmlCsp(html));
      }
      return { filename, mime, bytes: media.size, html,
        route: media.inlineBase64 !== undefined ? 'inline' : media.url.startsWith('file://') ? 'direct' : 'upload' };
    } finally { if (media.url.startsWith('file://')) releasePeerMedia(media.url); }
  } catch (error) {
    try { destination.delete(); } catch {}
    throw error;
  } finally { for (const key of uploaded) deps.deleteOssObject(key); }
}

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
export async function prepareMobileHtmlPreview(absPath: string, deps: HtmlPreviewDeps,
  signal: AbortSignal, onProgress?: ProgressListener, preferCache = true): Promise<MobileHtmlPreview> {
  if (!native) throw new Error('HTML_PREVIEW_NATIVE_UNAVAILABLE');
  const { root, entry } = htmlSnapshotLocation(absPath);
  if (/[\\:\0\r\n]/.test(entry) || entry.startsWith('.')) throw new Error('NOT_FOUND');
  const cache = createMobileHtmlPreviewCache(deps.deviceId, root, deps.ssh);
  const lifetime = new AbortController();
  let active: MobileHtmlPreview | undefined;
  let refreshed: MobileHtmlPreview | null | undefined;
  const abort = () => {
    lifetime.abort();
    void active?.close().catch(() => {});
    void refreshed?.close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = subscribeMobileAuthOwner(() => { if (cache && !cache.current()) abort(); });
  const dispose = () => {
    signal.removeEventListener('abort', abort);
    unsubscribe();
    abort();
  };
  if (signal.aborted || (cache && !cache.current())) abort();
  mobileDebugLog('debug', 'files', 'html preview mode', {
    onDemand: !!(native.startOnDemand && native.resolveRequest),
    ssh: !!deps.ssh,
  });
  try {
    const preview = native.startOnDemand && native.resolveRequest
      ? await prepareOnDemand(absPath, deps, lifetime.signal, onProgress, cache, preferCache)
      : await prepareLegacy(absPath, deps, lifetime.signal, onProgress, cache, preferCache);
    active = preview;
    if (lifetime.signal.aborted) { await preview.close(); throw new Error('PREVIEW_CANCELLED'); }
    const close = async () => { dispose(); await preview.close(); await refreshed?.close(); };
    const updated = preview.updated?.then(async (next) => {
      refreshed = next;
      if (lifetime.signal.aborted) { await next?.close(); return null; }
      return next ? { ...next, close } : null;
    });
    // The original visit owns both immutable copies. Keeping the old server until
    // exit avoids killing in-flight WebKit reads while React commits its replacement.
    return { ...preview, updated, close };
  } catch (error) { dispose(); throw error; }
}

async function prepareLegacy(absPath: string, deps: HtmlPreviewDeps, signal: AbortSignal,
  onProgress?: ProgressListener, cache?: MobileHtmlPreviewCache, preferCache = true,
  onEntryHtml?: (html: string) => void): Promise<MobileHtmlPreview> {
  const server = native!;
  assertHtmlSnapshotActive(signal);
  const { root, entry } = htmlSnapshotLocation(absPath);
  const listingRoot = deps.ssh?.workdir ?? root;
  if (deps.ssh && root !== listingRoot && !root.startsWith(listingRoot.replace(/\/$/, '') + '/')) throw new Error('OUTSIDE_WORKDIR');
  if (preferCache && cache) {
    const restored = await restoreLegacy(absPath, deps, signal, cache);
    if (restored) return restored;
  }
  // SSH enumeration must keep the original session workdir so the desktop resolves the SSH endpoint.
  const prefix = deps.ssh ? root.slice(listingRoot.replace(/\/$/, '').length).replace(/^\//, '') : '';
  const caps = await withTransientRemoteRetry(async () => {
    assertHtmlSnapshotActive(signal);
    await deps.openLink(deps.deviceId);
    assertHtmlSnapshotActive(signal);
    return deps.maker.fileBrowser.caps(listingRoot);
  });
  if (!caps.ok || caps.completeDirectoryListing !== true) throw new Error('COMPLETE_DIRECTORY_LISTING_UNSUPPORTED');
  const files = await collectHtmlSnapshot(entry, async (rel) => {
    const path = [prefix, rel].filter(Boolean).join('/');
    const result = await withTransientRemoteRetry(async () => {
      assertHtmlSnapshotActive(signal);
      await deps.openLink(deps.deviceId);
      assertHtmlSnapshotActive(signal);
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
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      try { await server.stop(token); } finally { try { dir.delete(); } catch { /* OS cache reclamation is the fallback. */ } }
    })();
    return closing;
  };
  try {
    const manifest: string[][] = [];
    for (const [index, file] of files.entries()) {
      assertHtmlSnapshotActive(signal);
      const progress = resourceProgress(file.relPath, signal, onProgress);
      progress(0, file.size);
      const uploaded = new Set<string>();
      const destination = new File(dir, String(index));
      try {
        const media = await fetchRemoteAbsFileOnce(deps, root.replace(/\/$/, '') + '/' + file.relPath, deps.ssh,
          (key) => uploaded.add(key), { baseDir: root, maxBytes: Math.max(1, file.size) }, signal, progress);
        assertHtmlSnapshotActive(signal);
        if (media.size !== file.size) throw new Error('PREVIEW_CHANGED');
        if (media.inlineBase64 !== undefined) {
          destination.create();
          destination.write(Uint8Array.from(atob(media.inlineBase64), (char) => char.charCodeAt(0)));
          if (destination.size !== file.size) throw new Error('PREVIEW_CHANGED');
        } else if (media.url.startsWith('file://')) {
          // File.copy is async; releasing first deletes the staged direct-transfer source mid-copy.
          try { await new File(media.url).copy(destination); } finally { releasePeerMedia(media.url); }
          if (destination.size !== file.size) throw new Error('PREVIEW_CHANGED');
        } else {
        let exceeded = false;
        progress(0, file.size);
        const download = createDownloadResumable(media.url, destination.uri, {}, (value) => {
          if (value.totalBytesWritten > file.size) { exceeded = true; void download.pauseAsync().catch(() => {}); }
          else progress(value.totalBytesWritten, file.size);
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
        progress(file.size, file.size);
        const mime = MIME[file.relPath.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
        const text = mime === 'text/html' ? new TextDecoder('utf-8', { fatal: true }).decode(await destination.bytes()) : undefined;
        assertHtmlSnapshotActive(signal);
        await cache?.store(file.relPath, destination, mime);
        assertHtmlSnapshotActive(signal);
        if (text !== undefined) {
          // Reject invalid UTF-8 instead of publishing a corrupted page. No source text is truncated.
          destination.write(withSnapshotHtmlCsp(text));
          if (file.relPath === entry) onEntryHtml?.(text);
        }
        manifest.push([file.relPath, String(index), mime]);
      } finally { for (const key of uploaded) deps.deleteOssObject(key); }
    }
    assertHtmlSnapshotActive(signal);
    const url = await server.start(decodeURIComponent(dir.uri.replace(/^file:\/\//, '')), entry, token, HTML_SNAPSHOT_CSP, manifest);
    assertHtmlSnapshotActive(signal);
    await cache?.storeManifest(entry, files, new File(dir, 'manifest.json'));
    assertHtmlSnapshotActive(signal);
    return { url, documents: snapshotDocumentPaths(files), close };
  } catch (error) { await close(); throw error; }
}

/** Unreadable or undecodable cache copies are misses in both native modes. */
async function restoreCachedResource(cache: MobileHtmlPreviewCache, relative: string,
  destination: File, maxBytes?: number) {
  try {
    const size = await cache?.copy(relative, destination, maxBytes);
    if (size != null) {
      const mime = MIME[relative.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
      const html = mime === 'text/html' ? new TextDecoder('utf-8', { fatal: true }).decode(await destination.bytes()) : undefined;
      if (html !== undefined) {
        destination.write(withSnapshotHtmlCsp(html));
      }
      return { size, mime, html };
    }
    return null;
  } catch { /* Old transfer copies may predate HTML validation. Fetch a fresh copy. */ }
  try { destination.delete(); } catch {}
  return null;
}

/** Old native binaries can publish only the files restored before starting their server. */
async function restoreLegacy(absPath: string, deps: HtmlPreviewDeps, signal: AbortSignal,
  cache: NonNullable<MobileHtmlPreviewCache>): Promise<MobileHtmlPreview | null> {
  const { entry } = htmlSnapshotLocation(absPath);
  const files = await cache.manifest(entry) ?? [{ name: entry, relPath: entry, type: 'file' as const, size: 0 }];
  assertHtmlSnapshotActive(signal);
  sweepInterruptedSnapshots();
  const token = Array.from(getRandomBytes(24), (n) => n.toString(16).padStart(2, '0')).join('');
  const dir = new Directory(Paths.cache, 'html-previews', token);
  dir.create({ intermediates: true });
  const refresh = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    refresh.abort();
    closing = (async () => {
      try { await native!.stop(token); } finally { try { dir.delete(); } catch {} }
    })();
    return closing;
  };
  try {
    const manifest: string[][] = [];
    const restored = [];
    let entryHtml: string | undefined;
    let remaining = HTML_SNAPSHOT_MAX_BYTES;
    for (const [index, file] of files.entries()) {
      const destination = new File(dir, String(index));
      const cached = await restoreCachedResource(cache, file.relPath, destination, remaining);
      assertHtmlSnapshotActive(signal);
      if (!cached) {
        if (file.relPath === entry) { await close(); return null; }
        continue;
      }
      const { size, mime } = cached;
      if (file.relPath === entry) entryHtml = cached.html;
      manifest.push([file.relPath, String(index), mime]);
      restored.push({ ...file, size });
      remaining -= size;
    }
    assertHtmlSnapshotActive(signal);
    const url = await native!.start(decodeURIComponent(dir.uri.replace(/^file:\/\//, '')), entry, token, HTML_SNAPSHOT_CSP, manifest);
    assertHtmlSnapshotActive(signal);
    let freshHtml: string | undefined;
    const updated = prepareLegacy(absPath, deps, refresh.signal, undefined, cache, false, (html) => { freshHtml = html; })
      .then(async (fresh) => {
        if (!refresh.signal.aborted && freshHtml !== undefined && freshHtml !== entryHtml) return fresh;
        await fresh.close();
        return null;
      }).catch(() => null);
    return { url, documents: snapshotDocumentPaths(restored), updated, close };
  } catch (error) { await close(); throw error; }
}

/** New native binaries fetch each requested resource; older binaries retain their existing snapshot API. */
async function prepareOnDemand(absPath: string, deps: HtmlPreviewDeps,
  signal: AbortSignal, onProgress?: ProgressListener, cache?: MobileHtmlPreviewCache, preferCache = true,
  preparedEntry?: { file: File; mime: string }): Promise<MobileHtmlPreview> {
  const server = native!;
  assertHtmlSnapshotActive(signal);
  const { root, entry } = htmlSnapshotLocation(absPath);
  const workdir = deps.ssh?.workdir.replace(/\/$/, '');
  if (workdir && root !== workdir && !root.startsWith(workdir + '/')) throw new Error('OUTSIDE_WORKDIR');
  sweepInterruptedSnapshots();
  const token = Array.from(getRandomBytes(24), (n) => n.toString(16).padStart(2, '0')).join('');
  const dir = new Directory(Paths.cache, 'html-previews', token);
  dir.create({ intermediates: true });
  let closed = false;
  let sequence = 0;
  let requestCount = 0;
  const requests = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  const materialized = new Map<string, { filename: string; mime: string }>();
  let entryUpdated: Promise<MobileHtmlPreview | null> | undefined;
  const queue = createFileReadQueue();
  const loadResource = async (relative: string, filename: string, requestSignal: AbortSignal) => {
    const destination = new File(dir, filename);
    const cached = preferCache ? await restoreCachedResource(cache, relative, destination) : null;
    assertHtmlSnapshotActive(requestSignal);
    if (cached) {
      const { size, mime } = cached;
      const updatedName = `${filename}-refresh`;
      const update = materializeResource(deps, root, relative, dir, updatedName, signal, undefined, cache)
        .then((fresh) => {
          if (relative !== entry || signal.aborted || fresh.html === undefined || fresh.html === cached.html) return null;
          // Reuse the bytes just downloaded; companion resources in the replacement
          // use fresh reads instead of inheriting stale CSS/JS from the old document.
          return prepareOnDemand(absPath, deps, signal, undefined, cache, false,
            { file: new File(dir, updatedName), mime: fresh.mime });
        }).catch(() => null).finally(() => {
          try { new File(dir, updatedName).delete(); } catch {}
          pending.delete(update);
        });
      pending.add(update);
      if (relative === entry) entryUpdated = update;
      return { filename, mime, bytes: size, route: 'cache' };
    }
    return materializeResource(deps, root, relative, dir, filename, requestSignal, onProgress, cache);
  };
  const requestListener = server.addListener('resourceRequest', (event) => {
    if (event.token !== token || closed || requests.has(event.id)) return;
    const controller = new AbortController();
    requests.set(event.id, controller);
    const request = ++requestCount;
    const queuedAt = Date.now();
    const ext = /\.([a-z0-9]{1,8})$/i.exec(event.path ?? '')?.[1]?.toLowerCase() ?? '';
    const work = queue('preview', async () => {
      let destination: File | undefined;
      let accepted = false;
      let route = 'unknown';
      let bytes = 0;
      const startedAt = Date.now();
      try {
        assertHtmlSnapshotActive(controller.signal);
        const relative = event.path;
        if (!relative || /[\\:\0\r\n]/.test(relative) || relative.split('/').some((part) => !part || part.startsWith('.')))
          throw new Error('NOT_FOUND');
        const reused = materialized.get(relative);
        if (reused) {
          accepted = await server.resolveRequest!(token, event.id, reused.filename, reused.mime, 200);
          mobileDebugLog('debug', 'files', 'html resource reused', { request, ext, accepted });
          return;
        }
        const filename = String(sequence++);
        destination = new File(dir, filename);
        const resource = await loadResource(relative, filename, controller.signal);
        const { mime } = resource;
        bytes = resource.bytes;
        route = resource.route;
        assertHtmlSnapshotActive(controller.signal);
        accepted = await server.resolveRequest!(token, event.id, filename, mime, 200);
        if (accepted) materialized.set(relative, { filename, mime });
        mobileDebugLog('debug', 'files', 'html resource served', {
          request, ext, route, bytes, accepted,
          waitMs: startedAt - queuedAt, ms: Date.now() - startedAt,
        });
      } catch (error) {
        const aborted = closed || controller.signal.aborted;
        const message = error instanceof Error ? error.message : '';
        const status = /NOT_FOUND|ENOENT/.test(message) ? 404 : 502;
        mobileDebugLog(aborted ? 'debug' : 'warn', 'files', 'html resource failed', {
          request, ext, route, bytes,
          status: aborted ? 'aborted' : status,
          waitMs: startedAt - queuedAt, ms: Date.now() - startedAt,
          error: errorText(error),
        });
        if (!aborted) {
          await server.resolveRequest!(token, event.id, '', '', status);
        }
      } finally {
        // Accepted files remain available for subsequent requests until the preview closes.
        if (!accepted && destination) { try { destination.delete(); } catch {} }
      }
    }, controller.signal);
    pending.add(work);
    void work.catch(() => {}).finally(() => { pending.delete(work); requests.delete(event.id); });
  });
  const closedListener = server.addListener('resourceClosed', (event) => {
    if (event.token === token) requests.get(event.id)?.abort();
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener('abort', abort);
    requestListener.remove();
    closedListener.remove();
    for (const request of requests.values()) request.abort();
    closing = (async () => {
      try { await server.stop(token); } finally {
        // Downloads may settle after an abort. Drain the entry and all resources before cleanup.
        await Promise.allSettled([...pending]);
        try { dir.delete(); } catch {}
      }
    })();
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    assertHtmlSnapshotActive(signal);
    // Keep weak-network waiting outside WebKit's document-request timeout. Only the
    // entry is fetched eagerly; sibling resources retain the existing on-demand queue.
    const filename = String(sequence++);
    const preparation = preparedEntry ? (async () => {
      await preparedEntry.file.copy(new File(dir, filename));
      assertHtmlSnapshotActive(signal);
      return { filename, mime: preparedEntry.mime };
    })() : loadResource(entry, filename, signal);
    pending.add(preparation);
    try { materialized.set(entry, await preparation); } finally { pending.delete(preparation); }
    assertHtmlSnapshotActive(signal);
    const url = await server.startOnDemand!(decodeURIComponent(dir.uri.replace(/^file:\/\//, '')), entry, token, HTML_SNAPSHOT_CSP);
    if (closed || signal.aborted) {
      await server.stop(token);
      throw new Error('PREVIEW_CANCELLED');
    }
    return { url, documents: ['/' + entry.split('/').map(encodeURIComponent).join('/')], onDemand: true, updated: entryUpdated, close };
  } catch (error) { await close(); throw error; }
}
