import { app, BrowserWindow, dialog, screen, session } from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n.desktop';
import { privacyScreenHtml } from './privacyScreenHtml';
import { watchPrivacyInput, type PrivacyInputMonitor } from './privacyInput';
import { loadWindowsTaskbarNative } from '../windowsTaskbarNative';
import { scheduleMainAppPresenceRestore } from '../appPresence';

/** Below 1 so windows behind stay "visible" to macOS; high enough to hide them from people. */
const AWAY_MASK_OPACITY = 0.99;

export type PrivacyInputWatcher = (
  localInput: () => void,
  failed: () => void,
  /** Physical pointer movement: brings the dimmed notice back to full brightness. */
  pointer: () => void,
) => Promise<PrivacyInputMonitor>;

/** Reloading the page restarts its full-brightness period; at most this often. */
const WAKE_INTERVAL_MS = 8_000;

const log = createLogger('remote-desktop:privacy');

/** Ephemeral physical-screen masks, not reusable tool windows.
 * No preload or persistent state. Destroy on
 * every lease end; native physical input opens the local disconnect confirmation.
 */
export class PrivacyScreen {
  private windows: BrowserWindow[] = [];
  private generation = 0;
  private inputGeneration = 0;
  private windowGeneration = 0;
  private partitionConfigured = false;
  private confirming = false;
  private disconnecting = false;
  private holdingInput = false;
  private monitor: PrivacyInputMonitor | null = null;
  /** The page currently shown, reloaded to wake its notice. */
  private page = '';
  private wokenAt = Number.NEGATIVE_INFINITY;
  get active(): boolean {
    return this.windows.length > 0;
  }
  constructor(
    private readonly excluded: (ids: number[]) => void,
    /** Returns false to keep the masks up (the away guard could not lock). */
    private readonly stopped: () => void | false | Promise<void | false>,
    private readonly suspendInput: () => Promise<() => Promise<void>>,
    private readonly watchInput: PrivacyInputWatcher = (localInput, failed, pointer) =>
      watchPrivacyInput(localInput, failed, undefined, pointer),
    private readonly options: {
      /** Page shown on the masks; the away guard uses its own black cover. */
      html?: () => string;
      /**
       * macOS non-activating panels that join full-screen Spaces without Electron's
       * dock hide. The away guard needs this: the owner keeps using Cindy afterwards,
       * and the dock hide left the whole app as a background-only process. Remote
       * desktop keeps its dialog-capable windows and only restores Dock presence.
       */
      nonActivating?: boolean;
      /** Local click recovery when the native input watcher cannot be restarted. */
      heldInput?: () => void;
    } = {},
  ) {}
  private async disconnect(generation: number): Promise<void> {
    if (generation !== this.generation || this.disconnecting) return;
    this.disconnecting = true;
    // Invalidate callbacks immediately, but retain masks and capture exclusions
    // until the controller has finished locking and ended the viewing lease.
    const ending = ++this.generation;
    this.inputGeneration++;
    let keep = false;
    try {
      // The confirming hook rejects injected input, including our lock shortcut.
      // Keep the masks, but wait for hook teardown before asking the OS to lock.
      await this.monitor?.stop();
      this.monitor = null;
      if (ending !== this.generation) return;
      keep = (await this.stopped()) === false;
    } catch {
      log.warn('privacy disconnect failed');
    } finally {
      if (ending === this.generation) {
        this.disconnecting = false;
        if (!keep) this.stop();
      }
    }
  }
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
        resumeInput = undefined;
        await this.disconnect(generation);
      }
    } catch (error) {
      log.warn('privacy exit confirmation failed', error);
      if (generation === this.generation) {
        resumeInput = undefined;
        await this.disconnect(generation);
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
            resumeInput = undefined;
            await this.disconnect(generation);
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
    const windowGeneration = ++this.windowGeneration;
    const windowFailed = () => {
      if (windowGeneration === this.windowGeneration) void this.disconnect(this.generation);
    };
    const created: BrowserWindow[] = [];
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
    const html =
      this.options.html?.() ?? privacyScreenHtml(t('privacyExit.status'), t('privacyExit.hint'));
    const nonActivating = this.options.nonActivating === true && process.platform === 'darwin';
    try {
      const displays = screen.getAllDisplays();
      for (const display of displays) {
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
          // Away masks are very slightly translucent: a fully opaque full-screen window
          // makes macOS report every window behind it as occluded, and Chromium/Electron
          // apps then stop drawing, so Agents behind the cover read a frozen screen
          // (2026-11-06: a click behind the mask changed the page, its pixels did not).
          // A transparent window whose page is opaque is still treated as occluding.
          ...(nonActivating ? { type: 'panel' } : {}),
          // Every macOS privacy screen, including the in-session one: an opaque cover made
          // remote viewers and Agents read frozen Electron windows.
          ...(process.platform === 'darwin' ? { opacity: AWAY_MASK_OPACITY } : {}),
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
        created.push(window);
        if (generation === this.generation) this.windows.push(window);
        // Each mask follows its physical display, including non-captured screens.
        const relayout = (_event: unknown, changed: Electron.Display) => {
          if (window.isDestroyed() || changed.id !== display.id) return;
          try {
            window.setBounds(changed.bounds, false);
          } catch {
            windowFailed();
          }
        };
        screen.on('display-metrics-changed', relayout);
        window.on('closed', () => {
          screen.removeListener('display-metrics-changed', relayout);
          windowFailed();
        });
        window.setMenuBarVisibility(false);
        await window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
        );
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.webContents.on('before-mouse-event', (_event, input) => {
          if (windowGeneration === this.windowGeneration && this.holdingInput &&
              !this.monitor && input.type === 'mouseDown') this.options.heldInput?.();
        });
        window.setContentProtection(true);
        // Remote system injection must reach the app behind this passive mask.
        // Physical input is identified and consumed by the native hook instead.
        window.setIgnoreMouseEvents(true);
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          ...(nonActivating ? { skipTransformProcessType: true } : {}),
        });
        window.setAlwaysOnTop(true, 'screen-saver', 1);
        window.webContents.on('render-process-gone', () => {
          windowFailed();
        });
      }
      // Register the first mask synchronously so display changes during preparation
      // invalidate the lease, including while the Windows shell bridge loads.
      const windowsShell = process.platform === 'win32' ? await loadWindowsTaskbarNative() : null;
      if (!current() || generation !== this.generation) throw new Error('DESKTOP_LEASE_EXPIRED');
      const ids = this.windows.map((window) => Number(window.getMediaSourceId().split(':')[1]));
      if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
        throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      this.excluded(ids);
      this.page = html;
      const monitor = await this.watch(generation);
      if (!current() || generation !== this.generation) {
        monitor.stop();
        throw new Error('DESKTOP_LEASE_EXPIRED');
      }
      this.monitor = monitor;
      for (const [index, window] of this.windows.entries()) {
        const target = screen
          .getAllDisplays()
          .find((display) => display.id === displays[index].id)?.bounds;
        if (!target) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
        window.showInactive();
        window.setBounds(target, false);
        // Chromium can apply its screenshot policy when showing the HWND. Set
        // and read back the exact exclusion policy on the final visible window.
        if (windowsShell && !windowsShell.excludePrivacyMaskFromCapture(window.getNativeWindowHandle()))
          throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
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
      else {
        for (const window of created) if (!window.isDestroyed()) window.destroy();
      }
      throw error;
    }
  }
  private watch(generation: number): Promise<PrivacyInputMonitor> {
    const inputGeneration = ++this.inputGeneration;
    const current = () => generation === this.generation && inputGeneration === this.inputGeneration;
    return this.watchInput(
      () => {
        if (current()) void this.confirmExit(this.windows[0], generation);
      },
      () => {
        if (current()) void this.disconnect(generation);
      },
      () => {
        if (current()) this.wake();
      },
    );
  }

  /**
   * The lock could not be confirmed and the masks stay (docs/product-rules/privacy-screen.md):
   * clicks land on the masks instead of passing through to apps nobody can see.
   */
  holdInput(): void {
    this.holdingInput = true;
    for (const window of this.windows) if (!window.isDestroyed()) window.setIgnoreMouseEvents(false);
  }

  /**
   * Stop watching physical input while keeping the masks, e.g. so the system's
   * verification prompt can receive the owner's typing. Not a failure: the helper's end
   * is detached from this cover first.
   */
  async releaseInput(): Promise<void> {
    const monitor = this.monitor;
    if (!monitor) return;
    this.monitor = null;
    this.inputGeneration++;
    await monitor.stop();
  }

  /** Watch physical input again on the masks still up, so the next touch retries the lock. */
  async rearmInput(): Promise<void> {
    if (!this.windows.length || this.monitor) return;
    const generation = this.generation;
    const monitor = await this.watch(generation);
    if (generation !== this.generation || !this.windows.length) {
      void monitor.stop();
      return;
    }
    this.monitor = monitor;
  }

  /**
   * Let the system's owner-verification prompt show above the masks while it is open.
   * The pop-up-menu level stays above the Dock and menu bar (the floating level showed
   * the Dock during verification) and below the prompt (macOS 27.3, 2026-11-15).
   */
  lowerForSystemPrompt(lowered: boolean): void {
    for (const window of this.windows)
      if (!window.isDestroyed())
        window.setAlwaysOnTop(true, lowered ? 'pop-up-menu' : 'screen-saver', 1);
  }

  /** Native handle Windows anchors its verification prompt to. */
  nativeWindowHandle(): Buffer | undefined {
    const window = this.windows.find((candidate) => !candidate.isDestroyed());
    return window?.getNativeWindowHandle();
  }

  /**
   * Someone moved the pointer: reload the page so its notice is at full brightness again
   * (it dims after ten seconds; docs/product-rules/privacy-screen.md). Never locks.
   */
  wake(): void {
    const now = Date.now();
    if (!this.windows.length || this.confirming || now - this.wokenAt < WAKE_INTERVAL_MS) return;
    this.wokenAt = now;
    void this.replacePage(this.page).catch(() => {});
  }
  /** Swaps the page on every mask, keeping the masks in place. */
  async replacePage(html: string): Promise<void> {
    this.page = html;
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await Promise.all(
      this.windows.filter((window) => !window.isDestroyed()).map((window) => window.loadURL(url)),
    );
  }

  stop(): void {
    this.generation++;
    this.inputGeneration++;
    this.windowGeneration++;
    this.confirming = false;
    this.disconnecting = false;
    this.holdingInput = false;
    this.monitor?.stop();
    this.monitor = null;
    const windows = this.windows;
    this.windows = [];
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    this.excluded([]);
    // visibleOnFullScreen hides the Dock tile and never brings it back by itself.
    if (windows.length && process.platform === 'darwin')
      scheduleMainAppPresenceRestore('privacy-screen-stopped');
  }
}
