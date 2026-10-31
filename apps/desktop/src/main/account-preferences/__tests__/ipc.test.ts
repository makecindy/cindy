/** Unit: the public IPC adapter must not disclose preferences across renderer or owner boundaries. */
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request?: unknown) => unknown>(),
  changed: null as ((change: { snapshot: unknown; origin: string }) => void) | null,
  owner: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
  windows: [] as Array<{ trusted: boolean; isDestroyed(): boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
  load: vi.fn(), set: vi.fn(), importLegacy: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (event: unknown, request?: unknown) => unknown) => h.handlers.set(name, handler) },
  BrowserWindow: { getAllWindows: () => h.windows },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (event: { trusted?: boolean }) => {
    if (!event.trusted) throw new Error('untrusted renderer');
  },
  isTrustedAppRendererWindow: (win: { trusted: boolean }) => win.trusted,
}));
vi.mock('../../appSessionState.js', () => ({ getActiveDataOwnerPushStamp: () => h.owner }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../store.js', () => ({
  loadAccountPreferencesSnapshot: h.load,
  setAccountPreference: h.set,
  importLegacyAccountPreferences: h.importLegacy,
  onAccountPreferencesChanged: (listener: typeof h.changed) => { h.changed = listener; return () => {}; },
}));

import { registerAccountPreferencesIpc } from '../ipc.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.owner = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
  h.windows = [];
  registerAccountPreferencesIpc();
});

it('rejects untrusted load, set and legacy import before accessing the preference store', () => {
  for (const name of ['load', 'set', 'import-legacy']) {
    expect(() => h.handlers.get(`account-preferences:${name}`)!({}, {})).toThrow('untrusted renderer');
  }
  expect(h.load).not.toHaveBeenCalled();
  expect(h.set).not.toHaveBeenCalled();
  expect(h.importLegacy).not.toHaveBeenCalled();
});

it('routes trusted operations to the store with their original generation-stamped request', async () => {
  const snapshot = { ...h.owner, values: { theme: 'dark' }, legacyImportAllowed: false };
  const request = { ...h.owner, key: 'theme', value: 'dark' };
  h.load.mockReturnValue(snapshot);
  h.set.mockResolvedValue(snapshot);
  h.importLegacy.mockResolvedValue(snapshot);
  expect(h.handlers.get('account-preferences:load')!({ trusted: true })).toBe(snapshot);
  await expect(h.handlers.get('account-preferences:set')!({ trusted: true }, request)).resolves.toBe(snapshot);
  await expect(h.handlers.get('account-preferences:import-legacy')!({ trusted: true }, request)).resolves.toBe(snapshot);
  expect(h.set).toHaveBeenCalledWith(request);
  expect(h.importLegacy).toHaveBeenCalledWith(request);
});

it('broadcasts only the current owner generation to trusted live app windows', () => {
  const live = { trusted: true, isDestroyed: () => false, webContents: { send: vi.fn() } };
  const guest = { trusted: false, isDestroyed: () => false, webContents: { send: vi.fn() } };
  const closed = { trusted: true, isDestroyed: () => true, webContents: { send: vi.fn() } };
  h.windows = [live, guest, closed];
  const snapshot = { ...h.owner, values: { language: 'en' }, legacyImportAllowed: false };
  h.changed!({ snapshot: { ...snapshot, dataOwnerId: 'owner-b' }, origin: 'remote' });
  h.changed!({ snapshot: { ...snapshot, ownerGeneration: 0 }, origin: 'remote' });
  expect(live.webContents.send).not.toHaveBeenCalled();
  h.changed!({ snapshot, origin: 'remote' });
  expect(live.webContents.send).toHaveBeenCalledExactlyOnceWith('account-preferences:changed', snapshot);
  expect(guest.webContents.send).not.toHaveBeenCalled();
  expect(closed.webContents.send).not.toHaveBeenCalled();
});

it('keeps an already saved preference successful when a window closes during broadcast', () => {
  h.windows = [{ trusted: true, isDestroyed: () => false, webContents: { send: vi.fn(() => { throw new Error('closed'); }) } }];
  const snapshot = { ...h.owner, values: {}, legacyImportAllowed: false };
  expect(() => h.changed!({ snapshot, origin: 'local' })).not.toThrow();
});
