import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- speaker-gate inference is CPU-isolated and never touches the database.
import { Worker } from 'node:worker_threads';

import {
  SPEAKER_GATE_VAD_FRAME,
  type SpeakerEnrollmentEngine,
  type SpeakerGateEngine,
} from '@cindy/voice-input-core';

import type { SpeakerWorkerRequest, SpeakerWorkerResponse } from './speakerWorkerProtocol';

type ModelPaths = { vadModel: string; embeddingModel: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<SpeakerWorkerRequest, 'id'>;
type OkResponse = Extract<SpeakerWorkerResponse, { ok: true }>;

type Pending = {
  resolve: (response: OkResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A worker idle this long is stopped; the next dictation starts it again. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;

/**
 * Owns the speaker-gate worker thread. The worker is started on first use,
 * loads the models once, and exits after a quiet period. A crashed worker
 * rejects everything in flight (the gate then fails open) and is restarted on
 * the next call.
 */
export class SpeakerEngineHost {
  private worker: Worker | null = null;
  private loadedModels: ModelPaths | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private nextSession = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly resolveModels: () => ModelPaths | null,
    private readonly workerPath = path.join(__dirname, 'speakerGateWorker.js'),
    private readonly requestTimeoutMs = 15_000,
  ) {}

  /** Starts the worker and loads models ahead of the first chunk. */
  warm(): Promise<void> {
    return this.ensureReady();
  }

  createGateEngine(): SpeakerGateEngine {
    const session = `run-${this.nextSession++}`;
    return {
      resetVad: async () => {
        await this.call({ op: 'vad-reset', session });
      },
      detectSpeech: async (samples) => {
        const usable = samples.length - (samples.length % SPEAKER_GATE_VAD_FRAME);
        const response = await this.call({ op: 'vad', session, samples: samples.slice(0, usable) });
        return Array.from(response.flags ?? [], (flag) => flag === 1);
      },
      embed: async (samples) => (await this.call({ op: 'embed', samples: samples.slice() })).embedding ?? null,
    };
  }

  createEnrollmentEngine(): SpeakerEnrollmentEngine {
    return {
      extractSpeech: async (samples) =>
        (await this.call({ op: 'speech', samples: samples.slice() })).samples ?? new Float32Array(0),
      embed: async (samples) => (await this.call({ op: 'embed', samples: samples.slice() })).embedding ?? null,
    };
  }

  /** Stops the worker (models deleted, app quitting). */
  shutdown(reason = 'shutdown'): void {
    this.clearIdleTimer();
    const worker = this.worker;
    this.worker = null;
    this.loadedModels = null;
    this.readyPromise = null;
    this.rejectAll(new Error(`speaker engine ${reason}`));
    void worker?.terminate();
  }

  private async call(body: RequestBody): Promise<OkResponse> {
    await this.ensureReady();
    return this.send(body);
  }

  private ensureReady(): Promise<void> {
    const models = this.resolveModels();
    if (!models) return Promise.reject(new Error('speaker models are not installed'));
    if (
      this.readyPromise &&
      this.loadedModels?.vadModel === models.vadModel &&
      this.loadedModels.embeddingModel === models.embeddingModel
    ) {
      return this.readyPromise;
    }
    if (this.worker) this.shutdown('models_changed');
    this.loadedModels = models;
    const ready = this.send({ op: 'init', ...models }).then(() => undefined);
    this.readyPromise = ready;
    // A failed load must not stick: the next call tries a fresh worker.
    ready.catch(() => {
      if (this.readyPromise === ready) this.shutdown('init_failed');
    });
    return ready;
  }

  private send(body: RequestBody): Promise<OkResponse> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      // A worker that cannot even start must reject like any other failure,
      // so the gate fails open instead of breaking dictation start.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const id = this.nextId++;
    this.clearIdleTimer();
    return new Promise<OkResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.worker === worker) this.shutdown('request_timeout');
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const request = { ...body, id } as SpeakerWorkerRequest;
      const transfer = 'samples' in request ? [request.samples.buffer as ArrayBuffer] : [];
      try {
        worker.postMessage(request, transfer);
      } catch {
        this.shutdown('send_failed');
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath);
    worker.on('message', (response: SpeakerWorkerResponse) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response);
      else pending.reject(new Error(response.error));
      if (this.pending.size === 0) this.scheduleIdleShutdown();
    });
    const onGone = (error: Error): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.loadedModels = null;
      this.readyPromise = null;
      this.clearIdleTimer();
      this.rejectAll(error);
    };
    worker.on('error', onGone);
    worker.on('exit', (code) => onGone(new Error(`speaker worker exited (${code})`)));
    // An idle worker must not keep the app alive on quit.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.shutdown('idle'), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
