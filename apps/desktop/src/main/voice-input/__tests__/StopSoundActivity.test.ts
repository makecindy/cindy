import { describe, expect, it } from 'vitest';
import { StopSoundActivity } from '../StopSoundActivity.js';

const rate = 16000;
const silence = (ms: number) => Buffer.alloc(((ms * rate) / 1000) * 2);
function tone(ms: number, peak: number): Buffer {
  const pcm = silence(ms);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(peak * Math.sin((2 * Math.PI * i) / 16)), i * 2);
  return pcm;
}

describe('stop-time sound activity', () => {
  it('ignores low background noise and isolated high-amplitude impulses', () => {
    const detector = new StopSoundActivity(rate);
    const pcm = tone(1000, 20);
    for (const index of [1, 999, 8000]) pcm.writeInt16LE(30000, index * 2);
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
    const pcm = Buffer.concat([
      silence(100),
      tone(20, 56),
      silence(100),
      tone(2, 20000),
      silence(30),
    ]);
    for (const bytes of [2, 14, 320, 1280, pcm.length]) {
      const detector = new StopSoundActivity(rate);
      for (let offset = 0; offset < pcm.length; offset += bytes)
        detector.append(pcm.subarray(offset, offset + bytes));
      expect(detector.lastSoundEndMs).toBe(120);
    }
  });

  it('protects an unfinished tail and resets all evidence between recordings', () => {
    const detector = new StopSoundActivity(rate);
    detector.append(Buffer.from(new Int16Array([100, 100, 100, 100]).buffer));
    expect(detector.lastSoundEndMs).toBe(0.25);
    detector.reset();
    detector.append(silence(100));
    expect(detector.lastSoundEndMs).toBe(0);
  });
});
