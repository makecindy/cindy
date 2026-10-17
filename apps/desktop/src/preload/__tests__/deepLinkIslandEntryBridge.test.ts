import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import { openMainWindowSession, setDeepLinkMainWindow } from '../../main/deepLink';

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
  const bridge = new Function('fanOutDeepLinkNavigate', 'isDeepLinkProviderConnectId', `${compiled}; return bridge;`)(
    (callback: (payload: unknown) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    },
    () => false,
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

describe('Agent Island click id across the preload deep-link bridge', () => {
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
