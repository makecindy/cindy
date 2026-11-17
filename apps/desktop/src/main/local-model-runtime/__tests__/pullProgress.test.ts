import { describe, expect, it } from 'vitest';

import {
  applyOllamaPullEvent,
  createPullDownloadTracker,
  createPullSpeedTracker,
} from '../pullProgress.js';
import type { LocalModelPullProgress } from '../../../shared/localModelRuntime.js';

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

// 测试价值
// - 生产入口与可观察结果：createPullDownloadTracker 给每个拉取快照附上 DownloadMeter 显示的
//   download（阶段、字节、百分比、剩余时间）；设置页 Ollama 模型拉取进度条据此显示。
// - Bug／规则依据：verified-downloads.md「下载进度与界面」——进度不倒退，暂停／完成有明确阶段。
// - 现有覆盖缺口：旧快照只有原始百分比，新层出现时总量变大会让进度条倒退。
// - 最小失败输入：第二层出现使总量翻倍；随后暂停；最后完成。
// - tier：unit（纯函数，注入时钟）。
describe('createPullDownloadTracker', () => {
  const snap = (patch: Partial<LocalModelPullProgress>): LocalModelPullProgress => ({
    name: 'qwen3.8:27b',
    status: 'downloading',
    phase: 'downloading',
    done: false,
    ...patch,
  });

  // PR #10938 review: once the first layer finished the meter read 100% and, because it never
  // moved back, stayed there while the next layers downloaded.
  it('never claims 100% before the pull succeeds, even when a later layer appears', () => {
    const track = createPullDownloadTracker(() => 0);
    expect(track(snap({ phase: 'manifest' })).download).toMatchObject({ phase: 'preparing' });
    const first = track(snap({ completed: 80, total: 100, percent: 80, bytesPerSecond: 10 }));
    expect(first.download).toMatchObject({ phase: 'downloading', percent: 80, etaSeconds: 2 });
    const layerDone = track(snap({ completed: 100, total: 100, percent: 100, bytesPerSecond: 10 }));
    expect(layerDone.download?.percent).toBeLessThan(100);
    // More work discovered: the bar follows the real share instead of sticking near 100%.
    const grown = track(snap({ completed: 120, total: 400, percent: 30, bytesPerSecond: 10 }));
    expect(grown.download).toMatchObject({ loaded: 120, total: 400, percent: 30, etaSeconds: 28 });
    expect(grown.percent).toBe(30); // the raw snapshot is unchanged for existing consumers
    expect(track(snap({ phase: 'success', done: true })).download?.percent).toBe(100);
  });

  it.each([
    ['paused', 'paused'],
    ['cancelled', 'cancelled'],
    ['error', 'failed'],
  ] as const)('marks a %s pull without dropping its bytes', (phase, shown) => {
    const track = createPullDownloadTracker(() => 0);
    track(snap({ completed: 50, total: 100, percent: 50, bytesPerSecond: 10 }));
    expect(track(snap({ phase, done: true })).download).toMatchObject({
      phase: shown,
      loaded: 50,
      speedBps: 0,
      etaSeconds: null,
    });
  });

  it('fills the bar when the pull succeeds', () => {
    const track = createPullDownloadTracker(() => 0);
    track(snap({ completed: 50, total: 100, percent: 50 }));
    expect(track(snap({ phase: 'success', percent: 100, done: true })).download).toMatchObject({
      phase: 'completed',
      loaded: 100,
      percent: 100,
    });
  });
});
