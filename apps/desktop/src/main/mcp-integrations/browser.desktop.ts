// 浏览器自动化 Desktop 装配；共用主体见 browser.ts。维护者指南：
// packages/browser-control-runtime/upstream/MAINTAINING.md
// Set the runtime directory before the browser package reads its eager config.
import './browser-runtime-env.js';
import nodePath from 'node:path';
import { app, ipcMain } from 'electron';
import { createBrowserRuntime } from './browser.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import * as settings from '../browser-backend-settings-store.desktop.js';
import * as loader from '../browser-recipes/loader.desktop.js';
import * as writer from '../browser-recipes/writer.desktop.js';
import { RsbWebviewBackend } from './browser-backend/rsb-webview-backend.js';
import { getRsbBrowserBridge } from '../rsb-browser-bridge/index.js';
import { getActiveRsbSessionId, setActiveRsbSessionId } from '../rsb-browser-bridge/active-session.js';
import type { RsbBrowserBridgeTabOp } from '../../shared/rsbBrowserBridge.js';
import { requireObject, optionalNullableString } from '../utils/ipcValidate.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { createLogger } from '../logger.js';
export { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';
const logger = createLogger('mcp/cindy_browser');
let mainWindowAccessor: (op?: RsbBrowserBridgeTabOp) => Electron.WebContents | null = () => null;
let ensureHost: (sessionId?: string) => Promise<void> = () => Promise.resolve();
let isDetached = () => false;
export function setMainWindowAccessorForBackend(accessor: typeof mainWindowAccessor) { mainWindowAccessor = accessor; }
export function setEnsureHostForBackend(impl: typeof ensureHost) { ensureHost = impl; }
export function setIsDetachedForBackend(impl: typeof isDetached) { isDetached = impl; }
export function createDesktopEmbeddedBackend(resolveUploadRoots: (sessionId: string) => Promise<string[]>) {
  return new RsbWebviewBackend({ registry: getRsbBrowserBridge(),
    getActiveSessionId: () => getActiveRsbSessionId(), artifactRoot: () => nodePath.join(app.getPath('temp'), 'cindy-browser-artifacts'),
    resolveUploadRoots, bridge: { getHostWebContents: op => mainWindowAccessor(op), ensureHost: id => ensureHost(id), isDetached: () => isDetached(), logger }, logger });
}
const runtime = createBrowserRuntime({ tempDir: () => app.getPath('temp'), settings,
  recipes: { ...loader, ...writer }, secretIo: genericOAuthSecretIo,
  createEmbeddedBackend: createDesktopEmbeddedBackend,
});
export const { setBrowserSessionUploadRootResolver, setUserBrowserPageControlProvider, clearUserBrowserMarksForSession, setActiveBrowserBackendKind, setBrowserUseRealProfile, getBrowserMcpDeps, getBrowserAvailability, getActiveBrowserBackendKind, recoverActiveBrowserBackend, getBrowserBackendHealth, createBrowserSettingsHandlers, openBrowserForLogin, disposeBrowserRuntime } = runtime;
let registered = false;
export function registerBrowserBackendIpc() {
  if (registered) return;
  registered = true;
  const handlers = runtime.createBrowserSettingsHandlers(assertTrustedAppRendererEvent);
  ipcMain.handle('browser-backend:get-state', handlers.getState);
  ipcMain.handle('browser-backend:set-kind', handlers.setKind);
  ipcMain.handle('browser-backend:set-use-real-profile', handlers.setUseRealProfile);
  ipcMain.handle('browser-backend:reset', handlers.reset);
  ipcMain.handle('browser-backend:get-health', handlers.getHealth);
  ipcMain.handle('browser-backend:recover', handlers.recover);
  ipcMain.handle('browser-backend:probe-source-read', handlers.probeSourceRead);
  ipcMain.handle('browser-backend:open-extension-store', handlers.openExtensionStore);
  ipcMain.handle('rsb-browser-bridge:set-active-session', (_event, payload: unknown) => {
    const obj = requireObject(payload, 'set-active-session payload');
    setActiveRsbSessionId(optionalNullableString(obj.sessionId) ?? null);
    return { ok: true };
  });
  logger.info('browser-backend IPC handlers registered');
}
