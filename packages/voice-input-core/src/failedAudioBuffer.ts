import { hasPcmSound } from './pcmActivity';

/** Default retention cap: 5 minutes of 16 kHz mono PCM16 (~9.6 MB). */
export const DEFAULT_FAILED_AUDIO_MAX_BYTES = 16_000 * 2 * 300;
/** Minimum voiced PCM duration to consider worth retaining (~120 ms at 16 kHz). */
export const MIN_FAILED_AUDIO_BYTES = 16_000 * 2 * 0.12;
/** Retained failed audio automatically expires after 10 minutes. */
export const FAILED_VOICE_AUDIO_TTL_MS = 10 * 60 * 1000;
/** Default chunk size when streaming retained audio back into an ASR provider (~200 ms at 16 kHz). */
export const DEFAULT_REPLAY_CHUNK_BYTES = 6_400;

export type RetainedFailedVoiceAudio = {
  id: string;
  sampleRate: number;
  /** Owned, immutable copies of captured PCM16 little-endian mono frames. */
  chunks: Uint8Array[];
  totalBytes: number;
  durationMs: number;
  capturedAt: number;
  expiresAt: number;
};

export type FailedVoiceAudioRetentionCheck = {
  hasSound: boolean;
  transcriptLanded: boolean;
  cancelled: boolean;
  permissionDenied?: boolean;
  captureFailed?: boolean;
};

/**
 * Decides whether a failed recording should retain its captured audio for
 * one-click re-recognition.
 *
 * Silent takes, explicit user cancellations, microphone permission/capture
 * failures without speech, and runs that already produced a usable transcript
 * are strictly excluded.
 */
export function shouldRetainFailedVoiceAudio(input: FailedVoiceAudioRetentionCheck): boolean {
  if (!input.hasSound) return false;
  if (input.transcriptLanded) return false;
  if (input.cancelled) return false;
  if (input.permissionDenied) return false;
  if (input.captureFailed) return false;
  return true;
}

export function isRetainedFailedVoiceAudioExpired(
  audio: Pick<RetainedFailedVoiceAudio, 'expiresAt'> | null | undefined,
  now = Date.now(),
): boolean {
  if (!audio) return true;
  return now >= audio.expiresAt;
}

/**
 * Re-slices retained PCM16 bytes into evenly sized ArrayBuffer chunks for
 * replay through `VoiceInputController` / ASR providers.
 */
export function sliceRetainedAudioForReplay(
  audio: Pick<RetainedFailedVoiceAudio, 'chunks' | 'totalBytes' | 'sampleRate'>,
  chunkBytes = DEFAULT_REPLAY_CHUNK_BYTES,
): Array<{ pcm: ArrayBuffer; durationMs: number; chunkIndex: number }> {
  const bytesPerMs = (audio.sampleRate * 2) / 1000;
  const alignedChunkBytes = Math.max(2, chunkBytes - (chunkBytes % 2));
  const merged = new Uint8Array(audio.totalBytes);
  let offset = 0;
  for (const chunk of audio.chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const result: Array<{ pcm: ArrayBuffer; durationMs: number; chunkIndex: number }> = [];
  let chunkIndex = 0;
  for (let pos = 0; pos < merged.byteLength; pos += alignedChunkBytes) {
    const end = Math.min(pos + alignedChunkBytes, merged.byteLength);
    const slice = merged.slice(pos, end);
    result.push({
      pcm: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      durationMs: bytesPerMs > 0 ? slice.byteLength / bytesPerMs : 0,
      chunkIndex,
    });
    chunkIndex += 1;
  }
  return result;
}

/**
 * Bounded in-memory PCM16 accumulator for an active recording.
 *
 * Keeps at most `maxBytes` of the freshest captured PCM16 audio (FIFO sliding
 * drop on overflow) so long recordings never grow unbounded, and immediately
 * releases buffers on `clear()`.
 */
export class FailedVoiceAudioAccumulator {
  private readonly sampleRate: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private hasSoundFlag = false;

  constructor(options?: { sampleRate?: number; maxBytes?: number; ttlMs?: number }) {
    this.sampleRate = options?.sampleRate ?? 16_000;
    this.maxBytes = Math.max(MIN_FAILED_AUDIO_BYTES, options?.maxBytes ?? DEFAULT_FAILED_AUDIO_MAX_BYTES);
    this.ttlMs = Math.max(1_000, options?.ttlMs ?? FAILED_VOICE_AUDIO_TTL_MS);
  }

  append(pcm: ArrayBuffer | Uint8Array): void {
    const view = pcm instanceof Uint8Array
      ? pcm
      : new Uint8Array(pcm);
    if (view.byteLength === 0) return;

    // Copy immediately so pooled/transferred buffers cannot mutate retained audio.
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    if (!this.hasSoundFlag && hasPcmSound(copy.buffer)) {
      this.hasSoundFlag = true;
    }

    if (copy.byteLength >= this.maxBytes) {
      const tail = copy.slice(copy.byteLength - this.maxBytes);
      this.chunks = [tail];
      this.totalBytes = tail.byteLength;
      return;
    }

    this.chunks.push(copy);
    this.totalBytes += copy.byteLength;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.totalBytes -= removed.byteLength;
    }
  }

  get hasSound(): boolean {
    return this.hasSoundFlag;
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  snapshot(id: string, now = Date.now()): RetainedFailedVoiceAudio | null {
    if (!this.hasSoundFlag || this.totalBytes < MIN_FAILED_AUDIO_BYTES) return null;
    const bytesPerMs = (this.sampleRate * 2) / 1000;
    return {
      id,
      sampleRate: this.sampleRate,
      chunks: this.chunks.map((chunk) => new Uint8Array(chunk)),
      totalBytes: this.totalBytes,
      durationMs: bytesPerMs > 0 ? Math.round(this.totalBytes / bytesPerMs) : 0,
      capturedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.hasSoundFlag = false;
  }
}
