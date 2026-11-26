// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：标准 DownloadMeter 组件；用户看到的百分比、状态行（字节／重试原因／
 *   校验／安装／失败）、速度与剩余时间，以及读屏的 aria-valuetext。
 * - Bug／规则依据：2026-11-17 GitHub CLI 停在 93% 而无任何说明；verified-downloads.md
 *   「下载进度与界面」要求非传输状态都有文字说明。迁入原 settings/DownloadMeter 的格式化用例。
 * - 现有覆盖缺口：旧组件只有百分比、字节和速度，没有重试、校验、安装与剩余时间。
 * - 最小失败输入：phase=retrying + retryReason=slow；phase=verifying；带 speed 的 downloading。
 * - tier：unit（jsdom，mock 翻译函数，断言 key 与插值）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialDownloadProgress,
  type DownloadProgress,
} from '../../../../shared/downloadProgress';
import {
  DownloadMeter,
  DownloadRing,
  downloadPercentLabel,
  formatDownloadBytes,
  formatDownloadEta,
  formatDownloadSpeed,
} from '../download-meter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join('|')})` : key,
    i18n: { language: 'en' },
  }),
}));
afterEach(cleanup);

const MB = 1024 * 1024;
function meter(progress: Partial<DownloadProgress>, error?: string) {
  render(
    <DownloadMeter
      label="GitHub CLI"
      progress={{ ...initialDownloadProgress('downloading', 20 * MB), ...progress }}
      error={error}
    />,
  );
  return screen.getByRole('progressbar');
}

describe('DownloadMeter', () => {
  it('shows bytes, speed and time left while transferring', () => {
    const bar = meter({ loaded: 13 * MB, percent: 65, speedBps: MB, etaSeconds: 7 });
    expect(screen.getByText('65%')).toBeTruthy();
    expect(screen.getByText('downloadProgress.bytes(13 MB|20 MB)')).toBeTruthy();
    expect(screen.getByText('1.0 MB/s · downloadProgress.eta(7s)')).toBeTruthy();
    expect(bar.getAttribute('aria-valuenow')).toBe('65');
  });

  it.each([
    [{ phase: 'retrying', retryReason: 'slow', attempt: 2 }, 'downloadProgress.retry.slow'],
    [{ phase: 'retrying', attempt: 3 }, 'downloadProgress.retry.network'],
    [{ phase: 'verifying' }, 'downloadProgress.phase.verifying'],
    [{ phase: 'installing' }, 'downloadProgress.phase.installing'],
    [{ phase: 'paused' }, 'downloadProgress.phase.paused'],
  ] as const)('explains a bar that is not moving: %o', (progress, status) => {
    const bar = meter({ loaded: 18 * MB, percent: 90, speedBps: MB, ...progress });
    expect(screen.getByText(status)).toBeTruthy();
    // Speed belongs to an active transfer only; a stale value would read as progress.
    expect(screen.queryByText(/MB\/s/)).toBeNull();
    if ('attempt' in progress)
      expect(screen.getByText(`downloadProgress.attempt(${progress.attempt})`)).toBeTruthy();
    expect(bar.getAttribute('aria-valuetext')).toContain(status);
  });

  it('replaces the status with the failure and hides a misleading percent', () => {
    meter({ phase: 'failed', loaded: 5 * MB, percent: 25 }, 'Could not reach GitHub');
    expect(screen.getByText('Could not reach GitHub')).toBeTruthy();
    expect(screen.queryByText('25%')).toBeNull();
  });
});

describe('download formatters', () => {
  it('formats sizes, speed and whole percentages', () => {
    expect(formatDownloadBytes(0)).toBe('');
    expect(formatDownloadBytes(512)).toBe('0.5 KB');
    expect(formatDownloadBytes(12.4 * MB)).toBe('12 MB');
    expect(formatDownloadBytes(1.5 * 1024 * MB)).toBe('1.5 GB');
    expect(formatDownloadSpeed(2.5 * MB)).toBe('2.5 MB/s');
    expect(
      [43.4, 99.99, 100, 120, -5, Number.NaN, null].map((value) => downloadPercentLabel(value)),
    ).toEqual([43, 99, 100, 100, 0, null, null]);
  });

  it('rounds time left to what a person can use', () => {
    expect([14, 200, 1500, 3900].map((s) => formatDownloadEta(s, 'en'))).toEqual([
      '14s',
      '3m 20s',
      '25m',
      '1h 5m',
    ]);
  });
});

/**
 * 测试价值（DownloadRing）
 * - 生产入口与可观察结果：标准进度的圆环形态；用户只看到圆环和一句步骤，读屏仍能读到
 *   百分比、字节与速度。
 * - Bug／规则依据：DESIGN.md §4「Download progress」圆环形态——不画数字，但进度停住时必须有
 *   文字说明；verified-downloads.md 要求读屏文本取自同一份 DownloadProgress。
 * - 现有覆盖缺口：上面的用例只覆盖三行长条。
 * - 最小失败输入：带字节与速度的 downloading；retrying；调用方自带文字的 completed / failed。
 * - tier：unit（jsdom，沿用本文件的翻译 mock）。
 */
describe('DownloadRing', () => {
  function ring(progress: Partial<DownloadProgress>, props: { status?: string; explainRetry?: boolean } = {}) {
    render(
      <DownloadRing
        label="Update Helper"
        progress={{ ...initialDownloadProgress('downloading', 20 * MB), ...progress }}
        {...props}
      />,
    );
    return screen.getByRole('progressbar', { name: 'Update Helper' });
  }

  it('draws the step without figures and keeps the figures for screen readers', () => {
    const el = ring({ loaded: 13 * MB, percent: 65, speedBps: MB, etaSeconds: 7 });
    expect(el.textContent).toBe('downloadProgress.phase.downloading');
    expect(el.getAttribute('aria-valuenow')).toBe('65');
    expect(el.getAttribute('aria-valuetext')).toBe(
      'downloadProgress.phase.downloading · downloadProgress.bytes(13 MB|20 MB) · 1.0 MB/s · downloadProgress.eta(7s)',
    );
  });

  it.each([
    [{ phase: 'retrying', retryReason: 'slow', attempt: 2, percent: 40 }, {}, 'downloadProgress.phase.retrying', '40'],
    [{ phase: 'retrying', retryReason: 'slow', attempt: 2, percent: 40 }, { explainRetry: true }, 'downloadProgress.retry.slow', '40'],
    // Every byte has arrived: the ring is full while the words name what is still running.
    [{ phase: 'installing', percent: 99.9 }, {}, 'downloadProgress.phase.installing', '100'],
    [{ phase: 'completed', percent: 100 }, { status: 'Updated' }, 'Updated', '100'],
    [{ phase: 'failed', percent: 61 }, { status: 'Update failed' }, 'Update failed', '61'],
  ] as Array<[Partial<DownloadProgress>, { status?: string; explainRetry?: boolean }, string, string]>)(
    'explains %j',
    (progress, props, words, percent) => {
      const el = ring(progress, props);
      expect(el.textContent).toBe(words);
      expect(el.getAttribute('aria-valuenow')).toBe(percent);
    },
  );
});
