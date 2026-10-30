import {
  BrowserWindow,
  nativeTheme,
  screen,
  session,
  type Display,
  type Rectangle,
} from 'electron';
import { createLogger } from '../logger';
import { t } from '../i18n';
import { resolveAppThemeIsDark } from '../resolved-app-theme';
import { readWindowThemeSnapshot } from '../window-theme-mode-store';
import { escapeHtml } from './privacyScreenHtml';

const log = createLogger('remote-desktop:overlay');

const HEIGHT = 36;
const INITIAL_WIDTH = 220;
const TOP_MARGIN = 12;
// Renderer crashes / load failures tolerated per lease before giving up.
const MAX_FAILURES = 3;
// Never loaded: the page has no script, so its only way to talk to Main is
// its Disconnect link, which will-navigate cancels and recognizes by this prefix.
const DISCONNECT_URL = 'https://cindy-overlay.invalid/disconnect?peer=';
// Constant code only: every label is rendered into the page markup itself.
const MEASURE_SCRIPT = "Math.ceil(document.querySelector('main').getBoundingClientRect().width)";
// After the viewer's pointer rests this long, the shared cursor is handed back to local clicks.
const VIEWER_POINTER_REST_MS = 1000;
const CONFIRM_WIDTH = 400;
const CONFIRM_MEASURE_SCRIPT =
  "Math.ceil(document.querySelector('main').getBoundingClientRect().height)";
// The confirmation's answers, recognized by will-navigate like the Disconnect link:
// its script-free form submits the revoke checkbox as `?revoke=1` when ticked.
const CHOICE_URL = {
  disconnect: 'https://cindy-overlay.invalid/choose/disconnect',
  cancel: 'https://cindy-overlay.invalid/choose/cancel',
} as const;
/** Ending only this session, or also blocking the device until restored in Settings. */
type DisconnectChoice = 'disconnect' | 'revoke';

export interface ControlledOverlayTarget {
  displayId: string;
  controlling: boolean;
  /** Device id of the viewer holding the lease. */
  peer: string;
  name?: string;
}

/** Isolated data page: mirrors surface / border / text / chip-neutral / Thinking Orange tokens (DESIGN.md §2, §10). */
function overlayHtml(text: string, label: string, dark: boolean, peer: string): string {
  return `<!doctype html><html${dark ? ' class="dark"' : ''}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light;--surface:#ffffff;--border:#d7d7d4;--text-primary:#262626;--accent:#ea6b17;--chip:#e5e5e5}
:root.dark{color-scheme:dark;--surface:#2c2c2a;--border:#3c3c3a;--text-primary:#d4d4d4;--chip:#3c3c3a}
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;cursor:default;-webkit-app-region:drag}
main{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;height:${HEIGHT}px;padding:0 4px 0 16px;border:1px solid var(--border);border-radius:9999px;background:var(--surface);color:var(--text-primary);font-size:14px;font-weight:500;white-space:nowrap}
i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:breathe 1.5s ease-in-out infinite}
span{max-width:320px;overflow:hidden;text-overflow:ellipsis}
a{flex:none;-webkit-app-region:no-drag;display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:9999px;background:var(--chip);color:var(--text-primary);font-size:13px;text-decoration:none;-webkit-user-drag:none}
a:hover{opacity:.8}
@keyframes breathe{0%,100%{opacity:.3}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){i{animation:none}}
</style></head><body><main><i></i><span>${escapeHtml(text)}</span><a href="${escapeHtml(DISCONNECT_URL + encodeURIComponent(peer))}" draggable="false">${escapeHtml(label)}</a></main></body></html>`;
}

/** Isolated disconnect confirmation: mirrors the shared ConfirmDialog's standard presentation
 * (DESIGN.md §4 Dialog & Modal, §2 ConfirmDialog Danger) — an unticked revoke checkbox,
 * Cancel first, Disconnect as the inverse neutral primary that turns danger while revoke
 * is ticked. Pointer-only: the window never takes keyboard focus (see askDisconnect). */
function confirmHtml(
  copy: {
    title: string;
    detail: string;
    revoke: string;
    revokeHint: string;
    cancel: string;
    disconnect: string;
  },
  dark: boolean,
): string {
  return `<!doctype html><html${dark ? ' class="dark"' : ''}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light;--surface:#ffffff;--border:#d7d7d4;--text-primary:#262626;--text-secondary:#737373;--focus:#417cdd}
:root.dark{color-scheme:dark;--surface:#2c2c2a;--border:#3c3c3a;--text-primary:#d4d4d4;--text-secondary:#a3a3a3}
html,body{margin:0;overflow:hidden;background:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;cursor:default;-webkit-app-region:drag}
main{box-sizing:border-box;width:${CONFIRM_WIDTH}px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text-primary)}
h1{margin:0;font-size:16px;font-weight:500;line-height:1.5}
p{margin:8px 0 0;font-size:13px;line-height:1.5;color:var(--text-secondary)}
label{display:flex;align-items:flex-start;gap:8px;margin-top:16px;-webkit-app-region:no-drag}
input{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--text-primary)}
b{display:block;font-size:13px;font-weight:500;line-height:1.5}
small{display:block;font-size:12px;line-height:1.5;color:var(--text-secondary)}
nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin-top:24px}
a,button{-webkit-app-region:no-drag;-webkit-user-drag:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:96px;min-height:36px;margin:0;padding:6px 16px;border:0;border-radius:9999px;font:inherit;font-size:14px;font-weight:500;text-decoration:none;cursor:default;outline:none}
a:focus-visible,button:focus-visible,input:focus-visible{box-shadow:0 0 0 2px var(--focus)}
a:hover,button:hover{opacity:.85}
.cancel{border:1px solid var(--border);color:var(--text-primary)}
.primary{background:var(--text-primary);color:var(--surface)}
form:has(input:checked) .primary{background:#ef4444;color:#ffffff}
</style></head><body><main><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.detail)}</p>
<form action="${CHOICE_URL.disconnect}" method="get"><label><input type="checkbox" name="revoke" value="1"><span><b>${escapeHtml(copy.revoke)}</b><small>${escapeHtml(copy.revokeHint)}</small></span></label>
<nav><a class="cancel" href="${CHOICE_URL.cancel}" draggable="false">${escapeHtml(copy.cancel)}</a><button class="primary" type="submit">${escapeHtml(copy.disconnect)}</button></nav></form></main></body></html>`;
}

/** The device named on the page whose Disconnect link was clicked. */
function linkedPeer(url: string): string | null {
  if (!url.startsWith(DISCONNECT_URL)) return null;
  try {
    return decodeURIComponent(url.slice(DISCONNECT_URL.length)) || null;
  } catch {
    return null;
  }
}

/** Cindy's selected Light / Dark mode, not just the OS appearance. */
function overlayIsDark(): boolean {
  const theme = readWindowThemeSnapshot();
  return resolveAppThemeIsDark(nativeTheme.shouldUseDarkColors, theme.mode, theme.resolvedIsDark);
}

function clamp(bounds: Rectangle, area: Rectangle): Rectangle {
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height);
  return { ...bounds, x: Math.round(x), y: Math.round(y) };
}

/** Local-only reminder that this desktop is shared: above every app, draggable,
 * and excluded from what the viewer receives. Frameless and never focused, it
 * has no close affordance; the lease alone decides its lifetime.
 *
 * Every label change loads a fresh static page whose Disconnect link carries the
 * device it names, so a click always acts on exactly the device on screen. It
 * asks first, with an unticked checkbox to also revoke the device's access.
 * Both are local-only: the viewer cannot see them, its pointer passes through
 * them to what it does see beneath, and the confirmation never takes keyboard
 * focus, so the viewer can neither open nor answer it.
 * (`closable: false` is avoided: on macOS it cancels window-list closes.)
 */
export class ControlledOverlay {
  private window: BrowserWindow | null = null;
  private target: ControlledOverlayTarget | null = null;
  private shown = false;
  private failures = 0;
  /** Page currently loaded, and the one being loaded (superseded loads are ignored). */
  private loadedKey = '';
  private loadingKey = '';
  private loadSeq = 0;
  private placedDisplay: string | null = null;
  private generation = 0;
  private partitionConfigured = false;
  private confirmWindow: BrowserWindow | null = null;
  /** Capture-filter ids of the shown overlay and confirmation (macOS filters them explicitly). */
  private overlayId: number | null = null;
  private confirmId: number | null = null;
  /** Whether the local-only windows currently let clicks through, and when they take them back. */
  private passThrough = false;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  /** Viewer pointer batches currently being injected. */
  private injecting = 0;
  /** Bumped when the overlay stops, so a late completion cannot affect the next lease. */
  private injectEpoch = 0;
  /** Last dragged origin, kept for this app run only. */
  private position: { x: number; y: number } | null = null;

  constructor(
    private readonly excluded: (ids: number[]) => void,
    private readonly revoke: (peer: string) => Promise<void>,
    private readonly disconnect: (peer: string) => void,
  ) {}

  /** Shown on screen: while it is, the main window's own session notice stays hidden. */
  get visible(): boolean {
    return this.shown && this.window !== null && !this.window.isDestroyed();
  }

  /** Idempotent; `null` removes the overlay. */
  update(target: ControlledOverlayTarget | null): void {
    if (!target) {
      // A new lease gets a fresh recreation budget.
      this.failures = 0;
      this.stop();
      return;
    }
    this.target = target;
    const window = this.window;
    if (!window) {
      if (this.failures < MAX_FAILURES) void this.create(this.generation + 1);
      return;
    }
    // Until it is shown, create() renders the latest target itself.
    if (this.shown) {
      const generation = this.generation;
      void this.render(window, generation).catch((error) => this.fail(window, generation, error));
    }
  }

  /** The viewer's pointer positions of one batch, in global DIP, reported as that
   * batch starts being injected (every earlier batch has finished). If any is over the
   * overlay or its confirmation, clicks pass through both for the whole batch; local
   * clicks (on the same system cursor) get them back once a batch stays clear of
   * them, or once the pointer has rested there for a while. The returned callback
   * marks the batch finished: the rest countdown only starts then, so a slow batch
   * never gets its later events through to the hidden windows. */
  viewerPointer(points: { x: number; y: number }[]): () => void {
    const windows = this.localOnlyWindows();
    if (!windows.length) return () => {};
    const over = points.some((point) =>
      windows.some((window) => {
        const { x, y, width, height } = window.getBounds();
        return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
      }),
    );
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    this.setPassThrough(over);
    this.injecting++;
    const epoch = this.injectEpoch;
    let finished = false;
    return () => {
      if (finished || epoch !== this.injectEpoch) return;
      finished = true;
      if (--this.injecting > 0 || !this.passThrough) return;
      this.restTimer = setTimeout(() => this.setPassThrough(false), VIEWER_POINTER_REST_MS);
    };
  }

  /** What the viewer must never reach: the shown overlay and the shown confirmation. */
  private localOnlyWindows(): BrowserWindow[] {
    const confirmation = this.confirmWindow;
    return [
      this.shown ? this.window : null,
      confirmation?.isVisible() ? confirmation : null,
    ].filter((window): window is BrowserWindow => window !== null && !window.isDestroyed());
  }

  private setPassThrough(on: boolean): void {
    if (this.passThrough === on) return;
    this.passThrough = on;
    for (const window of this.localOnlyWindows()) window.setIgnoreMouseEvents(on);
  }

  private publishExcluded(): void {
    this.excluded([this.overlayId, this.confirmId].filter((id): id is number => id !== null));
  }

  stop(): void {
    this.generation++;
    this.target = null;
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    this.passThrough = false;
    this.injecting = 0;
    this.injectEpoch++;
    // An unanswered confirmation never outlives its lease: closing it cancels.
    const confirmation = this.confirmWindow;
    if (confirmation && !confirmation.isDestroyed()) confirmation.destroy();
    const window = this.window;
    if (!window) return;
    this.window = null;
    this.shown = false;
    this.loadedKey = '';
    this.loadingKey = '';
    this.placedDisplay = null;
    if (!window.isDestroyed()) window.destroy();
    this.overlayId = null;
    this.publishExcluded();
  }

  /** The only failure path: counts against the lease that owns this window. */
  private fail(window: BrowserWindow, generation: number, error: unknown): void {
    if (generation !== this.generation || this.window !== window) return;
    log.warn('overlay unavailable', error);
    this.failures++;
    this.stop();
  }

  private display(): Display {
    return (
      screen.getAllDisplays().find((display) => String(display.id) === this.target?.displayId) ??
      screen.getPrimaryDisplay()
    );
  }

  /** Keeps the overlay on the shared display: the capture filter needs it there. */
  private layout(window: BrowserWindow, width = window.getBounds().width): void {
    const display = this.display();
    const current = window.getBounds();
    let origin = { x: current.x, y: current.y };
    if (this.placedDisplay !== String(display.id)) {
      const remembered = this.position;
      const { bounds, workArea } = display;
      origin =
        remembered &&
        remembered.x >= bounds.x &&
        remembered.y >= bounds.y &&
        remembered.x < bounds.x + bounds.width &&
        remembered.y < bounds.y + bounds.height
          ? remembered
          : {
              x: workArea.x + Math.round((workArea.width - width) / 2),
              y: workArea.y + TOP_MARGIN,
            };
      this.placedDisplay = String(display.id);
    }
    const next = clamp({ ...origin, width, height: HEIGHT }, display.bounds);
    if (
      next.x !== current.x ||
      next.y !== current.y ||
      next.width !== current.width ||
      next.height !== current.height
    )
      window.setBounds(next, false);
  }

  /** Loads the page for the current target. Throws on real failure; a load
   * superseded by a newer target or lease returns quietly. */
  private async render(window: BrowserWindow, generation: number): Promise<void> {
    const target = this.target;
    if (!target || generation !== this.generation || this.window !== window) return;
    const text = target.name
      ? t(
          target.controlling ? 'remoteDesktop.controlledByDevice' : 'remoteDesktop.viewedByDevice',
        ).replaceAll('{{name}}', target.name)
      : t(target.controlling ? 'remoteDesktop.beingControlled' : 'remoteDesktop.beingViewed');
    const label = t('remoteDesktop.disconnect');
    const dark = overlayIsDark();
    const key = JSON.stringify([text, label, dark, target.peer]);
    if (key === this.loadedKey) {
      if (this.placedDisplay !== String(this.display().id)) this.layout(window);
      return;
    }
    if (key === this.loadingKey) return;
    const seq = ++this.loadSeq;
    this.loadingKey = key;
    const current = () =>
      seq === this.loadSeq && generation === this.generation && !window.isDestroyed();
    let width: unknown;
    try {
      await window.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(text, label, dark, target.peer))}`,
      );
      if (!current()) return;
      width = await window.webContents.executeJavaScript(MEASURE_SCRIPT);
    } catch (error) {
      // A newer page aborts this load or its measurement; that is not a failure.
      if (!current()) return;
      throw error;
    }
    if (!current()) return;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
      throw new Error('overlay label unavailable');
    this.loadingKey = '';
    this.loadedKey = key;
    this.layout(window, width);
  }

  private async confirmDisconnect(peer: string): Promise<void> {
    const open = this.confirmWindow;
    if (open && !open.isDestroyed()) {
      open.moveTop();
      return;
    }
    try {
      const choice = await this.askDisconnect();
      if (!choice) return;
      // Either way this session ends now; revoking also blocks the device.
      this.disconnect(peer);
      if (choice === 'revoke') await this.revoke(peer);
    } catch (error) {
      log.warn('overlay disconnect failed', error);
    }
  }

  /** Cindy's own confirmation instead of `dialog.showMessageBox`: without a visible
   * parent, macOS runs that alert app-modally, so Main stops serving the lease
   * (heartbeats, injected input) the viewer needs to answer it, and the lease
   * expires. A one-off, top-level, transparent float like the overlay itself,
   * so it is not one of the reusable auxiliary windows (electron-security §3.1).
   * Local-only like the overlay: filtered from capture, passed through by the
   * viewer's pointer, and never focusable, so injected keys cannot answer it
   * either; the local user answers by pointer (no Esc).
   * Resolves `null` for Cancel, closing, lease end and any failure. */
  private askDisconnect(): Promise<DisconnectChoice | null> {
    return new Promise((resolve) => {
      let window: BrowserWindow;
      try {
        window = new BrowserWindow({
          width: CONFIRM_WIDTH,
          height: 160,
          show: false,
          ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          acceptFirstMouse: true,
          focusable: false,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          webPreferences: this.webPreferences(),
        });
      } catch (error) {
        log.warn('disconnect choice unavailable', error);
        resolve(null);
        return;
      }
      this.confirmWindow = window;
      let settled = false;
      const finish = (choice: DisconnectChoice | null) => {
        if (settled) return;
        settled = true;
        if (this.confirmWindow === window) {
          this.confirmWindow = null;
          if (this.confirmId !== null) {
            this.confirmId = null;
            this.publishExcluded();
          }
        }
        if (!window.isDestroyed()) window.destroy();
        resolve(choice);
      };
      window.on('closed', () => finish(null));
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => {
        event.preventDefault();
        if (event.url === CHOICE_URL.cancel) return finish(null);
        const [base, query = ''] = event.url.split('?', 2);
        if (base !== CHOICE_URL.disconnect) return;
        finish(new URLSearchParams(query).get('revoke') === '1' ? 'revoke' : 'disconnect');
      });
      window.webContents.on('render-process-gone', () => finish(null));
      void (async () => {
        const copy = {
          title: t('privacyExit.title'),
          detail: t('remoteDesktop.disconnectChoiceDetail'),
          revoke: t('remoteDesktop.disconnectRevoke'),
          revokeHint: t('remoteDesktop.disconnectRevokeHint'),
          cancel: t('privacyExit.cancel'),
          disconnect: t('remoteDesktop.disconnect'),
        };
        window.setMenuBarVisibility(false);
        window.setContentProtection(true);
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        // Above the overlay, which sits at the same level.
        window.setAlwaysOnTop(true, 'screen-saver', 1);
        await window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(confirmHtml(copy, overlayIsDark()))}`,
        );
        if (settled) return;
        const height: unknown = await window.webContents.executeJavaScript(CONFIRM_MEASURE_SCRIPT);
        if (settled) return;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)
          throw new Error('disconnect choice unavailable');
        const { workArea } = this.display();
        window.setBounds(
          clamp(
            {
              x: workArea.x + Math.round((workArea.width - CONFIRM_WIDTH) / 2),
              y: workArea.y + Math.round((workArea.height - height) / 2),
              width: CONFIRM_WIDTH,
              height,
            },
            workArea,
          ),
          false,
        );
        const id = Number(window.getMediaSourceId().split(':')[1]);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('disconnect choice unavailable');
        // Install the capture filter before the first visible frame.
        this.confirmId = id;
        this.publishExcluded();
        if (this.passThrough) window.setIgnoreMouseEvents(true);
        window.showInactive();
      })().catch((error) => {
        log.warn('disconnect choice unavailable', error);
        finish(null);
      });
    });
  }

  /** The isolated, script-free partition shared by the overlay and its confirmation. */
  private webPreferences(): Electron.WebPreferences {
    const partition = session.fromPartition('cindy-desktop-overlay', { cache: false });
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
    return {
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
    };
  }

  private async create(generation: number): Promise<void> {
    this.generation = generation;
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        width: INITIAL_WIDTH,
        height: HEIGHT,
        show: false,
        // A non-activating panel joins full-screen Spaces without converting
        // the whole app into a UI element (no Dock flicker per session).
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        roundedCorners: false,
        acceptFirstMouse: true,
        focusable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: this.webPreferences(),
      });
    } catch (error) {
      log.warn('overlay unavailable', error);
      this.failures++;
      return;
    }
    this.window = window;
    this.passThrough = false;
    const relayout = () => {
      if (this.window === window && this.shown && !window.isDestroyed()) this.layout(window);
    };
    screen.on('display-metrics-changed', relayout);
    window.on('moved', () => {
      if (this.window !== window || window.isDestroyed()) return;
      this.layout(window);
      const { x, y } = window.getBounds();
      this.position = { x, y };
    });
    window.on('closed', () => {
      screen.removeListener('display-metrics-changed', relayout);
      if (this.window !== window) return;
      this.window = null;
      this.shown = false;
      this.loadedKey = '';
      this.loadingKey = '';
      this.placedDisplay = null;
      this.overlayId = null;
      this.publishExcluded();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
      const peer = linkedPeer(event.url);
      if (peer && this.window === window) void this.confirmDisconnect(peer);
    });
    window.webContents.on('render-process-gone', () =>
      this.fail(window, generation, new Error('overlay renderer gone')),
    );
    try {
      window.setMenuBarVisibility(false);
      window.setContentProtection(true);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      window.setAlwaysOnTop(true, 'screen-saver');
      await this.render(window, generation);
      // Pick up a target that changed while the first page loaded.
      await this.render(window, generation);
      if (generation !== this.generation || window.isDestroyed() || !this.loadedKey) return;
      const id = Number(window.getMediaSourceId().split(':')[1]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('overlay window id unavailable');
      // Install the capture filter before the first visible frame.
      this.overlayId = id;
      this.publishExcluded();
      window.showInactive();
      this.shown = true;
    } catch (error) {
      this.fail(window, generation, error);
    }
  }
}
