/**
 * 测试价值
 * - 生产入口与可观察结果：createDownloadProgressReporter 把下载器原始回调转成各下载界面显示的
 *   DownloadProgress（阶段、字节、百分比、速度、剩余时间、重试原因）。
 * - Bug／规则依据：2026-11-17 GitHub CLI 安装停在 93% 而界面无任何提示；
 *   verified-downloads.md「下载进度与界面」：进度不倒退、重试需说明原因、取消后不复活。
 * - 现有覆盖缺口：新模块；此前只有更新包的 ProgressNormalizer 做了防倒退，其余界面各自处理。
 * - 最小失败输入：服务器忽略 Range 后从 0 重下；龟速超时后的重试；取消后迟到的进度回调。
 * - tier：unit，纯内存，注入时钟。
 */
import { describe, expect, it } from 'vitest';
import type { DownloadProgress } from '../../../shared/downloadProgress';
import { createDownloadProgressReporter, DownloadError } from '../index';

function harness(throttleMs = 200) {
  let clock = 1000;
  const seen: DownloadProgress[] = [];
  const reporter = createDownloadProgressReporter({
    emit: (progress) => seen.push(progress),
    throttleMs,
    now: () => clock,
  });
  const progress = (loaded: number, total: number | null = 1000, speedBps = 100) =>
    reporter.callbacks.onProgress({
      loaded,
      total,
      percent: total ? (loaded / total) * 100 : null,
      speedBps,
    });
  return {
    reporter,
    seen,
    progress,
    tick: (ms: number) => (clock += ms),
    last: () => seen[seen.length - 1],
  };
}

describe('download progress reporter', () => {
  it('never moves bytes or percent backwards when an attempt restarts from zero', () => {
    const h = harness(0);
    h.progress(600);
    h.progress(50); // the server ignored Range on the next attempt
    // The bar holds, but time left (PR #10938 review) follows the 950 bytes still to fetch.
    expect(h.last()).toMatchObject({
      phase: 'downloading',
      loaded: 600,
      percent: 60,
      etaSeconds: 10,
    });
    h.progress(900);
    expect(h.last()).toMatchObject({ loaded: 900, percent: 90, etaSeconds: 1 });
  });

  it.each([
    [new DownloadError('TIMEOUT', 'slow', undefined, undefined, 'slow'), 'slow'],
    [new DownloadError('TIMEOUT', 'idle', undefined, undefined, 'idle'), 'timeout'],
    [new DownloadError('HTTP_5XX', 'busy', undefined, 503), 'server'],
    [new DownloadError('NETWORK', 'reset'), 'network'],
  ] as const)('explains a retry caused by %s as %s, then resumes downloading', (cause, reason) => {
    const h = harness();
    h.progress(400);
    h.reporter.callbacks.onRetry({ attempt: 2, delayMs: 1000, cause });
    expect(h.last()).toMatchObject({
      phase: 'retrying',
      attempt: 2,
      retryReason: reason,
      loaded: 400,
      speedBps: 0,
      etaSeconds: null,
    });
    h.progress(450); // first event of the next attempt is shown at once
    expect(h.last()).toMatchObject({ phase: 'downloading', attempt: 2, loaded: 450 });
    expect(h.last().retryReason).toBeUndefined();
  });

  it('throttles byte updates but sends phase changes and the final byte immediately', () => {
    const h = harness(200);
    h.progress(100);
    h.progress(200);
    h.tick(50);
    h.progress(300);
    expect(h.seen.map((p) => p.loaded)).toEqual([100]);
    h.progress(1000);
    h.reporter.callbacks.onVerifying();
    h.reporter.setPhase('installing');
    h.reporter.setPhase('completed');
    expect(h.seen.map((p) => [p.phase, p.loaded])).toEqual([
      ['downloading', 100],
      ['downloading', 1000],
      ['verifying', 1000],
      ['installing', 1000],
      ['completed', 1000],
    ]);
  });

  it('ignores late downloader callbacks after the user paused or cancelled', () => {
    const h = harness(0);
    h.progress(300);
    h.reporter.setPhase('cancelled');
    h.progress(500);
    h.reporter.callbacks.onRetry({ attempt: 2, delayMs: 1, cause: new Error('late') });
    expect(h.last()).toMatchObject({ phase: 'cancelled', loaded: 300 });
    h.reporter.reset('queued');
    h.progress(10);
    expect(h.last()).toMatchObject({ phase: 'downloading', loaded: 10, percent: 1 });
  });
});
