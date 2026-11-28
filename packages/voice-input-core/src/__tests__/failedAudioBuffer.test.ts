import { describe, expect, it } from 'vitest';

import {
  FailedVoiceAudioAccumulator,
  FAILED_VOICE_AUDIO_TTL_MS,
  isRetainedFailedVoiceAudioExpired,
  shouldRetainFailedVoiceAudio,
  sliceRetainedAudioForReplay,
} from '../failedAudioBuffer.js';

function makePcm16(samples: number, amplitude: number): ArrayBuffer {
  const buf = new ArrayBuffer(samples * 2);
  const view = new Int16Array(buf);
  for (let i = 0; i < samples; i += 1) {
    view[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return buf;
}

describe('failedAudioBuffer', () => {
  it('excludes silent, cancelled, permission-denied, capture-failed, and already-landed runs', () => {
    expect(shouldRetainFailedVoiceAudio({ hasSound: true, transcriptLanded: false, cancelled: false })).toBe(true);
    expect(shouldRetainFailedVoiceAudio({ hasSound: false, transcriptLanded: false, cancelled: false })).toBe(false);
    expect(shouldRetainFailedVoiceAudio({ hasSound: true, transcriptLanded: true, cancelled: false })).toBe(false);
    expect(shouldRetainFailedVoiceAudio({ hasSound: true, transcriptLanded: false, cancelled: true })).toBe(false);
    expect(shouldRetainFailedVoiceAudio({ hasSound: true, transcriptLanded: false, cancelled: false, permissionDenied: true })).toBe(false);
    expect(shouldRetainFailedVoiceAudio({ hasSound: true, transcriptLanded: false, cancelled: false, captureFailed: true })).toBe(false);
  });

  it('rejects purely silent PCM and retains voiced audio with bounded FIFO eviction and TTL expiry', () => {
    const acc = new FailedVoiceAudioAccumulator({ sampleRate: 16_000, maxBytes: 8_000, ttlMs: 5_000 });
    acc.append(makePcm16(2_000, 0)); // 4000 bytes of silence
    expect(acc.hasSound).toBe(false);
    expect(acc.snapshot('silent', 1_000)).toBeNull();

    // Append three 3200-byte voiced chunks -> total 9600 exceeds 8000, oldest evicted.
    const c1 = makePcm16(1_600, 1_500);
    const c2 = makePcm16(1_600, 2_500);
    const c3 = makePcm16(1_600, 3_500);
    acc.append(c1);
    acc.append(c2);
    acc.append(c3);
    // Mutating caller buffer after append must not corrupt retained copy.
    new Int16Array(c3).fill(0);

    const snapshot = acc.snapshot('failed-1', 10_000);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.totalBytes).toBeLessThanOrEqual(8_000);
    expect(snapshot!.expiresAt).toBe(15_000);
    expect(isRetainedFailedVoiceAudioExpired(snapshot, 14_999)).toBe(false);
    expect(isRetainedFailedVoiceAudioExpired(snapshot, 15_000)).toBe(true);

    const replayChunks = sliceRetainedAudioForReplay(snapshot!, 3_200);
    expect(replayChunks.length).toBeGreaterThanOrEqual(2);
    const lastSample = new Int16Array(replayChunks[replayChunks.length - 1]!.pcm)[0];
    expect(lastSample).toBe(3_500);

    acc.clear();
    expect(acc.byteLength).toBe(0);
    expect(acc.snapshot('after-clear', 10_000)).toBeNull();
    expect(FAILED_VOICE_AUDIO_TTL_MS).toBe(10 * 60 * 1000);
  });
});
