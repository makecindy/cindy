// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectAlias } from '../../../../../shared/projectAliases';
import { useProjectAliases } from '../useProjectAliases';

const service = vi.hoisted(() => ({
  list: vi.fn<() => Promise<ProjectAlias[]>>(),
  set: vi.fn<(projectKey: string, alias: string) => Promise<ProjectAlias | null>>(),
  subscribe: vi.fn<(_listener: () => void) => () => void>(() => () => {}),
}));

vi.mock('@/lib/projectAliasService', () => ({
  listProjectAliases: () => service.list(),
  setProjectAlias: (projectKey: string, alias: string) => service.set(projectKey, alias),
  onProjectAliasesChanged: (listener: () => void) => service.subscribe(listener),
}));

const LEGACY_ROWS: ProjectAlias[] = [
  {
    projectKey: 'local:D:/École/Project-A',
    alias: 'Newest alias',
    updatedAt: '2026-08-13T01:00:00.000Z',
  },
  {
    projectKey: 'local:d:/école/project-a',
    alias: 'Older alias',
    updatedAt: '2026-08-12T01:00:00.000Z',
  },
];

beforeEach(() => {
  service.list.mockReset().mockResolvedValue(LEGACY_ROWS);
  service.set.mockReset().mockResolvedValue(null);
  service.subscribe.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'win32' };
});

describe('useProjectAliases Windows comparison identity', () => {
  it('optimistically clears every legacy casing variant', async () => {
    const view = renderHook(() => useProjectAliases());
    await waitFor(() => expect(view.result.current.aliases.size).toBe(2));

    await act(async () => {
      await view.result.current.updateAlias('local:D:/ÉCOLE/PROJECT-A', '');
    });

    expect(view.result.current.aliases.size).toBe(0);
  });

  it('optimistically replaces every legacy casing variant with one representative', async () => {
    const view = renderHook(() => useProjectAliases());
    await waitFor(() => expect(view.result.current.aliases.size).toBe(2));
    service.set.mockResolvedValue({
      projectKey: 'local:D:/ÉCOLE/PROJECT-A',
      alias: 'Replacement',
      updatedAt: '2026-08-13T02:00:00.000Z',
    });

    await act(async () => {
      await view.result.current.updateAlias('local:D:/ÉCOLE/PROJECT-A', 'Replacement');
    });

    expect(Array.from(view.result.current.aliases.entries())).toEqual([
      ['local:D:/ÉCOLE/PROJECT-A', 'Replacement'],
    ]);
  });
});
