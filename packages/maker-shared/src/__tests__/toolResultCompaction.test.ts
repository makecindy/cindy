import { describe, expect, it } from 'vitest';

import {
  formatToolResultCompactionBytes,
  parseToolResultCompactionMarker,
} from '../toolResultCompaction.js';

describe('tool result compaction marker', () => {
  const marker = {
    type: 'tool_result_compacted',
    version: 1,
    originalBytes: 128 * 1024,
    compactedAt: 500,
  } as const;

  it('parses persisted strings and mapped message objects', () => {
    expect(parseToolResultCompactionMarker(JSON.stringify(marker))).toEqual(marker);
    expect(parseToolResultCompactionMarker(marker)).toEqual(marker);
  });

  it('rejects malformed or unsupported values', () => {
    expect(parseToolResultCompactionMarker('{')).toBeNull();
    expect(parseToolResultCompactionMarker({ ...marker, version: 2 })).toBeNull();
    expect(parseToolResultCompactionMarker({ ...marker, originalBytes: -1 })).toBeNull();
    expect(parseToolResultCompactionMarker('ordinary tool output')).toBeNull();
  });

  it('formats the retained original byte count consistently across clients', () => {
    expect(formatToolResultCompactionBytes(128 * 1024)).toBe('128 KB');
    expect(formatToolResultCompactionBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });

  it('字节数取整后跨过档位时升档,不留 "1024 KB" / "1024.0 MB"', () => {
    expect(formatToolResultCompactionBytes(1023.6)).toBe('1.0 KB');
    expect(formatToolResultCompactionBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatToolResultCompactionBytes(1023)).toBe('1023 B');
    expect(formatToolResultCompactionBytes(1024 * 1023)).toBe('1023 KB');
    // 各档原有精度不变:MB/GB 始终一位小数,只有取整后真的达到 1024 才升档。
    expect(formatToolResultCompactionBytes(12.4 * 1024 * 1024)).toBe('12.4 MB');
    expect(formatToolResultCompactionBytes(10.5 * 1024 * 1024)).toBe('10.5 MB');
    expect(formatToolResultCompactionBytes(50.49 * 1024 * 1024)).toBe('50.5 MB');
    expect(formatToolResultCompactionBytes(1024 * 1024 * 1023.6)).toBe('1023.6 MB');
  });
});

