/**
 * Side-effect module: set XDT_BROWSER_RUNTIME_DIR BEFORE @cindy/browser-control-runtime
 * is imported.
 *
 * The runtime reads this env var into CONFIG_DIR
 * (`packages/browser-control-runtime/src/shim/_local/text-utils.ts`). Vite's main
 * bundle require()s that module before `index.ts` body, so desktop also refreshes
 * the live binding after pinning. This module remains the fallback for tests that
 * import `browser.ts` without going through `index.ts`.
 */
import path from 'node:path';
import { app } from 'electron';

// `app` is undefined when this module is imported OUTSIDE a real Electron process
// — e.g. a vitest unit test that transitively pulls the MCP provider chain
// (`mcp-providers` → `browser.ts` → here, which is exactly how collabSendOutcome /
// any provider-importing test reaches this). Guard so we only seed the runtime dir
// when Electron is actually present; otherwise the runtime falls back to its own
// default dir, which is harmless because such contexts never launch the browser.
// In the real app `app` is always defined here (this loads after app init), so the
// behavior is unchanged.
const electronApp = app as { getPath?: (name: string) => string } | undefined;
if (!process.env.XDT_BROWSER_RUNTIME_DIR && electronApp?.getPath) {
  process.env.XDT_BROWSER_RUNTIME_DIR = path.join(electronApp.getPath('userData'), 'browser-runtime');
}
