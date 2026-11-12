import { promises as fs } from 'node:fs';
import { FILE_PEER_MAX_BYTES, FILE_PEER_RANGE_BYTES, validFileVersion, type DeviceFileResult } from '@cindy/device-link';
import { parseRangeHeader } from '../httpRange';
import { tryPeerFileRange } from './filePeer';

export interface PeerStreamFileResult extends DeviceFileResult {
  kind: 'peer-stream';
  isAvailable(): boolean;
  serve(range: string | null, signal?: AbortSignal): Promise<Response>;
}
/** Seekable byte stream over the file data channel. Small signaling replies carry
 * metadata only; source version and authorization are rechecked on every range. */
export async function openRemotePeerMediaStream(device: string, url: string,
  invoke: Parameters<typeof tryPeerFileRange>[2], metadata: DeviceFileResult,
  current: () => boolean, signal?: AbortSignal): Promise<PeerStreamFileResult | null> {
  if (!validFileVersion(metadata.version) || !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 || metadata.size > FILE_PEER_MAX_BYTES) return null;
  const read = async (start: number, end: number, signal?: AbortSignal) => {
    if (!current() || signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
    const file = await tryPeerFileRange(device, url, invoke, { start, end, version: metadata.version! }, signal);
    if (!file) return null;
    try {
      if (!current() || signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
      const bytes = await fs.readFile(file.path);
      if (!current() || signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
      if (bytes.length !== end - start + 1) throw new Error('FILE_PEER_SIZE');
      return bytes;
    } finally { await file.dispose(); }
  };
  let first = await read(0, Math.min(metadata.size, FILE_PEER_RANGE_BYTES) - 1, signal);
  if (!first) return null;
  let available = true;
  return { ...metadata, kind: 'peer-stream', ossKey: '',
    isAvailable: () => available && current() && !signal?.aborted,
    async serve(header, signal) {
      if (!current() || signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
      if (!available) throw new Error('FILE_PEER_UNAVAILABLE');
      const range = parseRangeHeader(header, metadata.size);
      const headers = { 'Content-Type': metadata.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (range?.kind === 'unsatisfiable') return new Response(null, { status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${metadata.size}` } });
      let offset = range?.kind === 'range' ? range.start : 0;
      const end = range?.kind === 'range' ? range.end : metadata.size - 1;
      const abort = new AbortController();
      const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (combined.aborted || !current()) throw new Error('FILE_PEER_CANCELLED');
            if (!available) throw new Error('FILE_PEER_UNAVAILABLE');
            const to = Math.min(end, offset + FILE_PEER_RANGE_BYTES - 1);
            let bytes: Buffer | null;
            if (first && to < first.length) bytes = first.subarray(offset, to + 1);
            else { first = null; bytes = await read(offset, to, combined); }
            if (!bytes) throw new Error('FILE_PEER_UNAVAILABLE');
            if (combined.aborted || !current()) throw new Error('FILE_PEER_CANCELLED');
            controller.enqueue(bytes); offset = to + 1;
            if (offset > end) controller.close();
          } catch (error) {
            // A failed transport must be reprobed on reopen, allowing OSS fallback.
            // Abandoning one response (e.g. seek) must not poison the shared reader.
            if (!combined.aborted && current()) { available = false; first = null; }
            controller.error(error);
          }
        },
        cancel() { abort.abort(); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: range ? 206 : 200, headers: { ...headers,
        'Content-Length': String(end - offset + 1),
        ...(range ? { 'Content-Range': `bytes ${offset}-${end}/${metadata.size}` } : {}) } });
    },
  };
}
