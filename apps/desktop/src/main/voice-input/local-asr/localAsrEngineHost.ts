import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- local offline ASR inference is CPU-isolated and never touches the database.
import { Worker } from 'node:worker_threads';

import {
  localAsrModelSpecKey,
  type LocalAsrModelSpec,
  type LocalAsrWorkerRequest,
  type LocalAsrWorkerResponse,
} from './localAsrWorkerProtocol.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<LocalAsrWorkerRequest, 'id'>;
type OkResponse = Extract<LocalAsrWorkerResponse, { ok: true }>;

type Pending = {
  resolve: (response: OkResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface LocalAsrDecodeEngine {
  warm(language?: string): Promise<void>;
  transcribe(samples: Float32Array, sampleRate: number, language?: string): Promise<string>;
}

/** Stop the idle inference worker after 10 minutes to free model RAM. */
const IDLE_SHUTDOWN_MS = 10 * 60_000;

/**
 * Owns the dedicated sherpa-onnx offline ASR worker thread.
 * Mirrors SpeakerEngineHost: lazy start, idle memory reclamation, clean crash
 * recovery, and automatic reload when the user switches local model folders.
 */
export class LocalAsrEngineHost implements LocalAsrDecodeEngine {
  private worker: Worker | null = null;
  private loadedKey: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly resolveModel: () => LocalAsrModelSpec | null,
    private readonly workerPath = path.join(__dirname, 'localAsrWorker.js'),
    private readonly requestTimeoutMs = 30_000,
  ) {}

  warm(language?: string): Promise<void> {
    return this.ensureReady(language);
  }

  async transcribe(samples: Float32Array, sampleRate: number, language?: string): Promise<string> {
    await this.ensureReady(language);
    const copy = samples.slice();
    const response = await this.send({ op: 'transcribe', samples: copy, sampleRate });
    return response.text ?? '';
  }

  shutdown(reason = 'shutdown'): void {
    this.clearIdleTimer();
    const worker = this.worker;
    this.worker = null;
    this.loadedKey = null;
    this.readyPromise = null;
    this.rejectAll(new Error(`local ASR engine ${reason}`));
    void worker?.terminate();
  }

  private ensureReady(language?: string): Promise<void> {
    const spec = this.resolveModel();
    if (!spec) {
      return Promise.reject(new Error('Select a local sherpa-onnx ASR model folder to enable offline voice input.'));
    }
    const normalizedLang = (language ?? '').trim().toLowerCase();
    const key = localAsrModelSpecKey(spec, normalizedLang === 'auto' ? '' : normalizedLang.split(/[-_]/)[0] ?? '');
    if (this.readyPromise && this.loadedKey === key) {
      return this.readyPromise;
    }
    if (this.worker && this.loadedKey && this.loadedKey !== key) {
      this.shutdown('model_changed');
    }
    this.loadedKey = key;
    const ready = this.send({ op: 'init', spec, language }).then(() => undefined);
    this.readyPromise = ready;
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
      const request = { ...body, id } as LocalAsrWorkerRequest;
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
    worker.on('message', (response: LocalAsrWorkerResponse) => {
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
      this.loadedKey = null;
      this.readyPromise = null;
      this.clearIdleTimer();
      this.rejectAll(error);
    };
    worker.on('error', onGone);
    worker.on('exit', (code) => onGone(new Error(`local ASR worker exited (${code})`)));
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
