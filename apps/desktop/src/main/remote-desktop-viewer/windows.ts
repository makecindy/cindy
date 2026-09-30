import {
  BrowserWindow,
  clipboard,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { REMOTE_DESKTOP_CHANNEL, DeviceLinkError, parseClipboardContent } from '@cindy/device-link';
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
import { ViewerCredentials } from './credentials.js';
import { readViewerPreferences, writeViewerPreferences } from './preferences.js';
import { resolveDesktopInputBinary } from '../remote-desktop/inputHost.js';
import { ClipboardCounter } from '../remote-desktop/clipboardCounter.js';
import { transferDesktopClipboardContent } from '../remote-desktop/clipboard.js';

async function requestRemote<T>(device: string, request: unknown, check: () => void): Promise<T> {
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
      throw new Error(result.error.code === 'IPC_ERROR' ? result.error.message : result.error.code);
    return result.result as T;
  } catch (error) {
    if (error instanceof DeviceLinkError) throw new Error(error.code);
    const parsed = extractIpcError(error);
    if (parsed?.code === 'DEVICE_LINK_CONTROL_DISABLED') throw new Error('REMOTE_DISABLED');
    if (parsed)
      throw new Error(
        /^(DESKTOP|CLIPBOARD|CREDENTIAL)_[A-Z_]+$/.test(parsed.message)
          ? parsed.message
          : parsed.code,
      );
    throw error;
  }
}

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
    const counter = new ClipboardCounter(resolveDesktopInputBinary);
    const credentials: ViewerCredentials = new ViewerCredentials({
      request: (message, check) => requestRemote(connection.target!.deviceId, message, check),
    });
    const connection: RemoteViewerConnection = new RemoteViewerConnection({
      owner: activeOwnerScopeKey,
      readClipboard: () => clipboard.readText(),
      writeClipboard: (value) => clipboard.writeText(value),
      preferences: readViewerPreferences,
      savePreferences: writeViewerPreferences,
      focused: () => entry.window?.isFocused() === true,
      clipboard: {
        version: (current) => {
          if (!current()) return Promise.reject(new Error('DESKTOP_STOPPED'));
          return counter.read(true);
        },
        stop: () => counter.stop(),
        read: async (current) =>
          JSON.stringify(
            await transferDesktopClipboardContent('copy', undefined, current, () => {}, {
              sync: true,
            }),
          ),
        write: async (json, version, current) => {
          const result = await transferDesktopClipboardContent(
            'paste',
            parseClipboardContent(json),
            current,
            () => {},
            { sync: true, version },
          );
          if (!result || !('version' in result)) throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
          return result.version;
        },
      },
      request: requestRemote,
      credentials,
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
        win.on('blur', () => {
          void connection.focusChanged();
        });
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
    ipcMain.handle(REMOTE_VIEWER.CLOSE, async (event, generation) => {
      const entry = this.entry(event);
      if (generation !== entry.connection.generation) return;
      try {
        await entry.connection.close(generation);
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'DESKTOP_STOP_FAILED');
      }
      if (generation !== entry.connection.generation) return;
      entry.controller.close(event.sender);
    });
    ipcMain.handle(REMOTE_VIEWER.PREFERENCES, async (event, generation, patch) => {
      try {
        return await this.entry(event).connection.preferences(generation, patch);
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'DESKTOP_SETTINGS_FAILED');
      }
    });
    ipcMain.handle(REMOTE_VIEWER.SAFETY, async (event, generation, retry) => {
      if (retry !== undefined && typeof retry !== 'boolean')
        throwIpcError('INVALID_PARAMS', 'Invalid retry');
      try {
        return await this.entry(event).connection.safety(generation, retry);
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'DESKTOP_STOPPED');
      }
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
    ipcMain.handle(REMOTE_VIEWER.CREDENTIAL, async (event, generation, action, enabled) => {
      try {
        return await this.entry(event).connection.credential(generation, action, enabled);
      } catch (error) {
        throwIpcError(
          'PRECONDITION_FAILED',
          error instanceof Error && /^CREDENTIAL_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'CREDENTIAL_UNAVAILABLE',
        );
      }
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
    ipcMain.handle(REMOTE_VIEWER.RESIZE, (event, generation, width, height) => {
      const entry = this.entry(event);
      entry.connection.check(generation);
      if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 32768))
        throwIpcError('INVALID_PARAMS', 'Invalid viewer size');
      const win = entry.window!;
      const resize = () => {
        if (win.isDestroyed()) return;
        try {
          entry.connection.check(generation);
        } catch {
          return;
        }
        const bounds = win.getBounds();
        const content = win.getContentBounds();
        const area = screen.getDisplayMatching(bounds).workArea;
        const [minWidth, minHeight] = win.getMinimumSize();
        const w = Math.min(area.width, Math.max(minWidth, width + bounds.width - content.width));
        const h = Math.min(
          area.height,
          Math.max(minHeight, height + bounds.height - content.height),
        );
        win.setBounds({
          width: w,
          height: h,
          x: Math.round(
            Math.max(area.x, Math.min(area.x + area.width - w, bounds.x + (bounds.width - w) / 2)),
          ),
          y: Math.round(
            Math.max(
              area.y,
              Math.min(area.y + area.height - h, bounds.y + (bounds.height - h) / 2),
            ),
          ),
        });
      };
      const restore = () => {
        if (win.isDestroyed()) return;
        try {
          entry.connection.check(generation);
        } catch {
          return;
        }
        if (win.isMaximized()) {
          win.once('unmaximize', resize);
          win.unmaximize();
        } else resize();
      };
      if (win.isFullScreen()) {
        win.once('leave-full-screen', restore);
        win.setFullScreen(false);
      } else restore();
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
