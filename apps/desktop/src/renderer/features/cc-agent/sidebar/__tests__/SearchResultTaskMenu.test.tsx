// @vitest-environment jsdom
/**
 * Unit/component tests for right-clicking conversation search results.
 * Why: Right-clicking a searched task must open the same SessionTaskMenu as the
 * sidebar task list across both expanded inline search and collapsed rail search,
 * while excluding non-task companion private chats, hydrating out-of-window tasks,
 * gating offline/guest remote tasks, and staying open during dialogs.
 * Gap: Existing conversationSearchBox tests mock dropdown-menu and only cover
 * left-click navigation and filters; SessionTaskMenu tests do not cover search
 * rows, out-of-window hydration, live deletion/status filtering, or inline rename.
 */
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';

import { Tooltip } from '@/components/ui/tooltip';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { resetTaskTagCatalogCache } from '@/features/task-tags/taskTagEvents';
import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { sessionsStore } from '@/lib/sessionsStore';
import { __resetInstalledGhostsStoreForTest } from '@/cindy-brain/useInstalledGhosts';
import type {
  ConversationSearchResultItem,
  ConversationSearchSessionSummary,
  ConversationSearchStatusFilter,
} from '../../../../../shared/conversationSearch';
import {
  ConversationSearchBox,
  SearchResultsBody,
  useConversationSearch,
} from '../ConversationSearchBox';
import { setSearchDraft } from '../conversationSearchDraft';
import {
  buildFallbackSessionFromSearchSummary,
  CONVERSATION_SEARCH_KEEPALIVE_SELECTOR,
  createSearchResultTaskMenuActions,
} from '../SearchResultTaskMenu';
import {
  SPLIT_GROUP_SESSION_LINK_MIME,
  SPLIT_GROUP_SESSION_MIME,
} from '../../splitGroupDnd';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  searchConversations: vi.fn(),
  hostSharedTask: vi.fn(),
  accountSharedTask: vi.fn(),
  deviceLinkInvoke: vi.fn(),
  deviceLinkOpenLink: vi.fn(),
  deviceLinkCloseLink: vi.fn(),
  openSessionInNewWindow: vi.fn(),
  openSessionInNewWindowIfDroppedOutside: vi.fn(),
  beginSessionDragPreview: vi.fn(),
  endSessionDragPreview: vi.fn(),
  worktreeRemovalPreview: vi.fn(),
  taskTagsExecute: vi.fn(),
  writeClipboard: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/conversationSearchService', () => ({
  searchConversations: (...args: unknown[]) => mocks.searchConversations(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => key.split('.').at(-1) ?? key,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner-1', isAuthenticated: true }),
}));

vi.mock('@/lib/sessionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessionService')>();
  return {
    ...actual,
    get: mocks.getSession,
  };
});

vi.mock('@/lib/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

function makeSummary(
  overrides: Partial<ConversationSearchSessionSummary> = {},
): ConversationSearchSessionSummary {
  return {
    id: 'task-1',
    title: 'Deploy search feature',
    workingDir: '/repo/cindy',
    workspaceKind: 'project',
    agentKind: 'cc',
    status: 'active',
    userSendAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    createdAt: '2026-09-01T09:00:00.000Z',
    _count: { messages: 4 },
    ...overrides,
  };
}

function makeResult(
  summaryOverrides: Partial<ConversationSearchSessionSummary> = {},
  itemOverrides: Partial<ConversationSearchResultItem> = {},
): ConversationSearchResultItem {
  return {
    session: makeSummary(summaryOverrides),
    matchKind: 'title',
    titleMatchIndices: [0, 1, 2, 3, 4, 5],
    titleScore: 1,
    contentHit: null,
    contentHits: [],
    rankScore: 1,
    ...itemOverrides,
  };
}

function renderSearchResults({
  results,
  liveSessions = [],
  remoteStatuses = {},
  statusFilter = 'all',
  onSelect = vi.fn(),
  onAction = vi.fn(),
  onRename = vi.fn(),
  onTogglePin = vi.fn(),
  onMoveSession = vi.fn(),
}: {
  results: ConversationSearchResultItem[];
  liveSessions?: Session[];
  remoteStatuses?: Record<string, DeviceLinkConnectionStatus>;
  statusFilter?: ConversationSearchStatusFilter;
  onSelect?: ReturnType<typeof vi.fn>;
  onAction?: ReturnType<typeof vi.fn>;
  onRename?: ReturnType<typeof vi.fn>;
  onTogglePin?: ReturnType<typeof vi.fn>;
  onMoveSession?: ReturnType<typeof vi.fn>;
}) {
  const liveByKey = new Map(
    liveSessions.map((session) => [`${session.deviceLinkDeviceId ?? ''}:${session.id}`, session]),
  );
  const taskMenu = createSearchResultTaskMenuActions({
    resolveSession: (summary) =>
      liveByKey.get(`${summary.deviceLinkDeviceId ?? ''}:${summary.id}`) ?? null,
    getRemoteConnectionStatus: (deviceId) => remoteStatuses[deviceId] ?? null,
    onAction,
    onRename,
    onTogglePin,
    onMoveSession,
    projectOptions: [],
  });
  const view = render(
    <MemoryRouter>
      <Tooltip.Provider>
        <SearchResultsBody
          trimmed="Deploy"
          status="done"
          results={results}
          statusFilter={statusFilter}
          taskMenu={taskMenu}
          onSelect={onSelect}
        />
      </Tooltip.Provider>
    </MemoryRouter>,
  );
  return { view, onSelect, onAction, onRename, onTogglePin, onMoveSession };
}

beforeEach(() => {
  __resetInstalledGhostsStoreForTest();
  resetTaskTagCatalogCache();
  remoteProjectsStore.clear();
  setSearchDraft('');
  setDataOwnerGeneration('owner-1');
  vi.clearAllMocks();

  mocks.hostSharedTask.mockResolvedValue({ available: false, detail: null });
  mocks.accountSharedTask.mockResolvedValue([]);
  mocks.deviceLinkInvoke.mockResolvedValue(null);
  mocks.deviceLinkOpenLink.mockResolvedValue(undefined);
  mocks.deviceLinkCloseLink.mockResolvedValue(undefined);
  mocks.openSessionInNewWindow.mockResolvedValue(undefined);
  mocks.openSessionInNewWindowIfDroppedOutside.mockResolvedValue(false);
  mocks.beginSessionDragPreview.mockResolvedValue(undefined);
  mocks.endSessionDragPreview.mockReturnValue(undefined);
  mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: false, dirty: false });
  mocks.taskTagsExecute.mockResolvedValue({ tags: [], sessions: [] });
  mocks.writeClipboard.mockResolvedValue(undefined);
  mocks.getSession.mockResolvedValue(null);
  mocks.searchConversations.mockResolvedValue({
    query: '',
    results: [],
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  });

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeClipboard },
  });
  Object.assign(window, {
    electronAPI: {
      platform: 'darwin',
      worktreeRemovalPreview: mocks.worktreeRemovalPreview,
      maker: {
        openSessionInNewWindow: mocks.openSessionInNewWindow,
        openSessionInNewWindowIfDroppedOutside: mocks.openSessionInNewWindowIfDroppedOutside,
        beginSessionDragPreview: mocks.beginSessionDragPreview,
        endSessionDragPreview: mocks.endSessionDragPreview,
      },
      sharedTask: {
        host: mocks.hostSharedTask,
        account: mocks.accountSharedTask,
      },
      deviceLink: {
        invoke: mocks.deviceLinkInvoke,
        openLink: mocks.deviceLinkOpenLink,
        closeLink: mocks.deviceLinkCloseLink,
      },
      localDb: {
        taskTags: {
          execute: mocks.taskTagsExecute,
        },
      },
      ghosts: {
        listSync: () => ({ ghosts: [] }),
        onChanged: () => () => {},
        runtimePlugins: async () => ({}),
        listControlPointCandidates: async () => [],
      },
    },
  });
});

afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
});

describe('SearchResultTaskMenu', () => {
  it('opens the standard task menu when right-clicking a row or nested content hit without navigating', async () => {
    const hit = {
      messageId: 'msg-1',
      messageClientId: 'client-1',
      role: 'assistant' as const,
      createdAt: '2026-09-01T10:00:00.000Z',
      snippet: null,
      preview: 'Deploy preview snippet',
      score: 1,
      ftsRank: 1,
      vectorRank: null,
    };
    const item = makeResult({}, { matchKind: 'both', contentHit: hit, contentHits: [hit] });
    const live = buildFallbackSessionFromSearchSummary(item.session);
    const { onSelect } = renderSearchResults({ results: [item], liveSessions: [live] });

    const hitButton = screen.getByRole('button', { name: /Deploy preview snippet/ });
    fireEvent.contextMenu(hitButton, { clientX: 120, clientY: 90 });

    const menu = await screen.findByRole('menu');
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual([
      'pin',
      'rename',
      'muteNotifications',
      'copySessionLink',
      'title',
      'moveToProject',
      'exportShare',
      'openInNewWindow',
      'archived',
      'delete',
    ]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mocks.worktreeRemovalPreview).toHaveBeenCalledWith('task-1');
  });

  it('excludes companion canonical and history private chats while allowing companion channel tasks', async () => {
    const canonical = makeResult({
      id: 'bot-canonical',
      title: 'Deploy canonical chat',
      source: 'bot',
      companion: { id: 'bot-1', name: 'Melody', role: 'canonical', readOnly: false },
    });
    const history = makeResult({
      id: 'bot-history',
      title: 'Deploy archived chat',
      status: 'archived',
      source: 'bot',
      companion: { id: 'bot-1', name: 'Melody', role: 'history', readOnly: true },
    });
    const channel = makeResult({
      id: 'bot-channel',
      title: 'Deploy channel task',
      source: 'bot',
      companion: { id: 'bot-1', name: 'Melody', role: 'channel', readOnly: false },
    });

    renderSearchResults({
      results: [canonical, history, channel],
      liveSessions: [
        buildFallbackSessionFromSearchSummary(canonical.session),
        buildFallbackSessionFromSearchSummary(history.session),
        buildFallbackSessionFromSearchSummary(channel.session),
      ],
    });

    for (const id of ['bot-canonical', 'bot-history']) {
      const row = document.querySelector(`[data-session-id="${id}"]`) as HTMLElement;
      fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
      expect(screen.queryByRole('menu')).toBeNull();
    }

    const channelRow = document.querySelector('[data-session-id="bot-channel"]') as HTMLElement;
    fireEvent.contextMenu(channelRow, { clientX: 40, clientY: 40 });
    expect(await screen.findByRole('menu')).toBeTruthy();
  });

  it('dispatches pin, archive, delete, unarchive, open in new window, and deep-link copy actions', async () => {
    const activeItem = makeResult({ id: 'task-active', title: 'Deploy active' });
    const archivedItem = makeResult({
      id: 'task-archived',
      title: 'Deploy archived',
      status: 'archived',
    });
    const activeSession = buildFallbackSessionFromSearchSummary(activeItem.session);
    const archivedSession = buildFallbackSessionFromSearchSummary(archivedItem.session);

    const { onAction, onTogglePin } = renderSearchResults({
      results: [activeItem, archivedItem],
      liveSessions: [activeSession, archivedSession],
    });

    const activeRow = document.querySelector('[data-session-id="task-active"]') as HTMLElement;
    fireEvent.contextMenu(activeRow, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'pin' }));
    expect(onTogglePin).toHaveBeenCalledWith('task-active', false, activeSession);

    fireEvent.contextMenu(activeRow, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'archived' }));
    expect(onAction).toHaveBeenCalledWith('task-active', 'archive', activeSession);

    fireEvent.contextMenu(activeRow, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'delete' }));
    expect(onAction).toHaveBeenCalledWith('task-active', 'delete', activeSession);

    fireEvent.contextMenu(activeRow, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'openInNewWindow' }));
    expect(mocks.openSessionInNewWindow).toHaveBeenCalledWith('task-active', undefined);

    fireEvent.contextMenu(activeRow, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'copySessionLink' }));
    await waitFor(() =>
      expect(mocks.writeClipboard).toHaveBeenCalledWith(buildSessionDeepLink('task-active')),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('copied');

    const archivedRow = document.querySelector('[data-session-id="task-archived"]') as HTMLElement;
    fireEvent.contextMenu(archivedRow, { clientX: 40, clientY: 80 });
    expect(screen.queryByRole('menuitem', { name: 'moveToProject' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'unarchive' }));
    expect(onAction).toHaveBeenCalledWith('task-archived', 'unarchive', archivedSession);
  });

  it('supports inline rename, cancels on Escape, commits on Enter, and clears stale title highlights', async () => {
    const item = makeResult({ id: 'task-rename', title: 'Deploy search feature' });
    const onRenameSpy = vi.fn();

    function RenameHarness() {
      const [live, setLive] = useState<Session>(() =>
        buildFallbackSessionFromSearchSummary(item.session),
      );
      const taskMenu = createSearchResultTaskMenuActions({
        resolveSession: (summary) => (summary.id === live.id ? live : null),
        onAction: vi.fn(),
        onRename: async (sessionId, newTitle, session) => {
          onRenameSpy(sessionId, newTitle, session);
          setLive((prev) => ({ ...prev, title: newTitle }));
          return true;
        },
        onTogglePin: vi.fn(),
      });
      return (
        <MemoryRouter>
          <Tooltip.Provider>
            <SearchResultsBody
              trimmed="Deploy"
              status="done"
              results={[item]}
              taskMenu={taskMenu}
              onSelect={vi.fn()}
            />
          </Tooltip.Provider>
        </MemoryRouter>
      );
    }

    render(<RenameHarness />);
    const row = document.querySelector('[data-session-id="task-rename"]') as HTMLElement;
    expect(row.querySelector('mark')?.textContent).toBe('Deploy');

    // Open menu -> Rename -> Escape cancels without calling onRename
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'rename' }));
    const cancelInput = screen.getByRole('textbox') as HTMLInputElement;
    expect(cancelInput.value).toBe('Deploy search feature');
    fireEvent.change(cancelInput, { target: { value: 'Temporary draft' } });
    fireEvent.keyDown(cancelInput, { key: 'Escape' });
    expect(onRenameSpy).not.toHaveBeenCalled();

    // Open menu -> Rename -> Enter commits and clears old match indices
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'rename' }));
    const commitInput = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(commitInput, { target: { value: 'Shipped search menu' } });
    fireEvent.keyDown(commitInput, { key: 'Enter' });

    expect(onRenameSpy).toHaveBeenCalledWith(
      'task-rename',
      'Shipped search menu',
      expect.objectContaining({ id: 'task-rename' }),
    );
    expect(screen.getByText('Shipped search menu')).toBeTruthy();
    expect(row.querySelector('mark')).toBeNull();
  });

  it('pins remote origin on right-click and enforces offline write-block and shared-guest gates', async () => {
    const pinSpy = vi.spyOn(remoteProjectsStore, 'pinSessionOrigin');
    const onlineRemote = makeResult({
      id: 'remote-online',
      title: 'Deploy on Studio',
      deviceLinkDeviceId: 'dev-online',
      deviceLinkDeviceName: 'Studio',
    });
    const offlineRemote = makeResult({
      id: 'remote-offline',
      title: 'Deploy offline',
      deviceLinkDeviceId: 'dev-offline',
      deviceLinkDeviceName: 'Offline Mac',
    });
    const sharedPeer = sharedTaskHostPeer('share-1', 'dev-host');
    const sharedGuest = makeResult({
      id: 'remote-shared',
      title: 'Deploy shared task',
      deviceLinkDeviceId: sharedPeer,
      deviceLinkDeviceName: 'Teammate Mac',
    });

    renderSearchResults({
      results: [onlineRemote, offlineRemote, sharedGuest],
      liveSessions: [
        buildFallbackSessionFromSearchSummary(onlineRemote.session, 'connected'),
        buildFallbackSessionFromSearchSummary(offlineRemote.session, 'disconnected'),
        buildFallbackSessionFromSearchSummary(sharedGuest.session, 'connected'),
      ],
      remoteStatuses: {
        'dev-online': 'connected',
        'dev-offline': 'disconnected',
      },
    });

    // Connected remote task pins origin and passes deviceId to openInNewWindow
    const onlineRow = document.querySelector('[data-session-id="remote-online"]') as HTMLElement;
    fireEvent.contextMenu(onlineRow, { clientX: 40, clientY: 40 });
    expect(pinSpy).toHaveBeenCalledWith('dev-online', 'remote-online');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'openInNewWindow' }));
    expect(mocks.openSessionInNewWindow).toHaveBeenCalledWith('remote-online', 'dev-online');

    // Disconnected remote task disables mutations while keeping copy link active
    const offlineRow = document.querySelector('[data-session-id="remote-offline"]') as HTMLElement;
    fireEvent.contextMenu(offlineRow, { clientX: 40, clientY: 80 });
    await screen.findByRole('menu');
    for (const name of ['pin', 'rename', 'openInNewWindow', 'archived', 'delete']) {
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
    }
    expect(
      screen.getByRole('menuitem', { name: 'copySessionLink' }).getAttribute('aria-disabled'),
    ).not.toBe('true');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    // Shared guest task exposes only copy link and leave without worktree prefetch
    mocks.worktreeRemovalPreview.mockClear();
    const sharedRow = document.querySelector('[data-session-id="remote-shared"]') as HTMLElement;
    fireEvent.contextMenu(sharedRow, { clientX: 40, clientY: 120 });
    const guestMenu = await screen.findByRole('menu');
    const guestLabels = Array.from(guestMenu.querySelectorAll('[role="menuitem"]')).map(
      (node) => node.textContent,
    );
    expect(guestLabels).toEqual(['copySessionLink', 'leaveShort']);
    expect(mocks.worktreeRemovalPreview).not.toHaveBeenCalled();
  });

  it('blocks mutations while out-of-window hydration is pending and unlocks with authoritative state', async () => {
    const outOfWindow = makeResult({ id: 'old-local', title: 'Deploy legacy task' });
    let resolveSession!: (session: Session | null) => void;
    mocks.getSession.mockReturnValueOnce(
      new Promise<Session | null>((resolve) => {
        resolveSession = resolve;
      }),
    );

    const { onTogglePin, onAction } = renderSearchResults({ results: [outOfWindow], liveSessions: [] });
    const row = document.querySelector('[data-session-id="old-local"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });

    await screen.findByRole('status');
    expect(screen.getByRole('status').textContent).toBe('loading');
    for (const name of [
      'pin',
      'rename',
      'muteNotifications',
      'moveToProject',
      'openInNewWindow',
      'archived',
      'delete',
    ]) {
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
    }
    expect(screen.queryByRole('menuitem', { name: 'exportShare' })).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'copySessionLink' }).getAttribute('aria-disabled'),
    ).not.toBe('true');

    fireEvent.click(screen.getByRole('menuitem', { name: 'pin' }));
    expect(onTogglePin).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();

    await act(async () => {
      resolveSession({
        ...buildFallbackSessionFromSearchSummary(outOfWindow.session),
        pinnedAt: '2026-09-01T12:00:00.000Z',
        notificationsMuted: true,
        remoteHostId: 'ssh-prod',
      });
    });

    const unpinItem = await screen.findByRole('menuitem', { name: 'unpin' });
    expect(unpinItem.getAttribute('aria-disabled')).not.toBe('true');
    expect(mocks.getSession).toHaveBeenCalledWith('old-local');
    expect(screen.getByRole('menuitem', { name: 'unmuteNotifications' }).getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByRole('menuitem', { name: 'moveToProject' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'exportShare' })).toBeNull();
  });

  it('keeps out-of-window mutations disabled after hydration failure and recovers via retry', async () => {
    const outOfWindow = makeResult({ id: 'old-retry', title: 'Deploy flaky task' });
    mocks.getSession
      .mockRejectedValueOnce(new Error('db busy'))
      .mockResolvedValueOnce({
        ...buildFallbackSessionFromSearchSummary(outOfWindow.session),
        pinnedAt: '2026-09-02T00:00:00.000Z',
      });

    renderSearchResults({ results: [outOfWindow], liveSessions: [] });
    const row = document.querySelector('[data-session-id="old-retry"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });

    const retryItem = await screen.findByRole('menuitem', { name: 'retry' });
    expect(screen.getByRole('menuitem', { name: 'pin' }).getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'copySessionLink' }).getAttribute('aria-disabled'),
    ).not.toBe('true');

    fireEvent.click(retryItem);
    const unpinItem = await screen.findByRole('menuitem', { name: 'unpin' });
    expect(unpinItem.getAttribute('aria-disabled')).not.toBe('true');
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('syncs out-of-window remote archive/unarchive outcomes into results and leaves cancelled transitions intact', async () => {
    const remoteActive = makeResult({
      id: 'remote-oow-active',
      title: 'Deploy remote archive',
      status: 'active',
      deviceLinkDeviceId: 'dev-oow',
      deviceLinkDeviceName: 'Studio',
    });
    const remoteArchived = makeResult({
      id: 'remote-oow-archived',
      title: 'Deploy remote restore',
      status: 'archived',
      deviceLinkDeviceId: 'dev-oow',
      deviceLinkDeviceName: 'Studio',
    });
    mocks.deviceLinkInvoke.mockImplementation(async (_device, channel, [id]) => {
      if (channel !== 'local-db:sessions:get') return null;
      const target = id === remoteActive.session.id ? remoteActive.session : remoteArchived.session;
      return buildFallbackSessionFromSearchSummary(target, 'connected');
    });

    // 1. statusFilter="active": cancelled archive stays visible, confirmed archive removes row.
    const activeView = renderSearchResults({
      results: [remoteActive],
      liveSessions: [],
      remoteStatuses: { 'dev-oow': 'connected' },
      statusFilter: 'active',
    });
    expect(document.querySelector('[data-session-id="remote-oow-active"]')).not.toBeNull();
    act(() => {
      const cancelled = remoteProjectsStore.beginPendingStatus('dev-oow', 'remote-oow-active', 'archived');
      remoteProjectsStore.rollbackPendingStatus(cancelled);
    });
    expect(document.querySelector('[data-session-id="remote-oow-active"]')).not.toBeNull();
    act(() => {
      const confirmed = remoteProjectsStore.beginPendingStatus('dev-oow', 'remote-oow-active', 'archived');
      remoteProjectsStore.completePendingStatus(confirmed, { status: 'archived', pinnedAt: null });
    });
    expect(document.querySelector('[data-session-id="remote-oow-active"]')).toBeNull();
    activeView.view.unmount();

    // 2. statusFilter="all": confirmed archive updates row status so reopening the menu offers unarchive.
    const allView = renderSearchResults({
      results: [remoteActive],
      liveSessions: [],
      remoteStatuses: { 'dev-oow': 'connected' },
      statusFilter: 'all',
    });
    act(() => {
      const confirmed = remoteProjectsStore.beginPendingStatus('dev-oow', 'remote-oow-active', 'archived');
      remoteProjectsStore.completePendingStatus(confirmed, { status: 'archived', pinnedAt: null });
    });
    const stayedRow = document.querySelector('[data-session-id="remote-oow-active"]') as HTMLElement;
    expect(stayedRow).not.toBeNull();
    fireEvent.contextMenu(stayedRow, { clientX: 50, clientY: 50 });
    expect(await screen.findByRole('menuitem', { name: 'unarchive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'archived' })).toBeNull();
    allView.view.unmount();

    // 3. statusFilter="archived": confirmed unarchive removes row immediately.
    renderSearchResults({
      results: [remoteArchived],
      liveSessions: [],
      remoteStatuses: { 'dev-oow': 'connected' },
      statusFilter: 'archived',
    });
    expect(document.querySelector('[data-session-id="remote-oow-archived"]')).not.toBeNull();
    act(() => {
      const restored = remoteProjectsStore.beginPendingStatus('dev-oow', 'remote-oow-archived', 'active');
      remoteProjectsStore.completePendingStatus(restored, { status: 'active' });
    });
    expect(document.querySelector('[data-session-id="remote-oow-archived"]')).toBeNull();
  });

  it('removes deleted local/remote rows immediately and filters archived rows when statusFilter is active', () => {
    const localItem = makeResult({ id: 'local-del', title: 'Deploy local' });
    const remoteItem = makeResult({
      id: 'remote-del',
      title: 'Deploy remote',
      deviceLinkDeviceId: 'dev-b',
      deviceLinkDeviceName: 'Remote Box',
    });
    const archiveItem = makeResult({ id: 'local-arch', title: 'Deploy archive candidate' });

    renderSearchResults({
      results: [localItem, remoteItem, archiveItem],
      liveSessions: [],
      statusFilter: 'active',
    });

    expect(document.querySelector('[data-session-id="local-del"]')).not.toBeNull();
    expect(document.querySelector('[data-session-id="remote-del"]')).not.toBeNull();
    expect(document.querySelector('[data-session-id="local-arch"]')).not.toBeNull();

    act(() => {
      sessionsStore.patchLocal('local-del', { status: 'deleted' });
      remoteProjectsStore.applyPatch('dev-b', 'remote-del', { status: 'deleted' });
      sessionsStore.patchLocal('local-arch', { status: 'archived' });
    });

    expect(document.querySelector('[data-session-id="local-del"]')).toBeNull();
    expect(document.querySelector('[data-session-id="remote-del"]')).toBeNull();
    expect(document.querySelector('[data-session-id="local-arch"]')).toBeNull();
  });

  it('keeps tag editor and export dialogs inside the conversation search keepalive selector', async () => {
    const item = makeResult({ id: 'task-dialogs', title: 'Deploy dialog task' });
    const live = buildFallbackSessionFromSearchSummary(item.session);
    renderSearchResults({ results: [item], liveSessions: [live] });

    const row = document.querySelector('[data-session-id="task-dialogs"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('button', { name: 'more' }));
    const tagDialog = await screen.findByRole('dialog');
    expect(tagDialog.closest(CONVERSATION_SEARCH_KEEPALIVE_SELECTOR)).not.toBeNull();
    fireEvent.keyDown(tagDialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'exportShare' }));
    const exportDialog = await screen.findByRole('alertdialog');
    expect(exportDialog.closest(CONVERSATION_SEARCH_KEEPALIVE_SELECTOR)).not.toBeNull();
  });

  it('opens search rows and nested hits in a new window on Cmd/Ctrl-click and middle-click with platform and remote gates', async () => {
    const navigate = vi.fn();
    const pinSpy = vi.spyOn(remoteProjectsStore, 'pinSessionOrigin');
    const hit1 = {
      messageId: 'msg-1',
      messageClientId: 'client-1',
      role: 'assistant' as const,
      createdAt: '2026-09-01T10:00:00.000Z',
      snippet: null,
      preview: 'First matching snippet',
      score: 1,
      ftsRank: 1,
      vectorRank: null,
    };
    const hit2 = {
      messageId: 'msg-2',
      messageClientId: 'client-2',
      role: 'user' as const,
      createdAt: '2026-09-01T10:05:00.000Z',
      snippet: null,
      preview: 'Second matching snippet',
      score: 0.9,
      ftsRank: 2,
      vectorRank: null,
    };
    const localItem = makeResult(
      { id: 'task-jump', title: 'Deploy jump target' },
      { matchKind: 'both', contentHit: hit1, contentHits: [hit1, hit2] },
    );
    const onlineRemote = makeResult({
      id: 'remote-online',
      title: 'Deploy remote online',
      deviceLinkDeviceId: 'dev-online',
      deviceLinkDeviceName: 'Studio',
    });
    const offlineRemote = makeResult({
      id: 'remote-offline',
      title: 'Deploy remote offline',
      deviceLinkDeviceId: 'dev-offline',
      deviceLinkDeviceName: 'Offline Box',
    });
    const sharedPeer = sharedTaskHostPeer('share-2', 'dev-host');
    const sharedGuest = makeResult({
      id: 'remote-shared',
      title: 'Deploy shared guest',
      deviceLinkDeviceId: sharedPeer,
      deviceLinkDeviceName: 'Host Mac',
    });

    const liveByKey = new Map<string, Session>([
      [':task-jump', buildFallbackSessionFromSearchSummary(localItem.session)],
      ['dev-online:remote-online', buildFallbackSessionFromSearchSummary(onlineRemote.session, 'connected')],
      ['dev-offline:remote-offline', buildFallbackSessionFromSearchSummary(offlineRemote.session, 'disconnected')],
      [`${sharedPeer}:remote-shared`, buildFallbackSessionFromSearchSummary(sharedGuest.session, 'connected')],
    ]);

    function Harness() {
      const search = useConversationSearch({
        enabled: true,
        navigate,
        allKnownProjects: [],
      });
      const taskMenu = createSearchResultTaskMenuActions({
        resolveSession: (summary) =>
          liveByKey.get(`${summary.deviceLinkDeviceId ?? ''}:${summary.id}`) ?? null,
        getRemoteConnectionStatus: (deviceId) =>
          deviceId === 'dev-offline' ? 'disconnected' : 'connected',
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
      });
      return (
        <MemoryRouter>
          <Tooltip.Provider>
            <SearchResultsBody
              trimmed="Deploy"
              status="done"
              results={[localItem, onlineRemote, offlineRemote, sharedGuest]}
              taskMenu={taskMenu}
              onSelect={search.handleSelect}
            />
          </Tooltip.Provider>
        </MemoryRouter>
      );
    }

    render(<Harness />);

    const localRowButton = document.querySelector(
      '[data-session-id="task-jump"] > button',
    ) as HTMLButtonElement;
    const hit2Button = screen.getByRole('button', { name: /Second matching snippet/ });

    // macOS Cmd+Click on row header opens with primary hit anchor and does not navigate
    fireEvent.click(localRowButton, { metaKey: true });
    await waitFor(() =>
      expect(mocks.openSessionInNewWindow).toHaveBeenLastCalledWith('task-jump', undefined, 'client-1'),
    );
    expect(navigate).not.toHaveBeenCalled();

    // macOS Cmd+Click on nested hit #2 preserves hit #2's messageClientId
    fireEvent.click(hit2Button, { metaKey: true });
    await waitFor(() =>
      expect(mocks.openSessionInNewWindow).toHaveBeenLastCalledWith('task-jump', undefined, 'client-2'),
    );
    expect(navigate).not.toHaveBeenCalled();

    // Middle-click on nested hit also opens in a new window
    fireEvent(hit2Button, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(mocks.openSessionInNewWindow).toHaveBeenCalledTimes(3));
    expect(navigate).not.toHaveBeenCalled();

    // macOS Ctrl+Click stays normal navigation (does not open in new window)
    fireEvent.click(localRowButton, { ctrlKey: true });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(mocks.openSessionInNewWindow).toHaveBeenCalledTimes(3);

    // Connected remote Cmd+Click pins origin and passes deviceId
    const onlineButton = document.querySelector(
      '[data-session-id="remote-online"] > button',
    ) as HTMLButtonElement;
    fireEvent.click(onlineButton, { metaKey: true });
    await waitFor(() =>
      expect(mocks.openSessionInNewWindow).toHaveBeenLastCalledWith('remote-online', 'dev-online', null),
    );
    expect(pinSpy).toHaveBeenCalledWith('dev-online', 'remote-online');

    // Offline remote and shared-task guest Cmd+Click warn instead of opening a new window
    mocks.openSessionInNewWindow.mockClear();
    const offlineButton = document.querySelector(
      '[data-session-id="remote-offline"] > button',
    ) as HTMLButtonElement;
    fireEvent.click(offlineButton, { metaKey: true });
    expect(mocks.toastWarning).toHaveBeenCalledWith('actionsUnavailable');
    expect(mocks.openSessionInNewWindow).not.toHaveBeenCalled();

    const sharedButton = document.querySelector(
      '[data-session-id="remote-shared"] > button',
    ) as HTMLButtonElement;
    fireEvent.click(sharedButton, { metaKey: true });
    expect(mocks.toastWarning).toHaveBeenCalledTimes(2);
    expect(mocks.openSessionInNewWindow).not.toHaveBeenCalled();

    // Windows/Linux Ctrl+Click opens in a new window
    window.electronAPI.platform = 'win32';
    navigate.mockClear();
    fireEvent.click(localRowButton, { ctrlKey: true });
    await waitFor(() =>
      expect(mocks.openSessionInNewWindow).toHaveBeenLastCalledWith('task-jump', undefined, 'client-1'),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('supports dragging search rows and nested hits to split panes or new windows and respects drag gates', async () => {
    const pinSpy = vi.spyOn(remoteProjectsStore, 'pinSessionOrigin');
    const hit = {
      messageId: 'msg-drag',
      messageClientId: 'client-drag',
      role: 'assistant' as const,
      createdAt: '2026-09-01T10:00:00.000Z',
      snippet: null,
      preview: 'Draggable hit snippet',
      score: 1,
      ftsRank: 1,
      vectorRank: null,
    };
    const localItem = makeResult(
      { id: 'task-drag', title: 'Deploy draggable task' },
      { matchKind: 'both', contentHit: hit, contentHits: [hit] },
    );
    const remoteItem = makeResult({
      id: 'remote-drag',
      title: 'Deploy remote drag',
      deviceLinkDeviceId: 'dev-drag',
      deviceLinkDeviceName: 'Studio',
    });
    const workerItem = makeResult({
      id: 'worker-no-drag',
      title: 'Deploy worker',
      orcaRole: 'worker',
    });
    const sharedGuest = makeResult({
      id: 'shared-no-drag',
      title: 'Deploy shared',
      deviceLinkDeviceId: sharedTaskHostPeer('share-3', 'dev-host'),
      deviceLinkDeviceName: 'Host',
    });

    renderSearchResults({
      results: [localItem, remoteItem, workerItem, sharedGuest],
      liveSessions: [
        buildFallbackSessionFromSearchSummary(localItem.session),
        buildFallbackSessionFromSearchSummary(remoteItem.session, 'connected'),
        buildFallbackSessionFromSearchSummary(workerItem.session),
        buildFallbackSessionFromSearchSummary(sharedGuest.session, 'connected'),
      ],
      remoteStatuses: { 'dev-drag': 'connected' },
    });

    const createDataTransfer = (dropEffect = 'none') => {
      const values = new Map<string, string>();
      return {
        values,
        dataTransfer: {
          effectAllowed: '',
          dropEffect,
          clearData: () => values.clear(),
          setData: (type: string, value: string) => values.set(type, value),
          setDragImage: vi.fn(),
        },
      };
    };

    // 1. Dragging local row header writes split + link payloads and calls outside-drop check on dragEnd
    const localButton = document.querySelector(
      '[data-session-id="task-drag"] > button',
    ) as HTMLButtonElement;
    expect(localButton.getAttribute('draggable')).toBe('true');
    expect(localButton.getAttribute('data-split-group-drag-source')).toBe('true');

    const localDt = createDataTransfer('none');
    fireEvent.pointerDown(localButton.querySelector('span') ?? localButton);
    fireEvent.dragStart(localButton, { dataTransfer: localDt.dataTransfer });
    // Tip must stay mounted during dragStart so Chromium never aborts the native drag gesture
    expect(document.querySelector('[data-session-id="task-drag"] > button')).toBe(localButton);
    expect(localButton.getAttribute('data-session-dragging')).toBe('true');
    expect(localDt.values.get(SPLIT_GROUP_SESSION_MIME)).toBe('task-drag');
    expect(localDt.values.get(SPLIT_GROUP_SESSION_LINK_MIME)).toBe(buildSessionDeepLink('task-drag'));
    expect(mocks.beginSessionDragPreview).toHaveBeenCalledWith(
      'Deploy draggable task',
      'task-drag',
      undefined,
      expect.any(Object),
    );
    fireEvent.dragEnd(localButton, { dataTransfer: localDt.dataTransfer });
    expect(mocks.openSessionInNewWindowIfDroppedOutside).toHaveBeenLastCalledWith('task-drag', undefined);

    // 2. Dragging nested content hit writes the same session payload
    const hitButton = screen.getByRole('button', { name: /Draggable hit snippet/ });
    expect(hitButton.getAttribute('draggable')).toBe('true');
    expect(hitButton.getAttribute('data-split-group-drag-source')).toBe('true');
    const hitDt = createDataTransfer('move');
    fireEvent.dragStart(hitButton, { dataTransfer: hitDt.dataTransfer });
    expect(hitDt.values.get(SPLIT_GROUP_SESSION_MIME)).toBe('task-drag');
    fireEvent.dragEnd(hitButton, { dataTransfer: hitDt.dataTransfer });
    expect(mocks.openSessionInNewWindowIfDroppedOutside).toHaveBeenLastCalledWith('task-drag', undefined);

    // 3. Dragging remote result pins origin and passes deviceId into link + outside-drop check
    const remoteButton = document.querySelector(
      '[data-session-id="remote-drag"] > button',
    ) as HTMLButtonElement;
    const remoteDt = createDataTransfer('none');
    fireEvent.dragStart(remoteButton, { dataTransfer: remoteDt.dataTransfer });
    expect(pinSpy).toHaveBeenCalledWith('dev-drag', 'remote-drag');
    expect(remoteDt.values.get(SPLIT_GROUP_SESSION_MIME)).toBe('remote-drag');
    expect(remoteDt.values.get(SPLIT_GROUP_SESSION_LINK_MIME)).toBe(
      buildSessionDeepLink('remote-drag', { deviceId: 'dev-drag' }),
    );
    fireEvent.dragEnd(remoteButton, { dataTransfer: remoteDt.dataTransfer });
    expect(mocks.openSessionInNewWindowIfDroppedOutside).toHaveBeenLastCalledWith(
      'remote-drag',
      'dev-drag',
    );

    // 4. Worker and shared-task guest rows are not draggable
    const workerButton = document.querySelector(
      '[data-session-id="worker-no-drag"] > button',
    ) as HTMLButtonElement;
    expect(workerButton.getAttribute('draggable')).toBe('false');
    expect(workerButton.getAttribute('data-split-group-drag-source')).toBeNull();

    const sharedButton = document.querySelector(
      '[data-session-id="shared-no-drag"] > button',
    ) as HTMLButtonElement;
    expect(sharedButton.getAttribute('draggable')).toBe('false');
    expect(sharedButton.getAttribute('data-split-group-drag-source')).toBeNull();

    // 5. Opening context menu or starting inline rename disables drag on the row
    const localRow = document.querySelector('[data-session-id="task-drag"]') as HTMLElement;
    fireEvent.contextMenu(localRow, { clientX: 50, clientY: 50 });
    await screen.findByRole('menu');
    expect(localButton.getAttribute('draggable')).toBe('false');
    expect(localButton.getAttribute('data-split-group-drag-source')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'rename' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(hitButton.getAttribute('draggable')).toBe('false');
  });

  it('hides rail ConversationSearchBox popover transparently during drag, restores on cancel, and closes on in-window drop', async () => {
    const item = makeResult({ id: 'rail-drag-task', title: 'Deploy from rail' });
    mocks.searchConversations.mockResolvedValue({
      query: 'Deploy',
      results: [item],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });

    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const onOpenChange = vi.fn();

    try {
      render(
        <MemoryRouter>
          <Tooltip.Provider>
            <ConversationSearchBox
              navigate={vi.fn()}
              allKnownProjects={[]}
              allowedSessionIds={['rail-drag-task']}
              hiddenProjectKeys={new Set()}
              defaultOpen
              onOpenChange={onOpenChange}
            />
          </Tooltip.Provider>
        </MemoryRouter>,
      );

      const input = await screen.findByRole('textbox', { name: 'placeholder' });
      fireEvent.change(input, { target: { value: 'Deploy' } });

      const resultRow = await waitFor(() => {
        const node = document.querySelector(
          '[data-session-id="rail-drag-task"] > button',
        ) as HTMLButtonElement | null;
        expect(node).not.toBeNull();
        return node!;
      });

      const popoverContent = resultRow.closest('[role="dialog"]') as HTMLElement;
      expect(popoverContent).not.toBeNull();

      const makeDt = (dropEffect: string) => {
        const values = new Map<string, string>();
        return {
          effectAllowed: '',
          dropEffect,
          clearData: () => values.clear(),
          setData: (type: string, value: string) => values.set(type, value),
          setDragImage: vi.fn(),
        };
      };

      // Drag start defers hiding by 1 animation frame so Chromium captures drag source cleanly
      fireEvent.dragStart(resultRow, { dataTransfer: makeDt('none') });
      expect(popoverContent.className).not.toContain('pointer-events-none');
      act(() => {
        while (rafCallbacks.length > 0) rafCallbacks.shift()!(16);
      });
      expect(popoverContent.className).toContain('pointer-events-none');
      expect(popoverContent.className).toContain('opacity-0');

      // Cancelled / outside drag (dropEffect = 'none') keeps popover open and restores visibility
      fireEvent.dragEnd(resultRow, { dataTransfer: makeDt('none') });
      expect(popoverContent.className).not.toContain('pointer-events-none');
      expect(popoverContent.className).not.toContain('opacity-0');
      expect(onOpenChange).not.toHaveBeenCalledWith(false);

      // In-window drop (dropEffect = 'move') closes the rail popover cleanly
      fireEvent.dragStart(resultRow, { dataTransfer: makeDt('move') });
      act(() => {
        while (rafCallbacks.length > 0) rafCallbacks.shift()!(32);
      });
      fireEvent.dragEnd(resultRow, { dataTransfer: makeDt('move') });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });
});
