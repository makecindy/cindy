import { app, ipcMain, screen, type BrowserWindow, type IpcMainEvent, type Rectangle } from 'electron';
import { TRAY_EVENT, TRAY_VIEW } from '../../shared/quotaTray.js';
import type { MenubarView } from '../../shared/menubarQuota.js';
import { focusMainWindow } from '../deepLink.js';
import { ResourceUsageWindowController } from '../resource-usage-window/controller.js';
import { createResourceUsageWindow } from '../resource-usage-window/window.js';
import { isTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { QuotaPanelController } from './panelController.js';
import { QUOTA_PANEL_DESIGN, quotaPanelWidth } from '../../shared/quotaPanelDesign.js';
import { sanitizeMenubarSettingsPatch } from '../menubar/settingsStore.js';
import { placeTrayCard } from './trayCardPlacement.js';

function withoutWindowAnimation(changeVisibility: () => void): void {
  // A Chromium hide fade leaves the reused layer transparent if the next show
  // skips its fade. Both transitions must use the same animation policy.
  const flag = 'wm-window-animations-disabled';
  if (app.commandLine.hasSwitch(flag)) return changeVisibility();
  app.commandLine.appendSwitch(flag);
  try {
    changeVisibility();
  } finally {
    app.commandLine.removeSwitch(flag);
  }
}

export class WindowsQuotaPanel {
  private window: BrowserWindow | null = null;
  private active = false;
  private preview = false;
  private pendingHover?: NodeJS.Timeout;
  private hoverWatch?: NodeJS.Timeout;
  private anchor?: Rectangle;
  private contentHeight = 580;
  private readonly panel = new QuotaPanelController({
    publish: view => this.send(view),
    open: () => this.open(this.anchor),
  }, { openNewTask: () => this.openNewTask(), hoverCard: true });
  private readonly controller = new ResourceUsageWindowController({
    createWindow: () => this.createWindow(),
    isOpenSender: sender => sender === this.owner()?.webContents,
    resolveNativeTitle: () => 'Cindy',
    onBeforeShow: win => this.position(win),
    showWindow: win => withoutWindowAnimation(() => {
      if (this.preview) {
        win.showInactive();
        win.moveTop();
      }
      else { win.show(); win.focus(); }
    }),
    hideWindow: win => withoutWindowAnimation(() => win.hide()),
    onActivityChanged: (_win, active) => {
      if (this.active === active) return;
      this.active = active;
      if (active) {
        this.panel.start();
        this.send(this.panel.view);
        this.panel.handle({ type: 'panel', open: true });
      } else {
        this.clearHover();
        this.panel.handle({ type: 'panel', open: false });
      }
    },
    onUnavailable: focusMainWindow,
  });

  constructor(private readonly owner: () => BrowserWindow | null, private readonly openNewTask: () => void) {
    ipcMain.on(TRAY_EVENT, this.onEvent);
  }

  prewarm(): void {
    this.controller.prewarm();
    this.panel.start();
  }

  destroyWindow(): void {
    this.clearHover();
    this.controller.destroyWindow();
  }

  hover(bounds: Rectangle, position: Electron.Point): void {
    if (this.active || this.preview || this.pendingHover) return;
    const anchor = bounds.width && bounds.height && this.contains(bounds, position)
      ? bounds : { x: position.x - 8, y: position.y - 8, width: 16, height: 16 };
    this.pendingHover = setTimeout(() => {
      this.pendingHover = undefined;
      if (this.contains(anchor, screen.getCursorScreenPoint())) this.showHover(anchor);
    }, 100);
  }

  cancelPendingHover(): void {
    clearTimeout(this.pendingHover);
    this.pendingHover = undefined;
  }

  private showHover(anchor: Rectangle): void {
    this.preview = true;
    this.present(anchor);
    let outsideSince = 0;
    this.hoverWatch = setInterval(() => {
      const cursor = screen.getCursorScreenPoint();
      const win = this.window;
      if (this.contains(anchor, cursor) || (win?.isVisible() && this.contains(win.getBounds(), cursor))) {
        outsideSince = 0;
      } else if (!outsideSince) outsideSince = Date.now();
      else if (Date.now() - outsideSince >= 350) this.dismiss();
    }, 120);
  }

  private contains(bounds: Rectangle, point: Electron.Point): boolean {
    return point.x >= bounds.x && point.x < bounds.x + bounds.width &&
      point.y >= bounds.y && point.y < bounds.y + bounds.height;
  }

  private clearHover(): void {
    this.cancelPendingHover();
    clearInterval(this.hoverWatch);
    this.hoverWatch = undefined;
    this.preview = false;
  }

  dismiss(): void {
    this.clearHover();
    this.controller.hideWithOwner();
  }

  open(anchor?: Rectangle): void {
    this.clearHover();
    this.present(anchor);
  }

  private present(anchor?: Rectangle): void {
    this.anchor = anchor;
    const owner = this.owner();
    if (owner && !owner.isDestroyed()) this.controller.open(owner.webContents);
    else focusMainWindow();
  }

  dispose(): void {
    this.clearHover();
    ipcMain.removeListener(TRAY_EVENT, this.onEvent);
    this.controller.dispose();
    this.panel.stop();
  }

  private send(view: MenubarView | null): void {
    if (this.window && isTrustedAppRendererWindow(this.window)) {
      this.position(this.window);
      this.window.webContents.send(TRAY_VIEW, view);
    }
  }

  private readonly onEvent = (event: IpcMainEvent, action: unknown, id: unknown) => {
    const win = this.window;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !isTrustedAppRendererEvent(event)) return;
    if (action === 'ready') {
      this.controller.markRendererReady(event.sender);
      this.send(this.panel.view);
    } else if (action === 'painted') {
      this.controller.markPresentationReady(event.sender);
    } else if (action === 'resize' && typeof id === 'number' && Number.isFinite(id) && id > 0) {
      this.contentHeight = Math.max(160, Math.min(Math.ceil(id), 5000));
      this.position(win);
    } else if (win.isVisible()) {
      if (action === 'open-app') {
        this.controller.hideWithOwner();
        this.panel.handle({ type: 'open-app' });
      } else if (action === 'refresh') {
        this.panel.handle({ type: 'refresh' });
      } else if (action === 'settings' && this.panel.view && !this.panel.view.gate) {
        const patch = sanitizeMenubarSettingsPatch(id);
        // The tray remains the app's entry point. Its visibility/text belong to the OS.
        delete patch.enabled;
        delete patch.statusText;
        this.panel.handle({ type: 'settings', patch });
      } else if (action === 'detail-action' && typeof id === 'string' && this.panel.view?.details[id]) {
        this.panel.handle({ type: 'detail-action', sourceId: id });
        this.dismiss();
      } else if (action === 'open-provider-settings' || action === 'open-remote-control-settings') {
        this.panel.handle({ type: action });
        this.dismiss();
      } else if (action === 'open-session' && typeof id === 'string') {
        const view = this.panel.view;
        if (!view || view.gate || !(view.activities?.some(row => row.sessionId === id) ||
          view.tasks.some(row => row.sessionId === id))) return;
        this.panel.handle({ type: 'open-session', sessionId: id });
        this.controller.hideWithOwner();
      }
    }
  };

  private createWindow(): BrowserWindow {
    const win = createResourceUsageWindow(undefined, {
      title: 'Cindy', preload: 'quotaTrayPreload.js', query: 'quotaTray', hash: '/quota-tray',
      width: 360, height: 516, minWidth: 1, minHeight: 1, transparent: true, register: () => {},
    });
    this.window = win;
    win.setSkipTaskbar(true);
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setResizable(false);
    win.on('focus', () => this.clearHover());
    win.on('hide', () => this.controller.resetPresentation());
    win.on('blur', () => {
      if (win.isVisible() && !win.isFocused()) this.controller.hideWithOwner();
    });
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.clearHover();
        this.active = false;
        this.panel.stop();
      }
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.controller.hideWithOwner();
      }
    });
    return win;
  }

  private position(win: BrowserWindow): void {
    const cursor = screen.getCursorScreenPoint();
    // Without an icon (the low-quota alert opens the card) the pointer stands in for it.
    const anchor = this.anchor?.width && this.anchor.height ? this.anchor : { ...cursor, width: 0, height: 0 };
    const area = screen.getDisplayNearestPoint({ x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }).workArea;
    const zoom = win.webContents.getZoomFactor();
    const width = Math.min(Math.ceil(quotaPanelWidth(this.panel.view?.sources.filter(source => source.fill !== null).length ?? 0) * zoom), area.width);
    const height = Math.min(Math.ceil(this.contentHeight * zoom), Math.floor(area.height * QUOTA_PANEL_DESIGN.metrics.heightShare));
    const next = placeTrayCard({ anchor, area, width, height });
    const current = win.getBounds();
    if (current.x !== next.x || current.y !== next.y || current.width !== width || current.height !== height) {
      win.setBounds(next);
    }
  }
}
