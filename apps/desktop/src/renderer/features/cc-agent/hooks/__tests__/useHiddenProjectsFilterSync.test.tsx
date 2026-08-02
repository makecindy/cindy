// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECTS_KEY, useSidebarFilter } from '../useSidebarFilter';
import { useHiddenProjects } from '../useHiddenProjects';

type HiddenProjectsListener = (projectKeys: string[]) => void;

const PROJECT_A = 'local:/workspace/a';
const PROJECT_B = 'local:/workspace/b';

let hiddenProjectsListeners: HiddenProjectsListener[] = [];
let initialHiddenProjectKeys: string[] = [];

function useSyncedSidebarFilter() {
  const { hiddenProjectKeys } = useHiddenProjects();
  return useSidebarFilter(hiddenProjectKeys);
}

beforeEach(() => {
  hiddenProjectsListeners = [];
  initialHiddenProjectKeys = [];
  window.localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    sidebarSettings: {
      loadHiddenProjectKeys: () => initialHiddenProjectKeys,
      onHiddenProjectKeysChanged: (listener: HiddenProjectsListener) => {
        hiddenProjectsListeners.push(listener);
        return () => {
          hiddenProjectsListeners = hiddenProjectsListeners.filter((entry) => entry !== listener);
        };
      },
      setProjectHidden: vi.fn(),
    },
    sidebarSettingsLoadPinnedOrderSync: () => [],
    sidebarSettingsOnPinnedOrderChanged: () => () => {},
    sidebarSettingsSavePinnedOrder: vi.fn(),
  };
});

describe('hidden-project filter synchronization', () => {
  it('prunes the hidden project in every mounted renderer without toggling it back', () => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_A, PROJECT_B]));
    const firstWindow = renderHook(() => useSyncedSidebarFilter());
    const secondWindow = renderHook(() => useSyncedSidebarFilter());

    expect(hiddenProjectsListeners).toHaveLength(2);
    act(() => {
      for (const listener of hiddenProjectsListeners) listener([PROJECT_A]);
    });

    expect(firstWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(secondWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? 'null')).toEqual([PROJECT_B]);

    act(() => {
      for (const listener of hiddenProjectsListeners) listener([PROJECT_A]);
    });
    expect(firstWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(secondWindow.result.current.projects).toEqual([PROJECT_B]);

    act(() => {
      for (const listener of hiddenProjectsListeners) listener([]);
    });
    act(() => {
      firstWindow.result.current.ensureProjectIncluded(PROJECT_A);
    });

    expect(firstWindow.result.current.projects).toEqual([PROJECT_B, PROJECT_A]);
    expect(secondWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? 'null')).toEqual([
      PROJECT_B,
      PROJECT_A,
    ]);
  });

  it("falls back to 'all' when the only selected project becomes hidden", () => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_A]));
    const view = renderHook(() => useSyncedSidebarFilter());

    act(() => {
      hiddenProjectsListeners[0]?.([PROJECT_A]);
    });

    expect(view.result.current.projects).toBe('all');
    expect(JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? 'null')).toBe('all');
  });
  it('reconciles the synchronous hidden snapshot on a newly mounted window', () => {
    initialHiddenProjectKeys = [PROJECT_A];
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_A]));

    const view = renderHook(() => useSyncedSidebarFilter());

    expect(view.result.current.projects).toBe('all');
    expect(JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? 'null')).toBe('all');
  });
});
