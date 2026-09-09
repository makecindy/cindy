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
});
