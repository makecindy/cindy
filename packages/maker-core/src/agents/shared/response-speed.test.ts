import { describe, expect, it } from 'vitest';
import { retryResponseSpeed, resumeResponseSpeed, mergeResponseSpeedStatus, calibratedResponseDuration, readResponseSpeedSnapshot, stopResponseSpeed, responseSpeedHistory, responseSpeedActivity } from '@cindy/maker-shared/usage-format';
import { ResponseSpeedTracker } from './response-speed.js';

describe('response speed', () => {
  it('distinguishes observed output, silence, execution and subsequent request waiting', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 1000);
    expect(responseSpeedActivity(speed.snapshot(2000), 2000)).toBe('waiting');
    speed.delta('tool arguments', 2000);
    expect(speed.snapshot(2000).toolActive).toBe(false);
    expect(responseSpeedActivity(speed.snapshot(2000), 2000)).toBe('generating');
    expect(responseSpeedActivity(speed.snapshot(3500), 3500)).toBe('quiet');
    speed.endResponse(20, 4000);
    expect(responseSpeedActivity(speed.snapshot(4000), 4000)).toBe('paused');
    speed.toolStarted('command');
    expect(responseSpeedActivity(speed.snapshot(5000), 5000)).toBe('tool');
    // A concurrent model delta remains model generation, even with a tool active.
    speed.delta('parallel output', 6000);
    expect(responseSpeedActivity(speed.snapshot(6000), 6000)).toBe('generating');
    speed.toolEnded('command');
    speed.beginRequest(7000);
    expect(speed.snapshot(8500)).toMatchObject({ phase: 'waiting', waitingMs: 1500, firstResponseMs: 1000 });
    speed.finish(undefined, 9000);
    expect(responseSpeedActivity(speed.snapshot(10000), 10000)).toBe('complete');
  });
  it('separates first content wait from streaming time and calibrates the curve', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    expect(speed.snapshot(2_000)).toMatchObject({ phase: 'waiting', waitingMs: 2_000, recentRate: null });
    speed.content(2_000);
    speed.delta('a'.repeat(40), 2_000);
    speed.delta('b'.repeat(40), 3_000);
    expect(speed.snapshot(3_000)).toMatchObject({ firstResponseMs: 2_000, estimated: true, outputTokens: 20 });
    expect(speed.snapshot(3_000).samples.length).toBeGreaterThan(0);
    speed.endResponse(100, 4_000);
    speed.finish(undefined, 20_000);
    const done = speed.snapshot(20_000);
    expect(done).toMatchObject({ durationMs: 2_000, outputTokens: 100, estimated: false, averageRate: 50, recentRate: 50 });
    expect(done.samples.at(-1)?.rate).toBe(50);
    expect(calibratedResponseDuration(done, 100)).toBe(2_000);
    expect(calibratedResponseDuration(done, 101)).toBeUndefined();
  });

  it('updates a long response before any usage arrives and decays a silent window', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.content(1_000);
    for (let now = 1_000; now <= 8_000; now += 250) speed.delta('abcdefgh', now);
    expect(speed.snapshot(8_000).samples.length).toBeGreaterThan(20);
    expect(speed.snapshot(8_000)).toMatchObject({ estimated: true, phase: 'generating' });
    expect(speed.snapshot(9_500).recentRate).toBeNull();
  });

  it('excludes tools and the next request wait, and calibrates each response separately', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.content(1_000);
    speed.delta('a'.repeat(40), 1_000);
    speed.endResponse(40, 2_000);
    speed.beginRequest(10_000);
    speed.content(12_000);
    speed.delta('a'.repeat(40), 12_000);
    speed.endResponse(60, 13_000);
    speed.finish(undefined, 30_000);
    expect(speed.snapshot(30_000)).toMatchObject({ firstResponseMs: 1_000, durationMs: 2_000,
      outputTokens: 100, estimated: false, averageRate: 50 });
  });

  it('does not double-add repeated per-response usage and handles a real zero', () => {
    const speed = new ResponseSpeedTracker('stream');
    speed.beginRequest(1_000);
    speed.delta('a'.repeat(40), 2_000);
    speed.reportOutput(50);
    speed.reportOutput(50);
    speed.pause(3_000);
    speed.beginRequest(4_000);
    speed.delta('a'.repeat(40), 5_000);
    speed.endResponse(0, 6_000);
    speed.finish(undefined, 7_000);
    expect(speed.snapshot(7_000)).toMatchObject({ waitOrigin: 'stream', firstResponseMs: 1_000,
      outputTokens: 50, durationMs: 2_000, estimated: false, averageRate: 25 });
  });

  it('keeps missing usage approximate and suppresses completed-only or untimed output', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.delta('a'.repeat(40), 1_000);
    speed.finish(undefined, 2_000);
    expect(speed.snapshot(2_000)).toMatchObject({ estimated: true, outputTokens: 10, averageRate: 10 });
    expect(calibratedResponseDuration(speed.snapshot(2_000), 10)).toBeUndefined();
    speed.reset('turn', 3_000);
    speed.endResponse(100, 4_000);
    speed.finish(undefined, 5_000);
    expect(speed.snapshot(5_000)).toMatchObject({ firstResponseMs: null, averageRate: null, samples: [] });
  });

  it('cumulative turn usage calibrates Codex without counting hidden reasoning twice', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.delta('a'.repeat(40), 1_000);
    speed.pause(2_000);
    speed.delta('b'.repeat(40), 10_000);
    speed.finish(200, 11_000);
    expect(speed.snapshot(20_000)).toMatchObject({ outputTokens: 200, durationMs: 2_000, averageRate: 100 });
    speed.finish(300, 30_000);
    expect(speed.snapshot(30_000).outputTokens).toBe(200);
  });

  it('does not manufacture a current rate from a short burst, silence or a tool gap', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.delta('a'.repeat(4000), 1000);
    expect(speed.snapshot(1250).recentRate).toBeNull();
    speed.delta('a'.repeat(40), 2000);
    const observed = speed.snapshot(2000);
    expect(observed.recentRate).toBe(10);
    const local = readResponseSpeedSnapshot(observed, 100000)!;
    expect(responseSpeedHistory(local, 100999).latestRate).toBe(10);
    expect(responseSpeedHistory(local, 101000).latestRate).toBeNull();
    expect(local.firstResponseMs).toBe(observed.firstResponseMs);
    expect(speed.snapshot(5000).recentRate).toBeNull();
    speed.pause(5000);
    speed.delta('resume', 20000);
    expect(speed.snapshot(20000).recentRate).toBeNull();
    speed.finish(1100, 21000);
    expect(speed.snapshot(21000)).toMatchObject({ durationMs: 5000, averageRate: 220 });
  });

  it('reset clears cancelled/retried turns and ignores late deltas after completion', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.delta('a'.repeat(40), 1_000);
    speed.finish(undefined, 2_000);
    speed.delta('late', 3_000);
    speed.reset('turn', 4_000);
    expect(speed.snapshot(4_500)).toMatchObject({ phase: 'waiting', firstResponseMs: null,
      waitingMs: 500, outputTokens: 0, samples: [] });
    speed.content(5_000);
    speed.finish(0, 6_000);
    expect(speed.snapshot(6_000)).toMatchObject({ outputTokens: 0, estimated: false, averageRate: 0 });
  });

  it('expires high-frequency output instead of renewing accumulated units', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.content(0);
    for (let now = 1; now <= 10_000; now++) {
      speed.delta('abcd', now); // 1 estimated token, 1000 deltas per second.
      if (now === 1_000 || now === 5_000 || now === 10_000) {
        expect(speed.snapshot(now).recentRate).toBeGreaterThanOrEqual(996);
        expect(speed.snapshot(now).recentRate).toBeLessThanOrEqual(1000);
      }
    }
    expect(speed.snapshot(10_000).samples.every(sample => sample.rate <= 1000)).toBe(true);
    expect(responseSpeedHistory(speed.snapshot(10_000), 10_000).peak).toBeLessThanOrEqual(1000);
    expect(speed.snapshot(11_000).recentRate).toBeNull();
    speed.pause(11_000);
    for (let now = 20_000; now <= 21_000; now++) speed.delta('abcd', now);
    expect(speed.snapshot(21_000).recentRate).toBeLessThanOrEqual(1000);
    expect(speed.snapshot(22_000).recentRate).toBeNull();
    speed.finish(11_001, 22_000);
    const done = speed.snapshot(22_000);
    expect(done).toMatchObject({ estimated: false, outputTokens: 11_001,
      durationMs: 13_000, averageRate: 11_001_000 / 13_000 });
    expect(responseSpeedHistory(done, 22_000).peak).toBeLessThanOrEqual(1000);
  });

  it('character estimates are independent of chunk boundaries and samples stay bounded', () => {
    const measure = (chunks: string[]) => {
      const speed = new ResponseSpeedTracker();
      speed.reset('turn', 0);
      for (const chunk of chunks) speed.delta(chunk, 1_000);
      return speed.snapshot(2_000).outputTokens;
    };
    expect(measure(['hello 世界 👋'])).toBe(measure(['h', 'ello ', '世', '界 ', '👋']));
    expect(measure(['👋'.repeat(10)])).toBe(measure('👋'.repeat(10).split('')));
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    for (let i = 1; i < 500; i++) speed.delta('a', i * 250);
    expect(speed.snapshot(125_000).samples.length).toBeLessThanOrEqual(60);
    speed.invalidate();
    expect(speed.snapshot(125_000)).toMatchObject({ averageRate: null, recentRate: null, samples: [] });
  });

  it('freezes an interrupted observation without claiming provider calibration', () => {
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 0);
    speed.delta('a'.repeat(40), 1_000);
    const stopped = stopResponseSpeed(speed.snapshot(2_000));
    expect(stopped).toMatchObject({ phase: 'complete', estimated: true, durationMs: 1_000 });
    expect(calibratedResponseDuration(stopped, 10)).toBeUndefined();
    expect(stopResponseSpeed(stopped)).toBe(stopped);
  });

  it('rejects malformed remote snapshots and supports older hosts omitting the field', () => {
    expect(readResponseSpeedSnapshot(undefined)).toBeUndefined();
    expect(readResponseSpeedSnapshot({ phase: 'generating', outputTokens: Infinity })).toBeUndefined();
    const speed = new ResponseSpeedTracker();
    speed.reset('turn', 1_000);
    expect(readResponseSpeedSnapshot(speed.snapshot(2_000))).toEqual(speed.snapshot(2_000));
  });
});

it('retains incomplete history without showing success or a live rate on failure, cancellation or retry', () => {
  const tracker = new ResponseSpeedTracker();
  tracker.reset('turn', 0);
  tracker.delta('observed output', 1000);
  tracker.delta('more observed output', 2000);
  const original = tracker.snapshot(2000);
  for (const outcome of ['failed', 'cancelled'] as const) {
    const stopped = stopResponseSpeed(original, outcome)!;
    expect(responseSpeedActivity(stopped, 3000)).toBe(outcome);
    expect(responseSpeedHistory(stopped).latestRate).toBeNull();
    expect(stopped.samples).toEqual(original.samples);
    expect(stopped.averageRate).toBe(original.averageRate);
    expect(calibratedResponseDuration(stopped, stopped.outputTokens)).toBeUndefined();
    expect(mergeResponseSpeedStatus(stopped, { ...original, phase: 'complete' }, false, false)?.outcome).toBe(outcome);
    expect(mergeResponseSpeedStatus(stopped, undefined, true, true)).toBeUndefined();
  }
  const retry = retryResponseSpeed(original)!;
  expect(responseSpeedActivity(retry)).toBe('retrying');
  expect(responseSpeedHistory(retry).latestRate).toBeNull();
  expect(mergeResponseSpeedStatus(retry, original, true, false)?.retrying).toBe(true);
  expect(mergeResponseSpeedStatus(retry, { ...original, outputTokens: 1000 }, true, false)?.retrying).toBe(true);
  expect(responseSpeedActivity(mergeResponseSpeedStatus(retry, { ...original, phase: 'complete' }, true, false)!)).toBe('retrying');
  expect(mergeResponseSpeedStatus(retry, { ...original, hasRecentOutput: true,
    samples: [...original.samples, { durationMs: original.durationMs + 1000, outputTokens: 100, rate: 40 }] }, true, false)?.retrying).not.toBe(true);
  expect(mergeResponseSpeedStatus(retry, { ...original, retrying: false }, true, false)?.retrying).toBe(false);
  expect(resumeResponseSpeed(retry)?.retrying).toBe(false);
  const parallelToolRetry = retryResponseSpeed({ ...original, phase: 'paused', toolActive: true })!;
  expect(parallelToolRetry.toolActive).toBe(true);
  expect(mergeResponseSpeedStatus(parallelToolRetry, { ...original, phase: 'paused', toolActive: true }, true, false)?.retrying).toBe(true);
  expect(responseSpeedActivity(resumeResponseSpeed(parallelToolRetry)!)).toBe('tool');
  expect(readResponseSpeedSnapshot({ ...original, outcome: 'unknown' })).toBeUndefined();
  expect(readResponseSpeedSnapshot({ ...original, retrying: 'yes' })).toBeUndefined();
});
