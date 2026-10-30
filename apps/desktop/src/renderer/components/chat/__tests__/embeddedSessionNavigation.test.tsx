// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openSessionInNewWindow: vi.fn(async () => undefined),
  writeText: vi.fn(async () => undefined),
  error: vi.fn(),
  navigate: vi.fn(),
  remoteSessions: [] as Array<{ id: string; title: string; deviceLinkDeviceId: string; orcaRole: 'lead' | 'worker' | null }>,
  pinSessionOrigin: vi.fn(),
  resolveSessionRoute: vi.fn(async (sessionId: string) => `/cc-agent/${sessionId}`),
  getSession: vi.fn(async (sessionId: string) => ({
    id: sessionId,
    title: `Session ${sessionId}`,
    status: 'active',
  })),
  resolveSessionMessageText: vi.fn(async () => 'Target message\nfull text'),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => values?.name ?? key,
  }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => mocks.remoteSessions,
  useRemoteSessionTitle: () => null,
  getSessionDeviceId: () => undefined,
  remoteProjectsStore: {
    getSessionDeviceId: () => undefined,
    pinSessionOrigin: mocks.pinSessionOrigin,
  },
}));
vi.mock('@/lib/sessionService', () => ({ get: mocks.getSession }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthDeviceId: () => 'this-mac' }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [
    { deviceId: 'this-mac', name: 'Studio Mac', isSelf: true },
    { deviceId: 'phone-1', name: 'Dash iPhone', isSelf: false },
  ],
}));
vi.mock('@/lib/sessionMessageText', () => ({
  resolveSessionMessageText: mocks.resolveSessionMessageText,
}));
vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: mocks.resolveSessionRoute,
  getSessionRouteOwnerId: (route: string) => /^\/cc-agent\/([^/?#]+)/.exec(route)?.[1] ?? null,
}));

import {
  isInteractiveSessionNavigationMode,
  SessionNavigationModeProvider,
  useSidebarTargetSessionId,
} from '@/features/cc-agent/embeddedSessionNavigation';
import { tryHandleNavigationCommand } from '@/lib/navigationCommands';
import { AutomationOriginBadge } from '../AutomationOriginBadge';
import { MessageSourceLabels } from '../MessageSourceLabels';
import { SessionHandoffCard } from '../SessionHandoffCard';
import { SessionLinkChip } from '../SessionLinkChip';

function embedded(children: ReactNode, sidebarTargetSessionId?: string) {
  return (
    <SessionNavigationModeProvider
      mode="sidebar-embedded"
      sidebarTargetSessionId={sidebarTargetSessionId}
    >
      {children}
    </SessionNavigationModeProvider>
  );
}

function splitPane(
  children: ReactNode,
  onSessionNavigate: (targetSessionId: string, routeOwnerSessionId?: string) => void,
) {
  return (
    <SessionNavigationModeProvider mode="split-pane" onSessionNavigate={onSessionNavigate}>
      {children}
    </SessionNavigationModeProvider>
  );
}

function SidebarTargetProbe({ contentSessionId }: { contentSessionId?: string }) {
  return <span data-testid="sidebar-target">{useSidebarTargetSessionId(contentSessionId)}</span>;
}

describe('sidebar-embedded session navigation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.remoteSessions = [];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true, value: { maker: { openSessionInNewWindow: mocks.openSessionInNewWindow } },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: mocks.writeText },
    });
  });

  it('keeps worker content identity while targeting the visible Lead sidebar bucket', () => {
    const { rerender } = render(embedded(<SidebarTargetProbe contentSessionId="worker-a" />));
    expect(screen.getByTestId('sidebar-target').textContent).toBe('worker-a');

    rerender(embedded(<SidebarTargetProbe contentSessionId="worker-a" />, 'lead-a'));
    expect(screen.getByTestId('sidebar-target').textContent).toBe('lead-a');
  });

  it('keeps missing content capability disabled even when a Lead target is provided', () => {
    render(embedded(<SidebarTargetProbe />, 'lead-a'));
    expect(screen.getByTestId('sidebar-target').textContent).toBe('');
  });

  it('opens embedded session links in a separate window without taking the host route', async () => {
    render(embedded(<SessionLinkChip href="xdt-maker://session/session-a" label="Session A" />));

    fireEvent.click(screen.getByRole('button', { name: 'Session A' }));
    await waitFor(() => expect(mocks.openSessionInNewWindow)
      .toHaveBeenCalledWith('session-a', undefined, null));
    const chip = screen.getByText('Session A').closest('[data-inline-reference-chip]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('title')).toBeNull();
    expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  // #7115: same-id copies on two computers must use the linked computer's
  // route metadata as well as its transport origin; unit, real chip activation.
  it('selects the linked remote computer when another snapshot has the same task id', async () => {
    const wrong = { id: 'same', title: 'Wrong', deviceLinkDeviceId: 'mac-a', orcaRole: 'worker' as const };
    const right = { id: 'same', title: 'Right', deviceLinkDeviceId: 'mac-b', orcaRole: null };
    mocks.remoteSessions = [wrong, right];
    render(<SessionLinkChip href="cindy://session/same?device=mac-b" label="Task" />);
    fireEvent.click(screen.getByRole('button', { name: 'Task' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('mac-b', 'same');
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('same', right, { remote: true });
  });

  it.each([{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }])(
    'opens remote task links separately for modifier %j, keeping the message anchor', async (modifier) => {
      const onNavigate = vi.fn();
      render(splitPane(<SessionLinkChip
        href="cindy://session/remote-task?device=remote-mac&message=m%2F1" label="Remote task"
      />, onNavigate));
      fireEvent.click(screen.getByRole('button', { name: 'Remote task' }), modifier);
      await waitFor(() => expect(mocks.openSessionInNewWindow)
        .toHaveBeenCalledWith('remote-task', 'remote-mac', 'm/1'));
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(onNavigate).not.toHaveBeenCalled();
    },
  );

  it('supports Shift+Enter on an inline task chip', async () => {
    render(<SessionLinkChip href="cindy://session/local?device=this-mac" label="Local" />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Local' }), { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(mocks.openSessionInNewWindow).toHaveBeenCalledWith('local', undefined, null));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('supports middle click without navigating the source pane', async () => {
    render(<SessionLinkChip href="cindy://session/local" label="Local" />);
    fireEvent(screen.getByRole('button', { name: 'Local' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => expect(mocks.openSessionInNewWindow).toHaveBeenCalledWith('local', undefined, null));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('offers the same new-window action in the context menu without triggering parent clicks', async () => {
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><SessionLinkChip
      href="cindy://session/remote-task?device=remote-mac" label="Remote task"
    /></div>);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Remote task' }), { clientX: 12, clientY: 24 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ccAgent.sidebar.sessionMenu.openInNewWindow' }));
    await waitFor(() => expect(mocks.openSessionInNewWindow).toHaveBeenCalledWith('remote-task', 'remote-mac', null));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('opens the menu with Shift+F10 and copies the complete link', async () => {
    const href = 'cindy://session/remote-task?device=remote-mac&message=m%2F1';
    render(<SessionLinkChip href={href} label="Remote task" />);
    const link = screen.getByRole('button', { name: 'Remote task' });
    fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyLink' }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(href));
    expect(mocks.openSessionInNewWindow).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('reports a rejected window-open request and leaves the source pane intact', async () => {
    mocks.openSessionInNewWindow.mockRejectedValueOnce(new Error('unavailable'));
    render(<SessionLinkChip href="cindy://session/local" label="Local" />);
    fireEvent.click(screen.getByRole('button', { name: 'Local' }), { shiftKey: true });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('chat.markdownRenderer.openLinkFailed'));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('routes an unmirrored remote history link through its host before resolving the task', async () => {
    render(<SessionLinkChip href="cindy://session/archived-task?device=remote-mac" />);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.pinSessionOrigin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/archived-task', undefined));
    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('remote-mac', 'archived-task');
    expect(mocks.pinSessionOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveSessionRoute.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a link to this computer local', async () => {
    render(<SessionLinkChip href="cindy://session/local-task?device=this-mac" label="Local task" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/local-task', undefined));
    expect(mocks.pinSessionOrigin).not.toHaveBeenCalled();
  });

  it('reports split-pane session navigation before changing the route', async () => {
    const onSessionNavigate = vi.fn();
    render(
      splitPane(
        <SessionLinkChip href="xdt-maker://session/session-target" label="Session target" />,
        onSessionNavigate,
      ),
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/session-target', undefined),
    );
    expect(onSessionNavigate).toHaveBeenCalledWith('session-target', 'session-target');
    expect(onSessionNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0],
    );
  });

  it('reports the canonical Lead owner for a worker deep link', async () => {
    mocks.resolveSessionRoute.mockResolvedValueOnce('/cc-agent/lead-target?worker=worker-target');
    const onSessionNavigate = vi.fn();
    render(
      splitPane(
        <SessionLinkChip href="xdt-maker://session/worker-target" label="Worker target" />,
        onSessionNavigate,
      ),
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        '/cc-agent/lead-target?worker=worker-target',
        undefined,
      ),
    );
    expect(onSessionNavigate).toHaveBeenCalledWith('worker-target', 'lead-target');
  });

  it('cancels pending split-pane link navigation after the source pane unmounts', async () => {
    const pendingRoute = deferred<string>();
    mocks.resolveSessionRoute.mockReturnValueOnce(pendingRoute.promise);
    const onSessionNavigate = vi.fn();
    const view = render(
      splitPane(
        <SessionLinkChip href="xdt-maker://session/session-target" label="Session target" />,
        onSessionNavigate,
      ),
    );

    fireEvent.click(screen.getByRole('button'));
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('session-target', null, { remote: false });
    view.unmount();

    await act(async () => {
      pendingRoute.resolve('/cc-agent/session-target');
      await pendingRoute.promise;
    });

    expect(onSessionNavigate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps the anchored pill visibly clickable and on a single line (embedded=%s)', async (isEmbedded) => {
    const chip = <SessionLinkChip href="cindy://session/session-a?message=message-1" label="Session A" />;
    const { container } = render(isEmbedded ? embedded(chip) : chip);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Session A')).toBeTruthy();
    const link = container.querySelector('button[data-session-message-link]');
    expect(link?.className).toContain('items-center');
    expect(link?.textContent).toBe('Session A');
    expect(container.querySelector('[data-inline-reference-chip]')?.className).toContain('underline');
    expect(
      container.querySelector('[data-inline-reference-chip]')?.parentElement?.className,
    ).toContain('max-w-[min(240px,55vw)]');
  });

  it('renders handoff cards as static content without resolving or navigating', () => {
    render(
      embedded(
        <SessionHandoffCard
          sessionId="session-b"
          title="Session B"
          wake="resumed"
          lastActive={null}
        />,
      ),
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Session B')).toBeTruthy();
    expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('reports the canonical Lead owner for a worker handoff', async () => {
    mocks.resolveSessionRoute.mockResolvedValueOnce('/cc-agent/lead-target?worker=worker-target');
    const onSessionNavigate = vi.fn();
    render(
      splitPane(
        <SessionHandoffCard
          sessionId="worker-target"
          title="Worker target"
          wake="resumed"
          lastActive={null}
        />,
        onSessionNavigate,
      ),
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lead-target?worker=worker-target', {
        state: undefined,
      }),
    );
    expect(onSessionNavigate).toHaveBeenCalledWith('worker-target', 'lead-target');
  });

  it('cancels pending handoff navigation after the source pane unmounts', async () => {
    const pendingRoute = deferred<string>();
    mocks.resolveSessionRoute.mockReturnValueOnce(pendingRoute.promise);
    const onSessionNavigate = vi.fn();
    const view = render(
      splitPane(
        <SessionHandoffCard
          sessionId="session-target"
          title="Session target"
          wake="resumed"
          lastActive={null}
        />,
        onSessionNavigate,
      ),
    );

    fireEvent.click(screen.getByRole('button'));
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('session-target');
    view.unmount();

    await act(async () => {
      pendingRoute.resolve('/cc-agent/session-target');
      await pendingRoute.promise;
    });

    expect(onSessionNavigate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('renders automation origins as static content without scheduling navigation', () => {
    render(
      embedded(
        <AutomationOriginBadge
          automationOrigin={{
            kind: 'scheduler',
            scheduleId: 'schedule-1',
            scheduleName: 'Nightly',
          }}
        />,
      ),
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Nightly')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('renders device, plugin and hook source labels as static content', () => {
    render(
      embedded(
        <>
          <MessageSourceLabels
            sourcePlugin={{ pluginId: 'ghost.notes', name: 'Notes' }}
            sourceDevice={{ deviceId: 'phone-1', platform: 'mobile' }}
          />
          <MessageSourceLabels
            automationOrigin={{
              kind: 'scheduler',
              scheduleId: 'hook:slack-1',
              scheduleName: 'Hook · Team Slack',
            }}
          />
        </>,
      ),
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText('Dash iPhone')).toBeTruthy();
    expect(screen.queryByText('Hook · Team Slack')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('consumes /jump-session without resolving or navigating in embedded mode', async () => {
    const t = ((key: string) => key) as never;
    const onSessionNavigate = vi.fn();

    await expect(
      tryHandleNavigationCommand('/jump-session session-c', {
        navigate: mocks.navigate,
        t,
        allowNavigation: false,
        onSessionNavigate,
      }),
    ).resolves.toBe(true);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();
    expect(onSessionNavigate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('reports /jump-session replacement before navigating from a split pane', async () => {
    const t = ((key: string) => key) as never;
    const onSessionNavigate = vi.fn();
    mocks.resolveSessionRoute.mockResolvedValueOnce('/cc-agent/lead-target?worker=worker-target');

    await expect(
      tryHandleNavigationCommand('/jump-session worker-target', {
        navigate: mocks.navigate,
        t,
        allowNavigation: true,
        onSessionNavigate,
      }),
    ).resolves.toBe(true);

    expect(mocks.getSession).toHaveBeenCalledWith('worker-target');
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith(
      'worker-target',
      expect.objectContaining({ id: 'worker-target' }),
    );
    expect(onSessionNavigate).toHaveBeenCalledWith('worker-target', 'lead-target');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lead-target?worker=worker-target');
    expect(onSessionNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('cancels pending split-pane /jump-session navigation after the source becomes stale', async () => {
    const pendingRoute = deferred<string>();
    mocks.resolveSessionRoute.mockReturnValueOnce(pendingRoute.promise);
    const onSessionNavigate = vi.fn();
    let navigationCurrent = true;
    const navigationPromise = tryHandleNavigationCommand('/jump-session session-target', {
      navigate: mocks.navigate,
      t: ((key: string) => key) as never,
      allowNavigation: true,
      onSessionNavigate,
      isNavigationCurrent: () => navigationCurrent,
    });

    await waitFor(() => expect(mocks.resolveSessionRoute).toHaveBeenCalled());
    navigationCurrent = false;
    await act(async () => {
      pendingRoute.resolve('/cc-agent/session-target');
      await pendingRoute.promise;
      await navigationPromise;
    });

    expect(onSessionNavigate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('cancels stale /jump-session before resolving the route after target lookup', async () => {
    const pendingSession = deferred<{
      id: string;
      title: string;
      status: 'active';
    }>();
    mocks.getSession.mockReturnValueOnce(pendingSession.promise);
    const onSessionNavigate = vi.fn();
    let navigationCurrent = true;
    const navigationPromise = tryHandleNavigationCommand('/jump-session session-target', {
      navigate: mocks.navigate,
      t: ((key: string) => key) as never,
      allowNavigation: true,
      onSessionNavigate,
      isNavigationCurrent: () => navigationCurrent,
    });

    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledWith('session-target'));
    navigationCurrent = false;
    await act(async () => {
      pendingSession.resolve({ id: 'session-target', title: 'Session target', status: 'active' });
      await pendingSession.promise;
      await navigationPromise;
    });

    expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();
    expect(onSessionNavigate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('wires split-pane /jump-session handling through the pane navigation reporter', () => {
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
      'utf8',
    );

    expect(source).toContain('allowNavigation: canNavigateSession');
    expect(source).toContain(
      "onSessionNavigate: navigationMode === 'split-pane' ? onSessionNavigate : undefined",
    );
    expect(source).toContain(
      'onSessionNavigate?.(parentSessionId, getSessionRouteOwnerId(target) ?? parentSessionId)',
    );
    expect(source).toContain(
      'canNavigateSession && session?.parentSessionId && session.forkedAtMessageId',
    );
    expect(source).toContain('const sessionNavigationVersionRef = useRef(0);');
    expect(source).toContain(
      'if (sessionNavigationVersionRef.current !== navigationRequestVersion) return;',
    );
    expect(source).toContain(
      'if (sessionNavigationVersionRef.current !== forkStripNavigationVersion || !recovery.isCurrent()) return;',
    );
    expect(source).toContain('isNavigationCurrent:');
    expect(source).toContain('[navigationMode, sessionId],');
  });

  it('keeps route-owner session links interactive', async () => {
    render(<SessionLinkChip href="xdt-maker://session/session-d" label="Session D" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('session-d', null, { remote: false }));
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/session-d', undefined);
  });

  it('renders anchored links from message content and preserves jump navigation', async () => {
    const { container } = render(
      <SessionLinkChip
        href="cindy://session/session-message?message=client-1"
        label="Session Message"
      />,
    );

    expect(await screen.findByText('Session Message')).toBeTruthy();
    expect(mocks.resolveSessionMessageText).toHaveBeenCalledWith('session-message', 'client-1');
    expect(
      container
        .querySelector('[data-session-message-link] [aria-label]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Message');
    expect(container.querySelector('svg.lucide-message-square-quote')).not.toBeNull();

    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('session-message', null, { remote: false }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/session-message', {
      state: {
        searchJump: {
          kind: 'conversation-search',
          sessionId: 'session-message',
          messageId: 'client-1',
          messageIdKind: 'clientId',
          messageClientId: 'client-1',
        },
      },
    });
  });

  it('caps anchored message labels before mounting them in the DOM', async () => {
    const longMessage = `  ${'x'.repeat(320)}  `;
    mocks.resolveSessionMessageText.mockResolvedValueOnce(longMessage);
    const { container } = render(
      <SessionLinkChip href="cindy://session/session-message?message=client-long" />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('button[data-session-message-link]')?.getAttribute('aria-label'),
      ).toBe(`${'x'.repeat(239)}…`),
    );
    expect(container.textContent).not.toContain('x'.repeat(320));
  });

  it('keeps route-owner handoff and automation actions interactive', async () => {
    const { unmount } = render(
      <SessionHandoffCard
        sessionId="session-e"
        title="Session E"
        wake="created"
        lastActive={null}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/session-e', { state: undefined }),
    );
    unmount();

    mocks.navigate.mockClear();
    render(
      <AutomationOriginBadge
        automationOrigin={{ kind: 'scheduler', scheduleId: 'schedule-2', scheduleName: 'Daily' }}
      />,
    );
    const automationButton = screen.getByRole('button');
    expect(automationButton.getAttribute('data-split-pane-route-action')).toBe('');
    fireEvent.click(automationButton);
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/scheduled?focus=schedule-2');
  });

  it('keeps /jump-session active for route owners', async () => {
    const t = ((key: string) => key) as never;
    await expect(
      tryHandleNavigationCommand('/jump-session session-f', {
        navigate: mocks.navigate,
        t,
      }),
    ).resolves.toBe(true);

    expect(mocks.getSession).toHaveBeenCalledWith('session-f');
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith(
      'session-f',
      expect.objectContaining({ id: 'session-f' }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/session-f');
  });
});

describe('session navigation interaction policy', () => {
  it.each([
    ['route-owner', true],
    ['split-pane', true],
    ['sidebar-embedded', false],
  ] as const)('%s interactive=%s', (mode, expected) => {
    expect(isInteractiveSessionNavigationMode(mode)).toBe(expected);
  });
});
