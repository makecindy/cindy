import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  onPcm: null as null | ((chunk: { pcm16k: ArrayBuffer }) => void),
}));
vi.mock('../WebMicAudioEngine', () => ({
  WebMicAudioEngine: class {
    start = audio.start;
    stop = audio.stop;
    onPcm16k(callback: NonNullable<typeof audio.onPcm>) { audio.onPcm = callback; }
  },
}));
vi.mock('../workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));

import {
  recordSpeakerEnrollmentClip,
  SpeakerEnrollmentAbortedError,
  SpeakerEnrollmentNoAudioError,
} from '../speakerEnrollmentRecorder';

const emit = (samples: number) => audio.onPcm?.({ pcm16k: new Int16Array(samples).fill(1234).buffer });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('speaker enrollment recording', () => {
  it('keeps the captured samples when stopped early, with no padding or late chunks', async () => {
    const stop = new AbortController();
    const recording = recordSpeakerEnrollmentClip({ durationMs: 30_000, stopSignal: stop.signal });
    emit(12 * 16_000);
    stop.abort();
    emit(16_000);
    expect(new Int16Array(await recording)).toEqual(new Int16Array(12 * 16_000).fill(1234));
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it('continues past six seconds and caps automatic completion at thirty seconds', async () => {
    const resolved = vi.fn();
    const recording = recordSpeakerEnrollmentClip({ durationMs: 30_000 }).then((clip) => { resolved(); return clip; });
    emit(6 * 16_000);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    emit(25 * 16_000);
    expect((await recording).byteLength).toBe(960_000);
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it('rejects an empty manually stopped clip', async () => {
    const stop = new AbortController();
    const recording = recordSpeakerEnrollmentClip({ durationMs: 30_000, stopSignal: stop.signal });
    stop.abort();
    await expect(recording).rejects.toBeInstanceOf(SpeakerEnrollmentNoAudioError);
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it('discards audio on cancellation even when finish was also requested', async () => {
    const stop = new AbortController();
    const cancel = new AbortController();
    const recording = recordSpeakerEnrollmentClip({ durationMs: 30_000, stopSignal: stop.signal, signal: cancel.signal });
    emit(16_000);
    stop.abort();
    cancel.abort();
    await expect(recording).rejects.toBeInstanceOf(SpeakerEnrollmentAbortedError);
    expect(audio.stop).toHaveBeenCalledOnce();
  });

  it('does not treat a stalled partial capture as a successful manual stop', async () => {
    vi.useFakeTimers();
    const recording = recordSpeakerEnrollmentClip({ durationMs: 30_000 });
    const rejected = expect(recording).rejects.toBeInstanceOf(SpeakerEnrollmentNoAudioError);
    emit(16_000);
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(audio.stop).toHaveBeenCalledOnce();
  });
});
