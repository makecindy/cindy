// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { RemoteDesktopViewerWindow } from '../RemoteDesktopViewerWindow';
import type { ViewerSnapshot } from '../viewerController';

const lifecycle = vi.hoisted(() => ({
  created: vi.fn(),
  disposed: vi.fn(),
  releaseInput: vi.fn(),
  setControl: vi.fn(),
  update: null as ((state: ViewerSnapshot) => void) | null,
}));
vi.mock('../viewerController', () => ({
  DesktopViewerController: class {
    constructor(_api: unknown, _root: HTMLElement, update: typeof lifecycle.update) {
      lifecycle.created();
      lifecycle.update = update;
    }
    dispose = lifecycle.disposed;
    releaseInput = lifecycle.releaseInput;
    setControl = lifecycle.setControl;
  },
}));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: false }),
}));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('confirms toolbar and native exits, keeps cancellation connected, and discards stale confirmations', async () => {
  await i18n.changeLanguage('zh-CN');
  const close = vi.fn(async () => {});
  let closeRequested!: (generation: number) => void;
  let active!: (state: { generation: number; active: boolean }) => void;
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: (listener: typeof active) => {
          active = listener;
          return () => {};
        },
        onLocale: () => () => {},
        onCloseRequested: (listener: typeof closeRequested) => {
          closeRequested = listener;
          return () => {};
        },
        state: async () => ({ generation: 1 }),
        rendererReady: async () => {},
        presentationReady: async () => {},
        inputFocus: async () => {},
        close,
      },
    },
  });
  render(<RemoteDesktopViewerWindow />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteDesktop.disconnect') }));
  expect(close).not.toHaveBeenCalled();
  expect(lifecycle.releaseInput).toHaveBeenCalled();
  const dialog = within(screen.getByRole('alertdialog'));
  const cancel = dialog.getByRole('button', { name: i18n.t('commonUi.confirmDialog.cancel') });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  act(() => {
    closeRequested(1);
    closeRequested(1);
  });
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: i18n.t('remoteDesktop.disconnect'),
    }),
  );
  expect(close).toHaveBeenCalledExactlyOnceWith(1);
  act(() => closeRequested(1));
  act(() => active({ generation: 2, active: false }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  act(() => closeRequested(1));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it('explains view-only actions and enables the same actions when control is confirmed', async () => {
  await i18n.changeLanguage('zh-CN');
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: () => () => {},
        onLocale: () => () => {},
        onCloseRequested: () => () => {},
        state: async () => ({ generation: 1 }),
        rendererReady: async () => {},
        presentationReady: async () => {},
        inputFocus: async () => {},
      },
    },
  });
  render(<RemoteDesktopViewerWindow />);
  const state: ViewerSnapshot = {
    target: { deviceId: 'host', name: 'Windows' },
    ready: true,
    controlling: false,
    controlPending: false,
    status: 'live',
    error: null,
    displayId: 'one',
    transport: 'direct',
    latency: null,
    settings: { fps: 30, bitrate: 0, audio: false },
    caps: {
      version: 1,
      enabled: true,
      canControl: true,
      clipboardText: true,
      platform: 'win32',
      displays: [],
    },
  };
  await act(async () => lifecycle.update?.(state));
  fireEvent.click(screen.getByRole('button', { name: '操作' }));
  const panel = within(screen.getByRole('complementary', { name: '操作' }));
  expect(panel.getByText(i18n.t('remoteDesktop.viewer.controlRequired'))).toBeDefined();
  expect(panel.queryByText('文字剪贴板')).toBeNull();
  expect(
    panel.getByText(i18n.t('remoteDesktop.viewer.clipboardShortcutHint', { modifier: '⌘' })),
  ).toBeDefined();
  const desktop = panel.getByRole('button', {
    name: i18n.t('remoteDesktop.showDesktop'),
  }) as HTMLButtonElement;
  expect(desktop.disabled).toBe(true);
  fireEvent.click(panel.getByRole('button', { name: i18n.t('remoteDesktop.takeControl') }));
  expect(lifecycle.setControl).toHaveBeenCalledWith(true);
  await act(async () => lifecycle.update?.({ ...state, controlPending: true }));
  expect(panel.getByText(i18n.t('remoteDesktop.viewer.controlPending'))).toBeDefined();
  expect(desktop.disabled).toBe(true);
  await act(async () => lifecycle.update?.({ ...state, controlling: true }));
  expect(desktop.disabled).toBe(false);
  expect(panel.queryByText(i18n.t('remoteDesktop.viewer.controlRequired'))).toBeNull();
});

it.each([
  ['direct', '电脑直连'],
  ['relay', '服务器视频中转'],
  ['screenshots', '服务器截图中转'],
] as const)('shows %s beside control status in the toolbar', async (transport, label) => {
  await i18n.changeLanguage('zh-CN');
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: () => () => {},
        onLocale: () => () => {},
        onCloseRequested: () => () => {},
        state: async () => ({ generation: 1 }),
        rendererReady: async () => {},
        presentationReady: async () => {},
      },
    },
  });
  const view = render(<RemoteDesktopViewerWindow />);
  await act(async () =>
    lifecycle.update?.({
      target: null,
      ready: true,
      controlling: true,
      controlPending: false,
      status: 'live',
      error: null,
      caps: null,
      displayId: 'one',
      transport,
      latency: null,
      settings: { fps: 30, bitrate: 0, audio: false },
    }),
  );
  const toolbar = within(view.container.querySelector('header')!);
  expect(toolbar.getByText('正在控制')).toBeDefined();
  expect(toolbar.getByText(label)).toBeDefined();
});

it('updates translated controls without ending or recreating the viewer connection', async () => {
  await i18n.changeLanguage('en');
  const listeners = new Set<(locale: string) => void>();
  const rendererReady = vi.fn(async () => {});
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: () => () => {},
        onCloseRequested: () => () => {},
        onLocale: (listener: (locale: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        state: async () => ({ generation: 1 }),
        rendererReady,
        presentationReady: async () => {},
      },
    },
  });
  const view = render(<RemoteDesktopViewerWindow />);
  expect(lifecycle.created).toHaveBeenCalledOnce();
  await act(async () => {
    for (const listener of [...listeners]) listener('zh-CN');
  });
  expect(screen.getByRole('button', { name: '操作' })).toBeDefined();
  expect(lifecycle.disposed).not.toHaveBeenCalled();
  expect(lifecycle.created).toHaveBeenCalledOnce();
  expect(rendererReady).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(lifecycle.disposed).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});
