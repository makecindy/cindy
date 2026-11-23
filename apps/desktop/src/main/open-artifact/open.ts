/**
 * Pages the daemon asks Cindy to show (`host.open`) → a web-browser tab in that task's right sidebar.
 *
 * The full page (`viewUrl`: the Shell with its title bar, Share, Export and comments) opens in an ordinary sidebar
 * browser tab through the same main → renderer tab bridge Browser Use's sidebar backend uses. Opening the same page
 * again for the same task focuses its tab instead of adding another one.
 */
import type { OpenRequest } from '@open-artifact/harness-kit';
import type { RsbBrowserBridgeTabOp, RsbBrowserBridgeTabOpResult } from '../../shared/rsbBrowserBridge.js';
import { createLogger } from '../logger.js';

const log = createLogger('open-artifact');

export interface OpenDeps {
  /** `dispatchTabOp(op, desktopRsbBridgeOptions())`. */
  dispatch: (op: RsbBrowserBridgeTabOp) => Promise<RsbBrowserBridgeTabOpResult>;
  /** The task whose sidebar is in front, for a page opened without a task (from the library). */
  activeSessionId: () => string | null;
  /** The task's sidebar tabs the tab registry knows, with the page each one shows now. */
  sessionTabs?: (sessionId: string) => PageTab[];
}

export interface PageTab {
  tabId: string;
  url: string;
}

/** The same page: same origin and path (a query or hash the page adds does not make another page). */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

/** The tabs showing a page of the daemon at `origin` (to reload once it runs again). */
export function tabsAt(tabs: readonly PageTab[], origin: string): PageTab[] {
  return tabs.filter((tab) => {
    try {
      return new URL(tab.url).origin === new URL(origin).origin;
    } catch {
      return false;
    }
  });
}

export function createOpenHandler(deps: OpenDeps): (request: OpenRequest) => Promise<boolean> {
  const tabs = new Map<string, string>();
  return async (request) => {
    const sessionId = request.session ?? deps.activeSessionId();
    if (!sessionId) return false;
    const url = request.viewUrl || request.url;
    const key = `${sessionId}\n${request.url}`;
    const known = tabs.get(key) ?? deps.sessionTabs?.(sessionId).find((tab) => samePage(tab.url, url))?.tabId;
    if (known) {
      const focused = await deps.dispatch({ op: 'focus', sessionId, tabId: known });
      if (focused.ok) {
        tabs.set(key, known);
        return true;
      }
      tabs.delete(key);
    }
    const opened = await deps.dispatch({ op: 'open', sessionId, url });
    if (!opened.ok) {
      log.warn('Open Artifact page not opened', { error: opened.error });
      return false;
    }
    if (opened.tabId) tabs.set(key, opened.tabId);
    return true;
  };
}
