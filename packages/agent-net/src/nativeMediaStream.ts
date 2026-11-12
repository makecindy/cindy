import type { NativeEnginePort } from './nativeTransport.js';
import { openNativeMediaReader, type NativeMediaApi, type NativeMediaOptions } from './nativeMedia.js';
import { toBase64Url } from './portableBytes.js';

export interface NativeMediaStream { url: string; size: number; isOpen(): boolean; close(): Promise<void>; retain?(): () => void; }
/** Takes ownership of a dedicated native engine. Loopback requests carry only
 * an opaque random path; all upstream fetching remains signed and Root-bound.
 * Native limits concurrent players to four 1 MiB jobs. A bad AEAD block closes
 * this stream, never supplying unverified bytes or affecting other resources. */
export async function openNativeMediaStream(api: NativeMediaApi | (() => NativeMediaApi), engine: NativeEnginePort,
  id: string, headerSha256: string, contentType: string, options: NativeMediaOptions = {}): Promise<NativeMediaStream> {
  return openNativeByteStream(engine, contentType,
    current => openNativeMediaReader(api, engine, id, headerSha256, current), options);
}

export interface NativeByteReader {
  size: number;
  read(start: number, end: number, write: (bytes: Uint8Array, offset: number) => Promise<void>): Promise<unknown>;
  close(): Promise<void>;
}
/** Existing loopback bridge, with upstream authorization owned by the supplied reader. */
export async function openNativeByteStream(engine: NativeEnginePort, contentType: string,
  openReader: (options: NativeMediaOptions) => Promise<NativeByteReader>,
  options: NativeMediaOptions = {}): Promise<NativeMediaStream> {
  let reader: NativeByteReader | undefined;
  let closed = false, timer: ReturnType<typeof setTimeout> | undefined, lastRequest = Date.now();
  let consumers = 0;
  const jobs = new Set<number>(), controller = new AbortController();
  const assertCurrent = () => {
    if (closed || options.signal?.aborted) throw new Error('MEDIA_CLOSED');
    options.assertCurrent?.(); engine.assertCurrent?.();
  };
  const close = async () => {
    if (closed) return; closed = true; controller.abort(); clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    try { await engine.command({ op: 'httpMediaStop' }).catch(() => undefined); await reader?.close(); }
    finally { await engine.destroy(); }
  };
  const abort = () => { void close(); };
  try {
    assertCurrent(); options.signal?.addEventListener('abort', abort, { once: true });
    reader = await openReader({ ...options, signal: controller.signal, assertCurrent });
    assertCurrent();
    // Container metadata identifies codecs; keep optional MIME parameters out
    // of the native HTTP header's deliberately small character set.
    const result = await engine.command<{ url: string }>({ op: 'httpMediaStart', size: reader.size, contentType: contentType.split(';', 1)[0] });
    assertCurrent();
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_-]{43}$/.test(result.url)) throw new Error('INVALID_MEDIA_STREAM_URL');
    const work = async (request: { id: number; start: number; end: number }) => {
      try {
        const data = new Uint8Array(request.end - request.start + 1);
        await reader!.read(request.start, request.end, async (bytes, offset) => { data.set(bytes, offset); }); assertCurrent();
        await engine.command({ op: 'httpMediaReply', id: request.id, data: toBase64Url(data) }); data.fill(0);
      } catch { await close(); } finally { jobs.delete(request.id); }
    };
    const poll = async () => {
      try {
        assertCurrent();
        const requests = await engine.command<Array<{ id: number; start: number; end: number }>>({ op: 'httpMediaPoll' }); assertCurrent();
        if (!Array.isArray(requests) || requests.length > 4) throw new Error('INVALID_MEDIA_STREAM_REQUEST');
        for (const r of requests) {
          if (!Number.isSafeInteger(r.id) || r.id < 1 || jobs.has(r.id) || !Number.isSafeInteger(r.start)
            || !Number.isSafeInteger(r.end) || r.start < 0 || r.end < r.start || r.end >= reader!.size || r.end - r.start >= 1024 * 1024)
            throw new Error('INVALID_MEDIA_STREAM_REQUEST');
          lastRequest = Date.now(); jobs.add(r.id); void work(r);
        }
        if (!consumers && !jobs.size && Date.now() - lastRequest > 5 * 60_000) { await close(); return; }
      } catch { await close(); }
      if (!closed) {
        timer = setTimeout(() => { void poll(); }, jobs.size ? 10 : Date.now() - lastRequest > 1000 ? 200 : 25);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    };
    void poll();
    return { url: result.url, size: reader.size, isOpen: () => !closed, close, retain: () => {
      assertCurrent(); consumers++;
      let released = false;
      return () => { if (!released) { released = true; consumers--; lastRequest = Date.now(); } };
    } };
  } catch (error) { await close(); throw error; }
}
