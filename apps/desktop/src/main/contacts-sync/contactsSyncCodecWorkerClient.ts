import { randomUUID } from 'node:crypto';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- CPU-heavy contacts codec work must stay off Main.
import { Worker } from 'node:worker_threads';
import {
  CONTACTS_SYNC_CHUNK_BYTES,
  CONTACTS_SYNC_MAX_CHUNKS,
  isContactsSyncWireFrame as isSharedContactsSyncWireFrame,
  type ContactsSyncCipherChunkFrame,
} from '@cindy/device-link';

import { isValidContactsSyncPublicKey } from './crypto.js';
import {
  CONTACTS_SYNC_MAX_COMPRESSED_BYTES,
  createContactsSyncFrames,
  isContactsSyncStateMessage,
  type ContactsSyncAppliedStateResult,
  type ContactsSyncCodec,
  type ContactsSyncDecodeResult,
  type ContactsSyncCodecWorkerRequest,
  type ContactsSyncCodecWorkerResponse,
  type ContactsSyncDecodeOptions,
  type ContactsSyncDatabaseSource,
  type ContactsSyncEncodedPayload,
} from './contactsSyncCodec.js';

const CODEC_TIMEOUT_MS = 60_000;
const DATABASE_WORKER_HARD_KILL_GRACE_MS = 30_000;
const MAX_CONCURRENT_CODEC_WORKERS = 2;
const MAX_CONCURRENT_DATABASE_WORKERS = 1;
const MAX_QUEUED_CODEC_TASKS = 8;
const MAX_QUEUED_CODEC_BYTES = MAX_QUEUED_CODEC_TASKS * CONTACTS_SYNC_MAX_COMPRESSED_BYTES;
let activeWorkers = 0;
let activeDatabaseWorkers = 0;
let queuedBytes = 0;

interface CodecWorkerWaiter {
  weight: number;
  databaseBound: boolean;
  signal?: AbortSignal;
  grant(): void;
  reject(error: Error): void;
  cleanup(): void;
}

const waiters: CodecWorkerWaiter[] = [];

/**
 * 限制 worker 并发，避免 N 台设备同时校准时用多个 gzip/crypto 任务抢满 CPU。
 */
async function acquireCodecWorkerSlot(
  weight: number,
  signal: AbortSignal | undefined,
  deadline: number,
  databaseBound: boolean,
): Promise<void> {
  if (signal?.aborted) throw codecAbortedError();
  if (
    activeWorkers < MAX_CONCURRENT_CODEC_WORKERS &&
    (!databaseBound || activeDatabaseWorkers < MAX_CONCURRENT_DATABASE_WORKERS)
  ) {
    activeWorkers += 1;
    if (databaseBound) activeDatabaseWorkers += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUED_CODEC_TASKS || queuedBytes + weight > MAX_QUEUED_CODEC_BYTES) {
    throw new Error('contacts sync codec queue is full');
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const removeAndReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
        queuedBytes -= weight;
      }
      cleanup();
      reject(error);
    };
    const onAbort = (): void => removeAndReject(codecAbortedError());
    const waiter: CodecWorkerWaiter = {
      weight,
      databaseBound,
      signal,
      grant: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      reject: removeAndReject,
      cleanup,
    };
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(
      () => removeAndReject(new Error('contacts sync codec timed out')),
      remaining,
    );
    timer.unref?.();
    waiters.push(waiter);
    queuedBytes += weight;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function releaseCodecWorkerSlot(databaseBound: boolean): void {
  activeWorkers -= 1;
  if (databaseBound) activeDatabaseWorkers -= 1;
  while (waiters.length > 0) {
    const nextIndex = waiters.findIndex(
      (waiter) =>
        !waiter.databaseBound || activeDatabaseWorkers < MAX_CONCURRENT_DATABASE_WORKERS,
    );
    if (nextIndex < 0) return;
    const [waiter] = waiters.splice(nextIndex, 1);
    if (!waiter) return;
    queuedBytes -= waiter.weight;
    waiter.cleanup();
    if (waiter.signal?.aborted) {
      waiter.reject(codecAbortedError());
      continue;
    }
    activeWorkers += 1;
    if (waiter.databaseBound) activeDatabaseWorkers += 1;
    waiter.grant();
    return;
  }
}

async function runCodecWorker(
  request: ContactsSyncCodecWorkerRequest,
  transferList: ArrayBuffer[] = [],
  signal?: AbortSignal,
  weight = CONTACTS_SYNC_MAX_COMPRESSED_BYTES,
): Promise<unknown> {
  const deadline = Date.now() + CODEC_TIMEOUT_MS;
  const databaseBound = requestTouchesDatabase(request);
  const cancellation = databaseBound ? new Int32Array(new SharedArrayBuffer(4)) : null;
  const dispatchedRequest: ContactsSyncCodecWorkerRequest = cancellation
    ? { ...request, cancellation: cancellation.buffer as SharedArrayBuffer }
    : request;
  await acquireCodecWorkerSlot(weight, signal, deadline, databaseBound);
  let worker: Worker | null = null;
  try {
    if (signal?.aborted) throw codecAbortedError();
    const currentWorker = new Worker(path.join(__dirname, 'contactsSyncCodecWorker.js'));
    worker = currentWorker;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let deferredCancellation: Error | null = null;
      let hardKillTimer: NodeJS.Timeout | undefined;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        signal?.removeEventListener('abort', onAbort);
        operation();
      };
      const deferDatabaseCancellation = (error: Error): void => {
        deferredCancellation ??= markDatabaseMayHaveChanged(error);
        hardKillTimer ??= setTimeout(
          () => finish(() => reject(deferredCancellation!)),
          DATABASE_WORKER_HARD_KILL_GRACE_MS,
        );
        hardKillTimer.unref?.();
      };
      const onAbort = (): void => {
        const error = codecAbortedError();
        if (databaseBound) {
          Atomics.store(cancellation!, 0, 1);
          deferDatabaseCancellation(error);
        }
        else finish(() => reject(error));
      };
      const remaining = deadline - Date.now();
      const timer = setTimeout(
        () => {
          const error = new Error('contacts sync codec timed out');
          if (databaseBound) {
            Atomics.store(cancellation!, 0, 1);
            deferDatabaseCancellation(error);
          }
          else finish(() => reject(error));
        },
        Math.max(1, remaining),
      );
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      currentWorker.once('error', (error) => finish(() => reject(error)));
      currentWorker.once('exit', (code) =>
        finish(() => reject(new Error(`contacts sync codec worker exited (${code})`))),
      );
      currentWorker.once('message', (value: unknown) => {
        if (deferredCancellation) {
          finish(() => reject(deferredCancellation!));
          return;
        }
        if (!isWorkerResponse(value) || value.id !== request.id) {
          finish(() => reject(new Error('invalid contacts sync codec response')));
          return;
        }
        if (!value.ok) {
          finish(() => reject(new Error(value.error ?? 'contacts sync codec failed')));
          return;
        }
        finish(() => resolve(value.data));
      });
      try {
        currentWorker.postMessage(dispatchedRequest, transferList);
      } catch (error) {
        finish(() => reject(error));
      }
      if (signal?.aborted) onAbort();
    });
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      releaseCodecWorkerSlot(databaseBound);
    }
  }
}

function requestTouchesDatabase(request: ContactsSyncCodecWorkerRequest): boolean {
  return (
    request.type === 'prepare' ||
    (request.type === 'encode' && Boolean(request.options.database)) ||
    (request.type === 'decode' && Boolean(request.options.databaseSource))
  );
}

export async function prepareContactsSyncDatabase(
  source: ContactsSyncDatabaseSource,
  signal?: AbortSignal,
): Promise<{ materialized: boolean }> {
  const value = await runCodecWorker({ id: randomUUID(), type: 'prepare', source }, [], signal);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { materialized?: unknown }).materialized !== 'boolean'
  ) {
    throw new Error('invalid contacts sync prepare result');
  }
  return value as { materialized: boolean };
}

export const workerContactsSyncCodec: ContactsSyncCodec = {
  async encode(options, signal) {
    const value = await runCodecWorker({ id: randomUUID(), type: 'encode', options }, [], signal);
    if (!isEncodedPayload(value)) throw new Error('invalid contacts sync encode result');
    const frames = createContactsSyncFrames(value, options.ownPublicKey);
    if (!isCipherChunkFrames(frames)) throw new Error('invalid contacts sync encode frames');
    return { frames, materialized: value.materialized };
  },
  async decode(options, signal) {
    const ciphertext = copyBytes(options.ciphertext);
    const transferableOptions: ContactsSyncDecodeOptions = {
      ...options,
      ciphertext,
    };
    const value = await runCodecWorker(
      {
        id: randomUUID(),
        type: 'decode',
        options: transferableOptions,
      },
      [ciphertext.buffer],
      signal,
      ciphertext.byteLength,
    );
    if (!isDecodeResult(value)) throw new Error('invalid contacts sync decode result');
    if (options.databaseSource && value.type !== 'applied-state') {
      throw new Error('contacts sync state was not applied in worker');
    }
    return value;
  },
};

function codecAbortedError(): Error {
  const error = new Error('contacts sync codec aborted');
  error.name = 'AbortError';
  return error;
}

function markDatabaseMayHaveChanged(error: Error): Error {
  return Object.assign(error, { contactsDatabaseMayHaveChanged: true as const });
}

function isCipherChunkFrames(value: unknown): value is ContactsSyncCipherChunkFrame[] {
  return (
    Array.isArray(value) &&
    value.every(
      (frame) =>
        isSharedContactsSyncWireFrame(frame) &&
        frame.type === 'cipher-chunk' &&
        isValidContactsSyncPublicKey(frame.senderPublicKey),
    )
  );
}

function isEncodedPayload(value: unknown): value is ContactsSyncEncodedPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Partial<ContactsSyncEncodedPayload>;
  return (
    typeof payload.transferId === 'string' &&
    payload.transferId.length >= 1 &&
    payload.transferId.length <= 128 &&
    !payload.transferId.includes('\u0000') &&
    Number.isInteger(payload.total) &&
    (payload.total ?? 0) >= 1 &&
    (payload.total ?? CONTACTS_SYNC_MAX_CHUNKS + 1) <= CONTACTS_SYNC_MAX_CHUNKS &&
    typeof payload.iv === 'string' &&
    payload.iv.length <= 64 &&
    typeof payload.tag === 'string' &&
    payload.tag.length <= 64 &&
    payload.ciphertext instanceof Uint8Array &&
    payload.ciphertext.byteLength <= CONTACTS_SYNC_MAX_COMPRESSED_BYTES + 32 &&
    payload.total ===
      Math.max(1, Math.ceil(payload.ciphertext.byteLength / CONTACTS_SYNC_CHUNK_BYTES)) &&
    typeof payload.materialized === 'boolean'
  );
}

function isDecodeResult(value: unknown): value is ContactsSyncDecodeResult {
  return isContactsSyncStateMessage(value) || isAppliedStateResult(value);
}

function isAppliedStateResult(value: unknown): value is ContactsSyncAppliedStateResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Partial<ContactsSyncAppliedStateResult>;
  const seenNodeIds = new Set<string>();
  return (
    result.version === 1 &&
    result.type === 'applied-state' &&
    typeof result.changed === 'boolean' &&
    Array.isArray(result.clocks) &&
    result.clocks.length <= 256 &&
    result.clocks.every((clock) => {
      if (typeof clock !== 'object' || clock === null || Array.isArray(clock)) return false;
      const candidate = clock as { nodeId?: unknown; counter?: unknown };
      if (
        typeof candidate.nodeId !== 'string' ||
        candidate.nodeId.length < 1 ||
        candidate.nodeId.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(candidate.nodeId) ||
        !Number.isSafeInteger(candidate.counter) ||
        (candidate.counter as number) <= 0 ||
        seenNodeIds.has(candidate.nodeId)
      ) {
        return false;
      }
      seenNodeIds.add(candidate.nodeId);
      return true;
    }) &&
    (result.requestReply === undefined || typeof result.requestReply === 'boolean')
  );
}

function isWorkerResponse(value: unknown): value is ContactsSyncCodecWorkerResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    ((value as { error?: unknown }).error === undefined ||
      typeof (value as { error?: unknown }).error === 'string')
  );
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
