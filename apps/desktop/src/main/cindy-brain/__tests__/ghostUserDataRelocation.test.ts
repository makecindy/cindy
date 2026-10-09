import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ghostInstallApprovalToken, type GhostManifest } from '../../../shared/ghost.js';
import type { GhostCardDb } from '../cardStoreDb.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createPluginTaskStore } from '../../maker-ipc/pluginTaskStore.js';
import { createPluginTaskService } from '../../maker-ipc/pluginTaskService.js';
import { LayoutStore } from '../../layout/LayoutStore.js';
import { createDefaultLayout, walkPanes } from '../../../shared/layoutTree.js';
import { GhostManager } from '../GhostManager.js';
import { createGhostInstallReceipt, GhostInstallReceiptStore, hashApprovedSkillContent } from '../ghostInstallReceipt.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import { relocateGhostUserDataResources, type GhostUserDataRelocationResources } from '../ghostUserDataRelocation.js';
import { writeTestCindyPackage } from './cindyPackageFixture.js';

const scope = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => scope.dir } }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(scope.dir, ...parts),
  activeOwnerScopeKey: () => scope.dir,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

const cindy = await import('../cindyPrefsStore.js');
const errand = await import('../pluginTaskPrefsStore.js');
const pick = await import('../pickGrantsStore.js');
const workdir = await import('../ghostWorkdirPrefs.js');
const unread = await import('../ghostUnreadStore.js');
const cards = await import('../cardStoreDb.js');
const schema = await import('../../localDb/schema.js');
let rawDb: Database.Database | undefined;
let db: GhostCardDb;
let root: string;
let receipts: GhostInstallReceiptStore;
let layout: LayoutStore;
let resources: GhostUserDataRelocationResources;
let tasks: ReturnType<typeof createPluginTaskStore>;
const from = 'helper';
const to = '_ns__acme__helper';
const manifest = {
  schemaVersion: 2, id: from, name: 'Helper', version: '1.0.0',
  kind: 'chip', entry: 'main.js', slots: ['tool'],
  tools: [{ name: 'do_thing', description: 'do' }],
} as GhostManifest;
const mutateSnapshot: NonNullable<ConstructorParameters<typeof GhostInstallReceiptStore>[1]> = async ({ parentDir, ...request }) => {
  await runGhostSnapshotWorkerRequest(request, parentDir);
};

beforeEach(() => {
  scope.dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relocation-')));
  root = path.join(scope.dir, 'ghosts');
  rawDb = undefined;
  const noOp = async () => {};
  resources = {
    userDataPath: (...parts) => path.join(scope.dir, ...parts),
    assertCurrent: () => {},
    secrets: noOp, libraryBinding: noOp, libraryMeta: noOp,
    tasks: noOp,
    cindyPreferences: cindy.relocateGhostCindyPrefs,
    errandPreferences: errand.relocateGhostErrandPrefs,
    pickedDirectories: pick.relocateGhostPickedDirs,
    workdirPreferences: workdir.relocateGhostWorkdirPrefs,
    media: noOp,
    cards: noOp,
    unread: unread.relocateGhostUnread,
    routines: noOp,
    recommendations: noOp,
    recentUsage: noOp,
  };
});

function createTaskFixture() {
  rawDb = new Database(':memory:');
  db = drizzle(rawDb, { schema });
  rawDb.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
    operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
    revision INTEGER, created_at INTEGER, UNIQUE(plugin_id, operation, target_id, request_key))`);
  tasks = createPluginTaskStore({ drizzle: db } as unknown as DbClient);
  resources.tasks = (source, destination) => tasks.relocatePlugin(source, destination);
  return rawDb;
}

async function seedSourceResources() {
  createTaskFixture().exec(fs.readFileSync(path.resolve(__dirname, '../../../../drizzle/0072_first_lightspeed.sql'), 'utf8'));
  resources.cards = (source, destination) => cards.reassignGhostCards(source, destination, db);
  receipts = new GhostInstallReceiptStore(() => path.join(scope.dir, 'ghosts-install-state'), mutateSnapshot);
  layout = new LayoutStore({ getFilePath: () => path.join(scope.dir, 'layout.json') });
  const initial = createDefaultLayout();
  if (initial.content.type !== 'split') throw new Error('expected default split');
  for (const child of initial.content.children) child.fraction = 0.4;
  initial.content.children.push({ fraction: 0.2, node: { type: 'pane', id: 'org-placement', panelKind: 'ghost:helper' } });
  expect(layout.setLayout(initial)).toMatchObject({ persisted: true });
  fs.mkdirSync(path.join(root, from), { recursive: true });
  fs.writeFileSync(path.join(root, from, 'ghost.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, from, 'main.js'), 'void 0;');
  await receipts.write(createGhostInstallReceipt({
    manifest, localeResources: {}, enabled: true,
    trust: { level: 'unverified', publisherSigned: false, publisherVerified: false, reviewed: false },
    skillContentSha256: await hashApprovedSkillContent(manifest, path.join(root, from)),
  }), { skillSourceDir: path.join(root, from) });
  fs.mkdirSync(path.join(scope.dir, 'ghost-kv'));
  fs.writeFileSync(path.join(scope.dir, 'ghost-kv', from + '.json'), JSON.stringify({ private: 'org' }));
  cindy.writeGhostCindyOverride(from, 'image.generate', 'org-model');
  errand.writePluginTaskConfig(from, { permissionMode: 'auto', workingDir: '/org-workspace' });
  errand.writeGhostErrandSessionId(from, 'org-session');
  errand.writeGhostErrandSessionId(from, 'org-keyed-session', 'draft');
  pick.recordGhostPickedDir(from, '/org-picked');
  workdir.setGhostDisabledForWorkdir('/project', from, true);
  unread.markGhostUnread(from, 'org activity', 100);
  await cards.upsertGhostCard({
    callId: 'org-card', ghostId: from, sessionId: 'org-session', html: '<p>org</p>',
    height: 240, v: 1, updatedAt: 1,
  }, db);
}

afterEach(() => { rawDb?.close(); fs.rmSync(scope.dir, { recursive: true, force: true }); });

it('installs a same-name root without changing legacy data or UI references', async () => {
  await seedSourceResources();
  const archive = vi.fn();
  const manager = new GhostManager({ getRootDir: () => root, onArchiveSourceState: archive });
  expect(await manager.commitPendingNamespace(from, 'acme', 'market-organization')).toEqual({ ok: true });
  const receiptBefore = fs.readFileSync(path.join(scope.dir, 'ghosts-install-state', from + '.json'), 'utf8');
  const packageFile = await writeTestCindyPackage(path.join(scope.dir, 'root.cindy'), manifest, { 'main.js': 'void 1;' });
  expect(await manager.install(packageFile)).toMatchObject({ ghost: { namespace: null, dir: path.join(root, '_ns', '_root', from) } });
  expect(archive).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(scope.dir, 'ghosts-install-state', from + '.json'), 'utf8')).toBe(receiptBefore);
  expect(fs.readFileSync(path.join(scope.dir, 'ghost-kv', from + '.json'), 'utf8')).toBe(JSON.stringify({ private: 'org' }));
  expect(fs.existsSync(path.join(scope.dir, 'ghost-kv', '_root__' + from + '.json'))).toBe(false);
  expect(cindy.readGhostCindyOverrides(from)['image.generate']).toBe('org-model');
  expect(errand.readPluginTaskConfig(from)).toMatchObject({ permissionMode: 'auto', workingDir: '/org-workspace' });
  expect(errand.readGhostErrandSessionId(from, 'draft')).toBe('org-keyed-session');
  expect(unread.readGhostUnread(from)).toMatchObject({ summary: 'org activity', at: 100 });
  expect(await cards.getGhostCard('org-card', db)).toMatchObject({ ghostId: from });
  expect(walkPanes(layout.getLayout())).toContainEqual({ type: 'pane', id: 'org-placement', panelKind: 'ghost:helper' });
});

it('archives and restores source-owned data without changing logical UI placement', async () => {
  await seedSourceResources();
  const archive = '_ns__cindy-archive-test__helper';
  const task = { id: 'task', pluginId: from, operation: 'create' as const, targetId: '',
    requestKey: 'create', fingerprint: 'hash', payload: '{"title":"keep"}', revision: 0, createdAt: 1 };
  const run = { ...task, id: 'run', operation: 'send' as const, targetId: task.id, requestKey: 'send', payload: '{"status":"completed"}' };
  await tasks.insert(task);
  await tasks.insert(run);
  await tasks.insert({ ...task, id: 'other', pluginId: to });
  await relocateGhostUserDataResources(from, archive, resources);
  expect(await tasks.find(from, 'create', '', task.requestKey)).toBeUndefined();
  expect(await tasks.get(task.id)).toEqual({ ...task, pluginId: archive, revision: 1 });
  expect(await tasks.get(run.id)).toEqual({ ...run, pluginId: archive, revision: 1 });
  expect(await tasks.get('other')).toEqual({ ...task, id: 'other', pluginId: to });
  await expect(tasks.save(task)).rejects.toThrow('revision conflict');
  await relocateGhostUserDataResources(from, archive, resources);
  expect((await tasks.get(task.id))?.revision).toBe(1);
  expect(errand.readGhostErrandSessionId(from)).toBeNull();
  expect(await cards.getGhostCard('org-card', db)).toMatchObject({ ghostId: archive });
  expect(unread.readGhostUnread(from)).toBeNull();
  expect(unread.readGhostUnread(archive)).toMatchObject({ summary: 'org activity', at: 100 });
  expect(walkPanes(layout.getLayout())).toContainEqual({ type: 'pane', id: 'org-placement', panelKind: 'ghost:helper' });
  await relocateGhostUserDataResources(archive, from, resources);
  expect(await tasks.get(task.id)).toEqual({ ...task, revision: 2 });
  expect(await tasks.get(run.id)).toEqual({ ...run, revision: 2 });
  expect(errand.readGhostErrandSessionId(from, 'draft')).toBe('org-keyed-session');
  expect(await cards.getGhostCard('org-card', db)).toMatchObject({ ghostId: from });
  expect(unread.readGhostUnread(from)).toMatchObject({ summary: 'org activity', at: 100 });
});

it('keeps task ownership isolated after partial archival and restores it through inverse replay', async () => {
  await seedSourceResources();
  const archive = '_ns__cindy-archive-test__helper';
  await tasks.insert({ id: 'task', pluginId: from, operation: 'create', targetId: '',
    requestKey: 'key', fingerprint: 'hash', payload: '{}', revision: 0, createdAt: 1 });
  await expect(relocateGhostUserDataResources(from, archive, {
    ...resources, secrets: () => { throw new Error('archive interrupted'); },
  })).rejects.toThrow('archive interrupted');
  expect((await tasks.get('task'))?.pluginId).toBe(archive);
  await relocateGhostUserDataResources(archive, from, resources);
  expect(await tasks.get('task')).toMatchObject({ pluginId: from, revision: 2 });
});

it('completes source replacement and another plugin uninstall without reversing mutation queues', async () => {
  await seedSourceResources();
  const archive = '_ns__cindy-archive-00000000-0000-4000-8000-000000000002__helper';
  const service = createPluginTaskService({
    store: tasks, assertCurrent: () => {}, assertAuthorized: vi.fn(), readPermissionMode: vi.fn(),
    resolveRoute: vi.fn(), createSession: vi.fn(), readSession: vi.fn(),
    dispatch: vi.fn(), inspect: vi.fn(), cancel: vi.fn(),
  });
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const manager = new GhostManager({ getRootDir: () => root, onArchiveSourceState: async (source, destination) => {
    entered(); await gate; await service.relocatePlugin(source, destination);
  } });
  await manager.commitPendingNamespace(from, 'acme', 'market-organization');
  await manager.install(await writeTestCindyPackage(path.join(scope.dir, 'other.cindy'), { ...manifest, id: 'other' }));
  await tasks.insert({ id: 'task', pluginId: from, operation: 'create', targetId: '',
    requestKey: 'key', fingerprint: 'hash', payload: '{}', revision: 0, createdAt: 1 });
  const packageFile = await writeTestCindyPackage(path.join(scope.dir, 'update.cindy'), { ...manifest, version: '2.0.0' });
  const updating = manager.update(packageFile, { namespace: 'acme', sourceStateArchiveId: archive,
    expectedInstalledApproval: ghostInstallApprovalToken(manager.list().find(ghost => ghost.manifest.id === from)?.approval) });
  await started;
  const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('    const downloadScope = activeOwnerScopeKey();');
  const end = source.indexOf('    await pluginDownloads.removePlugin', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const code = ts.transpileModule(`return (async () => { ${source.slice(start, end)} })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const remove = new Function('activeOwnerScopeKey', 'pluginTaskUninstaller', 'storagePart', 'manager', 'relId', 'throwUninstallError', code);
  const removing = remove(() => scope.dir, (id: string, callback: () => Promise<void>) => service.withUninstall(id, callback),
    '_root__other', manager, '_ns/_root/other', (failure: { reason: string }) => { throw new Error(failure.reason); });
  await new Promise<void>(resolve => setImmediate(resolve));
  finish();
  const [updated] = await Promise.all([updating, removing]);
  expect(updated).toMatchObject({ ghost: { manifest: { version: '2.0.0' } } });
  expect(manager.list().some(ghost => ghost.manifest.id === 'other')).toBe(false);
  expect((await tasks.get('task'))?.pluginId).toBe(archive);
});

it('stops at an owner change after an asynchronous resource instead of writing later references', async () => {
  errand.writeGhostErrandSessionId(from, 'org-session');
  let current = true;
  const binding = vi.fn();
  const guarded = { ...resources, secrets: () => { current = false; }, libraryBinding: binding,
    assertCurrent: () => { if (!current) throw new Error('owner changed'); },
  };
  await expect(relocateGhostUserDataResources(from, to, guarded)).rejects.toThrow('owner changed');
  expect(binding).not.toHaveBeenCalled();
  expect(errand.readGhostErrandSessionId(from)).toBe('org-session');
});

it('rejects colliding task identities atomically without overwriting either source', async () => {
  createTaskFixture();
  const task = { id: 'task', pluginId: from, operation: 'create' as const, targetId: '',
    requestKey: 'key', fingerprint: 'hash', payload: '{}', revision: 0, createdAt: 1 };
  const other = { ...task, id: 'other', pluginId: to };
  await tasks.insert(task);
  await tasks.insert(other);
  await expect(tasks.relocatePlugin(from, to)).rejects.toThrow('UNIQUE constraint failed');
  await tasks.relocatePlugin(from, from);
  expect(await tasks.get(task.id)).toEqual(task);
  expect(await tasks.get(other.id)).toEqual(other);
});

it('moves downloads, recent usage and recommendations with the archived instance', async () => {
  const archive = 'arch_' + 'a'.repeat(32);
  fs.mkdirSync(path.join(scope.dir, 'plugin-downloads', from), { recursive: true });
  fs.writeFileSync(path.join(scope.dir, 'plugin-downloads', from, 'pkg.bin'), 'bytes');
  const recent = await import('../ghostRecentUsageStore.js');
  const recs = await import('../ghostRecommendationStore.js');
  recent.markGhostRecentlyUsed(from);
  recent.markGhostRecentlyUsed('other-plugin');
  recs.markGhostRecommendationInstalled(from);
  resources.recentUsage = recent.relocateGhostRecentUsage;
  resources.recommendations = recs.relocateGhostRecommendations;
  const routines = vi.fn();
  resources.routines = routines;
  await relocateGhostUserDataResources(from, archive, resources);
  expect(fs.readFileSync(path.join(scope.dir, 'plugin-downloads', archive, 'pkg.bin'), 'utf8')).toBe('bytes');
  expect(fs.existsSync(path.join(scope.dir, 'plugin-downloads', from))).toBe(false);
  expect(recent.loadGhostRecentIds()).toEqual(['other-plugin', archive]);
  expect(recs.readGhostRecommendationEntries().map((entry) => entry.id)).toEqual([archive]);
  expect(routines).toHaveBeenCalledWith(from, archive);
});
