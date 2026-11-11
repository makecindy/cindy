import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';

const FOCUS_ATTEMPTS = 10;
const FOCUS_RETRY_MS = 150;

type RuntimeCall = Pick<BrowserControlRuntime, 'call'>;

type TabEntry = {
  targetId?: string;
  suggestedTargetId?: string;
  type?: string;
  url?: string;
};

/**
 * Targets that never raise a window: extension background workers and the
 * browser's own surfaces.
 *
 * The managed browser starts with `--no-startup-window`, and the tab list is
 * whatever CDP reports in target order — for a fresh profile that is an
 * extension's service worker. Focusing such a target succeeds but shows
 * nothing, so the login button looked dead while the browser was in fact
 * running fine.
 */
const NON_PAGE_URL_PREFIXES = [
  'chrome-extension://',
  'chrome://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'brave://',
  'vivaldi://',
  'opera://',
];

/** Whether this target is a real page, i.e. one that can own a visible window. */
function isPageTarget(tab: TabEntry): boolean {
  const type = tab.type?.trim().toLowerCase();
  if (type && type !== 'page') return false;
  const url = (tab.url ?? '').trim().toLowerCase();
  return !NON_PAGE_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Bring the headed automation Chrome to the front after `start`.
 *
 * Normal automation starts headed Chrome without a startup window so agent-only
 * reads cannot steal focus. This user-initiated path waits for CDP readiness,
 * creates one foreground tab when needed, and then focuses it.
 */
export async function raiseAgentBrowserWindow(
  runtime: RuntimeCall,
  options?: { sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < FOCUS_ATTEMPTS; attempt += 1) {
    const state = await readTabState(runtime);
    if (state.targetId) {
      await focusTarget(runtime, state.targetId);
      return;
    }
    if (state.running) {
      const opened = await runtime.call({
        action: 'open',
        url: 'about:blank',
        background: false,
      });
      if (!opened.ok) {
        throw new Error(opened.message ?? 'Failed to open the Agent browser login tab');
      }
      const targetId = tabIdFromData(opened.data);
      if (!targetId) {
        throw new Error('Agent browser login tab opened without a target ID');
      }
      await focusTarget(runtime, targetId);
      return;
    }
    if (attempt < FOCUS_ATTEMPTS - 1) {
      await sleep(FOCUS_RETRY_MS);
    }
  }
}

/**
 * Raise the window and report a failed focus instead of swallowing it.
 *
 * A silent focus failure is indistinguishable from "the button did nothing",
 * which is how a broken login entry point stays unreported for days.
 */
async function focusTarget(runtime: RuntimeCall, targetId: string): Promise<void> {
  const focused = await runtime.call({ action: 'focus', targetId });
  if (!focused.ok) {
    throw new Error(focused.message ?? 'Failed to focus the Agent browser window');
  }
}

async function readTabState(
  runtime: RuntimeCall,
): Promise<{ running: boolean; targetId?: string }> {
  const tabsRes = await runtime.call({ action: 'tabs' });
  const data = tabsRes.data as
    | {
        running?: boolean;
        tabs?: Array<{
          targetId?: string;
          suggestedTargetId?: string;
          type?: string;
          url?: string;
        }>;
      }
    | undefined;
  const tabs = data?.tabs;
  const page = Array.isArray(tabs) ? tabs.find(isPageTarget) : undefined;
  return {
    running: data?.running === true,
    targetId: page?.suggestedTargetId ?? page?.targetId,
  };
}

function tabIdFromData(data: unknown): string | undefined {
  const tab = data as { targetId?: string; suggestedTargetId?: string } | undefined;
  return tab?.suggestedTargetId ?? tab?.targetId;
}
