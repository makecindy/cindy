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
import { SearchResultsBody } from '../ConversationSearchBox';
import {
  buildFallbackSessionFromSearchSummary,
  CONVERSATION_SEARCH_KEEPALIVE_SELECTOR,
  createSearchResultTaskMenuActions,
} from '../SearchResultTaskMenu';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hostSharedTask: vi.fn(),
  accountSharedTask: vi.fn(),
  deviceLinkInvoke: vi.fn(),
  deviceLinkOpenLink: vi.fn(),
  deviceLinkCloseLink: vi.fn(),
  openSessionInNewWindow: vi.fn(),
  worktreeRemovalPreview: vi.fn(),
  taskTagsExecute: vi.fn(),
  writeClipboard: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
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
  setDataOwnerGeneration('owner-1');
  vi.clearAllMocks();

  mocks.hostSharedTask.mockResolvedValue({ available: false, detail: null });
  mocks.accountSharedTask.mockResolvedValue([]);
  mocks.deviceLinkInvoke.mockResolvedValue(null);
  mocks.deviceLinkOpenLink.mockResolvedValue(undefined);
  mocks.deviceLinkCloseLink.mockResolvedValue(undefined);
  mocks.openSessionInNewWindow.mockResolvedValue(undefined);
  mocks.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: false, dirty: false });
  mocks.taskTagsExecute.mockResolvedValue({ tags: [], sessions: [] });
  mocks.writeClipboard.mockResolvedValue(undefined);
  mocks.getSession.mockResolvedValue(null);

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

  it('hydrates out-of-window search hits on menu open so pinned, mute, and SSH capabilities match DB', async () => {
    const outOfWindow = makeResult({ id: 'old-local', title: 'Deploy legacy task' });
    mocks.getSession.mockResolvedValue({
      ...buildFallbackSessionFromSearchSummary(outOfWindow.session),
      pinnedAt: '2026-09-01T12:00:00.000Z',
      notificationsMuted: true,
      remoteHostId: 'ssh-prod',
    });

    renderSearchResults({ results: [outOfWindow], liveSessions: [] });
    const row = document.querySelector('[data-session-id="old-local"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 50, clientY: 50 });

    await screen.findByRole('menuitem', { name: 'unpin' });
    expect(mocks.getSession).toHaveBeenCalledWith('old-local');
    expect(screen.getByRole('menuitem', { name: 'unmuteNotifications' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'moveToProject' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'exportShare' })).toBeNull();
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
});
