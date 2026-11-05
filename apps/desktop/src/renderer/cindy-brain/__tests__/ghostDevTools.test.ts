// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGhostDevTools } from '../ghostDevTools';
/* C9: the existing dev entry must retain the trusted main-process inspect gate.
 * Minimal regression: production exposes diagnostics or renderer bypasses IPC.
 * Tier: unit. */
afterEach(() => { delete window.__cindyGhosts; vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('plugin UI development diagnostics', () => {
  it('stays absent in a production build', () => {
    vi.stubEnv('DEV', false); installGhostDevTools(); expect(window.__cindyGhosts).toBeUndefined();
  });
  it('delegates to trusted IPC and includes only live subscription metadata', async () => {
    vi.stubEnv('DEV', true); const inspect = vi.fn(async () => ({ bindings: 0, queries: 0 }));
    Object.assign(window, { electronAPI: { ghosts: { ui: { inspect } } } });
    installGhostDevTools(); const first = window.__cindyGhosts; installGhostDevTools();
    expect(window.__cindyGhosts).toBe(first);
    expect(await first!.ui.inspect()).toEqual({ host: { bindings: 0, queries: 0 }, subscriptions: [] });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
