import { describe, expect, it } from 'vitest';
import {
  AdaptiveVoicedDetector,
  hasPcmSound,
  RecordingSoundDetector,
  StopSoundActivity,
} from '../pcmActivity';

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

  // 测试价值：验证 StopSoundActivity、RecordingSoundDetector 与 AdaptiveVoicedDetector 在稳态底噪和提示音回声下自适应收敛，不误判静音也不漏判轻声说话。
  // 依据：语音输入优化 ⑦ 要求底噪自适应阈值与开始提示音回声门控，解决嘈杂环境无法触发停顿润色/快速收尾以及提示音被误判为人声的问题。
  // 缺口：既有用例仅验证安静环境下的固定阈值，未覆盖稳态底噪（咖啡馆/风扇）与提示音回声窗口。
  // 最小输入：稳态底噪 PCM（peak 180 / RMS ~127）+ 真实语音（peak 2000）+ 短时提示音回声（200ms vs 360ms）。
  // tier: unit，纯内存合成 PCM，耗时 <50ms。
  it('adapts to steady ambient room noise so stop-time fast finish stops at speech end', () => {
    const detector = new StopSoundActivity(rate);
    // 600ms of steady cafe noise establishes the ambient floor before speech.
    detector.append(tone(600, 180));
    // 300ms of clear speech well above the ambient noise floor.
    detector.append(tone(300, 2000));
    // 2200ms of trailing steady cafe noise must NOT keep extending lastSoundEndMs.
    detector.append(tone(2200, 180));

    expect(detector.lastSoundEndMs).toBeGreaterThanOrEqual(890);
    expect(detector.lastSoundEndMs).toBeLessThan(1200);
  });
});

describe('RecordingSoundDetector', () => {
  it('ignores steady background noise while detecting real speech above the floor', () => {
    const detector = new RecordingSoundDetector();
    for (let i = 0; i < 15; i += 1) {
      expect(detector.append(tone(40, 180).buffer as ArrayBuffer)).toBe(false);
    }
    expect(detector.append(tone(40, 1800).buffer as ArrayBuffer)).toBe(true);
    expect(detector.hasSound).toBe(true);
  });

  it('suppresses brief start-cue echo (<300ms) while accepting continuous speech (>=300ms) during the cue window', () => {
    const detector = new RecordingSoundDetector();
    // 200ms of speaker-to-mic start-cue bleed inside the echo window is ignored.
    for (let i = 0; i < 5; i += 1) {
      expect(detector.append(tone(40, 2500).buffer as ArrayBuffer, { startCueEchoWindow: true, durationMs: 40 })).toBe(false);
    }
    // Silence clears the echo burst streak; recording stays silent.
    expect(detector.append(silence(80).buffer as ArrayBuffer, { startCueEchoWindow: false, durationMs: 80 })).toBe(false);
    expect(detector.hasSound).toBe(false);

    // Continuous user speech spanning >=300ms even while inside the echo window is accepted.
    detector.reset();
    let triggered = false;
    for (let i = 0; i < 9; i += 1) {
      if (detector.append(tone(40, 2500).buffer as ArrayBuffer, { startCueEchoWindow: true, durationMs: 40 })) {
        triggered = true;
      }
    }
    expect(triggered).toBe(true);
  });
});

describe('AdaptiveVoicedDetector', () => {
  it('raises threshold in steady noisy rooms so quiet pauses are still detected', () => {
    const detector = new AdaptiveVoicedDetector();
    // Feed 1.2s of steady ambient noise (RMS ~350, above the old fixed 300 floor).
    let lastVoiced = true;
    for (let i = 0; i < 30; i += 1) {
      lastVoiced = detector.observe(tone(40, 500).buffer as ArrayBuffer, { durationMs: 40 }).voiced;
    }
    // Once calibrated to the steady room noise, noise alone is no longer classified as voiced.
    expect(lastVoiced).toBe(false);
    // Real speech well above the floor is immediately classified as voiced.
    expect(detector.observe(tone(40, 2400).buffer as ArrayBuffer, { durationMs: 40 }).voiced).toBe(true);
  });

  it('lowers threshold in quiet rooms so soft speakers remain voiced', () => {
    const detector = new AdaptiveVoicedDetector();
    for (let i = 0; i < 15; i += 1) {
      expect(detector.observe(silence(40).buffer as ArrayBuffer, { durationMs: 40 }).voiced).toBe(false);
    }
    // Soft speech (peak 280 -> RMS ~198, below the old fixed 300) is detected in a quiet room.
    expect(detector.observe(tone(40, 280).buffer as ArrayBuffer, { durationMs: 40 }).voiced).toBe(true);
  });
});
