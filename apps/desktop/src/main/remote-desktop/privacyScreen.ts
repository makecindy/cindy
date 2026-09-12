import { app, BrowserWindow, dialog, globalShortcut, screen, session } from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { privacyScreenHtml } from './privacyScreenHtml';

const escapeShortcut = 'Control+Alt+Shift+Escape';
const log = createLogger('remote-desktop:privacy');

/** Ephemeral physical-screen masks, not reusable tool windows.
 * No preload or persistent state. Destroy on
 * every lease end; a local emergency shortcut ends remote control as well.
 */
export class PrivacyScreen {
  private windows: BrowserWindow[] = [];
  private generation = 0;
  private shortcut = false;
  private partitionConfigured = false;
  private confirming = false;
  constructor(
    private readonly excluded: (ids: number[]) => void,
    private readonly stopped: () => void,
  ) {}
  private async confirmExit(window: BrowserWindow, generation: number): Promise<void> {
    if (this.confirming || generation !== this.generation || window.isDestroyed()) return;
    this.confirming = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: t('privacyExit.title'),
        detail: t('privacyExit.detail'),
        buttons: [t('privacyExit.cancel'), t('privacyExit.disconnect')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1 && generation === this.generation) {
        this.stop();
        this.stopped();
      }
    } catch (error) {
      log.warn('privacy exit confirmation failed', error);
    } finally {
      if (generation === this.generation) this.confirming = false;
    }
  }
  async set(enabled: boolean, current: () => boolean): Promise<void> {
    if (!enabled) {
      this.stop();
      return;
    }
    if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
    if (this.windows.length) return;
    const generation = ++this.generation;
    const partition = session.fromPartition('cindy-desktop-privacy', { cache: false });
    if (!this.partitionConfigured) {
      partition.setPermissionCheckHandler(() => false);
      partition.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      partition.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('data:') }),
      );
      this.partitionConfigured = true;
    }
    this.shortcut = globalShortcut.register(escapeShortcut, () => {
      this.stop();
      this.stopped();
    });
    try {
      for (const display of screen.getAllDisplays()) {
        const window = new BrowserWindow({
          ...display.bounds,
          show: false,
          frame: false,
          // A frameless macOS window still gets the platform's rounded mask by
          // default. Disable it so the physical display corners cannot reveal
          // the captured desktop underneath.
          roundedCorners: false,
          enableLargerThanScreen: true,
          acceptFirstMouse: true,
          focusable: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          hasShadow: false,
          // Functional blackout pixels, independent of the application's theme.
          backgroundColor: '#000000',
          webPreferences: {
            session: partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            plugins: false,
            navigateOnDragDrop: false,
            devTools: false,
          },
        });
        this.windows.push(window);
        window.setMenuBarVisibility(false);
        await window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(privacyScreenHtml(t('privacyExit.status'), t('privacyExit.hint')))}`,
        );
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.setContentProtection(true);
        // Mouse and keyboard share a confirmation while the mask stays up.
        window.setIgnoreMouseEvents(false);
        window.webContents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && generation === this.generation) {
            event.preventDefault();
            log.debug('local exit', { input: 'keyboard', windowId: window.id });
            if (!input.isAutoRepeat) void this.confirmExit(window, generation);
          }
        });
        window.webContents.on('before-mouse-event', (event, input) => {
          if (input.type !== 'mouseDown' || generation !== this.generation) return;
          event.preventDefault();
          log.debug('local exit', { input: 'mouse', windowId: window.id });
          void this.confirmExit(window, generation);
        });
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.setAlwaysOnTop(true, 'screen-saver', 1);
        window.on('closed', () => {
          if (generation === this.generation) {
            this.stop();
            this.stopped();
          }
        });
        window.webContents.on('render-process-gone', () => {
          if (generation === this.generation) {
            this.stop();
            this.stopped();
          }
        });
      }
      if (!current() || generation !== this.generation) throw new Error('DESKTOP_LEASE_EXPIRED');
      const ids = this.windows.map((window) => Number(window.getMediaSourceId().split(':')[1]));
      if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
        throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      this.excluded(ids);
      app.focus({ steal: true });
      for (const window of this.windows) {
        const target = screen.getDisplayMatching(window.getBounds()).bounds;
        window.showInactive();
        window.setBounds(target, false);
        window.focus();
        window.webContents.focus();
        log.debug('mask shown', {
          windowId: window.id,
          target,
          actual: window.getBounds(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          alwaysOnTop: window.isAlwaysOnTop(),
        });
      }
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }
  stop(): void {
    this.generation++;
    this.confirming = false;
    const windows = this.windows;
    this.windows = [];
    if (this.shortcut) globalShortcut.unregister(escapeShortcut);
    this.shortcut = false;
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    this.excluded([]);
  }
}
