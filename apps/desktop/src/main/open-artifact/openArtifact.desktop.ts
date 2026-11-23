// Open Artifact desktop assembly: binds the Electron pieces (utility process, user-data path, right-sidebar tab
// bridge, built-in tool toggle, account changes) to the service. The service, tools, wake and open logic stay free
// of Electron.
import path from 'node:path';
import { app } from 'electron';
import { onAppSessionInvalidated } from '../appSessionState.js';
import { createPluginRegistry } from '../maker-host/plugins/index.js';
import { getRsbBrowserBridge } from '../rsb-browser-bridge/index.js';
import { dispatchTabOp } from '../rsb-browser-bridge/renderer-bridge.js';
import { getActiveRsbSessionId } from '../rsb-browser-bridge/active-session.js';
import { desktopRsbBridgeOptions } from '../mcp-integrations/browser.desktop.js';
import { spawnDaemonInUtilityProcess } from './daemonSpawn.desktop.js';
import { createLogger } from '../logger.js';
import { createOpenHandler, tabsAt, type PageTab } from './open.js';
import { cindyOpenArtifactHome } from './runtime.js';
import { OpenArtifactService, type OpenArtifactSessionBridge } from './service.js';
import { createWakeHandler, type WakeDeps } from './wake.js';

const log = createLogger('open-artifact');

let service: OpenArtifactService | null = null;
let stopAccountWatch: (() => void) | null = null;
let launchTimer: NodeJS.Timeout | null = null;
/** After the main window opens; short, so pages restored in the sidebar come back soon. */
const LAUNCH_DELAY_MS = 2000;

/** Sidebar browser tabs the main-side registry knows (reported once their page attached), with their current page. */
function registeredTabs(sessionId?: string): PageTab[] {
  const registry = getRsbBrowserBridge();
  const records = sessionId ? registry.listBySession(sessionId) : registry.listAll();
  return records.flatMap((record) => {
    const url = registry.getWebContentsByTabId(record.tabId)?.getURL();
    return url ? [{ tabId: record.tabId, url }] : [];
  });
}

/** The process's one service; constructing it starts nothing. */
export function getOpenArtifactService(): OpenArtifactService {
  if (!service) {
    service = new OpenArtifactService({
      home: cindyOpenArtifactHome(),
      runtime: () => ({ toolsRoot: path.join(app.getPath('userData'), 'managed-tools') }),
      spawn: spawnDaemonInUtilityProcess,
      open: createOpenHandler({
        dispatch: (op) => dispatchTabOp(op, desktopRsbBridgeOptions()),
        activeSessionId: () => getActiveRsbSessionId(),
        sessionTabs: (sessionId) => registeredTabs(sessionId),
      }),
    });
    // Account switch: the next tool call attaches its task again under the new account.
    stopAccountWatch ??= onAppSessionInvalidated(() => service?.forgetSessions());
  }
  return service;
}

/** register.ts calls this once its task plumbing exists (sendToSessionInternal is a closure there). */
export function setOpenArtifactSessionBridge(bridge: WakeDeps & Omit<OpenArtifactSessionBridge, 'wake'>): void {
  getOpenArtifactService().setSessionBridge({
    wake: createWakeHandler({ send: bridge.send, isBusy: bridge.isBusy }),
    isInTurn: bridge.isInTurn,
    observeTurns: bridge.observeTurns,
    ...(bridge.title ? { title: bridge.title } : {}),
  });
}

/**
 * After startup, off the startup path: when the Artifacts tool is on, connect to a running daemon, or start one from a
 * runtime already on disk when Cindy used this home before (never downloads; see resumeAtLaunch). Pages restored in
 * the sidebar that tried to load before the daemon was back are reloaded once. Like the other built-in tools, the
 * toggle is read as the user default; a later change applies to new tasks.
 */
export function resumeOpenArtifactAfterLaunch(): void {
  if (launchTimer || !createPluginRegistry().isEnabled('artifacts')) return;
  launchTimer = setTimeout(() => {
    void getOpenArtifactService()
      .resumeAtLaunch()
      .then((origin) => {
        if (!origin) return;
        const restored = tabsAt(registeredTabs(), origin);
        for (const tab of restored) getRsbBrowserBridge().getWebContentsByTabId(tab.tabId)?.reload();
        if (restored.length) log.info('Reloaded restored Open Artifact pages', { count: restored.length });
      })
      .catch((error) => log.warn('Open Artifact did not resume after launch', { error: (error as Error).message }));
  }, LAUNCH_DELAY_MS);
  launchTimer.unref?.();
}

/** App quit: close the connection and stop a daemon Cindy started (bounded wait); one another app started keeps running. */
export async function closeOpenArtifact(): Promise<void> {
  if (launchTimer) clearTimeout(launchTimer);
  stopAccountWatch?.();
  stopAccountWatch = null;
  const closing = service?.close();
  service = null;
  await closing;
}
