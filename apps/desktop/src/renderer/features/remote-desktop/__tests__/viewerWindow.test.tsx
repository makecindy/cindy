// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { RemoteDesktopViewerWindow } from '../RemoteDesktopViewerWindow';
import type { ViewerSnapshot } from '../viewerController';

const lifecycle = vi.hoisted(() => ({
  created: vi.fn(),
  disposed: vi.fn(),
  releaseInput: vi.fn(),
  setControl: vi.fn(),
  zoom: vi.fn(),
  fit: vi.fn(),
  actualSize: vi.fn(),
  update: null as ((state: ViewerSnapshot) => void) | null,
}));
vi.mock('../viewerController', () => ({
  DesktopViewerController: class {
    constructor(
      private _api: { close(generation: number): Promise<void> },
      _root: HTMLElement,
      update: typeof lifecycle.update,
    ) {
      lifecycle.created();
      lifecycle.update = update;
    }
    dispose = lifecycle.disposed;
    releaseInput = lifecycle.releaseInput;
    setControl = lifecycle.setControl;
    zoom = lifecycle.zoom;
    fit = lifecycle.fit;
    actualSize = lifecycle.actualSize;
    close = () => this._api.close(1);
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
  // The window can be closed before the first controller snapshot arrives.
  act(() => closeRequested(1));
  expect(close).toHaveBeenCalledExactlyOnceWith(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  close.mockClear();
  const connected: ViewerSnapshot = {
    target: null,
    status: 'live',
    error: null,
    controlling: false,
    controlPending: false,
    caps: null,
    displayId: '',
    transport: 'direct',
    latency: null,
    settings: { fps: 30, bitrate: 0, audio: true },
    ready: true,
    preferences: {
      audio: true,
      privacyScreen: false,
      hostMute: false,
      clipboardSync: false,
      lockOnExit: false,
    },
    safety: { privacyActive: false, notice: null, clipboardProgress: null },
    receiveRate: null,
    closing: false,
    credential: null,
    credentialBusy: false,
    credentialNotice: null,
  };
  for (const status of ['connecting', 'reconnecting']) {
    act(() => lifecycle.update?.({ ...connected, ready: false, status }));
    expect(screen.queryByRole('button', { name: i18n.t('remoteDesktop.disconnect') })).toBeNull();
    act(() => closeRequested(1));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    close.mockClear();
  }
  act(() => lifecycle.update?.(connected));
  expect(screen.queryByRole('button', { name: i18n.t('remoteDesktop.takeControl') })).toBeNull();
  expect(screen.queryByRole('button', { name: i18n.t('remoteDesktop.releaseControl') })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  fireEvent.click(screen.getByRole('button', { name: '缩小' }));
  fireEvent.click(screen.getByRole('button', { name: '适应窗口' }));
  expect(lifecycle.zoom.mock.calls).toEqual([['in'], ['out']]);
  expect(lifecycle.fit).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '实际大小（1:1）' }));
  expect(lifecycle.actualSize).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole('button', { name: i18n.t('remoteDesktop.viewer.fullscreen') }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: i18n.t('remoteDesktop.disconnect') })).toBeNull();
  act(() => closeRequested(1));
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
    preferences: {
      audio: true,
      privacyScreen: false,
      hostMute: false,
      clipboardSync: false,
      lockOnExit: false,
    },
    safety: { privacyActive: false, notice: null, clipboardProgress: null },
    receiveRate: null,
    closing: false,
    credential: null,
    credentialBusy: false,
    credentialNotice: null,
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
  const openPanel = (label: string) => {
    fireEvent.click(screen.getByRole('button', { name: label }));
    return within(screen.getByRole('dialog', { name: label }));
  };
  let panel = openPanel('剪贴板');
  expect(
    (
      panel.getByRole('switch', {
        name: i18n.t('remoteDesktop.clipboardSync'),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(panel.getByText(i18n.t('remoteDesktop.settingUnsupported'))).toBeDefined();
  expect(panel.getByText(i18n.t('remoteDesktop.viewer.controlRequired'))).toBeDefined();
  const desktop = screen.getByRole('button', {
    name: i18n.t('remoteDesktop.showDesktop'),
  }) as HTMLButtonElement;
  expect(desktop.disabled).toBe(true);
  fireEvent.click(panel.getByRole('button', { name: i18n.t('remoteDesktop.takeControl') }));
  expect(lifecycle.setControl).toHaveBeenCalledWith(true);
  await act(async () => lifecycle.update?.({ ...state, controlPending: true }));
  expect(panel.getByText(i18n.t('remoteDesktop.viewer.controlPending'))).toBeDefined();
  const supported = {
    ...state,
    controlling: true,
    caps: {
      ...state.caps!,
      privacyScreen: true,
      hostMute: true,
      clipboardSync: true,
      lockOnExit: true,
    },
  };
  await act(async () => lifecycle.update?.(supported));
  expect(desktop.disabled).toBe(false);
  expect(
    (
      panel.getByRole('switch', {
        name: i18n.t('remoteDesktop.clipboardSync'),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  panel = openPanel('安全');
  expect(screen.queryByRole('dialog', { name: '剪贴板' })).toBeNull();
  expect(panel.queryByRole('switch', { name: i18n.t('remoteDesktop.clipboardSync') })).toBeNull();
  expect(
    (
      panel.getByRole('switch', {
        name: i18n.t('remoteDesktop.privacyScreen'),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(lifecycle.releaseInput).toHaveBeenCalled();
  await act(async () => lifecycle.update?.({ ...supported, ready: false }));
  panel = within(screen.getByRole('dialog', { name: '安全' }));
  expect(
    (
      panel.getByRole('switch', {
        name: i18n.t('remoteDesktop.privacyScreen'),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(panel.getAllByText(i18n.t('remoteDesktop.loadingSettings'))).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole('dialog', { name: '安全' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '安全' })),
  );
  openPanel('安全');
  const remotePointer = vi.fn();
  const stage = document.getElementById('stage')!;
  stage.addEventListener('pointerdown', remotePointer);
  fireEvent.pointerDown(stage);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(remotePointer).not.toHaveBeenCalled();
  stage.removeEventListener('pointerdown', remotePointer);
  expect(lifecycle.disposed).not.toHaveBeenCalled();
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
      preferences: {
        audio: true,
        privacyScreen: false,
        hostMute: false,
        clipboardSync: false,
        lockOnExit: false,
      },
      safety: { privacyActive: false, notice: null, clipboardProgress: null },
      receiveRate: null,
      closing: false,
      credential: null,
      credentialBusy: false,
      credentialNotice: null,
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
  const display = screen.getByRole('button', { name: '影音' });
  expect(display.textContent).toBe('');
  expect(screen.getByRole('button', { name: '剪贴板' }).textContent).toBe('');
  expect(screen.getByRole('button', { name: '安全' }).textContent).toBe('');
  expect(lifecycle.disposed).not.toHaveBeenCalled();
  expect(lifecycle.created).toHaveBeenCalledOnce();
  expect(rendererReady).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(lifecycle.disposed).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});
