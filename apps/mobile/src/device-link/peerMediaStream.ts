import { File } from 'expo-file-system';
import { getRandomBytesAsync, randomUUID } from 'expo-crypto';
import { openNativeByteStream, toBase64Url, type NativeMediaStream } from '@cindy/agent-net/portable';
import { FILE_PEER_MAX_BYTES, FILE_PEER_RANGE_BYTES, validFileVersion, type DeviceFileResult } from '@cindy/device-link';
import { MobileAgentNetEngine } from './agentNetNative';
import { tryMobilePeerFileRange, peerMediaUri, releasePeerMedia, recordPeerMediaPlayback } from './peerFileRegistry';

interface ReadActivity { (state: 'queued' | 'active', loaded?: number): void; signal?: AbortSignal; }
const streams = new Set<NativeMediaStream>();
let opening = 0;

/** Byte requests use the existing WebRTC file receiver. Loopback is local only;
 * it holds no account credentials and never permits a caller-supplied URL. */
export async function openPeerMediaStream(device: string, url: string, metadata: DeviceFileResult,
  current: () => boolean, signal?: AbortSignal): Promise<DeviceFileResult | null> {
  if (!MobileAgentNetEngine.available() || !validFileVersion(metadata.version) ||
    !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > FILE_PEER_MAX_BYTES ||
    !/^(video|audio)\//.test(metadata.mimeType)) return null;
  for (const stream of streams) if (!stream.isOpen()) streams.delete(stream);
  if (streams.size + opening >= 4) return null;
  opening++;
  try { return await open(device, url, metadata, current, signal); }
  finally { opening--; }
}

async function open(device: string, url: string, metadata: DeviceFileResult,
  current: () => boolean, signal?: AbortSignal): Promise<DeviceFileResult | null> {
  const guard = () => { if (!current() || signal?.aborted) throw new Error('FILE_PEER_CANCELLED'); };
  const fetchRange = async (start: number, end: number, readSignal?: AbortSignal, activity?: ReadActivity) => {
    guard();
    const value = await tryMobilePeerFileRange(device, url, { start, end, version: metadata.version! }, readSignal,
      loaded => activity?.('active', loaded), () => activity?.('active'));
    if (!value) { guard(); return null; }
    const uri = peerMediaUri(value);
    try {
      guard();
      if (!uri || value.size !== end - start + 1 || value.version !== metadata.version) throw new Error('FILE_PEER_CHANGED');
      const bytes = await new File(uri).bytes(); guard();
      if (bytes.length !== value.size) throw new Error('FILE_PEER_SIZE');
      return bytes;
    } finally { if (uri) releasePeerMedia(uri); }
  };
  // Native players can retry the same HTTP block while probing or buffering.
  // Retain only the most recent block (at most 1 MiB), including its in-flight
  // request, so a retry does not queue another transfer over the file channel.
  let cached: { start: number; end: number; bytes: Promise<Uint8Array | null>;
    state: 'queued' | 'active'; loaded: number; listeners: Set<ReadActivity>; controller: AbortController } | undefined;
  const read = async (start: number, end: number, readSignal?: AbortSignal, activity?: ReadActivity) => {
    guard();
    if (!cached || cached.start !== start || cached.end !== end) {
      const entry = { start, end, bytes: Promise.resolve<Uint8Array | null>(null),
        state: 'queued' as 'queued' | 'active', loaded: 0, listeners: new Set<ReadActivity>(), controller: new AbortController() };
      cached = entry;
      if (readSignal?.aborted) entry.controller.abort();
      const abort = () => entry.controller.abort();
      readSignal?.addEventListener('abort', abort, { once: true });
      entry.bytes = fetchRange(start, end, entry.controller.signal, (state, loaded = entry.loaded) => {
        entry.state = state; entry.loaded = loaded;
        for (const listener of entry.listeners) if (!listener.signal?.aborted) listener(state, loaded);
      }).finally(() => readSignal?.removeEventListener('abort', abort));
    }
    const entry = cached;
    let abort: (() => void) | undefined;
    try {
      if (activity) { entry.listeners.add(activity); activity(entry.state, entry.loaded); }
      const bytes = await (activity?.signal ? Promise.race([entry.bytes, new Promise<never>((_, reject) => {
        abort = () => reject(new Error('FILE_PEER_CANCELLED'));
        if (activity.signal!.aborted) abort(); else activity.signal!.addEventListener('abort', abort, { once: true });
      })]) : entry.bytes);
      guard(); return bytes;
    } finally {
      if (abort) activity?.signal?.removeEventListener('abort', abort);
      if (activity) {
        entry.listeners.delete(activity);
        if (activity.signal?.aborted && !entry.listeners.size) {
          entry.controller.abort(); if (cached === entry) cached = undefined;
        }
      }
    }
  };
  // Probe the negotiated path before publishing a player URL. Old hosts return
  // null without receiving a range request; their full-file/OSS path is unchanged.
  let first = await read(0, Math.min(metadata.size, FILE_PEER_RANGE_BYTES) - 1, signal);
  if (!first) return null;
  const engine = await MobileAgentNetEngine.create({ seed: toBase64Url(await getRandomBytesAsync(32)),
    context: 'cindy-file-player', deviceId: randomUUID(), udp: false }, guard);
  let stream: NativeMediaStream;
  try {
    stream = await openNativeByteStream(engine, metadata.mimeType, async options => ({
      size: metadata.size,
      async read(start, end, write, activity) {
        guard();
        let bytes: Uint8Array | null;
        if (first && end < first.length) bytes = first.slice(start, end + 1);
        else { first = null; bytes = await read(start, end, options.signal, activity); }
        if (!bytes) throw new Error('FILE_PEER_UNAVAILABLE');
        guard(); await write(bytes, 0);
      },
      async close() { first = null; cached?.controller.abort(); cached = undefined; },
    }), { assertCurrent: guard, signal });
  } catch (error) { await engine.destroy(); throw error; }
  streams.add(stream);
  const result = { ...metadata, ossKey: '' };
  recordPeerMediaPlayback(result, stream);
  return result;
}
