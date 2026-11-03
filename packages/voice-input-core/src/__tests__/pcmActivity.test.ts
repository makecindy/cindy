import { describe, expect, it } from 'vitest';
import { hasPcmSound, StopSoundActivity } from '../pcmActivity';

const rate = 16000;
const silence = (ms: number): Uint8Array => new Uint8Array(((ms * rate) / 1000) * 2);
function writeSample(pcm: Uint8Array, index: number, value: number): void {
  new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).setInt16(index * 2, value, true);
}
function tone(ms: number, peak: number): Uint8Array {
  const pcm = silence(ms);
  for (let i = 0; i < pcm.length / 2; i++)
    writeSample(pcm, i, Math.round(peak * Math.sin((2 * Math.PI * i) / 16)));
  return pcm;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('conservative PCM silence check', () => {
  it('accepts empty, digital silence and a very low noise floor as silent', () => {
    for (const pcm of [
      new Int16Array(),
      new Int16Array(640),
      Int16Array.from({ length: 640 }, (_, i) => (i % 2 ? 12 : -12)),
    ]) {
      expect(hasPcmSound(pcm.buffer)).toBe(false);
    }
  });

  it('keeps quiet sound well below the cloud stall watchdog speech threshold', () => {
    const pcm = Int16Array.from({ length: 640 }, (_, i) => Math.round(60 * Math.sin(i * 0.1)));
    expect(hasPcmSound(pcm.buffer)).toBe(true);
  });

  it('keeps a brief sound even when the full chunk RMS is small', () => {
    const pcm = new Int16Array(640);
    pcm[300] = -150;
    expect(hasPcmSound(pcm.buffer)).toBe(true);
  });

  it('does not discard malformed PCM as silence', () => {
    expect(hasPcmSound(new ArrayBuffer(3))).toBe(true);
  });
});

describe('stop-time sound activity', () => {
  it('ignores low background noise and isolated high-amplitude impulses', () => {
    const detector = new StopSoundActivity(rate);
    const pcm = tone(1000, 20);
    for (const index of [1, 999, 8000]) writeSample(pcm, index, 30000);
    detector.append(pcm);
    detector.append(silence(30));
    expect(detector.lastSoundEndMs).toBe(0);
  });

  it.each([1, 2, 3])('ignores an isolated %s ms burst after the uncertainty window', (ms) => {
    const detector = new StopSoundActivity(rate);
    detector.append(tone(ms, 20000));
    expect(detector.lastSoundEndMs).toBe(ms); // immediate stop stays conservative
    detector.append(silence(30));
    expect(detector.lastSoundEndMs).toBe(0);
  });

  it.each([
    [40, 56],
    [20, 56],
    [10, 160],
    [6, 160],
  ])('protects a %s ms sound with peak %s', (duration, peak) => {
    const detector = new StopSoundActivity(rate);
    detector.append(silence(300));
    detector.append(tone(duration, peak));
    detector.append(silence(3000));
    expect(detector.lastSoundEndMs).toBe(300 + duration);
  });

  it('ignores a later impulse without forgetting earlier quiet speech', () => {
    const detector = new StopSoundActivity(rate);
    detector.append(tone(40, 56));
    detector.append(silence(500));
    detector.append(tone(1, 30000));
    detector.append(silence(3000));
    expect(detector.lastSoundEndMs).toBe(40);
  });

  it('is independent of audio packet boundaries, including partial millisecond buckets', () => {
    const pcm = concat(silence(100), tone(20, 56), silence(100), tone(2, 20000), silence(30));
    for (const bytes of [2, 14, 320, 1280, pcm.length]) {
      const detector = new StopSoundActivity(rate);
      for (let offset = 0; offset < pcm.length; offset += bytes)
        detector.append(pcm.subarray(offset, offset + bytes));
      expect(detector.lastSoundEndMs).toBe(120);
    }
  });

  it('reads little-endian samples from a view into a larger buffer', () => {
    const detector = new StopSoundActivity(rate);
    const backing = concat(new Uint8Array(3), tone(40, 56), new Uint8Array(1));
    detector.append(backing.subarray(3, backing.length - 1));
    detector.append(silence(3000));
    expect(detector.lastSoundEndMs).toBe(40);
  });

  it('protects an unfinished tail and resets all evidence between recordings', () => {
    const detector = new StopSoundActivity(rate);
    detector.append(new Uint8Array(new Int16Array([100, 100, 100, 100]).buffer));
    expect(detector.lastSoundEndMs).toBe(0.25);
    detector.reset();
    detector.append(silence(100));
    expect(detector.lastSoundEndMs).toBe(0);
  });
});
