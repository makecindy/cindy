import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';

const FOCUS_ATTEMPTS = 10;
const FOCUS_RETRY_MS = 150;

type RuntimeCall = Pick<BrowserControlRuntime, 'call'>;

/**
 * Bring the headed automation Chrome to the front after `start`.
 *
 * `start` already creates Chrome's initial tab. Cold-start `GET /tabs` returns
 * `{ running: false, tabs: [] }` until CDP is reachable, so an empty list is
 * "not ready yet", not "missing window". Opening `about:blank` after the poll
 * races that first tab (MAINTAINING pit #5).
 */
export async function raiseAgentBrowserWindow(
  runtime: RuntimeCall,
  options?: { sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < FOCUS_ATTEMPTS; attempt += 1) {
    const targetId = await firstTabId(runtime);
    if (targetId) {
      await runtime.call({ action: 'focus', targetId });
      return;
    }
    if (attempt < FOCUS_ATTEMPTS - 1) {
      await sleep(FOCUS_RETRY_MS);
    }
  }
}

export async function firstTabId(runtime: RuntimeCall): Promise<string | undefined> {
  const tabsRes = await runtime.call({ action: 'tabs' });
  const tabs = (tabsRes.data as { tabs?: Array<{ targetId?: string; suggestedTargetId?: string }> } | undefined)
    ?.tabs;
  const first = Array.isArray(tabs) ? tabs[0] : undefined;
  return first?.suggestedTargetId ?? first?.targetId;
}
