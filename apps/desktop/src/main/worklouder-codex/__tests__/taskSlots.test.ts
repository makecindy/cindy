import { describe, expect, it } from 'vitest';

import {
  buildWorkLouderCodexTaskCatalog,
  selectWorkLouderCodexRecentTaskSlots,
} from '../taskSlots.js';

describe('selectWorkLouderCodexRecentTaskSlots', () => {
  it('keeps pure recency order and caps the projection at the board size', () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({ id: `recent-${index}` }));
    expect(selectWorkLouderCodexRecentTaskSlots(rows)).toEqual(
      rows.slice(0, 13).map((row) => row.id),
    );
  });
});

describe('buildWorkLouderCodexTaskCatalog', () => {
  it('keeps pinned-only order independent of activity, with visible pin order first', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'unpin', title: 'Recent', pinnedAt: null, userSendAt: 999 },
      { id: 'hidden-pin', title: 'Hidden', pinnedAt: 300, userSendAt: 0 },
      { id: 'pin-2', title: 'Second', pinnedAt: 200, userSendAt: 200, sidebarOrder: 1 },
      { id: 'pin-1', title: 'First', pinnedAt: 100, userSendAt: 100, sidebarOrder: 0 },
      {
        id: 'archived-pin',
        title: 'Archived',
        pinnedAt: 400,
        userSendAt: 999,
        catalogEligible: false,
      },
    ]);
    expect(catalog.pinned?.map(({ id }) => id)).toEqual(['pin-1', 'pin-2', 'hidden-pin']);
  });

  it('retains old pins beyond the recent-task cap in both mapping and options', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `recent-${i}`,
      title: 'Recent',
      pinnedAt: null,
      userSendAt: 999,
    }));
    const pin = { id: 'old-pin', title: 'Old Pin', pinnedAt: 1, userSendAt: 1 };
    const catalog = buildWorkLouderCodexTaskCatalog([...rows, pin]);
    expect(catalog.pinned).toEqual([{ id: pin.id, title: pin.title, pinned: true }]);
    expect(catalog.options).toContainEqual({ id: pin.id, title: pin.title, pinned: true });
    expect(catalog.options).toHaveLength(100);
    expect(catalog.sidebar[0].id).toBe('recent-0');
  });
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

  it('caps the keys at the board size while keeping the full option list', () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      pinnedAt: null,
      userSendAt: index,
    }));

    const catalog = buildWorkLouderCodexTaskCatalog(rows);

    expect(catalog.sidebar).toHaveLength(13);
    expect(catalog.lastSent).toHaveLength(13);
    expect(catalog.options).toHaveLength(16);
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
    expect(catalog.lastSent.map((task) => task.id)).toEqual(
      [...active].reverse().map((row) => row.id),
    );
    expect(catalog.options.map((task) => task.id)).toEqual(active.map((row) => row.id));
  });

  it('keeps an untitled task addressable instead of dropping it', () => {
    const catalog = buildWorkLouderCodexTaskCatalog([
      { id: 'blank', title: null, pinnedAt: null, userSendAt: null },
    ]);

    expect(catalog.sidebar).toEqual([{ id: 'blank', title: null, pinned: false }]);
  });
});
