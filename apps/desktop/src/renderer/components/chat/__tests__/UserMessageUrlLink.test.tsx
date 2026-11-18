// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseSessionPrUrl, type SessionPrRef } from '@cindy/maker-shared';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prState = vi.hoisted(() => ({
  refs: [] as SessionPrRef[],
  session: { id: 'session-a' } as { id: string; deviceLinkDeviceId?: string } | null,
  sticky: undefined as string | undefined,
  invalidate: vi.fn(),
  manage: vi.fn(async (): Promise<SessionPrRef[]> => []),
  remote: vi.fn(async (): Promise<unknown> => []),
  get: vi.fn(),
}));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrRefsForSession: () => prState.refs,
  usePrActions: () => ({ invalidateRemotePrRefs: prState.invalidate }),
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { findById: () => prState.session } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => prState.sticky,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => (
    <span aria-hidden>{children}</span>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(async () => undefined),
  pathToFileUrl: (path: string) => `file://${path}`,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { SessionNavigationModeProvider } from '@/features/cc-agent/embeddedSessionNavigation';
import { openUrlInSidebarBrowser } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import {
  _resetLinkOpenPreferenceForTests,
  useLinkOpenPreference,
} from '@/hooks/useLinkOpenPreference';
import { toast } from '@/lib/toast';
import { UserMessageUrlLink } from '../UserMessageUrlLink';

const URL = 'https://example.com/path';
const LOCAL_URL = 'http://localhost:3000/app';
const openExternal = vi.fn(async (url: string) => {
  void url;
  return { success: true };
});

function WebPreferenceButton({ value }: { value: 'sidebar' | 'external' }) {
  const { setPreference } = useLinkOpenPreference('web');
  return (
    <button type="button" onClick={() => setPreference(value)}>
      use {value}
    </button>
  );
}

describe('UserMessageUrlLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prState.refs = [];
    prState.session = { id: 'session-a' };
    prState.sticky = undefined;
    prState.manage.mockReset().mockResolvedValue([]);
    prState.remote.mockReset().mockResolvedValue([]);
    prState.get.mockReset().mockResolvedValue(null);
    localStorage.clear();
    _resetLinkOpenPreferenceForTests();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openExternal,
        gitContext: { managePrRefs: prState.manage },
        deviceLink: { invoke: prState.remote },
        localDb: { sessions: { get: prState.get } },
      },
    });
  });

  it('opens public web URLs in the system browser by default', async () => {
    render(<UserMessageUrlLink url={URL} sessionId="session-a" />);

    fireEvent.click(screen.getByRole('link'));

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(URL));
    expect(openUrlInSidebarBrowser).not.toHaveBeenCalled();
  });

  it('opens localhost URLs in the current session sidebar by default', async () => {
    render(<UserMessageUrlLink url={LOCAL_URL} sessionId="session-a" />);

    fireEvent.click(screen.getByRole('link'));

    await waitFor(() =>
      expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('session-a', LOCAL_URL),
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the URL in the current session sidebar when sidebar is preferred', async () => {
    localStorage.setItem('chat.webLinkOpenPreference', 'sidebar');
    render(<UserMessageUrlLink url={URL} sessionId="session-a" />);

    fireEvent.click(screen.getByRole('link'));

    await waitFor(() => expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('session-a', URL));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('uses a newly selected external preference without remounting', async () => {
    localStorage.setItem('chat.webLinkOpenPreference', 'sidebar');
    render(
      <>
        <WebPreferenceButton value="external" />
        <UserMessageUrlLink url={URL} sessionId="session-a" />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'use external' }));
    fireEvent.click(screen.getByRole('link'));

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(URL));
    expect(openUrlInSidebarBrowser).not.toHaveBeenCalled();
  });

  it('falls back to the external browser without session context', async () => {
    render(<UserMessageUrlLink url={URL} />);

    fireEvent.click(screen.getByRole('link'));

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(URL));
    expect(openUrlInSidebarBrowser).not.toHaveBeenCalled();
  });

  it('uses the visible session bucket for sidebar-embedded messages', async () => {
    localStorage.setItem('chat.webLinkOpenPreference', 'sidebar');
    render(
      <SessionNavigationModeProvider mode="sidebar-embedded" sidebarTargetSessionId="lead-a">
        <UserMessageUrlLink url={URL} sessionId="worker-a" />
      </SessionNavigationModeProvider>,
    );

    fireEvent.click(screen.getByRole('link'));

    await waitFor(() => expect(openUrlInSidebarBrowser).toHaveBeenCalledWith('lead-a', URL));
  });

  it('shows the existing open-with menu on right-click', () => {
    render(<UserMessageUrlLink url={URL} sessionId="session-a" />);

    fireEvent.contextMenu(screen.getByRole('link'), { clientX: 10, clientY: 20 });

    expect(screen.getByText('chat.markdownRenderer.openInSidebarBrowser')).toBeTruthy();
    expect(screen.getByText('chat.markdownRenderer.openInDefaultBrowser')).toBeTruthy();
    expect(screen.getByText('chat.markdownRenderer.copyLink')).toBeTruthy();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }])(
    'uses %j as a temporary external-browser override',
    async (modifier) => {
      localStorage.setItem('chat.webLinkOpenPreference', 'sidebar');
      render(<UserMessageUrlLink url={URL} sessionId="session-a" />);

      fireEvent.click(screen.getByRole('link'), modifier);

      await waitFor(() => expect(openExternal).toHaveBeenCalledWith(URL));
      expect(openUrlInSidebarBrowser).not.toHaveBeenCalled();
      expect(localStorage.getItem('chat.webLinkOpenPreference')).toBe('sidebar');
    },
  );

  it('supports middle click and Shift+Enter without changing the sidebar preference', async () => {
    render(<UserMessageUrlLink url={LOCAL_URL} sessionId="session-a" />);
    fireEvent(screen.getByRole('link'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent.keyDown(screen.getByRole('link'), { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(openUrlInSidebarBrowser).not.toHaveBeenCalled();
  });

  it('offers copy and system-browser actions without a session, including keyboard access', () => {
    render(<UserMessageUrlLink url={URL} />);
    fireEvent.keyDown(screen.getByRole('link'), { key: 'F10', shiftKey: true });
    expect(screen.getByText('chat.markdownRenderer.copyLink')).toBeTruthy();
    expect(screen.getByText('chat.markdownRenderer.openInDefaultBrowser')).toBeTruthy();
    expect(screen.queryByText('chat.markdownRenderer.openInSidebarBrowser')).toBeNull();
  });
  /** Test value (§3.2): production link -> menu -> generic association IPC.
   * Rule: explicit task ownership only; a GitLab /diffs link must add its base MR.
   * Gap: existing tests cover navigation, not association writes or remote routing.
   * Minimal input: right-click a PR link in a remote task; only its host may receive add.
   * Tier: renderer unit (mocked IPC), 2.65s for this existing file in isolation.
   */
  it.each([
    [
      'https://github.com/Example/Repo/pull/7/files?diff=split',
      'https://github.com/example/repo/pull/7',
    ],
    [
      'https://git.example.com/group/sub/repo/-/merge_requests/7/diffs',
      'https://git.example.com/group/sub/repo/-/merge_requests/7',
    ],
  ])('adds the canonical PR/MR for %s locally', async (url, canonical) => {
    prState.manage.mockResolvedValueOnce([parseSessionPrUrl(canonical)! as SessionPrRef]);
    render(<UserMessageUrlLink url={url} sessionId="session-a" />);
    fireEvent.contextMenu(screen.getByRole('link'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
    await waitFor(() =>
      expect(prState.manage).toHaveBeenCalledWith({
        sessionId: 'session-a',
        action: 'add',
        url: canonical,
      }),
    );
    expect(prState.remote).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('chat.markdownRenderer.prAddedToHeader'),
    );
    expect(screen.queryByText('chat.markdownRenderer.addPrToHeader')).toBeNull();
  });

  it.each([
    URL,
    'https://github.com/o/r/issues/7',
    'https://github.com/o/r/pull/new/main',
    'http://github.com/o/r/pull/7',
    'https://git.example.com/g/r/-/issues/7',
  ])('does not offer association for %s', (url) => {
    render(<UserMessageUrlLink url={url} sessionId="session-a" />);
    fireEvent.contextMenu(screen.getByRole('link'));
    expect(screen.queryByText('chat.markdownRenderer.addPrToHeader')).toBeNull();
  });

  it('disables an existing association even on a PR subpage', () => {
    prState.refs = [{ owner: 'o', repo: 'r', prNumber: 7, removedAt: null } as SessionPrRef];
    render(
      <UserMessageUrlLink url="https://github.com/o/r/pull/7/commits" sessionId="session-a" />,
    );
    fireEvent.contextMenu(screen.getByRole('link'));
    const item = screen.getByText('chat.markdownRenderer.prAlreadyInHeader') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    fireEvent.click(item);
    expect(prState.manage).not.toHaveBeenCalled();
  });

  // A saved fourth association is not visible: use the server ordering rather
  // than the pre-write cache, on both local and device-link paths.
  it.each(['local', 'remote'])(
    'reports a saved fourth PR without claiming visibility (%s)',
    async (source) => {
      const pinned = [1, 2, 3].map(
        (prNumber) => ({ owner: 'o', repo: 'r', prNumber, pinned: true }) as SessionPrRef,
      );
      const added = { owner: 'o', repo: 'r', prNumber: 7 } as SessionPrRef;
      prState.refs = pinned;
      if (source === 'remote') {
        prState.sticky = 'host-a';
        prState.remote.mockResolvedValueOnce([...pinned, added]);
      } else prState.manage.mockResolvedValueOnce([...pinned, added]);
      render(<UserMessageUrlLink url="https://github.com/o/r/pull/7" sessionId="session-a" />);
      fireEvent.contextMenu(screen.getByRole('link'));
      fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith('chat.markdownRenderer.prSavedNotInHeader'),
      );
      expect(toast.success).not.toHaveBeenCalled();
      prState.refs = [...pinned, added];
      fireEvent.contextMenu(screen.getByRole('link'));
      const item = screen.getByText(
        'chat.markdownRenderer.prAssociatedNotInHeader',
      ) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(screen.queryByText('chat.markdownRenderer.prAlreadyInHeader')).toBeNull();
    },
  );

  it('keeps the legacy success fallback when a remote host returns no list', async () => {
    prState.sticky = 'host-a';
    prState.remote.mockResolvedValueOnce(undefined);
    render(<UserMessageUrlLink url="https://github.com/o/r/pull/7" sessionId="session-a" />);
    fireEvent.contextMenu(screen.getByRole('link'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('chat.markdownRenderer.prAddedToHeader'),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['session', 'sticky'] as const)(
    'routes remote writes using %s ownership without local fallback',
    async (source) => {
      prState.session =
        source === 'session' ? { id: 'session-a', deviceLinkDeviceId: 'host-a' } : null;
      prState.sticky = source === 'sticky' ? 'host-a' : 'other-host';
      render(<UserMessageUrlLink url="https://github.com/o/r/pull/7" sessionId="session-a" />);
      fireEvent.contextMenu(screen.getByRole('link'));
      fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
      await waitFor(() =>
        expect(prState.remote).toHaveBeenCalledWith('host-a', 'git-context:pr-refs:manage', [
          { sessionId: 'session-a', action: 'add', url: 'https://github.com/o/r/pull/7' },
        ]),
      );
      expect(prState.manage).not.toHaveBeenCalled();
      expect(prState.get).not.toHaveBeenCalled();
      expect(prState.invalidate).toHaveBeenCalledWith('session-a');
    },
  );

  it('uses the resolved task device when the list cache is absent', async () => {
    prState.session = null;
    prState.get.mockResolvedValue({ id: 'session-a', deviceLinkDeviceId: 'resolved-host' });
    render(<UserMessageUrlLink url="https://github.com/o/r/pull/7" sessionId="session-a" />);
    fireEvent.contextMenu(screen.getByRole('link'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
    await waitFor(() =>
      expect(prState.remote).toHaveBeenCalledWith('resolved-host', 'git-context:pr-refs:manage', [
        { sessionId: 'session-a', action: 'add', url: 'https://github.com/o/r/pull/7' },
      ]),
    );
    expect(prState.manage).not.toHaveBeenCalled();
  });

  it('does not write locally when task ownership cannot be resolved', async () => {
    prState.session = null;
    render(<UserMessageUrlLink url="https://github.com/o/r/pull/7" sessionId="session-a" />);
    fireEvent.contextMenu(screen.getByRole('link'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('ccAgent.gitContext.pr.manage.errors.failed'),
    );
    expect(prState.manage).not.toHaveBeenCalled();
    expect(prState.remote).not.toHaveBeenCalled();
  });

  it.each([
    ['ALREADY_EXISTS', 'duplicate'],
    ['INVALID_PARAMS', 'invalidUrl'],
    ['PRECONDITION_FAILED', 'verifyFailed'],
  ])('reports %s without restoring a removed association', async (code, key) => {
    prState.manage.mockRejectedValueOnce(Object.assign(new Error('failure'), { code }));
    render(<UserMessageUrlLink url="https://github.com/o/r/pull/7" sessionId="session-a" />);
    fireEvent.contextMenu(screen.getByRole('link'));
    fireEvent.click(screen.getByText('chat.markdownRenderer.addPrToHeader'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(`ccAgent.gitContext.pr.manage.errors.${key}`),
    );
    expect(prState.manage).toHaveBeenCalledTimes(1);
  });
});
