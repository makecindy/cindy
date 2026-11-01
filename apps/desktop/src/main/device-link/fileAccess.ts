import {
  readDeviceFile,
  DL_MEDIA_FETCH_CHANNEL,
  FILE_PEER_CHANNEL,
  FILE_PEER_MAX_BYTES,
  FILE_INLINE_MAX_BYTES,
  isSharedTaskPeer,
  validFileVersion,
  type DeviceFileResult,
} from '@cindy/device-link';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryPeerFile, copyReceivedFile } from './filePeer';
import { activeOwnerScopeKey } from '../appSessionState';
import { captureFilePeerScope } from './filePeerScope';
import { downloadToFile, removeRemote } from './mediaTransfer';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { captureRemoteMediaCacheValidity } from './remoteMediaPersistentCache';

type Invoke = Parameters<typeof tryPeerFile>[2];
type LocalFileResult = DeviceFileResult & { path: string; dispose(): Promise<void> };
// Metadata only: bytes remain in the existing managed disk caches.
const latestFiles = new Map<string, { url: string; metadata: DeviceFileResult }>();
let latestOwner = '';
/** Platform adapter; authorization stays in the controlled host's shared resolver. */
export function readRemoteDeviceFile(
  device: string,
  url: string,
  rawInvoke: Invoke,
  options: {
    signal?: AbortSignal;
    /** Bytes actually written by the direct receiver, shared by every file entry point. */
    onProgress?: (received: number, total: number) => void;
    skipCache?: boolean;
    /** Version-keyed outer caches must wait for host validation before filling. */
    cacheFirst?: boolean;
    maxPeerBytes?: number;
    maxBytes?: number;
    stream?: boolean;
    workdir?: string;
    relPath?: string;
    fallback?: () => Promise<DeviceFileResult>;
    assertCacheCurrent?: () => void;
  } = {},
) {
  const owner = captureDataOwnerBroadcastScope();
  const assertCacheCurrent = options.assertCacheCurrent ?? captureRemoteMediaCacheValidity();
  const isCurrent = captureFilePeerScope(device);
  const scope = activeOwnerScopeKey();
  if (latestOwner !== scope) { latestFiles.clear(); latestOwner = scope; }
  const cacheKey = JSON.stringify([scope, device, url, options.workdir, options.relPath]);
  let returnedCached = false;
  const remember = (result: DeviceFileResult) => {
    if (isCurrent() && validFileVersion(result.version))
      latestFiles.set(cacheKey, { url, metadata: { ossKey: '', size: result.size, mimeType: result.mimeType, version: result.version } });
    return result;
  };
  const invoke: Invoke = async (target, channel, args) => {
    // A connection can outlive this read, including an offer answered after cancellation.
    // Teardown may cross the read's cancellation boundary, never the account boundary.
    const closing = channel === FILE_PEER_CHANNEL &&
      (args[0] as { action?: unknown } | undefined)?.action === 'close';
    if (closing
      ? !isDataOwnerBroadcastScopeCurrent(owner)
      : options.signal?.aborted || !isCurrent())
      throw new Error('FILE_PEER_CANCELLED');
    return rawInvoke(target, channel, args);
  };
  const fetch = async (prepareOnly: boolean, metadataOnly = false): Promise<DeviceFileResult> => {
    const response = await invoke(device, DL_MEDIA_FETCH_CHANNEL, [
      // Older shared hosts reject unknown fields; retain their authorized inline/OSS path.
      { url, prepareOnly, ...(metadataOnly && !isSharedTaskPeer(device) ? { metadataOnly: true } : {}), ...(options.skipCache ? { skipCache: true } : {}) },
    ]);
    if (!response.ok) {
      const error = (response as { error?: { code?: string; message?: string } }).error;
      throw new Error(`${error?.code ?? 'FILE_READ_FAILED'}: ${error?.message ?? ''}`);
    }
    return response.result as DeviceFileResult;
  };
  // Workdir callers supply same-account export jobs. Guests must retain the
  // media endpoint's task authorization and shared-task OSS scope instead.
  const fallback = !isSharedTaskPeer(device) && options.fallback
    ? options.fallback : () => fetch(false);
  return readDeviceFile<LocalFileResult>({
    cacheFirst: options.skipCache || options.cacheFirst === false || isSharedTaskPeer(device) ? undefined : {
      read: async () => {
        const previous = latestFiles.get(cacheKey);
        if (!previous || (options.stream && /^(audio|video)\//.test(previous.metadata.mimeType))) return null;
        const { remoteFileVersionCache } = await import('./remoteFileVersionCache');
        const path = await remoteFileVersionCache(device, previous.url, { ...previous.metadata, assertCacheCurrent })?.get();
        if (!path) return null;
        if (previous.metadata.size <= FILE_INLINE_MAX_BYTES) {
          const bytes = await fs.readFile(path);
          if (bytes.length !== previous.metadata.size) return null;
          url = previous.url;
          returnedCached = true;
          return { ...previous.metadata, inlineBase64: bytes.toString('base64') };
        }
        const copy = await copyReceivedFile({ ...previous.metadata, path, dispose: async () => {} });
        url = previous.url;
        returnedCached = true;
        return { ...copy, ossKey: '' };
      },
      retain: async (result) => {
        if (result.ossKey && validFileVersion(result.version)) {
          const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-file-peer-'));
          try {
            const file = path.join(directory, 'file');
            await downloadToFile(result.ossKey, file, undefined, undefined, options.signal);
            if (!isCurrent() || options.signal?.aborted) return;
            if ((await fs.stat(file)).size !== result.size) return;
            const { remoteFileVersionCache } = await import('./remoteFileVersionCache');
            await remoteFileVersionCache(device, url, { ...result, assertCacheCurrent })?.put(file);
          } finally { await fs.rm(directory, { recursive: true, force: true }); }
        }
        remember(result);
      },
    },
    inline: () => fetch(true),
    revalidate: () => fetch(true, true),
    inlineCache: {
      read: async (metadata) => {
        const { remoteFileVersionCache } = await import('./remoteFileVersionCache');
        const cache = remoteFileVersionCache(device, url, { ...metadata, assertCacheCurrent });
        if (options.skipCache) {
          await cache?.invalidate();
          return null;
        }
        const path = await cache?.get();
        if (!path) return null;
        const bytes = await fs.readFile(path);
        if (bytes.length !== metadata.size) return null;
        return { ossKey: '', size: bytes.length, mimeType: metadata.mimeType,
          version: metadata.version, inlineBase64: bytes.toString('base64') };
      },
      store: async (result) => {
        const { remoteFileVersionCache } = await import('./remoteFileVersionCache');
        if (options.signal?.aborted || !isCurrent()) return;
        await remoteFileVersionCache(device, url, { ...result, assertCacheCurrent })
          ?.put(Buffer.from(result.inlineBase64!, 'base64'));
      },
    },
    stream: options.stream,
    signal: options.signal,
    isCurrent,
    discard: async (result) => {
      if ('dispose' in result && typeof result.dispose === 'function') await result.dispose();
      else if (result.ossKey && isDataOwnerBroadcastScopeCurrent(owner))
        await removeRemote(result.ossKey);
    },
    prepare: async () => {
      if (options.workdir && options.fallback) {
        const caps = await invoke(device, 'file-browser:remote-op', [
          { op: 'caps', workdir: options.workdir },
        ]);
        if (options.signal?.aborted || !isCurrent())
          throw new Error('FILE_PEER_CANCELLED');
        if (!caps.ok) throw new Error('FILE_CAPABILITY_FAILED');
        if (!(caps.result as { fileRead?: boolean })?.fileRead) return fallback();
        const reference = await invoke(device, 'file-browser:remote-op', [
          { op: 'fileUrl', workdir: options.workdir, relPath: options.relPath },
        ]);
        const file = reference.result as { ok?: boolean; url?: string; message?: string };
        if (!reference.ok || !file?.ok || !file.url)
          throw new Error(file?.message ?? 'FILE_READ_FAILED');
        url = file.url;
        // The snapshot's limit may be smaller than the host's newer stat.
        // Retain it when replacing the caller path with the authorized reference.
        if (options.maxBytes !== undefined) {
          const bounded = new URL(url);
          bounded.searchParams.set('maxBytes', String(options.maxBytes));
          url = bounded.toString();
        }
      }
      return fetch(true, true);
    },
    peer: async (metadata) => {
      if (
        isSharedTaskPeer(device) ||
        metadata.size > Math.min(options.maxPeerBytes ?? FILE_PEER_MAX_BYTES, FILE_PEER_MAX_BYTES)
      )
        return null;
      const result = await tryPeerFile(device, url, invoke, options.signal, options.onProgress,
        { ...metadata, ...(options.skipCache ? { skipCache: true } : {}), assertCacheCurrent });
      // A failed direct attempt is discarded before OSS starts; do not leave its partial
      // percentage/speed on screen during the fallback preparation.
      if (!result && !options.signal?.aborted && isCurrent()) {
        try {
          options.onProgress?.(0, metadata.size);
        } catch {
          /* observer only */
        }
      }
      return result ? { ...result, ossKey: '' } : null;
    },
    fallback,
  }).then((result) => { if (!returnedCached) remember(result); return result; });
}
