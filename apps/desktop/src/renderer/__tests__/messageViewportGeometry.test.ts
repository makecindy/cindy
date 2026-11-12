import { describe, expect, it } from 'vitest';
import { findViewportRange } from '../components/chat/messageViewportGeometry';

describe('indexed message geometry', () => {
  it('matches intersecting rows including exact boundaries, gaps and zero-height rows', () => {
    const tops: number[] = [], bottoms: number[] = [];
    let cursor = 19;
    for (let i = 0; i < 500; i++) {
      cursor += i % 7;
      tops.push(cursor); cursor += (i * 37) % 401; bottoms.push(cursor);
    }
    for (const top of [-1000, ...tops, ...bottoms, cursor + 1]) {
      for (const height of [0, 1, 600, 1600]) {
        const { start, end } = findViewportRange(tops, bottoms, top, top + height);
        expect(tops.slice(start, end).map((_, i) => start + i)).toEqual(
          tops.flatMap((value, i) => bottoms[i] >= top && value <= top + height ? [i] : []),
        );
      }
    }
  });
  it('handles empty history', () => {
    expect(findViewportRange([], [], 0, 800)).toEqual({ start: 0, end: 0 });
  });
});
