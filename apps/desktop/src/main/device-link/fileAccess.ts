import {
  readDeviceFile,
  DL_MEDIA_FETCH_CHANNEL,
  FILE_PEER_MAX_BYTES,
  type DeviceFileResult,
} from '@cindy/device-link';
import { tryPeerFile } from './filePeer';
import { removeRemote } from './mediaTransfer';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';

type Invoke = Parameters<typeof tryPeerFile>[2];
type LocalFileResult = DeviceFileResult & { path: string; dispose(): Promise<void> };
/** Platform adapter; authorization stays in the controlled host's shared resolver. */
export function readRemoteDeviceFile(
  device: string,
  url: string,
  rawInvoke: Invoke,
  options: {
    signal?: AbortSignal;
    skipCache?: boolean;
    maxPeerBytes?: number;
    maxBytes?: number;
    stream?: boolean;
    workdir?: string;
    relPath?: string;
    fallback?: () => Promise<DeviceFileResult>;
  } = {},
) {
  const owner = captureDataOwnerBroadcastScope();
  const invoke: Invoke = async (...args) => {
    if (options.signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
      throw new Error('FILE_PEER_CANCELLED');
    return rawInvoke(...args);
  };
  const fetch = async (prepareOnly: boolean): Promise<DeviceFileResult> => {
    const response = await invoke(device, DL_MEDIA_FETCH_CHANNEL, [
      { url, prepareOnly, ...(options.skipCache ? { skipCache: true } : {}) },
    ]);
    if (!response.ok) {
      const error = (response as { error?: { code?: string; message?: string } }).error;
      throw new Error(`${error?.code ?? 'FILE_READ_FAILED'}: ${error?.message ?? ''}`);
    }
    return response.result as DeviceFileResult;
  };
  return readDeviceFile<LocalFileResult>({
    stream: options.stream,
    signal: options.signal,
    isCurrent: () => isDataOwnerBroadcastScopeCurrent(owner),
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
        if (options.signal?.aborted || !isDataOwnerBroadcastScopeCurrent(owner))
          throw new Error('FILE_PEER_CANCELLED');
        if (!caps.ok) throw new Error('FILE_CAPABILITY_FAILED');
        if (!(caps.result as { fileRead?: boolean })?.fileRead) return options.fallback();
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
      return fetch(true);
    },
    peer: async (metadata) => {
      if (
        metadata.size >
          Math.min(options.maxPeerBytes ?? FILE_PEER_MAX_BYTES, FILE_PEER_MAX_BYTES)
      )
        return null;
      const result = await tryPeerFile(device, url, invoke, options.signal);
      return result ? { ...result, ossKey: '' } : null;
    },
    fallback: options.fallback ?? (() => fetch(false)),
  });
}
