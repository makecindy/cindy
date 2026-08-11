import { describe, expect, it } from 'vitest';

import { selectWorkLouderCodexRecentTaskSlots } from '../taskSlots.js';

describe('selectWorkLouderCodexRecentTaskSlots', () => {
  it('keeps pure recency order and caps the projection at six tasks', () => {
    expect(
      selectWorkLouderCodexRecentTaskSlots([
        { id: 'recent-1' },
        { id: 'recent-2' },
        { id: 'recent-3' },
        { id: 'recent-4' },
        { id: 'recent-5' },
        { id: 'recent-6' },
        { id: 'older-pinned-task' },
      ]),
    ).toEqual(['recent-1', 'recent-2', 'recent-3', 'recent-4', 'recent-5', 'recent-6']);
  });
});
