import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '', owner: 'owner-a', pending: false }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => h.pending,
  ownerScopedUserDataPath: (name: string) => path.join(h.dir, h.owner, name),
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { createTaskExportDirectoryHandlers, readTaskExportDirectory } from '../task-export-settings.js';

// Unit, #12461 review: the settings IPC and the Agent export read the file through an
// async reader (no sync I/O on Main), while writes stay on the shared store. Production
// entry: the real get/choose/reset handlers and readTaskExportDirectory on a temp
// user-data folder. No existing test covered this module. Minimum inputs: no file, a
// chosen folder, a corrupt file, and an account switch. One file covers the reader and
// the store agreeing on every state.
describe('task export folder setting', () => {
  let chosen: string | null = null;
  const settingsFile = () => path.join(h.dir, h.owner, 'task-export-settings.json');
  beforeEach(async () => {
    h.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-task-export-settings-'));
    h.owner = 'owner-a';
    await fs.mkdir(path.join(h.dir, h.owner), { recursive: true });
  });
  afterEach(async () => { await fs.rm(h.dir, { recursive: true, force: true }); });
  const handlers = createTaskExportDirectoryHandlers({ chooseDirectory: async () => chosen });

  it('records the real path on choose, scopes it per account and resets to ask each time', async () => {
    expect(await handlers.get()).toEqual({ path: null, exists: false, unreadable: false });
    expect(await readTaskExportDirectory()).toBeNull();
    chosen = path.join(h.dir, 'exports');
    await fs.mkdir(chosen);
    expect(await handlers.choose()).toEqual({ path: chosen, exists: true, unreadable: false });
    expect(await readTaskExportDirectory()).toEqual({ realPath: await fs.realpath(chosen) });

    h.owner = 'owner-b';
    await fs.mkdir(path.join(h.dir, h.owner), { recursive: true });
    expect(await handlers.get()).toEqual({ path: null, exists: false, unreadable: false });
    h.owner = 'owner-a';

    expect(await handlers.reset()).toEqual({ path: null, exists: false, unreadable: false });
    expect(await readTaskExportDirectory()).toBeNull();
  });

  it('reports a corrupt file as unreadable and lets reset or a new choice recover', async () => {
    await fs.writeFile(settingsFile(), '{ not json');
    expect(await handlers.get()).toEqual({ path: null, exists: false, unreadable: true });
    expect(await readTaskExportDirectory()).toBe('unreadable');
    expect(await handlers.reset()).toEqual({ path: null, exists: false, unreadable: false });

    await fs.writeFile(settingsFile(), '[]');
    chosen = path.join(h.dir, 'recovered');
    await fs.mkdir(chosen);
    expect(await handlers.choose()).toEqual({ path: chosen, exists: true, unreadable: false });
    expect(await readTaskExportDirectory()).toEqual({ realPath: await fs.realpath(chosen) });
  });
});
