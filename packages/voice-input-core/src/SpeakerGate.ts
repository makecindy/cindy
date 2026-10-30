import type { AudioTrace } from './types';

/**
 * Receives audio that already passed an AudioGate, in capture order. Chunks
 * keep their original size and trace; rejected speech arrives as silence.
 */
export type AudioGateEmit = (chunk: ArrayBuffer, trace?: AudioTrace) => void;

/**
 * Optional filter between microphone capture and the controller. The
 * controller owns the run lifecycle; the gate only decides which samples
 * reach the ASR. Every implementation must preserve order and never drop a
 * chunk: muted audio is replaced by silence so the ASR clock stays intact.
 */
export interface AudioGate {
  /** Starts a fresh run. Audio from an earlier run is never emitted again. */
  begin(emit: AudioGateEmit): void;
  push(chunk: ArrayBuffer, trace?: AudioTrace): void;
  /** Decides everything still held and emits it. Resolves once emitted. */
  finish(): Promise<void>;
  /** Drops held audio without emitting it (cancel / failure). */
  abort(): void;
}

/**
 * Platform inference behind the speaker gate. Desktop runs it in a worker
 * thread and mobile in a native module; both load the same VAD and speaker
 * embedding models.
 */
export interface SpeakerGateEngine {
  /** Clears VAD state before a new run. */
  resetVad(): Promise<void>;
  /**
   * Runs VAD over whole frames of SPEAKER_GATE_VAD_FRAME samples and returns
   * one "speech detected" flag per frame, in order.
   */
  detectSpeech(samples: Float32Array): Promise<boolean[]>;
  /** Speaker embedding of 16 kHz mono samples; null when the clip is unusable. */
  embed(samples: Float32Array): Promise<Float32Array | null>;
}

export type SpeakerGateDecision = {
  startSample: number;
  endSample: number;
  score: number;
  accepted: boolean;
  computeMs: number;
};

export type SpeakerGateOptions = {
  engine: SpeakerGateEngine;
  enrolledEmbedding: Float32Array;
  /** Score needed when speech starts. */
  threshold?: number;
  /** Lower score needed to keep going right after an accepted window. */
  continueThreshold?: number;
  /** Longest speech held before a decision. */
  windowSec?: number;
  /** Shortest audio used for one embedding, crossing short pauses. */
  minVerifySec?: number;
  /** Silence held back so a late VAD onset still covers the first syllable. */
  prerollSec?: number;
  /** One engine call taking longer than this disables the gate for the run. */
  engineTimeoutMs?: number;
  /** finish() never holds the user's stop longer than this. */
  finishTimeoutMs?: number;
  onDecision?: (decision: SpeakerGateDecision) => void;
  /** The gate stopped filtering this run and now passes audio through. */
  onPassthrough?: (reason: string) => void;
};

export const SPEAKER_GATE_SAMPLE_RATE = 16_000;
export const SPEAKER_GATE_VAD_FRAME = 512;

/** Defaults measured in the 2026-10 validation (CAM++ zh-en, 1.5 s window). */
export const SPEAKER_GATE_DEFAULTS = {
  threshold: 0.5,
  continueThreshold: 0.4,
  windowSec: 1.5,
  minVerifySec: 1.0,
  prerollSec: 0.5,
  engineTimeoutMs: 3_000,
  finishTimeoutMs: 1_500,
} as const;

export type SpeakerGateStrictness = 'relaxed' | 'standard' | 'strict';

export const SPEAKER_GATE_STRICTNESS_VALUES: readonly SpeakerGateStrictness[] = [
  'relaxed',
  'standard',
  'strict',
];

export const DEFAULT_SPEAKER_GATE_STRICTNESS: SpeakerGateStrictness = 'standard';

/**
 * Thresholds behind the user-facing strictness levels. In validation the
 * owner's own windows scored about 0.8 and one similar-sounding bystander
 * 0.44–0.50: "strict" blocks that bystander, "relaxed" clips the owner less in
 * noisy rooms.
 */
export const SPEAKER_GATE_STRICTNESS_THRESHOLDS: Readonly<
  Record<SpeakerGateStrictness, { threshold: number; continueThreshold: number }>
> = {
  relaxed: { threshold: 0.42, continueThreshold: 0.32 },
  standard: { threshold: SPEAKER_GATE_DEFAULTS.threshold, continueThreshold: SPEAKER_GATE_DEFAULTS.continueThreshold },
  strict: { threshold: 0.55, continueThreshold: 0.45 },
};

export function isSpeakerGateStrictness(value: unknown): value is SpeakerGateStrictness {
  return typeof value === 'string' && (SPEAKER_GATE_STRICTNESS_VALUES as readonly string[]).includes(value);
}

type HeldChunk = {
  samples: Int16Array;
  trace?: AudioTrace;
  start: number;
};

class EngineTimeoutError extends Error {}

/**
 * SpeakerGate passes the enrolled speaker's voice and mutes everyone else.
 *
 * Silence is released after a short pre-roll. Speech is held until the speaker
 * pauses or a full window has accumulated, then compared with the enrolled
 * voiceprint. Inference is asynchronous, so all work runs on one serial queue
 * and audio is emitted strictly in capture order.
 *
 * The gate fails open: an engine error or timeout releases everything held and
 * passes the rest of the run through unchanged. Losing the user's own words is
 * worse than letting a bystander through.
 */
export class SpeakerGate implements AudioGate {
  private readonly engine: SpeakerGateEngine;
  private readonly enrolled: Float32Array;
  private readonly threshold: number;
  private readonly continueThreshold: number;
  private readonly windowSamples: number;
  private readonly minVerifySamples: number;
  private readonly prerollSamples: number;
  private readonly engineTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private readonly onDecision?: (decision: SpeakerGateDecision) => void;
  private readonly onPassthrough?: (reason: string) => void;

  private emit: AudioGateEmit | null = null;
  private runToken = 0;
  private queue: Promise<void> = Promise.resolve();
  private passthrough = false;
  private held: HeldChunk[] = [];
  private total = 0;
  private released = 0;
  private vadPos = 0;
  private vadCarry: Float32Array = new Float32Array(0);
  private inSpeech = false;
  private pendingStart = 0;
  private lastAcceptedEnd = -1;
  // Most recent accepted speech, used as context until a window is rejected.
  private speechTail: Float32Array;
  private speechTailLength = 0;

  constructor(options: SpeakerGateOptions) {
    this.engine = options.engine;
    this.enrolled = options.enrolledEmbedding;
    this.threshold = options.threshold ?? SPEAKER_GATE_DEFAULTS.threshold;
    this.continueThreshold = options.continueThreshold ?? SPEAKER_GATE_DEFAULTS.continueThreshold;
    this.windowSamples = seconds(options.windowSec ?? SPEAKER_GATE_DEFAULTS.windowSec);
    this.minVerifySamples = seconds(options.minVerifySec ?? SPEAKER_GATE_DEFAULTS.minVerifySec);
    this.prerollSamples = seconds(options.prerollSec ?? SPEAKER_GATE_DEFAULTS.prerollSec);
    this.engineTimeoutMs = options.engineTimeoutMs ?? SPEAKER_GATE_DEFAULTS.engineTimeoutMs;
    this.finishTimeoutMs = options.finishTimeoutMs ?? SPEAKER_GATE_DEFAULTS.finishTimeoutMs;
    this.onDecision = options.onDecision;
    this.onPassthrough = options.onPassthrough;
    this.speechTail = new Float32Array(Math.max(this.windowSamples, this.minVerifySamples));
  }

  begin(emit: AudioGateEmit): void {
    this.resetRun();
    this.emit = emit;
    const token = this.runToken;
    this.enqueue(token, () => this.withTimeout(this.engine.resetVad()));
  }

  push(chunk: ArrayBuffer, trace?: AudioTrace): void {
    if (!this.emit) return;
    const samples = new Int16Array(chunk.slice(0, chunk.byteLength - (chunk.byteLength % 2)));
    if (this.passthrough) {
      this.emit(samples.buffer, trace);
      return;
    }
    this.held.push({ samples, trace, start: this.total });
    this.total += samples.length;
    this.vadCarry = concatFloat(this.vadCarry, toFloat(samples));
    const token = this.runToken;
    this.enqueue(token, () => this.analyze(token));
  }

  async finish(): Promise<void> {
    if (!this.emit) return;
    const token = this.runToken;
    this.enqueue(token, async () => {
      if (this.inSpeech && this.total > this.pendingStart) {
        await this.decide(token, this.pendingStart, this.total);
      }
      if (token !== this.runToken || this.passthrough) return;
      this.inSpeech = false;
      this.releaseUpTo(this.total);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.queue.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.finishTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (token !== this.runToken) return;
    if (timedOut) this.enterPassthrough('finish_timeout');
    // Whatever happened above, nothing of this run may stay held.
    this.releaseUpTo(this.total);
  }

  abort(): void {
    this.resetRun();
  }

  private resetRun(): void {
    this.runToken += 1;
    this.emit = null;
    this.queue = Promise.resolve();
    this.passthrough = false;
    this.held = [];
    this.total = 0;
    this.released = 0;
    this.vadPos = 0;
    this.vadCarry = new Float32Array(0);
    this.inSpeech = false;
    this.pendingStart = 0;
    this.lastAcceptedEnd = -1;
    this.speechTailLength = 0;
  }

  private enqueue(token: number, task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (token !== this.runToken || this.passthrough) return;
      try {
        await task();
      } catch (error) {
        if (token !== this.runToken) return;
        this.enterPassthrough(error instanceof EngineTimeoutError
          ? 'engine_timeout'
          : `engine_error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async analyze(token: number): Promise<void> {
    const frames = Math.floor(this.vadCarry.length / SPEAKER_GATE_VAD_FRAME);
    if (frames === 0) return;
    const usable = frames * SPEAKER_GATE_VAD_FRAME;
    const input = this.vadCarry.slice(0, usable);
    this.vadCarry = this.vadCarry.slice(usable);
    const flags = await this.withTimeout(this.engine.detectSpeech(input));
    if (token !== this.runToken || this.passthrough) return;
    for (let i = 0; i < frames; i += 1) {
      this.vadPos += SPEAKER_GATE_VAD_FRAME;
      await this.step(token, this.vadPos, flags[i] === true);
      if (token !== this.runToken || this.passthrough) return;
    }
  }

  private async step(token: number, frameEnd: number, detected: boolean): Promise<void> {
    if (detected && !this.inSpeech) {
      this.inSpeech = true;
      this.pendingStart = this.released;
    }
    if (this.inSpeech) {
      if (frameEnd - this.pendingStart >= this.windowSamples) {
        await this.decide(token, this.pendingStart, frameEnd);
        if (token !== this.runToken || this.passthrough) return;
      }
      if (!detected) {
        this.inSpeech = false;
        if (frameEnd > this.pendingStart) await this.decide(token, this.pendingStart, frameEnd);
      }
      return;
    }
    this.releaseUpTo(frameEnd - this.prerollSamples);
  }

  private async decide(token: number, start: number, end: number): Promise<void> {
    const speech = this.readHeld(start, end);
    // VAD frame boundaries can make this window longer than speechTail's
    // capacity. Preserve the whole window; only accepted history may pad a
    // short one. Do not commit the current speech until it has been judged.
    const context = speech.length >= this.minVerifySamples
      ? speech
      : concatFloat(this.speechTailSlice(this.minVerifySamples - speech.length), speech);
    const startedAt = now();
    const embedding = await this.withTimeout(this.engine.embed(context));
    if (token !== this.runToken || this.passthrough) return;
    const computeMs = now() - startedAt;
    const score = embedding ? cosineSimilarity(embedding, this.enrolled) : -1;
    const continuing = this.lastAcceptedEnd >= 0 && start <= this.lastAcceptedEnd;
    const accepted = score >= (continuing ? this.continueThreshold : this.threshold);
    if (accepted) {
      this.lastAcceptedEnd = end;
      this.appendSpeechTail(speech);
    } else {
      // A rejected speaker breaks continuity, including older accepted audio.
      this.lastAcceptedEnd = -1;
      this.speechTailLength = 0;
      this.muteHeld(start, end);
    }
    this.onDecision?.({ startSample: start, endSample: end, score, accepted, computeMs });
    this.pendingStart = end;
    this.releaseUpTo(end);
  }

  private releaseUpTo(upTo: number): void {
    if (upTo > this.released) this.released = Math.min(upTo, this.total);
    const emit = this.emit;
    if (!emit) return;
    while (this.held.length > 0) {
      const chunk = this.held[0];
      if (chunk.start + chunk.samples.length > this.released) break;
      this.held.shift();
      emit(chunk.samples.buffer as ArrayBuffer, chunk.trace);
    }
  }

  private enterPassthrough(reason: string): void {
    if (this.passthrough) return;
    this.passthrough = true;
    this.inSpeech = false;
    this.vadCarry = new Float32Array(0);
    this.released = this.total;
    this.releaseUpTo(this.total);
    this.onPassthrough?.(reason);
  }

  private readHeld(start: number, end: number): Float32Array {
    const out = new Float32Array(Math.max(0, end - start));
    for (const chunk of this.held) {
      const chunkEnd = chunk.start + chunk.samples.length;
      if (chunkEnd <= start || chunk.start >= end) continue;
      const from = Math.max(start, chunk.start);
      const to = Math.min(end, chunkEnd);
      for (let i = from; i < to; i += 1) out[i - start] = chunk.samples[i - chunk.start] / 32768;
    }
    return out;
  }

  private muteHeld(start: number, end: number): void {
    for (const chunk of this.held) {
      const chunkEnd = chunk.start + chunk.samples.length;
      if (chunkEnd <= start || chunk.start >= end) continue;
      chunk.samples.fill(0, Math.max(start, chunk.start) - chunk.start, Math.min(end, chunkEnd) - chunk.start);
    }
  }

  private appendSpeechTail(samples: Float32Array): void {
    const capacity = this.speechTail.length;
    if (samples.length >= capacity) {
      this.speechTail.set(samples.subarray(samples.length - capacity));
      this.speechTailLength = capacity;
      return;
    }
    const keep = Math.min(this.speechTailLength, capacity - samples.length);
    this.speechTail.copyWithin(0, this.speechTailLength - keep, this.speechTailLength);
    this.speechTail.set(samples, keep);
    this.speechTailLength = keep + samples.length;
  }

  private speechTailSlice(length: number): Float32Array {
    const take = Math.min(length, this.speechTailLength);
    return this.speechTail.slice(this.speechTailLength - take, this.speechTailLength);
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EngineTimeoutError('engine timeout')), this.engineTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / Math.sqrt(na * nb);
}

/** PCM16 little-endian to float samples in [-1, 1). */
export function pcm16ToFloat(pcm: ArrayBuffer): Float32Array {
  return toFloat(new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2)));
}

function toFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 32768;
  return out;
}

function concatFloat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function seconds(value: number): number {
  return Math.round(value * SPEAKER_GATE_SAMPLE_RATE);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
