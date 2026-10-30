import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';
import {
  deliveryNamespaceFields,
  findInstalledGhostByInstanceId,
  installedGhostMutationTargetToken,
  resolvePluginLibraryStorageKey,
  isGhostInstanceId,
} from '../../../shared/pluginIdentity.js';
import { GhostManager } from '../GhostManager.js';
import { GhostMutationCoordinator } from '../ghostMutationCoordinator.js';
import { assertLibraryMetaOwner, LibraryBindingStore, relocateLibraryMetaOwner } from '../libraryBinding.js';
import { trashGhostLibrary } from '../libraryTrash.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((finish) => { resolve = finish; });
  return { promise, resolve };
}

const loadDelete = createGhostProductionCallbacks<{
  handler: (event: { sender: object }, id: string) => Promise<{ ok: boolean }>;
  deleteGhostLibraryForActiveOwner: (id: string) => Promise<{ ok: boolean }>;
}>({
  functions: [
    'captureGhostMutationOwner', 'beginGhostMutation', 'ghostInstallMutationTargetFor',
    'libraryStorageKeyFor', 'ghostLibraryDeleteTargetFor', 'deleteGhostLibraryForActiveOwner',
    'deleteGhostLibraryLocked',
  ],
  callbacks: { handler: ['ipcMain.handle', 'ghosts:library-delete'] },
});

let directory: string;

function harness() {
  const state = { owner: { mode: 'cloud', dataOwnerId: 'owner', generation: 1 }, pending: false };
  const scopeKey = () => state.owner.dataOwnerId + ':' + state.owner.generation;
  const userPath = (...parts: string[]) => path.join(directory, state.owner.dataOwnerId, ...parts);
  const ghost = (namespace: string | null = 'acme', revision = 'original'): InstalledGhost => ({
    manifest: { schemaVersion: 3, id: 'helper', name: namespace ? 'Organization helper' : 'Root helper',
      version: '1.0.0', kind: 'chip', entry: 'main.js', library: true },
    dir: userPath('ghosts', 'helper'), namespace, enabled: true,
    approval: { state: 'approved', revision },
  });
  let ghosts = [ghost()];
  const coordinator = new GhostMutationCoordinator();
  const manager = new GhostManager({ getRootDir: () => userPath('ghosts'), getOwnerContextKey: scopeKey });
  const binding = new LibraryBindingStore({
    getFile: () => userPath('libraries-binding.json'), getManagedRoots: () => [],
    getDefaultRoot: (id) => userPath('libraries', id),
  });
  const removeBinding = vi.spyOn(binding, 'removeBinding');
  const disposeGhost = vi.fn(async () => {});
  const checkMeta = vi.fn(assertLibraryMetaOwner);
  const dialog = deferred<{ response: number }>();
  const showMessageBox = vi.fn(() => dialog.promise);
  const setRelocating = vi.fn();
  const api = loadDelete({
    path, ghostInstallApprovalToken, deliveryNamespaceFields, installedGhostMutationTargetToken,
    resolvePluginLibraryStorageKey, isGhostInstanceId,
    findGhostForInstanceId: (id: string) => findInstalledGhostByInstanceId(ghosts, id) ?? null,
    activeOwnerScopeKey: scopeKey, isAppSessionBoundaryPending: () => state.pending,
    getActiveAppSession: () => ({ ...state.owner }), ghostMutationCoordinator: coordinator,
    getGhostManager: () => manager, getGhostLibrarySlot: () => ({ disposeGhost, setRelocating }),
    getGhostLibraryBindingStore: () => binding, assertLibraryMetaOwner: checkMeta,
    ownerScopedUserDataPath: userPath, trashGhostLibrary,
    refreshMivoLibraryExtraDirGrant: async () => {}, assertTrustedAppRendererEvent: () => {},
    throwIpcError: (code: string, message: string) => { throw new Error(code + ': ' + message); },
    BrowserWindow: { fromWebContents: () => ({}) }, dialog: { showMessageBox },
    t: (key: string) => key, log: { info: vi.fn(), warn: vi.fn() },
  });
  const createLibrary = (id = 'helper', contents = 'organization data') => {
    const root = userPath('libraries', id);
    fs.mkdirSync(path.join(root, '.cindy-library'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cindy-library', 'meta.json'), JSON.stringify({ version: 1, ghostId: id, createdAt: 1 }));
    fs.writeFileSync(path.join(root, 'data.txt'), contents);
    return root;
  };
  const root = createLibrary();
  return { ...api, state, ghost, manager, binding, removeBinding, disposeGhost, checkMeta,
    dialog, showMessageBox, setRelocating, coordinator, createLibrary, root, userPath,
    setGhosts: (next: InstalledGhost[]) => { ghosts = next; },
    invoke: () => api.handler({ sender: {} }, 'helper'),
    unchanged: () => {
      expect(fs.readFileSync(path.join(root, 'data.txt'), 'utf8')).toBe('organization data');
      expect(removeBinding).not.toHaveBeenCalled();
      expect(fs.existsSync(userPath('libraries-trash'))).toBe(false);
    },
  };
}

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-library-delete-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('Library delete Host confirmation', () => {
  it('does not apply organization confirmation to a root that reuses its physical key', async () => {
    const run = harness();
    const deleting = run.invoke();
    expect(run.showMessageBox.mock.calls[0]).toBeDefined();
    const orgId = '_ns__acme__helper';
    fs.renameSync(run.root, run.userPath('libraries', orgId));
    await relocateLibraryMetaOwner(run.userPath('libraries', orgId), 'helper', orgId);
    const organization = { ...run.ghost(), dir: run.userPath('ghosts', '_ns', 'acme', 'helper') };
    run.setGhosts([run.ghost(null, 'new-root'), organization]);
    run.createLibrary('helper', 'root data');
    run.dialog.resolve({ response: 0 });
    await expect(deleting).rejects.toThrow(/重新确认/);
    expect(fs.readFileSync(path.join(run.root, 'data.txt'), 'utf8')).toBe('root data');
    expect(fs.readFileSync(run.userPath('libraries', orgId, 'data.txt'), 'utf8')).toBe('organization data');
    expect(run.disposeGhost).not.toHaveBeenCalled();
    expect(run.removeBinding).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'owner', 'boundary'] as const)('rejects a stale %s after confirmation', async (change) => {
    const run = harness();
    const deleting = run.invoke();
    if (change === 'receipt') run.setGhosts([run.ghost('acme', 'replacement')]);
    if (change === 'owner') run.state.owner = { ...run.state.owner, generation: 2 };
    if (change === 'boundary') run.state.pending = true;
    run.dialog.resolve({ response: 0 });
    await expect(deleting).rejects.toThrow();
    run.unchanged();
    await run.coordinator.waitForIdle();
  });

  it('revalidates the target after waiting for the existing mutation lane', async () => {
    const run = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const competing = run.manager.runExclusiveMutation(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const deleting = run.invoke();
    run.dialog.resolve({ response: 0 });
    await Promise.resolve();
    run.setGhosts([run.ghost(null, 'replacement')]);
    release.resolve();
    await competing;
    await expect(deleting).rejects.toThrow(/重新确认/);
    run.unchanged();
  });

  it.each(['dispose', 'binding', 'meta'] as const)('revalidates after the delete helper awaits %s', async (stage) => {
    const run = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const pause = async () => { entered.resolve(); await release.promise; };
    if (stage === 'dispose') run.disposeGhost.mockImplementationOnce(pause);
    if (stage === 'binding') vi.spyOn(run.binding, 'resolveLibraryRoot').mockImplementationOnce(async () => {
      await pause(); return { kind: 'default', root: run.root };
    });
    if (stage === 'meta') run.checkMeta.mockImplementationOnce(async (root, id) => {
      await assertLibraryMetaOwner(root, id); await pause();
    });
    const deleting = run.invoke();
    run.dialog.resolve({ response: 0 });
    await entered.promise;
    run.setGhosts([run.ghost(null, 'replacement')]);
    release.resolve();
    await expect(deleting).rejects.toThrow(/重新确认/);
    run.unchanged();
    expect(run.setRelocating).toHaveBeenLastCalledWith('helper', false);
  });

  it('keeps installed-instance mutations queued throughout the trash filesystem awaits', async () => {
    const run = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      if (args[0] === run.root) { entered.resolve(); await release.promise; }
      return rename(...args);
    });
    const deleting = run.invoke();
    run.dialog.resolve({ response: 0 });
    await entered.promise;
    const mutate = vi.fn(() => run.setGhosts([run.ghost(null, 'replacement')]));
    const competing = run.manager.runExclusiveMutation(async () => { mutate(); });
    await Promise.resolve();
    expect(mutate).not.toHaveBeenCalled();
    release.resolve();
    await expect(deleting).resolves.toEqual({ ok: true });
    await competing;
    expect(mutate).toHaveBeenCalledOnce();
    expect(run.removeBinding).toHaveBeenCalledWith('helper');
  });

  it.each(['approved', 'invalid', 'legacy-unapproved', 'orphan'] as const)('retains cleanup of a stable %s Library', async (approval) => {
    const run = harness();
    if (approval === 'orphan') run.setGhosts([]);
    else if (approval !== 'approved') run.setGhosts([{ ...run.ghost(), approval: { state: approval } }]);
    const deleting = run.invoke();
    run.dialog.resolve({ response: 0 });
    await expect(deleting).resolves.toEqual({ ok: true });
    expect(fs.existsSync(run.root)).toBe(false);
    const names = fs.readdirSync(run.userPath('libraries-trash'));
    expect(fs.readFileSync(run.userPath('libraries-trash', names[0], 'data.txt'), 'utf8')).toBe('organization data');
    expect(run.removeBinding).toHaveBeenCalledWith('helper');
  });

  it.each(['invalid', 'legacy-unapproved', 'orphan'] as const)('does not apply stale %s cleanup to a newly installed root', async (approval) => {
    const run = harness();
    run.setGhosts(approval === 'orphan' ? [] : [{ ...run.ghost(), approval: { state: approval } }]);
    const deleting = run.invoke();
    run.setGhosts([run.ghost(null, 'replacement')]);
    run.dialog.resolve({ response: 0 });
    await expect(deleting).rejects.toThrow(/重新确认/);
    run.unchanged();
  });

  it('supports direct orphan cleanup without an approval requirement', async () => {
    const run = harness();
    run.setGhosts([]);
    await expect(run.deleteGhostLibraryForActiveOwner('helper')).resolves.toEqual({ ok: true });
    expect(fs.existsSync(run.root)).toBe(false);
  });

  it('does not start cleanup when the user cancels', async () => {
    const run = harness();
    const deleting = run.invoke();
    run.dialog.resolve({ response: 1 });
    await expect(deleting).resolves.toEqual({ ok: false, cancelled: true });
    expect(run.disposeGhost).not.toHaveBeenCalled();
    run.unchanged();
  });
});
