import { describe, expect, it, vi } from 'vitest';

import {
  collectRestorableProjectKeys,
  registerSidebarProjectRestoreHandler,
  requestSidebarProjectRestore,
  restoreHiddenProjectIfPresent,
  restoreSelectedHiddenProject,
  restoreSelectedHiddenProjectWithoutMountedSidebar,
} from '@/features/cc-agent/lib/sidebarProjectRestore';
import type { Session } from '@/lib/ccAgent.types';

const PROJECT_KEY = 'local:/workspace/cindy';

function projectSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: 'user-1',
    title: 'Task',
    workingDir: '/workspace/cindy',
    workspaceKind: 'project',
    model: 'model',
    effort: 'medium',
    permissionMode: 'default',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: '2026-08-02T08:00:00.000Z',
    status: 'active',
    agentKind: 'cc',
    extraDirs: [],
    remoteHostId: null,
    createdAt: '2026-08-02T08:00:00.000Z',
    updatedAt: '2026-08-02T08:00:00.000Z',
    _count: { messages: 1 },
    ...overrides,
  } as Session;
}

describe('collectRestorableProjectKeys', () => {
  it('excludes projects filtered out by vendor', () => {
    const keys = collectRestorableProjectKeys({
      sessions: [projectSession()],
      lastActivityCutoff: null,
      pinnedProjectKeys: new Set(),
      vendorPredicate: (session) => session.agentKind === 'codex',
    });

    expect(keys.has(PROJECT_KEY)).toBe(false);
  });

  it('excludes inactive projects that have no pinned representation', () => {
    const keys = collectRestorableProjectKeys({
      sessions: [
        projectSession({
          userSendAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      lastActivityCutoff: Date.parse('2026-08-01T00:00:00.000Z'),
      pinnedProjectKeys: new Set(),
      vendorPredicate: null,
    });

    expect(keys.has(PROJECT_KEY)).toBe(false);
  });

  it('keeps an inactive project visible through an individually pinned task', () => {
    const keys = collectRestorableProjectKeys({
      sessions: [
        projectSession({
          pinnedAt: '2026-01-01T00:00:00.000Z',
          userSendAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      lastActivityCutoff: Date.parse('2026-08-01T00:00:00.000Z'),
      pinnedProjectKeys: new Set(),
      vendorPredicate: null,
    });

    expect(keys.has(PROJECT_KEY)).toBe(true);
  });

  it('keeps an inactive pinned project visible while excluding dialogue workdirs', () => {
    const keys = collectRestorableProjectKeys({
      sessions: [
        projectSession({
          userSendAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        projectSession({ id: 'dialogue-1', workspaceKind: 'dialogue' }),
      ],
      lastActivityCutoff: Date.parse('2026-08-01T00:00:00.000Z'),
      pinnedProjectKeys: new Set([PROJECT_KEY]),
      vendorPredicate: null,
    });

    expect(Array.from(keys)).toEqual([PROJECT_KEY]);
  });
});

describe('restoreHiddenProjectIfPresent', () => {
  it('continues draft creation when the project was not hidden', async () => {
    const setProjectHidden = vi.fn().mockResolvedValue(false);
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreHiddenProjectIfPresent({
        projectKey: PROJECT_KEY,
        wasHiddenAtPickerOpen: false,
        setProjectHidden,
        getCurrentProjectKeys: () => new Set([PROJECT_KEY]),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(false);

    expect(setProjectHidden).toHaveBeenCalledWith(PROJECT_KEY, false);
    expect(ensureProjectIncluded).not.toHaveBeenCalled();
  });

  it('restores an existing project and includes it in the active filter', async () => {
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreHiddenProjectIfPresent({
        projectKey: PROJECT_KEY,
        wasHiddenAtPickerOpen: true,
        setProjectHidden: vi.fn().mockResolvedValue(true),
        getCurrentProjectKeys: () => new Set([PROJECT_KEY]),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(true);

    expect(ensureProjectIncluded).toHaveBeenCalledOnce();
    expect(ensureProjectIncluded).toHaveBeenCalledWith(PROJECT_KEY);
  });

  it('restores an equivalent Windows project and includes its actual current key', async () => {
    const selectedProjectKey = 'local:c:/workspace/cindy';
    const currentProjectKey = 'local:C:/Workspace/Cindy';
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreHiddenProjectIfPresent({
        projectKey: selectedProjectKey,
        wasHiddenAtPickerOpen: true,
        setProjectHidden: vi.fn().mockResolvedValue(true),
        getCurrentProjectKeys: () => new Set([currentProjectKey]),
        ensureProjectIncluded,
        localPlatform: 'win32',
      }),
    ).resolves.toBe(true);

    expect(ensureProjectIncluded).toHaveBeenCalledOnce();
    expect(ensureProjectIncluded).toHaveBeenCalledWith(currentProjectKey);
  });

  it('does not restore a different-cased POSIX double-slash project', async () => {
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreHiddenProjectIfPresent({
        projectKey: 'local://mnt/Repo',
        wasHiddenAtPickerOpen: true,
        setProjectHidden: vi.fn().mockResolvedValue(true),
        getCurrentProjectKeys: () => new Set(['local://mnt/repo']),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(false);

    expect(ensureProjectIncluded).not.toHaveBeenCalled();
  });

  it('continues draft creation when the hidden project no longer has tasks', async () => {
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreHiddenProjectIfPresent({
        projectKey: PROJECT_KEY,
        wasHiddenAtPickerOpen: true,
        setProjectHidden: vi.fn().mockResolvedValue(true),
        getCurrentProjectKeys: () => new Set(),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(false);

    expect(ensureProjectIncluded).not.toHaveBeenCalled();
  });

  it('restores when another window unhides the project while this picker is open', async () => {
    const currentProjectKey = 'local:C:/Workspace/Cindy';
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreHiddenProjectIfPresent({
        projectKey: 'local:c:/workspace/cindy',
        wasHiddenAtPickerOpen: true,
        setProjectHidden: vi.fn().mockResolvedValue(false),
        getCurrentProjectKeys: () => new Set([currentProjectKey]),
        ensureProjectIncluded,
        localPlatform: 'win32',
      }),
    ).resolves.toBe(true);

    expect(ensureProjectIncluded).toHaveBeenCalledOnce();
    expect(ensureProjectIncluded).toHaveBeenCalledWith(currentProjectKey);
  });

  it('reads the latest project catalogue after awaiting the main-process update', async () => {
    const projectKeys = new Set([PROJECT_KEY]);
    const ensureProjectIncluded = vi.fn();
    let resolveHidden!: (changed: boolean) => void;
    const hiddenUpdate = new Promise<boolean>((resolve) => {
      resolveHidden = resolve;
    });

    const result = restoreHiddenProjectIfPresent({
      projectKey: PROJECT_KEY,
      wasHiddenAtPickerOpen: true,
      setProjectHidden: () => hiddenUpdate,
      getCurrentProjectKeys: () => projectKeys,
      ensureProjectIncluded,
      localPlatform: 'linux',
    });
    projectKeys.delete(PROJECT_KEY);
    resolveHidden(true);

    await expect(result).resolves.toBe(false);
    expect(ensureProjectIncluded).not.toHaveBeenCalled();
  });
});

describe('restoreSelectedHiddenProject', () => {
  it('unhides a selected project and admits it to an explicit Project filter', async () => {
    const setProjectHidden = vi.fn().mockResolvedValue(true);
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreSelectedHiddenProject({
        projectKey: PROJECT_KEY,
        hiddenProjectKeys: new Set([PROJECT_KEY]),
        setProjectHidden,
        getCurrentProjectKeys: () => new Set([PROJECT_KEY]),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(true);

    expect(setProjectHidden).toHaveBeenCalledWith(PROJECT_KEY, false);
    expect(ensureProjectIncluded).toHaveBeenCalledWith(PROJECT_KEY);
  });

  it('skips hidden-state persistence but re-admits an already-visible project', async () => {
    const setProjectHidden = vi.fn().mockResolvedValue(false);
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreSelectedHiddenProject({
        projectKey: PROJECT_KEY,
        hiddenProjectKeys: new Set(),
        setProjectHidden,
        getCurrentProjectKeys: () => new Set([PROJECT_KEY]),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(false);

    expect(setProjectHidden).not.toHaveBeenCalled();
    expect(ensureProjectIncluded).toHaveBeenCalledWith(PROJECT_KEY);
  });

  it('admits a newly selected path without acquiring the hidden-project write lock', async () => {
    const setProjectHidden = vi.fn().mockResolvedValue(false);
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreSelectedHiddenProject({
        projectKey: PROJECT_KEY,
        hiddenProjectKeys: new Set(),
        setProjectHidden,
        getCurrentProjectKeys: () => new Set(),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(false);

    expect(setProjectHidden).not.toHaveBeenCalled();
    expect(ensureProjectIncluded).toHaveBeenCalledWith(PROJECT_KEY);
  });

  it('finishes restoration when another window already cleared the hidden marker', async () => {
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreSelectedHiddenProject({
        projectKey: 'local:c:/workspace/cindy',
        hiddenProjectKeys: new Set(['local:C:/Workspace/Cindy']),
        setProjectHidden: vi.fn().mockResolvedValue(false),
        getCurrentProjectKeys: () => new Set(['local:C:/Workspace/Cindy']),
        ensureProjectIncluded,
        localPlatform: 'win32',
      }),
    ).resolves.toBe(true);

    expect(ensureProjectIncluded).toHaveBeenCalledWith('local:C:/Workspace/Cindy');
  });

  it('uses the selected path when the restored project has no remaining tasks', async () => {
    const ensureProjectIncluded = vi.fn();

    await expect(
      restoreSelectedHiddenProject({
        projectKey: PROJECT_KEY,
        hiddenProjectKeys: new Set([PROJECT_KEY]),
        setProjectHidden: vi.fn().mockResolvedValue(true),
        getCurrentProjectKeys: () => new Set(),
        ensureProjectIncluded,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(true);

    expect(ensureProjectIncluded).toHaveBeenCalledWith(PROJECT_KEY);
  });
});

describe('sidebar project restore coordinator', () => {
  it('delegates selection restoration to the mounted sidebar owner', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    const unregister = registerSidebarProjectRestoreHandler(handler);

    await expect(requestSidebarProjectRestore(PROJECT_KEY)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(PROJECT_KEY);

    unregister();
    const fallback = vi.fn().mockResolvedValue(false);
    await expect(requestSidebarProjectRestore(PROJECT_KEY, fallback)).resolves.toBe(false);
    expect(fallback).toHaveBeenCalledWith(PROJECT_KEY);
  });

  it('does not let an older cleanup unregister the current sidebar owner', async () => {
    const unregisterFirst = registerSidebarProjectRestoreHandler(vi.fn().mockResolvedValue(false));
    const currentHandler = vi.fn().mockResolvedValue(true);
    const unregisterCurrent = registerSidebarProjectRestoreHandler(currentHandler);

    unregisterFirst();
    await expect(requestSidebarProjectRestore(PROJECT_KEY)).resolves.toBe(true);
    expect(currentHandler).toHaveBeenCalledOnce();

    unregisterCurrent();
  });

  it('restores through persisted sidebar state when no sidebar owner is mounted', async () => {
    const setProjectHidden = vi.fn().mockResolvedValue(true);
    const persistFilterProjects = vi.fn();

    await expect(
      restoreSelectedHiddenProjectWithoutMountedSidebar({
        projectKey: PROJECT_KEY,
        hiddenProjectKeys: new Set([PROJECT_KEY]),
        setProjectHidden,
        loadFilterProjects: () => ['local:/workspace/other'],
        persistFilterProjects,
        localPlatform: 'linux',
      }),
    ).resolves.toBe(true);

    expect(setProjectHidden).toHaveBeenCalledWith(PROJECT_KEY, false);
    expect(persistFilterProjects).toHaveBeenCalledWith([
      'local:/workspace/other',
      PROJECT_KEY,
    ]);
  });
});
