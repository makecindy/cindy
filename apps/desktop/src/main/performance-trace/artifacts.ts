import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Whole-artifact JSON processing must not block main.
import { Worker } from 'node:worker_threads';
import { throwIpcError } from '../utils/ipcValidate';

export const TRACE_ARTIFACT_NAMES = [
  'report.json',
  'chromium-trace.json',
  'main.cpuprofile',
  'renderer.cpuprofile',
] as const;
export type TraceArtifactName = (typeof TRACE_ARTIFACT_NAMES)[number];
export interface TraceArtifact {
  name: TraceArtifactName;
  bytes: Buffer;
}
export const MAX_TRACE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TRACE_TOTAL_BYTES = 128 * 1024 * 1024;

/** Only the recording directory selected by main, never paths supplied by a renderer. */
export async function readTraceArtifacts(directory: string): Promise<TraceArtifact[]> {
  const root = await realpath(directory);
  const files: TraceArtifact[] = [];
  let total = 0;
  for (const name of TRACE_ARTIFACT_NAMES) {
    const filename = path.join(root, name);
    let info;
    try {
      info = await lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(filename)) !== filename)
      throwIpcError('LOG_UPLOAD_FAILED', 'Recording file is not a regular local file');
    total += info.size;
    if (info.size > MAX_TRACE_FILE_BYTES || total > MAX_TRACE_TOTAL_BYTES)
      throwIpcError(
        'LOG_UPLOAD_FAILED',
        'Recording exceeds upload limit; local files are preserved',
      );
    const handle = await open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size)
        throwIpcError('LOG_UPLOAD_FAILED', 'Recording changed before upload');
      const bytes = Buffer.alloc(info.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const next = await handle.read(bytes, read, Math.min(64 * 1024, bytes.length - read), read);
        if (!next.bytesRead) break;
        read += next.bytesRead;
      }
      const after = await handle.stat();
      if (read !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size)
        throwIpcError('LOG_UPLOAD_FAILED', 'Recording changed during upload preparation');
      files.push({ name, bytes: bytes.subarray(0, read) });
    } finally {
      await handle.close();
    }
  }
  return files;
}

/** Parse, redact and serialize in one disposable worker. Only byte buffers cross
 * the boundary; cloning a parsed object back to main would recreate the stall. */
export async function redactTraceArtifact(bytes: Buffer): Promise<Buffer> {
  let worker: Worker | undefined;
  try {
    if (bytes.length > MAX_TRACE_FILE_BYTES) throw new Error('oversized artifact');
    worker = new Worker(path.join(__dirname, 'traceRedactionWorker.js'));
    const current = worker;
    // Never detach the caller's buffer or a pooled Buffer slab: retries need it.
    const input = Uint8Array.from(bytes);
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (result?: ArrayBuffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result) resolve(Buffer.from(result));
        else reject(new Error('artifact preparation failed'));
      };
      const timer = setTimeout(() => finish(), 60_000);
      timer.unref?.();
      current.once('message', (message: { bytes?: unknown } | null) => {
        const result = message?.bytes;
        finish(result instanceof ArrayBuffer && result.byteLength <= MAX_TRACE_FILE_BYTES ? result : undefined);
      });
      current.once('error', () => finish());
      current.once('exit', () => finish());
      try {
        current.postMessage(input.buffer, [input.buffer]);
      } catch {
        finish();
      }
    });
  } catch {
    // Worker/JSON errors can contain raw recording content. Return only a fixed error.
    return throwIpcError('LOG_UPLOAD_FAILED', 'Recording preparation failed; local files are preserved');
  } finally {
    await worker?.terminate().catch(() => undefined);
  }
}
