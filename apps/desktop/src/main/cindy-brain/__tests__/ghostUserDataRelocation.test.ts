import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';
import type { GhostCardDb } from '../cardStoreDb.js';
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
const errand = await import('../errandPrefsStore.js');
const pick = await import('../pickGrantsStore.js');
const workdir = await import('../ghostWorkdirPrefs.js');
const unread = await import('../ghostUnreadStore.js');
const cards = await import('../cardStoreDb.js');
const schema = await import('../../localDb/schema.js');
let rawDb: Database.Database;
let db: GhostCardDb;
let root: string;
let receipts: GhostInstallReceiptStore;
let layout: LayoutStore;
let resources: GhostUserDataRelocationResources;
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

beforeEach(async () => {
  scope.dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relocation-')));
  root = path.join(scope.dir, 'ghosts');
  receipts = new GhostInstallReceiptStore(() => path.join(scope.dir, 'ghosts-install-state'), mutateSnapshot);
  rawDb = new Database(':memory:');
  rawDb.exec(fs.readFileSync(path.resolve(__dirname, '../../../../drizzle/0072_first_lightspeed.sql'), 'utf8'));
  db = drizzle(rawDb, { schema });
  layout = new LayoutStore({ getFilePath: () => path.join(scope.dir, 'layout.json') });
  const initial = createDefaultLayout();
  if (initial.content.type !== 'split') throw new Error('expected default split');
  for (const child of initial.content.children) child.fraction = 0.4;
  initial.content.children.push({ fraction: 0.2, node: { type: 'pane', id: 'org-placement', panelKind: 'ghost:helper' } });
  expect(layout.setLayout(initial)).toMatchObject({ persisted: true });
  const noOp = async () => {};
  resources = {
    userDataPath: (...parts) => path.join(scope.dir, ...parts),
    assertCurrent: () => {},
    secrets: noOp, libraryBinding: noOp, libraryMeta: noOp,
    cindyPreferences: cindy.relocateGhostCindyPrefs,
    errandPreferences: errand.relocateGhostErrandPrefs,
    pickedDirectories: pick.relocateGhostPickedDirs,
    workdirPreferences: workdir.relocateGhostWorkdirPrefs,
    media: noOp,
    cards: (source, destination) => cards.reassignGhostCards(source, destination, db),
    unread: unread.relocateGhostUnread,
  };
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
  errand.writeGhostErrandConfig(from, { permissionMode: 'auto', workingDir: '/org-workspace' });
  errand.writeGhostErrandSessionId(from, 'org-session');
  errand.writeGhostErrandSessionId(from, 'org-keyed-session', 'draft');
  pick.recordGhostPickedDir(from, '/org-picked');
  workdir.setGhostDisabledForWorkdir('/project', from, true);
  unread.markGhostUnread(from, 'org activity', 100);
  await cards.upsertGhostCard({
    callId: 'org-card', ghostId: from, sessionId: 'org-session', html: '<p>org</p>',
    height: 240, v: 1, updatedAt: 1,
  }, db);
});

afterEach(() => { rawDb.close(); fs.rmSync(scope.dir, { recursive: true, force: true }); });

it('installs a same-name root without changing legacy data or UI references', async () => {
  const archive = vi.fn();
  const manager = new GhostManager({ getRootDir: () => root, onArchiveSourceState: archive });
  expect(await manager.commitPendingNamespace(from, 'acme', 'market-organization')).toEqual({ ok: true });
  const receiptBefore = fs.readFileSync(path.join(scope.dir, 'ghosts-install-state', from + '.json'), 'utf8');
  const packageFile = await writeTestCindyPackage(path.join(scope.dir, 'root.cindy'), manifest, { 'main.js': 'void 1;' });
  expect(await manager.install(packageFile)).toMatchObject({ ghost: { namespace: null, dir: path.join(root, '_root', from) } });
  expect(archive).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(scope.dir, 'ghosts-install-state', from + '.json'), 'utf8')).toBe(receiptBefore);
  expect(fs.readFileSync(path.join(scope.dir, 'ghost-kv', from + '.json'), 'utf8')).toBe(JSON.stringify({ private: 'org' }));
  expect(fs.existsSync(path.join(scope.dir, 'ghost-kv', '_root__' + from + '.json'))).toBe(false);
  expect(cindy.readGhostCindyOverrides(from)['image.generate']).toBe('org-model');
  expect(errand.readGhostErrandConfig(from)).toMatchObject({ permissionMode: 'auto', workingDir: '/org-workspace' });
  expect(errand.readGhostErrandSessionId(from, 'draft')).toBe('org-keyed-session');
  expect(unread.readGhostUnread(from)).toMatchObject({ summary: 'org activity', at: 100 });
  expect(await cards.getGhostCard('org-card', db)).toMatchObject({ ghostId: from });
  expect(walkPanes(layout.getLayout())).toContainEqual({ type: 'pane', id: 'org-placement', panelKind: 'ghost:helper' });
});

it('archives and restores source-owned data without changing logical UI placement', async () => {
  const archive = '_ns__cindy-archive-test__helper';
  await relocateGhostUserDataResources(from, archive, resources);
  expect(errand.readGhostErrandSessionId(from)).toBeNull();
  expect(await cards.getGhostCard('org-card', db)).toMatchObject({ ghostId: archive });
  expect(unread.readGhostUnread(from)).toBeNull();
  expect(unread.readGhostUnread(archive)).toMatchObject({ summary: 'org activity', at: 100 });
  expect(walkPanes(layout.getLayout())).toContainEqual({ type: 'pane', id: 'org-placement', panelKind: 'ghost:helper' });
  await relocateGhostUserDataResources(archive, from, resources);
  expect(errand.readGhostErrandSessionId(from, 'draft')).toBe('org-keyed-session');
  expect(await cards.getGhostCard('org-card', db)).toMatchObject({ ghostId: from });
  expect(unread.readGhostUnread(from)).toMatchObject({ summary: 'org activity', at: 100 });
});

it('stops at an owner change after an asynchronous resource instead of writing later references', async () => {
  let current = true;
  const binding = vi.fn();
  const guarded = { ...resources, secrets: () => { current = false; }, libraryBinding: binding,
    assertCurrent: () => { if (!current) throw new Error('owner changed'); },
  };
  await expect(relocateGhostUserDataResources(from, to, guarded)).rejects.toThrow('owner changed');
  expect(binding).not.toHaveBeenCalled();
  expect(errand.readGhostErrandSessionId(from)).toBe('org-session');
});
