import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { REMOTE_DESKTOP_CHANNEL, DeviceLinkError } from '@cindy/device-link';
import { REMOTE_VIEWER, type RemoteViewerTarget } from '../../shared/remoteDesktopViewer.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { getSelfDeviceId, remoteInvoke } from '../device-link/index.js';
import { loadDesktopIceServers } from '../remote-desktop/iceConfig.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedTopLevelCindyRendererEvent,
  isTrustedCindyRendererWindow,
} from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { ResourceUsageWindowController } from '../resource-usage-window/controller.js';
import { createResourceUsageWindow } from '../resource-usage-window/window.js';
import type { SupportedLocale } from '../../shared/locale.js';
import { t } from '../i18n.js';
import { markRemoteDesktopViewer } from './registry.js';
import { extractIpcError } from '../../shared/ipcError.js';
import { RemoteViewerConnection } from './connection.js';

type Entry = {
  window: BrowserWindow | null;
  controller: ResourceUsageWindowController;
  connection: RemoteViewerConnection;
};

/** Reuses the existing auxiliary-window lifecycle. One window per target plus
 * one unbound prewarmed shell; no capture, link or input during prewarming.
 */
export class RemoteDesktopViewerWindows {
  private entries = new Set<Entry>();
  private locale: SupportedLocale | null = null;
  constructor(private readonly isOpenSender: (sender: WebContents) => boolean) {}
  prewarm(): void {
    if (![...this.entries].some((e) => e.connection.target === null))
      this.create().controller.prewarm();
  }
  open(sender: WebContents, target: RemoteViewerTarget): void {
    if (
      !this.isOpenSender(sender) ||
      !getAppCapabilities().canUseDeviceLink ||
      isAppSessionBoundaryPending()
    )
      throwIpcError('PERMISSION_DENIED', 'Remote desktop unavailable');
    if (
      !target ||
      typeof target.deviceId !== 'string' ||
      !target.deviceId.trim() ||
      target.deviceId.length > 256 ||
      target.deviceId === getSelfDeviceId() ||
      typeof target.name !== 'string' ||
      target.name.length > 256
    )
      throwIpcError('INVALID_PARAMS', 'Invalid remote desktop target');
    let entry = [...this.entries].find((e) => e.connection.target?.deviceId === target.deviceId);
    if (!entry) entry = [...this.entries].find((e) => !e.connection.target) ?? this.create();
    if (!entry.connection.active)
      entry.connection.bind({ deviceId: target.deviceId, name: target.name });
    entry.controller.open(sender);
    // The spare shell is created off the next click path, never connects to a peer.
    this.prewarm();
  }
  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    for (const e of this.entries) e.controller.setLocale(locale);
  }
  reset(): void {
    for (const e of this.entries) {
      e.connection.deactivate();
      e.controller.dispose();
    }
    this.entries.clear();
  }
  private requestClose(entry: Entry): void {
    const win = entry.window;
    if (!win || win.isDestroyed()) return;
    if (!entry.connection.active) {
      entry.controller.close(win.webContents);
      return;
    }
    win.webContents.send(REMOTE_VIEWER.CLOSE_REQUESTED, entry.connection.generation);
  }
  private create(): Entry {
    const connection = new RemoteViewerConnection({
      owner: activeOwnerScopeKey,
      readClipboard: () => clipboard.readText(),
      writeClipboard: (value) => clipboard.writeText(value),
      request: async (device, request, check) => {
        check();
        if (!getAppCapabilities().canUseDeviceLink || isAppSessionBoundaryPending())
          throw new Error('DESKTOP_STOPPED');
        try {
          const result = await remoteInvoke(device, REMOTE_DESKTOP_CHANNEL, [request], {
            preSend: () => {
              check();
              if (!getAppCapabilities().canUseDeviceLink || isAppSessionBoundaryPending())
                throw new Error('DESKTOP_STOPPED');
            },
          });
          if (!result.ok)
            throw new Error(
              result.error.code === 'IPC_ERROR' ? result.error.message : result.error.code,
            );
          return result.result;
        } catch (error) {
          if (error instanceof DeviceLinkError) throw new Error(error.code);
          const parsed = extractIpcError(error);
          if (parsed?.code === 'DEVICE_LINK_CONTROL_DISABLED') throw new Error('REMOTE_DISABLED');
          if (parsed)
            throw new Error(
              /^(DESKTOP|CLIPBOARD)_[A-Z_]+$/.test(parsed.message) ? parsed.message : parsed.code,
            );
          throw error;
        }
      },
    });
    const entry: Entry = { window: null, connection, controller: null! };
    entry.controller = new ResourceUsageWindowController({
      isOpenSender: this.isOpenSender,
      // Independent top-level windows do not follow main-window minimize/hide.
      prewarmWork: false,
      activityChannel: REMOTE_VIEWER.ACTIVE,
      activityPayload: () => connection.snapshot(),
      localeChannel: REMOTE_VIEWER.LOCALE,
      onCloseRequested: () => this.requestClose(entry),
      resolveNativeTitle: () =>
        [connection.target?.name, t('remoteDesktop.title')].filter(Boolean).join(' · '),
      onActivityChanged: (win, active) => {
        connection.setActive(active);
        if (!active && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(false);
      },
      createWindow: () => {
        const win = createResourceUsageWindow(undefined, {
          title: t('remoteDesktop.title'),
          preload: 'remoteDesktopViewerPreload.js',
          query: 'remoteDesktopViewer',
          hash: '/remote-desktop-viewer',
          width: 1180,
          height: 780,
          minWidth: 720,
          minHeight: 420,
          register: markRemoteDesktopViewer,
        });
        entry.window = win;
        // Local navigation/reloads/crashes immediately retire authority, including in-flight starts.
        win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace) connection.deactivate();
        });
        win.webContents.on('render-process-gone', () => connection.deactivate());
        win.on('closed', () => connection.deactivate());
        win.webContents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.code === 'KeyW' && (input.meta || input.control)) {
            event.preventDefault();
            this.requestClose(entry);
          }
        });
        return win;
      },
    });
    this.entries.add(entry);
    if (this.locale) entry.controller.setLocale(this.locale);
    return entry;
  }
  private entry(event: IpcMainInvokeEvent): Entry {
    if (!isTrustedTopLevelCindyRendererEvent(event))
      throwIpcError('PERMISSION_DENIED', 'Invalid viewer');
    const entry = [...this.entries].find(
      (e) => e.window && !e.window.isDestroyed() && e.window.webContents === event.sender,
    );
    if (!entry || !isTrustedCindyRendererWindow(entry.window))
      throwIpcError('PERMISSION_DENIED', 'Invalid viewer');
    return entry;
  }
  register(): void {
    ipcMain.handle(REMOTE_VIEWER.OPEN, (event, target) => {
      assertTrustedAppRendererEvent(event);
      this.open(event.sender, target);
    });
    ipcMain.handle(REMOTE_VIEWER.STATE, (event) => this.entry(event).connection.snapshot());
    ipcMain.handle(REMOTE_VIEWER.READY, (event) => {
      this.entry(event).controller.markRendererReady(event.sender);
    });
    ipcMain.handle(REMOTE_VIEWER.PRESENTED, (event) => {
      this.entry(event).controller.markPresentationReady(event.sender);
    });
    ipcMain.handle(REMOTE_VIEWER.CLOSE, (event, generation) => {
      const entry = this.entry(event);
      if (generation !== entry.connection.generation) return;
      entry.controller.close(event.sender);
    });
    ipcMain.handle(REMOTE_VIEWER.REQUEST, async (event, generation, request, attempt) => {
      const result = await this.entry(event).connection.request(generation, request, attempt);
      if (!result.ok) throwIpcError('PRECONDITION_FAILED', result.code);
      return result.result;
    });
    ipcMain.handle(REMOTE_VIEWER.CLIPBOARD, async (event, generation, action) => {
      const result = await this.entry(event).connection.clipboard(generation, action);
      if (!result.ok) throwIpcError('PRECONDITION_FAILED', result.code);
    });
    ipcMain.handle(REMOTE_VIEWER.ICE, async (event, generation, attempt) => {
      const entry = this.entry(event);
      try {
        entry.connection.beginMedia(generation, attempt);
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'DESKTOP_VIDEO_STOPPED');
      }
      const result = await loadDesktopIceServers();
      try {
        entry.connection.checkMedia(generation, attempt);
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'DESKTOP_VIDEO_STOPPED');
      }
      return result;
    });
    ipcMain.handle(REMOTE_VIEWER.FULLSCREEN, (event) => {
      const entry = this.entry(event);
      const win = entry.window!;
      win.setFullScreen(!win.isFullScreen());
    });
    ipcMain.handle(REMOTE_VIEWER.INPUT_FOCUS, (event, generation, focused) => {
      const entry = this.entry(event);
      if (typeof focused !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid input focus');
      if (focused) {
        try {
          entry.connection.check(generation);
        } catch {
          throwIpcError('PRECONDITION_FAILED', 'DESKTOP_STOPPED');
        }
      } else if (generation !== entry.connection.generation) return;
      event.sender.setIgnoreMenuShortcuts(focused && entry.window!.isFocused());
    });
  }
}
