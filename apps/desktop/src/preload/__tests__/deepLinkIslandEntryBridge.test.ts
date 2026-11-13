import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { isValidPluginResourceId } from '@cindy/plugin-protocol';

import { handleIncomingDeepLink, openMainWindowRemoteControlSettings, openMainWindowSession, setDeepLinkMainWindow, takePendingDeepLink } from '../../main/deepLink';

vi.mock('electron', () => ({ app: { focus: vi.fn() }, BrowserWindow: class {} }));
vi.mock('../../main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));

// Execute the production preload `onDeepLinkNavigate` adapter, with its IPC
// subscription injected, so the main → preload → renderer session payload is
// exercised end to end instead of only through the renderer type declaration.
const source = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
const start = source.indexOf('  onDeepLinkNavigate: (');
const end = source.indexOf('  // 冷启动时', start);
if (start < 0 || end <= start) throw new Error('onDeepLinkNavigate bridge not found');
const compiled = ts.transpileModule(`const bridge = {${source.slice(start, end)}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function connect() {
  let listener: ((payload: unknown) => void) | undefined;
  const bridge = new Function('fanOutDeepLinkNavigate', 'isDeepLinkProviderConnectId', 'isValidPluginResourceId', `${compiled}; return bridge;`)(
    (callback: (payload: unknown) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    },
    () => false,
    isValidPluginResourceId,
  ) as { onDeepLinkNavigate(callback: (payload: unknown) => void): () => void };
  const received: unknown[] = [];
  bridge.onDeepLinkNavigate((payload) => received.push(payload));
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    setAlwaysOnTop: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    webContents: { isLoading: () => false, send: (_channel: string, payload: unknown) => listener?.(payload) },
  } as unknown as BrowserWindow;
  setDeepLinkMainWindow(win);
  return { received, deliver: (payload: unknown) => listener?.(payload) };
}

afterEach(() => setDeepLinkMainWindow(null));

// Unit regression: a menu-bar click focused the app but preload silently dropped
// the new settings tab. Exercise the real main dispatch and production bridge.
it('delivers remote-control settings through the live bridge and cold-start buffer', () => {
  const { received, deliver } = connect();
  openMainWindowRemoteControlSettings();
  const expected = { type: 'settings', tab: 'remote-control' };
  expect(received).toEqual([expected]);
  deliver({ type: 'settings', tab: 'unknown' });
  deliver({ type: 'settings', tab: 'remote-control', connect: 'codex' });
  expect(received).toEqual([expected]);
  setDeepLinkMainWindow(null);
  openMainWindowRemoteControlSettings();
  expect(takePendingDeepLink()).toEqual(expected);
  expect(takePendingDeepLink()).toBeNull();
});

// Review #8227 (Codex P2): the Computer Use enablement link must reach a running app, not only
// the cold-start buffer; the preload whitelist had no builtin-tools branch.
it('delivers cindy://settings/builtin-tools through the live bridge and cold-start buffer', () => {
  const { received } = connect();
  handleIncomingDeepLink('cindy://settings/builtin-tools', 'open-url');
  expect(received).toEqual([{ type: 'settings', tab: 'builtin-tools' }]);
  setDeepLinkMainWindow(null);
  handleIncomingDeepLink('cindy://settings/builtin-tools', 'argv');
  expect(takePendingDeepLink()).toEqual({ type: 'settings', tab: 'builtin-tools' });
});

// Review 2026-10-29 (Codex P1): the warm-app path dropped installed-plugin payloads because the
// preload validator had no branch for them; only the cold-start buffer worked.
it('delivers cindy://plugins links through the live bridge and cold-start buffer', () => {
  const { received } = connect();
  handleIncomingDeepLink('cindy://plugins/my-browser', 'open-url');
  handleIncomingDeepLink('cindy://plugins', 'open-url');
  expect(received).toEqual([{ type: 'installed-plugin', ghostId: 'my-browser' }, { type: 'installed-plugin' }]);
  setDeepLinkMainWindow(null);
  handleIncomingDeepLink('cindy://plugins/my-browser', 'argv');
  expect(takePendingDeepLink()).toEqual({ type: 'installed-plugin', ghostId: 'my-browser' });
});

describe('Agent Island click id across the preload deep-link bridge', () => {
  // External links must keep their owning computer through both the live bridge
  // and the cold-start buffer; otherwise a same-id local task wins.
  it('preserves a remote task and message through live delivery and cold start', () => {
    const href = 'cindy://session/same?device=other-mac&message=m-1';
    const expected = { type: 'session', id: 'same', deviceId: 'other-mac', messageClientId: 'm-1' };
    const { received } = connect();
    handleIncomingDeepLink(href, 'open-url');
    expect(received).toEqual([expected]);
    setDeepLinkMainWindow(null);
    handleIncomingDeepLink(href, 'argv');
    expect(takePendingDeepLink()).toEqual(expected);
    expect(takePendingDeepLink()).toBeNull();
  });

  it('carries the click id main put on a loaded main window session entry', () => {
    const { received } = connect();
    openMainWindowSession('lane-1', { islandEntryId: '42' });
    openMainWindowSession('plain-1');
    expect(received).toEqual([
      { type: 'session', id: 'lane-1', islandEntryId: '42' },
      { type: 'session', id: 'plain-1' },
    ]);
  });

  it('drops a malformed click id but still navigates', () => {
    const { received, deliver } = connect();
    deliver({ type: 'session', id: 's', islandEntryId: 'x'.repeat(33) });
    deliver({ type: 'session', id: 's', islandEntryId: 'abc' });
    deliver({ type: 'session', id: 's', islandEntryId: 7 });
    deliver({ type: 'session', id: 's', messageClientId: 'm-1', islandEntryId: '9' });
    expect(received).toEqual([
      { type: 'session', id: 's' },
      { type: 'session', id: 's' },
      { type: 'session', id: 's' },
      { type: 'session', id: 's', messageClientId: 'm-1', islandEntryId: '9' },
    ]);
  });
});

// PR #7240: the new plugin intent was parsed by main but dropped by preload,
// and a loaded login page lost it before MainLayout mounted. The existing
// session cases cover neither branch. Unit inputs use a public resource ID,
// a loaded window, and the real one-shot main queue; no Electron is started.
describe('public plugin entry through the production bridge', () => {
  const pluginId = 'c123456789012345678901234';
  const href = `cindy://plugin/${pluginId}`;
  const expected = { type: 'plugin', pluginId };

  it('delivers a live wake-up and retains the intent for exactly one consumer', () => {
    const { received } = connect();
    handleIncomingDeepLink(href, 'open-url');
    expect(received).toEqual([expected]);
    expect(takePendingDeepLink()).toEqual(expected);
    expect(takePendingDeepLink()).toBeNull();
  });

  it('retains the last plugin during login and cold start until the mount pull', () => {
    connect();
    handleIncomingDeepLink('cindy://plugin/c223456789012345678901234', 'open-url');
    handleIncomingDeepLink(href, 'open-url');
    expect(takePendingDeepLink()).toEqual(expected);
    expect(takePendingDeepLink()).toBeNull();
    setDeepLinkMainWindow(null);
    handleIncomingDeepLink(href, 'argv');
    expect(takePendingDeepLink()).toEqual(expected);
    expect(takePendingDeepLink()).toBeNull();
  });

  it('drops invalid plugin identifiers and projects only the navigation fields', () => {
    const { received, deliver } = connect();
    for (const pluginId of [undefined, null, 7, '', 'cindy-github', '../file', 'c123?install=true']) {
      deliver({ type: 'plugin', pluginId });
    }
    expect(received).toEqual([]);
    deliver({ ...expected, install: true, url: 'https://untrusted.example.test' });
    expect(received).toEqual([expected]);
  });
});
