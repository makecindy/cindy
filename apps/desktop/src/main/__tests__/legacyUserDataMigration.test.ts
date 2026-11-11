/**
 * legacyUserDataMigration.test — 首登轻量数据迁移(mToc)核心流程单测。
 *
 * Core migration tests use injected in-memory filesystem dependencies. A final
 * subprocess test runs against Electron itself to cover physical .asar access.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  LEGACY_MIGRATION_MARKER_FILENAME,
  runLegacyUserDataMigration,
  shouldSkipLegacyMigrationForDevSandbox,
  type LegacyMigrationFsDeps,
  type LegacyMigrationPhase,
  type LegacyUserDataMigrationDeps,
} from '../legacyUserDataMigration';

const BASE = path.join(path.sep, 'base');
const USER_DATA = path.join(BASE, 'Cindy');
const LEGACY = path.join(BASE, 'xdt-maker');
const nodeRequire = createRequire(import.meta.url);

function resolveElectronRuntime(
  resolveElectron: () => unknown = () => nodeRequire('electron'),
  fileExists: (filePath: string) => boolean = existsSync,
): { executable: string; asarFixture: string } | null {
  try {
    const executable = resolveElectron();
    if (typeof executable !== 'string' || !fileExists(executable)) return null;
    const resourcesDir = process.platform === 'darwin'
      ? path.resolve(path.dirname(executable), '..', 'Resources')
      : path.join(path.dirname(executable), 'resources');
    const asarFixture = path.join(resourcesDir, 'default_app.asar');
    return fileExists(asarFixture) ? { executable, asarFixture } : null;
  } catch {
    return null;
  }
}

const electronRuntime = resolveElectronRuntime();
const electronPath = electronRuntime?.executable ?? '';
const electronAsarFixture = electronRuntime?.asarFixture ?? '';
const hasElectronRuntime = electronRuntime !== null;
const requireElectronRuntime = process.env.CINDY_REQUIRE_ELECTRON_RUNTIME_TEST === '1';

if (requireElectronRuntime && !hasElectronRuntime) {
  throw new Error(
    'CINDY_REQUIRE_ELECTRON_RUNTIME_TEST requires an installed Electron runtime and default_app.asar',
  );
}

/** 内存 fs 假体:Map 存文件(内容 + mtime),Set 存目录/符号链接;merge 复制不覆盖。 */
function createMemFs() {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const dirs = new Set<string>();
  const symbolicLinks = new Set<string>();
  const norm = (p: string) => path.normalize(p);

  const addDir = (p: string): void => {
    let cur = norm(p);
    // 逐级登记祖先目录,pathExists 才能命中中间层。
    while (true) {
      dirs.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  const addFile = (p: string, content = 'x', mtimeMs = 0): void => {
    files.set(norm(p), { content, mtimeMs });
    addDir(path.dirname(p));
  };
  const addSymbolicLink = (p: string): void => {
    symbolicLinks.add(norm(p));
    addDir(path.dirname(p));
  };

  const fsDeps: LegacyMigrationFsDeps = {
    pathExists: async (p) => files.has(norm(p)) || dirs.has(norm(p)) || symbolicLinks.has(norm(p)),
    listDir: async (dir) => {
      const nd = norm(dir);
      const out: string[] = [];
      for (const f of files.keys()) if (path.dirname(f) === nd) out.push(path.basename(f));
      for (const d of dirs) if (path.dirname(d) === nd && d !== nd) out.push(path.basename(d));
      for (const link of symbolicLinks) {
        if (path.dirname(link) === nd) out.push(path.basename(link));
      }
      return out;
    },
    statMtimeMs: async (p) => {
      const f = files.get(norm(p));
      if (!f) throw new Error(`ENOENT: ${p}`);
      return f.mtimeMs;
    },
    listDirEntries: async (dir) => {
      const nd = norm(dir);
      const out: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }> = [];
      for (const f of files.keys()) {
        if (path.dirname(f) === nd) {
          out.push({ name: path.basename(f), isDirectory: false, isSymbolicLink: false });
        }
      }
      for (const d of dirs) {
        if (path.dirname(d) === nd && d !== nd) {
          out.push({ name: path.basename(d), isDirectory: true, isSymbolicLink: false });
        }
      }
      for (const link of symbolicLinks) {
        if (path.dirname(link) === nd) {
          out.push({ name: path.basename(link), isDirectory: false, isSymbolicLink: true });
        }
      }
      return out;
    },
    statSize: async (p) => {
      const f = files.get(norm(p));
      if (!f) throw new Error(`ENOENT: ${p}`);
      return f.content.length;
    },
    copyFile: async (src, dest) => {
      const s = files.get(norm(src));
      if (!s) throw new Error(`ENOENT: ${src}`);
      files.set(norm(dest), { ...s });
      addDir(path.dirname(dest));
    },
    rename: async (src, dest) => {
      const s = files.get(norm(src));
      if (!s) throw new Error(`ENOENT: ${src}`);
      if (files.has(norm(dest))) throw new Error(`EEXIST: ${dest}`); // Windows 语义
      files.delete(norm(src));
      files.set(norm(dest), s);
    },
    removeIfExists: async (p) => {
      files.delete(norm(p));
    },
    mkdirp: async (dir) => {
      addDir(dir);
    },
    writeFile: async (p, content) => {
      files.set(norm(p), { content, mtimeMs: 0 });
    },
  };

  return {
    files,
    addDir,
    addFile,
    addSymbolicLink,
    fsDeps,
    read: (p: string) => files.get(norm(p))?.content,
    has: (p: string) => files.has(norm(p)),
  };
}

type MemFs = ReturnType<typeof createMemFs>;

function makeDeps(
  memfs: MemFs,
  overrides: Partial<Pick<LegacyUserDataMigrationDeps, 'ui'>> = {},
): { deps: LegacyUserDataMigrationDeps; phases: LegacyMigrationPhase[] } {
  const phases: LegacyMigrationPhase[] = [];
  const deps: LegacyUserDataMigrationDeps = {
    userDataDir: USER_DATA,
    legacyDirNames: ['xdt-maker'],
    legacyDbPrefixes: ['xdt-maker'],
    currentDbPrefix: 'cindy',
    fs: memfs.fsDeps,
    now: () => new Date('2026-07-17T08:00:00.000Z'),
    log: { info: vi.fn(), warn: vi.fn() },
    ui: overrides.ui ?? {
      publish: (p) => phases.push(p),
      waitForConfirm: async () => {},
    },
  };
  return { deps, phases };
}

const markerPath = path.join(USER_DATA, LEGACY_MIGRATION_MARKER_FILENAME);

function readMarker(memfs: MemFs): Record<string, unknown> {
  const raw = memfs.read(markerPath);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe('Electron runtime detection', () => {
  it('treats a missing Electron package as unavailable', () => {
    expect(
      resolveElectronRuntime(() => {
        throw new Error('module not found');
      }),
    ).toBeNull();
  });
});

describe('runLegacyUserDataMigration', () => {
  it('marker 已存在 → 直接返回,不弹窗不写盘', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(markerPath, '{"schemaVersion":1}');
    const writeSpy = vi.spyOn(memfs.fsDeps, 'writeFile');
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({ status: 'marker-exists' });
    expect(phases).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('老目录不存在 → 静默写 marker 返回,不弹窗', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({ status: 'no-legacy-dir' });
    expect(phases).toEqual([]);
    expect(readMarker(memfs)).toEqual({
      schemaVersion: 1,
      migratedAt: '2026-07-17T08:00:00.000Z',
      userId: 'u1',
      sourceDb: null,
      mediaCopied: false,
      dialoguesCopied: false,
      browserProfileCopied: false,
    });
  });

  it('源库精确命中 <prefix>-<userId>.db 优先于 mtime 更新的其它库', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db-u1', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-other.db'), 'db-other', 9999);
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({
      status: 'migrated',
      sourceDb: 'xdt-maker-u1.db',
      mediaCopied: false,
      dialoguesCopied: false,
      browserProfileCopied: false,
    });
    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db'))).toBe('db-u1');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(readMarker(memfs)).toMatchObject({ sourceDb: 'xdt-maker-u1.db', mediaCopied: false });
    // 全程只读老目录:源库仍在。
    expect(memfs.read(path.join(LEGACY, 'xdt-maker-u1.db'))).toBe('db-u1');
  });

  it('无精确命中 → 扫 <prefix>-*.db 取 mtime 最新的一个;无关文件不参与', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-old.db'), 'db-old', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-new.db'), 'db-new', 200);
    memfs.addFile(path.join(LEGACY, 'unrelated-u1.db'), 'not-mine', 9999);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-new.db-wal'), 'wal', 9999); // 非 .db 结尾,不算候选
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-new.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db'))).toBe('db-new');
  });

  it('wal / shm 附属文件跟随复制并按新库名改名', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db-wal'), 'wal', 1);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db-shm'), 'shm', 1);
    const { deps } = makeDeps(memfs);

    await runLegacyUserDataMigration('u1', deps);

    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db-wal'))).toBe('wal');
    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db-shm'))).toBe('shm');
  });

  it('目标库已存在 → 跳过复制不覆盖,media 与 marker 照常', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(USER_DATA, 'cindy-u1.db'), 'existing-new-db');
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'legacy-db', 1);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'a.png'), 'legacy-a');
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({
      status: 'migrated',
      sourceDb: null,
      mediaCopied: true,
      dialoguesCopied: false,
      browserProfileCopied: false,
    });
    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db'))).toBe('existing-new-db');
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'a.png'))).toBe('legacy-a');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(readMarker(memfs)).toMatchObject({ sourceDb: null, mediaCopied: true });
  });

  it('老目录没有任何源库 → 跳过 db 步骤,仍做 media 迁移', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'b.mp4'), 'video');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({
      status: 'migrated',
      sourceDb: null,
      mediaCopied: true,
      dialoguesCopied: false,
      browserProfileCopied: false,
    });
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db'))).toBe(false);
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'b.mp4'))).toBe('video');
  });

  it('cindy-media 递归 merge:同名同字节的目标文件不覆盖,缺的补齐', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'blobs', 'a.png'), 'legacy-a');
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'blobs', 'b.png'), 'legacy-b');
    // 同字节数(8)不同内容:视为已存在成品,保留不覆盖。
    memfs.addFile(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'), 'newer-a!');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', mediaCopied: true });
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'))).toBe('newer-a!');
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'blobs', 'b.png'))).toBe('legacy-b');
  });

  it('cindy-media 字节数不一致的同名文件 = 截断残留 → 重拷修复', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'blobs', 'a.png'), 'full-content');
    memfs.addFile(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'), 'trunc'); // 上次截断
    const { deps } = makeDeps(memfs);

    await runLegacyUserDataMigration('u1', deps);

    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'))).toBe('full-content');
  });

  it('db 半成品防线:崩溃残留的 .mtoc-tmp 被清理重拷,最终名一次 rename 入位', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'good-db', 1);
    // 模拟上次拷贝中途崩溃:tmp 残留、最终名不存在。
    memfs.addFile(path.join(USER_DATA, 'cindy-u1.db.mtoc-tmp'), 'trunca');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db'))).toBe('good-db');
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db.mtoc-tmp'))).toBe(false);
  });

  it('跨 attempt 孤儿 sidecar:源侧无 wal 时,残留在最终名上的旧 wal 被清掉', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1); // 源侧无 wal/shm
    // 上次 attempt 在「wal 已入位、db 未入位」窗口崩溃的残留。
    memfs.addFile(path.join(USER_DATA, 'cindy-u1.db-wal'), 'stale-wal');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db'))).toBe('db');
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db-wal'))).toBe(false);
  });

  it('目标库已存在时清理崩溃残留的 tmp 文件', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(USER_DATA, 'cindy-u1.db'), 'existing');
    memfs.addFile(path.join(USER_DATA, 'cindy-u1.db.mtoc-tmp'), 'stale');
    memfs.addFile(path.join(USER_DATA, 'cindy-u1.db-wal.mtoc-tmp'), 'stale-wal');
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'legacy', 1);
    const { deps } = makeDeps(memfs);

    await runLegacyUserDataMigration('u1', deps);

    expect(memfs.read(path.join(USER_DATA, 'cindy-u1.db'))).toBe('existing');
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db.mtoc-tmp'))).toBe(false);
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db-wal.mtoc-tmp'))).toBe(false);
  });

  it('复制阶段失败 → 不写 marker、推 failed、返回 failed(不 throw)', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'a.png'), 'a');
    vi.spyOn(memfs.fsDeps, 'copyFile').mockRejectedValue(new Error('disk full'));
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({ status: 'failed', error: 'disk full' });
    expect(memfs.has(markerPath)).toBe(false);
    // 失败时最终名不存在——半成品只可能以 tmp 名残留,不会被下次"已存在跳过"转正。
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db'))).toBe(false);
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('dialogues 无文件夹对话工作目录整树随迁,老目录只读保留', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'dialogues', '2026-06-22', 'sess-1', 'note.md'), 'agent-output');
    memfs.addFile(path.join(LEGACY, 'dialogues', '2026-05-20', 'sess-2', 'data.json'), '{}');
    // 空的 dialogue 工作目录(最常见形态)也要随迁成目录。
    memfs.addDir(path.join(LEGACY, 'dialogues', '2026-07-01', 'sess-3'));
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', dialoguesCopied: true });
    expect(memfs.read(path.join(USER_DATA, 'dialogues', '2026-06-22', 'sess-1', 'note.md'))).toBe(
      'agent-output',
    );
    expect(memfs.read(path.join(USER_DATA, 'dialogues', '2026-05-20', 'sess-2', 'data.json'))).toBe('{}');
    // 老目录只读:源文件原样保留。
    expect(memfs.read(path.join(LEGACY, 'dialogues', '2026-06-22', 'sess-1', 'note.md'))).toBe(
      'agent-output',
    );
    expect(readMarker(memfs)).toMatchObject({ dialoguesCopied: true });
  });

  it('dialogues 跳过任意层级 node_modules 与符号链接,其余文件继续迁移', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    const workspace = path.join(LEGACY, 'dialogues', '2026-07-06', 'sess-1', 'XDMaker');
    memfs.addFile(path.join(workspace, 'src', 'index.ts'), 'source');
    memfs.addFile(
      path.join(workspace, 'apps', 'desktop', 'node_modules', 'plain-package', 'index.js'),
      'dependency',
    );
    // 复现线上报错形态:pnpm package 目录链接被 Dirent.isDirectory() 判为 false。
    memfs.addSymbolicLink(
      path.join(workspace, 'packages', 'feature', 'node_modules', '@cindy', 'orca-workflow'),
    );
    // node_modules 之外的链接也必须明确跳过，不能解引用到老目录外或形成递归环。
    memfs.addSymbolicLink(path.join(workspace, 'linked-workspace'));
    const listDirEntries = memfs.fsDeps.listDirEntries;
    vi.spyOn(memfs.fsDeps, 'listDirEntries').mockImplementation(async (dir) =>
      (await listDirEntries(dir)).map((entry) =>
        entry.name === 'linked-workspace'
          ? { ...entry, isDirectory: true, isSymbolicLink: true }
          : entry,
      ),
    );
    const copySpy = vi.spyOn(memfs.fsDeps, 'copyFile');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', dialoguesCopied: true });
    const migratedWorkspace = path.join(USER_DATA, 'dialogues', '2026-07-06', 'sess-1', 'XDMaker');
    expect(memfs.read(path.join(migratedWorkspace, 'src', 'index.ts'))).toBe('source');
    expect(
      memfs.has(
        path.join(
          migratedWorkspace,
          'apps',
          'desktop',
          'node_modules',
          'plain-package',
          'index.js',
        ),
      ),
    ).toBe(false);
    expect(memfs.has(path.join(migratedWorkspace, 'linked-workspace'))).toBe(false);
    expect(copySpy).not.toHaveBeenCalledWith(
      path.join(workspace, 'linked-workspace'),
      expect.any(String),
    );
    expect(readMarker(memfs)).toMatchObject({ dialoguesCopied: true });
  });

  it('老目录无 dialogues → 步骤跳过,dialoguesCopied=false', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', dialoguesCopied: false });
    expect(memfs.has(path.join(USER_DATA, 'dialogues'))).toBe(false);
  });

  it('agent 浏览器 profile:browser/XDMaker 复制为 browser/Cindy,缓存目录与 Singleton 锁跳过', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    const legacyProfile = path.join(LEGACY, 'browser-runtime', 'browser', 'XDMaker');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'Local State'), 'local-state');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'Default', 'Cookies'), 'cookies');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'Default', 'Cache', 'blob0'), 'cache-bytes');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'Default', 'Code Cache', 'js0'), 'code-cache');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'SingletonLock'), 'lock');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', browserProfileCopied: true });
    const newProfile = path.join(USER_DATA, 'browser-runtime', 'browser', 'Cindy');
    // 登录态文件随迁到新品牌目录名下。
    expect(memfs.read(path.join(newProfile, 'user-data', 'Local State'))).toBe('local-state');
    expect(memfs.read(path.join(newProfile, 'user-data', 'Default', 'Cookies'))).toBe('cookies');
    // Chrome 重建型缓存与单实例锁不搬。
    expect(memfs.has(path.join(newProfile, 'user-data', 'Default', 'Cache', 'blob0'))).toBe(false);
    expect(memfs.has(path.join(newProfile, 'user-data', 'Default', 'Code Cache', 'js0'))).toBe(false);
    expect(memfs.has(path.join(newProfile, 'user-data', 'SingletonLock'))).toBe(false);
    // 老目录只读:源 profile 原样保留。
    expect(memfs.read(path.join(legacyProfile, 'user-data', 'Default', 'Cookies'))).toBe('cookies');
    expect(readMarker(memfs)).toMatchObject({ browserProfileCopied: true });
  });

  it('老目录无 browser-runtime → profile 步骤跳过,browserProfileCopied=false', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', browserProfileCopied: false });
    expect(memfs.has(path.join(USER_DATA, 'browser-runtime'))).toBe(false);
  });

  it('确认流程时序:confirm 先推送并阻塞,resolver 放行后才 running', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    const phases: LegacyMigrationPhase[] = [];
    let releaseConfirm: (() => void) | null = null;
    const { deps } = makeDeps(memfs, {
      ui: {
        publish: (p) => phases.push(p),
        waitForConfirm: () =>
          new Promise<void>((resolve) => {
            releaseConfirm = resolve;
          }),
      },
    });

    const resultPromise = runLegacyUserDataMigration('u1', deps);
    // 让流程推进到等待确认。
    await vi.waitFor(() => {
      expect(phases).toEqual(['confirm']);
      expect(releaseConfirm).not.toBeNull();
    });
    // 确认前:不复制、不写 marker。
    expect(memfs.has(path.join(USER_DATA, 'cindy-u1.db'))).toBe(false);
    expect(memfs.has(markerPath)).toBe(false);

    releaseConfirm!();
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(memfs.has(markerPath)).toBe(true);
  });
});

describe('shouldSkipLegacyMigrationForDevSandbox', () => {
  it('dev + XDT_USER_DATA_DIR 生效(--isolated 沙箱 / 手动覆写)→ 跳过', () => {
    expect(
      shouldSkipLegacyMigrationForDevSandbox({
        isPackaged: false,
        envUserDataDir: path.join(BASE, 'Cindy-dev'),
      }),
    ).toBe(true);
  });

  it('dev 共库(未覆写 userData)→ 不跳过,保持与 packaged 行为一致', () => {
    expect(
      shouldSkipLegacyMigrationForDevSandbox({ isPackaged: false, envUserDataDir: undefined }),
    ).toBe(false);
    expect(
      shouldSkipLegacyMigrationForDevSandbox({ isPackaged: false, envUserDataDir: '' }),
    ).toBe(false);
    expect(
      shouldSkipLegacyMigrationForDevSandbox({ isPackaged: false, envUserDataDir: '   ' }),
    ).toBe(false);
  });

  it('packaged 永不跳过(即使残留同名 env)', () => {
    expect(
      shouldSkipLegacyMigrationForDevSandbox({
        isPackaged: true,
        envUserDataDir: path.join(BASE, 'anything'),
      }),
    ).toBe(false);
  });
});

describe.skipIf(!hasElectronRuntime)('Electron physical .asar access', () => {
  it('copies a physical .asar through original-fs', () => {
    const script = `
const nodeFs = require('node:fs').promises;
const originalFs = require('original-fs').promises;
const os = require('node:os');
const path = require('node:path');

(async () => {
  const source = ${JSON.stringify(electronAsarFixture)};
  const tempDir = await originalFs.mkdtemp(path.join(os.tmpdir(), 'cindy-asar-copy-'));
  const destination = path.join(tempDir, 'copied.asar');
  let patchedCopyError = null;

  try {
    try {
      await nodeFs.copyFile(source, destination);
    } catch (error) {
      patchedCopyError = error.code;
    }

    await originalFs.copyFile(source, destination);
    const [sourceStat, destinationStat, sourceContents, destinationContents] = await Promise.all([
      originalFs.stat(source),
      originalFs.stat(destination),
      originalFs.readFile(source),
      originalFs.readFile(destination),
    ]);
    process.stdout.write(JSON.stringify({
      patchedCopyError,
      copiedBytes: destinationStat.size,
      sourceBytes: sourceStat.size,
      contentsMatch: sourceContents.equals(destinationContents),
    }));
  } finally {
    await originalFs.rm(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

    const result = spawnSync(electronPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      patchedCopyError: string | null;
      copiedBytes: number;
      sourceBytes: number;
      contentsMatch: boolean;
    };
    expect([null, 'ENOENT']).toContain(output.patchedCopyError);
    expect(output.copiedBytes).toBe(output.sourceBytes);
    expect(output.contentsMatch).toBe(true);
  });
});
