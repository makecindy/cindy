// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
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
  keys: vi.fn(),
  workspaceAction: vi.fn(async () => {}),
  resolutionModes: vi.fn(async (): Promise<unknown[]> => []),
  fitDisplay: vi.fn(async () => {}),
  restoreDisplay: vi.fn(async () => {}),
  resolution: vi.fn(async () => {}),
  clipboard: vi.fn(async (_action: 'copy' | 'paste') => {}),
  update: null as ((state: ViewerSnapshot) => void) | null,
}));
vi.mock('../viewerController', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewerController')>()),
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
    keys = lifecycle.keys;
    workspaceAction = lifecycle.workspaceAction;
    resolutionModes = lifecycle.resolutionModes;
    fitDisplay = lifecycle.fitDisplay;
    restoreDisplay = lifecycle.restoreDisplay;
    resolution = lifecycle.resolution;
    clipboard = lifecycle.clipboard;
    close = () => this._api.close(1);
  },
}));
const fullscreen = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: fullscreen.value }),
}));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

afterEach(() => {
  fullscreen.value = false;
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
    settings: { fps: 30, quality: 'auto', audio: true },
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
    fittedDisplay: null,
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

it('hides view-only controls and enables desktop actions only after control is confirmed', async () => {
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
    fittedDisplay: null,
    target: { deviceId: 'host', name: 'Windows' },
    ready: true,
    controlling: false,
    controlPending: false,
    status: 'live',
    error: null,
    displayId: 'one',
    transport: 'direct',
    latency: null,
    settings: { fps: 30, quality: 'auto', audio: false },
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
  expect(screen.queryByText(i18n.t('remoteDesktop.viewOnly'))).toBeNull();
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
  expect(panel.queryByRole('button', { name: i18n.t('remoteDesktop.takeControl') })).toBeNull();
  const desktop = screen.getByRole('button', {
    name: i18n.t('remoteDesktop.showDesktop'),
  }) as HTMLButtonElement;
  expect(desktop.disabled).toBe(true);
  await act(async () => lifecycle.update?.({ ...state, controlPending: true }));
  expect(panel.queryByRole('button', { name: i18n.t('remoteDesktop.takeControl') })).toBeNull();
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
  fireEvent.click(desktop);
  expect(lifecycle.keys).toHaveBeenLastCalledWith(['MetaLeft', 'KeyD']);
  // A synthesized Cmd+F3 never reaches Mission Control; F11 is the macOS default.
  await act(async () =>
    lifecycle.update?.({ ...supported, caps: { ...supported.caps, platform: 'darwin' } }),
  );
  fireEvent.click(desktop);
  expect(lifecycle.keys).toHaveBeenLastCalledWith(['F11']);
  // Linux workspace hosts swap the shortcut buttons for host-side window actions, as on Mobile.
  await act(async () =>
    lifecycle.update?.({
      ...supported,
      caps: { ...supported.caps, platform: 'linux', workspaceNavigation: true, omarchyMenu: true },
    }),
  );
  expect(screen.queryByRole('button', { name: i18n.t('remoteDesktop.showDesktop') })).toBeNull();
  expect(screen.queryByRole('button', { name: i18n.t('remoteDesktop.allWindows') })).toBeNull();
  for (const action of ['workspaceLeft', 'workspaceRight', 'omarchyMenu'] as const) {
    fireEvent.click(screen.getByRole('button', { name: i18n.t(`remoteDesktop.${action}`) }));
    expect(lifecycle.workspaceAction).toHaveBeenLastCalledWith(action);
  }
  lifecycle.workspaceAction.mockRejectedValueOnce(new Error('DESKTOP_INPUT_UNSUPPORTED'));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('remoteDesktop.workspaceLeft') }));
  expect(await screen.findByText(i18n.t('remoteDesktop.viewer.actionFailed'))).toBeDefined();
  expect(lifecycle.keys).toHaveBeenCalledTimes(2);
  await act(async () => lifecycle.update?.(supported));
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
      fittedDisplay: null,
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
      settings: { fps: 30, quality: 'auto', audio: false },
    }),
  );
  const toolbar = within(view.container.querySelector('header')!);
  expect(toolbar.getByText('正在控制')).toBeDefined();
  expect(toolbar.getByText(label)).toBeDefined();
});

it('announces an active privacy screen without a banner or toolbar setting markers', async () => {
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
  render(<RemoteDesktopViewerWindow />);
  await act(async () =>
    lifecycle.update?.({
      preferences: {
        audio: true,
        privacyScreen: true,
        hostMute: false,
        clipboardSync: true,
        lockOnExit: false,
      },
      safety: { privacyActive: true, notice: null, clipboardProgress: null },
      receiveRate: null,
      closing: false,
      credential: null,
      credentialBusy: false,
      credentialNotice: null,
      fittedDisplay: null,
      target: null,
      ready: true,
      controlling: true,
      controlPending: false,
      status: 'live',
      error: null,
      caps: null,
      displayId: 'one',
      transport: 'direct',
      latency: null,
      settings: { fps: 30, quality: 'auto', audio: false },
    }),
  );
  expect(document.querySelector('.remote-viewer-feedback')).toBeNull();
  const announcement = screen.getByText(i18n.t('remoteDesktop.privacyActive'));
  expect(announcement.getAttribute('role')).toBe('status');
  expect(announcement.classList.contains('sr-only')).toBe(true);
  for (const name of ['剪贴板', '安全']) {
    expect(screen.getByRole('button', { name }).querySelector('span')).toBeNull();
  }
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

it('reveals the fullscreen toolbar from the top edge and keeps it while macOS covers the edge', async () => {
  fullscreen.value = true;
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
        close: async () => {},
      },
    },
  });
  const { container } = render(<RemoteDesktopViewerWindow />);
  await act(async () => {});
  const toolbar = container.querySelector('.remote-viewer-toolbar')!;
  Object.defineProperty(toolbar, 'offsetHeight', { value: 60 });
  const move = (clientY: number) => fireEvent.pointerMove(window, { clientY });
  expect(toolbar.hasAttribute('data-revealed')).toBe(false);
  move(4);
  expect(toolbar.getAttribute('data-revealed')).toBe('true');
  // The pointer is still over the toolbar (or has left to the macOS menu bar).
  move(70);
  expect(toolbar.getAttribute('data-revealed')).toBe('true');
  move(200);
  expect(toolbar.hasAttribute('data-revealed')).toBe(false);
});
it('releases shortcut capture when the picture input loses focus programmatically', async () => {
  const inputFocus = vi.fn(async () => {});
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: () => () => {},
        onLocale: () => () => {},
        onCloseRequested: () => () => {},
        state: async () => ({ generation: 1 }),
        rendererReady: async () => {},
        presentationReady: async () => {},
        inputFocus,
      },
    },
  });
  const view = render(<RemoteDesktopViewerWindow />);
  await act(async () => {});
  const input = view.container.querySelector<HTMLTextAreaElement>('#keyboard-input')!;
  act(() => input.focus());
  expect(inputFocus).toHaveBeenLastCalledWith(1, true);
  // Ctrl+Alt+Esc and control loss blur the input without focusing another element.
  act(() => input.blur());
  expect(inputFocus).toHaveBeenLastCalledWith(1, false);
});

it('splits display size into a ratio choice and recommended resolutions for this screen', async () => {
  await i18n.changeLanguage('zh-CN');
  // jsdom has no scrollIntoView; Radix Select calls it when its list opens.
  const scrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  onTestFinished(() => {
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });
  Object.defineProperties(window.screen, {
    width: { configurable: true, value: 1512 },
    height: { configurable: true, value: 982 },
  });
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
  lifecycle.resolutionModes.mockResolvedValue([
    { id: 'hd', width: 1920, height: 1080, current: false },
    { id: 'qhd', width: 2560, height: 1440, current: true, native: true },
  ]);
  render(<RemoteDesktopViewerWindow />);
  const state: ViewerSnapshot = {
    target: { deviceId: 'host', name: 'Mac' },
    status: 'live',
    error: null,
    controlling: true,
    controlPending: false,
    caps: {
      version: 1,
      enabled: true,
      canControl: true,
      platform: 'darwin',
      displays: [{ id: 'one', name: 'Display', width: 2560, height: 1440 }],
      displayModes: true,
      viewerDisplay: true,
      viewerDisplayRestore: true,
    },
    displayId: 'one',
    transport: 'direct',
    latency: null,
    settings: { fps: 30, quality: 'auto', audio: false },
    ready: true,
    preferences: {
      audio: false,
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
    fittedDisplay: null,
  };
  await act(async () => lifecycle.update?.(state));
  fireEvent.click(screen.getByRole('button', { name: '影音' }));
  const panel = within(screen.getByRole('dialog', { name: '影音' }));
  const aspect = panel.getByRole('combobox', { name: '画面比例' });
  const resolution = await panel.findByRole('combobox', { name: '电脑分辨率' });
  expect(aspect.textContent).toBe('电脑原始 · 16:9');
  expect(resolution.textContent).toBe('2560 × 1440 · 原生');
  // Each field's hint is announced with its control.
  expect(document.getElementById(aspect.getAttribute('aria-describedby')!)?.textContent).toBe(
    i18n.t('remoteDesktop.viewer.aspectHint'),
  );
  // Choices follow this screen: one already at the computer's ratio needs no other ratio.
  Object.defineProperties(window.screen, {
    width: { configurable: true, value: 1600 },
    height: { configurable: true, value: 900 },
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(aspect.textContent).toBe('电脑原始 · 16:9（推荐）');
  Object.defineProperties(window.screen, {
    width: { configurable: true, value: 1512 },
    height: { configurable: true, value: 982 },
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(aspect.textContent).toBe('电脑原始 · 16:9');
  fireEvent.keyDown(aspect, { key: 'ArrowDown' });
  const choice = await screen.findByRole('option', { name: '本机屏幕 · 1.54:1（推荐）' });
  expect(screen.queryByRole('option', { name: /当前窗口/ })).toBeNull();
  lifecycle.resolutionModes.mockResolvedValue([
    { id: 'fitted:1512x982', width: 1512, height: 982, current: true },
  ]);
  fireEvent.keyDown(choice, { key: 'Enter' });
  await waitFor(() =>
    expect(lifecycle.fitDisplay).toHaveBeenCalledWith(1512, 982, true, undefined, {
      ratio: { width: 1512, height: 982 },
    }),
  );
  await act(async () =>
    lifecycle.update?.({ ...state, fittedDisplay: { width: 1512, height: 982 } }),
  );
  await waitFor(() => expect(resolution.textContent).toBe('1512 × 982 · 与本机一致'));
  expect(aspect.textContent).toBe('本机屏幕 · 1.54:1（推荐）');
  expect(document.getElementById(resolution.getAttribute('aria-describedby')!)?.textContent).toBe(
    i18n.t('remoteDesktop.viewer.resolutionTierHint'),
  );
  fireEvent.keyDown(resolution, { key: 'ArrowDown' });
  fireEvent.keyDown(await screen.findByRole('option', { name: '1210 × 786 · 字更大' }), {
    key: 'Enter',
  });
  await waitFor(() =>
    expect(lifecycle.resolution).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1210, height: 786 }),
    ),
  );
  fireEvent.keyDown(aspect, { key: 'ArrowDown' });
  fireEvent.keyDown(await screen.findByRole('option', { name: '电脑原始 · 16:9' }), {
    key: 'Enter',
  });
  await waitFor(() => expect(lifecycle.restoreDisplay).toHaveBeenCalledOnce());
});

it('explains why a manual clipboard transfer failed and clears it on the next attempt', async () => {
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
      fittedDisplay: null,
      target: { deviceId: 'host', name: 'Mac' },
      ready: true,
      controlling: true,
      controlPending: false,
      status: 'live',
      error: null,
      displayId: 'one',
      transport: 'direct',
      latency: null,
      settings: { fps: 30, quality: 'auto', audio: false },
      caps: {
        version: 1,
        enabled: true,
        canControl: true,
        clipboardContent: true,
        platform: 'darwin',
        displays: [],
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '剪贴板' }));
  const panel = within(screen.getByRole('dialog', { name: '剪贴板' }));
  expect(panel.getByText(i18n.t('remoteDesktop.viewer.clipboardShortcutHint'))).toBeDefined();
  const paste = panel.getByRole('button', { name: i18n.t('remoteDesktop.paste') });
  lifecycle.clipboard.mockRejectedValueOnce(new Error('CLIPBOARD_UNSUPPORTED'));
  fireEvent.click(paste);
  expect(lifecycle.clipboard).toHaveBeenCalledWith('paste');
  const unsupported = i18n.t('remoteDesktop.viewer.clipboardUnsupported');
  await waitFor(() => expect(screen.getByText(unsupported)).toBeDefined());
  fireEvent.click(paste);
  await waitFor(() => expect(screen.queryByText(unsupported)).toBeNull());
  // An earlier queued transfer failing late must not overwrite the latest result.
  let failEarlier!: (error: Error) => void;
  lifecycle.clipboard.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        failEarlier = reject;
      }),
  );
  fireEvent.click(paste);
  fireEvent.click(panel.getByRole('button', { name: i18n.t('remoteDesktop.copy') }));
  await act(async () => failEarlier(new Error('CLIPBOARD_UNSUPPORTED')));
  expect(screen.queryByText(unsupported)).toBeNull();
  // A stopped connection reports itself; no clipboard notice.
  lifecycle.clipboard.mockRejectedValueOnce(new Error('DESKTOP_STOPPED'));
  await act(async () => fireEvent.click(paste));
  expect(screen.queryByText(i18n.t('remoteDesktop.viewer.clipboardPasteFailed'))).toBeNull();
});
