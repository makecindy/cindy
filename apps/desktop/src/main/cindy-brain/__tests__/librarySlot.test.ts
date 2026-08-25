/**
 * library 能力单测:资格审(未声明/停用拒)、管道级全链路(open/status/write/
 * read/rename/delete)、db 子集(经进程内 core)、binding 漂移 → unavailable、
 * owner scope 切换后旧会话作废且写入落新根。注入 deps + tmpdir,零 Electron。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { GhostLibrarySlot, type GhostLibrarySlotDeps } from '../librarySlot.js';
import { LibraryBindingStore } from '../libraryBinding.js';
import { LibraryVault } from '../libraryVault.js';
import { createLibraryDbCore, type SqliteDatabaseConstructor } from '../libraryDbCore.js';
import { LibrarySqlService } from '../librarySqlService.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

const Ctor = Database as unknown as SqliteDatabaseConstructor;
const GHOST_ID = 'mivo-canvas';

function makeGhost(library: boolean, enabled = true): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 3,
      minCindyVersion: '0.1.61',
      id: GHOST_ID,
      name: '测试意识',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(library ? { library: true } : {}),
    },
    dir: '/tmp/fake-install-dir',
    enabled,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

describe('GhostLibrarySlot', () => {
  let tmp: string;
  let defaultRootBase: string;
  let bindingFile: string;
  let candidate: string;
  let scopeKey: string | null = 'local:owner-a:1';
  let ghost: InstalledGhost;
  let slot: GhostLibrarySlot;

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-slot-'));
    defaultRootBase = path.join(tmp, 'owners', 'a', 'libraries');
    bindingFile = path.join(tmp, 'owners', 'a', 'libraries-binding.json');
    candidate = path.join(tmp, 'picked');
    await fs.promises.mkdir(candidate, { recursive: true });
    ghost = makeGhost(true);
    const deps: GhostLibrarySlotDeps = {
      getGhost: (id) => (id === GHOST_ID ? ghost : null),
      bindingStore: new LibraryBindingStore({
        getFile: () => bindingFile,
        getManagedRoots: () => [path.join(tmp, 'managed')],
        getDefaultRoot: (id) => path.join(defaultRootBase, id),
      }),
      getDefaultRoot: (id) => path.join(defaultRootBase, id),
      captureOwnerScope: () => scopeKey,
      createVault: (d) => new LibraryVault(d),
      createSqlService: (d) =>
        new LibrarySqlService({
          ...d,
          createCore: (ctor) => createLibraryDbCore({ DatabaseCtor: ctor }),
          inProcessCtor: Ctor,
        }),
      getDiskFreeBytes: async () => 1024 ** 4,
      workerScriptPath: () => path.join(tmp, 'unused-worker.js'),
      betterSqliteModulePath: () => 'better-sqlite3',
    };
    slot = new GhostLibrarySlot(deps);
  });

  afterEach(async () => {
    await slot.disposeAll();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('资格审:未声明 library 能力/停用 → NOT_DECLARED', async () => {
    ghost = makeGhost(false);
    const r = await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('NOT_DECLARED');
    ghost = makeGhost(true, false);
    const r2 = await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    expect(r2.ok).toBe(false);
    ghost = makeGhost(true);
  });

  it('管道级全链路:open/status/write/read/rename/delete(默认根)', async () => {
    const open = await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    if (!open.ok || open.op !== 'open') throw new Error(JSON.stringify(open));
    expect(open.state).toBe('ready');
    expect(open.location).toBe('default');

    const w = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'write', path: 'canvases/c1/state.json', content: 'hello',
    });
    if (!w.ok || w.op !== 'write') throw new Error(JSON.stringify(w));
    expect(w.bytes).toBe(5);

    const st = await slot.handleLibraryRequest(GHOST_ID, { op: 'status' });
    if (!st.ok || st.op !== 'status') throw new Error(JSON.stringify(st));
    expect(st.usedBytes).toBe(5);

    const r = await slot.handleLibraryRequest(GHOST_ID, { op: 'read', path: 'canvases/c1/state.json' });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.op === 'read' && r.content).toBe('hello');

    const ren = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'rename', from: 'canvases/c1/state.json', to: 'canvases/c1/state-v2.json',
    });
    expect(ren.ok).toBe(true);

    const del = await slot.handleLibraryRequest(GHOST_ID, { op: 'delete', path: 'canvases/c1/state-v2.json' });
    if (!del.ok) throw new Error(JSON.stringify(del));
    expect(del.op === 'delete' && del.existed).toBe(true);
  });

  it('db 子集:open/exec/batch 往返;ATTACH 拒;migrate 前 自动备份', async () => {
    const dbo = await slot.handleLibraryRequest(GHOST_ID, { op: 'db.open', dbPath: 'library.sqlite' });
    expect(dbo.ok).toBe(true);
    const exec = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'db.exec', dbPath: 'library.sqlite', sql: 'CREATE TABLE t (a TEXT)',
    });
    expect(exec.ok).toBe(true);
    const batch = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'db.batch', dbPath: 'library.sqlite',
      statements: [{ sql: 'INSERT INTO t VALUES (?)', params: ['v'] }],
    });
    expect(batch.ok).toBe(true);
    const sel = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'db.exec', dbPath: 'library.sqlite', sql: 'SELECT a FROM t',
    });
    if (!sel.ok || sel.op !== 'db.exec') throw new Error(JSON.stringify(sel));
    expect(sel.rows).toEqual([{ a: 'v' }]);
    const attach = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'db.exec', dbPath: 'library.sqlite', sql: "ATTACH DATABASE 'x' AS y",
    });
    expect(attach.ok).toBe(false);
    if (!attach.ok) expect(attach.errorCode).toBe('DB_STATEMENT_REJECTED');
    const mig = await slot.handleLibraryRequest(GHOST_ID, {
      op: 'db.migrate', dbPath: 'library.sqlite', targetVersion: 1,
      steps: [{ toVersion: 1, sql: ['CREATE TABLE v1 (a TEXT)'] }],
    });
    expect(mig.ok).toBe(true);
    // 迁移自动备份落宿主命名空间。
    const backupsDir = path.join(defaultRootBase, GHOST_ID, '.cindy-library', 'backups');
    const backups = await fs.promises.readdir(backupsDir);
    expect(backups.some((f) => f.startsWith('pre-migrate-'))).toBe(true);
  });

  it('binding 漂移:目录删除 → open 报 unavailable(disk-missing),写拒', async () => {
    const store = new LibraryBindingStore({
      getFile: () => bindingFile,
      getManagedRoots: () => [path.join(tmp, 'managed')],
      getDefaultRoot: (id) => path.join(defaultRootBase, id),
    });
    await store.setBinding(GHOST_ID, candidate);
    const open = await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    if (!open.ok || open.op !== 'open') throw new Error(JSON.stringify(open));
    expect(open.location).toBe('custom');

    await fs.promises.rm(candidate, { recursive: true });
    await slot.disposeAll(); // 强制重解 binding
    const open2 = await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    if (!open2.ok || open2.op !== 'open') throw new Error(JSON.stringify(open2));
    expect(open2.state).toBe('unavailable');
    expect(open2.reason).toBe('disk-missing');
    const w = await slot.handleLibraryRequest(GHOST_ID, { op: 'write', path: 'a.txt', content: 'x' });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.errorCode).toBe('LIBRARY_UNAVAILABLE');
    // 绝不落默认根冒充。
    expect(fs.existsSync(path.join(defaultRootBase, GHOST_ID, 'a.txt'))).toBe(false);
  });

  it('重装自愈:meta 带 orphaned 标记时,会话建立自动清除', async () => {
    const root = path.join(defaultRootBase, GHOST_ID);
    await fs.promises.mkdir(path.join(root, '.cindy-library'), { recursive: true });
    await fs.promises.writeFile(
      path.join(root, '.cindy-library', 'meta.json'),
      JSON.stringify({ version: 1, ghostId: GHOST_ID, createdAt: 1, orphaned: { at: 2, name: '旧名' } }),
    );
    const open = await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    if (!open.ok || open.op !== 'open') throw new Error(JSON.stringify(open));
    const metaRaw = JSON.parse(await fs.promises.readFile(path.join(root, '.cindy-library', 'meta.json'), 'utf8'));
    expect(metaRaw.orphaned).toBeUndefined();
  });

  it('owner scope 切换:旧会话作废,写入落新根,不串旧 owner 数据', async () => {
    await slot.handleLibraryRequest(GHOST_ID, { op: 'open' });
    await slot.handleLibraryRequest(GHOST_ID, { op: 'write', path: 'a.txt', content: 'owner-a' });
    const ownerARoot = path.join(defaultRootBase, GHOST_ID);
    expect(fs.existsSync(path.join(ownerARoot, 'a.txt'))).toBe(true);

    scopeKey = 'local:owner-b:1';
    defaultRootBase = path.join(tmp, 'owners', 'b', 'libraries');
    const w2 = await slot.handleLibraryRequest(GHOST_ID, { op: 'write', path: 'a.txt', content: 'owner-b' });
    expect(w2.ok).toBe(true);
    const ownerBRoot = path.join(defaultRootBase, GHOST_ID);
    expect(fs.existsSync(path.join(ownerBRoot, 'a.txt'))).toBe(true);
    // owner-a 的文件原样,owner-b 读不到它。
    const r = await slot.handleLibraryRequest(GHOST_ID, { op: 'read', path: 'a.txt' });
    if (!r.ok || r.op !== 'read') throw new Error(JSON.stringify(r));
    expect(r.content).toBe('owner-b');
  });
});
