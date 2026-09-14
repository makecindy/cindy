import { app, BrowserWindow, dialog, screen, session } from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { privacyScreenHtml } from './privacyScreenHtml';
import { watchPrivacyInput, type PrivacyInputMonitor } from './privacyInput';

const log = createLogger('remote-desktop:privacy');

/** Ephemeral physical-screen masks, not reusable tool windows.
 * No preload or persistent state. Destroy on
 * every lease end; native physical input opens the local disconnect confirmation.
 */
export class PrivacyScreen {
  private windows: BrowserWindow[] = [];
  private generation = 0;
  private partitionConfigured = false;
  private confirming = false;
  private monitor: PrivacyInputMonitor | null = null;
  constructor(
    private readonly excluded: (ids: number[]) => void,
    private readonly stopped: () => void,
    private readonly suspendInput: () => Promise<() => Promise<void>>,
    private readonly watchInput = watchPrivacyInput,
  ) {}
  private async confirmExit(window: BrowserWindow, generation: number): Promise<void> {
    if (this.confirming || generation !== this.generation || window.isDestroyed()) return;
    this.confirming = true;
    let resumeInput: (() => Promise<void>) | undefined;
    try {
      // No local dialog exists while the old input helper drains/releases.
      // Then the native hook blocks even late injected events before focus moves.
      resumeInput = await this.suspendInput();
      if (generation !== this.generation || !this.monitor) return;
      await this.monitor.confirm();
      if (generation !== this.generation) return;
      window.setFocusable(true);
      window.setIgnoreMouseEvents(false);
      app.focus({ steal: true });
      window.focus();
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
      if (generation === this.generation) {
        this.stop();
        this.stopped();
      }
    } finally {
      if (generation === this.generation) {
        window.setIgnoreMouseEvents(true);
        window.setFocusable(false);
        try {
          // Restore input while the native fence is still up. Only then re-arm
          // local exit; a fresh physical click cannot be lost during resume.
          await resumeInput?.();
          resumeInput = undefined;
          if (generation === this.generation) {
            this.confirming = false;
            await this.monitor?.resume();
          }
        } catch {
          if (generation === this.generation) {
            this.stop();
            this.stopped();
          }
        }
      }
      await resumeInput?.();
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
          focusable: false,
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
        // Remote system injection must reach the app behind this passive mask.
        // Physical input is identified and consumed by the native hook instead.
        window.setIgnoreMouseEvents(true);
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
      const monitor = await this.watchInput(
        () => {
          if (generation === this.generation) void this.confirmExit(this.windows[0], generation);
        },
        () => {
          if (generation === this.generation) {
            this.stop();
            this.stopped();
          }
        },
      );
      if (!current() || generation !== this.generation) {
        monitor.stop();
        throw new Error('DESKTOP_LEASE_EXPIRED');
      }
      this.monitor = monitor;
      for (const window of this.windows) {
        const target = screen.getDisplayMatching(window.getBounds()).bounds;
        window.showInactive();
        window.setBounds(target, false);
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
    this.monitor?.stop();
    this.monitor = null;
    const windows = this.windows;
    this.windows = [];
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    this.excluded([]);
  }
}
