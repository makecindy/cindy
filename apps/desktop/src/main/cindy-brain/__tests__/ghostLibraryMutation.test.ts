import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { GhostManager } from '../GhostManager.js';
import { GhostMutationCoordinator } from '../ghostMutationCoordinator.js';
import { LibraryBindingStore, assertLibraryMetaOwner } from '../libraryBinding.js';
import { migrateGhostLibrary } from '../libraryMigrate.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';
import { deliveryNamespaceFields, installedGhostMutationTargetToken, resolvePluginLibraryStorageKey } from '../../../shared/pluginIdentity.js';

const load = createGhostProductionCallbacks<{
  relocateGhostLibraryTo: (id: string, candidate: string) => Promise<{ ok: boolean }>;
  bind: (event: unknown, id: string, candidate: string) => Promise<{ ok: boolean }>;
  unbind: (event: unknown, id: string) => Promise<{ ok: boolean }>;
  revert: (event: unknown, id: string) => Promise<{ ok: boolean }>;
}>({ functions: ['beginGhostMutation', 'ghostInstallMutationTargetFor', 'ghostLibraryDeleteTargetFor',
  'libraryStorageKeyFor', 'withGhostLibraryMutation', 'relocateGhostLibraryToLocked', 'relocateGhostLibraryTo'],
  callbacks: { bind: ['ipcMain.handle', 'ghosts:library-bind'], unbind: ['ipcMain.handle', 'ghosts:library-unbind'],
    revert: ['ipcMain.handle', 'ghosts:library-revert-default'] } });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-library-mutation-'));
  directories.push(directory);
  const userPath = (...parts: string[]) => path.join(directory, ...parts);
  const manager = new GhostManager({ getRootDir: () => userPath('ghosts'), getOwnerContextKey: () => 'owner' });
  const binding = new LibraryBindingStore({ getFile: () => userPath('libraries-binding.json'),
    getManagedRoots: () => [], getDefaultRoot: (id) => userPath('libraries', id) });
  const ghost: InstalledGhost = { manifest: { schemaVersion: 3, id: 'helper', name: 'Helper', version: '1', kind: 'chip',
    entry: 'main.js', library: true }, namespace: 'acme', dir: userPath('ghosts', 'helper'),
    enabled: true, approval: { state: 'approved', revision: 'original' } };
  const root = userPath('libraries', 'helper');
  fs.mkdirSync(path.join(root, '.cindy-library'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cindy-library', 'meta.json'), JSON.stringify({ version: 1, ghostId: 'helper', createdAt: 1 }));
  fs.writeFileSync(path.join(root, 'data.sqlite'), 'original data');
  const candidate = userPath('chosen');
  fs.mkdirSync(candidate);
  const copied = deferred(), resume = deferred();
  const slot = { setRelocating: vi.fn(), disposeGhost: vi.fn(async () => {}) };
  const api = load({ fs, path, getGhostManager: () => manager, findGhostForInstanceId: () => ghost,
    ghostInstallApprovalToken, deliveryNamespaceFields, installedGhostMutationTargetToken, resolvePluginLibraryStorageKey,
    getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner', generation: 1 }),
    activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false,
    ghostMutationCoordinator: new GhostMutationCoordinator(),
    getGhostLibrarySlot: () => slot, assertTrustedAppRendererEvent: () => {}, isGhostInstanceId: () => true,
    getGhostLibraryBindingStore: () => binding, ownerScopedUserDataPath: userPath,
    assertLibraryMetaOwner, migrateGhostLibrary, app: { getPath: () => userPath('managed') },
    statfsFreeBytes: async () => 1e12, refreshMivoLibraryExtraDirGrant: async () => {},
    createBetterSqliteDatabase: (file: string) => ({ backup: async (to: string) => {
      await fs.promises.copyFile(file, to); copied.resolve(); await resume.promise;
    }, prepare: () => ({ get: () => ({ quick_check: 'ok' }) }), close: () => {} }),
    throwIpcError: (code: string) => { throw new Error(code); }, log: { warn: vi.fn(), info: vi.fn() },
  });
  return { ...api, ghost, manager, binding, candidate, userPath, copied, resume, slot };
}

describe('Host Library mutation isolation', () => {
  it('holds the existing mutation lane until copying and binding commit finish', async () => {
    const fixture = harness();
    const relocating = fixture.relocateGhostLibraryTo('helper', fixture.candidate);
    await fixture.copied.promise;
    let archived = false;
    const archive = fixture.manager.runExclusiveMutation(async () => {
      archived = true;
      await fixture.binding.relocateBinding('helper', '_ns__archive__helper');
      fixture.ghost.approval = { state: 'approved', revision: 'replacement' };
    });
    await Promise.resolve();
    const archiveWaited = !archived;
    fixture.resume.resolve();
    await expect(relocating).resolves.toMatchObject({ ok: true });
    await archive;
    expect(archiveWaited).toBe(true);
    expect(await fixture.binding.getBinding('helper')).toBeNull();
    const retained = await fixture.binding.getBinding('_ns__archive__helper');
    expect(retained).not.toBeNull();
    expect(fs.readFileSync(path.join(retained!.root, '_ns__archive__helper', 'data.sqlite'), 'utf8')).toBe('original data');
  });

  it('rejects a settings operation queued for an installation that was replaced', async () => {
    const fixture = harness(), entered = deferred(), release = deferred();
    const replacement = fixture.manager.runExclusiveMutation(async () => {
      entered.resolve(); await release.promise;
      fixture.ghost.approval = { state: 'approved', revision: 'replacement' };
    });
    await entered.promise;
    const relocating = fixture.relocateGhostLibraryTo('helper', fixture.candidate);
    const rejected = expect(relocating).rejects.toThrow('PRECONDITION_FAILED');
    fixture.resume.resolve();
    release.resolve();
    await replacement;
    await rejected;
    expect(await fixture.binding.getBinding('helper')).toBeNull();
    expect(fs.existsSync(path.join(fixture.candidate, 'helper'))).toBe(false);
  });

  it.each(['bind', 'unbind', 'revert'] as const)('rejects stale queued %s before touching the Library', async (operation) => {
    const fixture = harness(), entered = deferred(), release = deferred();
    const replacement = fixture.manager.runExclusiveMutation(async () => {
      entered.resolve(); await release.promise;
      fixture.ghost.approval = { state: 'approved', revision: 'replacement' };
    });
    await entered.promise;
    const updating = fixture[operation](undefined, 'helper', fixture.candidate);
    const rejected = expect(updating).rejects.toThrow('PRECONDITION_FAILED');
    release.resolve();
    await replacement;
    await rejected;
    expect(fixture.slot.disposeGhost).not.toHaveBeenCalled();
    expect(await fixture.binding.getBinding('helper')).toBeNull();
  });

  it('binds, unbinds and reverts through the shared lane without nesting it', async () => {
    const fixture = harness();
    await expect(fixture.bind(undefined, 'helper', fixture.candidate)).resolves.toMatchObject({ ok: true });
    expect(await fixture.binding.getBinding('helper')).not.toBeNull();
    await expect(fixture.unbind(undefined, 'helper')).resolves.toMatchObject({ ok: true });
    expect(await fixture.binding.getBinding('helper')).toBeNull();
    fixture.resume.resolve();
    await expect(fixture.relocateGhostLibraryTo('helper', fixture.candidate)).resolves.toMatchObject({ ok: true });
    const metadata = path.join(fixture.candidate, 'helper', '.cindy-library');
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, 'meta.json'), JSON.stringify({ version: 1, ghostId: 'helper', createdAt: 1 }));
    await expect(fixture.revert(undefined, 'helper')).resolves.toEqual({ ok: true });
    expect(await fixture.binding.getBinding('helper')).toBeNull();
    expect(fs.readFileSync(fixture.userPath('libraries', 'helper', 'data.sqlite'), 'utf8')).toBe('original data');
  });
});
