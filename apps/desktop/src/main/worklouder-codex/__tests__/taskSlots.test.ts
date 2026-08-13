import { describe, expect, it } from 'vitest';

import {
  buildWorkLouderCodexTaskCatalog,
  selectWorkLouderCodexRecentTaskSlots,
} from '../taskSlots.js';

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

describe('buildWorkLouderCodexTaskCatalog', () => {
  it('projects whatever list it is handed, wherever the tasks live', () => {
    // Rows can come from the renderer, which is the only side that sees tasks
    // on a linked machine. The catalogue does not care which is which.
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'local-1', title: 'Local', pinnedAt: null },
      { id: 'remote-1', title: 'On another machine', pinnedAt: null },
    ]);

    expect(catalog.recent.map((task) => task.id)).toEqual(['local-1', 'remote-1']);
    expect(catalog.options).toHaveLength(2);
  });

  it('caps the keys at six while keeping the full option list', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      pinnedAt: null,
    }));

    const catalog = buildWorkLouderCodexTaskCatalog(rows);

    expect(catalog.recent).toHaveLength(6);
    expect(catalog.options).toHaveLength(9);
  });

  it('marks pinned tasks and orders them most recently pinned first', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'plain', title: 'Not pinned', pinnedAt: null },
      { id: 'older', title: 'Pinned earlier', pinnedAt: 1_000 },
      { id: 'newer', title: 'Pinned later', pinnedAt: 2_000 },
    ]);

    expect(catalog.pinned.map((task) => task.id)).toEqual(['newer', 'older']);
    expect(catalog.recent.find((task) => task.id === 'plain')?.pinned).toBe(false);
  });

  it('keeps an untitled task addressable instead of dropping it', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([{ id: 'blank', title: null, pinnedAt: null }]);

    expect(catalog.recent).toEqual([{ id: 'blank', title: '', pinned: false }]);
  });
});
