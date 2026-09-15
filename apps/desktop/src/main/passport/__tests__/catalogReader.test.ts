import { describe, expect, it, vi } from 'vitest';

import { createPassportTaskCatalogReader } from '../catalogReader.js';
import type { WorkLouderCodexTaskCatalog, WorkLouderCodexTaskCatalogInput } from '../../worklouder-codex/taskSlots.js';

function catalog(id: string): WorkLouderCodexTaskCatalog {
  const task = { id, title: id, pinned: false };
  return { sidebar: [task], lastSent: [task], options: [task] };
}

function reader(
  overrides: Partial<{
    scope: string | null;
    published: readonly WorkLouderCodexTaskCatalogInput[] | null;
    local: WorkLouderCodexTaskCatalog;
  }> = {},
) {
  let scope: string | null = overrides.scope ?? 'owner-a';
  const published = overrides.published ?? null;
  const readLocal = vi.fn(async () => overrides.local ?? catalog('local'));
  const build = vi.fn((rows: readonly WorkLouderCodexTaskCatalogInput[]) => catalog(rows[0]?.id ?? 'empty'));
  const value = createPassportTaskCatalogReader({
    getScope: () => scope,
    readPublished: () => published,
    readLocal,
    build,
  });
  return {
    value,
    readLocal,
    build,
    setScope: (next: string | null) => {
      scope = next;
    },
  };
}

describe('Passport task catalog reader', () => {
  it('prefers the renderer projection, including an intentionally empty one', async () => {
    const remote = {
      id: 'remote',
      title: 'Remote',
      pinnedAt: null,
      userSendAt: null,
      sidebarOrder: 0,
    };
    const first = reader({ published: [remote] });
    expect((await first.value.readFresh()).options[0].id).toBe('remote');
    expect(first.readLocal).not.toHaveBeenCalled();
    expect(first.build).toHaveBeenCalledWith([remote]);

    const empty = reader({ published: [] });
    expect(await empty.value.readFresh()).toEqual(catalog('empty'));
    expect(empty.readLocal).not.toHaveBeenCalled();
  });

  it('falls back to the local catalog until the renderer publishes', async () => {
    const state = reader();
    expect((await state.value.readFresh()).options[0].id).toBe('local');
    expect(state.readLocal).toHaveBeenCalledOnce();
  });

  it('keeps the last good snapshot for a transient refresh failure', async () => {
    const state = reader();
    await state.value.readFresh();
    state.readLocal.mockRejectedValueOnce(new Error('database warming up'));

    expect((await state.value.readForRefresh()).options[0].id).toBe('local');
    expect(state.value.hasCurrentSnapshot()).toBe(true);
  });

  it('drops the cache at an owner boundary and fails closed for fresh actions', async () => {
    const state = reader();
    await state.value.readFresh();
    state.setScope('owner-b');
    state.readLocal.mockRejectedValue(new Error('new owner not ready'));

    await expect(state.value.readFresh()).rejects.toThrow('new owner not ready');
    expect(state.value.hasCurrentSnapshot()).toBe(false);
    await expect(state.value.readForRefresh()).rejects.toThrow('new owner not ready');
  });

  it('does not cache a local read that finishes after the owner changes', async () => {
    let scope: string | null = 'owner-a';
    let finish!: (value: WorkLouderCodexTaskCatalog) => void;
    const value = createPassportTaskCatalogReader({
      getScope: () => scope,
      readPublished: () => null,
      readLocal: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      build: () => catalog('published'),
    });
    const pending = value.readFresh();
    scope = 'owner-b';
    finish(catalog('owner-a'));

    await expect(pending).rejects.toThrow('scope changed');
    expect(value.hasCurrentSnapshot()).toBe(false);
  });

  it('does not let a read started before stop repopulate the cache', async () => {
    let finish!: (value: WorkLouderCodexTaskCatalog) => void;
    const value = createPassportTaskCatalogReader({
      getScope: () => 'owner-a',
      readPublished: () => null,
      readLocal: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      build: () => catalog('published'),
    });
    const pending = value.readFresh();
    value.clear();
    finish(catalog('stale'));

    await expect(pending).rejects.toThrow('scope changed');
    expect(value.hasCurrentSnapshot()).toBe(false);
  });
});
