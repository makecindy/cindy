import { describe, expect, it } from 'vitest';

import { mergeWorkLouderCodexTaskSlots, orderWorkLouderCodexPinnedRows } from '../taskSlots.js';

describe('orderWorkLouderCodexPinnedRows', () => {
  it('follows the sidebar manual order and keeps unranked rows afterward', () => {
    expect(
      orderWorkLouderCodexPinnedRows(
        [{ id: 'oldest' }, { id: 'middle' }, { id: 'newest' }],
        ['newest', 'missing', 'middle', 'newest'],
      ),
    ).toEqual([{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }]);
  });
});

describe('mergeWorkLouderCodexTaskSlots', () => {
  it('puts pinned tasks first and fills the remaining six slots by recency', () => {
    expect(
      mergeWorkLouderCodexTaskSlots(
        [{ id: 'pinned-2' }, { id: 'pinned-1' }],
        [
          { id: 'recent-1' },
          { id: 'pinned-1' },
          { id: 'recent-2' },
          { id: 'recent-3' },
          { id: 'recent-4' },
          { id: 'recent-5' },
        ],
      ),
    ).toEqual(['pinned-2', 'pinned-1', 'recent-1', 'recent-2', 'recent-3', 'recent-4']);
  });
});
