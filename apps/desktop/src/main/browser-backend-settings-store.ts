/**
 * browser-backend-settings-store — controls which backend the MCP `browser`
 * tool drives (Phase 5).
 *
 * File: <userData>/browser-backend-settings.json
 *
 * Defaults: `kind: 'external'` — the standalone managed Chrome. Rationale for
 * making the *external* browser the default rather than the in-app webview:
 * browser automation spends its time on arbitrary untrusted pages, so engine
 * patch freshness matters more here than anywhere else in the app. Chrome
 * Stable self-updates within days of a Chromium 0-day; the in-app webview runs
 * on the Chromium bundled with our Electron, which only moves when we ship a
 * client update. The external backend still isolates the agent from the user's
 * everyday browsing: same Chrome binary, but a dedicated `Cindy` profile with
 * its own user-data-dir (see mcp-integrations/browser.ts).
 *
 * Accepted trade-offs of this default (do not "fix" one without re-reading the
 * other): the managed Chrome exposes a loopback CDP port, and its process
 * teardown is best-effort (win32 process-tree cleanup is unverified — see the
 * NOTE in mcp-integrations/browser.ts `disposeBrowserRuntime`). Users who want
 * the tighter in-app isolation (no CDP port, session-dir-confined uploads)
 * switch to `'rsb-webview'` in Settings →「自动操作」.
 *
 * DEFAULT HISTORY — this value has flipped twice; the override semantics below
 * are what keep that from thrashing users:
 *   - Phase 1: `'external'` was the only backend.
 *   - Phase 5: default became `'rsb-webview'` when the in-app browser shipped.
 *   - Now: back to `'external'` for the patch-freshness reason above.
 * Per docs/dev-rules/configuration-and-overrides.md §3, the flip is driven by
 * *override state*, never by guessing intent from the stored value:
 *   - new users → `'external'`;
 *   - existing users with a recorded `kind` override → keep it. Under the
 *     Phase-5 default that is *only* the users who picked `'external'`, and
 *     `'external'` is what they now get anyway — so no observable change;
 *   - **everyone currently on `'rsb-webview'` → moves to `'external'`.** This
 *     includes users who deliberately picked the sidebar browser, not just
 *     users who never touched the toggle. Do not read this as an override being
 *     ignored: no override exists to honor. Two mechanisms collapse
 *     "deliberately chose the then-default" into "never customized":
 *       (a) `override-settings-file.writePatch` DELETES a key whose new value
 *           equals the current default (`writeBrowserBackendKind` passes no
 *           `preserveDefaults`), and an empty override map unlinks the file —
 *           so toggling external→rsb-webview under the old default erased the
 *           file it had just written;
 *       (b) `setActiveBrowserBackendKind` short-circuits on same-kind, so
 *           re-clicking the already-active backend never writes at all.
 *     `isCustomized` is `Object.keys(overrides).length > 0`, hence false for
 *     all of them.
 * Consequence worth stating plainly: a user who chose the sidebar browser *for
 * its tighter isolation* (no loopback CDP port, uploads confined to the session
 * dir) is silently moved onto the backend that has neither. Protecting that
 * user would need a customization flag independent of value-equality; §3
 * forbids reconstructing intent from the old stored value, so we do NOT try to
 * infer it retroactively. If that user class matters, the fix is a real flag
 * plus a one-time notice — not a heuristic here.
 * No migration step is needed either way: `createOverrideSettingsFile` persists
 * only the override, so "has an override" is directly observable. Note the two
 * backends do NOT share login state — a user moved to `'external'` by this
 * default change starts from that profile's own cookies, and whatever they
 * logged into inside the sidebar browser stays in the webview partition.
 *
 * Stored as a single field so future knobs (e.g. snapshot format preference)
 * can join the same file under override-settings-file semantics (rule 20:
 * system default vs. user override is preserved, "reset" clears the override
 * rather than overwriting with a frozen snapshot).
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';
import type { BackendKind } from './mcp-integrations/browser-backend/index.js';

const log = desktopMakerLogger.child('browser-backend-settings-store');

export interface BrowserBackendSettings {
  kind: BackendKind;
}

const DEFAULTS: BrowserBackendSettings = {
  kind: 'external',
};

const VALID_KINDS: readonly BackendKind[] = ['external', 'rsb-webview'];

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'browser-backend-settings.json');
}

function normalize(raw: unknown): BrowserBackendSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const kind =
    typeof r.kind === 'string' && (VALID_KINDS as string[]).includes(r.kind)
      ? (r.kind as BackendKind)
      : DEFAULTS.kind;
  return { kind };
}

const store = createOverrideSettingsFile<BrowserBackendSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'browser-backend',
});

export function readBrowserBackendSettings(): BrowserBackendSettings {
  return store.read();
}

export function readBrowserBackendSettingsState(): OverrideSettingsState<BrowserBackendSettings> {
  return store.readState();
}

export function writeBrowserBackendKind(kind: BackendKind): void {
  store.writePatch({ kind });
  log.info('browser-backend kind written', { kind });
}

/** Reset = clear user override, fall back to current system default. */
export function resetBrowserBackendSettings(): BrowserBackendSettings {
  return store.reset();
}

export const __testing = { normalize, DEFAULTS };
