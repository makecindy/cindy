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

  it('keeps last-sent on the full catalog when only some rows are visible', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'hidden-new', title: 'Hidden but recent', pinnedAt: null, userSendAt: 3_000 },
      {
        id: 'visible-old',
        title: 'Visible older',
        pinnedAt: null,
        userSendAt: 1_000,
        sidebarOrder: 0,
      },
    ]);

    expect(catalog.sidebar.map((task) => task.id)).toEqual(['visible-old']);
    expect(catalog.lastSent.map((task) => task.id)).toEqual(['hidden-new', 'visible-old']);
  });

  it('keeps a published empty sidebar empty instead of falling back to every task', () => {
    const catalog = buildWorkLouderCodexTaskCatalog(
      [
        { id: 'hidden-a', title: 'Hidden A', pinnedAt: null, userSendAt: 2_000 },
        { id: 'hidden-b', title: 'Hidden B', pinnedAt: null, userSendAt: 1_000 },
      ],
      { publishedVisibleOrder: true },
    );

    expect(catalog.sidebar).toEqual([]);
    expect(catalog.lastSent.map((task) => task.id)).toEqual(['hidden-a', 'hidden-b']);
  });

  it('keeps archived visible rows off last-sent while still lighting the sidebar keys', () => {
    const catalog = buildWorkLouderCodexTaskCatalog(
      [
        {
          id: 'archived-visible',
          title: 'Archived',
          pinnedAt: null,
          userSendAt: 9_000,
          sidebarOrder: 0,
          catalogEligible: false,
        },
        { id: 'active-hidden', title: 'Active', pinnedAt: null, userSendAt: 1_000 },
      ],
      { publishedVisibleOrder: true },
    );

    expect(catalog.sidebar.map((task) => task.id)).toEqual(['archived-visible']);
    expect(catalog.lastSent.map((task) => task.id)).toEqual(['active-hidden']);
    expect(catalog.options.map((task) => task.id)).toEqual(['active-hidden']);
  });

  it('still fills last-sent from active rows when only six archived keys are reserved', () => {
    const archived = Array.from({ length: 6 }, (_, index) => ({
      id: `archived-${index}`,
      title: `Archived ${index}`,
      pinnedAt: null,
      userSendAt: 9_000 + index,
      sidebarOrder: index,
      catalogEligible: false as const,
    }));
    const active = Array.from({ length: 4 }, (_, index) => ({
      id: `active-${index}`,
      title: `Active ${index}`,
      pinnedAt: null,
      userSendAt: index,
    }));
    const catalog = buildWorkLouderCodexTaskCatalog([...archived, ...active], {
      publishedVisibleOrder: true,
    });

    expect(catalog.sidebar.map((task) => task.id)).toEqual(archived.map((row) => row.id));
    expect(catalog.lastSent.map((task) => task.id)).toEqual([...active].reverse().map((row) => row.id));
    expect(catalog.options.map((task) => task.id)).toEqual(active.map((row) => row.id));
  });

  it('keeps an untitled task addressable instead of dropping it', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'blank', title: null, pinnedAt: null, userSendAt: null },
    ]);

    expect(catalog.sidebar).toEqual([{ id: 'blank', title: null, pinned: false }]);
  });
});
