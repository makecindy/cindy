/**
 * macOS menu bar quota item: the native helper that presents the shared quota panel.
 *
 * Everything the panel knows and does lives in `quota-overview/`: the overview collects
 * quota and usage, and `QuotaPanelController` assembles the view (task activity, remote-control
 * indicator), raises the low-quota notification and carries out the user's commands. This
 * file is only the macOS presentation: it runs the helper, forwards its messages as commands,
 * and turns the item on or off. Another platform's panel plugs into the same controller.
 */

import os from 'node:os';

import {
  isMenubarSupportedPlatform,
  type MenubarHelperMessage,
  type MenubarState,
} from '../../shared/menubarQuota.js';
import { QuotaPanelController } from '../quota-overview/panelController.js';
import type { QuotaOverviewService } from '../quota-overview/service.js';
import { MacMenubarNativeHost } from './MacMenubarNativeHost.js';

export interface MenubarServiceDeps {
  /** Opens a new task in the main window (the app menu's "New Task" command). */
  openNewTask(): void;
  /** Defaults to the app-wide overview. */
  overview?: QuotaOverviewService;
}

export class MenubarService {
  private readonly host: MacMenubarNativeHost;
  private readonly panel: QuotaPanelController;
  private started = false;

  constructor(deps: MenubarServiceDeps) {
    this.host = new MacMenubarNativeHost({ onMessage: (message) => this.handleHelperMessage(message) });
    this.panel = new QuotaPanelController(
      { publish: (view) => this.host.publish(view), open: () => this.openPanel() },
      {
        openNewTask: deps.openNewTask,
        onSettingsChanged: (settings) => {
          if (!settings.enabled) this.halt();
        },
        ...(deps.overview ? { overview: deps.overview } : {}),
      },
    );
  }

  get state(): MenubarState {
    return { available: true, enabled: this.panel.settings.enabled };
  }

  init(): void {
    if (this.panel.settings.enabled) this.start();
  }

  setEnabled(enabled: boolean): MenubarState {
    const settings = this.panel.updateSettings({ enabled });
    if (settings.enabled) this.start();
    return this.state;
  }

  refreshControlState(): void {
    this.panel.refreshControlState();
  }

  /** Opens the panel under the status item. */
  openPanel(): void {
    if (!this.started) return;
    this.host.open();
  }

  stop(): void {
    this.halt();
    this.host.stop();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.host.resetFailure();
    this.host.prepare();
    this.panel.start();
  }

  private halt(): void {
    if (!this.started) return;
    this.started = false;
    this.panel.stop();
    this.host.suspend();
  }

  private handleHelperMessage(message: MenubarHelperMessage): void {
    if (message.type === 'ready' || message.type === 'error') return;
    this.panel.handle(message);
  }
}

let service: MenubarService | null = null;

export function initMenubarService(deps: MenubarServiceDeps): void {
  if (service || !isMenubarSupportedPlatform(process.platform, os.release())) return;
  service = new MenubarService(deps);
  service.init();
}

export function getMenubarState(): MenubarState {
  return service?.state ?? { available: false, enabled: false };
}

export function setMenubarEnabled(enabled: boolean): MenubarState {
  return service ? service.setEnabled(enabled) : { available: false, enabled: false };
}

export function stopMenubarService(): void {
  service?.stop();
}
