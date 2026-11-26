import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Platform fetch ports retain Chromium proxy handling and remote source authorization. */
export interface MediaSaveStreamPorts {
  fetchHttp(url: string, signal: AbortSignal): Promise<Response>;
  fetchRemote(url: string, signal: AbortSignal): Promise<Response>;
}

/** Export only to a native-dialog-selected destination, publishing after complete transfer.
 * Staging beside the destination keeps rename on one filesystem. A failed transfer never
 * truncates or deletes the user's old target, and rename replaces a target link, not its referent.
 */
export async function saveMediaStream(
  source: { kind: 'http' | 'remote-media'; url: string },
  destination: string,
  ports: MediaSaveStreamPorts,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(timer);
    // Bound inactivity, not total duration: large, progressing downloads may take minutes.
    timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
  };
  let staging: string | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // Cancel the Web reader too: a pending read in an async iterator must settle
  // before Node's pipeline can finish tearing down its source.
  const cancelBody = () => { void reader?.cancel(controller.signal.reason).catch(() => undefined); };
  try {
    // Fail an unwritable/missing destination directory before starting the download.
    staging = await fs.mkdtemp(path.join(path.dirname(destination), '.cindy-save-'));
    // HTTP may stall awaiting headers. Remote sources can first materialize a
    // large SSH/cache file under their existing per-chunk/RPC timeouts; do not
    // turn that healthy preparation into a total 30-second download deadline.
    if (source.kind === 'http') progress();
    response = await (source.kind === 'http' ? ports.fetchHttp : ports.fetchRemote)(
      source.url, controller.signal,
    );
    progress();
    if (!response.ok || response.status === 206) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('empty response body');
    reader = response.body.getReader();
    controller.signal.addEventListener('abort', cancelBody, { once: true });
    controller.signal.throwIfAborted();
    const bodyReader = reader;
    let received = 0;
    const rawLength = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    const expected = rawLength !== null && /^\d+$/.test(rawLength) &&
      (!encoding || encoding === 'identity') ? Number(rawLength) : null;
    const chunks = async function* () {
      while (true) {
        const { done, value } = await bodyReader.read();
        if (done) break;
        received += value.byteLength;
        progress();
        yield value;
      }
      if (expected !== null && received !== expected) throw new Error('incomplete media response');
    };
    const partial = path.join(staging, 'download');
    await pipeline(
      Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 }),
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
      { signal: controller.signal },
    );
    controller.signal.throwIfAborted();
    await fs.rename(partial, destination);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', cancelBody);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else {
      await response?.body?.cancel().catch(() => undefined);
    }
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
