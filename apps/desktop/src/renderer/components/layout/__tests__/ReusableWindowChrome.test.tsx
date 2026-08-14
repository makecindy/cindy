// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RsbWindowContext } from '../../../../shared/rightSidebarWindow';

const mocks = vi.hoisted(() => ({
  controlsMounts: 0,
  sidebarVisibilityListener: null as ((payload: { visible: boolean }) => void) | null,
  sidebarTabHandoffListener: null as
    | ((handoff: import('../../../../shared/rightSidebarWindow').RsbWindowTabHandoff) => void)
    | null,
  ghostVisibilityListener: null as ((payload: { visible: boolean }) => void) | null,
  ghostMinimizeListener: null as (() => void) | null,
  ghostMinimizeEnabled: true,
  sidebarShellVisible: undefined as boolean | undefined,
  sidebarShellSessionId: undefined as string | null | undefined,
  sidebarLightboxSessionId: undefined as string | undefined,
  sidebarLightboxMounts: 0,
  sidebarLightboxMountId: undefined as number | undefined,
  initGlobalListeners: vi.fn(),
  importTabSnapshot: vi.fn(),
  minimizeGhostPanel: vi.fn(),
  restoreGhostPanel: vi.fn(),
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: ({
    onMinimize,
    showMinimize = true,
  }: {
    onMinimize?: () => void | Promise<void>;
    showMinimize?: boolean;
  }) => {
    const [mountId] = React.useState(() => ++mocks.controlsMounts);
    return (
      <div data-testid="window-controls" data-mount-id={mountId}>
        {showMinimize && (
          <button
            type="button"
            aria-label="titleBar.minimize"
            onClick={() => void onMinimize?.()}
          />
        )}
      </div>
    );
  },
}));
vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({
  RightSidebarShell: ({
    sessionId,
    shellVisible,
  }: {
    sessionId?: string | null;
    shellVisible?: boolean;
  }) => {
    mocks.sidebarShellSessionId = sessionId;
    mocks.sidebarShellVisible = shellVisible;
    return null;
  },
}));
vi.mock('@/features/device-link/useDeviceLinkRemoteProjects', () => ({
  useDeviceLinkRemoteProjects: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/sidebarCommands', () => ({
  onRequestRightSidebarVisibility: () => vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/executeSidebarCommand', () => ({
  executeSidebarCommand: vi.fn(),
}));
vi.mock('@/features/right-sidebar/store', () => ({
  closeTab: vi.fn(),
  getBucket: () => ({ activeTabId: null }),
  getTabSnapshot: vi.fn(() => null),
  importTabSnapshot: mocks.importTabSnapshot,
}));
vi.mock('@/cindy-brain/ghostPanels', () => ({
  ensureGhostPanelsRegistered: vi.fn(),
  useGhostPanelsSync: vi.fn(),
}));
vi.mock('@/cindy-brain/GhostMediaLightboxHost', () => ({
  GhostMediaLightboxHost: ({ sessionId }: { sessionId?: string }) => {
    const [mountId] = React.useState(() => ++mocks.sidebarLightboxMounts);
    mocks.sidebarLightboxSessionId = sessionId;
    mocks.sidebarLightboxMountId = mountId;
    return null;
  },
}));
vi.mock('@/cindy-brain/ghostPanelBody', () => ({
  GhostChipPanelBody: () => null,
  GhostPanelError: () => null,
}));
vi.mock('@/cindy-brain/installErrorKey', () => ({ ghostInstallErrorKey: () => 'error' }));
vi.mock('@/cindy-brain/runtimeStates', () => ({ useGhostRuntimeState: () => 'running' }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => [
    {
      enabled: true,
      manifest: {
        id: 'test-ghost',
        name: 'Test Ghost',
        panel: {
          title: 'Test Panel',
          ...(mocks.ghostMinimizeEnabled
            ? {}
            : { systemButtons: { minimize: false } }),
        },
      },
    },
  ],
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(() => Promise.resolve(false)) }),
}));
vi.mock('@/hooks/useAppShortcut', () => ({ useAppShortcut: vi.fn() }));
vi.mock('@/hooks/useCloseWindowShortcut', () => ({ useCloseShortcutShellOwner: vi.fn() }));
vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ effectiveLocale: 'en', setLocale: vi.fn() }),
}));
vi.mock('@/lib/ghostPanelWindow', () => ({ getGhostPanelWindowGhostId: () => 'test-ghost' }));
vi.mock('@/lib/ghostPanelBubbleState', () => ({
  minimizeGhostPanel: mocks.minimizeGhostPanel,
  restoreGhostPanel: mocks.restoreGhostPanel,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { initGlobalListeners: mocks.initGlobalListeners },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/utils/ipcError', () => ({ extractIpcError: () => null }));
vi.mock('lucide-react', () => ({
  PanelRight: () => null,
  Minus: () => null,
  PictureInPicture2: () => null,
  Puzzle: () => null,
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { GhostPanelWindowLayout } from '../GhostPanelWindowLayout';
import { SidebarWindowLayout } from '../SidebarWindowLayout';

describe('reusable auxiliary window chrome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.controlsMounts = 0;
    mocks.sidebarVisibilityListener = null;
    mocks.sidebarTabHandoffListener = null;
    mocks.ghostVisibilityListener = null;
    mocks.ghostMinimizeListener = null;
    mocks.ghostMinimizeEnabled = true;
    mocks.sidebarShellVisible = undefined;
    mocks.sidebarShellSessionId = undefined;
    mocks.sidebarLightboxSessionId = undefined;
    mocks.sidebarLightboxMounts = 0;
    mocks.sidebarLightboxMountId = undefined;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        rightSidebarWindow: {
          getContext: vi.fn(() =>
            Promise.resolve({
              sessionId: null,
              workdir: null,
              remoteHostId: null,
              available: false,
            }),
          ),
          onContextChanged: vi.fn(() => vi.fn()),
          onTabHandoff: vi.fn((listener) => {
            mocks.sidebarTabHandoffListener = listener;
            return vi.fn();
          }),
          rendererReady: vi.fn(() => Promise.resolve()),
          presentationReady: vi.fn(() => Promise.resolve()),
          onVisibilityChanged: vi.fn((listener) => {
            mocks.sidebarVisibilityListener = listener;
            return vi.fn();
          }),
          refreshContext: vi.fn(() => Promise.resolve()),
          onCommand: vi.fn(() => vi.fn()),
          close: vi.fn(() => Promise.resolve()),
          setDetached: vi.fn(() => Promise.resolve()),
        },
        ghostPanelWindow: {
          rendererReady: vi.fn(() => Promise.resolve()),
          presentationReady: vi.fn(() => Promise.resolve()),
          onVisibilityChanged: vi.fn((listener) => {
            mocks.ghostVisibilityListener = listener;
            return vi.fn();
          }),
          onCloseRequested: vi.fn(() => vi.fn()),
          onMinimizeRequested: vi.fn((listener) => {
            mocks.ghostMinimizeListener = listener;
            return vi.fn();
          }),
          resolveCloseRequest: vi.fn(() => Promise.resolve()),
          setDetached: vi.fn(() => Promise.resolve()),
        },
        ghosts: { setEnabled: vi.fn(() => Promise.resolve()) },
      },
    });
  });

  afterEach(() => cleanup());

  it('remounts right-sidebar controls when the cached window is hidden', async () => {
    render(<SidebarWindowLayout />);
    const controlsBeforeHide = screen.getByTestId('window-controls');
    controlsBeforeHide.focus();

    await act(async () => mocks.sidebarVisibilityListener?.({ visible: false }));

    const controlsAfterHide = screen.getByTestId('window-controls');
    expect(controlsAfterHide).not.toBe(controlsBeforeHide);
    expect(document.activeElement).not.toBe(controlsAfterHide);
  });

  it('reports the sidebar shell ready without waiting for session context', async () => {
    window.electronAPI.rightSidebarWindow.getContext = vi.fn(
      () => new Promise<RsbWindowContext | null>(() => undefined),
    );

    render(<SidebarWindowLayout />);

    await waitFor(() => {
      expect(window.electronAPI.rightSidebarWindow.rendererReady).toHaveBeenCalledOnce();
      expect(window.electronAPI.rightSidebarWindow.presentationReady).toHaveBeenCalledOnce();
    });
  });

  it('subscribes to tab handoff before reporting presentation ready', async () => {
    const snapshot = {
      sessionId: 'session-a',
      tabs: [{ id: 'tab-a', kind: 'web-browser', state: { url: 'about:blank' } }],
      activeTabId: 'tab-a',
      persistable: false as const,
    };
    window.electronAPI.rightSidebarWindow.presentationReady = vi.fn(async () => {
      mocks.sidebarTabHandoffListener?.({ snapshots: [snapshot] });
    });

    render(<SidebarWindowLayout />);

    await waitFor(() => expect(mocks.importTabSnapshot).toHaveBeenCalledWith(snapshot));
    expect(
      (window.electronAPI.rightSidebarWindow.onTabHandoff as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (window.electronAPI.rightSidebarWindow.presentationReady as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
  });

  it('remounts ghost-panel controls when the cached window is hidden', async () => {
    render(<GhostPanelWindowLayout />);
    const controlsBeforeHide = screen.getByTestId('window-controls');
    controlsBeforeHide.focus();

    await act(async () => mocks.ghostVisibilityListener?.({ visible: false }));

    const controlsAfterHide = screen.getByTestId('window-controls');
    expect(controlsAfterHide).not.toBe(controlsBeforeHide);
    expect(document.activeElement).not.toBe(controlsAfterHide);
  });

  it('uses an icon-only merge-back action for detached plugin windows', async () => {
    render(<GhostPanelWindowLayout />);

    const mergeBack = screen.getByRole('button', { name: 'rightSidebar.window.mergeBack' });
    expect(mergeBack.getAttribute('title')).toBe('rightSidebar.window.mergeBack');
    expect(mergeBack.textContent).not.toContain('rightSidebar.window.mergeBack');
    fireEvent.click(mergeBack);

    expect(window.electronAPI.ghostPanelWindow.setDetached).toHaveBeenCalledWith(
      'test-ghost',
      false,
    );
  });

  it('minimizes a detached plugin window into the main-window Ghost bubble', async () => {
    render(<GhostPanelWindowLayout />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.minimize' }));

    expect(mocks.minimizeGhostPanel).toHaveBeenCalledWith('test-ghost');
    expect(window.electronAPI.ghostPanelWindow.setDetached).toHaveBeenCalledWith(
      'test-ghost',
      false,
    );
    expect(mocks.restoreGhostPanel).not.toHaveBeenCalled();
  });

  it('restores the bubble state when merging the minimized plugin window fails', async () => {
    window.electronAPI.ghostPanelWindow.setDetached = vi.fn(() =>
      Promise.reject(new Error('failed')),
    );
    render(<GhostPanelWindowLayout />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'titleBar.minimize' }));
    });

    expect(mocks.minimizeGhostPanel).toHaveBeenCalledWith('test-ghost');
    expect(mocks.restoreGhostPanel).toHaveBeenCalledWith('test-ghost');
  });

  it('uses the same Ghost bubble action for a native minimize request', async () => {
    render(<GhostPanelWindowLayout />);

    await act(async () => mocks.ghostMinimizeListener?.());

    expect(mocks.minimizeGhostPanel).toHaveBeenCalledWith('test-ghost');
    expect(window.electronAPI.ghostPanelWindow.setDetached).toHaveBeenCalledWith(
      'test-ghost',
      false,
    );
  });

  it('restores right-sidebar tab bodies only after the visible window has fresh context', async () => {
    render(<SidebarWindowLayout />);
    expect(mocks.initGlobalListeners).toHaveBeenCalledWith({ ownsRemoteAuthRetry: false });
    expect(mocks.sidebarShellVisible).toBe(false);

    await act(async () => mocks.sidebarVisibilityListener?.({ visible: true }));
    expect(mocks.sidebarShellVisible).toBe(true);

    await act(async () => mocks.sidebarVisibilityListener?.({ visible: false }));
    expect(mocks.sidebarShellVisible).toBe(false);
  });

  it('passes the active sidebar session to the media lightbox host', async () => {
    window.electronAPI.rightSidebarWindow.getContext = vi.fn(() =>
      Promise.resolve({
        sessionId: 'session-a',
        workdir: '/workdir',
        remoteHostId: null,
        available: true,
      }),
    );

    render(<SidebarWindowLayout />);

    await act(async () => mocks.sidebarVisibilityListener?.({ visible: true }));
    await waitFor(() => expect(mocks.sidebarLightboxSessionId).toBe('session-a'));
  });

  it('does not expose a stale media session while refreshing context after reopen', async () => {
    let resolveFreshContext!: (ctx: RsbWindowContext | null) => void;
    window.electronAPI.rightSidebarWindow.getContext = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: 'session-a',
        workdir: '/workdir-a',
        remoteHostId: null,
        available: true,
      })
      .mockResolvedValueOnce({
        sessionId: 'session-a',
        workdir: '/workdir-a',
        remoteHostId: null,
        available: true,
      })
      .mockImplementationOnce(
        () =>
          new Promise<RsbWindowContext | null>((resolve) => {
            resolveFreshContext = resolve;
          }),
      );

    render(<SidebarWindowLayout />);
    await waitFor(() =>
      expect(window.electronAPI.rightSidebarWindow.getContext).toHaveBeenCalledTimes(1),
    );
    await act(async () => mocks.sidebarVisibilityListener?.({ visible: true }));
    await waitFor(() => expect(mocks.sidebarLightboxSessionId).toBe('session-a'));
    const sessionAMountId = mocks.sidebarLightboxMountId;
    expect(mocks.sidebarShellSessionId).toBe('session-a');

    await act(async () => mocks.sidebarVisibilityListener?.({ visible: false }));
    expect(mocks.sidebarShellSessionId).toBe('session-a');
    expect(mocks.sidebarShellVisible).toBe(false);
    expect(mocks.sidebarLightboxSessionId).toBeUndefined();
    expect(mocks.sidebarLightboxMountId).not.toBe(sessionAMountId);
    const hiddenMountId = mocks.sidebarLightboxMountId;

    act(() => mocks.sidebarVisibilityListener?.({ visible: true }));
    expect(mocks.sidebarShellSessionId).toBe('session-a');
    expect(mocks.sidebarShellVisible).toBe(false);
    expect(mocks.sidebarLightboxSessionId).toBeUndefined();

    await act(async () => {
      resolveFreshContext({
        sessionId: 'session-b',
        workdir: '/workdir-b',
        remoteHostId: null,
        available: true,
      });
    });

    expect(mocks.sidebarShellVisible).toBe(true);
    expect(mocks.sidebarShellSessionId).toBe('session-b');
    expect(mocks.sidebarLightboxSessionId).toBe('session-b');
    expect(mocks.sidebarLightboxMountId).not.toBe(hiddenMountId);
  });

  it('keeps the sidebar safe and clears the old context when refresh temporarily fails', async () => {
    window.electronAPI.rightSidebarWindow.getContext = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: 'session-a',
        workdir: '/workdir-a',
        remoteHostId: null,
        available: true,
      })
      .mockResolvedValueOnce({
        sessionId: 'session-a',
        workdir: '/workdir-a',
        remoteHostId: null,
        available: true,
      })
      .mockRejectedValueOnce(new Error('context unavailable'))
      .mockResolvedValueOnce({
        sessionId: 'session-b',
        workdir: '/workdir-b',
        remoteHostId: null,
        available: true,
      });

    render(<SidebarWindowLayout />);
    await waitFor(() => expect(mocks.sidebarShellSessionId).toBe('session-a'));

    await act(async () => mocks.sidebarVisibilityListener?.({ visible: true }));
    await act(async () => mocks.sidebarVisibilityListener?.({ visible: false }));
    await act(async () => mocks.sidebarVisibilityListener?.({ visible: true }));

    await waitFor(() => expect(mocks.sidebarShellSessionId).toBe('session-b'));
    expect(mocks.sidebarShellVisible).toBe(true);
    expect(mocks.sidebarLightboxSessionId).toBe('session-b');
  });

  it('respects a plugin manifest that disables minimize in the detached window', async () => {
    mocks.ghostMinimizeEnabled = false;

    render(<GhostPanelWindowLayout />);

    expect(screen.queryByRole('button', { name: 'titleBar.minimize' })).toBeNull();
    expect(window.electronAPI.ghostPanelWindow.onMinimizeRequested).not.toHaveBeenCalled();
    expect(mocks.ghostMinimizeListener).toBeNull();
    expect(mocks.minimizeGhostPanel).not.toHaveBeenCalled();
  });
});
