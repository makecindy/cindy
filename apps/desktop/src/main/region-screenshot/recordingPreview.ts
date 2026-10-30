import { app, ipcMain, nativeTheme, screen, type BrowserWindow, type Display, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ResourceUsageWindowController } from '../resource-usage-window/controller';
import { markPlaybackFullscreenWindow } from '../remote-desktop/capturePermissions';
import { getResolvedMainLocale, t } from '../i18n';
import { RECORDING_PREVIEW_CHANNEL as C, validRecordingBytes, type RecordingPreviewDocument } from '../../shared/regionCapture';
import { createScreenshotPageWindow } from './pageWindow';
import { saveRegionRecording } from './save';
import { copyRegionRecording } from './recordingClipboard';
import { createLogger } from '../logger';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, onAppSessionInvalidated } from '../appSessionState';

const log = createLogger('region-screenshot:preview');

/** Only finished clip bytes enter this window; it has no screen or keyboard access. */
export class RecordingPreview {
  private window: BrowserWindow | null = null;
  private ready = false;
  private document: RecordingPreviewDocument | null = null;
  private ownerScope: string | null = null;
  private saving = false;
  private readonly controller: ResourceUsageWindowController;
  private readonly unsubscribeOwner: () => void;

  constructor() {
    this.controller = new ResourceUsageWindowController({
      createWindow: () => {
        this.ready = false;
        const window = createScreenshotPageWindow({
          width: 900, height: 660, minWidth: 480, minHeight: 320,
          frame: false, roundedCorners: true, resizable: true,
          minimizable: true, maximizable: true, fullscreenable: true, skipTaskbar: false,
          icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../resources/icon.png'),
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6',
          preload: 'recordingPreviewPreload.js', query: 'recordingPreview',
        });
        this.window = window;
        markPlaybackFullscreenWindow(window);
        window.on('closed', () => { if (this.window === window) { this.window = null; this.ready = false; } });
        return window;
      },
      prewarmWork: false, pauseWhenHidden: false, activityChannel: C.ACTIVITY,
      isOpenSender: (sender) => sender === this.window?.webContents,
      resolveNativeTitle: () => t('regionScreenshot.live.preview'),
      onBeforeShow: () => {
        // Capture panels leave the captured app active. Activate only when the
        // requested preview is presented, then let the controller focus its window.
        if (process.platform === 'darwin') app.focus({ steal: true });
      },
      onCloseRequested: () => this.close(),
      onUnavailable: () => { this.document = null; },
    });
    this.unsubscribeOwner = onAppSessionInvalidated(() => {
      this.document = null;
      this.ownerScope = null;
      // Destroy the renderer too: an old clip must not remain playable after logout.
      // Do not wait for an outstanding save dialog or clipboard operation.
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
    });
  }

  prewarm(): void { this.controller.prewarm(); }
  dispose(): void { this.unsubscribeOwner(); this.document = null; this.ownerScope = null; this.controller.dispose(); }

  open(bytes: Uint8Array<ArrayBuffer>, format: 'webm' | 'gif', display: Display, ownerScope = activeOwnerScopeKey()): boolean {
    if (this.document || this.saving || isAppSessionBoundaryPending()
      || ownerScope !== activeOwnerScopeKey() || !validRecordingBytes(bytes, format)) return false;
    this.controller.prewarm();
    const window = this.window;
    if (!window || window.isDestroyed()) return false;
    this.ownerScope = ownerScope;
    this.document = { token: randomUUID(), locale: getResolvedMainLocale(), bytes, format };
    const area = screen.getDisplayMatching(display.bounds).workArea;
    const width = Math.min(900, area.width), height = Math.min(660, area.height);
    if (!window.isMaximized()) window.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height });
    this.controller.resetPresentation();
    if (this.ready) window.webContents.send(C.BEGIN, this.document);
    if (this.controller.open(window.webContents)) return true;
    this.document = null;
    return false;
  }

  private owns(event: IpcMainEvent | IpcMainInvokeEvent, token?: unknown): boolean {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents
      && event.senderFrame === event.sender.mainFrame
      && (!this.document || (!isAppSessionBoundaryPending() && this.ownerScope === activeOwnerScopeKey()))
      && (token === undefined || token === this.document?.token);
  }

  private close(): void {
    if (this.saving) return;
    this.document = null;
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(C.END);
    this.controller.close(this.window.webContents);
    this.controller.resetPresentation();
  }

  registerIpc(): void {
    ipcMain.on(C.READY, (event) => {
      if (!this.owns(event)) return;
      this.ready = true;
      this.controller.markRendererReady(event.sender);
      if (this.document) event.sender.send(C.BEGIN, this.document);
    });
    ipcMain.on(C.FAILED, (event) => { if (this.owns(event)) this.controller.rendererFailed(event.sender); });
    ipcMain.on(C.PAINTED, (event, token: unknown) => {
      if (typeof token === 'string' && this.document && this.owns(event, token)) this.controller.markPresentationReady(event.sender);
    });
    ipcMain.on(C.CLOSE, (event, token: unknown) => {
      if (typeof token === 'string' && this.document && this.owns(event, token)) this.close();
    });
    ipcMain.on(C.MINIMIZE, (event, token: unknown) => {
      if (typeof token === 'string' && this.document && this.owns(event, token)) this.window?.minimize();
    });
    ipcMain.handle(C.SAVE, async (event, token: unknown) => {
      const doc = this.document;
      if (!doc || this.saving || typeof token !== 'string' || !this.owns(event, token)) return false;
      this.saving = true;
      try { return await saveRegionRecording(doc.bytes, doc.format, () => this.document === doc && this.owns(event, token)); }
      finally { this.saving = false; }
    });
    ipcMain.handle(C.COPY, async (event, token: unknown) => {
      const doc = this.document;
      if (!doc || this.saving || typeof token !== 'string' || !this.owns(event, token)) return false;
      this.saving = true;
      try {
        await copyRegionRecording(doc.bytes, doc.format, () => this.document === doc && this.owns(event, token));
        return true;
      } catch {
        log.warn('recording clipboard copy failed');
        return false;
      } finally { this.saving = false; }
    });
  }
}
