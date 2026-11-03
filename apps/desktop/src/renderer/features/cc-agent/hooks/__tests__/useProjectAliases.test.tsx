// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectAlias } from '../../../../../shared/projectAliases';
import { useProjectAliases } from '../useProjectAliases';
import { useProjectPickerOptions, getProjectPickerDisplayName } from '@/hooks/useProjectPickerOptions';
import { extractDisplayName } from '../../lib/projectGrouping';

const recent = vi.hoisted(() => ({ entries: [] as Array<{ path: string; exists: boolean }> }));
vi.mock('@/hooks/useRecentWorkdirs', () => ({ useRecentWorkdirs: () => recent }));

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
  service.subscribe.mockReset().mockImplementation(() => () => {});
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


describe('project picker aliases (#7831)', () => {
  it('loads persisted Windows aliases with sidebar identity rules without changing paths', async () => {
    recent.entries = [{ path: 'd:\\ÉCOLE\\project-a\\', exists: false }, { path: '\\\\SERVER\\Share\\App', exists: true }];
    service.list.mockResolvedValue([...LEGACY_ROWS, {
      projectKey: 'local://server/share/app', alias: '  Shared app  ', updatedAt: '2026-08-13T01:00:00.000Z',
    }]);
    const view = renderHook(() => useProjectPickerOptions());
    await waitFor(() => expect(view.result.current.map(p => p.name)).toEqual(['Newest alias', 'Shared app']));
    expect(view.result.current.map(p => ({ path: p.path, missing: p.missing, description: p.description }))).toEqual([
      { path: 'd:\\ÉCOLE\\project-a\\', missing: true, description: 'd:/ÉCOLE/project-a/' },
      { path: '\\\\SERVER\\Share\\App', missing: false, description: '//SERVER/Share/App' },
    ]);
    expect(getProjectPickerDisplayName(recent.entries[0].path, view.result.current)).toBe('Newest alias');
    view.unmount();
  });

  it('updates an already-open picker on rename and clear, and loads the saved name on remount', async () => {
    recent.entries = [{ path: '/work/app', exists: true }];
    service.list.mockResolvedValue([]);
    let notify = () => {};
    service.subscribe.mockImplementation(listener => { notify = listener; return () => {}; });
    const view = renderHook(() => useProjectPickerOptions());
    await act(async () => {});
    expect(view.result.current[0].name).toBe('app');
    const saved = [{ projectKey: 'local:/work/app', alias: 'Renamed project', updatedAt: '2026-08-13T01:00:00.000Z' }];
    service.list.mockResolvedValue(saved);
    await act(async () => notify());
    expect(view.result.current[0]).toMatchObject({ name: 'Renamed project', path: '/work/app' });
    view.unmount();
    const reopened = renderHook(() => useProjectPickerOptions());
    await waitFor(() => expect(reopened.result.current[0].name).toBe('Renamed project'));
    service.list.mockResolvedValue([]);
    await act(async () => notify());
    expect(reopened.result.current[0]).toMatchObject({ name: 'app', path: '/work/app' });
    reopened.unmount();
  });

  it('keeps unaliased names disambiguated and does not borrow a remote project alias', async () => {
    recent.entries = [{ path: '/one/app', exists: true }, { path: '/two/app', exists: true }];
    service.list.mockResolvedValue([
      { projectKey: 'remote:host:/one/app', alias: 'Remote only', updatedAt: '' },
      { projectKey: 'local:/two/app', alias: '   ', updatedAt: '' },
    ]);
    const view = renderHook(() => useProjectPickerOptions());
    await act(async () => {});
    const paths = recent.entries.map(p => p.path);
    expect(view.result.current.map(p => p.name)).toEqual(paths.map(p => extractDisplayName(p, paths).name));
    view.unmount();
  });

  it('keeps local POSIX paths case-sensitive', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'linux' };
    recent.entries = [{ path: '/work/App', exists: true }, { path: '/work/app', exists: true }];
    service.list.mockResolvedValue([{ projectKey: 'local:/work/App', alias: 'Uppercase project', updatedAt: '' }]);
    const view = renderHook(() => useProjectPickerOptions());
    await waitFor(() => expect(view.result.current.map(p => p.name)).toEqual(['Uppercase project', 'app']));
    view.unmount();
  });
});
