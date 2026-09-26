import { describe, expect, it } from 'vitest';
import { hasPcmSound } from '../pcmActivity';

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
