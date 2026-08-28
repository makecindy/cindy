import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BrowserWindow, ipcMain, shell, utilityProcess } from 'electron';

import { createLogger } from '../logger.js';
import { getDeepLinkMainWindow, openMainWindowSession, sendMainWindowMessage } from '../deepLink.js';
import { createLayoutPreviewLease, layoutPreviewOwnerFromEvent } from '../input-devices/previewLease.js';
import { registerInputDevice } from '../input-devices/registry.js';
import { isSecondaryAppWindow } from '../secondary-windows.js';
import {
  WORKLOUDER_CODEX_ACTION_CHANNEL,
  WORKLOUDER_CODEX_DEVICE,
  WORKLOUDER_CODEX_PREVIEW_INPUT_CHANNEL,
  WORKLOUDER_CODEX_GET_STATE_CHANNEL,
  WORKLOUDER_CODEX_OPEN_INPUT_MONITORING_CHANNEL,
  WORKLOUDER_CODEX_PROBE_CHANNEL,
  WORKLOUDER_CODEX_PUBLISH_TASKS_CHANNEL,
  WORKLOUDER_CODEX_SET_LAYOUT_PREVIEW_CHANNEL,
  WORKLOUDER_CODEX_RESET_SETTINGS_CHANNEL,
  WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL,
  WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL,
  type WorkLouderCodexPreviewInput,
  type WorkLouderCodexRendererAction,
  type WorkLouderCodexState,
} from '../../shared/workLouderCodex.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import {
  WorkLouderCodexHostClient,
  type WorkLouderSdkLocation,
} from './WorkLouderCodexHostClient.js';
import { WorkLouderCodexLightingController } from './WorkLouderCodexLightingController.js';
import { createWorkLouderCodexSettingsIpc } from './settingsIpc.js';
import { createWorkLouderCodexActiveWindowRouter } from './actionWindow.js';
import { createWorkLouderCodexSystemFrontmostInput } from './systemFrontmostInput.js';
import {
  createWorkLouderCodexWindowRevealGate,
  noteWorkLouderCodexWindowVisibility,
} from './windowReveal.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import {
  readWorkLouderCodexSettings,
  resetWorkLouderCodexSettings,
  writeWorkLouderCodexSettingsPatch,
} from './settingsStore.js';
import { listWorkersByLeads } from '../localDb/orcaTeamStore.js';
import {
  buildWorkLouderCodexTaskCatalog,
  listWorkLouderCodexTaskCatalog,
  type WorkLouderCodexTaskCatalogInput,
} from './taskSlots.js';

const log = createLogger('worklouder-codex');
const requireFromMain = createRequire(__filename);

function resolveWorkLouderSdk(): WorkLouderSdkLocation | null {
  try {
    return {
      entry: requireFromMain.resolve('@worklouder/device-kit-oai'),
      source: 'cindy-package',
    };
  } catch {
    // The official SDK is optional until Work Louder grants Cindy registry access.
  }

  for (const packageDir of listBundledWorkLouderSdkDirs()) {
    if (fs.existsSync(path.join(packageDir, 'package.json'))) {
      return { entry: packageDir, source: 'openai-app' };
    }
  }
  return null;
}

function listBundledWorkLouderSdkDirs(): string[] {
  const packageTail = path.join(
    'resources',
    'app.asar',
    'node_modules',
    '@worklouder',
    'device-kit-oai',
  );
  if (process.platform === 'darwin') {
    return ['ChatGPT.app', 'Codex.app'].map((appName) =>
      path.join('/Applications', appName, 'Contents', packageTail),
    );
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const roots = [localAppData, programFiles].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) =>
      ['ChatGPT', 'Codex'].flatMap((appName) => [
        path.join(root, appName, packageTail),
        path.join(root, 'Programs', appName, packageTail),
      ]),
    );
  }
  return [];
}

function forkWorkLouderHost(_sdkEntry: string): ReturnType<typeof utilityProcess.fork> {
  return utilityProcess.fork(path.join(__dirname, 'workLouderCodexHostProcess.js'), [], {
    serviceName: 'cindy-worklouder-codex',
  });
}

const hostClient = new WorkLouderCodexHostClient({
  resolveSdk: resolveWorkLouderSdk,
  fork: forkWorkLouderHost,
  log,
});

/**
 * Tasks as the sidebar currently shows them, published by the renderer.
 *
 * The local table is not the whole picture: sessions on a linked machine live
 * only in the renderer's remote store, so a machine driving someone else's
 * sessions would show six empty agent keys. The renderer is also the only side
 * that knows which machine filter is applied, so what it sends is what the user
 * sees. Null until it reports — until then the local table is the best guess.
 */
let rendererTaskCatalog: WorkLouderCodexTaskCatalogInput[] | null = null;
let rendererTaskCatalogScope: string | null = null;

function currentTaskCatalogScope(): string | null {
  if (isAppSessionBoundaryPending()) return null;
  return activeOwnerScopeKey();
}

function currentRendererTaskCatalog(): WorkLouderCodexTaskCatalogInput[] | null {
  if (!rendererTaskCatalog) return null;
  if (rendererTaskCatalogScope !== currentTaskCatalogScope()) {
    rendererTaskCatalog = null;
    rendererTaskCatalogScope = null;
    return null;
  }
  return rendererTaskCatalog;
}

export const workLouderCodexLightingController = new WorkLouderCodexLightingController(
  hostClient,
  (sessionId, focus = true) => openMainWindowSession(sessionId, { focus }),
  async () => {
    const catalog = currentRendererTaskCatalog();
    return catalog
      ? buildWorkLouderCodexTaskCatalog(catalog, { publishedVisibleOrder: true })
      : listWorkLouderCodexTaskCatalog();
  },
  dispatchRendererAction,
  dispatchPreviewInput,
  async (leadSessionIds) => {
    if (leadSessionIds.length === 0) return {};
    const grouped = await listWorkersByLeads(leadSessionIds);
    return Object.fromEntries(
      Object.entries(grouped).map(([leadId, workers]) => [
        leadId,
        workers.map((worker) => worker.sessionId),
      ]),
    );
  },
);

const layoutPreviewLease = createLayoutPreviewLease((active) => {
  workLouderCodexLightingController.setLayoutPreviewActive(active);
});

let settingsIpcRegistered = false;
let inputDeviceRegistered = false;

/** Register this board as one input-device adapter, not as the host keyboard layer. */
export function registerWorkLouderCodexInputDevice(): void {
  if (inputDeviceRegistered) return;
  inputDeviceRegistered = true;
  registerInputDevice({
    descriptor: WORKLOUDER_CODEX_DEVICE,
    start: () => {
      registerWorkLouderCodexSettingsIpc();
    },
    updateSessionActivity: (activity) => {
      workLouderCodexLightingController.updateSessionActivity(activity);
    },
    playWindowReveal: () => {
      workLouderCodexLightingController.playWindowReveal();
    },
    resumeTaskSlots: async () => {
      workLouderCodexLightingController.applySettings(readWorkLouderCodexSettings());
      await workLouderCodexLightingController.resumeTaskSlots();
    },
    suspendTaskSlots: () => {
      rendererTaskCatalog = null;
      rendererTaskCatalogScope = null;
      workLouderCodexLightingController.suspendTaskSlots();
    },
    dispose: () => workLouderCodexLightingController.dispose(),
  });
}

/** Registers the local-desktop-only device settings bridge after Electron is ready. */
export function registerWorkLouderCodexSettingsIpc(): void {
  if (settingsIpcRegistered) return;
  settingsIpcRegistered = true;

  workLouderCodexLightingController.applySettings(readWorkLouderCodexSettings());
  workLouderCodexLightingController.start();
  const handlers = createWorkLouderCodexSettingsIpc({
    assertTrustedSender: (event) => assertTrustedAppRendererEvent(event as never),
    getState: () => workLouderCodexLightingController.getState(),
    writeSettings: writeWorkLouderCodexSettingsPatch,
    resetSettings: resetWorkLouderCodexSettings,
    applySettings: (settings) => workLouderCodexLightingController.applySettings(settings),
    openInputMonitoringSettings: async () => {
      if (process.platform !== 'darwin') return;
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
      );
    },
    probeDevice: () => hostClient.probe(),
    publishTasks: (tasks) => {
      const scope = currentTaskCatalogScope();
      if (!scope) return;
      rendererTaskCatalog = tasks.map((task) => ({ ...task }));
      rendererTaskCatalogScope = scope;
      void workLouderCodexLightingController.refreshTaskSlots().catch(() => undefined);
    },
    setLayoutPreviewActive: (active, event) => {
      layoutPreviewLease.setActive(active, layoutPreviewOwnerFromEvent(event));
    },
  });

  ipcMain.handle(WORKLOUDER_CODEX_GET_STATE_CHANNEL, (event) => handlers.get(event));
  ipcMain.handle(WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL, (event, patch: unknown) =>
    handlers.set(event, patch),
  );
  ipcMain.handle(WORKLOUDER_CODEX_RESET_SETTINGS_CHANNEL, (event) => handlers.reset(event));
  ipcMain.handle(WORKLOUDER_CODEX_OPEN_INPUT_MONITORING_CHANNEL, (event) =>
    handlers.openInputMonitoringSettings(event),
  );
  ipcMain.handle(WORKLOUDER_CODEX_PROBE_CHANNEL, (event) => handlers.probe(event));
  ipcMain.handle(WORKLOUDER_CODEX_PUBLISH_TASKS_CHANNEL, (event, tasks: unknown) =>
    handlers.publishTasks(event, tasks),
  );
  ipcMain.handle(WORKLOUDER_CODEX_SET_LAYOUT_PREVIEW_CHANNEL, (event, active: unknown) =>
    handlers.setLayoutPreviewActive(event, active),
  );

  workLouderCodexLightingController.subscribeState((state) => {
    broadcastState(state);
  });
}

const actionWindowRouter = createWorkLouderCodexActiveWindowRouter({
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getMainWindow: getDeepLinkMainWindow,
  isActionWindow: (win) => {
    if (!win) return false;
    const main = getDeepLinkMainWindow();
    return win === main || isSecondaryAppWindow(win);
  },
});
const systemFrontmostInput = createWorkLouderCodexSystemFrontmostInput();

function sendWindowMessage(win: BrowserWindow, channel: string, payload: unknown): boolean {
  if (win.webContents.isDestroyed() || win.webContents.isLoading()) return false;
  win.webContents.send(channel, payload);
  return true;
}

function dispatchRendererAction(action: WorkLouderCodexRendererAction): void {
  if (action.type === 'external-url') {
    void shell.openExternal(action.url).catch((error: unknown) => {
      log.warn('failed to open Codex Micro external action', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const win = actionWindowRouter.resolve(action);
  if (win && sendWindowMessage(win, WORKLOUDER_CODEX_ACTION_CHANNEL, action)) return;
  if (systemFrontmostInput.handle(action)) return;
  log.debug('Codex Micro action skipped because no ready Cindy window can receive it', {
    type: action.type,
  });
}

function dispatchPreviewInput(input: WorkLouderCodexPreviewInput): void {
  if (!sendMainWindowMessage(WORKLOUDER_CODEX_PREVIEW_INPUT_CHANNEL, input)) {
    log.debug('Codex Micro preview skipped because the main renderer is not ready', {
      part: input.part,
    });
  }
}

function broadcastState(state: WorkLouderCodexState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    window.webContents.send(WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL, state);
  }
}

const windowRevealGates = new WeakMap<
  BrowserWindow,
  ReturnType<typeof createWorkLouderCodexWindowRevealGate>
>();

/**
 * Flash the keyboard when this Cindy window becomes visible.
 *
 * Hide / minimize / Dock close all count. Focus while already visible
 * does not. Seed from the current visibility so a show that already
 * fired is not treated as still hidden.
 */
export function attachWorkLouderCodexWindowReveal(win: BrowserWindow): void {
  if (windowRevealGates.has(win)) return;
  const gate = createWorkLouderCodexWindowRevealGate();
  windowRevealGates.set(win, gate);

  const sync = (): void => {
    if (win.isDestroyed()) return;
    const visible = win.isVisible() && !win.isMinimized();
    if (noteWorkLouderCodexWindowVisibility(gate, visible)) {
      workLouderCodexLightingController.playWindowReveal();
    }
  };

  win.on('show', sync);
  win.on('restore', sync);
  win.on('hide', sync);
  win.on('minimize', sync);
  win.once('closed', () => {
    windowRevealGates.delete(win);
  });
  sync();
}
