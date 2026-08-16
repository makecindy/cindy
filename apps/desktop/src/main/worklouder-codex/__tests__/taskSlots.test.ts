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
      { id: 'local-1', title: 'Local', pinnedAt: null, userSendAt: 2_000 },
      { id: 'remote-1', title: 'On another machine', pinnedAt: null, userSendAt: 1_000 },
    ]);

    expect(catalog.sidebar.map((task) => task.id)).toEqual(['local-1', 'remote-1']);
    expect(catalog.options).toHaveLength(2);
  });

  it('caps the keys at six while keeping the full option list', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      pinnedAt: null,
      userSendAt: index,
    }));

    const catalog = buildWorkLouderCodexTaskCatalog(rows);

    expect(catalog.sidebar).toHaveLength(6);
    expect(catalog.options).toHaveLength(9);
  });

  it('orders last-sent tasks by the last user message, not sidebar order', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'older', title: 'Sent earlier', pinnedAt: 9_000, userSendAt: 1_000 },
      { id: 'never', title: 'Never sent', pinnedAt: null, userSendAt: null },
      { id: 'newer', title: 'Sent later', pinnedAt: null, userSendAt: 2_000 },
    ]);

    expect(catalog.lastSent.map((task) => task.id)).toEqual(['newer', 'older', 'never']);
    expect(catalog.sidebar.map((task) => task.id)).toEqual(['older', 'never', 'newer']);
  });

  it('keeps an untitled task addressable instead of dropping it', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'blank', title: null, pinnedAt: null, userSendAt: null },
    ]);

    expect(catalog.sidebar).toEqual([{ id: 'blank', title: '', pinned: false }]);
  });
});
