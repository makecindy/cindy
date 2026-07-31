import { randomUUID } from 'node:crypto';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- CPU-heavy contacts codec work must stay off Main.
import { Worker } from 'node:worker_threads';
import {
  isContactsSyncWireFrame as isSharedContactsSyncWireFrame,
  type ContactsSyncCipherChunkFrame,
} from '@cindy/device-link';

import { isValidContactsSyncPublicKey } from './crypto.js';
import {
  CONTACTS_SYNC_MAX_COMPRESSED_BYTES,
  isContactsSyncStateMessage,
  type ContactsSyncCodec,
  type ContactsSyncCodecWorkerRequest,
  type ContactsSyncCodecWorkerResponse,
  type ContactsSyncDecodeOptions,
} from './contactsSyncCodec.js';

const CODEC_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_CODEC_WORKERS = 2;
const MAX_QUEUED_CODEC_TASKS = 8;
const MAX_QUEUED_CODEC_BYTES = MAX_QUEUED_CODEC_TASKS * CONTACTS_SYNC_MAX_COMPRESSED_BYTES;
let activeWorkers = 0;
let queuedBytes = 0;

interface CodecWorkerWaiter {
  weight: number;
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
): Promise<void> {
  if (signal?.aborted) throw codecAbortedError();
  if (activeWorkers < MAX_CONCURRENT_CODEC_WORKERS) {
    activeWorkers += 1;
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

function releaseCodecWorkerSlot(): void {
  activeWorkers -= 1;
  while (waiters.length > 0) {
    const waiter = waiters.shift()!;
    queuedBytes -= waiter.weight;
    waiter.cleanup();
    if (waiter.signal?.aborted) {
      waiter.reject(codecAbortedError());
      continue;
    }
    activeWorkers += 1;
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
  await acquireCodecWorkerSlot(weight, signal, deadline);
  let worker: Worker | null = null;
  try {
    if (signal?.aborted) throw codecAbortedError();
    const currentWorker = new Worker(path.join(__dirname, 'contactsSyncCodecWorker.js'));
    worker = currentWorker;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        operation();
      };
      const onAbort = (): void => finish(() => reject(codecAbortedError()));
      const remaining = deadline - Date.now();
      const timer = setTimeout(
        () => {
          finish(() => reject(new Error('contacts sync codec timed out')));
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
        currentWorker.postMessage(request, transferList);
      } catch (error) {
        finish(() => reject(error));
      }
      if (signal?.aborted) onAbort();
    });
  } finally {
    try {
      if (worker) await worker.terminate();
    } finally {
      releaseCodecWorkerSlot();
    }
  }
}

export const workerContactsSyncCodec: ContactsSyncCodec = {
  async encode(options, signal) {
    const value = await runCodecWorker({ id: randomUUID(), type: 'encode', options }, [], signal);
    if (!isCipherChunkFrames(value)) throw new Error('invalid contacts sync encode result');
    return value;
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
    if (!isContactsSyncStateMessage(value)) throw new Error('invalid contacts sync decode result');
    return value;
  },
};

function codecAbortedError(): Error {
  const error = new Error('contacts sync codec aborted');
  error.name = 'AbortError';
  return error;
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
