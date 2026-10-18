import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  let sequence = 0;
  const windows = [];
  const ownerSession = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() }, protocol: { handle: vi.fn() },
  };
  return { windows, BrowserWindow: vi.fn(function BrowserWindow() {
    let destroyed = false;
    const contents = { id: ++sequence, on: vi.fn() };
    const win = {
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed');
        return contents;
      },
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => { destroyed = true; }),
    };
    windows.push(win);
    return win;
  }), session: { fromPartition: vi.fn(() => ownerSession) } };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow, session: harness.session, webContents: { fromId: vi.fn() },
}));
vi.mock('../src/main/appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'local', dataOwnerId: 'synthetic-owner', generation: 1 }),
  dataOwnerStorageKey: () => 'synthetic-owner-key',
}));
vi.mock('../src/main/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../src/main/cindy-media/blobStore.js', () => ({ resolveHashRef: vi.fn() }));
vi.mock('../src/main/cindy-media/ledger.js', () => ({ ghostCanRead: vi.fn(), listGhostGallery: vi.fn() }));

import { electronSandboxAdapter, ghostIdForLogicWebContents } from '../src/main/cindy-brain/runtime/electronSandboxAdapter.ts';

let sequence = 0;
const ghost = () => {
  const id = 'synthetic-lifecycle-' + ++sequence;
  return { dir: '/synthetic-plugins/' + id, enabled: true, manifest: {
    schemaVersion: 2, id, name: id, version: '1.0.0', kind: 'chip', entry: 'main.js', slots: [],
  } };
};

describe('sandbox destruction through the production constructor', () => {
  it.each([
    ['normal destroy', false, false],
    ['repeated normal destroy', false, true],
    ['external destroy', true, false],
    ['repeated external destroy', true, true],
  ])('%s preserves other live mappings', (_name, external, repeat) => {
    const installed = ghost();
    const handle = electronSandboxAdapter.create(installed);
    const win = harness.windows.at(-1);
    const id = win.webContents.id;
    const other = ghost();
    const otherHandle = electronSandboxAdapter.create(other);
    const otherWindow = harness.windows.at(-1);
    const otherId = otherWindow.webContents.id;
    try {
      expect(ghostIdForLogicWebContents(id)).toBe(installed.manifest.id);
      if (external) win.destroy();
      expect(() => handle.destroy()).not.toThrow();
      if (repeat) expect(() => handle.destroy()).not.toThrow();
      expect(win.isDestroyed()).toBe(true);
      expect(win.destroy).toHaveBeenCalledTimes(1);
      expect(ghostIdForLogicWebContents(id)).toBeNull();
      expect(ghostIdForLogicWebContents(otherId)).toBe(other.manifest.id);
      expect(otherWindow.isDestroyed()).toBe(false);
    } finally {
      otherHandle.destroy();
      handle.destroy();
    }
  });
});
