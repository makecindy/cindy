import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BrowserWindow, ipcMain, shell, utilityProcess } from 'electron';

import { createLogger } from '../logger.js';
import { openMainWindowSession, sendMainWindowMessage } from '../deepLink.js';
import {
  WORKLOUDER_CODEX_ACTION_CHANNEL,
  WORKLOUDER_CODEX_GET_STATE_CHANNEL,
  WORKLOUDER_CODEX_OPEN_INPUT_MONITORING_CHANNEL,
  WORKLOUDER_CODEX_RESET_SETTINGS_CHANNEL,
  WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL,
  WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL,
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
import {
  readWorkLouderCodexSettings,
  resetWorkLouderCodexSettings,
  writeWorkLouderCodexSettingsPatch,
} from './settingsStore.js';
import { listWorkLouderCodexTaskCatalog } from './taskSlots.js';

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

  if (process.platform !== 'darwin') return null;
  for (const appName of ['ChatGPT.app', 'Codex.app']) {
    const packageDir = path.join(
      '/Applications',
      appName,
      'Contents',
      'Resources',
      'app.asar',
      'node_modules',
      '@worklouder',
      'device-kit-oai',
    );
    if (fs.existsSync(path.join(packageDir, 'package.json'))) {
      return { entry: packageDir, source: 'openai-app' };
    }
  }
  return null;
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

export const workLouderCodexLightingController = new WorkLouderCodexLightingController(
  hostClient,
  (sessionId, focus = true) => openMainWindowSession(sessionId, { focus }),
  listWorkLouderCodexTaskCatalog,
  dispatchRendererAction,
);

let settingsIpcRegistered = false;

/** Registers the local-desktop-only device settings bridge after Electron is ready. */
export function registerWorkLouderCodexSettingsIpc(): void {
  if (settingsIpcRegistered) return;
  settingsIpcRegistered = true;

  workLouderCodexLightingController.start();
  workLouderCodexLightingController.applySettings(readWorkLouderCodexSettings());
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
  });

  ipcMain.handle(WORKLOUDER_CODEX_GET_STATE_CHANNEL, (event) => handlers.get(event));
  ipcMain.handle(WORKLOUDER_CODEX_SET_SETTINGS_CHANNEL, (event, patch: unknown) =>
    handlers.set(event, patch),
  );
  ipcMain.handle(WORKLOUDER_CODEX_RESET_SETTINGS_CHANNEL, (event) => handlers.reset(event));
  ipcMain.handle(WORKLOUDER_CODEX_OPEN_INPUT_MONITORING_CHANNEL, (event) =>
    handlers.openInputMonitoringSettings(event),
  );

  workLouderCodexLightingController.subscribeState((state) => {
    broadcastState(state);
  });
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
  if (!sendMainWindowMessage(WORKLOUDER_CODEX_ACTION_CHANNEL, action)) {
    log.debug('Codex Micro action skipped because the main renderer is not ready', {
      type: action.type,
    });
  }
}

function broadcastState(state: WorkLouderCodexState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppRendererWindow(window)) continue;
    window.webContents.send(WORKLOUDER_CODEX_STATE_CHANGED_CHANNEL, state);
  }
}
