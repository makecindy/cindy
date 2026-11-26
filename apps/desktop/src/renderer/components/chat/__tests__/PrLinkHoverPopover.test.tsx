// @vitest-environment jsdom

/**
 * Test value (§3.2):
 * - Production entry: real MarkdownRenderer / UserMessageUrlLink -> PrLinkHoverPopover ->
 *   PrRefsProvider -> PrSummaryPopoverContent (same popover body as GitContextBadge).
 * - Rules: recognized PR/MR links in chat open the summary popover after 300ms mouse hover
 *   and fetch status on demand (local IPC or device-link remote channel); non-PR links and
 *   untrusted Market markdown (allowPrivilegedLinks=false) never fetch or open; link click
 *   and right-click menu dismiss the hover popover without losing original link actions.
 * - Gap: existing tests cover header GitContextBadge and chat link click/context-menu,
 *   not chat-body PR/MR hover popovers or on-demand hover status fetches.
 * - Minimal inputs: hover GitHub PR / GitLab MR links in MarkdownRenderer and UserMessageUrlLink,
 *   click/right-click an open hover link, hover between two links, and hover in a remote session.
 * - Tier: renderer unit (jsdom, fake timers, mocked IPC), <3s in isolation.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PrStatusResult } from '@cindy/maker-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPrStatuses: vi.fn(
    async (_queries: Array<{ prNumber: number }>): Promise<PrStatusResult[]> => [],
  ),
  listAllPrRefs: vi.fn(async () => []),
  listPrRefs: vi.fn(async () => []),
  onPrRefsChanged: vi.fn(() => () => undefined),
  onGithubConnected: vi.fn(() => () => undefined),
  openExternal: vi.fn(async () => ({ success: true })),
  deviceInvoke: vi.fn(async (): Promise<unknown> => []),
  session: { id: 'session-1' } as {
    id: string;
    deviceLinkDeviceId?: string;
    remoteHostId?: string | null;
    source?: string;
  } | null,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner-1' }) }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { findById: (id: string) => (mocks.session?.id === id ? mocks.session : undefined) },
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(async () => undefined),
  pathToFileUrl: (path: string) => `file://${path}`,
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => [],
}));

import { PrRefsProvider } from '@/contexts/PrRefsContext';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { UserMessageUrlLink } from '../UserMessageUrlLink';
import { parsePrLinkUrl } from '@/features/cc-agent/PrSummaryPopoverContent';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

function hover(element: Element, type: 'over' | 'out', pointerType = 'mouse') {
  fireEvent(
    element,
    Object.assign(new MouseEvent(`pointer${type}`, { bubbles: true }), { pointerType }),
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('parsePrLinkUrl', () => {
  it.each([
    [
      'https://github.com/Octo/Repo/pull/42',
      { provider: 'github', host: 'github.com', owner: 'octo', repo: 'repo', prNumber: 42 },
    ],
    [
      'https://www.github.com/Octo/Repo/pull/42/files?w=1#diff-1',
      { provider: 'github', host: 'github.com', owner: 'octo', repo: 'repo', prNumber: 42 },
    ],
    [
      'https://gitlab.example.com/Group/Sub/Repo/-/merge_requests/19/diffs#note_1',
      {
        provider: 'gitlab',
        host: 'gitlab.example.com',
        owner: 'group/sub',
        repo: 'repo',
        prNumber: 19,
      },
    ],
  ])('recognizes %s', (input, expected) => {
    expect(parsePrLinkUrl(input)).toMatchObject(expected);
  });

  it.each([
    'https://github.com/octo/repo/issues/42',
    'https://example.com/octo/repo/pull/42',
    'http://github.com/octo/repo/pull/42',
    '',
  ])('ignores non-PR/MR link %s', (input) => {
    expect(parsePrLinkUrl(input)).toBeNull();
  });
});

describe('PrLinkHoverPopover in chat messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.session = { id: 'session-1' };
    mocks.getPrStatuses.mockResolvedValue([]);
    mocks.deviceInvoke.mockResolvedValue([]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal: mocks.openExternal,
        gitContext: {
          listAllPrRefs: mocks.listAllPrRefs,
          listPrRefs: mocks.listPrRefs,
          getPrStatuses: mocks.getPrStatuses,
          onPrRefsChanged: mocks.onPrRefsChanged,
          onGithubConnected: mocks.onGithubConnected,
        },
        deviceLink: {
          invoke: mocks.deviceInvoke,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    remoteProjectsStore.removeDevice('remote-dev');
    vi.useRealTimers();
  });

  it('shows PR summary popover on Markdown link hover, fetches on demand, and holds while hovering panel', async () => {
    mocks.getPrStatuses.mockResolvedValueOnce([
      {
        ok: true,
        provider: 'github',
        host: 'github.com',
        owner: 'octo',
        repo: 'repo',
        prNumber: 42,
        status: 'open',
        title: 'Add chat PR hover popover',
        htmlUrl: 'https://github.com/octo/repo/pull/42',
        branch: 'feat/pr-hover',
        unresolvedCount: 2,
        conflicts: false,
        checks: { total: 4, passed: 3, failed: 1, pending: 0, skipped: 0 },
      },
    ]);

    render(
      <PrRefsProvider>
        <MarkdownRenderer
          workingDir="/tmp"
          currentSessionId="session-1"
          content="See [PR #42](https://github.com/octo/repo/pull/42/files) for details."
        />
      </PrRefsProvider>,
    );

    const link = screen.getByRole('link', { name: 'PR #42' });
    // Idle link triggers zero status fetches.
    expect(mocks.getPrStatuses).not.toHaveBeenCalled();

    hover(link, 'over');
    advance(299);
    expect(screen.queryByRole('dialog')).toBeNull();

    advance(1);
    await flushMicrotasks();

    const dialog = screen.getByRole('dialog', {
      name: 'ccAgent.gitContext.pr.summaryAria {"number":42}',
    });
    expect(mocks.getPrStatuses).toHaveBeenCalledWith([
      { owner: 'octo', repo: 'repo', prNumber: 42 },
    ]);
    expect(dialog.textContent).toContain('octo/repo #42');
    expect(dialog.textContent).toContain('Add chat PR hover popover');
    expect(dialog.textContent).toContain('ccAgent.gitContext.pr.checksTotal {"count":4}');
    expect(dialog.textContent).toContain('ccAgent.gitContext.pr.unresolvedLabel');

    // Moving pointer from link into popover keeps it open.
    hover(link, 'out');
    advance(100);
    hover(dialog, 'over');
    advance(400);
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Leaving the popover closes it after 300ms.
    hover(dialog, 'out');
    advance(300);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows GitLab MR summary popover on UserMessageUrlLink hover and dismisses on click or right-click', async () => {
    mocks.getPrStatuses.mockResolvedValueOnce([
      {
        ok: true,
        provider: 'gitlab',
        host: 'git.example.com',
        owner: 'team/sub',
        repo: 'app',
        prNumber: 19,
        status: 'merged',
        title: 'Migrate MR hover card',
        htmlUrl: 'https://git.example.com/team/sub/app/-/merge_requests/19',
        branch: 'feat/mr-hover',
        unresolvedCount: 0,
        checks: { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0 },
      },
    ]);

    const mrUrl = 'https://git.example.com/team/sub/app/-/merge_requests/19/diffs';
    render(
      <PrRefsProvider>
        <UserMessageUrlLink url={mrUrl} sessionId="session-1" />
      </PrRefsProvider>,
    );

    const link = screen.getByRole('link');
    hover(link, 'over');
    advance(300);
    await flushMicrotasks();

    const dialog = screen.getByRole('dialog', {
      name: 'ccAgent.gitContext.pr.gitlab.summaryAria {"number":19}',
    });
    expect(mocks.getPrStatuses).toHaveBeenCalledWith([
      {
        provider: 'gitlab',
        host: 'git.example.com',
        owner: 'team/sub',
        repo: 'app',
        prNumber: 19,
      },
    ]);
    expect(dialog.textContent).toContain('team/sub/app !19');
    expect(dialog.textContent).toContain('Migrate MR hover card');

    // Right-click dismisses the hover popover so context menu never stacks over it.
    fireEvent.contextMenu(link, { clientX: 12, clientY: 16 });
    expect(screen.queryByRole('dialog')).toBeNull();

    // Re-hovering after pointer leave reopens cleanly; clicking opens link and dismisses popover.
    hover(link, 'out');
    hover(link, 'over');
    advance(300);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(link);
    await flushMicrotasks();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.openExternal).toHaveBeenCalledWith(mrUrl);
  });

  it('switches immediately between adjacent PR links without overlapping popovers', async () => {
    mocks.getPrStatuses.mockImplementation(async (queries: Array<{ prNumber: number }>) =>
      queries.map((q) => ({
        ok: true as const,
        provider: 'github' as const,
        host: 'github.com',
        owner: 'octo',
        repo: 'repo',
        prNumber: q.prNumber,
        status: 'open' as const,
        title: `PR title ${q.prNumber}`,
        htmlUrl: `https://github.com/octo/repo/pull/${q.prNumber}`,
        branch: `branch-${q.prNumber}`,
        unresolvedCount: 0,
      })),
    );

    render(
      <PrRefsProvider>
        <MarkdownRenderer
          workingDir="/tmp"
          currentSessionId="session-1"
          content="Compare [PR #1](https://github.com/octo/repo/pull/1) and [PR #2](https://github.com/octo/repo/pull/2)."
        />
      </PrRefsProvider>,
    );

    const [first, second] = screen.getAllByRole('link');
    hover(first, 'over');
    advance(300);
    await flushMicrotasks();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog').textContent).toContain('PR title 1');

    // Moving straight to the second link replaces the first popover without waiting another 300ms.
    hover(first, 'out');
    hover(second, 'over');
    await flushMicrotasks();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog').textContent).toContain('PR title 2');
  });

  it('never fetches or opens for non-PR links or untrusted Market markdown', async () => {
    render(
      <PrRefsProvider>
        <MarkdownRenderer
          workingDir="/tmp"
          currentSessionId="session-1"
          allowPrivilegedLinks={false}
          content="External [PR #7](https://github.com/octo/repo/pull/7) and [Issue #8](https://github.com/octo/repo/issues/8)."
        />
      </PrRefsProvider>,
    );

    for (const link of screen.getAllByRole('link')) {
      hover(link, 'over');
      advance(400);
      hover(link, 'out');
    }
    await flushMicrotasks();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.getPrStatuses).not.toHaveBeenCalled();
  });

  it('routes remote device-link session hovers through deviceLink.invoke instead of local IPC', async () => {
    mocks.session = { id: 'remote-session', deviceLinkDeviceId: 'remote-dev' };
    mocks.deviceInvoke.mockResolvedValueOnce([
      {
        ok: true,
        provider: 'github',
        host: 'github.com',
        owner: 'octo',
        repo: 'private-repo',
        prNumber: 9,
        status: 'draft',
        title: 'Remote draft PR',
        htmlUrl: 'https://github.com/octo/private-repo/pull/9',
        branch: 'wip',
        unresolvedCount: 0,
      },
    ]);

    render(
      <PrRefsProvider>
        <ChatSessionFileProvider
          value={{
            sessionId: 'remote-session',
            workingDir: '/remote',
            origin: { kind: 'device', deviceId: 'remote-dev' },
          }}
        >
          <UserMessageUrlLink
            url="https://github.com/octo/private-repo/pull/9"
            sessionId="remote-session"
          />
        </ChatSessionFileProvider>
      </PrRefsProvider>,
    );

    hover(screen.getByRole('link'), 'over');
    advance(300);
    await flushMicrotasks();

    expect(mocks.getPrStatuses).not.toHaveBeenCalled();
    expect(mocks.deviceInvoke).toHaveBeenCalledWith('remote-dev', 'git-context:pr-status', [
      {
        sessionId: 'remote-session',
        queries: [{ owner: 'octo', repo: 'private-repo', prNumber: 9 }],
      },
    ]);
    expect(screen.getByRole('dialog').textContent).toContain('Remote draft PR');
  });
});
