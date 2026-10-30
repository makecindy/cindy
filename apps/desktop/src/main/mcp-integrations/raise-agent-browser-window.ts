import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';

const FOCUS_ATTEMPTS = 10;
const FOCUS_RETRY_MS = 150;

type RuntimeCall = Pick<BrowserControlRuntime, 'call'>;

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
      await runtime.call({ action: 'focus', targetId: state.targetId });
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
      await runtime.call({ action: 'focus', targetId });
      return;
    }
    if (attempt < FOCUS_ATTEMPTS - 1) {
      await sleep(FOCUS_RETRY_MS);
    }
  }
}

async function readTabState(
  runtime: RuntimeCall,
): Promise<{ running: boolean; targetId?: string }> {
  const tabsRes = await runtime.call({ action: 'tabs' });
  const data = tabsRes.data as
    | {
        running?: boolean;
        tabs?: Array<{ targetId?: string; suggestedTargetId?: string }>;
      }
    | undefined;
  const tabs = data?.tabs;
  const first = Array.isArray(tabs) ? tabs[0] : undefined;
  return {
    running: data?.running === true,
    targetId: first?.suggestedTargetId ?? first?.targetId,
  };
}

function tabIdFromData(data: unknown): string | undefined {
  const tab = data as { targetId?: string; suggestedTargetId?: string } | undefined;
  return tab?.suggestedTargetId ?? tab?.targetId;
}
