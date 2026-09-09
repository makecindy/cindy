import { describe, expect, it } from 'vitest';

import { downloadPercent, formatDownloadBytes, formatDownloadSpeed } from '../DownloadMeter';

describe('DownloadMeter formatters', () => {
  it('formats byte sizes for a progress line', () => {
    expect(formatDownloadBytes(0)).toBe('');
    expect(formatDownloadBytes(512)).toBe('0.5 KB');
    expect(formatDownloadBytes(20 * 1024)).toBe('20 KB');
    expect(formatDownloadBytes(12.4 * 1024 * 1024)).toBe('12 MB');
    expect(formatDownloadBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('formats speed from bytes per second', () => {
    expect(formatDownloadSpeed(0)).toBe('');
    expect(formatDownloadSpeed(2.5 * 1024 * 1024)).toBe('2.5 MB/s');
  });

  it('prefers an explicit percent, then completed/total', () => {
    expect(downloadPercent({ percent: 41 })).toBe(41);
    expect(downloadPercent({ completed: 25, total: 100 })).toBe(25);
    expect(downloadPercent({})).toBeNull();
  });
});
