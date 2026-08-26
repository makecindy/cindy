import { describe, expect, it } from 'vitest';

import { applyOllamaPullEvent, createPullSpeedTracker } from '../pullProgress.js';

describe('applyOllamaPullEvent', () => {
  it('sums layered blob progress into one percent', () => {
    const layers = new Map<string, { completed: number; total: number }>();
    applyOllamaPullEvent('qwen3.8:27b-mlx', layers, {
      status: 'downloading',
      digest: 'sha256:aaa',
      completed: 50,
      total: 100,
    });
    const next = applyOllamaPullEvent('qwen3.8:27b-mlx', layers, {
      status: 'downloading',
      digest: 'sha256:bbb',
      completed: 25,
      total: 100,
    });
    expect(next.completed).toBe(75);
    expect(next.total).toBe(200);
    expect(next.percent).toBe(38);
    expect(next.phase).toBe('downloading');
  });

  it('classifies manifest and verify phases', () => {
    const layers = new Map<string, { completed: number; total: number }>();
    expect(applyOllamaPullEvent('m', layers, { status: 'pulling manifest' }).phase).toBe(
      'manifest',
    );
    expect(applyOllamaPullEvent('m', layers, { status: 'verifying sha256 digest' }).phase).toBe(
      'verifying',
    );
  });

  it('reports download speed over a multi-second window, not the last burst', () => {
    let now = 1_000;
    const speed = createPullSpeedTracker(() => now);
    const layers = new Map<string, { completed: number; total: number }>();
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 0, total: 30_000_000 },
      speed,
    );
    now = 1_200;
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 4_000_000, total: 30_000_000 },
      speed,
    );
    now = 4_000;
    const next = applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 6_000_000, total: 30_000_000 },
      speed,
    );
    expect(next.bytesPerSecond).toBe(2_000_000);
  });

  it('ignores a local-resume byte spike so later network progress still has a speed', () => {
    let now = 1_000;
    const speed = createPullSpeedTracker(() => now);
    const layers = new Map<string, { completed: number; total: number }>();
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 0, total: 30_000_000_000 },
      speed,
    );
    now = 1_050;
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 9_000_000_000, total: 30_000_000_000 },
      speed,
    );
    now = 2_050;
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 9_040_000_000, total: 30_000_000_000 },
      speed,
    );
    now = 4_050;
    const next = applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 9_120_000_000, total: 30_000_000_000 },
      speed,
    );
    expect(next.bytesPerSecond).toBeCloseTo(40_000_000 / 3, 5);
  });

  it('does not treat a newly reported layer as a resume spike', () => {
    let now = 1_000;
    const speed = createPullSpeedTracker(() => now);
    const layers = new Map<string, { completed: number; total: number }>();
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'a', completed: 8_000_000, total: 10_000_000 },
      speed,
    );
    now = 1_200;
    applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'b', completed: 1_000_000, total: 10_000_000 },
      speed,
    );
    now = 2_200;
    const next = applyOllamaPullEvent(
      'm',
      layers,
      { status: 'downloading', digest: 'b', completed: 3_000_000, total: 10_000_000 },
      speed,
    );
    expect(next.bytesPerSecond).toBe(2_500_000);
  });
});
