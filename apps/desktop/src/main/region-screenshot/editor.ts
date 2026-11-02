import { app, ipcMain, nativeImage, nativeTheme, screen, type BrowserWindow, type Display, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { activeOwnerScopeKey } from '../appSessionState';
import path from 'node:path';
import { ResourceUsageWindowController } from '../resource-usage-window/controller';
import { getResolvedMainLocale, t } from '../i18n';
import type { SupportedLocale } from '../../shared/locale';
import { onScreenshotTranslationPreferenceChanged, readScreenshotTranslationPreference, writeScreenshotTranslationPreference } from './translationPreferences';
import { isScreenshotTranslationLanguage, resolveScreenshotTranslationLanguage } from '../../shared/screenshotTranslation';
import { createScreenshotPageWindow } from './pageWindow';
import { REGION_SCREENSHOT_EDITOR_CHANNEL as C, isRegionScreenshotAction, validateRegionBitmap, type RegionRect, type RegionScreenshotBitmap, type RegionScreenshotBegin } from '../../shared/regionScreenshot';
import type { RegionScreenshotResult } from './session';

interface EditorDocument {
  ownerScope: string;
  payload: RegionScreenshotBegin;
  display: Display;
  selection: RegionRect;
}

/** Ordinary auxiliary window: hidden prewarm/reuse and bounded recovery use the shared controller. */
export class ScreenshotEditor {
  private window: BrowserWindow | null = null;
  private ready = false;
  private document: EditorDocument | null = null;
  private readonly controller: ResourceUsageWindowController;
  private readonly releaseTranslationPreference: () => void;

  constructor(private readonly onResult: (result: RegionScreenshotResult) => void) {
    this.controller = new ResourceUsageWindowController({
      createWindow: () => {
        this.ready = false;
        const window = createScreenshotPageWindow({
          width: 1000, height: 800, minWidth: 760, minHeight: 420,
          frame: false, roundedCorners: true, resizable: true,
          minimizable: true, maximizable: true, fullscreenable: true, skipTaskbar: false,
          icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../resources/icon.png'),
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6',
          preload: 'regionScreenshotEditorPreload.js', query: 'regionScreenshotEditor',
        });
        this.window = window;
        window.on('closed', () => { if (this.window === window) { this.window = null; this.ready = false; } });
        return window;
      },
      prewarmWork: false,
      // Minimizing or switching a macOS Space must retain the current image and annotations.
      pauseWhenHidden: false,
      activityChannel: C.ACTIVITY,
      isOpenSender: (sender) => sender === this.window?.webContents,
      resolveNativeTitle: () => t('regionScreenshot.live.edit'),
      onCloseRequested: () => this.close(),
      onUnavailable: () => { this.document = null; },
    });
    this.releaseTranslationPreference = onScreenshotTranslationPreferenceChanged((preference) => {
      if (!this.document || !this.window || this.window.isDestroyed()) return;
      this.document.payload.translationPreference = preference;
      if (this.ready) this.window.webContents.send(C.TRANSLATION_LANGUAGE_CHANGED,
        { token: this.document.payload.token, preference });
    });
  }

  prewarm(): void { this.controller.prewarm(); }
  dispose(): void { this.document = null; this.releaseTranslationPreference(); this.controller.dispose(); }

  setLocale(locale: SupportedLocale): void {
    this.controller.setLocale(locale);
    if (!this.document) return;
    this.document.payload.locale = locale;
    if (this.ready && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(C.LOCALE_CHANGED, { token: this.document.payload.token, locale });
    }
  }

  open(image: RegionScreenshotBitmap, display: Display, selection: RegionRect, ownerScope = activeOwnerScopeKey()): boolean {
    // Do not overwrite an unfinished image if another capture reaches Edit.
    if (this.document) return false;
    this.controller.prewarm();
    const window = this.window;
    if (!window || window.isDestroyed()) return false;
    this.document = { display, selection, ownerScope, payload: {
      token: randomUUID(), locale: getResolvedMainLocale(),
      translationPreference: readScreenshotTranslationPreference(),
      viewport: { width: image.width, height: image.height }, scaleFactor: 1,
      frame: image, windows: [], lastRegion: selection, cursor: null,
      safeArea: { x: 0, y: 0, width: image.width, height: image.height },
    } };
    const area = screen.getDisplayMatching(display.bounds).workArea;
    const width = Math.min(1000, area.width), height = Math.min(800, area.height);
    if (!window.isMaximized() && !window.isFullScreen()) window.setBounds({
      x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height,
    });
    this.controller.resetPresentation();
    if (this.ready) window.webContents.send(C.BEGIN, this.document.payload);
    if (this.controller.open(window.webContents)) return true;
    this.document = null;
    return false;
  }

  private owns(event: IpcMainEvent | IpcMainInvokeEvent, token?: unknown): boolean {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents
      && event.senderFrame === event.sender.mainFrame
      && (token === undefined || token === this.document?.payload.token);
  }

  private close(): void {
    const window = this.window;
    this.document = null;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(C.END);
    this.controller.close(window.webContents);
    this.controller.resetPresentation();
  }

  registerIpc(): void {
    ipcMain.handle(C.SET_TRANSLATION_LANGUAGE, async (event, token: unknown, value: unknown) => {
      if (!this.document || typeof token !== 'string' || !this.owns(event, token)) return false;
      await writeScreenshotTranslationPreference(value);
      return !!this.document && this.owns(event, token);
    });
    ipcMain.on(C.MINIMIZE, (event, token: unknown) => {
      if (this.document && typeof token === 'string' && this.owns(event, token)) this.window?.minimize();
    });
    ipcMain.on(C.FAILED, (event) => {
      if (this.owns(event)) this.controller.rendererFailed(event.sender);
    });
    ipcMain.on(C.READY, (event) => {
      if (!this.owns(event)) return;
      this.ready = true;
      this.controller.markRendererReady(event.sender);
      if (this.document) event.sender.send(C.BEGIN, this.document.payload);
    });
    ipcMain.on(C.PAINTED, (event, token: unknown) => {
      if (this.document && this.owns(event, token)) this.controller.markPresentationReady(event.sender);
    });
    ipcMain.on(C.CANCEL, (event, token: unknown) => {
      if (this.document && typeof token === 'string' && this.owns(event, token)) this.close();
    });
    ipcMain.handle(C.EXPORT, (event, token: unknown, raw: unknown) => {
      const doc = this.document;
      if (!doc || typeof token !== 'string' || !this.owns(event, token) || !raw || typeof raw !== 'object') return false;
      const { action, image: rawImage, translationLanguage } = raw as Record<string, unknown>;
      if (!isRegionScreenshotAction(action)) return false;
      if (translationLanguage !== undefined && !isScreenshotTranslationLanguage(translationLanguage)) return false;
      const bitmap = validateRegionBitmap(rawImage, doc.payload.frame);
      if (!bitmap || bitmap.width !== doc.payload.frame.width || bitmap.height !== doc.payload.frame.height) return false;
      const image = nativeImage.createFromBitmap(Buffer.from(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.byteLength), { width: bitmap.width, height: bitmap.height, scaleFactor: 1 });
      if (image.isEmpty()) return false;
      // A retained editor may still have the locale from its original BEGIN payload.
      const target = action === 'translate'
        ? resolveScreenshotTranslationLanguage(readScreenshotTranslationPreference(), getResolvedMainLocale()) : undefined;
      this.close();
      this.onResult({ action, image, display: doc.display, selection: doc.selection, ownerScope: doc.ownerScope, ...(target ? { translationLanguage: target } : {}) });
      return true;
    });
  }
}
