import { pcm16ToFloat, type AsrEvent, type AsrProvider, type AudioTrace } from '@cindy/voice-input-core';

import type { LocalAsrDecodeEngine } from './localAsrEngineHost.js';

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_PARTIAL_INTERVAL_MS = 700;
const DEFAULT_MIN_PARTIAL_AUDIO_MS = 400;
const MAX_BUFFERED_AUDIO_SECONDS = 180;
const MAX_PARTIAL_AUDIO_SECONDS = 8;

export type LocalSherpaAsrProviderOptions = {
  engine: LocalAsrDecodeEngine;
  language?: string;
  sampleRate?: number;
  /** Interval between bounded-window preview decodes; set <= 0 to disable partials. */
  partialIntervalMs?: number;
  minPartialAudioMs?: number;
};

/**
 * Local on-device ASR provider backed by sherpa-onnx-node in an isolated worker.
 *
 * Works completely offline with no Cindy account, no cloud endpoint, and no API key:
 * - Warms the local ONNX recognizer in `start()`.
 * - Buffers 16 kHz PCM16 audio and decodes only the recent eight seconds for
 *   live previews, while the final decode uses the complete recording.
 * - Runs an authoritative final decode on `flushAudio()` and emits `stable`.
 */
export class LocalSherpaAsrProvider implements AsrProvider {
  private readonly listeners: Array<(event: AsrEvent) => void> = [];
  private readonly sampleRate: number;
  private readonly partialIntervalMs: number;
  private readonly minPartialAudioMs: number;
  private readonly maxBytes: number;
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private running = false;
  private dirty = false;
  private lastEmittedPartial = '';
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private inFlightPartial: Promise<void> | null = null;

  constructor(private readonly options: LocalSherpaAsrProviderOptions) {
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.partialIntervalMs = options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS;
    this.minPartialAudioMs = options.minPartialAudioMs ?? DEFAULT_MIN_PARTIAL_AUDIO_MS;
    this.maxBytes = this.sampleRate * 2 * MAX_BUFFERED_AUDIO_SECONDS;
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.listeners.push(callback);
  }

  async start(): Promise<void> {
    await this.options.engine.warm(this.options.language);
    this.chunks = [];
    this.totalBytes = 0;
    this.dirty = false;
    this.lastEmittedPartial = '';
    this.running = true;
    this.emit({ type: 'connected', at: Date.now() });

    if (this.partialIntervalMs > 0) {
      this.partialTimer = setInterval(() => {
        this.maybeRunPartialDecode();
      }, this.partialIntervalMs);
      this.partialTimer.unref?.();
    }
  }

  appendAudio(chunk: ArrayBuffer, _trace?: AudioTrace): void {
    if (!this.running || chunk.byteLength === 0) return;
    if (this.totalBytes + chunk.byteLength > this.maxBytes) {
      this.running = false;
      this.stopPartialTimer();
      this.chunks = [];
      this.totalBytes = 0;
      this.emit({ type: 'error', message: 'Local voice recording exceeded the three-minute limit.', at: Date.now() });
      return;
    }
    const copy = new Uint8Array(chunk.slice(0));
    this.chunks.push(copy);
    this.totalBytes += copy.byteLength;
    this.dirty = true;
  }

  async flushAudio(): Promise<void> {
    this.stopPartialTimer();
    if (this.inFlightPartial) {
      await this.inFlightPartial.catch(() => undefined);
    }
    if (!this.running || this.totalBytes === 0) return;
    const samples = this.buildFloatSamples();
    if (samples.length === 0) return;
    const text = (await this.options.engine.transcribe(samples, this.sampleRate, this.options.language)).trim();
    if (!this.running) return;
    if (text) {
      this.emit({ type: 'stable', text, at: Date.now() });
    }
  }

  async stop(): Promise<void> {
    this.stopPartialTimer();
    const wasRunning = this.running;
    this.running = false;
    if (this.inFlightPartial) {
      await this.inFlightPartial.catch(() => undefined);
    }
    this.chunks = [];
    this.totalBytes = 0;
    this.dirty = false;
    if (wasRunning) {
      this.emit({ type: 'disconnected', at: Date.now() });
    }
  }

  private maybeRunPartialDecode(): void {
    if (!this.running || !this.dirty || this.inFlightPartial) return;
    const durationMs = (this.totalBytes / (this.sampleRate * 2)) * 1000;
    if (durationMs < this.minPartialAudioMs) return;
    this.dirty = false;
    const samples = this.buildFloatSamples(this.sampleRate * 2 * MAX_PARTIAL_AUDIO_SECONDS);
    const run = this.options.engine
      .transcribe(samples, this.sampleRate, this.options.language)
      .then((raw) => {
        if (!this.running) return;
        const text = raw.trim();
        if (text && text !== this.lastEmittedPartial) {
          this.lastEmittedPartial = text;
          this.emit({ type: 'partial', text, at: Date.now() });
        }
      })
      .catch(() => {
        // Non-fatal during incremental preview; flushAudio() surfaces authoritative errors.
      })
      .finally(() => {
        if (this.inFlightPartial === run) this.inFlightPartial = null;
      });
    this.inFlightPartial = run;
  }

  private buildFloatSamples(maxBytes = this.totalBytes): Float32Array {
    const keptBytes = Math.min(this.totalBytes, maxBytes);
    const merged = new Uint8Array(keptBytes - (keptBytes % 2));
    let skip = this.totalBytes - merged.byteLength;
    let offset = 0;
    for (const chunk of this.chunks) {
      if (skip >= chunk.byteLength) {
        skip -= chunk.byteLength;
        continue;
      }
      const len = Math.min(chunk.byteLength - skip, merged.byteLength - offset);
      if (len <= 0) break;
      merged.set(chunk.subarray(skip, skip + len), offset);
      offset += len;
      skip = 0;
    }
    return pcm16ToFloat(merged.buffer);
  }

  private stopPartialTimer(): void {
    if (this.partialTimer) {
      clearInterval(this.partialTimer);
      this.partialTimer = null;
    }
  }

  private emit(event: AsrEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
