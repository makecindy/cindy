// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bucket: {
    tabs: [] as Array<{ id: string; kind: string; state: unknown }>,
    activeTabId: null as string | null,
  },
}));

vi.mock('../../store', () => ({
  ensureSingletonTab: vi.fn(
    async () =>
      mocks.bucket.tabs.find((tab) => tab.kind === 'subagents') ?? {
        id: 'subagents-new',
        kind: 'subagents',
        state: { selectedRunId: null },
      },
  ),
  getBucket: vi.fn(() => mocks.bucket),
  patchTabState: vi.fn(async () => undefined),
  setActiveTab: vi.fn(async () => undefined),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));

import { ensureSingletonTab, patchTabState, setActiveTab } from '../../store';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { openSubagentsTab } from '../openSubagentsTab';
import { requestRightSidebarVisibility } from '../sidebarCommands';

describe('openSubagentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bucket.tabs = [];
    mocks.bucket.activeTabId = null;
    vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  });

  it('opens a focused singleton and carries a harness alias to the durable view', async () => {
    await openSubagentsTab('session-1', {
      focusRunId: 'native-child-1',
      focusProvider: 'codex',
    });

    expect(routeSidebarCommand).toHaveBeenCalledWith(
      {
        type: 'open-subagents-tab',
        sessionId: 'session-1',
        focusRunId: 'native-child-1',
        focusProvider: 'codex',
        focusTab: true,
        revealSidebar: true,
      },
      { allowOpen: true, userInitiated: true },
    );
    expect(routeSidebarCommand).toHaveBeenCalledTimes(4);
    expect(ensureSingletonTab).toHaveBeenCalledWith('session-1', 'subagents', {
      selectedRunId: null,
      selectedProvider: null,
    });
    expect(patchTabState).toHaveBeenCalledWith('session-1', 'subagents-new', expect.any(Function));
    expect(setActiveTab).toHaveBeenCalledWith('session-1', 'subagents-new');
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'session-1',
      userInitiated: true,
    });
  });

  it('silently adds the automatic tab without replacing another active tab', async () => {
    mocks.bucket.tabs = [{ id: 'files-1', kind: 'file-browser', state: null }];
    mocks.bucket.activeTabId = 'files-1';

    await openSubagentsTab('session-1', {
      focusTab: false,
      revealSidebar: false,
      userInitiated: false,
    });

    expect(routeSidebarCommand).toHaveBeenCalledWith(
      {
        type: 'open-subagents-tab',
        sessionId: 'session-1',
        focusRunId: null,
        focusProvider: null,
        focusTab: false,
        revealSidebar: false,
      },
      { allowOpen: false, userInitiated: false },
    );
    expect(ensureSingletonTab).toHaveBeenCalledWith('session-1', 'subagents', {
      selectedRunId: null,
      selectedProvider: null,
    });
    expect(setActiveTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
  });

  it('focuses and patches the existing singleton when a card is clicked', async () => {
    mocks.bucket.tabs = [
      { id: 'subagents-existing', kind: 'subagents', state: { selectedRunId: null } },
    ];
    mocks.bucket.activeTabId = null;

    await openSubagentsTab('session-1', {
      focusRunId: 'parent-tool-1',
      focusProvider: 'claude-code',
    });

    expect(ensureSingletonTab).toHaveBeenCalledWith('session-1', 'subagents', {
      selectedRunId: null,
      selectedProvider: null,
    });
    expect(patchTabState).toHaveBeenCalledWith(
      'session-1',
      'subagents-existing',
      expect.any(Function),
    );
    const patcher = vi.mocked(patchTabState).mock.calls[0]?.[2];
    expect(patcher?.({ kept: true })).toEqual({
      kept: true,
      selectedRunId: 'parent-tool-1',
      selectedProvider: 'claude-code',
    });
    expect(setActiveTab).toHaveBeenCalledWith('session-1', 'subagents-existing');
  });

  it('reroutes to the detached host if ownership changes while SQLite is in flight', async () => {
    vi.mocked(routeSidebarCommand)
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('routed');

    await openSubagentsTab('session-1', { focusRunId: 'child-1', focusProvider: 'pi' });

    expect(ensureSingletonTab).toHaveBeenCalledTimes(1);
    expect(patchTabState).not.toHaveBeenCalled();
    expect(setActiveTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).toHaveBeenCalledTimes(1);
  });

  it('reroutes after selection persistence if the detached host takes ownership', async () => {
    vi.mocked(routeSidebarCommand)
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('routed');

    await openSubagentsTab('session-1', { focusRunId: 'child-1', focusProvider: 'pi' });

    expect(patchTabState).toHaveBeenCalledTimes(1);
    expect(setActiveTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).toHaveBeenCalledTimes(1);
  });

  it('reroutes after activation persistence if ownership changes during the write', async () => {
    vi.mocked(routeSidebarCommand)
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('attached')
      .mockResolvedValueOnce('routed');

    await openSubagentsTab('session-1', { focusRunId: 'child-1', focusProvider: 'pi' });

    expect(patchTabState).toHaveBeenCalledTimes(1);
    expect(setActiveTab).toHaveBeenCalledTimes(1);
    expect(requestRightSidebarVisibility).toHaveBeenCalledTimes(1);
  });
});
