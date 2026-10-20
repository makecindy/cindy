/**
 * RSB browser bridge — main-process module entry.
 *
 * Phase 2 wires the renderer's `<webview>` tabs to a main-side registry so
 * Phase 3 backends can drive them via Electron debugger / capturePage / etc.
 * See `registry.ts` for the in-memory model and `ipc.ts` for the IPC contract.
 *
 * Singleton lifetime: created on first `getRsbBrowserBridge()` call, lives for
 * the main process. There is exactly one tab registry per app instance.
 */

import { webContents as electronWebContents } from 'electron';

import { createLogger } from '../logger.js';
import { TabRegistry } from './registry.js';

export { TabRegistry } from './registry.js';
export type { TabRecord } from './registry.js';
export {
  registerRsbBrowserBridgeIpc,
  _resetRsbBrowserBridgeIpcForTests,
  type RegisterRsbBrowserBridgeOptions,
} from './ipc.js';
export {
  dispatchTabOp,
  registerTabOpResultHandler,
  _resetRendererBridgeForTests,
  type RendererBridgeOptions,
} from './renderer-bridge.js';
export { setCastingTabs } from './previewCasting.js';
export {
  getActiveRsbSessionId,
  setActiveRsbSessionId,
  onActiveRsbSessionIdChange,
  _resetActiveRsbSessionForTests,
} from './active-session.js';

const logger = createLogger('rsb-browser-bridge');

let registry: TabRegistry | null = null;

/**
 * Lazy singleton. Created on first call (typically from bootstrap when
 * registering the IPC handlers). All Phase 3 backends consume this exact
 * instance.
 */
export function getRsbBrowserBridge(): TabRegistry {
  if (!registry) {
    registry = new TabRegistry({
      lookupWebContents: (id) => electronWebContents.fromId(id) ?? null,
      logger,
    });
  }
  return registry;
}

/** Test-only reset. */
export function _resetRsbBrowserBridgeForTests(): void {
  registry = null;
}
