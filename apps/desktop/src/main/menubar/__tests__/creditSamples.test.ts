import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendCreditSample,
  CreditSampleStore,
  estimateDailyBurn,
  largestCreditSample,
} from '../creditSamples';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

describe('credit samples', () => {
  it('estimates burn from drops only and ignores top-ups', () => {
    const samples = [
      { atMs: T0, available: 100 },
      { atMs: T0 + DAY, available: 90 },
      { atMs: T0 + 2 * DAY, available: 200 }, // top-up
      { atMs: T0 + 3 * DAY, available: 180 },
    ];
    expect(estimateDailyBurn(samples, T0 + 3 * DAY)).toBeCloseTo(10);
  });

  it('needs a day of history before estimating', () => {
    expect(estimateDailyBurn([{ atMs: T0, available: 10 }, { atMs: T0 + DAY / 2, available: 5 }], T0 + DAY / 2)).toBeNull();
  });

  it('collapses samples taken minutes apart but keeps the span', () => {
    let samples = appendCreditSample([], { atMs: T0, available: 10 }, T0);
    samples = appendCreditSample(samples, { atMs: T0 + 60_000, available: 9 }, T0 + 60_000);
    samples = appendCreditSample(samples, { atMs: T0 + 120_000, available: 8 }, T0 + 120_000);
    expect(samples).toEqual([{ atMs: T0, available: 10 }, { atMs: T0 + 120_000, available: 8 }]);
  });

  it('still keeps one sample per 10 minutes when read every minute', () => {
    let samples: ReturnType<typeof appendCreditSample> = [];
    for (let minute = 0; minute <= 60; minute += 1) {
      const atMs = T0 + minute * 60_000;
      samples = appendCreditSample(samples, { atMs, available: 100 - minute }, atMs);
    }
    expect(samples.length).toBeGreaterThanOrEqual(6);
    // No gap longer than the sampling period, so a dip between reads is never far from a kept sample.
    for (let i = 1; i < samples.length; i += 1) expect(samples[i].atMs - samples[i - 1].atMs).toBeLessThanOrEqual(600_000);
    expect(samples[samples.length - 1]).toEqual({ atMs: T0 + 3_600_000, available: 40 });
  });

  it('drops samples past the retention window', () => {
    const now = T0 + 40 * DAY;
    const samples = appendCreditSample([{ atMs: T0, available: 10 }], { atMs: now, available: 5 }, now);
    expect(samples).toEqual([{ atMs: now, available: 5 }]);
    expect(largestCreditSample(samples)).toBe(5);
  });
});

describe('CreditSampleStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists per key and starts over for another account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-credits-'));
    dirs.push(dir);
    const file = path.join(dir, 'samples.json');
    const store = new CreditSampleStore(() => file);
    store.record('user-a:USD', 10, T0);
    expect(new CreditSampleStore(() => file).record('user-a:USD', 8, T0 + DAY)).toHaveLength(2);
    expect(new CreditSampleStore(() => file).record('user-b:USD', 50, T0 + DAY)).toEqual([{ atMs: T0 + DAY, available: 50 }]);
  });

  it('follows the file of the signed-in account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-credits-'));
    dirs.push(dir);
    let file = path.join(dir, 'owner-a.json');
    const store = new CreditSampleStore(() => file);
    store.record('USD', 10, T0);
    file = path.join(dir, 'owner-b.json');
    expect(store.record('USD', 50, T0 + DAY)).toEqual([{ atMs: T0 + DAY, available: 50 }]);
    file = path.join(dir, 'owner-a.json');
    expect(store.record('USD', 8, T0 + DAY)).toHaveLength(2);
  });
});
